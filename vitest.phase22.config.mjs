import {defineConfig} from 'vitest/config';
export default defineConfig({test:{environment:'node',maxWorkers:1,include:['packages/resilience-testing/test/**/*.test.ts','tests/contracts/**/*.test.ts','tests/resilience/**/*.test.ts']}});
