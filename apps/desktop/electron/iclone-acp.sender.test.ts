// The renderer's doors into the ACP CLI, the wallet/card calls and the iNFT files (iclone:acp-*, inft-kv-*,
// email-state, acp-watch) answer only the app's own renderer: the same createAppSenderGuard the terminal and consent
// IPC use. A foreign or unknown webContents gets null and the handler never runs: no CLI spawn, no file write.
// Electron, the home dir and the CLI are fakes: nothing leaves the machine.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const lab = vi.hoisted(() => {
  // Short and fresh: the agent door's socket path must fit sun_path.
  const home = `/tmp/acpsnd-${process.pid}-${Date.now() % 1_000_000}`

  return { home, userData: `${home}/userData`, handlers: new Map<string, (...a: unknown[]) => unknown>() }
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
    getAppPath: () => lab.home,
    once: () => undefined,
    on: () => undefined
  },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => lab.handlers.set(channel, fn),
    on: () => undefined
  },
  utilityProcess: { fork: () => null }
}))

import { initIcloneAcp } from './iclone-acp'
import { createAppSenderGuard } from './ipc-sender-guard'

const CONTRACT = '0x' + '5e'.repeat(20)
const INFT_ID = `robinhood:${CONTRACT}:6`
const SLUG = `robinhood-${CONTRACT}-6`
const SIGNUP = ['card', 'signup', '--email', 'agent@example.com', '--json']
const NOTES = { step1: { text: 'kept', updatedAt: 1 } }
const RENDERER_INDEX = '/Applications/iclone os.app/Contents/Resources/app.asar/dist/index.html'
const RENDERER_URL = 'file:///Applications/iclone%20os.app/Contents/Resources/app.asar/dist/index.html'
const log = path.join(lab.home, 'acp-calls.log')
const notesFile = path.join(lab.userData, 'inft', SLUG, 'notes.json')
const savedBin = process.env.ICLONE_ACP_BIN
const refusals: string[] = []

interface FakeContents {
  owned: boolean
  getType: () => string
  isDestroyed: () => boolean
  mainFrame: { url: string }
}

function contents(type: string, url: string, { owned = true, destroyed = false } = {}): FakeContents {
  return { owned, getType: () => type, isDestroyed: () => destroyed, mainFrame: { url } }
}

const app = contents('window', RENDERER_URL)
const trusted = { sender: app, senderFrame: app.mainFrame }
const privyWindow = contents('window', 'http://127.0.0.1:47831/privy.html')
const webview = contents('webview', RENDERER_URL)
const detached = contents('window', RENDERER_URL, { owned: false })
const destroyed = contents('window', RENDERER_URL, { destroyed: true })

// Every sender shape the guard must refuse, from the most to the least specific.
const FOREIGN: [string, unknown][] = [
  [
    'a window on a remote page with its own preload (the Privy sign-in window)',
    { sender: privyWindow, senderFrame: privyWindow.mainFrame }
  ],
  ['a <webview> guest on the renderer URL', { sender: webview, senderFrame: webview.mainFrame }],
  ['a subframe inside the app window', { sender: app, senderFrame: { url: RENDERER_URL } }],
  ['a webContents no BrowserWindow owns', { sender: detached, senderFrame: detached.mainFrame }],
  ['a destroyed app window', { sender: destroyed, senderFrame: destroyed.mainFrame }],
  ['an unknown webContents (no type, no frame)', { sender: {} }],
  ['a sender whose frame is already gone', { sender: app, senderFrame: null }]
]

// Each guarded channel with arguments that WOULD act if the handler ran.
const CALLS: [string, unknown[]][] = [
  ['iclone:acp-check', []],
  ['iclone:agentcard-status', []],
  ['iclone:acp-run', [INFT_ID, SIGNUP]],
  ['iclone:acp-status', [INFT_ID, {}]],
  ['iclone:inft-kv-get', [INFT_ID, 'notes']],
  ['iclone:inft-kv-set', [INFT_ID, 'notes', NOTES]],
  ['iclone:inft-kv-delete', [INFT_ID, 'notes']],
  ['iclone:email-state', ['get', SLUG]],
  ['iclone:acp-detach', [INFT_ID]],
  ['iclone:acp-config-map', []],
  ['iclone:acp-install', []],
  ['iclone:acp-update-check', []],
  ['iclone:acp-stage', [SLUG]],
  ['iclone:acp-watch', [SLUG]]
]

const call = (channel: string, event: unknown, ...args: unknown[]) => {
  const handler = lab.handlers.get(channel)

  if (!handler) {
    throw new Error(`${channel} is not registered`)
  }

  return Promise.resolve(handler(event, ...args))
}

const cliCalls = () =>
  (existsSync(log) ? readFileSync(log, 'utf8') : '').split('\n').filter(line => line && !line.startsWith('chain '))

beforeAll(() => {
  mkdirSync(path.join(lab.userData, 'inft', SLUG, 'acp'), { recursive: true })
  const bin = path.join(lab.home, 'fake-acp')
  // The runtime health probe (`chain list`) needs a chain; every other call answers a bare ok.
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$@" >> '${log}'\nif [ "$1" = chain ]; then echo '{"chains":[{"id":8453}]}'; else echo '{"ok":true}'; fi\n`
  )
  chmodSync(bin, 0o755)
  process.env.ICLONE_ACP_BIN = bin

  initIcloneAcp({
    isTrustedSender: createAppSenderGuard({
      rendererIndexPath: () => RENDERER_INDEX,
      log: line => refusals.push(line),
      hasOwnerWindow: sender => (sender as Partial<FakeContents>).owned === true
    })
  })
})

afterAll(() => {
  process.env.ICLONE_ACP_BIN = savedBin
  rmSync(lab.home, { recursive: true, force: true })
})

describe('ACP IPC sender check (P7 seam, same guard as terminal and consent)', () => {
  it('registers every renderer door behind the guard', () => {
    for (const [channel] of CALLS) {
      expect(lab.handlers.has(channel), channel).toBe(true)
    }
  })

  it.each(FOREIGN)('refuses %s on every channel: null, no CLI spawn, no file write', async (_label, event) => {
    for (const [channel, args] of CALLS) {
      await expect(call(channel, event, ...args), channel).resolves.toBeNull()
    }

    expect(cliCalls()).toEqual([])
    expect(existsSync(notesFile)).toBe(false)
  })

  it('logs each refusal with the channel, never the arguments', () => {
    expect(refusals.some(line => line.includes('refused iclone:acp-run from'))).toBe(true)
    expect(refusals.some(line => line.includes('refused iclone:inft-kv-set from'))).toBe(true)
    expect(refusals.join('\n')).not.toContain('agent@example.com')
    expect(refusals.join('\n')).not.toContain(CONTRACT)
  })

  it('a refused acp-run never reaches the CLI, the same call from the app window does', async () => {
    await expect(
      call('iclone:acp-run', { sender: privyWindow, senderFrame: privyWindow.mainFrame }, INFT_ID, SIGNUP)
    ).resolves.toBeNull()
    expect(cliCalls()).toEqual([])

    const ran = (await call('iclone:acp-run', trusted, INFT_ID, SIGNUP)) as { ok: boolean }

    expect(ran.ok).toBe(true)
    expect(cliCalls().filter(line => line.startsWith('card signup'))).toHaveLength(1)
  })

  it('a refused inft-kv-set writes nothing, the same call from the app window writes', async () => {
    await expect(call('iclone:inft-kv-set', { sender: {} }, INFT_ID, 'notes', NOTES)).resolves.toBeNull()
    expect(existsSync(notesFile)).toBe(false)

    await expect(call('iclone:inft-kv-set', trusted, INFT_ID, 'notes', NOTES)).resolves.toMatchObject({ ok: true })
    expect(JSON.parse(readFileSync(notesFile, 'utf8'))).toEqual(NOTES)

    // A foreign delete cannot undo it either.
    await expect(
      call('iclone:inft-kv-delete', { sender: webview, senderFrame: webview.mainFrame }, INFT_ID, 'notes')
    ).resolves.toBeNull()
    expect(existsSync(notesFile)).toBe(true)
  })
})
