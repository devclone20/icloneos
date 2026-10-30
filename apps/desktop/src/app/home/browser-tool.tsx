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

/** Whether the agent keeps a WebM of what it does in the browser. */
export const $browserRecording = atom<HeadedState>('unknown')

export async function refreshBrowserRecording(): Promise<void> {
  if ($browserRecording.get() === 'working') {
    return
  }

  try {
    const config = await getHermesConfigRecord()

    $browserRecording.set(truthy(getNested(config, RECORD_PATH)) ? 'on' : 'off')
  } catch {
    $browserRecording.set('unknown')
  }
}

async function toggleBrowserRecording(): Promise<void> {
  if ($browserRecording.get() === 'working') {
    return
  }

  $browserRecording.set('working')

  try {
    const config = await getHermesConfigRecord()
    const next = !truthy(getNested(config, RECORD_PATH))

    await saveHermesConfig(setNested(config, RECORD_PATH, next))

    // No backend restart, deliberately. `_maybe_start_recording` reads the
    // config fresh at the start of every browser session
    // (tools/browser_tool.py), so this lands on the very next one. Restarting
    // here would kill a turn in flight for nothing.
    $browserRecording.set(next ? 'on' : 'off')
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
const recordLabel = (state: HeadedState): string => {
  const copy = $toolsCopy.get()

  return { off: copy.recordOff, on: copy.recordOn, unknown: copy.recordUnknown, working: copy.recordWorking }[state]
}

function recordGlyph(state: HeadedState) {
  if (state === 'working') {
    return <Loader2 className="animate-spin" size={16} strokeWidth={1.7} />
  }

  // Filled disc while armed, hollow ring while not — the universal record
  // grammar, so the state reads without the tooltip.
  return state === 'on' ? <Disc size={16} strokeWidth={1.7} /> : <Circle size={16} strokeWidth={1.7} />
}

let disposeRecord: (() => void) | null = null

function publishRecord(state: HeadedState) {
  disposeRecord?.()
  disposeRecord = registry.register({
    area: 'titleBar.tools.right',
    data: {
      active: state === 'on',
      busy: state === 'working',
      icon: recordGlyph(state),
      id: 'iclone-browser-recording',
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
  // The display language changed: same state, new words.
  $toolsCopy.listen(() => {
    publish($browserHeaded.get())
    publishRecord($browserRecording.get())
  })

  // First read is deferred: at wiring time the backend may not be dialled yet,
  // and a failed read would park the glyphs in `unknown` for the whole session.
  void refreshBrowserHeaded()
  void refreshBrowserRecording()
}
