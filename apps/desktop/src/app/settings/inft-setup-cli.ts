/**
 * iclone os — the wizard's CLI step: whether the `acp` CLI is present, the
 * ship-with-app install/update, and the agent skills the app teaches it.
 */
import { useCallback, useEffect, useState } from 'react'

import { useI18n } from '@/i18n'
import { errorMessage } from '@/iclone-shared/errors'
import { useAcpTools } from '@/store/acp-tools'

import {
  acpCheck,
  acpInstall,
  type AcpInstallResult,
  acpUpdateCheck,
  lastSkillSync,
  type SkillSyncReport,
  syncAgentSkills
} from '../home/acp-setup'
import { installErrorText } from '../home/econ/acp-tools-panel'

import type { StepState } from './inft-setup-runner'

interface CliPresence {
  ok: boolean
  version?: string
  error?: string
}

interface AcpCliStep {
  cli: CliPresence | null
  cliInstall: StepState
  cliUpdate: AcpInstallResult | null
  skills: SkillSyncReport | null
  skillsBusy: boolean
  installCli: () => Promise<void>
  checkCliUpdate: () => Promise<void>
  teachAgent: () => Promise<void>
}

export function useAcpCliStep(): AcpCliStep {
  const [cli, setCli] = useState<CliPresence | null>(null)
  const [cliInstall, setCliInstall] = useState<StepState>({ running: false })
  const [cliUpdate, setCliUpdate] = useState<AcpInstallResult | null>(null)
  const [skills, setSkills] = useState<SkillSyncReport | null>(null)
  const [skillsBusy, setSkillsBusy] = useState(false)

  // REL-6: the CLI is installed by the ACP tools installer; its check re-runs whenever that state settles.
  const toolsState = useAcpTools()?.state
  const toolsCopy = useI18n().t.acpTools

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

  /** REL-6: the owner's click installs the pinned CLI from npm into the app's own folder (main checks the click and
   *  records it) — no terminal, no `npm install -g`. Call it synchronously from the button's handler. */
  const installCli = useCallback(async () => {
    setCliInstall({ running: true })

    const result = await acpInstall().catch((error: unknown): AcpInstallResult => ({
      ok: false,
      error: errorMessage(error)
    }))

    if (result.ok) {
      setCli({ ok: true, version: result.version })
      setCliInstall({ running: false, note: result.version ? `acp ${result.version} installed` : 'acp CLI installed' })
    } else {
      // REL-6 (critic m4): a refused or failed install comes back as a code; this locale says it.
      const coded = result.tools ? installErrorText(toolsCopy, result.tools) : null

      setCliInstall({ running: false, error: coded ?? result.error ?? 'install failed' })
    }
  }, [toolsCopy])

  const checkCliUpdate = useCallback(async () => {
    setCliUpdate(await acpUpdateCheck())
  }, [])

  /** The app teaches the agent on every launch; this re-runs it now. */
  const teachAgent = useCallback(async () => {
    setSkillsBusy(true)
    setSkills(await syncAgentSkills())
    setSkillsBusy(false)
  }, [])

  return { cli, cliInstall, cliUpdate, skills, skillsBusy, installCli, checkCliUpdate, teachAgent }
}
