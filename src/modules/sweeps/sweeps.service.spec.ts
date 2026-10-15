import { jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { SweepsService } from './sweeps.service.js';
import { ValidationProvider } from './providers/validation.provider.js';
import { ContractProvider } from './providers/contract.provider.js';
import { TransactionProvider } from './providers/transaction.provider.js';
import { StellarService } from '../stellar/stellar.service.js';
import { ConfigService } from '@nestjs/config';
import { getToken } from '@willsoto/nestjs-prometheus';
import { SweepMetricsProvider } from './providers/sweep-metrics.provider.js';
import { Registry, register } from 'prom-client';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_AUTH_SIGNATURE = Buffer.alloc(64, 1);
const MOCK_TX_HASH = 'abc123txhash';
const MOCK_CONTRACT_AUTH_HASH = 'deadbeef'.repeat(8); // 64-char hex
// #812: the account's own EphemeralAccount instance, and a SweepController
// nonce that is deliberately NOT 0 so a hard-coded 0n would be caught.
const MOCK_ACCOUNT_CONTRACT_ID =
  'CACCOUNTINSTANCE0000000000000000000000000000000000000000000';
const MOCK_SWEEP_NONCE = 7n;

const validRequest = {
  accountId: 'test-account-id',
  ephemeralPublicKey:
    'GEPH47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  ephemeralSecret: 'SEPH47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  destinationAddress:
    'GBULQKZ7SA56UKRI6LX2IB6XH3GJW2L34BMTOWMQFJBAQNPSHJJNOTGN',
  amount: '100.0000000',
  asset: 'native',
  contractId: MOCK_ACCOUNT_CONTRACT_ID,
};

const mockTxResult = {
  hash: MOCK_TX_HASH,
  ledger: 12345,
  successful: true,
  timestamp: new Date('2024-01-01T12:00:00Z'),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SweepsService', () => {
  let service: SweepsService;
  type SweepStatusResult = Awaited<
    ReturnType<ValidationProvider['getSweepStatus']>
  >;

  let validationProvider: {
    validateSweepParameters: jest.Mock<() => Promise<any>>;
    canSweep: jest.Mock<() => Promise<any>>;
    getSweepStatus: jest.Mock<() => Promise<any>>;
  };
  let contractProvider: {
    generateAuthSignature: jest.Mock<() => any>;
    generateAuthHash: jest.Mock<() => any>;
  };
  let transactionProvider: {
    executeSweepTransaction: jest.Mock<() => Promise<any>>;
  };
  let stellarService: {
    executeSweep: jest.Mock<() => Promise<any>>;
    getSweepNonce: jest.Mock<() => Promise<any>>;
  };
  let configMock: { getOrThrow: jest.Mock };

  // #826: a DataSource whose `transaction()` serializes callbacks, modelling
  // the mutual exclusion pg_advisory_xact_lock provides in production. A
  // caller's callback does not start until the previous transaction settles;
  // a rejection releases the "lock" (the chain continues).
  type Manager = { query: jest.Mock<() => Promise<unknown>> };
  let managers: Manager[];
  let dataSource: {
    transaction: jest.Mock<
      (cb: (manager: Manager) => Promise<unknown>) => Promise<unknown>
    >;
  };

  beforeEach(async () => {
    let tail: Promise<unknown> = Promise.resolve();
    managers = [];
    dataSource = {
      transaction: jest
        .fn<any>()
        .mockImplementation((cb: (manager: Manager) => Promise<unknown>) => {
          const manager: Manager = {
            query: jest.fn<any>().mockResolvedValue(undefined),
          };
          managers.push(manager);
          const run = tail.then(() => cb(manager));
          tail = run.then(
            () => undefined,
            () => undefined,
          );
          return run;
        }),
    };

    validationProvider = {
      validateSweepParameters: jest.fn<any>().mockResolvedValue(undefined),
      canSweep: jest.fn<any>().mockResolvedValue(true),
      getSweepStatus: jest.fn<any>().mockResolvedValue({ canSweep: true }),
    };

    contractProvider = {
      generateAuthSignature: jest
        .fn<any>()
        .mockReturnValue(MOCK_AUTH_SIGNATURE),
      generateAuthHash: jest.fn<any>().mockReturnValue(MOCK_CONTRACT_AUTH_HASH),
    };

    transactionProvider = {
      executeSweepTransaction: jest.fn<any>().mockResolvedValue(mockTxResult),
    };

    stellarService = {
      executeSweep: jest.fn<any>().mockResolvedValue(undefined),
      getSweepNonce: jest.fn<any>().mockResolvedValue(MOCK_SWEEP_NONCE),
    };

    configMock = {
      getOrThrow: jest.fn((key: string) => {
        const map: Record<string, string> = {
          'stellar.contracts.sweepController': 'SWEEP_CTRL_CONTRACT_ID',
          // #812: still configured for the payment monitor / ContractProvider,
          // but the sweep path must never read it.
          'stellar.contracts.ephemeralAccount': 'EPHEMERAL_CONTRACT_ID',
        };
        if (!(key in map)) throw new Error(`Config key not found: ${key}`);
        return map[key];
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SweepsService,
        SweepMetricsProvider,
        { provide: ValidationProvider, useValue: validationProvider },
        { provide: ContractProvider, useValue: contractProvider },
        { provide: TransactionProvider, useValue: transactionProvider },
        { provide: StellarService, useValue: stellarService },
        { provide: ConfigService, useValue: configMock },
        { provide: getDataSourceToken(), useValue: dataSource },
        {
          provide: getToken('sweep_success_total'),
          useValue: { inc: jest.fn() },
        },
        {
          provide: getToken('sweep_failure_total'),
          useValue: { inc: jest.fn() },
        },
        {
          provide: Registry,
          useValue: register,
        },
      ],
    }).compile();

    service = module.get<SweepsService>(SweepsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Happy path — full flow
  // -------------------------------------------------------------------------

  describe('executeSweep — happy path', () => {
    it('calls validation first', async () => {
      await service.executeSweep(validRequest);
      expect(validationProvider.validateSweepParameters).toHaveBeenCalledWith(
        validRequest,
      );
    });

    it('generates auth signature via ContractProvider', async () => {
      await service.executeSweep(validRequest);
      // #812: the nonce read from the SweepController is signed, not 0n.
      expect(contractProvider.generateAuthSignature).toHaveBeenCalledWith({
        ephemeralPublicKey: validRequest.ephemeralPublicKey,
        destinationAddress: validRequest.destinationAddress,
        contractId: MOCK_ACCOUNT_CONTRACT_ID,
        nonce: MOCK_SWEEP_NONCE,
      });
    });

    // -----------------------------------------------------------------------
    // #812: per-account contract ID + live sweep nonce
    // -----------------------------------------------------------------------

    it('reads the sweep nonce from the SweepController before signing', async () => {
      await service.executeSweep(validRequest);

      expect(stellarService.getSweepNonce).toHaveBeenCalledWith(
        'SWEEP_CTRL_CONTRACT_ID',
      );
    });

    it('signs the nonce that was read, never a stale 0n', async () => {
      stellarService.getSweepNonce.mockResolvedValue(41n);

      await service.executeSweep(validRequest);

      const signedParams = contractProvider.generateAuthSignature.mock
        .calls[0][0] as { nonce: bigint };
      expect(signedParams.nonce).toBe(41n);
      expect(signedParams.nonce).not.toBe(0n);
    });

    it("submits execute_sweep against the account's own contract instance", async () => {
      await service.executeSweep(validRequest);

      expect(stellarService.executeSweep).toHaveBeenCalledWith(
        expect.objectContaining({
          ephemeralAccountContractId: MOCK_ACCOUNT_CONTRACT_ID,
        }),
      );
    });

    it('never reads the shared ephemeral-account contract ID from config', async () => {
      await service.executeSweep(validRequest);

      expect(
        configMock.getOrThrow.mock.calls.map((call) => call[0]),
      ).not.toContain('stellar.contracts.ephemeralAccount');
    });

    it('submits the contract call via StellarService.executeSweep()', async () => {
      await service.executeSweep(validRequest);
      expect(stellarService.executeSweep).toHaveBeenCalledWith({
        sweepControllerContractId: 'SWEEP_CTRL_CONTRACT_ID',
        // #812: the account's own instance, not the shared config value.
        ephemeralAccountContractId: MOCK_ACCOUNT_CONTRACT_ID,
        destination: validRequest.destinationAddress,
        authSignature: MOCK_AUTH_SIGNATURE,
        signerSecret: validRequest.ephemeralSecret,
      });
    });

    it('executes the Horizon payment via TransactionProvider', async () => {
      await service.executeSweep(validRequest);
      expect(transactionProvider.executeSweepTransaction).toHaveBeenCalledWith({
        ephemeralSecret: validRequest.ephemeralSecret,
        destinationAddress: validRequest.destinationAddress,
        amount: validRequest.amount,
        asset: validRequest.asset,
      });
    });

    it('calls validation before the contract call', async () => {
      const order: string[] = [];
      validationProvider.validateSweepParameters.mockImplementation(() => {
        order.push('validate');
        return Promise.resolve();
      });
      stellarService.executeSweep.mockImplementation(() => {
        order.push('contract');
        return Promise.resolve();
      });

      await service.executeSweep(validRequest);

      expect(order.indexOf('validate')).toBeLessThan(order.indexOf('contract'));
    });

    it('calls the contract before the Horizon payment', async () => {
      const order: string[] = [];
      stellarService.executeSweep.mockImplementation(() => {
        order.push('contract');
        return Promise.resolve();
      });
      transactionProvider.executeSweepTransaction.mockImplementation(() => {
        order.push('payment');
        return Promise.resolve(mockTxResult as any);
      });

      await service.executeSweep(validRequest);

      expect(order.indexOf('contract')).toBeLessThan(order.indexOf('payment'));
    });

    it('returns the real txHash from the Horizon payment', async () => {
      const result = await service.executeSweep(validRequest);
      expect(result.txHash).toBe(MOCK_TX_HASH);
    });

    it('returns success: true and correct fields', async () => {
      const result = await service.executeSweep(validRequest);
      expect(result).toEqual({
        success: true,
        txHash: MOCK_TX_HASH,
        contractAuthHash: MOCK_CONTRACT_AUTH_HASH,
        amountSwept: validRequest.amount,
        destination: validRequest.destinationAddress,
        timestamp: mockTxResult.timestamp,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Error propagation
  // -------------------------------------------------------------------------

  describe('executeSweep — error propagation', () => {
    it('propagates validation errors and does not proceed', async () => {
      validationProvider.validateSweepParameters.mockRejectedValue(
        new Error('Validation failed'),
      );

      await expect(service.executeSweep(validRequest)).rejects.toThrow(
        'Validation failed',
      );
      expect(stellarService.executeSweep).not.toHaveBeenCalled();
      expect(
        transactionProvider.executeSweepTransaction,
      ).not.toHaveBeenCalled();
    });

    it('propagates StellarService.executeSweep() errors and does not call Horizon payment', async () => {
      stellarService.executeSweep.mockRejectedValue(new Error('ALREADY_SWEPT'));

      await expect(service.executeSweep(validRequest)).rejects.toThrow(
        'ALREADY_SWEPT',
      );
      expect(
        transactionProvider.executeSweepTransaction,
      ).not.toHaveBeenCalled();
    });

    // Issue #820: a failed Soroban simulation/contract call is deterministic —
    // retrying cannot fix it — so it must surface as a distinct, stable error
    // code (502 SWEEP_CONTRACT_FAILED) rather than a generic 500. The raw host
    // error stays in the logs and out of the response body.
    it('maps a simulated contract failure to 502 SWEEP_CONTRACT_FAILED and keeps the host error in the logs', async () => {
      const hostError = new Error(
        'Transaction simulation failed: HostError: Error(Auth, InvalidAction)',
      );
      stellarService.executeSweep.mockRejectedValue(hostError);
      const loggerErrorSpy = jest
        .spyOn(service['logger'], 'error')
        .mockImplementation(() => {});

      let caught: unknown;
      try {
        await service.executeSweep(validRequest);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(HttpException);
      const httpError = caught as HttpException;
      expect(httpError.getStatus()).toBe(502);
      expect(httpError.getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'SWEEP_CONTRACT_FAILED' }),
      );
      // The raw host error is logged...
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('HostError: Error(Auth, InvalidAction)'),
        hostError.stack,
      );
      // ...and never returned to the caller.
      expect(JSON.stringify(httpError.getResponse())).not.toContain(
        'HostError',
      );
      // The payout must not run once the contract call has failed.
      expect(
        transactionProvider.executeSweepTransaction,
      ).not.toHaveBeenCalled();
    });

    it('maps a submitted-then-rejected execute_sweep transaction whose error carries a contract marker to SWEEP_CONTRACT_FAILED', async () => {
      stellarService.executeSweep.mockRejectedValue(
        new Error(
          'execute_sweep failed: {"status":"ERROR","error":"Error(Contract, AlreadySwept)"}',
        ),
      );
      jest.spyOn(service['logger'], 'error').mockImplementation(() => {});

      let caught: unknown;
      try {
        await service.executeSweep(validRequest);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(HttpException);
      expect((caught as HttpException).getStatus()).toBe(502);
      expect((caught as HttpException).getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'SWEEP_CONTRACT_FAILED' }),
      );
    });

    it('does not map a submit rejection with no contract marker (e.g. sequence) to SWEEP_CONTRACT_FAILED — it stays retryable', async () => {
      const txBadSeq = new Error(
        'execute_sweep failed: {"status":"ERROR","error":"tx_bad_seq"}',
      );
      stellarService.executeSweep.mockRejectedValue(txBadSeq);

      await expect(service.executeSweep(validRequest)).rejects.toThrow(
        'execute_sweep failed',
      );
    });

    // Regression: prior behaviour propagated Horizon payment errors.
    // Since #169, sweeper for the contract-authorized-but-payment-failed
    // path no longer throws — it returns a structured isPartial result so
    // the orchestrator can transition the account into PARTIAL_SWEEP and
    // emit a sweep.partial webhook. The new contract is asserted by the
    // dedicated `isPartial` test below; we deliberately omit the old
    // `propagates TransactionProvider errors` test here.

    it('returns isPartial: true (does NOT throw) when Horizon payment fails after contract authorization', async () => {
      const horizonError = new Error('Horizon payment failed');
      transactionProvider.executeSweepTransaction.mockRejectedValue(
        horizonError,
      );

      // Spy on the service's private logger
      const loggerErrorSpy = jest
        .spyOn(service['logger'], 'error')
        .mockImplementation(() => {});

      // The sweeper no longer throws — it returns a structured partial
      // result so the orchestrator can transition the account to PARTIAL_SWEEP
      // and emit a sweep.partial webhook.
      const result = await service.executeSweep(validRequest);

      expect(result.success).toBe(false);
      expect(result.isPartial).toBe(true);
      expect(result.error).toBe('Horizon payment failed');
      expect(result.contractAuthHash).toBe(MOCK_CONTRACT_AUTH_HASH);
      expect(result.amountSwept).toBe(validRequest.amount);
      expect(result.destination).toBe(validRequest.destinationAddress);
      expect(result.txHash).toBeUndefined();
      expect(result.timestamp).toBeUndefined();

      // The log line is now PARTIAL (not CRITICAL) to distinguish recoverable
      // vs fatal in monitoring.
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('PARTIAL sweep'),
        horizonError.stack,
      );
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(validRequest.accountId),
        horizonError.stack,
      );
    });

    it('skips contract auth + execute_sweep when skipContractAuth=true; only runs Horizon payment', async () => {
      await service.executeSweep({
        ...validRequest,
        skipContractAuth: true,
      });

      expect(contractProvider.generateAuthSignature).not.toHaveBeenCalled();
      expect(stellarService.executeSweep).not.toHaveBeenCalled();
      // A PARTIAL_SWEEP retry never touches the contract, so it must not need
      // (or read) the sweep nonce either.
      expect(stellarService.getSweepNonce).not.toHaveBeenCalled();
      // The Horizon payment still runs to retry the failed payment.
      expect(transactionProvider.executeSweepTransaction).toHaveBeenCalledWith({
        ephemeralSecret: validRequest.ephemeralSecret,
        destinationAddress: validRequest.destinationAddress,
        amount: validRequest.amount,
        asset: validRequest.asset,
      });
    });

    it('returns a success result with txHash when skipContractAuth=true and the Horizon payment succeeds', async () => {
      const result = await service.executeSweep({
        ...validRequest,
        skipContractAuth: true,
      });

      expect(result.isPartial).toBeUndefined();
      expect(result.success).toBe(true);
      expect(result.txHash).toBe(MOCK_TX_HASH);
      expect(result.contractAuthHash).toBe(MOCK_CONTRACT_AUTH_HASH);
    });

    it('returns isPartial: true when skipContractAuth=true but the Horizon payment still fails', async () => {
      transactionProvider.executeSweepTransaction.mockRejectedValue(
        new Error('Horizon offline'),
      );

      const result = await service.executeSweep({
        ...validRequest,
        skipContractAuth: true,
      });

      expect(result.isPartial).toBe(true);
      expect(result.error).toBe('Horizon offline');
      // Skipped contract side did NOT happen.
      expect(contractProvider.generateAuthSignature).not.toHaveBeenCalled();
      expect(stellarService.executeSweep).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // #812: missing per-account contract ID
  // -------------------------------------------------------------------------

  describe('executeSweep — account.contractId is null', () => {
    const nullContractRequest = { ...validRequest, contractId: null };

    it('throws an error naming the account', async () => {
      await expect(service.executeSweep(nullContractRequest)).rejects.toThrow(
        /test-account-id/,
      );
      await expect(service.executeSweep(nullContractRequest)).rejects.toThrow(
        /no EphemeralAccount contract ID/,
      );
    });

    it('does not sign, does not call the contract and does not pay', async () => {
      await expect(service.executeSweep(nullContractRequest)).rejects.toThrow();

      expect(stellarService.getSweepNonce).not.toHaveBeenCalled();
      expect(contractProvider.generateAuthSignature).not.toHaveBeenCalled();
      expect(stellarService.executeSweep).not.toHaveBeenCalled();
      expect(
        transactionProvider.executeSweepTransaction,
      ).not.toHaveBeenCalled();
    });

    it('propagates the failure instead of returning a partial result', async () => {
      // A missing contract ID is a data problem, not a "contract authorized but
      // the payment failed" case, so it must not be reported as isPartial.
      const result = await service
        .executeSweep(nullContractRequest)
        .then((r) => r)
        .catch((e: unknown) => e);

      expect(result).toBeInstanceOf(Error);
    });

    it('still allows a PARTIAL_SWEEP retry, which never touches the contract', async () => {
      const result = await service.executeSweep({
        ...nullContractRequest,
        skipContractAuth: true,
      });

      expect(result.success).toBe(true);
      expect(stellarService.executeSweep).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // canSweep / getSweepStatus — delegates unchanged
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // #826: serialize the shared SweepController nonce across instances
  // -------------------------------------------------------------------------

  describe('executeSweep — #826 nonce serialization', () => {
    it('holds a per-controller advisory lock around read-nonce → sign → submit', async () => {
      await service.executeSweep(validRequest);

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      const [manager] = managers;
      // Bounds the wait first, then takes the transaction-scoped lock.
      expect(manager.query).toHaveBeenNthCalledWith(
        1,
        'SET LOCAL lock_timeout = 10000',
      );
      expect(manager.query).toHaveBeenNthCalledWith(
        2,
        'SELECT pg_advisory_xact_lock($1::bigint)',
        [expect.stringMatching(/^-?\d+$/)],
      );
    });

    it('keys the lock on the SweepController contract ID, not the account', async () => {
      const { advisoryLockKey } = await import(
        '../../common/locks/advisory-lock.util.js'
      );
      await service.executeSweep(validRequest);

      const [[, [key]]] = managers[0].query.mock.calls.filter(
        (call) => call[0] === 'SELECT pg_advisory_xact_lock($1::bigint)',
      );
      expect(key).toBe(
        advisoryLockKey('sweep-controller-nonce', 'SWEEP_CTRL_CONTRACT_ID'),
      );
      expect(key).not.toBe(
        advisoryLockKey('sweep-controller-nonce', MOCK_ACCOUNT_CONTRACT_ID),
      );
    });

    it('serializes two concurrent sweeps: the second waits and signs the next nonce', async () => {
      stellarService.getSweepNonce
        .mockResolvedValueOnce(1n)
        .mockResolvedValueOnce(2n);

      let signalFirstInContract: () => void = () => {};
      const firstInContract = new Promise<void>((resolve) => {
        signalFirstInContract = resolve;
      });
      let releaseFirst: () => void = () => {};
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      let contractCalls = 0;
      stellarService.executeSweep.mockImplementation(async () => {
        contractCalls += 1;
        if (contractCalls === 1) {
          signalFirstInContract();
          await firstGate;
        }
      });

      const first = service.executeSweep(validRequest);
      const second = service.executeSweep(validRequest);

      // Wait until the first sweep is inside the contract call (holding the
      // lock) before inspecting the second.
      await firstInContract;
      // The second must not have read the nonce while the lock was held.
      expect(stellarService.getSweepNonce).toHaveBeenCalledTimes(1);

      releaseFirst();
      await Promise.all([first, second]);

      expect(stellarService.getSweepNonce).toHaveBeenCalledTimes(2);
      const signedNonces =
        contractProvider.generateAuthSignature.mock.calls.map(
          (call) => (call[0] as { nonce: bigint }).nonce,
        );
      expect(signedNonces).toEqual([1n, 2n]);
    });

    it('releases the lock after a failing sweep so the next sweep proceeds', async () => {
      stellarService.executeSweep
        .mockRejectedValueOnce(new Error('tx_bad_seq'))
        .mockResolvedValueOnce(undefined);

      await expect(service.executeSweep(validRequest)).rejects.toThrow(
        'tx_bad_seq',
      );

      const result = await service.executeSweep(validRequest);
      expect(result.success).toBe(true);
      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
    });

    it('retries once with a freshly read nonce on InvalidNonce', async () => {
      stellarService.getSweepNonce
        .mockResolvedValueOnce(5n)
        .mockResolvedValueOnce(6n);
      stellarService.executeSweep
        .mockRejectedValueOnce(
          new Error(
            'Transaction simulation failed: HostError: Error(Contract, #11)',
          ),
        )
        .mockResolvedValueOnce(undefined);
      jest.spyOn(service['logger'], 'warn').mockImplementation(() => {});

      const result = await service.executeSweep(validRequest);

      expect(result.success).toBe(true);
      expect(stellarService.getSweepNonce).toHaveBeenCalledTimes(2);
      expect(stellarService.executeSweep).toHaveBeenCalledTimes(2);
      const signedNonces =
        contractProvider.generateAuthSignature.mock.calls.map(
          (call) => (call[0] as { nonce: bigint }).nonce,
        );
      expect(signedNonces).toEqual([5n, 6n]);
    });

    it('does not retry a deterministic contract failure (maps it to 502)', async () => {
      stellarService.executeSweep.mockRejectedValue(
        new Error('HostError: Error(Auth, InvalidAction)'),
      );
      jest.spyOn(service['logger'], 'error').mockImplementation(() => {});

      let caught: unknown;
      try {
        await service.executeSweep(validRequest);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(HttpException);
      expect((caught as HttpException).getStatus()).toBe(502);
      expect(stellarService.getSweepNonce).toHaveBeenCalledTimes(1);
      expect(stellarService.executeSweep).toHaveBeenCalledTimes(1);
    });

    it('does not hold the lock during the Horizon payout', async () => {
      const order: string[] = [];
      const inner = dataSource.transaction.getMockImplementation();
      dataSource.transaction.mockImplementation(async (cb) => {
        order.push('lock-enter');
        const result = await inner!(cb);
        order.push('lock-exit');
        return result;
      });
      transactionProvider.executeSweepTransaction.mockImplementation(() => {
        order.push('payout');
        return Promise.resolve(mockTxResult as any);
      });

      await service.executeSweep(validRequest);

      expect(order).toContain('lock-enter');
      expect(order.indexOf('lock-exit')).toBeLessThan(order.indexOf('payout'));
    });

    it('does not acquire the lock on a skip-contract-auth retry', async () => {
      await service.executeSweep({
        ...validRequest,
        skipContractAuth: true,
      });

      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe('canSweep', () => {
    it('delegates to ValidationProvider', async () => {
      validationProvider.canSweep.mockResolvedValue(true);
      const result = await service.canSweep('account-id', 'GDEST...');
      expect(validationProvider.canSweep).toHaveBeenCalledWith(
        'account-id',
        'GDEST...',
      );
      expect(result).toBe(true);
    });
  });

  describe('getSweepStatus', () => {
    it('delegates to ValidationProvider', async () => {
      const sweepStatus: SweepStatusResult = {
        canSweep: false,
        reason: 'expired',
      };
      validationProvider.getSweepStatus.mockResolvedValue(sweepStatus);
      const result = await service.getSweepStatus('account-id');
      expect(validationProvider.getSweepStatus).toHaveBeenCalledWith(
        'account-id',
      );
      expect(result).toEqual({ canSweep: false, reason: 'expired' });
    });
  });
});
