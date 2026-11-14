import { configDefaults, defineConfig } from 'vitest/config';

// Vitest reads this file instead of vite.config.ts. Under VITEST that file adds no playcanvas alias,
// so none is set here either: tests keep the package's default (debug) engine build.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '.claude/**'],
    pool: 'forks',
  },
});
