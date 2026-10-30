import { useEffect, useState } from 'react'

import { Pill } from '@/app/settings/primitives'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { formatBytes } from '@/iclone-shared/format'
import { triggerHaptic } from '@/lib/haptics'

import { type ComputerUseState, type SetupBank, useSetupCopy } from './copy'
import type { SetupPackage, SetupSystemRow, SetupSystemStatus } from './types'
import { useComputerUse, useSetupPackages, useSetupSystem } from './use-setup-live'

/**
 * V3-ON — the rows of the Packages and System permissions sections. One component per section, used as-is by the
 * first-launch Set up step AND by Settings › Machine › Set up (ON-3: the same control and status in both places).
 */
const ROW = 'flex items-start justify-between gap-6 py-3'
const NAME = 'block text-[length:var(--conversation-text-font-size)] font-medium text-foreground'

const PURPOSE =
  'mt-1 block text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)'

const EFFECT = 'mt-1 block text-[0.75rem] leading-4 text-muted-foreground'
const SIDE = 'flex shrink-0 items-center gap-2'
const NOTE = 'py-3 text-[0.75rem] leading-4 text-(--ui-text-tertiary)'

const SYSTEM_TONE: Readonly<Record<SetupSystemStatus, 'muted' | 'primary' | 'warn'>> = {
  granted: 'primary',
  denied: 'warn',
  restricted: 'muted',
  declined: 'muted',
  notDetermined: 'muted',
  notSetUp: 'muted',
  unknown: 'muted'
}

const COMPUTER_USE_TONE: Readonly<Record<ComputerUseState, 'muted' | 'primary' | 'warn'>> = {
  granted: 'primary',
  needs: 'muted',
  notInstalled: 'warn',
  unavailable: 'muted'
}

function packageStatus(copy: SetupBank, one: SetupPackage): string {
  return one.state === 'installing' ? copy.packages.installing(one.progress) : copy.packages.state[one.state]
}

/** Packages after the first-launch install: state, size, and "Install again" only for one that failed or was skipped. */
export function SetupPackageRows() {
  const copy = useSetupCopy()
  const { packages, retry, retrying } = useSetupPackages()

  if (!packages || packages.length === 0) {
    return null
  }

  return (
    <div className="divide-y divide-(--stroke-nous)" data-setup-rows="packages">
      {packages.map(one => (
        <div className={ROW} data-setup-package={one.id} data-setup-state={one.state} key={one.id}>
          <div className="min-w-0">
            <span className={NAME}>{one.name}</span>
            {one.bytes !== null ? <span className={PURPOSE}>{formatBytes(one.bytes)}</span> : null}
          </div>
          <div className={SIDE}>
            <Pill tone={one.state === 'installed' ? 'primary' : one.state === 'failed' ? 'warn' : 'muted'}>
              {packageStatus(copy, one)}
            </Pill>
            {one.state === 'failed' || one.state === 'skipped' ? (
              <Button
                data-setup-retry={one.id}
                disabled={retrying !== null}
                onClick={() => {
                  triggerHaptic('selection')
                  retry(one.id)
                }}
                size="sm"
                variant="outline"
              >
                {retrying === one.id ? copy.packages.retrying : copy.packages.retry}
              </Button>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  )
}

function SystemRow({
  copy,
  onAct,
  pending,
  row
}: {
  copy: SetupBank
  onAct: (row: SetupSystemRow) => void
  pending: boolean
  row: SetupSystemRow
}) {
  const words = copy.system.rows[row.id]

  const label =
    row.action === 'request'
      ? row.id === 'notifications'
        ? copy.system.testNotification
        : copy.system.action.request
      : row.action === 'openSettings'
        ? copy.system.action.openSettings
        : null

  return (
    <div className={ROW} data-setup-item={row.id} data-setup-status={row.status}>
      <div className="min-w-0">
        <span className={NAME}>{words.name}</span>
        <span className={PURPOSE}>{words.purpose}</span>
        {row.status === 'declined' ? <span className={EFFECT}>{copy.system.declined}</span> : null}
        {row.restartToApply && row.status !== 'declined' ? <span className={EFFECT}>{copy.system.restart}</span> : null}
      </div>
      <div className={SIDE}>
        <Pill tone={SYSTEM_TONE[row.status]}>{copy.system.status[row.status]}</Pill>
        {label ? (
          <Button
            data-setup-action={row.action}
            disabled={pending}
            onClick={() => {
              triggerHaptic('selection')
              onAct(row)
            }}
            size="sm"
            variant="outline"
          >
            {label}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * V3-ON r2 (ruling 44 + V3-FX FX-2) — the Keychain opt-in: the SAME setter Settings › Gateway uses
 * (`setSecretStorageEncryption`, main's secret-storage policy — no second store). Off by default; Skip leaves it off;
 * only the user's own switch turns it on (macOS may show its keychain prompt once).
 */
function KeychainRow({ copy }: { copy: SetupBank }) {
  const desktop = typeof window === 'undefined' ? undefined : window.hermesDesktop
  const [on, setOn] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true

    void desktop?.getSecretStorageEncryption?.().then(
      res => live && setOn(res?.on === true),
      () => live && setOn(false)
    )

    return () => {
      live = false
    }
  }, [desktop])

  if (!desktop?.setSecretStorageEncryption || on === null) {
    return null
  }

  const words = copy.system.keychain

  const change = (next: boolean) => {
    triggerHaptic('selection')
    setBusy(true)
    setFailed(false)
    void desktop
      .setSecretStorageEncryption(next)
      .then(
        res => setOn(res?.on === true),
        () => setFailed(true)
      )
      .finally(() => setBusy(false))
  }

  return (
    <div className={ROW} data-setup-item="keychain" data-setup-status={on ? 'on' : 'off'}>
      <label className="min-w-0 cursor-pointer" htmlFor="setup-keychain">
        <span className={NAME}>{words.name}</span>
        <span className={PURPOSE}>{words.purpose}</span>
        <span className={EFFECT}>{failed ? words.failed : words.note}</span>
      </label>
      <div className={SIDE}>
        <Pill tone={on ? 'primary' : 'muted'}>{on ? words.on : words.off}</Pill>
        <Switch aria-label={words.name} checked={on} disabled={busy} id="setup-keychain" onCheckedChange={change} />
      </div>
    </div>
  )
}

function ComputerUseRow({ copy }: { copy: SetupBank }) {
  const { grant, granting, state } = useComputerUse(true)

  if (!state) {
    return null
  }

  const words = copy.system.rows.computerUse

  return (
    <div className={ROW} data-setup-item="computerUse" data-setup-status={state}>
      <div className="min-w-0">
        <span className={NAME}>{words.name}</span>
        <span className={PURPOSE}>{words.purpose}</span>
      </div>
      <div className={SIDE}>
        <Pill tone={COMPUTER_USE_TONE[state]}>{copy.system.computerUse[state]}</Pill>
        {state === 'needs' ? (
          <Button
            data-setup-action="request"
            disabled={granting}
            onClick={() => {
              triggerHaptic('selection')
              grant()
            }}
            size="sm"
            variant="outline"
          >
            {copy.system.action.request}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/** The TCC items the app itself uses, each with main's live status and its one action, plus computer use (CuaDriver). */
export function SetupSystemRows() {
  const copy = useSetupCopy()
  const { act, pending, rows } = useSetupSystem()

  if (!rows || rows.length === 0) {
    return null
  }

  return (
    <div data-setup-rows="system">
      <div className="divide-y divide-(--stroke-nous)">
        {rows.map(row => (
          <SystemRow
            copy={copy}
            key={row.id}
            onAct={target => act(target.id, target.id === 'notifications' ? copy.system.notification : undefined)}
            pending={pending === row.id}
            row={row}
          />
        ))}
        <KeychainRow copy={copy} />
        <ComputerUseRow copy={copy} />
      </div>
      <p className={NOTE}>{copy.system.perApp}</p>
    </div>
  )
}
