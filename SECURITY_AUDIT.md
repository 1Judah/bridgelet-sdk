# Security Audit — Secrets at Rest

**Last reviewed:** 2026-09-26 · **Next review due:** 2026-12-26
(see the re-audit cadence in [`SECURITY.md`](SECURITY.md))

Inventory of sensitive data categories persisted by this service and their
current protection level. This supplements the base64-encryption finding
already tracked for account secret keys.

| Category                    | Where stored                                | Current protection                                               | Status                                                          |
| --------------------------- | ------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| Stellar account secret keys | `accounts` table, `secretKeyEncrypted`      | Envelope-encrypted via `SecretEncryptionUtil` + `KmsKeyProvider` | OK                                                              |
| Claim tokens                | `accounts` table, `claimTokenHash` only     | SHA-256 hash, plaintext never persisted                          | OK                                                              |
| JWT signing secret          | Environment variable (`JWT_SECRET`)         | Not stored in DB; relies on deployment secret manager            | Accepted risk — deployment-level responsibility, not an app gap |
| Database credentials        | Environment variables                       | Not stored in DB or repo; relies on deployment secret manager    | Accepted risk — deployment-level responsibility, not an app gap |
| Webhook secrets             | `webhooks` table, `secret` column           | Envelope-encrypted via `KmsKeyProvider` (`encryptSecret`)        | Remediated — #688                                               |
| API keys (integrators)      | `accounts` table / future `api-keys` module | Rotation/revocation added                                        | Remediated — #549                                               |

## Gaps identified

- ~~Webhook `secret` column is not confirmed encrypted at rest, unlike account
  secret keys.~~ **Closed.** `WebhooksService.encryptSecret()` routes both
  `create()` and `update()` through `KmsKeyProvider.encrypt()`, so the column is
  envelope-encrypted on the same path as account secret keys. The DTOs also
  enforce strength and format validation (min length, character set).
  Tracked by **#688**, now closed. This row was still showing as an open gap at
  the 2026-09-26 review; corrected 2026-10-16 against #891.

No open gaps remain in this table.

## Known dependency advisories (baselined, not silently fixed)

`npm audit --omit=dev` currently reports findings in `js-yaml`, `multer`,
`protobufjs`, `qs`, `toml`, `typeorm`, `brace-expansion`, and their parent
packages (`@nestjs/swagger`, `@nestjs/platform-express`,
`@stellar/stellar-sdk`, `@opentelemetry/auto-instrumentations-node`,
`@opentelemetry/propagator-jaeger`, `@opentelemetry/sdk-node`).
These are pre-existing, tracked here rather than fixed ad hoc, and are
exempted in `.github/workflows/dependency-audit.yml` so the new CI gate
blocks only NEW high/critical findings. Remediating each requires a
dependency bump (some breaking) and should be its own follow-up issue.

## Process

New findings must be appended to this table with a `Status` and, once
triaged, a linked GitHub issue number (see
`docs/security-audit-reconciliation.md`).

At each quarterly review, every row above is re-checked against the tracker:
a `Gap` with no open issue is escalated and filed, and a row may not be marked
`Remediated` unless its linked issue is actually closed. This is a static
snapshot by design — the reconciliation doc and the cadence in `SECURITY.md`
are what keep it from drifting into a document nobody trusts.
