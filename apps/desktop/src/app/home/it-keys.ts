/**
 * The iT HUB keybindings, as one routine every key owner calls: the iT
 * section and the host's shell divs. The shells are siblings of the section,
 * not children — with the keyboard in a shell the section never sees the key,
 * so the bindings must also live where the xterm textarea is.
 *
 * And the guarded pane close that ⌘W, the pane × and the rail's workspace ×
 * share: a busy shell is never closed without asking.
 */
import { atom } from 'nanostores'

import { busyShellCount } from './it-busy'
import { listPanes } from './it-layout'
import {
  $itInstances,
  $itSurfaceOpen,
  activeItWorkspace,
  closeItPane,
  closeItWorkspace,
  cycleItPane,
  equalizeItPanes,
  splitItPane,
  toggleItZoom
} from './it-store'

interface ItKeyEvent {
  altKey: boolean
  ctrlKey: boolean
  key: string
  metaKey: boolean
  preventDefault: () => void
  /** A held key's auto-repeat: ⌘W held down still closes one pane. */
  repeat?: boolean
  shiftKey: boolean
  stopPropagation: () => void
}

/** A close waiting on the owner: `busy` shells would die with it. */
interface ItClosePrompt {
  busy: number
  /** Set = close this one pane; null = close the whole workspace. */
  terminalId: null | string
  workspaceId: string
}

export const $itClosePrompt = atom<ItClosePrompt | null>(null)

type ItCloseResult = 'closed' | 'prompt' | 'refused'

function workspaceOf(workspaceId: string) {
  return $itInstances.get()[0]?.workspaces.find(workspace => workspace.id === workspaceId)
}

function closeNow(prompt: Omit<ItClosePrompt, 'busy'>): boolean {
  return prompt.terminalId ? closeItPane(prompt.workspaceId, prompt.terminalId) : closeItWorkspace(prompt.workspaceId)
}

/** `ask` false (the CLI): a busy close reports 'prompt' without raising one,
 *  and a pending rail prompt survives unless its pane or workspace is gone. */
function guarded(
  prompt: Omit<ItClosePrompt, 'busy'>,
  shells: Iterable<string>,
  force: boolean,
  ask = true
): ItCloseResult {
  const busy = force ? 0 : busyShellCount(shells)

  if (busy > 0) {
    if (ask) {
      $itClosePrompt.set({ ...prompt, busy })
    }

    return 'prompt'
  }

  if (ask) {
    $itClosePrompt.set(null)
  }

  const closed = closeNow(prompt)

  if (!ask) {
    dropStalePrompt()
  }

  return closed ? 'closed' : 'refused'
}

function dropStalePrompt(): void {
  const pending = $itClosePrompt.get()
  const workspace = pending ? workspaceOf(pending.workspaceId) : undefined

  if (
    pending &&
    (!workspace || (pending.terminalId !== null && !listPanes(workspace.layout).includes(pending.terminalId)))
  ) {
    $itClosePrompt.set(null)
  }
}

/** Can this pane ever close? Not the sole pane of the sole workspace. */
export function canCloseItPane(workspaceId: string, terminalId: string): boolean {
  const workspace = workspaceOf(workspaceId)

  return Boolean(
    workspace &&
    listPanes(workspace.layout).includes(terminalId) &&
    (listPanes(workspace.layout).length > 1 || ($itInstances.get()[0]?.workspaces.length ?? 0) > 1)
  )
}

/** Close one pane. Its workspace's LAST pane closes the workspace instead —
 *  except the last pane of the last workspace, which never closes (iT always
 *  keeps a live shell). */
export function requestCloseItPane(workspaceId: string, terminalId: string, force = false, ask = true): ItCloseResult {
  const workspace = workspaceOf(workspaceId)

  if (!workspace || !listPanes(workspace.layout).includes(terminalId)) {
    return 'refused'
  }

  if (listPanes(workspace.layout).length > 1) {
    return guarded({ terminalId, workspaceId }, [terminalId], force, ask)
  }

  return requestCloseItWorkspace(workspaceId, force, ask)
}

export function requestCloseItWorkspace(workspaceId: string, force = false, ask = true): ItCloseResult {
  const workspace = workspaceOf(workspaceId)

  if (!workspace || ($itInstances.get()[0]?.workspaces.length ?? 0) < 2) {
    return 'refused'
  }

  return guarded({ terminalId: null, workspaceId }, listPanes(workspace.layout), force, ask)
}

export function confirmItClose(): boolean {
  const prompt = $itClosePrompt.get()

  $itClosePrompt.set(null)

  return prompt ? closeNow(prompt) : false
}

export function dismissItClose(): void {
  $itClosePrompt.set(null)
}

/**
 * One ⌘W press, one close. Main claims ⌘W in `before-input-event` and asks
 * over IPC; a press it does not see (or cannot stop) also reaches the page as
 * a keydown. A press is stamped by the close it caused and keeps that stamp
 * for its whole window: a request on a path this press has not used yet
 * within ONE_PRESS_MS is the same press, and so is a repeat on a path it has
 * used within one frame (the lab measured a hardware-style press arriving
 * twice over IPC, and a third delivery after the keydown). A real double ⌘W
 * is never that fast on one path, so it still closes two panes.
 */
const ONE_PRESS_MS = 600
const SAME_PATH_ECHO_MS = 80
type CloseVia = 'ipc' | 'key'
let press: { at: number; seen: Set<CloseVia> } | null = null

/** False when this request is another delivery (or an echo) of a press already acted on. */
function firstOfPress(via: CloseVia, now = performance.now()): boolean {
  if (press && now - press.at < (press.seen.has(via) ? SAME_PATH_ECHO_MS : ONE_PRESS_MS)) {
    press.seen.add(via)

    return false
  }

  press = { at: now, seen: new Set([via]) }

  return true
}

export function resetItClosePressForTests(): void {
  press = null
}

/** ⌘W with the keyboard in iT: the focused pane of the active workspace. */
function closeFocusedPane(): void {
  const workspace = activeItWorkspace()

  if (workspace) {
    requestCloseItPane(workspace.id, workspace.focusTerminalId)
  }
}

/**
 * On macOS main claims ⌘W in `before-input-event` (the page never sees the
 * key) and sends close-preview-requested instead; the renderer's close
 * handler must ask this FIRST. True when the keyboard was inside the iT view
 * on screen — the chord is then iT's, even when it refused (the last pane of
 * the last workspace): it must never fall through and close a chat tab.
 */
export function closeFocusedItPane(active: Element | null = document.activeElement): boolean {
  if (!$itSurfaceOpen.get() || !active?.closest('[data-it-host], [data-it-instance]')) {
    return false
  }

  if (firstOfPress('ipc')) {
    closeFocusedPane()
  }

  return true
}

/**
 * Handle one keydown. Returns true when it was an iT binding (the event is
 * then consumed, so neither xterm nor the app sees it).
 */
export function handleItHubKey(event: ItKeyEvent): boolean {
  // The HUB modifier is ⌘ alone, on every platform: ⌃C (interrupt), ⌃D (EOF),
  // ⌃W (delete word), ⌃⇧D… belong to the shell. ⌃⌘= still equalizes — it
  // carries ⌘.
  if (!event.metaKey) {
    return false
  }

  const workspaceId = activeItWorkspace()?.id ?? ''
  const key = event.key.toLowerCase()

  const consume = () => {
    event.preventDefault()
    event.stopPropagation()

    return true
  }

  // ⌃⌘= equalize splits
  if (event.ctrlKey) {
    if (key === '=' || key === '+') {
      equalizeItPanes(workspaceId)

      return consume()
    }

    return false
  }

  // ⌘W close the focused pane (busy prompt; never the very last one)
  if (!event.shiftKey && !event.altKey && key === 'w') {
    if (!event.repeat && firstOfPress('key')) {
      closeFocusedPane()
    }

    return consume()
  }

  // ⌘D split right · ⌘⇧D split down
  if (!event.altKey && key === 'd') {
    splitItPane(workspaceId, event.shiftKey ? 'v' : 'h')

    return consume()
  }

  // ⌘⇧↩ zoom the focused pane
  if (event.shiftKey && event.key === 'Enter') {
    toggleItZoom(workspaceId)

    return consume()
  }

  // ⌥⌘← / ⌥⌘→ walk the focus through the panes
  if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    cycleItPane(workspaceId, event.key === 'ArrowRight' ? 1 : -1)

    return consume()
  }

  return false
}
