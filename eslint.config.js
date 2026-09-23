import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/**', 'node_modules/**', '.atl/**'],
  },
  {
    // Zero-dependency Node scripts shipped inside a packaged skill (see `skills/*/assets/`):
    // never part of the `tsconfig.json` project, so they need Node's own globals declared
    // explicitly rather than picked up from `types: ["node"]`.
    files: ['skills/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
      },
    },
  },
);
