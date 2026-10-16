/**
 * Pure evaluation of the `@stellar/stellar-sdk` exact-pin rule (issue #446).
 *
 * #869: reconciles what the README promises with what `package.json` declares —
 * the SDK stays an exact version (currently `17.2.1`), never a caret/tilde
 * range, and the README quotes the same pinned version.
 *
 * This module deliberately contains no I/O and no side effects so that the
 * whole rule can be unit-tested; `check-stellar-sdk-pin.ts` is the thin CLI
 * wrapper that feeds it the repository's `package.json`.
 */

/** The only dependency whose declared version must be an exact pin. */
export const STELLAR_SDK_PACKAGE = '@stellar/stellar-sdk';

/**
 * `major.minor.patch` with an optional pre-release and build metadata suffix.
 * Anything carrying a range operator (`^`, `~`, `>=`, `||`, `-`, `*`, …) or
 * omitting a component fails this test, which is the entire point of the check.
 */
const EXACT_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Shape of the parts of `package.json` this check reads. */
export interface PackageJsonLike {
  dependencies?: Record<string, unknown> | undefined;
  devDependencies?: Record<string, unknown> | undefined;
}

/** Why a declared version is not an exact pin. */
export type PinRejectionReason =
  /** The package is not declared at all. */
  | 'missing'
  /** Declared as a non-string (object, number, null, …). */
  | 'not-a-string'
  /** Declared as an empty or whitespace-only string. */
  | 'empty'
  /** A version prefix with a component missing, e.g. `14.6`. */
  | 'partial-version'
  /** A dist-tag such as `latest` or `beta`, which moves without a commit. */
  | 'dist-tag'
  /** A semver range, wildcard, URL or git specifier. */
  | 'range';

export type PinCheckResult =
  | { ok: true; version: string }
  | { ok: false; reason: PinRejectionReason; declared: string };

/**
 * Classify the declared `@stellar/stellar-sdk` version.
 *
 * Returns `{ ok: true }` only for a bare exact version. Every other shape —
 * including a missing or empty value — is rejected with a reason the CLI can
 * turn into an actionable message.
 */
export function evaluateStellarSdkPin(pkg: PackageJsonLike): PinCheckResult {
  const declared = pkg.dependencies?.[STELLAR_SDK_PACKAGE];

  if (declared === undefined) {
    return { ok: false, reason: 'missing', declared: '' };
  }

  if (typeof declared !== 'string') {
    return {
      ok: false,
      reason: 'not-a-string',
      declared: describeValue(declared),
    };
  }

  const value = declared.trim();

  if (value === '') {
    return { ok: false, reason: 'empty', declared: declared };
  }

  if (EXACT_VERSION.test(value)) {
    return { ok: true, version: value };
  }

  if (/^\d/.test(value)) {
    return { ok: false, reason: 'partial-version', declared: declared };
  }

  if (/^[A-Za-z][\w.-]*$/.test(value)) {
    return { ok: false, reason: 'dist-tag', declared: declared };
  }

  return { ok: false, reason: 'range', declared: declared };
}

/** Operator/prefix that is most likely to have been added by accident. */
function suggest(value: string): string {
  const match = value.trim().match(/^([\^~><=*v]+)/);
  return match ? match[1] : '';
}

/** Display form of a value that was not a string, without `[object Object]`. */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const type = typeof value;
  return type === 'object' ? 'an object' : `a ${type}`;
}

/**
 * Human-readable explanation of a rejection, including why the pin matters.
 *
 * Kept separate from the classification so the spec can assert on the
 * classification without pinning prose, and so the wording is easy to revise.
 */
export function describePinFailure(result: {
  reason: PinRejectionReason;
  declared: string;
}): string {
  const { reason, declared } = result;
  const shown = declared === '' ? '(not declared)' : `"${declared}"`;

  switch (reason) {
    case 'missing':
      return (
        `${STELLAR_SDK_PACKAGE} is not listed in "dependencies" in package.json.\n` +
        'It is a runtime dependency and must be declared there with an exact version.'
      );
    case 'not-a-string':
      return `${STELLAR_SDK_PACKAGE} must be declared as a version string, but it is ${declared}.`;
    case 'empty':
      return `${STELLAR_SDK_PACKAGE} is declared as an empty string. Declare the exact version you intend to ship.`;
    case 'partial-version':
      return (
        `${STELLAR_SDK_PACKAGE} is declared as ${shown}, which is not a full major.minor.patch version.\n` +
        'A partial version is still a range in disguise: npm resolves it to the newest matching release.'
      );
    case 'dist-tag':
      return (
        `${STELLAR_SDK_PACKAGE} is declared as the dist-tag ${shown}, which floats to whatever is newest at install time.\n` +
        'Use the exact version instead.'
      );
    case 'range': {
      const op = suggest(declared);
      const hint = op
        ? `Remove the leading "${op}" so the version is exact.`
        : 'Declare the exact version instead of a range, wildcard, URL or git specifier.';
      return (
        `${STELLAR_SDK_PACKAGE} must be pinned to an exact version, but package.json declares ${shown}.\n` +
        `${hint}\n` +
        'The SDK is pinned exactly because it produces the raw Stellar XDR and Soroban\n' +
        'call encodings this service signs and submits; a range lets a patch release\n' +
        'change that encoding underneath us. See the "Stellar SDK Version" section of\n' +
        'README.md for the rationale and the manual upgrade process (issue #446).'
      );
    }
  }
}
