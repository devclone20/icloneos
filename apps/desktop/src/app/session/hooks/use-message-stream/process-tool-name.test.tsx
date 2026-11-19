/**
 * v0.0.9 pass 4: the background-process refresh follows the runtime's process tool. The runtime renamed `process` to
 * `process_manage` ('process' is a legacy alias, model_tools.py _LEGACY_TOOL_ALIASES), but tool.complete only
 * refreshed the process registry on `terminal` or `process`: a model reaping or polling a background job through
 * process_manage left the status stack and the row's background dot on the old reading. Red before for
 * process_manage; the legacy name and terminal stay covered.
 */
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type MessageStreamHarness, renderMessageStream } from './test-harness'

const refresh = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock(import('@/store/composer-status'), async importOriginal => ({
  ...(await importOriginal()),
  refreshBackgroundProcesses: refresh
}))

const SID = 'session-process-tool'

let stream: MessageStreamHarness

const complete = (name: string) =>
  act(() =>
    stream.handleEvent({ payload: { name, result: '{}', tool_id: `t-${name}` }, session_id: SID, type: 'tool.complete' } as never)
  )

beforeEach(() => {
  refresh.mockClear()
  stream = renderMessageStream(SID)
})

afterEach(() => cleanup())

describe('tool.complete refreshes the background-process registry', () => {
  it('process_manage (the runtime name) refreshes it', async () => {
    await complete('process_manage')
    expect(refresh).toHaveBeenCalledWith(SID)
  })

  it('process (the legacy name) and terminal still refresh it', async () => {
    await complete('process')
    await complete('terminal')
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('an unrelated tool does not', async () => {
    await complete('read_file')
    expect(refresh).not.toHaveBeenCalled()
  })
})
