// FIXO CLI — minimal ESLint flat config.
// Phase 0 goal is to establish the gate without breaking. Rules that the
// existing codebase would fail today are set to `warn`, not `error`, so
// CI can pass on first introduction while the warning count is tracked
// and paid down over Phase 4.

import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'vendor/**',
      'src/__tests__/**',
      'scripts/**',
      '**/*.d.ts',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
