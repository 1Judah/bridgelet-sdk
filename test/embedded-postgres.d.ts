/**
 * Hand-maintained ambient declarations for `embedded-postgres`.
 *
 * The upstream package ships no types, and it is pinned to a *beta* range
 * (`^16.14.0-beta.17` in package.json). A caret range on a beta can resolve to
 * a newer beta on any `npm install`, and upstream's API surface may change
 * without notice — which would silently desynchronise this file from the
 * package the e2e suite actually loads.
 *
 * MAINTENANCE RULE (issue #673, re-confirmed #887): whenever
 * `embedded-postgres` is bumped in package.json, re-verify this file against
 * the new version before merging.
 * `npm run check:embedded-postgres-types` fails the build when the pinned
 * range and the `LAST_VERIFIED_VERSION` below drift apart, so the bump cannot
 * be forgotten.
 *
 * Verified against: 16.14.0-beta.17
 */
declare module 'embedded-postgres' {
  type EmbeddedPostgresOptions = {
    databaseDir: string;
    port: number;
    user: string;
    password: string;
    persistent?: boolean;
    onLog?: (message: string) => void;
    onError?: (error: Error) => void;
  };

  export default class EmbeddedPostgres {
    constructor(options: EmbeddedPostgresOptions);
    initialise(): Promise<void>;
    start(): Promise<void>;
    createDatabase(name: string): Promise<void>;
    stop(): Promise<void>;
  }
}
