import type * as NodeChildProcess from 'node:child_process'
// F1-S (v0.0.9): the window's owner-locked ACP writes — `agent register-erc8004` and the Market catalogue writes — go
// through `iclone:acp-run` only on an admission the owner's click earned on `iclone:acp-owner-confirm`. The real
// initIcloneAcp runs against a temp userData and a fake pin (fixture.ts), with main's real gesture verdict
// (permissionGestureOk) over facts this test controls; the ACP tools are absent, so an ADMITTED write goes on to
// runAcp and stops there with the tools' reason — which is how this test sees that the lock let it through. Nothing
// spawns and nothing leaves the machine.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as AcpIpc from './iclone-acp-ipc'

const lab = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? '/tmp').replace(/\/$/, '')
  const home = `${tmp}/iclone-f1s-acp-${process.pid}-${Date.now()}`

  return {
    home,
    app: `${home}/app`,
    userData: `${home}/userData`,
    handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
    audits: [] as { kind: string; gesture: boolean; command: string; lock: string }[],
    lastInputAt: 0,
    spawns: 0,
    forks: 0
  }
})

vi.mock('node:os', async importOriginal => {
  const real = await importOriginal<typeof NodeOs>()
  const os = { ...real, homedir: () => lab.home }

  return { ...os, default: os }
})

vi.mock('node:child_process', async importOriginal => {
  const real = await importOriginal<typeof NodeChildProcess>()

  const spawn = () => {
    lab.spawns += 1
    throw new Error('F1-S test: nothing may spawn')
  }

  return { ...real, spawn, default: { ...real, spawn } }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => lab.userData,
    getAppPath: () => lab.app,
    once: () => undefined,
    on: () => undefined
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => lab.handlers.set(channel, fn),
    on: () => undefined
  },
  utilityProcess: {
    fork: () => {
      lab.forks += 1
      throw new Error('F1-S test: nothing may fork')
    }
  }
}))

vi.mock('./iclone-acp-ipc', async importOriginal => {
  const real = await importOriginal<typeof AcpIpc>()

  return {
    ...real,
    startAcpSocketServer: async (deps: Parameters<typeof AcpIpc.startAcpSocketServer>[0]) => ({
      socketPath: `${deps.dir}/acp.sock`,
      close: () => undefined
    })
  }
})

import { initIcloneAcp } from './iclone-acp'
import { memorySealer, writeFixturePin } from './iclone-acp-tools/fixture'
import { gestureOf, permissionGestureOk } from './iclone-permissions/gesture'

const savedBin = process.env.ICLONE_ACP_BIN
const WINDOW = { sender: { id: 7 } }
const call = (channel: string, event: unknown, ...args: unknown[]) => lab.handlers.get(channel)!(event, ...args)
const NOT_INSTALLED = /^\[acp-tools:absent\] ACP tools are not installed/

const REGISTER = ['agent', 'register-erc8004', '--agent-id', 'a1', '--chain-id', '8453', '--json']
const DELETE = ['offering', 'delete', '--offering-id', 'off-1', '--force', '--json']

beforeAll(() => {
  delete process.env.ICLONE_ACP_BIN

  const pin = writeFixturePin(path.join(lab.home, 'pin'))

  mkdirSync(path.join(lab.app, 'scripts'), { recursive: true })
  cpSync(pin.pinDir, path.join(lab.app, 'acp-cli-lock'), { recursive: true })
  cpSync(pin.launcher, path.join(lab.app, 'scripts', 'acp-launch.cjs'))
  initIcloneAcp({
    isTrustedSender: () => true,
    sealer: memorySealer,
    // critic m5: the window runs the CLI only for an iNFT main's scans returned (main.ts: isScannedInftId).
    isKnownInft: id => id === 'inft-1',
    // main.ts's verdict: the preload's flags + real input to this sender within the window.
    gestureOk: (_event, input) =>
      permissionGestureOk({ payload: gestureOf(input), lastInputAt: lab.lastInputAt, now: Date.now() }),
    writeAudit: entry => {
      lab.audits.push(entry)

      return { id: lab.audits.length }
    }
  })
})

beforeEach(() => {
  lab.audits.length = 0
  lab.lastInputAt = 0
})

afterAll(() => {
  process.env.ICLONE_ACP_BIN = savedBin
  rmSync(lab.home, { force: true, recursive: true })
})

describe('critic m5: iclone:acp-run refuses an iNFT id main never saw, before any per-iNFT home exists', () => {
  it('an invented id is refused and leaves no inft/<slug> directory; a known id still runs', async () => {
    const invented = 'robinhood:0xdead:999'
    const home = path.join(lab.userData, 'inft', 'robinhood-0xdead-999')

    expect(await call('iclone:acp-run', WINDOW, invented, ['offering', 'list', '--json'])).toMatchObject({
      ok: false,
      error: 'unknown iNFT: it is not in this wallet'
    })
    expect(existsSync(home)).toBe(false)
    expect(lab.audits).toEqual([])

    expect(await call('iclone:acp-run', WINDOW, 'inft-1', ['offering', 'list', '--json'])).not.toMatchObject({
      error: 'unknown iNFT: it is not in this wallet'
    })
  })
})

describe('F1-S: iclone:acp-run refuses an owner-locked write without the owner’s click', () => {
  it('register-erc8004 with no confirm: refused before runAcp, audited refuse · gesture:false', async () => {
    expect(await call('iclone:acp-run', WINDOW, 'inft-1', REGISTER)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^\[acp-write:gesture\]/)
    })
    expect(lab.audits).toEqual([expect.objectContaining({ kind: 'refuse', gesture: false, lock: 'acp-register' })])
  })

  it('a scripted confirm (synthetic el.click: no activation, no trusted confirm) earns nothing', async () => {
    lab.lastInputAt = Date.now()

    expect(
      await call('iclone:acp-owner-confirm', WINDOW, {
        inftId: 'inft-1',
        argv: REGISTER,
        lock: 'acp-register',
        gesture: { activation: false, confirm: false }
      })
    ).toMatchObject({ ok: false, error: expect.stringMatching(/^\[acp-write:gesture\]/) })
    expect(await call('iclone:acp-run', WINDOW, 'inft-1', REGISTER)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^\[acp-write:gesture\]/)
    })
    expect(lab.audits.map(entry => entry.gesture)).toEqual([false, false])
  })

  it('the owner’s real click admits ONE run past the lock (it then stops on the absent tools), audited gesture:true', async () => {
    lab.lastInputAt = Date.now()

    expect(
      await call('iclone:acp-owner-confirm', WINDOW, {
        inftId: 'inft-1',
        argv: DELETE,
        lock: 'acp-market',
        gesture: { activation: true, confirm: true }
      })
    ).toEqual({ ok: true })

    // Past the lock: runAcp answers with the tools' own reason, not the lock's.
    expect(await call('iclone:acp-run', WINDOW, 'inft-1', DELETE)).toMatchObject({
      ok: false,
      error: expect.stringMatching(NOT_INSTALLED)
    })
    // Spent: the same write again needs a new click.
    expect(await call('iclone:acp-run', WINDOW, 'inft-1', DELETE)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^\[acp-write:gesture\]/)
    })
    expect(lab.audits.map(entry => [entry.kind, entry.gesture, entry.lock])).toEqual([
      ['use', true, 'acp-market'],
      ['refuse', false, 'acp-market']
    ])
  })

  it('reads are untouched by the lock', async () => {
    expect(await call('iclone:acp-run', WINDOW, 'inft-1', ['offering', 'list', '--json'])).toMatchObject({
      ok: false,
      error: expect.stringMatching(NOT_INSTALLED)
    })
    expect(lab.audits).toEqual([])
  })

  it('nothing spawned or forked', () => {
    expect(lab.spawns).toBe(0)
    expect(lab.forks).toBe(0)
  })
})
