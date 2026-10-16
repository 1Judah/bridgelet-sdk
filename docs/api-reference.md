# API Reference

Every route the service exposes, with request/response examples. The
"Key Endpoints" table in [`README.md`](../README.md) is a summary of this
page; this page is the source of truth.

An OpenAPI/Swagger UI is also served by the running app (see
[Getting Started](./getting-started.md)).

## Contents

- [Authentication](#authentication)
- [Accounts](#accounts)
  - [`POST /accounts`](#post-accounts)
  - [`GET /accounts/:id`](#get-accountsid)
  - [`GET /accounts`](#get-accounts)
  - [`CreateAccountDto.expiresIn`](#createaccountdtoexpiresin)
- [Claims](#claims)
  - [`POST /claims/verify`](#post-claimsverify)
  - [`POST /claims/redeem`](#post-claimsredeem)
  - [`GET /claims/:id`](#get-claimsid)
  - [Where the claim token comes from](#where-the-claim-token-comes-from)
- [Webhooks](#webhooks)
  - [`GET /webhooks`](#get-webhooks)
  - [`POST /webhooks`](#post-webhooks)
  - [`PUT /webhooks/:id`](#put-webhooksid)
  - [`DELETE /webhooks/:id`](#delete-webhooksid)
  - [Webhook secrets](#webhook-secrets)
- [Health](#health)
- [Errors](#errors)

## Authentication

| Route group   | Auth required                                          |
| ------------- | ------------------------------------------------------ |
| `/accounts/*` | Yes — `Authorization: Bearer <api JWT>`                |
| `/webhooks/*` | Yes — `Authorization: Bearer <api JWT>`                |
| `/claims/*`   | **No** — the claim token in the body is the credential |
| `/health`     | No                                                     |

The API JWT must carry `type: "api"`. A token minted for a different purpose
(for example a `type: "claim"` claim token) is rejected with `401`.

A token may also carry a `scope`:

| `scope`          | Effect on `/accounts/*`                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| absent / `admin` | Sees every account (the default, and what existing deployments use).                                    |
| `sender`         | Only sees accounts whose `senderAddress` equals the token's `senderAddress` claim. Requires that claim. |

`POST /accounts` stamps `senderAddress` from a `sender`-scoped token (an
explicit body value for a _different_ wallet is rejected with `403`). An admin
token may set any `senderAddress` in the body, or none. See
[FUTURE_AUTH_SCOPING.md](./FUTURE_AUTH_SCOPING.md).

`/claims/*` is deliberately unauthenticated: the claim token _is_ the bearer
credential, and those routes are rate limited instead (see
[Rate limits](#rate-limits)).

## Accounts

### `POST /accounts`

Create an ephemeral escrow account. This is the only route that mints a claim
token — see [Where the claim token comes from](#where-the-claim-token-comes-from).

**Request**

```json
{
  "fundingSource": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "recovery_address": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "amount": "100.0000000",
  "asset_code": "native",
  "expiresIn": 2592000,
  "metadata": { "integration_id": "webhook_123" }
}
```

| Field              | Required | Notes                                                                                                                           |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `fundingSource`    | Yes      | Stellar public key funding the account. StrKey-validated.                                                                       |
| `recovery_address` | Yes      | Where funds go if the account expires unclaimed.                                                                                |
| `amount`           | Yes      | Decimal string, 7 decimal places.                                                                                               |
| `asset_code`       | No       | 1–12 uppercase alphanumerics. Use `native` for XLM.                                                                             |
| `asset_issuer`     | No       | Required when `asset_code` is a non-native issued asset and must be a supported issuer for the network (e.g. USDC) — see below. |
| `expiresIn`        | No       | Seconds, 1 hour – 30 days. See [`expiresIn`](#createaccountdtoexpiresin).                                                       |
| `senderAddress`    | No       | Sender wallet (StrKey). A `sender`-scoped token always stamps its own; an admin token may set any.                              |
| `metadata`         | No       | Free-form object. Bounded and PII-stripped — see below.                                                                         |

**Response `201`** — [`AccountResponseDto`](../src/modules/accounts/dto/account-response.dto.ts)

```json
{
  "accountId": "550e8400-e29b-41d4-a716-446655440000",
  "publicKey": "GABCD1234EFGH5678IJKL9012MNOP3456QRST7890UVWX1234YZAB5678",
  "claimUrl": "https://bridgelet.app/claim/abc123def456",
  "txHash": "abcd1234efgh5678ijkl9012mnop3456qrst7890uvwx1234yzab5678",
  "amount": "100.5000000",
  "asset": "native",
  "status": "PENDING_CLAIM",
  "expiresAt": "2026-03-26T10:00:00.000Z",
  "createdAt": "2026-02-26T10:00:00.000Z",
  "claimedAt": null,
  "metadata": { "integration_id": "webhook_123" }
}
```

`claimUrl` is returned **exactly once**. Only a SHA-256 hash of the underlying
claim token is persisted, so it cannot be retrieved later — store it at
creation time.

The ephemeral account's Stellar **secret key is never returned**. It is
encrypted at rest and only decrypted in-memory at redemption time.

#### Issued assets (e.g. USDC)

Supplying a non-native `asset_code` (anything other than `native`/`XLM`)
requires an `asset_issuer`, and that issuer must be on the deployment's
per-network **allow-list** of supported issuers — otherwise the request is
rejected with `400` and the issuer cannot be used. This stops an arbitrary
`CODE:ISSUER` from being minted by a caller.

The built-in defaults are the Circle USDC issuers (mainnet
`GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`, testnet
`GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`) and can be
overridden with `ASSET_ISSUER_ALLOWLIST` (or the per-network
`ASSET_ISSUER_ALLOWLIST_MAINNET` / `ASSET_ISSUER_ALLOWLIST_TESTNET`), a
comma-separated list of issuer public keys.

When an issued asset is created, the ephemeral account is funded with an extra
base reserve and a trustline to the issuer is established during creation, so
the account can receive that asset. Sweeping an issued asset additionally
requires the **destination** to already hold a trustline to the issuer, or the
sweep is rejected with `400 DESTINATION_NO_TRUSTLINE`.

**Errors:** `400` invalid input · `401` missing/invalid API JWT · `429`
rate limited

#### `metadata` handling

`metadata` is passed through
[`sanitizeMetadata`](../src/common/utils/metadata-sanitizer.util.ts) before
persistence:

- must serialise to **≤ 4096 bytes**;
- `__proto__`, `constructor` and `prototype` keys are dropped (prototype
  pollution);
- keys that look like PII (`email`, `phone`, `ssn`, `dob`, `address`, `name`,
  `passport`, `taxid`, …) are stripped case-insensitively.

Stripping is silent; exceeding the size limit is a `400`.

### `GET /accounts/:id`

Fetch the current lifecycle state of one account. For a `sender`-scoped
token, an account belonging to a different wallet returns `404` (not `403`)
so the caller cannot tell it apart from an account that does not exist.

**Response `200`** — `AccountResponseDto`, same shape as `POST /accounts`.
`claimUrl` is `null` once the account has been claimed or expired.

**Errors:** `401` · `404` not found (including soft-deleted accounts, and
accounts outside a `sender` token's scope)

### `GET /accounts`

Listing with pagination. An admin token sees every account; a `sender`-scoped
token only sees accounts stamped with its own `senderAddress`.

| Query param | Default | Notes                                                      |
| ----------- | ------- | ---------------------------------------------------------- |
| `limit`     | `50`    | Max `100`                                                  |
| `offset`    | `0`     | Records to skip                                            |
| `status`    | —       | Filter by [`AccountStatus`](./account-status-reference.md) |

**Response `200`** — `AccountsListResponseDto`

```json
{
  "accounts": [
    /* AccountResponseDto[] */
  ],
  "total": 150
}
```

`total` is the count _before_ pagination is applied.

### `CreateAccountDto.expiresIn`

`expiresIn` (seconds, integer) is the client-supplied lifetime of the
ephemeral account. Internally it is converted to `expiry_ledger`, the u32
ledger sequence the `bridgelet-core` contract expects:

```
expiry_ledger = current_ledger + (expiresIn / 5)
```

**Assumption:** Stellar ledgers close roughly every 5 seconds on average, so
dividing the requested lifetime (in seconds) by 5 approximates the number of
ledgers that will elapse. This is an approximation, not a guarantee — actual
ledger close times vary with network conditions, so `expiry_ledger` should
be treated as a best-effort deadline rather than an exact timestamp.

`current_ledger` is read from the latest Horizon/Soroban RPC response at the
time the account is created.

> This formula currently also appears in `README.md` under the temporary
> workarounds section (see "Ledger Expiry Conversion"). Once that section is
> removed, this page becomes the single source of truth — keep this doc in
> sync if the underlying conversion implementation changes.

Note that the account's `expiresAt` and the claim token's own expiry
(`CLAIM_TOKEN_EXPIRY`, default 30 days) are **independent** clocks. A claim
token can still be cryptographically valid after its account has expired; in
that case verification is rejected explicitly rather than failing later in the
sweep path. See [`expires-at-scope.md`](./expires-at-scope.md).

## Claims

All `/claims/*` routes are unauthenticated and rate limited. See
[Rate limits](#rate-limits).

### `POST /claims/verify`

Check whether a claim token is still valid and claimable, without moving
funds. Useful for a "claim page" that should show the amount before the user
commits.

**Request**

```json
{ "claimToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." }
```

**Response `200`**

```json
{
  "valid": true,
  "accountId": "4ebae33b-5b93-424c-858d-d79afc708af5",
  "amount": "100.0000000",
  "asset": "native",
  "expiresAt": "2026-02-21T10:30:00.000Z"
}
```

**Errors:** `400` account not funded / still initialising · `401` invalid or
expired token · `409` already claimed · `429` rate limited

### `POST /claims/redeem`

Sweep the account's funds to `destinationAddress`. **This moves real
on-chain funds** and is the highest-value route in the API.

**Request**

```json
{
  "claimToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "destinationAddress": "GBBD47UZQ5YLQYYTWTCB7X3DUEEVZMDVGFBRNZPMZDWQWKCFN3EOZQKQ"
}
```

**Response `201`** — success

```json
{
  "success": true,
  "txHash": "571a84bc59fefb3fd17fe167b9c76286e83c31972649441a2d09da87f5b997a7",
  "amountSwept": "100.0000000",
  "asset": "native",
  "destination": "GBBD47UZQ5YLQYYTWTCB7X3DUEEVZMDVGFBRNZPMZDWQWKCFN3EOZQKQ",
  "sweptAt": "2026-01-14T17:49:20.265Z"
}
```

A `201` with `success: false` and `isPartial: true` means the on-chain
contract authorised the sweep but the Horizon payment did not settle. The
account is left in `PARTIAL_SWEEP`; **retry with the same token** and it will
resume without re-authorising. Do not mint a new account in this state.

Redeeming an already-redeemed token is idempotent and returns the original
result with `message: "Claim was already redeemed"`.

**Errors:** `400` invalid destination / not yet funded / no trustline
(`DESTINATION_NO_TRUSTLINE`) · `401` invalid or expired token · `409` already
being processed · `429` rate limited

### `GET /claims/:id`

Fetch a recorded claim by its ID.

**Response `200`**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "accountId": "660e8400-e29b-41d4-a716-446655440000",
  "destinationAddress": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "amountSwept": "100.0000000",
  "asset": "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "sweepTxHash": "571a84bc59fefb3fd17fe167b9c76286e83c31972649441a2d09da87f5b997a7",
  "claimedAt": "2026-01-14T17:49:20.265Z"
}
```

**Errors:** `404` not found

### Where the claim token comes from

> There is **no `POST /claims/initiate` route.** An earlier version of the
> README's "Key Endpoints" table listed one; the endpoint does not exist in the
> codebase and the table has been corrected.

The claim token is minted as a side effect of `POST /accounts` and returned
once, in that response's `claimUrl`. The end-user presents the token to
`POST /claims/verify` and `POST /claims/redeem`; the service never re-issues
it.

## Webhooks

Event names and payload shapes are catalogued in
[`webhook-events.md`](./webhook-events.md). Signature verification is covered
in [`webhook-verification.md`](./webhook-verification.md).

### `GET /webhooks`

List **active** webhook subscriptions. Soft-deleted and paused subscriptions
are excluded.

| Query param | Default | Notes           |
| ----------- | ------- | --------------- |
| `limit`     | `50`    | Max `100`       |
| `offset`    | `0`     | Records to skip |

**Response `200`**

```json
{
  "webhooks": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "url": "https://api.example.com/hooks",
      "events": ["account.created", "sweep.completed"],
      "isActive": true,
      "description": "Payroll completion hook",
      "lastTriggeredAt": "2026-02-26T10:31:00.000Z",
      "createdAt": "2026-02-26T10:00:00.000Z"
    }
  ],
  "total": 1
}
```

`total` is the count of active subscriptions before pagination.

### `POST /webhooks`

Register a subscription.

**Request**

```json
{
  "url": "https://api.example.com/hooks",
  "events": ["account.created", "sweep.completed"],
  "secret": "my-webhook-secret",
  "description": "Payroll completion hook"
}
```

| Field         | Required | Notes                                                                      |
| ------------- | -------- | -------------------------------------------------------------------------- |
| `url`         | Yes      | Must be `https` and pass SSRF checks (no loopback/private hosts).          |
| `events`      | Yes      | See the [event catalogue](./webhook-events.md).                            |
| `secret`      | No       | ≥ 16 chars, `[A-Za-z0-9_-]` only. See [Webhook secrets](#webhook-secrets). |
| `description` | No       | Free text.                                                                 |

**Response `201`** — `WebhookResponseDto` (never includes `secret`)

**Errors:** `400` invalid input / unsafe URL · `401` · `429`

### `PUT /webhooks/:id`

Update a subscription. Every field is optional; omitted fields are left
unchanged.

**Request** — any subset of:

```json
{
  "url": "https://api.example.com/hooks-v2",
  "events": ["account.created"],
  "description": "Updated description",
  "isActive": false,
  "secret": "a-new-signing-secret-32chars"
}
```

`isActive` toggles delivery without deleting the subscription — use it to
temporarily pause a webhook. `secret` rotates the signing key immediately;
there is no grace period during which both old and new secrets are accepted,
so update your verifier in the same deploy.

**Response `200`** — `WebhookResponseDto`

**Errors:** `400` · `401` · `404` unknown id

### `DELETE /webhooks/:id`

This is a **soft delete**, not a hard delete. The handler sets the
webhook's `isActive` column to `false` and saves the row — it does not
remove it from the `webhooks` table (see
`WebhooksService.remove()` in `src/modules/webhooks/webhooks.service.ts`).

> Verified for #843: `WebhooksController.remove()` calls
> `WebhooksService.remove()`, which performs the `isActive = false` update
> documented above — confirming the endpoint deactivates rather than
> hard-deleting the row.

Consequences:

- The row (and its `id`) continue to exist and keep any foreign-key
  relationships, so existing `webhook_deliveries` history for it is
  preserved.
- `GET /webhooks` (`findAll()`) only returns webhooks where
  `isActive: true`, so a deleted webhook disappears from listings even
  though its row still exists.
- Deactivated webhooks stop receiving new deliveries, since
  `triggerEvent()` only queries webhooks with `isActive = true`.
- To bring a deleted webhook back, `PUT /webhooks/:id` with
  `{ "isActive": true }`.
- There is currently no endpoint to hard-delete a webhook row or purge
  its delivery history.

**Response `200`** (empty body)

**Errors:** `401` · `404` unknown id

### Webhook secrets

`secret` is used to compute the `X-Bridgelet-Signature` HMAC on outbound
deliveries. It is **write-only**:

- it is accepted on create and on update;
- it is never present in any `WebhookResponseDto`, so it cannot be read back
  through `GET`/`POST`/`PUT`;
- if you lose it, rotate it with `PUT /webhooks/:id` — there is no way to
  recover the current value.

If no secret is set, deliveries are still sent but signed with an empty key.
Treat those as unverifiable; always set a secret.

See [`webhook-verification.md`](./webhook-verification.md) for a worked
verification example.

## Health

`GET /health` — unauthenticated liveness/readiness probe. `200` when the
service is up.

## Rate limits

All routes sit behind a global throttler (`API_RATE_LIMIT`, default
`100` requests / 60s). Two claim routes carry **explicitly tighter,
route-level limits** because they accept raw bearer tokens and one of them
moves funds:

| Route                 | Limit            | Window | Rationale                        |
| --------------------- | ---------------- | ------ | -------------------------------- |
| `POST /claims/verify` | 10               | 60s    | Probe/endpoint-enumeration guard |
| `POST /claims/redeem` | 5                | 60s    | Bearer-secret brute-force guard  |
| everything else       | `API_RATE_LIMIT` | 60s    | App-wide default                 |

Exceeding a limit returns `429`. The redeem limit is the important one: a claim
token is a bearer secret, so an attacker who can guess or replay tokens has a
direct path to on-chain funds. Clients should treat `429` as retryable with
backoff, and should not retry a redemption more than a handful of times.

## Errors

Errors use the standard Nest shape:

```json
{
  "statusCode": 400,
  "message": "destinationAddress must be a valid Stellar address (starts with G and is 56 characters long)",
  "error": "Bad Request"
}
```

`message` may be an array of strings when multiple validation constraints fail
on the same field. Every request is assigned an `X-Request-Id` (also echoed in
the response body by the request-id middleware), which is the identifier to
quote when reporting a problem.

## Implementation notes

- **Metadata bounds (#762):** `CreateAccountDto.metadata` is checked by `@IsObject()` and `@IsBoundedMetadata()` (size/depth limits) during DTO validation, before `sanitizeMetadata()` runs.
- **Sweep webhooks (#763):** `ClaimRedemptionProvider` fires `sweep.completed` or `sweep.failed` exactly once per redemption outcome, never both; asserted in `claim-redemption.provider.spec.ts`.
- **KMS data key persistence (#832):** the encrypted data key is persisted (`KMS_ENCRYPTED_DATA_KEY` / `KMS_DATA_KEY_PATH`) and not regenerated on restart; see `SECURITY.md`.
- **Key rotation (#833):** `aes256gcm:v2:<keyId>:...` ciphertext with a previous-key decrypt path is implemented in `SecretEncryptionUtil` / `secret-rotation.util.ts`.
