# Contributing to Bridgelet SDK

Thank you for contributing to the Bridgelet SDK! Please follow these guidelines to ensure a smooth review process.

# Contributing

## Automated PR Naming Checks

All pull requests are validated automatically for branch naming and PR title format.

- During the initial rollout, checks run in warning mode until **2026-02-27**.
- After that date, pull requests are blocked until naming issues are fixed.

### Branch Name Format

Accepted pattern:

`(fix|feature|test|chore|docs)/issue-brief-description`

Regex used by CI:

`^(fix|feature|test|chore|docs)/issue-[a-z0-9-]+$`

Examples:

- `fix/issue-jwt-error-handling`
- `feature/issue-webhook-service`

`main` and `develop` are exempt for release/hotfix workflows.

### PR Title Format

Accepted pattern:

`(Fix|Feature|Test|Chore|Docs): Brief description (#NUMBER)`

Regex used by CI:

`^(Fix|Feature|Test|Chore|Docs): .+ \(#[0-9]+\)$`

Examples:

- `Fix: Handle JWT errors in TokenVerificationProvider (#42)`
- `Test: Add unit tests for ClaimLookupProvider (#43)`

### How To Fix A Branch Name

Rename your local branch and push the new branch:

```bash
git branch -m fix/issue-jwt-error-handling
git push origin -u fix/issue-jwt-error-handling
```

Then update the PR to use the renamed branch. If needed, close the old PR and open a new one from the renamed branch.

### How To Fix A PR Title

Edit the PR title directly in GitHub:

1. Open the pull request.
2. Click the title field.
3. Update it to the required format.
4. Save changes.

## Getting Started

1. **Fork the repository** and clone your fork locally
2. **Create a feature branch** from `main`:

```bash
   git checkout -b fix/issue-description
   # or
   git checkout -b feature/issue-description
```

3. **Never push directly to `main`** - always work in a branch

### Local Database Setup (issue #538)

You need a PostgreSQL instance before you can run migrations or start the
app. Two ways to get one:

**Recommended: Docker Compose.** From the repo root:

```bash
docker compose up
```

This provisions a Postgres 16 container with the same defaults as
`.env.example` and automatically runs `npm run migration:run` against it
(the `migrate` service waits for Postgres's healthcheck, then exits once
migrations succeed). Nothing else is required — no `.env` file needed
for this step. Once it's up, copy `.env.example` to `.env` (leaving
`DATABASE_HOST=localhost` and the other `DATABASE_*` defaults as they
are — they already point at the container's exposed port) and continue
with `npm run start:dev` on the host as usual.

If you'd rather run the NestJS app inside Docker too instead of on the
host, first copy and fill in `.env` (Stellar/KMS/JWT values are
required for the app to boot, in or out of Docker), then:

```bash
docker compose --profile app up
```

To reset to a completely clean database: `docker compose down -v` (the
`-v` drops the named Postgres volume).

This is separate from, and does not conflict with, the throwaway
Postgres instance `test/migrations.integration.runner.ts` starts for
its own test run — that one runs on a dynamically chosen free port for
the duration of the test only.

**Alternative: a manually provisioned Postgres.** See
`docs/getting-started.md` for the fully manual path (install Postgres
yourself, create the database, point `.env` at it).

## Development Workflow

### 1. Make Your Changes

- **Only modify files directly related to your issue**
- Do not refactor, rename, or "improve" code outside the scope of your task
- If you must use AI, use it cautiously and contiously.
- Touching unnecessary files makes reviews harder and increases the chance of merge conflicts
- Preserve codebase integrity by staying focused on the issue requirements

### 2. Run Tests Locally

Before submitting your PR, ensure all checks pass:

```bash
# Format check
npm run format:check

# Fix formatting (if needed)
npm run format

# Linting
npm run lint

# Run all tests
npm run test

# Run specific test file
npm test -- your-test-file.spec.ts

# Build verification
npm run build
```

**All of these must pass before submitting your PR.**

### 3. Commit Your Changes

Write clear, concise commit messages:

```bash
# Good examples:
git commit -m "Fix: Handle TokenExpiredError in TokenVerificationProvider"
git commit -m "Test: Add unit tests for ClaimLookupProvider"
git commit -m "Refactor: Extract Stellar address validation logic"

# Bad examples:
git commit -m "fixed stuff"
git commit -m "updates"
git commit -m "wip"
```

## Pull Request Guidelines

### Before Submitting

- [ ] All tests pass locally (`npm run test`)
- [ ] Linting passes (`npm run lint`)
- [ ] Code is properly formatted (`npx prettier --check .`)
- [ ] Build succeeds (`npm run build`)
- [ ] Only relevant files are modified
- [ ] No commented-out code added (unless marked as `TEMPORARY:` per project conventions)
- [ ] Coverage threshold passes (`npm run test:cov`)

### PR Title Format

Use conventional commit format:

```
Fix: Brief description of what was fixed (#issue-number)
Test: Brief description of tests added (#issue-number)
Feature: Brief description of feature (#issue-number)
```

**Examples:**

- `Fix: Resolve JWT error handling in claims service (#42)`
- `Test: Add comprehensive unit tests for ClaimRedemptionProvider (#43)`

### PR Description

Include:

1. **Issue reference**: "Closes #123" or "Fixes #456"
2. **What changed**: Brief summary of your changes 3-4 lines
3. **Testing**: Confirmation that all CI checks pass locally

**Example:**

```markdown
Closes #42

## Changes

- Added try-catch for TokenExpiredError and JsonWebTokenError in decodeClaimToken
- Errors now properly throw UnauthorizedException
- All 33 tests passing

## Testing

✅ Lint passed
✅ All tests passed (33/33)
✅ Build successful
```

## CI Pipeline

When you open a PR, our CI will automatically run:

1. **Format Check** - Ensures code follows Prettier conventions
2. **Linting** - Validates code quality and standards
3. **Unit Tests** - Runs all test suites
4. **Build Verification** - Confirms the project builds successfully

**Your PR will not be merged until all CI checks pass.**

## Code Review Process

1. Maintainers will review your PR within 48-72 hours
2. Address any requested changes promptly
3. Keep discussions focused and professional
4. Once approved, maintainers will merge your PR

## Database Migrations

`src/database/migrations/` is generated by `scripts/generate-migrations.sh`, not hand-edited. The script deletes the folder and rewrites every migration file verbatim, so the folder on disk always matches what the script defines — nobody has to recreate it by hand after a clean checkout.

```bash
# Rewrites src/database/migrations/ from scripts/generate-migrations.sh
./scripts/generate-migrations.sh --yes
```

The script refuses to run while `src/database/migrations/` has uncommitted changes
(`git status --porcelain` pre-flight check), since it would otherwise delete any
migration file you have hand-edited or not yet committed. Commit or stash first, or
re-run with `./scripts/generate-migrations.sh --yes --force` to overwrite
deliberately.

### Adding a new migration

1. Generate the file with the TypeORM CLI as usual:

   ```bash
   npm run migration:generate -- src/database/migrations/<timestamp>-<Name>
   # or, for a hand-written migration:
   npm run migration:create -- src/database/migrations/<timestamp>-<Name>
   ```

2. Write the `up()`/`down()` logic and confirm it locally (`npm run migration:run`, `npm run migration:revert`).
3. **Add the new file's contents into `scripts/generate-migrations.sh`** as its own `cat > "$MIGRATIONS_DIR/<file>.ts" <<'MIGRATION_EOF' ... MIGRATION_EOF` block, in timestamp order, so the script stays the single source of truth for the folder.
4. Run `./scripts/generate-migrations.sh --yes` and confirm `git diff` is empty — that's your proof the script and the folder agree. (If the new file is still uncommitted, commit it first, or pass `--force` to acknowledge the overwrite.)
5. Update the migration list in [`README.md`](./README.md#installation) to include the new file.

### Verifying `down()`

`down()` is the half that is easy to skip and expensive to get wrong — a broken
or missing `down()` only surfaces during a production rollback. Two ways to
check it:

- **One step at a time, against a real database:** `npm run migration:revert`
  reverts only the most recently applied migration, so run it repeatedly to
  walk the schema back to zero. Re-run it once more after the last migration
  and confirm it reports no migrations to revert.
- **Automated, no database to provision:** `npm run test:migrations` starts a
  throwaway embedded PostgreSQL instance, applies every migration in the pinned
  filename order, verifies the schema, reverts all of them, asserts the schema
  is back to its pre-migration state, and then re-applies them and asserts the
  schema matches again. This round trip is the check that catches a `down()`
  that drops the wrong objects or leaves a table behind; add your migration to
  the pinned list in `test/migrations.integration.runner.ts` when you add a new
  file, and keep the list in the same order as the folder.

Note that `down()` methods run in reverse filename order, which matters for the
three migrations sharing a timestamp (see below): `CreateClaimAuditLogTable`
reverts before `AddPartialSweepToAccountStatus`, which reverts before
`AddDeletedAtToAccountsTable`.

### Notes on timestamps

TypeORM orders migrations by the numeric timestamp in the filename, falling back to filename string comparison when timestamps tie. A few existing migrations (`1718100008000-*`) share a timestamp; their run order is preserved by the script exactly as it exists today (alphabetical: `AddDeletedAtToAccountsTable`, `AddPartialSweepToAccountStatus`, `CreateClaimAuditLogTable`). **Do not renumber existing migration timestamps** — any environment that already recorded these migration names in its `migrations` table would try to re-run them under new names. Give new migrations their own, later timestamp instead.

## Important Notes

### Temporary Workarounds

The project has temporary workarounds for missing services (see README "TEMPORARY DEVELOPMENT WORKAROUNDS" section). Do not:

- Remove or uncomment `TEMPORARY:` marked code unless specifically instructed
- Attempt to implement missing services (WebhooksService) unless assigned

### Scope Discipline

**This is critical:** Contributors often feel compelled to "improve" code beyond their assigned task. Please resist this urge. Unrelated changes:

- Make PRs harder to review
- Increase risk of introducing bugs
- Delay merge time
- May cause your PR to be rejected

If you notice issues outside your scope, open a separate issue instead.

## Questions?

- Check the [README](./README.md) for project setup and architecture
- Review existing issues and PRs for context
- Open a discussion issue if you need clarification before starting work

---

**Thank you for helping improve Bridgelet SDK!** 🚀

## Test quality notes

- **embedded-postgres typings (#734):** `test/embedded-postgres.d.ts` is hand-maintained against a beta package. Run `npm run check:embedded-postgres-types` and re-verify the file whenever `embedded-postgres` is bumped.
- **Expired claim tokens (#735):** `test/claim-lifecycle.e2e-spec.ts` ("Expired claim token (e2e)") covers redemption and verification after `CLAIM_TOKEN_EXPIRY` has elapsed, expecting a clear 401 rather than a 500.
- **Mutation testing (#736):** line/branch coverage alone does not prove assertions are meaningful. `npm run test:mutation` (Stryker) targets `src/common/crypto/` and `src/modules/sweeps/`; run it before changing those directories.
- **Metrics specs (#737):** metrics-provider specs must assert on registry state (`registry.getSingleMetric(name).get()`), not only that a mock `.inc()`/`.observe()` was called, so bucket and label mistakes are caught.
