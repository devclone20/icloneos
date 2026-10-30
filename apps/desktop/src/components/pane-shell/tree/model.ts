/**
 * Layout tree model — the Dockview-style structure that replaces the
 * rails/bands grammar. Two node kinds:
 *
 *  - `split`: children laid out along an orientation with fractional weights.
 *  - `group`: a stack of panes (tabs) with one active; may be minimized to
 *    its header strip (DetailPane semantics).
 *
 * Everything the old grammar special-cased is just tree shape here: a "top row
 * spanning the right rail" is a column split; "a cell inside a column" is a
 * stacked group; spans fall out of tree position. All operations are pure and
 * return new trees; `normalize` keeps the structure canonical (no empty
 * groups, no single-child or same-orientation nested splits).
 */

import { isFiniteNumber } from '@/iclone-shared/guards'

type Orientation = 'row' | 'column'

export interface SplitNode {
  type: 'split'
  id: string
  orientation: Orientation
  children: LayoutNode[]
  /** Parallel to children; relative flex weights. */
  weights: number[]
}

export interface GroupNode {
  type: 'group'
  id: string
  /** Pane ids stacked in this group (rendered as tabs when > 1). */
  panes: string[]
  /** The visible pane. */
  active: string
  /** Collapsed to header strip (chevron restores). */
  minimized?: boolean
}

export type LayoutNode = SplitNode | GroupNode

/** Where a dragged pane lands relative to a target group. */
export type DropPosition = 'center' | 'left' | 'right' | 'top' | 'bottom'

let seq = 0
const nodeId = (kind: string) => `${kind}-${Date.now().toString(36)}-${(seq++).toString(36)}`

export const group = (panes: string[], options?: Partial<Omit<GroupNode, 'type' | 'panes'>>): GroupNode => ({
  type: 'group',
  id: options?.id ?? nodeId('g'),
  panes,
  active: options?.active ?? panes[0] ?? '',
  minimized: options?.minimized
})

export const split = (
  orientation: Orientation,
  children: LayoutNode[],
  weights?: number[],
  id?: string
): SplitNode => ({
  type: 'split',
  id: id ?? nodeId('s'),
  orientation,
  children,
  weights: weights ?? children.map(() => 1)
})

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function findGroup(node: LayoutNode, groupId: string): GroupNode | null {
  if (node.type === 'group') {
    return node.id === groupId ? node : null
  }

  for (const child of node.children) {
    const hit = findGroup(child, groupId)

    if (hit) {
      return hit
    }
  }

  return null
}

export function findGroupOfPane(node: LayoutNode, paneId: string): GroupNode | null {
  if (node.type === 'group') {
    return node.panes.includes(paneId) ? node : null
  }

  for (const child of node.children) {
    const hit = findGroupOfPane(child, paneId)

    if (hit) {
      return hit
    }
  }

  return null
}

export function allPaneIds(node: LayoutNode): string[] {
  return node.type === 'group' ? [...node.panes] : node.children.flatMap(allPaneIds)
}

/** The split whose DIRECT child carries `childId`, or null. */
export function findParentSplit(node: LayoutNode, childId: string): SplitNode | null {
  if (node.type !== 'split') {
    return null
  }

  if (node.children.some(child => child.id === childId)) {
    return node
  }

  for (const child of node.children) {
    const hit = findParentSplit(child, childId)

    if (hit) {
      return hit
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Structural edits (pure)
// ---------------------------------------------------------------------------

/**
 * Canonical form: unwrap single-child splits, flatten same-orientation
 * nesting (weights scaled into the parent's slot), and PRUNE EMPTY GROUPS —
 * dragging the last pane out of a zone closes the zone and its siblings
 * absorb the space (VS Code semantics). Keeping empties as "stable regions"
 * (the original FancyZones rule) let invisible residue accumulate into
 * corrupt-feeling structure (`row([]|[])` eating half a slot); authored
 * empty zones still exist inside the zone editor's own grid model, and an
 * editor-applied tree keeps them until the first structural op.
 */
export function normalize(node: LayoutNode): LayoutNode | null {
  if (node.type === 'group') {
    if (node.panes.length === 0) {
      return null
    }

    const active = node.panes.includes(node.active) ? node.active : node.panes[0]

    if (active === node.active) {
      return node
    }

    return { ...node, active }
  }

  const children: LayoutNode[] = []
  const weights: number[] = []

  node.children.forEach((child, i) => {
    const kept = normalize(child)

    if (!kept) {
      return
    }

    if (kept.type === 'split' && kept.orientation === node.orientation) {
      // Flatten: distribute this slot's weight across the flattened children
      // proportionally to their internal weights.
      const total = kept.weights.reduce((a, b) => a + b, 0) || 1
      kept.children.forEach((grandchild, j) => {
        children.push(grandchild)
        weights.push((node.weights[i] ?? 1) * ((kept.weights[j] ?? 1) / total))
      })

      return
    }

    children.push(kept)
    weights.push(node.weights[i] ?? 1)
  })

  if (children.length === 0) {
    return null
  }

  if (children.length === 1) {
    return children[0]
  }

  return { ...node, children, weights }
}

/** Remove a pane wherever it lives. Closing the ACTIVE tab leaves selection on
 *  the neighbor that fills its slot (right; left when it was last) — same rule
 *  as terminals and the preview rail. */
export function removePane(node: LayoutNode, paneId: string): LayoutNode | null {
  const walk = (n: LayoutNode): LayoutNode => {
    if (n.type === 'group') {
      const at = n.panes.indexOf(paneId)

      if (at === -1) {
        return n
      }

      const panes = n.panes.filter(p => p !== paneId)

      // After splice, `at` indexes the old right neighbor (clamp left at end).
      return { ...n, panes, active: n.active === paneId ? (panes[Math.min(at, panes.length - 1)] ?? '') : n.active }
    }

    return { ...n, children: n.children.map(walk) }
  }

  return normalize(walk(node))
}

/**
 * Insert `paneId` at `target` group: `center` joins the stack (as a tab);
 * an edge splits the group in that direction. If the neighboring split
 * already runs in that orientation the new group is spliced in beside the
 * target instead of nesting (normalize would flatten it anyway).
 */
export function insertAtGroup(
  node: LayoutNode,
  targetGroupId: string,
  paneId: string,
  pos: DropPosition,
  /** Center drops only: stack BEFORE this pane id (`null`/omitted = append) —
   *  the tab-strip insertion divider's slot. */
  before?: null | string,
  /** Front the inserted pane — TRUE for a gesture (drop/reveal), FALSE for silent
   *  adoption (logs stacking into the terminal zone must not steal its tab). */
  activate: boolean = true,
  /** Edge splits only: the [target zone, added pane] weight pair (default
   *  even). Lets a re-opened tile take the share it held when it closed
   *  instead of half the anchor zone. */
  edgeWeights?: readonly [number, number]
): LayoutNode | null {
  const walk = (n: LayoutNode): LayoutNode => {
    if (n.type === 'group') {
      if (n.id !== targetGroupId) {
        return n
      }

      if (pos === 'center') {
        const at = before ? n.panes.indexOf(before) : -1
        const panes = at >= 0 ? [...n.panes.slice(0, at), paneId, ...n.panes.slice(at)] : [...n.panes, paneId]

        // Active moves only on a gesture; an empty target has no prior tab, so
        // the newcomer takes it regardless.
        const active = activate || n.panes.length === 0 ? paneId : n.active

        return { ...n, panes, active }
      }

      const orientation: Orientation = pos === 'left' || pos === 'right' ? 'row' : 'column'
      const leading = pos === 'left' || pos === 'top'
      const added = group([paneId])
      const children = leading ? [added, n] : [n, added]
      const [targetWeight, addedWeight] = edgeWeights ?? [1, 1]

      return split(orientation, children, leading ? [addedWeight, targetWeight] : [targetWeight, addedWeight])
    }

    return { ...n, children: n.children.map(walk) }
  }

  return normalize(walk(node))
}

/**
 * The tree's VISIBLE shape: pane stacks + split orientations, with empty
 * groups skipped (editor-session trees may still hold them) and single-child
 * runs unwrapped. Two trees with equal signatures are indistinguishable on
 * screen regardless of node ids.
 */
function shapeSignature(node: LayoutNode): string {
  if (node.type === 'group') {
    return node.panes.length > 0 ? `[${node.panes.join(',')}]` : ''
  }

  const children = node.children.map(shapeSignature).filter(Boolean)

  if (children.length === 0) {
    return ''
  }

  return children.length === 1 ? children[0] : `${node.orientation}(${children.join('|')})`
}

/**
 * Move = remove + insert. If the target group vanished during removal (the
 * pane was its only occupant), the move is a no-op. A move whose result
 * LOOKS identical to the current layout is also a no-op — e.g. a "split
 * bottom" drop onto the zone the pane already sits alone below would only
 * rebuild the same arrangement under a fresh zone id.
 */
export function movePane(
  root: LayoutNode,
  paneId: string,
  target: { groupId: string; pos: DropPosition; before?: null | string }
): LayoutNode {
  const from = findGroupOfPane(root, paneId)

  // No-op guards: dropping a pane onto its own single-pane group.
  if (from && from.id === target.groupId && from.panes.length === 1) {
    return root
  }

  const without = removePane(root, paneId)

  if (!without) {
    // The pane was the only thing in the tree.
    return root
  }

  if (!findGroup(without, target.groupId)) {
    return root
  }

  const next = insertAtGroup(without, target.groupId, paneId, target.pos, target.before) ?? root

  return shapeSignature(next) === shapeSignature(root) ? root : next
}

/** Group ids of every leaf under a node, in tree order. */
export function groupLeafIds(node: LayoutNode): string[] {
  return node.type === 'group' ? [node.id] : node.children.flatMap(groupLeafIds)
}

function sameSet(ids: string[], set: Set<string>): boolean {
  return ids.length === set.size && ids.every(id => set.has(id))
}

/** The node whose complete leaf set equals `set` (a rectangular region in a
 *  guillotine tree is always exactly one subtree), or null. */
function findCover(node: LayoutNode, set: Set<string>): LayoutNode | null {
  if (sameSet(groupLeafIds(node), set)) {
    return node
  }

  if (node.type === 'split') {
    for (const child of node.children) {
      const hit = findCover(child, set)

      if (hit) {
        return hit
      }
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Attribute edits
// ---------------------------------------------------------------------------

function mapGroups(node: LayoutNode, fn: (g: GroupNode) => GroupNode): LayoutNode {
  return node.type === 'group' ? fn(node) : { ...node, children: node.children.map(c => mapGroups(c, fn)) }
}

export function setActivePane(root: LayoutNode, groupId: string, paneId: string): LayoutNode {
  return mapGroups(root, g => (g.id === groupId && g.panes.includes(paneId) ? { ...g, active: paneId } : g))
}

export function setGroupMinimized(root: LayoutNode, groupId: string, minimized: boolean): LayoutNode {
  return mapGroups(root, g => (g.id === groupId ? { ...g, minimized } : g))
}

/** Mirror the layout HORIZONTALLY (the titlebar flip toggle / ⌘\): reverse
 *  every ROW split's child order at EVERY depth, so left↔right flips
 *  everywhere. A right rail lands on the left with its OWN internal order
 *  mirrored too — so preview stays directly beside the file tree instead of
 *  jumping to the far edge (a shallow root-only reverse left nested rails in
 *  place). COLUMN splits keep their top↔bottom order (the terminal stays at
 *  the bottom). Its own involution: flipping twice is the identity. */
export function mirrorTreeHorizontal(root: LayoutNode): LayoutNode {
  if (root.type === 'group') {
    return root
  }

  const children = root.children.map(mirrorTreeHorizontal)

  return root.orientation === 'row'
    ? { ...root, children: children.reverse(), weights: [...root.weights].reverse() }
    : { ...root, children }
}

// ---------------------------------------------------------------------------
// Validation (persisted trees are untrusted)
// ---------------------------------------------------------------------------

/**
 * Bring a persisted tree onto the current attribute schema.
 *
 * Retires `headerHidden` outright rather than translating it. A stored `true`
 * could have come from a deliberate "Hide header", or from a double-tap the
 * user never meant (that gesture rode every tab, so an ordinary double-click
 * on a title hid the strip), and nothing on disk distinguishes them. Since the
 * hide also unmounted the only surface offering "Show header", every wrongly
 * hidden zone stayed hidden across restarts — the state people actually
 * reported being stuck in. Carrying those forward as `tabStrip: 'never'` would
 * re-strand exactly them, so the flag is dropped and the zone returns to auto;
 * the strip is now hidden deliberately, from controls that say how to undo it.
 *
 * A stored `false` is dropped for the same reason in reverse: most were written
 * by the layout's own repair paths, not by anyone choosing to see a strip.
 *
 * `tabStrip` is retired the same way (E3): the per-zone strip, the menu row
 * that wrote the choice and the resolver that read it are all gone, so a stored
 * value can no longer be honoured by anything — carrying it forward would only
 * keep a preference alive with nothing to apply it to.
 */
export function migratePersistedTree(node: LayoutNode): LayoutNode {
  if (node.type === 'group') {
    const { headerHidden, tabStrip, ...rest } = node as GroupNode & {
      headerHidden?: unknown
      tabStrip?: unknown
    }

    return headerHidden === undefined && tabStrip === undefined ? node : rest
  }

  return { ...node, children: node.children.map(migratePersistedTree) }
}

export function isLayoutNode(value: unknown): value is LayoutNode {
  if (!value || typeof value !== 'object') {
    return false
  }

  const n = value as Record<string, unknown>

  if (n.type === 'group') {
    return (
      typeof n.id === 'string' &&
      Array.isArray(n.panes) &&
      n.panes.every(p => typeof p === 'string') &&
      typeof n.active === 'string'
    )
  }

  if (n.type === 'split') {
    return (
      typeof n.id === 'string' &&
      (n.orientation === 'row' || n.orientation === 'column') &&
      Array.isArray(n.children) &&
      n.children.length > 0 &&
      n.children.every(isLayoutNode) &&
      Array.isArray(n.weights) &&
      n.weights.length === n.children.length &&
      n.weights.every(w => isFiniteNumber(w) && w > 0)
    )
  }

  return false
}
