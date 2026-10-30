import { describe, expect, it } from 'vitest'

import type { BackendStatusView } from '../../src/iclone-shared/confinement'

import { containerRefusal, createContainerBackend } from './backend-container'

const NOT_INSTALLED: BackendStatusView = {
  id: 'container',
  status: 'not-installed',
  version: null,
  enforcing: false,
  detail: 'not-installed',
  evidence: '',
  ownerStep: 'install it'
}

const INSTALLED: BackendStatusView = {
  id: 'container',
  status: 'installed',
  version: '1.5.0',
  enforcing: false,
  detail: 'not-wired',
  evidence: '/usr/local/bin/container 1.5.0',
  ownerStep: null
}

const REQUEST = {
  cls: 'project',
  argv: ['ls'],
  cwd: '/',
  projectRoot: null,
  network: false,
  writeProject: false
} as const

describe('container backend — not used in this version', () => {
  const backend = createContainerBackend({ probe: async () => NOT_INSTALLED })

  it('reports not installed through the same seam', async () => {
    expect(await backend.probe()).toMatchObject({ id: 'container', status: 'not-installed' })
  })

  it('refuses every spawn, lists nothing, kills nothing — never falls back to running unconfined', async () => {
    await backend.probe()

    const result = backend.spawn(REQUEST)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/not available in this version of icloneOS: not installed on this Mac/)
    expect(!result.ok && result.error).not.toMatch(/owner step/)
    expect(backend.list({ rows: [{ pid: 1, ppid: 0, pgid: 1, elapsedSec: 1, command: 'x' }], verified: true })).toEqual(
      []
    )
    expect(await backend.kill(5)).toMatchObject({ ok: false, reason: 'not-confined' })
    expect(backend.explain(5, { rows: [], verified: false })[0]).toMatch(/runs nothing in this version/)
  })

  it('K131 — forced with container INSTALLED: still refused, and the refusal never says "not installed"', async () => {
    const installed = createContainerBackend({ probe: async () => INSTALLED })

    await installed.probe()

    const result = installed.spawn(REQUEST)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toBe(
      'Apple container is not available in this version of icloneOS: installed (1.5.0) but not used. The command is refused rather than run unconfined.'
    )
    expect(!result.ok && result.error).not.toMatch(/not installed|owner step/)
    expect(installed.explain(5, { rows: [], verified: false })[0]).not.toMatch(/not installed|owner step/)
  })

  it('K131 — the refusal follows the probe: broken, unsupported, and before any probe', () => {
    expect(containerRefusal({ ...INSTALLED, status: 'broken', version: null, detail: 'no-version' })).toMatch(
      /not available in this version of icloneOS: installed, but its check failed\./
    )
    expect(containerRefusal({ ...NOT_INSTALLED, status: 'unsupported', detail: 'needs-apple-silicon' })).toMatch(
      /: this Mac cannot run it\./
    )
    expect(containerRefusal(null)).toBe(
      'Apple container is not available in this version of icloneOS. The command is refused rather than run unconfined.'
    )
  })
})

describe('G3-3 — the refusal follows every probe, at the same time as the pane', () => {
  it('installed → broken → a probe that throws → timed out: each refusal carries that probe, never an earlier one', async () => {
    const answers: (() => BackendStatusView)[] = [
      () => INSTALLED,
      () => ({ ...INSTALLED, status: 'broken', version: null, detail: 'no-version' }),
      () => {
        throw new Error('probe crashed')
      },
      () => ({ ...INSTALLED, status: 'unknown', version: null, detail: 'probe-timeout' })
    ]

    let next = 0
    const backend = createContainerBackend({ probe: async () => answers[next++]() })
    const refusals: string[] = []

    for (let i = 0; i < answers.length; i += 1) {
      const view = await backend.probe()
      const result = backend.spawn(REQUEST)

      expect(!result.ok && result.error).toBe(containerRefusal(view))
      expect(backend.explain(5, { rows: [], verified: false })[0]).toContain(containerRefusal(view))
      refusals.push(!result.ok ? result.error : '')
    }

    expect(refusals.map(text => text.split(': ')[1])).toEqual([
      'installed (1.5.0) but not used. The command is refused rather than run unconfined.',
      'installed, but its check failed. The command is refused rather than run unconfined.',
      'installed, but its check failed. The command is refused rather than run unconfined.',
      'installed, but its check did not finish in time. The command is refused rather than run unconfined.'
    ])
  })

  it("a probe that throws resolves to the layer's own probe-failed view (never rejects, never keeps the last answer)", async () => {
    let fail = false

    const backend = createContainerBackend({
      probe: async () => {
        if (fail) {
          throw new Error('XPC gone')
        }

        return INSTALLED
      }
    })

    expect(await backend.probe()).toBe(INSTALLED)
    fail = true
    expect(await backend.probe()).toEqual({
      id: 'container',
      status: 'broken',
      version: null,
      enforcing: false,
      detail: 'probe-failed',
      evidence: 'XPC gone',
      ownerStep: null
    })
    expect(backend.spawn(REQUEST)).toEqual({ ok: false, error: containerRefusal(await backend.probe()) })
  })
})

describe('G3 r2 m-3 — overlapping probes: an older answer landing last never replaces a newer one', () => {
  it('the first probe (a timeout) lands after the second (installed): the refusal keeps the newer answer', async () => {
    const pending: ((view: BackendStatusView) => void)[] = []
    const backend = createContainerBackend({ probe: () => new Promise(resolve => pending.push(resolve)) })
    const older = backend.probe()
    const newer = backend.probe()

    pending[1](INSTALLED)
    expect(await newer).toBe(INSTALLED)
    pending[0]({ ...INSTALLED, status: 'unknown', version: null, detail: 'probe-timeout' })
    expect((await older).status).toBe('unknown')

    expect(backend.spawn(REQUEST)).toEqual({ ok: false, error: containerRefusal(INSTALLED) })
    expect(backend.explain(5, { rows: [], verified: false })[0]).toContain(containerRefusal(INSTALLED))
  })
})
