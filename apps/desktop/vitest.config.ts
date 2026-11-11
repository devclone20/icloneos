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

// v0.0.7 lead decision (DECISOES_LEAD 06:35Z): files whose tests start a stream on the real fseventsd, or race the app's
// 2 s canary timeout, ran past their bounds under 8 parallel workers (each red passed alone every time). They run here, one file at
// a time, in a later sequence group, so they never share the machine with the parallel suite. Found by grep and by a
// probe that logged every real addon start() in a full run; hardlinks-fsevents.barrier uses only fakes but races the
// canary timeout. The perf-v007 hard-link files use the real source and are skipped unless ICLONE_PERF_V007=1.
// A new test that starts a real stream (the addon, the default source, or a guard without `fsEvents`) is listed here.
const FSEVENTS_FILES = [
  'electron/iclone-confinement/iclone-fsevents.addon.test.ts',
  'electron/iclone-confinement/hardlinks-fsevents.barrier.test.ts',
  'electron/iclone-confinement/hardlinks.fsevents.test.ts',
  'electron/iclone-confinement/hardlinks.test.ts',
  'electron/iclone-confinement/hardlinks.async.test.ts',
  'electron/iclone-confinement/hardlink.live.test.ts',
  'electron/iclone-confinement/git-config.live.test.ts',
  'electron/iclone-confinement/loopback.live.test.ts',
  'electron/iclone-confinement/seatbelt.live.test.ts',
  'electron/perf-v007/hardlink-*.perf.test.ts'
]

const electronNative: TestProjectConfiguration = {
  test: {
    name: 'electron',
    environment: 'node',
    // Many tests here do real file and process work with nothing to wait for. In a full run at load 30 a test taking
    // 100 ms alone took 7 s, past the 5 s default, and which test it hit changed from run to run. A hung test still fails.
    testTimeout: 30_000,
    include: ['electron/**/*.test.ts', 'scripts/**.test.{ts,mjs}'],
    exclude: ['scripts/run-short-session-hang-repro.test.mjs', ...FSEVENTS_FILES]
  }
}

const electronFsevents: TestProjectConfiguration = {
  test: {
    ...electronNative.test,
    name: 'electron-fsevents',
    include: FSEVENTS_FILES,
    exclude: [],
    fileParallelism: false,
    sequence: { groupOrder: 1 }
  }
}

// K105: wall-clock budgets (pane-bus G1, Seatbelt G7, refusal latency R2) run only here, never in the default run:
// `npm run test:perf` (ICLONE_PERF=1). In the default run the same tests check correctness on fewer iterations and
// skip the budget; `npm run test:perf` selects the tests named `… @perf` (-t), full size, and a loaded machine reports SKIP(load)
// (electron/perf-gate.test-helpers.ts). A new perf test's file is listed below.
const PERF_FILES = [
  'electron/iclone-pane-bus/broker.test.ts',
  'electron/iclone-pane-bus/transport.test.ts',
  'electron/iclone-confinement/seatbelt.live.test.ts',
  'electron/iclone-permissions/audit-scale.test.ts'
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
    projects: process.env.ICLONE_PERF === '1' ? [reactUi, electronNative, electronFsevents, perf] : [reactUi, electronNative, electronFsevents]
  }
})
