import {
  STELLAR_SDK_PACKAGE,
  describePinFailure,
  evaluateStellarSdkPin,
} from './stellar-sdk-pin.js';
import type { PackageJsonLike } from './stellar-sdk-pin.js';

/** Builds a package.json-shaped object declaring the SDK at `declared`. */
function pkgWith(declared: unknown): PackageJsonLike {
  return { dependencies: { [STELLAR_SDK_PACKAGE]: declared } };
}

describe('evaluateStellarSdkPin', () => {
  describe('accepted', () => {
    it('accepts an exact release version', () => {
      expect(evaluateStellarSdkPin(pkgWith('14.6.1'))).toEqual({
        ok: true,
        version: '14.6.1',
      });
    });

    it('accepts an exact pre-release version', () => {
      expect(evaluateStellarSdkPin(pkgWith('15.0.0-rc.1'))).toEqual({
        ok: true,
        version: '15.0.0-rc.1',
      });
    });

    it('accepts an exact version with build metadata', () => {
      expect(evaluateStellarSdkPin(pkgWith('14.6.1+build.7'))).toEqual({
        ok: true,
        version: '14.6.1+build.7',
      });
    });

    it('accepts a major version above 9, which `\\d+` must not truncate', () => {
      expect(evaluateStellarSdkPin(pkgWith('14.16.203'))).toEqual({
        ok: true,
        version: '14.16.203',
      });
    });

    it('tolerates surrounding whitespace', () => {
      expect(evaluateStellarSdkPin(pkgWith('  14.6.1  '))).toEqual({
        ok: true,
        version: '14.6.1',
      });
    });

    it('ignores devDependencies and passes with no devDependencies block', () => {
      expect(
        evaluateStellarSdkPin({
          dependencies: { [STELLAR_SDK_PACKAGE]: '14.6.1' },
        }),
      ).toEqual({ ok: true, version: '14.6.1' });
    });
  });

  describe('rejected ranges — the case the check exists for', () => {
    it.each([
      ['caret range', '^14.6.1'],
      ['tilde range', '~14.6.1'],
      ['greater-than-or-equal range', '>=14.6.1'],
      ['partial version', '14.6'],
      ['wildcard', '*'],
      ['npm dist-tag', 'latest'],
    ])('rejects a %s', (_label, declared) => {
      const result = evaluateStellarSdkPin(pkgWith(declared));
      expect(result.ok).toBe(false);
    });

    it('rejects the caret range that is on main today', () => {
      const result = evaluateStellarSdkPin(pkgWith('^14.4.3'));
      expect(result).toEqual({
        ok: false,
        reason: 'range',
        declared: '^14.4.3',
      });
    });

    it('classifies each range shape with a distinct reason', () => {
      expect(evaluateStellarSdkPin(pkgWith('^14.6.1')).ok).toBe(false);
      expect(evaluateStellarSdkPin(pkgWith('~14.6.1')).ok).toBe(false);
      expect(evaluateStellarSdkPin(pkgWith('>=14.6.1')).ok).toBe(false);
      expect(evaluateStellarSdkPin(pkgWith('14.6'))).toEqual({
        ok: false,
        reason: 'partial-version',
        declared: '14.6',
      });
      expect(evaluateStellarSdkPin(pkgWith('*'))).toEqual({
        ok: false,
        reason: 'range',
        declared: '*',
      });
      expect(evaluateStellarSdkPin(pkgWith('latest'))).toEqual({
        ok: false,
        reason: 'dist-tag',
        declared: 'latest',
      });
    });

    it.each([
      '1.x',
      '14',
      '>=14.6.1 <15',
      '14.6.1 - 15.0.0',
      '^14.6.1 || ^15.0.0',
      '>14.6.0',
      '=14.6.1',
      'v14.6.1',
      'file:../stellar-sdk',
      'github:stellar/stellar-sdk#v14.6.1',
      'workspace:*',
      'beta',
      'next',
      '14.6.1.2',
    ])('rejects %j', (declared) => {
      expect(evaluateStellarSdkPin(pkgWith(declared)).ok).toBe(false);
    });
  });

  describe('rejected missing or empty declarations', () => {
    it('rejects a package.json with no dependencies block', () => {
      expect(evaluateStellarSdkPin({})).toEqual({
        ok: false,
        reason: 'missing',
        declared: '',
      });
    });

    it('rejects a dependencies block that omits the SDK', () => {
      expect(
        evaluateStellarSdkPin({ dependencies: { axios: '^1.0.0' } }),
      ).toEqual({ ok: false, reason: 'missing', declared: '' });
    });

    it('rejects an empty string', () => {
      expect(evaluateStellarSdkPin(pkgWith(''))).toEqual({
        ok: false,
        reason: 'empty',
        declared: '',
      });
    });

    it('rejects a whitespace-only string', () => {
      expect(evaluateStellarSdkPin(pkgWith('   '))).toEqual({
        ok: false,
        reason: 'empty',
        declared: '   ',
      });
    });

    it.each([null, 14, {}, [], true])(
      'rejects the non-string value %j',
      (declared) => {
        const result = evaluateStellarSdkPin(pkgWith(declared));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('not-a-string');
        }
      },
    );
  });

  it('is not fooled by a pin that merely starts with the right digits', () => {
    expect(evaluateStellarSdkPin(pkgWith('14.6.1.1')).ok).toBe(false);
    expect(evaluateStellarSdkPin(pkgWith('14.6.1rc1')).ok).toBe(false);
  });
});

describe('describePinFailure', () => {
  it('names the package and the offending value in the range message', () => {
    const message = describePinFailure({
      reason: 'range',
      declared: '^14.6.1',
    });
    expect(message).toContain(STELLAR_SDK_PACKAGE);
    expect(message).toContain('"^14.6.1"');
    expect(message).toContain('^');
    expect(message).toContain('README.md');
  });

  it('explains that a partial version is a range in disguise', () => {
    expect(
      describePinFailure({ reason: 'partial-version', declared: '14.6' }),
    ).toContain('range in disguise');
  });

  it('explains that a dist-tag floats at install time', () => {
    expect(
      describePinFailure({ reason: 'dist-tag', declared: 'latest' }),
    ).toContain('floats');
  });

  it('reports a missing dependency clearly', () => {
    const message = describePinFailure({ reason: 'missing', declared: '' });
    expect(message).toContain('not listed in "dependencies"');
  });

  it('returns a non-empty message for every rejection reason', () => {
    const reasons = [
      'missing',
      'not-a-string',
      'empty',
      'partial-version',
      'dist-tag',
      'range',
    ] as const;
    for (const reason of reasons) {
      expect(
        describePinFailure({ reason, declared: 'x' }).trim().length,
      ).toBeGreaterThan(0);
    }
  });
});

describe('the repository package.json', () => {
  // Guards against the pin regressing on main without anyone noticing locally.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pkg = require('../package.json') as PackageJsonLike;

  it('pins @stellar/stellar-sdk to an exact version', () => {
    expect(evaluateStellarSdkPin(pkg)).toEqual({ ok: true, version: '17.2.1' });
  });
});
