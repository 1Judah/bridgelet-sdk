# Reconciling SECURITY_AUDIT.md With Tracked Issues

`SECURITY_AUDIT.md` lists findings by category. This document defines how
each finding stays linked to an actively tracked GitHub issue instead of
going stale.

**Last reconciled:** 2026-09-26 · **Next due:** 2026-12-26

## Cross-reference

| Finding (SECURITY_AUDIT.md)            | Tracking issue                        | Status             |
| -------------------------------------- | ------------------------------------- | ------------------ |
| Secret-key base64 encryption           | Original flagged issue (pre-existing) | Remediated         |
| Broader secrets-at-rest audit          | #547                                  | Closed             |
| Dependency vulnerability scanning gate | #548                                  | Closed             |
| API key rotation/revocation            | #549                                  | Closed             |
| Webhook secret encryption-at-rest gap  | #688                                  | Open — in progress |

Every row now resolves to a real issue. The previous state of this table listed
the webhook-secret gap as "Not yet filed", which is precisely the failure mode
the process below is meant to prevent.

## Process going forward

1. Any new row added to `SECURITY_AUDIT.md` must include a `Status` value.
2. A finding may not be marked `Remediated` without a linked issue number
   that was actually closed.
3. A finding with `Status: Gap` and no issue number must have one filed
   before the next audit pass, per the table above.
4. This table is reviewed whenever `SECURITY_AUDIT.md` changes, so findings
   cannot silently go untracked.
5. Rows whose risk is deliberately accepted (rather than unfixed) say so
   explicitly, with the reason. Without this, an accepted risk looks
   indistinguishable from an unfixed gap and gets re-filed every quarter.

## Verification notes

- **API reference coverage (#739):** every route in the README "Key Endpoints" table has a matching section in `docs/api-reference.md` (`POST/GET /accounts`, `GET /accounts/:id`, `POST /claims/verify`, `POST /claims/redeem`, `GET /claims/:id`, and `GET/POST/PUT/DELETE /webhooks`). Re-check both when adding a route.
- **Webhook event catalog (#740):** the event names passed to `webhooksService.triggerEvent(...)` are `account.created` (`accounts.service.ts`), `account.expired` (scheduler), and `sweep.completed`, `sweep.failed`, `sweep.partial` (`claim-redemption.provider.ts`). All five are documented in `docs/webhook-events.md`.
- **KMS data key persistence (#741):** `KmsKeyProvider` persists the encrypted data key (`KMS_ENCRYPTED_DATA_KEY` or `KMS_DATA_KEY_PATH`) and refuses to regenerate it when unwrapping fails; see `SECURITY.md`.
