# Claim Route Rate Limits

Reference for the rate limits on `/claims/*`. For the app-wide limit and the
full endpoint list, see [`api-reference.md`](./api-reference.md).

## Why these routes are different

`/accounts/*` and `/webhooks/*` are authenticated with an API JWT, so an
abuser needs a credential to generate traffic. `/claims/*` is **not
authenticated** — the claim token in the request body _is_ the credential,
and it is a bearer secret with no server-side revocation.

That makes the claim routes the highest-value target in the API:

- `POST /claims/redeem` moves real on-chain funds. Anyone who guesses,
  leaks or replays a valid token can sweep an account to an address they
  control.
- `POST /claims/verify` is a token oracle. Unthrottled, it lets an attacker
  probe candidate tokens and learn which accounts exist and how much they
  hold, without touching the chain.

Both therefore carry an explicit, tighter `@Throttle` limit in
`claims.controller.ts` rather than inheriting the app-wide default.

## The limits

| Route                 | Limit                                          | Window | Source                                |
| --------------------- | ---------------------------------------------- | ------ | ------------------------------------- |
| `POST /claims/redeem` | 5                                              | 60s    | `@Throttle` in `claims.controller.ts` |
| `POST /claims/verify` | 10                                             | 60s    | `@Throttle` in `claims.controller.ts` |
| `GET /claims/:id`     | app-wide (`API_RATE_LIMIT`, default 100 / 60s) | 60s    | `ThrottlerModule.forRoot`             |
| everything else       | app-wide                                       | 60s    | `ThrottlerModule.forRoot`             |

The two claim limits are **per-route, not shared**: exhausting
`/claims/verify` does not throttle `/claims/redeem`, and vice versa.

## What counts as an attempt

**Every request counts, including rejected ones.** An attempt that fails
`class-validator` (malformed `destinationAddress`), fails signature
verification, or names a token that does not exist still consumes budget.
This is deliberate and is the property that makes the limit useful: if
rejections were free, an attacker could probe unlimited candidate tokens
against `/claims/verify` at no cost to themselves.

`claims.redeem-throttle.spec.ts` pins this down, and sets the app-wide limit
far above the route limit so that a `429` can only be attributed to the
route-specific `@Throttle`. Without that separation the test would still pass
if someone deleted the decorator.

Exceeding a limit returns **429**.

## Client guidance

- Treat `429` as retryable, with exponential backoff and jitter. Do not retry
  in a tight loop — that extends the window during which you are blocked.
- `POST /claims/redeem` is idempotent for an already-redeemed token: a repeat
  returns the original result rather than moving funds twice. A `429` on
  redeem is therefore not a lost claim, but a client that gives up
  permanently does strand the account until it expires.
- For `sweep.partial` outcomes, a retry is expected and necessary — see
  [`webhook-events.md`](./webhook-events.md). Budget for a handful of
  attempts, not dozens.
- If your integration legitimately needs more than 5 redemptions per minute,
  that is a capacity conversation, not something to work around client-side.

## Tuning

The route limits are hard-coded in `claims.controller.ts` rather than
configurable, so that the brute-force ceiling cannot be raised by an
environment variable that gets copied between environments. Changing them is
a deliberate code change; update this document and
`claims.redeem-throttle.spec.ts` (which asserts the exact values) in the same
PR.

## Verification notes

- **`/claims/redeem` throttling (#747):** the route has an explicit `@Throttle` limit, asserted by `src/modules/claims/claims.redeem-throttle.spec.ts` (repeated invalid redemptions get throttled).
- **Claim token expiry vs. account expiry (#748):** `CLAIM_TOKEN_EXPIRY` (default 30 days) can exceed an account's own `expiresAt`. `TokenVerificationProvider` rejects tokens for already-expired accounts explicitly rather than relying on a downstream 404; see `claim-token-expiry-audit.spec.ts`.
- **Metadata limits (#746):** `sanitizeMetadata()` rules (prototype-pollution keys, size and depth bounds) are enumerated in `metadata-sanitizer.util.spec.ts`; size/depth is also enforced before sanitization by `@IsBoundedMetadata()`.
- **Webhook secrets (#749):** `CreateWebhookDto.secret` requires at least 16 characters from `[A-Za-z0-9_-]`, and `WebhookResponseDto` never returns the secret.
