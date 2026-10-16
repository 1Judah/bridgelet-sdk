# `Account.expiresAt` — scope of responsibility

`expiresAt` (set once on creation from `expiresIn`, see
`AccountsService.create()`) is **DB-side only**. It is never passed to any
Stellar contract call.

## DB-side (uses `expiresAt`)

- `SchedulerService.expireAccounts()` sweeps `PENDING_PAYMENT` /
  `PENDING_CLAIM` rows where `expiresAt < now` and flips their status.
- `TokenVerificationProvider` and the sweep `ValidationProvider` compare
  `new Date() > account.expiresAt` to reject expired claims/sweeps before
  ever reaching the chain.
- Indexed via `IDX_accounts_expiresAt` / `IDX_accounts_status_expiresAt` for
  the scheduler's poll query.
- `PaymentMonitorService.pollAllAccounts()` queries
  `status = PENDING_PAYMENT AND expiresAt > now` (`MoreThan(now)`), so the
  poller never asks Horizon about accounts the expiry job is about to expire
  (#874, re-confirmed — see `1718100006000-AddHighTrafficIndexes`).

## Contract-side (uses `expiresIn`, not `expiresAt`)

`StellarService.createEphemeralAccount()` receives `expiresIn` (a relative
duration in seconds) from `CreateAccountDto`, not the derived `expiresAt`
`Date`. On-chain expiry enforcement (`EphemeralAccount.expire()`, called by
`executeSweep`) relies on the ledger's own expiry state set from that
`expiresIn`, independent of the DB row.

**Net:** the two are set from the same input but tracked separately by
design — `expiresAt` gates API/DB behavior, the contract enforces its own
expiry on-chain. No code change needed; this doc closes the "currently
unused" ambiguity noted in the README (re-verified against issue #696 —
`StellarService` has no `expiresAt`-typed parameter anywhere in its public
API, confirming the split above is still accurate).
