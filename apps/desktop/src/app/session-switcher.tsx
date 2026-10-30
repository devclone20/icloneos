import './command-palette/sheet.css'

import { useStore } from '@nanostores/react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'

import { sessionTitle } from '@/lib/chat-runtime'
import { $switcherIndex, $switcherOpen, $switcherSessions, closeSwitcher } from '@/store/session-switcher'

import { SessionStatusDot } from './chat/session-status-dot'
import { openSession } from './open-session'

// The ⌃Tab session switcher, on the same sheet as ⌘K (one chrome, one
// stylesheet — `command-palette/sheet.css`). Keyboard-driven from
// `use-keybinds`, rows clickable via mousedown (⌃-click on macOS). It takes no
// focus of its own — no Dialog, so Tab stays global — and its rows are
// `role="option"` divs, never controls, so nothing here can be tabbable while
// invisible (gate G5).
export function SessionSwitcher() {
  const open = useStore($switcherOpen)
  const sessions = useStore($switcherSessions)
  const index = useStore($switcherIndex)
  const navigate = useNavigate()

  const activeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [index, open])

  if (!open || sessions.length === 0) {
    return null
  }

  const pick = (sessionId: string) => {
    closeSwitcher()
    openSession(sessionId, navigate)
  }

  return createPortal(
    <div className="icp-root" data-kind="switcher" data-state="open">
      {/* Transparent click-catcher: click-away closes, but no dim/blur. */}
      <div
        className="icp-scrim"
        onMouseDown={event => {
          event.preventDefault()
          closeSwitcher()
        }}
      />
      <div className="icp" data-state="open">
        <div className="icp-list" role="listbox">
          {sessions.map((session, i) => {
            const selected = i === index

            return (
              <div
                aria-selected={selected}
                className="icp-row"
                data-active={selected ? '' : undefined}
                key={session.id}
                onMouseDown={event => {
                  event.preventDefault()
                  pick(session.id)
                }}
                ref={selected ? activeRef : undefined}
                role="option"
              >
                <SessionStatusDot className="icp-row__dot" session={session} storedSessionId={session.id} />
                <span className="icp-row__body">
                  <span className="icp-row__label">{sessionTitle(session)}</span>
                </span>
                {i < 9 && (
                  <span className="icp-keys" data-dim={selected ? undefined : ''}>
                    <kbd className="icp-key">⌃{i + 1}</kbd>
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>,
    document.body
  )
}
