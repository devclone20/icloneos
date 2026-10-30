import './it-terminal.css'

/**
 * iT — the terminal inside the Message window (owner rule: "dentro do chat vai
 * estar o terminal"), a real MULTIPLEXER in the HUB iT grammar (clean-room:
 * behaviour recreated, never cmux code).
 *
 * Workspaces on the rail; inside each one a binary tree of PANES — ⌘D splits
 * right, ⌘⇧D splits down, the hairline dividers drag-resize (ratio clamped
 * 12–88%), a click focuses a pane, ⌘⇧↩ zooms it, ⌃⌘= equalizes, ⌥⌘←→ walks
 * the focus, and closing a pane promotes its sibling.
 *
 * This file draws NO terminal. Each leaf is an empty slot carrying its shell's
 * id; the host (it-host.tsx) parks the real xterm over it. That is deliberate
 * and load-bearing: mounting the xterm in here meant every split reparented it
 * and the shell was destroyed mid-sentence.
 *
 * State lives in it-store.ts — shared with the `it` CLI, so the same layout is
 * driven from any terminal on the machine.
 */
import { useStore } from '@nanostores/react'
import { Columns2, Maximize2, Plus, Rows2, X } from 'lucide-react'
import { useCallback, useEffect } from 'react'

import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import {
  $itClosePrompt,
  confirmItClose,
  dismissItClose,
  handleItHubKey,
  requestCloseItPane,
  requestCloseItWorkspace
} from './it-keys'
import { IT_MESSAGE_INSTANCE, type ItPaneNode, type ItWorkspace, listPanes } from './it-layout'
import {
  $itBodySize,
  $itInstances,
  $itSurfaceOpen,
  activeItWorkspace,
  addItWorkspace,
  canSplitItPane,
  focusItPane,
  setItActive,
  setItPaneRatio,
  splitItPane,
  toggleItZoom
} from './it-store'
import { $paneStates } from './it/bus/attention'
import { IT_EXIT_HINT_ID } from './it/engine/focus-exit'

function startDividerDrag(
  event: React.PointerEvent<HTMLDivElement>,
  workspaceId: string,
  nodeId: string,
  dir: 'h' | 'v'
) {
  event.preventDefault()

  const container = (event.currentTarget as HTMLDivElement).parentElement

  if (!container) {
    return
  }

  const rect = container.getBoundingClientRect()

  const move = (pointer: PointerEvent) => {
    const ratio =
      dir === 'h'
        ? (pointer.clientX - rect.left) / Math.max(rect.width, 1)
        : (pointer.clientY - rect.top) / Math.max(rect.height, 1)

    setItPaneRatio(workspaceId, nodeId, ratio)
  }

  const end = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
  }

  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
}

/** One pane: an empty box the host parks a shell over. */
function PaneSlot({ multi, terminalId, workspace }: { multi: boolean; terminalId: string; workspace: ItWorkspace }) {
  const { t } = useI18n()
  const focused = workspace.focusTerminalId === terminalId
  const attention = useStore($paneStates, { keys: [terminalId] })[terminalId]?.state === 'needs-input'

  return (
    <div
      className={cn('itwin__pane', focused && multi && 'itwin__pane--focus', attention && 'itwin__pane--attention')}
      data-attention={attention ? '' : undefined}
      data-it-slot={terminalId}
      onPointerDownCapture={() => focusItPane(workspace.id, terminalId)}
    >
      {multi && (
        <button
          aria-label={t.desktop.home.itClosePane}
          className="itwin__pane-close"
          onClick={() => requestCloseItPane(workspace.id, terminalId)}
          type="button"
        >
          <X size={10} strokeWidth={2} />
        </button>
      )}
    </div>
  )
}

function PaneTree({ multi, node, workspace }: { multi: boolean; node: ItPaneNode; workspace: ItWorkspace }) {
  if (node.type === 'leaf') {
    return <PaneSlot multi={multi} terminalId={node.terminalId} workspace={workspace} />
  }

  return (
    <div className={cn('itwin__split', node.dir === 'h' ? 'itwin__split--h' : 'itwin__split--v')}>
      <div className="itwin__cell" style={{ flex: `${node.ratio} 1 0%` }}>
        <PaneTree multi={multi} node={node.a} workspace={workspace} />
      </div>
      <div
        className="itwin__div"
        onPointerDown={event => startDividerDrag(event, workspace.id, node.id, node.dir)}
        role="separator"
      />
      <div className="itwin__cell" style={{ flex: `${1 - node.ratio} 1 0%` }}>
        <PaneTree multi={multi} node={node.b} workspace={workspace} />
      </div>
    </div>
  )
}

const activeWorkspaceId = () => activeItWorkspace()?.id ?? ''

/** The busy prompt of a pending close, in the rail (design frozen: rail tokens). */
function ClosePrompt() {
  const prompt = useStore($itClosePrompt)
  const { t } = useI18n()

  if (!prompt) {
    return null
  }

  const shells = t.desktop.home.itBusyShells(prompt.busy)

  return (
    <span className="itwin__tab itwin__tab--on" role="alertdialog">
      {shells} — {t.desktop.home.itCloseAnyway(Boolean(prompt.terminalId))}
      <button className="itwin__tab-name" onClick={() => confirmItClose()} type="button">
        {t.desktop.home.itClose}
      </button>
      <button className="itwin__tab-name" onClick={() => dismissItClose()} type="button">
        Keep
      </button>
    </span>
  )
}

export function ItTerminal({ open }: { open: boolean }) {
  const { t } = useI18n()
  const instance = useStore($itInstances).find(item => item.id === IT_MESSAGE_INSTANCE)
  const workspaces = instance?.workspaces ?? []
  const activeId = instance?.activeId ?? ''
  const activeWorkspace = workspaces.find(workspace => workspace.id === activeId)
  const activePanes = activeWorkspace ? listPanes(activeWorkspace.layout) : []
  // canSplitItPane reads the measured body; subscribing re-renders the split
  // buttons when a resize or a divider drag changes whether the halves fit.
  useStore($itBodySize)
  const canSplitRight = activeWorkspace ? canSplitItPane(activeWorkspace.id, 'h') : false
  const canSplitDown = activeWorkspace ? canSplitItPane(activeWorkspace.id, 'v') : false

  const zoomedPane =
    activeWorkspace?.zoomedTerminalId && activePanes.includes(activeWorkspace.zoomedTerminalId)
      ? activeWorkspace.zoomedTerminalId
      : null

  // The host paints only what this says is on screen, so it can never show a
  // shell over a surface that has been switched away or closed.
  useEffect(() => {
    $itSurfaceOpen.set(open)

    return () => $itSurfaceOpen.set(false)
  }, [open])

  // The HUB keybindings (it-keys.ts) for the section; the host's shell divs
  // run the same routine for keys typed into a shell.
  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    handleItHubKey(event)
  }, [])

  return (
    <section
      aria-label={t.desktop.home.itTerminal}
      className={open ? 'itwin' : 'itwin itwin--hidden'}
      data-it-instance={IT_MESSAGE_INSTANCE}
      data-scope="message"
      onKeyDownCapture={onKeyDown}
    >
      <header className="itwin__rail">
        <span className="itwin__mark">iT</span>
        {workspaces.map(workspace => {
          const panes = listPanes(workspace.layout).length

          return (
            <span className={workspace.id === activeId ? 'itwin__tab itwin__tab--on' : 'itwin__tab'} key={workspace.id}>
              <button className="itwin__tab-name" onClick={() => setItActive(workspace.id)} type="button">
                <i aria-hidden className={cn('itwin__light', workspace.unread && 'itwin__light--unread')} />
                {workspace.title}
                {panes > 1 && <em className="itwin__panes-n">{panes}</em>}
              </button>
              {workspaces.length > 1 && (
                <button
                  aria-label={t.desktop.home.itCloseTab(workspace.title)}
                  className="itwin__tab-close"
                  onClick={() => requestCloseItWorkspace(workspace.id)}
                  type="button"
                >
                  <X size={11} strokeWidth={2} />
                </button>
              )}
            </span>
          )
        })}
        <button
          aria-label={t.desktop.home.itNewTab}
          className="itwin__add"
          onClick={() => addItWorkspace()}
          type="button"
        >
          <Plus size={13} strokeWidth={2} />
        </button>
        <ClosePrompt />
        <span className="itwin__rail-gap" />
        <Tip label={canSplitRight ? t.desktop.home.itSplitRightTip : t.desktop.home.itSplitRightSmall}>
          <button
            aria-disabled={!canSplitRight || undefined}
            aria-label={t.desktop.home.itSplitRight}
            className="itwin__add"
            onClick={() => canSplitRight && splitItPane(activeWorkspaceId(), 'h')}
            type="button"
          >
            <Columns2 size={13} strokeWidth={1.8} />
          </button>
        </Tip>
        <Tip label={canSplitDown ? t.desktop.home.itSplitDownTip : t.desktop.home.itSplitDownSmall}>
          <button
            aria-disabled={!canSplitDown || undefined}
            aria-label={t.desktop.home.itSplitDown}
            className="itwin__add"
            onClick={() => canSplitDown && splitItPane(activeWorkspaceId(), 'v')}
            type="button"
          >
            <Rows2 size={13} strokeWidth={1.8} />
          </button>
        </Tip>
        <Tip label={t.desktop.home.itZoomTip}>
          <button
            aria-label={t.desktop.home.itZoom}
            className="itwin__add"
            onClick={() => toggleItZoom(activeWorkspaceId())}
            type="button"
          >
            <Maximize2 size={12} strokeWidth={1.8} />
          </button>
        </Tip>
      </header>
      {/* ONLY the active workspace lays out slots. An inactive one used to keep
          its own hidden copy, and `visibility: hidden` still occupies layout —
          so the host measured two slots carrying the same terminal id and the
          loser's rect won at random. The shells do not live in here any more,
          so there is nothing to keep mounted for a workspace nobody is
          looking at. */}
      <div className="itwin__body">
        <span className="itwin__sr" id={IT_EXIT_HINT_ID}>
          {t.desktop.home.itExitHint}
        </span>
        {activeWorkspace && (
          <div className="itwin__tabpane itwin__tabpane--on" key={activeWorkspace.id}>
            {zoomedPane ? (
              <PaneSlot multi={activePanes.length > 1} terminalId={zoomedPane} workspace={activeWorkspace} />
            ) : (
              <PaneTree multi={activePanes.length > 1} node={activeWorkspace.layout} workspace={activeWorkspace} />
            )}
          </div>
        )}
      </div>
    </section>
  )
}
