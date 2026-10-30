import { beforeEach, describe, expect, it, vi } from 'vitest'

import { dismissNotification, notify } from '@/store/notifications'

import type { CompactOutcome } from './compact-outcome'
import { compactCopy } from './compact.copy'
import { presentCompactionOutcome } from './present-compaction'

vi.mock('@/store/notifications', () => ({ dismissNotification: vi.fn(), notify: vi.fn() }))

const NOTICE = 'session-compress:rt-1'

function present(outcome: Omit<CompactOutcome, 'sessionId'>) {
  const render = vi.fn<(text: string) => void>()

  presentCompactionOutcome({ sessionId: 'rt-1', ...outcome }, NOTICE, render)

  return { render, toast: vi.mocked(notify).mock.calls.at(-1)?.[0] }
}

beforeEach(() => {
  vi.mocked(notify).mockClear()
  vi.mocked(dismissNotification).mockClear()
})

describe('presentCompactionOutcome', () => {
  it('renders the runtime summary and toasts it for a compaction', () => {
    const { render, toast } = present({
      headline: 'Compressed: 61 → 9 messages',
      kind: 'compacted',
      tokenLine: '142k → 38k'
    })

    expect(render).toHaveBeenCalledWith('Compressed: 61 → 9 messages\n142k → 38k')
    expect(toast).toMatchObject({ id: NOTICE, kind: 'success' })
  })

  it('keeps an aborted run out of the transcript: nothing changed', () => {
    const { render, toast } = present({ headline: 'Compaction aborted', kind: 'aborted' })

    expect(render).not.toHaveBeenCalled()
    expect(toast).toMatchObject({ kind: 'error', message: 'Compaction aborted' })
  })

  it('toasts an aborted run without a headline as an error and writes no transcript line', () => {
    const { render, toast } = present({ kind: 'aborted' })

    expect(render).not.toHaveBeenCalled()
    expect(toast).toMatchObject({ id: NOTICE, kind: 'error', message: compactCopy.aborted })
  })

  it('records a refusal without a headline as would-grow, never as nothing to compress', () => {
    const { render, toast } = present({ kind: 'refused', removed: 0 })

    expect(render).toHaveBeenCalledWith(compactCopy.wouldGrow)
    expect(render).not.toHaveBeenCalledWith(compactCopy.nothingToCompress)
    expect(toast).toMatchObject({ id: NOTICE, kind: 'warning', message: compactCopy.wouldGrow })
  })

  it('reports the removed count for a fallback answer without a headline', () => {
    const { render, toast } = present({ kind: 'fallback', removed: 7 })

    expect(render).toHaveBeenCalledWith(compactCopy.compactedMessages(7))
    expect(toast).toMatchObject({ kind: 'success' })
  })

  it('says a held lock out loud instead of reporting nothing to compress', () => {
    const { render, toast } = present({ kind: 'lock_held' })

    expect(render).toHaveBeenCalledWith(compactCopy.lockHeld)
    expect(toast).toMatchObject({ kind: 'warning', message: compactCopy.lockHeld })
  })

  it('writes errors as an error line and drops the progress notice', () => {
    const { render } = present({ kind: 'error', message: 'session busy' })

    expect(render).toHaveBeenCalledWith(compactCopy.errorLine('session busy'))
    expect(dismissNotification).toHaveBeenCalledWith(NOTICE)
    expect(notify).not.toHaveBeenCalled()
  })

  it('leaves unsupported to the caller', () => {
    const { render } = present({ kind: 'unsupported' })

    expect(render).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(dismissNotification).toHaveBeenCalledWith(NOTICE)
  })
})
