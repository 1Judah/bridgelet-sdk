import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddSenderAddressToAccountsTable1718100010000 (#825)
 *
 * Adds the nullable `senderAddress` column used to scope account reads to the
 * wallet that created them.
 *
 * Locking notes
 * ─────────────
 * - `ADD COLUMN ... NULL` without a default is a metadata-only change on
 *   PostgreSQL 11+ (no table rewrite), so it takes only a brief
 *   ACCESS EXCLUSIVE lock.
 * - The index is built with `CREATE INDEX CONCURRENTLY` so it does not block
 *   writes to `accounts` while it runs on a large table. CONCURRENTLY cannot
 *   run inside a transaction, so this migration opts out of the per-migration
 *   transaction (`transaction = false`), which the TypeORM runner honours for
 *   `runMigrations()` but the revert path does not.
 * - `down()` therefore drops the index with a plain `DROP INDEX`, which works
 *   both inside and outside a transaction, keeping the migration reversible
 *   under `migrationsTransactionMode: 'each'`.
 */
export class AddSenderAddressToAccountsTable1718100010000
  implements MigrationInterface
{
  name = 'AddSenderAddressToAccountsTable1718100010000';

  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "accounts"
        ADD COLUMN "senderAddress" varchar(56) NULL
    `);

    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY "IDX_accounts_senderAddress"
        ON "accounts" ("senderAddress")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_accounts_senderAddress"
    `);

    await queryRunner.query(`
      ALTER TABLE "accounts"
        DROP COLUMN "senderAddress"
    `);
  }
}
