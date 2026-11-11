/**
 * R22 (R11's four spellings): the app's project as the exec copy gives it, raw, to the real plugin, the real runtime
 * profile and the real launcher. Another case and another Unicode form run in the kernel's spelling; a link and a folder
 * that is gone run nothing. The routed scope's read of the exec copy is test_r11 in test_iclone_confined_backend.py.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createLauncherWorld, type LauncherWorld } from './launcher-live-harness'
import { RUNTIME_ROOT, runtimeAvailable } from './runtime-live-harness'

const DRIVER = String.raw`
import importlib.util, json, os, sys, types
repo, spec_raw, marker = sys.argv[1:4]
ns = types.ModuleType("hermes_plugins"); ns.__path__ = []; sys.modules["hermes_plugins"] = ns
d = os.path.join(repo, "plugins", "iclone-confinement")
spec = importlib.util.spec_from_file_location("hermes_plugins.iclone_confinement", os.path.join(d, "__init__.py"), submodule_search_locations=[d])
mod = importlib.util.module_from_spec(spec); sys.modules[spec.name] = mod; spec.loader.exec_module(mod)
from hermes_cli.iclone_policy_env import confined_project
from hermes_plugins.iclone_confinement import core
from hermes_plugins.iclone_confinement.seatbelt import SeatbeltEnvironment
core.grant_params = lambda session, project, window=None: {"NET": "0", "WRITE_PROJECT": "1"}
out = {"exec_project": confined_project()}
try:
    env = SeatbeltEnvironment(cwd=out["exec_project"], timeout=20, cls="project", index=core.parse_spec(spec_raw), task_id="r22")
    r = env.execute("/usr/bin/touch " + marker + "; /bin/pwd -P")
    out.update(code=r.get("returncode"), out=r.get("output", "")[-600:])
except Exception as exc:
    out.update(code=-1, out=type(exc).__name__ + ": " + str(exc)[:400])
print("R22-JSON" + json.dumps(out), flush=True)
os._exit(0)
`

interface Answer {
  exec_project: string
  code: number
  out: string
}

describe.skipIf(!runtimeAvailable())('the app project in four spellings, real profile and launcher (live, macOS Seatbelt)', () => {
  let world: LauncherWorld
  let driver: string
  let listed: string

  const drive = (spelled: string, marker: string) =>
    new Promise<Answer>((resolve, reject) => {
      const launch = world.launch(['-s', '-P', driver, RUNTIME_ROOT, world.layer.spawnEnv().ICLONE_CONFINEMENT_SPEC, marker], true)
      const child = spawn(launch.command, launch.args, { cwd: world.project, env: { ...world.env, TERMINAL_CWD: spelled }, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      const killer = setTimeout(() => child.kill('SIGKILL'), 60_000)

      child.stdout.on('data', chunk => (out += String(chunk)))
      child.stderr.on('data', chunk => (err += String(chunk)))
      child.on('close', code => {
        clearTimeout(killer)
        const at = out.indexOf('R22-JSON')

        if (at < 0) {
          reject(new Error(`driver ended (${code})\n${err.slice(-1200)}`))
        } else {
          resolve(JSON.parse(out.slice(at + 'R22-JSON'.length).split('\n')[0]) as Answer)
        }
      })
    })

  beforeAll(async () => {
    world = await createLauncherWorld()
    driver = path.join(world.project, 'r22-driver.py')
    writeFileSync(driver, DRIVER)
    // The runtime profile reads the project main spawned it with, so every spelling is of that folder or inside it.
    listed = path.join(world.project, 'Ação'.normalize('NFD'))
    mkdirSync(listed)
  }, 60_000)

  afterAll(async () => {
    await world?.dispose()
  })

  it('another Unicode form runs, and the kernel spelling is where the file lands', async () => {
    const seen = await drive(path.join(world.project, 'Ação'.normalize('NFC')), 'nfc.txt')

    expect(seen.code, seen.out).toBe(0)
    expect(existsSync(path.join(listed, 'nfc.txt'))).toBe(true)
  })

  it('another case runs, and the kernel spelling is where the file lands', async () => {
    const seen = await drive(path.join(world.root, 'PROJECT'), 'case.txt')

    expect(seen.code, seen.out).toBe(0)
    expect(existsSync(path.join(world.project, 'case.txt'))).toBe(true)
    expect(seen.out).toContain(realpathSync(world.project))
  })

  it('a link to the listed folder runs nothing', async () => {
    const link = path.join(world.root, 'link-to-listed')

    symlinkSync(world.project, link)
    const seen = await drive(link, 'link.txt')

    expect(seen.code, seen.out).not.toBe(0)
    expect(existsSync(path.join(world.project, 'link.txt'))).toBe(false)
  })

  it('a folder that is gone runs nothing', async () => {
    const gone = path.join(world.root, 'gone')

    mkdirSync(gone)
    rmSync(gone, { recursive: true })
    const seen = await drive(gone, 'gone.txt')

    expect(seen.code, seen.out).not.toBe(0)
    expect(existsSync(path.join(listed, 'gone.txt'))).toBe(false)
    expect(existsSync(path.join(world.project, 'gone.txt'))).toBe(false)
  })
})
