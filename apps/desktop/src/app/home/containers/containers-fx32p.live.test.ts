/** fx32p: what rehearsal critic B ran, through the real plugin, the real runtime profile, the real launcher and main's
 *  real handlers: a repository sub-folder opened with Open folder (both listed) has git; an allowed ask in a sub-folder
 *  of a repository runs under the root its sheet named, and git works; a timeout's row says what stopped it; a working
 *  folder that is gone is said as gone, with the path, to the agent and in the journal. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { createLauncherWorld, type LauncherWorld } from '../../../../electron/iclone-confinement/launcher-live-harness'
import type { LauncherPolicyBody } from '../../../../electron/iclone-confinement/launcher-policy'
import { foldAllRuns, readRunEvents, runFiles } from '../../../../electron/iclone-confinement/runs'
import { RUNTIME_ROOT, runtimeAvailable } from '../../../../electron/iclone-confinement/runtime-live-harness'
import { CONSENT_CAPABILITY_KEYS, type ConsentRecord } from '../../../../electron/iclone-consent'
import { ceilingsFrom } from '../../../../electron/iclone-permissions/classify-policy'
import { DEFAULT_FUNCTION_LEVELS } from '../../../../electron/iclone-permissions/functions'
import { askedFolder } from '../../../../electron/iclone-permissions/ipc'
import { CLICK, type LaunchedMain, launchMain } from '../../../../electron/iclone-permissions/ipc.test-helpers'
import { buildPolicyBody } from '../../../../electron/iclone-permissions/policy-file'

import { CONFINEMENT_COPY } from './containers-copy'
import { failedMeaning } from './containers-data'

vi.mock('../../../../electron/iclone-confinement/index', async importOriginal => ({
  ...(await importOriginal<object>()),
  currentConfinement: () => ({ publishLauncherPolicy: (_body: LauncherPolicyBody) => undefined })
}))

const L = CONFINEMENT_COPY.en.ledger

const DRIVER = String.raw`
import importlib.util, json, os, sys, types
repo, spec_raw, project, cmds = sys.argv[1:5]
ns = types.ModuleType("hermes_plugins"); ns.__path__ = []; sys.modules["hermes_plugins"] = ns
d = os.path.join(repo, "plugins", "iclone-confinement")
spec = importlib.util.spec_from_file_location("hermes_plugins.iclone_confinement", os.path.join(d, "__init__.py"), submodule_search_locations=[d])
mod = importlib.util.module_from_spec(spec); sys.modules[spec.name] = mod; spec.loader.exec_module(mod)
from hermes_plugins.iclone_confinement import core
from hermes_plugins.iclone_confinement.seatbelt import SeatbeltEnvironment
core.grant_params = lambda session, project, window=None: {"NET": "0", "WRITE_PROJECT": "1"}
env = SeatbeltEnvironment(cwd=project, timeout=20, cls="project", index=core.parse_spec(spec_raw), task_id="fx32p")
rows = []
for cmd, cwd, timeout in json.loads(cmds):
    r = env.execute(cmd, cwd=cwd, timeout=timeout)
    rows.append({"code": r.get("returncode"), "out": r.get("output", "")[-700:]})
print("FX32P-JSON" + json.dumps(rows), flush=True)
`

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

const GIT = 'git -c user.name=fx32p -c user.email=fx32p@test.invalid'
const COMMIT = `${GIT} status --short > /dev/null && echo status=$? && ${GIT} add -A && ${GIT} commit -q -m fx32p && git log --oneline | wc -l`

describe.skipIf(!runtimeAvailable())('rehearsal B, closed, under the runtime profile (live)', () => {
  let world: LauncherWorld
  let main: LaunchedMain
  let answer: string[] = []
  const bodies: LauncherPolicyBody[] = []

  afterAll(async () => {
    await world?.dispose()
  })

  const publish = (standing: 'automatic' | 'manual') =>
    world.layer.publishLauncherPolicy(
      buildPolicyBody({
        mode: { v: 1, standing, projects: {}, sessions: {}, updatedAt: new Date().toISOString() },
        folders: main.authority.state().mode.folders ?? [],
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

  const drive = async (project: string, cmds: [string, string, number][]) => {
    const driver = path.join(world.project, 'fx32pdriver.py')

    writeFileSync(driver, DRIVER)

    const output = await world.run(['-s', '-P', driver, RUNTIME_ROOT, world.layer.spawnEnv().ICLONE_CONFINEMENT_SPEC, project, JSON.stringify(cmds)], {
      confined: true,
      timeoutMs: 120_000
    })

    const line = output.out.split('\n').find(row => row.startsWith('FX32P-JSON'))

    if (!line) {
      throw new Error(`driver: ${output.code} ${output.err.slice(-800)} ${output.out.slice(-300)}`)
    }

    return JSON.parse(line.slice('FX32P-JSON'.length)) as { code: number; out: string }[]
  }

  const events = () => readRunEvents(runFiles(world.userDataDir))
  const views = () => foldAllRuns({ nowMs: Date.now(), events: events(), rows: [], verified: true, refusals: new Map() })
  const startOf = (marker: string) => events().flatMap(event => (event.ev === 'start' ? [event] : [])).find(start => start.command.includes(marker))

  const repository = (name: string) => {
    const root = path.join(main.home, 'work', name)

    mkdirSync(path.join(root, 'sub', 'deep'), { recursive: true })
    execFileSync('git', ['init', '-q', root])

    return root
  }

  it('Open folder on a sub-folder lists the root too, and git status, add and commit all work from the sub-folder', async () => {
    world = await createLauncherWorld()
    const mainDir = path.join(world.root, 'mainud')

    mkdirSync(path.join(mainDir, 'ud'), { recursive: true })
    mkdirSync(path.join(world.home, 'work'), { recursive: true })
    main = launchMain(mainDir, bodies, () => answer, undefined, world.home)
    const root = repository('r1')

    answer = [`${root}/sub`]
    expect(await main.invoke('hermes:confinement:pick-project-folder', { gesture: CLICK })).toMatchObject({ listed: true })
    expect(main.authority.state().mode.folders).toEqual(expect.arrayContaining([`${root}/sub`, root]))
    publish('automatic')

    const rows = await drive(world.project, [
      [`echo marker-sub > a.txt && ${COMMIT}`, `${root}/sub`, 20],
      [`echo marker-deep > b.txt && ${GIT} add -A && ${GIT} commit -q -m deep && git log --oneline | wc -l`, `${root}/sub/deep`, 20]
    ])

    expect(rows[0], rows[0]?.out).toMatchObject({ code: 0 })
    expect(rows[0]?.out).toContain('status=0')
    expect(rows[0]?.out.trim().endsWith('1')).toBe(true)
    expect(rows[1], rows[1]?.out).toMatchObject({ code: 0 })
    expect(rows[1]?.out.trim().endsWith('2')).toBe(true)
    expect(existsSync(`${root}/sub/a.txt`)).toBe(true)
    expect(startOf('marker-sub')).toMatchObject({ cwd: `${root}/sub`, project: root, write: true })
    expect(startOf('marker-deep')).toMatchObject({ cwd: `${root}/sub/deep`, project: root, write: true })
  }, 150_000)

  it('a repository sub-folder and its root listed apart: a nested repository in the sub-folder stays its own project', async () => {
    const root = repository('r3')

    execFileSync('git', ['init', '-q', `${root}/sub`])
    answer = [`${root}/sub`]
    expect(await main.invoke('hermes:confinement:pick-project-folder', { gesture: CLICK })).toMatchObject({ listed: true })
    expect(await main.invoke('hermes:confinement:allow-folder', { folder: root, gesture: CLICK })).toMatchObject({ ok: true })
    publish('automatic')
    await drive(world.project, [['echo marker-nested > n.txt', `${root}/sub`, 20]])
    expect(startOf('marker-nested')).toMatchObject({ project: `${root}/sub`, write: true })
  }, 150_000)

  it('an allowed ask in a sub-folder: the sheet names the root, its pass lists it, and git works from the sub-folder', async () => {
    const root = repository('r2')
    const asked = askedFolder(`${root}/sub`, { home: main.home, userDataDir: main.userDataDir })

    expect(asked?.project).toBe(root)
    publish('manual')
    world.layer.passFolder({ project: asked?.project ?? null, cls: 'X', scope: 'once', shown: true, grantId: null })
    const rows = await drive(world.project, [[`echo marker-ask > a.txt && ${COMMIT}`, `${root}/sub`, 20]])

    expect(rows[0], rows[0]?.out).toMatchObject({ code: 0 })
    expect(rows[0]?.out.trim().endsWith('1')).toBe(true)
    expect(startOf('marker-ask')).toMatchObject({ project: root, write: true })
    expect(main.authority.state().mode.folders).not.toContain(root)
  }, 150_000)

  it('a timeout reads as the runtime stopping it; a folder that is gone is said as gone, with the path', async () => {
    publish('automatic')
    const gone = path.join(main.home, 'work', 'r1', 'gone')

    mkdirSync(gone, { recursive: true })
    rmdirSync(gone)
    const rows = await drive(world.project, [
      ['sleep 30 # marker-timeout', world.project, 2],
      ['pwd', gone, 20]
    ])

    expect(rows[0]).toMatchObject({ code: 124 })
    const timedOut = views().find(run => run.command.includes('marker-timeout'))

    expect(timedOut).toMatchObject({ phase: 'failed', signal: 15 })
    expect(timedOut && failedMeaning(L, timedOut)).toBe(
      "Ended by signal 15: the agent's runtime stops a command this way when it times out or is interrupted."
    )

    const refused = events().flatMap(event => (event.ev === 'refused' ? [event] : []))

    const said = `Its working folder ${gone} is not there any more, so it was not started. Move the folder back, or give a folder that exists.`

    expect(rows[1]).toMatchObject({ code: 126 })
    expect(rows[1]?.out).toContain(said)
    expect(refused.find(event => event.detail === said)).toMatchObject({ code: 'cwd-gone' })

    const row = views().find(run => run.refusedDetail?.includes(gone))

    expect(row?.refusedReason).toBe('cwd-gone')
    expect(L.refusedCode['cwd-gone']).toBe(
      'Its working folder is not there any more, so it was not started. Move the folder back, or give a folder that exists.'
    )
  }, 150_000)
})
