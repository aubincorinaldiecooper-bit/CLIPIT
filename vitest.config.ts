import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * The first run after the container has been idle spends its opening
     * seconds warming module transforms, and the two probe tests in
     * modelCapabilities blow the default 5s doing nothing wrong. They then
     * pass on every warm run — a flake that has produced four false alarms.
     * Slow-but-real failures still fail; they just get room to be real.
     */
    testTimeout: 15_000,
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    environment: 'node',
    // Provider suites intentionally change process.env before importing the
    // config singleton. Environment variables are process-global, so collect
    // those files serially and let their afterAll hooks restore every change.
    fileParallelism: false,
  },
});
