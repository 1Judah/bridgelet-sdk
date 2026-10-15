/**
 * EXPLAIN-based index-usage verification for the claim lookup paths (#764).
 *
 * The structural check in
 * `src/modules/claims/providers/claim-lookup.index-usage.spec.ts` only proves
 * the `CREATE INDEX` statements exist in the migration source; it says nothing
 * about whether the PostgreSQL planner actually chooses them. This script runs
 * the real query shapes against a real (embedded) PostgreSQL instance with a
 * populated `accounts`/`claims` pair and asserts on the JSON EXPLAIN plan that
 * every lookup is served by an index and not a sequential scan.
 *
 * Query shapes covered (all taken from production code):
 *   1. `ClaimLookupProvider.findClaimById()` - claims by primary key with a
 *      LEFT JOIN to accounts by primary key (`claim-lookup.provider.ts`).
 *   2. `ClaimRedemptionProvider.redeemClaim()` / `TokenVerificationProvider`
 *      - accounts by `claimTokenHash` plus the `deletedAt IS NULL` soft-delete
 *      filter (`claim-redemption.provider.ts:63`,
 *      `token-verification.provider.ts:52`).
 *   3. The "already redeemed" lookup - claims by `accountId`
 *      (`claim-redemption.provider.ts:66`).
 *
 * Like `test/migrations.integration.runner.ts`, this is a Node script rather
 * than a Jest spec because it needs the `embedded-postgres` binary package,
 * which is ESM-only and cannot be loaded through Jest's CommonJS transform.
 * Run with `npm run test:claim-lookup-index`. The script prints a JSON report
 * and exits non-zero when any plan falls back to a sequential scan, so it can
 * be wired into CI as a real pass/fail check.
 */

import { mkdtemp, rm } from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import EmbeddedPostgres from 'embedded-postgres';
import { DataSource } from 'typeorm';
import { CreateAccountsTable1718100000000 } from '../src/database/migrations/1718100000000-CreateAccountsTable.js';
import { CreateClaimsTable1718100001000 } from '../src/database/migrations/1718100001000-CreateClaimsTable.js';
import { AddDeletedAtToAccountsTable1718100008000 } from '../src/database/migrations/1718100008000-AddDeletedAtToAccountsTable.js';

const postgresUser = 'postgres';
const postgresPassword = 'postgres';
const postgresDatabase = 'bridgelet_claim_index_test';

/** Enough rows that an unindexed lookup would obviously prefer a seq scan. */
const seededAccounts = 5_000;
const seededClaims = 2_500;

const destinationAddress =
  'GBULQKZ7SA56UKRI6LX2IB6XH3GJW2L34BMTOWMQFJBAQNPSHJJNOTGN';

type PlanNode = {
  'Node Type': string;
  'Index Name'?: string;
  'Relation Name'?: string;
  Plans?: PlanNode[];
};

type IndexRow = { indexname: string };

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (address == null || typeof address === 'string') {
        reject(new Error('Unable to allocate a local port for index checks.'));
        return;
      }

      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

/** Flatten an EXPLAIN plan tree into a list of nodes. */
function collectNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(collectNodes)];
}

function seqScanRelations(plan: PlanNode): string[] {
  return collectNodes(plan)
    .filter(({ 'Node Type': nodeType }) => nodeType === 'Seq Scan')
    .map(({ 'Relation Name': relation }) => relation ?? 'unknown');
}

function indexNamesUsed(plan: PlanNode): string[] {
  return collectNodes(plan)
    .map(({ 'Index Name': indexName }) => indexName)
    .filter((indexName): indexName is string => indexName !== undefined);
}

type LookupCheck = {
  name: string;
  sql: string;
  params: unknown[];
  /** Index the planner must use for this lookup. */
  expectedIndex: string;
  expectedIndexesUsed: string[];
  seqScanRelations: string[];
  passed: boolean;
};

async function explain(
  dataSource: DataSource,
  sql: string,
  params: unknown[],
): Promise<PlanNode> {
  const rows: Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }> =
    await dataSource.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);

  return rows[0]['QUERY PLAN'][0].Plan;
}

async function seed(dataSource: DataSource): Promise<void> {
  // Raw SQL keeps seeding to a single round trip. `claimTokenHash` is the
  // sha256 of the row number in hex (64 chars, matching the column width), so
  // the checks can look up an exact hash the way the providers do.
  await dataSource.query(
    `
      INSERT INTO "accounts" (
        "publicKey",
        "secretKeyEncrypted",
        "fundingSource",
        "amount",
        "asset",
        "status",
        "claimTokenHash",
        "expiresAt"
      )
      SELECT
        'G' || lpad(i::text, 55, '0'),
        'embedded-test-secret',
        'GFUNDINGSOURCEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        1.0,
        'USDC',
        'pending_claim'::"account_status_enum",
        encode(digest(i::text, 'sha256'), 'hex'),
        NOW() + INTERVAL '1 day'
      FROM generate_series(1, $1) AS i
    `,
    [seededAccounts],
  );

  await dataSource.query(
    `
      INSERT INTO "claims" (
        "accountId",
        "destinationAddress",
        "sweepTxHash",
        "amountSwept",
        "asset",
        "claimedAt"
      )
      SELECT
        a."id",
        $1,
        encode(digest(a."id"::text, 'sha256'), 'hex'),
        '1.0000000',
        'USDC',
        NOW()
      FROM (SELECT "id" FROM "accounts" ORDER BY "id" LIMIT $2) AS a
    `,
    [destinationAddress, seededClaims],
  );
}

async function main(): Promise<void> {
  const port = await getFreePort();
  const postgresDataDir = await mkdtemp(
    path.join(os.tmpdir(), 'bridgelet-claim-index-'),
  );
  const postgresServer = new EmbeddedPostgres({
    databaseDir: postgresDataDir,
    port,
    user: postgresUser,
    password: postgresPassword,
    persistent: false,
    onLog: () => undefined,
    onError: () => undefined,
  });

  let dataSource: DataSource | null = null;

  try {
    await postgresServer.initialise();
    await postgresServer.start();
    await postgresServer.createDatabase(postgresDatabase);

    dataSource = new DataSource({
      type: 'postgres',
      host: '127.0.0.1',
      port,
      username: postgresUser,
      password: postgresPassword,
      database: postgresDatabase,
      entities: [],
      migrations: [
        CreateAccountsTable1718100000000,
        CreateClaimsTable1718100001000,
        AddDeletedAtToAccountsTable1718100008000,
      ],
      migrationsTransactionMode: 'each',
      synchronize: false,
    });

    await dataSource.initialize();
    // gen_random_uuid() is used as a column DEFAULT in the migrations, so the
    // extension must exist before they run.
    await dataSource.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await dataSource.runMigrations();

    await seed(dataSource);

    // The planner needs statistics to prefer the indexes; without ANALYZE a
    // freshly seeded table can be estimated as tiny and seq-scanned anyway.
    await dataSource.query('ANALYZE "accounts"');
    await dataSource.query('ANALYZE "claims"');

    // --- Referenced indexes exist ------------------------------------
    const expectedIndexNames = [
      'PK_claims',
      'PK_accounts',
      'IDX_accounts_claimTokenHash',
      'IDX_claims_accountId',
    ];
    const indexRows: IndexRow[] = await dataSource.query(
      `
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = ANY($1::text[])
        ORDER BY indexname
      `,
      [expectedIndexNames],
    );
    const existingIndexes = indexRows.map(({ indexname }) => indexname);

    // --- Lookup plans -------------------------------------------------
    // Pull one (claim, account) pair so every check queries real rows: the
    // claim's PK, its account's PK, and that account's token hash.
    const fixtureRows: Array<{
      claim_id: string;
      account_id: string;
      token_hash: string;
    }> = await dataSource.query(
      `SELECT c."id" AS claim_id,
              c."accountId" AS account_id,
              a."claimTokenHash" AS token_hash
         FROM "claims" c
         JOIN "accounts" a ON a."id" = c."accountId"
        LIMIT 1`,
    );
    const seededClaimId = fixtureRows[0].claim_id;
    const seededAccountId = fixtureRows[0].account_id;
    const tokenHash = fixtureRows[0].token_hash;

    const checks: LookupCheck[] = [];

    // 1. findClaimById(): claims by PK, LEFT JOIN accounts by PK. The
    //    relation is projected (as TypeORM does with `relations: ['account']`),
    //    otherwise PostgreSQL can eliminate the unused LEFT JOIN entirely.
    const claimByIdPlan = await explain(
      dataSource,
      `SELECT "Claim"."id", "Claim"."accountId",
              "Claim__account"."id" AS "account_id",
              "Claim__account"."publicKey" AS "account_publicKey"
         FROM "claims" "Claim"
         LEFT JOIN "accounts" "Claim__account"
           ON "Claim__account"."id" = "Claim"."accountId"
        WHERE "Claim"."id" = $1`,
      [seededClaimId],
    );
    const claimByIdIndexes = indexNamesUsed(claimByIdPlan);
    checks.push({
      name: 'findClaimById (claims PK + accounts PK join)',
      sql: 'SELECT ... FROM claims LEFT JOIN accounts ON accounts.id = claims."accountId" WHERE claims.id = $1',
      params: [seededClaimId],
      expectedIndex: 'PK_claims',
      expectedIndexesUsed: claimByIdIndexes,
      seqScanRelations: seqScanRelations(claimByIdPlan),
      passed:
        claimByIdIndexes.includes('PK_claims') &&
        claimByIdIndexes.includes('PK_accounts') &&
        seqScanRelations(claimByIdPlan).length === 0,
    });

    // 2. claimTokenHash lookup (redemption / verification providers).
    const tokenHashPlan = await explain(
      dataSource,
      `SELECT "id"
         FROM "accounts"
        WHERE "claimTokenHash" = $1
          AND "deletedAt" IS NULL`,
      [tokenHash],
    );
    const tokenHashIndexes = indexNamesUsed(tokenHashPlan);
    checks.push({
      name: 'claimTokenHash lookup (accounts by hash, deletedAt IS NULL)',
      sql: 'SELECT id FROM accounts WHERE claimTokenHash = $1 AND deletedAt IS NULL',
      params: [tokenHash],
      expectedIndex: 'IDX_accounts_claimTokenHash',
      expectedIndexesUsed: tokenHashIndexes,
      seqScanRelations: seqScanRelations(tokenHashPlan),
      passed:
        tokenHashIndexes.includes('IDX_accounts_claimTokenHash') &&
        seqScanRelations(tokenHashPlan).length === 0,
    });

    // 3. Already-redeemed lookup: claims by accountId.
    const claimsByAccountPlan = await explain(
      dataSource,
      `SELECT "id"
         FROM "claims"
        WHERE "accountId" = $1`,
      [seededAccountId],
    );
    const claimsByAccountIndexes = indexNamesUsed(claimsByAccountPlan);
    checks.push({
      name: 'claims by accountId (already-redeemed lookup)',
      sql: 'SELECT id FROM claims WHERE accountId = $1',
      params: [seededAccountId],
      expectedIndex: 'IDX_claims_accountId',
      expectedIndexesUsed: claimsByAccountIndexes,
      seqScanRelations: seqScanRelations(claimsByAccountPlan),
      passed:
        claimsByAccountIndexes.includes('IDX_claims_accountId') &&
        seqScanRelations(claimsByAccountPlan).length === 0,
    });

    process.stdout.write(
      JSON.stringify(
        {
          seededAccounts,
          seededClaims,
          expectedIndexNames,
          existingIndexes,
          checks,
        },
        null,
        2,
      ),
    );

    const failures: string[] = [];

    for (const indexName of expectedIndexNames) {
      if (!existingIndexes.includes(indexName)) {
        failures.push(`Expected index ${indexName} to exist after migrations`);
      }
    }

    for (const check of checks) {
      if (!check.passed) {
        failures.push(
          `${check.name}: expected ${check.expectedIndex}. ` +
            `indexesUsed=${JSON.stringify(check.expectedIndexesUsed)} ` +
            `seqScans=${JSON.stringify(check.seqScanRelations)}`,
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `Claim lookup index checks failed:\n - ${failures.join('\n - ')}`,
      );
    }
  } finally {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }

    await postgresServer.stop();
    await rm(postgresDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  // Same rationale as migrations.integration.runner.ts: ensure a failure here
  // propagates to the shell/CI exit code even when run through an ESM loader.
  process.exitCode = 1;
  process.exit(1);
});
