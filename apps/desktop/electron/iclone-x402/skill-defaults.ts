/**
 * V3-J — payment skills the app ships DISABLED (contract §1.3: `agentcard`, `touches:[$]`, per V3-B D3; §4 D4: which
 * payment skills are on is the user's choice). The bundle carries the skill; Hermes reads which skills are off from
 * `skills.disabled` in `<HERMES_HOME>/config.yaml` and in each `profiles/<name>/config.yaml`
 * (`agent/skill_utils.py get_disabled_skill_names`, re-read whenever the file changes). A MISSING config reads as "no
 * skill disabled", so main never leaves one missing (fix JM1): at launch, before every Hermes spawn and when a profile
 * folder appears, a config that does not exist is created (0600, exclusive) and an existing one gets each name once per
 * skill and per config folder, recorded in
 * `userData/payments/skills-seeded.json` (0600): a skill the user later turns on in the Skills page stays on.
 *
 * The root home's config belongs to the installer first (fix m-r2-1): `install.sh --stage config` copies the runtime's
 * `cli-config.yaml.example` only when no config exists, so creating one before it would silently drop the template's
 * defaults. A missing root config is therefore created from THAT template (the installer's own file, never a copy) plus
 * the `skills.disabled` block; while the template is not there yet (a fresh install whose bootstrap is pending) the
 * launch and profile passes leave the root config to the installer, and only the pass right before a Hermes spawn
 * creates the bare block, so no session ever reads a missing config. A profile's missing config is the bare block:
 * Hermes reads a profile without one as its built-in defaults, which the block does not change.
 *
 * The edit is deliberately narrow. It understands the shapes Hermes itself writes (PyYAML block style: `skills:` at
 * column 0, `disabled:` as an indented or indentless block list, `[]` or a flow list) and appends a new `skills:` block
 * when there is none. Any other shape is left untouched and reported, never guessed at. Nothing else in the file
 * changes, a file the user wrote is never replaced, and the write is atomic with the file's own mode.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { writeFileAtomicSync } from '../lib/atomic-write'

/** The bundled skills that start off: each one's manifest says `touches` has `$` and `shipped: "disabled"`. */
export const SHIPPED_DISABLED: readonly string[] = Object.freeze(['agentcard'])

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const TOP_KEY_RE = /^[^\s#][^:]*:/
const SKILLS_RE = /^skills:[ \t]*(#.*)?$/
const SKILLS_EMPTY_RE = /^skills:[ \t]*(\{\}|null|~)?[ \t]*(#.*)?$/
const FLOW_RE = /^\[(.*)\][ \t]*(#.*)?$/

const isBlank = (line: string) => line.trim() === '' || line.trimStart().startsWith('#')
const indentOf = (line: string) => line.length - line.trimStart().length

/**
 * `config.yaml` text with `name` in `skills.disabled`, the same text when it is already there, or null when the
 * file's shape is not one this edit understands (the caller leaves the file alone).
 */
export function withDisabledSkill(text: string, name: string): string | null {
  if (!SKILL_NAME_RE.test(name)) {
    return null
  }

  const lines = text.split('\n')
  const at = lines.findIndex(line => SKILLS_EMPTY_RE.test(line))

  if (at === -1) {
    if (lines.some(line => /^skills\s*:/.test(line))) {
      return null
    }

    const body = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`

    return `${body}skills:\n  disabled:\n  - ${name}\n`
  }

  // The `skills:` block: every line after it until the next top-level key.
  let end = at + 1

  while (end < lines.length && (isBlank(lines[end]) || indentOf(lines[end]) > 0)) {
    end += 1
  }

  const children = lines.slice(at + 1, end).filter(line => !isBlank(line))

  if (!SKILLS_RE.test(lines[at])) {
    // `skills: {}` / `skills: null`: an empty mapping written inline.
    if (children.length > 0) {
      return null
    }

    return [...lines.slice(0, at), 'skills:', '  disabled:', `  - ${name}`, ...lines.slice(at + 1)].join('\n')
  }

  const childIndent = children.length > 0 ? ' '.repeat(indentOf(children[0])) : '  '

  const key = lines.findIndex(
    (line, index) =>
      index > at && index < end && line.startsWith(`${childIndent}disabled:`) && indentOf(line) === childIndent.length
  )

  if (key === -1) {
    return [
      ...lines.slice(0, at + 1),
      `${childIndent}disabled:`,
      `${childIndent}- ${name}`,
      ...lines.slice(at + 1)
    ].join('\n')
  }

  const value = lines[key].slice(`${childIndent}disabled:`.length).trim()
  const flow = FLOW_RE.exec(value)

  if (flow) {
    const items = flow[1]
      .split(',')
      .map(item => item.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)

    if (items.includes(name)) {
      return text
    }

    return [
      ...lines.slice(0, key),
      `${childIndent}disabled:`,
      ...[...items, name].map(item => `${childIndent}- ${item}`),
      ...lines.slice(key + 1)
    ].join('\n')
  }

  if (value !== '' && !value.startsWith('#')) {
    // A bare scalar or anything else: not a shape Hermes writes.
    return null
  }

  // A block list under the key: indentless (same indent, PyYAML's default) or indented.
  let last = key
  let itemIndent: string | null = null

  for (let index = key + 1; index < end; index += 1) {
    const line = lines[index]

    if (isBlank(line)) {
      continue
    }

    const item = /^(\s*)- (.+?)[ \t]*(#.*)?$/.exec(line)

    if (!item || item[1].length < childIndent.length || (itemIndent !== null && item[1] !== itemIndent)) {
      break
    }

    itemIndent = item[1]

    if (item[2].replace(/^['"]|['"]$/g, '') === name) {
      return text
    }

    last = index
  }

  return [...lines.slice(0, last + 1), `${itemIndent ?? childIndent}- ${name}`, ...lines.slice(last + 1)].join('\n')
}

/** One config file's outcome. */
interface SeedResult {
  configFile: string
  /** True when there was no file and this call wrote one: the installer's template plus the `skills.disabled` block,
   *  or that block alone (a profile, or a spawn with no template to read). */
  created: boolean
  /** Names added to `skills.disabled` this time. */
  seeded: string[]
  /** Names already recorded for this config (the user's later choice stands) or already in its list. */
  kept: string[]
  /** Why nothing could be written to this config this time (retried at the next pass), or null. */
  skipped: string | null
}

interface SeedRecord {
  /** The folder holding the config (`dev:ino`): a profile deleted and created again under the same name is new. */
  dir: string
  skills: Record<string, string>
}

type SeedMarker = Record<string, SeedRecord>

const MARKER_VERSION = 2

/** What a missing config becomes: the `skills.disabled` block alone, which Hermes reads as a fresh minimal config. */
export const minimalConfig = (names: readonly string[]): string =>
  `skills:\n  disabled:\n${names.map(name => `  - ${name}\n`).join('')}`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stringsOf = (value: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))

function folderIdentity(dir: string): string | null {
  try {
    const stat = fs.statSync(dir)

    return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : null
  } catch {
    return null
  }
}

/**
 * The marker: `{v: 2, configs: {<config path>: {dir, skills: {<name>: <iso>}}}}`. The first shape this branch wrote,
 * `{<name>: <iso>}`, only ever described the root config: it is read as that config's record.
 */
function readMarker(markerFile: string, rootConfig: string | null, rootDir: string | null): SeedMarker {
  let parsed: unknown

  try {
    parsed = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  } catch {
    return {}
  }

  if (!isRecord(parsed)) {
    return {}
  }

  if (parsed.v === MARKER_VERSION && isRecord(parsed.configs)) {
    const marker: SeedMarker = {}

    for (const [file, value] of Object.entries(parsed.configs)) {
      if (isRecord(value) && typeof value.dir === 'string' && isRecord(value.skills)) {
        marker[file] = { dir: value.dir, skills: stringsOf(value.skills) }
      }
    }

    return marker
  }

  return rootConfig && rootDir ? { [rootConfig]: { dir: rootDir, skills: stringsOf(parsed) } } : {}
}

function writeMarker(markerFile: string, marker: SeedMarker): void {
  writeFileAtomicSync(markerFile, `${JSON.stringify({ v: MARKER_VERSION, configs: marker }, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700
  })
}

interface SeedTarget {
  configFile: string
  /** The root home may be created (first launch); a profile folder never is: Hermes creates profiles explicitly. */
  mayCreateDir: boolean
  /** The root home only: the installer's config template, the file a missing config is created from. */
  template?: null | string
  /** With no template to read, whether a missing config is created as the bare block now (`create`) or left to the
   *  installer (`wait`). Profiles always create. */
  withoutTemplate?: 'create' | 'wait'
  /** The resolved Hermes home and the profile slug this config belongs to (`default` for the root): a config.yaml
   *  that is a link resolving outside the home is never written, and its slug is reported unprotected. Unset (the
   *  single-config API) skips that check. */
  home?: null | string
  slug?: string
  /** Other profile names Hermes resolves to this same folder (a profile linked to another one, or to the home). */
  aliases?: string[]
}

/** Why a config is not seeded when it is a link out of the Hermes home (or a link to nothing). */
const LINKED_OUTSIDE = 'config.yaml links outside the Hermes home: never written'

/** Why a config is not seeded when a folder on its way changed between the check and the write (fix m-r3-1): like a
 *  link out, nothing is written and its profile is reported unprotected until a pass finds the folders settled. */
const MOVED = 'a folder of config.yaml changed while it was written: never written outside the Hermes home'

/** The check→write seams of one config's pass, in order (tests inject a concurrent swap at each; main passes none):
 *  `checked` after the link check, `opening` right before an existing config is opened for its edit, `placed` once
 *  the folder chain is recorded and before the temp file exists, `staged` once the temp file holds the text and before
 *  it is published. */
type WriteSeam = 'checked' | 'opening' | 'placed' | 'staged'
type Seam = ((at: WriteSeam, file: string) => void) | undefined

const { O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK, O_RDONLY, O_WRONLY } = fs.constants

/** `dev:ino` of the entry at `file` itself (lstat: a link is its own entry, never its target), or null. */
function entryId(file: string): null | string {
  try {
    const stat = fs.lstatSync(file)

    return `${stat.dev}:${stat.ino}`
  } catch {
    return null
  }
}

/** A real folder inside the Hermes home and the identity of every folder from the home down to it. */
interface Place {
  home: string
  dir: string
  chain: string[]
}

/** Each folder from `home` down to `dir` (both resolved), read with lstat so a link at any step breaks the chain; null
 *  when `dir` is not inside `home` or a step is not a real folder. */
function folderChain(home: string, dir: string): null | string[] {
  if (!isInside(home, dir)) {
    return null
  }

  const chain: string[] = []
  let at = home

  for (const step of ['', ...path.relative(home, dir).split(path.sep).filter(Boolean)]) {
    at = step ? path.join(at, step) : at

    try {
      const stat = fs.lstatSync(at)

      if (!stat.isDirectory()) {
        return null
      }

      chain.push(`${stat.dev}:${stat.ino}`)
    } catch {
      return null
    }
  }

  return chain
}

/** `dir` resolved, with its chain from `home` (resolved; null: the single-config API, the folder is its own home). */
function placeOf(home: null | string, dir: string): null | Place {
  const real = realOrNull(dir)
  const root = home ?? real

  if (real === null || root === null) {
    return null
  }

  const chain = folderChain(root, real)

  return chain ? { home: root, dir: real, chain } : null
}

/** The same folders, one by one, as when the place was recorded. */
function stillThere(place: Place): boolean {
  const now = folderChain(place.home, place.dir)

  return now !== null && now.length === place.chain.length && now.every((id, index) => id === place.chain[index])
}

/** Our temp files: `.<name>.<pid>.<12 hex>.tmp` next to the file they publish. */
const TEMP_RE = /^\.(.+)\.([0-9]{1,10})\.[0-9a-f]{12}\.tmp$/
/** A temp file of another process older than this is a leftover (a pass takes milliseconds). */
const TEMP_STALE_MS = 10 * 60 * 1000

/** Removes `file` only while it is still the entry `id` (a name that now resolves to something else is left alone). */
function removeIfOurs(file: string, id: null | string): void {
  try {
    if (id !== null && entryId(file) === id) {
      fs.rmSync(file, { force: true })
    }
  } catch {
    // gone already, or not ours to remove
  }
}

/**
 * Writes `text` as `<place.dir>/<name>` so that no byte ever lands outside the Hermes home, even when a folder on the
 * way is swapped for a link between the check and the write (fix m-r3-1). Node has no `openat` (and no `O_TMPFILE`),
 * so this is the open-then-verify-by-inode equivalent of a no-follow directory descriptor:
 *   1. the folders are checked one by one from the home down by identity right before the temp file is created
 *      exclusively next to the target (`O_EXCL|O_NOFOLLOW`: no link is ever followed or replaced at the last step);
 *   2. right after the create, before anything else, where the folder resolves NOW is read; then the temp file is
 *      proven to be the entry in the SAME folders: the text is then written through that descriptor, which no later
 *      swap can redirect. If the create landed anywhere else, that empty file is removed where it landed;
 *   3. right before publishing, the folders, the temp entry and (for an edit) the file being replaced are checked
 *      again; then a `rename` (edit, atomic) or a `link` (create, exclusive) publishes it.
 * A swap after (3) makes the publish miss (our temp name is not in the swapped folder): our bytes stay inside. A file
 * planted under our temp name there would be moved instead (its planter's own bytes); our bytes could follow only if
 * the swap lands between the two lookups inside that one system call (security_review.md, residual R-J1).
 * Every exit path removes our temp file wherever we last saw it. What no user-space check can rule out (R-J1 (d)): a
 * swap that lands between the check in (1) and the create, and is undone before the read in (2), leaves one EMPTY file
 * under our temp name in the folder the link pointed to; a swap undone mid-write can leave one inside. Neither holds a
 * byte of ours; the next pass sweeps leftovers inside the home (`sweepTemps`).
 * `moved`: a folder changed (the caller reports the profile unprotected). `changed`: the edited file was replaced
 * meanwhile (left to the next pass). `exists`: a create found a file there.
 */
function writeInside(
  place: Place,
  name: string,
  text: string,
  options: { mode: number; replacing: null | string; seam: Seam }
): 'changed' | 'exists' | 'failed' | 'moved' | 'written' {
  const target = path.join(place.dir, name)
  const tempName = `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const temp = path.join(place.dir, tempName)
  const failed = () => (stillThere(place) ? 'failed' : 'moved')

  options.seam?.('placed', temp)

  // (1) The temp file is created only in the folders as recorded: a swap made before this point creates nothing.
  if (!stillThere(place)) {
    return 'moved'
  }

  let fd: number

  try {
    fd = fs.openSync(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, options.mode)
  } catch {
    return failed()
  }

  // (2) Where the create landed, read before anything else can run: the folder as it resolves now.
  const landedIn = realOrNull(place.dir)
  const landed = landedIn === null ? null : path.join(landedIn, tempName)
  let own: null | string = null

  try {
    try {
      const stat = fs.fstatSync(fd)

      own = `${stat.dev}:${stat.ino}`

      // The re-check (2): this descriptor is the temp entry in the recorded folders, or nothing is written at all.
      if (landedIn !== place.dir || !stillThere(place) || entryId(temp) !== own) {
        return 'moved'
      }

      fs.writeFileSync(fd, text)
      fs.fchmodSync(fd, options.mode)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }

    options.seam?.('staged', temp)

    // The re-check (3), right before the publish.
    if (!stillThere(place) || entryId(temp) !== own) {
      return 'moved'
    }

    if (options.replacing !== null && entryId(target) !== options.replacing) {
      return 'changed'
    }

    if (options.replacing === null) {
      try {
        fs.linkSync(temp, target)
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : failed()
      }
    } else {
      fs.renameSync(temp, target)
    }

    syncFolder(place.dir)

    return 'written'
  } catch {
    return failed()
  } finally {
    // Ours only: an entry under that name that is not our temp file (a swap, a plant) is never removed. Both places we
    // saw it: where the create landed, and the name in the recorded folder.
    if (landed !== null && landed !== temp) {
      removeIfOurs(landed, own)
    }

    removeIfOurs(temp, own)
  }
}

/**
 * Leftover temp files of ours in a folder the pass just placed inside the home (a swap undone mid-write can leave one,
 * R-J1 (d)): this process's from an earlier pass, or another process's older than `TEMP_STALE_MS`. Only regular files,
 * single-linked, owned by this user, and only while the folder is still the one placed.
 */
function sweepTemps(place: Place): number {
  let names: string[]

  try {
    names = fs.readdirSync(place.dir)
  } catch {
    return 0
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  let swept = 0

  for (const entry of names) {
    const match = TEMP_RE.exec(entry)

    if (!match) {
      continue
    }

    const file = path.join(place.dir, entry)

    try {
      const stat = fs.lstatSync(file)
      const stale = Number(match[2]) === process.pid || Date.now() - stat.mtimeMs > TEMP_STALE_MS

      if (!stat.isFile() || stat.nlink !== 1 || (uid !== null && stat.uid !== uid) || !stale || !stillThere(place)) {
        continue
      }

      removeIfOurs(file, `${stat.dev}:${stat.ino}`)
      swept += 1
    } catch {
      // gone meanwhile
    }
  }

  return swept
}

/** Best effort: the folder's entry for the published file reaches the disk (as `writeFileAtomicSync` does). */
function syncFolder(dir: string): void {
  let fd: null | number = null

  try {
    fd = fs.openSync(dir, O_RDONLY)
    fs.fsyncSync(fd)
  } catch {
    // not every platform can fsync a folder
  } finally {
    if (fd !== null) {
      fs.closeSync(fd)
    }
  }
}

/** True when `configFile` is a link whose target is not a file inside `home` (a dangling link counts: nothing is ever
 *  created through a link). Hermes would read that file, so it cannot be protected from here. */
function linksOutside(configFile: string, home: null | string): boolean {
  try {
    if (!fs.lstatSync(configFile).isSymbolicLink()) {
      return false
    }
  } catch {
    return false
  }

  const real = realOrNull(configFile)

  return home === null || real === null || !isInside(home, real)
}

/** The runtime's config template, as `install.sh --stage config` reads it: `$INSTALL_DIR/cli-config.yaml.example`, the
 *  installer's `--dir` being the active Hermes root (`bootstrap-runner` `buildPosixPinArgs`). The one source: no copy. */
export const installerConfigTemplate = (activeRoot: string): string => path.join(activeRoot, 'cli-config.yaml.example')

const TEMPLATE_MAX_BYTES = 1024 * 1024

/** The template's text, or null when there is no readable regular file of a sane size there yet. */
function readTemplate(file: string): null | string {
  try {
    const stat = fs.statSync(file)

    return stat.isFile() && stat.size <= TEMPLATE_MAX_BYTES ? fs.readFileSync(file, 'utf8') : null
  } catch {
    return null
  }
}

/** What a missing config is created with now, or why it is not created this pass. */
function createdText(target: SeedTarget, names: readonly string[]): { text: string } | { wait: string } {
  const template = target.template ? readTemplate(target.template) : null

  if (template !== null) {
    let next: null | string = template

    for (const name of names) {
      next = next === null ? null : withDisabledSkill(next, name)
    }

    if (next !== null) {
      return { text: next }
    }

    // A template whose skills block this edit does not understand is treated as no template: never guessed at.
  }

  return target.withoutTemplate === 'wait'
    ? { wait: 'no config yet: the installer writes its template first' }
    : { text: minimalConfig(names) }
}

/**
 * Edits an EXISTING config in place with `edit` (its text -> the new text, or why the shape is not understood), under
 * the seed's rules (fix m-r3-1): the file is resolved now and written only where it really lives inside `bound` (the
 * resolved Hermes home; null: never written; undefined: the single-config API, its own folder), read through a
 * descriptor that follows no link at the last step, published atomically with its own mode, and never over a file that
 * was replaced meanwhile. Returns null when the file now holds the edit (or already did), else why nothing was written.
 * Shared by the payment-skill seed and the display-language pass (iclone-display-language.ts, review r2 R2-M5).
 */
export function editConfigInside(
  configFile: string,
  bound: null | string | undefined,
  edit: (text: string) => string | { skip: string },
  options: { here?: null | Place; seam?: Seam } = {}
): null | string {
  const { seam } = options
  const placeIn = (folder: string): null | Place => (bound === null ? null : placeOf(bound ?? null, folder))
  let real: string
  let place: null | Place
  let text: string
  let mode: number
  let readId: string

  try {
    // Edit the file itself (a linked config is written where it lives, with its own mode).
    real = fs.realpathSync.native(configFile)
  } catch {
    return 'config.yaml could not be read'
  }

  // The re-check: the target as resolved NOW is the one written, so a link swapped since the check above is never
  // followed out of the home; and every folder above it is recorded by identity for `writeInside`.
  if (bound !== undefined && (bound === null || !isInside(bound, real))) {
    return LINKED_OUTSIDE
  }

  place = placeIn(path.dirname(real))

  if (place === null) {
    return MOVED
  }

  if (place.dir !== options.here?.dir) {
    sweepTemps(place)
  }

  seam?.('opening', real)

  try {
    // Read through a descriptor (no link followed at the last step: a config swapped for a link since is never even
    // opened) proven to be the entry in those folders.
    const fd = fs.openSync(real, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)

    try {
      const stat = fs.fstatSync(fd)

      readId = `${stat.dev}:${stat.ino}`

      if (!stat.isFile() || entryId(real) !== readId || !stillThere(place)) {
        place = null
      }

      text = place === null ? '' : fs.readFileSync(fd, 'utf8')
      mode = stat.mode & 0o777
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return 'config.yaml could not be read'
  }

  if (place === null) {
    return MOVED
  }

  const next = edit(text)

  if (typeof next !== 'string') {
    return next.skip
  }

  if (next === text) {
    return null
  }

  const written = writeInside(place, path.basename(real), next, { mode, replacing: readId, seam })

  if (written === 'moved') {
    return MOVED
  }

  if (written === 'changed') {
    return 'config.yaml changed while it was edited: tried again at the next pass'
  }

  return written === 'written' ? null : 'write failed'
}

function seedOne(
  target: SeedTarget,
  names: readonly string[],
  marker: SeedMarker,
  stamp: string,
  seam: Seam
): { result: SeedResult; record: SeedRecord | null; folder?: string } {
  const { configFile } = target
  const dir = path.dirname(configFile)

  const skipped = (reason: string) => ({
    result: { configFile, created: false, seeded: [], kept: [], skipped: reason },
    record: null
  })

  if (target.mayCreateDir) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    } catch {
      return skipped('the Hermes home could not be created')
    }
  }

  const identity = folderIdentity(dir)

  if (identity === null) {
    return skipped('no folder for config.yaml')
  }

  // Never write outside the Hermes home (lead ruling, m-r2-2 follow-up): a config.yaml that is a link out of it is
  // left alone and its profile is reported unprotected, like a profile folder that resolves outside. The bound is the
  // resolved Hermes home (for the root on a first launch, when the home did not exist yet as the targets were listed,
  // the folder just created); null: none (never written); unset (the single-config API): the config's own folder.
  const bound = target.home === null && target.mayCreateDir ? realOrNull(dir) : target.home

  if (bound !== undefined && linksOutside(configFile, bound)) {
    return skipped(LINKED_OUTSIDE)
  }

  seam?.('checked', configFile)

  // Every write below goes through `writeInside`: the folder is resolved and recorded from the home down, and the text
  // only ever enters a file proven to be in those folders (fix m-r3-1).
  const placeIn = (folder: string): null | Place => (bound === null ? null : placeOf(bound ?? null, folder))

  // Leftovers of an earlier pass a swap stranded here (R-J1 (d)) go first.
  const here = placeIn(dir)

  if (here !== null) {
    sweepTemps(here)
  }

  // No config at all: nobody has chosen anything yet, so the shipped default is written now, before any session
  // reads the file (Hermes reads a missing config as "no skill disabled"): the installer's template with the block, or
  // the block alone (see the header for when the root waits for the installer instead). Exclusive create: a config
  // that appears meanwhile is the user's (or Hermes' or the installer's) and is edited below, never replaced.
  if (!fs.existsSync(configFile)) {
    const initial = createdText(target, names)

    if ('wait' in initial) {
      return skipped(initial.wait)
    }

    const place = placeIn(path.dirname(configFile))

    if (place === null) {
      return skipped(MOVED)
    }

    const created = writeInside(place, path.basename(configFile), initial.text, { mode: 0o600, replacing: null, seam })

    if (created === 'written') {
      return {
        result: { configFile, created: true, seeded: [...names], kept: [], skipped: null },
        record: { dir: identity, skills: Object.fromEntries(names.map(name => [name, stamp])) },
        folder: identity
      }
    }

    if (created === 'moved') {
      return skipped(MOVED)
    }

    if (created !== 'exists') {
      return skipped('config.yaml could not be created')
    }
  }

  const previous = marker[configFile]
  const recorded = previous && previous.dir === identity ? previous.skills : {}
  const due = names.filter(name => !Object.prototype.hasOwnProperty.call(recorded, name))

  if (due.length === 0) {
    // Already decided for this folder: still a readable regular file, or Hermes would read it as no skill disabled.
    try {
      if (!fs.statSync(configFile).isFile()) {
        return skipped('config.yaml could not be read')
      }

      fs.accessSync(configFile, fs.constants.R_OK)
    } catch {
      return skipped('config.yaml could not be read')
    }

    return {
      result: { configFile, created: false, seeded: [], kept: [...names], skipped: null },
      record: null,
      folder: identity
    }
  }

  const seeded: string[] = []
  const kept: string[] = []

  const edited = editConfigInside(
    configFile,
    bound,
    text => {
      let next = text

      for (const name of due) {
        const withName = withDisabledSkill(next, name)

        if (withName === null) {
          return { skip: `config.yaml skills block not understood (${name})` }
        }

        ;(withName === next ? kept : seeded).push(name)
        next = withName
      }

      return next
    },
    { here, seam }
  )

  if (edited !== null) {
    return skipped(edited)
  }

  return {
    result: { configFile, created: false, seeded, kept, skipped: null },
    record: { dir: identity, skills: { ...recorded, ...Object.fromEntries(due.map(name => [name, stamp])) } },
    folder: identity
  }
}

function seedTargets(
  targets: readonly SeedTarget[],
  options: { markerFile: string; names?: readonly string[]; now?: () => Date; root?: SeedTarget; seam?: Seam }
): { configs: SeedResult[]; markerError: string | null; folders: (null | string)[] } {
  const names = options.names ?? SHIPPED_DISABLED
  const stamp = (options.now ?? (() => new Date()))().toISOString()
  const root = options.root ?? null

  const marker = readMarker(
    options.markerFile,
    root?.configFile ?? null,
    root ? folderIdentity(path.dirname(root.configFile)) : null
  )

  const configs: SeedResult[] = []
  // The folder each config was verified in (`dev:ino` as recorded before the write), null when it was skipped.
  const folders: (null | string)[] = []
  let changed = false

  for (const target of targets) {
    let outcome: ReturnType<typeof seedOne>

    try {
      outcome = seedOne(target, names, marker, stamp, options.seam)
    } catch {
      // Any error is a config this pass could not verify (fix m-r4-2: fail closed).
      outcome = {
        result: { configFile: target.configFile, created: false, seeded: [], kept: [], skipped: 'error' },
        record: null
      }
    }

    const { result, record, folder } = outcome

    configs.push(result)
    folders.push(result.skipped === null ? (folder ?? null) : null)

    if (record) {
      marker[target.configFile] = record
      changed = true
    }
  }

  if (!changed) {
    return { configs, markerError: null, folders }
  }

  try {
    writeMarker(options.markerFile, marker)

    return { configs, markerError: null, folders }
  } catch {
    // The configs are seeded (the safe half); without the record a skill the user turns on later may be turned off
    // again at the next pass, never the other way round.
    return { configs, markerError: 'marker write failed', folders }
  }
}

/** One config file (its folder must exist): `names` into `skills.disabled`, recorded in `markerFile` (0600). Never throws. */
export function seedShippedDisabled(options: {
  configFile: string
  markerFile: string
  names?: readonly string[]
  now?: () => Date
}): SeedResult {
  const target = { configFile: options.configFile, mayCreateDir: false }

  return seedTargets([target], { ...options, root: target }).configs[0]
}

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

// The on-disk spelling (macOS `realpath(3)`: the case each folder was created with), so names compare as stored.
const realOrNull = (file: string): null | string => {
  try {
    return fs.realpathSync.native(file)
  } catch {
    return null
  }
}

/** `inner` is `outer` itself or below it (both already resolved). */
function isInside(outer: string, inner: string): boolean {
  const rel = path.relative(outer, inner)

  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** `inner` is inside `outer` by name (both resolved to their on-disk spelling, compared case-folded) AND by identity
 *  (one of `inner`'s folders, itself included, is the `outer` folder): neither a case-insensitive file system nor a
 *  case-sensitive one can make an outside folder pass (fix m-r4-2). */
function insideHome(outer: string, outerId: null | string, inner: string): boolean {
  if (outerId === null || !isInside(outer.toLowerCase(), inner.toLowerCase())) {
    return false
  }

  for (let at = inner; ; at = path.dirname(at)) {
    if (folderIdentity(at) === outerId) {
      return true
    }

    if (path.dirname(at) === at) {
      return false
    }
  }
}

/** The profile names two or more folder names fold to (`Away` and `away` on a case-sensitive file system): Hermes
 *  lower-cases the name it looks for, so which folder it runs cannot be told from here (fix m-r4-2). */
export function foldedCollisions(names: readonly string[]): Set<string> {
  const counts = new Map<string, number>()

  for (const name of names) {
    counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) ?? 0) + 1)
  }

  return new Set([...counts].filter(([, count]) => count > 1).map(([slug]) => slug))
}

// `hermes_cli/profiles.py _RESERVED_NAMES`: names Hermes never runs as a profile (`default` is the root's alias).
const RESERVED_PROFILE_NAMES = new Set(['hermes', 'default', 'test', 'tmp', 'root', 'sudo'])

/**
 * The root home's config and every Hermes profile's (`profiles/<name>/`). Hermes' `list_profiles` follows links
 * (`Path.is_dir`), so a profile folder that is a link is a live profile too (fix m-r2-2). Hermes has no per-spawn
 * switch for a disabled skill (it reads `skills.disabled` from the config file only), so the seed follows the link: a
 * profile whose folder resolves INSIDE the Hermes home is seeded where it really lives; one that resolves outside it is
 * never written. A link to nothing (or to a file) is not a profile to Hermes either and is skipped.
 *
 * Fail closed (fix m-r4-2): Hermes lower-cases a profile name before it looks for the folder, so on a case-insensitive
 * file system `profiles/Away` IS profile `away`. A folder whose name is not already its lower-case profile name, and
 * two folders that fold to one name, are never written: that profile is `undecided` and can only be reported
 * unprotected. `profiles` lists every profile Hermes could run from here, for the status.
 */
function hermesConfigTargets(
  hermesHome: string,
  root: Pick<SeedTarget, 'template' | 'withoutTemplate'>
): { targets: SeedTarget[]; profiles: Set<string>; undecided: Set<string> } {
  const home = realOrNull(hermesHome)
  const homeId = home === null ? null : folderIdentity(home)

  const targets: SeedTarget[] = [
    { configFile: path.join(hermesHome, 'config.yaml'), mayCreateDir: true, ...root, home, slug: 'default' }
  ]

  const profiles = new Set<string>(['default'])
  const undecided = new Set<string>()
  const profilesDir = path.join(hermesHome, 'profiles')
  let entries: fs.Dirent[] = []

  try {
    entries = fs.readdirSync(profilesDir, { withFileTypes: true })
  } catch {
    return { targets, profiles, undecided }
  }

  // The root config is already a target: a profile linked to the home itself is that config, not a second one.
  const seen = new Map<string, SeedTarget>(home === null ? [] : [[home, targets[0]]])
  const named: string[] = []

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const slug = entry.name.toLowerCase()

    if (!PROFILE_NAME_RE.test(slug) || RESERVED_PROFILE_NAMES.has(slug)) {
      continue
    }

    if (!(entry.isDirectory() || entry.isSymbolicLink())) {
      continue
    }

    const folder = realOrNull(path.join(profilesDir, entry.name))

    if (folder === null || folderIdentity(folder) === null) {
      continue
    }

    profiles.add(slug)
    named.push(entry.name)

    if (entry.name !== slug) {
      undecided.add(slug)

      continue
    }

    if (home === null || !insideHome(home, homeId, folder)) {
      continue
    }

    // Through a link the config is the target's own; two names for one folder are one config.
    const configFile = entry.isDirectory()
      ? path.join(profilesDir, entry.name, 'config.yaml')
      : path.join(folder, 'config.yaml')

    const same = seen.get(folder)

    if (same) {
      same.aliases = [...(same.aliases ?? []), slug]
    } else {
      const target: SeedTarget = { configFile, mayCreateDir: false, home, slug }

      seen.set(folder, target)
      targets.push(target)
    }
  }

  for (const slug of foldedCollisions(named)) {
    undecided.add(slug)
  }

  return { targets, profiles, undecided }
}

/**
 * Every existing config.yaml Hermes runs a LOCAL profile from (the root home's and each profile's, by the same rules as
 * the seed: links followed only inside the home, folded or colliding names never written), with the resolved home each
 * may be written inside. Missing configs are not listed: there is nothing in them to edit.
 */
export function hermesProfileConfigs(hermesHome: string): { configFile: string; home: null | string; slug: string }[] {
  return hermesConfigTargets(hermesHome, { template: null, withoutTemplate: 'wait' })
    .targets.filter(target => fs.existsSync(target.configFile))
    .map(target => ({ configFile: target.configFile, home: target.home ?? null, slug: target.slug ?? 'default' }))
}

/**
 * Every config Hermes reads skills from — the root home's and each profile's — gets the shipped-disabled names: a
 * missing config is created (the root's from the installer's `template` when it is there; otherwise the bare block,
 * or, with `rootWithoutTemplate: 'wait'`, left to the installer), an existing one is edited once per skill and per
 * config folder. Run at launch, before every Hermes spawn (`create`) and when a profile appears. Never throws.
 */
export function seedAllShippedDisabled(options: {
  hermesHome: string
  markerFile: string
  names?: readonly string[]
  now?: () => Date
  /** The installer's config template (`installerConfigTemplate(activeRoot)`). */
  template?: null | string
  /** A missing root config with no template to read: created as the bare block (default) or left to the installer. */
  rootWithoutTemplate?: 'create' | 'wait'
  /** Tests only: runs at each check→write seam (`WriteSeam`) with the file about to be touched. */
  seam?: (at: WriteSeam, file: string) => void
}): {
  configs: SeedResult[]
  markerError: string | null
  unprotected: string[]
  /** Each profile this pass verified (its config seeded or already kept) → the identity (`dev:ino`) of the folder Hermes
   *  runs it in: the only profiles the pay socket mints for (fix m-r4-1). */
  verified: Record<string, string>
} {
  const { targets, profiles, undecided } = hermesConfigTargets(options.hermesHome, {
    template: options.template ?? null,
    withoutTemplate: options.rootWithoutTemplate ?? 'create'
  })

  const seeded = seedTargets(targets, { ...options, root: targets[0] })

  // Fail closed (fix m-r4-2): a profile is protected only when THIS pass verified its config — seeded, created, or
  // already holding the names — in a folder inside the home. Everything else Hermes could run is unprotected: a
  // folder or config.yaml outside the home, folders that moved during the write (fix m-r3-1), a config that could not
  // be read, created or written (a read-only folder, a path too long for the temp file, any error), a name that is
  // not its own lower-case form or that two folders share.
  const verified: Record<string, string> = {}

  targets.forEach((target, index) => {
    const folder = seeded.folders[index]

    if (folder !== null) {
      for (const slug of [target.slug ?? 'default', ...(target.aliases ?? [])]) {
        if (!undecided.has(slug)) {
          verified[slug] = folder
        }
      }
    }
  })

  return {
    configs: seeded.configs,
    markerError: seeded.markerError,
    unprotected: [...profiles].filter(slug => !Object.prototype.hasOwnProperty.call(verified, slug)).sort(),
    verified
  }
}

/**
 * Seeds again whenever a profile folder appears under `<hermesHome>/profiles` (watched once it exists; until then the
 * home is watched for it). Debounced; a watch that cannot start leaves the launch and per-spawn passes. Returns stop.
 */
export function watchHermesProfiles(hermesHome: string, onChange: () => void, debounceMs = 250): () => void {
  const profiles = path.join(hermesHome, 'profiles')
  let watcher: fs.FSWatcher | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const fire = () => {
    if (timer) {
      clearTimeout(timer)
    }

    timer = setTimeout(() => {
      timer = null

      if (!stopped) {
        onChange()
      }
    }, debounceMs)
    timer.unref?.()
  }

  const watch = (dir: string, listener: (name: string | null) => void): fs.FSWatcher | null => {
    try {
      const handle = fs.watch(dir, { persistent: false }, (_event, name) =>
        listener(name === null ? null : String(name))
      )

      handle.on('error', () => undefined)

      return handle
    } catch {
      return null
    }
  }

  let onProfiles = false

  const watchProfiles = (): boolean => {
    const handle = watch(profiles, () => fire())

    if (!handle) {
      return false
    }

    watcher?.close()
    watcher = handle
    onProfiles = true

    return true
  }

  if (!watchProfiles()) {
    watcher = watch(hermesHome, name => {
      if (!onProfiles && (name === null || name === 'profiles') && watchProfiles()) {
        fire()
      }
    })
  }

  // A watch takes a moment to arm: one pass after it did covers a folder that appeared meanwhile.
  fire()

  return () => {
    stopped = true
    watcher?.close()

    if (timer) {
      clearTimeout(timer)
    }
  }
}

/** Where the marker lives: next to the other payments files (`userData/payments/`). */
export const skillsSeedMarker = (paymentsDir: string): string => path.join(paymentsDir, 'skills-seeded.json')
