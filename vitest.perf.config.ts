import { defineConfig } from 'vitest/config';

// Load, soak, CPU and stress tests (cases 1.2-T4..T7). Slow; run on demand.
// One fork, files in sequence, so measurements don't compete for CPU.
export default defineConfig({
    test: {
        include: ['test/perf/**/*.perf.ts'],
        pool: 'forks',
        poolOptions: { forks: { singleFork: true, execArgv: ['--expose-gc'] } },
        fileParallelism: false,
        testTimeout: 4 * 60 * 60 * 1000,
        hookTimeout: 60 * 1000,
    },
});
