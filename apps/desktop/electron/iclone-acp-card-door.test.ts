// The agent's door (`acp card signup` over the app socket, runForAgent) and the renderer's door
// (`iclone:acp-run`) share main's one-minute wait per iNFT. Electron, the home dir and the CLI are fakes:
// nothing leaves the machine.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import type * as NodeOs from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const lab = vi.hoisted(() => {
  // Short and fresh: the agent door's socket path must fit sun_path.
  const home = `/tmp/v3lm6-${process.pid}-${Date.now() % 1_000_000}`

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
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => lab.handlers.set(channel, fn),
    on: () => undefined
  },
  utilityProcess: { fork: () => null }
}))

import { initIcloneAcp } from './iclone-acp'
import { RESEND_AT_MARK } from './iclone-acp-signup'

const CONTRACT = '0x' + '4d'.repeat(20)
const INFT_ID = `robinhood:${CONTRACT}:6`
const SLUG = `robinhood-${CONTRACT}-6`
const SIGNUP = ['card', 'signup', '--email', 'a@mail.acp.virtuals.io', '--json']
const log = path.join(lab.home, 'acp-calls.log')
const runDir = path.join(lab.userData, 'run')
const savedBin = process.env.ICLONE_ACP_BIN

interface Frame {
  t: string
  d?: string
  c?: number
}

beforeAll(async () => {
  mkdirSync(path.join(lab.userData, 'inft', SLUG, 'acp'), { recursive: true })
  const bin = path.join(lab.home, 'fake-acp')
  // The runtime health probe (`chain list`) needs a chain; every other call answers a bare ok.
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$@" >> '${log}'\nif [ "$1" = chain ]; then echo '{"chains":[{"id":8453}]}'; else echo '{"ok":true}'; fi\n`
  )
  chmodSync(bin, 0o755)
  process.env.ICLONE_ACP_BIN = bin
  initIcloneAcp({ isTrustedSender: () => true }) // sender guard covered in iclone-acp.sender.test.ts

  for (let i = 0; i < 100 && !existsSync(path.join(runDir, 'acp.token')); i++) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
})

afterAll(() => {
  process.env.ICLONE_ACP_BIN = savedBin
  rmSync(lab.home, { recursive: true, force: true })
})

const rendererRun = (inftId: string, argv: string[]) =>
  lab.handlers.get('iclone:acp-run')?.({}, inftId, argv) as Promise<{ ok: boolean; error?: string }>

const agentRun = (inft: string, argv: string[]) =>
  new Promise<Frame[]>((resolve, reject) => {
    const token = readFileSync(path.join(runDir, 'acp.token'), 'utf8').trim()
    const socket = net.createConnection(path.join(runDir, 'acp.sock'))
    let data = ''

    socket.on('connect', () => socket.write(`${JSON.stringify({ v: 1, token, inft, argv })}\n`))
    socket.on('data', chunk => (data += String(chunk)))
    socket.on('error', reject)
    socket.on('close', () =>
      resolve(
        data
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line) as Frame)
      )
    )
  })

const signupsRun = () =>
  (existsSync(log) ? readFileSync(log, 'utf8') : '').split('\n').filter(line => line.startsWith('card signup')).length

describe("V3-L m6 — the agent door's card signup waits out main's minute", () => {
  it('a renderer send, then the agent asks inside the minute: refused with its end, 0 spawns', async () => {
    const sent = await rendererRun(INFT_ID, SIGNUP)

    expect(sent.ok).toBe(true)
    expect(signupsRun()).toBe(1)

    const frames = await agentRun('6', SIGNUP)
    const stderr = frames.filter(frame => frame.t === 'e').map(frame => frame.d ?? '')

    expect(stderr.join('')).toMatch(new RegExp(`\\[${RESEND_AT_MARK}\\d{13}\\]`))
    expect(frames.at(-1)?.t).toBe('x')
    expect(frames.at(-1)?.c).not.toBe(0)
    expect(signupsRun()).toBe(1)
  })

  it('the agent door sends first: a second agent signup inside the minute is refused, 0 spawns', async () => {
    const other = `robinhood:${CONTRACT}:7`
    const otherSlug = `robinhood-${CONTRACT}-7`

    mkdirSync(path.join(lab.userData, 'inft', otherSlug, 'acp'), { recursive: true })

    const first = await agentRun('7', SIGNUP)

    expect(first.at(-1)).toEqual({ t: 'x', c: 0 })
    expect(signupsRun()).toBe(2)

    const second = await agentRun('7', SIGNUP)

    expect(second.map(frame => frame.d ?? '').join('')).toContain(`[${RESEND_AT_MARK}`)
    expect(signupsRun()).toBe(2)

    // The renderer door for the same iNFT reads the same minute.
    const fromWindow = await rendererRun(other, SIGNUP)

    expect(fromWindow.ok).toBe(false)
    expect(fromWindow.error).toContain(`[${RESEND_AT_MARK}`)
    expect(signupsRun()).toBe(2)
  })
})
