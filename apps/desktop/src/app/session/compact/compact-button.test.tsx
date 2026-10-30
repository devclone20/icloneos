import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatMessage } from '@/lib/chat-messages'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $sessionStates, type SessionTileDelegate, setSessionTileDelegate } from '@/store/session-states'

import { CompactButton } from './compact-button'
import type { CompactOutcome } from './compact-outcome'
import { $compactions, finishCompaction, setCompactionProgress, startCompaction } from './compact-store'
import { compactCopy } from './compact.copy'

const SESSION = 'rt-button'

const message = (role: ChatMessage['role'], index: number) =>
  ({ id: `m${index}`, parts: [{ text: `t${index}`, type: 'text' }], role }) as unknown as ChatMessage

function seed(count: number, overrides: Partial<ReturnType<typeof createClientSessionState>> = {}) {
  const messages = Array.from({ length: count }, (_, index) => message(index % 2 ? 'assistant' : 'user', index))
  $sessionStates.set({ [SESSION]: { ...createClientSessionState('stored-1', messages), ...overrides } })
}

const isDisabled = (element: HTMLElement) => (element as HTMLButtonElement).disabled

function installDelegate(executeSlash: SessionTileDelegate['executeSlash']) {
  setSessionTileDelegate({ executeSlash } as SessionTileDelegate)
}

beforeEach(() => {
  $compactions.set({})
})

afterEach(() => {
  cleanup()
  $sessionStates.set({})
  $compactions.set({})
})

describe('CompactButton', () => {
  it('is disabled with a reason below 4 messages and while a turn runs', () => {
    seed(3, { messages: [message('user', 0), message('assistant', 1), message('system', 2), message('user', 3)] })
    const { rerender } = render(<CompactButton sessionId={SESSION} />)

    expect(isDisabled(screen.getByTestId('compact-session-button'))).toBe(true)
    expect(screen.getByTestId('compact-disabled-reason').textContent).toBe(compactCopy.tooFew)

    seed(8, { busy: true })
    rerender(<CompactButton sessionId={SESSION} />)
    expect(isDisabled(screen.getByTestId('compact-session-button'))).toBe(true)
    expect(screen.getByTestId('compact-disabled-reason').textContent).toBe(compactCopy.busy)
  })

  it('routes a click through /compress once, however many clicks', async () => {
    seed(8)
    let release!: () => void

    const executeSlash = vi.fn(
      (_command: string, sessionId: string) =>
        new Promise<void>(resolve => {
          startCompaction(sessionId)

          release = () => {
            finishCompaction([sessionId], { kind: 'compacted', removed: 6, sessionId })
            resolve()
          }
        })
    )

    installDelegate(executeSlash)
    render(<CompactButton sessionId={SESSION} />)

    const button = screen.getByTestId('compact-session-button')
    fireEvent.click(button)
    fireEvent.click(button)

    expect(executeSlash).toHaveBeenCalledTimes(1)
    expect(executeSlash).toHaveBeenCalledWith('/compress', SESSION)
    expect(isDisabled(button)).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')

    await act(async () => release())
    expect(screen.getByTestId('compact-result').dataset.kind).toBe('compacted')
    expect(isDisabled(screen.getByTestId('compact-session-button'))).toBe(false)
  })

  it('shows the runtime progress line while running', () => {
    seed(8)
    startCompaction(SESSION)
    render(<CompactButton sessionId={SESSION} />)
    expect(screen.getByTestId('compact-progress').textContent).toBe(compactCopy.running)

    act(() => setCompactionProgress(SESSION, '⠋ compressing 12 messages (~30,000 tok)…'))
    expect(screen.getByTestId('compact-progress').textContent).toBe('⠋ compressing 12 messages (~30,000 tok)…')
  })

  it('never leaves a claim spinning when no session could be resolved', async () => {
    seed(8)
    installDelegate(vi.fn(async () => undefined))
    render(<CompactButton sessionId={SESSION} />)

    await act(async () => fireEvent.click(screen.getByTestId('compact-session-button')))

    expect(screen.getByTestId('compact-result').dataset.kind).toBe('error')
    expect(screen.getByText(compactCopy.sessionUnavailable)).toBeTruthy()
  })

  it.each<[CompactOutcome, string]>([
    [
      {
        afterMessages: 9,
        afterTokens: 38_200,
        beforeMessages: 61,
        beforeTokens: 142_000,
        headline: 'Compressed: 61 → 9 messages',
        kind: 'compacted',
        sessionId: SESSION,
        tokenLine: 'Approx request size: ~142,000 → ~38,200 tokens'
      },
      '142.0k → 38.2k tokens · 61 → 9 messages'
    ],
    [{ headline: 'No changes from compression: 3 messages', kind: 'noop', sessionId: SESSION }, compactCopy.noop],
    [
      { headline: 'Compression refused (summary would grow)', kind: 'refused', sessionId: SESSION },
      compactCopy.wouldGrow
    ],
    [
      { headline: 'Compression aborted: 61 messages preserved', kind: 'aborted', sessionId: SESSION },
      compactCopy.aborted
    ],
    [{ kind: 'lock_held', message: 'Compression already running', sessionId: SESSION }, compactCopy.lockHeld],
    [{ kind: 'busy', message: 'session busy', sessionId: SESSION }, compactCopy.busy],
    [{ kind: 'error', message: 'boom', sessionId: SESSION }, compactCopy.error]
  ])('renders a visible result for %#', (outcome, expected) => {
    seed(8)
    finishCompaction([SESSION], outcome)
    render(<CompactButton sessionId={SESSION} />)

    const result = screen.getByTestId('compact-result')
    expect(result.textContent).toContain(expected)
    expect(result.textContent).toContain(outcome.headline ?? outcome.message ?? '')
  })

  it('shows the reduction only for a changed history', () => {
    seed(8)
    finishCompaction([SESSION], { afterTokens: 38_200, beforeTokens: 142_000, kind: 'compacted', sessionId: SESSION })
    render(<CompactButton sessionId={SESSION} />)

    expect(screen.getByTestId('compact-result-delta').textContent).toBe('−73 %')
  })

  it('head variant is an icon button with an accessible name and reason', () => {
    seed(2)
    render(<CompactButton sessionId={SESSION} variant="head" />)

    const button = screen.getByRole('button', { name: compactCopy.button })
    expect(isDisabled(button)).toBe(true)
    expect(button.getAttribute('aria-describedby')).toBeTruthy()
    expect(screen.getByText(compactCopy.tooFew).id).toBe(button.getAttribute('aria-describedby'))
  })
})
