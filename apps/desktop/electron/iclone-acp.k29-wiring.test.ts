// K125 (V3-K fix critic r2 m4): K29's PRODUCTION wiring. The agent door (`startAgentDoor`) must hand the socket server
// an `admitStreaming` that follows the WORK supervisor's verdict (`acpWorkCli.setWindowAdmission`), the same verdict
// the market window's listener gets. The K29 behaviour test in iclone-acp-ipc.test.ts injects its own
// `admitStreaming`, so a wiring of `() => true` (the agent's `events listen` starting while WORK holds the slug) kept
// every suite green. Here the real `initIcloneAcp` runs; the socket server is a capture (no socket opens) and the
// window watch is the real one with its deps recorded. No CLI runs, nothing leaves the machine.
import { rmSync } from 'node:fs'
import type * as NodeOs from 'node:os'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type * as AcpIpc from './iclone-acp-ipc'
import type * as AcpWatch from './iclone-acp-watch'

const lab = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? '/tmp').replace(/\/$/, '')
  const home = `${tmp}/iclone-k125-${process.pid}-${Date.now()}`

  return {
    home,
    userData: `${home}/userData`,
    door: null as null | Parameters<typeof AcpIpc.startAcpSocketServer>[0],
    watch: null as null | Parameters<typeof AcpWatch.initAcpWatch>[0],
    closed: 0
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
    getAppPath: () => lab.home,
    once: () => undefined,
    on: () => undefined
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined },
  utilityProcess: { fork: () => null }
}))

vi.mock('./iclone-acp-ipc', async importOriginal => {
  const real = await importOriginal<typeof AcpIpc>()

  return {
    ...real,
    startAcpSocketServer: async (deps: Parameters<typeof AcpIpc.startAcpSocketServer>[0]) => {
      lab.door = deps

      return { socketPath: `${deps.dir}/acp.sock`, close: () => void (lab.closed += 1) }
    }
  }
})

vi.mock('./iclone-acp-watch', async importOriginal => {
  const real = await importOriginal<typeof AcpWatch>()

  return {
    ...real,
    initAcpWatch: (deps: Parameters<typeof AcpWatch.initAcpWatch>[0]) => {
      lab.watch = deps

      return real.initAcpWatch(deps)
    }
  }
})

import { acpWorkCli, initIcloneAcp } from './iclone-acp'

const savedBin = process.env.ICLONE_ACP_BIN

beforeAll(async () => {
  // Belt and braces: should anything in init ever reach for the CLI, it finds a path that does not exist.
  process.env.ICLONE_ACP_BIN = `${lab.home}/no-acp-here`
  initIcloneAcp({ isTrustedSender: () => false })

  for (let i = 0; i < 100 && !lab.door; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
})

afterAll(() => {
  process.env.ICLONE_ACP_BIN = savedBin
  rmSync(lab.home, { force: true, recursive: true })
})

describe('K29 production wiring: the agent door asks the WORK supervisor before streaming', () => {
  it('the agent door opened with an admitStreaming of its own', () => {
    expect(lab.door).not.toBeNull()
    expect(typeof lab.door!.admitStreaming).toBe('function')
  })

  it('follows acpWorkCli.setWindowAdmission, and every later change of it', () => {
    const admit = lab.door!.admitStreaming

    acpWorkCli.setWindowAdmission(slug => slug !== 'held-by-work')
    expect(admit('held-by-work')).toBe(false)
    expect(admit('free')).toBe(true)

    // Read on every call, not captured once: WORK taking a second slug later is seen at once.
    acpWorkCli.setWindowAdmission(slug => slug === 'only-this')
    expect(admit('free')).toBe(false)
    expect(admit('only-this')).toBe(true)

    acpWorkCli.setWindowAdmission(() => false)
    expect(admit('only-this')).toBe(false)
  })

  it('gives the agent door the same verdict the market window listener gets', () => {
    const verdict = (slug: string) => slug.endsWith('-6')

    acpWorkCli.setWindowAdmission(verdict)

    for (const slug of ['robinhood-0xabc-6', 'robinhood-0xabc-7', '']) {
      expect(lab.door!.admitStreaming(slug)).toBe(verdict(slug))
      expect(lab.watch!.admit?.(slug)).toBe(verdict(slug))
    }
  })
})
