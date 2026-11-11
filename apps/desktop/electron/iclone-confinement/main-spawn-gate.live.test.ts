/**
 * fx39: the permission gate through the spawn the app really makes. Every other live test starts the runtime with an env
 * of its own, so the gate loads from the repository's plugins/. A dev app does not: `prepareHermesSpawn` runs the gate
 * from the app's own overlay and names that folder in HERMES_BUNDLED_PLUGINS, and there every tool was refused.
 *
 * Real here: prepareHermesSpawn (the overlay, the armed probe, the signed policy, the key pipe, the seal, the runtime
 * profile and its launcher), main's authority and socket, the runtime's own discovery and tool dispatch. Standing in:
 * Electron's `app` and the constants of main/env, which only say where the app's folders are, and the owner's click.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { startAcpSocketServer } from '../iclone-acp-ipc'
import { registerPermissions } from '../iclone-permissions/ipc'
import { prepareHermesSpawn } from '../main/iclone-gate'

import { registerConfinement, stopConfinement } from './ipc'
import { writeInstallerConfig } from './live-guards'
import { RUNTIME_PYTHON, RUNTIME_ROOT, runtimeAvailable } from './runtime-live-harness'

const world = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const nodePath = await import('node:path')
  const root = fs.realpathSync(fs.mkdtempSync('/private/tmp/iclone-mainspawn-'))
  const home = nodePath.join(root, 'home')

  return {
    root,
    home,
    hermesHome: nodePath.join(home, '.hermes'),
    userData: nodePath.join(root, 'ud'),
    project: nodePath.join(root, 'project'),
    logs: [] as string[]
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => world.userData, getVersion: () => '0.0.6', isPackaged: false }
}))

vi.mock('../main/env', () => {
  const repo = nodePathResolve()

  return {
    ACTIVE_HERMES_ROOT: repo,
    HERMES_HOME: world.hermesHome,
    IS_PACKAGED: false,
    SOURCE_REPO_ROOT: repo,
    isHermesSourceRoot: () => true
  }

  function nodePathResolve(): string {
    return new URL('../../../..', import.meta.url).pathname.replace(/\/$/, '')
  }
})

vi.mock('../main/log', () => ({ rememberLog: (line: string) => world.logs.push(line) }))

const DRIVER = String.raw`
import json, os, sys, time
plan = json.loads(sys.argv[1])
sys.argv = ["hermes"]
import hermes_cli.main  # the module body: load_hermes_dotenv and its config bridge
from hermes_cli.config import apply_terminal_config_to_env
apply_terminal_config_to_env()
from hermes_cli.plugins import discover_plugins
discover_plugins()
import model_tools

def call(tool, args):
    raw = model_tools.handle_function_call(tool, args, task_id=plan["scenario"], enabled_tools=["terminal", "read_file"])
    return json.loads(raw) if isinstance(raw, str) else raw

def asked(tool, args):  # the gate says the owner has the sheet and to retry this same call: what a model does
    for _ in range(12):
        answer = call(tool, args)
        if "Waiting for the owner" not in json.dumps(answer):
            return answer
        time.sleep(1)
    return answer

gate = sys.modules["hermes_plugins.iclone_permissions"]
report = {
    "gateFile": os.path.realpath(gate.__file__),
    "holds": sorted(k for k in gate._state if k in ("channel", "policy")),
    "usable": bool(gate._state["channel"].usable) if "channel" in gate._state else None,
    "read": call("read_file", {"path": plan["inside"]}),
    "terminal": asked("terminal", {"command": "echo honest-" + plan["marker"] + " && touch " + plan["ran"]}),
}
print("FX39-JSON" + json.dumps(report), flush=True)
`

interface Report {
  gateFile: string
  holds: string[]
  usable: boolean | null
  read: { content?: string; error?: string }
  terminal: { exit_code?: number; output?: string; error?: string }
}

describe.runIf(runtimeAvailable())('the gate through the spawn main really makes (fx39)', () => {
  let click: 'deny' | 'once' = 'once'
  let sheets = 0
  const marker = `${process.pid}-${Date.now()}`

  beforeAll(() => {
    vi.stubEnv('HOME', world.home)
    vi.stubEnv('CFFIXED_USER_HOME', world.home)

    for (const dir of [world.home, world.hermesHome, world.userData, world.project]) {
      mkdirSync(dir, { recursive: true })
    }

    writeInstallerConfig(world.hermesHome)
    writeFileSync(path.join(world.project, 'note.txt'), 'inside\n')
    writeFileSync(path.join(world.project, 'driver.py'), DRIVER)

    registerPermissions({
      ipcMain: { handle: () => undefined },
      isTrustedSender: () => true,
      userDataDir: world.userData,
      paths: { hermesHome: world.hermesHome, home: world.home, hermesRoot: null },
      door: {
        askPermissionShown: async () => {
          sheets += 1

          return { outcome: click, shown: true }
        }
      },
      consent: () => null,
      lastInputAt: () => Date.now(),
      sealer: null,
      confirmIgnore: async () => false,
      pickFolderDialog: async () => []
    } as never)

    // The deps main.ts passes, with the seams it leaves to the real thing left real.
    registerConfinement({
      ipcMain: { handle: () => undefined },
      isTrustedSender: () => true,
      userDataDir: world.userData,
      home: world.home,
      hermesHome: world.hermesHome,
      hermesRoot: RUNTIME_ROOT,
      memberPython: RUNTIME_PYTHON,
      keyStore: null,
      lastInputAt: () => Date.now(),
      hermesPids: () => [],
      broadcast: () => undefined
    } as never)
  }, 60_000)

  afterAll(() => {
    stopConfinement()
    vi.unstubAllEnvs()
    rmSync(world.root, { force: true, recursive: true })
  })

  const drive = async (scenario: string, ran: string, cwd = world.project, folder = world.project) => {
    const server = await startAcpSocketServer({
      dir: path.join(world.userData, 'run'),
      resolveInft: () => ({ ok: false }),
      admitStreaming: () => false,
      run: async () => ({ code: 1 }),
      log: () => undefined
    } as never)

    try {
      const backend = { command: RUNTIME_PYTHON, root: RUNTIME_ROOT, env: { PYTHONPATH: RUNTIME_ROOT } }
      const gated = await prepareHermesSpawn({ backend, cwd, profile: null, role: 'primary' })

      const plan = {
        scenario,
        marker,
        inside: path.join(folder, 'note.txt'),
        ran: path.join(world.project, ran)
      }

      const args = [path.join(folder, 'driver.py'), JSON.stringify(plan)]

      // As start-hermes.ts spawns it: the gate's command and argv, the sealed env, the gated stdio.
      const env = gated.seal({
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: world.home,
        LANG: 'en_US.UTF-8',
        HERMES_HOME: world.hermesHome,
        HERMES_DESKTOP: '1',
        TERMINAL_CWD: cwd,
        ...backend.env
      })

      const child = spawn(gated.command(backend.command), gated.argv(args, backend.command), {
        cwd,
        env,
        stdio: gated.stdio,
        detached: true
      })

      gated.attach(child as never)

      let out = ''
      let err = ''

      child.stdout?.on('data', chunk => (out += String(chunk)))
      child.stderr?.on('data', chunk => (err += String(chunk)))

      const timer = setTimeout(() => process.kill(-(child.pid ?? 0), 'SIGKILL'), 150_000)
      const code = await new Promise(resolve => child.once('close', resolve))

      clearTimeout(timer)

      const line = out.split('\n').find(part => part.startsWith('FX39-JSON'))

      if (!line) {
        throw new Error(`the driver ended (exit ${String(code)}) without a report\n${err.slice(-3000)}\n${out.slice(-800)}`)
      }

      return { report: JSON.parse(line.slice('FX39-JSON'.length)) as Report, env, overlay: gated.report.env.HERMES_BUNDLED_PLUGINS }
    } finally {
      await server.close()
    }
  }

  it('a dev app: the overlay copy holds the gate, reading runs, and a command runs on main\'s answer alone', async () => {
    const { report, env, overlay } = await drive('once', 'ran-once.txt')

    // The path this test exists for, or it proves nothing: main named the overlay, and the gate loaded from it, confined.
    expect(env.ICLONE_RUNTIME_CONFINED).toBe('1')
    expect(env.ICLONE_POLICY_LOCK).toBe('1')
    expect(overlay).toBe(path.join(realpathSync(world.userData), 'hermes-dev-plugins', 'plugins'))
    expect(env.HERMES_BUNDLED_PLUGINS).toBe(overlay)
    expect(report.gateFile).toBe(path.join(overlay as string, 'iclone-permissions', '__init__.py'))

    expect(report.holds).toEqual(['channel', 'policy'])
    expect(report.usable).toBe(true)
    expect(report.read.content, JSON.stringify(report.read)).toContain('inside')
    expect(report.terminal.exit_code, JSON.stringify(report.terminal)).toBe(0)
    expect(report.terminal.output).toContain(`honest-${marker}`)
    expect(existsSync(path.join(world.project, 'ran-once.txt'))).toBe(true)
    expect(sheets).toBeGreaterThan(0)
  }, 180_000)

  it('the same spawn with the owner saying no: nothing runs, so the fix decides nothing', async () => {
    click = 'deny'
    sheets = 0

    const { report } = await drive('deny', 'ran-deny.txt')

    expect(report.holds).toEqual(['channel', 'policy'])
    expect(sheets).toBeGreaterThan(0)
    expect(JSON.stringify(report.terminal)).toContain('BLOCKED by icloneOS permissions')
    expect(existsSync(path.join(world.project, 'ran-deny.txt'))).toBe(false)
    expect(report.read.content).toContain('inside')
  }, 180_000)

  it('no project chosen: main falls back to the home, which the runtime profile cannot read, and the runtime still starts', async () => {
    // resolveHermesCwd's last candidate. The driver sits where the profile reads, since a home cwd is no project.
    writeFileSync(path.join(world.hermesHome, 'note.txt'), 'inside\n')
    writeFileSync(path.join(world.hermesHome, 'driver.py'), DRIVER)

    const { report, env } = await drive('home', 'ran-home.txt', world.home, world.hermesHome)

    expect(env.ICLONE_RUNTIME_CONFINED).toBe('1')
    expect(env.TERMINAL_CWD).toBe(world.home)
    expect(report.holds).toEqual(['channel', 'policy'])
    expect(JSON.stringify(report)).not.toContain('internal error')
  }, 180_000)
})
