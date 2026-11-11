import { defineConfig } from 'vitest/config'

// v0.0.7 PERF gates (electron/perf-v007): `npm run test:perf:v007` (scripts/perf-v007/run-gates.sh: pinned Node 26.8.1
// and the pinned runtime interpreter, so the runtime-integrity gate runs), through iso_env.sh. Only this config turns them on
// (ICLONE_PERF_V007=1); the default electron project skips them. One file at a time in one fork, so no other test
// shares the event loop or the disk the gates measure.
export default defineConfig({
  test: {
    name: 'perf-v007',
    environment: 'node',
    include: ['electron/perf-v007/*.perf.test.ts'],
    env: { ICLONE_PERF_V007: '1' },
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000
  }
})
