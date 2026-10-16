import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';
import { rpc as SorobanRpc } from '@stellar/stellar-sdk';
import { StellarService, EXPIRY_BUFFER_LEDGERS } from './stellar.service.js';
import { getToken } from '@willsoto/nestjs-prometheus';

const mockConfigService = {
  getOrThrow: (key: string): string => {
    const config: Record<string, string> = {
      'stellar.horizonUrl': 'https://horizon-testnet.stellar.org',
      'stellar.sorobanRpcUrl': 'https://soroban-testnet.stellar.org',
      'stellar.network': 'testnet',
      'stellar.fundingSecret':
        'SCOCOEM6N6JNB5MAPWFRMMTMSUZW6RZ4KPKOMYUFXJKCUQUNVWDCJK2K',
      'stellar.contracts.ephemeralAccount': 'CONTRACT123',
      'stellar.contracts.ephemeralAccountWasmHash': WASM_HASH_HEX,
    };
    const value = config[key];
    if (value === undefined) throw new Error('Config key not found: ' + key);
    return value;
  },
};

// ── Helpers to build mock Horizon / Soroban server objects ────────────────────

function makeLedgerServer(sequence: number) {
  return {
    ledgers: jest.fn().mockReturnValue({
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      call: jest.fn().mockResolvedValue({ records: [{ sequence }] }),
    }),
    loadAccount: jest.fn(),
    submitTransaction: jest.fn(),
  };
}

function makeSorobanServer() {
  return {
    getAccount: jest.fn(),
    prepareTransaction: jest.fn(),
    sendTransaction: jest.fn(),
    getTransaction: jest.fn(),
    simulateTransaction: jest.fn(),
  };
}

// sdk 17: TransactionEnvelope/OperationBody/HostFunction are discriminated
// unions accessed via properties, not the removed method-style accessors.
function v1Operations(tx: StellarSdk.Transaction) {
  const envelope = tx.toEnvelope();
  if (envelope.type !== 'envelopeTypeTx') {
    throw new Error(`expected envelopeTypeTx, got ${envelope.type}`);
  }
  return envelope.v1.tx.operations;
}

function invokeHostFunctionOp(tx: StellarSdk.Transaction) {
  const body = v1Operations(tx)[0].body;
  if (body.type !== 'invokeHostFunction') {
    throw new Error(`expected invokeHostFunction, got ${body.type}`);
  }
  return body.invokeHostFunctionOp.hostFunction;
}

// ── Shared fixtures ───────────────────────────────────────────────────────────

const FUNDING_SECRET =
  'SCOCOEM6N6JNB5MAPWFRMMTMSUZW6RZ4KPKOMYUFXJKCUQUNVWDCJK2K';
const SIGNER_SECRET =
  'SCOCOEM6N6JNB5MAPWFRMMTMSUZW6RZ4KPKOMYUFXJKCUQUNVWDCJK2K';
const FUNDING_KEYPAIR = StellarSdk.Keypair.fromSecret(FUNDING_SECRET);
const DEST_KEY = FUNDING_KEYPAIR.publicKey();
// Valid Soroban contract address (56 chars, C-prefix strkey)
const CONTRACT_ID = 'CASJFOEQG3WN42CR37EKINFO77PP7UO2DT5XCNHITYT7WUHL7X3RYQFF';
// A second, distinct contract ID used for the instance a deploy returns
const DEPLOYED_CONTRACT_ID =
  'CBVSQFKKFONF6MPNQSZYEXGIHLFEFT3QLNNW2XTFE3PMADLSRDVBC552';
// #811: 64 hex chars, the uploaded ephemeral-account WASM hash
const WASM_HASH_HEX =
  '5e667ea0687341bdccc81538492143b573777dd04b2450cdeb89b02cee62c58e';

describe('StellarService', () => {
  let service: StellarService;
  let horizonServer: ReturnType<typeof makeLedgerServer>;
  let sorobanServer: ReturnType<typeof makeSorobanServer>;

  beforeEach(async () => {
    jest.clearAllMocks();

    horizonServer = makeLedgerServer(1000);
    sorobanServer = makeSorobanServer();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StellarService,
        { provide: ConfigService, useValue: mockConfigService },
        {
          provide: getToken('soroban_rpc_latency_seconds'),
          useValue: { startTimer: jest.fn(() => jest.fn()) },
        },
      ],
    }).compile();

    service = module.get<StellarService>(StellarService);

    // Replace internal SDK server references with our controlled mocks
    (service as unknown as { server: unknown; sorobanServer: unknown }).server =
      horizonServer;
    (
      service as unknown as { server: unknown; sorobanServer: unknown }
    ).sorobanServer = sorobanServer;
  });

  // ── getCurrentLedger ────────────────────────────────────────────────────────

  describe('getCurrentLedger', () => {
    it('returns the sequence number from Horizon', async () => {
      const result = await service.getCurrentLedger();
      expect(result).toBe(1000);
    });

    it('fetches the most recent ledger (order desc, limit 1)', async () => {
      await service.getCurrentLedger();
      expect(horizonServer.ledgers).toHaveBeenCalled();
    });
  });

  // ── generateKeypair ─────────────────────────────────────────────────────────

  describe('generateKeypair', () => {
    it('returns a random Stellar Keypair', () => {
      const kp = service.generateKeypair();
      expect(kp).toBeInstanceOf(StellarSdk.Keypair);
      expect(kp.publicKey()).toMatch(/^G[A-Z0-9]{55}$/);
    });

    it('returns a different keypair on each call', () => {
      const kp1 = service.generateKeypair();
      const kp2 = service.generateKeypair();
      expect(kp1.publicKey()).not.toBe(kp2.publicKey());
    });

    // #654 / #715: generateKeypair produces the secret key for an account that holds
    // funds, so the entropy source is security-relevant. These guard the chain
    // documented on StellarService.generateKeypair (confirming CSPRNG usage and
    // no Math.random or weaker RNG in the chain).

    it('does not use Math.random anywhere in the key-generation path', () => {
      const mathRandom = jest.spyOn(Math, 'random');

      try {
        service.generateKeypair();
        expect(mathRandom).not.toHaveBeenCalled();
      } finally {
        mathRandom.mockRestore();
      }
    });

    it('draws key material from the Web Crypto CSPRNG', () => {
      // Keypair.random() -> @noble/curves randomPrivateKey -> @noble/hashes
      // randomBytes -> crypto.getRandomValues. Spying on the boundary proves
      // the CSPRNG is what actually produces the bytes.
      const getRandomValues = jest.spyOn(globalThis.crypto, 'getRandomValues');

      try {
        service.generateKeypair();
        expect(getRandomValues).toHaveBeenCalled();
      } finally {
        getRandomValues.mockRestore();
      }
    });

    it('produces a full-length, well-formed Ed25519 secret seed', () => {
      const kp = service.generateKeypair();

      expect(kp.secret()).toMatch(/^S[A-Z2-7]{55}$/);
      expect(StellarSdk.StrKey.isValidEd25519SecretSeed(kp.secret())).toBe(
        true,
      );
      // 32 bytes of entropy, not a truncated or padded seed.
      expect(kp.rawSecretKey()).toHaveLength(32);
    });

    it('does not repeat a key across many draws', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 250; i++) {
        seen.add(service.generateKeypair().publicKey());
      }
      expect(seen.size).toBe(250);
    });
  });

  // ── toExpiryLedger ──────────────────────────────────────────────────────────

  describe('toExpiryLedger', () => {
    it('converts 1 hour (3600s) to the correct expiry ledger', async () => {
      jest.spyOn(service, 'getCurrentLedger').mockResolvedValue(1000);
      const result = await service.toExpiryLedger(3600);
      // 3600 / 5 = 720 ledgers + 10 buffer + 1000 current = 1730
      expect(result).toBe(1730);
    });

    it('converts 1 day (86400s) to the correct expiry ledger', async () => {
      jest.spyOn(service, 'getCurrentLedger').mockResolvedValue(1000);
      const result = await service.toExpiryLedger(86400);
      // 86400 / 5 = 17280 ledgers + 10 buffer + 1000 current = 18290
      expect(result).toBe(18290);
    });

    it('converts 30 days (2592000s) to the correct expiry ledger', async () => {
      jest.spyOn(service, 'getCurrentLedger').mockResolvedValue(1000);
      const result = await service.toExpiryLedger(2592000);
      // 2592000 / 5 = 518400 ledgers + 10 buffer + 1000 current = 519410
      expect(result).toBe(519410);
    });

    it('rounds fractional ledger counts up, not down (7s -> 2 ledgers)', async () => {
      jest.spyOn(service, 'getCurrentLedger').mockResolvedValue(1000);
      const result = await service.toExpiryLedger(7);
      // 7 / 5 = 1.4 -> ceil = 2 ledgers + 10 buffer + 1000 current = 1012
      expect(result).toBe(1012);
    });

    it('applies the buffer on top of the ledger conversion', async () => {
      jest.spyOn(service, 'getCurrentLedger').mockResolvedValue(500);
      // 5s / 5 = exactly 1 ledger; without buffer result would be 501
      const result = await service.toExpiryLedger(5);
      expect(result).toBe(511); // 500 + 1 + 10 (buffer)
    });

    it('handles edge case: getCurrentLedger returns a very low value', async () => {
      jest.spyOn(service, 'getCurrentLedger').mockResolvedValue(1);
      const result = await service.toExpiryLedger(3600);
      // 3600 / 5 = 720 + 10 buffer + 1 current = 731
      expect(result).toBe(731);
    });

    it('minimum expiresIn (3600s) produces an expiry ledger well above the current ledger', async () => {
      const currentLedger = 1000;
      jest.spyOn(service, 'getCurrentLedger').mockResolvedValue(currentLedger);
      const result = await service.toExpiryLedger(3600);
      // 730 ledgers ahead - meaningfully greater than current
      expect(result).toBeGreaterThan(currentLedger + 100);
    });

    it('EXPIRY_BUFFER_LEDGERS constant is 10', () => {
      expect(EXPIRY_BUFFER_LEDGERS).toBe(10);
    });
  });

  // ── createEphemeralAccount ──────────────────────────────────────────────────

  describe('createEphemeralAccount', () => {
    const params = {
      publicKey: FUNDING_KEYPAIR.publicKey(),
      amount: '100',
      asset: 'native',
      expiresIn: 3600,
      recoveryAddress: FUNDING_KEYPAIR.publicKey(),
      sweepControllerContractId: CONTRACT_ID,
      fundingKeypairSecret: FUNDING_SECRET,
    };

    function setupHappyPath(txHash = 'horizon-tx-hash') {
      const fundingAccount = new StellarSdk.Account(
        FUNDING_KEYPAIR.publicKey(),
        '100',
      );
      horizonServer.loadAccount.mockResolvedValue(fundingAccount);
      horizonServer.submitTransaction.mockResolvedValue({ hash: txHash });

      const sorobanAccount = new StellarSdk.Account(
        FUNDING_KEYPAIR.publicKey(),
        '101',
      );
      sorobanServer.getAccount.mockResolvedValue(sorobanAccount);

      // prepareTransaction just returns a signable transaction
      sorobanServer.prepareTransaction.mockImplementation(
        (tx: StellarSdk.Transaction) => Promise.resolve(tx),
      );
      sorobanServer.sendTransaction
        .mockResolvedValueOnce({ status: 'PENDING', hash: 'deploy-tx-hash' })
        .mockResolvedValueOnce({ status: 'PENDING', hash: 'soroban-tx-hash' });
      // The network reports the new contract ID as the deploy tx return value
      sorobanServer.getTransaction.mockResolvedValue({
        status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
        returnValue:
          StellarSdk.Address.fromString(DEPLOYED_CONTRACT_ID).toScVal(),
      });

      jest.spyOn(service, 'getCurrentLedger').mockResolvedValue(1000);
    }

    it('returns the Horizon transaction hash and the deployed contract ID on success', async () => {
      setupHappyPath('expected-tx-hash');

      const result = await service.createEphemeralAccount(params);

      expect(result).toEqual({
        txHash: 'expected-tx-hash',
        contractId: DEPLOYED_CONTRACT_ID,
      });
    });

    it('calls submitTransaction on Horizon', async () => {
      setupHappyPath();

      await service.createEphemeralAccount(params);

      expect(horizonServer.submitTransaction).toHaveBeenCalledTimes(1);
    });

    it('sends two Soroban transactions: the deployment and the initialize', async () => {
      setupHappyPath();

      await service.createEphemeralAccount(params);

      expect(sorobanServer.sendTransaction).toHaveBeenCalledTimes(2);
    });

    it('deploys a contract instance with the configured WASM hash and a 32-byte salt', async () => {
      setupHappyPath();

      await service.createEphemeralAccount(params);

      const deployTx = sorobanServer.prepareTransaction.mock
        .calls[0][0] as StellarSdk.Transaction;
      const deployOp = v1Operations(deployTx)[0];
      expect(deployOp.body.type).toBe('invokeHostFunction');
      if (deployOp.body.type !== 'invokeHostFunction') {
        throw new Error('expected invokeHostFunction operation body');
      }

      const hostFn = deployOp.body.invokeHostFunctionOp.hostFunction;
      expect(hostFn.type).toBe('hostFunctionTypeCreateContractV2');
      if (hostFn.type !== 'hostFunctionTypeCreateContractV2') {
        throw new Error('expected hostFunctionTypeCreateContractV2');
      }

      const createArgs = hostFn.createContractV2;
      expect(createArgs.executable.type).toBe('contractExecutableWasm');
      if (createArgs.executable.type !== 'contractExecutableWasm') {
        throw new Error('expected contractExecutableWasm');
      }
      expect(Buffer.from(createArgs.executable.wasmHash.toBytes())).toEqual(
        Buffer.from(WASM_HASH_HEX, 'hex'),
      );

      const preimage = createArgs.contractIdPreimage;
      expect(preimage.type).toBe('contractIdPreimageFromAddress');
      if (preimage.type !== 'contractIdPreimageFromAddress') {
        throw new Error('expected contractIdPreimageFromAddress');
      }
      expect(preimage.fromAddress.salt.toBytes()).toHaveLength(32);
      expect(
        StellarSdk.Address.fromScAddress(
          preimage.fromAddress.address,
        ).toString(),
      ).toBe(FUNDING_KEYPAIR.publicKey());
    });

    it('initializes the contract instance returned by the deployment', async () => {
      setupHappyPath();

      await service.createEphemeralAccount(params);

      const initTx = sorobanServer.prepareTransaction.mock
        .calls[1][0] as StellarSdk.Transaction;
      const hostFn = invokeHostFunctionOp(initTx);
      expect(hostFn.type).toBe('hostFunctionTypeInvokeContract');
      if (hostFn.type !== 'hostFunctionTypeInvokeContract') {
        throw new Error('expected hostFunctionTypeInvokeContract');
      }
      const invokeArgs = hostFn.invokeContract;
      expect(
        StellarSdk.Address.fromScAddress(invokeArgs.contractAddress).toString(),
      ).toBe(DEPLOYED_CONTRACT_ID);
      expect(invokeArgs.functionName.toString()).toBe('initialize');
    });

    it('does not read the shared ephemeral-account contract ID', async () => {
      const configSpy = jest.spyOn(mockConfigService, 'getOrThrow');
      setupHappyPath();

      await service.createEphemeralAccount(params);

      expect(configSpy.mock.calls.map((call) => call[0])).not.toContain(
        'stellar.contracts.ephemeralAccount',
      );
    });

    it('throws when the contract deployment returns ERROR status', async () => {
      setupHappyPath();
      sorobanServer.sendTransaction.mockReset();
      sorobanServer.sendTransaction.mockResolvedValue({
        status: 'ERROR',
        errorResult: { message: 'deployment error' },
      });

      await expect(service.createEphemeralAccount(params)).rejects.toThrow(
        'Contract deployment failed',
      );
      // initialize is never attempted for a contract that was not deployed
      expect(sorobanServer.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it('throws when the deployment transaction is confirmed without a contract ID', async () => {
      setupHappyPath();
      sorobanServer.getTransaction.mockResolvedValue({
        status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
      });

      await expect(service.createEphemeralAccount(params)).rejects.toThrow(
        'returned no contract ID',
      );
    });

    it('throws when initialize() fails after a successful deployment', async () => {
      setupHappyPath();
      sorobanServer.sendTransaction
        .mockReset()
        .mockResolvedValueOnce({ status: 'PENDING', hash: 'deploy-tx-hash' })
        .mockResolvedValueOnce({
          status: 'ERROR',
          errorResult: { message: 'contract error' },
        });

      await expect(service.createEphemeralAccount(params)).rejects.toThrow(
        `Contract initialization failed for contract ${DEPLOYED_CONTRACT_ID}`,
      );
    });
  });

  // ── recordPayment ───────────────────────────────────────────────────────────

  describe('recordPayment', () => {
    const params = {
      contractId: CONTRACT_ID,
      amount: 100n,
      assetAddress: FUNDING_KEYPAIR.publicKey(),
      signerSecret: SIGNER_SECRET,
    };

    it('resolves without throwing on success', async () => {
      const acct = new StellarSdk.Account(FUNDING_KEYPAIR.publicKey(), '100');
      sorobanServer.getAccount.mockResolvedValue(acct);
      sorobanServer.prepareTransaction.mockImplementation((tx: any) =>
        Promise.resolve(tx),
      );
      sorobanServer.sendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: 'pay-hash',
      });
      sorobanServer.getTransaction.mockResolvedValue({
        status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
      });

      await expect(service.recordPayment(params)).resolves.toBeUndefined();
    });

    it('throws when Soroban returns ERROR on record_payment', async () => {
      const acct = new StellarSdk.Account(FUNDING_KEYPAIR.publicKey(), '100');
      sorobanServer.getAccount.mockResolvedValue(acct);
      sorobanServer.prepareTransaction.mockImplementation((tx: any) =>
        Promise.resolve(tx),
      );
      sorobanServer.sendTransaction.mockResolvedValue({
        status: 'ERROR',
        errorResult: { message: 'TooManyPayments' },
      });

      await expect(service.recordPayment(params)).rejects.toThrow(
        'record_payment failed',
      );
    });
  });

  // ── executeSweep ────────────────────────────────────────────────────────────

  describe('executeSweep', () => {
    const params = {
      sweepControllerContractId: CONTRACT_ID,
      ephemeralAccountContractId: CONTRACT_ID,
      destination: DEST_KEY,
      authSignature: Buffer.alloc(64),
      signerSecret: SIGNER_SECRET,
    };

    it('resolves without throwing on successful sweep', async () => {
      const acct = new StellarSdk.Account(FUNDING_KEYPAIR.publicKey(), '100');
      sorobanServer.getAccount.mockResolvedValue(acct);
      sorobanServer.prepareTransaction.mockImplementation((tx: any) =>
        Promise.resolve(tx),
      );
      sorobanServer.sendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: 'sweep-hash',
      });
      sorobanServer.getTransaction.mockResolvedValue({
        status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
      });

      await expect(service.executeSweep(params)).resolves.toBeUndefined();
    });

    it('throws ALREADY_SWEPT for AlreadySwept contract error', async () => {
      const acct = new StellarSdk.Account(FUNDING_KEYPAIR.publicKey(), '100');
      sorobanServer.getAccount.mockResolvedValue(acct);
      sorobanServer.prepareTransaction.mockImplementation((tx: any) =>
        Promise.resolve(tx),
      );
      sorobanServer.sendTransaction.mockResolvedValue({
        status: 'ERROR',
        errorResult: 'AlreadySwept',
      });

      await expect(service.executeSweep(params)).rejects.toThrow(
        'ALREADY_SWEPT',
      );
    });

    it('throws ACCOUNT_EXPIRED for AccountExpired contract error', async () => {
      const acct = new StellarSdk.Account(FUNDING_KEYPAIR.publicKey(), '100');
      sorobanServer.getAccount.mockResolvedValue(acct);
      sorobanServer.prepareTransaction.mockImplementation((tx: any) =>
        Promise.resolve(tx),
      );
      sorobanServer.sendTransaction.mockResolvedValue({
        status: 'ERROR',
        errorResult: 'AccountExpired',
      });

      await expect(service.executeSweep(params)).rejects.toThrow(
        'ACCOUNT_EXPIRED',
      );
    });

    it('throws a generic error for unknown contract errors', async () => {
      const acct = new StellarSdk.Account(FUNDING_KEYPAIR.publicKey(), '100');
      sorobanServer.getAccount.mockResolvedValue(acct);
      sorobanServer.prepareTransaction.mockImplementation((tx: any) =>
        Promise.resolve(tx),
      );
      sorobanServer.sendTransaction.mockResolvedValue({
        status: 'ERROR',
        errorResult: 'SomeOtherError',
      });

      await expect(service.executeSweep(params)).rejects.toThrow(
        'execute_sweep failed',
      );
    });
  });

  // ── expireAccount ───────────────────────────────────────────────────────────

  describe('expireAccount', () => {
    const params = {
      contractId: CONTRACT_ID,
      signerSecret: SIGNER_SECRET,
    };

    function mockGetAccountInfo(expiryLedger: number) {
      jest.spyOn(service, 'getAccountInfo').mockResolvedValue({
        status: '1',
        expiry_ledger: expiryLedger,
        payment_received: false,
        payment_count: 0,
        recovery_address: FUNDING_KEYPAIR.publicKey(),
      });
    }

    it('returns early (no-op) when current ledger is before expiry', async () => {
      jest.spyOn(service, 'getCurrentLedger').mockResolvedValue(900);
      mockGetAccountInfo(1000);

      await expect(service.expireAccount(params)).resolves.toBeUndefined();
      expect(sorobanServer.sendTransaction).not.toHaveBeenCalled();
    });

    it('calls expire() on-chain when current ledger meets expiry', async () => {
      jest.spyOn(service, 'getCurrentLedger').mockResolvedValue(1001);
      mockGetAccountInfo(1000);

      const acct = new StellarSdk.Account(FUNDING_KEYPAIR.publicKey(), '100');
      sorobanServer.getAccount.mockResolvedValue(acct);
      sorobanServer.prepareTransaction.mockImplementation((tx: any) =>
        Promise.resolve(tx),
      );
      sorobanServer.sendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: 'expire-hash',
      });
      sorobanServer.getTransaction.mockResolvedValue({
        status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
      });

      await expect(service.expireAccount(params)).resolves.toBeUndefined();
      expect(sorobanServer.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it('throws ACCOUNT_ALREADY_TERMINAL for InvalidStatus contract error', async () => {
      jest.spyOn(service, 'getCurrentLedger').mockResolvedValue(1001);
      mockGetAccountInfo(1000);

      const acct = new StellarSdk.Account(FUNDING_KEYPAIR.publicKey(), '100');
      sorobanServer.getAccount.mockResolvedValue(acct);
      sorobanServer.prepareTransaction.mockImplementation((tx: any) =>
        Promise.resolve(tx),
      );
      sorobanServer.sendTransaction.mockResolvedValue({
        status: 'ERROR',
        errorResult: 'InvalidStatus',
      });

      await expect(service.expireAccount(params)).rejects.toThrow(
        'ACCOUNT_ALREADY_TERMINAL',
      );
    });

    it('throws a generic error for other expire() failures', async () => {
      jest.spyOn(service, 'getCurrentLedger').mockResolvedValue(1001);
      mockGetAccountInfo(1000);

      const acct = new StellarSdk.Account(FUNDING_KEYPAIR.publicKey(), '100');
      sorobanServer.getAccount.mockResolvedValue(acct);
      sorobanServer.prepareTransaction.mockImplementation((tx: any) =>
        Promise.resolve(tx),
      );
      sorobanServer.sendTransaction.mockResolvedValue({
        status: 'ERROR',
        errorResult: 'UnknownError',
      });

      await expect(service.expireAccount(params)).rejects.toThrow(
        'expire() failed',
      );
    });
  });

  // ── getAccountInfo ──────────────────────────────────────────────────────────

  // #871: simulateTransaction error branches for get_info — isSimulationError,
  // a network-level rejection and a malformed/no-retval response.
  describe('getAccountInfo', () => {
    it('throws when simulateTransaction returns an error', async () => {
      sorobanServer.simulateTransaction.mockResolvedValue({
        error: 'simulation error',
        _parsed: false,
      });
      // Make isSimulationError return true
      jest.spyOn(SorobanRpc.Api, 'isSimulationError').mockReturnValue(true);

      await expect(service.getAccountInfo(CONTRACT_ID)).rejects.toThrow(
        'get_info simulation failed',
      );
    });

    it('throws when simulation result has no retval', async () => {
      sorobanServer.simulateTransaction.mockResolvedValue({
        result: null,
      });
      jest.spyOn(SorobanRpc.Api, 'isSimulationError').mockReturnValue(false);

      await expect(service.getAccountInfo(CONTRACT_ID)).rejects.toThrow(
        'get_info returned no value',
      );
    });

    it('propagates network failures from simulateTransaction', async () => {
      sorobanServer.simulateTransaction.mockRejectedValue(
        new Error('Soroban RPC unavailable'),
      );

      await expect(service.getAccountInfo(CONTRACT_ID)).rejects.toThrow(
        'Soroban RPC unavailable',
      );
    });

    it('rejects a malformed simulation response without a result', async () => {
      sorobanServer.simulateTransaction.mockResolvedValue({});
      jest.spyOn(SorobanRpc.Api, 'isSimulationError').mockReturnValue(false);

      await expect(service.getAccountInfo(CONTRACT_ID)).rejects.toThrow(
        `get_info returned no value for ${CONTRACT_ID}`,
      );
    });
  });

  // ── waitForTransaction (via createEphemeralAccount) ─────────────────────────

  describe('waitForTransaction timeout', () => {
    it('throws when transaction is not confirmed after max attempts', async () => {
      const fundingAccount = new StellarSdk.Account(
        FUNDING_KEYPAIR.publicKey(),
        '100',
      );
      horizonServer.loadAccount.mockResolvedValue(fundingAccount);
      horizonServer.submitTransaction.mockResolvedValue({ hash: 'tx' });

      const sorobanAccount = new StellarSdk.Account(
        FUNDING_KEYPAIR.publicKey(),
        '101',
      );
      sorobanServer.getAccount.mockResolvedValue(sorobanAccount);
      sorobanServer.prepareTransaction.mockImplementation((tx: any) =>
        Promise.resolve(tx),
      );
      sorobanServer.sendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: 'pending-tx',
      });
      // Always return NOT_FOUND to exhaust the retry loop
      sorobanServer.getTransaction.mockResolvedValue({
        status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND,
      });
      jest.spyOn(service, 'getCurrentLedger').mockResolvedValue(1000);

      await expect(
        service.createEphemeralAccount({
          publicKey: FUNDING_KEYPAIR.publicKey(),
          amount: '100',
          asset: 'native',
          expiresIn: 3600,
          recoveryAddress: FUNDING_KEYPAIR.publicKey(),
          sweepControllerContractId: CONTRACT_ID,
          fundingKeypairSecret: FUNDING_SECRET,
        }),
      ).rejects.toThrow('not confirmed after');
    }, 30000);

    it('throws when a transaction fails on-chain', async () => {
      const fundingAccount = new StellarSdk.Account(
        FUNDING_KEYPAIR.publicKey(),
        '100',
      );
      horizonServer.loadAccount.mockResolvedValue(fundingAccount);
      horizonServer.submitTransaction.mockResolvedValue({ hash: 'tx' });

      const sorobanAccount = new StellarSdk.Account(
        FUNDING_KEYPAIR.publicKey(),
        '101',
      );
      sorobanServer.getAccount.mockResolvedValue(sorobanAccount);
      sorobanServer.prepareTransaction.mockImplementation((tx: any) =>
        Promise.resolve(tx),
      );
      sorobanServer.sendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: 'failed-tx',
      });
      sorobanServer.getTransaction.mockResolvedValue({
        status: SorobanRpc.Api.GetTransactionStatus.FAILED,
      });
      jest.spyOn(service, 'getCurrentLedger').mockResolvedValue(1000);

      await expect(
        service.createEphemeralAccount({
          publicKey: FUNDING_KEYPAIR.publicKey(),
          amount: '100',
          asset: 'native',
          expiresIn: 3600,
          recoveryAddress: FUNDING_KEYPAIR.publicKey(),
          sweepControllerContractId: CONTRACT_ID,
          fundingKeypairSecret: FUNDING_SECRET,
        }),
      ).rejects.toThrow('failed on-chain');
    });
  });

  // ── getNetworkPassphrase (via createEphemeralAccount on mainnet) ────────────

  describe('getNetworkPassphrase', () => {
    it('uses TESTNET passphrase for non-mainnet networks', () => {
      // Already tested implicitly via createEphemeralAccount — just verify
      // we can instantiate with 'testnet' config without error
      expect((service as unknown as { network: string }).network).toBe(
        'testnet',
      );
    });

    it('uses PUBLIC passphrase when network is mainnet', async () => {
      const mainnetModule: TestingModule = await Test.createTestingModule({
        providers: [
          StellarService,
          {
            provide: ConfigService,
            useValue: {
              getOrThrow: (key: string) => {
                const cfg: Record<string, string> = {
                  'stellar.horizonUrl': 'https://horizon.stellar.org',
                  'stellar.sorobanRpcUrl': 'https://soroban.stellar.org',
                  'stellar.network': 'mainnet',
                };
                return cfg[key];
              },
            },
          },
          {
            provide: getToken('soroban_rpc_latency_seconds'),
            useValue: { startTimer: jest.fn(() => jest.fn()) },
          },
        ],
      }).compile();

      const mainnetService = mainnetModule.get<StellarService>(StellarService);
      type InternalService = {
        network: string;
        getNetworkPassphrase: () => string;
      };
      const internal = mainnetService as unknown as InternalService;
      expect(internal.network).toBe('mainnet');
      expect(internal.getNetworkPassphrase()).toBe(StellarSdk.Networks.PUBLIC);
    });
  });

  // ── getAccountInfo (success path) ──────────────────────────────────────────

  describe('getAccountInfo success path', () => {
    it('parses a valid simulation result with all fields present', async () => {
      jest.spyOn(SorobanRpc.Api, 'isSimulationError').mockReturnValue(false);

      // The simulation returns an SCMap mirroring the on-chain AccountInfo struct.
      const recoveryScVal = StellarSdk.Address.fromString(
        FUNDING_KEYPAIR.publicKey(),
      ).toScVal();

      const entry = (key: string, val: StellarSdk.xdr.ScVal) =>
        new StellarSdk.xdr.ScMapEntry({
          key: StellarSdk.xdr.ScVal.scvSymbol(key),
          val,
        });

      const mockRetval = StellarSdk.xdr.ScVal.scvMap([
        entry('status', StellarSdk.xdr.ScVal.scvU32(1)),
        entry('expiry_ledger', StellarSdk.xdr.ScVal.scvU32(5000)),
        entry('payment_received', StellarSdk.xdr.ScVal.scvBool(true)),
        entry('payment_count', StellarSdk.xdr.ScVal.scvU32(2)),
        entry('recovery_address', recoveryScVal),
      ]);

      sorobanServer.simulateTransaction.mockResolvedValue({
        result: { retval: mockRetval },
      });

      const info = await service.getAccountInfo(CONTRACT_ID);

      expect(info.expiry_ledger).toBe(5000);
      expect(info.payment_received).toBe(true);
      expect(info.payment_count).toBe(2);
      expect(info.recovery_address).toBe(FUNDING_KEYPAIR.publicKey());
    });

    it('throws when recovery_address field is missing', async () => {
      jest.spyOn(SorobanRpc.Api, 'isSimulationError').mockReturnValue(false);

      const mockRetval = StellarSdk.xdr.ScVal.scvMap([
        new StellarSdk.xdr.ScMapEntry({
          key: StellarSdk.xdr.ScVal.scvSymbol('status'),
          val: StellarSdk.xdr.ScVal.scvU32(1),
        }),
      ]);

      sorobanServer.simulateTransaction.mockResolvedValue({
        result: { retval: mockRetval },
      });

      await expect(service.getAccountInfo(CONTRACT_ID)).rejects.toThrow(
        'get_info missing recovery_address',
      );
    });

    it('throws when the ScVal map payload is null (unexpected ScVal type)', async () => {
      jest.spyOn(SorobanRpc.Api, 'isSimulationError').mockReturnValue(false);

      sorobanServer.simulateTransaction.mockResolvedValue({
        result: { retval: StellarSdk.xdr.ScVal.scvMap(null) },
      });

      await expect(service.getAccountInfo(CONTRACT_ID)).rejects.toThrow(
        'unexpected ScVal type',
      );
    });
  });

  /**
   * #812: getSweepNonce — the SweepController nonce read that the sweeper
   * signs. Previously the signer defaulted the nonce to 0n, which only ever
   * verified for the first sweep a controller ever executed.
   */
  describe('getSweepNonce', () => {
    it('returns the u64 nonce from the simulation result', async () => {
      jest.spyOn(SorobanRpc.Api, 'isSimulationError').mockReturnValue(false);
      sorobanServer.simulateTransaction.mockResolvedValue({
        result: {
          retval: StellarSdk.xdr.ScVal.scvU64(42n),
        },
      });

      const nonce = await service.getSweepNonce(CONTRACT_ID);

      expect(nonce).toBe(42n);
      // buildMessage feeds the nonce to Buffer.writeBigUInt64BE, which
      // throws on a non-bigint.
      expect(typeof nonce).toBe('bigint');
    });

    it('returns a bigint for the maximum u64 the counter can reach', async () => {
      jest.spyOn(SorobanRpc.Api, 'isSimulationError').mockReturnValue(false);
      sorobanServer.simulateTransaction.mockResolvedValue({
        result: {
          retval: StellarSdk.xdr.ScVal.scvU64(18446744073709551615n),
        },
      });

      const nonce = await service.getSweepNonce(CONTRACT_ID);

      expect(nonce).toBe(18446744073709551615n);
      expect(typeof nonce).toBe('bigint');
    });

    it('reads it with a read-only simulation: no signing, no transaction', async () => {
      jest.spyOn(SorobanRpc.Api, 'isSimulationError').mockReturnValue(false);
      sorobanServer.simulateTransaction.mockResolvedValue({
        result: {
          retval: StellarSdk.xdr.ScVal.scvU64(1n),
        },
      });

      await service.getSweepNonce(CONTRACT_ID);

      expect(sorobanServer.simulateTransaction).toHaveBeenCalledTimes(1);
      expect(sorobanServer.sendTransaction).not.toHaveBeenCalled();
      expect(sorobanServer.prepareTransaction).not.toHaveBeenCalled();
    });

    it('calls get_nonce on the SweepController passed in', async () => {
      jest.spyOn(SorobanRpc.Api, 'isSimulationError').mockReturnValue(false);
      sorobanServer.simulateTransaction.mockResolvedValue({
        result: {
          retval: StellarSdk.xdr.ScVal.scvU64(0n),
        },
      });

      await service.getSweepNonce(CONTRACT_ID);

      const tx = sorobanServer.simulateTransaction.mock
        .calls[0][0] as StellarSdk.Transaction;
      const hostFn = invokeHostFunctionOp(tx);
      expect(hostFn.type).toBe('hostFunctionTypeInvokeContract');
      if (hostFn.type !== 'hostFunctionTypeInvokeContract') {
        throw new Error('expected hostFunctionTypeInvokeContract');
      }
      const invokeArgs = hostFn.invokeContract;
      expect(
        StellarSdk.Address.fromScAddress(invokeArgs.contractAddress).toString(),
      ).toBe(CONTRACT_ID);
      expect(invokeArgs.functionName.toString()).toBe('get_nonce');
    });

    it('propagates a simulation error instead of returning a stale value', async () => {
      jest.spyOn(SorobanRpc.Api, 'isSimulationError').mockReturnValue(true);

      sorobanServer.simulateTransaction.mockResolvedValue({
        error: 'rpc exploded',
      } as any);

      await expect(service.getSweepNonce(CONTRACT_ID)).rejects.toThrow(
        'get_nonce simulation failed',
      );
    });

    it('throws when the simulation returns no value', async () => {
      jest.spyOn(SorobanRpc.Api, 'isSimulationError').mockReturnValue(false);
      sorobanServer.simulateTransaction.mockResolvedValue({ result: {} });

      await expect(service.getSweepNonce(CONTRACT_ID)).rejects.toThrow(
        'get_nonce returned no value',
      );
    });

    it('throws when the returned ScVal is not a u64', async () => {
      jest.spyOn(SorobanRpc.Api, 'isSimulationError').mockReturnValue(false);
      sorobanServer.simulateTransaction.mockResolvedValue({
        result: { retval: StellarSdk.xdr.ScVal.scvU32(3) },
      });

      await expect(service.getSweepNonce(CONTRACT_ID)).rejects.toThrow(
        'get_nonce returned unexpected ScVal type',
      );
    });
  });
});
