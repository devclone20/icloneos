import { readActivePreview } from '@/app/chat/right-rail/preview-reader'
import { writeAgentTerminalChunk } from '@/app/right-sidebar/terminal/agent-terminal-stream'
import { readActiveTerminal } from '@/app/right-sidebar/terminal/buffer'
import { closeAgentTerminalByProc } from '@/app/right-sidebar/terminal/terminals'
import { errorMessage } from '@/iclone-shared/errors'
import { asFiniteNumber, asString } from '@/iclone-shared/guards'
import type { PreviewActAction } from '@/lib/preview-act/act-in-page'
import type { TourAction, TourStep } from '@/lib/tour'
import { applyDesktopLayoutPreset, revealDesktopPane } from '@/store/pane-focus'
import { recordAgentReaction } from '@/store/reactions-local'
import { setMessages } from '@/store/session'

import type { GatewayEventContext } from './types'

/** The preview engine, loaded on demand so ~25KB of page-injectable source stays
 *  off the boot path.
 *
 *  In dev that lazy chunk is also a trap. The browser caches a dynamic import by
 *  URL for the life of the page, so this bridge would hand every action to
 *  whichever build of the engine loaded first, and no edit to it — or to the
 *  overlay whose source it stringifies into the page — would reach the guest
 *  until the whole window reloaded. Asking for a fresh copy is more reliable
 *  than trusting hot-update propagation to reach a module nothing statically
 *  imports; the dev server stamps the dependency URLs it has invalidated, so a
 *  fresh engine pulls a fresh overlay down with it.
 *
 *  The literal path is what a bare specifier can't be here, and it has to track
 *  this module's real location — hence the fall back to the static import, which
 *  is also the only branch production keeps, `import.meta.hot` being stripped
 *  there along with everything it guards. */
const loadPreviewEngine = () => {
  const stable = () => import('@/app/chat/right-rail/preview-act')

  if (!import.meta.hot) {
    return stable().then(mod => mod.actOnActivePreview)
  }

  return import(/* @vite-ignore */ '/src/app/chat/right-rail/preview-act.ts?hot=' + Date.now())
    .catch(stable)
    .then(mod => mod.actOnActivePreview as Awaited<ReturnType<typeof stable>>['actOnActivePreview'])
}

/** The window-owned bridges the agent blocks on (read_terminal, read_preview,
 *  drive_preview, read_window_below, tour). Protocol-agnostic: the server-request
 *  seam registers these and answers both the server→client request and the
 *  legacy `*.respond` path with the same `{ value }`. */
export type DesktopBridgeMethod = 'preview.act' | 'preview.read' | 'terminal.read' | 'tour' | 'window.read'

interface DesktopBridgeContext {
  /** True when this window shows the session that raised the request. */
  showsSession: boolean
}

interface DesktopBridgeResult {
  value: string
}

type DesktopBridgeHandler = (
  params: Readonly<Record<string, unknown>>,
  ctx: DesktopBridgeContext
) => Promise<DesktopBridgeResult>

/** JSON-RPC error code for a window-owned bridge asked of a window that does not
 *  show the session: the runtime reads it as "not this window", never a hang. */
export const DESKTOP_BRIDGE_NOT_SHOWN = 4404

class DesktopBridgeDeclined extends Error {
  readonly code = DESKTOP_BRIDGE_NOT_SHOWN
}

// Empty value = nothing to read (no live pane, no tab, no native bridge).
const toValue = (result: unknown): DesktopBridgeResult => ({ value: result ? JSON.stringify(result) : '' })

const failure = (error: unknown) => ({ error: errorMessage(error), success: false })

export const DESKTOP_BRIDGE_HANDLERS: Readonly<Record<DesktopBridgeMethod, DesktopBridgeHandler>> = {
  // drive_preview: click/type/scroll/press inside the guest page, or drive the
  // pane's history. A window that does not show the session must never reach
  // into the page the user is working in (desktop AGENTS.md: offer, don't hijack).
  'preview.act': async (params, { showsSession }) => {
    if (!showsSession) {
      throw new DesktopBridgeDeclined('The in-app browser only takes actions in the session the user is looking at.')
    }

    try {
      const run = await loadPreviewEngine()

      return toValue(
        await run({
          amount: asFiniteNumber(params.amount),
          key: asString(params.key),
          kind: asString(params.action) ?? '',
          max: asFiniteNumber(params.max),
          ref: asString(params.ref),
          selector: asString(params.selector),
          submit: typeof params.submit === 'boolean' ? params.submit : undefined,
          text: asString(params.text),
          to: params.to as PreviewActAction['to']
        })
      )
    } catch (error) {
      return toValue(failure(error))
    }
  },
  // read_preview: the active preview tab (a Browser webview's page text is async).
  // The reads follow the same showing-window rule: a bystander window would hand
  // the agent another session's page, terminal or desktop.
  'preview.read': async (params, { showsSession }) => {
    if (!showsSession) {
      throw new DesktopBridgeDeclined('The preview is only read for the session the user is looking at.')
    }

    return toValue(
      await readActivePreview({ count: asFiniteNumber(params.count), start: asFiniteNumber(params.start) })
    )
  },
  // read_terminal: the renderer's xterm buffer, synchronously.
  'terminal.read': async (params, { showsSession }) => {
    if (!showsSession) {
      throw new DesktopBridgeDeclined('The terminal is only read for the session the user is looking at.')
    }

    return toValue(readActiveTerminal({ count: asFiniteNumber(params.count), start: asFiniteNumber(params.start) }))
  },
  // tour: one guided-tour action (highlight/step/discover) via driver.js, on the
  // app's own DOM or inside the preview pane's guest page. Same showing-window
  // rule as preview.act: a background turn never paints overlays on the screen.
  tour: async (params, { showsSession }) => {
    if (!showsSession) {
      throw new DesktopBridgeDeclined('Tours only run in the session the user is looking at.')
    }

    try {
      const { runTour } = await import('@/lib/tour')

      return toValue(
        await runTour(
          {
            kind: (asString(params.action) ?? 'stop') as TourAction['kind'],
            selector: asString(params.selector),
            side: params.side as TourStep['side'],
            startAt: asFiniteNumber(params.step_index),
            steps: params.steps as TourStep[] | undefined,
            text: asString(params.text),
            title: asString(params.title)
          },
          params.surface === 'preview' ? 'preview' : 'app'
        )
      )
    } catch (error) {
      return toValue(failure(error))
    }
  },
  // read_window_below: main owns native window enumeration. An older shell
  // without the IPC handler, or a main-side throw, answers empty instead of
  // stalling the tool's timeout.
  'window.read': async (_params, { showsSession }) => {
    if (!showsSession) {
      throw new DesktopBridgeDeclined('The window below is only read for the session the user is looking at.')
    }

    const read = window.hermesDesktop?.readWindowBelow

    try {
      return toValue(read ? await read() : null)
    } catch {
      return toValue(null)
    }
  }
}

/** Desktop-surface events: agent terminal streaming, pane reveal, layout presets
 *  and message reactions. */
export function handleDesktopBridgeEvent(ctx: GatewayEventContext): boolean {
  const { event, payload, isActiveEvent } = ctx

  if (event.type === 'agent.terminal.output') {
    // Live chunk from a background process → its read-only agent terminal tab.
    writeAgentTerminalChunk(payload?.process_id ?? '', payload?.chunk ?? '')

    return true
  }

  if (event.type === 'terminal.close') {
    // Agent closed its own read-only tab via the desktop-gated close_terminal tool.
    // The process is untouched — this only drops the view.
    closeAgentTerminalByProc(payload?.process_id ?? '')

    return true
  }

  if (event.type === 'pane.reveal') {
    // Agent revealed a pane via the desktop-gated focus_pane tool, in
    // response to an explicit user request. Active session only — a
    // background turn must never move the user's focus (desktop AGENTS.md:
    // offer, don't hijack).
    if (isActiveEvent) {
      revealDesktopPane(payload?.pane ?? '')
    }

    return true
  }

  if (event.type === 'layout.apply') {
    // Agent applied a layout preset via the desktop-gated apply_layout
    // tool. Same contract as pane.reveal: active session only, and the
    // preset resolves against the SAME layouts registry the picker reads,
    // so core, plugin, and user presets are all addressable.
    if (isActiveEvent) {
      applyDesktopLayoutPreset(typeof payload?.preset === 'string' ? payload.preset : '')
    }

    return true
  }

  if (event.type === 'message.reaction') {
    // The agent reacted to a message via the desktop-gated
    // react_to_message tool. Already persisted — this only paints it now
    // instead of at the next resume. Fresh ChatMessage object per change:
    // the runtime repository caches normalized ThreadMessages in a WeakMap
    // keyed by ChatMessage identity.
    const reactedRowId = payload?.row_id

    if (typeof reactedRowId === 'number') {
      const nextReactions = Array.isArray(payload?.reactions) ? payload.reactions : []
      const reactedRole = payload?.role === 'assistant' ? 'assistant' : 'user'

      setMessages(messages => {
        // Preferred leg: the message already knows its durable row id
        // (rehydrated transcript, or a live row that has round-tripped).
        const byRowId = messages.find(message => message.rowId === reactedRowId)

        if (byRowId) {
          // Overlay survives the end-of-turn resume, which rebuilds from
          // in-memory history that doesn't carry this mid-turn DB write.
          recordAgentReaction(reactedRowId, nextReactions)

          return messages.map(message =>
            message.rowId === reactedRowId ? { ...message, reactions: nextReactions } : message
          )
        }

        // Live leg: the targeted message is still optimistic (no rowId —
        // it hasn't round-tripped through a resume). The agent's default
        // target is the newest message of that role, so stamp the reaction
        // AND the now-known row id onto it. Without this the event matches
        // nothing and the reaction only appears after a reload.
        const lastIndex = messages.findLastIndex(message => message.role === reactedRole && message.rowId === undefined)

        if (lastIndex === -1) {
          return messages
        }

        recordAgentReaction(reactedRowId, nextReactions)

        return messages.map((message, index) =>
          index === lastIndex ? { ...message, rowId: reactedRowId, reactions: nextReactions } : message
        )
      })
    }

    return true
  }

  return false
}
