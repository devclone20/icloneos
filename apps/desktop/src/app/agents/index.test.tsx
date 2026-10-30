import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $subagentsBySession, type SubagentProgress } from '@/store/subagents'

import { AgentsView } from './index'

// Real i18n (English fallback) and the REAL subagent store: these tests drive
// the page the way the gateway does — by publishing progress — so the tree, the
// summary line, the expand/collapse and the empty state are proven end to end.

afterEach(() => {
  cleanup()
  $subagentsBySession.set({})
})

const progress = (over: Partial<SubagentProgress> & { id: string }): SubagentProgress => ({
  filesRead: [],
  filesWritten: [],
  goal: `goal ${over.id}`,
  parentId: null,
  startedAt: 1_000,
  status: 'completed',
  stream: [],
  taskCount: 1,
  taskIndex: 0,
  updatedAt: 1_000,
  ...over
})

describe('AgentsView', () => {
  it('shows the empty state and no summary when nothing has run', () => {
    render(<AgentsView onClose={vi.fn()} />)

    expect(screen.getByText('No live subagents')).toBeTruthy()
    expect(globalThis.document.querySelector('.icag-tree')).toBeNull()
  })

  it('aggregates every session into one tree with a summary', () => {
    $subagentsBySession.set({
      backgroundSession: [progress({ id: 'b', status: 'running', toolCount: 2 })],
      mainSession: [progress({ id: 'a' })]
    })

    render(<AgentsView onClose={vi.fn()} />)

    expect(screen.getByText('goal a')).toBeTruthy()
    expect(screen.getByText('goal b')).toBeTruthy()
    expect(screen.getByText(/2 agents/)).toBeTruthy()
    expect(screen.getByText(/1 active/)).toBeTruthy()
  })

  it('nests a child under its parent and collapses the stream on click', () => {
    $subagentsBySession.set({
      s: [
        progress({
          id: 'root',
          status: 'completed',
          stream: Array.from({ length: 4 }, (_unused, index) => ({
            at: index,
            kind: 'progress' as const,
            text: `step ${index}`
          }))
        }),
        progress({ filesWritten: ['src/a.ts'], id: 'child', parentId: 'root' })
      ]
    })

    render(<AgentsView onClose={vi.fn()} />)

    const child = globalThis.document.querySelector('.icag-children .icag-node')

    expect(child?.textContent).toContain('goal child')
    // Depth 0 and 1 start open: the written file is visible without a click.
    expect(screen.getByText('+ src/a.ts')).toBeTruthy()

    // Collapsed, a finished node keeps only the last two stream rows.
    fireEvent.click(screen.getByRole('button', { expanded: true, name: /goal root/ }))
    expect(screen.queryByText('step 0')).toBeNull()
    expect(screen.getByText('step 3')).toBeTruthy()
  })

  it('closes through the frame control', () => {
    const onClose = vi.fn()

    render(<AgentsView onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
