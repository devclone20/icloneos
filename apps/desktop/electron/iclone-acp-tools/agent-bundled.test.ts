// v0.0.9 F1-B (owner decision 17 Nov, replaces ruling 26) — the agent finds the CLI the app ships. The real
// initIcloneAcp starts against a temp userData, a fake pin and a bundle built from it by the real build code
// (fixture.ts `writeFixtureBundle` → materialise.ts) in `<app>/build/acp-tools`, where a dev run looks for it
// (bundle.ts `defaultBundleDir`). With NO Keychain sealer (blocker K: the owner's Keychain setting off), no click and
// no network, the agent's own door runs `acp --version`: the included copy is placed and verified on its own, the
// CLI starts confined to it, and nothing ever asks for an install. `utilityProcess.fork` is a fake CLI.
import { EventEmitter } from 'node:events'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type * as AcpIpc from '../iclone-acp-ipc'

const lab = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? '/tmp').replace(/\/$/, '')
  const home = `${tmp}/iclone-f1b-agent-${process.pid}-${Date.now()}`

  return {
    home,
    app: `${home}/app`,
    userData: `${home}/userData`,
    handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
    door: null as null | Parameters<typeof AcpIpc.startAcpSocketServer>[0],
    forks: [] as { args: string[]; env: Record<string, string | undefined> }[],
    fetched: 0
  }
})

vi.mock('node:os', async importOriginal => {
  const real = await importOriginal<typeof NodeOs>()
  const os = { ...real, homedir: () => lab.home }

  return { ...os, default: os }
})

// v0.0.9 Q (tests-perf 7): the global fetch counts too (no module on this path imports electron.net any more, so the
// mock alone could never see a download).
vi.stubGlobal('fetch', () => {
  lab.fetched += 1

  return Promise.reject(new Error('F1-B: the app never downloads the CLI'))
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
  net: {
    fetch: () => {
      lab.fetched += 1

      return Promise.reject(new Error('F1-B: the app never downloads the CLI'))
    }
  },
  utilityProcess: {
    fork: (_modulePath: string, args: string[], options: { env: Record<string, string | undefined> }) => {
      lab.forks.push({ args, env: options.env })

      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        pid: 4243,
        kill: () => true
      })

      setTimeout(() => {
        child.stdout.end(args.includes('--version') ? '1.0.38\n' : '{"chains":[{"id":8453,"name":"base"}]}\n')
        child.stderr.end()
        child.emit('spawn')
        child.emit('exit', 0)
      }, 5)

      return child
    }
  }
}))

vi.mock('../iclone-acp-ipc', async importOriginal => {
  const real = await importOriginal<typeof AcpIpc>()

  return {
    ...real,
    startAcpSocketServer: async (deps: Parameters<typeof AcpIpc.startAcpSocketServer>[0]) => {
      lab.door = deps

      return { socketPath: `${deps.dir}/acp.sock`, close: () => undefined }
    }
  }
})

import { acpToolsProblem, initIcloneAcp } from '../iclone-acp'

import { writeFixtureBundle, writeFixturePin } from './fixture'

const savedBin = process.env.ICLONE_ACP_BIN
const call = (channel: string, ...args: unknown[]) => lab.handlers.get(channel)!({ sender: {} }, ...args)

beforeAll(async () => {
  delete process.env.ICLONE_ACP_BIN

  const pin = writeFixturePin(path.join(lab.home, 'pin'))

  mkdirSync(path.join(lab.app, 'scripts'), { recursive: true })
  cpSync(pin.pinDir, path.join(lab.app, 'acp-cli-lock'), { recursive: true })
  cpSync(pin.launcher, path.join(lab.app, 'scripts', 'acp-launch.cjs'))
  await writeFixtureBundle(pin, path.join(lab.app, 'build', 'acp-tools'))
  // Blocker K: no sealer at all, and the reason the v0.0.8 app gave for it. No gestureOk: nothing is clicked here.
  initIcloneAcp({ isTrustedSender: () => true, sealer: null, noSealReason: () => 'keychain-off' } as never)

  for (let i = 0; i < 200 && !lab.door; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
})

afterAll(() => {
  process.env.ICLONE_ACP_BIN = savedBin
  rmSync(lab.home, { force: true, recursive: true })
})

describe('F1-B: the agent runs the CLI the app ships, with no install and no Keychain', () => {
  it('the tools are ready from the start: included, verified, Keychain off, no click, no download', async () => {
    // The first-run placement starts on its own at init (a local copy, no click); the window may first see it in flight.
    let view = (await call('iclone:acp-tools:state')) as { state: string }

    for (let i = 0; i < 200 && (view.state === 'installing' || view.state === 'checking'); i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      view = (await call('iclone:acp-tools:state')) as { state: string }
    }

    expect(view).toMatchObject({ state: 'installed', cliVersion: '1.0.38' })
    expect(acpToolsProblem()).toBeNull()
    expect(lab.fetched).toBe(0)
  })

  it('the agent’s door: `acp --version` answers through the confined launcher, never an install prompt', async () => {
    expect(lab.door).not.toBeNull()

    let out = ''
    let err = ''

    const sink = {
      stdout: (chunk: string) => {
        out += chunk
      },
      stderr: (chunk: string) => {
        err += chunk
      },
      signal: new AbortController().signal
    }

    const result = await lab.door!.run('inft-1', ['--version'], false, sink as never)

    expect(result.error).toBeUndefined()
    expect(result.code).toBe(0)
    expect(out).toContain('1.0.38')
    expect(`${out}${err}`).not.toMatch(/acp-tools:|not installed|install/i)

    const last = lab.forks.at(-1)!

    expect(last.args.slice(1)).toEqual(['--version'])
    // The verified working copy of the bundle, confined by its manifest digest (never NODE_PATH).
    expect(last.env.ICLONE_ACP_TREE).toMatch(/userData\/acp-cli\/[0-9a-f]{64}$/)
    expect(existsSync(path.join(last.env.ICLONE_ACP_TREE!, 'MANIFEST.json'))).toBe(true)
    expect(last.env.ICLONE_ACP_TREE_SHA256).toMatch(/^[0-9a-f]{64}$/)
    expect(last.env.NODE_PATH).toBeUndefined()
    expect(lab.fetched).toBe(0)
  })
})
