/**
 * H1b — the one-time removal of the old (Nous-era) update history: receipts, pre-update zips,
 * rollback clones and the runtime's update-check caches move to the Trash on the first packaged
 * launch of a release that carries this module. An exact allow-list; conversations, settings,
 * sign-ins and anything else are never touched. Idempotent through a marker in userData.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { errorMessage } from '../src/iclone-shared/errors'
import { formatBytes } from '../src/iclone-shared/format'

import { readJsonFile, writeJsonAtomic } from './lib/fs-json'

const LEGACY_CLEANUP_TAG = '[iclone-legacy-cleanup]'
export const LEGACY_CLEANUP_MARKER = 'legacy-update-cleanup.json'
const LEGACY_CLEANUP_MAX_ATTEMPTS = 3

/** Same pattern the old status reader used for the runtime's pre-update backups. */
const PRE_UPDATE_ZIP = /^pre-update-.+\.zip$/
const ROLLBACK_CHILD = /^(hermes-agent-[0-9a-f]{7,40}|home-state-\d{8}-\d{4})$/
const JSON_FILE = /\.json$/
/** A size walk stops here; the byte count is for the log line only. */
const SIZE_WALK_MAX_ENTRIES = 200_000

type LegacyItemKind = 'receipt' | 'rollback-clone' | 'pre-update-zip' | 'update-check-cache'

interface LegacyItem {
  bytes: number
  kind: LegacyItemKind
  path: string
}

interface LegacyFailure {
  error: string
  kind: LegacyItemKind
  path: string
}

interface LegacyCleanupMarker {
  at: string
  attempts: number
  failed: LegacyFailure[]
  removed: LegacyItem[]
  v: 1
  version: string
}

type LegacyCleanupResult = 'done' | 'moved' | 'nothing' | 'partial' | 'skipped'

interface LegacyCleanupSummary {
  bytes: number
  failed: number
  moved: number
  result: LegacyCleanupResult
}

interface LegacyCleanupDeps {
  appVersion: string
  hermesHome: string
  homeDir: string
  isPackaged: boolean
  log: (line: string) => void
  /** True while the runtime update marker is live or runtime alignment runs. */
  runtimeBusy?: () => boolean
  /** shell.trashItem — recoverable; never a permanent delete. */
  trash: (target: string) => Promise<void>
  userData: string
}

async function sizeOf(target: string): Promise<number> {
  let total = 0
  let seen = 0
  const stack = [target]

  while (stack.length > 0 && seen < SIZE_WALK_MAX_ENTRIES) {
    const current = stack.pop() as string
    seen += 1
    const stat = await fs.lstat(current).catch(() => null)

    if (!stat) {
      continue
    }

    total += stat.size

    if (stat.isDirectory()) {
      const names = await fs.readdir(current).catch(() => [] as string[])
      stack.push(...names.map(name => path.join(current, name)))
    }
  }

  return total
}

/** Allow-listed children of one root: real files/dirs only, never a symlink, never outside the root. */
async function children(
  root: string,
  match: RegExp,
  want: 'dir' | 'file',
  log: (line: string) => void
): Promise<string[]> {
  const realRoot = await fs.realpath(root).catch(() => null)

  if (!realRoot) {
    return []
  }

  const names = await fs.readdir(realRoot).catch(() => [] as string[])
  const found: string[] = []

  for (const name of names.filter(n => match.test(n)).sort()) {
    const full = path.join(realRoot, name)
    const stat = await fs.lstat(full).catch(() => null)

    if (!stat) {
      continue
    }

    if (stat.isSymbolicLink()) {
      log(`${LEGACY_CLEANUP_TAG} skipped symlink ${full}`)

      continue
    }

    if ((want === 'dir' && stat.isDirectory()) || (want === 'file' && stat.isFile())) {
      found.push(full)
    }
  }

  return found
}

async function plainFile(file: string, log: (line: string) => void): Promise<string[]> {
  const stat = await fs.lstat(file).catch(() => null)

  if (stat?.isSymbolicLink()) {
    log(`${LEGACY_CLEANUP_TAG} skipped symlink ${file}`)
  }

  return stat?.isFile() ? [file] : []
}

async function isEmptyRealDir(dir: string): Promise<boolean> {
  const stat = await fs.lstat(dir).catch(() => null)

  return Boolean(stat?.isDirectory()) && (await fs.readdir(dir).catch(() => ['?'])).length === 0
}

export async function runLegacyUpdateCleanup(deps: LegacyCleanupDeps): Promise<LegacyCleanupSummary> {
  const none = (result: LegacyCleanupResult): LegacyCleanupSummary => ({ bytes: 0, failed: 0, moved: 0, result })

  if (!deps.isPackaged) {
    return none('skipped')
  }

  if (deps.runtimeBusy?.()) {
    deps.log(`${LEGACY_CLEANUP_TAG} deferred: a runtime update is running`)

    return none('skipped')
  }

  const markerFile = path.join(deps.userData, LEGACY_CLEANUP_MARKER)
  const previous = await readJsonFile<Partial<LegacyCleanupMarker>>(markerFile, { maxBytes: 1024 * 1024 })
  const attempts = typeof previous?.attempts === 'number' ? previous.attempts : 0

  if (previous && (!(previous.failed?.length ?? 0) || attempts >= LEGACY_CLEANUP_MAX_ATTEMPTS)) {
    return none('done')
  }

  const home = deps.hermesHome
  const receiptsDir = path.join(home, 'logs', 'update_receipts')
  const clonesDir = path.join(deps.homeDir, '.hermes-update-backups')

  const groups: { dirIfEmpty?: string; kind: LegacyItemKind; paths: string[] }[] = [
    { dirIfEmpty: receiptsDir, kind: 'receipt', paths: await children(receiptsDir, JSON_FILE, 'file', deps.log) },
    { kind: 'pre-update-zip', paths: await children(path.join(home, 'backups'), PRE_UPDATE_ZIP, 'file', deps.log) },
    {
      dirIfEmpty: clonesDir,
      kind: 'rollback-clone',
      paths: await children(clonesDir, ROLLBACK_CHILD, 'dir', deps.log)
    },
    {
      kind: 'update-check-cache',
      paths: [
        ...(await plainFile(path.join(home, '.update_check'), deps.log)),
        ...(await children(path.join(home, 'source-checks'), JSON_FILE, 'file', deps.log))
      ]
    }
  ]

  const removed: LegacyItem[] = [...(previous?.removed ?? [])]
  const failed: LegacyFailure[] = []
  let moved = 0
  let bytes = 0

  const move = async (target: string, kind: LegacyItemKind) => {
    const size = await sizeOf(target)

    try {
      await deps.trash(target)
      removed.push({ bytes: size, kind, path: target })
      moved += 1
      bytes += size
    } catch (error) {
      failed.push({ error: errorMessage(error), kind, path: target })
    }
  }

  for (const group of groups) {
    for (const target of group.paths) {
      await move(target, group.kind)
    }

    if (group.dirIfEmpty && group.paths.length > 0 && (await isEmptyRealDir(group.dirIfEmpty))) {
      await move(group.dirIfEmpty, group.kind)
    }
  }

  const marker: LegacyCleanupMarker = {
    at: new Date().toISOString(),
    attempts: attempts + 1,
    failed,
    removed,
    v: 1,
    version: deps.appVersion
  }

  await writeJsonAtomic(markerFile, marker, { mode: 0o600 })

  if (moved === 0 && failed.length === 0) {
    deps.log(`${LEGACY_CLEANUP_TAG} nothing to move`)

    return none('nothing')
  }

  deps.log(
    `${LEGACY_CLEANUP_TAG} moved ${moved} items (${formatBytes(bytes, { base: 1000, maxUnit: 'GB' })}) to the Trash` +
      (failed.length ? `; ${failed.length} failed, retried on a later launch` : '')
  )

  return { bytes, failed: failed.length, moved, result: failed.length ? 'partial' : 'moved' }
}

/** The one toast after a cleanup that moved something. */
export function legacyCleanupNotice(summary: LegacyCleanupSummary): null | string {
  if (summary.moved === 0) {
    return null
  }

  return `Old update backups (${formatBytes(summary.bytes, { base: 1000, maxUnit: 'GB' })}) were moved to the Trash.`
}
