import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // Empty catch blocks are intentional here — best-effort calls to
      // vibrate/audio/clipboard that must never throw into the UI.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Service worker + Cloudflare Worker run in a worker global scope, not the
    // browser window — give the linter the right globals (self, clients, caches…).
    files: ['public/*.js', 'cloudflare-worker.js'],
    languageOptions: {
      globals: { ...globals.serviceworker, ...globals.worker },
    },
  },
])
