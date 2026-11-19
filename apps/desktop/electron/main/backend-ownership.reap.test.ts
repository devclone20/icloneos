/**
 * v0.0.9 eng r3-n1 (and the orphan judgment's point 2): the start reap on the REAL process probe (`ps` on macOS,
 * /proc on Linux). Red on bf42e8eb02:
 *  - a dead pid made `ps` exit 1 (the number, never ENOENT/ESRCH), so the probe read "unknown": the record of a dead
 *    backend was kept forever (`backend-ownership.json` kept 38414 / 38655 after the r3 proofs);
 *  - a SIGKILL that worked was then reported as "did not stop cleanly": the reap kept the record and logged no
 *    "Reaped" line, so a crash orphan stopped at the next start read as a failed stop.
 * Every process here is one this test spawned; nothing else is signalled. The ownership file is a temp file.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ file: '', logs: [] as string[] }))

vi.mock('./env', () => ({ IS_WINDOWS: false }))
vi.mock('./log', () => ({ rememberLog: (line: string) => h.logs.push(line) }))
vi.mock('./paths', () => ({
  get DESKTOP_BACKEND_OWNERSHIP_PATH() {
    return h.file
  }
}))

const { processStartMarker, psProbeGone } = await import('../backend-claim')

const posix = process.platform !== 'win32'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-reap-'))
const spawned: number[] = []

afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
})

afterAll(() => fs.rmSync(dir, { force: true, recursive: true }))

/** A pid that existed a moment ago and is gone now (spawned, exited, reaped by node). */
async function deadPid(): Promise<{ marker: string; pid: number }> {
  const child = spawn('/bin/sh', ['-c', 'sleep 0.3'], { stdio: 'ignore' })
  const pid = child.pid!
  const marker = await processStartMarker(pid)

  await new Promise(resolve => child.once('exit', resolve))
  await new Promise(resolve => setTimeout(resolve, 50))

  return { marker, pid }
}

/** A detached "hermes serve" lookalike (its own process group) that ignores SIGTERM, so only SIGKILL stops it. */
async function stubbornBackend(): Promise<{ marker: string; pid: number }> {
  const script = path.join(dir, 'hermes')

  fs.writeFileSync(script, "trap '' TERM\nwhile :; do sleep 0.2; done\n")

  const child = spawn('/bin/sh', [script, 'serve'], { detached: true, stdio: 'ignore' })
  const pid = child.pid!

  child.unref()
  spawned.push(pid)
  await new Promise(resolve => setTimeout(resolve, 150))

  return { marker: await processStartMarker(pid), pid }
}

async function freshOwnership(records: object[]) {
  vi.resetModules()
  h.file = path.join(fs.mkdtempSync(path.join(dir, 'ud-')), 'backend-ownership.json')
  h.logs.length = 0
  fs.writeFileSync(h.file, JSON.stringify({ backends: records }))

  return import('./backend-ownership')
}

const recorded = () => (JSON.parse(fs.readFileSync(h.file, 'utf8')) as { backends: { pid: number }[] }).backends

describe.runIf(posix)('the start reap on the real process probe', () => {
  it('a gone pid makes ps exit 1 with no output: the probe says ESRCH (gone), not "unknown"', async () => {
    const { pid } = await deadPid()

    await expect(processStartMarker(pid)).rejects.toMatchObject({ code: 'ESRCH' })
  })

  it('psProbeGone is exit status 1 with nothing printed, never another failure', () => {
    expect(psProbeGone({ code: 1, stdout: '', stderr: '' })).toBe(true)
    expect(psProbeGone({ code: 1, stdout: '', stderr: 'ps: Operation not permitted' })).toBe(false)
    expect(psProbeGone({ code: 1, stdout: 'Tue Nov 18 12:00:00 2026', stderr: '' })).toBe(false)
    expect(psProbeGone({ code: 2, stdout: '', stderr: '' })).toBe(false)
    expect(psProbeGone({ code: 1, killed: true, signal: 'SIGTERM', stdout: '', stderr: '' })).toBe(false)
    expect(psProbeGone({ code: 'ENOENT' })).toBe(false)
    expect(psProbeGone(null)).toBe(false)
  })

  it('the record of a dead backend (dead parent too) is pruned, nothing is signalled', async () => {
    const backend = await deadPid()
    const parent = await deadPid()
    const kill = vi.spyOn(process, 'kill')

    const { backendOwnership } = await freshOwnership([
      {
        nonce: 'n-dead',
        pid: backend.pid,
        profile: 'default',
        startMarker: backend.marker,
        command: 'hermes serve',
        parentPid: parent.pid,
        parentStartMarker: parent.marker
      }
    ])

    expect(await backendOwnership.listOrphans()).toEqual([])
    expect(await backendOwnership.reapOrphans()).toEqual([])
    expect(recorded()).toEqual([])
    expect(kill.mock.calls.filter(([, signal]) => signal === 'SIGTERM' || signal === 'SIGKILL')).toEqual([])
    kill.mockRestore()
  })

  it('a crash orphan that ignores SIGTERM is SIGKILLed at start: reaped, pruned, "Reaped" logged, no failed stop', async () => {
    const backend = await stubbornBackend()
    const parent = await deadPid()

    const { reapOrphanedBackendsOnce } = await freshOwnership([
      {
        nonce: 'n-orphan',
        pid: backend.pid,
        profile: 'default',
        startMarker: backend.marker,
        command: 'hermes serve',
        parentPid: parent.pid,
        parentStartMarker: parent.marker
      }
    ])

    await reapOrphanedBackendsOnce()

    expect(recorded()).toEqual([])
    expect(h.logs).toContain(`Reaped orphaned desktop backend PID(s): ${backend.pid}`)
    expect(() => process.kill(backend.pid, 0)).toThrow()
  })

  it('a backend whose parent is still running is kept and never signalled', async () => {
    const backend = await stubbornBackend()
    const parentMarker = await processStartMarker(process.pid)

    const { backendOwnership } = await freshOwnership([
      {
        nonce: 'n-live',
        pid: backend.pid,
        profile: 'default',
        startMarker: backend.marker,
        command: 'hermes serve',
        parentPid: process.pid,
        parentStartMarker: parentMarker
      }
    ])

    expect(await backendOwnership.reapOrphans()).toEqual([])
    expect(recorded().map(entry => entry.pid)).toEqual([backend.pid])
    expect(() => process.kill(backend.pid, 0)).not.toThrow()
  })
})
