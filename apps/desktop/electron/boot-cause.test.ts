/**
 * v0.0.9 F2 (P0_HERMES_FAILURES bug B, gate G1): the boot cause is structural and read from the child's OWN output.
 *
 * Red on the old code: there was no cause at all — the boot error was `… Log: <path>\n<last 20 desktop.log lines>`,
 * and those lines always hold main's own `[iclone-gate] … loaded by Hermes`, so a substring test made every pre-ready
 * exit "the permission gate is not in place" (14 Nov: four "install state is not writable" exits shown that way).
 */
import { describe, expect, it } from 'vitest'

import {
  boundedCauseLine,
  classifyBootError,
  classifyBootExit,
  isBootCause,
  isDeterministicBootCause,
  isSupersededBootError,
  missingModuleOf,
  readBootCause,
  withBootCause
} from './boot-cause'

/** The real 14 Nov line (path shortened), as the runtime prints it on stderr. */
const STALE_LEASE =
  'hermes: install state is not writable by this user (/Users/u/.hermes/installs/f3cca8023c228495/environments/d2a0574ad8364ad4a87cee896f2a3bea/.leases/1c4f); run as the install owner or grant write access'

/** What the SHARED log tail looked like at that moment: main's own gate success lines. */
const SHARED_LOG_TAIL = [
  '[iclone-gate] iclone-confinement: verified',
  '[iclone-gate] iclone-permissions loaded by Hermes at 2026-11-14T09:27:43.223Z',
  'Starting Hermes backend via Hermes at /Users/u/Library/Application Support/iclone os/hermes-runtime/x'
].join('\n')

describe('classifyBootExit — the child exited before ready', () => {
  it('the stale install record (cause A) is install-state-not-writable, never the gate', () => {
    const cause = classifyBootExit({ code: 1, output: `some warning\n${STALE_LEASE}\n` })

    expect(cause.code).toBe('install-state-not-writable')
    expect(cause.line).toContain('install state is not writable')
    expect(isDeterministicBootCause(cause)).toBe(true)
  })

  it('a gate SUCCESS line in the output is never a gate failure (the 14 Nov misreading)', () => {
    const cause = classifyBootExit({
      code: 1,
      output: `${SHARED_LOG_TAIL}\nTraceback (most recent call last):\nRuntimeError: boom\n`
    })

    expect(cause.code).toBe('exit-nonzero')
    expect(cause.line).toBe('RuntimeError: boom')
  })

  it('sandbox-exec 71 (the profile could not exec the interpreter) is gate-not-loaded', () => {
    const output = "sandbox-exec: execvp() of '/x/python' failed: Operation not permitted\n"

    expect(classifyBootExit({ code: 71, output }).code).toBe('gate-not-loaded')
    expect(classifyBootExit({ code: 71, confinedExec: 'The agent runtime could not start…', output }).line).toBe(
      'The agent runtime could not start…'
    )
  })

  it('a bind failure is port-in-use; an import failure is python-import (deterministic)', () => {
    expect(classifyBootExit({ code: 1, output: 'OSError: [Errno 48] Address already in use' }).code).toBe('port-in-use')
    expect(classifyBootExit({ code: 1, output: 'Error: listen EADDRINUSE 127.0.0.1:9119' }).code).toBe('port-in-use')

    const importFailure = classifyBootExit({ code: 1, output: "ModuleNotFoundError: No module named 'yaml'" })

    expect(importFailure.code).toBe('python-import')
    expect(isDeterministicBootCause(importFailure)).toBe(true)
  })

  it('a bare non-zero exit or a signal is exit-nonzero (transient: restartable)', () => {
    const silent = classifyBootExit({ code: 1, output: '' })

    expect(silent).toEqual({ code: 'exit-nonzero', line: 'exit 1' })
    expect(classifyBootExit({ code: null, output: '', signal: 'SIGKILL' }).code).toBe('exit-nonzero')
    expect(isDeterministicBootCause(silent)).toBe(false)
  })

  it('a clean exit with nothing recognisable is unknown', () => {
    expect(classifyBootExit({ code: 0, output: '' })).toEqual({ code: 'unknown' })
  })

  it('the newest matching line wins, ANSI stripped, secrets masked, capped', () => {
    const output = `\u001b[31mtoken=abc123secretvalue ${'x'.repeat(400)}\u001b[0m\n${STALE_LEASE}`
    const cause = classifyBootExit({ code: 1, output })

    expect(cause.code).toBe('install-state-not-writable')
    expect(boundedCauseLine(output.split('\n')[0]!)).not.toContain('abc123secretvalue')
    expect(boundedCauseLine('y'.repeat(500)).length).toBeLessThanOrEqual(241)
  })
})

describe('classifyBootError — main’s own errors', () => {
  it('a carried cause always wins', () => {
    const error = withBootCause(new Error('[iclone-gate] looks like a gate'), { code: 'port-in-use' })

    expect(classifyBootError(error)).toEqual({ code: 'port-in-use' })
    expect(readBootCause(error)).toEqual({ code: 'port-in-use' })
  })

  it('an IcloneGateError (structured flag) or a message main STARTS with the mark is the gate', () => {
    const typed = Object.assign(new Error('anything'), { isIcloneGateFailure: true })

    expect(classifyBootError(typed).code).toBe('gate-not-loaded')
    expect(classifyBootError(new Error('[iclone-gate] The icloneOS permission gate is not in place: x')).code).toBe(
      'gate-not-loaded'
    )
  })

  it('the old shape — a boot error carrying the shared log after "Log:" — is NOT the gate (red before F2)', () => {
    const old = new Error(
      `Hermes backend exited before it became ready (1). Log: /Users/u/.hermes/logs/desktop.log\n${SHARED_LOG_TAIL}\n${STALE_LEASE}`
    )

    expect(classifyBootError(old).code).not.toBe('gate-not-loaded')
  })

  it('deadlines are timeout; anything else unknown; superseded attempts are recognised', () => {
    expect(classifyBootError(new Error('Timed out waiting for Hermes backend port announcement')).code).toBe('timeout')
    expect(classifyBootError(new Error('weird')).code).toBe('unknown')
    expect(classifyBootError('not an error').code).toBe('unknown')
    expect(isSupersededBootError(new Error('Hermes backend start was superseded by a newer connection attempt.'))).toBe(
      true
    )
  })

  it('isBootCause rejects malformed values (the renderer reads it across IPC)', () => {
    expect(isBootCause({ code: 'timeout' })).toBe(true)
    expect(isBootCause({ code: 'nope' })).toBe(false)
    expect(isBootCause({ code: 'timeout', line: 3 })).toBe(false)
    expect(isBootCause(null)).toBe(false)
  })
})

describe('v0.0.9 Q (lead decision 5): only the end of the output decides', () => {
  const normal = Array.from({ length: 40 }, (_, i) => `INFO serving request ${i}`)

  it('an old optional-import warning followed by 40 normal lines and a SIGKILL is a plain exit, not python-import', () => {
    const output = [`WARNING tools: No module named 'playwright' (optional, skipped)`, ...normal].join('\n')

    expect(classifyBootExit({ code: null, output, signal: 'SIGKILL' }).code).toBe('exit-nonzero')
    expect(classifyBootExit({ code: 1, output }).code).toBe('exit-nonzero')
    expect(isDeterministicBootCause(classifyBootExit({ code: 1, output }))).toBe(false)
  })

  it('an old EADDRINUSE or install-state line far up is no verdict either', () => {
    for (const old of ['OSError: [Errno 48] address already in use', STALE_LEASE]) {
      expect(classifyBootExit({ code: 1, output: [old, ...normal].join('\n') }).code).toBe('exit-nonzero')
    }
  })

  it('the same lines at the end still decide before readiness', () => {
    const traceback = [
      ...normal,
      'Traceback (most recent call last):',
      '  File "/rt/hermes_cli/main.py", line 3, in <module>',
      '    import yaml',
      "ModuleNotFoundError: No module named 'yaml'"
    ].join('\n')

    expect(classifyBootExit({ code: 1, output: traceback }).code).toBe('python-import')
    expect(classifyBootExit({ code: 1, output: [...normal, STALE_LEASE].join('\n') }).code).toBe(
      'install-state-not-writable'
    )
  })

  it('critic m2: a skipped optional-import traceback inside the last 25 lines is no verdict when the process carried on', () => {
    const skipped = [
      ...normal.slice(0, 20),
      'Traceback (most recent call last):',
      '  File "/rt/tools/browser.py", line 9, in <module>',
      '    import playwright',
      "ModuleNotFoundError: No module named 'playwright'",
      'WARNING tools: browser tool disabled (optional dependency missing)',
      'INFO gateway: loading profile',
      'INFO gateway: binding 127.0.0.1:0'
    ].join('\n')

    expect(classifyBootExit({ code: 1, output: skipped }).code).toBe('exit-nonzero')
    expect(isDeterministicBootCause(classifyBootExit({ code: 1, output: skipped }))).toBe(false)
  })

  it('critic m2: a stray import WARNING line as the last line is not an exception line, so it is transient', () => {
    const output = [...normal, `WARNING tools: No module named 'playwright' (optional, skipped)`].join('\n')

    expect(classifyBootExit({ code: 1, output }).code).toBe('exit-nonzero')
  })

  it('critic m2: an import traceback that ends the output but the process died by a signal is transient', () => {
    const output = [
      ...normal,
      'Traceback (most recent call last):',
      '    import yaml',
      "ModuleNotFoundError: No module named 'yaml'"
    ].join('\n')

    expect(classifyBootExit({ code: null, output, signal: 'SIGKILL' }).code).toBe('exit-nonzero')
  })

  it('critic m2: an earlier import traceback followed by a different final exception is that exception, not python-import', () => {
    const output = [
      'Traceback (most recent call last):',
      '    import playwright',
      "ModuleNotFoundError: No module named 'playwright'",
      'INFO gateway: starting',
      'Traceback (most recent call last):',
      '  File "/rt/gateway/run.py", line 40, in main',
      'RuntimeError: event loop closed'
    ].join('\n')

    expect(classifyBootExit({ code: 1, output }).code).toBe('exit-nonzero')
  })

  it('critic m2: the import exception that ends the process stays python-import, with up to two trailing lines', () => {
    const output = [
      ...normal,
      'Traceback (most recent call last):',
      '  File "/rt/hermes_cli/main.py", line 3, in <module>',
      '    from yaml import safe_load',
      "ImportError: cannot import name 'safe_load' from 'yaml'",
      'sys:1: ResourceWarning: unclosed file'
    ].join('\n')

    expect(classifyBootExit({ code: 1, output })).toEqual({
      code: 'python-import',
      line: "ImportError: cannot import name 'safe_load' from 'yaml'"
    })
  })

  it('after readiness: only a non-zero exit whose last lines say it; a signal or an old line is a plain crash', () => {
    const late = [...normal, 'OSError: [Errno 48] address already in use'].join('\n')

    expect(classifyBootExit({ afterReady: true, code: 1, output: late }).code).toBe('port-in-use')
    expect(classifyBootExit({ afterReady: true, code: null, output: late, signal: 'SIGKILL' }).code).toBe(
      'exit-nonzero'
    )

    const earlier = ['OSError: [Errno 48] address already in use', ...normal.slice(0, 10)].join('\n')

    expect(classifyBootExit({ afterReady: true, code: 1, output: earlier }).code).toBe('exit-nonzero')
  })
})

describe('v0.0.9 r2 (m-r2-3): the runtime’s own “Details: No module named” last line', () => {
  // The r2 proof's real output (fastapi moved out of the managed venv), verbatim from run-21/stdout.log.
  const REAL = [
    '⚠ install out of sync (ffmpeg: not installed or outdated; node: not installed or outdated) — this unknown-managed install must rebuild the artifact to fix',
    "The dashboard can't start: its web-server packages (fastapi, uvicorn) are missing from this install.",
    'Run `hermes pm install` to prepare the declared dependencies.',
    'If an installed dependency is damaged, run `hermes pm repair`, then restart Hermes.',
    "Details: No module named 'fastapi'"
  ].join('\n')

  it('is python-import (deterministic), naming the missing package', () => {
    const cause = classifyBootExit({ code: 1, output: REAL })

    expect(cause).toEqual({ code: 'python-import', line: "Details: No module named 'fastapi'" })
    expect(isDeterministicBootCause(cause)).toBe(true)
    expect(missingModuleOf(cause)).toBe('fastapi')
    expect(missingModuleOf({ code: 'python-import', line: "ModuleNotFoundError: No module named 'yaml.cyaml'" })).toBe(
      'yaml'
    )
    expect(missingModuleOf({ code: 'exit-nonzero', line: "Details: No module named 'fastapi'" })).toBeNull()
  })

  it('only as the LAST line of a non-zero exit, never with a signal, never further up', () => {
    expect(classifyBootExit({ code: 0, output: REAL }).code).not.toBe('python-import')
    expect(classifyBootExit({ code: null, output: REAL, signal: 'SIGKILL' }).code).toBe('exit-nonzero')
    expect(classifyBootExit({ code: 1, output: `${REAL}\nserving on 127.0.0.1:9119\nshutting down` }).code).toBe(
      'exit-nonzero'
    )
    // A Details line about something else is no import verdict.
    expect(classifyBootExit({ code: 1, output: 'Details: session abc opened by cli.' }).code).toBe('exit-nonzero')
  })
})
