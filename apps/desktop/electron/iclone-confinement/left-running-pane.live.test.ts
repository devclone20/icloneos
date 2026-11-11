/**
 * fx22: what the Containers pane reads of a run that left a background command running, on the whole path: the real
 * launcher, the real interpreter and the wrapper `terminal background=true` sends, then main's own state and Stop.
 * Three runs: one the owner stops, one that ends by itself, one the quit stops.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createLauncherWorld, type LauncherWorld } from './launcher-live-harness'
import { RUNTIME_ROOT, runtimeAvailable } from './runtime-live-harness'

const DRIVER = String.raw`
import importlib.util, json, os, sys, types
repo, spec_raw, project = sys.argv[1:4]
ns = types.ModuleType("hermes_plugins"); ns.__path__ = []; sys.modules["hermes_plugins"] = ns
d = os.path.join(repo, "plugins", "iclone-confinement")
spec = importlib.util.spec_from_file_location("hermes_plugins.iclone_confinement", os.path.join(d, "__init__.py"), submodule_search_locations=[d])
mod = importlib.util.module_from_spec(spec); sys.modules[spec.name] = mod; spec.loader.exec_module(mod)
from hermes_plugins.iclone_confinement import core
from hermes_plugins.iclone_confinement.seatbelt import SeatbeltEnvironment
from tools.process_registry import background_shell
env = SeatbeltEnvironment(cwd=project, timeout=20, cls="project", index=core.parse_spec(spec_raw), task_id="fx22-lab")
tmp = env.get_temp_dir()
for seconds in (301, 8, 302):
    env.execute(background_shell("sleep " + str(seconds), tmp, "fx22-" + str(seconds)), rewrite_compound_background=False)
print("FX22-DONE", flush=True)
`

const live = runtimeAvailable()
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }

    await wait(50)
  }
}

interface Row {
  ev: string
  run?: string
  ts?: string
  command?: string
  stopped?: boolean
  why?: string
}

describe.skipIf(!live)('the pane and a run that left a command running (live, macOS Seatbelt)', () => {
  let world: LauncherWorld
  let ledger = ''

  const journal = () =>
    readFileSync(ledger, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(row => JSON.parse(row) as Row)

  const runOf = (seconds: number) =>
    journal().find(row => row.ev === 'start' && row.command?.includes(`sleep ${seconds}`))?.run ?? ''

  const leftEnd = (run: string) => journal().find(row => row.ev === 'left-ended' && row.run === run)
  const viewOf = async (run: string) => ((await world.layer.state()).runs ?? []).find(item => item.id === run)

  beforeAll(async () => {
    world = await createLauncherWorld()
    ledger = path.join(world.userDataDir, 'confinement', 'ledger', 'runs.jsonl')

    const driver = path.join(world.project, 'driver.py')

    writeFileSync(driver, DRIVER)

    const output = await world.run(
      ['-s', '-P', driver, RUNTIME_ROOT, world.layer.spawnEnv().ICLONE_CONFINEMENT_SPEC, world.project],
      { confined: true, timeoutMs: 60_000 }
    )

    if (!output.out.includes('FX22-DONE')) {
      throw new Error(`the driver: ${output.code} ${output.err.slice(-1500)} ${output.out.slice(-500)}`)
    }

    await until(
      () => [301, 302].every(n => journal().some(row => row.ev === 'left-running' && row.run === runOf(n))),
      15_000,
      'the left-running rows'
    )
  }, 120_000)

  afterAll(async () => {
    await world?.dispose()
  })

  it('reads as running while it lives, stops with Stop, and ends at its true time', async () => {
    const run = runOf(301)
    const before = await viewOf(run)

    expect(before).toMatchObject({ phase: 'background', exitCode: 0 })
    expect(before?.live).toBeGreaterThanOrEqual(1)

    expect(await world.layer.stopRun(run)).toMatchObject({ ok: true })
    await until(() => leftEnd(run) !== undefined, 15_000, 'the left-ended row of the stopped run')

    expect(await viewOf(run)).toMatchObject({ phase: 'stopped', endedAt: leftEnd(run)?.ts, live: 0 })
  }, 60_000)

  it('ended by itself: its status, at its true time, later than the first process', async () => {
    const run = runOf(8)

    await until(() => leftEnd(run) !== undefined, 30_000, 'the left-ended row of the short command')

    const end = journal().find(row => row.ev === 'end' && row.run === run)
    const view = await viewOf(run)

    expect(view).toMatchObject({ phase: 'exited', exitCode: 0, endedAt: leftEnd(run)?.ts })
    expect(Date.parse(view?.endedAt ?? '')).toBeGreaterThan(Date.parse(end?.ts ?? ''))
  }, 60_000)

  it('the quit stops it, and the pane says stopped', async () => {
    const run = runOf(302)

    expect((await viewOf(run))?.phase).toBe('background')
    await world.layer.stopLauncher()
    expect(leftEnd(run)).toMatchObject({ stopped: true, why: 'quit' })
    expect(await viewOf(run)).toMatchObject({ phase: 'stopped', endedAt: leftEnd(run)?.ts, live: 0 })
  }, 60_000)
})
