import type { Translations } from '@/i18n'
import { compactNumber } from '@/lib/format'
import type { SubagentNode, SubagentStatus, SubagentStreamEntry } from '@/store/subagents'

import type { IcTone } from '../command-center/ui/feedback'

/**
 * Everything the agents page computes, with no React and no DOM: the tree is
 * flattened, delegations are grouped and every label is formatted here, so the
 * page is a pure projection of `$subagentsBySession` and each rule has a test.
 */

type AgentsCopy = Translations['agents']

/** One burst of parallel work: several roots started together with the same
 *  task shape (the agent's own fan-out), or a single standalone root. */
export interface DelegationGroup {
  delegationIndex: number
  id: string
  nodes: SubagentNode[]
  taskCount: number
}

const DELEGATION_WINDOW_MS = 5_000

export function flattenNodes(nodes: readonly SubagentNode[]): SubagentNode[] {
  return nodes.flatMap(node => [node, ...flattenNodes(node.children)])
}

export function isActive(status: SubagentStatus): boolean {
  return status === 'running' || status === 'queued'
}

function isFailure(status: SubagentStatus): boolean {
  return status === 'failed' || status === 'interrupted'
}

export function statusTone(status: SubagentStatus): IcTone {
  if (isActive(status)) {
    return 'live'
  }

  return isFailure(status) ? 'danger' : 'done'
}

export function statusLabel(status: SubagentStatus, a: AgentsCopy): string {
  if (isActive(status)) {
    return a.running
  }

  return isFailure(status) ? a.failed : a.done
}

export function streamTone(entry: SubagentStreamEntry): IcTone {
  if (entry.isError) {
    return 'danger'
  }

  if (entry.kind === 'summary') {
    return 'done'
  }

  return 'muted'
}

/**
 * Roots that belong to one fan-out are merged into a single group. A root joins
 * the previous group when the shape matches (both report the same task_count > 1),
 * it started within 5 s of that group's last root, and its step index is not
 * already in the group — otherwise two unrelated bursts of the same width would
 * read as one delegation.
 */
export function groupDelegations(roots: readonly SubagentNode[]): DelegationGroup[] {
  const groups: DelegationGroup[] = []
  let delegations = 0

  for (const node of roots) {
    const previous = groups.at(-1)
    const tail = previous?.nodes.at(-1)
    const closeInTime = tail ? Math.abs(node.startedAt - tail.startedAt) <= DELEGATION_WINDOW_MS : false
    const sameShape = previous !== undefined && node.taskCount > 1 && previous.taskCount === node.taskCount
    const uniqueStep = previous ? !previous.nodes.some(item => item.taskIndex === node.taskIndex) : false

    if (previous && sameShape && closeInTime && uniqueStep) {
      previous.nodes.push(node)

      continue
    }

    if (node.taskCount > 1) {
      delegations += 1
      groups.push({
        delegationIndex: delegations,
        id: `delegation-${delegations}`,
        nodes: [node],
        taskCount: node.taskCount
      })

      continue
    }

    groups.push({ delegationIndex: 0, id: node.id, nodes: [node], taskCount: node.taskCount })
  }

  return groups
}

interface TreeTotals {
  active: number
  agents: number
  costUsd: number
  failed: number
  files: number
  tokens: number
  tools: number
}

export function treeTotals(flat: readonly SubagentNode[]): TreeTotals {
  return {
    active: flat.filter(node => isActive(node.status)).length,
    agents: flat.length,
    costUsd: flat.reduce((sum, node) => sum + (node.costUsd ?? 0), 0),
    failed: flat.filter(node => isFailure(node.status)).length,
    files: flat.reduce((sum, node) => sum + node.filesRead.length + node.filesWritten.length, 0),
    tokens: flat.reduce((sum, node) => sum + (node.inputTokens ?? 0) + (node.outputTokens ?? 0), 0),
    tools: flat.reduce((sum, node) => sum + (node.toolCount ?? 0), 0)
  }
}

function formatTokens(value: number | undefined, a: AgentsCopy): string {
  return value ? a.tokens(compactNumber(value)) : ''
}

function durationCopy(seconds: number | undefined, a: AgentsCopy): string {
  if (!seconds || seconds <= 0) {
    return ''
  }

  if (seconds < 60) {
    return a.durationSeconds(seconds.toFixed(1))
  }

  return a.durationMinutes(Math.floor(seconds / 60), Math.round(seconds % 60))
}

/** Distinct contract from the shared `formatAgo`: it rounds to the second (this
 *  ticks live) and hours are unbounded ("25h", never "1d"). */
export function formatAge(updatedAt: number, nowMs: number, a: AgentsCopy): string {
  const seconds = Math.max(0, Math.round((nowMs - updatedAt) / 1000))

  if (seconds < 2) {
    return a.ageNow
  }

  if (seconds < 60) {
    return a.ageSeconds(seconds)
  }

  const minutes = Math.floor(seconds / 60)

  return minutes < 60 ? a.ageMinutes(minutes) : a.ageHours(Math.floor(minutes / 60))
}

export function treeSummary(totals: TreeTotals, a: AgentsCopy): string {
  return [
    a.agentsCount(totals.agents),
    totals.active > 0 ? a.activeCount(totals.active) : '',
    totals.failed > 0 ? a.failedCount(totals.failed) : '',
    totals.tools > 0 ? a.toolsCount(totals.tools) : '',
    totals.files > 0 ? a.filesCount(totals.files) : '',
    totals.tokens > 0 ? formatTokens(totals.tokens, a) : '',
    totals.costUsd > 0 ? `$${totals.costUsd.toFixed(2)}` : ''
  ]
    .filter(Boolean)
    .join(' · ')
}

export function nodeSubtitle(node: SubagentNode, durationSeconds: number, nowMs: number, a: AgentsCopy): string {
  return [
    node.model,
    durationCopy(durationSeconds, a),
    node.toolCount ? a.toolsCount(node.toolCount) : '',
    formatTokens((node.inputTokens ?? 0) + (node.outputTokens ?? 0), a),
    a.updatedAgo(formatAge(node.updatedAt, nowMs, a))
  ]
    .filter(Boolean)
    .join(' · ')
}

export const FILE_LINES_SHOWN = 8

/** Written files first (`+`), then read ones (`·`): what the agent CHANGED is
 *  what the user looks for. */
export function fileLines(node: SubagentNode): string[] {
  return [...node.filesWritten.map(path => `+ ${path}`), ...node.filesRead.map(path => `· ${path}`)]
}
