/**
 * v0.0.9 pass 4 (owner decision): a refused call stays "Refused" after the turn, a reload or a session switch. rt
 * persists the refusal in the stored tool result ({ refused: true, error: <reason> }); hydration rebuilds the row from
 * it, and the row must read exactly as live: titled Refused, the reason shown, never "Ran".
 */
import { describe, expect, it } from 'vitest'

import { toChatMessages } from '@/lib/chat-messages'
import type { SessionMessage } from '@/types/hermes'

import { buildToolView, type ToolPart } from './fallback-model'

const REASON = 'Blocked by the permission gate: sleep is not allowed in Manual mode'

const stored = (toolContent: string, displayMetadata?: Record<string, unknown> | string): SessionMessage[] =>
  [
    { content: 'run it', role: 'user', timestamp: 1 },
    {
      content: 'Checking the long-running task before I continue.',
      role: 'assistant',
      timestamp: 2,
      tool_calls: [{ function: { arguments: '{"command":"sleep 30"}', name: 'terminal' }, id: 'call-r', type: 'function' }]
    },
    {
      content: toolContent,
      role: 'tool',
      timestamp: 3,
      tool_call_id: 'call-r',
      tool_name: 'terminal',
      ...(displayMetadata === undefined ? {} : { display_metadata: displayMetadata })
    },
    { content: 'The corrected task finished.', role: 'assistant', timestamp: 4 }
  ] as SessionMessage[]

const toolPart = (messages: SessionMessage[]) =>
  toChatMessages(messages)
    .flatMap(m => m.parts)
    .find(part => part.type === 'tool-call') as unknown as ToolPart

describe('a stored refusal hydrates as a refused row', () => {
  it('refused: true in the stored tool result reads Refused, with the reason, never Ran', () => {
    const view = buildToolView(toolPart(stored(JSON.stringify({ error: REASON, refused: true }))), '')

    expect(view.status).toBe('refused')
    expect(view.title).toMatch(/^Refused\b/)
    expect(view.title).not.toMatch(/\bRan\b/)
    expect(`${view.subtitle}\n${view.detail}`).toContain(REASON)
  })

  // rt's stored shape: the refusal rides the tool row's display_metadata (refused + refusal_reason), the content being
  // whatever the model was told. Red before: hydration ignored display_metadata and painted a run.
  it('display_metadata.refused + refusal_reason on the stored tool row reads Refused, with that reason', () => {
    const view = buildToolView(
      toolPart(stored('{"status": "blocked"}', { refusal_reason: REASON, refused: true })),
      ''
    )

    expect(view.status).toBe('refused')
    expect(view.title).toMatch(/^Refused\b/)
    expect(`${view.subtitle}\n${view.detail}`).toContain(REASON)
  })

  it('display_metadata served as JSON text (an older backend) reads the same', () => {
    const view = buildToolView(
      toolPart(stored('blocked', JSON.stringify({ refusal_reason: REASON, refused: true }))),
      ''
    )

    expect(view.status).toBe('refused')
    expect(`${view.subtitle}\n${view.detail}`).toContain(REASON)
  })

  it('a stored ordinary result is still a run', () => {
    const view = buildToolView(toolPart(stored(JSON.stringify({ exit_code: 0, output: '' }))), '')

    expect(view.status).toBe('success')
    expect(view.title).toMatch(/\bRan\b/)
  })
})
