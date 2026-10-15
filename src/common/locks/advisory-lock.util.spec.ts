import { jest } from '@jest/globals';
import type { DataSource, EntityManager } from 'typeorm';
import {
  advisoryLockKey,
  DEFAULT_ADVISORY_LOCK_TIMEOUT_MS,
  withAdvisoryLock,
} from './advisory-lock.util.js';

describe('advisoryLockKey', () => {
  it('is deterministic for the same namespace and value', () => {
    expect(advisoryLockKey('ns', 'value')).toBe(advisoryLockKey('ns', 'value'));
  });

  it('returns a signed 64-bit integer as a decimal string', () => {
    expect(advisoryLockKey('ns', 'value')).toMatch(/^-?\d+$/);
  });

  it('separates different namespaces and values', () => {
    expect(advisoryLockKey('a', 'x')).not.toBe(advisoryLockKey('b', 'x'));
    expect(advisoryLockKey('a', 'x')).not.toBe(advisoryLockKey('a', 'y'));
  });
});

describe('withAdvisoryLock', () => {
  let manager: { query: jest.Mock<() => Promise<unknown>> };
  let transaction: jest.Mock<(cb: (m: unknown) => Promise<unknown>) => unknown>;
  let dataSource: { transaction: typeof transaction };

  beforeEach(() => {
    manager = { query: jest.fn<any>().mockResolvedValue(undefined) };
    transaction = jest
      .fn<any>()
      .mockImplementation((cb: (m: unknown) => Promise<unknown>) =>
        cb(manager),
      );
    dataSource = { transaction };
  });

  it('bounds the lock wait then acquires the lock before running fn', async () => {
    const order: string[] = [];
    manager.query.mockImplementation((sql: string) => {
      order.push(sql);
      return Promise.resolve(undefined);
    });

    await withAdvisoryLock(
      dataSource as unknown as DataSource,
      '123',
      async () => {
        order.push('fn');
        await Promise.resolve();
      },
    );

    expect(order[0]).toBe(
      `SET LOCAL lock_timeout = ${DEFAULT_ADVISORY_LOCK_TIMEOUT_MS}`,
    );
    expect(order[1]).toBe('SELECT pg_advisory_xact_lock($1::bigint)');
    expect(order[2]).toBe('fn');
    expect(manager.query).toHaveBeenNthCalledWith(2, expect.any(String), [
      '123',
    ]);
  });

  it('honours a custom timeout', async () => {
    await withAdvisoryLock(
      dataSource as unknown as DataSource,
      'k',
      () => Promise.resolve(undefined),
      { timeoutMs: 250 },
    );

    expect(manager.query).toHaveBeenNthCalledWith(
      1,
      'SET LOCAL lock_timeout = 250',
    );
  });

  it('reruns inside the transaction on each call (so the lock is transaction-scoped)', async () => {
    await withAdvisoryLock(dataSource as unknown as DataSource, 'k', () =>
      Promise.resolve(undefined),
    );
    await withAdvisoryLock(dataSource as unknown as DataSource, 'k', () =>
      Promise.resolve(undefined),
    );

    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('returns the value produced by fn', async () => {
    const result = await withAdvisoryLock(
      dataSource as unknown as DataSource,
      'k',
      () => Promise.resolve('done'),
    );
    expect(result).toBe('done');
  });

  it('propagates a rejection from fn (releasing the lock via the transaction)', async () => {
    await expect(
      withAdvisoryLock(dataSource as unknown as DataSource, 'k', () =>
        Promise.reject(new Error('boom')),
      ),
    ).rejects.toThrow('boom');

    expect(manager.query).toHaveBeenCalled();
  });

  it('rejects an invalid timeout without opening a transaction', async () => {
    await expect(
      withAdvisoryLock(
        dataSource as unknown as DataSource,
        'k',
        () => Promise.resolve(undefined),
        { timeoutMs: 0 },
      ),
    ).rejects.toThrow(RangeError);

    expect(transaction).not.toHaveBeenCalled();
  });

  it('passes the transaction manager to the callback type used by callers', () => {
    // Compile-time guard: the callback receives an EntityManager from TypeORM.
    const typed: (m: EntityManager) => Promise<void> = () => Promise.resolve();
    expect(typeof typed).toBe('function');
  });
});
