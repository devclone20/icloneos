/**
 * iclone os — headed browsing as a NATIVE titlebar tool.
 *
 * Owner rule: this sits in the top-right titlebar row with the theme glyph and
 * the wallet, same size and grammar, icon only. Registered on
 * `titleBar.tools.right` like its siblings; `order: 2` puts it after them.
 *
 * WHAT IT TOGGLES. `browser.headed` in config decides whether the agent's
 * browser opens a window you can watch, or works invisibly. Headed also keeps
 * the window alive between turns (the idle reaper still applies), which is
 * what makes "watch it work" a coherent mode rather than a flicker.
 *
 * WHY IT ALSO RESTARTS THE BACKEND. The agent resolves this value ONCE per
 * process and latches it — `tools/browser_tool.py`:
 *
 *     global _cached_headed_mode, _headed_mode_resolved
 *     if _headed_mode_resolved:
 *         return _cached_headed_mode
 *
 * so writing the config while the backend is alive changes precisely nothing
 * until it restarts. A toggle that flips a switch and leaves the agent in the
 * old mode is worse than no toggle: the owner would watch for a window that
 * was never going to appear. So the click writes the config AND respawns the
 * backend (soft — the renderer re-dials, no window reload, the 3D stage and
 * the terminal panes survive). A turn in flight does not survive, which is why
 * the tooltip says so before you click.
 *
 * The state is read from the backend, never assumed: the glyph shows what the
 * agent will actually do, including after someone edits config.yaml by hand.
 */
import { Circle, Disc, Eye, EyeOff, Loader2 } from 'lucide-react'
import { atom } from 'nanostores'

import { getHermesConfigRecord, saveHermesConfig } from '@/api/config'
import { registry } from '@/contrib/registry'
import { $gateway } from '@/store/gateway'
import { dismissNotification, notify } from '@/store/notifications'

import { getNested, setNested } from '../settings/helpers'

import { $toolsCopy } from './tools-copy'

type HeadedState = 'off' | 'on' | 'unknown' | 'working'

/** What the agent's browser will actually do, as last read from the backend. */
export const $browserHeaded = atom<HeadedState>('unknown')

/** Config carries booleans as real booleans, but a hand-edited YAML can leave
 *  `"true"` — read it the same permissive way the agent does. */
function truthy(value: unknown): boolean {
  return (
    value === true ||
    String(value ?? '')
      .trim()
      .toLowerCase() === 'true'
  )
}

const HEADED_PATH = 'browser.headed'
const RECORD_PATH = 'browser.record_sessions'

/** Read the live value. Never throws — an unreachable backend leaves the glyph
 *  in its `unknown` shape rather than claiming a state we did not verify. */
export async function refreshBrowserHeaded(): Promise<void> {
  if ($browserHeaded.get() === 'working') {
    return
  }

  try {
    const config = await getHermesConfigRecord()

    $browserHeaded.set(truthy(getNested(config, HEADED_PATH)) ? 'on' : 'off')
  } catch {
    $browserHeaded.set('unknown')
  }
}

async function toggleBrowserHeaded(): Promise<void> {
  if ($browserHeaded.get() === 'working') {
    return
  }

  $browserHeaded.set('working')

  try {
    // The restart would cut a capture short with no word: it stops and says so first, within its bound.
    await saveCapturesFirst()

    // Re-read immediately before writing: the whole record goes back over the
    // wire, so a stale copy would silently revert someone else's edit made
    // since this window loaded.
    const config = await getHermesConfigRecord()
    const next = !truthy(getNested(config, HEADED_PATH))

    await saveHermesConfig(setNested(config, HEADED_PATH, next))
    await window.hermesDesktop?.restartBackend?.()

    $browserHeaded.set(next ? 'on' : 'off')
  } catch (error) {
    console.warn('[iclone] headed-mode toggle failed:', error)
    // Do not guess: ask the backend what actually landed.
    $browserHeaded.set('unknown')
    void refreshBrowserHeaded()
  }
}

type RecordingState = 'capturing' | 'saving' | HeadedState

/** A change on its way: `saving` is a capture stopping, which can take about half a minute and at most RECORD_STOP_RPC_MS, and says so. */
const recordBusy = (state: RecordingState): boolean => state === 'working' || state === 'saving'

/** Off; on and armed, nothing captured yet; on and capturing now, by the runtime's word. */
export const $browserRecording = atom<RecordingState>('unknown')

interface RecordingNotice {
  file?: null | string
  message: string
  ok: boolean
  path?: null | string
  seq: number
}

interface RecordingView {
  armed?: boolean | null
  boot?: null | string
  capturing?: null | string[]
  notices?: null | RecordingNotice[]
}

/** Per runtime: each profile has its own, and each counts from 1. */
type SeenNotices = Record<string, number>

const RECORD_POLL_MS = 2_000
// Measured: Settings off took up to 2.5 s with the 2 s poll, 0.6 s of it the Settings save. While a capture runs the poll keeps that inside 2 s.
export const RECORD_POLL_CAPTURING_MS = 500
const RECORD_RPC_TIMEOUT_MS = 20_000
// A stop can take 40 s by the runtime's own bound (tools/browser_tool.py, _RECORD_STOP_TIMEOUT_S), and it waits for a start in flight.
export const RECORD_STOP_RPC_MS = 60_000
const SAVING_NOTICE_ID = 'browser-record-saving'
// Under this a save is over before anyone looks for a reason; past it the tooltip alone explains a spinner nobody hovers.
const SAVING_NOTICE_AFTER_MS = 2_000
const RECORD_FOLDER_TAIL = '/Movies/icloneOS Recordings/'
const SEEN_KEY = 'iclone.browser-record.seen'
const SEEN_RUNTIMES_KEPT = 8

let recordPoll: null | ReturnType<typeof setInterval> = null
let stoppingForSettings = false
let seenInMemory: null | SeenNotices = null
let endSavingNotice: (() => void) | null = null

/** The tooltip's words as a notice once a save outlasts the wait; the returned end cancels or removes it. */
function noticeWhenSaveIsSlow(): () => void {
  const timer = setTimeout(
    () => notify({ durationMs: 0, id: SAVING_NOTICE_ID, kind: 'info', message: $toolsCopy.get().recordSaving }),
    SAVING_NOTICE_AFTER_MS
  )

  return () => {
    clearTimeout(timer)
    dismissNotification(SAVING_NOTICE_ID)
  }
}

function followSaving(state: RecordingState): void {
  if (state === 'saving') {
    endSavingNotice ??= noticeWhenSaveIsSlow()

    return
  }

  endSavingNotice?.()
  endSavingNotice = null
}

async function askRecording(
  action: 'record_status' | 'record_stop' | 'record_sync',
  timeoutMs = RECORD_RPC_TIMEOUT_MS
): Promise<null | RecordingView> {
  try {
    return (await $gateway.get()?.request<RecordingView>('browser.manage', { action }, timeoutMs)) ?? null
  } catch {
    return null // A runtime that cannot answer: the button says armed at most, never capturing, and never off.
  }
}

/** Kept across a reload and shared by windows: a notice is said once, and one that came while no window listened is still said. */
function readSeen(): SeenNotices {
  try {
    const seen = JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? 'null') as unknown

    if (!seen || typeof seen !== 'object') {
      return {}
    }

    const { boot, seq } = seen as { boot?: unknown; seq?: unknown }

    if (typeof boot === 'string' && typeof seq === 'number') {
      return { [boot]: seq } // The record as it was before there was one per runtime.
    }

    return Object.fromEntries(Object.entries(seen).filter(([, value]) => typeof value === 'number')) as SeenNotices
  } catch {
    return seenInMemory ?? {}
  }
}

function writeSeen(seen: SeenNotices): void {
  seenInMemory = seen

  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
  } catch {
    // Storage refused: this window still counts, in memory.
  }
}

/** The saved video, in Finder. Only at the one folder, whatever a runtime sends. */
function showFileAction(notice: RecordingNotice) {
  const { file, ok, path } = notice

  if (!ok || !file || !/^browser-\d{8}-\d{6}-[0-9a-f]{6}\.webm$/.test(file) || !path || !path.startsWith('/') || path.includes('/../') || !path.endsWith(`${RECORD_FOLDER_TAIL}${file}`)) {
    return null
  }

  return {
    label: $toolsCopy.get().recordShowFile,
    onClick: () => void window.hermesDesktop?.revealPath?.(path)
  }
}

function sayNotices(view: null | RecordingView): void {
  if (!view) {
    return
  }

  // Each runtime counts from 1, so a count means something only beside the runtime that gave it.
  const boot = view.boot ?? ''
  const notices = view.notices ?? []
  const seen = readSeen()
  const from = seen[boot] ?? 0

  for (const notice of notices) {
    if (notice.seq > from) {
      const action = showFileAction(notice)

      notify({
        durationMs: 15_000,
        id: `browser-record-${boot}-${notice.seq}`,
        kind: notice.ok ? 'info' : 'warning',
        message: notice.message,
        ...(action ? { action } : {})
      })
    }
  }

  const others = Object.entries(seen).filter(([key]) => key !== boot)

  writeSeen(Object.fromEntries([...others.slice(1 - SEEN_RUNTIMES_KEPT), [boot, Math.max(from, ...notices.map(notice => notice.seq))]]))
}

const isCapturing = (view: null | RecordingView): boolean => (view?.capturing?.length ?? 0) > 0

/** A capture is a capture whatever the setting says; off is claimed only when the runtime has answered. */
function recordingState(configOn: boolean | null, view: null | RecordingView): RecordingState {
  if (isCapturing(view)) {
    return 'capturing'
  }

  if (configOn === true) {
    return 'on'
  }

  return configOn === false && view ? 'off' : 'unknown'
}

/** The runtime's own reading when it gave one, the config when it could not. */
async function readConfigOn(view: null | RecordingView): Promise<boolean | null> {
  if (typeof view?.armed === 'boolean') {
    return view.armed
  }

  try {
    return truthy(getNested(await getHermesConfigRecord(), RECORD_PATH))
  } catch {
    return null
  }
}

export async function refreshBrowserRecording(): Promise<void> {
  if (recordBusy($browserRecording.get())) {
    return
  }

  const view = await askRecording('record_status')

  sayNotices(view)

  const configOn = await readConfigOn(view)

  if (!recordBusy($browserRecording.get())) {
    $browserRecording.set(recordingState(configOn, view))
  }
}

/** Off in Settings, or by hand in config.yaml: off stops at once, so a capture with the setting off is stopped here. */
async function stopWhatSettingsTurnedOff(view: null | RecordingView): Promise<void> {
  if (view?.armed !== false || !isCapturing(view) || stoppingForSettings || recordBusy($browserRecording.get())) {
    return
  }

  stoppingForSettings = true
  $browserRecording.set('saving')

  try {
    const after = await askRecording('record_sync', RECORD_STOP_RPC_MS)

    sayNotices(after)
    $browserRecording.set(recordingState(false, after))
  } finally {
    stoppingForSettings = false
  }
}

export function recordPollDue(state: RecordingState, sinceLastPollMs: number): boolean {
  return state === 'capturing' || sinceLastPollMs >= RECORD_POLL_MS
}

/** Every 2 s in every state, faster during a capture: the turn's end, the idle reaper or Settings can each change what is running, and each says so. */
export async function pollBrowserRecording(): Promise<void> {
  const view = await askRecording('record_status')

  sayNotices(view)

  const configOn = await readConfigOn(view)

  if (!recordBusy($browserRecording.get())) {
    $browserRecording.set(recordingState(configOn, view))
  }

  await stopWhatSettingsTurnedOff(view)
}

/** Before anything that ends the runtime: the capture stops, the notice arrives, or the user reads that the wait ran out. */
async function saveCapturesFirst(): Promise<void> {
  const view = await askRecording('record_status')

  sayNotices(view)

  if (!(view ? isCapturing(view) : $browserRecording.get() === 'capturing')) {
    return
  }

  const endNotice = noticeWhenSaveIsSlow()
  const after = await askRecording('record_stop', RECORD_STOP_RPC_MS).finally(endNotice)

  sayNotices(after)

  if (!after || isCapturing(after)) {
    notify({ durationMs: 15_000, id: 'browser-record-ran-out', kind: 'warning', message: $toolsCopy.get().recordStopRanOut })
  }
}

async function toggleBrowserRecording(): Promise<void> {
  if (recordBusy($browserRecording.get())) {
    return
  }

  const wasCapturing = $browserRecording.get() === 'capturing'

  $browserRecording.set(wasCapturing ? 'saving' : 'working')

  try {
    const config = await getHermesConfigRecord()
    const configOn = truthy(getNested(config, RECORD_PATH))
    // The click answers what the button shows: a capture stops, whatever the setting says; only with nothing running and nothing armed does it arm.
    const next = !(configOn || wasCapturing)

    if (next !== configOn) {
      await saveHermesConfig(setNested(config, RECORD_PATH, next))
    }

    // No backend restart, deliberately: that would kill a turn in flight. The runtime makes the live browser match now:
    // off stops and saves at once, headed or not; on starts on a session that already has a page.
    const view = await askRecording('record_sync', RECORD_STOP_RPC_MS)

    sayNotices(view)
    $browserRecording.set(recordingState(next, view))
  } catch (error) {
    console.warn('[iclone] recording toggle failed:', error)
    $browserRecording.set('unknown')
    void refreshBrowserRecording()
  }
}

const label = (state: HeadedState): string => {
  const copy = $toolsCopy.get()

  return { off: copy.browserOff, on: copy.browserOn, unknown: copy.browserUnknown, working: copy.browserWorking }[state]
}

function glyph(state: HeadedState) {
  if (state === 'working') {
    return <Loader2 className="animate-spin" size={16} strokeWidth={1.7} />
  }

  return state === 'on' ? <Eye size={16} strokeWidth={1.7} /> : <EyeOff size={16} strokeWidth={1.7} />
}

// The label deliberately says "asks the agent to record" rather than promising
// a file. `browser.record_sessions` is honoured automatically only on the
// built-in browser path (`_maybe_start_recording` is called from
// `browser_navigate`). When the Browser-Use CLI is installed it wins, the
// built-ins are never registered, and nothing reads this flag for you — the
// agent honours it from its `browse-and-work` skill by calling
// `start_recording()`. Promising a video the flag alone cannot produce is the
// same lie as a toggle that does not restart the backend.
const recordLabel = (state: RecordingState): string => {
  const copy = $toolsCopy.get()

  return {
    capturing: copy.recordCapturing,
    off: copy.recordOff,
    on: copy.recordOn,
    saving: copy.recordSaving,
    unknown: copy.recordUnknown,
    working: copy.recordWorking
  }[state]
}

function recordGlyph(state: RecordingState) {
  if (recordBusy(state)) {
    return <Loader2 className="animate-spin" size={16} strokeWidth={1.7} />
  }

  // A solid red dot only while a capture really runs, a ring with a centre while armed, a plain ring while off: the
  // state reads without the tooltip.
  if (state === 'capturing') {
    return <Circle className="fill-current text-(--ic-danger)" data-recording-capturing="" size={16} strokeWidth={1.7} />
  }

  return state === 'on' ? <Disc size={16} strokeWidth={1.7} /> : <Circle size={16} strokeWidth={1.7} />
}

let disposeRecord: (() => void) | null = null

function publishRecord(state: RecordingState) {
  disposeRecord?.()
  disposeRecord = registry.register({
    area: 'titleBar.tools.right',
    data: {
      active: state === 'on' || state === 'capturing',
      busy: recordBusy(state),
      icon: recordGlyph(state),
      id: 'iclone-browser-recording',
      // A capture stays visible and stoppable whatever is open, as the AI record button does.
      keepOverModals: state === 'capturing' || state === 'saving',
      label: recordLabel(state),
      onSelect: () => {
        if ($browserRecording.get() === 'unknown') {
          void refreshBrowserRecording()

          return
        }

        void toggleBrowserRecording()
      },
      title: recordLabel(state)
    },
    id: 'iclone-browser-recording',
    order: 3
  })
}

let dispose: (() => void) | null = null

/** The registry resolves `data` at registration time, so a state change has to
 *  re-register (see the note in contrib/registry.ts). */
function publish(state: HeadedState) {
  dispose?.()
  dispose = registry.register({
    area: 'titleBar.tools.right',
    data: {
      active: state === 'on',
      busy: state === 'working',
      icon: glyph(state),
      id: 'iclone-browser-headed',
      label: label(state),
      onSelect: () => {
        if ($browserHeaded.get() === 'unknown') {
          void refreshBrowserHeaded()

          return
        }

        void toggleBrowserHeaded()
      },
      title: label(state)
    },
    id: 'iclone-browser-headed',
    order: 2
  })
}

let registered = false

/** Idempotent — wiring imports this module once per window. */
export function registerIcloneBrowserTool() {
  if (registered) {
    return
  }

  registered = true
  publish($browserHeaded.get())
  $browserHeaded.subscribe(publish)
  publishRecord($browserRecording.get())
  $browserRecording.subscribe(publishRecord)
  $browserRecording.subscribe(followSaving)
  // The display language changed: same state, new words.
  $toolsCopy.listen(() => {
    publish($browserHeaded.get())
    publishRecord($browserRecording.get())
  })

  // First read is deferred: at wiring time the backend may not be dialled yet,
  // and a failed read would park the glyphs in `unknown` for the whole session.
  void refreshBrowserHeaded()
  void refreshBrowserRecording()
  let sinceLastPoll = 0

  recordPoll ??= setInterval(() => {
    sinceLastPoll += RECORD_POLL_CAPTURING_MS

    if (recordPollDue($browserRecording.get(), sinceLastPoll)) {
      sinceLastPoll = 0
      void pollBrowserRecording()
    }
  }, RECORD_POLL_CAPTURING_MS)
}
