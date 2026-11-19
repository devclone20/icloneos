/**
 * v0.0.9 pass 4 (correction-session-switch :266, captured live): reopening a session whose turn is still running and
 * was redirected mid-turn painted its prompt and its pre-correction output TWICE. Capture (warm switch, cold resume):
 * the stored transcript already held the turn's rows, persisted when the correction landed (original prompt, the
 * streamed "Hello", the correction), and appendLiveSessionProjection appended the live projection of the SAME turn on
 * top (user-inflight, inflight-assistant-segment). Its "already persisted" walk stopped at the committed "Hello" row.
 * The turn is identified by the gateway's turn_started_at: rows stamped inside the running turn are that turn's,
 * whatever their text. Red before: both duplicate rows were projected.
 */
import { describe, expect, it } from 'vitest'

import { type ChatMessage, chatMessageText } from '@/lib/chat-messages'
import type { SessionResumeResponse } from '@/types/hermes'

import { appendLiveSessionProjection } from './utils'

const T = 1_795_059_040.43
const PROMPT = 'E2E_INFERENCE_SWITCH_TRIGGER: original inference prompt must remain singular.'
const CORRECTION = 'E2E_INFERENCE_SWITCH_TRIGGER: correction sent while inference is live.'

const row = (id: string, role: ChatMessage['role'], text: string, timestamp: number): ChatMessage => ({
  id,
  parts: [{ text, type: 'text' }] as ChatMessage['parts'],
  role,
  timestamp
})

const projection = (over: Partial<NonNullable<SessionResumeResponse['inflight']>> = {}, turnStartedAt: null | number = T) =>
  ({
    inflight: {
      assistant: 'Hello\n\nHello',
      correction_offsets: [5],
      corrections: [CORRECTION],
      streaming: true,
      user: PROMPT,
      ...over
    },
    session_id: 's1',
    turn_started_at: turnStartedAt
  }) as unknown as SessionResumeResponse

const texts = (messages: ChatMessage[]) => messages.map(m => `${m.role}:${chatMessageText(m).trim()}`)
const count = (messages: ChatMessage[], text: string) => messages.filter(m => chatMessageText(m).trim() === text).length

describe('the live projection of a running turn never repeats rows that turn already persisted', () => {
  // Earlier turns, then the running turn as the stored transcript holds it after the correction landed.
  const before = [row('p1', 'user', 'E2E persisted session used for a warm resume.', T - 10), row('p2', 'assistant', 'Earlier reply.', T - 9)]
  const persistedTurn = [row('t1', 'user', PROMPT, T), row('t2', 'assistant', 'Hello', T + 1), row('t3', 'user', CORRECTION, T + 1.0001)]

  it('inference-time correction, then a warm switch: one prompt, one pre-correction segment, the live tail kept', () => {
    const out = appendLiveSessionProjection([...before, ...persistedTurn], projection())

    expect(count(out, PROMPT)).toBe(1)
    expect(count(out, CORRECTION)).toBe(1)
    // The sealed pre-correction 'Hello' once; the live tail is the turn's second, distinct 'Hello'.
    expect(count(out.slice(0, -1), 'Hello')).toBe(1)
    expect(out.at(-1)?.id).toBe('assistant-stream-s1')
    expect(chatMessageText(out.at(-1)!).trim()).toBe('Hello')
    expect(out.slice(0, before.length + persistedTurn.length)).toEqual([...before, ...persistedTurn])
  })

  it('steer during a running tool, then a switch (no offsets): the prompt and correction are not projected again', () => {
    const out = appendLiveSessionProjection(
      [...before, ...persistedTurn],
      projection({ assistant: 'Hello', correction_offsets: undefined })
    )

    expect(count(out, PROMPT)).toBe(1)
    expect(count(out, CORRECTION)).toBe(1)
  })

  it('identical text is not identity: the same prompt in an EARLIER turn does not hide the running one', () => {
    const earlierSamePrompt = [row('e1', 'user', PROMPT, T - 20), row('e2', 'assistant', 'Hello', T - 19)]
    const out = appendLiveSessionProjection([...earlierSamePrompt], projection({ corrections: [], correction_offsets: [] }))

    // The running turn persisted nothing yet: its prompt and reply are projected beside the identical earlier pair.
    expect(count(out, PROMPT)).toBe(2)
    expect(texts(out).filter(t => t === 'assistant:Hello')).toHaveLength(1)
    expect(out.some(m => m.id === 'user-inflight-s1')).toBe(true)
  })

  it('two identical replies in two persisted turns both survive', () => {
    const twoTurns = [
      row('a1', 'user', 'again', T - 30),
      row('a2', 'assistant', 'Same reply.', T - 29),
      row('b1', 'user', 'again', T - 20),
      row('b2', 'assistant', 'Same reply.', T - 19)
    ]
    const out = appendLiveSessionProjection(twoTurns, projection({ assistant: '', corrections: [], streaming: true, user: 'next' }))

    expect(count(out, 'Same reply.')).toBe(2)
    expect(count(out, 'again')).toBe(2)
  })
})
