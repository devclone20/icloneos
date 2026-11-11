/**
 * Main's copy of the permission policy for the confinement launcher (fx7, A-M1; fx12; fx13). The launcher decides how
 * much a confined command may be given (NET, WRITE_PROJECT) from a source the runtime cannot write: this folder, the
 * launcher's own ledger, which the runtime profile denies whole. Main writes it by its own hand at every publish of
 * the policy (a mode, grant or switch change, a spawn's key) and again before each launcher start, so a change in the
 * UI is on disk before the next confined command asks. The body is the one main signs for the runtime
 * (`buildPolicyBody`): the launcher reads it with V3-F's own `decide`, and a runtime that skipped its own reading
 * gains nothing. No file is no policy, and the launcher then refuses every confined command.
 *
 * fx12 adds `projects`: the folders the app has open or the user named in a mode or a grant (the launcher writes
 * nowhere else, matched by folder identity). fx13 (D13) lists a window folder together with its repository root, and
 * replaces the leases: main can bind a request to a folder and a time, never to a command text — the runtime composes
 * the script that runs (lens3-policy H1). `passes.jsonl` holds one row per ask the user allowed, the folder it was
 * allowed in and when the pass expires; the launcher lifts an asking cell for any run in that folder until then. A
 * pass is never taken, so every run of the one tool call it covered (a file tool runs several) gets what the user
 * allowed. A write that fails removes the policy file: a stale policy must never stay wider than the one main could
 * not land.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, rmSync, statSync, truncateSync } from 'node:fs'
import path from 'node:path'

import type { PolicySigner } from '../iclone-permissions/policy-file'
import { writeFileAtomicSync } from '../lib/atomic-write'

export const LAUNCHER_POLICY_FILE = 'policy.json'
export const LAUNCHER_PASS_FILE = 'passes.jsonl'
/** How long an allowed ask keeps its folder writable: every run of that one tool call, and little after (D13). */
export const LAUNCHER_PASS_TTL_MS = 120 * 1000

/** Exactly what the signer publishes for the runtime: the launcher reads the same body. */
export type LauncherPolicyBody = Parameters<PolicySigner['publish']>[0]

export type LauncherPassScope = 'once' | 'project' | 'session' | 'standing'

/** What main learned when the user allowed an ask: the folder it was asked for, the class the user allowed (fx17,
 *  lens4-pass M1: a `Wp` pass lifts project writes, an `N` pass the network, an `X` pass both) and how the user
 *  answered. */
export interface LauncherPass {
  readonly project: string | null
  readonly cls: string
  readonly scope: LauncherPassScope
}

/** One row of `passes.jsonl`, as the launcher reads it (`Passes.rows`): no command text, ever. */
export interface LauncherPassRow {
  v: 1
  id: string
  project: string | null
  cls: string
  scope: LauncherPassScope
  /** Seconds since the epoch, as the launcher's `time.time()` counts. */
  ts: number
  exp: number
}

export interface LauncherPolicyMirror {
  /** The file the launcher reads. */
  readonly file: string
  /** The passes file the launcher reads. */
  readonly passFile: string
  /** The body main just published: written now with main's project list, kept for `rewrite`. */
  publish(body: LauncherPolicyBody): void
  /** The roots of the runtime spawned now: in the file from the next write on. */
  setRuntimeRoots(roots: { reads: readonly string[]; writes: readonly string[] }): void
  /** Writes the last published body again (a launcher start, a ledger folder made fresh); false when none yet. */
  rewrite(): boolean
  /** A folder the app has open, or the user named: in the list from the next publish on, with its repository root. */
  noteProject(root: string | null): void
  /** fx17 (lens4-pass M2): a folder the user named by allowing an ask that showed it: listed only while a pass or a
   *  grant for it is live, dropped at the prune. A folder `noteProject` listed is never dropped. fx19: `grantId` is the
   *  grant the same answer made (a session or standing grant names no folder): the folder stays while that grant does. */
  noteAskedProject(root: string | null, grantId?: string | null): void
  /** fx19: an allowed ask, as the authority reports it: a folder the sheet showed is listed, bound to the grant the same
   *  answer made; the pass is written either way. */
  noteAllowedAsk(pass: LauncherPass & { readonly shown: boolean; readonly grantId?: string | null }): void
  /** One pass for an allowed ask; false when it could not be written (then the command stays narrowed). */
  pass(pass: LauncherPass): boolean
  /** Drops the expired passes and the asked folders nothing live names any more; armed by itself at each expiry. */
  prune(): void
}

const realOrNull = (root: unknown): string | null => {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    return null
  }

  try {
    return realpathSync(root)
  } catch {
    return null
  }
}

/**
 * The repository root at or above `real` (lens3-normal M1: a window opened on a sub-folder of a repository runs its
 * commands at the repository root, which is what the runtime names as the project). Never the user's home, nothing
 * above it, never `/`: a home that is itself a repository must not make every folder in it writable.
 */
export function gitRootOf(real: string, home: string | null): string | null {
  let dir = real

  for (;;) {
    if (dir === '/' || (home !== null && (dir === home || !dir.startsWith(`${home}${path.sep}`)))) {
      return null
    }

    if (existsSync(path.join(dir, '.git'))) {
      return dir
    }

    const parent = path.dirname(dir)

    if (parent === dir) {
      return null
    }

    dir = parent
  }
}

/** The folders a confined command may write: every project main knows of, by real path, each once. */
export function listedProjects(body: LauncherPolicyBody, windowProjects: Iterable<string>): string[] {
  const named = [
    ...windowProjects,
    ...Object.keys(body.projects),
    ...(body.folders ?? []),
    ...body.grants.map(grant => grant.project),
    ...body.fnGrants.map(grant => grant.project)
  ]

  return [...new Set(named.map(realOrNull).filter((root): root is string => root !== null))].sort()
}

const isPassRow = (row: unknown): row is LauncherPassRow =>
  typeof row === 'object' &&
  row !== null &&
  (row as LauncherPassRow).v === 1 &&
  typeof (row as LauncherPassRow).id === 'string' &&
  typeof (row as LauncherPassRow).exp === 'number' &&
  typeof (row as LauncherPassRow).cls === 'string' &&
  ((row as LauncherPassRow).project === null || typeof (row as LauncherPassRow).project === 'string')

/** The rows of `passes.jsonl` that parse; nothing when the file is missing or unreadable. */
export function readPassRows(passFile: string): LauncherPassRow[] {
  let text: string

  try {
    text = readFileSync(passFile, 'utf8')
  } catch {
    return []
  }

  const rows: LauncherPassRow[] = []

  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue
    }

    try {
      const row: unknown = JSON.parse(line)

      if (isPassRow(row)) {
        rows.push(row)
      }
    } catch {
      // A torn line is no pass.
    }
  }

  return rows
}

/** Removes `target`, or empties it when its folder refuses the unlink: the launcher reads an empty file as no policy. */
function dropFile(target: string): void {
  try {
    rmSync(target, { force: true })
  } catch {
    try {
      truncateSync(target, 0)
    } catch {
      // Nothing more main can do by hand; the caller's log line says the launcher's state.
    }
  }

  if (existsSync(target)) {
    try {
      truncateSync(target, 0)
    } catch {
      // As above.
    }
  }
}

export function createLauncherPolicyMirror(
  ledgerDir: string,
  log: (line: string) => void,
  now: () => number = Date.now,
  home: string | null = null
): LauncherPolicyMirror {
  const file = path.join(ledgerDir, LAUNCHER_POLICY_FILE)
  const passFile = path.join(ledgerDir, LAUNCHER_PASS_FILE)
  const windowProjects = new Set<string>()
  // fx17 (lens4-pass M2): the folders allowed asks named, each kept while a pass or a grant names it.
  const askedProjects = new Map<string, Set<string>>()
  let last: LauncherPolicyBody | null = null
  let pruneTimer: ReturnType<typeof setTimeout> | null = null

  // A file from the last launch is the last launch's policy and its passes, not this one's: gone before the first
  // publish, so a launcher never reads a ceiling main has not written in this process.
  dropFile(file)
  dropFile(passFile)

  let runtimeRoots: { reads: readonly string[]; writes: readonly string[] } | null = null
  // V-3: the last content written (issue time aside) and the file's stamp right after: an identical write is skipped
  // only while the file is still exactly the one main wrote.
  let lastWritten: { content: string; stamp: string } | null = null

  const stampOf = (): string => {
    try {
      const stat = statSync(file)

      return `${stat.ino}:${stat.size}:${stat.ctimeMs}:${stat.mtimeMs}`
    } catch {
      return ''
    }
  }

  const write = (body: LauncherPolicyBody): void => {
    // A folder the store also lists (the button) was listed by the user, not by an ask: it never drops.
    const stored = new Set((body.folders ?? []).map(realOrNull))
    const asked = [...askedProjects.keys()].filter(folder => !windowProjects.has(folder) && !stored.has(folder)).sort()
    const projects = listedProjects(body, [...windowProjects, ...asked])
    const roots = runtimeRoots ? { roots: runtimeRoots } : {}
    const { issuedAt: _issuedAt, ...signedPart } = body
    const content = JSON.stringify({ v: 1, body: signedPart, projects, asked, ...roots })

    if (lastWritten && lastWritten.content === content && lastWritten.stamp !== '' && lastWritten.stamp === stampOf()) {
      return
    }

    try {
      // Not fsynced (V-3): this file is dropped at every launch before the first publish (above), so a power cut can
      // never leave a launcher reading it; for a reader now the write stays atomic (temp file + rename).
      writeFileAtomicSync(file, `${JSON.stringify({ v: 1, body, projects, asked, ...roots })}\n`, {
        mode: 0o600,
        dirMode: 0o700,
        durable: false
      })
      lastWritten = { content, stamp: stampOf() }
    } catch (error) {
      lastWritten = null
      // Closed, and said: the old file would be the wider policy the launcher keeps reading, so it goes too.
      dropFile(file)
      log(`[confinement] the launcher's policy could not be written (${(error as Error).message}); confined commands are refused until it is`)
    }
  }

  const writePasses = (rows: LauncherPassRow[]): void => {
    writeFileAtomicSync(passFile, rows.map(item => JSON.stringify(item)).join('\n') + (rows.length ? '\n' : ''), {
      mode: 0o600,
      dirMode: 0o700
    })
  }

  /** The next prune at the earliest expiry (unref'd: it holds nothing open); none when no pass is live. */
  const arm = (rows: LauncherPassRow[]): void => {
    if (pruneTimer) {
      clearTimeout(pruneTimer)
      pruneTimer = null
    }

    const next = Math.min(...rows.map(row => row.exp * 1000))

    if (Number.isFinite(next)) {
      pruneTimer = setTimeout(prune, Math.max(0, next - now()) + 1)
      pruneTimer.unref?.()
    }
  }

  /** Drops the asked folders nothing live names any more: no live pass, no grant of theirs, no grant from the same answer. */
  const dropUnnamed = (rows: readonly LauncherPassRow[]): boolean => {
    const grants = last ? [...last.grants, ...last.fnGrants] : []
    const liveIds = new Set(grants.map(grant => grant.id))

    const named = new Set(
      [...rows.map(row => row.project), ...grants.map(grant => grant.project)]
        .map(realOrNull)
        .filter((folder): folder is string => folder !== null)
    )

    let changed = false

    for (const [folder, ids] of [...askedProjects]) {
      if (!named.has(folder) && ![...ids].some(id => liveIds.has(id))) {
        askedProjects.delete(folder)
        changed = true
      }
    }

    return changed
  }

  const prune = (): void => {
    const at = now()
    const all = readPassRows(passFile)
    const kept = all.filter(row => row.exp * 1000 > at)

    if (kept.length !== all.length) {
      try {
        writePasses(kept)
      } catch (error) {
        log(`[confinement] the launcher's passes could not be pruned (${(error as Error).message})`)
      }
    }

    if (dropUnnamed(kept) && last) {
      write(last)
    }

    arm(kept)
  }

  return {
    file,
    passFile,
    publish(body) {
      last = body
      // A grant the user just removed takes the folder it kept with it, in this same write.
      dropUnnamed(readPassRows(passFile).filter(row => row.exp * 1000 > now()))
      write(body)
    },
    prune,
    noteAllowedAsk(pass) {
      // fx20 (lens5 H2): the authority compared the folder's identity at the answer; here, in the same tick, a path that
      // is not its own real path names nothing: a link is listed and passed for no one.
      const project = realOrNull(pass.project) === pass.project ? pass.project : null

      if (pass.shown && project) {
        this.noteAskedProject(project, pass.grantId ?? null)
      }

      this.pass({ ...pass, project })
    },
    noteAskedProject(root, grantId = null) {
      const real = realOrNull(root)

      if (!real || windowProjects.has(real)) {
        return
      }

      const known = askedProjects.get(real)

      if (known) {
        if (grantId) {
          known.add(grantId)
        }

        return
      }

      askedProjects.set(real, new Set(grantId ? [grantId] : []))

      if (last) {
        write(last)
      }
    },
    setRuntimeRoots(roots) {
      runtimeRoots = roots
    },
    rewrite() {
      if (!last) {
        return false
      }

      write(last)

      return true
    },
    noteProject(root) {
      const real = realOrNull(root)

      if (!real) {
        return
      }

      const roots = [real, gitRootOf(real, home)].filter(
        (candidate): candidate is string => candidate !== null && !windowProjects.has(candidate)
      )

      if (roots.length === 0) {
        return
      }

      for (const candidate of roots) {
        windowProjects.add(candidate)
      }

      if (last) {
        write(last)
      }
    },
    pass(pass) {
      const at = now()

      const row: LauncherPassRow = {
        v: 1,
        id: randomUUID(),
        project: realOrNull(pass.project),
        cls: pass.cls,
        scope: pass.scope,
        ts: at / 1000,
        exp: (at + LAUNCHER_PASS_TTL_MS) / 1000
      }

      try {
        // Expired rows go with every write (lens3-normal m2): the file holds the live passes and nothing else.
        const kept = [...readPassRows(passFile).filter(old => old.exp * 1000 > at), row]

        writePasses(kept)
        arm(kept)

        return true
      } catch (error) {
        log(`[confinement] the launcher's pass could not be written (${(error as Error).message}); the command the owner allowed runs without project writes or network`)

        return false
      }
    }
  }
}
