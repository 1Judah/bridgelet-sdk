import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #877: this migration (like every other one in this folder) ships a symmetric
 * `down()`, and `test/migrations.integration.runner.ts` exercises
 * `migration:revert` back to zero and re-applies, so a missing or broken
 * `down()` fails the runner instead of staying undetected.
 */
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
