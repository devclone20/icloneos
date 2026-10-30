/**
 * The Message WINDOW — owner rule: chat is a closable window (×) over the
 * ever-present home; expand fills the screen, retract brings the frame back.
 *
 * Mechanism: the window is an `IcWindow` placed 'under-shell' — it publishes
 * its rect as `--iwin-*` vars on <html> and home.css clips the chat surface to
 * that rounded window over the mosaic; the plate stays in the home's base
 * layer. THIS component mounts the chat surface (E3b): the upstream pane
 * layout no longer hosts it, so no tab strip, zone or drag handle can come
 * with it. The surface is portalled to <body> because home.css positions it
 * `fixed` from the page root — mounting it inside the window's own box would
 * put it in the home layer's stacking context and re-layer the whole window.
 *
 * The window has no tab bar: its head is the econ windows' title pill
 * ("iclone os", where "● email" sits — contract §14), and a session sidebar
 * below it (msg-sidebar.tsx), collapsed by default, carries the view switch
 * and every session. The window has TWO views: `chat` shows the Message
 * surface under the head band and `it` fills the SAME window with the iT
 * terminal, the sidebar listing the iT sessions instead (§12). OWNER DECISION
 * 2026-10-19 (RESUME/contracts/M1_message_head_band.md): the head band is in
 * BOTH views — it used to be chat-only so no pill sat over the shell's first
 * lines, and what makes it safe in iT is that the terminal now starts at the
 * band's bottom edge (msg-head.tsx, it-terminal.css). The chat only hides
 * (visibility) and iT never unmounts — shells and drafts both survive every
 * switch.
 */
import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

import { $msgSidebarOpen, setMsgSidebarOpen, toggleMsgSidebar } from '@/app/chat/sidebar/msg-sidebar-state'
import { WiredPane } from '@/app/contrib/context'
import { ErrorBoundary } from '@/components/error-boundary'
import { useI18n } from '@/i18n'
import { isPeerInstanceWindow } from '@/store/windows'

import { closeMessageWindow } from './home-escape'
import { ItCrashCard, ItCrashProbe, ItPeerCard } from './it-cards'
import { $itClosePrompt } from './it-keys'
import { $msgView, setMsgView } from './it-store'
import { ItTerminal } from './it-terminal'
import { MsgHead } from './msg-head'
import { MsgSidebar } from './msg-sidebar'
import { IcWindow, useWindowExpanded } from './window'

export function MessageWindow({ onClose }: { onClose: () => void }) {
  const copy = useI18n().t.desktop.home

  const labels = useMemo(
    () => ({ close: copy.msgClose, expand: copy.msgExpand, retract: copy.msgRetract, opacity: copy.msgOpacity }),
    [copy]
  )

  const { expanded, toggle: toggleExpanded } = useWindowExpanded('message')
  // View state is a store — the `it` CLI switches it too (it open / it msg).
  const view = useStore($msgView)
  // No shell spawns until iT is first shown; after that it only hides.
  const [itEverOpened, setItEverOpened] = useState(view === 'it')
  // iT follows the window everywhere — expanded included (owner rule).
  const itVisible = view === 'it'
  // The sidebar's open state is the shared store, so ⌘B (use-keybinds,
  // U2-p2-01) and the window's own toggle move the same panel. In-memory
  // only: closeMessageWindow clears it on the explicit close paths (this
  // window's control, Escape in home-view), never on unmount.
  const sideOpen = useStore($msgSidebarOpen)
  // The body clip widens as the sidebar starts opening and narrows only once
  // it has finished closing — one clip move per toggle, never per frame.
  const [clipWide, setClipWide] = useState(sideOpen)

  useEffect(() => {
    if (sideOpen) {
      setClipWide(true)
    }
  }, [sideOpen])

  const close = useCallback(() => closeMessageWindow(onClose), [onClose])

  const onSideCollapsed = useCallback(() => setClipWide(false), [])

  // A busy-close prompt (⌘W on a running shell) shows on its iT row: the
  // sidebar opens once, as the prompt appears, and collapses again at will
  // while the prompt waits.
  const promptWorkspaceId = useStore($itClosePrompt)?.workspaceId ?? null

  useEffect(() => {
    if (promptWorkspaceId && $msgView.get() === 'it') {
      setMsgSidebarOpen(true)
    }
  }, [promptWorkspaceId])

  useEffect(() => {
    if (view === 'it') {
      setItEverOpened(true)
    }
  }, [view])

  // BEFORE paint, not after: this window mounts the chat surface, and home.css
  // only clips it once `data-iclone-window` is on <html>. A passive effect
  // would let one unclipped, full-window chat frame reach the screen.
  useLayoutEffect(() => {
    const root = document.documentElement

    // Expanded is the SAME window mechanism with zero insets — dropping the
    // clip entirely would sink the chat below the fixed stage layer and the
    // whole window vanished (owner-reported bug). The view (chat | iT) and
    // the sidebar survive expansion.
    root.dataset.icloneWindow = '1'
    root.dataset.icloneView = view

    return () => {
      delete root.dataset.icloneWindow
      delete root.dataset.icloneView
    }
  }, [view])

  return (
    <>
      {/* The chat surface, mounted by this window and clipped into its rect. */}
      {createPortal(<WiredPane part="chatRoutes" />, document.body)}
      <IcWindow
        bodyInsetLeft={clipWide ? 'var(--ic-msg-sidebar-w)' : 'var(--ic-msg-rail-w)'}
        expanded={expanded}
        head={
          <>
            {/* One band for both views — there is no branch to take. */}
            <MsgHead expanded={expanded} view={view} />
            <MsgSidebar
              expanded={expanded}
              onCollapsed={onSideCollapsed}
              onToggle={toggleMsgSidebar}
              onView={setMsgView}
              open={sideOpen}
              view={view}
            />
          </>
        }
        headBand="var(--ic-win-head-h)"
        id="message"
        labels={labels}
        onClose={close}
        onToggleExpanded={toggleExpanded}
        placement="under-shell"
      >
        {itEverOpened &&
          (isPeerInstanceWindow() ? (
            itVisible && <ItPeerCard />
          ) : (
            // A throw in iT must cost iT only — unguarded it reached the root
            // boundary and masked the whole app.
            <ErrorBoundary fallback={({ reset }) => <ItCrashCard onRetry={reset} />} label="it-1">
              {import.meta.env.DEV && <ItCrashProbe target="surface" />}
              <ItTerminal open={itVisible} />
            </ErrorBoundary>
          ))}
      </IcWindow>
    </>
  )
}
