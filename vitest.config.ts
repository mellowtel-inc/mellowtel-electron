import { defineConfig } from 'vitest/config';

// Unit + integration tests. Performance tests live in test/perf and run with
// `npm run test:perf` (vitest.perf.config.ts).
export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        exclude: ['test/perf/**', 'node_modules/**', 'dist/**'],
    },
});
