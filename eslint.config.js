import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'results/', 'data/', 'docs/', 'coverage/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_|^(request|response|next)$' }],
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
