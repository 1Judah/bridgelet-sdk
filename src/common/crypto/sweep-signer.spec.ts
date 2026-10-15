import { jest } from '@jest/globals';
import * as crypto from 'crypto';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import {
  KMSClient,
  GetPublicKeyCommand,
  SignCommand,
} from '@aws-sdk/client-kms';
import {
  EnvSeedSweepSigner,
  KmsSweepSigner,
  createSweepSigner,
  fetchKmsEd25519PublicKeyStrKey,
} from './sweep-signer.js';
import { SweepSignerUtil } from './sweep-signer.util.js';

// Only the Command classes need mocking (for argument assertions); the tests
// always inject a fake KMSClient, so the real SDK client is never constructed.
jest.mock('@aws-sdk/client-kms', () => {
  const actual = jest.requireActual<typeof import('@aws-sdk/client-kms')>(
    '@aws-sdk/client-kms',
  );
  return {
    ...actual,
    GetPublicKeyCommand: jest.fn((input: unknown) => ({ input })),
    SignCommand: jest.fn((input: unknown) => ({ input })),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Any 32 bytes are a valid Ed25519 seed; deterministic for reproducible tests.
const SEED_HEX = '0123456789abcdef'.repeat(4);
const KEYPAIR = Keypair.fromRawEd25519Seed(Buffer.from(SEED_HEX, 'hex'));

// Deterministically derive real strkeys: Address.fromString validates the
// checksum, and the G.../C... literals used elsewhere in specs are fixtures
// that only survive because those specs mock Address.
const DESTINATION = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));
const CONTROLLER = StrKey.encodeContract(Buffer.alloc(32, 3));

const message = SweepSignerUtil.buildMessage(DESTINATION, 7n, CONTROLLER);

/** 12-byte Ed25519 SPKI DER header + 32-byte raw key = the 44 bytes KMS returns. */
const ed25519Spki = (rawKey: Buffer = Buffer.alloc(32, 9)): Buffer =>
  Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]);

const makeKmsClient = () =>
  ({
    send: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  }) as unknown as KMSClient;

// ---------------------------------------------------------------------------
// EnvSeedSweepSigner
// ---------------------------------------------------------------------------

describe('EnvSeedSweepSigner', () => {
  it('signs the message with real Ed25519 verifiable by the derived key', async () => {
    const signer = new EnvSeedSweepSigner(SEED_HEX);

    const signature = await signer.sign(message);

    expect(signature).toBeInstanceOf(Buffer);
    expect(signature).toHaveLength(64);
    expect(KEYPAIR.verify(message, signature)).toBe(true);
  });

  it('reports the G... public key the seed derives', () => {
    const signer = new EnvSeedSweepSigner(SEED_HEX);

    expect(signer.publicKey()).toBe(KEYPAIR.publicKey());
  });

  it('produces the same bytes as SweepSignerUtil.sign for the same inputs', async () => {
    const signer = new EnvSeedSweepSigner(SEED_HEX);

    expect(await signer.sign(message)).toEqual(
      SweepSignerUtil.sign(DESTINATION, 7n, CONTROLLER, SEED_HEX),
    );
  });

  it('rejects a seed that is not 32 bytes', () => {
    expect(() => new EnvSeedSweepSigner('abcd')).toThrow(
      /32 bytes \(64 hex chars\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// KmsSweepSigner
// ---------------------------------------------------------------------------

describe('KmsSweepSigner', () => {
  it('signs via KMS with ED25519_SHA_512 over the raw message', async () => {
    const client = makeKmsClient();
    (client.send as jest.Mock).mockResolvedValue({
      Signature: Buffer.alloc(64, 3),
    });
    const signer = new KmsSweepSigner('key-1', 'GPUBKEY', client);

    const signature = await signer.sign(message);

    expect(SignCommand).toHaveBeenCalledWith({
      KeyId: 'key-1',
      Message: message,
      MessageType: 'RAW',
      SigningAlgorithm: 'ED25519_SHA_512',
    });
    expect(signature).toEqual(Buffer.alloc(64, 3));
  });

  it('throws when KMS returns no signature', async () => {
    const client = makeKmsClient();
    (client.send as jest.Mock).mockResolvedValue({});
    const signer = new KmsSweepSigner('key-1', 'GPUBKEY', client);

    await expect(signer.sign(message)).rejects.toThrow(
      /KMS Sign returned no signature/,
    );
  });

  it('reports the public key it was constructed with', () => {
    const signer = new KmsSweepSigner('key-1', 'GPUBKEY', makeKmsClient());

    expect(signer.publicKey()).toBe('GPUBKEY');
  });
});

// ---------------------------------------------------------------------------
// fetchKmsEd25519PublicKeyStrKey
// ---------------------------------------------------------------------------

describe('fetchKmsEd25519PublicKeyStrKey', () => {
  it('encodes the raw key from the SPKI DER as a G... strkey', async () => {
    const rawKey = Buffer.alloc(32, 9);
    const client = makeKmsClient();
    (client.send as jest.Mock).mockResolvedValue({
      PublicKey: ed25519Spki(rawKey),
    });

    const strKey = await fetchKmsEd25519PublicKeyStrKey(client, 'key-1');

    expect(GetPublicKeyCommand).toHaveBeenCalledWith({ KeyId: 'key-1' });
    expect(strKey.startsWith('G')).toBe(true);
    expect(StrKey.decodeEd25519PublicKey(strKey)).toEqual(
      new Uint8Array(rawKey),
    );
  });

  it('rejects a public key that is not a 44-byte Ed25519 SPKI DER', async () => {
    const client = makeKmsClient();
    (client.send as jest.Mock).mockResolvedValue({
      PublicKey: Buffer.alloc(40),
    });

    await expect(
      fetchKmsEd25519PublicKeyStrKey(client, 'key-1'),
    ).rejects.toThrow(/44-byte Ed25519 SPKI DER public key/);
  });

  it('rejects an empty GetPublicKey response', async () => {
    const client = makeKmsClient();
    (client.send as jest.Mock).mockResolvedValue({});

    await expect(
      fetchKmsEd25519PublicKeyStrKey(client, 'key-1'),
    ).rejects.toThrow(/returned no public key/);
  });
});

// ---------------------------------------------------------------------------
// createSweepSigner — selection, fail-fast, and the mismatch check (#823)
// ---------------------------------------------------------------------------

describe('createSweepSigner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('defaults to the env-seed signer', async () => {
    const signer = await createSweepSigner({
      provider: 'env-seed',
      signingKeySeed: SEED_HEX,
      nodeEnv: 'development',
    });

    expect(signer).toBeInstanceOf(EnvSeedSweepSigner);
    expect(signer.publicKey()).toBe(KEYPAIR.publicKey());
  });

  it('refuses the env-seed signer in production (no fallback to the seed)', async () => {
    await expect(
      createSweepSigner({
        provider: 'env-seed',
        signingKeySeed: SEED_HEX,
        nodeEnv: 'production',
      }),
    ).rejects.toThrow(/Refusing to sign sweep authorizations/);
  });

  it('requires a seed for the env-seed signer', async () => {
    await expect(
      createSweepSigner({ provider: 'env-seed', nodeEnv: 'development' }),
    ).rejects.toThrow(/SWEEP_SIGNING_KEY_SEED\) is required/);
  });

  it('rejects an unknown provider', async () => {
    await expect(
      createSweepSigner({ provider: 'hsm', nodeEnv: 'development' }),
    ).rejects.toThrow(/Unknown stellar\.sweepSignerProvider "hsm"/);
  });

  it('builds a KmsSweepSigner for the kms provider', async () => {
    const client = makeKmsClient();
    (client.send as jest.Mock).mockResolvedValue({
      PublicKey: ed25519Spki(),
    });

    const signer = await createSweepSigner(
      {
        provider: 'kms',
        kmsKeyId: 'key-1',
        awsRegion: 'eu-west-1',
        nodeEnv: 'production',
      },
      () => client,
    );

    expect(signer).toBeInstanceOf(KmsSweepSigner);
    expect(signer.publicKey().startsWith('G')).toBe(true);
  });

  it('requires a key ID for the kms signer', async () => {
    await expect(
      createSweepSigner({ provider: 'kms', nodeEnv: 'production' }),
    ).rejects.toThrow(/STELLAR_SWEEP_KMS_KEY_ID\) is required/);
  });

  it('accepts a signer whose public key matches the configured authorized signer', async () => {
    const signer = await createSweepSigner({
      provider: 'env-seed',
      signingKeySeed: SEED_HEX,
      nodeEnv: 'development',
      authorizedSigner: KEYPAIR.publicKey(),
    });

    expect(signer.publicKey()).toBe(KEYPAIR.publicKey());
  });

  it('fails startup when the signer public key does not match the authorized signer', async () => {
    await expect(
      createSweepSigner({
        provider: 'env-seed',
        signingKeySeed: SEED_HEX,
        nodeEnv: 'development',
        authorizedSigner:
          'GBADKEYNOTMINEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
    ).rejects.toThrow(/does not match the configured authorized signer/);
  });

  it('applies the mismatch check to the kms signer too', async () => {
    const client = makeKmsClient();
    (client.send as jest.Mock).mockResolvedValue({
      PublicKey: ed25519Spki(),
    });

    await expect(
      createSweepSigner(
        {
          provider: 'kms',
          kmsKeyId: 'key-1',
          nodeEnv: 'production',
          authorizedSigner:
            'GBADKEYNOTMINEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        },
        () => client,
      ),
    ).rejects.toThrow(/does not match the configured authorized signer/);
  });
});

// ---------------------------------------------------------------------------
// Cross-check: KMS ED25519_SHA_512 (RAW) and Node Ed25519 sign the same bytes
// ---------------------------------------------------------------------------

describe('signer equivalence', () => {
  it('EnvSeedSweepSigner signatures verify with crypto.verify (RFC 8032)', async () => {
    const signer = new EnvSeedSweepSigner(SEED_HEX);
    const signature = await signer.sign(message);

    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        KEYPAIR.rawPublicKey(),
      ]),
      format: 'der',
      type: 'spki',
    });

    expect(crypto.verify(null, message, publicKey, signature)).toBe(true);
  });
});
