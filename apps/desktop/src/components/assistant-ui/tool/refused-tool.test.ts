/**
 * v0.0.9 pass 4 (correction-session-switch :227 + rt's fix): a call the gate or confinement refused now reaches the
 * desktop as tool.start + tool.complete with `refused: true`, the reason in `error`, and `summary: "Refused: <reason>"`
 * (tui_gateway/tool_progress.py _on_tool_refused). The row must say it was refused and why: never "Ran …", never
 * the destructive error state of a command that ran and failed, never a spinner left behind. Red before: it painted
 * a red "error" row titled as a run.
 */
import { describe, expect, it } from 'vitest'

import { upsertToolPart } from '@/lib/chat-messages'

import { buildToolView, type ToolPart } from './fallback-model'

const REASON = 'Blocked by the permission gate: sleep is not allowed in Manual mode'

const refusedPart = (): ToolPart => ({
  args: { command: 'sleep 5' },
  isError: true,
  result: { error: REASON, refused: true, summary: `Refused: ${REASON}` },
  toolCallId: 'call_refused',
  toolName: 'terminal',
  type: 'tool-call'
})

describe('a refused tool call', () => {
  it('reads as refused, with the reason, not as a run nor a failure', () => {
    const view = buildToolView(refusedPart(), '')

    expect(view.status).toBe('refused')
    expect(view.title).toMatch(/^Refused\b/)
    expect(view.title).not.toMatch(/\bRan\b/)
    // v0.0.9 G design GF-4: the title keeps the name of what was refused, not the bare word.
    expect(view.title).toBe('Refused · Terminal')
    expect(`${view.subtitle}\n${view.detail}`).toContain(REASON)
  })

  it('the stream carries `refused` into the part and leaves no running row behind', () => {
    const started = upsertToolPart([], { args: { command: 'sleep 5' }, name: 'terminal', tool_id: 't1' }, 'running')

    const done = upsertToolPart(
      started,
      { error: REASON, name: 'terminal', refused: true, result: JSON.stringify({ error: REASON }), summary: `Refused: ${REASON}`, tool_id: 't1' },
      'complete'
    )

    const tools = done.filter(part => part.type === 'tool-call') as unknown as ToolPart[]

    expect(tools).toHaveLength(1)
    expect((tools[0].result as Record<string, unknown>).refused).toBe(true)
    expect(buildToolView(tools[0], '').status).toBe('refused')
  })

  it('an ordinary failed command is still an error', () => {
    const view = buildToolView({ ...refusedPart(), result: { error: 'exit 2', exit_code: 2 } }, '')

    expect(view.status).toBe('error')
  })
})
