import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    // Sockets bind real ports; keep suites from racing each other on them.
    pool: 'forks',
    testTimeout: 15_000,
  },
})
