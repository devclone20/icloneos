/**
 * v0.0.9 pass 4 (app bug found by e2e, approved by the lead): the Tasks panel for the runtime's Todo tool.
 *
 * The runtime's tool is `todo_list` (tools/todo_tool.py:230; `todo` is only a legacy alias), deferred by default so a
 * model reaches it through the `tool_call` bridge, and the gateway also sends a full `todo.updated` snapshot with a
 * monotonic `revision` (tui_gateway/tool_progress.py:352-367). The renderer only knew the name `todo` and had no
 * `todo.updated` handler, so the session todos were never set: no "Tasks n/m" card, no running-todo spinner. Every
 * case below except the legacy name fails on that code.
 */
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { chatMessageText } from '@/lib/chat-messages'
import type { TodoItem } from '@/lib/todos'
import { $todosBySession, clearSessionTodos } from '@/store/todos'

import { type MessageStreamHarness, renderMessageStream } from './test-harness'

const SID = 'session-todo-list'

let stream: MessageStreamHarness

const todo = (id: string, status: TodoItem['status']): TodoItem => ({ content: `task ${id}`, id, status })
const A = [todo('1', 'completed'), todo('2', 'in_progress'), todo('3', 'pending')]
const B = [todo('1', 'completed'), todo('2', 'completed'), todo('3', 'in_progress')]

const event = (type: string, payload: Record<string, unknown>) =>
  act(() => stream.handleEvent({ payload, session_id: SID, type } as never))

const todos = () => $todosBySession.get()[SID]

/** Every state the store took, to see a flicker or a duplicate set. */
function recordSets(): TodoItem[][] {
  const seen: TodoItem[][] = []

  $todosBySession.listen(map => {
    if (map[SID]) {
      seen.push(map[SID])
    }
  })

  return seen
}

beforeEach(() => {
  clearSessionTodos(SID)
  stream = renderMessageStream(SID)
})

afterEach(() => {
  cleanup()
  clearSessionTodos(SID)
})

describe('the Tasks panel is fed by the runtime Todo tool', () => {
  it('todo_list by name: tool.start args and tool.complete set the session todos', async () => {
    await event('message.start', {})
    await event('tool.start', { args: { todos: A }, name: 'todo_list', tool_id: 'c1' })
    expect(todos()).toEqual(A)

    await event('tool.complete', { name: 'todo_list', revision: 2, todos: B, tool_id: 'c1' })
    expect(todos()).toEqual(B)
  })

  it('todo_list through the tool_call bridge: the single wrapped call is the Todo tool', async () => {
    await event('message.start', {})
    await event('tool.start', {
      args: { calls: [{ arguments: { todos: A }, name: 'todo_list' }] },
      name: 'tool_call',
      tool_id: 'c2'
    })
    expect(todos()).toEqual(A)
  })

  it('the todo.updated snapshot sets the session todos', async () => {
    await event('todo.updated', { revision: 1, todos: A })
    expect(todos()).toEqual(A)
  })

  it('the Todo tool row stays out of the transcript, whatever its name', async () => {
    await event('message.start', {})
    await event('tool.start', { args: { todos: A }, name: 'todo_list', tool_id: 'c3' })
    await event('message.complete', { text: 'Planned.' })

    const parts = stream.state().messages.flatMap(m => m.parts)
    const toolNames = parts.flatMap(part => (part.type === 'tool-call' ? [part.toolName] : []))

    expect(toolNames.every(name => name === 'todo')).toBe(true)
    expect(stream.state().messages.map(m => chatMessageText(m)).join('\n')).toContain('Planned.')
  })

  it('the legacy name todo keeps working', async () => {
    await event('message.start', {})
    await event('tool.complete', { name: 'todo', todos: A, tool_id: 'c4' })
    expect(todos()).toEqual(A)
  })
})

describe('todo.updated and tool.complete together are idempotent and never go back', () => {
  it('same snapshot from both, todo.updated first: one set, no flicker', async () => {
    const seen = recordSets()

    await event('todo.updated', { revision: 3, todos: B })
    await event('tool.complete', { name: 'todo_list', revision: 3, todos: B, tool_id: 'c5' })

    expect(todos()).toEqual(B)
    expect(seen).toHaveLength(1)
  })

  it('same snapshot from both, tool.complete first: one set, no flicker', async () => {
    const seen = recordSets()

    await event('tool.complete', { name: 'todo_list', revision: 3, todos: B, tool_id: 'c6' })
    await event('todo.updated', { revision: 3, todos: B })

    expect(todos()).toEqual(B)
    expect(seen).toHaveLength(1)
  })

  it('a stale snapshot never overwrites a newer one, in either order', async () => {
    await event('todo.updated', { revision: 4, todos: B })
    await event('tool.complete', { name: 'todo_list', revision: 3, todos: A, tool_id: 'c7' })
    expect(todos()).toEqual(B)

    clearSessionTodos(SID)
    await event('tool.complete', { name: 'todo_list', revision: 4, todos: B, tool_id: 'c8' })
    await event('todo.updated', { revision: 3, todos: A })
    expect(todos()).toEqual(B)
  })

  it('an unversioned tool.start after a versioned snapshot does not roll it back', async () => {
    await event('todo.updated', { revision: 5, todos: B })
    await event('tool.start', { args: { todos: A }, name: 'todo_list', tool_id: 'c9' })
    expect(todos()).toEqual(B)
  })
})
