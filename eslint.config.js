import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'test-results', 'playwright-report'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, chrome: 'readonly' } },
    rules: {
      'no-console': ['warn', { allow: ['error', 'warn'] }],
      // noUncheckedIndexedAccess makes `!` necessary after explicit presence checks.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // `_`-prefixed bindings omit keys when destructuring.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { varsIgnorePattern: '^_', argsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/**/*.tsx', 'tests/unit/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ['tests/**', '*.config.ts'],
    languageOptions: { globals: globals.node },
  },
);
