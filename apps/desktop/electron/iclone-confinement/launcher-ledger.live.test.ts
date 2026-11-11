/**
 * The whole path, live: main's real confinement layer starts the real launcher (launcher.py) in a throwaway world,
 * the real Hermes interpreter runs the plugin's `SeatbeltEnvironment` under the real runtime profile, and every
 * confined command goes stub → launcher → sandbox-exec. Proven here: output and exit code come back; a sandbox-exec
 * from inside the runtime fails (profiles do not nest, so the stub is the only path); a read outside the roots is
 * refused and the run that asked is in the ledger with a non-zero end; the owner's Stop ends a long run and the ledger
 * reads `stopped`; the ledger folds to the right phases. Skipped where there is no sandbox-exec or no venv.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { RefusalView, RunView } from '../../src/iclone-shared/confinement'

import { createLauncherWorld, type LauncherWorld } from './launcher-live-harness'
import { probeVerdict } from './live-verdict.test-helpers'
import { startRefusalStream } from './refusals'
import { readRunEvents, REFUSED_MAX, runFiles, type RunStartEvent } from './runs'
import { RUNTIME_ROOT, runtimeAvailable } from './runtime-live-harness'
import { launcherLedgerDir, launcherSocketFile } from './runtime-profile'

const DRIVER = String.raw`
import importlib.util, json, os, subprocess, sys, types
repo, spec_raw, project, outside = sys.argv[1:5]
ns = types.ModuleType("hermes_plugins"); ns.__path__ = []; sys.modules["hermes_plugins"] = ns
d = os.path.join(repo, "plugins", "iclone-confinement")
spec = importlib.util.spec_from_file_location("hermes_plugins.iclone_confinement", os.path.join(d, "__init__.py"), submodule_search_locations=[d])
mod = importlib.util.module_from_spec(spec); sys.modules[spec.name] = mod; spec.loader.exec_module(mod)
from hermes_plugins.iclone_confinement import core
from hermes_plugins.iclone_confinement.seatbelt import SeatbeltEnvironment
env = SeatbeltEnvironment(cwd=project, timeout=20, cls="project", index=core.parse_spec(spec_raw), task_id="ledger-lab")
out = {"confined": core.runtime_confined(), "project": env.project_root}
def run(name, cmd):
    r = env.execute(cmd)
    out[name] = {"code": r.get("returncode"), "out": r.get("output", "")[-1200:]}
run("exit3", "echo out-ok; exit 3")
run("clean", "true")
run("outside", "cat " + outside + "/secret.txt")
try:
    p = subprocess.run(["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)", "/usr/bin/true"], capture_output=True, text=True, timeout=15)
    out["nest"] = {"code": p.returncode, "err": p.stderr[-200:]}
except Exception as exc:
    out["nest"] = {"code": None, "err": type(exc).__name__ + ": " + str(exc)[-200:]}
# A compromised runtime reaches the launcher socket: 300 requests with a profile the app never made, each through a
# fresh stub. Half carry a different long command each, half the same one.
bad = "(version 1)(allow default)"
refused = 0
for i in range(300):
    arg = ("flood-%04d-" % i if i % 2 else "flood-same-") + "x" * 1980
    p = subprocess.run(core.via_launcher(["/usr/bin/sandbox-exec", "-p", bad, "/bin/echo", arg]), capture_output=True, timeout=15)
    refused += p.returncode == 126
out["flood"] = refused
print("LEDGER-JSON" + json.dumps(out), flush=True)
proc = env._run_bash("sleep 30")
print("LEDGER-SLEEP " + str(proc.pid), flush=True)
print("LEDGER-SLEEP-END " + str(proc.wait()), flush=True)
`

const live = runtimeAvailable()

interface Result {
  confined: boolean
  project: string
  exit3: { code: number; out: string }
  clean: { code: number; out: string }
  outside: { code: number; out: string }
  nest: { code: number | null; err: string }
  flood: number
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }

    await wait(50)
  }
}

describe.skipIf(!live)('the launcher and the ledger, end to end (live, macOS Seatbelt)', () => {
  let world: LauncherWorld
  let userDataDir = ''
  let project = ''
  let outside = ''
  let layer: LauncherWorld['layer']
  let result: Result
  let stdout = ''
  let exitCode: number | null = null
  let stopped: Awaited<ReturnType<LauncherWorld['layer']['stopRun']>>
  let runs: RunView[] = []
  let sleepRun = ''
  /** The kernel's refusals, read live from the Sandbox log while the driver ran, for this world's members folder. */
  let streamed: RefusalView[] = []

  beforeAll(async () => {
    world = await createLauncherWorld()
    ;({ userDataDir, project, outside, layer } = world)

    const driver = path.join(project, 'driver.py')

    writeFileSync(driver, DRIVER)
    expect(existsSync(launcherSocketFile(userDataDir))).toBe(true)

    // The reader main runs, into the layer's own refusal log (the record the fold counts from), over this world's
    // members folder, listening before the first confined command.
    const refusalLog = layer.refusals

    const stream = startRefusalStream({
      log: refusalLog,
      membersDir: layer.paths.membersDir,
      confined: async () => new Map(),
      backfillSeconds: 5
    })

    await wait(1_500)

    const launch = world.launch(
      ['-s', '-P', driver, RUNTIME_ROOT, layer.spawnEnv().ICLONE_CONFINEMENT_SPEC, project, outside],
      true
    )

    const child = spawn(launch.command, launch.args, {
      cwd: project,
      env: world.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    })

    let stderr = ''

    child.stdout.on('data', chunk => (stdout += String(chunk)))
    child.stderr.on('data', chunk => (stderr += String(chunk)))

    const exited = new Promise<void>(resolve =>
      child.on('close', code => {
        exitCode = code
        resolve()
      })
    )

    const killer = setTimeout(() => {
      try {
        process.kill(-(child.pid ?? 0), 'SIGKILL')
      } catch {
        // already gone
      }
    }, 100_000)

    try {
      await until(() => stdout.includes('LEDGER-SLEEP ') || exitCode !== null, 80_000, `the driver (${stderr.slice(-800)})`)

      if (!stdout.includes('LEDGER-JSON')) {
        throw new Error(`the driver ended (exit ${exitCode}) before its report\n${stdout.slice(-800)}\n${stderr.slice(-1600)}\n${world.logs.join('\n')}`)
      }

      result = JSON.parse(stdout.slice(stdout.indexOf('LEDGER-JSON') + 'LEDGER-JSON'.length).split('\n')[0]) as Result

      const files = runFiles(userDataDir)

      const sleepStart = () =>
        readRunEvents(files).find(
          (event): event is RunStartEvent => event.ev === 'start' && event.command === 'sleep 30'
        )

      await until(() => sleepStart() !== undefined, 10_000, 'the sleep run in the ledger')
      sleepRun = sleepStart()?.run ?? ''
      stopped = await layer.stopRun(sleepRun)
      await until(() => exitCode !== null, 15_000, `the driver to end after the stop (${stderr.slice(-400)})`)
      await exited
      await until(
        () => readRunEvents(files).some(event => event.ev === 'end' && event.run === sleepRun),
        5_000,
        'the sleep run to end in the ledger'
      )
      runs = (await layer.state()).runs ?? []

      const secret = `${outside}/secret.txt`

      await until(
        () => refusalLog.recent(500).some(row => row.target === secret),
        10_000,
        'the refused read to reach the refusal stream'
      ).catch(() => undefined)
      streamed = refusalLog.recent(500)
    } finally {
      clearTimeout(killer)
      stream.stop()
    }
  }, 150_000)

  afterAll(async () => {
    await world?.dispose()
  })

  it('the runtime is confined and the plugin took the project as its root', () => {
    expect(result.confined).toBe(true)
    expect(result.project).toBe(project)
  })

  it('(a) a command’s output and its exit code 3 come back through stub and launcher', () => {
    expect(result.exit3).toMatchObject({ code: 3 })
    expect(result.exit3.out).toContain('out-ok')
    expect(result.clean.code).toBe(0)
  })

  it('(b) sandbox-exec from inside the runtime fails: the stub is the only path', () => {
    expect(result.nest.code, result.nest.err).not.toBe(0)
  })

  it('(c) a read outside the roots is refused, and the run that asked is in the ledger with a non-zero end', () => {
    expect(probeVerdict(result.outside)).toBe('refused')
    expect(result.outside.out).not.toContain('outside-secret')

    const events = readRunEvents(runFiles(userDataDir))

    const start = events.find(
      (event): event is RunStartEvent => event.ev === 'start' && event.command === `cat ${outside}/secret.txt`
    )

    expect(start).toBeDefined()
    expect(start?.kind).toBe('shell')

    const end = events.find(event => event.ev === 'end' && event.run === start?.run)

    expect(end?.ev === 'end' && end.code).not.toBe(0)
  })

  it('(c2) the kernel’s refusal of that read is attributed to that run by the kernel’s own line, after the cat is long gone', () => {
    const start = readRunEvents(runFiles(userDataDir)).find(
      (event): event is RunStartEvent => event.ev === 'start' && event.command === `cat ${outside}/secret.txt`
    )

    const row = streamed.find(item => item.target === `${outside}/secret.txt`)

    expect(start).toBeDefined()
    expect(row, streamed.map(item => `${item.pid} ${item.operation} ${item.target} run=${item.run}`).join('\n')).toBeDefined()
    expect(row?.run).toBe(start?.run)
    expect(row?.operation).toBe('file-read-data')
    // Every streamed row is this world's: a token of this members folder, never another instance's.
    expect(streamed.every(item => typeof item.run === 'string' && item.run.length > 0)).toBe(true)
    // The run the pane folds carries that count, and would carry it unchanged after the run's end.
    expect(runs.find(run => run.id === start?.run)?.refusals).toBeGreaterThanOrEqual(1)
  })

  it('(c3) who issued each run: the driver’s commands through execute() are the agent’s; its direct shell call is the environment’s own', () => {
    const byCommand = (command: string) => runs.find(run => run.command === command)

    expect(byCommand('true')?.origin).toBe('agent')
    expect(byCommand(`cat ${outside}/secret.txt`)?.origin).toBe('agent')
    expect(byCommand('sleep 30')?.origin).toBe('runtime')
  })

  it('(d) the owner’s Stop ends a long run through the layer, and the ledger reads stopped', () => {
    expect(stopped).toMatchObject({ ok: true, run: sleepRun })
    expect(stdout).toContain('LEDGER-SLEEP-END')
    expect(runs.find(run => run.id === sleepRun)?.phase).toBe('stopped')
  })

  it('(e) the ledger folds every run to its phase; the launcher wrote it where the runtime cannot', () => {
    const byCommand = (command: string) => runs.find(run => run.command === command)

    expect(byCommand('echo out-ok; exit 3')?.phase).toBe('failed')
    expect(byCommand('true')?.phase).toBe('exited')
    expect(byCommand(`cat ${outside}/secret.txt`)?.phase).toBe('failed')
    expect(byCommand('sleep 30')?.phase).toBe('stopped')
    expect(runs.every(run => run.phase !== 'running' && run.phase !== 'unknown')).toBe(true)
    expect(existsSync(path.join(launcherLedgerDir(userDataDir), 'runs.jsonl'))).toBe(true)
    expect(existsSync(path.join(userDataDir, 'confinement', 'run', 'runs.jsonl'))).toBe(false)
    expect(readFileSync(path.join(launcherLedgerDir(userDataDir), 'runs.jsonl'), 'utf8')).not.toContain('__hermes_ec')
  })

  it('(f) a flood of 300 refused requests through the stub leaves every finished run in the fold and on disk', async () => {
    expect(result.flood).toBe(300)

    const finished = ['true', 'echo out-ok; exit 3', `cat ${outside}/secret.txt`].map(command =>
      runs.find(run => run.command === command)
    )

    expect(finished.map(run => run?.phase)).toEqual(['exited', 'failed', 'failed'])

    const journal = readFileSync(path.join(launcherLedgerDir(userDataDir), 'runs.jsonl'), 'utf8')

    for (const run of finished) {
      expect(journal).toContain(run?.id)
    }

    // runs.jsonl holds only what the launcher started and reaped; refusals have their own file beside it.
    const kinds = journal
      .split('\n')
      .filter(Boolean)
      .map(line => (JSON.parse(line) as { ev: string }).ev)

    expect(kinds.every(ev => ev === 'start' || ev === 'end')).toBe(true)
    expect(kinds.filter(ev => ev === 'start')).toHaveLength(kinds.filter(ev => ev === 'end').length)

    const refusedFile = path.join(launcherLedgerDir(userDataDir), 'refused.jsonl')

    expect(statSync(refusedFile).mode & 0o777).toBe(0o600)
    expect(statSync(refusedFile).size).toBeLessThan(200 * 1024)

    // The repeated request collapses: once its window closes, one view counts all 150.
    const same = (views: readonly RunView[]) =>
      views.find(run => run.phase === 'refused' && run.command.startsWith('/bin/echo flood-same-'))

    const deadline = Date.now() + 30_000
    let latest = runs

    while (same(latest)?.refusedCount !== 150 && Date.now() < deadline) {
      await wait(250)
      latest = (await layer.state()).runs ?? []
    }

    expect(same(latest)?.refusedCount).toBe(150)
    expect(same(latest)?.refusedDetail).toContain('150 times')
    expect(latest.filter(run => run.phase === 'refused' && run.reportedBy === 'launcher').length).toBeLessThanOrEqual(
      REFUSED_MAX
    )
    expect(latest.filter(run => run.phase === 'exited' || run.phase === 'failed').length).toBeGreaterThanOrEqual(3)
  }, 60_000)
})
