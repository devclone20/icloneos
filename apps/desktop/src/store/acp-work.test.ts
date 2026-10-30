import { afterEach, describe, expect, it, vi } from 'vitest'

import { workViewFixture } from '@/app/home/econ/market/work/fixture'

import { $acpWork, $acpWorkNotice, isWorkView, runWorkAction, watchWork } from './acp-work'

function installBridge() {
  let changed: ((slug: unknown) => void) | null = null

  const bridge = {
    state: vi.fn((slug: string) => Promise.resolve(workViewFixture({ slug }))),
    refresh: vi.fn((slug: string) => Promise.resolve(workViewFixture({ slug }))),
    setLevel: vi.fn(() => Promise.resolve({ ok: false as const, error: 'gesture' as const })),
    online: vi.fn(() => Promise.resolve({ ok: true as const })),
    offline: vi.fn(() =>
      Promise.resolve({ ok: true as const, open: [{ jobId: '2', status: 'funded' }], escrowMicros: 2_000_000 })
    ),
    reboot: vi.fn(() => Promise.resolve({ ok: true as const })),
    approve: vi.fn(() => Promise.resolve({ ok: true as const })),
    decline: vi.fn(() => Promise.resolve({ ok: true as const })),
    onChanged: vi.fn((callback: (slug: unknown) => void) => {
      changed = callback

      return () => {
        changed = null
      }
    })
  }

  Object.assign(window, { hermesDesktop: { ...(window.hermesDesktop ?? {}), icloneAcpWork: bridge } })

  return { bridge, fire: (slug: unknown) => changed?.(slug), attached: () => changed !== null }
}

afterEach(() => {
  $acpWork.set({})
  $acpWorkNotice.set({})
})

describe('the WORK store', () => {
  it('checks the shape of what main sends', () => {
    expect(isWorkView(workViewFixture())).toBe(true)
    expect(isWorkView({ slug: 'x', state: 'dancing' })).toBe(false)
    expect(isWorkView(null)).toBe(false)
  })

  it('reads on watch, re-reads when main says the slug changed, and lets go of the listener', async () => {
    const { bridge, fire, attached } = installBridge()
    const stop = watchWork('robinhood-1')

    await vi.waitFor(() => expect($acpWork.get()['robinhood-1']).toBeDefined())
    fire('robinhood-1')
    fire('someone-else')
    await vi.waitFor(() => expect(bridge.state).toHaveBeenCalledTimes(2))
    stop()
    expect(attached()).toBe(false)
  })

  it('an honest stop report and a refusal become the notice', async () => {
    const { bridge } = installBridge()

    await runWorkAction('robinhood-1', api => api.offline('robinhood-1'))
    expect($acpWorkNotice.get()['robinhood-1']).toMatchObject({ kind: 'stop', report: { open: [{ jobId: '2' }] } })
    await runWorkAction('robinhood-1', api => api.setLevel('robinhood-1', 'L2'))
    expect($acpWorkNotice.get()['robinhood-1']).toMatchObject({ kind: 'error', result: { error: 'gesture' } })
    expect(bridge.setLevel).toHaveBeenCalledWith('robinhood-1', 'L2')
  })
})
