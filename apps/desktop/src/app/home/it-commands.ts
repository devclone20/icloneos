/**
 * The `it` CLI dispatcher (renderer side) — the HUB's iT command grammar,
 * recreated clean-room for iclone os. electron/iclone-it.ts relays argv from
 * the installed CLI (any terminal on the machine) to here; every command
 * drives the same stores the UI uses, and the plain-text answer travels
 * back to the shell.
 *
 * The three verbs everything else is built on are `send`, `read-screen` and
 * `exec` — type into a pane, read a pane, do both in one shot. They address a
 * pane BY ID through the terminal io registry, so an agent can drive four
 * panes at once without any of them having focus. The old port had none of
 * them: its only write path was the single-slot injection channel, which could
 * reach exactly one terminal (whichever had focus) and clobbered itself when
 * two commands raced.
 */
import { sleep } from '@/iclone-shared/async'
import { resolveHermesOpenPath } from '@/lib/hermes-open-target'

import { requestComposerFocus, requestComposerInsert } from '../chat/composer/focus'

import { busyShellCount } from './it-busy'
import { type ItFlags, parseItFlags, resolvePaneRef, screenLooksIdle, toPtyText } from './it-cli-args'
import { requestCloseItPane } from './it-keys'
import { type ItWorkspace, listPanes } from './it-layout'
import {
  $itInstances,
  activeItWorkspace,
  addItWorkspace,
  breakItPane,
  canSplitItPane,
  closeItWorkspace,
  cycleItPane,
  equalizeItPanes,
  findItWorkspace,
  focusItPane,
  isRefShapedTitle,
  itWorkspacesTitled,
  openItSurface,
  renameItWorkspace,
  setItActive,
  setMsgView,
  splitItPane,
  toggleItZoom
} from './it-store'
import { initPaneAttention } from './it/bus/attention'
import { BUS_HELP, collectCommand, panesJson, spawnCommand, tmuxCommand, watchCommand } from './it/bus/commands'
import { redactPaneTokens } from './it/bus/redact'
import { readTerminalById, setActiveTerminalId, terminalIsLive, writeToTerminal } from './it/engine/buffer'
import { $terminals, renameTerminal } from './it/engine/terminals'
import { $inftRoster, $privySession } from './privy-session'
import { $activeInft } from './stage-store'

const scopeWorkspaces = () => $itInstances.get()[0]?.workspaces ?? []

const HELP = `it — the iclone os terminal command

  WORKSPACES (the rail)
    it status                app · view · workspaces · iNFT overview
    it list                  list workspaces (● = active)
    it new [title]           open a new workspace
    it use <n|title>         focus a workspace (and show iT)
    it close <n|title>       close a workspace (the last one never closes)
    it rename <n> <title>    rename a workspace

  PANES (inside a workspace)
    it panes                 panes of the active workspace (● = focused)
    it split [right|down]    split the focused pane (⌘D / ⌘⇧D)
    it vsplit                split the focused pane DOWN
    it focus-pane <n>        focus pane n (1-based)
    it next-pane | prev-pane
    it close-pane [n]        close a pane (the last one never closes)
    it equalize              all splits back to 50/50
    it zoom                  blow the focused pane up, or back (⌘⇧↩)
    it break-pane            lift the focused pane into its own workspace

  DOING WORK  (--pane <n|id> targets a pane, --workspace <n|title> the
               workspace it lives in; defaults = the focused pane of the
               active workspace. INDICES SHIFT when the tree changes — hold
               an id instead)
    it send <text…> [--enter] [--pane n]     type into a pane
    it send-key <key> [--pane n]             enter·escape·tab·up·down·left·
                                             right·ctrl+c·ctrl+d·ctrl+l
    it read-screen [--lines n] [--pane n]    read a pane's screen
    it exec <command…> [--pane n] [--wait s] run it, wait, return the screen
    it run <command…>                        alias of exec on the focused pane
    it idle [--pane n]                       is that pane at a prompt?
    it wait-idle [--pane n] [--wait s]       wait until it is (or say busy)
    it rename-pane <title> [--pane n]

${BUS_HELP}

  THE APP
    it open                  open the Message window on the iT view
    it open settings [pane]  open a Settings pane (updates = Settings › Updates); navigation only
    it msg                   switch the window to the message view
    it chat <text…>          drop text into the chat composer
    it notify <text…>        desktop notification from iclone os
    it inft                  active iNFT + collection roster
    it state                 FULL app snapshot
    it click <label…>        click a visible control by its name
    it help                  this help`

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect()

  return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden'
}

/** The topmost open overlay card (settings, skills, …) — the stage carries
 *  the same marker but is the permanent backdrop, never "on top". */
function topOverlaySurface(): HTMLElement | null {
  const surfaces = document.querySelectorAll<HTMLElement>('[data-overlay-surface]:not(.istage-layer)')

  return surfaces.length ? surfaces[surfaces.length - 1] : null
}

function clickables(root: ParentNode = document): { el: HTMLElement; label: string }[] {
  const out: { el: HTMLElement; label: string }[] = []

  for (const el of root.querySelectorAll<HTMLElement>('button, [role="button"], [role="tab"], a[href]')) {
    if (!isVisible(el)) {
      continue
    }

    const label = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ')

    if (label && label.length <= 60) {
      out.push({ el, label })
    }
  }

  return out
}

const SETTINGS_PANE_ALIASES: Record<string, string> = {
  agent: 'app-atualisation',
  update: 'app-atualisation',
  updates: 'app-atualisation'
}

/** `it open settings [pane]`: navigation only, through the same allow-list an `iclone://open/settings` link takes. */
function openSettingsPane(pane: string | undefined): string {
  const tab = pane ? (SETTINGS_PANE_ALIASES[pane.toLowerCase()] ?? pane) : undefined

  if (tab && !/^[a-z0-9][a-z0-9:-]*$/i.test(tab)) {
    return `it: "${pane}" is not a settings pane`
  }

  const path = resolveHermesOpenPath({ params: tab ? { tab } : {}, path: '/settings' })

  if (!path) {
    return 'it: settings cannot be opened from here'
  }

  window.location.hash = path

  return `opened: settings${tab ? ` › ${tab}` : ''}`
}

interface ItBridge {
  onCmd: (callback: (payload: { id: number; argv: string[] }) => void) => () => void
  reply: (id: number, output: string) => void
}

function bridge(): ItBridge | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }

  return (window.hermesDesktop as unknown as { icloneIt?: ItBridge } | undefined)?.icloneIt
}

// Flag parsing and pane addressing are PURE — they live in it-cli-args.ts so
// they can be tested without an app, a PTY or a window, and so there is one
// definition of "what --pane means" instead of two.

/** A pane whose PTY never started (shells start only on screen) — say so, and
 *  say how to put it on screen. */
function notStarted(): string {
  return 'it: that pane has no shell yet — shells start only while iT is on screen; run `it open` first'
}

/** The workspace a command acts in: `--workspace <n|title>`, else the active
 *  one. */
function targetWorkspace(ref?: string): ItWorkspace | undefined {
  return ref ? findItWorkspace(ref) : activeItWorkspace()
}

/** The terminal a command targets, resolved inside `workspace`. */
function targetTerminal(workspace: ItWorkspace | undefined, pane?: string): null | string {
  if (!workspace) {
    return null
  }

  return resolvePaneRef(listPanes(workspace.layout), pane, workspace.focusTerminalId)
}

function paneLabel(workspace: ItWorkspace, terminalId: string): string {
  const index = listPanes(workspace.layout).indexOf(terminalId)
  const title = $terminals.get().find(term => term.id === terminalId)?.title ?? 'shell'

  return `pane ${index + 1} (${title})`
}

const KEY_BYTES: Record<string, string> = {
  backspace: '\x7f',
  down: '\x1b[B',
  enter: '\r',
  esc: '\x1b',
  escape: '\x1b',
  left: '\x1b[D',
  right: '\x1b[C',
  tab: '\t',
  up: '\x1b[A',
  'ctrl+a': '\x01',
  'ctrl+c': '\x03',
  'ctrl+d': '\x04',
  'ctrl+e': '\x05',
  'ctrl+l': '\x0c',
  'ctrl+u': '\x15',
  'ctrl+z': '\x1a'
}

/** A pane's screen. `lines` reads back INTO the scrollback (the last N lines
 *  with content), not just the visible rows — output that scrolled past the
 *  viewport is exactly the case a caller asks about. */
function screenOf(terminalId: string, lines?: number): string {
  if (!lines || lines <= 0) {
    const viewport = readTerminalById(terminalId)

    return viewport ? viewport.text : notStarted()
  }

  const whole = readTerminalById(terminalId, { count: 100_000, start: 0 })

  if (!whole) {
    return notStarted()
  }

  const all = whole.text.split('\n')

  return all.slice(Math.max(0, all.length - lines)).join('\n')
}

/**
 * Does this pane look like it is sitting at a prompt?
 *
 * A HEURISTIC, and named like one. Without shell integration (OSC 133) there
 * is no truthful signal for "the foreground job finished" — so this reads the
 * last non-blank line and asks whether it ends in a prompt character. It is
 * right for the interactive shells iT opens and wrong for anything that paints
 * its own screen (a pager, an editor, a TUI), which is precisely the case
 * `wait-idle` exists to surface rather than hide: a driver that gets `busy`
 * forever has been told something true.
 */
function looksIdle(terminalId: string): boolean {
  const read = readTerminalById(terminalId)

  return read ? screenLooksIdle(read.text) : false
}

/** Wait for a pane to settle AND look like it is at a prompt. */
async function waitIdle(terminalId: string, seconds: number): Promise<string> {
  const deadline = Date.now() + Math.max(1, seconds) * 1000
  let last = ''
  let stable = 0

  while (Date.now() < deadline) {
    const now = readTerminalById(terminalId)?.text ?? ''

    stable = now === last ? stable + 300 : 0
    last = now

    if (stable >= 900 && looksIdle(terminalId)) {
      return 'idle'
    }

    await sleep(300)
  }

  return 'busy'
}

/**
 * Run a command in one pane and hand back what it printed.
 *
 * "Done" is inferred the way a human does it: the screen stops changing. A
 * fixed sleep either truncates real work or wastes the caller's time, and
 * there is no exit-code channel through a PTY screen — so it settles on two
 * consecutive identical reads, with a hard ceiling.
 */
async function execInPane(terminalId: string, command: string, waitSeconds: number): Promise<string> {
  if (!terminalIsLive(terminalId)) {
    return notStarted()
  }

  // Anchor on the CURSOR, not on the buffer length: a fresh terminal's buffer
  // is already `rows` long, so a command that prints two lines does not grow it
  // at all and a length-anchored slice came back empty.
  const before = readTerminalById(terminalId)?.cursor_row ?? 0

  writeToTerminal(terminalId, `${toPtyText(command)}\r`)

  const deadline = Date.now() + Math.max(1, waitSeconds) * 1000
  let last = ''
  let stableFor = 0

  while (Date.now() < deadline) {
    await sleep(250)

    const now = readTerminalById(terminalId)?.text ?? ''

    if (now === last) {
      stableFor += 250

      if (stableFor >= 750) {
        break
      }
    } else {
      last = now
      stableFor = 0
    }
  }

  const after = readTerminalById(terminalId, { count: 4000, start: Math.max(0, before) })

  return after?.text ?? last
}

/** A title shaped like a ref (`3`) could never be addressed by its title. */
function refShapedTitle(title: string): string {
  return `it: "${title.trim()}" reads as a tab number — pick a title with a word in it`
}

/** The refusal for a title more than one workspace carries. */
function ambiguousRef(ref: string): string | undefined {
  const count = itWorkspacesTitled(ref)

  return count > 1 ? `it: "${ref.trim()}" matches ${count} tabs — use its number (\`it list\`)` : undefined
}

/** Commands whose words after the options are TEXT for a shell (`it send
 *  grep -i x`): there `-i` is refused only before the text starts. */
const TEXT_COMMANDS = new Set(['exec', 'run', 'send'])

/** The instance grammar is gone: `--instance`, `--instance=N` and `-i` are refused
 *  in any position (an instance is a workspace now). */
function instanceFlagIn(command: string, raw: readonly string[]): boolean {
  const isInstance = (word: string) => word === '--instance' || word.startsWith('--instance=')

  if (command === 'instance' || command === 'instances' || raw.some(isInstance)) {
    return true
  }

  return TEXT_COMMANDS.has(command) ? raw[0] === '-i' : raw.includes('-i')
}

/** Exported for tests: one `it` invocation, exactly as the CLI relays it. */
export function runItCommand(argv: string[]): Promise<string> | string {
  const [command, ...raw] = argv.length ? argv : ['help']
  const flags: ItFlags = parseItFlags(raw)
  const rest = flags.rest

  if (instanceFlagIn(command, raw)) {
    return 'it: there is one iT — address a tab with --workspace <n|title> (`it list`)'
  }

  const workspace = targetWorkspace(flags.workspace)

  switch (command) {
    case 'help':

    case '--help':

    case '-h':
      return HELP
    case 'status': {
      const workspaces = scopeWorkspaces()
      const inft = $activeInft.get()
      const session = $privySession.get()

      return [
        `iclone os · it control`,
        `workspaces: ${workspaces.length} (active: ${workspace?.title ?? 'none'})`,
        `panes here: ${workspace ? listPanes(workspace.layout).length : 0}`,
        `stage: ${inft ? inft.name : 'no iNFT summoned'}`,
        `wallet: ${session.status === 'in' ? 'connected' : 'signed out'}`
      ].join('\n')
    }

    case 'list':
      return scopeWorkspaces()
        .map(
          (item, index) =>
            `${item.id === activeItWorkspace()?.id ? '●' : ' '} ${index + 1}  ${item.title}  [${listPanes(item.layout).length}p]${item.unread ? '  *' : ''}`
        )
        .join('\n')
    case 'new': {
      if (isRefShapedTitle(rest.join(' '))) {
        return refShapedTitle(rest.join(' '))
      }

      const created = addItWorkspace(rest.join(' '))

      openItSurface()

      return `opened ${created.title}`
    }

    case 'use':
    case 'focus': {
      const target = findItWorkspace(rest.join(' '))

      if (!target) {
        return ambiguousRef(rest.join(' ')) ?? `it: no workspace is "${rest.join(' ')}" (its number or its exact title)`
      }

      setItActive(target.id)
      openItSurface()

      return `active: ${target.title}`
    }

    case 'close': {
      // Closing kills shells: exact refs only, and a busy one needs --force.
      const force = rest.includes('--force')
      const ref = rest.filter(word => word !== '--force').join(' ')
      const target = findItWorkspace(ref)

      if (!target) {
        return ambiguousRef(ref) ?? `it: no workspace is "${ref}" (its number or its exact title)`
      }

      const busy = force ? 0 : busyShellCount(listPanes(target.layout))

      if (busy > 0) {
        return `it: ${target.title} has ${busy === 1 ? '1 busy shell' : `${busy} busy shells`} — pass --force to close it anyway`
      }

      return closeItWorkspace(target.id) ? `closed ${target.title}` : 'it: the last workspace never closes'
    }

    case 'rename': {
      const [ref, ...title] = rest
      const target = ref ? findItWorkspace(ref) : undefined

      if (!target) {
        return ambiguousRef(ref ?? '') ?? `it: no workspace is "${ref ?? ''}" (its number or its exact title)`
      }

      if (isRefShapedTitle(title.join(' '))) {
        return refShapedTitle(title.join(' '))
      }

      return renameItWorkspace(target.id, title.join(' '))
        ? `renamed to ${title.join(' ')}`
        : 'it: rename needs a title'
    }

    // ── panes ────────────────────────────────────────────────────────────

    case 'panes':
    case 'list-panes': {
      if (!workspace) {
        return 'it: no active workspace'
      }

      if (rest.includes('--json')) {
        return panesJson(listPanes(workspace.layout))
      }

      const pool = $terminals.get()

      return listPanes(workspace.layout)
        .map((terminalId, index) => {
          const term = pool.find(item => item.id === terminalId)
          const mark = terminalId === workspace.focusTerminalId ? '●' : ' '
          const live = terminalIsLive(terminalId) ? 'live' : 'idle'

          // The id is what survives a layout change; the index does not. It is
          // printed whole because only an exact id addresses a pane.
          return `${mark} ${index + 1}  ${terminalId}  ${term?.title ?? 'shell'}  ${live}  ${term?.restoreCwd || term?.cwd || ''}`
        })
        .join('\n')
    }

    case 'split':

    case 'new-split':
    case 'vsplit': {
      if (!workspace) {
        return 'it: no active workspace'
      }

      const where = (rest[0] ?? '').toLowerCase()
      const dir = command === 'vsplit' || where === 'down' || where === 'up' ? 'v' : 'h'

      openItSurface()

      if (!canSplitItPane(workspace.id, dir)) {
        return `it: the focused pane is too small to split ${dir === 'v' ? 'down' : 'right'} — close or zoom a pane first`
      }

      const created = splitItPane(workspace.id, dir)

      if (!created) {
        return 'it: could not split'
      }

      const panes = listPanes(activeItWorkspace()!.layout)

      return `split ${dir === 'v' ? 'down' : 'right'} — ${panes.length} panes, focus on pane ${panes.indexOf(created) + 1}`
    }

    case 'focus-pane': {
      const terminalId = targetTerminal(workspace, flags.pane ?? rest[0])

      if (!workspace || !terminalId) {
        return `it: no pane ${rest[0] ?? flags.pane ?? ''}`
      }

      focusItPane(workspace.id, terminalId)
      setActiveTerminalId(terminalId)

      return `focused ${paneLabel(workspace, terminalId)}`
    }

    case 'next-pane':

    case 'previous-pane':
    case 'prev-pane': {
      if (!workspace) {
        return 'it: no active workspace'
      }

      cycleItPane(workspace.id, command === 'next-pane' ? 1 : -1)

      const now = activeItWorkspace()!

      return `focused ${paneLabel(now, now.focusTerminalId)}`
    }

    case 'close-pane': {
      // The same guard as ⌘W and the pane ×: a busy shell needs --force, and
      // a workspace's last pane closes the workspace (never iT's last shell).
      const force = rest.includes('--force')
      const terminalId = targetTerminal(workspace, flags.pane ?? rest.filter(word => word !== '--force')[0])

      if (!workspace || !terminalId) {
        return 'it: no such pane'
      }

      const label = paneLabel(workspace, terminalId)
      // The CLI answers in text: it never raises, replaces or clears the
      // rail's prompt.
      const result = requestCloseItPane(workspace.id, terminalId, force, false)

      if (result === 'prompt') {
        return `it: ${label} has a busy shell — pass --force to close it anyway`
      }

      return result === 'closed' ? `closed ${label}` : 'it: the last pane never closes'
    }

    case 'equalize':
    case 'equalize-splits': {
      if (!workspace) {
        return 'it: no active workspace'
      }

      equalizeItPanes(workspace.id)

      return 'splits equalized'
    }

    case 'zoom':
    case 'toggle-split-zoom': {
      if (!workspace) {
        return 'it: no active workspace'
      }

      return toggleItZoom(workspace.id) ? 'zoom toggled' : 'it: nothing to zoom (one pane)'
    }

    case 'break-pane': {
      if (!workspace) {
        return 'it: no active workspace'
      }

      return breakItPane(workspace.id) ? 'pane lifted into its own workspace' : 'it: nothing to break out (one pane)'
    }

    // ── doing work ───────────────────────────────────────────────────────

    case 'send': {
      const text = rest.join(' ')
      const terminalId = targetTerminal(workspace, flags.pane)

      if (!workspace || !terminalId) {
        return 'it: no such pane'
      }

      if (!text) {
        return 'it: send needs text'
      }

      const payload = toPtyText(text)

      if (!writeToTerminal(terminalId, flags.enter ? `${payload}\r` : payload)) {
        return notStarted()
      }

      return `sent to ${paneLabel(workspace, terminalId)}`
    }

    case 'send-key': {
      const key = (rest[0] ?? '').toLowerCase()
      const bytes = KEY_BYTES[key]
      const terminalId = targetTerminal(workspace, flags.pane)

      if (!workspace || !terminalId) {
        return 'it: no such pane'
      }

      if (!bytes) {
        return `it: unknown key "${rest[0] ?? ''}" — ${Object.keys(KEY_BYTES).join(' · ')}`
      }

      return writeToTerminal(terminalId, bytes) ? `${key} → ${paneLabel(workspace, terminalId)}` : notStarted()
    }

    case 'read-screen':
    case 'capture-pane': {
      const terminalId = targetTerminal(workspace, flags.pane)

      if (!terminalId) {
        return 'it: no such pane'
      }

      // A pane that ran `env` shows its bus token; whoever reads the screen gets it masked.
      return redactPaneTokens(screenOf(terminalId, flags.lines))
    }

    case 'exec':
    case 'run': {
      const text = rest.join(' ').trim()
      const terminalId = targetTerminal(workspace, flags.pane)

      if (!workspace || !terminalId) {
        return 'it: no such pane'
      }

      if (!text) {
        return `it: ${command} needs a command`
      }

      openItSurface()

      return execInPane(terminalId, text, flags.wait ?? 20)
    }

    case 'idle': {
      const terminalId = targetTerminal(workspace, flags.pane)

      if (!terminalId) {
        return 'it: no such pane'
      }

      return looksIdle(terminalId) ? 'idle' : 'busy'
    }

    case 'wait-idle': {
      const terminalId = targetTerminal(workspace, flags.pane)

      if (!terminalId) {
        return 'it: no such pane'
      }

      return waitIdle(terminalId, flags.wait ?? 60)
    }

    case 'rename-pane': {
      const terminalId = targetTerminal(workspace, flags.pane)
      const title = rest.join(' ').trim()

      if (!terminalId) {
        return 'it: no such pane'
      }

      if (!title) {
        return 'it: rename-pane needs a title'
      }

      renameTerminal(terminalId, title)

      return `renamed to ${title}`
    }

    // ── the app ──────────────────────────────────────────────────────────

    case 'open': {
      if (rest[0]?.toLowerCase() === 'settings') {
        return openSettingsPane(rest[1])
      }

      openItSurface()

      return 'iT view opened'
    }

    case 'msg':

    case 'message':
      window.location.hash = '#/'
      setMsgView('chat')

      return 'message view opened'
    case 'chat': {
      const text = rest.join(' ').trim()

      if (!text) {
        return 'it: chat needs text'
      }

      window.location.hash = '#/'
      setMsgView('chat')
      requestComposerInsert(text, { mode: 'block', target: 'main' })
      requestComposerFocus('main')

      return 'dropped into the composer'
    }

    case 'state':
    case 'ui': {
      const root = document.documentElement
      const hash = window.location.hash.replace(/^#/, '') || '/'
      const workspaces = scopeWorkspaces()
      const inft = $activeInft.get()
      const session = $privySession.get()
      const roster = $inftRoster.get()
      // The open dock window, with its status line and any error note — so a
      // terminal can tell "Email · updated 3 s ago" from "Email · ALERT …".
      const econHead = document.querySelector('.iecon .iecon__head h2')?.textContent?.trim()
      const econStatus = document.querySelector('.iecon .iecon__status')?.textContent?.trim()
      const econAlert = document.querySelector('.iecon [role="alert"]')?.textContent?.trim()

      const econ = econHead
        ? [econHead, econStatus, econAlert && `ALERT ${econAlert}`].filter(Boolean).join(' · ')
        : null

      const labels = [...new Set(clickables().map(c => c.label))].slice(0, 48)

      return [
        `route: ${hash}`,
        `message window: ${root.dataset.icloneWindow ? `open · view ${root.dataset.icloneView}` : 'closed'}`,
        `it workspaces: ${workspaces
          .map(item => `${item.id === workspace?.id ? '●' : ''}${item.title}[${listPanes(item.layout).length}p]`)
          .join(' ')}`,
        `it panes live: ${workspace ? listPanes(workspace.layout).filter(terminalIsLive).length : 0}`,
        `stage: ${inft ? inft.name : 'no iNFT summoned'}`,
        `wallet: ${session.status === 'in' ? `connected · ${roster.length} iNFT` : 'signed out'}`,
        `collections panel: ${document.querySelector('.inft-panel') ? 'open' : 'closed'}`,
        `econ panel: ${econ ?? 'closed'}`,
        `theme: ${root.dataset.hermesTheme ?? 'default'}`,
        ``,
        `clickable now: ${labels.join(' · ')}`
      ].join('\n')
    }

    case 'click': {
      const wanted = rest.join(' ').trim().toLowerCase()

      if (!wanted) {
        return 'it: click needs a control name (see `it state`)'
      }

      // A name is resolved the way a USER sees the app: the window on top
      // first, the shell beneath it only as a fallback. Without this,
      // `it click "message"` inside Settings matched the dock's Message
      // button (whole-document DOM order) and dumped the caller into the
      // chat — the settings pane of the same name was unreachable by CLI.
      const overlay = topOverlaySurface()
      const scoped = overlay ? clickables(overlay) : []
      const all = clickables()

      const hit =
        scoped.find(c => c.label.toLowerCase() === wanted) ??
        scoped.find(c => c.label.toLowerCase().includes(wanted)) ??
        all.find(c => c.label.toLowerCase() === wanted) ??
        all.find(c => c.label.toLowerCase().includes(wanted))

      if (!hit) {
        return `it: no visible control matches "${rest.join(' ')}"`
      }

      if (hit.el.closest('[data-it-noclick]')) {
        return `it: "${hit.label}" is a confirmation only a person can press — ask the user to click it`
      }

      hit.el.click()

      return `clicked: ${hit.label}`
    }

    case 'notify': {
      const text = rest.join(' ').trim() || 'iT'

      void window.hermesDesktop?.notify({ title: 'iT — iclone os', body: text })

      return 'notified'
    }

    case 'spawn':
      return spawnCommand(rest)

    case 'watch':
      return watchCommand(rest[0])

    case 'collect':
      return collectCommand(rest[0])

    case 'tmux':
      return tmuxCommand(rest)

    case 'bus':
      return 'it bus: run it inside an iT pane — the bus answers the pane, not the app (`it help`)'
    case 'inft': {
      const inft = $activeInft.get()
      const roster = $inftRoster.get()
      const lines = [`stage: ${inft ? inft.name : 'none'}`]

      for (const card of roster) {
        lines.push(
          `${card.configured ? '●' : '○'} ${card.name} · ${card.chain} · ${card.configured ? 'economyos' : 'setup needed'}`
        )
      }

      if (roster.length === 0) {
        lines.push('(no wallet connected — the roster is empty)')
      }

      return lines.join('\n')
    }

    default:
      return `it: unknown command "${command}"\n\n${HELP}`
  }
}

let initialized = false

/** Idempotent — wiring imports this once per window. */
export function initItCommands() {
  if (initialized) {
    return
  }

  initialized = true
  initPaneAttention()

  bridge()?.onCmd(({ id, argv }) => {
    void (async () => {
      let output: string

      try {
        output = await runItCommand(argv.map(String))
      } catch (error) {
        output = `it: ${error instanceof Error ? error.message : 'command failed'}`
      }

      bridge()?.reply(id, output)
    })()
  })

  // The agent's `read_terminal` tool reads "the active terminal"; in a
  // multiplexed surface that is iT's focused pane. Keep the two in step.
  // Re-asserted after every change, since createTerminal() moves the pool's
  // active id.
  const follow = () => setActiveTerminalId(activeItWorkspace()?.focusTerminalId ?? null)

  $itInstances.subscribe(follow)
}
