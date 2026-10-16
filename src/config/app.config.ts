import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  env: process.env.NODE_ENV ?? 'development',
  jwtSecret: process.env.JWT_SECRET ?? 'change-me-in-production',
  // Previous JWT secret, kept verifiable for the duration of a rotation so
  // claim tokens signed before the swap stay redeemable. Claim tokens are valid
  // for up to `claimTokenExpiry` (30 days by default), so an operator who
  // changes JWT_SECRET today would otherwise invalidate every unclaimed token in
  // flight. Unset once no outstanding token predates the rotation. Mirrors
  // `encryptionKeyPrevious` for the AES-256 data key (issue #621/#681).
  jwtSecretPrevious: process.env.JWT_SECRET_PREVIOUS,
  corsOrigins: process.env.CORS_ORIGINS?.split(',') || '*',
  apiRateLimit: parseInt(process.env.API_RATE_LIMIT ?? '100', 10),
  claimTokenExpiry: parseInt(process.env.CLAIM_TOKEN_EXPIRY ?? '2592000', 10),
  claimBaseUrl: process.env.CLAIM_BASE_URL || 'https://claim.bridgelet.io',
  webhookRetryAttempts: parseInt(process.env.WEBHOOK_RETRY_ATTEMPTS ?? '3', 10),
  webhookTimeout: parseInt(process.env.WEBHOOK_TIMEOUT ?? '5000', 10),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  paymentPollIntervalMs: parseInt(
    process.env.PAYMENT_POLL_INTERVAL_MS ?? '30000',
    10,
  ),
  expiryCheckIntervalMs: parseInt(
    process.env.EXPIRY_CHECK_INTERVAL_MS ?? '300000',
    10,
  ),
  initializingCleanupIntervalMs: parseInt(
    process.env.INITIALIZING_CLEANUP_INTERVAL_MS ?? '900000',
    10,
  ),
  initializingTimeoutMs: parseInt(
    process.env.INITIALIZING_TIMEOUT_MS ?? '600000',
    10,
  ),
  kmsEnabled: process.env.KMS_ENABLED !== 'false',
  kmsKeyId: process.env.KMS_KEY_ID,
  awsRegion: process.env.AWS_REGION ?? 'us-east-1',
  // Previous AES-256 key, kept readable for the duration of a key rotation so
  // ciphertext written under the old key stays decryptable (issue #621/#681).
  // Unset once every row has been re-encrypted under the current key.
  encryptionKeyPrevious: process.env.ENCRYPTION_KEY_PREVIOUS,
  // Where the KMS-wrapped data key is persisted so it survives a restart
  // instead of being regenerated (issue #619/#680).
  kmsDataKeyPath: process.env.KMS_DATA_KEY_PATH,
  // Key id written into `aes256gcm:v2:<keyId>:...` ciphertext. When unset,
  // writes stay on the v1 format for backwards compatibility.
  encryptionKeyId: process.env.ENCRYPTION_KEY_ID,
}));
