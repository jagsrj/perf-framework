import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'results/', 'data/', 'docs/', 'coverage/'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_|^(request|response|next)$', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error'
    }
  },
  {
    files: ['web/public/**/*.js'],
    languageOptions: { globals: { ...globals.browser } }
  }
];
