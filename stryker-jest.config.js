/**
 * Jest config used only by Stryker's mutation-testing run (issue #675,
 * re-confirmed #889 — `npm run test:mutation` drives it against the
 * highest-risk directories configured in stryker.config.json).
 *
 * Stryker drives the test runner itself, so this config is deliberately
 * narrower than the project's own `package.json` jest block: unit specs only,
 * no coverage thresholds (Stryker needs raw pass/fail per test), and no
 * e2e suite. Keeping it separate means `npm test` and `npm run test:cov` are
 * unaffected by the mutation run and vice versa.
 */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'CommonJS',
          moduleResolution: 'node16',
          resolvePackageJsonExports: false,
        },
        isolatedModules: true,
      },
    ],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
