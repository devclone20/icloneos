/** fx29 (lead's rulings 1 and 2): the kernel owns a folder's identity. Through the real plugin (SeatbeltEnvironment,
 *  its request_project), the real runtime profile and the real launcher: a workdir in another case, NFC for a folder
 *  Foundation wrote NFD, a sub-folder of a listed repository in another case and the repository in another case all run
 *  and write where the listing permits, in the kernel's spelling, the project narrowed to the listed folder that holds
 *  them (a git commit in the sub-folder lands); a link, inside the repository too, is refused with the folder to give
 *  (code cwd-spelling, never bad-request); a never-list spelling stays refused. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { CONSENT_CAPABILITY_KEYS, type ConsentRecord } from '../iclone-consent'
import { ceilingsFrom } from '../iclone-permissions/classify-policy'
import { DEFAULT_FUNCTION_LEVELS } from '../iclone-permissions/functions'
import { CLICK, type LaunchedMain, launchMain } from '../iclone-permissions/ipc.test-helpers'
import { buildPolicyBody } from '../iclone-permissions/policy-file'

import { createLauncherWorld, type LauncherWorld } from './launcher-live-harness'
import type { LauncherPolicyBody } from './launcher-policy'
import { readRunEvents, runFiles } from './runs'
import { RUNTIME_ROOT, runtimeAvailable } from './runtime-live-harness'

vi.mock('./index', async importOriginal => ({
  ...(await importOriginal<object>()),
  currentConfinement: () => ({ publishLauncherPolicy: (_body: LauncherPolicyBody) => undefined })
}))

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
env = SeatbeltEnvironment(cwd=project, timeout=20, cls="project", index=core.parse_spec(spec_raw), task_id="fx29")
rows = []
for cmd, cwd in json.loads(cmds):
    r = env.execute(cmd, cwd=cwd)
    rows.append({"code": r.get("returncode"), "out": r.get("output", "")[-500:]})
print("FX29-JSON" + json.dumps(rows), flush=True)
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

describe.skipIf(!runtimeAvailable())('the working folder in another spelling, under the runtime profile (live)', () => {
  let world: LauncherWorld
  let main: LaunchedMain
  afterAll(async () => {
    await world?.dispose()
  })

  it('runs in the kernel spelling, narrowed to the listed folder that holds it; a link is refused with the folder to give', async () => {
    world = await createLauncherWorld()
    const work = path.join(world.home, 'work')
    const p1 = path.join(work, 'p1')
    const nfd = 'Ação'.normalize('NFD')
    const nfc = 'Ação'.normalize('NFC')
    mkdirSync(`${p1}/sub/deep`, { recursive: true })
    mkdirSync(`${p1}/${nfd}`, { recursive: true })
    mkdirSync(path.join(world.home, 'Library'), { recursive: true })
    execFileSync('git', ['init', '-q', p1])
    symlinkSync(`${p1}/sub`, `${p1}/linkin`)
    const mainDir = path.join(world.root, 'mainud')
    mkdirSync(path.join(mainDir, 'home'), { recursive: true })
    mkdirSync(path.join(mainDir, 'ud'), { recursive: true })
    const bodies: LauncherPolicyBody[] = []
    let answer: string[] = []
    main = launchMain(mainDir, bodies, () => answer)
    answer = [p1]
    expect(await main.invoke('hermes:confinement:pick-project-folder', { gesture: CLICK })).toMatchObject({ path: p1, listed: true })
    world.layer.publishLauncherPolicy(
      buildPolicyBody({
        mode: { v: 1, standing: 'automatic', projects: {}, sessions: {}, updatedAt: new Date().toISOString() },
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
    const driver = path.join(world.project, 'fx29driver.py')
    writeFileSync(driver, DRIVER)
    const git = 'git -c user.name=fx29 -c user.email=fx29@test.invalid'

    const cmds: [string, string][] = [
      ['pwd; echo one > f1.txt; echo rc=$?', `${p1}/SUB`],
      ['pwd; echo two > f2.txt; echo rc=$?', path.join(work, 'P1')],
      ['pwd; echo three > f3.txt; echo rc=$?', `${p1}/${nfc}`],
      ['pwd; echo four > f4.txt; echo rc=$?', `${p1}/sub/DEEP`],
      [`${git} add -A && ${git} commit -q -m fx29 && git log --oneline | wc -l`, `${p1}/sub`],
      ['pwd', `${p1}/linkin`],
      ['pwd', path.join(world.home, 'LIBRARY')]
    ]

    const output = await world.run(['-s', '-P', driver, RUNTIME_ROOT, world.layer.spawnEnv().ICLONE_CONFINEMENT_SPEC, p1, JSON.stringify(cmds)], {
      confined: true,
      timeoutMs: 120_000
    })

    const line = output.out.split('\n').find(row => row.startsWith('FX29-JSON'))

    if (!line) {
      throw new Error(`driver: ${output.code} ${output.err.slice(-800)} ${output.out.slice(-300)}`)
    }

    const rows = JSON.parse(line.slice(9)) as { code: number; out: string }[]
    const events = readRunEvents(runFiles(world.userDataDir))
    const starts = events.flatMap(event => (event.ev === 'start' ? [event] : []))
    const refused = events.flatMap(event => (event.ev === 'refused' ? [event] : []))

    // 1-4: run and write in the kernel's spelling; each a project write in p1, the listed folder that holds the workdir.
    for (const [index, file] of [`${p1}/sub/f1.txt`, `${p1}/f2.txt`, `${p1}/${nfd}/f3.txt`, `${p1}/sub/deep/f4.txt`].entries()) {
      expect(rows[index], `row ${index}: ${rows[index]?.out}`).toMatchObject({ code: 0 })
      expect(rows[index]?.out).toContain('rc=0')
      expect(existsSync(file), file).toBe(true)
    }

    // The shell's own pwd prints the text the wrapper cd-ed with; the folder each ran in, the journal's cwd below, is the kernel's.
    const same = (text: string | undefined) => (text ?? '').normalize('NFC').toLowerCase()

    expect(same(rows[0]?.out)).toContain(same(`${p1}/sub\n`))
    expect(same(rows[1]?.out)).toContain(same(`${p1}\n`))
    expect(same(rows[2]?.out)).toContain(same(`${p1}/${nfc}\n`))
    const written = starts.filter(start => start.command.includes('> f'))

    expect(written.map(start => [start.cwd, start.project, start.write, start.narrowed ?? false])).toEqual([
      [`${p1}/sub`, p1, true, false],
      [p1, p1, true, false],
      [`${p1}/${nfd}`, p1, true, false],
      [`${p1}/sub/deep`, p1, true, false]
    ])
    // 5: a git commit from the sub-folder of the listed repository.
    expect(rows[4], rows[4]?.out).toMatchObject({ code: 0 })
    expect(rows[4]?.out.trim().endsWith('1')).toBe(true)
    expect(existsSync(`${p1}/.git/refs/heads`)).toBe(true)
    expect(readFileSync(`${p1}/.git/HEAD`, 'utf8')).toContain('ref: refs/heads/')
    // 6: a link inside the repository: refused as a link, with the folder to give, never as malformed.
    expect(rows[5]).toMatchObject({ code: 126 })
    expect(rows[5]?.out).toContain(`Give ${p1}/sub itself as the working folder`)
    const link = refused.find(event => typeof event.detail === 'string' && event.detail.includes(`${p1}/linkin`))

    expect(link).toMatchObject({ code: 'cwd-spelling' })
    expect(link?.detail).toContain(`${p1}/sub`)
    expect(link?.detail).not.toContain('malformed')
    // 7: a never-list folder in another case is still no folder a confined command enters.
    expect(rows[6]).toMatchObject({ code: 126 })
    expect(starts.some(start => typeof start.cwd === 'string' && start.cwd.toLowerCase().endsWith('/library'))).toBe(false)
  })
})
