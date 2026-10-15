# Sweep nonce serialization (#826)

The `SweepController` contract keeps a **single global nonce** that is
incremented after every successful sweep. `SweepsService.executeSweep` reads
that nonce (`StellarService.getSweepNonce`), signs it, and submits
`execute_sweep`. If two claims run at the same time, both can read the same
value: the first succeeds and increments the counter, and the second is
rejected on-chain with `InvalidNonce` (error code 11) and reverts to
`PENDING_CLAIM`.

The existing row lock in `ClaimRedemptionProvider` only protects a single
account. It does not protect the shared counter, so it cannot prevent this.

## Approach

Read-nonce → sign → submit runs while holding a Postgres **transaction-scoped
advisory lock** keyed on the controller ID:

```
SELECT pg_advisory_xact_lock(<key derived from the SweepController contract ID>)
```

- The key is a signed 64-bit integer derived from `sha256('sweep-controller-nonce:' + controllerId)`
  (first 8 bytes, big-endian). See `src/common/locks/advisory-lock.util.ts`.
- `pg_advisory_xact_lock` releases automatically when the surrounding
  transaction commits **or rolls back**, so the lock is released on success and
  on failure with no explicit unlock and no leak if the process crashes
  (closing the connection aborts the transaction).
- `SET LOCAL lock_timeout` bounds how long a caller waits for the lock, so a
  stuck holder cannot pin a request forever.
- The lock works **across every application instance** because it lives in the
  shared database, not in process memory.

The scope is deliberately minimal: the classic Horizon payout (Step 4) runs
**outside** the lock, and a `skipContractAuth` retry (the `PARTIAL_SWEEP`
recovery path) never touches the contract and therefore never takes the lock.

## Second safety net: retry on `InvalidNonce`

The lock is enough to stop the common race, but the contract is the source of
truth and could still reject a signature as stale (for example if a
non-controller path advances the counter). If `execute_sweep` is rejected with
`InvalidNonce`, `SweepsService` re-reads the nonce, re-signs, and submits
**once more** while still holding the lock.

The nonce error is detected before the generic Soroban-contract-failure
mapping, because that mapping also matches any `Error(Contract, ...)`. A
non-nonce contract failure (e.g. `Error(Auth, InvalidAction)`) is deterministic
and keeps its existing behaviour: it is **not** retried and surfaces as the
stable `SWEEP_CONTRACT_FAILED` (HTTP 502).

## Tests

- `src/modules/sweeps/sweeps.service.spec.ts` — two parallel `executeSweep`
  calls prove the second waits and signs the next nonce; a failing sweep
  releases the lock; `InvalidNonce` retries once; a deterministic failure does
  not retry; the lock is released before the Horizon payout.
- `src/common/locks/advisory-lock.util.spec.ts` — key derivation and lock
  acquisition/ordering.
