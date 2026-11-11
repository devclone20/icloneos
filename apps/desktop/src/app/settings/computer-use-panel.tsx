import { useComputerUseFlow } from '@/components/setup/computer-use-flow'
import { CUA_DRIVER_WORDS } from '@/components/setup/copy'
import { CuaDriverAction, CuaDriverExplain, CuaDriverFlowNote } from '@/components/setup/cua-driver-explain'
import { Button } from '@/components/ui/button'
import { AlertTriangle, Check, Loader2, RefreshCw, X } from '@/lib/icons'

import { Pill } from './primitives'

interface ComputerUsePanelProps {
  /** Re-read the parent toolset list after a permission/install change so the
   *  "Configured / Needs keys" pill stays in sync. */
  onConfiguredChange?: () => void
}

// Per-OS one-liner shown when there's no TCC grant flow (Windows/Linux). macOS
// drives the permission rows instead, so it has no entry here.
const PLATFORM_NOTE: Record<string, string> = {
  linux: 'Drives your desktop via the X11/XWayland accessibility stack — no permission prompt.',
  win32: 'First run may trigger a Windows SmartScreen prompt for the cua-driver UIAccess worker — allow it.'
}

function tone(granted: boolean | null) {
  return granted === true ? 'primary' : 'muted'
}

function GrantIcon({ granted }: { granted: boolean | null }) {
  const Icon = granted === true ? Check : granted === false ? X : AlertTriangle

  return <Icon className="size-3" />
}

function PermissionRow({ granted, label, hint }: { granted: boolean | null; label: string; hint: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-background/55 p-2.5">
      <div className="min-w-0">
        <span className="text-sm font-medium">{label}</span>
        <p className="mt-0.5 text-[0.7rem] text-muted-foreground">{hint}</p>
      </div>
      <Pill tone={tone(granted)}>
        <GrantIcon granted={granted} />
        {granted === true ? 'Granted' : granted === false ? 'Not granted' : 'Unknown'}
      </Pill>
    </div>
  )
}

/**
 * Cross-platform Computer Use preflight card. macOS needs two TCC grants on CuaDriver's own identity
 * (`com.trycua.driver`); Windows/Linux have no TCC toggles, so readiness is driver health from `cua-driver doctor`.
 * The Allow, install and status flow is the Set up row's own (components/setup/computer-use-flow.ts).
 * Binary upgrade stays in the provider's post-setup runner below this card (the generic ToolsetConfigPanel).
 */
export function ComputerUsePanel({ onConfiguredChange }: ComputerUsePanelProps) {
  const { grant, install, loaded, phase, reason, refresh, state, status } = useComputerUseFlow(true, onConfiguredChange)

  if (!loaded) {
    return (
      <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Checking Computer Use status…
      </div>
    )
  }

  if (!status) {
    return null
  }

  if (!status.platform_supported) {
    return (
      <p className="px-1 text-xs text-muted-foreground">
        Computer Use isn&apos;t supported on this platform ({status.platform}).
      </p>
    )
  }

  if (!status.installed) {
    return (
      <div className="grid gap-2 px-1" data-computer-use-state="notInstalled">
        <p className="text-xs text-muted-foreground">
          {status.can_grant
            ? 'CuaDriver is not installed yet. Install it, then allow Accessibility and Screen recording here.'
            : 'Install the cua-driver backend below to drive this machine.'}
        </p>
        {status.can_grant ? (
          <div>
            <CuaDriverAction grant={() => void grant()} install={() => void install()} phase={phase} state={state} />
            <CuaDriverFlowNote phase={phase} reason={reason} state={state} status={status} />
            <CuaDriverExplain />
          </div>
        ) : null}
      </div>
    )
  }

  const failingChecks = status.checks.filter(c => c.status !== 'ok')

  return (
    <div className="grid gap-2" data-computer-use-state={state ?? 'other'}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="min-w-0">
          {status.can_grant ? (
            <p className="text-[0.72rem] text-muted-foreground">
              macOS keeps these on CuaDriver (com.trycua.driver), apart from this app, so the dialog names the helper that
              uses your Mac.
            </p>
          ) : (
            <p className="text-[0.72rem] text-muted-foreground">{PLATFORM_NOTE[status.platform] ?? ''}</p>
          )}
          {status.version && <p className="text-[0.68rem] text-muted-foreground/80">{status.version}</p>}
          {status.can_grant ? <CuaDriverExplain /> : null}
        </div>
        <Button onClick={() => void refresh()} size="sm" variant="text">
          <RefreshCw className="size-3.5" />
          {CUA_DRIVER_WORDS.recheck}
        </Button>
      </div>

      {status.can_grant ? (
        <>
          <PermissionRow
            granted={status.accessibility}
            hint="Lets CuaDriver click, type and read the buttons of an app."
            label="Accessibility"
          />
          <PermissionRow
            granted={status.screen_recording}
            hint="Lets CuaDriver see the window of the app it is using."
            label="Screen Recording"
          />
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-background/55 p-2.5">
          <span className="text-sm font-medium">Driver health</span>
          <Pill tone={tone(status.ready)}>
            <GrantIcon granted={status.ready} />
            {status.ready === true ? 'Ready' : status.ready === false ? 'Not ready' : 'Unknown'}
          </Pill>
        </div>
      )}

      {failingChecks.map(c => (
        <p className="px-1 text-[0.7rem] text-muted-foreground" key={c.label}>
          <AlertTriangle className="mr-1 inline size-3" />
          {c.label}: {c.message}
        </p>
      ))}

      {status.error && (
        <p className="px-1 text-[0.7rem] text-muted-foreground">
          <AlertTriangle className="mr-1 inline size-3" />
          {status.error}
        </p>
      )}

      {status.ready ? (
        <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
          <Check className="size-3.5" />
          Computer Use is ready. Ask the agent to capture an app and click around.
        </div>
      ) : (
        status.can_grant && (
          <div className="grid justify-items-start gap-1 px-1">
            <CuaDriverAction grant={() => void grant()} install={() => void install()} phase={phase} state={state} />
            <CuaDriverFlowNote phase={phase} reason={reason} state={state} status={status} />
          </div>
        )
      )}
    </div>
  )
}
