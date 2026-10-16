import { jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Account } from '../../../modules/accounts/entities/account.entity.js';
import { PaymentMonitorProvider } from './payment-monitor-provider.js';
import { StellarService } from '../stellar.service.js';
import { AccountStatus } from '../../accounts/enums/account-status.enum.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeAccount = (overrides: Partial<Account> = {}): Account =>
  ({
    id: 'acc-uuid-1',
    publicKey: 'GPUBKEY1234',
    status: AccountStatus.PENDING_PAYMENT,
    // #812: payments are recorded against the per-account contract instance,
    // so the fixture models the column the provider now reads.
    contractId: 'CONTRACT123',
    secretKeyEncrypted: 'enc',
    fundingSource: 'GFUNDING',
    amount: '100',
    asset: 'USDC',
    claimTokenHash: null,
    destinationAddress: null,
    expiresAt: new Date(Date.now() + 86400_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    claimedAt: null,
    expiredAt: null,
    metadata: null,
    ...overrides,
  }) as Account;

const makePaymentRecord = (overrides: Partial<any> = {}) => ({
  type: 'payment',
  to: 'GPUBKEY1234',
  from: 'GSENDER',
  amount: '100.0000000',
  asset_type: 'credit_alphanum4',
  asset_code: 'USDC',
  asset_issuer: 'GBULQKZ7SA56UKRI6LX2IB6XH3GJW2L34BMTOWMQFJBAQNPSHJJNOTGN',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Mock Horizon server
// ---------------------------------------------------------------------------

// Capture the callbacks so tests can invoke them manually
let capturedOnMessage: ((r: any) => void) | null = null;
let capturedOnError: ((e: any) => void) | null = null;
const mockCloseStream = jest.fn();

const mockStreamFn = jest.fn(({ onmessage, onerror }) => {
  capturedOnMessage = onmessage;
  capturedOnError = onerror;
  return mockCloseStream;
});

const mockPaymentsBuilder = {
  forAccount: jest.fn().mockReturnThis(),
  cursor: jest.fn().mockReturnThis(),
  stream: mockStreamFn,
};

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual<typeof import('@stellar/stellar-sdk')>(
    '@stellar/stellar-sdk',
  );
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: jest.fn().mockImplementation(() => ({
        payments: () => mockPaymentsBuilder,
      })),
    },
    Asset: actual.Asset,
    Networks: actual.Networks,
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaymentMonitorProvider', () => {
  let service: PaymentMonitorProvider;
  let stellarService: {
    recordPayment: jest.MockedFunction<StellarService['recordPayment']>;
  };
  let accountsRepo: {
    // #445: `Repository.update()` resolves to an `UpdateResult` carrying
    // `affected`. The mock used to resolve `void`, which is not a faithful
    // stand-in — the provider now branches on `affected` to distinguish a
    // written row from an already-advanced one, so the mock has to model it.
    update: jest.MockedFunction<
      () => Promise<{ affected: number | null; raw: unknown[] }>
    >;
    find: jest.MockedFunction<() => Promise<Account[]>>;
  };
  let configMock: {
    getOrThrow: jest.Mock<(key: string) => string | undefined>;
  };

  beforeEach(async () => {
    capturedOnMessage = null;
    capturedOnError = null;
    mockCloseStream.mockReset();
    mockStreamFn.mockClear();
    mockPaymentsBuilder.forAccount.mockClear();
    mockPaymentsBuilder.cursor.mockClear();

    accountsRepo = {
      update: jest
        .fn<() => Promise<{ affected: number | null; raw: unknown[] }>>()
        .mockResolvedValue({ affected: 1, raw: [] }),
      find: jest.fn<() => Promise<Account[]>>().mockResolvedValue([]),
    };

    const stellarMock = {
      recordPayment: jest
        .fn<StellarService['recordPayment']>()
        .mockResolvedValue(undefined),
    };

    const configMap: Record<string, string> = {
      'stellar.horizonUrl': 'https://horizon-testnet.stellar.org',
      'stellar.fundingSecret': 'SFUNDING_SECRET',
      'stellar.network': 'testnet',
    };
    configMock = {
      getOrThrow: jest.fn((key: string) => configMap[key]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentMonitorProvider,
        { provide: getRepositoryToken(Account), useValue: accountsRepo },
        { provide: StellarService, useValue: stellarMock },
        { provide: ConfigService, useValue: configMock },
      ],
    }).compile();

    service = module.get(PaymentMonitorProvider);

    // bypass real Asset validation - we're not testing address resolution here
    jest
      .spyOn(service as any, 'resolveAssetAddress')
      .mockReturnValue('MOCK_ASSET_CONTRACT_ADDRESS');

    stellarService = module.get(StellarService);
  });

  // -------------------------------------------------------------------------
  // watch() / unwatch()
  // -------------------------------------------------------------------------

  describe('watch()', () => {
    it('opens a Horizon payment stream for the account', () => {
      service.watch(makeAccount());
      expect(mockPaymentsBuilder.forAccount).toHaveBeenCalledWith(
        'GPUBKEY1234',
      );
      expect(mockPaymentsBuilder.cursor).toHaveBeenCalledWith('now');
      expect(mockStreamFn).toHaveBeenCalledTimes(1);
    });

    it('does not open a second stream if already watching', () => {
      const acc = makeAccount();
      service.watch(acc);
      service.watch(acc);
      expect(mockStreamFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('unwatch()', () => {
    it('calls the close handle and removes the account from tracking', () => {
      service.watch(makeAccount());
      service.unwatch('acc-uuid-1');
      expect(mockCloseStream).toHaveBeenCalledTimes(1);
      // Watching again should open a new stream (not a no-op)
      service.watch(makeAccount());
      expect(mockStreamFn).toHaveBeenCalledTimes(2);
    });

    it('is safe to call for an account that is not being watched', () => {
      expect(() => service.unwatch('not-watched')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Payment event handling
  // -------------------------------------------------------------------------

  describe('on inbound payment', () => {
    beforeEach(() => {
      service.watch(makeAccount());
    });

    it('calls recordPayment() with correct params when a valid payment arrives', async () => {
      capturedOnMessage!(makePaymentRecord());
      await Promise.resolve(); // flush microtasks

      expect(stellarService.recordPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          contractId: 'CONTRACT123',
          signerSecret: 'SFUNDING_SECRET',
          amount: expect.any(BigInt),
        }),
      );
    });

    it('updates account status to PENDING_CLAIM after recordPayment() succeeds', async () => {
      capturedOnMessage!(makePaymentRecord());
      await new Promise(setImmediate); // flush async chain

      // #445: the write is conditional on the source status so it cannot move
      // an account backwards and is a no-op once the account has advanced
      // (e.g. the interval poller already moved it). This makes the code match
      // the invariant this file's own class doc already claimed.
      expect(accountsRepo.update).toHaveBeenCalledWith(
        { id: 'acc-uuid-1', status: AccountStatus.PENDING_PAYMENT },
        { status: AccountStatus.PENDING_CLAIM },
      );
    });

    // #445: the self-transition hazard that made the write conditional in the
    // first place. A duplicate payment event for an account the poller has
    // already advanced must not clobber it, and must not throw.
    it('skips the PENDING_CLAIM write when the account already advanced', async () => {
      accountsRepo.update.mockResolvedValue({ affected: 0, raw: [] });

      capturedOnMessage!(makePaymentRecord());
      await new Promise(setImmediate);

      expect(accountsRepo.update).toHaveBeenCalledTimes(1);
      // Still closes the stream — the payment *was* recorded on-chain.
      expect(mockCloseStream).toHaveBeenCalledTimes(1);
    });

    it('closes the stream after a successful payment is recorded', async () => {
      capturedOnMessage!(makePaymentRecord());
      await new Promise(setImmediate);

      expect(mockCloseStream).toHaveBeenCalledTimes(1);
    });

    it('ignores events that are not type "payment"', async () => {
      capturedOnMessage!({ ...makePaymentRecord(), type: 'create_account' });
      await new Promise(setImmediate);

      expect(stellarService.recordPayment).not.toHaveBeenCalled();
    });

    it('ignores payments not addressed to this account', async () => {
      capturedOnMessage!({ ...makePaymentRecord(), to: 'GOTHER' });
      await new Promise(setImmediate);

      expect(stellarService.recordPayment).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Per-account contract ID (#812)
  // -------------------------------------------------------------------------

  describe('per-account contract ID (#812)', () => {
    it('records payments against the account row contract ID, not config', async () => {
      service.watch(makeAccount({ contractId: 'CACCOUNT999' }));
      capturedOnMessage!(makePaymentRecord());
      await new Promise(setImmediate);

      expect(stellarService.recordPayment).toHaveBeenCalledWith(
        expect.objectContaining({ contractId: 'CACCOUNT999' }),
      );
      // The old code read a phantom `stellar.ephemeralContractId` key that
      // exists in no env-validation schema or .env.example.
      expect(configMock.getOrThrow).not.toHaveBeenCalledWith(
        'stellar.ephemeralContractId',
      );
      expect(configMock.getOrThrow).not.toHaveBeenCalledWith(
        'stellar.contracts.ephemeralAccount',
      );
    });

    it('gives a clear error and skips recordPayment when contractId is null', async () => {
      const providerLogger = (
        service as unknown as { logger: { error: (msg: string) => void } }
      ).logger;
      const errorSpy = jest
        .spyOn(providerLogger, 'error')
        .mockImplementation(() => undefined);

      service.watch(makeAccount({ contractId: null }));
      capturedOnMessage!(makePaymentRecord());
      await new Promise(setImmediate);

      expect(stellarService.recordPayment).not.toHaveBeenCalled();
      expect(accountsRepo.update).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Cannot record payment for account acc-uuid-1: no ' +
            'EphemeralAccount contract ID is recorded for it.',
        ),
      );
    });

    it('catches handler rejections so they cannot become unhandled', async () => {
      const providerLogger = (
        service as unknown as { logger: { error: (msg: string) => void } }
      ).logger;
      const errorSpy = jest
        .spyOn(providerLogger, 'error')
        .mockImplementation(() => undefined);

      // recordPayment itself is try/caught inside the handler, but the DB
      // status write is not — that rejection used to escape the `void`.
      accountsRepo.update.mockRejectedValueOnce(new Error('db down'));
      service.watch(makeAccount());
      capturedOnMessage!(makePaymentRecord());
      await new Promise(setImmediate);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Unhandled payment-event error for account acc-uuid-1: db down',
        ),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency — DuplicateAsset
  // -------------------------------------------------------------------------

  describe('idempotency', () => {
    it('treats DuplicateAsset errors as no-ops and leaves stream open', async () => {
      stellarService.recordPayment.mockRejectedValueOnce(
        new Error('DuplicateAsset'),
      );
      service.watch(makeAccount());
      capturedOnMessage!(makePaymentRecord());
      await new Promise(setImmediate);

      expect(accountsRepo.update).not.toHaveBeenCalled();
      expect(mockCloseStream).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Non-retryable contract errors
  // -------------------------------------------------------------------------

  describe('non-retryable contract errors', () => {
    it.each(['TooManyPayments', 'InvalidAmount'])(
      'marks account as FAILED and stops the stream on %s',
      async (errMsg) => {
        stellarService.recordPayment.mockRejectedValueOnce(new Error(errMsg));
        service.watch(makeAccount());
        capturedOnMessage!(makePaymentRecord());
        await new Promise(setImmediate);

        // #445: conditional on PENDING_PAYMENT, so a non-retryable error on an
        // account that has already advanced cannot drag it backwards into
        // FAILED. PENDING_PAYMENT -> FAILED is a legal transition.
        expect(accountsRepo.update).toHaveBeenCalledWith(
          { id: 'acc-uuid-1', status: AccountStatus.PENDING_PAYMENT },
          { status: AccountStatus.FAILED },
        );
        expect(mockCloseStream).toHaveBeenCalledTimes(1);
      },
    );

    // #445: the backwards-move hazard on the FAILED path.
    it('skips the FAILED write when the account already advanced', async () => {
      accountsRepo.update.mockResolvedValue({ affected: 0, raw: [] });
      stellarService.recordPayment.mockRejectedValueOnce(
        new Error('TooManyPayments'),
      );

      service.watch(makeAccount());
      capturedOnMessage!(makePaymentRecord());
      await new Promise(setImmediate);

      expect(accountsRepo.update).toHaveBeenCalledTimes(1);
      expect(mockCloseStream).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Stream error handler
  // -------------------------------------------------------------------------

  describe('stream onerror', () => {
    it('logs the error without closing the stream (Horizon reconnects)', () => {
      service.watch(makeAccount());
      // Should not throw
      expect(() => capturedOnError!(new Error('network blip'))).not.toThrow();
      // Stream is still tracked
      expect(mockCloseStream).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Restart recovery
  // -------------------------------------------------------------------------

  describe('restoreActiveStreams()', () => {
    it('opens streams for all PENDING_PAYMENT accounts found in DB', async () => {
      accountsRepo.find.mockResolvedValueOnce([
        makeAccount({ id: 'a1', publicKey: 'GPK1' }),
        makeAccount({ id: 'a2', publicKey: 'GPK2' }),
      ]);

      await service.restoreActiveStreams();

      expect(mockStreamFn).toHaveBeenCalledTimes(2);
    });

    it('does nothing when there are no active accounts', async () => {
      accountsRepo.find.mockResolvedValueOnce([]);
      await service.restoreActiveStreams();
      expect(mockStreamFn).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  describe('onModuleDestroy()', () => {
    it('closes all open streams', () => {
      service.watch(makeAccount({ id: 'a1', publicKey: 'GPK1' }));
      service.watch(makeAccount({ id: 'a2', publicKey: 'GPK2' }));
      service.onModuleDestroy();
      expect(mockCloseStream).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // Amount conversion
  // -------------------------------------------------------------------------

  describe('parseAmountToStroops (via integration)', () => {
    it('converts "100.0000000" to 1_000_000_000n stroops', async () => {
      service.watch(makeAccount());
      capturedOnMessage!(makePaymentRecord({ amount: '100.0000000' }));
      await new Promise(setImmediate);

      expect(stellarService.recordPayment).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 1_000_000_000n }),
      );
    });

    it('converts "1.5000000" to 15_000_000n stroops', async () => {
      service.watch(makeAccount());
      capturedOnMessage!(makePaymentRecord({ amount: '1.5000000' }));
      await new Promise(setImmediate);

      expect(stellarService.recordPayment).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 15_000_000n }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Horizon paging tokens & multiple inbound payments (#717, re-confirmed #870)
  // -------------------------------------------------------------------------

  describe('multiple inbound payments with paging tokens (#717)', () => {
    beforeEach(() => {
      service.watch(makeAccount());
    });

    it('processes sequence of payments with paging tokens when an account receives multiple payments before expected one', async () => {
      // First event: non-payment operation with earlier paging token
      capturedOnMessage!({
        ...makePaymentRecord({ paging_token: '1000', amount: '0.0000010' }),
        type: 'other_op',
      });
      await new Promise(setImmediate);
      expect(stellarService.recordPayment).not.toHaveBeenCalled();

      // Second event: payment not addressed to watched account
      capturedOnMessage!(
        makePaymentRecord({
          paging_token: '1001',
          to: 'GOTHER',
          amount: '1.0000000',
        }),
      );
      await new Promise(setImmediate);
      expect(stellarService.recordPayment).not.toHaveBeenCalled();

      // Third event: expected valid payment with its paging token
      capturedOnMessage!(
        makePaymentRecord({
          paging_token: '1002',
          amount: '100.0000000',
        }),
      );
      await new Promise(setImmediate);

      expect(stellarService.recordPayment).toHaveBeenCalledTimes(1);
      expect(stellarService.recordPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          contractId: 'CONTRACT123',
          signerSecret: 'SFUNDING_SECRET',
          amount: 1_000_000_000n,
        }),
      );
      expect(accountsRepo.update).toHaveBeenCalledWith(
        { id: 'acc-uuid-1', status: AccountStatus.PENDING_PAYMENT },
        { status: AccountStatus.PENDING_CLAIM },
      );
      expect(mockCloseStream).toHaveBeenCalledTimes(1);
    });
  });
});
