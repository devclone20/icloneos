/**
 * v0.0.9 pass 4 (the lead's ruling on interim-messages :184): with display.interim_assistant_messages off, the
 * commentary a model streams beside its tool calls is dropped when the turn completes, and the final answer is kept.
 * Red before: the runtime emits no message.interim with the key off, but the streamed deltas stayed in the bubble
 * between the tool parts, and a final that repeats the whole stream (e2e DIAG: one assistant row, text · tool · text ·
 * tool · text · tool · final) kept every one of them.
 */
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { chatMessageText } from '@/lib/chat-messages'
import { $interimAssistantMessages, setInterimAssistantMessagesFromConfig } from '@/store/interim-assistant-messages'
import { clearSessionTodos } from '@/store/todos'

import { type MessageStreamHarness, renderMessageStream } from './test-harness'

const SID = 'session-interim-off'
const PLAN = 'Let me start by planning the approach.'
const CHECK = 'Now checking the details before answering.'
const FINAL = 'All done! Here is the complete summary.'

let stream: MessageStreamHarness

const event = (type: string, payload: Record<string, unknown>) =>
  act(() => stream.handleEvent({ payload, session_id: SID, type } as never))

async function toolRound(id: string) {
  await event('tool.start', { args: {}, name: 'read_file', tool_id: id })
  await event('tool.complete', { args: {}, name: 'read_file', result: '{}', tool_id: id })
}

/** One turn: commentary, a tool, commentary, a tool, then the final answer, completed with `completion`. */
async function turn(completion: string) {
  await event('message.start', {})
  await event('message.delta', { text: PLAN })
  await toolRound('t1')
  await event('message.delta', { text: CHECK })
  await toolRound('t2')
  await event('message.delta', { text: FINAL })
  await event('message.complete', { text: completion })
}

const visibleText = () =>
  stream
    .state()
    .messages.filter(m => m.role === 'assistant' && !m.hidden)
    .map(m => chatMessageText(m))
    .join('\n')

const toolParts = () =>
  stream
    .state()
    .messages.flatMap(m => m.parts)
    .filter(part => part.type === 'tool-call').length

beforeEach(() => {
  clearSessionTodos(SID)
  stream = renderMessageStream(SID)
})

afterEach(() => {
  cleanup()
  $interimAssistantMessages.set(true)
})

describe('display.interim_assistant_messages: false', () => {
  it('drops the commentary streamed before the tool calls when the final repeats the stream', async () => {
    setInterimAssistantMessagesFromConfig(false)
    await turn(`${PLAN}${CHECK}${FINAL}`)

    expect(visibleText()).not.toContain(PLAN)
    expect(visibleText()).not.toContain(CHECK)
    expect(visibleText()).toContain(FINAL)
    // The tool rows stay: only the commentary goes.
    expect(toolParts()).toBe(2)
  })

  it('keeps the final answer when the final is the answer alone', async () => {
    setInterimAssistantMessagesFromConfig(false)
    await turn(FINAL)

    expect(visibleText()).toContain(FINAL)
    expect(visibleText()).not.toContain(PLAN)
  })

  it('a turn without tool calls keeps all of its text', async () => {
    setInterimAssistantMessagesFromConfig(false)
    await event('message.start', {})
    await event('message.delta', { text: FINAL })
    await event('message.complete', { text: FINAL })

    expect(visibleText()).toContain(FINAL)
  })
})

describe('display.interim_assistant_messages: true (the default)', () => {
  it('keeps the commentary and the final answer', async () => {
    setInterimAssistantMessagesFromConfig(true)
    await turn(`${PLAN}${CHECK}${FINAL}`)

    expect(visibleText()).toContain(PLAN)
    expect(visibleText()).toContain(CHECK)
    expect(visibleText()).toContain(FINAL)
  })

  it('an absent or unreadable key is the default (on)', () => {
    setInterimAssistantMessagesFromConfig(undefined)
    expect($interimAssistantMessages.get()).toBe(true)
    setInterimAssistantMessagesFromConfig('nonsense')
    expect($interimAssistantMessages.get()).toBe(true)
    setInterimAssistantMessagesFromConfig(false)
    expect($interimAssistantMessages.get()).toBe(false)
  })
})
