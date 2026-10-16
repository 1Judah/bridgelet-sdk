# Security

**Last reviewed:** 2026-09-26
**Next review due:** 2026-12-26 (quarterly — see [Re-audit cadence](#re-audit-cadence))

This document describes how Bridgelet SDK protects sensitive data at rest, in particular the ephemeral Stellar secret keys the service is responsible for custodying between account creation and claim redemption.

## Ephemeral secret key encryption

Every ephemeral account's Stellar secret key is encrypted before it is written to `accounts.secretKeyEncrypted` and is only ever decrypted in-memory, for the duration of a claim redemption, immediately before it is handed to the signing/sweep path.

- **Algorithm:** AES-256-GCM (authenticated encryption — tamper-evident, unique IV per write).
- **Implementation:** [`SecretEncryptionUtil`](src/common/crypto/secret-encryption.util.ts). This is the single, shared implementation for encrypt/decrypt of secret material — it must never be reimplemented inline elsewhere.
- **Stored format:** `aes256gcm:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>`, or `aes256gcm:v2:<keyId>:<iv_hex>:<authTag_hex>:<ciphertext_hex>` when a key id is configured. The `aes256gcm:v1:`/`v2:` prefix makes the format self-describing so a future format change fails loudly on an unrecognized version rather than silently mis-decoding.
- **Key length:** 256-bit (32-byte) key, supplied as a 64-character hex string.

### Key management

The encryption key is never stored alongside the encrypted data (i.e. never in the database, never committed to the repo).

- **Production (recommended):** [`KmsKeyProvider`](src/common/crypto/kms-key.provider.ts) sources the data-encryption key from AWS KMS via envelope encryption:
  - On startup, the service calls `GenerateDataKey` against a KMS Customer Master Key (`KMS_KEY_ID`). The plaintext data key is held in memory only, for the lifetime of the process, and is used to encrypt/decrypt secret rows via `SecretEncryptionUtil`. The CMK itself never leaves AWS.
  - The **encrypted** data-key blob is persisted — via `KMS_ENCRYPTED_DATA_KEY`, else the file at `KMS_DATA_KEY_PATH` — and unwrapped with KMS `Decrypt` on the next start. This matters: regenerating the data key on every restart would make every `secretKeyEncrypted` value written under the previous one undecryptable, permanently.
  - If a persisted blob exists but cannot be unwrapped (wrong CMK, rotated-away key, corrupted file), the provider **refuses to generate a new data key** and falls back to `ENCRYPTION_KEY`, logging an error. Regenerating in that situation would destroy access while appearing healthy.
  - Configure with `KMS_ENABLED=true`, `KMS_KEY_ID=<arn-or-alias>`, `AWS_REGION=<region>`.
  - For multi-instance deployments, replace the local file with a durable store (AWS Systems Manager Parameter Store / Secrets Manager) by populating `KMS_ENCRYPTED_DATA_KEY` out of band. The plaintext is never written to disk either way.
  - Rotating the CMK requires re-wrapping (`decryptDataKey`) and re-encrypting existing rows; it is not automatic.
- **Fallback (non-production / local dev only):** if `KMS_ENABLED=false` or `KMS_KEY_ID` is unset, the service falls back to a static key from the `ENCRYPTION_KEY` environment variable (see `.env.example`). This path exists for local development and tests. **Do not run production with real funds on the `ENCRYPTION_KEY` fallback path** — use KMS.

### Key rotation

[`SecretRotationUtil`](src/common/crypto/secret-rotation.util.ts) provides the dual-key decrypt path, and `KmsKeyProvider` wires it in for both the KMS and fallback paths.

Two mechanisms, because two problems exist:

- **Untagged rows** (`v1`, unprefixed). These name no key, so the only way to read one is to try the current key and then the previous one. Set `ENCRYPTION_KEY_PREVIOUS` to keep old rows readable.
- **Key-id tagged rows** (`v2`). These name the key they need, so the right key is selected directly rather than by trial. Set `ENCRYPTION_KEY_ID` to opt into tagged writes.

During a rotation:

1. Set `ENCRYPTION_KEY_ID` (new key id) and `ENCRYPTION_KEY_PREVIOUS` (the outgoing key material).
2. Deploy. New writes are tagged `v2`; reads resolve either format.
3. Re-encrypt existing rows (`npm run migrate:secrets`), or simply let them age out.
4. Confirm the outgoing key id is no longer in use with `npm run audit:secrets` (see below).
5. Unset `ENCRYPTION_KEY_PREVIOUS` once nothing needs it.

A v2 row whose key id is unknown to the loaded key ring **fails loudly** rather than being mis-decoded with the current key.

### Migration from legacy formats

Prior to PR #193, this service persisted secret keys with `Buffer.from(secret).toString('base64')` — encoding, not encryption. That placeholder is no longer produced by any code path, but rows written before the fix may still hold a base64 value in non-production databases.

`SecretEncryptionUtil.decrypt()` refuses to decode a base64 row (it throws a descriptive error pointing at the migration tool) rather than silently treating it as ciphertext. To reclassify and re-encrypt any legacy rows (base64 placeholder, or unprefixed pre-`v1` AES-GCM), run:

```bash
# Dry run (default) — reports what would change, writes nothing
npm run migrate:secrets

# Actual migration — requires both flags
npm run migrate:secrets -- --i-have-a-backup --execute
```

See the header comment in [`src/scripts/migrate-secrets.ts`](src/scripts/migrate-secrets.ts) for full safety semantics (dry-run default, optimistic concurrency, audit log, halt-on-corrupt-row).

`decrypt()` also still accepts **unprefixed** pre-`v1` AES-GCM rows, for databases partway through the migration. Those branches are only removable once nothing needs them, so there is a check that answers that question:

```bash
psql -At -c 'SELECT "secretKeyEncrypted" FROM accounts' > secrets.json
npm run audit:secrets -- ./secrets.json
```

It prints a per-format breakdown plus the key ids currently in use, and exits
non-zero while any legacy or corrupt row remains — so it can gate the cleanup
that deletes those branches from `decrypt()`.

**No production deployment with real funds should occur against a database that still has any `legacy-base64` rows.** Run the migration (or start from a fresh database) first.

### Test coverage

- [`src/common/crypto/encryption.util.spec.ts`](src/common/crypto/encryption.util.spec.ts) covers: round-trip correctness, unique ciphertext per call (random IV), rejection of a tampered ciphertext, rejection of the wrong key, descriptive rejection errors for legacy base64 and unsupported format versions, and the `classify()` helper used by the migration script.
- [`src/common/crypto/kms-key.provider.spec.ts`](src/common/crypto/kms-key.provider.spec.ts) covers the KMS/fallback key-selection logic.
- [`src/scripts/migration-cli.spec.ts`](src/scripts/migration-cli.spec.ts) covers the migration CLI's flag parsing and audit logging.

## Claim tokens

Claim tokens are signed JWTs (`app.jwtSecret`). Only a SHA-256 hash of the token (`claimTokenHash`) is persisted; the raw token is returned to the caller exactly once, in the `create` response's `claimUrl`.

<<<<<<< HEAD
Because a token cannot be re-issued, rotating `JWT_SECRET` without a grace window invalidates every outstanding token at once and strands the funds behind them. `JWT_SECRET_PREVIOUS` keeps the outgoing secret accepted during a rotation; see [`docs/jwt-secret-rotation-runbook.md`](docs/jwt-secret-rotation-runbook.md).

## Webhook secrets

A webhook `secret` is a shared HMAC key: whoever holds it can forge deliveries your receiver will accept. It is:

- **validated** on input — at least 16 characters, `[A-Za-z0-9_-]` only (`CreateWebhookDto.secret`, `UpdateWebhookDto.secret`);
- **encrypted at rest** with the same `SecretEncryptionUtil` + `KmsKeyProvider` envelope used for account secret keys, and decrypted only at the moment a delivery is signed (`WebhooksService`);
- **write-only over the API** — `WebhookResponseDto` has no `secret` field, so it cannot be read back through `GET`/`POST`/`PUT`. A lost secret must be rotated, not recovered.

Rows written before encryption was introduced hold a plaintext secret; `WebhooksService.readSecret()` detects that and keeps using them, and they are re-encrypted the next time the secret is rotated.

## Re-audit cadence

`SECURITY.md` and [`SECURITY_AUDIT.md`](SECURITY_AUDIT.md) are point-in-time
snapshots and go stale if nobody revisits them. The following cadence applies.

- **Quarterly** (next due **2026-12-26**): re-read both documents end to end
  and update the `Last reviewed` date above. The reviewer must, for every row
  in `SECURITY_AUDIT.md`, confirm the stated `Status` is still accurate and
  that any linked issue is still tracked (open or closed) rather than silently
  dropped.
- **On any change to the crypto path** — `src/common/crypto/**`,
  `SecretEncryptionUtil`, `KmsKeyProvider` — re-review immediately rather than
  waiting for the quarterly pass. These files hold the keys that protect
  account secret keys, so a change here is itself a review trigger.
- **On any new sensitive data category** being persisted, add a row to
  `SECURITY_AUDIT.md` in the same PR that introduces it. A new column holding
  secret material may not land without a corresponding audit row.

### What "cross-checked against tracked issues" means

The `Status` column in `SECURITY_AUDIT.md` is only trustworthy if each finding
resolves to something the tracker knows about. The rules, enforced at review
time and recorded in
[`docs/security-audit-reconciliation.md`](docs/security-audit-reconciliation.md):

1. Every finding carries a `Status`.
2. A finding may not be marked `Remediated` without a linked issue that was
   actually closed.
3. A finding marked `Gap` must have an open issue filed against it before the
   next quarterly pass. **This is the check most likely to catch silent
   rot** — a `Gap` with no issue number means nobody owns the work.
4. Findings that are intentionally accepted risk (rather than gaps) are marked
   as such with a rationale, so they are not re-litigated every quarter and not
   mistaken for unfixed bugs.

The one currently-known `Gap` is the webhook `secret` column, which is tracked
by issue #688. Until that closes, treat webhook secrets as plaintext at rest
and avoid treating them as protected with the same guarantees as account
secret keys.

## Reporting a vulnerability

If you discover a security issue in this repository, please do not open a public GitHub issue. Contact the maintainers directly so the issue can be triaged and fixed before disclosure.

## Verification notes

- **Dual-key decrypt (#742):** `aes256gcm:v2:<keyId>:...` ciphertexts and the key ring in `SecretEncryptionUtil` allow decrypting under the previous key during a rotation window (`secret-rotation.util.ts`).
- **Legacy secret formats (#743):** run `npm run audit:secrets` (`src/scripts/audit-legacy-secret-formats.ts`) to find remaining unprefixed or base64 rows. The legacy branches in `decrypt()` can be deleted once it reports none.
- **JWT_SECRET rotation (#744):** see `docs/jwt-secret-rotation-runbook.md`; `jwt-rotation.util.ts` accepts the previous secret during the grace window.
- **StrKey validation (#745):** `is-stellar-public-key.validator.ts` is covered by `is-stellar-public-key.validator.spec.ts` and a fuzz spec (`is-stellar-public-key.fuzz.spec.ts`) including checksum-invalid encodings.
