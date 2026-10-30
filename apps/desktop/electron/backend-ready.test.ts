/**
 * Tests for electron/backend-ready.ts.
 *
 * Run with: node --test electron/backend-ready.test.ts
 * (Wired into npm test:desktop:platforms in package.json.)
 *
 * Covers the cold-start port-announcement deadline (issue #50209): the clock
 * starts before the backend binds its port, so a tight 45s deadline killed a
 * healthy-but-still-compiling backend on cold Windows installs. The default is
 * now cold-start tolerant (90 s). Ruling 42 removed the env override that could lengthen it.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, vi } from 'vitest'

import {
  DEFAULT_PORT_ANNOUNCE_TIMEOUT_MS,
  MIN_PORT_ANNOUNCE_TIMEOUT_MS,
  readDashboardReadyFile,
  resolvePortAnnounceTimeoutMs,
  waitForDashboardPort,
  waitForDashboardPortAnnouncement,
  waitForDashboardReadyFile
} from './backend-ready'
import { endInstallBudget } from './install-liveness'
import { watchBackendBoot } from './main/backend-boot-watch'

type FakeChildProcess = EventEmitter & {
  stdout: EventEmitter
}

// A minimal stand-in for a spawned child process: an EventEmitter with a
// stdout EventEmitter, matching the surface waitForDashboardPort consumes
// (child.stdout.on('data'), child.on('exit'|'error') + the .off() teardown).
function makeFakeChild(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess
  child.stdout = new EventEmitter()

  return child
}

// ---------------------------------------------------------------------------
// resolvePortAnnounceTimeoutMs
// ---------------------------------------------------------------------------

test('default is cold-start tolerant (> the historical 45s floor)', () => {
  assert.equal(resolvePortAnnounceTimeoutMs({}), DEFAULT_PORT_ANNOUNCE_TIMEOUT_MS)
  assert.ok(
    DEFAULT_PORT_ANNOUNCE_TIMEOUT_MS > MIN_PORT_ANNOUNCE_TIMEOUT_MS,
    'cold-start default must exceed the warm-start floor'
  )
})

test('ruling 42 (critic M4): HERMES_DESKTOP_PORT_ANNOUNCE_TIMEOUT_MS no longer moves the budget, in either direction', () => {
  for (const value of ['120000', '1000000000', '1000', '60000.7', '', 'abc', '0', '-5']) {
    assert.equal(
      resolvePortAnnounceTimeoutMs({ HERMES_DESKTOP_PORT_ANNOUNCE_TIMEOUT_MS: value }),
      DEFAULT_PORT_ANNOUNCE_TIMEOUT_MS,
      value
    )
  }

  assert.equal(DEFAULT_PORT_ANNOUNCE_TIMEOUT_MS, 90_000)
})

test('the default port wait reads no env at all (the knob is gone from the source)', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, 'backend-ready.ts'), 'utf8')

  assert.equal(/env\.HERMES_DESKTOP_PORT_ANNOUNCE_TIMEOUT_MS/.test(source), false)
})

// ---------------------------------------------------------------------------
// waitForDashboardPort
// ---------------------------------------------------------------------------

test('resolves with the announced port', async () => {
  const child = makeFakeChild()
  const p = waitForDashboardPort(child, 1000)
  child.stdout.emit('data', 'noise before\nHERMES_DASHBOARD_READY port=54321\n')
  assert.equal(await p, 54321)
})

test('rejects when the child has no piped stdout', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: null })
  await assert.rejects(waitForDashboardPort(child, 1000), /stdout is not piped/)
})

test('resolves with a HERMES_BACKEND_READY port (headless `serve`)', async () => {
  const child = makeFakeChild()
  const p = waitForDashboardPort(child, 1000)
  child.stdout.emit('data', 'HERMES_BACKEND_READY port=43210\n')
  assert.equal(await p, 43210)
})

test('parses the port even when the line arrives split across chunks', async () => {
  const child = makeFakeChild()
  const p = waitForDashboardPort(child, 1000)
  child.stdout.emit('data', 'HERMES_DASHBOARD_READY po')
  child.stdout.emit('data', 'rt=8080\n')
  assert.equal(await p, 8080)
})

test('rejects when the child exits before announcing', async () => {
  const child = makeFakeChild()
  const p = waitForDashboardPort(child, 1000)
  child.emit('exit', 1, null)
  await assert.rejects(p, /exited before port announcement/)
})

test('rejects on a child error event', async () => {
  const child = makeFakeChild()
  const p = waitForDashboardPort(child, 1000)
  child.emit('error', new Error('spawn ENOENT'))
  await assert.rejects(p, /spawn ENOENT/)
})

test('rejects with the timeout message after the deadline', async () => {
  const child = makeFakeChild()
  await assert.rejects(
    waitForDashboardPort(child, 20),
    /Timed out waiting for Hermes backend port announcement \(20ms\)/
  )
})

test('a late announcement after timeout does not throw (listeners torn down)', async () => {
  const child = makeFakeChild()
  await assert.rejects(waitForDashboardPort(child, 20), /Timed out/)
  // The orphaned backend may still print its READY line later; the watcher
  // must have detached so this emit is a no-op rather than a double-settle.
  assert.doesNotThrow(() => {
    child.stdout.emit('data', 'HERMES_DASHBOARD_READY port=9999\n')
  })
})

// ---------------------------------------------------------------------------
// ready-file port announcement
// ---------------------------------------------------------------------------

function mkTmpReadyFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-ready-test-'))

  return {
    dir,
    file: path.join(dir, 'ready.json'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('readDashboardReadyFile returns a valid port from JSON', () => {
  const tmp = mkTmpReadyFile()

  try {
    fs.writeFileSync(tmp.file, JSON.stringify({ port: 4567 }))
    assert.equal(readDashboardReadyFile(tmp.file), 4567)
  } finally {
    tmp.cleanup()
  }
})

test('readDashboardReadyFile ignores missing, malformed, or invalid files', () => {
  const tmp = mkTmpReadyFile()

  try {
    assert.equal(readDashboardReadyFile(tmp.file), null)
    fs.writeFileSync(tmp.file, '{')
    assert.equal(readDashboardReadyFile(tmp.file), null)
    fs.writeFileSync(tmp.file, JSON.stringify({ port: 0 }))
    assert.equal(readDashboardReadyFile(tmp.file), null)
  } finally {
    tmp.cleanup()
  }
})

test('waitForDashboardReadyFile resolves when the ready file appears', async () => {
  const tmp = mkTmpReadyFile()
  const child = makeFakeChild()

  try {
    const p = waitForDashboardReadyFile(tmp.file, child, 1000)
    setTimeout(() => fs.writeFileSync(tmp.file, JSON.stringify({ port: 8765 })), 20)
    assert.equal(await p, 8765)
  } finally {
    tmp.cleanup()
  }
})

test('waitForDashboardPortAnnouncement uses ready file when provided', async () => {
  const tmp = mkTmpReadyFile()
  const child = makeFakeChild()

  try {
    const p = waitForDashboardPortAnnouncement(child, { readyFile: tmp.file, timeoutMs: 1000 })
    setTimeout(() => fs.writeFileSync(tmp.file, JSON.stringify({ port: 9876 })), 20)
    assert.equal(await p, 9876)
  } finally {
    tmp.cleanup()
  }
})

test('waitForDashboardReadyFile rejects when the child exits before file readiness', async () => {
  const tmp = mkTmpReadyFile()
  const child = makeFakeChild()

  try {
    const p = waitForDashboardReadyFile(tmp.file, child, 1000)
    child.emit('exit', 1, null)
    await assert.rejects(p, /exited before port announcement/)
  } finally {
    tmp.cleanup()
  }
})

// ---------------------------------------------------------------------------
// describeOutputTail (#93608): the child's real stderr reaches the exit error
// ---------------------------------------------------------------------------

test('exit-before-announcement error carries the buffered output tail (stdout path)', async () => {
  const child = makeFakeChild()

  const wait = waitForDashboardPortAnnouncement(child, {
    describeOutputTail: () => '\nRecent backend output:\nModuleNotFoundError: hermes_cli'
  })

  child.emit('exit', 1, null)

  await assert.rejects(wait, /exited before port announcement \(1\)[\s\S]*ModuleNotFoundError: hermes_cli/)
})

test('exit-before-announcement error carries the buffered output tail (ready-file path)', async () => {
  const child = makeFakeChild()
  const readyFile = path.join(os.tmpdir(), `hermes-ready-${process.pid}-${Date.now()}.json`)

  const wait = waitForDashboardPortAnnouncement(child, {
    describeOutputTail: () => '\nRecent backend output:\nTraceback (most recent call last)',
    readyFile
  })

  child.emit('exit', null, 'SIGSEGV')

  await assert.rejects(wait, /exited before port announcement \(SIGSEGV\)[\s\S]*Traceback/)
})

test('exit-before-announcement error stays clean when no output was buffered', async () => {
  const child = makeFakeChild()

  const wait = waitForDashboardPortAnnouncement(child, {})

  child.emit('exit', 137, null)

  await assert.rejects(wait, error => {
    assert.match((error as Error).message, /exited before port announcement \(137\)$/)

    return true
  })
})

// ---------------------------------------------------------------------------
// RTB-2 (ruling 42 + amendment): the port deadline slides on the child's install output
// ---------------------------------------------------------------------------

function portChild() {
  const child = makeFakeChild() as FakeChildProcess & { stderr: EventEmitter; exitCode: null | number }
  child.stderr = new EventEmitter()
  child.exitCode = null

  return child
}

async function withFakeTimers(run: () => Promise<void>) {
  vi.useFakeTimers()
  endInstallBudget()

  try {
    await run()
  } finally {
    vi.useRealTimers()
  }
}

function settle<T>(promise: Promise<T>) {
  const out: { error?: Error; settled: boolean; value?: T } = { settled: false }
  promise.then(
    value => Object.assign(out, { settled: true, value }),
    error => Object.assign(out, { error, settled: true })
  )

  return out
}

test('RTB-2 a serve that syncs dependencies for 200 s before binding still gets its port (0.0.2 timeline, slower)', () =>
  withFakeTimers(async () => {
    const child = portChild()
    const watch = watchBackendBoot(child, { publishDependenciesStep: () => {}, publishHeartbeat: () => {} })
    const out = settle(waitForDashboardPort(child, 90_000, () => '', watch.source))

    child.stderr.emit('data', 'hermes: completing source-update dependencies...\n')

    for (let t = 0; t < 200_000; t += 10_000) {
      await vi.advanceTimersByTimeAsync(10_000)
      child.stderr.emit('data', '  → Installing Python dependencies…\n')
      assert.equal(out.settled, false)
    }

    child.stdout.emit('data', 'HERMES_BACKEND_READY port=57038\n')
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(out.value, 57038)
  }))

test('RTB-2 without install output the port budget is the fixed one of before, whatever the child prints', () =>
  withFakeTimers(async () => {
    const child = portChild()
    const watch = watchBackendBoot(child, { publishDependenciesStep: () => {}, publishHeartbeat: () => {} })
    const out = settle(waitForDashboardPort(child, 90_000, () => '', watch.source))

    for (let t = 0; t < 89_000; t += 1_000) {
      await vi.advanceTimersByTimeAsync(1_000)
      child.stderr.emit('data', 'INFO: importing gateway\n')
    }

    assert.equal(out.settled, false)
    await vi.advanceTimersByTimeAsync(1_000)
    assert.match(String(out.error?.message), /Timed out waiting for Hermes backend port announcement \(90000ms\)/)
  }))

test('RTB-2 r2 install output that stops: the port wait fails 120 s after the last line (past the 90 s floor)', () =>
  withFakeTimers(async () => {
    const child = portChild()
    const watch = watchBackendBoot(child, { publishDependenciesStep: () => {}, publishHeartbeat: () => {} })
    const out = settle(waitForDashboardPort(child, 90_000, () => '', watch.source))

    for (let t = 0; t < 120_000; t += 10_000) {
      child.stderr.emit('data', 'Downloading pydantic-core (1.9MiB)\n')
      await vi.advanceTimersByTimeAsync(10_000)
    }

    // Last line at 110 s; the clock is at 120 s: the deadline is 110 + 120 = 230 s.
    await vi.advanceTimersByTimeAsync(109_999)
    assert.equal(out.settled, false)
    await vi.advanceTimersByTimeAsync(1)
    assert.match(String(out.error?.message), /no progress \(output or CPU\) for 120 s/)
  }))

test('RTB-2 r2 install output past the one 15-minute budget fails with a message naming it', () =>
  withFakeTimers(async () => {
    const child = portChild()
    const watch = watchBackendBoot(child, { publishDependenciesStep: () => {}, publishHeartbeat: () => {} })
    const out = settle(waitForDashboardPort(child, 90_000, () => '', watch.source))

    for (let t = 0; t < 899_000; t += 1_000) {
      child.stderr.emit('data', '  agent-browser:  12.3%  20.0 MiB / 162.3 MiB\r')
      await vi.advanceTimersByTimeAsync(1_000)
    }

    assert.equal(out.settled, false)
    child.stderr.emit('data', '  agent-browser:  12.4%  20.1 MiB / 162.3 MiB\r')
    await vi.advanceTimersByTimeAsync(1_000)
    assert.match(String(out.error?.message), /ceiling 900 s reached/)
  }))

test('RTB-2 a child that exits mid-install fails at once', () =>
  withFakeTimers(async () => {
    const child = portChild()
    const watch = watchBackendBoot(child, { publishDependenciesStep: () => {}, publishHeartbeat: () => {} })
    const out = settle(waitForDashboardPort(child, 90_000, () => '', watch.source))

    child.stderr.emit('data', '→ Installing Python dependencies…\n')
    await vi.advanceTimersByTimeAsync(5_000)
    child.emit('exit', 1, null)
    await vi.advanceTimersByTimeAsync(0)
    assert.match(String(out.error?.message), /exited before port announcement/)
  }))
