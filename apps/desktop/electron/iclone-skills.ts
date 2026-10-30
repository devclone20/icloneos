/**
 * iclone os — the app TEACHES its agent.
 *
 * The skills the app ships from the repo root `iclone/skills/<name>/`
 * (packaged to `Resources/hermes-skill`) are what the iNFT agent knows about this app:
 * how to drive it (`iclone-os`), how to run its economy (`economyos`), how to
 * update it (`app-atualisation`), how to work across iT panes
 * (`it-orchestration`), how to publish itself (`agent-self-repo`).
 *
 * Hermes loads skills from `<HERMES_HOME>/skills` — the ROOT home, because an
 * iNFT in iclone os is a personality overlay on the primary backend, not a
 * separate profile process (see src/app/home/inft-profile.ts). The per-iNFT
 * profile directories (`profiles/inft-*`) keep a copy too, so a profile run
 * on its own (`hermes --profile inft-…`) knows the same things.
 *
 * Sync = copy every bundled skill into every target, byte-compared so an
 * unchanged skill costs one read per file and no write, and RETIRE the skills
 * of the retired mini app (and the hand-written `virtuals-protocol-cli`,
 * which hard-coded one token and the owner's personal ACP config — the
 * opposite of "each iNFT has its own"). Retired skills are MOVED to
 * `<HERMES_HOME>/skills-retired/<stamp>/…`, never deleted.
 *
 * Only skill directories the app owns are ever written: those whose name is
 * in the bundle, or in RETIRED. A skill the owner installed is never touched.
 *
 * Every tree also gets ROOT_FILES: DESCRIPTION.md (copied from the bundle) is
 * the one category line Hermes renders above our rows in <available_skills> for
 * EVERY agent, the default one included; CATALOG.json/.md are written from the
 * catalog derived from the bundled SKILL.md frontmatter at sync time
 * (iclone-skills-catalog.ts), never copied from the committed docs, which
 * another front's edit may have staled. Every file lands through a temp file +
 * rename, so a crash mid-sync leaves the old bytes or the new ones, never half
 * a file.
 *
 * Hermes caches the rendered skills prompt in-process and file writes do not
 * invalidate it: the launch sync runs before the backend is spawned, and a
 * later re-sync only reaches the agent after a backend restart.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { app, ipcMain } from 'electron'

import type { SkillHost } from '../src/iclone-shared/skill-manifest'

import { attachSkillRequirements, type PortedSkillCatalog, realSkillHost } from './iclone-skill-requires'
import { deriveSkillCatalog, hostOs, renderCatalogFiles } from './iclone-skills-catalog'
import { isAtomicTempName, writeFileAtomicSync } from './lib/atomic-write'

export type { SkillCatalog, SkillCatalogEntry } from './iclone-skills-catalog'

/** Skills of the retired Telegram mini app (owner decision) and the
 *  pre-isolation CLI notes. Moved aside wherever they still sit. */
export const RETIRED_SKILLS = Object.freeze([
  'iclone-mini-agentcard',
  'iclone-mini-app',
  'iclone-mini-appmap',
  'iclone-mini-commands',
  'iclone-mini-economyos',
  'iclone-mini-machines',
  'iclone-mini-voice',
  'virtuals-protocol-cli'
])

/** The category folder the app's skills live under, in every skills tree. */
const SKILL_CATEGORY = 'iclone'
const MARKER = '.iclone-managed'

/** Bundle-root files copied into every skills tree next to the skill folders. */
export const ROOT_FILES = Object.freeze(['DESCRIPTION.md', 'CATALOG.md', 'CATALOG.json'])

/** `.<name>.iclone-tmp-<pid>`: the temp name of older versions' writes; swept with the atomic writer's own. */
const TEMP_FILE = /^\..+\.iclone-tmp-\d+$/

/** Test seam: runs between the temp write and the rename (a throw = a crash there). */
interface SyncHooks {
  beforeRename?: (temp: string, destination: string) => void
}

interface SkillSyncReport {
  ok: boolean
  source: string
  /** Every skills tree written to (root + per-iNFT profiles). */
  targets: string[]
  /** Bundled skill names found in `source`. */
  skills: string[]
  /** `<target>/<skill>` paths that were created or changed this run. */
  written: string[]
  /** `<target>/<skill>` paths moved to the retired folder this run. */
  retired: string[]
  errors: string[]
  syncedAt: number
  /** sha256 (12 hex) of the CATALOG.json derived from the bundled SKILL.md files and written to every tree. */
  catalogHash: string | null
}

function isDir(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

function isSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name)
}

/** Files of one skill directory, relative paths, deterministic order. */
function listFiles(root: string, relative = ''): string[] {
  const dir = path.join(root, relative)
  const out: string[] = []

  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue
    }

    const rel = relative ? path.join(relative, entry.name) : entry.name

    if (entry.isDirectory()) {
      out.push(...listFiles(root, rel))
    } else if (entry.isFile()) {
      out.push(rel)
    }
  }

  return out
}

function sameContent(content: string, file: string): boolean {
  try {
    return readFileSync(file, 'utf8') === content
  } catch {
    return false
  }
}

function sameBytes(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b))
  } catch {
    return false
  }
}

/** Copies `from` over `to` atomically, keeping the source's permission bits (a script stays executable). */
function copyAtomic(from: string, to: string, hooks?: SyncHooks): void {
  writeFileAtomicSync(to, readFileSync(from), { beforeRename: hooks?.beforeRename, mode: statSync(from).mode & 0o777 })
}

/** Remove the temp files an interrupted sync left behind (only in trees the app owns). */
function sweepTemps(dir: string, deep: boolean): void {
  let entries

  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name)

    if (entry.isFile() && (TEMP_FILE.test(entry.name) || isAtomicTempName(entry.name))) {
      rmSync(full, { force: true })
    } else if (deep && entry.isDirectory()) {
      sweepTemps(full, true)
    }
  }
}

/** Copy one skill into `<targetRoot>/<name>`; true when anything was written. */
function syncSkill(sourceDir: string, targetDir: string, stamp: string, hooks?: SyncHooks): boolean {
  let wrote = false

  sweepTemps(targetDir, true)

  for (const rel of listFiles(sourceDir)) {
    const from = path.join(sourceDir, rel)
    const to = path.join(targetDir, rel)

    if (sameBytes(from, to)) {
      continue
    }

    copyAtomic(from, to, hooks)
    wrote = true
  }

  const marker = path.join(targetDir, MARKER)

  if (wrote || !existsSync(marker)) {
    mkdirSync(targetDir, { recursive: true })
    writeFileAtomicSync(marker, `${stamp}\n`)
    wrote = true
  }

  return wrote
}

/** The skills trees to teach: the root home and every iNFT profile. */
export function skillTargets(hermesHome: string): string[] {
  const targets = [path.join(hermesHome, 'skills', SKILL_CATEGORY)]
  const profiles = path.join(hermesHome, 'profiles')

  if (isDir(profiles)) {
    for (const entry of readdirSync(profiles, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && /^inft-[a-z0-9]{1,12}-\d{1,12}$/.test(entry.name)) {
        targets.push(path.join(profiles, entry.name, 'skills', SKILL_CATEGORY))
      }
    }
  }

  return targets
}

/**
 * The pure sync: bundled skills at `sourceDir` → every target under
 * `hermesHome`; retired names moved aside. Idempotent; a second run writes
 * nothing.
 */
export function syncSkillTrees(options: {
  sourceDir: string
  hermesHome: string
  stamp: string
  hooks?: SyncHooks
}): SkillSyncReport {
  const { sourceDir, hermesHome, stamp, hooks } = options

  const report: SkillSyncReport = {
    ok: true,
    source: sourceDir,
    targets: [],
    skills: [],
    written: [],
    retired: [],
    errors: [],
    syncedAt: Date.now(),
    catalogHash: null
  }

  if (!isDir(sourceDir)) {
    report.ok = false
    report.errors.push(`bundled skills missing at ${sourceDir}`)

    return report
  }

  report.skills = readdirSync(sourceDir, { withFileTypes: true })
    .filter(
      entry =>
        entry.isDirectory() && isSkillName(entry.name) && existsSync(path.join(sourceDir, entry.name, 'SKILL.md'))
    )
    .map(entry => entry.name)
    .sort()

  const catalog = deriveSkillCatalog(sourceDir)?.skills ?? []
  const derived = renderCatalogFiles(catalog)

  for (const row of catalog) {
    if (row.problem) {
      // The folder is still copied (Hermes indexes it with full YAML); the report names it so nobody misses it.
      report.errors.push(`${row.name}: frontmatter unreadable — ${row.problem}`)
    }
  }

  const copied = existsSync(path.join(sourceDir, 'DESCRIPTION.md')) ? ['DESCRIPTION.md'] : []

  report.catalogHash = createHash('sha256').update(derived['CATALOG.json']).digest('hex').slice(0, 12)

  const retiredRoot = path.join(hermesHome, 'skills-retired', stamp.replace(/[^0-9A-Za-z._-]/g, '-'))

  for (const target of skillTargets(hermesHome)) {
    report.targets.push(target)

    for (const name of RETIRED_SKILLS) {
      const stale = path.join(target, name)

      if (!isDir(stale)) {
        continue
      }

      try {
        // `<retired>/<home-relative target>/<name>` keeps the origin readable.
        const label = path.relative(hermesHome, target).replace(/[\\/]/g, '__')
        const dest = path.join(retiredRoot, label, name)

        mkdirSync(path.dirname(dest), { recursive: true })
        renameSync(stale, dest)
        report.retired.push(stale)
      } catch (error) {
        report.ok = false
        report.errors.push(`retire ${stale}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    for (const name of report.skills) {
      try {
        if (syncSkill(path.join(sourceDir, name), path.join(target, name), stamp, hooks)) {
          report.written.push(path.join(target, name))
        }
      } catch (error) {
        report.ok = false
        report.errors.push(
          `write ${path.join(target, name)}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    // After the skills, so the category line never lands above rows that are not there yet.
    sweepTemps(target, false)

    for (const file of ROOT_FILES) {
      const to = path.join(target, file)
      const content = file === 'CATALOG.json' || file === 'CATALOG.md' ? derived[file] : null

      if (content === null && !copied.includes(file)) {
        continue
      }

      try {
        if (content !== null && !sameContent(content, to)) {
          writeFileAtomicSync(to, content, { beforeRename: hooks?.beforeRename })
          report.written.push(to)
        } else if (content === null && !sameBytes(path.join(sourceDir, file), to)) {
          copyAtomic(path.join(sourceDir, file), to, hooks)
          report.written.push(to)
        }
      } catch (error) {
        report.ok = false
        report.errors.push(`write ${to}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  return report
}

/**
 * The catalog the pane shows: derived from the bundled SKILL.md frontmatter NOW (a committed CATALOG.json is never
 * read), plus the host OS so the pane can tell a skill Hermes hides here from one not taught yet. Null when the
 * bundle folder is missing or holds no skill. V3-B: a skill ported from the owner's library carries a manifest.json;
 * its `requires` is evaluated against `host` (this machine by default) and attached as `port` — names only.
 */
export function readSkillCatalog(
  sourceDir: string,
  platform: string = process.platform,
  host: SkillHost = realSkillHost({ platform })
): PortedSkillCatalog | null {
  const catalog = deriveSkillCatalog(sourceDir)

  return catalog && catalog.count
    ? attachSkillRequirements({ ...catalog, host: hostOs(platform) }, sourceDir, host)
    : null
}

/** Packaged: `Resources/hermes-skill`. Dev: the ONE source tree in the repo
 *  root (`iclone/skills`, documented in its README). */
function bundledSkillsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'hermes-skill')
    : path.resolve(app.getAppPath(), '..', '..', 'iclone', 'skills')
}

let last: SkillSyncReport | null = null

function syncAgentSkills(hermesHome: string): SkillSyncReport {
  const stamp = `${app.getVersion()}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`

  last = syncSkillTrees({ sourceDir: bundledSkillsDir(), hermesHome, stamp })

  if (last.written.length || last.retired.length || !last.ok) {
    console.info(
      `[iclone] agent skills: ${last.skills.length} bundled · ${last.written.length} written · ${last.retired.length} retired` +
        (last.errors.length ? ` · errors: ${last.errors.join('; ')}` : '')
    )
  }

  return last
}

let initialized = false

export function initIcloneSkills(options: { hermesHome: string }) {
  if (initialized) {
    return
  }

  initialized = true
  ipcMain.handle('iclone:skills-sync', () => syncAgentSkills(options.hermesHome))
  ipcMain.handle('iclone:skills-last', () => last)
  ipcMain.handle('iclone:skills-catalog', () => readSkillCatalog(bundledSkillsDir()))

  // Teach on every launch: a reinstall of the app (new skills) or of Hermes
  // (`hermes update` re-seeds profiles) must never leave the agent behind.
  try {
    syncAgentSkills(options.hermesHome)
  } catch (error) {
    console.warn('[iclone] agent skills sync failed:', error)
  }
}
