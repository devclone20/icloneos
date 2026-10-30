import { useStore } from '@nanostores/react'

import { $agentCompatFlag, $agentUpdate } from '@/store/agent-update'
import { $runtimeStatus } from '@/store/iclone-updates'
import { $desktopVersion, $updatePolicy } from '@/store/updates'
import type { IcloneAgentInstalled } from '@/types/iclone-updates'

import { type AgentVerdict, agentVerdict, installedAgent } from './agent-model'

interface AgentVerdictReading {
  flagged: boolean
  installed: IcloneAgentInstalled | null
  verdict: AgentVerdict
}

/**
 * The installed agent and its verdict from the same stores, for Settings › Updates and About alike (U5-p2b-01):
 * neither pane may feed agentVerdict() a different flag than the other.
 */
export function useAgentVerdict(): AgentVerdictReading {
  const check = useStore($agentUpdate).check
  const runtime = useStore($runtimeStatus)
  const version = useStore($desktopVersion)
  const policy = useStore($updatePolicy)
  const flagged = useStore($agentCompatFlag)?.red === true
  const installed = installedAgent(check, runtime, version?.runtimeVersion, policy)

  return { flagged, installed, verdict: agentVerdict(installed, flagged) }
}
