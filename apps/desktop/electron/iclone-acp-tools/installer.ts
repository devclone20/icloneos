/**
 * v0.0.9 (owner decision 17 Nov, replaces ruling 26) — the ACP tools: the Virtuals ACP CLI the app SHIPS. Nothing is
 * installed from the network any more. The build materialised the pinned tree (materialise.ts) into the signed app
 * (Resources/acp-tools, bundle.ts); this module keeps a working copy of it in `userData/acp-cli/<sha256 of
 * package-lock.json>/`, and every ACP spawn goes through `runtime()`, which verifies that copy first and refuses (with
 * the reason) when it is absent, changed, or not this build's.
 *
 * WHAT VERIFIES. The bundle's own MANIFEST.json, read from inside the signed app: the copy's MANIFEST.json must be those
 * exact bytes and every file must hash to it (same full and quick checks as before, manifest.ts). No Keychain key, no
 * MAC, no install record: the app's signature is the authority (blocker K is gone — a Mac with the Keychain setting off
 * runs the CLI like any other).
 *
 * PLACED, NOT INSTALLED. The first check of a build places the copy from the bundle on its own (no network, no click:
 * the owner's decision is that the app comes with the CLI), and so does the first check after an update from v0.0.8,
 * whose npm-installed tree at the same path is replaced. A copy that is there and does NOT verify is never replaced
 * silently: it is `unverified`, audited, and only the owner's **Repair** (`install()`, behind V3-F's gesture lock and
 * audit in ipc.ts) restores it from the bundle — every byte re-checked against the bundle's manifest on the way, the
 * new copy proven before it replaces anything.
 *
 * CONFINED (critic M1). Our launcher (scripts/acp-launch.cjs, Resources/acp-pin/launch.cjs) refuses any module that
 * resolves outside `runtime/node_modules` and hashes every file it loads against the copy's MANIFEST.json (the bundle's
 * bytes). What a check finds planted in the app-owned folders above the tree is audited (never deleted, never loaded).
 */
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  constants as fsConstants,
  promises as fsp,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ACP_CLI_NAME, parsePin, type PinTarget, targetName } from '../../src/iclone-shared/acp-pin'
import type { AcpToolsProblemInfo, AcpToolsReason, AcpToolsView } from '../../src/iclone-shared/acp-tools'
import { isAtomicTempName } from '../lib/atomic-write'

import {
  type BundleManifest,
  copyBundle,
  defaultBundleDir,
  isLegacyInstallManifest,
  readBundleManifest
} from './bundle'
import { AcpToolsError, logText, problemOf } from './errors'
import { KEY_FILE, type KeySealer, MANIFEST_FILE, quickUnchanged, sha256Hex, type Snapshot, verifyTree } from './manifest'
import { NOTICES_FILE, RUNTIME_DIR } from './materialise'
import { addonsDigest, type NativeAddons } from './native'
import type { InstallRecordStore } from './record'

export { NOTICES_FILE } from './materialise'

const PROGRESS_MS = 120
const HEX64 = /^[0-9a-f]{64}$/

export interface AcpToolsAudit {
  kind: 'refuse' | 'use' | 'gap'
  reason: string
}

export interface AcpToolsDeps {
  /** `userData/acp-cli`: the working copy lives in `<root>/<lock sha256>/`. */
  root: string
  /** The shipped pin: `package.json` + `package-lock.json` (Resources/acp-pin, or acp-cli-lock in a dev run). */
  pinDir: string
  /** Our own launcher (Resources/acp-pin/launch.cjs, or scripts/acp-launch.cjs in a dev run). */
  launcher: string
  target: PinTarget
  /** The bundled tree (Resources/acp-tools). Default: beside the pin (bundle.ts `defaultBundleDir`). */
  bundleDir?: string
  /** Ruling 33: the app's own native add-ons for this target; the bundle must have been built with this very list. */
  native: NativeAddons
  /** @deprecated v0.0.9: nothing is fetched at run time (the build materialises the tree). Ignored. */
  fetch?(url: string, signal: AbortSignal): Promise<Buffer>
  /** @deprecated v0.0.9: the bundle's manifest is authenticated by the app's signature, not a sealed key. Ignored. */
  sealer?: KeySealer | null
  /** @deprecated v0.0.9: the Keychain setting no longer matters to the ACP tools (blocker K). Ignored. */
  noSealReason?: 'keychain-off' | 'unsealable'
  /** @deprecated v0.0.9: the app's signature replaces the install record. Ignored. */
  record?: InstallRecordStore
  audit?(entry: AcpToolsAudit): void
  log(line: string): void
  onChange?(view: AcpToolsView): void
  now?(): Date
  /** Test seam: awaited at the start of every full check (holds one in flight to prove m5 without timing). */
  beforeCheck?(): Promise<void>
}

/** A verified CLI, as iclone-acp.ts runs it. */
export interface AcpToolsRuntime {
  dir: string
  entry: string
  launcher: string
  nodeModules: string
  pkg: string
  version: string
  /** The verified manifest's tree digest: the launcher refuses to start on a MANIFEST.json that is not this one. */
  treeSha256: string
}

export type AcpToolsProblem = 'absent' | 'installing' | 'unavailable' | 'unverified'

export type RuntimeAnswer =
  { ok: true; rt: AcpToolsRuntime } | { ok: false; code: AcpToolsProblem; reason: AcpToolsReason | null; error: string }

export type InstallAnswer =
  | { ok: true; view: AcpToolsView }
  | { ok: false; cancelled: true }
  | ({ ok: false; cancelled?: false } & AcpToolsProblemInfo)

interface LoadedPin {
  cliVersion: string
  lockSha256: string
}

interface LoadedBundle {
  manifest: BundleManifest
  bytes: Buffer
  sha256: string
}

/** Why a copy is (re)placed from the bundle: the first check of a build, a v0.0.8 npm tree, or the owner's Repair. */
type PlaceWhy = 'first-run' | 'legacy' | 'repair'

const SENTENCE: Record<AcpToolsProblem, string> = {
  absent: 'ACP tools are not installed: this build does not include the Virtuals ACP CLI',
  installing: 'ACP tools are being restored from the copy included in the app',
  unverified: 'ACP tools could not be verified: repair them from ACP Market or Settings',
  unavailable: 'ACP tools cannot run in this build'
}

/**
 * The refusal every ACP path answers with while the tools are not ready: the machine prefix the window classifies on
 * (`[acp-tools:<state>:<reason>]`, src/iclone-shared/acp-tools.ts), then an English sentence for the log only.
 */
export function problemText(code: AcpToolsProblem, reason?: AcpToolsReason | null, subject?: string): string {
  return `[acp-tools:${code}${reason ? `:${reason}` : ''}] ${SENTENCE[code]}${reason ? ` (${reason}${subject ? `: ${subject}` : ''})` : ''}`
}

/**
 * The spawn gate's comparison (critic r2 D10): the runtime a caller resolved earlier is the verified one NOW only when
 * it names the same entry AND the same manifest digest (a repair keeps the path; an app update changes the tree).
 */
export function sameTree(
  now: { entry: string; treeSha256: string },
  then: { entry: string; treeSha256: string }
): boolean {
  return now.entry === then.entry && now.treeSha256 === then.treeSha256
}

/** What a check found: the view, the verified copy it may hand to a spawn, or that the copy must be placed first. */
interface Checked {
  view: AcpToolsView
  verified: { dir: string; manifest: BundleManifest; snapshot: Snapshot } | null
  place?: Exclude<PlaceWhy, 'repair'>
}

export function createAcpTools(deps: AcpToolsDeps) {
  const now = deps.now ?? (() => new Date())
  const bundleDir = deps.bundleDir ?? defaultBundleDir(deps.pinDir)
  let loadedPin: LoadedPin | { reason: AcpToolsReason } | null = null
  let loadedBundle: LoadedBundle | null = null
  let view: AcpToolsView = { state: 'checking', cliVersion: null }
  let verified: Checked['verified'] = null
  let installing: { controller: AbortController; promise: Promise<InstallAnswer> } | null = null
  /** Bumped by every placement: a check started before it never speaks for the copy after it (critic m5). */
  let generation = 0
  let checking: { generation: number; promise: Promise<AcpToolsView> } | null = null
  /** The last automatic placement failed: no second automatic attempt this run; the owner's Repair retries. */
  let placeFailure: AcpToolsProblemInfo | null = null
  /** The owner cancelled an automatic placement this run: no automatic retry until his Repair (correctness 4). */
  let placeCancelled = false
  let lastEmit = 0
  const audited = new Set<string>()

  const emit = (next: AcpToolsView, force = true) => {
    view = next

    const at = Date.now()

    if (force || at - lastEmit >= PROGRESS_MS) {
      lastEmit = at
      deps.onChange?.(next)
    }
  }

  const pinOf = (): LoadedPin | { reason: AcpToolsReason } => {
    if (loadedPin) {
      return loadedPin
    }

    try {
      const lockText = readFileSync(path.join(deps.pinDir, 'package-lock.json'), 'utf8')
      const pin = parsePin(readFileSync(path.join(deps.pinDir, 'package.json'), 'utf8'), lockText)

      loadedPin = existsSync(deps.launcher)
        ? { cliVersion: pin.cliVersion, lockSha256: sha256Hex(lockText) }
        : { reason: 'launcher-missing' }
    } catch (error) {
      deps.log(`[iclone-acp-tools] the pin does not parse: ${logText(error)}`)
      loadedPin = { reason: 'pin-invalid' }
    }

    return loadedPin
  }

  /**
   * The bundle, read once per run when it is this build's (the signed app cannot change under a running process; a
   * refusal is read again on the next check). `absent`: this build includes no CLI (a dev run that did not stage it).
   */
  const bundleOf = (pin: LoadedPin): LoadedBundle | { absent: true } | ({ absent: false } & AcpToolsProblemInfo) => {
    if (loadedBundle) {
      return loadedBundle
    }

    const read = readBundleManifest(bundleDir)

    if (!read.ok) {
      return read.absent
        ? { absent: true }
        : { absent: false, reason: read.reason, ...(read.subject ? { subject: read.subject } : {}) }
    }

    const { manifest } = read

    if (
      manifest.lockSha256 !== pin.lockSha256 ||
      manifest.cliVersion !== pin.cliVersion ||
      manifest.target !== targetName(deps.target)
    ) {
      return { absent: false, reason: 'other-pin', subject: `included copy: ${manifest.target}` }
    }

    // Critic r2 m4, kept: the bundle must be the one built with THIS app's add-on list.
    if (manifest.addons !== addonsDigest(deps.native)) {
      return { absent: false, reason: 'addons-mismatch', subject: 'included copy' }
    }

    loadedBundle = { manifest, bytes: read.bytes, sha256: read.sha256 }

    return loadedBundle
  }

  const dirFor = (lockSha256: string) => path.join(deps.root, lockSha256)

  const cliVersion = () => {
    const pin = pinOf()

    return 'reason' in pin ? null : pin.cliVersion
  }

  /**
   * Other pins' copies and every leftover of an interrupted placement. Never the current pin's copy. v0.0.9 Q
   * (tests-perf 5): removed with the async `fs.rm`, never a recursive `rmSync` on the main thread (a v0.0.8 npm tree is
   * ~12.6k files: seconds of a frozen window at the first start after the upgrade). The names are read once, before
   * the first await, so a placement that starts meanwhile (a fresh random `.install-*`) is never in the list.
   */
  const sweep = async (keep: string | null): Promise<void> => {
    if (!existsSync(deps.root)) {
      return
    }

    for (const name of readdirSafe(deps.root)) {
      const leftover = name.startsWith('.install-') || name.startsWith('.trash-')

      if ((leftover && !installing) || (HEX64.test(name) && name !== keep)) {
        await fsp.rm(path.join(deps.root, name), { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  /** One audit record per distinct finding per run, not one per spawn. */
  const auditOnce = (kind: AcpToolsAudit['kind'], reason: string) => {
    if (!audited.has(reason)) {
      audited.add(reason)
      deps.audit?.({ kind, reason })
    }
  }

  /**
   * Critic M1: Node would walk up from the tree into `userData/acp-cli/node_modules` and `userData/node_modules`. The
   * launcher never resolves there (scripts/acp-launch.cjs); anything planted in these app-owned folders is refused,
   * left untouched, and recorded in the audit.
   */
  const strays = () => {
    const found: string[] = []

    for (const name of readdirSafe(deps.root)) {
      if (
        !HEX64.test(name) &&
        name !== KEY_FILE &&
        !name.startsWith('.install-') &&
        !name.startsWith('.trash-') &&
        !isAtomicTempName(name)
      ) {
        found.push(`acp-cli/${name}`)
      }
    }

    try {
      lstatSync(path.join(path.dirname(deps.root), 'node_modules'))
      found.push('node_modules')
    } catch {
      // the usual case
    }

    for (const stray of found) {
      auditOnce(
        'refuse',
        `acp tools: refused ${stray} beside the verified tree (outside it: never resolved, never loaded)`
      )
    }
  }

  const unverified = (cliVersion: string, problem: AcpToolsProblemInfo): Checked => ({
    view: { state: 'unverified', cliVersion, ...problem },
    verified: null
  })

  /** Full check of the working copy against the bundle. Never throws; touches no shared state (check() applies it). */
  const fullCheck = async (): Promise<Checked> => {
    await deps.beforeCheck?.()

    const pin = pinOf()

    if ('reason' in pin) {
      return { view: { state: 'unavailable', cliVersion: null, reason: pin.reason }, verified: null }
    }

    const version = pin.cliVersion
    const bundle = bundleOf(pin)

    if ('absent' in bundle) {
      return bundle.absent
        ? { view: { state: 'absent', cliVersion: version, stale: false }, verified: null }
        : {
            view: {
              state: 'unavailable',
              cliVersion: version,
              reason: bundle.reason,
              ...(bundle.subject ? { subject: bundle.subject } : {})
            },
            verified: null
          }
    }

    strays()

    const dir = dirFor(pin.lockSha256)

    if (!existsSync(dir)) {
      // The owner's decision: the app comes with the CLI. Placed from the bundle without a click — unless an automatic
      // placement already failed this run (then it is the owner's Repair that retries, never a loop).
      if (placeFailure) {
        return unverified(version, placeFailure)
      }

      // v0.0.9 Q (correctness 4): the owner cancelled the automatic placement: no copy until his Repair (never a loop).
      return placeCancelled
        ? { view: { state: 'absent', cliVersion: version, stale: false }, verified: null }
        : { view, verified: null, place: 'first-run' }
    }

    let copied: Buffer

    try {
      copied = readFileSync(path.join(dir, MANIFEST_FILE))
    } catch {
      return unverified(version, { reason: 'manifest-missing' })
    }

    if (sha256Hex(copied) !== bundle.sha256) {
      // A v0.0.8 npm install at this path is the app's own past state, not a tamper: replaced once, audited.
      if (isLegacyInstallManifest(copied) && !placeFailure) {
        // Cancelled once: the old tree stays where it is and is not run; the owner's Repair replaces it.
        return placeCancelled
          ? { view: { state: 'absent', cliVersion: version, stale: false }, verified: null }
          : { view, verified: null, place: 'legacy' }
      }

      return unverified(version, { reason: 'manifest-signature' })
    }

    const tree = await verifyTree(dir, bundle.manifest)

    if (!tree.ok) {
      return unverified(
        version,
        tree.subject === undefined ? { reason: tree.reason } : { reason: tree.reason, subject: tree.subject }
      )
    }

    return {
      view: {
        state: 'installed',
        cliVersion: bundle.manifest.cliVersion,
        packages: bundle.manifest.packages,
        installedAt: bundle.manifest.createdAt
      },
      verified: { dir, manifest: bundle.manifest, snapshot: tree.snapshot }
    }
  }

  const check = (): Promise<AcpToolsView> => {
    if (installing) {
      return Promise.resolve(view)
    }

    if (checking && checking.generation === generation) {
      return checking.promise
    }

    const mine = generation

    const promise = fullCheck()
      .then(async ({ view: next, verified: tree, place: why }) => {
        // A check that started before a placement is stale: it never sets the view or the verified tree.
        if (mine !== generation || installing) {
          return next
        }

        if (why) {
          const answer = await place(why)

          return answer.ok ? answer.view : view
        }

        verified = tree

        if (next.state === 'unverified') {
          auditOnce('refuse', `acp tools: ${next.reason}${next.subject ? ` (${next.subject})` : ''}`)
        }

        emit(next)

        return next
      })
      .finally(() => {
        if (checking?.promise === promise) {
          checking = null
        }
      })

    checking = { generation: mine, promise }

    return promise
  }

  const runtimeOf = (tree: NonNullable<Checked['verified']>): AcpToolsRuntime => {
    const pkgDir = path.join(tree.dir, RUNTIME_DIR, 'node_modules', ...ACP_CLI_NAME.split('/'))

    return {
      dir: tree.dir,
      entry: path.join(pkgDir, 'dist', 'bin', 'acp.js'),
      launcher: deps.launcher,
      nodeModules: path.join(tree.dir, RUNTIME_DIR, 'node_modules'),
      pkg: path.join(pkgDir, 'package.json'),
      version: tree.manifest.cliVersion,
      treeSha256: tree.manifest.treeSha256
    }
  }

  const answerFor = (current: AcpToolsView): RuntimeAnswer => {
    switch (current.state) {
      case 'installed':
        return verified
          ? { ok: true, rt: runtimeOf(verified) }
          : { ok: false, code: 'unverified', reason: 'moved', error: problemText('unverified', 'moved') }

      case 'installing':
        return { ok: false, code: 'installing', reason: null, error: problemText('installing') }

      case 'unverified':
        return {
          ok: false,
          code: 'unverified',
          reason: current.reason,
          error: problemText('unverified', current.reason, current.subject)
        }

      case 'unavailable':
        return {
          ok: false,
          code: 'unavailable',
          reason: current.reason,
          error: problemText('unavailable', current.reason, current.subject)
        }

      default:
        return { ok: false, code: 'absent', reason: null, error: problemText('absent') }
    }
  }

  /** Spawns that ask at the same moment share one stat sweep (~12.6k paths, ~0.1 s on the real tree). */
  let quick: Promise<boolean> | null = null

  const quickCheck = (dir: string, marks: Snapshot): Promise<boolean> =>
    (quick ??= quickUnchanged(dir, marks).finally(() => {
      quick = null
    }))

  /**
   * Before EVERY spawn: the copy must be the verified one. Nothing moved since the last full check (stat of every file
   * and directory, inode/size/mtime/ctime/mode) passes at once; anything that moved gets a full check, whose verdict
   * stands (a changed copy is `unverified`: never re-placed behind the owner's back).
   */
  const runtime = async (): Promise<RuntimeAnswer> => {
    // v0.0.9: placing is a local copy from the app bundle (first run, v0.0.8 tree, Repair), never a download — a run
    // asked for meanwhile waits for it instead of failing with "being restored".
    if (installing) {
      await installing.promise.catch(() => undefined)

      return answerFor(view)
    }

    if (view.state === 'installed' && verified && (await quickCheck(verified.dir, verified.snapshot))) {
      strays()

      return answerFor(view)
    }

    return answerFor(await check())
  }

  const failedAnswer = (problem: AcpToolsProblemInfo): InstallAnswer => ({ ok: false, ...problem })

  const WHY: Record<PlaceWhy, string> = {
    'first-run': 'first run of this build',
    legacy: 'replacing the v0.0.8 npm install',
    repair: "the owner's Repair"
  }

  /**
   * Place the working copy from the bundle (no network): copy every listed file, each checked against the bundle's
   * manifest as it is read; prove the new copy; only then swap it in. Atomic: a failure, a cancel or a crash leaves no
   * partial copy (leftovers are swept on the next start) and the previous copy where it was.
   */
  const place = (why: PlaceWhy): Promise<InstallAnswer> => {
    if (installing) {
      return installing.promise
    }

    const pin = pinOf()

    if ('reason' in pin) {
      return Promise.resolve(failedAnswer({ reason: pin.reason }))
    }

    const bundle = bundleOf(pin)

    if ('absent' in bundle) {
      return Promise.resolve(
        failedAnswer(
          bundle.absent
            ? { reason: 'manifest-missing', subject: 'included copy' }
            : { reason: bundle.reason, ...(bundle.subject ? { subject: bundle.subject } : {}) }
        )
      )
    }

    if (why === 'repair') {
      placeFailure = null
      placeCancelled = false
    }

    const controller = new AbortController()
    const tmp = path.join(deps.root, `.install-${randomBytes(6).toString('hex')}`)
    const final = dirFor(pin.lockSha256)
    const files = Object.keys(bundle.manifest.files).length

    const promise = (async (): Promise<InstallAnswer> => {
      generation += 1
      emit({ state: 'installing', cliVersion: pin.cliVersion, phase: 'verify', done: 0, total: files, bytes: 0 })
      deps.audit?.({
        kind: 'use',
        reason: `acp tools: place the included ${ACP_CLI_NAME}@${pin.cliVersion} (${files} files, tree ${bundle.manifest.treeSha256.slice(0, 12)}) from the app bundle — ${WHY[why]}`
      })

      try {
        mkdirSync(deps.root, { recursive: true, mode: 0o700 })
        await copyBundle({
          from: bundleDir,
          to: tmp,
          manifest: bundle.manifest,
          manifestBytes: bundle.bytes,
          signal: controller.signal
        })

        // The new copy is proven BEFORE it replaces anything: a copy that does not verify never moves into place.
        const proof = await verifyTree(tmp, bundle.manifest)

        if (!proof.ok) {
          throw new AcpToolsError('new-tree-unverified', proof.subject, proof.reason)
        }

        if (controller.signal.aborted) {
          throw new Error('cancelled')
        }

        const trash = path.join(deps.root, `.trash-${randomBytes(6).toString('hex')}`)

        if (existsSync(final)) {
          renameSync(final, trash)
        }

        renameSync(tmp, final)
        // Tests-perf 5: the old tree (a v0.0.8 npm install: ~12.6k files) goes off the main thread.
        await fsp.rm(trash, { recursive: true, force: true }).catch(() => undefined)
        // From here a fresh check speaks for the new copy (critic m5): the generation moved, so a check started
        // before the rename can neither answer this placement nor set the view.
        generation += 1
        installing = null
        await sweep(pin.lockSha256)

        const next = await check()

        if (next.state !== 'installed') {
          const problem: AcpToolsProblemInfo =
            next.state === 'unverified' || next.state === 'unavailable'
              ? next.subject === undefined
                ? { reason: next.reason }
                : { reason: next.reason, subject: next.subject }
              : { reason: 'internal' }

          placeFailure = problem
          deps.audit?.({ kind: 'refuse', reason: `acp tools: the placed copy did not verify: ${problem.reason}` })
          emit({ ...next, lastError: problem })

          return failedAnswer(problem)
        }

        deps.audit?.({
          kind: 'use',
          reason: `acp tools: ${ACP_CLI_NAME}@${next.cliVersion} included and verified (${files} files, ${WHY[why]})`
        })
        deps.log(`[iclone-acp-tools] placed the included ${next.cliVersion} into ${final} (${WHY[why]})`)

        return { ok: true, view: next }
      } catch (error) {
        await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined)

        const cancelled = controller.signal.aborted
        const problem = problemOf(error)

        if (cancelled) {
          placeCancelled = true
        } else {
          placeFailure = problem
        }

        deps.audit?.({
          kind: 'refuse',
          reason: `acp tools: placing the included copy ${cancelled ? 'cancelled' : `failed: ${problem.reason}${problem.subject ? ` (${problem.subject})` : ''}`}`
        })
        deps.log(`[iclone-acp-tools] placing the included copy ${cancelled ? 'cancelled' : `failed: ${logText(error)}`}`)
        generation += 1
        installing = null

        const after = await check()

        emit(cancelled ? after : { ...after, lastError: problem })

        return cancelled ? { ok: false, cancelled: true } : failedAnswer(problem)
      } finally {
        installing = null
      }
    })()

    installing = { controller, promise }

    return promise
  }

  /**
   * The verified copy's NOTICES.md (the pin's table, then every package's licence texts), as a read-only COPY outside
   * the tree (critic nit: an editor that saved the original would make the tree unverified). Only while the copy is
   * the verified one, and only the manifest's bytes.
   */
  const noticesFile = (): string | null => {
    if (view.state !== 'installed' || !verified) {
      return null
    }

    try {
      const data = readFileSync(path.join(verified.dir, NOTICES_FILE))
      const sha = sha256Hex(data)

      if (verified.manifest.files[NOTICES_FILE]?.sha256 !== sha) {
        return null
      }

      // m-r5-4: the copy lives in a folder of ours (a real 0700 folder, never a link) and is re-hashed before EVERY
      // open: a name planted or swapped there (a link, a fifo, other bytes) is never what the user's click opens.
      const dir = path.join(os.tmpdir(), 'iclone-acp-notices')
      const copy = path.join(dir, `NOTICES-${sha.slice(0, 12)}.md`)

      if (!ownedFolder(dir)) {
        return null
      }

      if (!sameRegularFile(copy, sha)) {
        rmSync(copy, { force: true })
        writeFileSync(copy, data, { mode: 0o444, flag: 'wx' })

        if (!sameRegularFile(copy, sha)) {
          return null
        }
      }

      return copy
    } catch {
      return null
    }
  }

  return {
    view: (): AcpToolsView => view,
    /** The pin's CLI version, without touching the tree. */
    cliVersion,
    /** Full check now (startup, Settings): sweeps leftovers of an interrupted placement first. */
    refresh: (): Promise<AcpToolsView> => {
      return (installing ? Promise.resolve() : sweepLeftovers(deps.root)).then(() => check())
    },
    /** v0.0.9: the owner's Repair — restore the working copy from the bundle, offline. (Name kept for the IPC.) */
    install: (): Promise<InstallAnswer> => place('repair'),
    cancel: (): boolean => {
      if (!installing) {
        return false
      }

      installing.controller.abort()

      return true
    },
    runtime,
    /** A cheap answer for paths that must not touch the disk (the last verdict, never "installed" without a check). */
    problem: (): string | null => {
      const answer = answerFor(view)

      return answer.ok ? null : answer.error
    },
    noticesFile,
    /** The launcher reported something (scripts/acp-launch.cjs over the utility process's port): audit it once. */
    launcherReport: (report: { type: 'escape' | 'integrity'; what: string }): void => {
      if (report.type === 'escape') {
        auditOnce('refuse', `acp tools: refused a module outside the verified tree (${report.what})`)
      } else {
        auditOnce('refuse', `acp tools: a file changed after the check and was refused at load (${report.what})`)
        // The next spawn must not trust the snapshot: a full check decides.
        verified = null
        void check()
      }
    },
    /** Remove other pins' copies (after a verified placement of the current one). */
    sweep: (): Promise<void> => {
      const pin = pinOf()

      return sweep('reason' in pin ? null : pin.lockSha256)
    }
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Leftovers of an interrupted placement, off the main thread (names read once, before the first await). */
async function sweepLeftovers(root: string): Promise<void> {
  for (const name of readdirSafe(root)) {
    if (name.startsWith('.install-') || name.startsWith('.trash-')) {
      await fsp.rm(path.join(root, name), { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

export type AcpTools = ReturnType<typeof createAcpTools>

/** A folder only this user owns and enters, made if missing; false for a link, a file or anyone else's folder. */
function ownedFolder(dir: string): boolean {
  mkdirSync(dir, { recursive: true, mode: 0o700 })

  const stat = lstatSync(dir)

  if (!stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    return false
  }

  chmodSync(dir, 0o700)

  return true
}

/** `file` is a regular, single-linked file of this user whose bytes hash to `sha` (read without following a link). */
function sameRegularFile(file: string, sha: string): boolean {
  let fd: null | number = null

  try {
    const stat = lstatSync(file)

    if (!stat.isFile() || stat.nlink !== 1 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      return false
    }

    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)

    const opened = fstatSync(fd)

    return opened.ino === stat.ino && opened.dev === stat.dev && sha256Hex(readFileSync(fd)) === sha
  } catch {
    return false
  } finally {
    if (fd !== null) {
      closeSync(fd)
    }
  }
}
