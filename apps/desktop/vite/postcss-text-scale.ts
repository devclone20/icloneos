/**
 * Build-time text size (Settings → Appearance → Text size).
 *
 * Every absolute `font-size` / `line-height` in every compiled stylesheet
 * (Tailwind output, our CSS, third-party CSS imported through Vite) becomes
 * `calc(<value> * var(--ic-text-scale, 1))`, so one root variable scales the
 * type without touching rem-based spacing — the fixed-px window frames and
 * paddings keep their size, unlike a root font-size zoom.
 *
 * Relative values (`em`, `%`, unitless line-heights, keywords) are left alone:
 * they inherit an already scaled parent. Custom-property DEFINITIONS are never
 * scaled (no double scaling) except "carriers": a property such as Tailwind's
 * `--tw-leading` that holds absolute and unitless values and is read by a
 * `line-height: var(--tw-leading, …)` that cannot be wrapped as a whole — its
 * absolute definitions are scaled instead.
 *
 * Root rules (`html`, `:root`, `:host`) keep their font-size: it sets the rem.
 * Icon-font glyphs (`.codicon`) keep theirs: they sit in fixed hit targets.
 */
import fs from 'node:fs'
import path from 'node:path'

export const TEXT_SCALE_VAR = '--ic-text-scale'
const SCALE_REF = `var(${TEXT_SCALE_VAR}, 1)`

/** abs = a length that must scale · rel = follows its parent · mixed = both, per element · unknown = unresolvable. */
export type SizeKind = 'abs' | 'mixed' | 'rel' | 'unknown'
type LeafKind = SizeKind | 'neutral' | 'num'

export type TokenDefs = ReadonlyMap<string, readonly string[]>

const ABSOLUTE_UNITS = new Set(['px', 'rem', 'pt', 'pc', 'in', 'cm', 'mm', 'q'])
const CSS_WIDE = new Set(['initial', 'inherit', 'unset', 'revert', 'revert-layer'])
const MATH_FUNCTIONS = new Set(['calc', 'clamp', 'min', 'max', 'round', 'abs', 'sign', 'mod', 'rem'])
const MATH_CONSTANTS = new Set(['infinity', '-infinity', 'nan', 'pi', 'e'])
const SCALED_PROPS = new Set(['font-size', 'line-height'])
const ROOT_SELECTOR = /^(?:html|:root|:host)(?:[.[:#][^\s>+~]*)?$/i
const SKIP_SELECTOR = /\.codicon\b/

function closingParen(value: string, open: number): number {
  let depth = 0

  for (let i = open; i < value.length; i++) {
    if (value[i] === '(') {
      depth++
    } else if (value[i] === ')') {
      depth--

      if (depth === 0) {
        return i
      }
    }
  }

  return value.length
}

/** Splits at top-level occurrences of `sep` (whitespace when omitted), ignoring separators inside parentheses. */
export function splitTop(value: string, sep?: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0

  for (let i = 0; i < value.length; i++) {
    const ch = value[i]

    if (ch === '(') {
      depth++
    } else if (ch === ')') {
      depth--
    } else if (depth === 0 && (sep === undefined ? /\s/.test(ch) : ch === sep)) {
      parts.push(value.slice(start, i))
      start = i + 1
    }
  }

  parts.push(value.slice(start))

  return parts.map(part => part.trim()).filter(Boolean)
}

function combine(kinds: Iterable<LeafKind>): LeafKind {
  const seen = new Set(kinds)
  const sized = (['abs', 'rel', 'mixed', 'unknown'] as const).filter(kind => seen.has(kind))

  if (sized.length === 0) {
    return seen.has('num') ? 'num' : 'neutral'
  }

  if (seen.has('mixed') || (seen.has('abs') && seen.has('rel'))) {
    return 'mixed'
  }

  return seen.has('unknown') ? 'unknown' : sized[0]
}

function classifyVar(inner: string, defs: TokenDefs, seen: ReadonlySet<string>, inMath: boolean): LeafKind {
  const comma = splitTop(inner, ',')
  const name = comma[0] ?? ''
  const fallback = comma.length > 1 ? inner.slice(inner.indexOf(',') + 1).trim() : null
  const values = defs.get(name)
  const kinds: LeafKind[] = []

  if (values && !seen.has(name)) {
    const next = new Set(seen).add(name)
    kinds.push(...values.map(value => classifyLeaves(value, defs, next, inMath)))
  }

  if (fallback !== null) {
    kinds.push(classifyLeaves(fallback, defs, seen, inMath))
  }

  return kinds.length === 0 ? 'unknown' : combine(kinds)
}

/** A bare number is a factor inside math (`calc(var(--spacing) * 6)`) but a unitless line-height at the top level. */
function classifyLeaves(value: string, defs: TokenDefs, seen: ReadonlySet<string>, inMath: boolean): LeafKind {
  const kinds: LeafKind[] = []
  let i = 0

  while (i < value.length) {
    const rest = value.slice(i)
    const fn = /^([a-z-]+)\(/i.exec(rest)

    if (fn) {
      const name = fn[1].toLowerCase()
      const open = i + fn[1].length
      const close = closingParen(value, open)
      const inner = value.slice(open + 1, close)

      if (name === 'var') {
        kinds.push(classifyVar(inner, defs, seen, inMath))
      } else if (MATH_FUNCTIONS.has(name)) {
        const kind = classifyLeaves(inner, defs, seen, true)
        kinds.push(kind === 'num' && !inMath ? 'rel' : kind)
      } else {
        kinds.push('unknown')
      }

      i = close + 1

      continue
    }

    const num = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?([a-z%]*)/i.exec(rest)

    if (num) {
      const unit = num[1].toLowerCase()
      kinds.push(unit === '' ? (inMath ? 'num' : 'rel') : ABSOLUTE_UNITS.has(unit) ? 'abs' : 'rel')
      i += num[0].length

      continue
    }

    const word = /^-*[a-z_][\w-]*/i.exec(rest)

    if (word) {
      const lower = word[0].toLowerCase()
      kinds.push(CSS_WIDE.has(lower) ? 'neutral' : inMath && MATH_CONSTANTS.has(lower) ? 'num' : 'rel')
      i += word[0].length

      continue
    }

    i++
  }

  return combine(kinds)
}

/** How a `font-size` / `line-height` value behaves under the text scale. */
export function classifySize(value: string, defs: TokenDefs = new Map()): SizeKind {
  const kind = classifyLeaves(value.trim(), defs, new Set(), false)

  return kind === 'num' || kind === 'neutral' ? 'rel' : kind
}

export function isScaled(value: string): boolean {
  return value.includes(TEXT_SCALE_VAR)
}

/** The smallest a scaled size may get (U3-p2-08: ½× put captions at 5px). A
 *  value already under its floor at 1× keeps its own value as the floor, so the
 *  default rendering is byte-for-byte what it was. */
export const FONT_SIZE_FLOOR_PX = 10
export const LINE_HEIGHT_FLOOR_PX = 12

export function scaleValue(value: string, floorPx?: number): string {
  const scaled = `calc(${value.trim()} * ${SCALE_REF})`

  return floorPx === undefined ? scaled : `max(min(${value.trim()}, ${floorPx}px), ${scaled})`
}

function floorFor(prop: string): number {
  return prop === 'line-height' ? LINE_HEIGHT_FLOOR_PX : FONT_SIZE_FLOOR_PX
}

/** `var(--x)` / `var(--x, fallback)` as the whole value → `--x`. */
function soleVar(value: string): null | string {
  const match = /^var\(\s*(--[\w-]+)/.exec(value.trim())

  if (!match || closingParen(value.trim(), 3) !== value.trim().length - 1) {
    return null
  }

  return match[1]
}

/** Scales the size (and an absolute `/line-height`) inside a `font` shorthand. */
export function scaleFontShorthand(value: string, defs: TokenDefs = new Map()): string {
  const parts = splitTop(value)
  let changed = false

  const out = parts.map(part => {
    const slashed = splitTop(part, '/')
    const size = slashed[0] ?? ''

    if (changed || !/^[\d.+-]|^(?:calc|clamp|min|max|var)\(/i.test(size)) {
      return part
    }

    const kind = classifySize(size, defs)

    if (kind !== 'abs' && !/[a-z%)]$/i.test(size)) {
      return part
    }

    changed = true

    const sized = kind === 'abs' ? scaleValue(size, FONT_SIZE_FLOOR_PX) : size
    const lineHeight = slashed[1]

    if (lineHeight === undefined) {
      return sized
    }

    return `${sized}/${classifySize(lineHeight, defs) === 'abs' ? scaleValue(lineHeight, LINE_HEIGHT_FLOOR_PX) : lineHeight}`
  })

  return changed ? out.join(' ') : value
}

const DEF_RE = /(--[\w-]+)\s*:\s*([^;{}]+)/g
const USE_RE = /(?:^|[;{\s])(font-size|line-height)\s*:\s*([^;{}]+)/g

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function addDef(defs: Map<string, string[]>, name: string, value: string): void {
  const list = defs.get(name)
  const clean = value.replace(/!important\s*$/i, '').trim()

  if (list) {
    list.push(clean)
  } else {
    defs.set(name, [clean])
  }
}

/** Custom-property definitions and font-size/line-height values found in raw CSS text. */
export function scanCss(css: string): { defs: Map<string, string[]>; uses: string[] } {
  const text = stripComments(css)
  const defs = new Map<string, string[]>()
  const uses: string[] = []

  for (const match of text.matchAll(DEF_RE)) {
    addDef(defs, match[1], match[2])
  }

  for (const match of text.matchAll(USE_RE)) {
    uses.push(match[2].trim())
  }

  return { defs, uses }
}

function mergeDefs(...maps: TokenDefs[]): Map<string, string[]> {
  const out = new Map<string, string[]>()

  for (const map of maps) {
    for (const [name, values] of map) {
      for (const value of values) {
        addDef(out, name, value)
      }
    }
  }

  return out
}

/** Properties read by a font-size/line-height that mixes absolute and relative values (see the module comment). */
export function findCarriers(uses: Iterable<string>, defs: TokenDefs): Set<string> {
  const carriers = new Set<string>()

  for (const use of uses) {
    const name = soleVar(use)

    if (name && classifySize(use, defs) === 'mixed') {
      carriers.add(name)
    }
  }

  return carriers
}

/* Minimal structural view of the PostCSS AST — only what the plugin reads and writes. */
export interface CssParent {
  type: string
  selector?: string
  parent?: CssParent
}

export interface CssDecl {
  prop: string
  value: string
  parent?: CssParent
}

export interface CssRoot {
  walkDecls(callback: (decl: CssDecl) => void): void
}

export interface TextScaleContext {
  defs: TokenDefs
  carriers: ReadonlySet<string>
}

function skippedRule(decl: CssDecl): boolean {
  const selector = decl.parent?.type === 'rule' ? decl.parent.selector : undefined

  if (!selector) {
    return false
  }

  if (SKIP_SELECTOR.test(selector)) {
    return true
  }

  return splitTop(selector, ',').every(part => ROOT_SELECTOR.test(part))
}

/** The rewritten value for one declaration, or null when it stays as is. */
export function scaleDecl(decl: CssDecl, ctx: TextScaleContext): null | string {
  const prop = decl.prop.toLowerCase()
  const value = decl.value

  if (isScaled(value) || skippedRule(decl)) {
    return null
  }

  if (SCALED_PROPS.has(prop) || ctx.carriers.has(decl.prop)) {
    return classifySize(value, ctx.defs) === 'abs' ? scaleValue(value, floorFor(prop)) : null
  }

  if (prop === 'font') {
    const next = scaleFontShorthand(value, ctx.defs)

    return next === value ? null : next
  }

  return null
}

export interface AuditEntry {
  selector: string
  prop: string
  value: string
  kind: SizeKind
}

/** Absolute or unresolvable font-size/line-height declarations left unscaled — the T0 gate wants 0 `abs`. */
export function auditDecls(root: CssRoot, ctx: TextScaleContext): AuditEntry[] {
  const entries: AuditEntry[] = []

  root.walkDecls(decl => {
    const prop = decl.prop.toLowerCase()

    if (!SCALED_PROPS.has(prop) || isScaled(decl.value) || skippedRule(decl)) {
      return
    }

    const kind = classifySize(decl.value, ctx.defs)

    if (kind === 'abs' || kind === 'unknown' || (kind === 'mixed' && !ctx.carriers.has(soleVar(decl.value) ?? ''))) {
      entries.push({ selector: decl.parent?.selector ?? decl.parent?.type ?? '', prop, value: decl.value, kind })
    }
  })

  return entries
}

function listCss(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory() && entry.name !== 'node_modules') {
      listCss(full, out)
    } else if (entry.isFile() && entry.name.endsWith('.css')) {
      out.push(full)
    }
  }

  return out
}

/** Tokens and font uses of every `.css` under `dirs` (a token is often defined in one file and read in another). */
export function scanSources(dirs: readonly string[]): { defs: Map<string, string[]>; uses: string[] } {
  const defs: TokenDefs[] = []
  const uses: string[] = []

  for (const file of dirs.flatMap(dir => listCss(dir, []))) {
    const scanned = scanCss(fs.readFileSync(file, 'utf8'))
    defs.push(scanned.defs)
    uses.push(...scanned.uses)
  }

  return { defs: mergeDefs(...defs), uses }
}

export function contextFor(root: CssRoot, global: { defs: TokenDefs; uses: readonly string[] }): TextScaleContext {
  const local = new Map<string, string[]>()
  const uses = [...global.uses]

  root.walkDecls(decl => {
    if (decl.prop.startsWith('--')) {
      addDef(local, decl.prop, decl.value)
    } else if (SCALED_PROPS.has(decl.prop.toLowerCase())) {
      uses.push(decl.value)
    }
  })

  const defs = mergeDefs(global.defs, local)

  return { defs, carriers: findCarriers(uses, defs) }
}

export interface TextScalePlugin {
  postcssPlugin: string
  Once(root: CssRoot): void
}

/**
 * The PostCSS plugin. `sourceDirs` are scanned once for tokens defined in one
 * stylesheet and read in another; a token added while the dev server runs is
 * seen after a restart (the file defining it is always seen at once).
 */
export function textScale(options: { sourceDirs: readonly string[] }): TextScalePlugin {
  let global: { defs: TokenDefs; uses: readonly string[] } | null = null

  return {
    postcssPlugin: 'ic-text-scale',
    Once(root) {
      global ??= scanSources(options.sourceDirs)
      const ctx = contextFor(root, global)

      root.walkDecls(decl => {
        const next = scaleDecl(decl, ctx)

        if (next !== null) {
          decl.value = next
        }
      })
    }
  }
}
