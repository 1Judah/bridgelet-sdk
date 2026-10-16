import { DataSource } from 'typeorm';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * DataSource used by the TypeORM CLI (migration:run, migration:revert, …).
 *
 * Pool rationale (issue #516)
 * ────────────────────────────
 * • max: 10 – Caps the per-instance pool to a value that leaves headroom for
 *             other services sharing the same PostgreSQL server. See
 *             docs/deployment.md for how to size this against expected
 *             concurrent load and multiple app instances.
 * • min: 2  – node-postgres's `min` does NOT eagerly open connections at
 *             startup; it only stops the pool from closing idle connections
 *             below this floor once they exist (see `_isAboveMin` in
 *             pg-pool). It does not remove first-request connection latency
 *             on its own.
 * • connectionTimeoutMillis: 3000 – This is the real node-postgres option
 *             (previously misspelled here as `acquireTimeoutMillis`, which
 *             pg-pool silently ignores). It governs BOTH the time allowed to
 *             establish a brand-new physical connection AND, critically,
 *             how long a caller queues for an already-open connection when
 *             the pool is fully saturated. Without it set, pool exhaustion
 *             queues callers indefinitely with no error – a silent hang
 *             rather than clear backpressure. With it set, a caller that
 *             can't get a connection within 3s fails fast with
 *             "timeout exceeded when trying to connect" instead of hanging.
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST || 'localhost',
  port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  username: process.env.DATABASE_USER || 'bridgelet_user',
  password: process.env.DATABASE_PASSWORD || 'bridgelet_pass',
  database: process.env.DATABASE_NAME || 'bridgelet',
  entities: [__dirname + '/../**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/../database/migrations/*{.ts,.js}'],
  migrationsTransactionMode: 'each',
  // #726, re-confirmed for #879: the CLI DataSource is migration-driven, so
  // schema sync is hard-disabled here and `synchronize` can never auto-alter a
  // production schema from the entities.
  synchronize: false,
  poolSize: 10,
  extra: {
    min: 2,
    max: 10,
    connectionTimeoutMillis: 3000,
  },
});
