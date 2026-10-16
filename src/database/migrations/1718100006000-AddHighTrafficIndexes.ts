import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddHighTrafficIndexes1718100006000
 *
 * Index → query map (#878: every index below is annotated with the one query
 * pattern it exists to serve, so a future schema change does not drop an index
 * that is load-bearing for a query nobody remembers.)
 * ─────────────────
 * Every index in this migration exists to serve a named query, and none of
 * those queries is declared in this file. Before dropping or renaming an
 * index below, find its call site first — these are load-bearing for the
 * expiry scheduler and the payment poller even though nothing in the
 * migration itself references them.
 *
 * 1. IDX_accounts_status_expiresAt ("status", "expiresAt")
 *    Serves two queries that scan the same (status, expiresAt) shape in
 *    opposite directions:
 *
 *      • SchedulerService.runExpiryJob()  — rows to expire next tick:
 *          WHERE status IN ('pending_payment','pending_claim')
 *            AND "expiresAt" < NOW()             -- TypeORM LessThan(now)
 *
 *      • PaymentMonitorService.pollAllAccounts()  — live accounts still
 *        eligible for an inbound payment:
 *          WHERE status = 'pending_payment'
 *            AND "expiresAt" > NOW()             -- TypeORM MoreThan(now)
 *        The "> NOW()" half is what keeps the poller from hitting Horizon
 *        for accounts the expiry job is about to expire anyway.
 *
 *    Before this migration both predicates were satisfied by separate
 *    scans of IDX_accounts_status and IDX_accounts_expiresAt plus a
 *    bitmap AND; the composite satisfies both in a single index scan and
 *    eliminates that step on large tables. Column order: status first,
 *    because it is a low-cardinality enum (8 values) that prunes the row
 *    set before the timestamp column filters it further. PostgreSQL can
 *    also use this index as a left-prefix scan for status-only predicates.
 *
 * 2. IDX_accounts_status_createdAt ("status", "createdAt")
 *    Serves SchedulerService.runInitializingCleanup() — INITIALIZING
 *    accounts stuck past `app.initializingTimeoutMs`, marked FAILED:
 *          WHERE status = 'initializing'
 *            AND "createdAt" < <cutoff>          -- TypeORM LessThan(cutoff)
 *    No composite index existed before this migration. Without it,
 *    PostgreSQL fetched every INITIALIZING row and then filtered by
 *    createdAt, which degrades as the table grows. Same column-order
 *    rationale as (1).
 *
 * 3. IDX_accounts_createdAt ("createdAt")
 *    Range scans on createdAt with no status predicate (audit and
 *    time-boxed reporting). No production caller today: both jobs above
 *    carry a status predicate and use their composites instead. This is
 *    the least load-bearing of the three — dropping it costs reporting
 *    queries only, not a hot path. Its overhead (~20 % larger write cost
 *    on accounts) is acceptable given the low insert rate.
 *
 * Queries deliberately NOT served by this migration
 * ─────────────────────────────────────────────────
 * • AccountsService.findAll() — `deletedAt IS NULL` plus an optional
 *   `status = :status` predicate. Those are covered by IDX_accounts_deletedAt
 *   (1718100008000-AddDeletedAtToAccountsTable) and the single-column
 *   IDX_accounts_status (1718100000000-CreateAccountsTable); no new index
 *   is required here.
 * • FK lookup (claims JOIN accounts ON "accountId") — covered by
 *   IDX_claims_accountId from 1718100001000-CreateClaimsTable.
 *
 * All indexes use the default B-tree access method, which PostgreSQL can
 * use for equality, range (<, >), and ORDER BY optimisation.
 *
 * Keep in sync when an index here changes
 * ───────────────────────────────────────
 * • Account entity @Index decorators
 *   (src/modules/accounts/entities/account.entity.ts)
 * • docs/database-schema.md → "Database Indexes → accounts"
 * • scripts/generate-migrations.sh (source of truth for this folder)
 */
export class AddHighTrafficIndexes1718100006000 implements MigrationInterface {
  name = 'AddHighTrafficIndexes1718100006000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // IDX_accounts_status_expiresAt — expiry scheduler and payment poller.
    // Both scan ("status", "expiresAt"); see the header for the call sites:
    //   SchedulerService.runExpiryJob()          status IN (...) AND "expiresAt" < NOW()
    //   PaymentMonitorService.pollAllAccounts()  status = 'pending_payment' AND "expiresAt" > NOW()
    await queryRunner.query(`
      CREATE INDEX "IDX_accounts_status_expiresAt"
        ON "accounts" ("status", "expiresAt")
    `);

    // IDX_accounts_status_createdAt — INITIALIZING cleanup:
    //   SchedulerService.runInitializingCleanup()
    //     WHERE status = 'initializing' AND "createdAt" < <cutoff>
    await queryRunner.query(`
      CREATE INDEX "IDX_accounts_status_createdAt"
        ON "accounts" ("status", "createdAt")
    `);

    // IDX_accounts_createdAt — no production caller today; createdAt range
    // scans for audit / time-boxed reporting. Least load-bearing of the three:
    // both jobs above carry a status predicate and use their composites.
    await queryRunner.query(`
      CREATE INDEX "IDX_accounts_createdAt"
        ON "accounts" ("createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_accounts_status_expiresAt"`);
    await queryRunner.query(`DROP INDEX "IDX_accounts_status_createdAt"`);
    await queryRunner.query(`DROP INDEX "IDX_accounts_createdAt"`);
  }
}
