/**
 * V3-G — pure shaping of `ConfinementStateView` for the pane. Every number the pane shows is the length of an array
 * built here from the state main just folded; nothing is kept between renders.
 */
import type { ConfinementCopy } from '@/i18n/en/confinement'
import type {
  AgentActivityView,
  BackendStatus,
  ConfinedProcessView,
  ConfinementReason,
  ConfinementStateView,
  ConfinementVerdict
} from '@/iclone-shared/confinement'

type Tone = 'down' | 'muted' | 'up' | 'warn'

interface ConfinedGroup {
  root: ConfinedProcessView
  children: ConfinedProcessView[]
}

export function confinedGroups(state: Pick<ConfinementStateView, 'inside'>): ConfinedGroup[] {
  const groups = new Map<number, ConfinedGroup>()

  for (const process of state.inside) {
    if (process.pid === process.root) {
      groups.set(process.pid, { root: process, children: [] })
    }
  }

  for (const process of state.inside) {
    if (process.pid !== process.root) {
      groups.get(process.root)?.children.push(process)
    }
  }

  return [...groups.values()]
}

export const verdictTone = (verdict: ConfinementVerdict): Tone =>
  verdict === 'green' ? 'up' : verdict === 'red' ? 'down' : 'muted'

/** Red is a fault only: an `installed` backend this version does not use is neutral (K130), like `unsupported`, and so is
 *  a check that did not finish in time (`unknown`, G3-2). */
const BACKEND_TONE: Record<BackendStatus, Tone> = {
  ready: 'up',
  broken: 'down',
  'not-installed': 'warn',
  installed: 'muted',
  unknown: 'muted',
  unsupported: 'muted'
}

export const backendTone = (status: BackendStatus): Tone => BACKEND_TONE[status]

export function counts(state: Pick<ConfinementStateView, 'inside' | 'outside'>): { inside: number; outside: number } {
  return {
    inside: state.inside.filter(process => process.pid === process.root).length,
    outside: state.outside.filter(process => process.kind === 'agent-command').length
  }
}

export function followed(state: Pick<ConfinementStateView, 'inside'>, pid: number | null): ConfinedGroup | null {
  if (pid === null) {
    return null
  }

  return confinedGroups(state).find(group => group.root.pid === pid) ?? null
}

export const agentName = (agent: AgentActivityView, unattributed: string): string =>
  agent.sessionId === 'unattributed' ? unattributed : (agent.inft ?? agent.sessionId)

export const shortSha = (sha: string): string => sha.slice(0, 12)

/** The catalogue sentence for one reason main folded (each case narrows to that reason's own fields). */
export function sayReason(copy: Pick<ConfinementCopy, 'reason'>, reason: ConfinementReason): string {
  switch (reason.code) {
    case 'backend-not-confining':
      return copy.reason[reason.code](reason)

    case 'plugin-not-loaded':
      return copy.reason[reason.code](reason)

    case 'profile-changed':
      return copy.reason[reason.code](reason)

    case 'widened-profile':
      return copy.reason[reason.code](reason)

    case 'unknown-profile':
      return copy.reason[reason.code](reason)

    case 'agent-command-outside':
      return copy.reason[reason.code](reason)

    case 'forged-marker':
      return copy.reason[reason.code](reason)

    case 'membership-unverified':
      return copy.reason[reason.code](reason)

    case 'hardlink-appeared':
      return copy.reason[reason.code](reason)

    case 'settings-ignored':
      return copy.reason[reason.code](reason)
  }
}
