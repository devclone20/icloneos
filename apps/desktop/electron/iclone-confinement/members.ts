/**
 * V3-G — which processes are confined, asked of the kernel instead of inferred from ancestry.
 *
 * Ancestry fails the moment a confined child double-forks and calls `setsid`: it is reparented to launchd, leaves the
 * process group, and can drop its marker by exec-ing with a fresh argv and env. Its sandbox is the one thing it
 * cannot drop (Seatbelt is inherited and irrevocable). So every confined run gets an empty token file here, its
 * profile may read exactly that file (`-D MEMBER=<token>`) plus the shared mark, and main asks `sandbox_check(pid,
 * "file-read-data", path)` for every process:
 *
 *   sandboxed  ∧  may read `.member`  ∧  may NOT read `.decoy`   ⇒ an icloneOS confined process
 *   … and may read `<token>`                                    ⇒ of that run
 *   sandboxed  ∧  may read `.runtime` ∧  may NOT read `.decoy`   ⇒ held in the runtime profile (Hermes and the
 *                                                                  interpreter children it starts), never a run
 *
 * Agent profiles never read `.runtime`, so the runtime answer is asked first: the kernel, not ancestry or argv, says
 * which processes the runtime profile holds.
 *
 * The decoy rules out any foreign sandbox that reads broadly; only a profile that names the mark passes. Node has no
 * FFI, so the question is asked by the Hermes runtime's own Python (`-I -S`: no site, no env, no cwd imports; ctypes
 * is stdlib), the interpreter this layer already confines the agent with.
 *
 * Token names carry the run's facts (`<class>+<sha12>+<session|->+<random>`), so a run whose root already exited is
 * still attributed. Files only exist while a run may; `sweepTokens` removes the ones with no live member.
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { type ActivityClass, isActivityClass } from '../../src/iclone-shared/confinement'

const MARK = '.member'
const DECOY = '.decoy'
const RUNTIME = '.runtime'
/** The probe's answer for a process the runtime profile holds (a dot name: never a run token). */
export const RUNTIME_ANSWER = RUNTIME
const SESSION_RE = /^[A-Za-z0-9_.-]{1,64}$/
const TOKEN_RE = /^([a-z]+)\+([0-9a-f]{12})\+([A-Za-z0-9_.-]{1,64})\+([0-9a-f]{32})$/

/** A run token's name, by shape alone (what a renderer or a journal line may name). */
export const isRunToken = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 200 && TOKEN_RE.test(value)

export const memberMarkFile = (membersDir: string): string => path.join(membersDir, MARK)

/** The marks and the decoy must exist: the kernel answers path checks on real files. */
export function ensureMembersDir(membersDir: string): void {
  mkdirSync(membersDir, { recursive: true, mode: 0o700 })

  for (const name of [MARK, DECOY, RUNTIME]) {
    writeFileSync(path.join(membersDir, name), '', { mode: 0o600, flag: 'a' })
  }
}

interface RunToken {
  name: string
  file: string
}

export function newRunToken(
  membersDir: string,
  cls: ActivityClass,
  sha256: string,
  sessionId: string | null | undefined
): RunToken {
  ensureMembersDir(membersDir)

  const session = sessionId && SESSION_RE.test(sessionId) ? sessionId : '-'
  const name = `${cls}+${sha256.slice(0, 12)}+${session}+${randomBytes(16).toString('hex')}`
  const file = path.join(realpathSync(membersDir), name)

  closeSync(openSync(file, 'wx', 0o600))

  return { name, file }
}

interface RunFacts {
  cls: ActivityClass | null
  sha12: string
  sessionId: string | null
}

export function parseRunToken(name: string): RunFacts | null {
  const match = TOKEN_RE.exec(name)

  if (!match) {
    return null
  }

  return {
    cls: isActivityClass(match[1]) ? match[1] : null,
    sha12: match[2],
    sessionId: match[3] === '-' ? null : match[3]
  }
}

/** `SANDBOX_FILTER_PATH` (libsandbox): the check's extra argument is a path. */
const SANDBOX_FILTER_PATH = 1
/**
 * `SANDBOX_CHECK_NO_REPORT` (libsandbox's private header, OR-ed into the filter type): the kernel answers the check
 * without reporting a denial. Without it every denied check is written to the unified log as a denial of the checked
 * process, tagged like a real refusal of that run's profile, and the pane fills with the probe's own questions (about
 * ten rows a second for one idle command). Measured on this Mac: the answer is the same with and without the flag;
 * with it the log stays silent (members.live.test.ts).
 */
export const SANDBOX_CHECK_NO_REPORT = 0x40000000
/** The filter the probe asks every path question with: a path, and never a report. */
export const PROBE_PATH_FILTER = SANDBOX_FILTER_PATH | SANDBOX_CHECK_NO_REPORT

// sandbox_check is variadic: argtypes name only the fixed three, so ctypes passes the path the variadic way (on the
// stack on arm64).
const PROBE_SCRIPT = `
import ctypes, json, os, sys
d = sys.argv[1]
check = ctypes.CDLL(None).sandbox_check
check.restype = ctypes.c_int
check.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
P = ctypes.c_char_p
op = b"file-read-data"
F = ${PROBE_PATH_FILTER}
mark, decoy = os.path.join(d, ".member").encode(), os.path.join(d, ".decoy").encode()
rt = os.path.join(d, ".runtime").encode()
tokens = [(n, os.path.join(d, n).encode()) for n in os.listdir(d) if not n.startswith(".")]
me, out = os.getpid(), {}
for line in sys.stdin:
    pid = int(line)
    if pid <= 1 or pid == me or check(pid, None, 0) != 1:
        continue
    if check(pid, op, F, P(decoy)) != 1:
        continue
    if check(pid, op, F, P(rt)) == 0:
        out[str(pid)] = ".runtime"
        continue
    if check(pid, op, F, P(mark)) != 0:
        continue
    out[str(pid)] = next((n for n, f in tokens if check(pid, op, F, P(f)) == 0), None)
sys.stdout.write(json.dumps(out))
`

/** pid → run token name (null: confined by icloneOS, run token already swept; `RUNTIME_ANSWER`: held in the runtime
 *  profile). Absent pid ⇒ not ours. */
type Membership = ReadonlyMap<number, string | null>

export type MemberProbe = (pids: readonly number[]) => Promise<Membership>

export function createMemberProbe(membersDir: string, python: string): MemberProbe {
  return pids =>
    new Promise((resolve, reject) => {
      const child = execFile(
        python,
        ['-I', '-S', '-c', PROBE_SCRIPT, realpathSync(membersDir)],
        { encoding: 'utf8', timeout: 5_000, maxBuffer: 4 * 1024 * 1024, env: {} },
        (error, stdout) => {
          if (error) {
            reject(error)

            return
          }

          try {
            const raw = JSON.parse(String(stdout)) as Record<string, unknown>

            resolve(
              new Map(
                Object.entries(raw).map(([pid, token]) => [Number(pid), typeof token === 'string' ? token : null])
              )
            )
          } catch (parseError) {
            reject(parseError instanceof Error ? parseError : new Error(String(parseError)))
          }
        }
      )

      child.stdin?.end(`${pids.join('\n')}\n`)
    })
}

/** A token younger than this is kept even with no member: its run may not have started yet. Its age runs from the file's
 *  birth, not its mtime: the runtime that made the token may keep the descriptor and write through it for ever. */
const TOKEN_GRACE_MS = 10 * 60_000

/** Removes the tokens no live process holds. The mark and the decoy stay. */
export function sweepTokens(membersDir: string, live: Membership, nowMs: number): number {
  const held = new Set([...live.values()].filter((token): token is string => token !== null && token !== RUNTIME))
  let removed = 0
  let names: string[]

  try {
    names = readdirSync(membersDir)
  } catch {
    return 0
  }

  for (const name of names) {
    if (name.startsWith('.') || held.has(name)) {
      continue
    }

    const file = path.join(membersDir, name)

    try {
      if (nowMs - statSync(file).birthtimeMs > TOKEN_GRACE_MS) {
        unlinkSync(file)
        removed += 1
      }
    } catch {
      // gone already
    }
  }

  return removed
}
