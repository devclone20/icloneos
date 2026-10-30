import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { createClientSessionState } from '@/lib/chat-runtime'
import {
  $petActivity,
  $petId,
  $petState,
  $petUnread,
  choosePet,
  derivePetState,
  type PetActivity,
  removePet,
  setPetActivity
} from '@/store/pet'
import { setBusy } from '@/store/session'
import { dropSessionState, publishSessionState } from '@/store/session-states'
import type { RpcEvent } from '@/types/hermes'

import { type MessageStreamHarness, renderMessageStream } from './test-harness'

// Gate P9: every PetActivity signal reaches its state through the REAL message-stream hooks
// (restored from 282eded29f^ after V3-E removed them; no Hermes pet call anywhere).
const SID = 'session-1'
const OTHER = 'session-2'
let stream: MessageStreamHarness
let states: Map<string, ClientSessionState>

function emit(type: RpcEvent['type'], payload: RpcEvent['payload'] = {}, sessionId = SID) {
  act(() => stream.handleEvent({ payload, session_id: sessionId, type }))
}

const QUIET: PetActivity = {
  awaitingInput: false,
  celebrate: false,
  error: false,
  justCompleted: false,
  reasoning: false,
  toolRunning: false
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  choosePet('n2')
  $petActivity.set({ ...QUIET })
  $petUnread.set(false)
  states = new Map()
  stream = renderMessageStream(SID, { states })
})

afterEach(() => {
  cleanup()
  setBusy(false)
  $petActivity.set({})
  removePet()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('activity → state through the message stream (gate P9)', () => {
  it("busy → run (the chat's own busy signal)", () => {
    setBusy(true)
    expect($petState.get()).toBe('run')
  })

  it('reasoning → review, toolRunning → run, and back', () => {
    setBusy(true)
    emit('reasoning.delta', { text: 'hmm' })
    expect($petActivity.get().reasoning).toBe(true)
    expect($petState.get()).toBe('review')

    emit('tool.start', { name: 'terminal', tool_id: 't1' })
    expect($petActivity.get()).toMatchObject({ reasoning: false, toolRunning: true })
    expect($petState.get()).toBe('run')

    emit('tool.complete', { name: 'terminal', tool_id: 't1' })
    expect($petActivity.get().toolRunning).toBe(false)
  })

  it('a turn error → failed (status), then it decays', () => {
    setBusy(true)
    emit('tool.start', { name: 'terminal', tool_id: 't1' })
    emit('error', { message: 'boom' })
    expect($petActivity.get()).toMatchObject({ error: true, toolRunning: false })
    expect($petState.get()).toBe('failed')
    act(() => vi.advanceTimersByTime(1600))
    expect($petActivity.get().error).toBe(false)
  })

  it("an isolated tool failure → failed; a background session's does not reach the pet", () => {
    emit('tool.complete', { error: 'exit 1', name: 'terminal', tool_id: 't1' })
    expect($petState.get()).toBe('failed')
    act(() => vi.advanceTimersByTime(1600))
    emit('tool.complete', { error: 'exit 1', name: 'terminal', tool_id: 't2' }, OTHER)
    expect($petActivity.get().error).toBe(false)
  })

  it('a finished turn → celebrate (jump) for 2.2 s, and the unread marker when the app is not focused', () => {
    vi.spyOn(window.document, 'hasFocus').mockReturnValue(false)
    setBusy(true)
    emit('reasoning.delta', { text: 'x' })
    emit('message.complete', { text: 'done' })
    expect($petActivity.get()).toMatchObject({ celebrate: true, reasoning: false, toolRunning: false })
    expect($petState.get()).toBe('jump')
    expect($petUnread.get()).toBe(true)
    act(() => vi.advanceTimersByTime(2200))
    expect($petActivity.get().celebrate).toBe(false)
  })

  it('answering the pet\'s "your turn" → justCompleted (wave)', () => {
    states.set(SID, { ...createClientSessionState(), needsInput: true })
    emit('tool.complete', { name: 'clarify', tool_id: 'c1' })
    expect($petActivity.get().justCompleted).toBe(true)
    expect($petState.get()).toBe('wave')
    act(() => vi.advanceTimersByTime(1000))
    expect($petState.get()).toBe('idle')
  })

  it('a session parked on the user → awaitingInput (waiting), from the session store the stream writes', () => {
    publishSessionState(SID, { ...createClientSessionState(), needsInput: true })
    expect($petState.get()).toBe('waiting')
    dropSessionState(SID)
    expect($petState.get()).toBe('idle')
  })

  it('a fresh gateway connection drops stranded steady flags (lifecycle)', () => {
    setBusy(true)
    setPetActivity({ reasoning: true, toolRunning: true })
    emit('gateway.ready', {})
    expect($petActivity.get()).toMatchObject({ reasoning: false, toolRunning: false })
  })

  it('every signal maps as derivePetState says (the priority chain)', () => {
    const cases: [PetActivity, string][] = [
      [{ error: true, celebrate: true }, 'failed'],
      [{ celebrate: true, justCompleted: true }, 'jump'],
      [{ justCompleted: true, awaitingInput: true }, 'wave'],
      [{ awaitingInput: true, toolRunning: true }, 'waiting'],
      [{ toolRunning: true, reasoning: true }, 'run'],
      [{ reasoning: true, busy: true }, 'review'],
      [{ busy: true }, 'run'],
      [{}, 'idle']
    ]

    for (const [activity, state] of cases) {
      expect(derivePetState(activity)).toBe(state)
    }
  })

  it('no pet chosen: no beat (so no decay timer) and no unread', () => {
    removePet()
    vi.spyOn(window.document, 'hasFocus').mockReturnValue(false)
    emit('message.complete', { text: 'done' })
    emit('error', { message: 'boom' })
    expect($petUnread.get()).toBe(false)
    expect($petActivity.get()).toMatchObject({ celebrate: false, error: false, justCompleted: false })
  })

  it('a turn run before a pet was chosen leaves no run/review behind for the next turn (m11)', () => {
    removePet()
    setBusy(true)
    emit('reasoning.delta', { text: 'thinking' })
    emit('tool.start', { name: 'terminal', tool_id: 't1' })
    emit('message.complete', { text: 'done' })
    setBusy(false)
    expect($petActivity.get()).toMatchObject({ reasoning: false, toolRunning: false })

    choosePet('n2')
    setBusy(true) // the next turn starts: plain busy, nothing stranded
    expect($petState.get()).toBe('run')
    emit('reasoning.delta', { text: 'now' })
    expect($petState.get()).toBe('review')
  })
})

// K42 (V3-E N1): the runtime still broadcasts `pet.changed` (contract `runtime-contract.generated.ts`), from the
// retired Hermes pet. The desktop's pet is its own (V3-P): the event must be dropped quietly, never drive it.
describe('the runtime pet.changed event (K42)', () => {
  it('is dropped: the chosen pet, its activity and the session state stay as they were, nothing is logged', () => {
    const errors = vi.spyOn(console, 'error')
    const warnings = vi.spyOn(console, 'warn')
    const before = JSON.stringify([$petId.get(), $petActivity.get(), $petUnread.get(), [...states.entries()]])

    emit('pet.changed', { displayName: null, enabled: false, slug: null })
    emit('pet.changed', { displayName: 'Boba', enabled: true, slug: 'boba' })
    act(() => stream.handleEvent({ payload: { enabled: false }, type: 'pet.changed' }))

    expect($petId.get()).toBe('n2')
    expect(JSON.stringify([$petId.get(), $petActivity.get(), $petUnread.get(), [...states.entries()]])).toBe(before)
    expect(stream.latest()).toBeNull()
    expect(errors).not.toHaveBeenCalled()
    expect(warnings).not.toHaveBeenCalled()
  })
})
