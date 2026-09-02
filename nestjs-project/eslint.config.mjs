// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  // Test files only. Production code under src/ keeps the full strictness of
  // recommendedTypeChecked, and the rules below stay errors there.
  //
  // Why this block exists: the configuration above already turns
  // `no-explicit-any` off, which is the right call for test doubles. But an
  // `as any` mock cannot be *used* without tripping `no-unsafe-assignment` and
  // `no-unsafe-member-access`, so the two settings contradicted each other and
  // `npm run lint` could not reach exit 0. They are demoted to warnings rather
  // than switched off, so the debt stays visible instead of disappearing.
  //
  // `unbound-method` is switched off outright: passing an unbound method to
  // `expect(...)` is how jest assertions are written, the reference is
  // inspected and never called, and typescript-eslint documents this as a
  // known false positive with jest.
  {
    files: [
      '**/*.spec.ts',
      '**/*.integration-spec.ts',
      '**/*.e2e-spec.ts',
      'src/test/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'warn',
    },
  },
);
