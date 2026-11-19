// v0.0.9 W1b (F1-B items 2–3) — the packaged self-test proves the CLI the app SHIPS, not "the app ships only the pin".
// A self-test launch never runs initIcloneAcp (startIcloneSelftest skips the app's startup), so `tools` is null here
// exactly as it is there. With no staged bundle a dev run reports the pin alone (`bundled: false`); once a build staged
// `<app>/build/acp-tools` (the real build code, fixture.ts `writeFixtureBundle`), the self-test places the included copy
// in its own throwaway userData, reports `bundled: true, verified: true`, and runs `chain list --json` through the
// confined launcher. Red on the old code: `selftestAcp` was not exported and always answered `bundled: false`.
import { EventEmitter } from 'node:events'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const lab = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? '/tmp').replace(/\/$/, '')
  const home = `${tmp}/iclone-w1b-selftest-${process.pid}-${Date.now()}`

  return {
    home,
    app: `${home}/app`,
    userData: `${home}/userData`,
    forks: [] as { args: string[] }[],
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
  ipcMain: { handle: () => undefined, on: () => undefined },
  net: {
    fetch: () => {
      lab.fetched += 1

      return Promise.reject(new Error('the self-test never downloads the CLI'))
    }
  },
  utilityProcess: {
    fork: (_modulePath: string, args: string[]) => {
      lab.forks.push({ args })

      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        pid: 4244,
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

import { selftestAcp } from '../iclone-acp'

import { type FixtureRegistry, writeFixtureBundle, writeFixturePin } from './fixture'

const savedBin = process.env.ICLONE_ACP_BIN
let pin: FixtureRegistry

beforeAll(() => {
  delete process.env.ICLONE_ACP_BIN
  pin = writeFixturePin(path.join(lab.home, 'pin'))
  mkdirSync(path.join(lab.app, 'scripts'), { recursive: true })
  mkdirSync(lab.userData, { recursive: true })
  cpSync(pin.pinDir, path.join(lab.app, 'acp-cli-lock'), { recursive: true })
  cpSync(pin.launcher, path.join(lab.app, 'scripts', 'acp-launch.cjs'))
})

afterAll(() => {
  process.env.ICLONE_ACP_BIN = savedBin
  rmSync(lab.home, { force: true, recursive: true })
})

describe('W1b: the self-test proves the bundled ACP CLI', () => {
  it('a dev run with no staged bundle reports the pin alone (bundled: false), no CLI run, no download', async () => {
    const report = await selftestAcp()

    expect(report).toMatchObject({ ok: true, bundled: false, version: '1.0.38' })
    expect(report.lockSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(report.verified).toBeUndefined()
    expect(lab.forks).toHaveLength(0)
    expect(lab.fetched).toBe(0)
  })

  it('with the bundle staged: bundled + verified, and `chain list --json` runs through the confined launcher', async () => {
    await writeFixtureBundle(pin, path.join(lab.app, 'build', 'acp-tools'))

    const report = await selftestAcp()

    expect(report).toMatchObject({ ok: true, bundled: true, verified: true, version: '1.0.38' })
    expect(report.error).toBeUndefined()
    expect(lab.forks.some(fork => fork.args.slice(1).join(' ') === 'chain list --json')).toBe(true)
    expect(lab.fetched).toBe(0)
  })
})
