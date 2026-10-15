/**
 * Basic smoke tests to execute the config factory functions and
 * ensure defaults are applied when env vars are absent.
 *
 * These tests do not require any NestJS DI context — they call the
 * factory directly to exercise the branches (|| fallback values).
 *
 * Note: database.config.ts and typeorm.config.ts use import.meta.url (ESM)
 * which Jest cannot dynamically import in CommonJS mode — they are excluded.
 */

type ConfigFactory = () => Record<string, unknown>;

describe('app.config', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.PORT;
    delete process.env.NODE_ENV;
    delete process.env.JWT_SECRET;
    delete process.env.CLAIM_TOKEN_EXPIRY;
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    delete process.env.PORT;
    delete process.env.NODE_ENV;
    delete process.env.JWT_SECRET;
    delete process.env.CLAIM_TOKEN_EXPIRY;
  });

  it('returns defaults when env vars are not set', async () => {
    const mod = await import('./app.config.js');
    const config = (mod.default as unknown as ConfigFactory)();
    expect(config.port).toBe(3000);
    expect(config.env).toBe('development');
  });

  it('uses env var PORT when set', async () => {
    process.env.PORT = '4000';
    const mod = await import('./app.config.js');
    const config = (mod.default as unknown as ConfigFactory)();
    expect(config.port).toBe(4000);
  });

  it('uses NODE_ENV when set', async () => {
    process.env.NODE_ENV = 'production';
    const mod = await import('./app.config.js');
    const config = (mod.default as unknown as ConfigFactory)();
    expect(config.env).toBe('production');
  });

  it('uses JWT_SECRET when set', async () => {
    process.env.JWT_SECRET = 'my-test-secret';
    const mod = await import('./app.config.js');
    const config = (mod.default as unknown as ConfigFactory)();
    expect(config.jwtSecret).toBe('my-test-secret');
  });

  it('uses CLAIM_TOKEN_EXPIRY when set', async () => {
    process.env.CLAIM_TOKEN_EXPIRY = '86400';
    const mod = await import('./app.config.js');
    const config = (mod.default as unknown as ConfigFactory)();
    expect(config.claimTokenExpiry).toBe(86400);
  });
});

describe('stellar.config', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.STELLAR_NETWORK;
    delete process.env.STELLAR_HORIZON_URL;
    delete process.env.STELLAR_SOROBAN_RPC_URL;
    delete process.env.SWEEP_CONTROLLER_CONTRACT_ID;
    delete process.env.SWEEP_SIGNING_KEY_SEED;
    delete process.env.ENCRYPTION_KEY;
  });

  afterEach(() => {
    delete process.env.STELLAR_NETWORK;
    delete process.env.STELLAR_HORIZON_URL;
  });

  it('returns testnet defaults when env vars are not set', async () => {
    const mod = await import('./stellar.config.js');
    const config = (mod.default as unknown as ConfigFactory)();
    expect(config.network).toBe('testnet');
    expect(config.horizonUrl).toContain('testnet');
    expect(config.sorobanRpcUrl).toContain('testnet');
  });

  it('uses STELLAR_NETWORK when set', async () => {
    process.env.STELLAR_NETWORK = 'mainnet';
    const mod = await import('./stellar.config.js');
    const config = (mod.default as unknown as ConfigFactory)();
    expect(config.network).toBe('mainnet');
  });

  it('rejects an invalid STELLAR_NETWORK value', async () => {
    process.env.STELLAR_NETWORK = 'main-net';
    const mod = await import('./stellar.config.js');
    expect(() => (mod.default as unknown as ConfigFactory)()).toThrow(
      'Expected "mainnet" or "testnet"',
    );
  });

  it('uses STELLAR_HORIZON_URL when set', async () => {
    process.env.STELLAR_HORIZON_URL = 'https://horizon.stellar.org';
    const mod = await import('./stellar.config.js');
    const config = (mod.default as unknown as ConfigFactory)();
    expect(config.horizonUrl).toBe('https://horizon.stellar.org');
  });

  it('uses STELLAR_SOROBAN_RPC_URL when set', async () => {
    process.env.STELLAR_SOROBAN_RPC_URL = 'https://soroban.stellar.org';
    const mod = await import('./stellar.config.js');
    const config = (mod.default as unknown as ConfigFactory)();
    expect(config.sorobanRpcUrl).toBe('https://soroban.stellar.org');
  });
});

describe('isSynchronizeAllowed (#726)', () => {
  it('is false when DATABASE_SYNC is unset or "false"', async () => {
    const { isSynchronizeAllowed } = await import('./database-sync.util.js');
    expect(isSynchronizeAllowed({})).toBe(false);
    expect(isSynchronizeAllowed({ DATABASE_SYNC: 'false' })).toBe(false);
    expect(
      isSynchronizeAllowed({ DATABASE_SYNC: 'false', NODE_ENV: 'production' }),
    ).toBe(false);
  });

  it('is true only under NODE_ENV=test with DATABASE_SYNC=true', async () => {
    const { isSynchronizeAllowed } = await import('./database-sync.util.js');
    expect(
      isSynchronizeAllowed({ DATABASE_SYNC: 'true', NODE_ENV: 'test' }),
    ).toBe(true);
  });

  it('throws when DATABASE_SYNC=true outside NODE_ENV=test', async () => {
    const { isSynchronizeAllowed } = await import('./database-sync.util.js');
    for (const NODE_ENV of ['production', 'development', undefined]) {
      expect(() =>
        isSynchronizeAllowed({ DATABASE_SYNC: 'true', NODE_ENV }),
      ).toThrow('only permitted when NODE_ENV=test');
    }
  });
});

describe('validateEnv - CLAIM_BASE_URL', () => {
  const baseValidEnv: NodeJS.ProcessEnv = {
    DATABASE_HOST: 'localhost',
    DATABASE_PORT: '5432',
    DATABASE_NAME: 'bridgelet',
    DATABASE_USER: 'postgres',
    DATABASE_PASSWORD: 'password',
    STELLAR_NETWORK: 'testnet',
    STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    STELLAR_SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    JWT_SECRET: 'test-jwt-secret',
    ENCRYPTION_KEY: 'a'.repeat(64),
    EPHEMERAL_ACCOUNT_WASM_HASH: 'b'.repeat(64),
  };

  it('refuses to start when NODE_ENV=production and CLAIM_BASE_URL is missing', async () => {
    const { validateEnv } = await import('./env-validation.js');
    expect(() =>
      validateEnv({
        ...baseValidEnv,
        NODE_ENV: 'production',
      }),
    ).toThrow('CLAIM_BASE_URL is missing');
  });

  it('refuses to start when NODE_ENV=production and CLAIM_BASE_URL has a trailing slash', async () => {
    const { validateEnv } = await import('./env-validation.js');
    expect(() =>
      validateEnv({
        ...baseValidEnv,
        NODE_ENV: 'production',
        CLAIM_BASE_URL: 'https://claim.bridgelet.io/',
      }),
    ).toThrow('CLAIM_BASE_URL must not have a trailing slash');
  });

  it('refuses to start when NODE_ENV=production and CLAIM_BASE_URL is not http/https', async () => {
    const { validateEnv } = await import('./env-validation.js');
    expect(() =>
      validateEnv({
        ...baseValidEnv,
        NODE_ENV: 'production',
        CLAIM_BASE_URL: 'ftp://claim.bridgelet.io',
      }),
    ).toThrow('CLAIM_BASE_URL must be a valid http or https URL');
  });

  it('succeeds when NODE_ENV=production and CLAIM_BASE_URL is a valid URL without trailing slash', async () => {
    const { validateEnv } = await import('./env-validation.js');
    expect(() =>
      validateEnv({
        ...baseValidEnv,
        NODE_ENV: 'production',
        CLAIM_BASE_URL: 'https://claim.bridgelet.io',
        // #823: production requires the KMS sweep signer.
        STELLAR_SWEEP_SIGNER_PROVIDER: 'kms',
        STELLAR_SWEEP_KMS_KEY_ID:
          'arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab',
      }),
    ).not.toThrow();
  });

  it('refuses to start when NODE_ENV=production and the sweep signer is env-seed (#823)', async () => {
    const { validateEnv } = await import('./env-validation.js');
    expect(() =>
      validateEnv({
        ...baseValidEnv,
        NODE_ENV: 'production',
        CLAIM_BASE_URL: 'https://claim.bridgelet.io',
        STELLAR_SWEEP_SIGNER_PROVIDER: 'env-seed',
      }),
    ).toThrow('STELLAR_SWEEP_SIGNER_PROVIDER must be "kms" in production');
  });

  it('refuses to start when NODE_ENV=production and the sweep signer is kms without a key ID (#823)', async () => {
    const { validateEnv } = await import('./env-validation.js');
    expect(() =>
      validateEnv({
        ...baseValidEnv,
        NODE_ENV: 'production',
        CLAIM_BASE_URL: 'https://claim.bridgelet.io',
        STELLAR_SWEEP_SIGNER_PROVIDER: 'kms',
      }),
    ).toThrow(
      'STELLAR_SWEEP_KMS_KEY_ID is required when STELLAR_SWEEP_SIGNER_PROVIDER is "kms"',
    );
  });

  it('rejects an unknown STELLAR_SWEEP_SIGNER_PROVIDER value (#823)', async () => {
    const { validateEnv } = await import('./env-validation.js');
    expect(() =>
      validateEnv({
        ...baseValidEnv,
        STELLAR_SWEEP_SIGNER_PROVIDER: 'hsm',
      }),
    ).toThrow('STELLAR_SWEEP_SIGNER_PROVIDER must be "env-seed" or "kms"');
  });

  it('starts normally without CLAIM_BASE_URL when NODE_ENV is development or test', async () => {
    const { validateEnv } = await import('./env-validation.js');
    expect(() =>
      validateEnv({
        ...baseValidEnv,
        NODE_ENV: 'development',
      }),
    ).not.toThrow();

    expect(() =>
      validateEnv({
        ...baseValidEnv,
        NODE_ENV: 'test',
      }),
    ).not.toThrow();
  });
});
