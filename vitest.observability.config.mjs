import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['packages/observability/test/*.proof.ts'],maxWorkers:1,testTimeout:180000,hookTimeout:120000}});
