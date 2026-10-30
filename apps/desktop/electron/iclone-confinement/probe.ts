/**
 * V3-G R1/R4 — what each backend can do on this Mac, measured at boot and on every state read. Seatbelt is
 * deprecated: a missing binary, or one that stops enforcing, must read RED and never silently unconfined, so the
 * probe runs a negative control (a profile that must deny a canary file does deny it) next to a positive one.
 * Apple `container` is detected only: installing it is the owner's step (admin password), never ours, and a correct
 * install reads `installed` (neutral): this version confines with Seatbelt and does not use it.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { accessSync, existsSync, constants as fsConstants, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { BackendStatusView } from '../../src/iclone-shared/confinement'

import { realOrSelf } from './profiles'

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

/** Where Apple's signed installer puts the CLI (`/usr/local`), and Homebrew's prefix — the only places that count
 *  (K133): never a PATH lookup, so a stray shim cannot stand in for it. The Hermes plugin checks the same list
 *  (`plugins/iclone-confinement/providers.py`), both held to `plugins/iclone-confinement/tests/fixtures/container_detect.json`. */
export const CONTAINER_CANDIDATES = ['/usr/local/bin/container', '/opt/homebrew/bin/container'] as const

/** The installed `container` binary: the first fixed path that exists, else null. */
export const containerBinary = (exists: (file: string) => boolean): string | null =>
  CONTAINER_CANDIDATES.find(candidate => exists(candidate)) ?? null

/** G3-1: the CLI's own answer to `--version`, anchored at the start: a different tool, or any x.y.z anywhere in a
 *  message ("requires macOS 26.0.1"), is not it. The Hermes plugin uses the same pattern, timeout and platform rule,
 *  both held to the shared fixture's version-answer cases. */
export const CONTAINER_VERSION_RE = /^container CLI version ([0-9]+\.[0-9]+\.[0-9]+)(?=[ \t\r\n]|$)/
export const CONTAINER_VERSION_TIMEOUT_MS = 3_000

/** G3 r2 m-1: how both sides read a check's raw bytes, held to the shared fixture. At most this many bytes per stream
 *  (more is stopped, a definite failure: the CLI prints one line), decoded as UTF-8 with every invalid byte replaced by
 *  U+FFFD (never an exception), then stripped of exactly " \t\r\n" at both ends (no Unicode or control-character
 *  trimming), then matched with ASCII digits only. The plugin's `_run_version` / `_answer_text` do the same. */
export const CHECK_OUTPUT_MAX_BYTES = 64 * 1024
export const CHECK_OUTPUT_STRIP = ' \t\r\n'

/** The bytes a check printed, as text: UTF-8, invalid bytes replaced (U+FFFD), nothing stripped (a BOM stays). */
const outputText = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')

/** Strips exactly " \t\r\n" at both ends: `String.prototype.trim` would also take NBSP, BOM and other Unicode spaces,
 *  and Python's `str.strip()` the ASCII separators (\x1c–\x1f); either would split the two sides. */
const stripAnswer = (text: string): string => text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')

/** What a check said, as both sides read it. */
export const answerText = (bytes: Uint8Array): string => stripAnswer(outputText(bytes))
/** Darwin 25 = macOS 26, the first release Apple `container` runs on. */
export const CONTAINER_MIN_DARWIN_MAJOR = 25

/** Doc 12 pins 1.5.x; 1.6.0 shipped 2026-10-20 and is not measured yet. */
const CONTAINER_PINNED = '1.5.0'
export const CONTAINER_PKG_SHA256 = 'a24808cb202318fa1c3bbee0c6c6887fe1225fe899d7b687a0ddd939bd6573f8'

/** The owner's one-time install, verbatim (also in the pane's detail and the builder report). */
export const CONTAINER_OWNER_COMMAND = [
  'cd ~/Downloads',
  `curl -fLO https://github.com/apple/container/releases/download/${CONTAINER_PINNED}/container-${CONTAINER_PINNED}-installer-signed.pkg`,
  `echo "${CONTAINER_PKG_SHA256}  container-${CONTAINER_PINNED}-installer-signed.pkg" | shasum -a 256 -c -`,
  `sudo installer -pkg container-${CONTAINER_PINNED}-installer-signed.pkg -target /`,
  'container system start',
  'container --version'
].join(' && ')

interface RunResult {
  code: number | null
  /** The raw bytes, at most CHECK_OUTPUT_MAX_BYTES (decoding is the reader's, one rule: `answerText`). */
  stdout: Uint8Array
  stderr: Uint8Array
  /** Killed by the runner's timeout: the check did not finish, which is not an answer. */
  timedOut?: boolean
  /** Why the program could not run (`ENOENT`, `EACCES`, `ENOEXEC`, a signal), for the evidence. */
  error?: string | null
}

export type Runner = (file: string, args: string[], timeoutMs: number) => Promise<RunResult>

const EMPTY = new Uint8Array(0)

const errorCode = (error: unknown): string =>
  typeof (error as NodeJS.ErrnoException | null)?.code === 'string'
    ? String((error as NodeJS.ErrnoException).code)
    : String(error)

/** Never rejects: a program that cannot start (some spawn errors, e.g. ENOEXEC, throw synchronously) is an answer
 *  with `code: null` and the error code, like one that exits.
 *
 *  G3 r2 m-2: the timeout is enforced. The program runs as the leader of its own process group (`detached` = setsid),
 *  and at the timeout the whole group gets SIGKILL and the answer is given at once: a `--version` that ignores
 *  SIGTERM, or a child it left holding the pipe, can neither hold the probe past the timeout nor outlive it. The
 *  Hermes plugin's runner does the same (`start_new_session` + `killpg`). */
export const runFile: Runner = (file, args, timeoutMs) =>
  new Promise(resolve => {
    let child: ChildProcess

    try {
      child = spawn(file, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: null, stdout: EMPTY, stderr: EMPTY, timedOut: false, error: errorCode(error) })

      return
    }

    const out = { stdout: [] as Buffer[], stderr: [] as Buffer[], bytes: { stdout: 0, stderr: 0 } }
    let settled = false

    const killGroup = () => {
      if (child.pid === undefined) {
        return
      }

      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }

    const settle = (answer: { code: number | null; timedOut: boolean; error: string | null }) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)
      // G3 r3 m-3: on EVERY exit path, not only the timeout and the overflow: a child the check left running (even
      // one that dropped its pipes) dies with the probe. After a normal exit the leader is already reaped, but its
      // group id cannot be reused while a member lives (POSIX), and an empty group is ESRCH (ignored).
      killGroup()
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({
        ...answer,
        stdout: Buffer.concat(out.stdout).subarray(0, CHECK_OUTPUT_MAX_BYTES),
        stderr: Buffer.concat(out.stderr).subarray(0, CHECK_OUTPUT_MAX_BYTES)
      })
    }

    const timer = setTimeout(() => {
      killGroup()
      settle({ code: null, timedOut: true, error: null })
    }, timeoutMs)

    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream]?.on('data', (chunk: Buffer) => {
        out[stream].push(chunk)
        out.bytes[stream] += chunk.length

        // More than the CLI's one line: stopped (the group, SIGKILL), and a definite failure — never the timeout.
        if (out.bytes[stream] > CHECK_OUTPUT_MAX_BYTES) {
          killGroup()
          settle({ code: null, timedOut: false, error: 'output-too-large' })
        }
      })
    }

    child.on('error', error => {
      killGroup()
      settle({ code: null, timedOut: false, error: errorCode(error) })
    })
    child.on('close', (code, signal) => settle({ code, timedOut: false, error: code === null ? signal : null }))
  })

interface ProbeHost {
  run: Runner
  exists: (file: string) => boolean
  /** The file may be executed by this user (X_OK). */
  executable: (file: string) => boolean
  platform: NodeJS.Platform
  arch: string
  /** Darwin kernel major (25 = macOS 26). */
  darwinMajor: number
}

function defaultProbeHost(): ProbeHost {
  return {
    run: runFile,
    exists: existsSync,
    executable: file => {
      try {
        accessSync(file, fsConstants.X_OK)

        return true
      } catch {
        return false
      }
    },
    platform: process.platform,
    arch: process.arch,
    darwinMajor: Number.parseInt(os.release().split('.')[0] ?? '0', 10) || 0
  }
}

const timeoutEvidence = (answer: RunResult): string =>
  `timed out${answerText(answer.stderr) ? `: ${answerText(answer.stderr).slice(0, 200)}` : ''}`

/** A probe that threw (a bug, not an answer): RED `broken` / `probe-failed`. The one shape the layer (index.ts) and
 *  the container backend's refusal both use, so the pane and the refusal never disagree about it (G3-3). */
export function probeFailedView(id: BackendStatusView['id'], error: unknown): BackendStatusView {
  return {
    id,
    status: 'broken',
    version: null,
    enforcing: false,
    detail: 'probe-failed',
    evidence: error instanceof Error ? error.message : String(error),
    ownerStep: null
  }
}

/** Positive control: an allow-all profile runs `true`. Negative control: a deny on a canary makes `cat` fail. */
export async function probeSeatbelt(host: ProbeHost = defaultProbeHost()): Promise<BackendStatusView> {
  const base = { id: 'seatbelt' as const, version: null, ownerStep: null }

  if (host.platform !== 'darwin') {
    return { ...base, status: 'unsupported', enforcing: false, detail: 'macos-only', evidence: host.platform }
  }

  if (!host.exists(SANDBOX_EXEC)) {
    return { ...base, status: 'broken', enforcing: false, detail: 'binary-missing', evidence: SANDBOX_EXEC }
  }

  const dir = realOrSelf(mkdtempSync(path.join(os.tmpdir(), 'iclone-confinement-probe-')))
  const canary = path.join(dir, 'canary.txt')

  try {
    writeFileSync(canary, 'canary\n', { mode: 0o600 })

    const positive = await host.run(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true'], 5_000)

    const negative = await host.run(
      SANDBOX_EXEC,
      ['-p', `(version 1)(allow default)(deny file-read* (literal "${canary}"))`, '/bin/cat', canary],
      5_000
    )

    // G3-2: a control that did not finish in time is not an answer: "could not check" (neutral), never red, and never
    // "enforcing" (a timed-out negative control used to fall through to ready).
    for (const control of [positive, negative]) {
      if (control.timedOut) {
        return {
          ...base,
          status: 'unknown',
          enforcing: false,
          detail: 'probe-timeout',
          evidence: timeoutEvidence(control)
        }
      }
    }

    if (positive.code !== 0) {
      return {
        ...base,
        status: 'broken',
        enforcing: false,
        detail: 'cannot-run',
        evidence: `exit ${positive.code}: ${answerText(positive.stderr)}`
      }
    }

    if (negative.code === 0 || outputText(negative.stdout).includes('canary')) {
      return {
        ...base,
        status: 'broken',
        enforcing: false,
        detail: 'not-enforcing',
        evidence: `exit ${negative.code}: the canary read was not denied`
      }
    }

    return {
      ...base,
      status: 'ready',
      enforcing: true,
      detail: 'enforcing',
      evidence: `exit ${negative.code}: the control profile denied the canary read`
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** `<binary> --version: <exit n (why) | timed out>: <first 200 chars of what it said>`. */
function answerEvidence(binary: string, answer: RunResult): string {
  const how = answer.timedOut ? 'timed out' : `exit ${answer.code}${answer.error ? ` (${answer.error})` : ''}`

  return `${binary} --version: ${how}: ${answerText(answer.stderr.length > 0 ? answer.stderr : answer.stdout).slice(0, 200)}`
}

export async function probeContainer(host: ProbeHost = defaultProbeHost()): Promise<BackendStatusView> {
  const base = { id: 'container' as const, enforcing: false }

  if (host.platform !== 'darwin' || host.arch !== 'arm64' || host.darwinMajor < CONTAINER_MIN_DARWIN_MAJOR) {
    return {
      ...base,
      status: 'unsupported',
      version: null,
      detail: 'needs-apple-silicon',
      evidence: `${host.platform} ${host.arch} darwin ${host.darwinMajor}`,
      ownerStep: null
    }
  }

  const binary = containerBinary(host.exists)

  if (!binary) {
    return {
      ...base,
      status: 'not-installed',
      version: null,
      detail: 'not-installed',
      evidence: CONTAINER_CANDIDATES.join(', '),
      ownerStep: CONTAINER_OWNER_COMMAND
    }
  }

  // G3-1: a fixed-path file this user cannot execute is a broken install, and it is never run.
  if (!host.executable(binary)) {
    return {
      ...base,
      status: 'broken',
      version: null,
      detail: 'no-version',
      evidence: `${binary}: not executable (never run)`,
      ownerStep: null
    }
  }

  const answer = await host.run(binary, ['--version'], CONTAINER_VERSION_TIMEOUT_MS)

  // G3-2: a check that did not finish in time on a busy Mac says nothing about the install: neutral "could not check".
  if (answer.timedOut) {
    return {
      ...base,
      status: 'unknown',
      version: null,
      detail: 'probe-timeout',
      evidence: answerEvidence(binary, answer),
      ownerStep: null
    }
  }

  const version = answer.code === 0 ? (CONTAINER_VERSION_RE.exec(answerText(answer.stdout))?.[1] ?? null) : null

  // K130: a binary that does not answer its version is a broken install (RED); one that does is a correct install
  // this version does not use (no C1 baseline, not selectable) — neutral, never "Not working".
  if (!version) {
    return {
      ...base,
      status: 'broken',
      version: null,
      detail: 'no-version',
      evidence: answerEvidence(binary, answer),
      ownerStep: null
    }
  }

  return {
    ...base,
    status: 'installed',
    version,
    detail: 'not-wired',
    evidence: `${binary} ${version}: not used in this version (no spike C1 baseline; Seatbelt confines)`,
    ownerStep: null
  }
}
