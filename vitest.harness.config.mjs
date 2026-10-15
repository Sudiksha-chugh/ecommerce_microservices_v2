import {defineConfig} from 'vitest/config';
// Verification control paths only; application integration discovery stays unchanged.
export default defineConfig({test:{include:['scripts/**/*.test.mjs'],maxWorkers:1,environment:'node'}});
