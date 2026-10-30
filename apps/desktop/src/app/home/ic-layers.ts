/**
 * THE LADDER — every z-index of the home surface, in one place (plan AD8).
 *
 * This file is the source. `ic-layers.css` is its rendering (`layersCss()`), and the ladder comment in `home.css`
 * is `ladderComment()`; `ic-layers.test.ts` fails when either drifts. CSS reads `var(--ic-z-<scope>-<name>)`,
 * TSX reads `IC_LAYERS` — no z-index literal lives anywhere else.
 *
 * A rung only orders against rungs of its own scope: `.ihome` is one stacking context at `global.home`, so
 * nothing inside it can outrank a global rung above 40, however large its number looks.
 */

type Scope = Readonly<Record<string, number>>

/** Siblings of (or outside) `.ihome`. */
const global = {
  stage: 37,
  chat: 38,
  shells: 39,
  home: 40,
  files: 46
} as const satisfies Scope

/** Ordered inside the `.ihome` stacking context. */
const ihome = {
  frame: 39,
  itwin: 41,
  chrome: 42,
  econ: 43,
  dock: 44,
  inftTab: 45,
  controls: 60,
  inftScrim: 61,
  inftPanel: 62,
  walletScrim: 64,
  walletPanel: 65
} as const satisfies Scope

/** Stacking inside one component (its own context): a part over its siblings. */
const local = {
  base: 1,
  raised: 2,
  overlay: 3,
  float: 4,
  peak: 5
} as const satisfies Scope

/** What each rung holds — the ladder comment's third column. */
const WHAT: Readonly<Record<string, string>> = {
  'global.stage': '.istage-layer: the field + live 3D iNFT, and the Message window plate on them',
  'global.chat': 'the chat surface (the shell, clipped into the Message window)',
  'global.shells': 'the iT shells (it-host.tsx parks them over the iT slots)',
  'global.home': '.ihome: all the chrome of the ihome scope lives in here',
  'global.files': '.ifiles: the Files island (mounted app-wide)',
  'ihome.frame': ".iwin-frame: the window's champagne border (decor)",
  'ihome.inftTab': '.inft-tab: the collections tab on the stage edge',
  'ihome.itwin': '.itwin: the iT terminal filling the window',
  'ihome.chrome': ".imsg-side: the Message window's session sidebar",
  'ihome.econ': '.iecon: a dock window opened over the Message window',
  'ihome.dock': '.dock: the rail, above the windows it opens',
  'ihome.controls': ".iwin-controls .iop: the window's controls",
  'ihome.inftScrim': '.inft-scrim: collections, modal, above every control',
  'ihome.inftPanel': '.inft-panel',
  'ihome.walletScrim': '.iwbal-scrim: wallet, modal',
  'ihome.walletPanel': '.iwbal',
  'local.base': 'lifted off the flow (plate, rail, cell, checkbox)',
  'local.raised': 'over a base part (pane divider)',
  'local.overlay': 'over the content (pane close, window controls)',
  'local.float': 'floating header or flash region',
  'local.peak': 'menus and a dragged card'
}

export const IC_LAYERS = { global, ihome, local } as const

type LayerScope = keyof typeof IC_LAYERS

/** Upstream rungs we order against but never write (read-only reference). */
export const UPSTREAM_LAYERS = {
  overlay: 50,
  modalBackdrop: 120
} as const

/**
 * The one named cross-scope exception: the Files island is global (46) and `.ihome` is 40, so the island paints
 * over the in-`.ihome` modals (collections, wallet) and their scrims. Accepted by the lead (P5 lead_actions).
 */
export const CROSS_SCOPE_EXCEPTIONS = [
  { above: 'global.files', below: ['ihome.inftScrim', 'ihome.inftPanel', 'ihome.walletScrim', 'ihome.walletPanel'] }
] as const

export function zIndex<S extends LayerScope>(scope: S, name: keyof (typeof IC_LAYERS)[S]): number {
  return (IC_LAYERS[scope] as Scope)[name as string]
}

const kebab = (name: string) => name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)

const layerVar = (scope: LayerScope, name: string) => `--ic-z-${scope}-${kebab(name)}`

function rungs(): Array<{ scope: LayerScope; name: string; z: number; what: string }> {
  return (Object.keys(IC_LAYERS) as LayerScope[]).flatMap(scope =>
    Object.entries(IC_LAYERS[scope] as Scope).map(([name, z]) => ({
      scope,
      name,
      z,
      what: WHAT[`${scope}.${name}`] ?? ''
    }))
  )
}

/** The ladder table, as the comment block both CSS files carry. */
export function ladderComment(): string {
  const width = Math.max(...rungs().map(r => layerVar(r.scope, r.name).length))

  const rows = rungs().map(r => `   ${String(r.z).padStart(3)}  ${layerVar(r.scope, r.name).padEnd(width)}  ${r.what}`)

  return [
    '/* ── THE LADDER (generated from home/ic-layers.ts — edit it there) ─────────',
    '   global rungs order the siblings of .ihome; .ihome is ONE stacking context',
    '   at global-home, so its rungs can never outrank a global rung above it.',
    '   Upstream overlay views sit at 50, upstream modals at 120.',
    '',
    ...rows,
    '',
    '   Rule for anything added later: a piece with a scrim is modal and belongs',
    '   ABOVE the window controls; a piece without one belongs below them.',
    '   ────────────────────────────────────────────────────────────────────── */'
  ].join('\n')
}

/** The exact content of ic-layers.css. */
export function layersCss(): string {
  const decls = rungs().map(r => `  ${layerVar(r.scope, r.name)}: ${r.z};`)

  return `${ladderComment()}\n\n:root {\n${decls.join('\n')}\n}\n`
}
