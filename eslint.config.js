import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/', 'data/', 'samples/'] },
  js.configs.recommended,
  { languageOptions: { globals: globals.node } },
  { rules: { 'no-unused-vars': ['error', { ignoreRestSiblings: true }] } },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: tseslint.configs.recommended,
    rules: { '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }] },
  },
  // The integration tests read API answers as they come: `any` is the honest type there.
  { files: ['test/**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
  {
    files: ['packages/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest']],
    languageOptions: { globals: globals.browser },
  },
);
