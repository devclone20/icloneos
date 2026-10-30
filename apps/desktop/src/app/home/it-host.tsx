/**
 * The iT terminal HOST — every shell iT knows about, mounted exactly once and
 * never moved again.
 *
 * This is the same trick Hermes Desktop already used for its single terminal
 * (the upstream sidebar's single-terminal host, deleted in E3c), generalised
 * to N: moving an xterm's
 * host element detaches its WebGL renderer — it observes its own attachment —
 * and the screen resets. iT used to mount each xterm INSIDE the pane tree, so
 * every split reparented the focused leaf under two new wrapper elements,
 * React tore the old instance down, and the shell (with everything written in
 * it) went with it. That is the owner's "when I split, what was written
 * disappears".
 *
 * Now the tree renders empty SLOTS (`[data-it-slot="<terminal id>"]`, in
 * it-terminal.tsx) and this host parks one fixed-position xterm over each. The
 * React list here is flat and keyed by terminal id, so a terminal's DOM never
 * changes parent for the whole life of the shell — splitting, resizing,
 * zooming, switching workspace and closing a neighbour are all just new rects.
 */
import { useStore } from '@nanostores/react'
import { type CSSProperties, type JSX, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { ErrorBoundary } from '@/components/error-boundary'

import { zIndex } from './ic-layers'
import { $itCrashProbe, ItCrashProbe, ItPaneCrashCard } from './it-cards'
import { readSlotsIn, sameSlots, type SlotRect, slotsBounds } from './it-host-rects'
import { $itClosePrompt, canCloseItPane, closeFocusedItPane, handleItHubKey, requestCloseItPane } from './it-keys'
import { IT_MESSAGE_INSTANCE, listPanes } from './it-layout'
import {
  $itBodySize,
  $itInstances,
  $itSurfaceOpen,
  activeItWorkspace,
  focusItPane,
  instanceTerminalIds,
  locateItTerminal,
  openItSurface,
  splitItPane
} from './it-store'
import { readTerminalById, writeToTerminal } from './it/engine/buffer'
import { AgentTerminalInstance, TerminalInstance } from './it/engine/instance'
import { $terminals } from './it/engine/terminals'

type SelectionSink = (text: string, label?: string) => void

/**
 * The iT body in LAYOUT pixels. The Message window scales while it opens and
 * retracts, and a client rect taken mid-transform is a fraction of the real
 * body — the split floor then refused every split. offsetWidth/Height ignore
 * transforms, so one slot gives the scale to undo.
 */
function layoutBody(
  own: HTMLElement | null,
  rects: Record<string, SlotRect>
): null | { height: number; width: number } {
  const bounds = slotsBounds(rects)
  const slot = own?.querySelector<HTMLElement>('[data-it-slot]')
  const r = slot?.getBoundingClientRect()

  if (!bounds || !slot || !r || r.width <= 0 || r.height <= 0) {
    return bounds
  }

  return {
    height: Math.round(bounds.height * (slot.offsetHeight / r.height)),
    width: Math.round(bounds.width * (slot.offsetWidth / r.width))
  }
}

/**
 * The shells of the iT surface (the Message window's iT view), fixed in
 * viewport pixels at `global.shells`, under `.ihome`. Mounted once, by the
 * primary window only (wiring.tsx) — a ⌘⇧N peer never hosts a shell.
 */
export function ItTerminalHost({ onAddSelectionToChat }: { onAddSelectionToChat: SelectionSink }): JSX.Element | null {
  const terminals = useStore($terminals)
  const instances = useStore($itInstances)
  const surfaceOpen = useStore($itSurfaceOpen)
  const instance = instances.find(item => item.id === IT_MESSAGE_INSTANCE)
  const [slots, setSlots] = useState<Record<string, SlotRect>>({})
  const slotsRef = useRef(slots)

  slotsRef.current = slots

  const measure = useCallback(() => {
    // Only the iT section's own slots — nothing else on the page carries them.
    const own = document.querySelector<HTMLElement>(`[data-it-instance='${IT_MESSAGE_INSTANCE}']`)
    const next = own ? readSlotsIn(own) : {}

    if (!sameSlots(slotsRef.current, next)) {
      const body = $itSurfaceOpen.get() ? layoutBody(own, next) : null

      // Kept while iT is hidden: a CLI split then still knows the body.
      if (body) {
        $itBodySize.set(body)
      }

      slotsRef.current = next
      setSlots(next)

      return true
    }

    return false
  }, [])

  // One coalesced pass per burst, then one settle pass — a split changes
  // several rects in the same frame and the flex layout lands a frame later.
  //
  // NEVER frames alone. Electron throttles requestAnimationFrame while the
  // window is occluded or backgrounded (deliberately — see the throttling
  // note in electron/main.ts), and the first version of this scheduler parked
  // a rAF that simply never fired in that state: `frameRef` stayed non-zero,
  // every later schedule() early-returned, and the measurement pipeline was
  // dead until the window got focus again. A split during that stall left the
  // old shell stretched across BOTH slots and the new shell at 0×0 — clicks
  // on the second pane landed in the first shell, which reads as "the app
  // stopped accepting clicks". So: a timer races the frame (timers survive
  // throttling, merely clamped), and whichever fires first runs the pass.
  const frameRef = useRef(0)
  const timerRef = useRef(0)

  const cancelPending = useCallback(() => {
    if (frameRef.current !== 0) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = 0
    }

    if (timerRef.current !== 0) {
      window.clearTimeout(timerRef.current)
      timerRef.current = 0
    }
  }, [])

  const schedule = useCallback(() => {
    if (frameRef.current !== 0 || timerRef.current !== 0) {
      return
    }

    const run = () => {
      if (frameRef.current !== 0) {
        window.cancelAnimationFrame(frameRef.current)
        frameRef.current = 0
      }

      if (timerRef.current !== 0) {
        window.clearTimeout(timerRef.current)
        timerRef.current = 0
      }

      if (measure()) {
        schedule()
      }
    }

    frameRef.current = window.requestAnimationFrame(run)
    timerRef.current = window.setTimeout(run, 200)
  }, [measure])

  useLayoutEffect(() => {
    // The structural changes measure SYNCHRONOUSLY: a layout effect runs
    // after the DOM is committed and laid out, so the rects are already
    // exact — no frame required, throttled or not. schedule() stays as the
    // settle pass for anything the flex layout moves one frame later.
    measure()
    schedule()
  }, [instance, measure, schedule, surfaceOpen])

  useLayoutEffect(() => {
    const onResize = () => schedule()

    window.addEventListener('resize', onResize)

    // The iT body is inside the Message window, which moves with the window
    // chrome (expand/retract, a right-edge island). All of that is driven by
    // custom properties and data attributes on <html> (`--iwin-*`,
    // `--iclone-island-w`, `data-iclone-*`), and <html>'s own box never
    // changes size when they do — a ResizeObserver on it stayed silent, and
    // an expanded window kept its shells parked at the old rect. Watch the
    // attributes themselves instead; schedule() coalesces bursts (the opacity
    // slider writes a var per pointer move) into one pass per frame.
    const observer =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
            schedule()
          })

    observer?.observe(document.documentElement, { attributes: true })

    return () => {
      window.removeEventListener('resize', onResize)
      observer?.disconnect()
      cancelPending()
    }
  }, [cancelPending, schedule])

  useEffect(() => {
    return () => {
      if (frameRef.current !== 0) {
        window.cancelAnimationFrame(frameRef.current)
      }

      if (timerRef.current !== 0) {
        window.clearTimeout(timerRef.current)
      }
    }
  }, [])

  if (!instance) {
    return null
  }

  const workspace = instance.workspaces.find(item => item.id === instance.activeId)

  const visiblePanes = workspace
    ? workspace.zoomedTerminalId
      ? [workspace.zoomedTerminalId]
      : listPanes(workspace.layout)
    : []

  // A shell starts (deferStart) only once its pane is on screen here: a boot
  // that never opens iT spawns no PTY at all.
  const onScreen = new Set(surfaceOpen ? visiblePanes : [])
  // The host mounts only what the layout places (agent mirrors included).
  const mine = instanceTerminalIds(instance)

  return (
    <>
      {terminals
        .filter(term => mine.has(term.id))
        .map(term => {
          const rect = slots[term.id]
          const visible = onScreen.has(term.id) && Boolean(rect)
          // Exactly ONE keyboard owner: the focused pane. Agent mirrors too —
          // `focused` defaults to `active`, which would rank every visible
          // mirror first for a GPU context.
          const focused = visible && workspace?.focusTerminalId === term.id

          const style: CSSProperties = {
            contain: 'layout size paint',
            display: 'flex',
            flexDirection: 'column',
            height: rect?.height ?? 0,
            left: rect?.left ?? 0,
            // Electron can keep xterm's WebGL canvas composited after an ancestor
            // goes visibility:hidden; opacity clears that layer while the DOM,
            // the terminal dimensions and the live PTY all stay put.
            opacity: visible ? 1 : 0,
            // `auto` would override the Message opacity slider's gate; let the
            // stylesheet own it while visible (see `[data-it-host]` in home.css).
            pointerEvents: visible ? undefined : 'none',
            position: 'fixed',
            top: rect?.top ?? 0,
            visibility: visible ? 'visible' : 'hidden',
            width: rect?.width ?? 0,
            // Between the chat surface (38) and `.ihome` (40) — iT's own chrome
            // is inside .ihome and paints over these shells.
            zIndex: zIndex('global', 'shells')
          }

          return (
            <div
              aria-hidden={!visible}
              data-it-host={term.id}
              key={term.id}
              // The shells sit outside the iT section, so the HUB keys must be
              // caught here too.
              onKeyDownCapture={event => handleItHubKey(event)}
              // Clicking a shell focuses its pane. The slot above is
              // hit-transparent so the click reaches here at all.
              onPointerDownCapture={() => {
                const owner = locateItTerminal(term.id)

                if (owner) {
                  focusItPane(owner.workspace.id, term.id)
                }
              }}
              style={style}
            >
              <ErrorBoundary
                fallback={({ reset }) => (
                  <ItPaneCrashCard
                    onClose={
                      canCloseItPane(locateItTerminal(term.id)?.workspace.id ?? '', term.id)
                        ? () => {
                            const owner = locateItTerminal(term.id)

                            if (owner) {
                              requestCloseItPane(owner.workspace.id, term.id, true)
                            }
                          }
                        : undefined
                    }
                    onRetry={() => {
                      $itCrashProbe.set(null)
                      reset()
                    }}
                  />
                )}
                label={`it-shell:${term.id}`}
              >
                {import.meta.env.DEV && <ItCrashProbe target={term.id} />}
                {term.kind === 'agent' ? (
                  <AgentTerminalInstance active={visible} focused={focused} id={term.id} procId={term.procId!} />
                ) : (
                  <TerminalInstance
                    active={visible}
                    cwd={term.cwd}
                    deferStart
                    focused={focused}
                    id={term.id}
                    onAddSelectionToChat={onAddSelectionToChat}
                    restoreCwd={term.restoreCwd}
                    reviveBuffer={term.reviveBuffer}
                  />
                )}
              </ErrorBoundary>
            </div>
          )
        })}
    </>
  )
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  // The lab's handle on the ONE iT surface (gate probes in RESUME/run/gates/R5).
  const pane = (ref?: string) => ref || activeItWorkspace()?.focusTerminalId || ''

  Object.assign(window, {
    __icloneIt: {
      /** A terminal id → that pane throws; 'surface' → the whole iT view; null = heal. */
      crash: (target: null | string) => $itCrashProbe.set(target),
      /** What the macOS ⌘W IPC path calls (main claims the chord before the page sees it). */
      closeFocused: () => closeFocusedItPane(),
      open: () => openItSurface(),
      panes: () =>
        ($itInstances.get()[0]?.workspaces ?? []).flatMap(workspace =>
          listPanes(workspace.layout).map(id => ({
            focused: workspace.focusTerminalId === id,
            id,
            workspace: workspace.id
          }))
        ),
      prompt: () => $itClosePrompt.get(),
      read: (ref?: string) => readTerminalById(pane(ref))?.text ?? '',
      send: (ref: string | undefined, text: string) => writeToTerminal(pane(ref), text),
      split: (dir: 'h' | 'v' = 'h') => splitItPane(activeItWorkspace()?.id ?? '', dir),
      workspaces: () =>
        ($itInstances.get()[0]?.workspaces ?? []).map(workspace => ({
          active: workspace.id === $itInstances.get()[0]?.activeId,
          id: workspace.id,
          panes: listPanes(workspace.layout).length,
          title: workspace.title
        }))
    }
  })
}
