/**
 * V3-G — the Seatbelt backend: one generated SBPL text per activity class, run with `sandbox-exec -p <text> -D …`
 * (the text main generated and holds, never re-read from disk between check and use). The files on disk are for the
 * Hermes plugin, which accepts one only if it hashes to what main handed it at spawn (`pluginSpec`). The confined shell is `/bin/bash -c '<command>; exit $?' <marker>`: the trailing statement stops bash from
 * exec-ing the command away, so the marker stays visible in `ps` for the whole run, and every child inherits the
 * sandbox (Seatbelt cannot be left from inside).
 */
import { spawn as spawnChild } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import type {
  ActivityClass,
  BackendStatusView,
  ConfinedProcessView,
  HardlinkBlockView,
  KillResultView,
  ProfileView
} from '../../src/iclone-shared/confinement'
import { writeFileAtomicSync } from '../lib/atomic-write'

import { type ConfinementBackend, confinementMarker, type SpawnRequest, type SpawnResult } from './backend'
import { hardlinkFiles, type HardlinkGuard, hardlinkRefusal } from './hardlinks'
import { newRunToken } from './members'
import { probeSeatbelt, SANDBOX_EXEC } from './probe'
import {
  acceptableProjectRoot,
  buildAllProfileSpecs,
  type ConfinementPaths,
  type ProfileSpec,
  realOrSelf
} from './profiles'
import { auditSbpl, renderSbpl } from './sbpl'
import { confinedProcesses, type KnownProfile, type Snapshot } from './state'

/** A hard link (or an unlistable directory) found in `root` when run `pid` exited: detected, not prevented. */
export interface HardlinkAppearedEvent {
  root: string
  block: HardlinkBlockView
  pid: number
  sessionId: string | null
}

export interface GeneratedProfile {
  spec: ProfileSpec
  text: string
  sha256: string
  file: string
}

const sha256Of = (text: string) => createHash('sha256').update(text).digest('hex')

export function generateProfiles(paths: ConfinementPaths): GeneratedProfile[] {
  mkdirSync(paths.profilesDir, { recursive: true, mode: 0o700 })

  return buildAllProfileSpecs(paths).map(spec => {
    const text = renderSbpl(spec)
    const sha256 = sha256Of(text)
    const file = path.join(paths.profilesDir, `${spec.cls}.sb`)

    writeFileAtomicSync(file, text, { mode: 0o600, dirMode: 0o700 })

    return { spec, text, sha256, file }
  })
}

/**
 * What the Hermes plugin may trust, handed over in its spawn env (`ICLONE_CONFINEMENT_SPEC`, popped at import): the
 * expected hash of every profile and the facts the project rule needs. Integrity, not a secret. Nothing the plugin
 * trusts is read from a folder another process can write: a profile file whose hash differs is refused.
 */
export function pluginSpec(
  paths: ConfinementPaths,
  generated: readonly GeneratedProfile[],
  pnpmStoreRoots: readonly string[] = []
): string {
  return JSON.stringify({
    // r5: 5 = the store roots are denied-filtered here and judged real and store-shaped where they are walked; a
    // plugin reading an older spec keeps the gesture path for every link.
    v: 5,
    profilesDir: realOrSelf(paths.profilesDir),
    scratchRoot: realOrSelf(paths.scratchRoot),
    membersDir: realOrSelf(paths.membersDir),
    home: realOrSelf(paths.home),
    denied: generated[0]?.spec.denied ?? [],
    // F7: the owner's signed acknowledgements (verified with the key in ICLONE_CONFINEMENT_LINK_KEY) and where the
    // plugin reports a project it refused.
    hardlinkAcks: hardlinkFiles(paths.userDataDir).acks,
    hardlinkReport: hardlinkFiles(paths.userDataDir).report,
    // T3: where the plugin writes a refusal-class row when a link appeared during a run it ran.
    refusalsDir: path.join(paths.userDataDir, 'confinement', 'refusals'),
    // T2'': the pnpm store roots a `build` command may be linked into without a gesture (hardlinks.ts).
    pnpmStoreRoots,
    sha256: Object.fromEntries(generated.map(item => [item.spec.cls, item.sha256]))
  })
}

export function profileView(profile: GeneratedProfile): ProfileView {
  const { spec } = profile

  return {
    cls: spec.cls,
    sha256: profile.sha256,
    network: spec.network,
    reads: ['project', 'scratch', ...(spec.paramReads.includes('OUTPUT_DIR') ? ['output'] : []), ...spec.extraReads],
    writes: [
      'scratch',
      ...(spec.projectWrites ? ['project (unless the mode is Plan)'] : []),
      ...(spec.paramWrites.includes('OUTPUT_DIR') ? ['output'] : []),
      ...spec.extraWrites
    ],
    denied: [...spec.denied, ...spec.deniedGlobs]
  }
}

export const knownProfile = (profile: GeneratedProfile): KnownProfile => ({
  cls: profile.spec.cls,
  sha256: profile.sha256,
  widened: auditSbpl(profile.text).widened,
  generated: true
})

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * What each profile file holds right now. A file that no longer matches what main generated is reported (the state
 * reads RED) and described, so a process launched under it is recognised as widened rather than merely unknown.
 */
export function profilesOnDisk(generated: readonly GeneratedProfile[]): {
  tampered: ActivityClass[]
  variants: KnownProfile[]
} {
  const tampered: ActivityClass[] = []
  const variants: KnownProfile[] = []

  for (const profile of generated) {
    const text = readText(profile.file)

    if (text === profile.text) {
      continue
    }

    tampered.push(profile.spec.cls)

    if (text !== null) {
      variants.push({
        cls: profile.spec.cls,
        sha256: sha256Of(text),
        widened: auditSbpl(text).widened,
        generated: false
      })
    }
  }

  return { tampered, variants }
}

const shellQuote = (arg: string) => `'${arg.replace(/'/g, `'\\''`)}'`

function scratchFor(paths: ConfinementPaths, sessionId: string | null | undefined): string {
  const name = sessionId && /^[A-Za-z0-9_.-]{1,64}$/.test(sessionId) ? sessionId : 'default'
  const dir = path.join(realOrSelf(paths.scratchRoot), name)

  mkdirSync(path.join(dir, 'tmp'), { recursive: true, mode: 0o700 })

  return dir
}

interface SeatbeltDeps {
  paths: ConfinementPaths
  profiles: () => readonly GeneratedProfile[]
  /** A fresh `ps` with the kernel's membership answer (state.ts `withMembership`). Kill re-reads it every round. */
  scan: () => Promise<Snapshot>
  probe?: () => Promise<BackendStatusView>
  /** F7: refuses a project with hard links to outside inodes the owner did not acknowledge (hardlinks.ts). */
  hardlinks: Pick<HardlinkGuard, 'check'>
  /** r6: the pnpm store roots (`pnpmStoreRoots`): a store, or a folder inside one, is never a project. */
  storeRoots?: readonly string[]
  /** T3: the scan after a run's exit found what the pre-start scan could not (a link planted during the run). */
  onHardlinkAppeared?: (event: HardlinkAppearedEvent) => void
  /** Test seam: the binary that applies the profile. */
  sandboxExec?: string
}

/** SIGTERM first: a well-behaved tree gets this long to exit on its own. */
const TERM_GRACE_MS = 1_500
/** Then SIGSTOP + SIGKILL rounds, each followed by a fresh scan, until a scan finds none of the run alive. */
const KILL_ROUNDS = 40
const ROUND_PAUSE_MS = 50

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function send(pids: Iterable<number>, signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      // already gone
    }
  }
}

export function createSeatbeltBackend(deps: SeatbeltDeps): ConfinementBackend {
  const known = () => deps.profiles().map(knownProfile)

  const list = (snapshot: Snapshot): ConfinedProcessView[] =>
    confinedProcesses(snapshot.rows, known(), snapshot.verified)

  return {
    id: 'seatbelt',
    probe: () => (deps.probe ?? probeSeatbelt)(),
    spawn(request: SpawnRequest): SpawnResult {
      const profile = deps.profiles().find(item => item.spec.cls === request.cls)

      if (!profile) {
        return { ok: false, error: `no generated profile for class ${request.cls}` }
      }

      if (request.argv.length === 0) {
        return { ok: false, error: 'empty command' }
      }

      const scratch = scratchFor(deps.paths, request.sessionId)

      const project =
        request.projectRoot &&
        acceptableProjectRoot(request.projectRoot, profile.spec, deps.paths.home, deps.storeRoots)
          ? realOrSelf(request.projectRoot)
          : scratch

      // F7: the project and the scratch (T1: scratch too; it is small and main owns it) are scanned before the start.
      const roots = project === scratch ? [scratch] : [project, scratch]

      for (const root of roots) {
        const links = deps.hardlinks.check(root, request.cls)

        if (!links.ok) {
          return { ok: false, error: hardlinkRefusal(links.block), hardlinks: links.block }
        }
      }

      const token = newRunToken(deps.paths.membersDir, request.cls, profile.sha256, request.sessionId)

      const params: Record<string, string> = {
        PROJECT_ROOT: project,
        SCRATCH: scratch,
        NET: request.network && profile.spec.network === 'grant' ? '1' : '0',
        WRITE_PROJECT: request.writeProject && project !== scratch ? '1' : '0',
        OUTPUT_DIR: realOrSelf(request.outputDir ?? path.join(scratch, 'output')),
        MEMBER: token.file
      }

      mkdirSync(params.OUTPUT_DIR, { recursive: true, mode: 0o700 })

      const marker = confinementMarker(request.cls, profile.sha256, request.sessionId)
      const script = `${request.argv.map(shellQuote).join(' ')}; exit $?`
      const defines = Object.entries(params).flatMap(([key, value]) => ['-D', `${key}=${value}`])

      const child = spawnChild(
        deps.sandboxExec ?? SANDBOX_EXEC,
        ['-p', profile.text, ...defines, '/bin/bash', '-c', script, marker],
        {
          cwd: request.cwd,
          detached: true,
          env: {
            ...request.env,
            TMPDIR: path.join(scratch, 'tmp'),
            GIT_CONFIG_GLOBAL: path.join(scratch, '.gitconfig')
          },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )

      if (child.pid === undefined) {
        return { ok: false, error: 'sandbox-exec did not start' }
      }

      // T3: a link planted while the command ran was readable to it (Seatbelt has no inode filter). The scan after
      // the exit cannot undo that; it records it, and the next run in that root is refused like any other.
      const pid = child.pid

      child.once('exit', () => {
        for (const root of roots) {
          const links = deps.hardlinks.check(root, request.cls)

          if (!links.ok) {
            deps.onHardlinkAppeared?.({ root, block: links.block, pid, sessionId: request.sessionId ?? null })
          }
        }
      })

      return { ok: true, pid, child, marker, params }
    },
    list,
    async kill(pid: number): Promise<KillResultView> {
      let snapshot = await deps.scan()
      const member = list(snapshot).find(item => item.pid === pid)

      if (!member) {
        return { ok: false, pid, reason: 'not-confined', survivors: [], error: 'not a confined process' }
      }

      // The run is everything the kernel puts in the root's sandbox token, plus the root's tree (the ancestry
      // fallback when the kernel cannot be asked). A daemon that left the tree is still in the token.
      const rowOf = (snap: Snapshot, target: number) => snap.rows.find(row => row.pid === target)
      const run = rowOf(snapshot, member.root)?.run ?? rowOf(snapshot, pid)?.run ?? null

      const inRun = (snap: Snapshot): number[] =>
        list(snap)
          .filter(item => item.root === member.root || (run !== null && rowOf(snap, item.pid)?.run === run))
          .map(item => item.pid)

      const signalled = new Set<number>()

      const hit = (pids: readonly number[], signal: NodeJS.Signals) => {
        pids.forEach(target => signalled.add(target))
        send(pids, signal)
      }

      let targets = inRun(snapshot)

      hit(targets, 'SIGTERM')

      for (const deadline = Date.now() + TERM_GRACE_MS; targets.length > 0 && Date.now() < deadline;) {
        await sleep(ROUND_PAUSE_MS * 2)
        snapshot = await deps.scan()
        targets = inRun(snapshot)
        hit(
          targets.filter(target => !signalled.has(target)),
          'SIGTERM'
        )
      }

      // Stopped first, so a process that forks in a loop cannot outrun the sweep: a stopped process forks nothing.
      for (let round = 0; targets.length > 0 && round < KILL_ROUNDS; round += 1) {
        hit(targets, 'SIGSTOP')
        hit(targets, 'SIGKILL')
        await sleep(ROUND_PAUSE_MS)
        snapshot = await deps.scan()
        targets = inRun(snapshot)
      }

      if (targets.length > 0) {
        return {
          ok: false,
          pid,
          reason: 'survivors',
          survivors: targets,
          error: `could not stop ${targets.length}: ${targets.join(', ')}`
        }
      }

      if (!snapshot.verified) {
        return {
          ok: false,
          pid,
          reason: 'unverified',
          survivors: [],
          error: 'the kernel could not be asked; a process that left the tree may survive'
        }
      }

      return { ok: true, pid, killed: [...signalled].sort((a, b) => a - b) }
    },
    explain(pid: number, snapshot: Snapshot): string[] {
      const member = list(snapshot).find(item => item.pid === pid)

      if (!member) {
        return [`pid ${pid} is not confined by Seatbelt.`]
      }

      const profile = member.profileSha
        ? deps.profiles().find(item => item.sha256.startsWith(member.profileSha))
        : undefined

      if (!profile) {
        return [`pid ${pid} runs under profile ${member.profileSha || '(unknown)'}, which main did not generate.`]
      }

      const view = profileView(profile)
      const audit = auditSbpl(profile.text)

      return [
        `class ${view.cls} · profile ${profile.sha256.slice(0, 12)}${audit.widened ? ` · WIDENED: ${audit.problems.join(', ')}` : ''}`,
        `reads: ${view.reads.join(', ')}`,
        `writes: ${view.writes.join(', ')}`,
        `network: ${view.network === 'grant' ? 'only with a network grant (never loopback)' : 'never'}`,
        `never: ${view.denied.length} secret and app-state paths, the keychain services`
      ]
    }
  }
}
