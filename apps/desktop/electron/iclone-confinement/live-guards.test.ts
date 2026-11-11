import { type ChildProcess, spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CONFINEMENT_CHANNELS, registerConfinement } from './ipc'
import { BROWSER_PROOF_TITLE, browserProofPlan, INSTALLER_TEMPLATE, isThrowawayHome } from './live-guards'
import { appendStop, foldRuns, parseRunLine, type RunEvent } from './runs'

/**
 * How the live test registers the browser proof, read from its syntax tree so that a comment or the import never counts:
 * 'registered' only for exactly one plain `it(BROWSER_PROOF_TITLE, ...)` under no condition. `describe.runIf(LIVE)` is
 * the one wrapper allowed: the whole live file is gated that way, and the gate sets LIVE.
 */
function browserProofRegistration(source: string): string {
  const file = ts.createSourceFile('live.test.ts', source, ts.ScriptTarget.Latest, true)
  const found: string[] = []

  const verdictOf = (call: ts.CallExpression): string => {
    if (call.expression.getText(file) !== 'it') {
      return `conditional: ${call.expression.getText(file)}`
    }

    for (let up: ts.Node = call.parent; !ts.isSourceFile(up); up = up.parent) {
      if (ts.isIfStatement(up) || ts.isConditionalExpression(up) || ts.isBinaryExpression(up)) {
        return `conditional: under ${ts.SyntaxKind[up.kind]}`
      }

      if (ts.isCallExpression(up)) {
        const callee = up.expression.getText(file)

        if (callee !== 'describe' && callee !== 'describe.runIf(LIVE)') {
          return `conditional: under ${callee}`
        }
      }
    }

    return 'registered'
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.some(arg => arg.getText(file) === 'BROWSER_PROOF_TITLE')) {
      found.push(verdictOf(node))
    }

    ts.forEachChild(node, visit)
  }

  visit(file)

  return found.length === 1 ? found[0] : `registered ${found.length} times`
}

describe('live proof guards', () => {
  it('the browser proof runs with its fixture and Chrome', () => {
    expect(browserProofPlan({ fixture: '/fixed/agent-browser', chrome: true, inGate: true })).toEqual({ state: 'run' })
  })

  it('without Chrome the gate says NOT RUN, never a pass', () => {
    expect(browserProofPlan({ fixture: '/fixed/agent-browser', chrome: false, inGate: true }).state).toBe('not-run')
  })

  it('a gate without its own fixture is broken and fails; a developer without one sees NOT RUN', () => {
    expect(browserProofPlan({ fixture: null, chrome: true, inGate: true }).state).toBe('missing-in-gate')
    expect(browserProofPlan({ fixture: null, chrome: true, inGate: false }).state).toBe('not-run')
  })

  it('only a temp directory counts as a throwaway HOME', () => {
    expect(isThrowawayHome('/private/tmp/ih.abc/h')).toBe(true)
    expect(isThrowawayHome('/var/folders/xy/T/h')).toBe(true)
    expect(isThrowawayHome('/Users/me')).toBe(false)
    expect(isThrowawayHome('/Users/me/tmp/h')).toBe(false)
  })

  it('the live test is wired to them: no conditional registration, the HOME guard before its probes', () => {
    const source = readFileSync(path.join(__dirname, 'hermes-plugin.live.test.ts'), 'utf8')

    expect(browserProofRegistration(source)).toBe('registered')
    expect(BROWSER_PROOF_TITLE).toMatch(/browser runs inside/)

    const guard = source.indexOf('the terminal probes need a throwaway HOME')
    const firstWrite = source.indexOf('.iclone-v3g-lab`')

    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(firstWrite)
  })

  it('the wiring check itself fails on every way of dropping the registration', () => {
    const source = readFileSync(path.join(__dirname, 'hermes-plugin.live.test.ts'), 'utf8')
    const plain = /\bit\(\s*BROWSER_PROOF_TITLE,/

    expect(source).toMatch(plain)

    const mutants: Record<string, string> = {
      'renamed so nothing registers': source.replace(plain, "it('another title',"),
      'it.runIf': source.replace(plain, 'it.runIf(Boolean(AGENT_BROWSER_SRC))(BROWSER_PROOF_TITLE,'),
      'it.skipIf': source.replace(plain, 'it.skipIf(!AGENT_BROWSER_SRC)(BROWSER_PROOF_TITLE,'),
      'it.skip': source.replace(plain, 'it.skip(BROWSER_PROOF_TITLE,'),
      'commented out': source.replace(plain, "// it(BROWSER_PROOF_TITLE,\nit('another title',"),
      'under an if': source.replace(plain, 'if (AGENT_BROWSER_SRC) it(BROWSER_PROOF_TITLE,'),
      'under &&': source.replace(plain, 'AGENT_BROWSER_SRC && it(BROWSER_PROOF_TITLE,')
    }

    for (const [name, mutant] of Object.entries(mutants)) {
      expect(mutant, name).not.toBe(source)
      expect(browserProofRegistration(mutant), name).not.toBe('registered')
    }
  })
})

// B-n2 sits here because this review's file list holds runs.ts and index.ts but not their test files (review/fx9.md).
describe('a failed Stop never reads as stopped by you', () => {
  const RUN = `project+${'a'.repeat(12)}+sess-1+${'c'.repeat(32)}`
  const T0 = Date.parse('2026-11-04T10:00:00.000Z')
  const at = (sec: number) => new Date(T0 + sec * 1_000).toISOString()

  const startLine = {
    v: 1,
    ev: 'start',
    ts: at(0),
    run: RUN,
    pid: 4242,
    kind: 'shell',
    cls: 'project',
    sha: 'a'.repeat(64),
    session: 'sess-1',
    command: 'sleep 30',
    cwd: '/tmp',
    project: null,
    net: false,
    write: false
  }

  const endLine = (sec: number, code: number | null, signal: number | null) => ({
    v: 1,
    ev: 'end',
    ts: at(sec),
    run: RUN,
    pid: 4242,
    code,
    signal
  })

  const stopLine = (sec: number) => ({ v: 1, ev: 'stop', ts: at(sec), run: RUN })
  const failedLine = (sec: number) => ({ ...stopLine(sec), outcome: 'failed' })

  const fold = (...lines: object[]) => {
    const events = lines
      .map(line => parseRunLine(JSON.stringify(line)))
      .filter((event): event is RunEvent => event !== null)

    return foldRuns({ nowMs: T0 + 600_000, events, rows: [], verified: true, refusals: new Map() })[0]
  }

  it("the run's own end speaks when the kill reported survivors", () => {
    expect(fold(startLine, stopLine(10), failedLine(10), endLine(50, 0, null))).toMatchObject({
      phase: 'exited',
      endedAt: at(50)
    })
    expect(fold(startLine, stopLine(10), failedLine(10), endLine(50, 3, null))).toMatchObject({
      phase: 'failed',
      exitCode: 3
    })
  })

  it("a signal Stop sends, after Stop was pressed, is the Stop's doing even though a process outlived that round", () => {
    expect(fold(startLine, stopLine(10), failedLine(10), endLine(11, null, 15))).toMatchObject({ phase: 'stopped' })
    expect(fold(startLine, stopLine(10), failedLine(10), endLine(11, null, 9))).toMatchObject({ phase: 'stopped' })
    // Before Stop was pressed, or another signal: not Stop's.
    expect(fold(startLine, endLine(5, null, 15), stopLine(10), failedLine(10))).toMatchObject({ phase: 'failed' })
    expect(fold(startLine, stopLine(10), failedLine(10), endLine(11, null, 11))).toMatchObject({ phase: 'failed' })
  })

  it('no end and nothing alive after a failed Stop is unknown, with no end time borrowed from the Stop', () => {
    expect(fold(startLine, stopLine(10), failedLine(10))).toMatchObject({ phase: 'unknown', endedAt: null })
  })

  it('pressing Stop again supersedes the failure, and a Stop with no outcome line reads stopped as before', () => {
    expect(fold(startLine, stopLine(10), failedLine(10), stopLine(20), endLine(21, 0, null))).toMatchObject({
      phase: 'stopped'
    })
    expect(fold(startLine, stopLine(10), endLine(11, 0, null))).toMatchObject({ phase: 'stopped' })
  })

  it('appendStop writes the outcome and the reader returns it; a bad outcome reads as no outcome', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'v006-stop-outcome-'))

    try {
      const file = path.join(root, 'stops.jsonl')

      appendStop(file, RUN, at(10))
      appendStop(file, RUN, at(10), 'failed')

      const lines = readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => parseRunLine(line))

      expect(lines).toEqual([
        { ev: 'stop', ts: at(10), run: RUN },
        { ev: 'stop', ts: at(10), run: RUN, outcome: 'failed' }
      ])
      expect(parseRunLine(JSON.stringify({ ...stopLine(1), outcome: 'nonsense' }))).toEqual({
        ev: 'stop',
        ts: at(1),
        run: RUN
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  describe('through the real stop-run path', () => {
    const children: ChildProcess[] = []
    const roots: string[] = []

    afterEach(() => {
      vi.restoreAllMocks()

      for (const child of children.splice(0)) {
        child.kill('SIGKILL')
      }

      for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it("a kill that leaves survivors records the failure, and the later exit reads as the run's own", async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'v006-stop-fail-'))

      roots.push(root)

      const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })

      children.push(child)

      const pid = child.pid as number
      const userDataDir = path.join(root, 'userData')
      const journal = path.join(userDataDir, 'confinement', 'ledger', 'runs.jsonl')
      const memberPython = path.join(root, 'member-python.sh')

      mkdirSync(path.dirname(journal), { recursive: true })
      writeFileSync(journal, `${JSON.stringify({ ...startLine, ts: new Date().toISOString(), pid })}\n`)
      writeFileSync(memberPython, `#!/bin/sh\n/bin/cat > /dev/null\necho '${JSON.stringify({ [pid]: RUN })}'\n`, {
        mode: 0o700
      })

      // Every signal is swallowed, so this process outlives each round of the backend's kill.
      const realKill = process.kill.bind(process)

      vi.spyOn(process, 'kill').mockImplementation((target: number, signal?: string | number) =>
        target === pid || target === -pid ? true : realKill(target, signal)
      )

      const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

      const layer = registerConfinement({
        userDataDir,
        home: path.join(root, 'home'),
        hermesHome: path.join(root, 'home', '.hermes'),
        hermesRoot: null,
        hermesPids: () => [],
        audit: () => [],
        memberPython,
        ps: async () =>
          child.exitCode === null && child.signalCode === null
            ? [{ pid, ppid: process.pid, pgid: pid, elapsedSec: 1, command: '/bin/sleep 30' }]
            : [],
        ipcMain: {
          handle: (channel, listener) =>
            void handlers.set(channel, listener as (event: unknown, ...args: unknown[]) => unknown)
        },
        isTrustedSender: () => true
      })

      const result = await handlers.get(CONFINEMENT_CHANNELS.stopRun)?.({}, { run: RUN })

      expect(result).toMatchObject({ ok: false, reason: 'survivors' })

      const stops = readFileSync(path.join(userDataDir, 'confinement', 'stops.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)

      expect(stops).toHaveLength(2)
      expect(JSON.parse(stops[1])).toMatchObject({ ev: 'stop', run: RUN, outcome: 'failed' })

      vi.restoreAllMocks()
      child.kill('SIGKILL')
      await new Promise(resolve => child.once('exit', resolve))
      appendFileSync(journal, `${JSON.stringify({ ...endLine(0, 0, null), ts: new Date().toISOString(), pid })}\n`)

      const after = await layer.state()

      expect(after.runs.find(run => run.id === RUN)?.phase).toBe('exited')
    }, 30_000)
  })
})

describe('the live worlds start from what a clean install writes (FX35)', () => {
  it('the template still names a backend, so the gate means what it says', () => {
    expect(readFileSync(INSTALLER_TEMPLATE, 'utf8')).toMatch(/^terminal:\n {2}backend: "local"$/m)
  })

  it.each(['live-harness.ts', 'launcher-live-harness.ts', 'runtime-live-harness.ts'])(
    '%s writes the real template, not a stub with no backend',
    file => {
      const source = readFileSync(path.join(import.meta.dirname, file), 'utf8')

      expect(source).toContain('writeInstallerConfig(hermesHome)')
      expect(source).not.toMatch(/config\.yaml'\), '(terminal|model): \{\}/)
    }
  )
})
