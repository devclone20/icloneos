/**
 * The runtime's own home, live: what a real confined interpreter can plant in HERMES_HOME under `sandbox-exec -p
 * <runtime profile>`, against the real unconfined writers of main (desktop.log, the update marker, the hand-off result).
 * Main must never reach through what was planted; the planting itself is asserted, so no case passes for lack of a link.
 * Uses a throwaway world only, never the real home.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type * as LogModule from '../main/log'

import { attachLayer, type WorldLayer } from './launcher-live-harness'
import { createRuntimeWorld, type RuntimeWorld } from './runtime-live-harness'

const h = vi.hoisted(() => ({ hermesHome: '', userData: '' }))

vi.mock('electron', () => ({ app: { getPath: () => h.userData, isPackaged: false } }))
vi.mock('../main/env', () => ({
  get HERMES_HOME() {
    return h.hermesHome
  },
  IS_PACKAGED: false,
  updatePolicyOverrideFile: () => path.join(h.userData, 'no-override.json')
}))

const live = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')

const PLANT = `
import json, os, shutil, sys
action, home, hermes, tmp = sys.argv[1:5]
logs = os.path.join(hermes, "logs")
canary = os.path.join(home, ".zshrc")
def empty(p):
    if os.path.islink(p) or os.path.isfile(p): os.unlink(p)
    elif os.path.isdir(p): shutil.rmtree(p)
out = {}
try:
    if action == "denied":
        open(canary).read()
    elif action == "link-log":
        os.makedirs(logs, exist_ok=True); empty(os.path.join(logs, "desktop.log"))
        os.symlink(canary, os.path.join(logs, "desktop.log"))
    elif action == "dangling-log":
        os.makedirs(logs, exist_ok=True); empty(os.path.join(logs, "desktop.log"))
        os.symlink(os.path.join(home, "new-file"), os.path.join(logs, "desktop.log"))
    elif action == "fifo-log":
        os.makedirs(logs, exist_ok=True); empty(os.path.join(logs, "desktop.log"))
        os.mkfifo(os.path.join(logs, "desktop.log"))
    elif action == "dir-log":
        os.makedirs(os.path.join(logs, "desktop.log"), exist_ok=True)
    elif action == "link-folder":
        empty(logs); os.symlink(home, logs)
    elif action == "link-marker":
        os.symlink(canary, os.path.join(hermes, ".hermes-update-in-progress"))
    elif action == "link-result":
        os.symlink(canary, os.path.join(hermes, ".hermes-update-result.json"))
    elif action == "move-home":
        os.rename(hermes, os.path.join(tmp, "moved-home"))
    out["done"] = True
except Exception as e:
    out["error"] = type(e).__name__
print("RESULT" + json.dumps(out))
`

describe.skipIf(!live)('the runtime home holds no link main follows (live, macOS Seatbelt)', () => {
  let world: RuntimeWorld
  let layer: WorldLayer
  let home: string
  let canary: string
  let logFile: string
  let log: typeof LogModule
  let driver: string

  const ORIGINAL = 'original-rc\n'

  const plant = async (action: string) => {
    const run = await layer.run(['-s', '-P', driver, action, home, world.paths.hermesHome, world.facts.tmpDir], {
      confined: true,
      timeoutMs: 60_000,
      env: { HOME: home }
    })

    return JSON.parse(/RESULT(.*)/.exec(run.out ?? '')?.[1] ?? '{"error":"no result"}') as { done?: boolean; error?: string }
  }

  const clearLogs = () => {
    rmSync(path.join(world.paths.hermesHome, 'logs'), { force: true, recursive: true })
    writeFileSync(canary, ORIGINAL)
  }

  const flushLine = (line: string) => {
    log.rememberLog(line)
    log.flushDesktopLogBufferSync()
  }

  beforeAll(async () => {
    world = createRuntimeWorld({})
    home = world.facts.homeDir ?? path.join(world.root, 'home')
    canary = path.join(home, '.zshrc')
    writeFileSync(canary, ORIGINAL)
    driver = path.join(world.root, 'project', 'plant.py')
    writeFileSync(driver, PLANT)
    h.hermesHome = world.paths.hermesHome
    h.userData = world.paths.userDataDir
    logFile = path.join(world.paths.hermesHome, 'logs', 'desktop.log')
    layer = await attachLayer(world)
    log = await import('../main/log')
  }, 120_000)

  afterAll(async () => {
    await layer?.dispose()
    world?.dispose()
  })

  it('the wall holds on its own: the runtime cannot open the file directly', async () => {
    expect(await plant('denied')).toEqual({ error: 'PermissionError' })
  }, 60_000)

  it('a link planted at desktop.log: main does not write through it, keeps the line in memory, records once', async () => {
    clearLogs()
    expect(await plant('link-log')).toEqual({ done: true })
    expect(lstatSync(logFile).isSymbolicLink()).toBe(true)

    flushLine('line-through-link')
    flushLine('second-line-through-link')

    expect(readFileSync(canary, 'utf8')).toBe(ORIGINAL)
    expect(log.hermesLog.join('\n')).toContain('line-through-link')

    const record = readFileSync(path.join(h.userData, 'desktop-log-refused.json'), 'utf8')

    expect(record.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(record).refused).toContain('desktop.log')
  }, 60_000)

  it('a dangling link at desktop.log creates nothing at its target', async () => {
    clearLogs()
    expect(await plant('dangling-log')).toEqual({ done: true })

    flushLine('line-through-dangling')

    expect(existsSync(path.join(home, 'new-file'))).toBe(false)
  }, 60_000)

  it('a FIFO at desktop.log never hangs main', async () => {
    clearLogs()
    expect(await plant('fifo-log')).toEqual({ done: true })
    expect(lstatSync(logFile).isFIFO()).toBe(true)

    flushLine('line-at-fifo')

    expect(log.hermesLog.join('\n')).toContain('line-at-fifo')
  }, 60_000)

  it('a folder at desktop.log is left alone, and does not crash the flush', async () => {
    clearLogs()
    expect(await plant('dir-log')).toEqual({ done: true })

    flushLine('line-at-folder')

    expect(lstatSync(logFile).isDirectory()).toBe(true)
    expect(readdirSync(logFile)).toEqual([])
  }, 60_000)

  it('a link in place of logs/ itself sends nothing to its target', async () => {
    clearLogs()
    expect(await plant('link-folder')).toEqual({ done: true })

    flushLine('line-through-folder')

    expect(existsSync(path.join(home, 'desktop.log'))).toBe(false)
    rmSync(path.join(world.paths.hermesHome, 'logs'))
    mkdirSync(path.join(world.paths.hermesHome, 'logs'))
  }, 60_000)

  it('a plain log still works after the refusals: the fix does not silence logging', async () => {
    clearLogs()
    flushLine('line-in-the-real-log')

    expect(readFileSync(logFile, 'utf8')).toContain('line-in-the-real-log')
  }, 60_000)

  it('a link at the update marker: main neither truncates nor rewrites the target', async () => {
    const { writeUpdateMarker } = await import('../update-marker')

    // A live pid: an owner the marker's own staleness cleanup would not unlink first.
    const alive = `${process.pid}\n${Math.floor(Date.now() / 1000)}\n`

    writeFileSync(canary, alive)
    expect(await plant('link-marker')).toEqual({ done: true })

    writeUpdateMarker(world.paths.hermesHome, 4242)

    expect(readFileSync(canary, 'utf8')).toBe(alive)
    rmSync(path.join(world.paths.hermesHome, '.hermes-update-in-progress'))
  }, 60_000)

  it('a link at the hand-off result: main does not read through it, and removes only the link', async () => {
    const { readAndConsumeHandoffResult } = await import('../handoff-result')

    writeFileSync(canary, '{"exitCode":0,"at":0}\n')
    expect(await plant('link-result')).toEqual({ done: true })

    expect(readAndConsumeHandoffResult(world.paths.hermesHome)).toBeNull()
    expect(readFileSync(canary, 'utf8')).toBe('{"exitCode":0,"at":0}\n')
    rmSync(path.join(world.paths.hermesHome, '.hermes-update-result.json'), { force: true })
  }, 60_000)

  it("the home's own name cannot be moved aside: its never-written folders would be written from outside", async () => {
    const moved = path.join(world.facts.tmpDir, 'moved-home')
    const answer = await plant('move-home')
    const escaped = existsSync(moved)

    if (escaped) {
      renameSync(moved, world.paths.hermesHome)
    }

    expect(escaped).toBe(false)
    expect(answer).toEqual({ error: 'PermissionError' })
  }, 60_000)
})
