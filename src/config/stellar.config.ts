import { registerAs } from '@nestjs/config';

export type StellarNetwork = 'mainnet' | 'testnet';

/**
 * #827: default allow-list of asset issuers per network.
 *
 * Only issuers on this list may be used for issued-asset ephemeral accounts,
 * so an API caller cannot mint an arbitrary asset code that merely happens to
 * validate as `CODE:ISSUER`. The defaults are the Circle USDC issuers;
 * operators can override them per deployment (see
 * {@link getAllowedAssetIssuers}).
 */
const DEFAULT_ALLOWED_ASSET_ISSUERS: Record<StellarNetwork, string[]> = {
  mainnet: ['GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'],
  testnet: ['GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'],
};

export default registerAs('stellar', () => ({
  network: getNetwork(),
  horizonUrl:
    process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org',
  sorobanRpcUrl:
    process.env.STELLAR_SOROBAN_RPC_URL ||
    'https://soroban-testnet.stellar.org',
  fundingSecret: process.env.FUNDING_ACCOUNT_SECRET,
  recoveryPublic: process.env.RECOVERY_ACCOUNT_PUBLIC,
  contracts: {
    ephemeralAccount: process.env.EPHEMERAL_ACCOUNT_CONTRACT_ID,
    // #811: the ephemeral-account WASM hash of the uploaded contract. Every
    // POST /accounts deploys its own contract instance from this hash (see
    // StellarService.createEphemeralAccount), so a single shared contract ID
    // can never be initialized twice.
    ephemeralAccountWasmHash: process.env.EPHEMERAL_ACCOUNT_WASM_HASH,
    sweepController: process.env.SWEEP_CONTROLLER_CONTRACT_ID,
    // #648: version of the deployed ephemeral-account contract. Left
    // undefined when unknown so ContractProvider reports 'unknown' rather
    // than a stale literal that silently drifts from the deployed WASM.
    ephemeralAccountVersion: process.env.EPHEMERAL_ACCOUNT_CONTRACT_VERSION,
  },
  sweepSigningKeySeed: process.env.SWEEP_SIGNING_KEY_SEED,
  // #823: which SweepSigner backs generateAuthSignature(). 'env-seed' (the
  // default) signs with SWEEP_SIGNING_KEY_SEED and is refused in production
  // by SweepSigningGuard; 'kms' signs with an asymmetric Ed25519 KMS key and
  // is required in production.
  sweepSignerProvider: process.env.STELLAR_SWEEP_SIGNER_PROVIDER,
  // KMS key (KeySpec ECC_NIST_EDWARDS25519, KeyUsage SIGN_VERIFY) used when
  // sweepSignerProvider is 'kms'.
  sweepKmsKeyId: process.env.STELLAR_SWEEP_KMS_KEY_ID,
  // Optional: the G... public key the selected signer must hold (the
  // SweepController's on-chain authorized_signer). Startup fails on mismatch.
  sweepAuthorizedSigner: process.env.STELLAR_SWEEP_AUTHORIZED_SIGNER,
  encryptionKey: process.env.ENCRYPTION_KEY || '64_char_hex_string_here',
  sweepControllerContractId: process.env.SWEEP_CONTROLLER_CONTRACT_ID,
  // #827: the issuers a non-native asset may be denominated in on this network.
  allowedAssetIssuers: getAllowedAssetIssuers(),
}));

// #882: strict enum validation at config-load time. A typo such as `main-net`
// throws here instead of silently resolving to the TESTNET passphrase while
// still pointing at mainnet Horizon/RPC URLs.
function getNetwork(): StellarNetwork {
  const network = process.env.STELLAR_NETWORK || 'testnet';
  if (network !== 'mainnet' && network !== 'testnet') {
    throw new Error(
      `Invalid STELLAR_NETWORK "${network}". Expected "mainnet" or "testnet".`,
    );
  }
  return network;
}

/**
 * #827: the allow-list of asset issuers for `network` (defaults to the
 * configured network).
 *
 * Precedence: a per-network env override
 * (`ASSET_ISSUER_ALLOWLIST_MAINNET` / `ASSET_ISSUER_ALLOWLIST_TESTNET`), then
 * the generic `ASSET_ISSUER_ALLOWLIST`, then the built-in defaults. Each value
 * is a comma-separated list of Stellar public keys; empty entries are ignored
 * and an all-empty override falls back to the defaults.
 */
export function getAllowedAssetIssuers(
  network: StellarNetwork = getNetwork(),
): string[] {
  const envKey =
    network === 'mainnet'
      ? 'ASSET_ISSUER_ALLOWLIST_MAINNET'
      : 'ASSET_ISSUER_ALLOWLIST_TESTNET';
  const configured = process.env[envKey] ?? process.env.ASSET_ISSUER_ALLOWLIST;

  if (configured !== undefined) {
    const parsed = configured
      .split(',')
      .map((issuer) => issuer.trim())
      .filter((issuer) => issuer.length > 0);
    if (parsed.length > 0) {
      return parsed;
    }
  }

  return DEFAULT_ALLOWED_ASSET_ISSUERS[network];
}

/**
 * #827: whether `issuer` is an allowed issuer for `network`.
 */
export function isAllowedAssetIssuer(
  issuer: string,
  network: StellarNetwork = getNetwork(),
): boolean {
  return getAllowedAssetIssuers(network).includes(issuer);
}
