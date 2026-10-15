import { createHash } from 'node:crypto';
import type { DataSource } from 'typeorm';

/**
 * How long a caller waits for a Postgres advisory lock before giving up. A
 * holder that crashed (or a network call that hangs) cannot pin the lock
 * forever: the lock lives inside a transaction, so when the holder's
 * connection drops Postgres aborts the transaction and releases it; the
 * timeout here bounds the *wait* for an otherwise healthy holder.
 */
export const DEFAULT_ADVISORY_LOCK_TIMEOUT_MS = 10_000;

/**
 * Derive a stable, process-independent 64-bit advisory-lock key from a
 * namespace and a value (e.g. a contract ID).
 *
 * `pg_advisory_xact_lock` accepts a single `bigint`, so the SHA-256 digest of
 * `namespace:value` is truncated to its first 8 bytes and read as a signed
 * 64-bit integer (the full range Postgres accepts). Hashing keeps the key
 * fixed-length and spreads similar inputs apart; the namespace lets unrelated
 * lock domains share the same value without colliding.
 */
export function advisoryLockKey(namespace: string, value: string): string {
  const digest = createHash('sha256').update(`${namespace}:${value}`).digest();
  return digest.readBigInt64BE(0).toString();
}

export interface AdvisoryLockOptions {
  timeoutMs?: number;
}

/**
 * Run `fn` while holding a Postgres transaction-scoped advisory lock, so
 * callers across every application instance are serialized on the same key.
 *
 * The lock is acquired with `pg_advisory_xact_lock`, which releases
 * automatically when the surrounding transaction commits or rolls back, so it
 * is released on both success and failure without an explicit unlock.
 * `lock_timeout` is set first so a caller never waits indefinitely for a stuck
 * holder. `fn` runs inside the transaction; keep it as short as possible and
 * never include unrelated network I/O that does not need the lock.
 */
export async function withAdvisoryLock<T>(
  dataSource: DataSource,
  lockKey: string,
  fn: () => Promise<T>,
  options: AdvisoryLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ADVISORY_LOCK_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`Invalid advisory lock timeout: ${timeoutMs}`);
  }

  return dataSource.transaction(async (manager) => {
    // `lock_timeout` takes a literal (milliseconds when bare), not a bind
    // parameter; `timeoutMs` is validated as a positive integer above.
    await manager.query(`SET LOCAL lock_timeout = ${timeoutMs}`);
    await manager.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey]);
    return fn();
  });
}
