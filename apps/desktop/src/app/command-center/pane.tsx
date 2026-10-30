/**
 * Command Center as a SETTINGS PANE (front K5, the owner's order: move the
 * whole Command Center inside Settings, dashboard included).
 *
 * This is the adapter and nothing else: the page reads `?section=` from the
 * URL itself, so all the pane owes it is the two session actions. `openSession`
 * is a module function that only needs the router; the delete is published by
 * the wiring (`session-delete.ts`) because it cannot be rebuilt here without
 * losing branches.
 */
import { useStore } from '@nanostores/react'
import { useNavigate } from 'react-router'

import { openSession } from '../open-session'

import { $commandCenterSessionDelete } from './session-delete'

import { CommandCenterView } from './index'

export function CommandCenterPane() {
  const navigate = useNavigate()
  const onDeleteSession = useStore($commandCenterSessionDelete)

  return (
    <CommandCenterView
      onDeleteSession={onDeleteSession ?? undefined}
      onOpenSession={sessionId => openSession(sessionId, navigate)}
    />
  )
}
