// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'eslint.config.mjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // HTTP status codes are plain numbers on the wire; comparing them against Nest's numeric
      // HttpStatus enum is intentional and safe.
      '@typescript-eslint/no-unsafe-enum-comparison': 'off',
      // Money must never be coerced: flag any float parsing that sneaks in.
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Money is a string — never parse it into a float.' },
      ],
    },
  },
  {
    // Supertest hands back `response.body` as `any`; asserting on it is the point of an e2e test.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
);
