import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Suites share local PostgreSQL/RabbitMQ capacity. Serialize files; scenario-level concurrency remains real.
  test: { setupFiles: process.env.INTEGRATION_DIAGNOSTICS_FILE ? ['./test/integration-timing.ts'] : [], maxWorkers: 1, environment: 'node', include: ['apps/**/test/**/*.test.ts', 'packages/**/test/**/*.test.ts'] },
});
