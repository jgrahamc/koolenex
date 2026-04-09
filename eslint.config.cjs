'use strict';
const js = require('@eslint/js');
const prettier = require('eslint-config-prettier');
const tseslint = require('typescript-eslint');

module.exports = [
  js.configs.recommended,
  prettier,
  ...tseslint.configs.recommended.map((cfg) => ({
    ...cfg,
    files: ['server/**/*.ts'],
  })),
  {
    files: ['server/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  // client/ has its own eslint.config.js with React/JSX plugins
  { ignores: ['node_modules/', 'client/'] },
];
