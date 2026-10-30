import { describe, expect, it } from 'vitest'

import type { SubagentNode } from '@/store/subagents'

import {
  fileLines,
  flattenNodes,
  formatAge,
  groupDelegations,
  nodeSubtitle,
  statusTone,
  streamTone,
  treeSummary,
  treeTotals
} from './subagent-view-model'

// The agents page is a pure projection of the subagent store: every rule that
// decides what the user reads is here, so a regression shows up as a red test
// instead of a wrong tree on screen.

const node = (over: Partial<SubagentNode> & { id: string }): SubagentNode => ({
  children: [],
  filesRead: [],
  filesWritten: [],
  goal: `goal ${over.id}`,
  parentId: null,
  startedAt: 0,
  status: 'completed',
  stream: [],
  taskCount: 1,
  taskIndex: 0,
  updatedAt: 0,
  ...over
})

const copy = {
  ageHours: (h: number) => `${h}h`,
  ageMinutes: (m: number) => `${m}m`,
  ageNow: 'now',
  ageSeconds: (s: number) => `${s}s`,
  agentsCount: (n: number) => `${n} agents`,
  activeCount: (n: number) => `${n} active`,
  done: 'done',
  durationMinutes: (m: number, s: number) => `${m}m ${s}s`,
  durationSeconds: (s: string) => `${s}s`,
  failed: 'failed',
  failedCount: (n: number) => `${n} failed`,
  filesCount: (n: number) => `${n} files`,
  running: 'running',
  tokens: (v: string) => `${v} tokens`,
  updatedAgo: (age: string) => `updated ${age}`,
  toolsCount: (n: number) => `${n} tools`
} as unknown as Parameters<typeof treeSummary>[1]

describe('groupDelegations', () => {
  it('merges roots of one fan-out and keeps standalone roots apart', () => {
    const groups = groupDelegations([
      node({ id: 'a', startedAt: 1_000, taskCount: 3, taskIndex: 0 }),
      node({ id: 'b', startedAt: 2_000, taskCount: 3, taskIndex: 1 }),
      node({ id: 'c', startedAt: 3_000, taskCount: 1, taskIndex: 0 })
    ])

    expect(groups.map(g => g.nodes.map(n => n.id))).toEqual([['a', 'b'], ['c']])
    expect(groups[0]!.delegationIndex).toBe(1)
    expect(groups[1]!.delegationIndex).toBe(0)
    expect(groups[1]!.id).toBe('c')
  })

  it('does not merge a later burst of the same width (> 5 s apart)', () => {
    const groups = groupDelegations([
      node({ id: 'a', startedAt: 0, taskCount: 2, taskIndex: 0 }),
      node({ id: 'b', startedAt: 5_001, taskCount: 2, taskIndex: 1 })
    ])

    expect(groups).toHaveLength(2)
    expect(groups.map(g => g.delegationIndex)).toEqual([1, 2])
  })

  it('does not merge a repeated step index', () => {
    const groups = groupDelegations([
      node({ id: 'a', startedAt: 0, taskCount: 2, taskIndex: 0 }),
      node({ id: 'b', startedAt: 100, taskCount: 2, taskIndex: 0 })
    ])

    expect(groups).toHaveLength(2)
  })
})

describe('tree maths', () => {
  const tree = [
    node({
      children: [node({ children: [], filesRead: ['r'], id: 'child', status: 'failed', toolCount: 2 })],
      filesWritten: ['w'],
      id: 'root',
      inputTokens: 400,
      outputTokens: 600,
      status: 'running',
      toolCount: 3
    })
  ]

  it('flattens depth-first, parent before child', () => {
    expect(flattenNodes(tree).map(n => n.id)).toEqual(['root', 'child'])
  })

  it('totals every node, not just the roots', () => {
    expect(treeTotals(flattenNodes(tree))).toEqual({
      active: 1,
      agents: 2,
      costUsd: 0,
      failed: 1,
      files: 2,
      tokens: 1000,
      tools: 5
    })
  })

  it('summarises only the non-zero counters', () => {
    expect(treeSummary(treeTotals(flattenNodes(tree)), copy)).toBe(
      '2 agents · 1 active · 1 failed · 5 tools · 2 files · 1k tokens'
    )
  })

  it('maps status to our tones', () => {
    expect(statusTone('running')).toBe('live')
    expect(statusTone('queued')).toBe('live')
    expect(statusTone('interrupted')).toBe('danger')
    expect(statusTone('failed')).toBe('danger')
    expect(statusTone('completed')).toBe('done')
  })

  it('tones a stream entry by kind, error first', () => {
    expect(streamTone({ at: 0, isError: true, kind: 'summary', text: '' })).toBe('danger')
    expect(streamTone({ at: 0, kind: 'summary', text: '' })).toBe('done')
    expect(streamTone({ at: 0, kind: 'tool', text: '' })).toBe('muted')
  })

  it('lists written files before read ones', () => {
    expect(fileLines(node({ filesRead: ['a'], filesWritten: ['b'], id: 'x' }))).toEqual(['+ b', '· a'])
  })
})

describe('formatting', () => {
  // Through the subtitle the page actually renders: the duration helper is
  // module-private, so nothing is exported only for its own test.
  it('reads a duration in seconds under a minute and m/s above', () => {
    const subtitle = (seconds: number) => nodeSubtitle(node({ id: 'x' }), seconds, 0, copy)

    expect(subtitle(0)).not.toContain('s ·')
    expect(subtitle(12.34)).toContain('12.3s')
    expect(subtitle(90)).toContain('1m 30s')
  })

  it('rounds the age to the second and never rolls hours into days', () => {
    expect(formatAge(1_000, 1_900, copy)).toBe('now')
    expect(formatAge(0, 30_000, copy)).toBe('30s')
    expect(formatAge(0, 120_000, copy)).toBe('2m')
    expect(formatAge(0, 90_000_000, copy)).toBe('25h')
    expect(formatAge(5_000, 0, copy)).toBe('now')
  })
})
