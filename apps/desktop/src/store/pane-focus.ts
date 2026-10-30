import { setTerminalTakeover } from '@/app/right-sidebar/store'
import { isLayoutNode, type LayoutNode } from '@/components/pane-shell/tree/model'
import { applyLayoutPreset, LAYOUTS_AREA } from '@/components/pane-shell/tree/presets'
import { revealTreePane } from '@/components/pane-shell/tree/store'
import { registry } from '@/contrib/registry'

import { setFileBrowserOpen, setSidebarOpen } from './layout'

// Explicit-request pane reveals, keyed to the backend `focus_pane` tool. Each
// entry drives the pane's own reveal path (some are toggle-bound) so a revealed
// pane matches a user-driven open. `files` is workspace-gated — a no-op without
// a project cwd, which is the honest behavior. `review` is gone with its pane
// (E3r): an agent asking for it gets false, like any other unknown pane.
const PANE_REVEALERS: Record<string, () => void> = {
  chat: () => revealTreePane('workspace'),
  files: () => setFileBrowserOpen(true),
  sessions: () => setSidebarOpen(true),
  terminal: () => setTerminalTakeover(true)
}

/** Reveal a desktop pane by name. Returns false for an unknown pane. */
export function revealDesktopPane(pane: string): boolean {
  const reveal = PANE_REVEALERS[pane]

  if (!reveal) {
    return false
  }

  reveal()

  return true
}

/** Apply a layout preset by id, resolved against the layouts contribution
 *  registry, for the backend `apply_layout` tool. The registry holds exactly
 *  what some module registered: the one core layout the app root seeds, plus
 *  the layouts a previous build persisted, which presets.ts re-registers
 *  read-only. There is no preset UI left to add more. Every other id — the
 *  extra presets older builds offered included — returns false. */
export function applyDesktopLayoutPreset(preset: string): boolean {
  if (!preset) {
    return false
  }

  const entry = registry
    .getArea(LAYOUTS_AREA)
    .find(candidate => candidate.id === preset && isLayoutNode(candidate.data))

  if (!entry) {
    return false
  }

  applyLayoutPreset(entry.id, entry.data as LayoutNode)

  return true
}
