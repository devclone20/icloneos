/**
 * v0.0.9 F3 — the repair kit ("Fix tools") that repairs by known classes.
 *
 * Contract for every class (P0_REPAIR_KIT.md §4, PLANO_V009.md §F3):
 *   detect → plan → (real run only, on the owner's click, checked by ipc.ts) stop the agent → back up DATED → move
 *   aside, never delete → report each step → re-check → manifest under `<userData>/diagnostics/repair-kit/<stamp>-<class>/`
 *   → undo replays the manifest backwards, never over something that changed since.
 * A dry run plans and touches nothing. A step that fails rolls back the steps before it.
 *
 * Every path, process probe and side effect outside the file system comes in through `RepairKitDeps`, so the tests
 * drive the real file-system code against a throwaway HOME.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { BootCause } from '../boot-cause'
import { EXPECTED_ICLONE_PLUGINS } from '../iclone-hermes-plugins'
import { writeFileAtomicSync } from '../lib/atomic-write'
import { dependencyHomeRoot, runtimeInstallKey as pmInstallKey } from '../main/runtime-install-state'
import { pmCommittedVenv } from '../pm-venv'

import {
  type AppliedStep,
  isRepairClassId,
  REPAIR_CLASS_IDS,
  type RepairClassId,
  type RepairFinding,
  type RepairHistoryEntry,
  type RepairManifest,
  type RepairReport,
  type RepairStep,
  type UndoReport
} from './types'

export interface OrphanCandidate {
  pid: number
  command?: string
}

export interface RepairKitDeps {
  /** The root HERMES_HOME the agent is spawned with (main's `HERMES_HOME`; `~/.hermes` only by default). */
  hermesHome: string
  /** v0.0.9 W1b: the HERMES_HOME of the profile the agent runs as (`<root>/profiles/<slug>` under `--profile`), read
   *  at every scan (active-home.ts). Absent = the root. The stale-install class looks where THAT agent keeps state. */
  activeHermesHome?(): string
  /** v0.0.9 W1b: the user's home directory (`app.getPath('home')`): its `.hermes` is the runtime's platform-default
   *  dependency root (main/runtime-install-state.ts). Absent = the root HERMES_HOME stands in for it. */
  home?: string
  /** The app's data folder (`~/Library/Application Support/iclone os`). */
  userData: string
  /** The runtime the app runs (ACTIVE_HERMES_ROOT); null when there is none yet. */
  runtimeRoot: string | null
  /** The runtime's private dependency home (`<runtime>/.iclone-deps/hermes`); null in the dev (shared) layout. */
  privateHermesHome: string | null
  /** This user's uid (null where there is none). */
  uid: number | null
  now(): Date
  appVersion?: string
  /** The cause of the failure main has latched, read before anything resets it. */
  bootCause(): BootCause | null
  orphans: {
    /** Backends from this app's OWN pid records whose app process is gone (never a pattern match). */
    list(): Promise<OrphanCandidate[]>
    /** Stops those records' processes after proving each identity (backend-ownership.ts reapOrphans). */
    reap(): Promise<number[]>
  }
  /** True when something answers on the socket file. */
  socketAlive(file: string): Promise<boolean>
  /** The next start reinstalls the runtime (the existing installer path). */
  requestReinstall(): void
  /** Stops the agent this app runs, and waits for it to exit. */
  stopAgent(): Promise<void>
  log(line: string): void
}

export interface RepairKit {
  scan(): Promise<RepairFinding[]>
  detect(classId: RepairClassId): Promise<{ finding: RepairFinding; steps: RepairStep[] }>
  apply(classId: RepairClassId, options: { dryRun: boolean }): Promise<RepairReport>
  undo(manifestId: string): Promise<UndoReport>
  history(): RepairHistoryEntry[]
  manifestsRoot: string
}

const KIT_TAG = '[repair-kit]'
const MANIFEST_FILE = 'manifest.json'
const MANIFEST_ID = /^\d{8}-\d{6}-\d{3}-[a-z-]{4,40}(?:-\d{1,3})?$/
const PRIVATE_DIR = 0o700
const PRIVATE_FILE = 0o600

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

/** The owner's local date, the way he named the 14 Nov folder by hand: `installs-aside-2026-11-14`. */
export function asideDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function stamp(date: Date): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`
  )
}

/** PM's install key for a runtime root (pm/environments.py): the ONE definition is F2's
 * main/runtime-install-state.ts `runtimeInstallKey`; null for no root or one that cannot be resolved. */
export function runtimeInstallKey(root: string | null): string | null {
  if (!root) {
    return null
  }

  try {
    return pmInstallKey(root)
  } catch {
    return null
  }
}

function lstat(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file)
  } catch {
    return null
  }
}

function exists(file: string): boolean {
  return lstat(file) !== null
}

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

function sameDir(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p)
    } catch {
      return path.resolve(p)
    }
  }

  return real(a) === real(b)
}

/** `child` is `parent` or inside it (lexically, after resolving both). */
function within(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))

  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** `file` with every link in its existing ancestors resolved (the nearest existing folder's realpath + the rest). */
function realLocation(file: string): string {
  const rest: string[] = []
  let at = path.resolve(file)

  for (;;) {
    try {
      return path.join(fs.realpathSync(at), ...rest)
    } catch {
      const parent = path.dirname(at)

      if (parent === at) {
        return path.resolve(file)
      }

      rest.unshift(path.basename(at))
      at = parent
    }
  }
}

/** `<parent>/<base>-aside-<date>/<name>`, made unique with `-2`, `-3`… so nothing already aside is ever overwritten. */
function asideTarget(parent: string, base: string, name: string, date: Date): string {
  const root = path.join(parent, `${base}-aside-${asideDate(date)}`)

  for (let n = 1; ; n += 1) {
    const candidate = path.join(root, n === 1 ? name : `${name}-${n}`)

    if (!exists(candidate)) {
      return candidate
    }
  }
}

// ── plugins.disabled: a line-level edit that keeps the owner's YAML as written ─────────────────────────────────────

export interface DisabledList {
  names: string[]
  /** The text with `remove` taken out of the list (null when the list's form is not one the kit edits). */
  edit(remove: readonly string[]): string | null
}

const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, '$2')

/**
 * `plugins:` → `disabled:` in the forms Hermes writes (block list `- name`, flow list `[a, b]`). Null when the file has
 * no such list. Anything else (anchors, multi-line flow) parses as `names` with `edit` → null: reported, not touched.
 */
export function parsePluginsDisabled(text: string): DisabledList | null {
  const lines = text.split('\n')
  const pluginsAt = lines.findIndex(line => /^plugins:\s*(?:#.*)?$/.test(line))

  if (pluginsAt === -1) {
    return null
  }

  let disabledAt = -1
  let disabledIndent = 0

  for (let i = pluginsAt + 1; i < lines.length; i += 1) {
    const line = lines[i]

    if (/^\S/.test(line) && !line.startsWith('#')) {
      break // the next top-level key
    }

    const match = /^(\s+)disabled:(.*)$/.exec(line)

    if (match) {
      disabledAt = i
      disabledIndent = match[1].length

      break
    }
  }

  if (disabledAt === -1) {
    return null
  }

  const rest = lines[disabledAt].slice(lines[disabledAt].indexOf('disabled:') + 'disabled:'.length).replace(/\s+#.*$/, '').trim()
  const prefix = lines[disabledAt].slice(0, lines[disabledAt].indexOf('disabled:') + 'disabled:'.length)

  if (rest.startsWith('[')) {
    if (!rest.endsWith(']')) {
      return { names: [], edit: () => null }
    }

    const names = rest
      .slice(1, -1)
      .split(',')
      .map(unquote)
      .filter(Boolean)

    return {
      names,
      edit: remove => {
        const kept = names.filter(name => !remove.includes(name))
        const next = [...lines]
        next[disabledAt] = `${prefix} [${kept.join(', ')}]`

        return next.join('\n')
      }
    }
  }

  if (rest && rest !== '') {
    return { names: [], edit: () => null } // a scalar or an anchor: not a list the kit edits
  }

  const items: { at: number; name: string }[] = []

  for (let i = disabledAt + 1; i < lines.length; i += 1) {
    const match = /^(\s*)-\s+(.+?)\s*(?:#.*)?$/.exec(lines[i])

    if (match && match[1].length >= disabledIndent) {
      items.push({ at: i, name: unquote(match[2]) })

      continue
    }

    if (lines[i].trim() === '') {
      continue
    }

    break
  }

  return {
    names: items.map(item => item.name),
    edit: remove => {
      const drop = new Set(items.filter(item => remove.includes(item.name)).map(item => item.at))
      const next = lines.filter((_, i) => !drop.has(i))

      if (drop.size === items.length && items.length > 0) {
        // Every item went: an empty list, not a null key. Every dropped item sits AFTER `disabledAt`, so the key keeps
        // its index (security m2: searching by text found an earlier identical `disabled:` line of another section).
        next[disabledAt] = `${prefix} []`
      }

      return next.join('\n')
    }
  }
}

// ── the kit ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export function createRepairKit(deps: RepairKitDeps): RepairKit {
  const manifestsRoot = path.join(deps.userData, 'diagnostics', 'repair-kit')
  let busy = false

  /**
   * v0.0.9 Q (tests-perf 6): the only folders a step may touch, resolved through links: the app's homes (HERMES_HOME,
   * the active profile's, the platform default `~/.hermes` and its dependency root), the private dependency home,
   * the runtime and userData. Checked on apply AND on undo (a manifest is data on disk, not proof).
   */
  const allowedRoots = (): string[] => {
    const active = deps.activeHermesHome?.() ?? deps.hermesHome
    const platformDefault = deps.home ? path.join(deps.home, '.hermes') : deps.hermesHome
    const roots = [
      deps.hermesHome,
      deps.userData,
      active,
      platformDefault,
      dependencyHomeRoot(active, platformDefault),
      deps.privateHermesHome,
      deps.runtimeRoot
    ].filter((root): root is string => typeof root === 'string' && root !== '')

    return [...new Set(roots.map(realLocation))]
  }

  /**
   * True when `file` (its parent resolved through links; the name itself is not followed) sits inside an allowed root.
   * `self` also refuses a link AT that path (chmod follows links). A step naming anything else is refused.
   */
  const contained = (file: unknown, self = false): boolean => {
    if (typeof file !== 'string' || !path.isAbsolute(file)) {
      return false
    }

    if (self && lstat(file)?.isSymbolicLink()) {
      return false
    }

    const where = path.join(realLocation(path.dirname(file)), path.basename(file))

    return allowedRoots().some(root => within(where, root))
  }

  /** Every path one step names is inside the homes (and an edit's backup inside the kit's own manifests). */
  const stepContained = (step: RepairStep, backup?: string): boolean => {
    switch (step.kind) {
      case 'move-aside':
        return contained(step.from) && contained(step.to)

      case 'chmod':
        return contained(step.path, true)

      case 'edit-config':
        return (
          contained(step.file, true) &&
          (backup === undefined || (typeof backup === 'string' && within(realLocation(backup), realLocation(manifestsRoot))))
        )

      default:
        return true
    }
  }

  const finding = (classId: RepairClassId, status: RepairFinding['status'], facts: string[] = []): RepairFinding => ({
    classId,
    facts,
    status
  })

  const configFiles = (): string[] => {
    const files = [path.join(deps.hermesHome, 'config.yaml')]
    const profiles = path.join(deps.hermesHome, 'profiles')

    try {
      for (const entry of fs.readdirSync(profiles, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          files.push(path.join(profiles, entry.name, 'config.yaml'))
        }
      }
    } catch {
      // No profiles.
    }

    return files.filter(file => lstat(file)?.isFile() === true)
  }

  // 1 · stale-install-record (14 Nov 2026)
  const detectStaleRecord = () => {
    const id: RepairClassId = 'stale-install-record'
    const key = runtimeInstallKey(deps.runtimeRoot)

    // Dev layout: the runtime's own record lives in HERMES_HOME; it is not stale, it is the record.
    if (!deps.privateHermesHome || !key || sameDir(deps.privateHermesHome, deps.hermesHome)) {
      return { finding: finding(id, 'skipped'), steps: [] }
    }

    // v0.0.9 W1b: where the runtime would adopt a dependency selection for THIS agent — the dependency root of the
    // ACTIVE profile's HERMES_HOME and the platform default root (the runtime's own two candidates). Each record is
    // moved beside its own `installs` folder: `<that home>/installs-aside-<YYYY-MM-DD>/<key>` (same volume: a rename).
    const records = staleInstallRecords(key)

    if (records.length === 0) {
      return { finding: finding(id, 'ok'), steps: [] }
    }

    const steps: RepairStep[] = records.map(record => ({
      kind: 'move-aside',
      from: record,
      to: asideTarget(path.dirname(path.dirname(record)), 'installs', key, deps.now())
    }))

    return { finding: finding(id, 'found', records), steps }
  }

  /** `<root>/installs/<key>` holding a `facts.json`, for each dependency root the active agent's runtime reads. */
  const staleInstallRecords = (key: string): string[] => {
    const active = deps.activeHermesHome?.() ?? deps.hermesHome
    // The runtime's own two candidates (main/runtime-install-state.ts, the boot's hint uses the same): the dependency
    // root of the active HERMES_HOME, then the platform default `~/.hermes` (the root HERMES_HOME with no home known).
    const platformDefault = deps.home ? path.join(deps.home, '.hermes') : deps.hermesHome
    const roots = [...new Set([dependencyHomeRoot(active, platformDefault), platformDefault])]

    return roots
      .map(root => path.join(root, 'installs', key))
      .filter(record => !(deps.privateHermesHome && within(record, deps.privateHermesHome)))
      .filter(record => lstat(record)?.isDirectory() === true && lstat(path.join(record, 'facts.json'))?.isFile())
  }

  // 2 · runtime-venv
  const detectRuntimeVenv = () => {
    const id: RepairClassId = 'runtime-venv'
    const key = runtimeInstallKey(deps.runtimeRoot)

    if (!deps.privateHermesHome || !key || !deps.runtimeRoot) {
      return { finding: finding(id, 'skipped'), steps: [] }
    }

    const install = path.join(deps.privateHermesHome, 'installs', key)
    const factsFile = path.join(install, 'facts.json')
    const facts: string[] = []
    // Other runtimes beside this one (older releases): listed, never moved by this class.
    const runtimesDir = path.dirname(deps.runtimeRoot)

    try {
      for (const name of fs.readdirSync(runtimesDir)) {
        if (name !== path.basename(deps.runtimeRoot) && !name.startsWith('.')) {
          facts.push(`other runtime: ${path.join(runtimesDir, name)}`)
        }
      }
    } catch {
      // No runtimes folder.
    }

    if (!exists(factsFile)) {
      return { finding: finding(id, 'ok', facts), steps: [] }
    }

    let broken: string | null = null

    try {
      JSON.parse(fs.readFileSync(factsFile, 'utf8'))
    } catch {
      broken = `${factsFile} cannot be read`
    }

    const venv = broken ? null : pmCommittedVenv(deps.runtimeRoot, deps.privateHermesHome)

    if (!broken && !venv) {
      broken = `${factsFile} names no usable environment`
    }

    if (venv && !broken) {
      try {
        const cfg = fs.readFileSync(path.join(venv, 'pyvenv.cfg'), 'utf8')
        const home = /^home\s*=\s*(.+)$/m.exec(cfg)?.[1]?.trim()

        if (!home || !exists(home)) {
          broken = `${path.join(venv, 'pyvenv.cfg')}: its interpreter home ${home ?? '(none)'} is gone`
        }

        fs.realpathSync(path.join(venv, 'bin', 'python'))
      } catch (error) {
        broken ??= `${venv}: ${(error as Error).message}`
      }
    }

    if (!broken) {
      return { finding: finding(id, 'ok', facts), steps: [] }
    }

    const to = asideTarget(deps.privateHermesHome, 'installs', key, deps.now())

    return {
      finding: finding(id, 'found', [broken, ...facts]),
      steps: [{ kind: 'move-aside', from: install, to } satisfies RepairStep, { kind: 'reinstall-runtime' } satisfies RepairStep]
    }
  }

  // 3 · plugins-disabled
  const detectPluginsDisabled = () => {
    const id: RepairClassId = 'plugins-disabled'
    const steps: RepairStep[] = []
    const facts: string[] = []
    let manual = false

    for (const file of configFiles()) {
      let text: string

      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }

      const list = parsePluginsDisabled(text)
      const ours = list?.names.filter(name => EXPECTED_ICLONE_PLUGINS.includes(name)) ?? []

      if (!list || ours.length === 0) {
        continue
      }

      const nextText = list.edit(ours)

      if (nextText === null) {
        manual = true
        facts.push(`${file}: plugins.disabled lists ${ours.join(', ')} in a form the kit does not edit`)

        continue
      }

      facts.push(`${file}: plugins.disabled lists ${ours.join(', ')}`)
      steps.push({ kind: 'edit-config', file, nextText, preSha256: sha256(text), remove: ours })
    }

    return {
      finding: finding(id, steps.length ? 'found' : manual ? 'manual' : 'ok', facts),
      steps
    }
  }

  // 4 · root-permissions
  const detectRoots = () => {
    const id: RepairClassId = 'root-permissions'
    const steps: RepairStep[] = []
    const facts: string[] = []
    let manual = false

    const roots = [
      deps.hermesHome,
      deps.userData,
      ...(deps.runtimeRoot ? [deps.runtimeRoot] : []),
      path.join(deps.userData, 'confinement', 'profiles')
    ]

    for (const root of roots) {
      const stat = lstat(root)

      if (!stat) {
        continue
      }

      if (stat.isSymbolicLink()) {
        manual = true
        facts.push(`${root} is a link`)

        continue
      }

      if (deps.uid !== null && stat.uid !== deps.uid) {
        manual = true
        facts.push(`${root} belongs to another user (uid ${stat.uid})`)

        continue
      }

      const mode = stat.mode & 0o7777

      if (mode & 0o022) {
        facts.push(`${root} is writable by others (${mode.toString(8)})`)
        steps.push({ kind: 'chmod', fromMode: mode, path: root, toMode: mode & ~0o022 })
      }
    }

    // The folders the sandbox never lets the agent write: a link there would point the runtime somewhere else.
    for (const name of ['installs', 'plugins', 'tools']) {
      const child = path.join(deps.hermesHome, name)

      if (lstat(child)?.isSymbolicLink()) {
        manual = true
        facts.push(`${child} is a link`)
      }
    }

    return { finding: finding(id, steps.length ? 'found' : manual ? 'manual' : 'ok', facts), steps }
  }

  // 5 · gate-not-starting
  const detectGate = () => {
    const id: RepairClassId = 'gate-not-starting'
    const cause = deps.bootCause()

    if (cause?.code !== 'gate-not-loaded') {
      return { finding: finding(id, 'ok'), steps: [] }
    }

    const plugins = detectPluginsDisabled()
    const facts = [cause.line ?? 'the permission gate refused the last start', ...plugins.finding.facts]

    // The gate's own fix first (the app's plugins switched off in config.yaml); otherwise reinstall the runtime, which
    // puts the gate back with it.
    return {
      finding: finding(id, 'found', facts),
      steps: plugins.steps.length ? plugins.steps : [{ kind: 'reinstall-runtime' } satisfies RepairStep]
    }
  }

  // 6 · port-busy
  const detectPort = async () => {
    const id: RepairClassId = 'port-busy'
    const run = path.join(deps.userData, 'run')
    const steps: RepairStep[] = []
    const facts: string[] = []
    let names: string[] = []

    try {
      names = fs.readdirSync(run)
    } catch {
      // No run folder.
    }

    for (const name of names) {
      const file = path.join(run, name)

      if (!lstat(file)?.isSocket()) {
        continue
      }

      if (!(await deps.socketAlive(file))) {
        facts.push(`${file}: nothing answers (left by an earlier run)`)
        steps.push({ kind: 'move-aside', from: file, to: asideTarget(deps.userData, 'run', name, deps.now()) })
      }
    }

    const orphans = await deps.orphans.list()

    if (orphans.length) {
      facts.push(...orphans.map(o => `pid ${o.pid} from an earlier run${o.command ? `: ${o.command}` : ''}`))
      steps.push({ kind: 'reap-orphans', pids: orphans.map(o => o.pid) })
    }

    if (steps.length) {
      return { finding: finding(id, 'found', facts), steps }
    }

    // The port is held by something that is not the app's: only the owner can close it.
    return deps.bootCause()?.code === 'port-in-use'
      ? { finding: finding(id, 'manual', [deps.bootCause()?.line ?? 'the port is in use by another program']), steps }
      : { finding: finding(id, 'ok'), steps }
  }

  // 7 · orphan-processes
  const detectOrphans = async () => {
    const id: RepairClassId = 'orphan-processes'
    const orphans = await deps.orphans.list()

    return orphans.length
      ? {
          finding: finding(
            id,
            'found',
            orphans.map(o => `pid ${o.pid}${o.command ? `: ${o.command}` : ''}`)
          ),
          steps: [{ kind: 'reap-orphans', pids: orphans.map(o => o.pid) } satisfies RepairStep]
        }
      : { finding: finding(id, 'ok'), steps: [] }
  }

  const detect = async (classId: RepairClassId): Promise<{ finding: RepairFinding; steps: RepairStep[] }> => {
    switch (classId) {
      case 'stale-install-record':
        return detectStaleRecord()

      case 'runtime-venv':
        return detectRuntimeVenv()

      case 'plugins-disabled':
        return detectPluginsDisabled()

      case 'root-permissions':
        return detectRoots()

      case 'gate-not-starting':
        return detectGate()

      case 'port-busy':
        return detectPort()

      case 'orphan-processes':
        return detectOrphans()
    }
  }

  const describe = (step: RepairStep): string => {
    switch (step.kind) {
      case 'move-aside':
        return `moved ${step.from} aside to ${step.to}`

      case 'chmod':
        return `${step.path}: mode ${step.fromMode.toString(8)} → ${step.toMode.toString(8)}`

      case 'edit-config':
        return `${step.file}: removed ${step.remove.join(', ')} from plugins.disabled`

      case 'reap-orphans':
        return `stopped the app's own leftover processes ${step.pids.join(', ')}`

      case 'reinstall-runtime':
        return 'the next start reinstalls the agent runtime'
    }
  }

  const runStep = async (step: RepairStep, index: number, manifestDir: string): Promise<AppliedStep> => {
    if (!stepContained(step)) {
      throw new Error(`${describe(step)}: a path is outside the app's and the agent's folders`)
    }

    switch (step.kind) {
      case 'move-aside': {
        if (exists(step.to)) {
          throw new Error(`${step.to} already exists`)
        }

        fs.mkdirSync(path.dirname(step.to), { mode: PRIVATE_DIR, recursive: true })
        fs.renameSync(step.from, step.to) // a rename: nothing is copied, nothing is deleted

        return { detail: describe(step), ok: true, step }
      }

      case 'chmod':
        fs.chmodSync(step.path, step.toMode)

        return { detail: describe(step), ok: true, step }
      case 'edit-config': {
        const current = fs.readFileSync(step.file)

        if (sha256(current) !== step.preSha256) {
          throw new Error(`${step.file} changed since it was checked`)
        }

        const backup = path.join(manifestDir, 'backup', `${index}-${path.basename(step.file)}`)
        fs.mkdirSync(path.dirname(backup), { mode: PRIVATE_DIR, recursive: true })
        fs.copyFileSync(step.file, backup, fs.constants.COPYFILE_EXCL)
        fs.chmodSync(backup, PRIVATE_FILE)
        writeFileAtomicSync(step.file, step.nextText)

        return { backup, detail: describe(step), ok: true, postSha256: sha256(step.nextText), step }
      }

      case 'reap-orphans': {
        const reaped = await deps.orphans.reap()

        return { detail: `${describe({ ...step, pids: reaped })} (of ${step.pids.join(', ')})`, ok: true, step }
      }

      case 'reinstall-runtime':
        deps.requestReinstall()

        return { detail: describe(step), ok: true, step }
    }
  }

  /** Puts one applied step back. Returns why it could not, or null when it did. */
  const putBack = (applied: AppliedStep): UndoReport['skipped'][number]['reason'] | null => {
    const step = applied.step

    if (!step || typeof step !== 'object' || !stepContained(step, step.kind === 'edit-config' ? applied.backup : undefined)) {
      return 'outside-home'
    }

    switch (step.kind) {
      case 'move-aside': {
        if (!exists(step.to)) {
          return 'missing'
        }

        if (exists(step.from)) {
          return 'occupied' // something new sits there: never overwritten
        }

        fs.mkdirSync(path.dirname(step.from), { mode: PRIVATE_DIR, recursive: true })
        fs.renameSync(step.to, step.from)

        return null
      }

      case 'chmod': {
        const stat = lstat(step.path)

        if (!stat) {
          return 'missing'
        }

        if ((stat.mode & 0o7777) !== step.toMode) {
          return 'changed-since'
        }

        fs.chmodSync(step.path, step.fromMode)

        return null
      }

      case 'edit-config': {
        if (!applied.backup || !exists(applied.backup)) {
          return 'missing'
        }

        let current: Buffer

        try {
          current = fs.readFileSync(step.file)
        } catch {
          return 'missing'
        }

        if (sha256(current) !== applied.postSha256) {
          return 'changed-since' // the owner (or Hermes) edited it after the repair: his edit wins
        }

        writeFileAtomicSync(step.file, fs.readFileSync(applied.backup))

        return null
      }

      default:
        return 'not-undoable'
    }
  }

  const readManifest = (id: string): RepairManifest | null => {
    if (!MANIFEST_ID.test(id)) {
      return null
    }

    try {
      const value = JSON.parse(fs.readFileSync(path.join(manifestsRoot, id, MANIFEST_FILE), 'utf8')) as RepairManifest

      return value?.schema === 1 && value.id === id && isRepairClassId(value.classId) && Array.isArray(value.applied)
        ? value
        : null
    } catch {
      return null
    }
  }

  const writeManifest = (dir: string, manifest: RepairManifest) =>
    writeFileAtomicSync(path.join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 1)}\n`, {
      mode: PRIVATE_FILE
    })

  const apply = async (classId: RepairClassId, { dryRun }: { dryRun: boolean }): Promise<RepairReport> => {
    // Detect BEFORE anything is stopped: stopping the agent clears the latched failure the gate class reads.
    const { finding: before, steps } = await detect(classId)

    const report: RepairReport = {
      after: null,
      applied: [],
      before,
      classId,
      dryRun,
      manifestDir: null,
      manifestId: null,
      ok: true,
      steps,
      verify: null
    }

    if (dryRun || steps.length === 0) {
      return report
    }

    if (busy) {
      return { ...report, ok: false, refused: 'busy' }
    }

    busy = true

    try {
      const createdAt = deps.now()
      let id = `${stamp(createdAt)}-${classId}`

      for (let n = 2; exists(path.join(manifestsRoot, id)); n += 1) {
        id = `${stamp(createdAt)}-${classId}-${n}` // never two repairs in one manifest folder
      }

      const dir = path.join(manifestsRoot, id)

      fs.mkdirSync(dir, { mode: PRIVATE_DIR, recursive: true })
      deps.log(`${KIT_TAG} ${classId}: ${steps.length} step(s), manifest ${dir}`)

      if (steps.some(step => step.kind !== 'reinstall-runtime')) {
        await deps.stopAgent()
      }

      for (const [index, step] of steps.entries()) {
        try {
          const applied = await runStep(step, index, dir)
          report.applied.push(applied)
          deps.log(`${KIT_TAG} ${classId}: ${applied.detail}`)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)

          deps.log(`${KIT_TAG} ${classId}: step ${index + 1} failed (${message}); rolling back`)

          // v0.0.9 Q (correctness 8): every put-back is checked. A step that could not be put back (occupied, missing,
          // changed since, or it threw) is still in effect: it stays in the report and in an UNDONE-NOT manifest, so
          // the history offers Undo for it; a clean rollback reports nothing applied (nothing on disk changed).
          const unresolved: AppliedStep[] = []

          for (const done of [...report.applied].reverse()) {
            let reason: ReturnType<typeof putBack>

            try {
              reason = putBack(done)
            } catch {
              reason = 'missing'
            }

            if (reason !== null && reason !== 'not-undoable') {
              unresolved.unshift(done)
              deps.log(`${KIT_TAG} ${classId}: could not put back "${done.detail ?? describe(done.step)}" (${reason})`)
            }
          }

          const attempted = report.applied

          report.ok = false
          report.rolledBack = true
          report.applied = unresolved
          report.error =
            unresolved.length === 0
              ? `${describe(step)} failed: ${message}. The steps before it were put back.`
              : `${describe(step)} failed: ${message}. ${unresolved.length} step(s) before it could not be put back; ` +
                'Undo in Diagnostics tries them again.'
          writeManifest(dir, {
            applied: unresolved.length === 0 ? attempted : unresolved,
            appVersion: deps.appVersion,
            classId,
            createdAt: createdAt.toISOString(),
            id,
            schema: 1,
            undoneAt: unresolved.length === 0 ? createdAt.toISOString() : null
          })

          if (unresolved.length > 0) {
            report.manifestId = id
            report.manifestDir = dir
          }

          return report
        }
      }

      writeManifest(dir, {
        applied: report.applied,
        appVersion: deps.appVersion,
        classId,
        createdAt: createdAt.toISOString(),
        id,
        schema: 1,
        undoneAt: null
      })

      report.manifestId = id
      report.manifestDir = dir

      const reinstall = steps.some(step => step.kind === 'reinstall-runtime')
      const after = classId === 'gate-not-starting' ? null : (await detect(classId)).finding

      report.after = after
      report.verify = reinstall || !after ? 'next-start' : 'now'
      report.ok = after ? after.status !== 'found' : true

      return report
    } finally {
      busy = false
    }
  }

  const undo = async (manifestId: string): Promise<UndoReport> => {
    const base: UndoReport = { manifestId, ok: false, restored: [], skipped: [] }
    const manifest = readManifest(manifestId)

    if (!manifest) {
      return { ...base, refused: 'unknown-manifest' }
    }

    if (manifest.undoneAt) {
      return { ...base, refused: 'already-undone' }
    }

    if (busy) {
      return { ...base, refused: 'busy' }
    }

    busy = true

    try {
      if (manifest.applied.some(applied => applied.step.kind === 'move-aside')) {
        await deps.stopAgent()
      }

      for (const applied of [...manifest.applied].reverse()) {
        if (!applied.ok) {
          continue
        }

        const what = applied.detail ?? describe(applied.step)

        try {
          const reason = putBack(applied)

          if (reason) {
            base.skipped.push({ reason, what })
          } else {
            base.restored.push(what)
          }
        } catch (error) {
          base.skipped.push({ reason: 'missing', what: `${what} (${(error as Error).message})` })
        }
      }

      writeManifest(path.join(manifestsRoot, manifestId), { ...manifest, undoneAt: deps.now().toISOString() })
      deps.log(`${KIT_TAG} undo ${manifestId}: ${base.restored.length} put back, ${base.skipped.length} left`)

      return { ...base, ok: base.skipped.every(item => item.reason === 'not-undoable') }
    } finally {
      busy = false
    }
  }

  const history = (): RepairHistoryEntry[] => {
    let ids: string[] = []

    try {
      ids = fs.readdirSync(manifestsRoot).filter(name => MANIFEST_ID.test(name))
    } catch {
      return []
    }

    return ids
      .sort()
      .reverse()
      .flatMap(id => {
        const manifest = readManifest(id)

        return manifest
          ? [
              {
                classId: manifest.classId,
                createdAt: manifest.createdAt,
                id,
                undoable:
                  !manifest.undoneAt &&
                  manifest.applied.some(a => a.ok && ['chmod', 'edit-config', 'move-aside'].includes(a.step.kind)),
                undoneAt: manifest.undoneAt
              }
            ]
          : []
      })
  }

  const scan = async (): Promise<RepairFinding[]> => {
    const out: RepairFinding[] = []

    for (const classId of REPAIR_CLASS_IDS) {
      try {
        out.push((await detect(classId)).finding)
      } catch (error) {
        out.push(finding(classId, 'manual', [`the check could not run: ${(error as Error).message}`]))
      }
    }

    return out
  }

  return { apply, detect, history, manifestsRoot, scan, undo }
}
