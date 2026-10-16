#!/usr/bin/env bash
#
# generate-migrations.sh
# ------------------------
# Recreates src/database/migrations/ from scratch.
#
# This is the scripted, reproducible replacement for the migration files
# that were previously created by hand. Run it any time the migrations
# folder needs to be rebuilt (e.g. after a fresh clone problem, or to
# confirm the folder on disk matches what this script produces).
#
# What it does:
#   1. Refuses to run outside a git repo / outside the expected project
#      (safety check so it can never be run against the wrong directory).
#   2. Aborts when src/database/migrations/ contains uncommitted changes
#      (modified, staged, or untracked files) unless --force was given,
#      because the rewrite below would permanently discard them (#875).
#   3. Removes the existing src/database/migrations/ directory.
#   4. Recreates it and writes out each migration file verbatim.
#
# Usage:
#   ./scripts/generate-migrations.sh                  # prompts before deleting
#   ./scripts/generate-migrations.sh --yes            # skip the confirmation prompt
#   ./scripts/generate-migrations.sh --yes --force    # skip the prompt AND overwrite
#                                                     # uncommitted changes in the folder
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/src/database/migrations"

if [ ! -f "$REPO_ROOT/package.json" ] || ! grep -q '"bridgelet-sdk"' "$REPO_ROOT/package.json"; then
  echo "error: this does not look like the bridgelet-sdk repo root ($REPO_ROOT)." >&2
  echo "       aborting so nothing gets deleted in the wrong place." >&2
  exit 1
fi

AUTO_YES=false
FORCE_OVERWRITE=false
for arg in "$@"; do
  case "$arg" in
    --yes|-y) AUTO_YES=true ;;
    --force) FORCE_OVERWRITE=true ;;
    *)
      echo "error: unknown argument: $arg" >&2
      echo "       usage: $0 [--yes] [--force]" >&2
      exit 1
      ;;
  esac
done

# Pre-flight: this script deletes and rewrites the entire migrations folder,
# so any hand-edited or never-committed migration file in it would be
# silently destroyed. Refuse to run while git reports uncommitted changes
# in that folder unless --yes is also paired with an explicit --force.
UNCOMMITTED_MIGRATIONS="$(git -C "$REPO_ROOT" status --porcelain -- "$MIGRATIONS_DIR" 2>/dev/null || true)"
if [ -n "$UNCOMMITTED_MIGRATIONS" ] && { [ "$AUTO_YES" != true ] || [ "$FORCE_OVERWRITE" != true ]; }; then
  echo "error: uncommitted changes detected in src/database/migrations/:" >&2
  echo "$UNCOMMITTED_MIGRATIONS" | sed 's/^/    /' >&2
  echo "" >&2
  echo "This script deletes and rewrites the entire migrations folder, so running" >&2
  echo "it now would permanently discard the changes above. Commit or stash them" >&2
  echo "first, or re-run with --yes --force to overwrite them deliberately." >&2
  exit 1
fi
if [ -n "$UNCOMMITTED_MIGRATIONS" ] && [ "$AUTO_YES" = true ] && [ "$FORCE_OVERWRITE" = true ]; then
  echo "warning: --yes --force given; the following uncommitted changes in" >&2
  echo "         src/database/migrations/ will be overwritten:" >&2
  echo "$UNCOMMITTED_MIGRATIONS" | sed 's/^/    /' >&2
fi

if [ -d "$MIGRATIONS_DIR" ] && [ "$AUTO_YES" != true ]; then
  read -r -p "This will delete and recreate $MIGRATIONS_DIR. Continue? [y/N] " reply
  case "$reply" in
    [yY][eE][sS]|[yY]) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

echo "Removing $MIGRATIONS_DIR ..."
rm -rf "$MIGRATIONS_DIR"
mkdir -p "$MIGRATIONS_DIR"

echo "Writing migrations ..."

cat > "$MIGRATIONS_DIR/1718100000000-CreateAccountsTable.ts" <<'MIGRATION_EOF'
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAccountsTable1718100000000 implements MigrationInterface {
  name = 'CreateAccountsTable1718100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."account_status_enum" AS ENUM(
        'pending_payment',
        'pending_claim',
        'claimed',
        'expired',
        'failed'
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "accounts" (
        "id"                  uuid                            NOT NULL DEFAULT gen_random_uuid(),
        "publicKey"           character varying(56)           NOT NULL,
        "secretKeyEncrypted"  text                            NOT NULL,
        "fundingSource"       character varying(56)           NOT NULL,
        "amount"              numeric(18,7)                   NOT NULL,
        "asset"               character varying(100)          NOT NULL,
        "status"              "public"."account_status_enum"  NOT NULL DEFAULT 'pending_payment',
        "claimTokenHash"      character varying(64),
        "destinationAddress"  character varying(56),
        "expiresAt"           TIMESTAMP                       NOT NULL,
        "createdAt"           TIMESTAMP                       NOT NULL DEFAULT now(),
        "updatedAt"           TIMESTAMP                       NOT NULL DEFAULT now(),
        "claimedAt"           TIMESTAMP,
        "expiredAt"           TIMESTAMP,
        "metadata"            jsonb,
        CONSTRAINT "UQ_accounts_publicKey" UNIQUE ("publicKey"),
        CONSTRAINT "PK_accounts" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_accounts_publicKey"      ON "accounts" ("publicKey")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_accounts_status"         ON "accounts" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_accounts_claimTokenHash" ON "accounts" ("claimTokenHash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_accounts_expiresAt"      ON "accounts" ("expiresAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_accounts_expiresAt"`);
    await queryRunner.query(`DROP INDEX "IDX_accounts_claimTokenHash"`);
    await queryRunner.query(`DROP INDEX "IDX_accounts_status"`);
    await queryRunner.query(`DROP INDEX "IDX_accounts_publicKey"`);
    await queryRunner.query(`DROP TABLE "accounts"`);
    await queryRunner.query(`DROP TYPE "public"."account_status_enum"`);
  }
}
MIGRATION_EOF

cat > "$MIGRATIONS_DIR/1718100001000-CreateClaimsTable.ts" <<'MIGRATION_EOF'
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateClaimsTable1718100001000 implements MigrationInterface {
  name = 'CreateClaimsTable1718100001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "claims" (
        "id"                 uuid                   NOT NULL DEFAULT gen_random_uuid(),
        "accountId"          uuid                   NOT NULL,
        "destinationAddress" character varying(56)  NOT NULL,
        "sweepTxHash"        character varying(64)  NOT NULL,
        "amountSwept"        character varying(100) NOT NULL,
        "asset"              character varying(100) NOT NULL,
        "claimedAt"          TIMESTAMP              NOT NULL,
        "createdAt"          TIMESTAMP              NOT NULL DEFAULT now(),
        "updatedAt"          TIMESTAMP              NOT NULL DEFAULT now(),
        CONSTRAINT "PK_claims" PRIMARY KEY ("id"),
        CONSTRAINT "FK_claims_accountId"
          FOREIGN KEY ("accountId")
          REFERENCES "accounts"("id")
          ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_claims_accountId" ON "claims" ("accountId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_claims_accountId"`);
    await queryRunner.query(`DROP TABLE "claims"`);
  }
}
MIGRATION_EOF

cat > "$MIGRATIONS_DIR/1718100002000-AddInitializingToAccountStatus.ts" <<'MIGRATION_EOF'
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInitializingToAccountStatus1718100002000 implements MigrationInterface {
  name = 'AddInitializingToAccountStatus1718100002000';

  // ALTER TYPE ADD VALUE cannot run inside a transaction on some PostgreSQL
  // versions -- setting transaction = false keeps this migration safe.
  public transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "public"."account_status_enum"
        ADD VALUE 'initializing' BEFORE 'pending_payment'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL has no DROP VALUE -- must recreate the enum type.
    await queryRunner.query(
      `ALTER TABLE "accounts" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "accounts" ALTER COLUMN "status" TYPE text USING "status"::text`,
    );
    await queryRunner.query(`DROP TYPE "public"."account_status_enum"`);
    await queryRunner.query(`
      CREATE TYPE "public"."account_status_enum" AS ENUM(
        'pending_payment',
        'pending_claim',
        'claimed',
        'expired',
        'failed'
      )
    `);
    // Remap any rows that were in INITIALIZING back to PENDING_PAYMENT.
    await queryRunner.query(
      `UPDATE "accounts" SET "status" = 'pending_payment' WHERE "status" = 'initializing'`,
    );
    await queryRunner.query(`
      ALTER TABLE "accounts"
        ALTER COLUMN "status" TYPE "public"."account_status_enum"
        USING "status"::"public"."account_status_enum"
    `);
    await queryRunner.query(
      `ALTER TABLE "accounts" ALTER COLUMN "status" SET DEFAULT 'pending_payment'`,
    );
  }
}
MIGRATION_EOF

cat > "$MIGRATIONS_DIR/1718100003000-CreateWebhooksTable.ts" <<'MIGRATION_EOF'
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWebhooksTable1718100003000 implements MigrationInterface {
  name = 'CreateWebhooksTable1718100003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "webhooks" (
        "id"               uuid                    NOT NULL DEFAULT gen_random_uuid(),
        "url"              character varying(2048)  NOT NULL,
        "secret"           character varying(256),
        "events"           jsonb                   NOT NULL DEFAULT '[]',
        "isActive"         boolean                 NOT NULL DEFAULT true,
        "description"      character varying(255),
        "lastTriggeredAt"  TIMESTAMP,
        "createdAt"        TIMESTAMP               NOT NULL DEFAULT now(),
        "updatedAt"        TIMESTAMP               NOT NULL DEFAULT now(),
        CONSTRAINT "PK_webhooks" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_webhooks_isActive" ON "webhooks" ("isActive")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_webhooks_isActive"`);
    await queryRunner.query(`DROP TABLE "webhooks"`);
  }
}
MIGRATION_EOF

cat > "$MIGRATIONS_DIR/1718100004000-AddClaimingToAccountStatus.ts" <<'MIGRATION_EOF'
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddClaimingToAccountStatus1718100004000 implements MigrationInterface {
  name = 'AddClaimingToAccountStatus1718100004000';

  // ALTER TYPE ADD VALUE cannot run inside a transaction on some PostgreSQL
  // versions -- setting transaction = false keeps this migration safe.
  public transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "public"."account_status_enum"
        ADD VALUE 'claiming' AFTER 'pending_claim'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL has no DROP VALUE -- must recreate the enum type.
    await queryRunner.query(
      `ALTER TABLE "accounts" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "accounts" ALTER COLUMN "status" TYPE text USING "status"::text`,
    );
    await queryRunner.query(`DROP TYPE "public"."account_status_enum"`);
    await queryRunner.query(`
      CREATE TYPE "public"."account_status_enum" AS ENUM(
        'initializing',
        'pending_payment',
        'pending_claim',
        'claimed',
        'expired',
        'failed'
      )
    `);
    await queryRunner.query(
      `UPDATE "accounts" SET "status" = 'pending_claim' WHERE "status" = 'claiming'`,
    );
    await queryRunner.query(`
      ALTER TABLE "accounts"
        ALTER COLUMN "status" TYPE "public"."account_status_enum"
        USING "status"::"public"."account_status_enum"
    `);
    await queryRunner.query(
      `ALTER TABLE "accounts" ALTER COLUMN "status" SET DEFAULT 'pending_payment'`,
    );
  }
}
MIGRATION_EOF

cat > "$MIGRATIONS_DIR/1718100005000-CreateWebhookDeliveriesTable.ts" <<'MIGRATION_EOF'
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWebhookDeliveriesTable1718100005000 implements MigrationInterface {
  name = 'CreateWebhookDeliveriesTable1718100005000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "webhook_deliveries" (
        "id"                  uuid                   NOT NULL DEFAULT gen_random_uuid(),
        "subscription_id"     uuid                   NOT NULL,
        "event_type"          character varying(255) NOT NULL,
        "payload_hash"        character varying(128) NOT NULL,
        "attempt_count"       integer                NOT NULL DEFAULT 1,
        "last_response_code"  integer,
        "last_response_body"  character varying(2048),
        "delivered_at"        TIMESTAMP,
        "created_at"          TIMESTAMP              NOT NULL DEFAULT now(),
        CONSTRAINT "PK_webhook_deliveries" PRIMARY KEY ("id"),
        CONSTRAINT "FK_webhook_deliveries_subscription_id"
          FOREIGN KEY ("subscription_id")
          REFERENCES "webhooks"("id")
          ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_webhook_deliveries_subscription_id_created_at"
      ON "webhook_deliveries" ("subscription_id", "created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX "IDX_webhook_deliveries_subscription_id_created_at"
    `);
    await queryRunner.query(`DROP TABLE "webhook_deliveries"`);
  }
}
MIGRATION_EOF

cat > "$MIGRATIONS_DIR/1718100006000-AddHighTrafficIndexes.ts" <<'MIGRATION_EOF'
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddHighTrafficIndexes1718100006000
 *
 * Index → query map
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
MIGRATION_EOF

cat > "$MIGRATIONS_DIR/1718100007000-CreateContractEventsTable.ts" <<'MIGRATION_EOF'
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateContractEventsTable1718100007000 implements MigrationInterface {
  name = 'CreateContractEventsTable1718100007000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "contract_events" (
        "id"                uuid                   NOT NULL DEFAULT gen_random_uuid(),
        "event_type"        character varying(255) NOT NULL,
        "contract_address"  character varying(128) NOT NULL,
        "ledger_sequence"   bigint                 NOT NULL,
        "tx_hash"           character varying(64)  NOT NULL,
        "payload"           jsonb                  NOT NULL DEFAULT '{}'::jsonb,
        "created_at"        TIMESTAMP              NOT NULL DEFAULT now(),
        CONSTRAINT "PK_contract_events" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "contract_events"`);
  }
}
MIGRATION_EOF

cat > "$MIGRATIONS_DIR/1718100008000-AddDeletedAtToAccountsTable.ts" <<'MIGRATION_EOF'
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDeletedAtToAccountsTable1718100008000 implements MigrationInterface {
  name = 'AddDeletedAtToAccountsTable1718100008000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "accounts"
        ADD COLUMN "deletedAt" timestamp NULL
    `);

    // Index to keep soft-delete filtering fast on high-traffic queries,
    // mirroring the style of 1718100006000-AddHighTrafficIndexes.
    await queryRunner.query(`
      CREATE INDEX "IDX_accounts_deletedAt" ON "accounts" ("deletedAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX "IDX_accounts_deletedAt"
    `);

    await queryRunner.query(`
      ALTER TABLE "accounts"
        DROP COLUMN "deletedAt"
    `);
  }
}
MIGRATION_EOF

cat > "$MIGRATIONS_DIR/1718100008000-AddPartialSweepToAccountStatus.ts" <<'MIGRATION_EOF'
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPartialSweepToAccountStatus1718100008000 implements MigrationInterface {
  name = 'AddPartialSweepToAccountStatus1718100008000';

  // ALTER TYPE ADD VALUE cannot run inside a transaction on some PostgreSQL
  // versions -- setting transaction = false keeps this migration safe.
  public transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "public"."account_status_enum"
        ADD VALUE 'partial_sweep' AFTER 'claiming'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL has no DROP VALUE -- must recreate the enum type.
    await queryRunner.query(
      `ALTER TABLE "accounts" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "accounts" ALTER COLUMN "status" TYPE text USING "status"::text`,
    );
    await queryRunner.query(`DROP TYPE "public"."account_status_enum"`);
    await queryRunner.query(`
      CREATE TYPE "public"."account_status_enum" AS ENUM(
        'initializing',
        'pending_payment',
        'pending_claim',
        'claiming',
        'claimed',
        'expired',
        'failed'
      )
    `);
    await queryRunner.query(
      `UPDATE "accounts" SET "status" = 'claiming' WHERE "status" = 'partial_sweep'`,
    );
    await queryRunner.query(`
      ALTER TABLE "accounts"
        ALTER COLUMN "status" TYPE "public"."account_status_enum"
        USING "status"::"public"."account_status_enum"
    `);
    await queryRunner.query(
      `ALTER TABLE "accounts" ALTER COLUMN "status" SET DEFAULT 'pending_payment'`,
    );
  }
}
MIGRATION_EOF

cat > "$MIGRATIONS_DIR/1718100008000-CreateClaimAuditLogTable.ts" <<'MIGRATION_EOF'
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateClaimAuditLogTable1718100008000 implements MigrationInterface {
  name = 'CreateClaimAuditLogTable1718100008000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "claim_audit_log" (
        "id"              uuid                   NOT NULL DEFAULT gen_random_uuid(),
        "accountId"       uuid                   NOT NULL,
        "destinationHash" character varying(64)  NOT NULL,
        "ipHash"          character varying(64),
        "outcome"         character varying(10)  NOT NULL,
        "failureReason"   text,
        "attemptedAt"     TIMESTAMP              NOT NULL DEFAULT now(),
        CONSTRAINT "PK_claim_audit_log" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_claim_audit_log_accountId" ON "claim_audit_log" ("accountId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_claim_audit_log_attemptedAt" ON "claim_audit_log" ("attemptedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_claim_audit_log_attemptedAt"`);
    await queryRunner.query(`DROP INDEX "IDX_claim_audit_log_accountId"`);
    await queryRunner.query(`DROP TABLE "claim_audit_log"`);
  }
}
MIGRATION_EOF

echo "Done. Wrote 11 migration files to $MIGRATIONS_DIR."
echo "Run 'npm run migration:run' to apply them, or 'npm run migration:show' to check status."