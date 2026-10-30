import { useEffect, useState } from 'react'

import { IcButton } from '@/components/onboarding/ic-system'
import { useI18n } from '@/i18n'
import type { AgentRuntimeStatus } from '@/iclone-shared/agent-runtime-status'
import { formatBytes } from '@/iclone-shared/format'
import { PYTHON_ENV_PACKAGE } from '@/iclone-shared/install-packages'
import { Cpu, Package } from '@/lib/icons'

import { ListRow, SettingsSection } from './primitives'

type Status = AgentRuntimeStatus & { skippedThisRun?: boolean }

/**
 * Settings > Machine > Updates > Agent runtime (RTB-6/7), above the Agent update section (the Machine group's
 * pane layout is the owner's §3 contract, so this is a section of the pane about the agent runtime, not a new pane). The row the owner asked for — "Agent runtime — not installed /
 * incomplete: <what>" with the same fix the install overlay offers (Install again resumes; installed packages are
 * reused) — and every package with its state and size. Read from main's status record (agent-runtime-status.ts).
 */
export function AgentRuntimeSection() {
  const { t } = useI18n()
  const copy = t.settings.agentRuntime
  const install = t.install.recovery
  const [status, setStatus] = useState<null | Status>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const api = window.hermesDesktop?.agentRuntime

    if (!api) {
      return
    }

    let cancelled = false

    void api
      .status()
      .then(next => !cancelled && setStatus(next))
      .catch(() => undefined)

    const off = api.onChange(next => setStatus(prev => ({ ...prev, ...next })))

    return () => {
      cancelled = true
      off()
    }
  }, [])

  const failed =
    status?.packages
      .filter(line => line.state === 'failed')
      .map(line => (line.name === PYTHON_ENV_PACKAGE ? install.pythonEnvironment : line.name)) ?? []

  const what =
    failed.length > 0
      ? failed.join(', ')
      : status?.diagnosis
        ? install.diagnosis[status.diagnosis.class]
        : (status?.diagnosis?.stage ?? '')

  const stateLabel = !status
    ? ''
    : status.state === 'installed'
      ? copy.installed
      : status.state === 'installing'
        ? copy.installing
        : status.state === 'incomplete'
          ? copy.incompleteWhat(what || copy.incomplete)
          : what
            ? copy.notInstalledWhat(what)
            : copy.notInstalled

  const installAgain = async () => {
    setBusy(true)

    try {
      await window.hermesDesktop?.agentRuntime?.installAgain()
      window.location.reload()
    } finally {
      setBusy(false)
    }
  }

  // The web build has no installer (the bridge namespace is absent there): nothing to show.
  if (!window.hermesDesktop?.agentRuntime) {
    return null
  }

  return (
    <>
      <SettingsSection icon={Cpu} title={copy.title}>
        <ListRow
          action={
            status && status.state !== 'installed' && status.state !== 'installing' ? (
              <IcButton data-action="install-again" disabled={busy} onClick={installAgain} size="sm">
                {copy.installAgain}
              </IcButton>
            ) : null
          }
          data-agent-runtime-state={status?.state ?? 'unknown'}
          description={
            status?.skipCount
              ? copy.skipped
              : status && status.state !== 'installed'
                ? copy.installAgainHint
                : copy.blurb
          }
          title={`${copy.title} — ${stateLabel}`}
        />
      </SettingsSection>
      <SettingsSection icon={Package} title={copy.packages}>
        {status && status.packages.length > 0 ? (
          status.packages.map(line => (
            <ListRow
              data-package={line.name}
              data-state={line.state}
              description={line.error ?? undefined}
              hint={line.totalBytes ? formatBytes(line.totalBytes) : undefined}
              key={line.name}
              title={`${line.name === PYTHON_ENV_PACKAGE ? install.pythonEnvironment : line.name} — ${
                line.state === 'downloading'
                  ? install.packageStates.downloading((line.percent ?? 0).toFixed(1), line.done ?? '', line.total ?? '')
                  : line.state === 'not-needed'
                    ? install.packageStates.notNeeded
                    : install.packageStates[line.state]
              }`}
            />
          ))
        ) : (
          <ListRow title={copy.noPackages} />
        )}
      </SettingsSection>
    </>
  )
}
