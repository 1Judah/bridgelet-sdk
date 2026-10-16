/**
 * Controller CRUD exercised against the REAL `WebhooksService` (#917).
 *
 * The previous version of this suite injected a mocked `WebhooksService`, so
 * every test asserted only that the controller forwards to a stub and returns
 * its value. Nothing about the service was covered, which is exactly why #915
 * could ship: `update()` silently ignored `isActive` and `secret` while both
 * `README.md` and `docs/api-reference.md` documented them, and a controller test
 * that mocks the service cannot see that.
 *
 * This suite wires the real service over a mock TypeORM repository — the same
 * convention as `claim-redemption.provider.spec.ts`, since this repo has no
 * database-backed test harness. What that buys us is the real service logic:
 *   - `create()` encrypts the secret via `KmsKeyProvider` and defaults
 *     `isActive` to true;
 *   - `findAll()` filters on `isActive = true` and paginates;
 *   - `update()` applies `isActive` and rotates `secret` (the #915 regression);
 *   - `remove()` deactivates rather than deleting.
 *
 * The secret is encrypted through a stub KMS provider, so these tests also
 * assert the plaintext never reaches the response DTO.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksService } from './webhooks.service.js';
import { Webhook } from './entities/webhook.entity.js';
import { CreateWebhookDto } from './dto/create-webhook.dto.js';
import { UpdateWebhookDto } from './dto/update-webhook.dto.js';
import { KmsKeyProvider } from '../../common/crypto/kms-key.provider.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { ThrottlerGuard } from '@nestjs/throttler';

/** Stands in for `SecretEncryptionUtil` output; real ciphertext, opaque here. */
const ENCRYPTED = 'aes256gcm:v1:iv:tag:data';

const mockKms = {
  encrypt: jest.fn(() => ENCRYPTED),
  decrypt: jest.fn((ciphertext: string) =>
    ciphertext === ENCRYPTED ? 'plain-secret-value' : ciphertext,
  ),
};

/** Rows the mock repository has "persisted", keyed by id. */
let rows: Webhook[] = [];
let nextId = 1;

/** Mirrors the entity's generated uuid PK, which a DTO never supplies. */
function freshRow(overrides: Partial<Webhook> = {}): Webhook {
  const row = {
    url: 'https://api.example.com/hooks',
    events: ['account.created'],
    secret: null,
    description: null,
    isActive: true,
    lastTriggeredAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as Webhook;
  row.id = `wh-${nextId++}`;
  return row;
}

/** Minimal DTO instance; this suite bypasses class-validator on purpose. */
function createDto(url: string): CreateWebhookDto {
  const dto = new CreateWebhookDto();
  dto.url = url;
  dto.events = ['account.created', 'sweep.completed'];
  dto.secret = 'plain-secret-value';
  return dto;
}

const mockRepository = {
  create: jest.fn((partial: Partial<Webhook>) => freshRow(partial)),
  save: jest.fn(async (row: Webhook) => {
    const existing = rows.find((r) => r.id === row.id);
    if (existing) {
      Object.assign(existing, row);
      return existing;
    }
    rows.push(row);
    return row;
  }),
  findOne: jest.fn(
    async ({ where }: { where: { id: string } }) =>
      rows.find((r) => r.id === where.id) ?? null,
  ),
  update: jest.fn(async () => undefined),
  // findAll() builds a query; `.take(n)` is what the service uses to bound the
  // page, so the mock resolves the active rows at that point.
  createQueryBuilder: jest.fn(() => {
    const qb: Record<string, unknown> = {};
    qb.where = jest.fn(() => qb);
    qb.andWhere = jest.fn(() => qb);
    qb.orderBy = jest.fn(() => qb);
    qb.addOrderBy = jest.fn(() => qb);
    qb.skip = jest.fn(() => qb);
    qb.take = jest.fn((n: number) => {
      qb.getManyAndCount = async () => {
        const active = rows.filter((r) => r.isActive);
        return [active.slice(0, n), active.length] as [Webhook[], number];
      };
      return qb;
    });
    qb.getMany = jest.fn(async () => rows.filter((r) => r.isActive));
    qb.getManyAndCount = async () => [[], 0];
    return qb;
  }),
};

describe('WebhooksController — full CRUD against the real service (#917)', () => {
  let controller: WebhooksController;

  beforeEach(async () => {
    jest.clearAllMocks();
    rows = [];
    nextId = 1;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        WebhooksService,
        { provide: getRepositoryToken(Webhook), useValue: mockRepository },
        { provide: KmsKeyProvider, useValue: mockKms },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<WebhooksController>(WebhooksController);
  });

  it('creates a subscription, encrypting the secret and defaulting isActive', async () => {
    const created = await controller.create(createDto('https://api.example.com/hooks'));

    expect(created.url).toBe('https://api.example.com/hooks');
    expect(created.events).toEqual(['account.created', 'sweep.completed']);
    expect(created.isActive).toBe(true);
    // The secret is encrypted before it reaches the repository...
    expect(mockKms.encrypt).toHaveBeenCalledWith('plain-secret-value');
    const persisted = mockRepository.create.mock
      .calls[0][0] as Partial<Webhook>;
    expect(persisted.secret).toBe(ENCRYPTED);
    // ...and never echoed back to the caller.
    expect(created).not.toHaveProperty('secret');
  });

  it('lists only active subscriptions', async () => {
    await controller.create(createDto('https://api.example.com/one'));
    await controller.create(createDto('https://api.example.com/two'));

    // Deactivate the first through the real remove() path.
    const all = await controller.findAll();
    expect(all.total).toBe(2);
    await controller.remove(all.webhooks[0].id);

    const afterRemoval = await controller.findAll();
    expect(afterRemoval.total).toBe(1);
    expect(afterRemoval.webhooks[0].url).toBe('https://api.example.com/two');
  });

  it('paginates and still reports the unpaginated total', async () => {
    for (const n of ['a', 'b', 'c']) {
      await controller.create(createDto(`https://api.example.com/${n}`));
    }

    const page = await controller.findAll('2', '0');
    expect(page.webhooks).toHaveLength(2);
    expect(page.total).toBe(3);
  });

  it('applies isActive on update — the #915 regression', async () => {
    const created = await controller.create(
      createDto('https://api.example.com/hooks'),
    );
    expect(created.isActive).toBe(true);

    const updated = await controller.update(created.id, {
      isActive: false,
    } as UpdateWebhookDto);

    expect(updated.isActive).toBe(false);
  });

  it('rotates the secret on update, re-encrypting it', async () => {
    const created = await controller.create(
      createDto('https://api.example.com/hooks'),
    );
    mockKms.encrypt.mockClear();

    await controller.update(created.id, {
      secret: 'rotated-secret-value',
    } as UpdateWebhookDto);

    expect(mockKms.encrypt).toHaveBeenCalledWith('rotated-secret-value');
    expect(rows[0].secret).toBe(ENCRYPTED);
  });

  it('deactivates rather than deleting on remove, preserving the row', async () => {
    const created = await controller.create(
      createDto('https://api.example.com/hooks'),
    );

    await expect(controller.remove(created.id)).resolves.toBeUndefined();

    // Row survives so delivery history is retained, but is no longer active.
    expect(rows).toHaveLength(1);
    expect(rows[0].isActive).toBe(false);
    expect(mockRepository.update).not.toHaveBeenCalled();
  });

  it('404s on update and remove for an unknown id', async () => {
    await expect(
      controller.update('missing', { description: 'x' } as UpdateWebhookDto),
    ).rejects.toThrow(/not found/i);
    await expect(controller.remove('missing')).rejects.toThrow(/not found/i);
  });
});