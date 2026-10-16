/**
 * E2E test for the webhooks module lifecycle (issue #672, re-confirmed #886).
 *
 * Complements the unit-level `webhooks.controller.spec.ts` and the
 * repository-fake `webhooks.controller.integration.spec.ts` by exercising the
 * real thing end to end:
 *
 *   - boots the full `AppModule` against an embedded PostgreSQL instance, so
 *     the `webhooks` table, its `jsonb` events column, and the real TypeORM
 *     query builder are all exercised;
 *   - drives the full HTTP lifecycle over supertest:
 *       create -> list -> update -> (pause) -> (resume) -> delete
 *     with `JwtAuthGuard` satisfied by a genuinely signed `type: 'api'` JWT
 *     rather than an overridden guard;
 *   - runs a real local HTTP server as the mock receiver, so outbound
 *     delivery, HMAC signing, and event filtering are verified over an actual
 *     socket instead of a stubbed `fetch`.
 *
 * External Stellar/webhook side effects are avoided by only triggering events
 * through the real `WebhooksService.triggerEvent()` (which only does HTTP) and
 * by stubbing the Stellar sweep boundary, which this module does not touch.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import type { AddressInfo } from 'net';
import type { Server as HttpServer } from 'http';
import { mkdtemp, rm } from 'fs/promises';
import EmbeddedPostgres from 'embedded-postgres';

import { AppModule } from '../src/app.module.js';
import { Webhook } from '../src/modules/webhooks/entities/webhook.entity.js';
import { WebhookDelivery } from '../src/modules/webhooks/entities/webhook-delivery.entity.js';
import { WebhooksService } from '../src/modules/webhooks/webhooks.service.js';
import { SchedulerService } from '../src/modules/scheduler/scheduler.service.js';
import { PaymentMonitorService } from '../src/modules/payment-monitor/payment-monitor.service.js';
import { SweepsService } from '../src/modules/sweeps/sweeps.service.js';

const JWT_SECRET = 'e2e-webhooks-jwt-secret';
const WEBHOOK_SECRET = 'e2e-webhook-signing-secret';
const EVENT = 'account.created';
const UNSUBSCRIBED_EVENT = 'sweep.completed';

interface ReceivedDelivery {
  body: string;
  signature: string | undefined;
  event: string | undefined;
  contentType: string | undefined;
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address == null || typeof address === 'string') {
        reject(new Error('Port not allocated'));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

describe('Webhooks lifecycle (e2e) [issue #672]', () => {
  let pg: EmbeddedPostgres | null = null;
  let pgDataDir: string | null = null;
  let app: INestApplication | null = null;
  let ds: DataSource | null = null;
  let webhooksService: WebhooksService;

  /** Mock receiver: records every delivery Bridgelet makes. */
  let receiver: http.Server;
  let receiverUrl: string;
  const received: ReceivedDelivery[] = [];

  const getHttpServer = (): HttpServer => {
    if (!app) throw new Error('Application not initialized');
    return app.getHttpServer() as HttpServer;
  };

  const apiAuth = () => ({ Authorization: `Bearer ${signApiToken()}` });

  function signApiToken(): string {
    return jwt.sign({ type: 'api' }, JWT_SECRET, { expiresIn: '1h' });
  }

  beforeAll(async () => {
    // ── mock HTTP receiver ──────────────────────────────────────────────────
    received.length = 0;
    receiver = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({
          body: Buffer.concat(chunks).toString('utf8'),
          signature: req.headers['x-bridgelet-signature'] as string | undefined,
          event: req.headers['x-bridgelet-event'] as string | undefined,
          contentType: req.headers['content-type'],
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) =>
      receiver.listen(0, '127.0.0.1', resolve),
    );
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks`;

    // ── embedded postgres ───────────────────────────────────────────────────
    const port = await getFreePort();
    pgDataDir = await mkdtemp(
      path.join(os.tmpdir(), 'bridgelet-webhooks-e2e-'),
    );
    pg = new EmbeddedPostgres({
      databaseDir: pgDataDir,
      port,
      user: 'postgres',
      password: 'postgres',
      persistent: false,
      onLog: () => undefined,
      onError: () => undefined,
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('bridgelet_webhooks_e2e');

    process.env.DATABASE_HOST = '127.0.0.1';
    process.env.DATABASE_PORT = String(port);
    process.env.DATABASE_USER = 'postgres';
    process.env.DATABASE_PASSWORD = 'postgres';
    process.env.DATABASE_NAME = 'bridgelet_webhooks_e2e';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.STELLAR_SECRET_ENCRYPTION_KEY = 'a'.repeat(64);
    process.env.CORS_ORIGINS = '*';
    process.env.API_RATE_LIMIT = '1000';
    process.env.NODE_ENV = 'test';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // The webhooks module itself is NOT stubbed: real controller, real
      // service, real repository, real HTTP delivery.
      .overrideProvider(SweepsService)
      .useValue({
        executeSweep: () => Promise.resolve({ txHash: 'a'.repeat(64) }),
      })
      .overrideProvider(SchedulerService)
      .useValue({
        handleCron: () => Promise.resolve(),
        handleExpiredClaims: () => Promise.resolve(),
      })
      .overrideProvider(PaymentMonitorService)
      .useValue({
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
        poll: () => Promise.resolve(),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    ds = app.get(DataSource);
    webhooksService = app.get(WebhooksService);
  }, 180_000);

  afterAll(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    if (pg) {
      await pg.stop();
      pg = null;
    }
    if (pgDataDir) {
      await rm(pgDataDir, { recursive: true, force: true });
      pgDataDir = null;
    }
    if (receiver) {
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    }
  });

  beforeEach(async () => {
    if (!ds) throw new Error('DataSource not ready');
    await ds
      .getRepository(WebhookDelivery)
      .createQueryBuilder()
      .delete()
      .execute();
    await ds.getRepository(Webhook).createQueryBuilder().delete().execute();
    received.length = 0;
  });

  /** triggerEvent is fire-and-forget; give the in-flight fetch time to land. */
  const settleDeliveries = () =>
    new Promise((resolve) => setTimeout(resolve, 250));

  describe('CRUD lifecycle over HTTP', () => {
    it('create -> list -> update -> delete against a real repository', async () => {
      const createRes = await request(getHttpServer())
        .post('/webhooks')
        .set(apiAuth())
        .send({
          url: receiverUrl,
          events: [EVENT],
          secret: WEBHOOK_SECRET,
          description: 'e2e lifecycle',
        });

      expect(createRes.status).toBe(201);
      expect(createRes.body).toEqual(
        expect.objectContaining({
          url: receiverUrl,
          events: [EVENT],
          isActive: true,
          description: 'e2e lifecycle',
        }),
      );
      const id: string = createRes.body.id;
      expect(typeof id).toBe('string');

      // The row really is in Postgres.
      const stored = await ds!.getRepository(Webhook).findOneByOrFail({ id });
      expect(stored.url).toBe(receiverUrl);
      expect(stored.events).toEqual([EVENT]);

      // List returns it.
      const listRes = await request(getHttpServer())
        .get('/webhooks')
        .set(apiAuth());
      expect(listRes.status).toBe(200);
      expect(listRes.body.webhooks.map((w: { id: string }) => w.id)).toContain(
        id,
      );
      expect(listRes.body.total).toBe(1);

      // Update is reflected in both the response and the row.
      const updateRes = await request(getHttpServer())
        .put(`/webhooks/${id}`)
        .set(apiAuth())
        .send({ description: 'updated description' });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.description).toBe('updated description');
      const afterUpdate = await ds!.getRepository(Webhook).findOneByOrFail({
        id,
      });
      expect(afterUpdate.description).toBe('updated description');

      // Delete deactivates, so it disappears from the (active-only) listing.
      const deleteRes = await request(getHttpServer())
        .delete(`/webhooks/${id}`)
        .set(apiAuth());
      expect(deleteRes.status).toBeLessThan(400);

      const listAfter = await request(getHttpServer())
        .get('/webhooks')
        .set(apiAuth());
      expect(listAfter.body.webhooks).toHaveLength(0);
      // ...but the row survives (soft delete).
      const afterDelete = await ds!.getRepository(Webhook).findOneByOrFail({
        id,
      });
      expect(afterDelete.isActive).toBe(false);
    });

    it('rejects unauthenticated access', async () => {
      await request(getHttpServer()).get('/webhooks').expect(401);
      await request(getHttpServer())
        .post('/webhooks')
        .send({ url: receiverUrl, events: [EVENT] })
        .expect(401);
    });

    it('rejects a webhook with a too-short secret', async () => {
      const res = await request(getHttpServer())
        .post('/webhooks')
        .set(apiAuth())
        .send({ url: receiverUrl, events: [EVENT], secret: 'short' });
      expect(res.status).toBe(400);
    });

    it('404s when updating or deleting an unknown webhook', async () => {
      const unknown = '00000000-0000-4000-8000-000000000000';
      await request(getHttpServer())
        .put(`/webhooks/${unknown}`)
        .set(apiAuth())
        .send({ description: 'nope' })
        .expect(404);
      await request(getHttpServer())
        .delete(`/webhooks/${unknown}`)
        .set(apiAuth())
        .expect(404);
    });
  });

  describe('delivery to a mock HTTP receiver', () => {
    const createWebhook = async (events: string[], secret?: string) => {
      const res = await request(getHttpServer())
        .post('/webhooks')
        .set(apiAuth())
        .send({ url: receiverUrl, events, ...(secret ? { secret } : {}) });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    it('delivers a subscribed event with a verifiable HMAC signature', async () => {
      await createWebhook([EVENT], WEBHOOK_SECRET);

      await webhooksService.triggerEvent(EVENT, {
        accountId: 'acct-e2e-1',
        amount: '10.0000000',
      });
      await settleDeliveries();

      expect(received).toHaveLength(1);
      const delivery = received[0];
      expect(delivery.event).toBe(EVENT);
      expect(delivery.contentType).toContain('application/json');
      expect(JSON.parse(delivery.body)).toEqual(
        expect.objectContaining({ event: EVENT, accountId: 'acct-e2e-1' }),
      );

      // The integrator-facing contract from docs/webhook-events.md: recompute
      // HMAC-SHA256 over the raw body and compare to the header.
      const expected = crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(delivery.body)
        .digest('hex');
      expect(delivery.signature).toBe(`sha256=${expected}`);
    });

    it('does not deliver an event the subscription is not registered for', async () => {
      await createWebhook([EVENT], WEBHOOK_SECRET);

      await webhooksService.triggerEvent(UNSUBSCRIBED_EVENT, {
        accountId: 'acct-e2e-2',
      });
      await settleDeliveries();

      expect(received).toHaveLength(0);
    });

    it('stops delivering after the subscription is deactivated', async () => {
      const id = await createWebhook([EVENT], WEBHOOK_SECRET);

      await request(getHttpServer())
        .put(`/webhooks/${id}`)
        .set(apiAuth())
        .send({ isActive: false });
      await settleDeliveries();

      await webhooksService.triggerEvent(EVENT, { accountId: 'acct-e2e-3' });
      await settleDeliveries();

      expect(received).toHaveLength(0);
    });

    it('resumes delivering once reactivated', async () => {
      const id = await createWebhook([EVENT], WEBHOOK_SECRET);

      await request(getHttpServer())
        .put(`/webhooks/${id}`)
        .set(apiAuth())
        .send({ isActive: false });
      await request(getHttpServer())
        .put(`/webhooks/${id}`)
        .set(apiAuth())
        .send({ isActive: true });

      await webhooksService.triggerEvent(EVENT, { accountId: 'acct-e2e-4' });
      await settleDeliveries();

      expect(received).toHaveLength(1);
    });

    it('delivers to every subscription registered for the event', async () => {
      await createWebhook([EVENT], WEBHOOK_SECRET);
      await createWebhook([EVENT, UNSUBSCRIBED_EVENT], WEBHOOK_SECRET);

      await webhooksService.triggerEvent(EVENT, { accountId: 'acct-e2e-5' });
      await settleDeliveries();

      expect(received).toHaveLength(2);
    });

    it('records lastTriggeredAt on the subscription after a delivery', async () => {
      const id = await createWebhook([EVENT], WEBHOOK_SECRET);
      expect(
        (await ds!.getRepository(Webhook).findOneByOrFail({ id }))
          .lastTriggeredAt,
      ).toBeNull();

      await webhooksService.triggerEvent(EVENT, { accountId: 'acct-e2e-6' });
      await settleDeliveries();

      expect(
        (await ds!.getRepository(Webhook).findOneByOrFail({ id }))
          .lastTriggeredAt,
      ).not.toBeNull();
    });
  });
});
