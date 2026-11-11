/**
 * v0.0.7 PERF gate on L4-01: the runtime check every gated spawn runs (ensureRuntimeIntegrity, as checkRuntimeIntegrity
 * calls it) on a managed runtime whose Python environment holds 30 000 extra recorded files (~360 MB), the order of a
 * real 329-package environment. Real artifact of the compiled pin, temp trees only.
 *
 *   PERF.rt.cold   a fresh digest cache (every file read and hashed): no turn of the event loop over 16 ms
 *   PERF.rt.warm   the same check again, nothing changed: no turn over 16 ms, no runtime file opened, nothing hashed
 *
 * Never skipped under ICLONE_PERF_V007=1 (CF1): without the pinned interpreter or Node 26.8.1 the first test fails.
 *
 * The longest turn is sampled by a setImmediate chain, which runs once per turn of the loop: a stretch of synchronous
 * work of any kind (hashing, parsing, a sync fs call, a long poll phase) shows up as the gap it holds the chain back.
 */
import fs from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { prepareDependencyInstall, sealRuntimeDependencies } from '../iclone-runtime-closed'
import { DigestCache } from '../iclone-runtime-digest'
import type { IntegrityReport } from '../iclone-runtime-integrity'
import {
  canBuildPinnedArtifact,
  fakeDependencies,
  type RuntimeFixture,
  runtimeFixture
} from '../iclone-runtime-integrity.test-helpers'

import { below, PERF_V007_ENABLED, report } from './gate-helpers'

const FRAME_MS = 16
const PACKAGES = 330
const FILES_PER_PACKAGE = 91
const FILE_BYTES = 12_000
/** Past the digest cache's racy window (2 s): files written this recently are hashed every time, by design. */
const PAST_RACY_WINDOW_MS = 2_100

/** CF1 (critic B-m5): under the PERF run a missing prerequisite FAILS the gate; it never skips. Outside it (the
 *  default electron run) the gate does not run at all. scripts/perf-v007/run-gates.sh supplies both pinned tools. */
const RUNNABLE = process.platform !== 'win32' && canBuildPinnedArtifact()
const SUITE = PERF_V007_ENABLED ? describe : describe.skip

let fx: RuntimeFixture

beforeAll(async () => {
  if (PERF_V007_ENABLED && RUNNABLE) {
    fx = await runtimeFixture()
  }
}, 120_000)

afterAll(async () => {
  if (fx?.tmp) {
    await fs.promises.rm(fx.tmp, { force: true, recursive: true })
  }
}, 300_000)

async function longestTurn<T>(work: () => Promise<T>): Promise<{ maxMs: number; result: T; totalMs: number }> {
  let max = 0
  let last = performance.now()
  let sampling = true

  const tick = () => {
    const at = performance.now()
    max = Math.max(max, at - last)
    last = at

    if (sampling) {
      setImmediate(tick)
    }
  }

  setImmediate(tick)
  const started = performance.now()

  try {
    const result = await work()
    const totalMs = performance.now() - started
    // One more turn: work that never yielded is measured by the tick it held back.
    await new Promise(resolve => setImmediate(resolve))

    return { maxMs: max, result, totalMs }
  } finally {
    sampling = false
  }
}

async function syntheticTree(name: string): Promise<string> {
  const root = await fx.managedTree(name)
  const fresh = prepareDependencyInstall(root)
  const { site } = fakeDependencies(root)
  const body = Buffer.alloc(FILE_BYTES, 0x61)

  for (let p = 0; p < PACKAGES; p++) {
    const dir = path.join(site, `pkg_${p}`, 'sub')
    fs.mkdirSync(dir, { recursive: true })

    for (let f = 0; f < FILES_PER_PACKAGE; f++) {
      body.writeUInt32LE(p * FILES_PER_PACKAGE + f, 0)
      fs.writeFileSync(path.join(dir, `mod_${f}.py`), body)
    }
  }

  sealRuntimeDependencies(root, fresh)

  return root
}

SUITE('PERF L4-01: the runtime check before a spawn never holds the main thread', { timeout: 600_000 }, () => {
  it('its prerequisites are here: the pinned runtime interpreter (ICLONE_RUNTIME_PY) and Node 26.8.1 (run-gates.sh)', () => {
    expect(
      { runnable: RUNNABLE, node: process.version },
      'run the PERF gates with `npm run test:perf:v007` (scripts/perf-v007/run-gates.sh) through iso_env.sh'
    ).toEqual({ runnable: true, node: 'v26.8.1' })
  })

  it.runIf(RUNNABLE)(
    '30k files / ~360 MB: cold and warm, no turn over 16 ms; the warm check opens and hashes nothing',
    async () => {
      const root = await syntheticTree('synthetic')
      const digests = new DigestCache()
      await new Promise(resolve => setTimeout(resolve, PAST_RACY_WINDOW_MS))

      const cold = await longestTurn(() => fx.run(root, { digests }))
      const hashedCold = digests.hashedFiles
      const open = vi.spyOn(fs.promises, 'open')
      let warm: { maxMs: number; result: IntegrityReport; totalMs: number }
      let opened: string[]

      try {
        warm = await longestTurn(() => fx.run(root, { digests }))
        opened = open.mock.calls.map(call => String(call[0])).filter(file => file.startsWith(root))
      } finally {
        open.mockRestore()
      }

      const pass = report(
        'PERF L4-01 runtime integrity',
        [
          below('PERF.rt.cold.longest-turn', cold.maxMs, FRAME_MS),
          below('PERF.rt.warm.longest-turn', warm.maxMs, FRAME_MS)
        ],
        {
          coldTotalMs: Math.round(cold.totalMs),
          files: PACKAGES * FILES_PER_PACKAGE,
          hashedCold,
          hashedWarm: digests.hashedFiles - hashedCold,
          openedWarm: opened.length,
          warmTotalMs: Math.round(warm.totalMs)
        }
      )

      expect(cold.result.action).toBe('verified')
      expect(warm.result.action).toBe('verified')
      expect(hashedCold).toBeGreaterThan(PACKAGES * FILES_PER_PACKAGE)
      expect(digests.hashedFiles).toBe(hashedCold)
      expect(opened).toEqual([])
      expect(pass).toBe(true)
    }
  )
})
