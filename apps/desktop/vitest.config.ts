import type { TestProjectConfiguration } from 'vitest/config'
import { defineConfig } from 'vitest/config'

const reactUi: TestProjectConfiguration = {
  extends: './vite.config.ts',
  test: {
    name: 'ui',
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'vite/**/*.test.ts'],
    globals: true,
    // The first test in each file pays jsdom env init + full module transform,
    // which can exceed vitest's 5000ms default under CI/load. 15s gives the
    // cold start headroom without masking genuinely hung tests.
    testTimeout: 15_000
  }
}

const electronNative: TestProjectConfiguration = {
  test: {
    name: 'electron',
    environment: 'node',
    include: ['electron/**/*.test.ts', 'scripts/**.test.{ts,mjs}'],
    exclude: ['scripts/run-short-session-hang-repro.test.mjs']
  }
}

// K105: wall-clock budgets (pane-bus G1, Seatbelt G7, refusal latency R2) run only here, never in the default run:
// `npm run test:perf` (ICLONE_PERF=1). In the default run the same tests check correctness on fewer iterations and
// skip the budget; `npm run test:perf` selects the tests named `… @perf` (-t), full size, and a loaded machine reports SKIP(load)
// (electron/perf-gate.test-helpers.ts). A new perf test's file is listed below.
const PERF_FILES = [
  'electron/iclone-pane-bus/broker.test.ts',
  'electron/iclone-pane-bus/transport.test.ts',
  'electron/iclone-confinement/seatbelt.live.test.ts'
]

const perf: TestProjectConfiguration = {
  test: {
    name: 'perf',
    environment: 'node',
    include: PERF_FILES,
    fileParallelism: false
  }
}

export default defineConfig({
  test: {
    projects: process.env.ICLONE_PERF === '1' ? [reactUi, electronNative, perf] : [reactUi, electronNative]
  }
})
