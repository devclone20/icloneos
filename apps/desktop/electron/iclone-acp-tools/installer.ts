/**
 * REL-6 (ruling 26) — the app-owned installer of the Virtuals ACP CLI. The app ships no CLI; on the owner's click it
 * installs the pinned tree from the npm registry into `userData/acp-cli/<sha256 of package-lock.json>/`, and every
 * ACP spawn goes through `runtime()`, which verifies that tree first and refuses (with the reason) when it is absent,
 * changed, or installed from another pin. Same shape as the Hermes runtime pin: fetch, verify, fail closed.
 *
 * WHY NOT `npm ci`. The app has no npm (and Electron's RunAsNode fuse is off, so it cannot run one). Requiring a system
 * Node/npm would put an unknown tool of unknown version, found on PATH, on the install path. What `npm ci
 * --ignore-scripts --omit=dev` does with a lockfile is: fetch each row's `resolved`, check its `integrity`, extract it
 * at the row's path. This module does exactly that, stricter: only https://registry.npmjs.org/ tarballs of the row's
 * own name and version (acp-pin.ts), sha512 required, redirects refused, only the CLI's runtime closure for this
 * platform (build tooling such as esbuild is never fetched), the same per-file prune the shipped tree had.
 *
 * WHY NO INSTALL SCRIPTS (`--ignore-scripts`). Nothing in the closure needs one, and none ever runs: bufferutil and
 * utf-8-validate (node-gyp-build) ship N-API prebuilds that load from `prebuilds/<platform>-<arch>` at run time, and
 * ws falls back to JS without them; es5-ext's postinstall only prints a message; esbuild and fsevents are build
 * tooling outside the closure. The CLI's one native artefact that must work, its Go signer
 * (`bin/acp-cli-signer-<os>`, published inside the npm package itself), is installed with its exec bit set
 * explicitly and covered by the package's sha512 and by the manifest.
 *
 * ATOMIC. The tree is built in `.install-<random>/`, checked against the manifest it just wrote, then renamed into
 * place; a cancel, a failure or a crash leaves no partial tree (leftovers are swept on the next start).
 *
 * SEALED OR NOTHING (round 2, critic M2 + lead ruling on m7). The manifest's MAC needs the OS-sealed key: a session
 * that cannot seal gets `unavailable · unsealable` (no install, no run), and a key that cannot be opened makes the
 * tree `unverified · key-unopenable`. The record of the install lives in V3-F's protected state (record.ts).
 *
 * CONFINED (round 2, critic M1). The tree is only as good as what Node loads from it: our launcher
 * (scripts/acp-launch.cjs) refuses any module that resolves outside `runtime/node_modules`, for require and import
 * alike, and hashes every file it loads against this manifest. What a check finds planted in the app-owned folders
 * above the tree is audited (never deleted, never loaded).
 *
 * NATIVE ADD-ONS (ruling 33): native.ts swaps the app's own copies in before the manifest is written.
 */
import { createHash, randomBytes } from 'node:crypto'
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

import {
  ACP_CLI_NAME,
  type AcpPin,
  installsFile,
  isLegalText,
  parsePin,
  type PinRow,
  type PinTarget,
  runtimeClosure,
  signerFor,
  targetName
} from '../../src/iclone-shared/acp-pin'
import type { AcpToolsProblemInfo, AcpToolsReason, AcpToolsView } from '../../src/iclone-shared/acp-tools'
import { isAtomicTempName } from '../lib/atomic-write'

import { AcpToolsError, logText, problemOf } from './errors'
import {
  type AcpManifest,
  createManifestKey,
  KEY_FILE,
  type KeySealer,
  MANIFEST_FILE,
  type ManifestEntry,
  openManifestKey,
  quickUnchanged,
  readManifest,
  sha256Hex,
  signManifest,
  type Snapshot,
  treeDigest,
  verifyTree
} from './manifest'
import { addonsDigest, type NativeAddons, swapAddons } from './native'
import { type InstallRecordStore, recordMatches, recordOf } from './record'
import { gunzipAsync, readTar, type TarFile } from './tar'

export const NOTICES_FILE = 'NOTICES.md'
const RUNTIME_DIR = 'runtime'
const DOWNLOAD_CONCURRENCY = 8
/** Largest unpacked tarball accepted (the CLI's own, with three signer binaries, is ~40 MB). */
const MAX_UNPACKED = 256 * 1024 * 1024
const PROGRESS_MS = 120
const HEX64 = /^[0-9a-f]{64}$/

export interface AcpToolsAudit {
  kind: 'refuse' | 'use' | 'gap'
  reason: string
}

export interface AcpToolsDeps {
  /** `userData/acp-cli`. */
  root: string
  /** The shipped pin: `package.json` + `package-lock.json` (Resources/acp-pin, or acp-cli-lock in a dev run). */
  pinDir: string
  /** Our own launcher (Resources/acp-pin/launch.cjs, or scripts/acp-launch.cjs in a dev run). */
  launcher: string
  target: PinTarget
  /** One registry GET; must refuse redirects, time out a stalled body and honour the signal (net-core.ts). */
  fetch(url: string, signal: AbortSignal): Promise<Buffer>
  /** The OS sealing (safeStorage). Null: this OS or session cannot seal, so nothing installs and nothing runs. */
  sealer: KeySealer | null
  /** FX-2: why there is no sealer, for the owner: the Keychain setting is off (default 'unsealable': the OS cannot). */
  noSealReason?: 'keychain-off' | 'unsealable'
  /** "This app installed this tree", in V3-F's protected state (record.ts). */
  record: InstallRecordStore
  /** Ruling 33: the app's own native add-ons for this target. */
  native: NativeAddons
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
  pin: AcpPin
  lockSha256: string
  rows: PinRow[]
}

const sri512 = (data: Buffer) => `sha512-${createHash('sha512').update(data).digest('base64')}`

const SENTENCE: Record<AcpToolsProblem, string> = {
  absent: 'ACP tools are not installed: install them from ACP Market (downloads from npm)',
  installing: 'ACP tools are being installed',
  unverified: 'ACP tools could not be verified: reinstall them from ACP Market',
  unavailable: 'ACP tools cannot be installed here'
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
 * it names the same entry AND the same manifest digest (a reinstall keeps the path but changes the tree).
 */
export function sameTree(
  now: { entry: string; treeSha256: string },
  then: { entry: string; treeSha256: string }
): boolean {
  return now.entry === then.entry && now.treeSha256 === then.treeSha256
}

/** What a check found: the view, and (installed only) the verified tree it may hand to a spawn. */
interface Checked {
  view: AcpToolsView
  verified: { dir: string; manifest: AcpManifest; snapshot: Snapshot } | null
}

export function createAcpTools(deps: AcpToolsDeps) {
  const now = deps.now ?? (() => new Date())
  let loaded: LoadedPin | { reason: AcpToolsReason } | null = null
  let view: AcpToolsView = { state: 'checking', cliVersion: null }
  let verified: Checked['verified'] = null
  let installing: { controller: AbortController; promise: Promise<InstallAnswer> } | null = null
  /** Bumped by every install: a check started before it never speaks for the tree after it (critic m5). */
  let generation = 0
  let checking: { generation: number; promise: Promise<AcpToolsView> } | null = null
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
    if (loaded) {
      return loaded
    }

    try {
      const lockText = readFileSync(path.join(deps.pinDir, 'package-lock.json'), 'utf8')
      const pin = parsePin(readFileSync(path.join(deps.pinDir, 'package.json'), 'utf8'), lockText)

      loaded = existsSync(deps.launcher)
        ? { pin, lockSha256: sha256Hex(lockText), rows: runtimeClosure(pin, deps.target) }
        : { reason: 'launcher-missing' }
    } catch (error) {
      deps.log(`[iclone-acp-tools] the pin does not parse: ${logText(error)}`)
      loaded = { reason: 'pin-invalid' }
    }

    return loaded
  }

  const dirFor = (lockSha256: string) => path.join(deps.root, lockSha256)

  const cliVersion = () => {
    const pin = pinOf()

    return 'reason' in pin ? null : pin.pin.cliVersion
  }

  /** Other pins' trees and every leftover of an interrupted install. Never the current pin's tree. */
  const sweep = (keep: string | null) => {
    if (!existsSync(deps.root)) {
      return
    }

    for (const name of readdirSafe(deps.root)) {
      const leftover = name.startsWith('.install-') || name.startsWith('.trash-')

      if ((leftover && !installing) || (HEX64.test(name) && name !== keep)) {
        rmSync(path.join(deps.root, name), { recursive: true, force: true })
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

  /** Full check of the current pin's tree. Never throws; touches no shared state (check() applies its result). */
  const fullCheck = async (): Promise<Checked> => {
    await deps.beforeCheck?.()

    const pin = pinOf()

    if ('reason' in pin) {
      return { view: { state: 'unavailable', cliVersion: null, reason: pin.reason }, verified: null }
    }

    const version = pin.pin.cliVersion

    if (!deps.sealer) {
      // Lead ruling on m7: no OS seal, no install and no run (there is no unsealed tree in 0.0.3).
      return {
        view: { state: 'unavailable', cliVersion: version, reason: deps.noSealReason ?? 'unsealable' },
        verified: null
      }
    }

    strays()

    const dir = dirFor(pin.lockSha256)

    if (!existsSync(dir)) {
      return {
        view: { state: 'absent', cliVersion: version, stale: readdirSafe(deps.root).some(name => HEX64.test(name)) },
        verified: null
      }
    }

    const key = openManifestKey(deps.root, deps.sealer)

    if (!key.ok) {
      return unverified(version, { reason: key.reason })
    }

    const read = readManifest(dir, key.key)

    if (!read.ok) {
      return unverified(version, { reason: read.reason })
    }

    const { manifest } = read

    if (manifest.lockSha256 !== pin.lockSha256 || manifest.target !== targetName(deps.target)) {
      return unverified(version, { reason: 'other-pin' })
    }

    // Critic r2 m4: an install made with another app build's add-ons (a replay of an earlier install of this pin, or
    // an app update that changed them) is not this app's: reinstall.
    if (manifest.addons !== addonsDigest(deps.native)) {
      return unverified(version, { reason: 'other-pin' })
    }

    if (!recordMatches(deps.record.read(), manifest)) {
      return unverified(version, { reason: 'not-recorded' })
    }

    const tree = await verifyTree(dir, manifest)

    if (!tree.ok) {
      return unverified(
        version,
        tree.subject === undefined ? { reason: tree.reason } : { reason: tree.reason, subject: tree.subject }
      )
    }

    return {
      view: {
        state: 'installed',
        cliVersion: manifest.cliVersion,
        packages: manifest.packages,
        installedAt: manifest.createdAt
      },
      verified: { dir, manifest, snapshot: tree.snapshot }
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
      .then(({ view: next, verified: tree }) => {
        // A check that started before an install is stale: it never sets the view or the verified tree.
        if (mine !== generation || installing) {
          return next
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
   * Before EVERY spawn: the tree must be the verified one. Nothing moved since the last full check (stat of every
   * file and directory, inode/size/mtime/ctime/mode) passes at once; anything that moved gets a full check, whose
   * verdict stands.
   */
  const runtime = async (): Promise<RuntimeAnswer> => {
    if (installing) {
      return answerFor(view)
    }

    if (view.state === 'installed' && verified && (await quickCheck(verified.dir, verified.snapshot))) {
      strays()

      return answerFor(view)
    }

    return answerFor(await check())
  }

  const fetchRow = async (row: PinRow, signal: AbortSignal): Promise<TarFile[]> => {
    if (signal.aborted) {
      throw new Error('cancelled')
    }

    const subject = `${row.name}@${row.version}`
    const tgz = await deps.fetch(row.resolved, signal)

    if (sri512(tgz) !== row.integrity) {
      throw new AcpToolsError('integrity', subject, 'the tarball does not match the lockfile’s sha512')
    }

    try {
      return readTar(await gunzipAsync(tgz, MAX_UNPACKED))
    } catch (error) {
      throw new AcpToolsError('tar-unsafe', subject, logText(error))
    }
  }

  const noticeFor = (row: PinRow, legal: { path: string; text: string }[]) => {
    const head = `## ${row.name} ${row.version} — ${row.license ?? 'no licence declared'}`

    if (legal.length === 0) {
      return `${head}\n\nThe package carries no licence file.\n`
    }

    return (
      [head, ...legal.map(file => `### ${file.path}\n\n\`\`\`\`text\n${file.text.trimEnd()}\n\`\`\`\``)].join('\n\n') +
      '\n'
    )
  }

  const build = async (pin: LoadedPin, tmp: string, signal: AbortSignal) => {
    const files: Record<string, ManifestEntry> = {}
    const notices: string[] = []
    const total = pin.rows.length
    let done = 0
    let bytes = 0
    const signer = `bin/${signerFor(deps.target.platform)}`

    const put = async (rel: string, data: Buffer, mode: number) => {
      const abs = path.join(tmp, ...rel.split('/'))

      await fsp.mkdir(path.dirname(abs), { recursive: true, mode: 0o755 })
      await fsp.writeFile(abs, data, { mode })
      await fsp.chmod(abs, mode)
      files[rel] = { sha256: sha256Hex(data), size: data.length, mode }
    }

    const noticesByKey = new Map<string, string>()
    let next = 0
    let failure: unknown = null

    const worker = async () => {
      while (next < pin.rows.length && !failure) {
        const row = pin.rows[next++] as PinRow
        const subject = `${row.name}@${row.version}`

        try {
          const entries = await fetchRow(row, signal)
          const legal: { path: string; text: string }[] = []

          for (const file of entries) {
            if (!installsFile(row, file.path, deps.target)) {
              continue
            }

            if (file.path.split('/').some(part => part.toLowerCase() === 'node_modules')) {
              throw new AcpToolsError('nested-modules', subject, `it carries its own node_modules (${file.path})`)
            }

            const isSigner = row.name === ACP_CLI_NAME && file.path === signer

            await put(`${RUNTIME_DIR}/${row.key}/${file.path}`, file.data, isSigner ? 0o755 : file.mode)

            if (!file.path.includes('/') && isLegalText(file.path)) {
              legal.push({ path: file.path, text: file.data.toString('utf8') })
            }

            bytes += file.data.length
          }

          // Ruling 28: a package that names a licence FILE instead of a licence (`SEE LICENSE IN LICENSE`, the Segment
          // packages among them) installs only with that file; without it the whole install is refused.
          const named = /^SEE LICEN[CS]E IN (.+)$/i.exec(row.license ?? '')?.[1]?.trim()

          if (named && !legal.some(file => file.path.toLowerCase() === named.toLowerCase())) {
            throw new AcpToolsError('licence-file-missing', subject, `it names its licence file ${named} and has none`)
          }

          noticesByKey.set(row.key, noticeFor(row, legal))
          done += 1
          emit({ state: 'installing', cliVersion: pin.pin.cliVersion, phase: 'download', done, total, bytes }, false)
        } catch (error) {
          failure ??= error
        }
      }
    }

    await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker))

    if (signal.aborted) {
      throw new Error('cancelled')
    }

    if (failure) {
      throw failure
    }

    for (const row of pin.rows) {
      notices.push(noticesByKey.get(row.key) as string)
    }

    const cliSigner = path.join(tmp, RUNTIME_DIR, 'node_modules', ...ACP_CLI_NAME.split('/'), ...signer.split('/'))

    if (!existsSync(cliSigner)) {
      throw new AcpToolsError('signer-missing', `${ACP_CLI_NAME}@${pin.pin.cliVersion}`)
    }

    // Ruling 33: the app's own (Team-signed in a release) add-ons replace npm's, before the manifest is written.
    const { swapped, digest } = await swapAddons({
      native: deps.native,
      target: targetName(deps.target),
      lockSha256: pin.lockSha256,
      tmp,
      runtimeDir: RUNTIME_DIR,
      files,
      log: deps.log
    })

    await put(NOTICES_FILE, Buffer.from(noticesText(pin, swapped, notices)), 0o644)

    emit({ state: 'installing', cliVersion: pin.pin.cliVersion, phase: 'verify', done: total, total, bytes })

    return { files, addons: digest }
  }

  const noticesText = (pin: LoadedPin, swapped: number, notices: string[]) => {
    const signer = signerFor(deps.target.platform)

    return [
      `# ACP tools — licences of the installed packages`,
      '',
      `Installed by iclone os from https://registry.npmjs.org/ on ${now().toISOString()} for ${targetName(deps.target)}:`,
      `${ACP_CLI_NAME} ${pin.pin.cliVersion} and its runtime packages (${pin.rows.length}), each under its own`,
      'licence as published on npm. iclone os does not redistribute them. Below: each package, the licence it declares,',
      'and the licence files it ships.',
      '',
      `The Go signer \`bin/${signer}\` is a program published inside ${ACP_CLI_NAME} on npm; iclone os did not build`,
      'it and holds no source for it. It is installed only because it comes inside that package, whose bytes the',
      'lockfile’s sha512 and this install’s manifest pin, and it runs as a separate program.',
      deps.target.platform === 'darwin'
        ? 'It is written without the macOS quarantine flag (and the CLI itself runs `xattr -d com.apple.quarantine` on it' +
          ' before use), so Gatekeeper does not assess it when it runs.'
        : '',
      swapped > 0
        ? `The ${swapped} native add-on file(s) of @napi-rs/keyring, bufferutil and utf-8-validate (MIT) are the copies this app ships, made from the same versions and signed by its developer, in place of npm's copies; their licence notices, with the Rust crates linked into the keyring binding, are in THIRD_PARTY_NOTICES.md ("ACP native add-ons") and beside them in the app (Resources/acp-native).`
        : '',
      ''
    ]
      .filter((line, index, all) => line !== '' || all[index - 1] !== '')
      .join('\n')
      .concat('\n', notices.join('\n'))
  }

  const failedAnswer = (problem: AcpToolsProblemInfo): InstallAnswer => ({ ok: false, ...problem })

  const install = (): Promise<InstallAnswer> => {
    if (installing) {
      return installing.promise
    }

    const pin = pinOf()

    if ('reason' in pin) {
      return Promise.resolve(failedAnswer({ reason: pin.reason }))
    }

    const controller = new AbortController()
    const tmp = path.join(deps.root, `.install-${randomBytes(6).toString('hex')}`)
    const final = dirFor(pin.lockSha256)

    const promise = (async (): Promise<InstallAnswer> => {
      generation += 1
      emit({
        state: 'installing',
        cliVersion: pin.pin.cliVersion,
        phase: 'download',
        done: 0,
        total: pin.rows.length,
        bytes: 0
      })
      deps.audit?.({
        kind: 'use',
        reason: `acp tools: install ${ACP_CLI_NAME}@${pin.pin.cliVersion} (${pin.rows.length} packages, lock ${pin.lockSha256.slice(0, 12)}) from registry.npmjs.org`
      })

      try {
        // Lead ruling on m7: an OS or session that cannot seal gets no install (refused before any fetch).
        const key = createManifestKey(deps.root, deps.sealer)

        if (!key.ok) {
          throw new AcpToolsError(key.reason)
        }

        await fsp.mkdir(tmp, { recursive: true, mode: 0o700 })

        const { files, addons } = await build(pin, tmp, controller.signal)

        const manifest: AcpManifest = signManifest(
          {
            v: 1,
            lockSha256: pin.lockSha256,
            cliVersion: pin.pin.cliVersion,
            target: targetName(deps.target),
            createdAt: now().toISOString(),
            packages: pin.rows.length,
            addons,
            files,
            treeSha256: treeDigest(files)
          },
          key.key
        )

        await fsp.writeFile(path.join(tmp, MANIFEST_FILE), `${JSON.stringify(manifest)}\n`, { mode: 0o644 })

        // The new tree is proven BEFORE it replaces anything: a tree that does not verify never moves into place.
        const proof = await verifyTree(tmp, manifest)

        if (!proof.ok) {
          throw new AcpToolsError('new-tree-unverified', proof.subject, proof.reason)
        }

        if (controller.signal.aborted) {
          throw new Error('cancelled')
        }

        try {
          deps.record.write(recordOf(manifest, now().toISOString()))
        } catch (error) {
          throw new AcpToolsError('record-unwritable', undefined, logText(error))
        }

        const trash = path.join(deps.root, `.trash-${randomBytes(6).toString('hex')}`)

        if (existsSync(final)) {
          renameSync(final, trash)
        }

        renameSync(tmp, final)
        rmSync(trash, { recursive: true, force: true })
        // From here a fresh check speaks for the new tree (critic m5): the generation moved, so a check started
        // before the rename can neither answer this install nor set the view.
        generation += 1
        installing = null
        sweep(pin.lockSha256)

        const next = await check()

        if (next.state !== 'installed') {
          const problem: AcpToolsProblemInfo =
            next.state === 'unverified' || next.state === 'unavailable'
              ? next.subject === undefined
                ? { reason: next.reason }
                : { reason: next.reason, subject: next.subject }
              : { reason: 'internal' }

          deps.audit?.({ kind: 'refuse', reason: `acp tools: the installed tree did not verify: ${problem.reason}` })
          emit({ ...next, lastError: problem })

          return failedAnswer(problem)
        }

        deps.audit?.({
          kind: 'use',
          reason: `acp tools: installed ${ACP_CLI_NAME}@${next.cliVersion} and verified ${Object.keys(files).length} files (sealed)`
        })
        deps.log(`[iclone-acp-tools] installed ${next.cliVersion} (${pin.rows.length} packages) into ${final}`)

        return { ok: true, view: next }
      } catch (error) {
        rmSync(tmp, { recursive: true, force: true })

        const cancelled = controller.signal.aborted
        const problem = problemOf(error)

        deps.audit?.({
          kind: 'refuse',
          reason: `acp tools: install ${cancelled ? 'cancelled' : `failed: ${problem.reason}${problem.subject ? ` (${problem.subject})` : ''}`}`
        })
        deps.log(`[iclone-acp-tools] install ${cancelled ? 'cancelled' : `failed: ${logText(error)}`}`)
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
   * The installed tree's NOTICES.md, as a read-only COPY outside the tree (critic nit: an editor that saved the
   * original would make the tree unverified). Only while the tree is the verified one, and only its manifest's bytes.
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
    /** Full check now (startup, Settings): sweeps leftovers of an interrupted install first. */
    refresh: (): Promise<AcpToolsView> => {
      if (!installing) {
        sweepLeftovers(deps.root)
      }

      return check()
    },
    install,
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
    /** Remove other pins' trees (after a verified install of the current one). */
    sweep: () => {
      const pin = pinOf()

      sweep('reason' in pin ? null : pin.lockSha256)
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

function sweepLeftovers(root: string) {
  for (const name of readdirSafe(root)) {
    if (name.startsWith('.install-') || name.startsWith('.trash-')) {
      rmSync(path.join(root, name), { recursive: true, force: true })
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
