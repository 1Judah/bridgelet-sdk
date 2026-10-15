# Deployment

## `EPHEMERAL_ACCOUNT_WASM_HASH` (issue #811)

Each `POST /accounts` deploys its **own** `EphemeralAccount` contract instance
and initializes that instance. `EphemeralAccount` in bridgelet-core holds all of
an account's on-chain state (status, expiry ledger, recorded payments,
`swept_to`) and its `initialize()` returns `Error::AlreadyInitialized`
(`Error(Contract, #1)`) on any second call — so a single shared contract ID
allowed exactly one account per deployment.

- `EPHEMERAL_ACCOUNT_WASM_HASH` is the 64-hex-char WASM hash of the uploaded
  ephemeral-account contract. It is required outside tests and validated by
  `validateEnv()` in `src/config/env-validation.ts`, which reports
  `EPHEMERAL_ACCOUNT_WASM_HASH is missing` or
  `EPHEMERAL_ACCOUNT_WASM_HASH must be a 64-character hex string`. A hash that
  is not uploaded on the target network makes the deploy transaction fail, and
  the account is marked `FAILED` rather than handed to the caller.
- On testnet the value is `ephemeralAccountWasmHash` in
  `bridgelet-core/deployments/testnet.json`. On mainnet, take it from the
  `stellar contract upload` output for the mainnet build.
- `stellar.contracts.ephemeralAccount` (`EPHEMERAL_ACCOUNT_CONTRACT_ID`) is still
  required by the payment monitor, sweeps and `ContractProvider`, but account
  creation never initializes it.
- Deploys are salted with 32 random bytes, so retrying an account creation
  cannot collide with an earlier deployment.
- Redeploy the contract and bump this value (and
  `EPHEMERAL_ACCOUNT_CONTRACT_VERSION`) whenever a new ephemeral-account WASM is
  uploaded; instances deployed from an older hash keep running against the
  older code.
- Each new account costs one extra deploy transaction (rent + fees) on top of
  the existing `createAccount` and `initialize` transactions. Size the funding
  account accordingly.

## Sweep signer selection (issue #823)

Sweep authorization signatures are produced by a `SweepSigner`
(`src/common/crypto/sweep-signer.ts`) selected once at startup in
`ContractProvider.onModuleInit()`. The signed message format is the same for
every signer (the SHA256 digest pinned by the bridgelet-core conformance
vectors); only who holds the private key differs.

- `STELLAR_SWEEP_SIGNER_PROVIDER=env-seed` (default): signs with
  `SWEEP_SIGNING_KEY_SEED`. **Development and testnet only** —
  `SweepSigningGuard` refuses to sign with it when `NODE_ENV=production`, and
  both `validateEnv()` and `onModuleInit()` refuse to start with it in
  production. There is no fallback from the production signer to the seed.
- `STELLAR_SWEEP_SIGNER_PROVIDER=kms`: signs with an asymmetric Ed25519 AWS
  KMS key (`STELLAR_SWEEP_KMS_KEY_ID`). Create the key with
  `KeySpec=ECC_NIST_EDWARDS25519` and `KeyUsage=SIGN_VERIFY`, and grant the
  app `kms:Sign` and `kms:GetPublicKey` on it. The app's IAM principal also
  needs those permissions for the claim-secret KMS key if `KMS_ENABLED=true`.
- `STELLAR_SWEEP_AUTHORIZED_SIGNER` (optional but recommended): the G...
  public key the SweepController was initialized with as `authorized_signer`.
  Startup fails with a clear error when the selected signer's public key does
  not match, because a mismatch rejects every sweep on-chain and is otherwise
  easy to miss. Derive the value with the one-liner in `.env.example`, or
  from the core tooling:
  `./target/release/sweep-signer pubkey --signer-seed-hex <64-hex seed>`.
  For a KMS key the SDK reads the public key from KMS itself, so the same
  check needs no operator input.

Follow-up (not in this change): read `authorized_signer` directly from the
deployed SweepController's storage at startup, instead of relying on the
configured value.

## Database connection pool (issue #516)

Pool settings live in two places that must be kept in sync:

- `src/config/database.config.ts` (`POOL_CONFIG`) – used by the running
  NestJS app via `TypeOrmModule.forRootAsync`.
- `src/config/typeorm.config.ts` – used by the TypeORM CLI
  (`migration:run`, `migration:revert`, `migration:generate`).

Both currently set:

```ts
{
  min: 2,
  max: 10,
  connectionTimeoutMillis: 3000,
}
```

### What each option actually does

This repo previously used `acquireTimeoutMillis` instead of
`connectionTimeoutMillis`. `pg-pool` does not recognize
`acquireTimeoutMillis` as an option and silently ignores it, so the
intended fail-fast behavior was never in effect. Concretely:

- **`max`** is the only hard cap. It limits how many physical
  connections one app instance opens to Postgres.
- **`min`** does _not_ eagerly open connections at startup. In
  `pg-pool`, `min` only stops the pool from closing idle connections
  below that floor once they already exist (see `_isAboveMin` in
  `pg-pool/index.js`). It has no effect on cold-start latency.
- **`connectionTimeoutMillis`** is the real option name. It governs
  two things at once: how long a brand-new physical connection attempt
  may take, and — this is the part that matters for pool exhaustion —
  how long a caller queues waiting for an already-open connection once
  the pool is fully saturated (`_isFull()` in `pg-pool`). If this is
  unset (as it effectively was, since `acquireTimeoutMillis` was
  ignored), a caller that arrives when all `max` connections are busy
  queues **indefinitely** with no error: a silent hang, not
  backpressure. With it set to `3000`, that caller now fails after 3s
  with `timeout exceeded when trying to connect`, which NestJS
  surfaces as a request-level error instead of a hung connection.

### Sizing `max` against expected concurrency

This repo does not currently have a load-testing script or a
documented concurrency figure checked in (issue #516 assumed a
"50 concurrent requests" load test existed; as of this audit it does
not — see the PR for this issue). Until one exists, size `max`
using this reasoning instead of a specific benchmark:

1. **Pool size is not request concurrency.** A request only holds a
   connection for the duration of its DB work, not its full
   lifetime. If the average DB-bound portion of a request is short
   (a few ms to tens of ms), a pool much smaller than the peak
   concurrent HTTP request count can still serve it, as long as
   requests queue briefly rather than reject outright.
2. **Watch for connection-holding operations.** `ClaimRedemptionProvider.redeemClaim`
   opens a `dataSource.transaction(...)` with a `pessimistic_write`
   lock while it validates and transitions account state — this holds
   one pool connection for longer than a typical read, and multiple
   concurrent redemptions against _different_ accounts will each hold
   a connection concurrently (they don't block each other; they're
   different rows). Size `max` with headroom for the expected number
   of concurrent in-flight redemptions/sweeps, not just steady-state
   reads.
3. **Multiply by instance count, not just per-instance `max`.**
   `max: 10` is _per NestJS instance_. If you run N instances behind a
   load balancer, total connections to Postgres are `N * max` (plus
   any CLI/migration connections). Check that against Postgres's own
   `max_connections` (`SHOW max_connections;`) with headroom for
   other services and superuser/admin connections.
4. **Recommended starting point for production:** `max: 10` per
   instance is reasonable for a small number of instances (2-4)
   against a standard managed Postgres tier. If you scale out app
   instances, either lower `max` per instance proportionally or put a
   connection pooler (e.g. PgBouncer in transaction mode) in front of
   Postgres so instance count doesn't multiply raw connections
   linearly.
5. **Before raising `max` in response to timeouts,** check whether
   the real cause is connection-holding queries/transactions running
   long, not too few connections — a bigger pool just delays hitting
   the same ceiling if a query is the actual bottleneck.

When a real load-testing setup is added, replace this section with
the measured concurrency figure and the `max` value it justifies.

## Deploying on Render (issue #824)

This is the shortest path to a running testnet deployment. It assumes a
Render account and a Stellar funding account.

### 1. Create a managed Postgres instance

1. Render dashboard -> **New +** -> **Postgres**.
2. Pick a region/plan and create it. Note the **Internal Database URL** for
   services in the same region (or the **External** one for one-off jobs run
   from your machine, e.g. the first `npm run migration:run`).
3. From the connection details, set `DATABASE_HOST`, `DATABASE_PORT`,
   `DATABASE_NAME`, `DATABASE_USER` and `DATABASE_PASSWORD` on the web service
   below. `DATABASE_SYNC` must stay `false` outside `NODE_ENV=test`; run
   migrations explicitly instead.

### 2. Create the web service

1. Render dashboard -> **New +** -> **Web Service**, connect this repository.
2. Settings:
   - **Environment:** Node
   - **Build Command:** `npm ci && npm run build`
   - **Start Command:** `npm run migration:run && npm run start:prod`
   - **Health Check Path:** `/health`
3. Add the environment variables from the table below. Render applies them and
   the app validates them at startup: `validateEnv()` (`src/config/env-validation.ts`)
   runs before the Nest app is created, so a bad configuration exits
   immediately with a single error listing every problem rather than failing
   later inside a request handler.

### 3. Environment variables

| Variable                                                                                    | Required       | Notes                                                                                                                                 |
| ------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                                  | yes            | `production` for a real deployment, `development` for a testnet demo (see below).                                                     |
| `PORT`                                                                                      | no             | Render injects this; the app reads it.                                                                                                |
| `DATABASE_HOST` / `DATABASE_PORT` / `DATABASE_NAME` / `DATABASE_USER` / `DATABASE_PASSWORD` | yes            | From the Postgres instance.                                                                                                           |
| `DATABASE_SYNC`                                                                             | yes            | Must be `false` outside tests.                                                                                                        |
| `STELLAR_NETWORK`                                                                           | yes            | `testnet` or `mainnet`.                                                                                                               |
| `STELLAR_HORIZON_URL`                                                                       | yes            | e.g. `https://horizon-testnet.stellar.org`.                                                                                           |
| `STELLAR_SOROBAN_RPC_URL`                                                                   | yes            | e.g. `https://soroban-testnet.stellar.org`.                                                                                           |
| `JWT_SECRET`                                                                                | yes            | Long random string.                                                                                                                   |
| `ENCRYPTION_KEY`                                                                            | yes            | 64 hex chars.                                                                                                                         |
| `SWEEP_CONTROLLER_CONTRACT_ID`                                                              | yes (non-test) | Controller that authorizes sweeps. Redeploying it produces a **new ID** that only applies to accounts created afterwards (see below). |
| `EPHEMERAL_ACCOUNT_WASM_HASH`                                                               | yes (non-test) | 64 hex chars; from `bridgelet-core/deployments/testnet.json`.                                                                         |
| `CLAIM_BASE_URL`                                                                            | yes (non-test) | Public base URL for claim links, a valid `http`/`https` URL **without a trailing slash**.                                             |
| `CORS_ORIGINS`                                                                              | production     | Comma-separated allowed origins. **`*` is rejected when `NODE_ENV=production`.**                                                      |
| `FUNDING_ACCOUNT_SECRET`                                                                    | yes            | Stellar secret funding account creation.                                                                                              |
| `SWEEP_SIGNING_KEY_SEED`                                                                    | testnet demo   | 64-hex Ed25519 seed. See the sweep-signer notes below.                                                                                |

### 4. `NODE_ENV`: testnet demo vs production

- **Testnet demo:** `NODE_ENV=development`. `CORS_ORIGINS` may be `*`, which
  makes it easy to poke the API from a browser during a demo. `CLAIM_BASE_URL`,
  `SWEEP_CONTROLLER_CONTRACT_ID` and `EPHEMERAL_ACCOUNT_WASM_HASH` are still
  required (they are required for everything except `NODE_ENV=test`).
- **Production:** `NODE_ENV=production`. `CORS_ORIGINS` must list explicit
  origins (a wildcard is rejected at startup because the app sends
  credentials), and the production sweep-signing path must be configured.

> **Production sweep signing is gated.** As of this writing the app refuses to
> sign sweeps with a raw env seed when `NODE_ENV=production`; see the sweep
> signer work tracked in the "production sweep signer" pull request. Until a
> production signer is configured, a `NODE_ENV=production` deployment will not
> sweep. Use `NODE_ENV=development` for testnet demos.

### 5. Redeploying `SWEEP_CONTROLLER_CONTRACT_ID`

Each ephemeral account is initialized with the controller ID **in effect when
the account was created** and stores it on-chain as `authorized_controller`.
Changing `SWEEP_CONTROLLER_CONTRACT_ID` (e.g. after redeploying
`SweepController`) therefore points only **new** accounts at the new
controller; existing accounts keep sweeping through the controller they were
created under. If you need to move old accounts, recreate them.
