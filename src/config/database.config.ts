import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { dirname } from 'path';
import { DataSource } from 'typeorm';
import { fileURLToPath } from 'url';
import 'dotenv/config';

/**
 * Connection pool rationale (issue #516, re-confirmed #880 — see the
 * load-testing section of README.md for the 50-concurrent-request relationship)
 * ───────────────────────────────────────
 * • max: 10 – Caps each NestJS instance to 10 connections. This leaves room
 *             for other services sharing the same PostgreSQL server. See
 *             docs/deployment.md for sizing guidance against expected
 *             concurrent load and multiple app instances.
 * • min: 2  – node-postgres's `min` does NOT eagerly open connections at
 *             startup; it only stops the pool closing idle connections below
 *             this floor once they exist (see `_isAboveMin` in pg-pool). It
 *             does not remove first-request connection latency on its own.
 * • connectionTimeoutMillis: 3000 – This is the real node-postgres option
 *             (previously misspelled here as `acquireTimeoutMillis`, which
 *             pg-pool silently ignores as an unknown key). It governs BOTH
 *             the time allowed to establish a brand-new physical connection
 *             AND, critically, how long a caller queues for an already-open
 *             connection when the pool is fully saturated. Without it set,
 *             pool exhaustion queued callers indefinitely with no error – a
 *             silent hang rather than clear backpressure. With it set, a
 *             caller that can't get a connection within 3s now fails fast
 *             with "timeout exceeded when trying to connect".
 *
 * The `extra` key is passed verbatim to the underlying `pg` Pool constructor,
 * which is how TypeORM exposes driver-specific pool configuration for Postgres.
 */
const POOL_CONFIG = {
  min: 2,
  max: 10,
  connectionTimeoutMillis: 3000,
} as const;

export default registerAs(
  'database',
  (): { database: TypeOrmModuleOptions } => ({
    database: {
      type: 'postgres',
      host: process.env.DATABASE_HOST || 'localhost',
      port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
      username: process.env.DATABASE_USER || 'bridgelet_user',
      password: process.env.DATABASE_PASSWORD || 'bridgelet_pass',
      database: process.env.DATABASE_NAME || 'bridgelet',
      entities: [__dirname + '/../**/*.entity{.ts,.js}'],
      migrations: [__dirname + '/../database/migrations/*{.ts,.js}'],
      // synchronize: isSynchronizeAllowed(),
      // use the util later before production
      synchronize: true,
      autoLoadEntities: true,
      logging: process.env.DATABASE_LOGGING === 'true',
      // ssl:
      //   process.env.DATABASE_SSL === 'true'
      //     ? { rejectUnauthorized: false }
      //     : false,
      // Connection pool (see rationale above)
      poolSize: POOL_CONFIG.max,
      extra: POOL_CONFIG,
    },
  }),
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST || 'localhost',
  port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  username: process.env.DATABASE_USER || 'bridgelet_user',
  password: process.env.DATABASE_PASSWORD || 'bridgelet_pass',
  database: process.env.DATABASE_NAME || 'bridgelet',
  entities: [__dirname + '/../**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/../database/migrations/*{.ts,.js}'],
  // #726: migration-driven; never auto-sync the schema.
  synchronize: false,
  // Connection pool settings (see rationale above)
  poolSize: POOL_CONFIG.max,
  extra: POOL_CONFIG,
});
