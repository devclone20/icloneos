import { act, cleanup, render } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePromptActions } from '@/app/session/hooks/use-prompt-actions'
import { clearSingleFlightSessionResumeState } from '@/app/session/hooks/use-prompt-actions/single-flight-resume'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $clarifyRequests, setClarifyRequest } from '@/store/clarify'
import { $composerAttachments, type ComposerAttachment } from '@/store/composer'
import { $queuedPromptsBySession, getQueuedPrompts } from '@/store/composer-queue'
import { clearAllPrompts, setApprovalRequest, setSecretRequest, setSudoRequest } from '@/store/prompts'
import { setSessions } from '@/store/session'
import { $sessionStates, dropSessionState, publishSessionState } from '@/store/session-states'
import type { SessionInfo } from '@/types/hermes'

import { sendPetPrompt } from './pet-prompt-send'
import type { PetPromptTarget } from './pet-prompt-target'

vi.mock('@/hermes', () => ({
  getProfiles: vi.fn(async () => ({ profiles: [] })),
  getSession: vi.fn(),
  PROMPT_SUBMIT_REQUEST_TIMEOUT_MS: 1_800_000,
  setApiRequestProfile: vi.fn(),
  transcribeAudio: vi.fn()
}))

vi.mock('@/store/gateway', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestGatewayForAgent: vi.fn()
}))

const RT = 'rt-pet-1'
const STORED = 'stored-pet-1'
const ROOT = 'root-pet-1'
const CHIP: ComposerAttachment = { id: 'file:plan.pdf', kind: 'file', label: 'plan.pdf', path: '/Users/me/plan.pdf' }

const onScreen =
  (over: Partial<PetPromptTarget> = {}) =>
  () => ({
    busy: false,
    runtimeId: RT,
    storedId: STORED,
    ...over
  })

function busyState(busy: boolean) {
  return { ...createClientSessionState(), busy } as never
}

beforeEach(() => {
  clearSingleFlightSessionResumeState()
  $queuedPromptsBySession.set({})
  $clarifyRequests.set({})
  $composerAttachments.set([])
  setSessions(() => [])
})

afterEach(() => {
  cleanup()
  clearAllPrompts()
  dropSessionState(RT)
  $queuedPromptsBySession.set({})
  $clarifyRequests.set({})
  $composerAttachments.set([])
  setSessions(() => [])
  window.localStorage.clear()
})

describe('the pet box sends only a normal message to the session on screen (R3-S, gate P7)', () => {
  it('an idle session: the composer send, with attachments [] — sent', async () => {
    const submitText = vi.fn(async () => true)

    await expect(sendPetPrompt('  ship the fix  ', { submitText, target: onScreen() })).resolves.toEqual({
      outcome: 'sent'
    })
    expect(submitText).toHaveBeenCalledTimes(1)
    expect(submitText).toHaveBeenCalledWith('ship the fix', { attachments: [] })
  })

  it('a slash command is refused (no composer send, nothing queued) — the text stays in the box', async () => {
    const submitText = vi.fn(async () => true)

    for (const text of ['/yolo', '/new', '/branch here', '/handoff claude', '  /compress  ', '/skill:do it']) {
      await expect(sendPetPrompt(text, { submitText, target: onScreen() })).resolves.toEqual({
        outcome: 'refused',
        reason: 'command'
      })
    }

    // Busy as well: a command is never queued either.
    publishSessionState(RT, busyState(true))
    await expect(sendPetPrompt('/yolo', { submitText, target: onScreen() })).resolves.toMatchObject({
      reason: 'command'
    })
    expect(submitText).not.toHaveBeenCalled()
    expect($queuedPromptsBySession.get()).toEqual({})
    // A path is a message, not a command.
    await expect(sendPetPrompt('/Users/me/notes.md looks off', { submitText, target: onScreen() })).resolves.toEqual({
      outcome: 'queued'
    })
  })

  it('no session on screen (a new-chat draft): refused, nothing sent, nothing queued', async () => {
    const submitText = vi.fn(async () => true)
    const target = onScreen({ runtimeId: null, storedId: null })

    await expect(sendPetPrompt('hello', { submitText, target })).resolves.toEqual({
      outcome: 'refused',
      reason: 'no-session'
    })
    expect(submitText).not.toHaveBeenCalled()
    expect($queuedPromptsBySession.get()).toEqual({})
  })

  it('busy: the message joins the composer queue of that session (its lineage key), never dropped', async () => {
    const submitText = vi.fn(async () => true)
    setSessions(() => [{ _lineage_root_id: ROOT, id: STORED } as SessionInfo])
    publishSessionState(RT, busyState(true))

    await expect(sendPetPrompt(' and add a test ', { submitText, target: onScreen() })).resolves.toEqual({
      outcome: 'queued'
    })
    expect(submitText).not.toHaveBeenCalled()
    expect(getQueuedPrompts(ROOT).map(e => [e.text, e.attachments])).toEqual([['and add a test', []]])

    // No runtime yet (a stored session still resuming): the foreground busy flag decides, the stored id keys it.
    setSessions(() => [])
    await expect(
      sendPetPrompt('second', { submitText, target: onScreen({ busy: true, runtimeId: null }) })
    ).resolves.toEqual({ outcome: 'queued' })
    expect(getQueuedPrompts(STORED).map(e => e.text)).toEqual(['second'])
  })

  it('waiting on a clarify: queued behind it, not sent into the parked turn', async () => {
    const submitText = vi.fn(async () => true)
    expect($sessionStates.get()[RT]).toBeUndefined()
    setClarifyRequest({ choices: ['a', 'b'], multiSelect: false, question: 'which?', requestId: 'c1', sessionId: RT })

    await expect(sendPetPrompt('neither, use c', { submitText, target: onScreen() })).resolves.toEqual({
      outcome: 'queued'
    })
    expect(submitText).not.toHaveBeenCalled()
    expect(getQueuedPrompts(STORED).map(e => e.text)).toEqual(['neither, use c'])
  })

  it('an idle session parked on an approval, a sudo or a secret: queued behind it, never submitted (R3b n-B)', async () => {
    // Typing cannot answer these prompts, so the message waits as the next turn — not sent into the parked one.
    const parkOn = [
      () => setApprovalRequest({ command: 'rm -rf build', description: 'delete build', sessionId: RT }),
      () => setSudoRequest({ requestId: 'sudo-1', sessionId: RT }),
      () => setSecretRequest({ envVar: 'API_KEY', prompt: 'key?', requestId: 'secret-1', sessionId: RT })
    ]

    for (const [i, park] of parkOn.entries()) {
      clearAllPrompts()
      $queuedPromptsBySession.set({})
      $composerAttachments.set([CHIP])
      park()
      const submitText = vi.fn(async () => true)
      expect($sessionStates.get()[RT]).toBeUndefined()

      await expect(sendPetPrompt(`after prompt ${i}`, { submitText, target: onScreen() })).resolves.toEqual({
        outcome: 'queued'
      })
      expect(submitText).not.toHaveBeenCalled()
      expect(getQueuedPrompts(STORED).map(e => [e.text, e.attachments])).toEqual([[`after prompt ${i}`, []]])
      expect($composerAttachments.get()).toEqual([CHIP])
    }

    // A prompt parked on another session does not hold this one: sent.
    clearAllPrompts()
    setApprovalRequest({ command: 'ls', description: 'list', sessionId: 'rt-other' })
    const submitText = vi.fn(async () => true)
    await expect(sendPetPrompt('go', { submitText, target: onScreen() })).resolves.toEqual({ outcome: 'sent' })
    expect(submitText).toHaveBeenCalledTimes(1)
  })

  it('a send that does not land (false or a throw) is refused, so the box keeps the text', async () => {
    await expect(sendPetPrompt('x', { submitText: async () => false, target: onScreen() })).resolves.toEqual({
      outcome: 'refused',
      reason: 'not-sent'
    })
    await expect(
      sendPetPrompt('x', {
        submitText: async () => {
          throw new Error('gateway down')
        },
        target: onScreen()
      })
    ).resolves.toMatchObject({ reason: 'not-sent' })
    await expect(sendPetPrompt('x', { target: onScreen() })).resolves.toMatchObject({ reason: 'not-sent' })
    await expect(sendPetPrompt('   ', { submitText: async () => true, target: onScreen() })).resolves.toMatchObject({
      reason: 'not-sent'
    })
  })
})

describe('main hears of the hand-off before the text leaves (R4-F2, gate P7)', () => {
  it('sent: the hand-off is awaited BEFORE the composer send starts', async () => {
    const order: string[] = []

    let release: () => void = () => {}
    const handOff = vi.fn(() => new Promise<boolean>(r => (release = () => (order.push('handed-off'), r(true)))))
    const submitText = vi.fn(async () => (order.push('submit'), true))

    const reply = sendPetPrompt('ship it', { handOff, submitText, target: onScreen() })
    await Promise.resolve()
    expect(handOff).toHaveBeenCalledTimes(1)
    expect(submitText).not.toHaveBeenCalled() // nothing leaves until main has recorded the hand-off
    release()
    await expect(reply).resolves.toEqual({ outcome: 'sent' })
    expect(order).toEqual(['handed-off', 'submit'])
  })

  it('queued: the hand-off comes before the queue takes it', async () => {
    publishSessionState(RT, busyState(true))
    let queuedAtHandOff = -1

    const handOff = vi.fn(async () => {
      queuedAtHandOff = getQueuedPrompts(STORED).length
    })

    await expect(sendPetPrompt('later', { handOff, submitText: vi.fn(), target: onScreen() })).resolves.toEqual({
      outcome: 'queued'
    })
    expect(queuedAtHandOff).toBe(0)
    expect(getQueuedPrompts(STORED).map(p => p.text)).toEqual(['later'])
  })

  it('refused before anything leaves (a command, no session): no hand-off at all', async () => {
    const handOff = vi.fn(async () => true)
    const submitText = vi.fn(async () => true)

    await sendPetPrompt('/new', { handOff, submitText, target: onScreen() })
    await sendPetPrompt('hi', { handOff, submitText, target: onScreen({ runtimeId: null, storedId: null }) })
    expect(handOff).not.toHaveBeenCalled()
    expect(submitText).not.toHaveBeenCalled()
  })

  it('the hand-off failing (main gone): refused not-sent, and nothing is sent or queued — that is the truth', async () => {
    const submitText = vi.fn(async () => true)

    const handOff = vi.fn(async () => {
      throw new Error('no main')
    })

    await expect(sendPetPrompt('x', { handOff, submitText, target: onScreen() })).resolves.toEqual({
      outcome: 'refused',
      reason: 'not-sent'
    })
    publishSessionState(RT, busyState(true))
    await expect(sendPetPrompt('y', { handOff, submitText, target: onScreen() })).resolves.toMatchObject({
      reason: 'not-sent'
    })
    expect(submitText).not.toHaveBeenCalled()
    expect(getQueuedPrompts(STORED)).toEqual([])
  })

  it('main answering false (hand-off not recorded: already answered, evicted, wrong sender): refused not-sent, nothing sent or queued (R4b m1)', async () => {
    const submitText = vi.fn(async () => true)
    const handOff = vi.fn(async () => false)

    await expect(sendPetPrompt('x', { handOff, submitText, target: onScreen() })).resolves.toEqual({
      outcome: 'refused',
      reason: 'not-sent'
    })
    publishSessionState(RT, busyState(true))
    await expect(sendPetPrompt('y', { handOff, submitText, target: onScreen() })).resolves.toEqual({
      outcome: 'refused',
      reason: 'not-sent'
    })
    expect(handOff).toHaveBeenCalledTimes(2)
    expect(submitText).not.toHaveBeenCalled()
    expect(getQueuedPrompts(STORED)).toEqual([])
    expect(getQueuedPrompts(ROOT)).toEqual([])
  })

  it('main answering true, or no answer at all (no preload bridge): the text goes on as before', async () => {
    const submitText = vi.fn(async () => true)

    await expect(
      sendPetPrompt('a', { handOff: vi.fn(async () => true), submitText, target: onScreen() })
    ).resolves.toEqual({ outcome: 'sent' })
    await expect(
      sendPetPrompt('b', { handOff: vi.fn(async () => undefined), submitText, target: onScreen() })
    ).resolves.toEqual({ outcome: 'sent' })
    expect(submitText).toHaveBeenCalledTimes(2)
  })
})

/** The app's real composer send (`usePromptActions().submitText`), with a fake gateway. */
function Harness({
  onReady,
  requestGateway
}: {
  onReady: (submit: ReturnType<typeof usePromptActions>['submitText']) => void
  requestGateway: <T>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>
}) {
  const activeSessionIdRef = useRef<null | string>(RT)
  const selectedStoredSessionIdRef = useRef<null | string>(RT)
  const runtimeIdByStoredSessionIdRef = useRef(new Map([[RT, RT]]))
  const stateRef = useRef(createClientSessionState() as never)

  const actions = usePromptActions({
    activeSessionId: RT,
    activeSessionIdRef,
    branchCurrentSession: async () => true,
    busyRef: { current: false },
    createBackendSessionForSend: async () => RT,
    getRoutedStoredSessionId: () => null,
    getRuntimeIdForStoredSession: () => null,
    getRouteToken: () => 'token',
    handleSkinCommand: () => '',
    openMemoryGraph: () => undefined,
    refreshSessions: async () => undefined,
    requestGateway,
    resumeStoredSession: () => undefined,
    runtimeIdByStoredSessionIdRef,
    selectedStoredSessionIdRef,
    startFreshSessionDraft: () => undefined,
    sttEnabled: false,
    updateSessionState: (_sessionId, updater) => {
      stateRef.current = updater(stateRef.current) as never

      return stateRef.current
    }
  })

  useEffect(() => {
    onReady(actions.submitText)
  }, [actions.submitText, onReady])

  return null
}

describe("through the app's real composer send (R3-S)", () => {
  async function realSubmit() {
    const requestGateway = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({}) as never)
    let submit: ReturnType<typeof usePromptActions>['submitText'] | null = null
    await act(async () => {
      render(<Harness onReady={s => (submit = s)} requestGateway={requestGateway} />)
    })

    return { requestGateway, submitText: submit! }
  }

  it("the composer's staged attachments are neither sent nor removed; only the pet's text reaches the session", async () => {
    $composerAttachments.set([CHIP])
    const { requestGateway, submitText } = await realSubmit()
    // As staged once the app has settled (its own upload pass marks the chip): the pet's send must leave it so.
    const staged = $composerAttachments.get()
    expect(staged.map(a => a.id)).toEqual([CHIP.id])
    const callsBefore = requestGateway.mock.calls.length
    let reply: unknown
    await act(async () => {
      reply = await sendPetPrompt('summarise the thread', { submitText, target: onScreen({ storedId: RT }) })
    })

    expect(reply).toEqual({ outcome: 'sent' })
    expect($composerAttachments.get()).toBe(staged)
    // The send's own gateway traffic: one prompt.submit with the text alone, no attachment work at all.
    const sendCalls = requestGateway.mock.calls.slice(callsBefore).map(([method, params]) => [method, params])
    expect(sendCalls).toEqual([['prompt.submit', { session_id: RT, text: 'summarise the thread' }]])
  })

  it('/yolo never reaches the slash dispatcher or the gateway', async () => {
    const { requestGateway, submitText } = await realSubmit()
    let reply: unknown
    await act(async () => {
      reply = await sendPetPrompt('/yolo', { submitText, target: onScreen({ storedId: RT }) })
    })

    expect(reply).toEqual({ outcome: 'refused', reason: 'command' })
    expect(requestGateway).not.toHaveBeenCalled()
  })
})
