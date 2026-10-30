import type * as NodeChildProcess from 'node:child_process'
// REL-6 (ruling 26): while the ACP tools are not installed, EVERY ACP path refuses cleanly, with the reason, and no
// CLI process is ever started: the window's bridge (run, status, check, the wizard's install), the tools channels,
// the market window's listener, the WORK supervisor's listener, and the agent's own door. The real initIcloneAcp runs
// against a temp userData and a fake pin (fixture.ts); the socket server is a capture; `utilityProcess.fork` and
// `spawn` would fail the suite if reached. Nothing leaves the machine.
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type * as AcpIpc from './iclone-acp-ipc'

const lab = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? '/tmp').replace(/\/$/, '')
  const home = `${tmp}/iclone-rel6-gate-${process.pid}-${Date.now()}`

  return {
    home,
    app: `${home}/app`,
    userData: `${home}/userData`,
    handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
    door: null as null | Parameters<typeof AcpIpc.startAcpSocketServer>[0],
    forks: 0,
    spawns: 0
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
    throw new Error('REL-6 gate test: nothing may spawn while the ACP tools are absent')
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
      throw new Error('REL-6 gate test: nothing may fork while the ACP tools are absent')
    }
  }
}))

vi.mock('./iclone-acp-ipc', async importOriginal => {
  const real = await importOriginal<typeof AcpIpc>()

  return {
    ...real,
    startAcpSocketServer: async (deps: Parameters<typeof AcpIpc.startAcpSocketServer>[0]) => {
      lab.door = deps

      return { socketPath: `${deps.dir}/acp.sock`, close: () => undefined }
    }
  }
})

import { acpToolsProblem, acpWorkCli, initIcloneAcp } from './iclone-acp'
import { memorySealer, writeFixturePin } from './iclone-acp-tools/fixture'

const savedBin = process.env.ICLONE_ACP_BIN
const call = (channel: string, ...args: unknown[]) => lab.handlers.get(channel)!({ sender: {} }, ...args)
const NOT_INSTALLED = /^\[acp-tools:absent\] ACP tools are not installed/

beforeAll(async () => {
  delete process.env.ICLONE_ACP_BIN

  const pin = writeFixturePin(path.join(lab.home, 'pin'))

  mkdirSync(path.join(lab.app, 'scripts'), { recursive: true })
  cpSync(pin.pinDir, path.join(lab.app, 'acp-cli-lock'), { recursive: true })
  cpSync(pin.launcher, path.join(lab.app, 'scripts', 'acp-launch.cjs'))
  // A sealer (the OS can seal), but no gestureOk and no audit: the safe defaults (no gesture, no audit ⇒ no install).
  initIcloneAcp({ isTrustedSender: () => true, sealer: memorySealer })

  for (let i = 0; i < 100 && !lab.door; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
})

afterAll(() => {
  process.env.ICLONE_ACP_BIN = savedBin
  rmSync(lab.home, { force: true, recursive: true })
})

describe('REL-6: every ACP path refuses while the tools are absent', () => {
  it('the tools channel says absent, for this build’s pinned version', async () => {
    expect(await call('iclone:acp-tools:state')).toMatchObject({ state: 'absent', cliVersion: '1.0.38', stale: false })
    expect(acpToolsProblem()).toMatch(NOT_INSTALLED)
  })

  it('the window’s bridge: run, check and status refuse with the reason', async () => {
    expect(await call('iclone:acp-run', 'inft-1', ['chain', 'list', '--json'])).toMatchObject({
      ok: false,
      error: expect.stringMatching(NOT_INSTALLED)
    })
    expect(await call('iclone:acp-check')).toMatchObject({ ok: false, error: expect.stringMatching(NOT_INSTALLED) })
    expect(await call('iclone:acp-status', 'inft-1', {})).toMatchObject({
      cli: false,
      cliError: expect.stringMatching(NOT_INSTALLED)
    })
  })

  it('the install needs the owner’s click and an audit: without either, nothing is fetched', async () => {
    expect(await call('iclone:acp-install', { gesture: { trusted: true } })).toMatchObject({
      ok: false,
      error: '[acp-tools-install:gesture]',
      tools: { ok: false, error: 'gesture' }
    })
    expect(await call('iclone:acp-tools:install', {})).toMatchObject({ ok: false, error: 'gesture' })
    expect(await call('iclone:acp-tools:state')).toMatchObject({ state: 'absent' })
  })

  it('the WORK supervisor’s listener gets a terminal refusal (no retry loop)', async () => {
    expect(await acpWorkCli.listen('inft-1', ['events', 'listen', '--json'])).toEqual({
      error: expect.stringMatching(NOT_INSTALLED),
      terminal: true
    })
    expect(acpWorkCli.toolsProblem()).toMatch(NOT_INSTALLED)
  })

  it('the agent’s own door refuses its command with the reason', async () => {
    expect(lab.door).not.toBeNull()

    const sink = { stdout: () => undefined, stderr: () => undefined, signal: new AbortController().signal }

    expect(await lab.door!.run('inft-1', ['agent', 'whoami', '--json'], false, sink as never)).toEqual({
      code: null,
      error: expect.stringMatching(NOT_INSTALLED)
    })
  })

  it('no CLI process was started by any of it', () => {
    expect(lab.forks).toBe(0)
    expect(lab.spawns).toBe(0)
  })
})
