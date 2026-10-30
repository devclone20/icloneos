import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import type { JsonRpcGatewayClient } from '@hermes/shared'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { onComposerInsertRequest } from '@/app/chat/composer/focus'
import { I18nProvider } from '@/i18n'
import { $serverRequests, replayOpenRequests, resetServerRequestsForTest } from '@/lib/server-requests'
import { clearClarifyRequest, setClarifyRequest } from '@/store/clarify'
import { $gateway } from '@/store/gateway'
import { $profiles } from '@/store/profile'
import { $activeSessionId, _resetSessionOwnerHintsForTests, setSessionOwnerHint } from '@/store/session'

import { ClarifyTool, readClarifyResult } from './clarify-tool'

// The OWNER-socket seam (`requestForOwnedSession` → `requestForSessionProfile`
// → here). Mocked so the real owner ladder still runs against real fixtures and
// only the dial is observed; the rest of the gateway store stays actual, so
// `$gateway` remains the genuine ambient atom every other test in this file
// drives.
const gatewayMocks = vi.hoisted(() => ({
  requestGatewayForAgent: vi.fn(async () => ({ ok: true }))
}))

vi.mock('@/store/gateway', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  requestGatewayForAgent: gatewayMocks.requestGatewayForAgent
}))

// The live pending card used to require message-running. Tests that exercise
// the pending form force that on; the settle-shift case flips it off.
let messageRunning = true

vi.mock('@assistant-ui/react', () => ({
  useAuiState: () => messageRunning
}))

// Drives the real seam: open clarify requests are replayed through a fake
// gateway, and every answer must leave as that gateway's `respond(id, {result})`
// frame — the socket that delivered the request, so the owner by construction.
const seamRespond = vi.fn((_id: number | string, _outcome: unknown) => true)

const unsubscribe = () => () => {}

const seamGateway = {
  on: unsubscribe,
  onOpen: unsubscribe,
  onServerRequest: unsubscribe,
  request: vi.fn(async () => ({})),
  respond: seamRespond
} as unknown as JsonRpcGatewayClient

function openClarify(id: string, params: Record<string, unknown>) {
  replayOpenRequests(seamGateway, [{ id, method: 'clarify', params }])
}

const answered = (requestId: string, answers: Record<string, null | string>) =>
  [requestId, { result: { answers } }] as const

beforeEach(() => {
  resetServerRequestsForTest()
})

afterEach(() => {
  cleanup()
  clearClarifyRequest()
  resetServerRequestsForTest()
  $activeSessionId.set(null)
  $gateway.set(null)
  messageRunning = true
  vi.clearAllMocks()
  vi.useRealTimers()
})

function clarifyTree(ui: ReactNode) {
  return (
    <I18nProvider configClient={null} initialLocale="en">
      {ui}
    </I18nProvider>
  )
}

function renderClarify(ui: ReactNode) {
  return render(clarifyTree(ui))
}

function settledClarifyProps(
  args: ToolCallMessagePartProps['args'],
  result: ToolCallMessagePartProps['result'],
  toolCallId: string
): ToolCallMessagePartProps {
  return {
    addResult: vi.fn(),
    args,
    argsText: JSON.stringify(args),
    isError: false,
    respondToApproval: vi.fn(),
    result,
    resume: vi.fn(),
    status: { type: 'complete' },
    toolCallId,
    toolName: 'clarify',
    type: 'tool-call'
  }
}

function liveClarifyProps(choices = ['staging', 'production']): ToolCallMessagePartProps {
  const args = { choices, question: 'Which deployment target?' }

  return {
    addResult: vi.fn(),
    args,
    argsText: JSON.stringify(args),
    isError: false,
    respondToApproval: vi.fn(),
    result: undefined,
    resume: vi.fn(),
    status: { type: 'running' },
    toolCallId: 'clarify-live',
    toolName: 'clarify',
    type: 'tool-call'
  }
}

function renderLiveClarify({ multiSelect = false }: { multiSelect?: boolean } = {}) {
  const request = vi.fn().mockResolvedValue({ ok: true })

  $activeSessionId.set('session-1')
  $gateway.set({ request } as never)
  openClarify('request-1', {
    choices: ['staging', 'production'],
    multi_select: multiSelect,
    question: 'Which deployment target?',
    session_id: 'session-1'
  })
  const { rerender } = renderClarify(<ClarifyTool {...liveClarifyProps()} />)

  return { request, rerender, respond: seamRespond }
}

describe('ClarifyTool live card stays mounted across settle', () => {
  it('keeps the question card while the gateway request is open and the turn reports not-running', () => {
    messageRunning = false
    renderLiveClarify()

    expect(screen.getByText('Which deployment target?')).toBeTruthy()
    expect(globalThis.document.querySelector('[data-clarify-choices]')).toBeTruthy()
    expect(globalThis.document.querySelector('[data-clarify-settled]')).toBeNull()
  })

  it('demotes to a tool row when the turn stopped and no request is left to answer', () => {
    messageRunning = false
    $activeSessionId.set('session-1')
    $gateway.set({ request: vi.fn() } as never)
    renderClarify(<ClarifyTool {...liveClarifyProps()} />)

    expect(globalThis.document.querySelector('[data-clarify-choices]')).toBeNull()
    expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull()
  })

  it('holds the card through the gap between answering and the settled result', async () => {
    const { rerender, respond } = renderLiveClarify()

    fireEvent.click(screen.getByRole('button', { name: /staging/ }))
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))

    await waitFor(() => {
      expect(respond).toHaveBeenCalledWith(...answered('request-1', { q0: 'staging' }))
    })

    // tool.complete is what swaps in the settled card; the turn can already
    // read as not-running in that gap.
    messageRunning = false
    rerender(clarifyTree(<ClarifyTool {...liveClarifyProps()} />))

    expect(globalThis.document.querySelector('[data-clarify-choices]')).toBeTruthy()
  })

  it('demotes when the turn is stopped after the card was live but never answered', () => {
    renderLiveClarify()

    expect(globalThis.document.querySelector('[data-clarify-choices]')).toBeTruthy()

    messageRunning = false
    act(() => clearClarifyRequest('request-1', 'session-1'))

    expect(globalThis.document.querySelector('[data-clarify-choices]')).toBeNull()
    expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull()
  })

  it('paints the question from tool args instead of a spinner while request_id is still racing', () => {
    $activeSessionId.set('session-1')
    $gateway.set({ request: vi.fn() } as never)
    renderClarify(<ClarifyTool {...liveClarifyProps()} />)

    expect(screen.getByText('Which deployment target?')).toBeTruthy()
    expect(screen.queryByRole('status', { name: /loading question/i })).toBeNull()
    expect(screen.getByRole('button', { name: /Continue/ }).hasAttribute('disabled')).toBe(true)
  })
})

describe('ClarifyTool choice selection', () => {
  it('selects independently, deselects and submits multi-select choices as a JSON array', async () => {
    const { respond } = renderLiveClarify({ multiSelect: true })
    const staging = screen.getByRole('button', { name: /staging/ })
    const production = screen.getByRole('button', { name: /production/ })

    fireEvent.click(staging)
    fireEvent.click(production)
    expect(staging.getAttribute('aria-pressed')).toBe('true')
    expect(production.getAttribute('aria-pressed')).toBe('true')

    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(staging.getAttribute('aria-pressed')).toBe('true')
    expect(production.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(staging)
    expect(staging.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(staging)

    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))

    await waitFor(() => {
      expect(respond).toHaveBeenCalledWith(...answered('request-1', { q0: JSON.stringify(['production', 'staging']) }))
    })
  })

  it('keeps single-select replacement and plain-string submission', async () => {
    const { respond } = renderLiveClarify()
    const staging = screen.getByRole('button', { name: /staging/ })
    const production = screen.getByRole('button', { name: /production/ })

    fireEvent.click(staging)
    fireEvent.click(production)

    expect(staging.getAttribute('aria-pressed')).toBe('false')
    expect(production.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))

    await waitFor(() => {
      expect(respond).toHaveBeenCalledWith(...answered('request-1', { q0: 'production' }))
    })
  })
})

describe('readClarifyResult', () => {
  it('reads question + user_response from the tool JSON payload', () => {
    expect(
      readClarifyResult({
        question: 'Which target?',
        choices_offered: ['staging', 'prod'],
        user_response: 'staging'
      })
    ).toEqual({
      question: 'Which target?',
      answer: 'staging',
      error: undefined
    })
  })

  it('parses a JSON string result the same way as an object', () => {
    expect(
      readClarifyResult(
        JSON.stringify({
          question: 'Ship it?',
          user_response: 'yes'
        })
      )
    ).toEqual({
      question: 'Ship it?',
      answer: 'yes',
      error: undefined
    })
  })

  it('keeps an empty user_response so Skip can render as skipped', () => {
    expect(readClarifyResult({ question: 'Ok?', user_response: '' })).toEqual({
      question: 'Ok?',
      answer: '',
      error: undefined
    })
  })
})

describe('ClarifyTool settled view', () => {
  it('keeps the question and answer visible after the tool completes', () => {
    renderClarify(
      <ClarifyTool
        {...settledClarifyProps(
          { question: 'Which deployment target?', choices: ['staging', 'prod'] },
          {
            question: 'Which deployment target?',
            choices_offered: ['staging', 'prod'],
            user_response: 'staging'
          },
          'clarify-1'
        )}
      />
    )

    expect(screen.getByText('Which deployment target?')).toBeTruthy()
    expect(screen.getByText('staging')).toBeTruthy()
    expect(globalThis.document.querySelector('[data-clarify-settled]')).toBeTruthy()
    expect(globalThis.document.querySelector('[data-clarify-answer]')?.textContent).toBe('staging')
  })

  it('labels an empty response as Skipped', () => {
    renderClarify(
      <ClarifyTool
        {...settledClarifyProps(
          { question: 'Anything else?' },
          { question: 'Anything else?', user_response: '' },
          'clarify-2'
        )}
      />
    )

    expect(screen.getByText('Anything else?')).toBeTruthy()
    expect(screen.getByText('Skipped')).toBeTruthy()
  })

  it('keeps the original choices visible and clickable after a skip', async () => {
    const inserts: string[] = []

    const stop = onComposerInsertRequest(detail => {
      inserts.push(detail.text)
    })

    try {
      renderClarify(
        <ClarifyTool
          {...settledClarifyProps(
            { question: 'Which deployment target?', choices: ['staging', 'prod'] },
            { question: 'Which deployment target?', user_response: '' },
            'clarify-3'
          )}
        />
      )

      // The skip label renders AND the original options are still on screen.
      expect(screen.getByText('Skipped')).toBeTruthy()
      const group = globalThis.document.querySelector('[data-clarify-late-choices]')
      expect(group).toBeTruthy()
      expect(screen.getByText('staging')).toBeTruthy()
      expect(screen.getByText('prod')).toBeTruthy()

      // Picking one drafts a quoted follow-up into the composer. The insert
      // bus defers dispatch by a macrotask, so flush one tick.
      fireEvent.click(screen.getByText('prod'))
      await new Promise(resolve => window.setTimeout(resolve, 0))

      expect(inserts).toHaveLength(1)
      expect(inserts[0]).toContain('Which deployment target?')
      expect(inserts[0]).toContain('prod')
    } finally {
      stop()
    }
  })

  it('does not render late choices on an answered clarify', () => {
    renderClarify(
      <ClarifyTool
        {...settledClarifyProps(
          { question: 'Which deployment target?', choices: ['staging', 'prod'] },
          { question: 'Which deployment target?', user_response: 'staging' },
          'clarify-4'
        )}
      />
    )

    expect(globalThis.document.querySelector('[data-clarify-late-choices]')).toBeNull()
  })

  it('does not render late choices for a free-text (no-choice) skip', () => {
    renderClarify(
      <ClarifyTool
        {...settledClarifyProps(
          { question: 'Anything else?' },
          { question: 'Anything else?', user_response: '' },
          'clarify-5'
        )}
      />
    )

    expect(globalThis.document.querySelector('[data-clarify-late-choices]')).toBeNull()
  })
})

describe('ClarifyTool keyboard navigation', () => {
  it('cycles through choices and Other with the arrow keys', () => {
    renderLiveClarify()

    const staging = screen.getByRole('button', { name: /staging/ })
    const production = screen.getByRole('button', { name: /production/ })
    const other = screen.getByPlaceholderText(/Other/)

    expect(staging.getAttribute('data-highlighted')).toBe('true')
    expect(staging.getAttribute('aria-current')).toBe('true')
    expect(staging.getAttribute('aria-keyshortcuts')).toBe('A 1')

    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(production.getAttribute('data-highlighted')).toBe('true')

    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(other.closest('label')?.getAttribute('data-highlighted')).toBe('true')
    expect(other.getAttribute('aria-current')).toBe('true')
    expect(other.getAttribute('aria-keyshortcuts')).toBe('C 3')

    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(staging.getAttribute('data-highlighted')).toBe('true')

    fireEvent.keyDown(window, { key: 'ArrowUp' })
    expect(other.closest('label')?.getAttribute('data-highlighted')).toBe('true')
  })

  it('selects by number and confirms the answer with Enter', async () => {
    const { respond } = renderLiveClarify()

    fireEvent.keyDown(window, { key: '2' })
    fireEvent.keyDown(window, { key: 'Enter' })

    await waitFor(() => {
      expect(respond).toHaveBeenCalledWith(...answered('request-1', { q0: 'production' }))
    })
  })

  it('stages a highlighted multi-select choice with Enter and submits it with Continue', async () => {
    const { request, respond } = renderLiveClarify({ multiSelect: true })
    const production = screen.getByRole('button', { name: /production/ })

    fireEvent.keyDown(window, { key: 'ArrowDown' })
    fireEvent.keyDown(window, { key: 'Enter' })

    expect(production.getAttribute('aria-pressed')).toBe('true')
    expect(request).not.toHaveBeenCalled()
    expect(respond).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))

    await waitFor(() => {
      expect(respond).toHaveBeenCalledWith(...answered('request-1', { q0: JSON.stringify(['production']) }))
    })
  })

  it('focuses Other when its number is pressed and leaves typing keys alone', () => {
    renderLiveClarify()

    const other = screen.getByPlaceholderText(/Other/)

    fireEvent.keyDown(window, { key: '3' })
    expect(globalThis.document.activeElement).toBe(other)

    fireEvent.change(other, { target: { value: 'canary' } })
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    expect(globalThis.document.activeElement).toBe(other)
    expect((other as HTMLTextAreaElement).value).toBe('canary')
  })

  it('does not intercept keyboard events while an action button has focus', () => {
    const { request, respond } = renderLiveClarify()
    const skip = screen.getByRole('button', { name: 'Skip' })

    skip.focus()

    expect(fireEvent.keyDown(window, { key: 'Enter' })).toBe(true)
    expect(fireEvent.keyDown(window, { key: 'ArrowDown' })).toBe(true)
    expect(request).not.toHaveBeenCalled()
    expect(respond).not.toHaveBeenCalled()
  })
})

describe('ClarifyTool recommended option', () => {
  it('dims the (Recommended) label and answers with the choice the backend sent', async () => {
    const respond = seamRespond

    $activeSessionId.set('session-1')
    openClarify('request-1', {
      choices: ['staging (Recommended)', 'production'],
      question: 'Which deployment target?',
      session_id: 'session-1'
    })
    renderClarify(<ClarifyTool {...liveClarifyProps(['staging (Recommended)', 'production'])} />)

    const recommended = screen.getByRole('button', { name: /staging/ })

    // The label rides in its own muted span so the option text still reads first.
    expect(recommended.querySelector('.text-\\(--ic-text-2\\)')?.textContent).toBe('(Recommended)')

    fireEvent.click(recommended)
    fireEvent.keyDown(window, { key: 'Enter' })

    // The decorated string goes back verbatim; the tool strips the label before
    // the agent ever sees the answer.
    await waitFor(() => {
      expect(respond).toHaveBeenCalledWith(...answered('request-1', { q0: 'staging (Recommended)' }))
    })
  })
})

describe('ClarifyTool pending marker', () => {
  it('marks a live choices card with its row count so type-to-focus yields exactly its keys', () => {
    renderLiveClarify()

    // `clarifyCardOwnsKey` reads the count off this marker to yield only the
    // shortcuts the card renders (A..N + "Other", 1-9, Enter) and let every
    // other printable through to the composer.
    const card = globalThis.document.querySelector('[data-clarify-choices]')

    expect(card).toBeTruthy()
    expect(Number(card?.getAttribute('data-clarify-choices'))).toBeGreaterThan(0)
  })

  it('does not mark a free-text (no-choice) pending card', () => {
    $activeSessionId.set('session-1')
    $gateway.set({ request: vi.fn().mockResolvedValue({ ok: true }) } as never)
    setClarifyRequest({
      choices: null,
      multiSelect: false,
      question: 'Anything else?',
      requestId: 'request-1',
      sessionId: 'session-1'
    })

    const args = { question: 'Anything else?' }
    renderClarify(
      <ClarifyTool
        addResult={vi.fn()}
        args={args}
        argsText={JSON.stringify(args)}
        isError={false}
        respondToApproval={vi.fn()}
        result={undefined}
        resume={vi.fn()}
        status={{ type: 'running' }}
        toolCallId="clarify-free"
        toolName="clarify"
        type="tool-call"
      />
    )

    // No shortcuts → nothing to protect → composer type-to-focus stays live.
    expect(globalThis.document.querySelector('[data-clarify-choices]')).toBeNull()
  })
})

// ─── Batch (multi-question) clarify ─────────────────────────────────────────

function batchArgs(): { questions: { question: string; choices?: string[] }[] } {
  return {
    questions: [{ choices: ['red', 'blue'], question: 'Color?' }, { question: 'Name?' }]
  }
}

function liveBatchProps(): ToolCallMessagePartProps {
  const args = batchArgs()

  return {
    addResult: vi.fn(),
    args,
    argsText: JSON.stringify(args),
    isError: false,
    respondToApproval: vi.fn(),
    result: undefined,
    resume: vi.fn(),
    status: { type: 'running' },
    toolCallId: 'clarify-batch',
    toolName: 'clarify',
    type: 'tool-call'
  }
}

// The batch card locks a staged answer once the user pauses; tests run the
// pause on a fake clock that still advances, so `waitFor` keeps polling.
function startStagingClock() {
  vi.useFakeTimers({ shouldAdvanceTime: true })
}

async function pauseStaging() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
}

function renderLiveBatch(lockedAnswers?: Record<string, string>, multiSelect = false) {
  // The ambient socket carries the per-question `clarify.lock`s (no owner hint:
  // single-backend); the result frame goes out on the seam's own gateway.
  const request = vi.fn().mockResolvedValue({ remaining: ['q1'], status: 'ok' })

  startStagingClock()
  $activeSessionId.set('session-1')
  $gateway.set({ request } as never)
  openClarify('request-batch', {
    ...(lockedAnswers ? { answers: lockedAnswers } : {}),
    questions: [
      { choices: ['red', 'blue'], multi_select: multiSelect, qid: 'q0', question: 'Color?' },
      { qid: 'q1', question: 'Name?' }
    ],
    session_id: 'session-1'
  })
  renderClarify(<ClarifyTool {...liveBatchProps()} />)

  return { request, respond: seamRespond }
}

describe('ClarifyTool batch card', () => {
  it('renders every question at once', () => {
    renderLiveBatch()

    expect(screen.getByText('Color?')).toBeTruthy()
    expect(screen.getByText('Name?')).toBeTruthy()
    expect(screen.getByText('0 of 2 answered')).toBeTruthy()
  })

  it('stages, keeps the single confirm disabled until all answered, and locks each pick on stage', async () => {
    const { request, respond } = renderLiveBatch()
    const confirm = screen.getByRole('button', { name: /Confirm and continue/ })

    expect((confirm as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /red/ }))
    expect(screen.getByText('1 of 2 answered')).toBeTruthy()
    expect(request).not.toHaveBeenCalled()
    expect((confirm as HTMLButtonElement).disabled).toBe(true)

    // The pause locks the pick server-side long before any confirm.
    await pauseStaging()
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('clarify.lock', {
      answer: 'red',
      question_id: 'q0',
      request_id: 'request-batch'
    })
    expect(respond).not.toHaveBeenCalled()

    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), { target: { value: 'packet' } })
    await pauseStaging()
    expect(screen.getByText('2 of 2 answered')).toBeTruthy()
    // q1 is the last unlocked question: its lock would resolve the request.
    expect(request).toHaveBeenCalledTimes(1)
    expect(respond).not.toHaveBeenCalled()
    expect((confirm as HTMLButtonElement).disabled).toBe(false)
  })

  it('confirm completes the batch with one result after the stage locks', async () => {
    const { request, respond } = renderLiveBatch()

    fireEvent.click(screen.getByRole('button', { name: /red/ }))
    await pauseStaging()
    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), { target: { value: 'packet' } })
    fireEvent.submit(globalThis.document.querySelector('form') as HTMLFormElement)

    await waitFor(() => {
      expect(respond).toHaveBeenCalledTimes(1)
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect(respond).toHaveBeenCalledWith(...answered('request-batch', { q0: 'red', q1: 'packet' }))
    expect(request.mock.invocationCallOrder[0]).toBeLessThan(respond.mock.invocationCallOrder[0])
    expect($serverRequests.get()).toEqual([])
  })

  it('a staged answer stays editable before confirm and re-locks only when it changes', async () => {
    const { request, respond } = renderLiveBatch()

    fireEvent.click(screen.getByRole('button', { name: /red/ }))
    await pauseStaging()
    fireEvent.click(screen.getByRole('button', { name: /blue/ }))
    await pauseStaging()
    fireEvent.click(screen.getByRole('button', { name: /blue/ }))
    await pauseStaging()
    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), { target: { value: 'packet' } })
    fireEvent.submit(globalThis.document.querySelector('form') as HTMLFormElement)

    await waitFor(() => {
      expect(respond).toHaveBeenCalledTimes(1)
    })
    expect(request.mock.calls.map(([, params]) => (params as { answer: string }).answer)).toEqual(['red', 'blue'])
    // The re-pick won: blue, not red.
    expect(respond).toHaveBeenCalledWith(...answered('request-batch', { q0: 'blue', q1: 'packet' }))
  })

  it('retries a failed stage lock on the next stage and never blocks the confirm', async () => {
    const { request, respond } = renderLiveBatch()
    request.mockRejectedValueOnce(new Error('socket closed'))

    fireEvent.click(screen.getByRole('button', { name: /red/ }))
    await pauseStaging()
    expect(request).toHaveBeenCalledTimes(1)

    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), { target: { value: 'packet' } })
    await pauseStaging()
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenLastCalledWith('clarify.lock', {
      answer: 'red',
      question_id: 'q0',
      request_id: 'request-batch'
    })

    fireEvent.click(screen.getByRole('button', { name: /Confirm and continue/ }))
    await waitFor(() => {
      expect(respond).toHaveBeenCalledWith(...answered('request-batch', { q0: 'red', q1: 'packet' }))
    })
  })

  it('keeps the locked answers when the runtime times the batch out before confirm', async () => {
    const { request, respond } = renderLiveBatch()

    fireEvent.click(screen.getByRole('button', { name: /red/ }))
    await pauseStaging()
    expect(request).toHaveBeenCalledWith('clarify.lock', {
      answer: 'red',
      question_id: 'q0',
      request_id: 'request-batch'
    })

    // The runtime's deadline withdraws the request; the answer it locked
    // returns to the agent with the timed-out set. Nothing more is sent.
    act(() => resetServerRequestsForTest())
    await pauseStaging()

    expect(request).toHaveBeenCalledTimes(1)
    expect(respond).not.toHaveBeenCalled()
  })

  it('does not re-lock an answer the server already holds from a reconnect', async () => {
    const { request, respond } = renderLiveBatch({ q0: 'red' })

    await pauseStaging()
    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), { target: { value: 'packet' } })
    await pauseStaging()
    fireEvent.click(screen.getByRole('button', { name: /Confirm and continue/ }))

    await waitFor(() => {
      expect(respond).toHaveBeenCalledWith(...answered('request-batch', { q0: 'red', q1: 'packet' }))
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('pre-stages replayed locked answers from a reconnect', () => {
    renderLiveBatch({ q0: 'red' })

    // The replayed answer counts as staged: one question left to answer.
    expect(screen.getByText('1 of 2 answered')).toBeTruthy()
  })

  it('reselects every choice from a replayed multi-select JSON answer', () => {
    renderLiveBatch({ q0: '["red","blue"]' }, true)

    expect(screen.getByRole('button', { name: /red/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /blue/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('1 of 2 answered')).toBeTruthy()
  })

  it('Skip cancels the whole batch without a question_id', async () => {
    const { request, respond } = renderLiveBatch()

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))

    // A result without `answers` is the protocol's cancel-all.
    await waitFor(() => {
      expect(respond).toHaveBeenCalledWith('request-batch', { result: {} })
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('renders the settled batch with all questions and answers', () => {
    renderClarify(
      <ClarifyTool
        {...settledClarifyProps(
          batchArgs(),
          JSON.stringify({
            responses: [
              { choices_offered: ['red', 'blue'], question: 'Color?', user_response: 'red' },
              { choices_offered: null, question: 'Name?', user_response: '' }
            ]
          }),
          'clarify-batch-settled'
        )}
      />
    )

    expect(screen.getByText('Color?')).toBeTruthy()
    expect(screen.getByText('red')).toBeTruthy()
    expect(screen.getByText('Name?')).toBeTruthy()
    expect(screen.getByText('Skipped')).toBeTruthy()
  })
})

// ─── Owner routing (#91684 client half) ─────────────────────────────────────
// The clarify card used to answer on the AMBIENT socket. That socket follows
// foreground focus, so after a profile / Bot Chat switch it can be profile B
// while the blocking clarify belongs to profile A — the response lands on a
// backend that never held the request and the owner stays blocked until the
// tool times out. The result frame now goes back on the socket that delivered
// the request; the per-question `clarify.lock`s route by request.sessionId.

const OWNER_CONNECTION_ID = 'conn-profile-a'
const OWNER_PROFILE = 'profile-a'

/** Profile A owns the clarify's session; the window has since switched to
 *  profile B, so `$gateway` (ambient) is profile B's socket. */
function armCrossProfileOwner() {
  // Two profiles exist → the ambient gateway is not provably the sole backend,
  // so the legacy single-backend escape hatch stays shut.
  $profiles.set([{ name: OWNER_PROFILE }, { name: 'profile-b' }] as never)
  setSessionOwnerHint('session-a', { connectionId: OWNER_CONNECTION_ID, profile: OWNER_PROFILE })

  const ambient = vi.fn().mockResolvedValue({ ok: true })

  $activeSessionId.set('session-a')
  $gateway.set({ request: ambient } as never)

  return ambient
}

function expectOwnerCall(nth: number, method: string, params: Record<string, unknown>) {
  expect(gatewayMocks.requestGatewayForAgent).toHaveBeenNthCalledWith(
    nth,
    OWNER_CONNECTION_ID,
    OWNER_PROFILE,
    method,
    params
  )
}

const ownerBatchParams = {
  questions: [
    { choices: ['red', 'blue'], qid: 'q0', question: 'Color?' },
    { qid: 'q1', question: 'Name?' }
  ],
  session_id: 'session-a'
}

describe('ClarifyTool owner routing', () => {
  afterEach(() => {
    $profiles.set([])
    _resetSessionOwnerHintsForTests({ storage: true })
    gatewayMocks.requestGatewayForAgent.mockClear()
  })

  it('answers a single clarify on the delivering socket, never profile B ambient', async () => {
    const ambient = armCrossProfileOwner()

    openClarify('request-1', {
      choices: ['staging', 'production'],
      question: 'Which deployment target?',
      session_id: 'session-a'
    })
    renderClarify(<ClarifyTool {...liveClarifyProps()} />)

    fireEvent.click(screen.getByRole('button', { name: /staging/ }))
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))

    await waitFor(() => {
      expect(seamRespond).toHaveBeenCalledTimes(1)
    })
    expect(seamRespond).toHaveBeenCalledWith(...answered('request-1', { q0: 'staging' }))
    expect(gatewayMocks.requestGatewayForAgent).not.toHaveBeenCalled()
    expect(ambient).not.toHaveBeenCalled()
  })

  it('locks the batch on the owner socket, in order, before the result frame', async () => {
    const ambient = armCrossProfileOwner()

    startStagingClock()
    openClarify('request-batch', ownerBatchParams)
    renderClarify(<ClarifyTool {...liveBatchProps()} />)

    fireEvent.click(screen.getByRole('button', { name: /red/ }))
    await pauseStaging()
    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), { target: { value: 'packet' } })
    fireEvent.click(screen.getByRole('button', { name: /Confirm and continue/ }))

    await waitFor(() => {
      expect(seamRespond).toHaveBeenCalledTimes(1)
    })
    expect(gatewayMocks.requestGatewayForAgent).toHaveBeenCalledTimes(1)
    expectOwnerCall(1, 'clarify.lock', { answer: 'red', question_id: 'q0', request_id: 'request-batch' })
    expect(gatewayMocks.requestGatewayForAgent.mock.invocationCallOrder[0]).toBeLessThan(
      seamRespond.mock.invocationCallOrder[0]
    )
    expect(seamRespond).toHaveBeenCalledWith(...answered('request-batch', { q0: 'red', q1: 'packet' }))
    expect(ambient).not.toHaveBeenCalled()
  })

  it('sends a batch skip/cancel on the delivering socket', async () => {
    const ambient = armCrossProfileOwner()

    openClarify('request-batch', ownerBatchParams)
    renderClarify(<ClarifyTool {...liveBatchProps()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))

    await waitFor(() => {
      expect(seamRespond).toHaveBeenCalledTimes(1)
    })
    expect(seamRespond).toHaveBeenCalledWith('request-batch', { result: {} })
    expect(gatewayMocks.requestGatewayForAgent).not.toHaveBeenCalled()
    expect(ambient).not.toHaveBeenCalled()
  })
})
