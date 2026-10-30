/** K105: the perf project's switch and load guard. */
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

const projectNames = async () => {
  vi.resetModules()

  // A computed path: the config is outside the electron tsconfig, and vitest loads it like any module.
  const file = path.join(__dirname, '..', 'vitest.config.ts')

  const config = ((await import(file)) as { default: unknown }).default as {
    test: { projects: { test: { name: string; include?: string[] } }[] }
  }

  return config.test.projects.map(project => project.test)
}

describe('the perf project (K105)', () => {
  it('the default run has no perf project: no wall-clock budget runs there', async () => {
    vi.stubEnv('ICLONE_PERF', '')

    expect((await projectNames()).map(project => project.name)).toEqual(['ui', 'electron'])
  })

  it('ICLONE_PERF=1 adds it, selecting only the tests named "… @perf"', async () => {
    vi.stubEnv('ICLONE_PERF', '1')

    const perf = (await projectNames()).find(project => project.name === 'perf')

    expect(perf?.include?.length).toBeGreaterThan(0)

    // The documented command (`npm run test:perf` → scripts/test-perf.mjs, K127) selects the "@perf" names and nothing
    // else. A computed path: the script is outside the electron tsconfig.
    const runner = (await import(path.join(__dirname, '..', 'scripts', 'test-perf.mjs'))) as {
      perfVitestArgs: (reportFile: string, extra?: string[]) => string[]
    }

    const argv = runner.perfVitestArgs('/r.json')
    const pattern = argv[argv.indexOf('-t') + 1] ?? ''

    expect(argv.slice(0, 3)).toEqual(['run', '--project', 'perf'])
    // G3-5 (m-A3): exactly the trailing tag, nothing looser — a name that merely contains "perf" is not a @perf test.
    expect(pattern).toBe('@perf$')
    expect(new RegExp(pattern).test('G1 over the socket @perf')).toBe(true)

    for (const name of ['G1 over the socket', 'perf budget', 'G1 perf', 'G1 @perf budget', 'perf @perfx']) {
      expect(new RegExp(pattern).test(name), name).toBe(false)
    }
  })

  it('PERF_TAG tags a test only in the perf project', async () => {
    vi.stubEnv('ICLONE_PERF', '')
    expect((await import('./perf-gate.test-helpers')).PERF_TAG).toBe('')

    vi.resetModules()
    vi.stubEnv('ICLONE_PERF', '1')
    expect((await import('./perf-gate.test-helpers')).PERF_TAG).toBe(' @perf')
  })

  it('a busy machine (load above cores / 2) reports SKIP(load), an idle one measures', async () => {
    const { skipUnderLoad } = await import('./perf-gate.test-helpers')
    const cores = os.cpus().length
    const skip = vi.fn()

    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(os, 'loadavg').mockReturnValue([cores / 2 + 0.5, 0, 0])
    skipUnderLoad({ skip })
    expect(skip).toHaveBeenCalledWith(expect.stringMatching(/^SKIP\(load /))

    skip.mockClear()
    vi.spyOn(os, 'loadavg').mockReturnValue([cores / 2 - 0.5, 0, 0])
    skipUnderLoad({ skip })
    expect(skip).not.toHaveBeenCalled()
  })
})
