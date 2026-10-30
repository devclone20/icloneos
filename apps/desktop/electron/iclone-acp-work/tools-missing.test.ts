// REL-6 (ruling 26): WORK while the ACP tools are not installed (or do not verify). The listener engine stops at the
// first refusal instead of retrying every minute, the supervisor names the real cause (not "needs sign-in"), and the
// fix says what the owner does. Going online is refused up front (iclone-acp.tools-gate.test.ts covers the wiring).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { on: () => undefined }, ipcMain: { handle: () => undefined } }))

import type { SupervisorState, WorkFixView } from '../../src/iclone-shared/acp-work'

import { actionFor } from './fixes'
import { createSupervisor } from './supervisor'

const SLUG = 'robinhood-1'
const REASON = 'ACP tools are not installed: install them from ACP Market (downloads from npm)'

const flush = async () => {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

function harness(toolsProblem: () => string | null, terminal: boolean) {
  const states: SupervisorState[] = []
  const fixes: WorkFixView[] = []
  let starts = 0

  const supervisor = createSupervisor({
    start: () => {
      starts += 1

      return Promise.resolve({ error: REASON, terminal })
    },
    toolsProblem,
    streaming: new Set(),
    keychainPromptShowing: () => false,
    yieldWindowWatch: () => undefined,
    emit: () => undefined,
    onState: (_slug, state) => states.push(state),
    onFix: (_slug, fix) => fixes.push(fix),
    log: () => undefined
  })

  return { supervisor, states, fixes, starts: () => starts }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('WORK without the ACP tools', () => {
  it('a terminal refusal stops the listener at once: failed, cause tools-missing, no retry', async () => {
    const h = harness(() => REASON, true)

    h.supervisor.online(SLUG)
    await flush()
    await vi.advanceTimersByTimeAsync(5 * 60_000)

    expect(h.starts()).toBe(1)
    expect(h.supervisor.state(SLUG)).toBe('failed')
    expect(h.fixes.map(fix => [fix.cause, fix.tried])).toEqual([['tools-missing', 'stopped-for-tools']])
  })

  it('negative control: the same refusal without `terminal` is retried with backoff', async () => {
    const h = harness(() => REASON, false)

    h.supervisor.online(SLUG)
    await flush()
    await vi.advanceTimersByTimeAsync(5 * 60_000)

    expect(h.starts()).toBeGreaterThan(1)
  })

  it('a stop the tools do not explain is still a sign-in stop', () => {
    expect(actionFor('needs-sign-in')).toBe('stopped-for-sign-in')
    expect(actionFor('tools-missing')).toBe('stopped-for-tools')
  })
})
