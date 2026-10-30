/**
 * The skills catalog, derived from the bundled `<skill>/SKILL.md` frontmatter at READ time.
 *
 * Other fronts edit SKILL.md files while the app runs; a committed CATALOG.json goes stale between their edit and
 * the next generator run. So the app never trusts one: the sync, the Settings → Skills pane and every synced tree
 * use this derivation. The committed iclone/skills/CATALOG.* are docs, guarded by `build-catalog.mjs --check`.
 *
 * TS port of the pure core of iclone/skills/tools/build-catalog.mjs (frontmatter subset, cue, platforms, the
 * CATALOG.json/.md bytes); iclone-skills-catalog.test.ts holds the two to byte-equal output on the real bundle
 * and on fixtures.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

export interface SkillCatalogEntry {
  name: string
  version: string
  description: string
  whenToOpen: string
  tags: string[]
  relatedSkills: string[]
  /** Frontmatter `platforms`, lowercase; [] = every OS. */
  platforms: string[]
  /** Set when the SKILL.md frontmatter could not be read: the row stays (the sync still teaches the folder). */
  problem?: string
}

export interface SkillCatalog {
  schema: number
  category: string
  count: number
  skills: SkillCatalogEntry[]
  /** The OS the app runs on (`macos` | `linux` | `windows`), set by the IPC read, never written to a file. */
  host?: string
}

/** Hermes' index row cut (agent/skill_utils.py SKILL_PROMPT_DESC_LIMIT 60 minus "..."). */
const PROMPT_CUT = 57
export const SHIPPED_OS: readonly string[] = ['macos', 'linux']

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const OS_ALIAS: Record<string, string> = { darwin: 'macos', win32: 'windows' }

type Frontmatter = { [key: string]: FrontmatterValue }
type FrontmatterValue = string | string[] | Frontmatter

const KEY_LINE = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/
const BLOCK_SCALAR = /^([|>])([1-9]?)([-+]?)([1-9]?)(?:\s+#.*)?$/

const YAML_ESCAPES: Record<string, string> = {
  '0': '\0',
  a: '\x07',
  b: '\b',
  t: '\t',
  '\t': '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  e: '\x1b',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
  N: '\x85',
  _: '\xa0',
  L: ' ',
  P: ' '
}

const indentOf = (line: string) => line.length - line.trimStart().length
const isContent = (line: string) => Boolean(line.trim()) && !line.trimStart().startsWith('#')

/** The body of a one-line YAML double-quoted string, with every YAML escape (`\x41`, `\N`, `\_` …). */
function doubleQuoted(inner: string): string {
  return inner.replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[\s\S])|"/g, (_whole, esc?: string) => {
    if (esc === undefined) {
      throw new Error('unescaped " inside a double-quoted string')
    }

    if (esc.length > 1) {
      return String.fromCodePoint(parseInt(esc.slice(1), 16))
    }

    const out = YAML_ESCAPES[esc]

    if (out === undefined) {
      throw new Error(`unknown escape \\${esc} in a double-quoted string`)
    }

    return out
  })
}

function unquote(value: string): string {
  const v = value.trim()

  if (v.startsWith('"') || v.startsWith("'")) {
    if (v.length < 2 || !v.endsWith(v[0])) {
      throw new Error(`unterminated quoted string: ${v.slice(0, 60)}`)
    }

    return v[0] === '"' ? doubleQuoted(v.slice(1, -1)) : v.slice(1, -1).replace(/''/g, "'")
  }

  return v.replace(/\s+#.*$/, '')
}

function scalar(value: string): string | string[] {
  const v = value.trim().replace(/^(\[.*\])\s+#.*$/, '$1')

  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim()

    return inner ? inner.split(',').map(item => unquote(item)) : []
  }

  return unquote(v)
}

/** YAML line folding: a single break between two plain lines is a space, each blank line is one `\n`, and the
 *  breaks around a more-indented line stay. */
function fold(lines: readonly string[]): string {
  let out = ''
  let prev: string | null = null
  let empty = 0

  for (const line of lines) {
    if (!line) {
      empty++

      continue
    }

    if (prev === null) {
      out = '\n'.repeat(empty) + line
    } else if (/^\s/.test(line) || /^\s/.test(prev)) {
      out += '\n'.repeat(empty + 1) + line
    } else {
      out += empty ? '\n'.repeat(empty) + line : ` ${line}`
    }

    prev = line
    empty = 0
  }

  return out
}

/** A `|` / `>` block scalar (chomping `-` `+`, indentation digit) under a key at `indent`, from line `start`. */
function blockScalar(
  lines: readonly string[],
  start: number,
  indent: number,
  head: RegExpExecArray,
  lastBreak: boolean
): [string, number] {
  let end = start

  while (end < lines.length && (!lines[end].trim() || indentOf(lines[end]) > indent)) {
    end++
  }

  const body = lines.slice(start, end)
  const digit = head[2] || head[4]
  const first = body.find(line => line.trim())
  const at = digit ? indent + Number(digit) : first === undefined ? indent + 1 : indentOf(first)
  const text: string[] = []

  for (const line of body) {
    if (!line.trim()) {
      text.push('')
    } else if (indentOf(line) < at) {
      throw new Error(`bad indentation in a block scalar: ${line.trim().slice(0, 60)}`)
    } else {
      text.push(line.slice(at))
    }
  }

  let last = text.length

  while (last > 0 && !text[last - 1]) {
    last--
  }

  const content = text.slice(0, last)
  const value = head[1] === '|' ? content.join('\n') : fold(content)
  const chomp = head[3]
  // The block's final line touches the closing fence with no line break of its own (Hermes cuts the YAML there).
  const open = end === lines.length && !lastBreak

  if (chomp === '+') {
    return [value + '\n'.repeat(Math.max((content.length ? 1 : 0) + text.length - last - (open ? 1 : 0), 0)), end]
  }

  return [chomp === '-' || !content.length || (open && last === text.length) ? value : `${value}\n`, end]
}

/** A block list (`- item` lines at one indent) of scalars, from line `start`. */
function blockSequence(lines: readonly string[], start: number, indent: number): [string[], number] {
  const items: string[] = []
  let i = start

  for (; i < lines.length; i++) {
    const line = lines[i]

    if (!isContent(line)) {
      continue
    }

    if (indentOf(line) !== indent || !/^-(\s|$)/.test(line.trim())) {
      break
    }

    const item = line.trim().slice(1).trim()

    if (!item || item.startsWith('#') || KEY_LINE.test(item) || /^[-[{|>]/.test(item)) {
      throw new Error(`unsupported list item: ${line.trim().slice(0, 60)}`)
    }

    items.push(unquote(item))
  }

  return [items, i]
}

/** The leading `---` block (one leading BOM skipped, as Hermes does): `key: value` lines nesting by indentation,
 *  quoted strings with YAML escapes, flow and block lists, `|` / `>` block scalars and multi-line plain values.
 *  Throws on anything else.
 * @public used by RESUME/run/gates/R14/extra/2026-10-17_r5_fuzz_vs_hermes.sh
 */
export function parseFrontmatter(text: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text.replace(/^\uFEFF/, ''))

  if (!match) {
    throw new Error('no frontmatter block')
  }

  const lines = match[1].split(/\r?\n/)
  const lastBreak = lines[lines.length - 1] === ''

  if (lastBreak) {
    lines.pop()
  }

  const root: Frontmatter = {}
  const stack: { indent: number; node: Frontmatter; keys?: number }[] = [{ indent: -1, node: root }]
  let i = 0

  while (i < lines.length) {
    const line = lines[i++]

    if (!isContent(line)) {
      continue
    }

    const indent = indentOf(line)
    const kv = KEY_LINE.exec(line.trim())

    if (!kv) {
      throw new Error(`unsupported frontmatter line: ${line.trim().slice(0, 60)}`)
    }

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop()
    }

    const top = stack[stack.length - 1]
    const key = kv[1]
    const raw = kv[2] ?? ''

    if (top.keys === undefined) {
      top.keys = indent
    } else if (top.keys !== indent) {
      throw new Error(`bad indentation at: ${line.trim().slice(0, 60)}`)
    }

    const block = BLOCK_SCALAR.exec(raw)

    if (block) {
      ;[top.node[key], i] = blockScalar(lines, i, indent, block, lastBreak)
    } else if (raw && !raw.startsWith('#')) {
      const more: string[] = []
      let end = i

      while (!/^["'[]/.test(raw) && end < lines.length) {
        const next = lines[end]

        if (next.trim() && (indentOf(next) <= indent || next.trimStart().startsWith('#'))) {
          break
        }

        more.push(next.trim())
        end++
      }

      if (more.some(Boolean)) {
        const parts = [raw, ...more]

        if (parts.some(part => /(^|\s)#|:(\s|$)/.test(part))) {
          throw new Error(`unsupported multi-line value of ${key}`)
        }

        top.node[key] = fold(parts)
        i = end
      } else {
        top.node[key] = scalar(raw)
      }
    } else {
      let next = i

      while (next < lines.length && !isContent(lines[next])) {
        next++
      }

      const first = lines[next]

      if (first !== undefined && indentOf(first) >= indent && /^-(\s|$)/.test(first.trim())) {
        ;[top.node[key], i] = blockSequence(lines, next, indentOf(first))
      } else {
        const child: Frontmatter = {}

        top.node[key] = child
        stack.push({ indent, node: child })
      }
    }
  }

  return root
}

/** The when-to-open cue: the first sentence of the description. */
function cueOf(description: string): string {
  const end = description.search(/[.;](\s|$)/)

  return end < 0 ? description : description.slice(0, end + 1)
}

/** @public used by RESUME/run/gates/R14/extra/2026-10-17_r5_fuzz_vs_hermes.sh */
export function platformsOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' && value.trim() ? [value] : []

  return list.map(item => String(item).trim().toLowerCase()).filter(Boolean)
}

/** The OSes in `among` that Hermes hides a skill on, given its `platforms` (skill_matches_platform). */
export function hiddenOn(platforms: readonly string[], among: readonly string[] = SHIPPED_OS): string[] {
  if (!platforms.length) {
    return []
  }

  const allowed = new Set(platforms.map(item => OS_ALIAS[item] ?? item))

  return among.filter(os => !allowed.has(os))
}

export function hostOs(platform: string = process.platform): string {
  return OS_ALIAS[platform] ?? platform
}

const list = (value: FrontmatterValue | undefined): string[] => (Array.isArray(value) ? value : [])

function entryOf(name: string, fm: Frontmatter): SkillCatalogEntry {
  const description = typeof fm.description === 'string' ? fm.description.trim() : ''
  const metadata = fm.metadata
  const meta = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata.hermes : undefined
  const hermes = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}
  const version = fm.version

  return {
    name,
    version: version === undefined ? '' : typeof version === 'object' ? String(version) : version,
    description,
    whenToOpen: cueOf(description),
    tags: list(hermes.tags),
    relatedSkills: list(hermes.related_skills),
    platforms: platformsOf(fm.platforms)
  }
}

/** The row of a folder whose SKILL.md exists but cannot be read: kept, never dropped, so nobody loses it silently. */
function unreadableEntry(name: string, problem: string): SkillCatalogEntry {
  return { name, version: '', description: '', whenToOpen: '', tags: [], relatedSkills: [], platforms: [], problem }
}

/** One row per `<dir>/<name>/SKILL.md`, sorted by name (an unreadable frontmatter is a row with `problem`); null when
 *  `dir` is not a folder. */
export function deriveSkillCatalog(dir: string): SkillCatalog | null {
  let names: string[]

  try {
    names = readdirSync(dir).sort()
  } catch {
    return null
  }

  const skills: SkillCatalogEntry[] = []

  for (const name of names) {
    let text: string

    try {
      if (!SKILL_NAME.test(name) || !statSync(path.join(dir, name)).isDirectory()) {
        continue
      }

      text = readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code

      if (code && code !== 'ENOENT') {
        skills.push(unreadableEntry(name, `SKILL.md unreadable (${code})`))
      }

      continue
    }

    try {
      skills.push(entryOf(name, parseFrontmatter(text)))
    } catch (error) {
      skills.push(unreadableEntry(name, error instanceof Error ? error.message : String(error)))
    }
  }

  return { schema: 1, category: 'iclone', count: skills.length, skills }
}

/** CATALOG.json + CATALOG.md exactly as build-catalog.mjs renders them. */
export function renderCatalogFiles(
  skills: readonly SkillCatalogEntry[]
): Record<'CATALOG.json' | 'CATALOG.md', string> {
  const json = `${JSON.stringify({ schema: 1, category: 'iclone', count: skills.length, skills }, null, 2)}\n`
  const cell = (value: string) => value.replace(/\|/g, '\\|')

  const md = [
    '# iclone os — skills catalog',
    '',
    '<!-- Generated by tools/build-catalog.mjs from every SKILL.md frontmatter. Do not edit by hand. -->',
    '',
    `${skills.length} skills. Every agent sees one index row per skill (name + the first ${PROMPT_CUT} chars of its`,
    'description) and opens a skill with `skill_view(name)` only when the task matches that row.',
    '',
    '| Skill | When to open | Version |',
    '| --- | --- | --- |',
    ...skills.map(
      s =>
        `| \`${s.name}\` | ${cell(s.problem ? `Frontmatter unreadable — ${s.problem}` : s.whenToOpen)} | ${cell(s.version)} |`
    ),
    ''
  ].join('\n')

  return { 'CATALOG.json': json, 'CATALOG.md': md }
}
