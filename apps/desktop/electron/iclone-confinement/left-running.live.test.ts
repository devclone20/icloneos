/**
 * fx21 — the three findings of the v0.0.6 real-app proof, on the whole path: main's layer starts the real launcher, the
 * real Hermes interpreter runs `SeatbeltEnvironment` under the runtime profile, and each command goes stub → launcher →
 * sandbox-exec. F1: the exact wrapper `terminal background=true` sends, and a daemon out of the group, both outlive
 * the run's first process, are in the journal, count in the quit decision, and stop with the launcher. F2, F3: what
 * read_file and write_file say about a sibling folder, from the kernel's real answer.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CONSENT_CAPABILITY_KEYS, type ConsentRecord } from '../iclone-consent'
import { ceilingsFrom } from '../iclone-permissions/classify-policy'
import { DEFAULT_FUNCTION_LEVELS } from '../iclone-permissions/functions'
import type { PermissionMode } from '../iclone-permissions/modes'
import { buildPolicyBody } from '../iclone-permissions/policy-file'

import { createLauncherWorld, type LauncherWorld } from './launcher-live-harness'
import { sweepTokens } from './members'
import { leftRunningCount, readRunEvents, runFiles } from './runs'
import { RUNTIME_ROOT, runtimeAvailable } from './runtime-live-harness'

const DRIVER = String.raw`
import importlib.util, json, os, shlex, sys, types
repo, spec_raw, project, outside = sys.argv[1:5]
ns = types.ModuleType("hermes_plugins"); ns.__path__ = []; sys.modules["hermes_plugins"] = ns
d = os.path.join(repo, "plugins", "iclone-confinement")
spec = importlib.util.spec_from_file_location("hermes_plugins.iclone_confinement", os.path.join(d, "__init__.py"), submodule_search_locations=[d])
mod = importlib.util.module_from_spec(spec); sys.modules[spec.name] = mod; spec.loader.exec_module(mod)
from hermes_plugins.iclone_confinement import core
from hermes_plugins.iclone_confinement.seatbelt import SeatbeltEnvironment
from tools.file_operations import ShellFileOperations
from tools.process_registry import background_shell
env = SeatbeltEnvironment(cwd=project, timeout=20, cls="project", index=core.parse_spec(spec_raw), task_id="fx21-lab")
out = {}
tmp = env.get_temp_dir()
out["tmp"] = tmp
r = env.execute(background_shell("echo $$ > " + tmp + "/bg.pid; sleep 300", tmp, "fx35e"), rewrite_compound_background=False)
out["background"] = {"code": r.get("returncode"), "out": r.get("output", "")[-200:]}
r = env.execute(background_shell("echo $$ > " + tmp + "/hup.pid; until [ -e " + tmp + "/hup.go ]; do sleep 0.1; done; echo survived", tmp, "fx35h"), rewrite_compound_background=False)
out["hup"] = {"code": r.get("returncode")}
daemon = "use POSIX; fork and exit; POSIX::setsid(); fork and exit; open(F, q{>}, q{" + tmp + "/daemon.pid}); print F $$; close F; sleep 300;"
r = env.execute("/usr/bin/perl -e " + shlex.quote(daemon) + " < /dev/null > /dev/null 2> " + tmp + "/daemon.err; echo daemon-rc=$?")
out["daemon"] = {"code": r.get("returncode"), "out": r.get("output", "")[-200:]}
ops = ShellFileOperations(env, cwd=project)
read = ops.read_file(outside + "/secret.txt")
out["read"] = {"error": read.error, "not_found": read.not_found, "content": read.content}
missing = ops.read_file(project + "/gone.txt")
out["missing"] = {"error": missing.error, "not_found": missing.not_found}
wrote = ops.write_file(outside + "/new/x.txt", "x")
out["write"] = {"error": wrote.error}
print("FX21-JSON" + json.dumps(out), flush=True)
`

const live = runtimeAvailable()

interface Result {
  tmp: string
  background: { code: number; out: string }
  hup: { code: number }
  daemon: { code: number; out: string }
  read: { error: string; not_found: boolean; content: string }
  missing: { error: string; not_found: boolean }
  write: { error: string }
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function until(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }

    await wait(50)
  }
}

describe.skipIf(!live)('a confined background command and the app (live, macOS Seatbelt)', () => {
  let world: LauncherWorld
  let result: Result
  let bgPid = 0
  let daemonPid = 0
  let countBeforeQuit = -1
  let hangup = { exit: '', log: '' }
  let journal: { ev: string; run?: string; command?: string; stopped?: boolean; why?: string; survivors?: number; signal?: number | null }[] = []

  beforeAll(async () => {
    world = await createLauncherWorld()

    const driver = path.join(world.project, 'driver.py')

    writeFileSync(driver, DRIVER)

    const output = await world.run(
      ['-s', '-P', driver, RUNTIME_ROOT, world.layer.spawnEnv().ICLONE_CONFINEMENT_SPEC, world.project, world.outside],
      { confined: true, timeoutMs: 90_000 }
    )

    const line = output.out.split('\n').find(row => row.startsWith('FX21-JSON'))

    if (!line) {
      throw new Error(`the driver said nothing: ${output.code} ${output.err.slice(-1500)} ${output.out.slice(-500)}`)
    }

    result = JSON.parse(line.slice('FX21-JSON'.length)) as Result

    const pidFile = (name: string) => path.join(result.tmp, name)

    await until(() => existsSync(pidFile('bg.pid')), 10_000, `the background command ${JSON.stringify(result)}`)
    await until(() => existsSync(pidFile('daemon.pid')), 10_000, `the daemon ${result.daemon.out} ${existsSync(pidFile('daemon.err')) ? readFileSync(pidFile('daemon.err'), 'utf8') : ''}`)
    bgPid = Number(readFileSync(pidFile('bg.pid'), 'utf8'))
    daemonPid = Number(readFileSync(pidFile('daemon.pid'), 'utf8'))

    const ledger = path.join(world.userDataDir, 'confinement', 'ledger', 'runs.jsonl')

    await until(() => readFileSync(ledger, 'utf8').includes('left-running'), 10_000, 'the left-running row')
    countBeforeQuit = leftRunningCount(runFiles(world.userDataDir))

    // fx35e (R40): the real hangup, from outside, on the command and on the wrapper that writes its exit. What decides
    // is that the command carries on past it to the file it waits for, so nothing here is a matter of timing.
    const rows = () =>
      readFileSync(ledger, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(row => JSON.parse(row) as (typeof journal)[number])

    // Its own left-running row first and its left-ended row after, so quitting below finds it settled either way.
    await until(() => rows().filter(row => row.ev === 'left-running').length >= 3, 10_000, 'the third left-running row')
    await until(() => existsSync(pidFile('hup.pid')), 10_000, 'the second background command')
    process.kill(Number(readFileSync(pidFile('hup.pid'), 'utf8')), 'SIGHUP')
    process.kill(Number(readFileSync(pidFile('hermes_bg_fx35h.pid'), 'utf8')), 'SIGHUP')
    writeFileSync(pidFile('hup.go'), '')
    await until(() => existsSync(pidFile('hermes_bg_fx35h.exit')), 5_000, 'its exit').catch(() => undefined)
    hangup = {
      exit: existsSync(pidFile('hermes_bg_fx35h.exit')) ? readFileSync(pidFile('hermes_bg_fx35h.exit'), 'utf8').trim() : 'none',
      log: readFileSync(pidFile('hermes_bg_fx35h.log'), 'utf8')
    }
    await until(() => rows().some(row => row.ev === 'left-ended'), 10_000, 'its left-ended row')

    expect(alive(bgPid)).toBe(true)
    expect(alive(daemonPid)).toBe(true)

    // What quitting does: main stops the launcher.
    await world.layer.stopLauncher()
    journal = readFileSync(ledger, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(row => JSON.parse(row) as (typeof journal)[number])
  }, 180_000)

  afterAll(async () => {
    for (const pid of [bgPid, daemonPid]) {
      if (pid > 1 && alive(pid)) {
        process.kill(pid, 'SIGKILL')
      }
    }

    await world?.dispose()
  })

  it('F1: the runtime gets its answer at once and the command goes on (the reason it survived)', () => {
    expect(result.background.code).toBe(0)
    expect(result.background.out).toMatch(/^\d+$/m)
    expect(journal.filter(row => row.ev === 'end').length).toBeGreaterThan(0)
  })

  it('fx35e (R40): the command and its wrapper outlive a hangup, and the exit is still written', () => {
    expect(result.hup.code).toBe(0)
    expect(hangup.log).toContain('survived')
    expect(hangup.log).not.toContain('nohup')
    expect(hangup.exit).toBe('0')
  })

  it('F1: it counts in the quit decision', () => {
    expect(countBeforeQuit).toBeGreaterThanOrEqual(1)
  })

  it('F1: no process survives the launcher, in the group or out of it', async () => {
    await until(() => !alive(bgPid) && !alive(daemonPid), 5_000, 'the background command and the daemon to die')
    expect(alive(bgPid)).toBe(false)
    expect(alive(daemonPid)).toBe(false)
  })

  it('F1: the journal says it ran on and how it ended', () => {
    const ended = journal.filter(row => row.ev === 'left-ended')
    const hupRun = journal.find(row => row.ev === 'start' && row.command?.includes('hup.pid'))?.run
    const left = journal.filter(row => row.ev === 'left-running' && row.run !== hupRun)

    expect(left.length).toBeGreaterThanOrEqual(2)
    expect(ended.find(end => end.run === hupRun)).toMatchObject({ stopped: false })

    for (const row of left) {
      expect(ended.find(end => end.run === row.run)).toMatchObject({ stopped: true, why: 'quit', survivors: 0 })
    }
  })

  it('F2: a read the kernel refuses says so, by the kernel, and does not read', () => {
    expect(result.read.error).toContain('icloneOS confinement refused')
    expect(result.read.error).not.toContain('File not found')
    expect(result.read.not_found).toBeFalsy()
    expect(result.read.content ?? '').not.toContain('outside-secret')
  })

  it('F2: a file that is really missing in the project stays "File not found"', () => {
    expect(result.missing.error).toContain('File not found')
    expect(result.missing.not_found).toBe(true)
  })

  it('F3: a write the kernel refuses says why and what to do, and nothing lands', () => {
    expect(result.write.error).toContain('Operation not permitted')
    expect(result.write.error).toContain('icloneOS: this write ran confined to')
    expect(result.write.error).toContain('workdir=')
    expect(existsSync(path.join(world.outside, 'new'))).toBe(false)
  })
})

// fx26a (pre4 major 1, closerh5 sentences): the same world, a daemon the shell double-forked out of the group, as the
// one above; the run's token taken by main's own sweep, the launcher killed, a background command ending within the grace.
const FX26A_DRIVER = String.raw`
import importlib.util, json, os, shlex, sys, types
repo, spec_raw, project, mode = sys.argv[1:5]
ns = types.ModuleType("hermes_plugins"); ns.__path__ = []; sys.modules["hermes_plugins"] = ns
d = os.path.join(repo, "plugins", "iclone-confinement")
spec = importlib.util.spec_from_file_location("hermes_plugins.iclone_confinement", os.path.join(d, "__init__.py"), submodule_search_locations=[d])
mod = importlib.util.module_from_spec(spec); sys.modules[spec.name] = mod; spec.loader.exec_module(mod)
from hermes_plugins.iclone_confinement import core
from hermes_plugins.iclone_confinement.seatbelt import SeatbeltEnvironment
env = SeatbeltEnvironment(cwd=project, timeout=20, cls="project", index=core.parse_spec(spec_raw), task_id="fx26a-lab")
tmp = env.get_temp_dir()
out = {"tmp": tmp}
if mode == "daemon":
    daemon = "use POSIX; fork and exit; POSIX::setsid(); fork and exit; open(F, q{>}, q{" + tmp + "/daemon.pid}); print F $$; close F; sleep 300;"
    r = env.execute("/usr/bin/perl -e " + shlex.quote(daemon) + " < /dev/null > /dev/null 2> " + tmp + "/daemon.err; echo daemon-rc=$?")
else:
    r = env.execute("( sleep 0.1 ) > /dev/null 2>&1 & echo quick")
out["result"] = {"code": r.get("returncode"), "out": r.get("output", "")[-200:]}
print("FX26A-JSON" + json.dumps(out), flush=True)
`

interface DaemonRun {
  world: LauncherWorld
  daemonPid: number
  run: string
  token: string
}

const ledgerOf = (world: LauncherWorld) => path.join(world.userDataDir, 'confinement', 'ledger', 'runs.jsonl')

const journalOf = (world: LauncherWorld) =>
  readFileSync(ledgerOf(world), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(row => JSON.parse(row) as { ev: string; run?: string; stopped?: boolean; why?: string; background?: boolean })

async function drive(world: LauncherWorld, mode: 'daemon' | 'quick'): Promise<{ tmp: string; run: string }> {
  const driver = path.join(world.project, `driver-${mode}.py`)

  writeFileSync(driver, FX26A_DRIVER)

  const before = new Set(readRunEvents(runFiles(world.userDataDir)).flatMap(event => (event.ev === 'start' ? [event.run] : [])))

  const output = await world.run(
    ['-s', '-P', driver, RUNTIME_ROOT, world.layer.spawnEnv().ICLONE_CONFINEMENT_SPEC, world.project, mode],
    { confined: true, timeoutMs: 90_000 }
  )

  const line = output.out.split('\n').find(row => row.startsWith('FX26A-JSON'))

  if (!line) {
    throw new Error(`the driver said nothing: ${output.code} ${output.err.slice(-1500)} ${output.out.slice(-500)}`)
  }

  const { tmp } = JSON.parse(line.slice('FX26A-JSON'.length)) as { tmp: string }
  // The run of the driver's command, by its text: the plugin's own setup commands of this launch are runs too.
  const word = mode === 'daemon' ? 'daemon-rc' : 'echo quick'
  const starts = readRunEvents(runFiles(world.userDataDir)).flatMap(event => (event.ev === 'start' && !before.has(event.run) ? [event] : []))
  const own = starts.filter(event => event.command.includes(word))

  console.info(`fx26a ${mode}: new runs ${JSON.stringify(starts.map(event => event.command.slice(0, 60)))}`)
  expect(own).toHaveLength(1)

  return { tmp, run: own[0].run }
}

async function daemonRun(world: LauncherWorld): Promise<DaemonRun> {
  const { tmp, run } = await drive(world, 'daemon')
  const pidFile = path.join(tmp, 'daemon.pid')

  await until(() => existsSync(pidFile), 10_000, 'the daemon')

  const daemonPid = Number(readFileSync(pidFile, 'utf8'))

  await until(() => readFileSync(ledgerOf(world), 'utf8').includes('left-running'), 10_000, 'the left-running row')

  const token = path.join(world.layer.paths.membersDir, run)

  expect(alive(daemonPid)).toBe(true)
  expect(existsSync(token)).toBe(true)

  return { world, daemonPid, run, token }
}

/** Main's own remover (members.ts sweepTokens), as the state scan calls it, with the token past its grace. */
function sweepByMain(world: LauncherWorld, token: string): void {
  // Every token of this launch goes (the plugin's own setup run has one too): nothing lives that main could name.
  expect(sweepTokens(world.layer.paths.membersDir, new Map(), Date.now() + 11 * 60_000)).toBeGreaterThanOrEqual(1)
  expect(existsSync(token)).toBe(false)
}

const consent = (): ConsentRecord => ({
  schema: 1,
  policyVersion: 'live',
  policyEffective: 'live',
  acceptedAt: new Date().toISOString(),
  permissions: Object.fromEntries(CONSENT_CAPABILITY_KEYS.map(key => [key, true])) as ConsentRecord['permissions'],
  permissionsDecidedAt: new Date().toISOString(),
  skipped: false,
  aiProviderConsent: null
})

/** Main's own writer: the standing mode lowered, every project and session with it. */
const publishMode = (world: LauncherWorld, standing: PermissionMode) =>
  world.layer.publishLauncherPolicy(
    buildPolicyBody({
      mode: { v: 1, standing, projects: {}, sessions: {}, updatedAt: new Date().toISOString() },
      grants: [],
      ceilings: ceilingsFrom(consent()),
      protectedPaths: [],
      secretPaths: [],
      guardPids: [],
      inftContracts: [],
      functions: { ...DEFAULT_FUNCTION_LEVELS },
      fnGrants: [],
      now: new Date()
    })
  )

const runRow = async (world: LauncherWorld, run: string) => (await world.layer.state()).runs.find(row => row.id === run)

describe.skipIf(!live)('fx26a: a daemon whose run token main swept, and a downgrade to Plan (live, macOS Seatbelt)', () => {
  let it1: DaemonRun

  beforeAll(async () => {
    it1 = await daemonRun(await createLauncherWorld())
  }, 180_000)

  afterAll(async () => {
    if (it1?.daemonPid > 1 && alive(it1.daemonPid)) {
      process.kill(it1.daemonPid, 'SIGKILL')
    }

    await it1?.world.dispose()
  })

  it('token gone, daemon alive: the run row reads background with it as its live count, never Background ended', async () => {
    sweepByMain(it1.world, it1.token)

    const row = await runRow(it1.world, it1.run)

    expect(row).toMatchObject({ id: it1.run, phase: 'background', live: 1 })
    expect(row).not.toHaveProperty('backgroundEnded')
    expect(alive(it1.daemonPid)).toBe(true)
  })

  it('lowering the standing mode to Plan kills it, and the journal says why', async () => {
    publishMode(it1.world, 'plan')
    await until(() => !alive(it1.daemonPid), 10_000, 'the daemon to die on the downgrade')
    await until(() => journalOf(it1.world).some(row => row.ev === 'left-ended' && row.run === it1.run), 10_000, 'the left-ended row')

    expect(journalOf(it1.world).filter(row => row.ev === 'left-ended' && row.run === it1.run)).toMatchObject([{ stopped: true, why: 'policy' }])
    expect(await runRow(it1.world, it1.run)).toMatchObject({ phase: 'stopped', live: 0 })
  })
})

describe.skipIf(!live)('fx28: a daemon whose run token main swept, and a raise (live, macOS Seatbelt)', () => {
  let it4: DaemonRun

  beforeAll(async () => {
    it4 = await daemonRun(await createLauncherWorld())
  }, 180_000)

  afterAll(async () => {
    if (it4?.daemonPid > 1 && alive(it4.daemonPid)) {
      process.kill(it4.daemonPid, 'SIGKILL')
    }

    await it4?.world.dispose()
  })

  it('raising the standing mode kills it too: no flags to judge, no run to answer for it, and the journal says why', async () => {
    sweepByMain(it4.world, it4.token)
    publishMode(it4.world, 'ignore')
    await until(() => !alive(it4.daemonPid), 10_000, 'the daemon to die on the raise')
    await until(() => journalOf(it4.world).some(row => row.ev === 'left-ended' && row.run === it4.run), 10_000, 'the left-ended row')

    expect(journalOf(it4.world).filter(row => row.ev === 'left-ended' && row.run === it4.run)).toMatchObject([{ stopped: true, why: 'policy' }])
  })
})

describe.skipIf(!live)('fx26a: a daemon whose run token main swept, and quitting (live, macOS Seatbelt)', () => {
  let it2: DaemonRun

  beforeAll(async () => {
    it2 = await daemonRun(await createLauncherWorld())
  }, 180_000)

  afterAll(async () => {
    if (it2?.daemonPid > 1 && alive(it2.daemonPid)) {
      process.kill(it2.daemonPid, 'SIGKILL')
    }

    await it2?.world.dispose()
  })

  it('quitting (main stops the launcher) kills it, and the journal says why', async () => {
    sweepByMain(it2.world, it2.token)
    expect(await runRow(it2.world, it2.run)).toMatchObject({ phase: 'background', live: 1 })

    await it2.world.layer.stopLauncher()
    await until(() => !alive(it2.daemonPid), 10_000, 'the daemon to die at quit')

    expect(journalOf(it2.world).filter(row => row.ev === 'left-ended' && row.run === it2.run)).toMatchObject([{ stopped: true, why: 'quit' }])
  })
})

describe.skipIf(!live)('closerh5 sentences: the launcher killed -9, and a background command gone within the grace (live)', () => {
  let world: LauncherWorld
  let it3: DaemonRun

  beforeAll(async () => {
    world = await createLauncherWorld()
  }, 180_000)

  afterAll(async () => {
    if (it3?.daemonPid > 1 && alive(it3.daemonPid)) {
      process.kill(it3.daemonPid, 'SIGKILL')
    }

    await world?.dispose()
  })

  it('a background command that ends within LEFT_GRACE_S leaves no left-running row: only the background wrapper flag would say', async () => {
    const { run } = await drive(world, 'quick')

    await wait(1_500)

    const rows = journalOf(world).filter(row => row.run === run)

    expect(rows.map(row => row.ev)).toEqual(['start', 'end'])
    expect(rows[0]).not.toHaveProperty('background')
    expect(await runRow(world, run)).toMatchObject({ phase: 'exited', live: 0 })
    expect(await runRow(world, run)).not.toHaveProperty('backgroundEnded')
  })

  it('kill -9 the real launcher: quit and a lower mode do not reach what it started; the pane’s Stop does', async () => {
    it3 = await daemonRun(world)

    const launcherPid = Number(/launcher ready \(pid (\d+)\)/.exec(world.logs.join('\n'))?.[1])

    expect(launcherPid).toBeGreaterThan(1)
    process.kill(launcherPid, 'SIGKILL')
    await until(() => !alive(launcherPid), 5_000, 'the launcher to die')

    // The launcher is restarted by main (launcher.ts) and knows nothing of this run: the sentence holds either way.
    publishMode(world, 'plan')
    await wait(1_500)
    expect(alive(it3.daemonPid)).toBe(true)

    await world.layer.stopLauncher()
    await wait(1_000)
    expect(alive(it3.daemonPid)).toBe(true)
    expect(journalOf(world).filter(row => row.ev === 'left-ended' && row.run === it3.run)).toEqual([])

    expect(await world.layer.stopRun(it3.run)).toMatchObject({ ok: true, run: it3.run })
    await until(() => !alive(it3.daemonPid), 10_000, 'the daemon to die on Stop')
  })
})
