/**
 * `it spawn`: lay a validated plan (main checked every field) out as panes.
 * Panes tile by halving — step i splits the pane placed at i − 2^⌊log₂ i⌋, so
 * the tree stays balanced instead of spiralling into ever-thinner slivers —
 * and whatever no longer fits (IT_MIN_PANE_PX) overflows into a new workspace.
 */
import type { ItWorkspace } from '../../it-layout'
import { addItWorkspace, focusItPane, splitItPane } from '../../it-store'
import { renameTerminal } from '../engine/terminals'

import type { SpawnPane } from './bridge'
import { setPaneSpec } from './pane-meta'

interface PlacedPane {
  name: string
  terminalId: string
  workspaceTitle: string
}

const spawnIds = new Map<string, PlacedPane[]>()

export function spawnedPanes(spawnId: string): PlacedPane[] {
  return spawnIds.get(spawnId) ?? []
}

export function lastSpawnId(): null | string {
  return [...spawnIds.keys()].pop() ?? null
}

function highestPowerOfTwo(n: number): number {
  return 2 ** Math.floor(Math.log2(n))
}

export function layOutSpawn(
  panes: readonly SpawnPane[],
  layout: 'tabs' | 'tiled'
): { spawnId: string; placed: PlacedPane[] } {
  const spawnId = `s${Date.now().toString(36).slice(-6)}`
  const placed: PlacedPane[] = []
  let workspace: null | ItWorkspace = null
  let tiles: string[] = []

  const claim = (pane: SpawnPane, terminalId: string, title: string) => {
    setPaneSpec(terminalId, {
      name: pane.name,
      spawnId,
      ...(pane.group ? { group: pane.group } : {}),
      ...(pane.role ? { role: pane.role } : {}),
      ...(pane.env ? { env: pane.env } : {}),
      ...(pane.cmd ? { cmd: pane.cmd } : {})
    })
    renameTerminal(terminalId, pane.name)
    placed.push({ name: pane.name, terminalId, workspaceTitle: title })
    tiles.push(terminalId)
  }

  const openWorkspace = (pane: SpawnPane): ItWorkspace => {
    const opened = addItWorkspace(pane.group ?? pane.name, pane.cwd)

    tiles = []
    claim(pane, opened.focusTerminalId, opened.title)

    return opened
  }

  const splitInto = (target: ItWorkspace, pane: SpawnPane): null | string => {
    const step = tiles.length
    const first = Math.floor(Math.log2(step)) % 2 === 0 ? 'h' : 'v'

    focusItPane(target.id, tiles[step - highestPowerOfTwo(step)])

    return splitItPane(target.id, first, pane.cwd) ?? splitItPane(target.id, first === 'h' ? 'v' : 'h', pane.cwd)
  }

  for (const pane of panes) {
    const created = workspace && layout === 'tiled' ? splitInto(workspace, pane) : null

    if (workspace && created) {
      claim(pane, created, workspace.title)
    } else {
      workspace = openWorkspace(pane)
    }
  }

  spawnIds.set(spawnId, placed)

  return { spawnId, placed }
}
