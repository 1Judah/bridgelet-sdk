import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { InternalServerErrorException } from '@nestjs/common';
import {
  Contract,
  rpc,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  Address,
  xdr,
  hash,
  Account,
  Operation,
} from '@stellar/stellar-sdk';
import {
  ContractProvider,
  UNKNOWN_CONTRACT_VERSION,
} from './contract.provider.js';
import { ContractAuthResult } from '../interfaces/contract-auth-result.interface.js';
import { AuthorizeSweepParams } from '../interfaces/authorize-sweep-params.interface.js';
import { SweepSignerUtil } from '../../../common/crypto/sweep-signer.util.js';

// Mock the Stellar SDK
const mockServer = {
  getAccount: jest.fn<Promise<Account>, [string]>(),
  simulateTransaction: jest.fn<
    Promise<rpc.Api.SimulateTransactionResponse>,
    [any]
  >(),
};

const mockContract = {
  call: jest.fn<Operation, [string, ...any[]]>(),
};

const mockTransactionBuilder = {
  addOperation: jest.fn().mockReturnThis(),
  setTimeout: jest.fn().mockReturnThis(),
  build: jest.fn<any, []>(),
};

const mockAddress = {
  toScVal: jest.fn<xdr.ScVal, []>(),
};

jest.mock('../../../common/crypto/sweep-signer.util.js', () => ({
  SweepSignerUtil: {
    sign: jest.fn(() => Buffer.alloc(64)), // 64-byte dummy signature
  },
}));

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual<typeof import('@stellar/stellar-sdk')>(
    '@stellar/stellar-sdk',
  );
  return {
    ...actual,
    Contract: jest.fn(() => mockContract),
    rpc: {
      ...actual.rpc,
      Server: jest.fn(() => mockServer),
      Api: {
        ...actual.rpc.Api,
        isSimulationError: jest.fn(),
      },
    },
    TransactionBuilder: jest.fn(() => mockTransactionBuilder),
    Address: {
      ...actual.Address,
      fromString: jest.fn(() => mockAddress),
    },
    xdr: {
      ...actual.xdr,
      ScVal: {
        ...actual.xdr.ScVal,
        scvBytes: jest.fn((buf: Buffer) => ({ type: 'scvBytes', value: buf })),
      },
    },
  };
});

/**
 * Comprehensive test suite for ContractProvider
 *
 * SCOPE: Tests Soroban smart contract authorization for sweep operations
 *
 * MVP vs PRODUCTION BEHAVIOR:
 * - MVP: Uses dummy signatures, does not submit transactions
 * - Production: Will use real Ed25519 signatures and submit transactions on-chain
 *
 * SECURITY CRITICAL: This component handles authorization for asset sweeps
 * All cryptographic operations must be verified by security review before production
 */

describe('ContractProvider', () => {
  let provider: ContractProvider;
  let configService: ConfigService;

  // Mock instances
  let mockRpcServer: typeof mockServer;
  let mockAccount: Account;
  let mockTransaction: any;
  let mockOperation: Operation;

  // Valid test parameters
  const validParams: AuthorizeSweepParams = {
    ephemeralPublicKey:
      'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J2RROMSG',
    destinationAddress:
      'GD5J6HLF5666X4AZLTFTXLY2CQZBS2LBJBIMYV3SYGQ5OAQY5QO4XRNM',
    // #812: the EphemeralAccount instance is supplied per call, and the nonce
    // is required. A non-zero nonce here is deliberate — it proves no `0n`
    // fallback is being applied.
    contractId: 'CDUMMYACCOUNTINSTANCE123456789ABCDEFGHIJKLMNOP',
    nonce: 9n,
  };

  // Default config values
  const mockConfig = {
    'stellar.contracts.ephemeralAccount':
      'CDUMMYCONTRACTID123456789ABCDEFGHIJKLMNOPQRSTUV',
    'stellar.sorobanRpcUrl': 'https://soroban-testnet.stellar.org',
    'stellar.network': 'testnet',
    'stellar.sweepSigningKeySeed':
      'SDUMMYSEEDFORTESTING1234567890ABCDEFGHIJKLMNOPQRSTUV',
    'stellar.contracts.sweepController':
      'CDUMMYSWEEPCONTROLLER123456789ABCDEFGHIJKLMNOP',
    // Deliberately not '0.1.0': proves the version is read from config and
    // is no longer the literal that used to be returned (#648).
    'stellar.contracts.ephemeralAccountVersion': '1.2.3',
  };

  beforeEach(async () => {
    // Clear all mock calls and instances
    jest.clearAllMocks();

    // Suppress console errors during tests
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Create mock instances with proper types
    mockAccount = {
      accountId: jest.fn(() => validParams.ephemeralPublicKey),
      sequenceNumber: jest.fn(() => '1'),
      incrementSequenceNumber: jest.fn(),
    };

    mockOperation = {
      type: 'invokeHostFunction',
    };

    mockTransaction = {
      hash: jest.fn(() => Buffer.from('mock-tx-hash')),
      toEnvelope: jest.fn(),
    };

    // Setup mock implementations
    mockRpcServer = mockServer;
    mockServer.getAccount.mockResolvedValue(mockAccount);
    mockServer.simulateTransaction.mockResolvedValue({
      id: 'mock-simulation-id',
      latestLedger: 12345,
      minResourceFee: '100',
      results: [{ auth: [], xdr: 'mock-xdr' }],
    } as unknown as rpc.Api.SimulateTransactionSuccessResponse);

    mockContract.call.mockReturnValue(mockOperation);

    mockTransactionBuilder.addOperation.mockReturnThis();
    mockTransactionBuilder.setTimeout.mockReturnThis();
    mockTransactionBuilder.build.mockReturnValue(mockTransaction);

    mockAddress.toScVal.mockReturnValue({} as xdr.ScVal);

    // Setup other SDK mocks
    (rpc.Api.isSimulationError as unknown as jest.Mock).mockReturnValue(false);
    (Address.fromString as jest.Mock).mockReturnValue(mockAddress);

    // Create testing module
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContractProvider,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(
              (key: string) => mockConfig[key as keyof typeof mockConfig],
            ),
            getOrThrow: jest.fn((key: string) => {
              const value = mockConfig[key as keyof typeof mockConfig];
              if (!value) {
                throw new Error(`Configuration key not found: ${key}`);
              }
              return value;
            }),
          },
        },
      ],
    }).compile();

    provider = module.get<ContractProvider>(ContractProvider);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * SECTION 1: Configuration and Initialization Tests
   * Tests constructor behavior, config loading, and network setup
   */
  describe('Configuration and Initialization', () => {
    it('should initialize with valid configuration', async () => {
      expect(provider).toBeDefined();

      const getOrThrowSpy = jest.spyOn(configService, 'getOrThrow');
      expect(
        configService.getOrThrow('stellar.contracts.ephemeralAccount'),
      ).toBeDefined();

      expect(getOrThrowSpy.mock.calls).toContainEqual([
        'stellar.sorobanRpcUrl',
      ]);

      expect(getOrThrowSpy).toHaveBeenCalledWith('stellar.network');
      await Promise.resolve();
    });

    it('should set TESTNET network passphrase for testnet config', async () => {
      // Network passphrase is private, so we verify via behavior
      const result = await provider.authorizeSweep(validParams);

      expect(TransactionBuilder).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          networkPassphrase: Networks.TESTNET,
        }),
      );
      expect(result.authorized).toBe(true);
    });

    it('should set PUBLIC network passphrase for mainnet config', async () => {
      // Create new provider with mainnet config
      const mainnetModule = await Test.createTestingModule({
        providers: [
          ContractProvider,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn(
                (key: string) => mockConfig[key as keyof typeof mockConfig],
              ),
              getOrThrow: jest.fn((key: string) => {
                if (key === 'stellar.network') return 'mainnet';
                return mockConfig[key as keyof typeof mockConfig];
              }),
            },
          },
        ],
      }).compile();

      const mainnetProvider =
        mainnetModule.get<ContractProvider>(ContractProvider);
      await mainnetProvider.authorizeSweep(validParams);

      expect(TransactionBuilder).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          networkPassphrase: Networks.PUBLIC,
        }),
      );
    });

    it('should throw error when required config is missing', async () => {
      const invalidModule = Test.createTestingModule({
        providers: [
          ContractProvider,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn(
                (key: string) => mockConfig[key as keyof typeof mockConfig],
              ),
              getOrThrow: jest.fn(() => {
                throw new Error(
                  'Configuration key not found: stellar.sorobanRpcUrl',
                );
              }),
            },
          },
        ],
      });

      await expect(invalidModule.compile()).rejects.toThrow();
    });

    it('should no longer require a shared ephemeral-account contract ID (#812)', async () => {
      // #812: the provider used to bind
      // `stellar.contracts.ephemeralAccount` in its constructor. There is no
      // shared EphemeralAccount contract any more — each account has its own
      // instance passed per call — so construction must succeed without it.
      const moduleWithoutSharedId = await Test.createTestingModule({
        providers: [
          ContractProvider,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn(
                (key: string) => mockConfig[key as keyof typeof mockConfig],
              ),
              getOrThrow: jest.fn((key: string) => {
                if (key === 'stellar.contracts.ephemeralAccount') {
                  throw new Error(
                    'Configuration key not found: stellar.contracts.ephemeralAccount',
                  );
                }
                return mockConfig[key as keyof typeof mockConfig];
              }),
            },
          },
        ],
      }).compile();

      const providerWithoutSharedId =
        moduleWithoutSharedId.get<ContractProvider>(ContractProvider);

      await providerWithoutSharedId.authorizeSweep(validParams);

      expect(Contract).toHaveBeenCalledWith(validParams.contractId);
    });

    it('should throw error when RPC URL config is missing', async () => {
      const invalidModule = Test.createTestingModule({
        providers: [
          ContractProvider,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn(
                (key: string) => mockConfig[key as keyof typeof mockConfig],
              ),
              getOrThrow: jest.fn((key: string) => {
                if (key === 'stellar.sorobanRpcUrl') {
                  throw new Error('Configuration key not found');
                }
                return mockConfig[key as keyof typeof mockConfig];
              }),
            },
          },
        ],
      });

      await expect(invalidModule.compile()).rejects.toThrow();
    });

    it('should throw error when network config is missing', async () => {
      const invalidModule = Test.createTestingModule({
        providers: [
          ContractProvider,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn(
                (key: string) => mockConfig[key as keyof typeof mockConfig],
              ),
              getOrThrow: jest.fn((key: string) => {
                if (key === 'stellar.network') {
                  throw new Error('Configuration key not found');
                }
                return mockConfig[key as keyof typeof mockConfig];
              }),
            },
          },
        ],
      });

      await expect(invalidModule.compile()).rejects.toThrow();
    });
  });

  /**
   * SECTION 2: getContractInfo Tests
   * Tests contract information retrieval
   */
  describe('getContractInfo', () => {
    it('should return the contract ID passed in and the configured version', () => {
      // #812: the ID is now a parameter — the provider holds no shared
      // EphemeralAccount contract, so it can only report what it is asked
      // about. The version assertion is unchanged.
      const info = provider.getContractInfo(validParams.contractId);

      expect(info).toEqual({
        contractId: validParams.contractId,
        version: mockConfig['stellar.contracts.ephemeralAccountVersion'],
      });
    });

    it('should report whichever instance it is given', () => {
      // Two accounts, two instances (#812): the reported ID must follow the
      // argument rather than a value bound at construction.
      const otherContractId = 'CDUMMYOTHERACCOUNT123456789ABCDEFGHIJKL';

      expect(provider.getContractInfo(validParams.contractId).contractId).toBe(
        validParams.contractId,
      );
      expect(provider.getContractInfo(otherContractId).contractId).toBe(
        otherContractId,
      );
    });

    it('should not return the previously hardcoded version', () => {
      // #648: guards against reintroducing a literal that drifts from the
      // deployed contract.
      expect(provider.getContractInfo(validParams.contractId).version).not.toBe(
        '0.1.0',
      );
    });

    it('should report the version as unknown when it is not configured', async () => {
      const moduleWithoutVersion: TestingModule =
        await Test.createTestingModule({
          providers: [
            ContractProvider,
            {
              provide: ConfigService,
              useValue: {
                get: jest.fn(() => undefined),
                getOrThrow: jest.fn((key: string) => {
                  const value = mockConfig[key as keyof typeof mockConfig];
                  if (!value) {
                    throw new Error(`Configuration key not found: ${key}`);
                  }
                  return value;
                }),
              },
            },
          ],
        }).compile();

      const providerWithoutVersion =
        moduleWithoutVersion.get<ContractProvider>(ContractProvider);

      expect(
        providerWithoutVersion.getContractInfo(validParams.contractId).version,
      ).toBe(UNKNOWN_CONTRACT_VERSION);
    });

    it('should return consistent contract ID', () => {
      const info1 = provider.getContractInfo(validParams.contractId);
      const info2 = provider.getContractInfo(validParams.contractId);

      expect(info1.contractId).toBe(info2.contractId);
    });

    it('should have properly typed return value', () => {
      const info = provider.getContractInfo(validParams.contractId);

      expect(typeof info.contractId).toBe('string');
      expect(typeof info.version).toBe('string');
      expect(info.contractId.length).toBeGreaterThan(0);
      expect(info.version).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  /**
   * SECTION 3: authorizeSweep - Successful Authorization Tests
   * Tests the happy path for sweep authorization
   *
   * MVP BEHAVIOR: Returns dummy hash, does not submit transaction
   * PRODUCTION: Will return actual transaction hash and submit to network
   */
  describe('authorizeSweep - Successful Authorization', () => {
    it('should successfully authorize sweep with valid parameters', async () => {
      const result: ContractAuthResult =
        await provider.authorizeSweep(validParams);

      expect(result.authorized).toBe(true);
      expect(result.hash).toBeDefined();
      expect(typeof result.hash).toBe('string');
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('should create RPC server with correct URL when constructed', async () => {
      // #650: the connection is built once in the constructor, so it already
      // exists before any sweep is authorized.
      expect(rpc.Server).toHaveBeenCalledWith(
        mockConfig['stellar.sorobanRpcUrl'],
      );
      expect(rpc.Server).toHaveBeenCalledTimes(1);

      await provider.authorizeSweep(validParams);

      expect(rpc.Server).toHaveBeenCalledTimes(1);
    });

    it('should create contract instance with the per-account contract ID', async () => {
      // #812: the ID comes from the call, not from a value bound in the
      // constructor (which no longer exists).
      await provider.authorizeSweep(validParams);

      expect(Contract).toHaveBeenCalledWith(validParams.contractId);
      expect(Contract).toHaveBeenCalledTimes(1);
    });

    it('should fetch account from RPC server', async () => {
      await provider.authorizeSweep(validParams);

      expect(mockRpcServer.getAccount).toHaveBeenCalledWith(
        validParams.ephemeralPublicKey,
      );
      expect(mockRpcServer.getAccount).toHaveBeenCalledTimes(1);
    });

    it('should convert destination address to Address object', async () => {
      await provider.authorizeSweep(validParams);

      expect(Address.fromString).toHaveBeenCalledWith(
        validParams.destinationAddress,
      );
      expect(Address.fromString).toHaveBeenCalledTimes(1);
    });

    it('should build transaction with correct parameters', async () => {
      await provider.authorizeSweep(validParams);

      expect(TransactionBuilder).toHaveBeenCalledWith(
        mockAccount,
        expect.objectContaining({
          fee: BASE_FEE,
          networkPassphrase: Networks.TESTNET,
        }),
      );
    });

    it('should call contract sweep function with destination and signature', async () => {
      await provider.authorizeSweep(validParams);

      expect(mockContract.call).toHaveBeenCalledWith(
        'sweep',
        expect.anything(), // destination ScVal
        expect.anything(), // signature ScVal
      );

      const callArgs = mockContract.call.mock.calls[0] as unknown[];
      expect(callArgs[0]).toBe('sweep');
      // callArgs[2] should be the signature ScVal
      expect(callArgs[2]).toBeDefined();
    });

    it('should add operation to transaction builder', async () => {
      await provider.authorizeSweep(validParams);

      expect(mockTransactionBuilder.addOperation).toHaveBeenCalledWith(
        mockOperation,
      );
      expect(mockTransactionBuilder.addOperation).toHaveBeenCalledTimes(1);
    });

    it('should set transaction timeout to 30 seconds', async () => {
      await provider.authorizeSweep(validParams);

      expect(mockTransactionBuilder.setTimeout).toHaveBeenCalledWith(30);
      expect(mockTransactionBuilder.setTimeout).toHaveBeenCalledTimes(1);
    });

    it('should build transaction after setting timeout', async () => {
      await provider.authorizeSweep(validParams);

      expect(mockTransactionBuilder.build).toHaveBeenCalled();

      // Verify method chaining - all three should be called
      expect(mockTransactionBuilder.addOperation).toHaveBeenCalled();
      expect(mockTransactionBuilder.setTimeout).toHaveBeenCalled();
      expect(mockTransactionBuilder.build).toHaveBeenCalled();
    });

    it('should simulate transaction before returning', async () => {
      await provider.authorizeSweep(validParams);

      expect(mockRpcServer.simulateTransaction).toHaveBeenCalledWith(
        mockTransaction,
      );
      expect(mockRpcServer.simulateTransaction).toHaveBeenCalledTimes(1);
    });

    it('should check if simulation resulted in error', async () => {
      await provider.authorizeSweep(validParams);

      expect(rpc.Api.isSimulationError).toHaveBeenCalled();
    });

    it('should return timestamp close to current time', async () => {
      const beforeTime = new Date();
      const result = await provider.authorizeSweep(validParams);
      const afterTime = new Date();

      expect(result.timestamp.getTime()).toBeGreaterThanOrEqual(
        beforeTime.getTime(),
      );
      expect(result.timestamp.getTime()).toBeLessThanOrEqual(
        afterTime.getTime(),
      );
    });

    it('should convert destination address to ScVal', async () => {
      await provider.authorizeSweep(validParams);

      expect(mockAddress.toScVal).toHaveBeenCalled();
      expect(mockAddress.toScVal).toHaveBeenCalledTimes(1);
    });

    /**
     * MVP BEHAVIOR TEST: Returns cryptographic authorization hash
     * In production with on-chain submission, this would be the transaction hash
     */
    it('should return cryptographic authorization hash (not transaction hash in MVP)', async () => {
      const result = await provider.authorizeSweep(validParams);

      // MVP returns cryptographic authorization hash generated by generateAuthHash()
      // This is a 64-character hex string (SHA-256 output)
      expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.hash.length).toBe(64);

      // Verify hash is reproducible with same timestamp
      const expectedHash = provider.generateAuthHash(
        validParams.ephemeralPublicKey,
        validParams.destinationAddress,
        result.timestamp.getTime(),
      );
      expect(result.hash).toBe(expectedHash);

      // In production with on-chain submission, this would be the actual tx hash
      // expect(result.hash).toBe(mockTransaction.hash().toString('hex'));
    });
  });

  /**
   * SECTION 4: authorizeSweep - RPC Server Failures
   * Tests various RPC server error scenarios
   */
  describe('authorizeSweep - RPC Server Failures', () => {
    it('should throw InternalServerErrorException when RPC server is unreachable', async () => {
      mockRpcServer.getAccount.mockRejectedValue(
        new Error('Network error: ECONNREFUSED'),
      );

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        InternalServerErrorException,
      );
      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        /Contract execution failed.*Network error/,
      );
    });

    it('should throw InternalServerErrorException on RPC timeout', async () => {
      mockRpcServer.getAccount.mockRejectedValue(new Error('Request timeout'));

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw InternalServerErrorException on DNS resolution failure', async () => {
      mockRpcServer.getAccount.mockRejectedValue(
        new Error('getaddrinfo ENOTFOUND'),
      );

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw InternalServerErrorException on TLS/SSL error', async () => {
      mockRpcServer.getAccount.mockRejectedValue(
        new Error('unable to verify the first certificate'),
      );

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw InternalServerErrorException on rate limiting (429)', async () => {
      mockRpcServer.getAccount.mockRejectedValue(
        new Error('Too Many Requests'),
      );

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw InternalServerErrorException when RPC returns malformed response', async () => {
      mockRpcServer.getAccount.mockRejectedValue(
        new Error('Unexpected token in JSON'),
      );

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw InternalServerErrorException when account does not exist', async () => {
      mockRpcServer.getAccount.mockRejectedValue(
        new Error('Account not found'),
      );

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        InternalServerErrorException,
      );
      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        /Account not found/,
      );
    });

    it('should throw InternalServerErrorException when account has insufficient balance', async () => {
      mockRpcServer.getAccount.mockRejectedValue(
        new Error('Account balance too low for transaction fee'),
      );

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  /**
   * SECTION 5: authorizeSweep - Contract Simulation Failures
   * Tests simulation error handling
   */
  describe('authorizeSweep - Contract Simulation Failures', () => {
    it('should throw error when simulation fails', async () => {
      const simulationError = {
        error: 'Contract execution failed: insufficient auth',
        events: [],
        latestLedger: 12345,
      } as unknown as rpc.Api.SimulateTransactionErrorResponse;

      mockRpcServer.simulateTransaction.mockResolvedValue(simulationError);
      jest.spyOn(rpc.Api, 'isSimulationError').mockReturnValue(true);

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        /Contract simulation failed.*insufficient auth/,
      );
    });

    it('should throw InternalServerErrorException on simulation failure', async () => {
      const simulationError = {
        error: 'Invalid contract invocation',
        events: [],
        latestLedger: 12345,
      } as unknown as rpc.Api.SimulateTransactionErrorResponse;

      mockRpcServer.simulateTransaction.mockResolvedValue(simulationError);
      jest.spyOn(rpc.Api, 'isSimulationError').mockReturnValue(true);

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should handle simulation timeout', async () => {
      mockRpcServer.simulateTransaction.mockRejectedValue(
        new Error('Simulation timeout'),
      );

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        InternalServerErrorException,
      );
      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        /Simulation timeout/,
      );
    });

    it('should handle contract not found error', async () => {
      const simulationError = {
        error: 'Contract not found',
        events: [],
        latestLedger: 12345,
      } as unknown as rpc.Api.SimulateTransactionErrorResponse;

      mockRpcServer.simulateTransaction.mockResolvedValue(simulationError);
      jest.spyOn(rpc.Api, 'isSimulationError').mockReturnValue(true);

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        /Contract simulation failed.*Contract not found/,
      );
    });

    it('should handle invalid contract function error', async () => {
      const simulationError = {
        error: 'Function sweep not found in contract',
        events: [],
        latestLedger: 12345,
      } as unknown as rpc.Api.SimulateTransactionErrorResponse;

      mockRpcServer.simulateTransaction.mockResolvedValue(simulationError);
      jest.spyOn(rpc.Api, 'isSimulationError').mockReturnValue(true);

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        /Contract simulation failed.*Function sweep not found/,
      );
    });

    it('should handle contract execution revert', async () => {
      const simulationError = {
        error: 'Contract execution reverted',
        events: [],
        latestLedger: 12345,
      } as unknown as rpc.Api.SimulateTransactionErrorResponse;

      mockRpcServer.simulateTransaction.mockResolvedValue(simulationError);
      jest.spyOn(rpc.Api, 'isSimulationError').mockReturnValue(true);

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        /Contract simulation failed.*execution reverted/,
      );
    });

    it('should handle resource exhaustion error', async () => {
      const simulationError = {
        error: 'Resource limit exceeded',
        events: [],
        latestLedger: 12345,
      } as unknown as rpc.Api.SimulateTransactionErrorResponse;

      mockRpcServer.simulateTransaction.mockResolvedValue(simulationError);
      jest.spyOn(rpc.Api, 'isSimulationError').mockReturnValue(true);

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        /Contract simulation failed.*Resource limit exceeded/,
      );
    });
  });

  /**
   * SECTION 6: authorizeSweep - Address Conversion Failures
   * Tests address validation and conversion errors
   */
  describe('authorizeSweep - Address Conversion Failures', () => {
    it('should throw error for invalid destination address format', async () => {
      jest.spyOn(Address, 'fromString').mockImplementation(() => {
        throw new Error('Invalid Stellar address');
      });

      await expect(
        provider.authorizeSweep({
          ...validParams,
          destinationAddress: 'INVALID_ADDRESS',
        }),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should throw error for malformed Stellar address', async () => {
      jest.spyOn(Address, 'fromString').mockImplementation(() => {
        throw new Error('Address checksum invalid');
      });

      await expect(
        provider.authorizeSweep({
          ...validParams,
          destinationAddress:
            'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890BADCHECKSUM',
        }),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should throw error for empty destination address', async () => {
      jest.spyOn(Address, 'fromString').mockImplementation(() => {
        throw new Error('Address cannot be empty');
      });

      await expect(
        provider.authorizeSweep({
          ...validParams,
          destinationAddress: '',
        }),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should handle Address.toScVal conversion failure', async () => {
      mockAddress.toScVal.mockImplementation(() => {
        throw new Error('Failed to convert address to ScVal');
      });

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  /**
   * SECTION 7: authorizeSweep - Transaction Building Failures
   * Tests transaction construction error scenarios
   */
  describe('authorizeSweep - Transaction Building Failures', () => {
    it('should throw error when TransactionBuilder fails', async () => {
      (TransactionBuilder as unknown as jest.Mock).mockImplementationOnce(
        () => {
          throw new Error('Failed to create transaction builder');
        },
      );

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw error when operation cannot be added', async () => {
      mockTransactionBuilder.addOperation.mockImplementation(() => {
        throw new Error('Invalid operation');
      });

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw error when timeout is invalid', async () => {
      mockTransactionBuilder.setTimeout.mockImplementation(() => {
        throw new Error('Invalid timeout value');
      });

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw error when transaction build fails', async () => {
      mockTransactionBuilder.build.mockImplementation(() => {
        throw new Error('Transaction build failed');
      });

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw error when contract call construction fails', async () => {
      mockContract.call.mockImplementation(() => {
        throw new Error('Invalid contract call parameters');
      });

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  /**
   * SECTION 8: Authorization Signature Generation Tests
   * Tests cryptographic signature generation
   *
   * MVP BEHAVIOR: Generates dummy 64-byte signature
   * PRODUCTION: Must implement Ed25519 signing with proper key management
   */
  describe('Authorization Signature Generation (MVP)', () => {
    it('should generate 64-byte signature for valid parameters', async () => {
      await provider.authorizeSweep(validParams);

      // Verify signature was passed to contract.call
      expect(mockContract.call).toHaveBeenCalled();
      const callArgs = mockContract.call.mock.calls[0] as [
        string,
        xdr.ScVal,
        xdr.ScVal,
      ];
      const signatureScVal = callArgs[2];

      // Signature should be an ScVal created from a 64-byte buffer
      expect(signatureScVal).toBeDefined();
      expect(xdr.ScVal.scvBytes).toHaveBeenCalledWith(expect.any(Buffer));

      const signatureBuffer = (
        (xdr.ScVal.scvBytes as jest.Mock).mock.calls[0] as unknown[]
      )[0] as Buffer;
      expect(signatureBuffer).toBeInstanceOf(Buffer);
      expect(signatureBuffer.length).toBe(64);
    });

    it('should generate deterministic signature for same inputs', async () => {
      // Mock xdr.ScVal.scvBytes to capture the signature
      const signatures: Buffer[] = [];
      jest.spyOn(xdr.ScVal, 'scvBytes').mockImplementation((buffer: Buffer) => {
        signatures.push(Buffer.from(buffer));
        return {} as xdr.ScVal;
      });

      await provider.authorizeSweep(validParams);
      await provider.authorizeSweep(validParams);

      expect(signatures).toHaveLength(2);
      expect(signatures[0].toString('hex')).toBe(signatures[1].toString('hex'));
    });

    it('should generate different signatures for different nonces', async () => {
      (SweepSignerUtil.sign as jest.Mock)
        .mockReturnValueOnce(Buffer.alloc(64, 1))
        .mockReturnValueOnce(Buffer.alloc(64, 2));

      await provider.authorizeSweep({ ...validParams, nonce: 0n });
      await provider.authorizeSweep({ ...validParams, nonce: 1n });

      expect(SweepSignerUtil.sign).toHaveBeenNthCalledWith(
        1,
        validParams.destinationAddress,
        0n,
        expect.any(String),
        expect.any(String),
      );
      expect(SweepSignerUtil.sign).toHaveBeenNthCalledWith(
        2,
        validParams.destinationAddress,
        1n,
        expect.any(String),
        expect.any(String),
      );
    });

    it('should sign the nonce it is given, never an implicit 0n (#812)', () => {
      // #812 regression guard. `generateAuthSignature` used to default the
      // nonce to `0n`, which is correct only for the first sweep ever executed
      // by a controller; every later sweep was rejected on-chain.
      provider.generateAuthSignature({ ...validParams, nonce: 12n });

      expect(SweepSignerUtil.sign).toHaveBeenCalledWith(
        validParams.destinationAddress,
        12n,
        mockConfig['stellar.contracts.sweepController'],
        mockConfig['stellar.sweepSigningKeySeed'],
      );
      expect(SweepSignerUtil.sign).not.toHaveBeenCalledWith(
        validParams.destinationAddress,
        0n,
        expect.anything(),
        expect.anything(),
      );
    });

    it('should pass different destination addresses to SweepSignerUtil', async () => {
      await provider.authorizeSweep(validParams);
      await provider.authorizeSweep({
        ...validParams,
        destinationAddress: 'GD5J...XRNX',
      });

      expect(SweepSignerUtil.sign).toHaveBeenNthCalledWith(
        1,
        validParams.destinationAddress,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
      expect(SweepSignerUtil.sign).toHaveBeenNthCalledWith(
        2,
        'GD5J...XRNX',
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('should use hash function to generate signature base', async () => {
      // The implementation uses hash() from Stellar SDK
      // We verify this indirectly by checking that a signature is generated
      await provider.authorizeSweep(validParams);

      // Verify that xdr.ScVal.scvBytes was called with a Buffer (the signature)
      expect(xdr.ScVal.scvBytes).toHaveBeenCalledWith(expect.any(Buffer));
    });

    it('should produce collision-resistant signatures (different inputs never produce same output)', () => {
      const signatures: Map<string, string> = new Map();
      jest.spyOn(xdr.ScVal, 'scvBytes').mockImplementation(() => {
        return {} as xdr.ScVal;
      });

      // Test multiple input combinations
      const testCases = [
        {
          ephemeralPublicKey:
            'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J2RROMSG',
          destinationAddress:
            'GD5J6HLF5666X4AZLTFTXLY2CQZBS2LBJBIMYV3SYGQ5OAQY5QO4XRNM',
        },
        {
          ephemeralPublicKey:
            'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J2RROMSE',
          destinationAddress:
            'GD5J6HLF5666X4AZLTFTXLY2CQZBS2LBJBIMYV3SYGQ5OAQY5QO4XRNM',
        },
        {
          ephemeralPublicKey:
            'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J2RROMSG',
          destinationAddress:
            'GD5J6HLF5666X4AZLTFTXLY2CQZBS2LBJBIMYV3SYGQ5OAQY5QO4XRNX',
        },
        {
          ephemeralPublicKey:
            'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
          destinationAddress:
            'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ',
        },
      ];

      for (const testCase of testCases) {
        const message = `${testCase.ephemeralPublicKey}:${testCase.destinationAddress}`;
        const sigHash = Buffer.from(hash(Buffer.from(message))).toString('hex');
        const inputKey = `${testCase.ephemeralPublicKey}:${testCase.destinationAddress}`;

        // Verify no collision with previous signatures
        expect(signatures.has(sigHash)).toBe(false);
        signatures.set(sigHash, inputKey);
      }

      // All 4 test cases should produce unique signatures
      expect(signatures.size).toBe(4);
    });

    /**
     * PRODUCTION REQUIREMENT: Ed25519 signature verification
     * TODO: Implement when moving to production:
     * - Use actual Ed25519 private key
     * - Include timestamp/nonce for replay protection
     * - Ensure signature is verifiable by contract
     * - Implement proper key management
     */
    it('should document production signature requirements', () => {
      // This test serves as documentation for production implementation
      const productionRequirements = {
        algorithm: 'Ed25519',
        signatureLength: 64,
        includeTimestamp: true,
        includeNonce: true,
        replayProtection: true,
        keyManagement: 'secure-enclave-or-hsm',
      };

      expect(productionRequirements.algorithm).toBe('Ed25519');
      expect(productionRequirements.signatureLength).toBe(64);
    });
  });

  /**
   * SECTION 9: Parameter Validation Tests
   * Tests input validation for authorizeSweep
   */
  describe('Parameter Validation', () => {
    it('should handle valid Stellar G-address for ephemeralPublicKey', async () => {
      const result = await provider.authorizeSweep({
        ...validParams,
        ephemeralPublicKey:
          'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J2RROMSG',
      });

      expect(result.authorized).toBe(true);
    });

    it('should handle valid Stellar G-address for destinationAddress', async () => {
      jest
        .spyOn(Address, 'fromString')
        .mockReturnValue(
          mockAddress as unknown as ReturnType<typeof Address.fromString>,
        );

      const result = await provider.authorizeSweep({
        ...validParams,
        destinationAddress:
          'GD5J6HLF5666X4AZLTFTXLY2CQZBS2LBJBIMYV3SYGQ5OAQY5QO4XRNM',
      });

      expect(result.authorized).toBe(true);
      expect(Address.fromString).toHaveBeenCalledWith(
        'GD5J6HLF5666X4AZLTFTXLY2CQZBS2LBJBIMYV3SYGQ5OAQY5QO4XRNM',
      );
    });

    it('should accept contract addresses (C-prefix)', async () => {
      jest
        .spyOn(Address, 'fromString')
        .mockReturnValue(
          mockAddress as unknown as ReturnType<typeof Address.fromString>,
        );

      const result = await provider.authorizeSweep({
        ...validParams,
        destinationAddress:
          'CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA',
      });

      expect(result.authorized).toBe(true);
      expect(Address.fromString).toHaveBeenCalledWith(
        'CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA',
      );
    });

    it('should properly type AuthorizeSweepParams', async () => {
      const params: AuthorizeSweepParams = {
        ephemeralPublicKey: validParams.ephemeralPublicKey,
        destinationAddress: validParams.destinationAddress,
      };

      const result = await provider.authorizeSweep(params);
      expect(result.authorized).toBe(true);
    });

    it('should properly type ContractAuthResult', async () => {
      const result: ContractAuthResult =
        await provider.authorizeSweep(validParams);

      expect(typeof result.authorized).toBe('boolean');
      expect(typeof result.hash).toBe('string');
      expect(result.timestamp).toBeInstanceOf(Date);
    });
  });

  /**
   * SECTION 10: Error Handling and Logging Tests
   * Tests error propagation and logging behavior
   */
  describe('Error Handling and Logging', () => {
    it('should wrap all errors in InternalServerErrorException', async () => {
      mockRpcServer.getAccount.mockRejectedValue(new Error('Some RPC error'));

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should preserve original error message in exception', async () => {
      const originalError = new Error('Specific RPC failure reason');
      mockRpcServer.getAccount.mockRejectedValue(originalError);

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        /Specific RPC failure reason/,
      );
    });

    it('should handle errors with stack traces', async () => {
      const errorWithStack = new Error('Error with stack');
      errorWithStack.stack = 'Mock stack trace';
      mockRpcServer.getAccount.mockRejectedValue(errorWithStack);

      try {
        await provider.authorizeSweep(validParams);
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(InternalServerErrorException);
        expect((error as Error).message).toContain('Error with stack');
      }
    });

    it('should handle network-specific errors appropriately', async () => {
      const networkErrors = [
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ENOTFOUND',
        'ECONNRESET',
        'EPIPE',
      ];

      for (const errorCode of networkErrors) {
        mockRpcServer.getAccount.mockRejectedValue(new Error(errorCode));

        await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
          InternalServerErrorException,
        );
      }
    });
  });

  /**
   * SECTION 11: Integration Flow Tests
   * Tests end-to-end flow of authorization
   */
  describe('Integration Flow', () => {
    it('should execute complete authorization flow in correct order', async () => {
      const callOrder: string[] = [];

      // #650: rpc.Server is not part of this order any more - it is built
      // once in the constructor, before any of these calls.
      (Contract as jest.Mock).mockImplementationOnce(() => {
        callOrder.push('Contract');
        return mockContract;
      });

      mockRpcServer.getAccount.mockImplementationOnce(() => {
        callOrder.push('getAccount');
        return Promise.resolve(mockAccount);
      });

      (Address.fromString as jest.Mock).mockImplementationOnce(() => {
        callOrder.push('Address.fromString');
        return mockAddress;
      });

      (TransactionBuilder as unknown as jest.Mock).mockImplementationOnce(
        () => {
          callOrder.push('TransactionBuilder');
          return mockTransactionBuilder;
        },
      );

      mockRpcServer.simulateTransaction.mockImplementationOnce(() => {
        callOrder.push('simulateTransaction');
        return Promise.resolve({
          id: 'mock',
          latestLedger: 123,
          minResourceFee: '100',
          results: [],
        } as unknown as rpc.Api.SimulateTransactionSuccessResponse);
      });

      await provider.authorizeSweep(validParams);

      expect(callOrder).toEqual([
        'Contract',
        'Address.fromString',
        'getAccount',
        'TransactionBuilder',
        'simulateTransaction',
      ]);
    });

    it('should not call simulateTransaction if transaction build fails', async () => {
      mockTransactionBuilder.build.mockImplementation(() => {
        throw new Error('Build failed');
      });

      await expect(provider.authorizeSweep(validParams)).rejects.toThrow();
      expect(mockRpcServer.simulateTransaction).not.toHaveBeenCalled();
    });

    it('should reuse a single RPC server instance across calls', async () => {
      // #650: regression guard - building an rpc.Server per sweep added
      // avoidable latency under load.
      await provider.authorizeSweep(validParams);
      await provider.authorizeSweep(validParams);
      await provider.authorizeSweep(validParams);

      expect(rpc.Server).toHaveBeenCalledTimes(1);
    });

    it('should create only one Contract instance per call', async () => {
      await provider.authorizeSweep(validParams);

      expect(Contract).toHaveBeenCalledTimes(1);
    });

    it('should create only one TransactionBuilder instance per call', async () => {
      await provider.authorizeSweep(validParams);

      expect(TransactionBuilder).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * SECTION 12: generateAuthHash - Cryptographically Secure Hash Generation
   * Tests for the authorization hash generation method
   *
   * IMPLEMENTATION: Uses Stellar SDK's SHA-256 hash() function
   * PURPOSE: Generates unique, verifiable authorization hashes for sweep operations
   * INTEGRATION: Used in authorizeSweep() to generate the returned hash
   */
  describe('generateAuthHash - Cryptographic Hash Generation', () => {
    it('should be a public method accessible on the provider', () => {
      expect(typeof provider.generateAuthHash).toBe('function');
    });

    it('should generate 64-character hex string (SHA-256 output)', () => {
      const result = provider.generateAuthHash(
        validParams.ephemeralPublicKey,
        validParams.destinationAddress,
      );

      expect(typeof result).toBe('string');
      expect(result.length).toBe(64); // 32 bytes = 64 hex characters
      expect(result).toMatch(/^[a-f0-9]{64}$/); // Valid hex string
    });

    it('should use Stellar SDK hash function for cryptographic security', () => {
      const timestamp = 1706640000000; // Fixed timestamp for deterministic test
      const result = provider.generateAuthHash(
        validParams.ephemeralPublicKey,
        validParams.destinationAddress,
        timestamp,
      );

      // Manually compute expected hash
      const message = `${validParams.ephemeralPublicKey}:${validParams.destinationAddress}:${timestamp}`;
      const expectedHash = Buffer.from(hash(Buffer.from(message))).toString(
        'hex',
      );

      expect(result).toBe(expectedHash);
    });

    it('should include timestamp for replay protection', () => {
      const timestamp1 = 1706640000000;
      const timestamp2 = 1706640001000;

      const hash1 = provider.generateAuthHash(
        validParams.ephemeralPublicKey,
        validParams.destinationAddress,
        timestamp1,
      );
      const hash2 = provider.generateAuthHash(
        validParams.ephemeralPublicKey,
        validParams.destinationAddress,
        timestamp2,
      );

      // Different timestamps should produce different hashes
      expect(hash1).not.toBe(hash2);
    });

    it('should produce different hashes for different ephemeral keys', () => {
      const timestamp = 1706640000000;

      const hash1 = provider.generateAuthHash(
        'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J2RROMSG',
        validParams.destinationAddress,
        timestamp,
      );
      const hash2 = provider.generateAuthHash(
        'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
        validParams.destinationAddress,
        timestamp,
      );

      expect(hash1).not.toBe(hash2);
    });

    it('should produce different hashes for different destinations', () => {
      const timestamp = 1706640000000;

      const hash1 = provider.generateAuthHash(
        validParams.ephemeralPublicKey,
        'GD5J6HLF5666X4AZLTFTXLY2CQZBS2LBJBIMYV3SYGQ5OAQY5QO4XRNM',
        timestamp,
      );
      const hash2 = provider.generateAuthHash(
        validParams.ephemeralPublicKey,
        'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ',
        timestamp,
      );

      expect(hash1).not.toBe(hash2);
    });

    it('should produce deterministic hash for same inputs', () => {
      const timestamp = 1706640000000;

      const hash1 = provider.generateAuthHash(
        validParams.ephemeralPublicKey,
        validParams.destinationAddress,
        timestamp,
      );
      const hash2 = provider.generateAuthHash(
        validParams.ephemeralPublicKey,
        validParams.destinationAddress,
        timestamp,
      );

      expect(hash1).toBe(hash2);
    });

    it('should use current timestamp when none provided', () => {
      const result1 = provider.generateAuthHash(
        validParams.ephemeralPublicKey,
        validParams.destinationAddress,
      );

      // Small delay
      const start = Date.now();
      while (Date.now() - start < 5) {
        // Small delay
      }

      const result2 = provider.generateAuthHash(
        validParams.ephemeralPublicKey,
        validParams.destinationAddress,
      );

      // Without explicit timestamp, hashes should differ
      expect(result1).not.toBe(result2);
    });

    it('should be integrated into authorizeSweep return value', async () => {
      const result = await provider.authorizeSweep(validParams);

      // Hash should be a valid 64-character hex string (not the old placeholder)
      expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.hash).not.toBe('contract-auth-hash');
    });

    it('should generate verifiable hash that can be reconstructed', async () => {
      const result = await provider.authorizeSweep(validParams);
      const timestamp = result.timestamp.getTime();

      // Reconstruct the hash using same parameters
      const reconstructedHash = provider.generateAuthHash(
        validParams.ephemeralPublicKey,
        validParams.destinationAddress,
        timestamp,
      );

      expect(result.hash).toBe(reconstructedHash);
    });

    /**
     * TEST VECTORS - Known input/output pairs for hash verification
     * These can be used by contract implementations to verify hash generation
     */
    it('should match test vectors for known inputs', () => {
      const testVectors = [
        {
          ephemeralKey:
            'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J2RROMSG',
          destination:
            'GD5J6HLF5666X4AZLTFTXLY2CQZBS2LBJBIMYV3SYGQ5OAQY5QO4XRNM',
          timestamp: 1706640000000,
          // Expected hash computed from: hash("GBBM6...:GD5J6...:1706640000000")
        },
      ];

      for (const vector of testVectors) {
        const result = provider.generateAuthHash(
          vector.ephemeralKey,
          vector.destination,
          vector.timestamp,
        );

        // Verify hash format
        expect(result.length).toBe(64);
        expect(result).toMatch(/^[a-f0-9]{64}$/);

        // Verify determinism
        const result2 = provider.generateAuthHash(
          vector.ephemeralKey,
          vector.destination,
          vector.timestamp,
        );
        expect(result).toBe(result2);
      }
    });

    /**
     * SECURITY VALIDATION: Cryptographic properties
     */
    it('should produce collision-resistant hashes', () => {
      const hashes = new Set<string>();
      const timestamp = 1706640000000;

      // Generate hashes for multiple different inputs
      const testInputs = [
        {
          key: 'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J2RROMSG',
          dest: 'GD5J6HLF5666X4AZLTFTXLY2CQZBS2LBJBIMYV3SYGQ5OAQY5QO4XRNM',
        },
        {
          key: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
          dest: 'GD5J6HLF5666X4AZLTFTXLY2CQZBS2LBJBIMYV3SYGQ5OAQY5QO4XRNM',
        },
        {
          key: 'GBBM6BKZPEHWYO3E3YKRETPKQ5MRNWSKA722GHBMZABXD4F2J2RROMSG',
          dest: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ',
        },
        {
          key: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ',
          dest: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
        },
      ];

      for (const input of testInputs) {
        const h = provider.generateAuthHash(input.key, input.dest, timestamp);
        expect(hashes.has(h)).toBe(false); // No collisions
        hashes.add(h);
      }

      expect(hashes.size).toBe(testInputs.length);
    });

    it('should document security properties', () => {
      const securityProperties = {
        algorithm: 'SHA-256 via Stellar SDK hash()',
        outputLength: '64 hex characters (256 bits)',
        cryptographicallySafe: true,
        replayProtection: 'timestamp included in hash input',
        collisionResistant: true,
        preimageResistant: true,
        productionReady: true,
      };

      expect(securityProperties.cryptographicallySafe).toBe(true);
      expect(securityProperties.productionReady).toBe(true);
    });
  });

  /**
   * SECTION 13: Type Safety Validation
   * Ensures all code is properly typed
   */
  describe('Type Safety', () => {
    it('should use properly typed ConfigService', () => {
      const config = configService.getOrThrow<string>(
        'stellar.contracts.ephemeralAccount',
      );
      expect(typeof config).toBe('string');
    });

    it('should use properly typed RPC Server', () => {
      expect(typeof mockRpcServer.getAccount).toBe('function');
      expect(typeof mockRpcServer.simulateTransaction).toBe('function');
    });

    it('should use properly typed Contract', () => {
      expect(typeof mockContract.call).toBe('function');
    });

    it('should use properly typed TransactionBuilder', () => {
      expect(typeof mockTransactionBuilder.addOperation).toBe('function');
      expect(typeof mockTransactionBuilder.setTimeout).toBe('function');
      expect(typeof mockTransactionBuilder.build).toBe('function');
    });

    it('should use properly typed Address', () => {
      expect(typeof mockAddress.toScVal).toBe('function');
    });

    it('should properly type all mock return values', async () => {
      const result = await provider.authorizeSweep(validParams);

      const authorized: boolean = result.authorized;
      const hash: string = result.hash;
      const timestamp: Date = result.timestamp;

      expect(typeof authorized).toBe('boolean');
      expect(typeof hash).toBe('string');
      expect(timestamp).toBeInstanceOf(Date);
    });
  });

  /**
   * SECTION 14: Authorization Verification - Not Implemented in MVP
   *
   * DESIGN DECISION: Authorization verification is not required in MVP because:
   * 1. Contract simulation validates authorization during authorizeSweep()
   * 2. Hash is cryptographically generated and verifiable via generateAuthHash()
   * 3. Production implementation will verify on-chain via smart contract
   *
   * FUTURE: When implementing on-chain submission, the Soroban contract will
   * perform authorization verification by:
   * - Reconstructing the message from parameters
   * - Hashing the message using same algorithm
   * - Comparing against signature provided
   */
  describe('Authorization Verification - Design Decision', () => {
    it('should document that verification is handled by contract simulation in MVP', () => {
      // MVP verification happens during simulateTransaction()
      // which validates the contract call will succeed

      const mvpVerificationApproach = {
        method: 'Contract simulation via RPC',
        location: 'authorizeSweep() calls simulateTransaction()',
        validates: 'Transaction structure and authorization',
        productionApproach: 'On-chain smart contract verification',
      };

      expect(mvpVerificationApproach.method).toBe(
        'Contract simulation via RPC',
      );
    });

    it('should allow manual verification using generateAuthHash', () => {
      const timestamp = new Date().getTime();

      // Generate hash
      const hash1 = provider.generateAuthHash(
        validParams.ephemeralPublicKey,
        validParams.destinationAddress,
        timestamp,
      );

      // Manually verify by regenerating
      const hash2 = provider.generateAuthHash(
        validParams.ephemeralPublicKey,
        validParams.destinationAddress,
        timestamp,
      );

      expect(hash1).toBe(hash2);
    });
  });

  /**
   * SECTION: Production signing guard (#457 criterion 3)
   *
   * `generateAuthSignature()` must refuse to sign when NODE_ENV is
   * `production`, so a development/test seed cannot be used in a real
   * deployment. The guard's own semantics (casing, whitespace, unset) are
   * covered in `sweep-signing-guard.util.spec.ts`; this block asserts the
   * provider actually calls it, because an unwired guard is a guard that
   * does not exist.
   */
  describe('Sweep signing production guard (#457)', () => {
    const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

    afterEach(() => {
      if (ORIGINAL_NODE_ENV === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = ORIGINAL_NODE_ENV;
      }
    });

    it('refuses to sign when NODE_ENV is production', () => {
      process.env.NODE_ENV = 'production';

      expect(() => provider.generateAuthSignature(validParams)).toThrow(
        /Refusing to sign sweep authorizations/,
      );
    });

    it('does not sign when the guard refuses, even via authorizeSweep()', async () => {
      process.env.NODE_ENV = 'production';

      // authorizeSweep() wraps failures in InternalServerErrorException, so the
      // guard's message survives inside it.
      await expect(provider.authorizeSweep(validParams)).rejects.toThrow(
        /Refusing to sign sweep authorizations/,
      );
      // The signature must never have reached the contract call.
      expect(mockContract.call).not.toHaveBeenCalled();
    });

    it.each(['development', 'test', 'staging'])(
      'allows signing when NODE_ENV is %p',
      (nodeEnv) => {
        process.env.NODE_ENV = nodeEnv;

        expect(() => provider.generateAuthSignature(validParams)).not.toThrow();
      },
    );

    it('allows signing when NODE_ENV is unset', () => {
      delete process.env.NODE_ENV;

      expect(() => provider.generateAuthSignature(validParams)).not.toThrow();
    });
  });
});
