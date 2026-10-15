import {
  KMSClient,
  GetPublicKeyCommand,
  SignCommand,
} from '@aws-sdk/client-kms';
import { StrKey } from '@stellar/stellar-sdk';
import { SweepSignerUtil } from './sweep-signer.util.js';
import { SweepSigningGuard } from './sweep-signing-guard.util.js';

/**
 * SweepSigner (#823)
 *
 * Abstraction over "who holds the sweep-authorization Ed25519 private key".
 * `ContractProvider.generateAuthSignature()` builds the 32-byte SHA256
 * message digest (`SweepSignerUtil.buildMessage`, pinned by the bridgelet-core
 * conformance vectors) and hands it to a `SweepSigner`; only the signing step
 * is behind the interface, so the signed bytes are identical no matter which
 * backend produced the 64-byte signature.
 *
 * Two implementations:
 *
 * - {@link EnvSeedSweepSigner} — signs with `stellar.sweepSigningKeySeed`
 *   straight from the environment. Development/testnet only:
 *   `SweepSigningGuard` refuses it when `NODE_ENV=production`, and
 *   {@link createSweepSigner} refuses to even construct it in production.
 *
 * - {@link KmsSweepSigner} — signs with an asymmetric Ed25519 AWS KMS key
 *   (KeySpec `ECC_NIST_EDWARDS25519`, KeyUsage `SIGN_VERIFY`). The private
 *   key never leaves KMS. KMS's `ED25519_SHA_512` with `MessageType: RAW` is
 *   pure Ed25519 (RFC 8032) over the message we pass — the same primitive
 *   Node's `crypto.sign(null, ...)` uses for the env-seed path — so the
 *   64-byte output is byte-for-byte the signature the on-chain
 *   `SweepController::verify_sweep_auth` accepts.
 *
 * Both report the G... strkey of their public key, so startup can verify it
 * against the SweepController's `authorized_signer` before any claim runs.
 */
export interface SweepSigner {
  /**
   * Sign the 32-byte SHA256 message digest built by
   * `SweepSignerUtil.buildMessage`. Returns the raw 64-byte Ed25519
   * signature.
   */
  sign(message: Buffer): Promise<Buffer>;

  /** G... strkey of the key this signer signs with. */
  publicKey(): string;
}

/** Signs with `SWEEP_SIGNING_KEY_SEED` from the environment. */
export class EnvSeedSweepSigner implements SweepSigner {
  private readonly signingKeySeed: string;
  private readonly cachedPublicKey: string;

  constructor(signingKeySeed: string) {
    // Validates the seed format (64 hex chars) up front, so a malformed seed
    // fails at startup rather than on the first sweep.
    this.cachedPublicKey = SweepSignerUtil.publicKeyFromSeed(signingKeySeed);
    this.signingKeySeed = signingKeySeed;
  }

  async sign(message: Buffer): Promise<Buffer> {
    return SweepSignerUtil.signMessage(message, this.signingKeySeed);
  }

  publicKey(): string {
    return this.cachedPublicKey;
  }
}

/** Signs with an asymmetric Ed25519 AWS KMS key; the private key never leaves KMS. */
export class KmsSweepSigner implements SweepSigner {
  constructor(
    private readonly kmsKeyId: string,
    private readonly cachedPublicKey: string,
    private readonly client: KMSClient,
  ) {}

  async sign(message: Buffer): Promise<Buffer> {
    const result = await this.client.send(
      new SignCommand({
        KeyId: this.kmsKeyId,
        // The message is the 32-byte SHA256 digest; RAW + ED25519_SHA_512 is
        // pure Ed25519 over those bytes (no caller-side prehash).
        Message: message,
        MessageType: 'RAW',
        SigningAlgorithm: 'ED25519_SHA_512',
      }),
    );
    if (!result.Signature) {
      throw new Error(
        `KMS Sign returned no signature for key ${this.kmsKeyId}`,
      );
    }
    return Buffer.from(result.Signature);
  }

  publicKey(): string {
    return this.cachedPublicKey;
  }
}

export type SweepSignerProvider = 'env-seed' | 'kms';

export interface SweepSignerConfig {
  /** `stellar.sweepSignerProvider`; defaults to 'env-seed' when unset. */
  provider: SweepSignerProvider | string;
  /** `stellar.sweepSigningKeySeed` — required for the env-seed provider. */
  signingKeySeed?: string;
  /** `stellar.sweepKmsKeyId` — required for the kms provider. */
  kmsKeyId?: string;
  /** AWS region for the KMS client (falls back to the SDK default chain). */
  awsRegion?: string;
  /** Passed through to SweepSigningGuard for the env-seed provider. */
  nodeEnv?: string;
  /** Optional expected G... public key (the controller's authorized_signer). */
  authorizedSigner?: string;
}

export type KmsClientFactory = (region: string | undefined) => KMSClient;

/**
 * Build the configured SweepSigner. Called once from
 * `ContractProvider.onModuleInit()`, so a misconfigured deployment fails at
 * startup — there is deliberately no fallback from 'kms' to the env seed.
 *
 * `kmsClientFactory` exists so unit tests can inject a fake KMSClient; the
 * default constructs the real SDK client.
 */
export async function createSweepSigner(
  config: SweepSignerConfig,
  kmsClientFactory: KmsClientFactory = (region) => new KMSClient({ region }),
): Promise<SweepSigner> {
  if (config.provider === 'env-seed') {
    // Reuses the #457 guard unchanged: the env seed is refused in production
    // even here, at construction time, not only later at signing time.
    SweepSigningGuard.assertSigningAllowed(config.nodeEnv);
    if (!config.signingKeySeed) {
      throw new Error(
        'stellar.sweepSigningKeySeed (SWEEP_SIGNING_KEY_SEED) is required ' +
          'when stellar.sweepSignerProvider is "env-seed".',
      );
    }
    const signer = new EnvSeedSweepSigner(config.signingKeySeed);
    assertMatchesAuthorizedSigner(signer, config.authorizedSigner);
    return signer;
  }

  if (config.provider === 'kms') {
    if (!config.kmsKeyId) {
      throw new Error(
        'stellar.sweepKmsKeyId (STELLAR_SWEEP_KMS_KEY_ID) is required ' +
          'when stellar.sweepSignerProvider is "kms".',
      );
    }
    const client = kmsClientFactory(config.awsRegion);
    const publicKey = await fetchKmsEd25519PublicKeyStrKey(
      client,
      config.kmsKeyId,
    );
    const signer = new KmsSweepSigner(config.kmsKeyId, publicKey, client);
    assertMatchesAuthorizedSigner(signer, config.authorizedSigner);
    return signer;
  }

  throw new Error(
    `Unknown stellar.sweepSignerProvider "${config.provider}". ` +
      'Expected "env-seed" or "kms".',
  );
}

/**
 * Fails startup when the selected signer's public key is not the one the
 * SweepController was initialized with: every sweep would be rejected
 * on-chain by `verify_sweep_auth`, and that failure mode is otherwise easy
 * to miss (issue #823 section C). Skipped when no expected key is
 * configured.
 */
function assertMatchesAuthorizedSigner(
  signer: SweepSigner,
  authorizedSigner?: string,
): void {
  if (!authorizedSigner) return;
  const actual = signer.publicKey();
  if (actual !== authorizedSigner) {
    throw new Error(
      `Sweep signer public key ${actual} does not match the configured ` +
        `authorized signer ${authorizedSigner}. Sweeps would be rejected ` +
        'on-chain by SweepController.verify_sweep_auth; refusing to start.',
    );
  }
}

/**
 * Reads the public key of an asymmetric Ed25519 KMS key and encodes it as
 * the G... strkey the SweepController stores in `authorized_signer`.
 */
export async function fetchKmsEd25519PublicKeyStrKey(
  client: KMSClient,
  kmsKeyId: string,
): Promise<string> {
  const result = await client.send(
    new GetPublicKeyCommand({ KeyId: kmsKeyId }),
  );
  if (!result.PublicKey) {
    throw new Error(`KMS GetPublicKey returned no public key for ${kmsKeyId}`);
  }
  const spki = Buffer.from(result.PublicKey);
  // Ed25519 SPKI DER is a fixed 12-byte header (SEQUENCE + AlgorithmIdentifier
  // OID 1.3.101.112 + BIT STRING framing) followed by the 32-byte raw key.
  if (spki.length !== 44) {
    throw new Error(
      `Expected a 44-byte Ed25519 SPKI DER public key from KMS key ` +
        `${kmsKeyId}, got ${spki.length} bytes. Create the key with KeySpec ` +
        'ECC_NIST_EDWARDS25519 and KeyUsage SIGN_VERIFY.',
    );
  }
  return StrKey.encodeEd25519PublicKey(spki.subarray(12));
}
