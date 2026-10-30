/**
 * The orchestration verbs of the `it` CLI — spawn, watch, collect, tmux —
 * answered in the renderer because they shape the layout. The bus verbs
 * themselves (`it bus …`) never come here: they go straight to main over the
 * pane's own socket.
 */
import { addItWorkspace, openItSurface } from '../../it-store'
import { readTerminalById } from '../engine/buffer'

import { $paneStates } from './attention'
import { paneBus, type PaneSummary, parseSpawnPlan, parseTmuxListing } from './bridge'
import { setPaneSpec } from './pane-meta'
import { redactPaneTokens } from './redact'
import { lastSpawnId, layOutSpawn, spawnedPanes } from './spawn'

const COLLECT_TAIL_LINES = 20
const TMUX_NAME_RE = /^[A-Za-z0-9_-]{1,48}$/

export const BUS_HELP = `  PANES THAT TALK  (inside an iT pane; each pane has a name — \`it bus whoami\`)
    it bus who [--json]                      panes on the bus, their state
    it bus send --to <name|@group> <text…>   leave a message (pull model)
    it bus ask --to <name> [--timeout s] <text…>   wait for an answer (60 s)
    it bus recv [--wait s] [--json]          read your messages
    it bus reply --corr <id> <text…>         answer an ask
    it bus reply --result <text…>            your result, for \`it collect\`
    it bus attention <text…>                 ring this pane until it is looked at

  ORCHESTRATION
    it spawn --spec <file.json>              up to 16 panes {name,role,cwd,cmd,env,group}
                                             env keys: PANE_* (STEP → PANE_STEP; the program
                                             reads $PANE_STEP), LC_*, or LANG, TZ, NODE_ENV…
    it watch [spawn]                         state and last signal of each pane
    it collect [spawn]                       each result, else the last 20 lines
    it tmux new [name] | attach <session> | ls | end <session>
                                             sessions that outlive the app`

function age(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))

  return seconds < 90 ? `${seconds}s` : `${Math.round(seconds / 60)}m`
}

function stateOf(terminalId: string): null | PaneSummary {
  return $paneStates.get()[terminalId] ?? null
}

export async function spawnCommand(rest: readonly string[]): Promise<string> {
  const at = (flag: string) => {
    const index = rest.indexOf(flag)

    return index >= 0 ? rest[index + 1] : undefined
  }

  const spec = at('--spec')
  const base = at('--base') ?? ''

  if (!spec) {
    return 'it: spawn needs --spec <file.json>'
  }

  const bus = paneBus()

  if (!bus) {
    return 'it: the pane bus is not available in this window'
  }

  const result = parseSpawnPlan(await bus.plan(spec.startsWith('/') ? spec : `${base}/${spec}`))

  if (!result.ok) {
    return `it: spawn refused (nothing was opened):\n  ${result.errors.join('\n  ')}`
  }

  openItSurface()
  const { spawnId, placed } = layOutSpawn(result.plan.panes, result.plan.layout)

  return [
    `spawned ${placed.length} panes — spawn ${spawnId}`,
    ...placed.map(pane => `  ${pane.name}  ${pane.terminalId}  (${pane.workspaceTitle})`),
    `follow: it watch ${spawnId} · results: it collect ${spawnId}`
  ].join('\n')
}

function spawnOrLast(ref: string | undefined): null | string {
  return ref ?? lastSpawnId()
}

export function watchCommand(ref: string | undefined): string {
  const spawnId = spawnOrLast(ref)
  const panes = spawnId ? spawnedPanes(spawnId) : []

  if (!panes.length) {
    return 'it: no spawn to watch (it spawn --spec <file>)'
  }

  return panes
    .map(pane => {
      const state = stateOf(pane.terminalId)
      const signal = state?.signal ? `${state.signal.text || state.signal.source} (${age(state.signal.at)} ago)` : '-'

      return `${pane.name}\t${state?.state ?? 'starting'}\t${state?.unread ?? 0} unread\t${signal}`
    })
    .join('\n')
}

export function collectCommand(ref: string | undefined): string {
  const spawnId = spawnOrLast(ref)
  const panes = spawnId ? spawnedPanes(spawnId) : []

  if (!panes.length) {
    return 'it: no spawn to collect (it spawn --spec <file>)'
  }

  return panes
    .map(pane => {
      const state = stateOf(pane.terminalId)

      if (state?.result) {
        return `── ${pane.name} · result\n${state.result}`
      }

      if (state?.exit) {
        const how = state.exit.signal ? `killed by ${state.exit.signal}` : `exit ${state.exit.code ?? '?'}`

        return `── ${pane.name} · ${how}`
      }

      const whole = readTerminalById(pane.terminalId, { count: 100_000, start: 0 })

      const tail = whole
        ? redactPaneTokens(whole.text.split('\n').slice(-COLLECT_TAIL_LINES).join('\n'))
        : '(no shell yet)'

      return `── ${pane.name} · ${state?.state ?? 'starting'} · last ${COLLECT_TAIL_LINES} lines\n${tail}`
    })
    .join('\n')
}

function openTmuxPane(tmux: { attach?: string; slug?: string }, title: string): string {
  openItSurface()
  const workspace = addItWorkspace(title)

  setPaneSpec(workspace.focusTerminalId, { tmux })

  return workspace.focusTerminalId
}

export async function tmuxCommand(rest: readonly string[]): Promise<string> {
  const [action = 'ls', name] = rest
  const bus = paneBus()

  if (!bus) {
    return 'it: the pane bus is not available in this window'
  }

  if (name !== undefined && !TMUX_NAME_RE.test(name)) {
    return `it: tmux names are 1-48 of A-Z a-z 0-9 _ -`
  }

  switch (action) {
    case 'new':
      return `tmux pane ${openTmuxPane({ slug: name ?? 'it' }, name ?? 'tmux')} — closing it detaches; \`it tmux end <session>\` ends it`

    case 'attach':
      return name ? `re-attached in pane ${openTmuxPane({ attach: name }, name)}` : 'it: tmux attach <session>'

    case 'end':
      return name && (await bus.tmuxEnd(name)) === true ? `ended ${name}` : `it: could not end ${name ?? '(no name)'}`
    case 'ls': {
      const listing = parseTmuxListing(await bus.tmuxList())

      if (!listing.ok) {
        return 'it: tmux is not installed on this Mac. To install it yourself: brew install tmux'
      }

      if (!listing.sessions.length) {
        return '(no iclone tmux sessions on this Mac)'
      }

      return listing.sessions
        .map(row => `${row.name}\t${row.attached ? 'attached' : 'detached — it tmux attach ' + row.name}`)
        .join('\n')
    }

    default:
      return 'it: tmux new [name] | attach <session> | ls | end <session>'
  }
}

export function panesJson(terminalIds: readonly string[]): string {
  return JSON.stringify(
    terminalIds.map((terminalId, index) => {
      const state = stateOf(terminalId)

      return {
        index: index + 1,
        id: terminalId,
        name: state?.name ?? null,
        state: state?.state ?? null,
        group: state?.group ?? null,
        unread: state?.unread ?? 0
      }
    })
  )
}
