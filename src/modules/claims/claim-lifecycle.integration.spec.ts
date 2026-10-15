/**
 * Integration test for the redemption lifecycle (issue #820).
 *
 * The unit suites mock one side of every boundary, which is exactly why the
 * "validator only accepted PENDING_CLAIM while the redemption provider had
 * already set CLAIMING" regression slipped through: `claim-redemption.provider
 * .spec.ts` stubs `SweepsService` entirely, and `validation.provider.spec.ts`
 * never sees a real redemption.
 *
 * This suite wires the REAL `ClaimRedemptionProvider`, the REAL `SweepsService`
 * and the REAL `ValidationProvider` together, and stubs only:
 *   - the Stellar/Soroban boundary (`StellarService`, `ContractProvider`,
 *     `TransactionProvider`) and
 *   - the database (`DataSource` + repositories).
 *
 * It asserts that an account that starts in PENDING_CLAIM redeems *through*
 * CLAIMING: the real `ValidationProvider.validateSweepParameters` is asked to
 * validate a CLAIMING account mid-flight and must accept it. If the validator
 * goes back to requiring PENDING_CLAIM, `executeSweep` throws before reaching
 * the stubbed contract call and this test fails.
 */

import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { getToken } from '@willsoto/nestjs-prometheus';
import { ConfigService } from '@nestjs/config';
import { ClaimRedemptionProvider } from './providers/claim-redemption.provider.js';
import { TokenVerificationProvider } from './providers/token-verification.provider.js';
import { ClaimAuditProvider } from './providers/claim-audit.provider.js';
import { Claim } from './entities/claim.entity.js';
import { Account } from '../accounts/entities/account.entity.js';
import { AccountStatus } from '../accounts/enums/account-status.enum.js';
import { SweepsService } from '../sweeps/sweeps.service.js';
import { ValidationProvider } from '../sweeps/providers/validation.provider.js';
import { ContractProvider } from '../sweeps/providers/contract.provider.js';
import { TransactionProvider } from '../sweeps/providers/transaction.provider.js';
import { SweepMetricsProvider } from '../sweeps/providers/sweep-metrics.provider.js';
import { StellarService } from '../stellar/stellar.service.js';
import { WebhooksService } from '../webhooks/webhooks.service.js';
import { KmsKeyProvider } from '../../common/crypto/kms-key.provider.js';
import { SecretEncryptionUtil } from '../../common/crypto/secret-encryption.util.js';

const VALID_DESTINATION =
  'GBULQKZ7SA56UKRI6LX2IB6XH3GJW2L34BMTOWMQFJBAQNPSHJJNOTGN';
const VALID_TOKEN = 'valid.jwt.token';
const MOCK_TX_HASH = 'a'.repeat(64);
const MOCK_ACCOUNT_CONTRACT_ID =
  'CACCOUNTINSTANCE0000000000000000000000000000000000000000000';

describe('Claim redemption lifecycle (integration) [issue #820]', () => {
  let provider: ClaimRedemptionProvider;

  // The single Account row the whole flow operates on. The DB stubs below
  // return this same reference so status mutations are observable end to end.
  let account: Account;
  let statusSeenByContractCall: AccountStatus | undefined;

  const claimsRepository = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
    save: jest.fn(),
  };

  const accountsRepository = {
    findOne: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
  };

  const tokenVerificationProvider = {
    verifyClaimToken: jest.fn(),
  };

  const webhooksService = {
    triggerEvent: jest.fn().mockResolvedValue(undefined),
  };

  const claimAuditProvider = {
    record: jest.fn().mockResolvedValue(undefined),
  };

  const kmsKeyProvider = {
    getEncryptionKey: jest.fn().mockReturnValue('a'.repeat(64)),
  };

  const configService = {
    get: jest.fn().mockReturnValue('https://horizon-testnet.stellar.org'),
    getOrThrow: jest.fn().mockReturnValue('SWEEP_CONTROLLER_CONTRACT_ID'),
  };

  const contractProvider = {
    generateAuthSignature: jest.fn().mockReturnValue(Buffer.alloc(64, 1)),
    generateAuthHash: jest.fn().mockReturnValue('deadbeef'.repeat(8)),
  };

  const transactionProvider = {
    executeSweepTransaction: jest.fn().mockResolvedValue({
      hash: MOCK_TX_HASH,
      ledger: 1,
      successful: true,
      timestamp: new Date('2026-10-09T12:00:00.000Z'),
    }),
  };

  const stellarService = {
    getSweepNonce: jest.fn().mockResolvedValue(7n),
    executeSweep: jest.fn(),
  };

  /**
   * A mock EntityManager sufficient for every transaction the claim flow
   * opens:
   *  - the claim-slot lock (SELECT ... FOR UPDATE) returns the account row;
   *  - the sweep lock (#826) issues advisory-lock SQL via `query`;
   *  - the finalise transaction persists the account and the claim.
   */
  function makeManager() {
    const qb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockImplementation(() => Promise.resolve(account)),
    };
    return {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      save: jest.fn().mockImplementation((e: unknown) => Promise.resolve(e)),
      create: jest
        .fn()
        .mockImplementation((_entity: unknown, data: object) => ({ ...data })),
      // #826: SweepsService runs read-nonce → sign → submit inside a
      // transaction-scoped advisory lock, which issues raw SQL via the
      // transaction manager before the contract call.
      query: jest.fn().mockResolvedValue(undefined),
      qb,
    };
  }

  const dataSource = {
    transaction: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    account = {
      id: 'account-uuid-820',
      publicKey: 'GPUBKEY47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLL',
      secretKeyEncrypted: Buffer.from('test-secret').toString('base64'),
      claimTokenHash: 'mock-token-hash',
      amount: '100.0000000',
      asset: 'native',
      status: AccountStatus.PENDING_CLAIM,
      expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
      metadata: { source: 'integration-test' },
      destinationAddress: '',
      contractId: MOCK_ACCOUNT_CONTRACT_ID,
      claimedAt: null,
    } as unknown as Account;

    statusSeenByContractCall = undefined;

    accountsRepository.findOne.mockImplementation(() =>
      Promise.resolve(account),
    );
    // Mirror a real DB write: the rollback in redeemClaim's catch block uses
    // repository.update(), so reflect it on the in-memory row.
    accountsRepository.update.mockImplementation(
      (_id: unknown, patch: object) => {
        Object.assign(account, patch);
        return Promise.resolve(undefined);
      },
    );
    tokenVerificationProvider.verifyClaimToken.mockResolvedValue({
      valid: true,
    });

    // Record the account status at the moment the stubbed contract call runs —
    // i.e. after the real ValidationProvider has accepted (or rejected) it.
    stellarService.executeSweep.mockImplementation(() => {
      statusSeenByContractCall = account.status;
      return Promise.resolve();
    });

    // All DB transactions share the same manager behaviour; the sweep lock
    // (#826) and the finalise transaction do not read via the query builder.
    dataSource.transaction.mockImplementation(
      (cb: (m: unknown) => Promise<unknown>) => cb(makeManager()),
    );

    jest
      .spyOn(ValidationProvider, 'assertDestinationExists')
      .mockResolvedValue(undefined);
    jest.spyOn(SecretEncryptionUtil, 'decrypt').mockReturnValue('test-secret');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClaimRedemptionProvider,
        // Real orchestrator dependencies — the point of this suite.
        SweepsService,
        ValidationProvider,
        // Stubbed Stellar/Soroban boundary.
        { provide: StellarService, useValue: stellarService },
        { provide: ContractProvider, useValue: contractProvider },
        { provide: TransactionProvider, useValue: transactionProvider },
        // Stubbed collaborators.
        {
          provide: TokenVerificationProvider,
          useValue: tokenVerificationProvider,
        },
        { provide: WebhooksService, useValue: webhooksService },
        { provide: ClaimAuditProvider, useValue: claimAuditProvider },
        { provide: KmsKeyProvider, useValue: kmsKeyProvider },
        { provide: ConfigService, useValue: configService },
        {
          provide: SweepMetricsProvider,
          useValue: { recordCompleted: jest.fn(), recordFailed: jest.fn() },
        },
        {
          provide: getToken('sweep_success_total'),
          useValue: { inc: jest.fn() },
        },
        {
          provide: getToken('sweep_failure_total'),
          useValue: { inc: jest.fn() },
        },
        // Stubbed DB.
        {
          provide: getRepositoryToken(Claim),
          useValue: claimsRepository,
        },
        {
          provide: getRepositoryToken(Account),
          useValue: accountsRepository,
        },
        { provide: getDataSourceToken(), useValue: dataSource },
      ],
    }).compile();

    provider = module.get<ClaimRedemptionProvider>(ClaimRedemptionProvider);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('redeems a PENDING_CLAIM account through CLAIMING to CLAIMED', async () => {
    const result = await provider.redeemClaim(
      VALID_TOKEN,
      VALID_DESTINATION,
      '127.0.0.1',
    );

    // The sweep ran while the account was CLAIMING (the real ValidationProvider
    // accepted it), and was only finalised to CLAIMED afterwards.
    expect(statusSeenByContractCall).toBe(AccountStatus.CLAIMING);
    expect(account.status).toBe(AccountStatus.CLAIMED);
    expect(account.claimedAt).toBeInstanceOf(Date);

    expect(result.success).toBe(true);
    expect(result.txHash).toBe(MOCK_TX_HASH);
    expect(result.destination).toBe(VALID_DESTINATION);

    // Three DB transactions: one to take the claim slot, one to serialize the
    // sweep on the SweepController nonce lock (#826), and one to finalise.
    expect(dataSource.transaction).toHaveBeenCalledTimes(3);
    // The payout ran exactly once, after the contract call.
    expect(transactionProvider.executeSweepTransaction).toHaveBeenCalledTimes(
      1,
    );
    expect(stellarService.executeSweep).toHaveBeenCalledTimes(1);
  });

  it('would fail if the real validator rejected a CLAIMING account (unsupported status exercise)', async () => {
    // Allow PENDING_CLAIM -> CLAIMING inside the locked transaction, but force
    // the real validator to reject CLAIMING. Since the current validator accepts
    // CLAIMING and PENDING_CLAIM, this uses a mocked override to simulate the
    // regression case: the validator sees CLAIMING and throws.
    const realValidate = ValidationProvider.prototype.validateSweepParameters;
    jest
      .spyOn(ValidationProvider.prototype, 'validateSweepParameters')
      .mockImplementationOnce(function (
        this: ValidationProvider,
        request: Parameters<ValidationProvider['validateSweepParameters']>[0],
      ) {
        if (account.status === AccountStatus.CLAIMING) {
          throw new BadRequestException(
            'Account cannot be swept. Status: claiming',
          );
        }
        return realValidate.call(this, request);
      });

    await expect(
      provider.redeemClaim(VALID_TOKEN, VALID_DESTINATION),
    ).rejects.toThrow('Account cannot be swept. Status: claiming');
  });

  it('propagates SWEEP_CONTRACT_FAILED (502) unchanged from SweepsService through ClaimRedemptionProvider', async () => {
    // Force SweepsService.executeSweep to throw the distinct 502 contract failure.
    // The real provider must propagate it verbatim (not transform it) and still
    // perform rollback from CLAIMING -> PENDING_CLAIM.
    const { throwSweepContractError, SWEEP_CONTRACT_FAILED } = await import(
      '../../common/errors/contract-error.mapper.js'
    );
    stellarService.executeSweep.mockImplementation(() => {
      statusSeenByContractCall = account.status;
      throwSweepContractError();
    });

    let caught: unknown;
    try {
      await provider.redeemClaim(VALID_TOKEN, VALID_DESTINATION);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    const httpError = caught as {
      getStatus: () => number;
      getResponse: () => unknown;
    };
    expect(httpError.getStatus()).toBe(502);
    const resp = httpError.getResponse() as { errorCode?: string };
    expect(resp.errorCode).toBe(SWEEP_CONTRACT_FAILED);
    // Rollback occurred.
    expect(account.status).toBe(AccountStatus.PENDING_CLAIM);
    expect(stellarService.executeSweep).toHaveBeenCalledTimes(1);
    expect(transactionProvider.executeSweepTransaction).not.toHaveBeenCalled();
  });
});
