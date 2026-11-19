/**
 * iclone os — the wizard's CLI step (step 1). v0.0.9 (owner decision 17 Nov, replaces ruling 26): the Virtuals ACP CLI
 * ships inside the app, so this step only reports it ("Virtuals ACP CLI 1.0.38 · included · verified", from main's
 * ACP tools state), re-runs the CLI's self-test whenever that state settles, and keeps the agent skills the app teaches
 * it. Install, Check for updates and Update now are gone (P0_ECONOMYOS_CONTROLS S1a/S1b/S1e/S1f); the one control left
 * is Repair (econ/acp-tools-panel.tsx `AcpToolsControl`), whose outcome lands here.
 */
import { useCallback, useEffect, useState } from 'react'

import { f1bAcpBundled } from '@/i18n/en/v009-f1b'
import { errorMessage } from '@/iclone-shared/errors'
import { useAcpTools } from '@/store/acp-tools'

import { acpCheck, lastSkillSync, type SkillSyncReport, syncAgentSkills } from '../home/acp-setup'

import type { StepState } from './inft-setup-runner'

interface CliPresence {
  ok: boolean
  version?: string
  error?: string
}

interface AcpCliStep {
  cli: CliPresence | null
  /** The step's own line under the row: the last Repair's outcome. */
  cliState: StepState
  /** Repair's answer (null: it worked), from `AcpToolsControl`'s `onResult`. */
  onRepairResult: (error: string | null) => void
  skills: SkillSyncReport | null
  skillsBusy: boolean
  teachAgent: () => Promise<void>
}

export function useAcpCliStep(): AcpCliStep {
  const [cli, setCli] = useState<CliPresence | null>(null)
  const [cliState, setCliState] = useState<StepState>({ running: false })
  const [skills, setSkills] = useState<SkillSyncReport | null>(null)
  const [skillsBusy, setSkillsBusy] = useState(false)

  // The CLI's self-test re-runs whenever main's tools state settles (placed, verified, repaired, changed under us).
  const tools = useAcpTools()
  const toolsState = tools?.state

  useEffect(() => {
    acpCheck()
      .then(setCli)
      .catch((error: unknown) => setCli({ ok: false, error: errorMessage(error) }))
  }, [toolsState])

  useEffect(() => {
    lastSkillSync()
      .then(setSkills)
      .catch(() => undefined)
  }, [])

  const onRepairResult = useCallback(
    (error: string | null) => {
      setCliState(
        error
          ? { running: false, error }
          : { running: false, note: f1bAcpBundled.repaired(tools?.cliVersion ?? '') }
      )
    },
    [tools?.cliVersion]
  )

  /** The app teaches the agent on every launch; this re-runs it now. */
  const teachAgent = useCallback(async () => {
    setSkillsBusy(true)
    setSkills(await syncAgentSkills())
    setSkillsBusy(false)
  }, [])

  return { cli, cliState, onRepairResult, skills, skillsBusy, teachAgent }
}
