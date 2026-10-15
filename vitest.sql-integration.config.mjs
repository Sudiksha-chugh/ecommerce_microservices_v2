import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['packages/observability/test/sql/*.integration.ts'],maxWorkers:1,testTimeout:10000,hookTimeout:30000}});
