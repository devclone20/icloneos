// REL-6 round 2 — with the ACP tools INSTALLED, every spawn still re-checks the tree (critic survivor C13: removing
// `spawnGate` stayed green) and starts the CLI confined to it (critic M1: the launcher gets the verified tree and its
// manifest digest, never NODE_PATH). The real initIcloneAcp installs a fake pin from a fake registry into a temp
// userData; `utilityProcess.fork` is a fake CLI that answers the self-test, so every fork is counted.
import { EventEmitter } from 'node:events'
import { appendFileSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type * as AcpIpc from './iclone-acp-ipc'

const lab = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? '/tmp').replace(/\/$/, '')
  const home = `${tmp}/iclone-rel6-spawn-${process.pid}-${Date.now()}`

  return {
    home,
    app: `${home}/app`,
    userData: `${home}/userData`,
    handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
    tarballs: new Map<string, Buffer>(),
    forks: [] as { args: string[]; env: Record<string, string | undefined> }[],
    children: [] as EventEmitter[],
    audit: [] as { kind: string; reason: string }[]
  }
})

vi.mock('node:os', async importOriginal => {
  const real = await importOriginal<typeof NodeOs>()
  const os = { ...real, homedir: () => lab.home }

  return { ...os, default: os }
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
  net: { fetch: () => Promise.reject(new Error('no network in tests')) },
  utilityProcess: {
    fork: (_modulePath: string, args: string[], options: { env: Record<string, string | undefined> }) => {
      lab.forks.push({ args, env: options.env })

      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        pid: 4242,
        kill: () => true
      })

      lab.children.push(child)
      setTimeout(() => {
        child.stdout.end('{"chains":[{"id":8453,"name":"base"}]}\n')
        child.stderr.end()
        child.emit('spawn')
        child.emit('exit', 0)
      }, 5)

      return child
    }
  }
}))

vi.mock('./iclone-acp-tools/net', () => ({
  registryFetch: async (url: string) => {
    const tgz = lab.tarballs.get(url)

    if (!tgz) {
      throw new Error(`404 ${url}`)
    }

    return tgz
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

const savedBin = process.env.ICLONE_ACP_BIN
const call = (channel: string, ...args: unknown[]) => lab.handlers.get(channel)!({ sender: {} }, ...args)

beforeAll(() => {
  delete process.env.ICLONE_ACP_BIN

  const pin = writeFixturePin(`${lab.home}/pin`)

  for (const [url, tgz] of pin.tarballs) {
    lab.tarballs.set(url, tgz)
  }

  mkdirSync(path.join(lab.app, 'scripts'), { recursive: true })
  cpSync(pin.pinDir, path.join(lab.app, 'acp-cli-lock'), { recursive: true })
  cpSync(pin.launcher, path.join(lab.app, 'scripts', 'acp-launch.cjs'))
  initIcloneAcp({
    isTrustedSender: () => true,
    sealer: memorySealer,
    gestureOk: () => true,
    audit: entry => {
      lab.audit.push(entry)

      return { seq: lab.audit.length }
    }
  })
})

afterAll(() => {
  process.env.ICLONE_ACP_BIN = savedBin
  rmSync(lab.home, { force: true, recursive: true })
})

describe('REL-6 round 2: the tools installed, every spawn re-checks and confines', () => {
  it('installs on the owner’s click, then a run starts the CLI with the verified tree and no NODE_PATH', async () => {
    expect(await call('iclone:acp-tools:install', {})).toMatchObject({ ok: true, view: { state: 'installed' } })

    const result = (await call('iclone:acp-run', 'inft-1', ['chain', 'list', '--json'])) as { ok: boolean }

    expect(result.ok).toBe(true)

    const last = lab.forks.at(-1)!

    expect(last.args.slice(1)).toEqual(['chain', 'list', '--json'])
    expect(last.env.ICLONE_ACP_TREE).toMatch(/userData\/acp-cli\/[0-9a-f]{64}$/)
    expect(last.env.ICLONE_ACP_TREE_SHA256).toMatch(/^[0-9a-f]{64}$/)
    expect(last.env.NODE_PATH).toBeUndefined()
  })

  it('a refusal the launcher reports over the port reaches the audit', () => {
    lab.children
      .at(-1)!
      .emit('message', { iclone: 'acp-launch', type: 'escape', what: 'supports-color -> ~/node_modules' })

    expect(lab.audit.map(entry => entry.reason)).toContainEqual(
      expect.stringMatching(/refused a module outside the verified tree \(supports-color/)
    )
  })

  it('a file changed after the self-test passed: the next run is refused BEFORE any process starts (C13)', async () => {
    const tree = path.dirname(lab.forks.at(-1)!.env.ICLONE_ACP_TREE + '/x')
    const forks = lab.forks.length

    appendFileSync(
      path.join(tree, 'runtime', 'node_modules', '@virtuals-protocol', 'acp-cli', 'dist', 'bin', 'acp.js'),
      ';evil()'
    )

    const result = (await call('iclone:acp-run', 'inft-1', ['chain', 'list', '--json'])) as {
      ok: boolean
      error?: string
    }

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/^\[acp-tools:unverified:file-changed\]/)
    expect(lab.forks.length).toBe(forks)
  })
})
