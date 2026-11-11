/**
 * fx23 (D6, the launcher half; critic r2-A): the real launcher, the real `sandbox-exec` and a policy body main's own
 * writer builds (fx24: buildPolicyBody, with the switches on, undecided and off), with the real mode table, no fake. Plan reads and does not write or reach the network. Automatic
 * writes a listed folder with no pass. Automatic in an unlisted folder and Manual with no pass start narrowed: the write
 * gets EPERM and the output carries the launcher's true line. Skipped where there is no sandbox-exec or no venv. The
 * app's half (the modes as the Settings pane sets them) is the owner's step.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CONSENT_CAPABILITY_KEYS, type ConsentRecord } from '../iclone-consent'
import { ceilingsFrom } from '../iclone-permissions/classify-policy'
import { DEFAULT_FUNCTION_LEVELS } from '../iclone-permissions/functions'
import type { PermissionMode } from '../iclone-permissions/modes'
import { buildPolicyBody } from '../iclone-permissions/policy-file'

import { createLauncherWorld, type LauncherWorld } from './launcher-live-harness'
import { readRunEvents, runFiles, type RunStartEvent } from './runs'
import { RUNTIME_ROOT, runtimeAvailable } from './runtime-live-harness'

const DRIVER = String.raw`
import importlib.util, json, os, sys, types
repo, spec_raw, folder, commands, asks = sys.argv[1:6]
ns = types.ModuleType("hermes_plugins"); ns.__path__ = []; sys.modules["hermes_plugins"] = ns
d = os.path.join(repo, "plugins", "iclone-confinement")
spec = importlib.util.spec_from_file_location("hermes_plugins.iclone_confinement", os.path.join(d, "__init__.py"), submodule_search_locations=[d])
mod = importlib.util.module_from_spec(spec); sys.modules[spec.name] = mod; spec.loader.exec_module(mod)
from hermes_plugins.iclone_confinement import core
from hermes_plugins.iclone_confinement.seatbelt import SeatbeltEnvironment
# What the runtime asks for is the driver's: what the command gets is the launcher's answer alone.
core.grant_params = lambda session, project, window=None: json.loads(asks)
env = SeatbeltEnvironment(cwd=os.getcwd(), timeout=20, cls="project", index=core.parse_spec(spec_raw), task_id="modes-lab")
out = {}
for name, command in json.loads(commands).items():
    r = env.execute(command, cwd=folder)
    out[name] = {"code": r.get("returncode"), "out": r.get("output", "")[-1500:]}
print("MODES-JSON" + json.dumps(out), flush=True)
os._exit(0)
`

interface Answer {
  code: number
  out: string
}

const live = runtimeAvailable()

/** The consent record a user's answers leave: every switch answered, or none (null: never decided). */
const consent = (on: boolean | null): ConsentRecord | null =>
  on === null
    ? null
    : {
        schema: 1,
        policyVersion: 'live',
        policyEffective: 'live',
        acceptedAt: new Date().toISOString(),
        permissions: Object.fromEntries(CONSENT_CAPABILITY_KEYS.map(key => [key, on])) as ConsentRecord['permissions'],
        permissionsDecidedAt: new Date().toISOString(),
        skipped: false,
        aiProviderConsent: null
      }

// fx24 (r3-A): D6 rests on this file. A skip is rc 0, so on the Mac a tree with no venv link fails here, by name.
it.runIf(process.platform === 'darwin')('the modes at the launcher were proved on this tree (venv link and sandbox-exec present)', () => {
  expect(live).toBe(true)
})

describe.skipIf(!live)('the modes at the launcher, with the real sandbox (live, macOS Seatbelt)', () => {
  let world: LauncherWorld
  let driver: string
  let unlisted: string

  /** Main's own writer, with every switch on (the default), undecided (null) or off: the states a Mac can be in. */
  const publish = (standing: PermissionMode, on: boolean | null = true) =>
    world.layer.publishLauncherPolicy(
      buildPolicyBody({
        mode: { v: 1, standing, projects: {}, sessions: {}, updatedAt: new Date().toISOString() },
        grants: [],
        ceilings: ceilingsFrom(consent(on)),
        protectedPaths: [],
        secretPaths: [],
        guardPids: [],
        inftContracts: [],
        functions: { ...DEFAULT_FUNCTION_LEVELS },
        fnGrants: [],
        now: new Date()
      })
    )

  /** `asks`: what the request asks for; by default the most a runtime can ask, as a compromised one would. */
  const drive = (folder: string, commands: Record<string, string>, asks = { NET: '1', WRITE_PROJECT: '1' }) =>
    new Promise<Record<string, Answer>>((resolve, reject) => {
      const launch = world.launch(
        ['-s', '-P', driver, RUNTIME_ROOT, world.layer.spawnEnv().ICLONE_CONFINEMENT_SPEC, folder, JSON.stringify(commands), JSON.stringify(asks)],
        true
      )

      const child = spawn(launch.command, launch.args, { cwd: world.project, env: world.env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const killer = setTimeout(() => child.kill('SIGKILL'), 60_000)

      child.stdout.on('data', chunk => (stdout += String(chunk)))
      child.stderr.on('data', chunk => (stderr += String(chunk)))
      child.on('close', code => {
        clearTimeout(killer)

        const at = stdout.indexOf('MODES-JSON')

        if (at < 0) {
          reject(new Error(`the driver ended (exit ${code})\n${stdout.slice(-800)}\n${stderr.slice(-1600)}\n${world.logs.join('\n')}`))
        } else {
          resolve(JSON.parse(stdout.slice(at + 'MODES-JSON'.length).split('\n')[0]) as Record<string, Answer>)
        }
      })
    })

  const startOf = (command: string) =>
    readRunEvents(runFiles(world.userDataDir)).find(
      (event): event is RunStartEvent => event.ev === 'start' && event.command === command
    )

  // The machine's own addresses are loopback to Seatbelt, shut with or without a grant: a public resolver, as seatbelt.live.
  const reach = (tag: string) => `/usr/bin/nc -zv -G 2 1.1.1.1 53 # ${tag}`

  beforeAll(async () => {
    world = await createLauncherWorld()
    driver = path.join(world.project, 'driver.py')
    writeFileSync(driver, DRIVER)
    unlisted = path.join(world.root, 'unlisted')
    mkdirSync(unlisted)
    writeFileSync(path.join(unlisted, 'README.md'), 'not listed\n')
    world.layer.noteProject(world.project)
  }, 60_000)

  afterAll(async () => {
    await world?.dispose()
  })

  it('fx24: a runtime spawned on another project moves the roots the launcher judges, with the launcher left up', async () => {
    publish('plan')

    const roots = () =>
      (JSON.parse(readFileSync(path.join(world.userDataDir, 'confinement', 'ledger', 'policy.json'), 'utf8')) as { roots: { reads: string[] } }).roots.reads

    await world.layer.ensureLauncher(RUNTIME_ROOT, world.facts)
    expect(roots()).toContain(realpathSync(world.project))
    expect(roots()).not.toContain(realpathSync(unlisted))

    await world.layer.ensureLauncher(RUNTIME_ROOT, { ...world.facts, project: realpathSync(unlisted) })
    expect(roots()).toContain(realpathSync(unlisted))
    expect(roots()).not.toContain(realpathSync(world.project))

    await world.layer.ensureLauncher(RUNTIME_ROOT, world.facts)
  }, 60_000)

  it('Plan: a command reads, and cannot write the project or reach the network', async () => {
    publish('plan')

    const said = await drive(world.project, { read: 'cat README.md', write: 'echo p > plan.txt', reach: reach('plan') }, { NET: '0', WRITE_PROJECT: '0' })

    expect(said.read).toMatchObject({ code: 0 })
    expect(said.read.out).toContain('inside')
    expect(said.write.code).not.toBe(0)
    expect(said.write.out).toMatch(/Operation not permitted/)
    expect(existsSync(path.join(world.project, 'plan.txt'))).toBe(false)
    expect(said.reach.code).not.toBe(0)
    expect(said.reach.out).toMatch(/Operation not permitted/)
    expect(startOf('echo p > plan.txt')).toMatchObject({ write: false, net: false })
  }, 90_000)

  it('Plan: a request that asks to write anyway is refused for that reason, and nothing starts', async () => {
    publish('plan')

    const said = await drive(world.project, { write: 'echo q > plan2.txt' })

    expect(said.write.code).toBe(126)
    expect(said.write.out).toContain('no mode set on this Mac allows project writes (every mode set on this Mac is Plan)')
    expect(existsSync(path.join(world.project, 'plan2.txt'))).toBe(false)
    expect(startOf('echo q > plan2.txt')).toBeUndefined()
  }, 90_000)

  it('Plan: a request that asks only for the network does not reach it', async () => {
    publish('plan')

    const said = await drive(world.project, { reach: reach('plan-net') }, { NET: '1', WRITE_PROJECT: '0' })

    expect(said.reach.code).toBe(126)
    expect(said.reach.out).toContain('no mode set on this Mac allows it (every mode set on this Mac is Plan)')
    expect(startOf(reach('plan-net'))).toBeUndefined()
  }, 90_000)

  it('Automatic, a listed folder: writes it with no pass, and has the network', async () => {
    publish('automatic')

    const said = await drive(world.project, { write: 'echo a > auto.txt', reach: reach('auto') })

    expect(said.write).toMatchObject({ code: 0 })
    expect(existsSync(path.join(world.project, 'auto.txt'))).toBe(true)
    expect(said.write.out).not.toMatch(/icloneOS:/)
    expect(startOf('echo a > auto.txt')).toMatchObject({ write: true })
    expect(startOf('echo a > auto.txt')?.narrowed).toBeUndefined()
    // The control that gives Plan's refusal its meaning: the same probe is not refused where the mode allows it. It may
    // connect or find no route, so it does not need the internet to hold.
    expect(said.reach.out).not.toMatch(/Operation not permitted/)
    expect(startOf(reach('auto'))).toMatchObject({ net: true })
  }, 90_000)

  it('Automatic, an unlisted folder: narrowed, EPERM on the write, and the true line', async () => {
    publish('automatic')

    const said = await drive(unlisted, { read: 'cat README.md', write: 'echo u > un.txt' })

    expect(said.read).toMatchObject({ code: 0 })
    expect(said.read.out).toContain('not listed')
    expect(said.write.code).not.toBe(0)
    expect(said.write.out).toMatch(/Operation not permitted/)
    expect(said.write.out).toContain(`no project writes because ${unlisted} is not a folder the app has open or you named`)
    expect(existsSync(path.join(unlisted, 'un.txt'))).toBe(false)
    expect(startOf('echo u > un.txt')).toMatchObject({ write: false, narrowed: true, narrowedWhy: 'unlisted-folder' })
  }, 90_000)

  it('Manual with no pass: narrowed, EPERM on the write, and the true line', async () => {
    publish('manual')

    const said = await drive(world.project, { write: 'echo m > man.txt' })

    expect(said.write.code).not.toBe(0)
    expect(said.write.out).toMatch(/Operation not permitted/)
    expect(said.write.out).toContain('no mode set on this Mac allows them without asking')
    expect(existsSync(path.join(world.project, 'man.txt'))).toBe(false)
    expect(startOf('echo m > man.txt')).toMatchObject({ write: false, narrowed: true, narrowedWhy: 'needs-allow' })
  }, 90_000)

  it('File writing undecided: Automatic in a listed folder writes nothing, and is told the switch, not the mode', async () => {
    publish('automatic', null)

    const said = await drive(world.project, { write: 'echo d > und.txt' })

    expect(said.write.code).not.toBe(0)
    expect(said.write.out).toMatch(/Operation not permitted/)
    expect(said.write.out).toContain('File writing is undecided in Settings')
    expect(said.write.out).toContain('Turn File writing on in Settings')
    expect(said.write.out).not.toContain('set a mode that allows')
    expect(said.write.out).not.toContain('no mode set on this Mac')
    expect(existsSync(path.join(world.project, 'und.txt'))).toBe(false)
    expect(startOf('echo d > und.txt')).toMatchObject({ write: false, narrowed: true, narrowedWhy: 'needs-file-writing' })
  }, 90_000)

  it('Web browsing undecided: Automatic has no network, and is told the switch', async () => {
    publish('automatic', null)

    const said = await drive(world.project, { reach: reach('und') }, { NET: '1', WRITE_PROJECT: '0' })

    expect(said.reach.out).toMatch(/Operation not permitted/)
    expect(said.reach.out).toContain('Web browsing & network calls is undecided in Settings')
    expect(startOf(reach('und'))).toMatchObject({ net: false, narrowed: true, narrowedWhy: 'needs-web-browsing' })
  }, 90_000)

  it('every switch undecided: Manual still asks, and its line stays true', async () => {
    publish('manual', null)

    const said = await drive(world.project, { write: 'echo m > undman.txt' })

    expect(said.write.out).toContain('no mode set on this Mac allows them without asking')
    expect(existsSync(path.join(world.project, 'undman.txt'))).toBe(false)
  }, 90_000)

  it.each(['automatic', 'manual'] as const)('every switch off: %s writes nothing, and the refusal names the switch', async standing => {
    publish(standing, false)

    const said = await drive(world.project, { write: `echo o > off-${standing}.txt` })

    expect(said.write.code).toBe(126)
    expect(said.write.out).toContain('the File writing switch is off in Settings')
    expect(existsSync(path.join(world.project, `off-${standing}.txt`))).toBe(false)
  }, 90_000)

  it.each([
    ['undecided', null],
    ['off', false]
  ] as const)('switches %s: Plan reads, and neither writes nor reaches the network', async (_name, on) => {
    publish('plan', on)

    const said = await drive(world.project, { read: 'cat README.md', write: `echo p > plan-${_name}.txt`, reach: reach(`plan-${_name}`) }, { NET: '0', WRITE_PROJECT: '0' })

    expect(said.read).toMatchObject({ code: 0 })
    expect(said.write.out).toMatch(/Operation not permitted/)
    expect(existsSync(path.join(world.project, `plan-${_name}.txt`))).toBe(false)
    expect(said.reach.out).toMatch(/Operation not permitted/)
  }, 90_000)
})
