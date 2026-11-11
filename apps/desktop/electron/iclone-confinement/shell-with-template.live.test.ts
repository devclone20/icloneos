/**
 * FX35 — the gate for "with confinement on, the installer's template refuses every shell tool". A real command inside
 * the real runtime profile, through the launcher, from a process started the way main starts Hermes, with the REAL
 * template copied into a throwaway HOME: import main (its dotenv pass and config bridge), then plugin discovery, then
 * each tool through the real dispatcher with its hook. Every write outside the project has its unconfined control.
 * fx35b: rows (a)-(c) also read the tool list a model is offered; the docker row runs a real AIAgent with a stub model;
 * the locked row is main's real authority and socket, a real key pipe, the real lock, and no stub on the grant.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Writable } from 'node:stream'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startAcpSocketServer } from '../iclone-acp-ipc'
import { permissionsSpawn, registerPermissions } from '../iclone-permissions/ipc'

import { createLauncherWorld, type LauncherWorld } from './launcher-live-harness'
import { INSTALLER_TEMPLATE, writeInstallerConfig } from './live-guards'
import { runtimeAvailable } from './runtime-live-harness'

const SEATBELT = 'iclone_seatbelt'

const DRIVER = String.raw`
import json, os, sys, time
plan = json.loads(sys.argv[1])
sys.argv = ["hermes"] + plan.get("argv", [])
import hermes_cli.main  # the module body: load_hermes_dotenv and its config bridge
from hermes_cli.config import apply_terminal_config_to_env
apply_terminal_config_to_env()  # main.py's bridge just before discovery
from hermes_cli.plugins import discover_plugins
discover_plugins()
# Rows with no authority: the grant comes from the permissions plugin and main's policy, this world has no lock, and the
# launcher's copy of the policy still decides (publishLivePolicy). The locked row never takes this stub.
def grant():
    if plan.get("locked"):
        return
    for name, mod in list(sys.modules.items()):
        if name.startswith("hermes_plugins.iclone_confinement") and name.endswith(".core"):
            mod.grant_params = lambda session, project, window=None: {"NET": "0", "WRITE_PROJECT": "1"}
grant()
import model_tools
from tools.terminal_scope import get_terminal_scope

def call(tool, args, task):
    raw = model_tools.handle_function_call(tool, args, task_id=task, enabled_tools=["terminal", "read_file"])
    return json.loads(raw) if isinstance(raw, str) else raw

def tools(tag):
    project, outside, marker = plan["project"], plan["outside"], plan["marker"]
    task = plan["scenario"] + "-" + tag
    out = {}
    out["terminal"] = call("terminal", {"command": f"echo honest-{marker} && touch {project}/{task}-terminal.txt"}, task)
    out["terminalOutside"] = call("terminal", {"command": f"echo planted > {outside}/{task}-terminal.txt"}, task)
    started = call("terminal", {"command": f"echo bg-{marker}", "background": True}, task)
    out["background"] = started
    out["process"] = call("process_manage", {"action": "wait", "session_id": started.get("session_id", "none"), "timeout": 20}, task)
    # fx35e (R40, R41, R42): the whole path, terminal background=true and the process tool. The command hangs up itself
    # and its wrapper before it prints, so the line and the exit code say both lived; no timing decides it.
    hup = call("terminal", {"command": f"kill -HUP $PPID; kill -HUP $$; echo hup-{marker}", "background": True}, task)
    out["hangup"] = call("process_manage", {"action": "wait", "session_id": hup.get("session_id", "none"), "timeout": 20}, task)
    left = call("terminal", {"command": "sleep 300", "background": True}, task)
    out["polled"] = call("process_manage", {"action": "poll", "session_id": left.get("session_id", "none")}, task)
    out["killed"] = call("process_manage", {"action": "kill", "session_id": left.get("session_id", "none")}, task)
    out["afterKill"] = call("process_manage", {"action": "poll", "session_id": left.get("session_id", "none")}, task)
    written = call("terminal", {"command": f"nohup echo nohup-{marker}", "background": True}, task)
    out["nohupBackground"] = call("process_manage", {"action": "wait", "session_id": written.get("session_id", "none"), "timeout": 20}, task)
    out["nohupForeground"] = call("terminal", {"command": f"bash -c 'nohup echo nohup-{marker}'"}, task)
    out["executeCode"] = call("execute_code", {"code": f"print('code-{marker}')\nopen('{project}/{task}-code.txt', 'w').write('x')\ntry:\n    open('{outside}/{task}-code.txt', 'w').write('x')\n    print('code-wrote-outside')\nexcept OSError as exc:\n    print('code-refused', exc.errno)\n"}, task)
    out["readFile"] = call("read_file", {"path": f"{project}/README.md"}, task)
    out["readOutside"] = call("read_file", {"path": f"{outside}/secret.txt"}, task)
    out["env"] = os.environ.get("TERMINAL_ENV")
    out["offered"] = [t["function"]["name"] for t in model_tools.get_tool_definitions(enabled_toolsets=["hermes-cli"], quiet_mode=True)]
    # process_manage is in the catalog behind tool_search, not in the assembled list: the real, uncollapsed one.
    out["catalog"] = [t["function"]["name"] for t in model_tools.get_tool_definitions(enabled_toolsets=["hermes-cli"], quiet_mode=True, skip_tool_search_assembly=True)]
    return out

def honest(tag):
    task = plan["scenario"] + "-" + tag
    def asked():  # the gate says the owner has the sheet and to retry this same call: what a model does
        return call("terminal", {"command": f"touch {plan['project']}/{task}-terminal.txt"}, task)
    answer = asked()
    for _ in range(100):
        if "Waiting for the owner" not in json.dumps(answer):
            break
        time.sleep(0.2)
        answer = asked()
    return {"terminal": answer,
            "readFile": call("read_file", {"path": f"{plan['project']}/README.md"}, task)}

def gates():
    found = {n: m for n, m in sys.modules.items() if n.startswith("hermes_plugins.iclone_permissions") and n.count(".") == 1}
    channels = {id(m._state["channel"]) for m in found.values()}
    return {"copies": sorted(found), "channels": len(channels), "healthy": [m._state["channel"].healthy for m in found.values()]}

def stub_agent():
    from types import SimpleNamespace as NS
    from run_agent import AIAgent
    def reply(tool_calls, content):
        message = NS(role="assistant", content=content, tool_calls=tool_calls, reasoning=None, reasoning_content=None, refusal=None)
        return NS(id="stub", model="stub-model", usage=None, choices=[NS(index=0, finish_reason="tool_calls" if tool_calls else "stop", message=message)])
    call_it = NS(id="call_1", type="function", function=NS(name="terminal", arguments=json.dumps({"command": f"touch {plan['project']}/agent-ran.txt"})))
    replies = [reply([call_it], None), reply(None, "done")]
    agent = AIAgent(api_key="stub", base_url="http://127.0.0.1:9/v1", model="stub-model", quiet_mode=True, skip_memory=True, skip_context_files=True, enabled_toolsets=["hermes-cli"], max_iterations=3)
    agent._interruptible_api_call = lambda *a, **k: replies.pop(0)
    agent._interruptible_streaming_api_call = lambda *a, **k: replies.pop(0)
    done = agent.run_conversation("run it")
    return {"offered": sorted(agent.valid_tool_names), "tool": [m.get("content") for m in done["messages"] if m.get("role") == "tool"], "left": len(replies)}

def search_turn(task):
    """R42: a real AIAgent, a stub model: terminal background=true, then poll and kill through tool_search, the only way a
    model reaches process_manage."""
    from types import SimpleNamespace as NS
    from run_agent import AIAgent
    state = {"n": 0, "sid": None}
    def reply(name=None, args=None, content=None):
        calls = [NS(id=f"call_{state['n']}", type="function", function=NS(name=name, arguments=json.dumps(args)))] if name else None
        message = NS(role="assistant", content=content, tool_calls=calls, reasoning=None, reasoning_content=None, refusal=None)
        return NS(id="stub", model="stub-model", usage=None, choices=[NS(index=0, finish_reason="tool_calls" if calls else "stop", message=message)])
    def process(action):
        return reply("tool_call", {"calls": [{"name": "process_manage", "arguments": {"action": action, "session_id": state["sid"]}}]})
    def model(*a, **k):
        state["n"] += 1
        if state["n"] == 1:
            return reply("terminal", {"command": "sleep 300", "background": True})
        if state["n"] == 2:
            state["sid"] = json.loads([m for m in a[0]["messages"] if m.get("role") == "tool"][-1]["content"])["session_id"]
            return reply("tool_search", {"queries": ["process_manage"]})
        if state["n"] == 3:
            return process("poll")
        return process("kill") if state["n"] == 4 else reply(content="done")
    agent = AIAgent(api_key="stub", base_url="http://127.0.0.1:9/v1", model="stub-model", quiet_mode=True, skip_memory=True, skip_context_files=True, enabled_toolsets=["hermes-cli"], max_iterations=8)
    agent._interruptible_api_call = model
    agent._interruptible_streaming_api_call = model
    done = agent.run_conversation("run it", task_id=task)
    return {"tool": [str(m.get("content")) for m in done["messages"] if m.get("role") == "tool"], "steps": state["n"]}

report = {}
if plan.get("locked"):
    report["launch"] = honest("launch")
else:
    report["first"] = tools("first")
    if not plan.get("refused"):
        report["first"]["turn"] = search_turn(plan["scenario"] + "-turn")
    report["later"] = tools("later")  # the first tool ran the one-shot bridge: this one comes after it
if plan.get("refused"):
    from hermes_cli.iclone_policy_env import refused_backend
    from tools.bot_desktop import placement
    report["reason"] = refused_backend()
    report["placement"] = placement.resolve().backend
    report["agent"] = stub_agent()
if plan.get("routed"):
    from tui_gateway.launch_profile_policy import activate_multi_profile_hosting
    from tui_gateway.server import _session_profile_runtime_scope
    activate_multi_profile_hosting()
    report["routed"] = {}
    for name in plan["routed"]:
        with _session_profile_runtime_scope({"profile_home": os.path.join(os.environ["HERMES_HOME"], "profiles", name)}):
            scope = get_terminal_scope()
            discover_plugins()  # imported again for each home; each copy reads main's hand-over from the exec copy
            grant()
            seen = honest(name) if plan.get("locked") else tools(name)
            seen["scope"] = scope.get("TERMINAL_ENV") if scope is not None else None
            report["routed"][name] = seen
if plan.get("locked"):
    report["gates"] = gates()
print("FX35-JSON" + json.dumps(report), flush=True)
`

type Row = Record<string, unknown> & { output?: string; error?: string; content?: string; exit_code?: number; status?: string; tool?: string[]; steps?: number }
type Tools = Record<string, Row> & { env: unknown }

interface DriveReport {
  first: Tools
  later: Tools
  routed?: Record<string, Tools>
  reason?: string
  placement?: string
  agent?: { offered: string[]; tool: string[]; left: number }
}

describe.runIf(runtimeAvailable())('a clean install: the real template under the real runtime profile', () => {
  let lab: LauncherWorld
  const marker = `${process.pid}-${Date.now()}`

  beforeAll(async () => {
    lab = await createLauncherWorld()
  }, 120_000)

  afterAll(async () => {
    await lab.dispose()
  })

  /** G22 B1: this lab's runtimes, each in its own hermes-ack.<pid>.json beside the path main names. */
  const ackFiles = () => {
    const dir = path.dirname(lab.env.ICLONE_CONFINEMENT_ACK)

    return existsSync(dir) ? readdirSync(dir).filter(name => /^hermes-ack\.\d+\.json$/.test(name)).map(name => path.join(dir, name)) : []
  }

  const setHome = (config: string | 'template', env?: string) => {
    if (config === 'template') {
      writeInstallerConfig(lab.hermesHome)
    } else {
      writeFileSync(path.join(lab.hermesHome, 'config.yaml'), config)
    }

    if (env === undefined) {
      rmSync(path.join(lab.hermesHome, '.env'), { force: true })
    } else {
      writeFileSync(path.join(lab.hermesHome, '.env'), env)
    }

    for (const file of ackFiles()) {
      rmSync(file, { force: true })
    }
  }

  const profile = (name: string, config?: 'template') => {
    const home = path.join(lab.hermesHome, 'profiles', name)

    mkdirSync(home, { recursive: true })

    if (config === 'template') {
      writeInstallerConfig(home)
    }
  }

  const drive = async (scenario: string, extra: Record<string, unknown> = {}) => {
    const driver = path.join(lab.project, 'fx35-driver.py')

    writeFileSync(driver, DRIVER)

    const plan = { scenario, project: lab.project, outside: lab.outside, marker, ...extra }
    const run = await lab.run(['-s', '-P', driver, JSON.stringify(plan)], { confined: true, timeoutMs: 170_000 })
    const line = `${run.out}\n${run.err}`.split('\n').find(part => part.startsWith('FX35-JSON'))

    if (!line) {
      throw new Error(`the driver ended (exit ${run.code}) without a report\n${run.err.slice(-3000)}\n${run.out.slice(-800)}`)
    }

    return JSON.parse(line.slice('FX35-JSON'.length)) as DriveReport
  }

  const ack = () =>
    JSON.parse(readFileSync(ackFiles()[0] ?? lab.env.ICLONE_CONFINEMENT_ACK, 'utf8')) as {
      backend: string
      commands?: { available: boolean; reason: string }
    }

  /** What a model is offered, from the real tool list: the original symptom was a list without these. */
  const expectOffered = (offered: unknown, catalog?: unknown) => {
    for (const tool of ['terminal', 'execute_code', 'read_file']) {
      expect(offered, tool).toContain(tool)
    }

    if (catalog !== undefined) {
      expect(offered).toContain('tool_search')
      expect(catalog).toContain('process_manage')
    }
  }

  /** Terminal, process, execute_code and read_file ran, confined: the honest work happened, the kernel refused the rest. */
  const expectConfined = (seen: Tools, task: string) => {
    const said = JSON.stringify(seen)

    expect(said).not.toContain('Refused by icloneOS confinement')
    expect(said).not.toContain('refused to start a program')
    expect(seen.terminal.output, JSON.stringify(seen.terminal)).toContain(`honest-${marker}`)
    expect(seen.terminal.exit_code).toBe(0)
    expect(existsSync(path.join(lab.project, `${task}-terminal.txt`))).toBe(true)

    expect(seen.terminalOutside.exit_code).not.toBe(0)
    expect(seen.terminalOutside.output).toMatch(/Operation not permitted/)
    expect(existsSync(path.join(lab.outside, `${task}-terminal.txt`))).toBe(false)

    expect(seen.background.session_id, JSON.stringify(seen.background)).toBeTruthy()
    expect(seen.process.output).toContain(`bg-${marker}`)

    // fx35e (R40): background=true outlives its starter and a hangup, and the process tool polls and kills it.
    expect(seen.hangup.output, JSON.stringify(seen.hangup)).toContain(`hup-${marker}`)
    expect(seen.hangup.exit_code, JSON.stringify(seen.hangup)).toBe(0)
    expect(seen.polled.status, JSON.stringify(seen.polled)).toBe('running')
    expect(seen.killed.status, JSON.stringify(seen.killed)).toBe('killed')
    expect(seen.afterKill.status, JSON.stringify(seen.afterKill)).toBe('exited')
    // fx35e (R41): a nohup the agent writes fails with its own message and nothing else happens.
    expect(seen.nohupBackground.output, JSON.stringify(seen.nohupBackground)).toContain("nohup: can't detach")
    expect(seen.nohupBackground.output).not.toContain(`nohup-${marker}`)
    expect(seen.nohupBackground.exit_code).toBe(127)
    expect(seen.nohupForeground.output, JSON.stringify(seen.nohupForeground)).toContain("nohup: can't detach")
    expect(seen.nohupForeground.exit_code).toBe(127)

    expect(seen.executeCode.output ?? "", JSON.stringify(seen.executeCode)).toContain(`code-${marker}`)
    expect(seen.executeCode.output).toContain('code-refused 1')
    expect(existsSync(path.join(lab.project, `${task}-code.txt`))).toBe(true)
    expect(existsSync(path.join(lab.outside, `${task}-code.txt`))).toBe(false)

    expect(seen.readFile.content).toContain('inside')
    expect(JSON.stringify(seen.readOutside)).not.toContain('outside-secret')
    expect(JSON.stringify(seen.readOutside)).toContain('icloneOS confinement refused')
    expect(seen.env).toBe(SEATBELT)
    expectOffered(seen.offered, seen.catalog)
  }

  const expectBoth = (report: { first: Tools; later: Tools }, scenario: string) => {
    expectConfined(report.first, `${scenario}-first`)
    // R42: the stub model reaches process_manage through tool_search, and the command it started polls running and dies.
    const turn = report.first.turn
    const answers = (turn.tool ?? []).map(text => text.replaceAll('\\"', '"'))
    expect(turn.steps, JSON.stringify(turn)).toBe(5)
    expect(answers, JSON.stringify(turn)).toHaveLength(4)
    expect(answers[0]).toContain('session_id')
    expect(answers[1]).toContain('process_manage')
    expect(answers[2]).toContain('"status": "running"')
    expect(answers[3]).toContain('"status": "killed"')
    expectConfined(report.later, `${scenario}-later`)
    expect(path.basename(lab.env.ICLONE_CONFINEMENT_ACK)).toBe('hermes-ack.json')
    expect(ack().backend).toBe(SEATBELT)
    expect(ack().commands).toEqual({ available: true, reason: '' })
  }

  it('the control: the same write outside the project succeeds with no sandbox', () => {
    const control = path.join(lab.outside, `control-${marker}.txt`)

    execFileSync('/bin/sh', ['-c', `echo planted > ${control}`])
    expect(readFileSync(control, 'utf8')).toBe('planted\n')
    rmSync(control)
    expect(readFileSync(path.join(lab.outside, 'secret.txt'), 'utf8')).toBe('outside-secret\n')
    expect(readFileSync(INSTALLER_TEMPLATE, 'utf8')).toMatch(/^terminal:\n {2}backend: "local"$/m)
  })

  it('(a) the root config is the installer template, backend local', async () => {
    setHome('template')
    expect(readFileSync(path.join(lab.hermesHome, 'config.yaml'), 'utf8')).toBe(readFileSync(INSTALLER_TEMPLATE, 'utf8'))
    expectBoth(await drive('a'), 'a')
  }, 180_000)

  it('(b) a turn routed to an iNFT profile: no terminal section, and a copy of the template', async () => {
    setHome('template')
    profile('inft-none')
    writeFileSync(path.join(lab.hermesHome, 'profiles', 'inft-none', 'config.yaml'), 'model: {}\n')
    profile('inft-tmpl', 'template')

    const report = await drive('b', { routed: ['inft-none', 'inft-tmpl'] })

    expectBoth(report, 'b')
    expect(report.routed?.['inft-none'].scope).toBe(SEATBELT)
    expect(report.routed?.['inft-tmpl'].scope).toBe(SEATBELT)
    expectConfined(report.routed!['inft-none'], 'b-inft-none')
    expectConfined(report.routed!['inft-tmpl'], 'b-inft-tmpl')
  }, 180_000)

  it('(c) .env says TERMINAL_ENV=local', async () => {
    setHome('model: {}\n', 'TERMINAL_ENV=local\n')
    expectBoth(await drive('c'), 'c')
  }, 180_000)

  it('a config asking for docker: tools stay offered, a real agent turn gets the reason, the pane too, nothing ran', async () => {
    setHome('terminal:\n  backend: docker\n')

    const { first, reason = '', agent, placement } = await drive('docker', { refused: true })

    // The sentence is the production writer's: other_backend_refusal, read by the driver from the process itself.
    expect(reason).toContain("'docker'")

    for (const tool of ['terminal', 'background', 'executeCode', 'readFile']) {
      expect(first[tool].error, tool).toBe(reason)
    }

    expectOffered(first.offered, first.catalog)
    expectOffered(agent?.offered)
    expect(agent?.left).toBe(0)
    expect(agent?.tool).toHaveLength(1)
    expect(agent?.tool[0]).toContain(reason)
    expect(placement).toBe(SEATBELT)

    for (const name of ['docker-first-terminal.txt', 'docker-first-code.txt', 'agent-ran.txt']) {
      expect(existsSync(path.join(lab.project, name)), name).toBe(false)
    }

    expect(existsSync(path.join(lab.outside, 'docker-first-terminal.txt'))).toBe(false)
    expect(existsSync(path.join(lab.outside, 'docker-first-code.txt'))).toBe(false)
    expect(ack().commands).toEqual({ available: false, reason: reason.slice(0, ack().commands?.reason.length) })
  }, 180_000)

  /** What the owner's click on the sheet answers: the one thing that stands in for a person in the locked row. */
  let click: 'deny' | 'once' = 'once'
  let sheets = 0

  /** Main's real authority, signed policy and socket; the key on a real pipe; the app's lock; and no stub on the grant. */
  const driveLocked = async (scenario: string, routed: string[]) => {
    const dir = path.join(lab.userDataDir, 'run')

    const server = await startAcpSocketServer({
      dir,
      resolveInft: () => ({ ok: false }),
      admitStreaming: () => false,
      run: async () => ({ code: 1 }),
      log: () => undefined
    } as never)

    try {
      const perm = permissionsSpawn(dir)
      const driver = path.join(lab.project, 'fx35-driver.py')

      writeFileSync(driver, DRIVER)
      expect(perm.keyLine).toBeTruthy()

      const plan = { scenario, project: lab.project, outside: lab.outside, marker, locked: true, routed, refused: scenario === 'refused' }

      const launched = lab.layer.runtimeSpawn(lab.facts.python, ['-s', '-P', driver, JSON.stringify(plan)], {
        ...lab.facts,
        permDir: dir,
        permSocket: perm.env.ICLONE_PERM_SOCKET,
        policyFile: perm.env.ICLONE_POLICY_FILE
      })

      const child = spawn(launched.command, launched.args, {
        cwd: lab.project,
        env: { ...lab.env, ...perm.env },
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        detached: true
      })

      perm.attach(child)
      ;(child.stdio[3] as Writable).end(perm.keyLine)

      let out = ''
      let err = ''

      child.stdout?.on('data', chunk => (out += String(chunk)))
      child.stderr?.on('data', chunk => (err += String(chunk)))

      const timer = setTimeout(() => process.kill(-(child.pid ?? 0), 'SIGKILL'), 170_000)
      const code = await new Promise(resolve => child.once('close', resolve))

      clearTimeout(timer)

      const line = `${out}\n${err}`.split('\n').find(part => part.startsWith('FX35-JSON'))

      if (!line) {
        throw new Error(`the locked driver ended (exit ${String(code)}) without a report\n${err.slice(-3000)}\n${out.slice(-800)}`)
      }

      return JSON.parse(line.slice('FX35-JSON'.length)) as {
        launch: Tools
        reason: string
        agent?: { tool: string[] }
        routed: Record<string, Tools>
        gates: { copies: string[]; channels: number; healthy: boolean[] }
      }
    } finally {
      await server.close()
    }
  }

  it('the real locked run: routed turns work through one gate, and main still decides', async () => {
    setHome('template')
    profile('inft-a', 'template')
    profile('inft-b')
    writeFileSync(path.join(lab.hermesHome, 'profiles', 'inft-b', 'config.yaml'), 'model: {}\n')

    registerPermissions({
      ipcMain: { handle: () => undefined },
      isTrustedSender: () => true,
      userDataDir: lab.userDataDir,
      paths: { hermesHome: lab.hermesHome, home: lab.home, hermesRoot: null },
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

    const report = await driveLocked('locked', ['inft-a', 'inft-b'])

    expect(report.gates.copies).toHaveLength(3)
    expect(report.gates.channels).toBe(1)
    expect(report.gates.healthy).toEqual([true, true, true])

    for (const [tag, seen] of [['launch', report.launch], ['inft-a', report.routed['inft-a']], ['inft-b', report.routed['inft-b']]] as const) {
      expect(seen.terminal.exit_code, `${tag} ${JSON.stringify(seen.terminal)}`).toBe(0)
      expect(existsSync(path.join(lab.project, `locked-${tag}-terminal.txt`)), tag).toBe(true)
      expect(seen.readFile.content).toContain('inside')
    }

    // The same turn with the owner saying no: what the routed copy answers is main's, not a grant of its own.
    click = 'deny'

    const denied = await driveLocked('denied', ['inft-a'])

    expect(denied.gates.healthy).toEqual([true, true])
    expect(JSON.stringify(denied.routed['inft-a'].terminal)).toContain('BLOCKED by icloneOS permissions')
    expect(existsSync(path.join(lab.project, 'denied-inft-a-terminal.txt'))).toBe(false)
    expect(denied.routed['inft-a'].readFile.content).toContain('inside')

    // R42: a backend confinement refuses, in the same real locked run: the reason comes first and the owner gets no
    // sheet to answer for a command that could not run anyway. The sheets above prove the door counts.
    expect(sheets).toBeGreaterThan(0)
    sheets = 0
    click = 'once'
    setHome('terminal:\n  backend: docker\n')

    const refused = await driveLocked('refused', [])

    expect(refused.reason).toContain("'docker'")
    expect(refused.launch.terminal.error, JSON.stringify(refused.launch.terminal)).toBe(refused.reason)
    expect(existsSync(path.join(lab.project, 'refused-launch-terminal.txt'))).toBe(false)
    expect(refused.agent?.tool[0]).toContain(refused.reason)
    expect(existsSync(path.join(lab.project, 'agent-ran.txt'))).toBe(false)
    expect(sheets).toBe(0)
  }, 360_000)

  it('the real serve under the real profile, with the template: hermes-ack.json says the sandbox', async () => {
    setHome('template')

    const { command, args } = lab.launch(['-m', 'hermes_cli.main', 'serve', '--host', '127.0.0.1', '--port', '0'], true)
    const child = spawn(command, args, { cwd: lab.project, env: lab.env, stdio: ['ignore', 'pipe', 'ignore'], detached: true })
    let said = ''

    child.stdout?.on('data', chunk => (said += String(chunk)))

    try {
      for (let tries = 0; tries < 800 && !said.includes('HERMES_BACKEND_READY'); tries += 1) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }

      expect(said).toContain('HERMES_BACKEND_READY')
      expect(child.exitCode).toBeNull()
      expect(ack().backend).toBe(SEATBELT)
      expect(ack().commands).toEqual({ available: true, reason: '' })
    } finally {
      process.kill(-(child.pid ?? 0), 'SIGTERM')
    }
  }, 90_000)
})
