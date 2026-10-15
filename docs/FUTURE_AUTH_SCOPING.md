# Future Feature: Per-Integrator Auth Scoping

> **Placement (issue #697):** this is forward-looking architecture, not
> module-local documentation, so it lives here in `docs/` rather than inside
> `src/modules/accounts/`. Track implementation of the design below as its
> own issue when work on it starts.

**Status:** Partially implemented (issue #825). `JwtAuthGuard` now reads two
optional claims:

- `scope`: `"admin"` or `"sender"`. **A token with no `scope` claim is treated
  as admin**, so existing single-caller deployments are unaffected.
- `senderAddress`: the wallet address a `sender`-scoped token is scoped to
  (required when `scope` is `"sender"`; the guard rejects a sender token that
  omits it).

For a `sender`-scoped token, `GET /accounts` and `GET /accounts/:id` only
return accounts whose `senderAddress` matches the token, and `POST /accounts`
stamps new accounts with it. An admin token keeps the previous unscoped
behaviour. The model chosen was **Option A - scoped JWTs** (below), rather
than the DB-backed API keys of Option B, because it reuses the existing
`JwtAuthGuard` and needs no new credential storage; tokens are still minted
out-of-band.

What is still **not** implemented: an admin-only endpoint/CLI to mint these
scoped tokens, per-integrator revocation for JWT-scoped callers, and scoped
permissions beyond "own accounts only". See [Remaining work](#remaining-work).

## The gap

`JwtAuthGuard` (`src/common/guards/jwt-auth.guard.ts`) does this and nothing more:

```ts
await this.jwtService.verifyAsync(token);
```

No claim is inspected. No `sub`, no scope, no integrator identity. Two tokens
signed with the same `JWT_SECRET` are functionally identical, regardless of
payload.

## Two options

### Option A - Scoped JWTs (claims-based)

Add an `integratorId` (or `sub`) claim when minting a token, and have the
guard extract + attach it to the request. Services filter queries by it.

**Pros:** stays JWT-based, no new storage for the credential itself, easy to
add short expiry/rotation later.
**Cons:** still need _somewhere_ to mint these - either an admin-only
endpoint, or continue doing it out-of-band (script/CLI) per integrator.

### Option B - Per-integrator API keys (recommended for this app's shape)

Store a hashed API key per integrator in the DB; a new guard looks up the
key, attaches `integratorId` to the request.

**Pros:** simpler mental model for B2B server-to-server callers (this API has
no human end-users on the create-account side), trivial per-key revocation
(delete/disable the row), no token expiry/refresh machinery needed.
**Cons:** one more table, one more guard.

**Recommendation: Option B.** This API's `/accounts` side is integrator-to-
service, not human-to-service - API keys are the more natural fit than a
JWT/login flow, and revocation is simpler (delete a row vs. rotate a shared
secret for everyone).

## Minimal sketch (Option B)

**New table:**

```sql
CREATE TABLE integrators (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,   -- store a hash (e.g. sha256), never the raw key
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at  TIMESTAMPTZ            -- null = active; set to revoke instantly
);
```

**New guard**, alongside the existing `JwtAuthGuard`:

```ts
// api-key-auth.guard.ts - reads X-API-Key header, hashes it, looks up
// integrators row, rejects if missing/disabled, attaches integratorId to
// the request for downstream services to filter by.
```

**Touch points once this exists:**

- `AccountsController` - swap `JwtAuthGuard` for the new guard (or support both, if internal admin tooling should stay on JWT).
- `AccountsService.findAll` / `create` - add `WHERE integrator_id = :integratorId` filtering, and stamp new accounts with the caller's `integratorId`.
- Admin-only bootstrap: a one-off script or protected endpoint to create the first `integrators` row and hand out the raw key exactly once (never retrievable again - only the hash is stored).

## Not in scope for the minimal version

- Per-integrator rate limiting (would layer on top of the existing `ThrottlerGuard`)
- Key rotation UI/endpoint (manual DB update is fine to start)
- Scoped permissions beyond "own accounts only" (e.g. read-only keys)

## Remaining work

- **Token minting.** Nothing in this repo mints scoped JWTs yet; they are
  issued out-of-band with the same `JWT_SECRET` as API tokens. A protected
  admin endpoint or CLI for minting (`scope`, `senderAddress`, expiry) is the
  natural follow-up.
- **Revocation.** A scoped JWT cannot be revoked before it expires the way an
  API-key row can (Option B), so keep expiries short if revocation matters.
- **Senders created via `metadata`.** `senderAddress` is a first-class column
  now; any integration that was smuggling the wallet address into `metadata`
  should migrate to the column.

## Status and tracking (#758)

This document lives in `docs/` because it is forward-looking architecture, not
module-local documentation. The accounts-module copy was moved here. Per-sender
scoping is partly in place: `JwtAuthGuard` already honours `scope: 'sender'`
tokens (see `jwt-auth.guard.ts`); broader per-integrator scoping remains planned.
