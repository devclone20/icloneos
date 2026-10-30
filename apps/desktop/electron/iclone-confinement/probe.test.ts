import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { containerRefusal } from './backend-container'
import {
  answerText,
  CHECK_OUTPUT_MAX_BYTES,
  CHECK_OUTPUT_STRIP,
  CONTAINER_CANDIDATES,
  CONTAINER_MIN_DARWIN_MAJOR,
  CONTAINER_OWNER_COMMAND,
  CONTAINER_PKG_SHA256,
  CONTAINER_VERSION_RE,
  CONTAINER_VERSION_TIMEOUT_MS,
  containerBinary,
  probeContainer,
  probeSeatbelt,
  runFile,
  type Runner
} from './probe'

/** K133 + G3-1: the fixture the Hermes plugin's test reads too (tests/plugins/test_iclone_confinement.py). */
const DETECT = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, '../../../../plugins/iclone-confinement/tests/fixtures/container_detect.json'),
    'utf8'
  )
) as {
  candidates: string[]
  versionPattern: string
  versionTimeoutMs: number
  platform: { platform: string; arch: string; minDarwinMajor: number }
  cases: { name: string; present: string[]; onPath: string | null; installed: string | null }[]
  verdicts: {
    name: string
    host: { platform: NodeJS.Platform; arch: string; darwinMajor: number }
    present: string[]
    executable: string[]
    answer: {
      code: number | null
      stdoutBytes: string
      stderrBytes: string
      timedOut: boolean
      error: string | null
    }
    /** The text both sides read from those bytes (decoded, stripped): what the broken evidence ends with. */
    read?: string
    expect: { status: string; detail: string; version: string | null; seen: string; runs: boolean }
  }[]
  output: { maxBytes: number; strip: string; overflowError: string }
  programs: {
    name: string
    files: Record<string, { bytes: string; mode: number }>
    /** The exact byte count the program prints on stdout (pins the bound to the byte). */
    stdoutLength?: number
    expect: { status: string; version: string | null }
  }[]
}

/** G3 r2 m-1: the fixture's bytes, one character per byte (latin-1): what a program printed, never decoded text. */
const b = (latin1: string): Uint8Array => {
  if ([...latin1].some(char => char.charCodeAt(0) > 0xff)) {
    throw new Error(`not one byte per character: ${JSON.stringify(latin1)}`)
  }

  return Buffer.from(latin1, 'latin1')
}

const host = (over: Partial<Parameters<typeof probeSeatbelt>[0] & object> = {}) => ({
  run: (async () => ({ code: 0, stdout: b(''), stderr: b('') })) as Runner,
  exists: () => true,
  executable: () => true,
  platform: 'darwin' as NodeJS.Platform,
  arch: 'arm64',
  darwinMajor: 26,
  ...over
})

// The negative control answers per profile: the canary deny must make `cat` fail.
const enforcing: Runner = async (_file, args) =>
  args.includes('/bin/cat')
    ? { code: 1, stdout: b(''), stderr: b('Operation not permitted') }
    : { code: 0, stdout: b(''), stderr: b('') }

describe('probeSeatbelt', () => {
  it('ready only when the positive control runs and the negative control denies', async () => {
    expect(await probeSeatbelt(host({ run: enforcing }))).toMatchObject({ status: 'ready', enforcing: true })
  })

  it('RED (broken) when sandbox-exec is missing — never silently unconfined', async () => {
    expect(await probeSeatbelt(host({ exists: () => false }))).toMatchObject({ status: 'broken', enforcing: false })
  })

  it('RED when the binary runs but stops enforcing (the canary was read)', async () => {
    const leaky: Runner = async (_file, args) =>
      args.includes('/bin/cat')
        ? { code: 0, stdout: b('canary\n'), stderr: b('') }
        : { code: 0, stdout: b(''), stderr: b('') }

    const view = await probeSeatbelt(host({ run: leaky }))

    expect(view).toMatchObject({ status: 'broken', enforcing: false })
    expect(view.detail).toBe('not-enforcing')
  })

  it('RED when even the allow-all profile fails', async () => {
    const dead: Runner = async () => ({ code: 65, stdout: b(''), stderr: b('sandbox_apply: refused') })

    expect((await probeSeatbelt(host({ run: dead }))).status).toBe('broken')
  })

  it('unsupported off macOS', async () => {
    expect((await probeSeatbelt(host({ platform: 'linux' }))).status).toBe('unsupported')
  })
})

describe('probeContainer', () => {
  it('not installed → the owner step, with the exact pinned command', async () => {
    const view = await probeContainer(host({ exists: () => false }))

    expect(view.status).toBe('not-installed')
    expect(view.detail).toBe('not-installed')
    expect(view.ownerStep).toBe(CONTAINER_OWNER_COMMAND)
    expect(CONTAINER_OWNER_COMMAND).toContain('container-1.5.0-installer-signed.pkg')
    expect(CONTAINER_OWNER_COMMAND).toContain(
      `${CONTAINER_PKG_SHA256}  container-1.5.0-installer-signed.pkg" | shasum -a 256 -c -`
    )
    expect(CONTAINER_OWNER_COMMAND).toContain('sudo installer -pkg')
  })

  it('K130 — installed and answering → `installed` (neutral, not used in this version), never `broken`', async () => {
    const run: Runner = async () => ({
      code: 0,
      stdout: b('container CLI version 1.5.0 (build: release)'),
      stderr: b('')
    })

    const view = await probeContainer(host({ exists: file => file === '/usr/local/bin/container', run }))

    expect(view).toMatchObject({
      status: 'installed',
      version: '1.5.0',
      detail: 'not-wired',
      enforcing: false,
      ownerStep: null
    })
  })

  it('K130 — present but not answering its version → `broken` (red stays for a genuinely broken install)', async () => {
    const failing: Runner = async () => ({ code: 1, stdout: b(''), stderr: b('XPC connection error') })
    const silent: Runner = async () => ({ code: 0, stdout: b('container\n'), stderr: b('') })

    // Killed by a signal (not the runner's timeout): a definite failure, still red.
    const killed: Runner = async () => ({
      code: null,
      stdout: b('container CLI version 1.5.0'),
      stderr: b(''),
      error: 'SIGKILL'
    })

    for (const run of [failing, silent, killed]) {
      const view = await probeContainer(host({ exists: file => file === '/usr/local/bin/container', run }))

      expect(view).toMatchObject({ status: 'broken', version: null, detail: 'no-version', enforcing: false })
    }
  })

  it('unsupported on Intel or before macOS 26', async () => {
    expect((await probeContainer(host({ arch: 'x64' }))).status).toBe('unsupported')
    expect((await probeContainer(host({ darwinMajor: 24 }))).status).toBe('unsupported')
  })
})

describe('G3-2 — a check that timed out under load reads "could not check" (neutral), never red', () => {
  const timeout: Runner = async () => ({ code: null, stdout: b(''), stderr: b(''), timedOut: true, error: null })

  it('container: a correct install whose --version timed out is `unknown` / `probe-timeout`, not `broken`', async () => {
    const view = await probeContainer(host({ exists: file => file === '/usr/local/bin/container', run: timeout }))

    expect(view).toMatchObject({ status: 'unknown', detail: 'probe-timeout', version: null, enforcing: false })
    expect(view.evidence).toBe('/usr/local/bin/container --version: timed out: ')
  })

  it('seatbelt: either control timing out is `unknown`, never `ready`/enforcing and never `broken`', async () => {
    const negativeHangs: Runner = async (file, args) =>
      args.includes('/bin/cat')
        ? { code: null, stdout: b(''), stderr: b(''), timedOut: true }
        : { code: 0, stdout: b(''), stderr: b('') }

    for (const run of [timeout, negativeHangs]) {
      expect(await probeSeatbelt(host({ run }))).toMatchObject({
        status: 'unknown',
        detail: 'probe-timeout',
        enforcing: false
      })
    }
  })

  it('red stays for a definite failure: a non-zero exit, or a kill that is not the timeout', async () => {
    const exit1: Runner = async () => ({ code: 1, stdout: b(''), stderr: b('boom'), timedOut: false })
    const killed: Runner = async () => ({ code: null, stdout: b(''), stderr: b(''), timedOut: false, error: 'SIGKILL' })

    for (const run of [exit1, killed]) {
      const view = await probeContainer(host({ exists: file => file === '/usr/local/bin/container', run }))

      expect(view.status).toBe('broken')
    }

    expect((await probeSeatbelt(host({ run: exit1 }))).status).toBe('broken')
  })
})

describe('K133 — "installed" means the same fixed paths as the Hermes plugin (shared fixture)', () => {
  it('the candidate list is the fixture list, in order, and every entry is absolute', () => {
    expect([...CONTAINER_CANDIDATES]).toEqual(DETECT.candidates)
    expect(DETECT.candidates.every(candidate => path.isAbsolute(candidate))).toBe(true)
    expect(DETECT.cases.length).toBeGreaterThanOrEqual(6)
  })

  it.each(DETECT.cases)('$name', async ({ installed, present }) => {
    const exists = (file: string) => present.includes(file)
    const run: Runner = async () => ({ code: 0, stdout: b('container CLI version 1.5.0'), stderr: b('') })

    expect(containerBinary(exists)).toBe(installed)
    expect((await probeContainer(host({ exists, run }))).status).toBe(installed ? 'installed' : 'not-installed')
  })
})

describe('G3-1 — "installed" is one rule on both sides: the shared fixture\'s version-answer cases', () => {
  it("the pattern, timeout and platform floor are the fixture's", () => {
    expect(CONTAINER_VERSION_RE.source).toBe(DETECT.versionPattern)
    expect(CONTAINER_VERSION_TIMEOUT_MS).toBe(DETECT.versionTimeoutMs)
    expect(CONTAINER_MIN_DARWIN_MAJOR).toBe(DETECT.platform.minDarwinMajor)
    expect(DETECT.verdicts.length).toBeGreaterThanOrEqual(12)
  })

  it('the fixture covers every kind of answer the rule must judge (both sides read these cases)', () => {
    const has = (kind: (verdict: (typeof DETECT.verdicts)[number]) => boolean) => DETECT.verdicts.some(kind)

    expect(has(v => v.expect.status === 'installed')).toBe(true)
    expect(has(v => v.present.length > 0 && v.executable.length === 0)).toBe(true)
    expect(has(v => v.answer.code === 0 && v.executable.length > 0 && v.expect.status === 'broken')).toBe(true)
    expect(has(v => v.answer.code !== null && v.answer.code !== 0)).toBe(true)
    expect(has(v => v.answer.timedOut && v.expect.status === 'unknown')).toBe(true)
    // An exec error proper: not the overflow stop (G3 r2 m-4: that case alone must not satisfy this kind).
    expect(
      has(v => v.answer.error !== null && v.answer.error !== DETECT.output.overflowError && !v.answer.timedOut)
    ).toBe(true)
    expect(has(v => v.host.arch !== 'arm64')).toBe(true)
    expect(has(v => v.host.platform === 'darwin' && v.host.darwinMajor < DETECT.platform.minDarwinMajor)).toBe(true)
    expect(has(v => v.expect.status === 'not-installed')).toBe(true)
    // G3 r2 m-1: the byte-level edges both sides once split on.
    const bytesOf = (v: (typeof DETECT.verdicts)[number]) => b(v.answer.stdoutBytes)

    expect(has(v => bytesOf(v).some(byte => byte >= 0x80) && v.expect.status === 'installed')).toBe(true)
    expect(has(v => bytesOf(v).some(byte => byte >= 0x80) && v.expect.status === 'broken')).toBe(true)
    expect(has(v => v.answer.stdoutBytes.includes('\x1c'))).toBe(true)
    expect(has(v => v.answer.stdoutBytes.startsWith('\n') && v.expect.status === 'installed')).toBe(true)
    expect(has(v => v.answer.error === DETECT.output.overflowError && v.expect.status === 'broken')).toBe(true)
  })

  it.each(DETECT.verdicts)('$name', async ({ host: machine, present, executable, answer, read, expect: want }) => {
    const calls: [string, string[], number][] = []

    const run: Runner = async (file, args, timeoutMs) => {
      calls.push([file, args, timeoutMs])

      return { ...answer, stdout: b(answer.stdoutBytes), stderr: b(answer.stderrBytes) }
    }

    const view = await probeContainer(
      host({ ...machine, exists: file => present.includes(file), executable: file => executable.includes(file), run })
    )

    expect({ status: view.status, detail: view.detail, version: view.version }).toEqual({
      status: want.status,
      detail: want.detail,
      version: want.version
    })
    expect(containerRefusal(view)).toBe(
      `Apple container is not available in this version of icloneOS: ${want.seen}. The command is refused rather than run unconfined.`
    )
    // `--version` runs only on a supported Mac, on an executable fixed path, with the shared timeout.
    expect(calls).toEqual(
      want.runs ? [[containerBinary(file => present.includes(file)), ['--version'], DETECT.versionTimeoutMs]] : []
    )
    expect(view.enforcing).toBe(false)

    // G3 r2 m-1: the stub runner hands over the fixture's RAW BYTES; the text read from them is the fixture's.
    if (read !== undefined) {
      expect(view.evidence.endsWith(`: ${read}`), view.evidence).toBe(true)
    }
  })
})

describe('the real runner (G3-2 evidence): a hang is a timeout, a non-program is an exec error', () => {
  it('reports timedOut, the exec error code, and a clean exit, on throwaway files', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-probe-runner-'))

    try {
      const hang = path.join(dir, 'hang')
      const junk = path.join(dir, 'junk')

      writeFileSync(hang, '#!/bin/sh\nsleep 5\n')
      writeFileSync(junk, Buffer.from([0, 1, 2, 3]))
      chmodSync(hang, 0o755)
      chmodSync(junk, 0o755)

      expect(await runFile(hang, [], 200)).toMatchObject({ code: null, timedOut: true })
      expect(await runFile(junk, [], 2_000)).toMatchObject({ code: null, timedOut: false, error: expect.any(String) })
      expect(await runFile('/bin/sh', ['-c', 'exit 3'], 2_000)).toMatchObject({ code: 3, timedOut: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('G3 r2 m-2 — the timeout is enforced: SIGKILL to the whole group, no orphan', () => {
  const gone = async (pid: number, withinMs = 3_000): Promise<boolean> => {
    const end = Date.now() + withinMs

    while (Date.now() < end) {
      try {
        process.kill(pid, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          return true
        }
      }

      await new Promise(resolve => setTimeout(resolve, 20))
    }

    return false
  }

  it.each([
    // ignores SIGTERM and keeps a child: the old runner waited for it (5.2 s, 12.2 s, unbounded)
    ['ignores-TERM', 'trap \'\' TERM\nsleep 30 &\necho $! > "$PIDFILE"\nwait\n'],
    // exits at once while its child holds the pipe
    ['child-holds-pipe', 'sleep 30 &\necho $! > "$PIDFILE"\nexit 0\n']
  ])('%s: answers timedOut at the timeout, and the child it started is gone', async (_name, body) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-probe-kill-'))
    const pidfile = path.join(dir, 'child.pid')
    const prog = path.join(dir, 'container')
    const saved = process.env.PIDFILE

    try {
      writeFileSync(prog, `#!/bin/sh\n${body}`)
      chmodSync(prog, 0o755)
      process.env.PIDFILE = pidfile

      const started = Date.now()
      const answer = await runFile(prog, ['--version'], 600)
      const took = Date.now() - started

      expect(answer).toMatchObject({ code: null, timedOut: true, error: null })
      expect(took).toBeLessThan(600 + 1_500)

      const child = Number.parseInt(readFileSync(pidfile, 'utf8').trim(), 10)

      expect(await gone(child), `orphan ${child} survived the timeout`).toBe(true)
    } finally {
      if (saved === undefined) {
        delete process.env.PIDFILE
      } else {
        process.env.PIDFILE = saved
      }

      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('G3 r3 m-3 — a check that answers, leaves a child that dropped its pipes, and exits 0: installed, and the child is gone', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-probe-detached-'))
    const pidfile = path.join(dir, 'child.pid')
    const prog = path.join(dir, 'container')
    const saved = process.env.PIDFILE

    try {
      writeFileSync(
        prog,
        '#!/bin/sh\necho "container CLI version 1.5.0"\nsleep 30 </dev/null >/dev/null 2>&1 &\necho $! > "$PIDFILE"\nexit 0\n'
      )
      chmodSync(prog, 0o755)
      process.env.PIDFILE = pidfile

      const view = await probeContainer(
        host({
          exists: file => file === CONTAINER_CANDIDATES[0],
          run: (_file, args, timeoutMs) => runFile(prog, args, timeoutMs)
        })
      )

      expect({ status: view.status, version: view.version }).toEqual({ status: 'installed', version: '1.5.0' })

      const child = Number.parseInt(readFileSync(pidfile, 'utf8').trim(), 10)

      expect(await gone(child), `orphan ${child} survived a normal exit`).toBe(true)
    } finally {
      if (saved === undefined) {
        delete process.env.PIDFILE
      } else {
        process.env.PIDFILE = saved
      }

      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a check killed by a signal that is not the timeout is a definite failure (SIGKILL named), never the timeout', async () => {
    expect(await runFile('/bin/sh', ['-c', 'kill -KILL $$'], 3_000)).toEqual({
      code: null,
      stdout: b(''),
      stderr: b(''),
      timedOut: false,
      error: 'SIGKILL'
    })
  })
})

describe('G3 r2 m-1 — both sides read the same RAW BYTES the same way (shared fixture)', () => {
  it("the bound, the strip set and the overflow error are the fixture's", () => {
    expect(CHECK_OUTPUT_MAX_BYTES).toBe(DETECT.output.maxBytes)
    expect(CHECK_OUTPUT_STRIP).toBe(DETECT.output.strip)
    expect(DETECT.programs.length).toBeGreaterThanOrEqual(15)
    // G3 r3 m-2: the exact-boundary pair stays in the shared programs.
    expect(DETECT.programs.map(p => p.stdoutLength)).toEqual(
      expect.arrayContaining([DETECT.output.maxBytes, DETECT.output.maxBytes + 1])
    )
  })

  // G3 r2 m-4: the two edges that survived the critic's mutations are shared cases both runners must keep judging.
  it('the programs keep a kill that is not the timeout, and a good answer after leading blank space', () => {
    const body = (program: (typeof DETECT.programs)[number]) => Object.values(program.files)[0]?.bytes ?? ''

    expect(DETECT.programs.some(p => /kill -(KILL|TERM) \$\$/.test(body(p)) && p.expect.status === 'broken')).toBe(true)
    expect(
      DETECT.programs.some(p => body(p).includes('printf "\\n  container') && p.expect.status === 'installed')
    ).toBe(true)
  })

  it('decoding never throws, strips exactly " \\t\\r\\n", and keeps a BOM, NBSP and \\x1c', () => {
    expect(answerText(b('\n \t container\r\n'))).toBe('container')
    expect(answerText(b('\xff\xfe'))).toBe('\ufffd\ufffd')
    expect(answerText(b('x\x1c'))).toBe('x\x1c')
    expect(answerText(b('\xef\xbb\xbfx'))).toBe('\ufeffx')
    expect(answerText(b('x\xc2\xa0'))).toBe('x\u00a0')
  })

  // Real files, the REAL runner (spawn, bound, decode): the plugin's test runs the same programs through its runner.
  it.each(DETECT.programs)('$name', async ({ files, stdoutLength, expect: want }) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-probe-program-'))

    try {
      const to = (candidate: string) =>
        path.join(dir, CONTAINER_CANDIDATES.indexOf(candidate as never).toString(), 'ctr')

      for (const [candidate, file] of Object.entries(files)) {
        mkdirSync(path.dirname(to(candidate)), { recursive: true })
        writeFileSync(to(candidate), b(file.bytes))
        chmodSync(to(candidate), file.mode)
      }

      const view = await probeContainer({
        run: (file, args, timeoutMs) => runFile(to(file), args, timeoutMs),
        exists: file => existsSync(to(file)),
        executable: file => {
          try {
            accessSync(to(file), constants.X_OK)

            return true
          } catch {
            return false
          }
        },
        platform: 'darwin',
        arch: 'arm64',
        darwinMajor: 25
      })

      expect({ status: view.status, version: view.version }).toEqual(want)

      // G3 r3 m-2: the bound, to the byte: exactly maxBytes is kept whole; one more is stopped.
      if (stdoutLength !== undefined) {
        const answer = await runFile(to(CONTAINER_CANDIDATES[0]), ['--version'], CONTAINER_VERSION_TIMEOUT_MS)
        const over = stdoutLength > DETECT.output.maxBytes

        expect(answer.stdout.length).toBe(Math.min(stdoutLength, DETECT.output.maxBytes))
        expect(answer.error).toBe(over ? DETECT.output.overflowError : null)
        expect(answer.code).toBe(over ? null : 0)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('more than the bound is stopped and is an error, never the timeout, with at most the bound kept', async () => {
    const answer = await runFile('/bin/sh', ['-c', 'head -c 2000000 /dev/zero'], CONTAINER_VERSION_TIMEOUT_MS)

    expect(answer).toMatchObject({ code: null, timedOut: false, error: DETECT.output.overflowError })
    expect(answer.stdout.length).toBeLessThanOrEqual(CHECK_OUTPUT_MAX_BYTES)
  })
})
