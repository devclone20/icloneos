/**
 * v0.0.9 pass 4: display.interim_assistant_messages off holds for a stored turn too. After the turn (or on a resume)
 * the transcript is re-read from the session, merged one row per turn; the commentary before the turn's last tool call
 * must not come back there. Red before: hydration knew nothing of the key and kept every commentary row.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { $interimAssistantMessages } from '@/store/interim-assistant-messages'
import type { SessionMessage } from '@/types/hermes'

import { chatMessageText, toChatMessages } from './chat-messages'

const call = (id: string) => ({ function: { arguments: '{}', name: 'read_file' }, id, type: 'function' })

const rows: SessionMessage[] = [
  { content: 'first question', role: 'user', timestamp: 1 },
  { content: 'First answer, no tools.', role: 'assistant', timestamp: 2 },
  { content: 'second question', role: 'user', timestamp: 3 },
  { content: 'Let me start by planning the approach.', role: 'assistant', timestamp: 4, tool_calls: [call('a')] },
  { content: '{}', role: 'tool', timestamp: 5, tool_call_id: 'a' },
  { content: 'Now checking the details.', role: 'assistant', timestamp: 6, tool_calls: [call('b')] },
  { content: '{}', role: 'tool', timestamp: 7, tool_call_id: 'b' },
  { content: 'All done! Here is the summary.', role: 'assistant', timestamp: 8 }
] as SessionMessage[]

const text = () =>
  toChatMessages(rows)
    .filter(m => m.role === 'assistant')
    .map(m => chatMessageText(m))
    .join('\n')

afterEach(() => $interimAssistantMessages.set(true))

describe('hydration and display.interim_assistant_messages', () => {
  it('off: the commentary before the last tool call is dropped, the final answer and the tool-free turn are kept', () => {
    $interimAssistantMessages.set(false)

    expect(text()).not.toContain('Let me start by planning the approach.')
    expect(text()).not.toContain('Now checking the details.')
    expect(text()).toContain('All done! Here is the summary.')
    expect(text()).toContain('First answer, no tools.')
    expect(toChatMessages(rows).flatMap(m => m.parts).filter(p => p.type === 'tool-call')).toHaveLength(2)
  })

  it('on (default): everything is kept', () => {
    expect(text()).toContain('Let me start by planning the approach.')
    expect(text()).toContain('All done! Here is the summary.')
  })
})
