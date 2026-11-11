/**
 * AI record, the owner's order: a title-bar tool beside the browser record button, which stays what it was
 * (`browser.record_sessions`, a video of the agent's browser). One click records the screen as timed precise
 * screenshots, one click stops, and the frames go into the active chat's next message.
 *
 * The user's own click: no permission mode and no Seatbelt state gates it. Main answers to the `screen` consent key and
 * the macOS grant, and this file says which one in plain words and takes the user to the place that changes it.
 */
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Tip } from '@/components/ui/tooltip'
import { registry } from '@/contrib/registry'
import { cn } from '@/lib/utils'
import { dismissNotification, notify } from '@/store/notifications'
import {
  $screenRecord,
  $screenRecordBusy,
  formatElapsed,
  refreshScreenRecord,
  screenRecordBridge,
  type ScreenRecordRefusal,
  wireScreenRecord
} from '@/store/screen-record'

import { $toolsCopy } from './tools-copy'

const NOTED_KEY = 'iclone:screen-record:noted'
const PRIVACY_HASH = '#/settings?tab=privacy'
const SETUP_HASH = '#/settings?tab=setup'

function firstUseNote() {
  try {
    if (window.localStorage.getItem(NOTED_KEY)) {
      return
    }

    window.localStorage.setItem(NOTED_KEY, '1')
  } catch {
    // Storage refused: a note shown twice is better than none.
  }

  notify({
    durationMs: 12_000,
    id: 'screen-record-note',
    kind: 'info',
    message: $toolsCopy.get().screenRecordFirstUse
  })
}

/** Says why, once per refusal, and offers the one place that changes it. */
export function sayRefusal(reason: ScreenRecordRefusal) {
  const copy = $toolsCopy.get()

  const open = (hash: string, label: string) => ({
    label,
    onClick: () => {
      window.location.hash = hash
    }
  })

  const setup = open(SETUP_HASH, copy.screenRecordOpenSetup)

  const said = {
    blank: { action: setup, message: copy.screenRecordBlank },
    consent: { action: open(PRIVACY_HASH, copy.screenRecordOpenPrivacy), message: copy.screenRecordConsentOff },
    failed: { action: undefined, message: copy.screenRecordFailed },
    'needs-grant': { action: setup, message: copy.screenRecordNoGrant },
    'needs-restart': { action: setup, message: copy.screenRecordRestart },
    restricted: { action: undefined, message: copy.screenRecordRestricted }
  }[reason]

  notify({ ...said, durationMs: 15_000, id: 'screen-record-refused', kind: 'warning' })
}

export async function toggleScreenRecord(): Promise<void> {
  const bridge = screenRecordBridge()

  if (!bridge || $screenRecordBusy.get()) {
    return
  }

  $screenRecordBusy.set(true)

  try {
    if ($screenRecord.get().recording) {
      $screenRecord.set(await bridge.stop())

      return
    }

    const started = await bridge.start()

    if (started.ok) {
      dismissNotification('screen-record-refused')
      $screenRecord.set(started.status)
      firstUseNote()
    } else {
      sayRefusal(started.reason)
      await refreshScreenRecord()
    }
  } catch {
    sayRefusal('failed')
  } finally {
    $screenRecordBusy.set(false)
  }
}

/** Reads AI at a glance beside the browser button's ring, idle or running. */
function AiMark({ live }: { live: boolean }) {
  return (
    <span className="flex items-center gap-0.5 text-[0.625rem] leading-none font-semibold tracking-[0.02em]">
      <span
        aria-hidden="true"
        className={cn('size-1.5 rounded-full', live ? 'bg-(--ic-danger) motion-safe:animate-pulse' : 'bg-current')}
      />
      AI
    </span>
  )
}

/** The running time, ticking on its own so the title bar does not republish every second. */
export function ScreenRecordElapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 500)

    return () => window.clearInterval(timer)
  }, [startedAt])

  return (
    <span className="flex items-center gap-1 text-(--ic-danger)" data-screen-recording="">
      <AiMark live />
      <span className="text-[0.6875rem] leading-none font-medium tabular-nums" role="timer">
        {formatElapsed(now - startedAt)}
      </span>
    </span>
  )
}

function publish() {
  const copy = $toolsCopy.get()
  const status = $screenRecord.get()
  const busy = $screenRecordBusy.get()
  const startedAt = status.recording ? status.startedAt : null

  const label =
    startedAt !== null
      ? copy.screenRecordActive
      : busy
        ? copy.screenRecordWorking
        : status.consentOn === false
          ? copy.screenRecordConsentOff
          : copy.screenRecordIdle

  dispose?.()
  dispose = registry.register({
    area: 'titleBar.tools.right',
    data: {
      active: startedAt !== null,
      busy,
      className: startedAt !== null ? 'w-auto px-1.5 opacity-100' : 'w-auto px-1',
      icon: startedAt !== null ? <ScreenRecordElapsed startedAt={startedAt} /> : <AiMark live={false} />,
      id: 'iclone-ai-record',
      keepOverModals: startedAt !== null,
      label,
      onSelect: () => void toggleScreenRecord(),
      title: label
    },
    id: 'iclone-ai-record',
    order: 4
  })
}

let dispose: (() => void) | null = null
let registered = false

/**
 * Idempotent, like its neighbours. The registry resolves `data` at registration, so a state change re-registers. The web
 * build has no recorder (ABSENT_IN_WEB), so there the button is not offered: nothing to press that does nothing.
 */
export function registerScreenRecordTool() {
  if (registered || !screenRecordBridge()) {
    return
  }

  registered = true
  wireScreenRecord()
  publish()
  $screenRecord.listen(publish)
  $screenRecordBusy.listen(publish)
  $toolsCopy.listen(publish)
}

/** A window without the title-bar tools (the HUD, a secondary window) still shows it, and can still stop it. */
export function ScreenRecordBadge() {
  const status = useStore($screenRecord)

  useEffect(() => wireScreenRecord(), [])

  if (!status.recording || status.startedAt === null) {
    return null
  }

  return (
    <Tip label={$toolsCopy.get().screenRecordActive}>
      <button
        aria-label={$toolsCopy.get().screenRecordActive}
        className="pointer-events-auto absolute top-1 right-3.5 z-1 flex h-6 items-center rounded-(--ic-radius-sm) px-1.5 [-webkit-app-region:no-drag] hover:bg-(--ic-ctl-hover-fill) focus-visible:outline-2 focus-visible:outline-(--ic-accent)"
        data-ic-screen-record-badge=""
        onClick={() => void toggleScreenRecord()}
        type="button"
      >
        <ScreenRecordElapsed startedAt={status.startedAt} />
      </button>
    </Tip>
  )
}
