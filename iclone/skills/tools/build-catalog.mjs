#!/usr/bin/env node
// Generates the skills catalog of iclone os from every `<skill>/SKILL.md` frontmatter:
//   CATALOG.json  — machine truth (the Settings → Skills pane, the sync report, the parity test)
//   CATALOG.md    — the same table for humans
//   DESCRIPTION.md — the category line Hermes renders above our rows in <available_skills> for EVERY agent
// Usage: node build-catalog.mjs [--check] [--dir <skills dir>]. --check writes nothing and exits 1 on drift or a rule break.
// No dependencies: the YAML frontmatter Hermes accepts in practice (scalars, YAML-escaped strings, flow and block lists,
// nested maps, | and > block scalars, a leading BOM) is parsed here. A frontmatter outside it is a row with `problem`, never a dropped row.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Hermes cuts every index row at 60 chars and appends "..." (agent/skill_utils.py SKILL_PROMPT_DESC_LIMIT). */
export const PROMPT_CUT = 57
export const CUE = 'Use when '
export const CATEGORY_LINE =
  'icloneOS skills — open one with skill_view only when the task matches its line; never browse'
export const CATEGORY_LINE_MAX_BYTES = 160
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
/** The OSes the app ships on. Hermes hides a skill whose `platforms` exclude the host (skill_utils.py skill_matches_platform). */
export const SHIPPED_OS = ['macos', 'linux']
const OS_ALIAS = { darwin: 'macos', win32: 'windows' }

/** The top-level `platforms` key as a lowercase list; [] = every OS (Hermes' rule for a missing key). */
export function platformsOf(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' && value.trim() ? [value] : []

  return list.map(item => String(item).trim().toLowerCase()).filter(Boolean)
}

/** The shipped OSes a skill is hidden on, given its `platforms` list. */
export function hiddenOn(platforms, shipped = SHIPPED_OS) {
  if (!platforms.length) {
    return []
  }

  const allowed = new Set(platforms.map(item => OS_ALIAS[item] ?? item))

  return shipped.filter(os => !allowed.has(os))
}

const KEY_LINE = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/
const BLOCK_SCALAR = /^([|>])([1-9]?)([-+]?)([1-9]?)(?:\s+#.*)?$/

const YAML_ESCAPES = {
  0: '\0',
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

const indentOf = line => line.length - line.trimStart().length
const isContent = line => Boolean(line.trim()) && !line.trimStart().startsWith('#')

/** The body of a one-line YAML double-quoted string, with every YAML escape (`\x41`, `\N`, `\_` …). */
function doubleQuoted(inner) {
  return inner.replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[\s\S])|"/g, (_whole, esc) => {
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

function unquote(value) {
  const v = value.trim()

  if (v.startsWith('"') || v.startsWith("'")) {
    if (v.length < 2 || !v.endsWith(v[0])) {
      throw new Error(`unterminated quoted string: ${v.slice(0, 60)}`)
    }

    return v[0] === '"' ? doubleQuoted(v.slice(1, -1)) : v.slice(1, -1).replace(/''/g, "'")
  }

  return v.replace(/\s+#.*$/, '')
}

function scalar(value) {
  const v = value.trim().replace(/^(\[.*\])\s+#.*$/, '$1')

  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim()

    return inner ? inner.split(',').map(item => unquote(item)) : []
  }

  return unquote(v)
}

/** YAML line folding: a single break between two plain lines is a space, each blank line is one `\n`, and the
 *  breaks around a more-indented line stay. */
function fold(lines) {
  let out = ''
  let prev = null
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
function blockScalar(lines, start, indent, head, lastBreak) {
  let end = start

  while (end < lines.length && (!lines[end].trim() || indentOf(lines[end]) > indent)) {
    end++
  }

  const body = lines.slice(start, end)
  const digit = head[2] || head[4]
  const first = body.find(line => line.trim())
  const at = digit ? indent + Number(digit) : first === undefined ? indent + 1 : indentOf(first)
  const text = []

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
function blockSequence(lines, start, indent) {
  const items = []
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
 *  Throws on anything else. */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text.replace(/^\uFEFF/, ''))

  if (!match) {
    throw new Error('no frontmatter block')
  }

  const lines = match[1].split(/\r?\n/)
  const lastBreak = lines[lines.length - 1] === ''

  if (lastBreak) {
    lines.pop()
  }

  const root = {}
  const stack = [{ indent: -1, node: root }]
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
      const more = []
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
        const child = {}

        top.node[key] = child
        stack.push({ indent, node: child })
      }
    }
  }

  return root
}

/** The when-to-open cue: the first sentence of the description. */
export function cueOf(description) {
  const end = description.search(/[.;](\s|$)/)

  return end < 0 ? description : description.slice(0, end + 1)
}

/** Rule breaks for one description (empty = ok). */
export function descriptionProblems(name, description) {
  const problems = []

  if (!description) {
    return [`${name}: description missing`]
  }

  if (!description.startsWith(CUE)) {
    problems.push(`${name}: description must start with "${CUE.trim()}"`)
  }

  if (cueOf(description).length > PROMPT_CUT) {
    problems.push(`${name}: the cue "${cueOf(description)}" is longer than ${PROMPT_CUT} chars (the prompt cut)`)
  }

  if (description.length > 1024) {
    problems.push(`${name}: description over 1024 chars`)
  }

  return problems
}

/** Skill names Hermes bundles (`<repo>/skills/<category>/<name>/SKILL.md`): a related skill may point at one. */
export function upstreamSkillNames(dir) {
  const root = path.resolve(dir, '..', '..', 'skills')
  const names = new Set()
  const walk = (folder, depth) => {
    let entries

    try {
      entries = readdirSync(folder, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }

      const child = path.join(folder, entry.name)

      try {
        if (statSync(path.join(child, 'SKILL.md')).isFile()) {
          names.add(entry.name)
          continue
        }
      } catch {
        // not a skill folder: a category, look one level deeper
      }

      if (depth < 2) {
        walk(child, depth + 1)
      }
    }
  }

  walk(root, 0)

  return names
}

/** Constructs Hermes (full YAML) and both parsers read, but the house style avoids, so the frontmatter stays one
 *  `key: value` line per key that every grep-based tool and Hermes' own malformed-YAML fallback read alike. */
export function styleNotes(text) {
  const notes = []
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text.replace(/^\uFEFF/, ''))
  const lines = (match ? match[1].split(/\r?\n/) : [])
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))

  if (text.startsWith('\uFEFF')) {
    notes.push('a leading BOM')
  }

  if (lines.some(line => /^-(\s|$)/.test(line))) {
    notes.push('a block list (write [a, b])')
  }

  if (lines.some(line => /^[A-Za-z0-9_.-]+:\s+[|>][1-9]?[-+]?[1-9]?(\s+#.*)?$/.test(line))) {
    notes.push('a | or > block scalar')
  }

  if (lines.some(line => !KEY_LINE.test(line) && !/^-(\s|$)/.test(line))) {
    notes.push('a value over several lines')
  }

  if (
    lines.some(line => line.includes('"') && [...line.matchAll(/\\([\s\S])/g)].some(m => !'"\\/bfnrtu'.includes(m[1])))
  ) {
    notes.push('a YAML-only escape (\\x41, \\N …; use the character)')
  }

  return notes
}

/** A third-party skill shipped byte-for-byte names its origin here, beside its SKILL.md. */
export const VENDORED_FILE = 'VENDORED.json'

/**
 * The vendored record of one skill folder: null when the folder is ours; otherwise its problems. A vendored SKILL.md
 * is exempt from the house style and the cue rule (its author wrote it, and editing it would break the sha256 that
 * proves it is the published file); it must still match that sha256, its frontmatter version and a licence.
 */
export function vendoredCheck(name, skillDir, skillBytes, version) {
  let raw

  try {
    raw = readFileSync(path.join(skillDir, VENDORED_FILE), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }

    return { problems: [`${name}: ${VENDORED_FILE} unreadable (${error.code})`] }
  }

  let record

  try {
    record = JSON.parse(raw)
  } catch {
    return { problems: [`${name}: ${VENDORED_FILE} is not JSON`] }
  }

  const problems = []
  const sha256 = createHash('sha256').update(skillBytes).digest('hex')

  if (typeof record?.source !== 'string' || !/^https:\/\//.test(record.source)) {
    problems.push(`${name}: ${VENDORED_FILE} names no https source`)
  }

  if (typeof record?.licence !== 'string' || !record.licence.trim()) {
    problems.push(`${name}: ${VENDORED_FILE} names no licence`)
  }

  if (record?.sha256 !== sha256) {
    problems.push(
      `${name}: SKILL.md is not the vendored file (sha256 ${sha256.slice(0, 12)}… ≠ ${VENDORED_FILE}) — ship it unedited`
    )
  }

  if (String(record?.version ?? '') !== version) {
    problems.push(
      `${name}: ${VENDORED_FILE} version "${record?.version ?? ''}" differs from the SKILL.md version "${version}"`
    )
  }

  return { problems }
}

/** The row of a folder whose SKILL.md exists but cannot be read (same shape as the app's derivation). */
export function unreadableEntry(name, problem) {
  return { name, version: '', description: '', whenToOpen: '', tags: [], relatedSkills: [], platforms: [], problem }
}

export function buildCatalog(dir, upstream = upstreamSkillNames(dir)) {
  const problems = []
  const skills = []

  for (const name of readdirSync(dir).sort()) {
    const skillFile = path.join(dir, name, 'SKILL.md')

    if (!SKILL_NAME.test(name) || !statSync(path.join(dir, name)).isDirectory()) {
      continue
    }

    let text

    try {
      text = readFileSync(skillFile, 'utf8')
    } catch (error) {
      if (error.code && error.code !== 'ENOENT') {
        problems.push(`${name}: SKILL.md unreadable (${error.code})`)
        skills.push(unreadableEntry(name, `SKILL.md unreadable (${error.code})`))
      }

      continue
    }

    let fm

    try {
      fm = parseFrontmatter(text)
    } catch (error) {
      // Kept as a flagged row: the sync still teaches the folder and Hermes still indexes it.
      problems.push(`${name}: frontmatter unreadable — ${error.message}`)
      skills.push(unreadableEntry(name, error.message))
      continue
    }

    const description = typeof fm.description === 'string' ? fm.description.trim() : ''
    const hermes = fm.metadata?.hermes ?? {}
    const vendored = vendoredCheck(name, path.join(dir, name), readFileSync(skillFile), String(fm.version ?? ''))
    const style = vendored ? [] : styleNotes(text)

    if (style.length) {
      problems.push(`${name}: frontmatter uses ${style.join(', ')} — Hermes reads it; keep one plain line per key`)
    }

    if (fm.name !== name) {
      problems.push(`${name}: frontmatter name "${fm.name ?? ''}" differs from the folder`)
    }

    if (vendored) {
      problems.push(...vendored.problems)

      if (!description) {
        problems.push(`${name}: description missing`)
      }
    } else {
      problems.push(...descriptionProblems(name, description))
    }
    skills.push({
      name,
      version: String(fm.version ?? ''),
      description,
      whenToOpen: cueOf(description),
      tags: Array.isArray(hermes.tags) ? hermes.tags : [],
      relatedSkills: Array.isArray(hermes.related_skills) ? hermes.related_skills : [],
      platforms: platformsOf(fm.platforms)
    })
  }

  const names = new Set(skills.map(skill => skill.name))

  for (const skill of skills) {
    for (const os of hiddenOn(skill.platforms)) {
      problems.push(`${skill.name}: hidden from agents on ${os} by platforms: [${skill.platforms.join(', ')}]`)
    }

    for (const target of skill.relatedSkills) {
      if (!names.has(target) && !upstream.has(target)) {
        problems.push(`${skill.name}: related skill "${target}" is neither in the bundle nor bundled with Hermes`)
      }
    }
  }

  if (Buffer.byteLength(CATEGORY_LINE) > CATEGORY_LINE_MAX_BYTES) {
    problems.push(`category line over ${CATEGORY_LINE_MAX_BYTES} B`)
  }

  return { problems, skills }
}

export function renderFiles(skills) {
  const json = `${JSON.stringify({ schema: 1, category: 'iclone', count: skills.length, skills }, null, 2)}\n`

  const cell = value => String(value).replace(/\|/g, '\\|')

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

  const description = `---\ndescription: ${CATEGORY_LINE}\n---\n`

  return { 'CATALOG.json': json, 'CATALOG.md': md, 'DESCRIPTION.md': description }
}

// Frontmatter only: a body edit (owned by each skill's front) never stales the catalog; the pane measures live bytes.
const ROW_FIELDS = ['version', 'description', 'whenToOpen', 'tags', 'relatedSkills', 'platforms']

/** Both sides of a changed field. Strings are cut around their first differing char, so the drift itself shows. */
export function changeSides(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string') {
    return [JSON.stringify(before), JSON.stringify(after)]
  }

  let at = 0

  while (at < before.length && at < after.length && before[at] === after[at]) {
    at += 1
  }

  let from = Math.max(0, at - 20)

  // Back up to the start of the word, so the context reads as text.
  while (from > 0 && from > at - 30 && before[from - 1] !== ' ') {
    from -= 1
  }
  const side = value => {
    const cut = value.slice(from, at + 12)

    return `${from > 0 ? '…' : ''}${cut}${at + 12 < value.length ? '…' : ''}`
  }

  return [side(before), side(after)]
}

/**
 * Names every SKILL.md whose row in the committed CATALOG.json no longer matches the folder, e.g.
 * `economyos/SKILL.md: version "1.2.0" → "1.3.0"`, so a stale catalog points at the edit that staled it.
 */
export function staleSkills(committedJson, skills) {
  let rows

  try {
    rows = JSON.parse(committedJson ?? '').skills
  } catch {
    rows = null
  }

  if (!Array.isArray(rows)) {
    return ['CATALOG.json: missing or unreadable']
  }

  const old = new Map(rows.filter(row => row && typeof row.name === 'string').map(row => [row.name, row]))
  const out = []
  const show = (field, before, after) => {
    const [a, b] = changeSides(before, after)

    return `${field} ${a} → ${b}`
  }

  for (const skill of skills) {
    const row = old.get(skill.name)

    if (!row) {
      out.push(`${skill.name}/SKILL.md: new skill`)
      continue
    }

    const changed = ROW_FIELDS.filter(field => JSON.stringify(row[field]) !== JSON.stringify(skill[field]))

    if (changed.length) {
      out.push(`${skill.name}/SKILL.md: ${changed.map(field => show(field, row[field], skill[field])).join(', ')}`)
    }
  }

  for (const name of old.keys()) {
    if (!skills.some(skill => skill.name === name)) {
      out.push(`${name}/SKILL.md: removed`)
    }
  }

  return out
}

/** tmp + rename: a reader (the sync, the pane, a test) never sees half a catalog. */
function writeAtomic(target, content) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}`)

  writeFileSync(tmp, content)
  renameSync(tmp, target)
}

function main(argv) {
  const check = argv.includes('--check')
  const dirAt = argv.indexOf('--dir')
  const dir =
    dirAt >= 0 ? path.resolve(argv[dirAt + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const { problems, skills } = buildCatalog(dir)
  const files = renderFiles(skills)
  const drift = []
  let committedJson = null

  try {
    committedJson = readFileSync(path.join(dir, 'CATALOG.json'), 'utf8')
  } catch {
    committedJson = null
  }

  const stale = staleSkills(committedJson, skills)

  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file)
    let current = null

    try {
      current = readFileSync(target, 'utf8')
    } catch {
      current = null
    }

    if (current === content) {
      continue
    }

    if (check) {
      drift.push(file)
    } else {
      writeAtomic(target, content)
    }
  }

  for (const problem of problems) {
    console.error(`skills catalog: ${problem}`)
  }

  for (const file of drift) {
    console.error(`skills catalog: ${file} is stale — run node iclone/skills/tools/build-catalog.mjs`)
  }

  if (drift.length) {
    for (const line of stale) {
      console.error(`skills catalog: drifted ${line}`)
    }
  }

  console.log(
    JSON.stringify({
      ok: !problems.length && !drift.length,
      skills: skills.length,
      problems: problems.length,
      drift,
      stale: drift.length ? stale : []
    })
  )

  return problems.length || drift.length ? 1 : 0
}

/** realpath on both sides: through a symlinked path (macOS /tmp, a linked checkout) the guard must still run main(). */
function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2))
}
