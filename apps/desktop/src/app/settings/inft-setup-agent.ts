/**
 * iclone os — the wizard's account steps for one iNFT: ACP sign-in, the
 * agent itself, its signer, its email and its ERC-8004 registration.
 */
import { useCallback, useEffect, useState } from 'react'

import type { InftAcpStatus } from '../home/acp-setup'
import type { INftCardData } from '../home/collections'
import { openExternal } from '../home/lib/external'

import { cliJson, pickString, type StepRunner } from './inft-setup-runner'

interface AgentStepsParams {
  runner: StepRunner
  selected: INftCardData | null
  status: InftAcpStatus | undefined
}

interface AgentSteps {
  agentName: string
  setAgentName: (name: string) => void
  startSignIn: () => Promise<void>
  createAgent: () => Promise<void>
  armSigner: () => Promise<void>
  provisionEmail: () => Promise<void>
  registerErc8004: () => Promise<void>
}

export function useAgentSteps({ runner, selected, status }: AgentStepsParams): AgentSteps {
  const { exec, pollUntil, refresh, setStep } = runner
  const [agentName, setAgentName] = useState('')

  useEffect(() => {
    if (selected) {
      setAgentName(selected.name)
    }
    // The name follows the SELECTED token, not the first one ever selected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id])

  const startSignIn = useCallback(async () => {
    const json = cliJson(await exec('auth', ['configure', 'start', '--json']))
    const url = pickString(json, ['url', 'authUrl'])
    const requestId = pickString(json, ['requestId', 'request_id'])

    if (!url || !requestId) {
      setStep('auth', { error: 'could not read the sign-in URL from the CLI output' })

      return
    }

    openExternal(url)
    setStep('auth', { running: true, note: 'finish signing in in your browser — this step completes itself…' })
    pollUntil(
      'auth',
      ['configure', 'complete', '--request-id', requestId, '--json'],
      json2 => pickString(json2, ['status']) === 'authenticated',
      refresh
    )
  }, [exec, pollUntil, refresh, setStep])

  const createAgent = useCallback(async () => {
    const name = agentName.trim() || selected?.name || 'iclone agent'
    const description = `iclone os iNFT agent for ${name} — EconomyOS enabled (wallet, email, card, Hyperliquid).`

    const created = await exec(
      'agent',
      ['agent', 'create', '--name', name, '--description', description, '--json'],
      90_000
    )

    if (!created?.ok) {
      return
    }

    const json = cliJson(created)
    const nested = json?.agent && typeof json.agent === 'object' ? (json.agent as Record<string, unknown>) : null
    const agentId = pickString(json, ['agentId', 'id']) ?? pickString(nested, ['agentId', 'id'])

    // Bind THIS config dir to the new agent. Safe precisely because the dir
    // is exclusive to this iNFT — the shared-config `agent use` hazard
    // cannot exist here.
    if (agentId) {
      await exec('agent', ['agent', 'use', '--agent-id', agentId, '--json'])
    }

    refresh({ agent: true })
  }, [agentName, exec, refresh, selected?.name])

  const armSigner = useCallback(async () => {
    const agentId = status?.agentId

    if (!agentId) {
      return
    }

    const result = await exec(
      'signer',
      ['agent', 'add-signer', '--agent-id', agentId, '--policy', 'restricted', '--no-wait', '--json'],
      90_000
    )

    const json = cliJson(result)
    const signerUrl = pickString(json, ['signerUrl', 'url'])
    const requestId = pickString(json, ['requestId', 'request_id'])
    const publicKey = pickString(json, ['publicKey', 'public_key'])

    if (!signerUrl || !requestId || !publicKey) {
      setStep('signer', { error: 'could not read the signer approval URL from the CLI output' })

      return
    }

    openExternal(signerUrl)
    setStep('signer', { running: true, note: 'approve the signer in your browser — this step completes itself…' })
    pollUntil(
      'signer',
      ['agent', 'signer-status', '--agent-id', agentId, '--request-id', requestId, '--public-key', publicKey, '--json'],
      json2 => pickString(json2, ['status']) === 'approved',
      () => refresh({ agent: true })
    )
  }, [exec, pollUntil, refresh, setStep, status?.agentId])

  const provisionEmail = useCallback(async () => {
    await exec('email', ['email', 'provision', '--json'], 90_000)
    refresh({ agent: true })
  }, [exec, refresh])

  const registerErc8004 = useCallback(async () => {
    const agentId = status?.agentId

    if (!agentId) {
      return
    }

    await exec('erc8004', ['agent', 'register-erc8004', '--agent-id', agentId, '--chain-id', '8453', '--json'], 180_000)
    refresh()
  }, [exec, refresh, status?.agentId])

  return { agentName, setAgentName, startSignIn, createAgent, armSigner, provisionEmail, registerErc8004 }
}
