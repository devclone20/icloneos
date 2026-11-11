/**
 * The runtime profile, live: the real Hermes interpreter under `sandbox-exec -p <runtime profile>` in a throwaway
 * world, probed from the runtime interpreter AND from an interpreter child it starts (Seatbelt is inherited). Every
 * refusal is paired with its unconfined control: the same probe without the profile succeeds, so a refusal is the
 * profile's doing, never a missing file. Real secrets are only stat'ed or opened, never read or printed.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { judgeProbe, parseProbe, PROBE_MARK } from '../iclone-hermes-plugins'

import { attachLayer, probeAnswers, RUNTIME_PROBE, type RuntimeProbe, type RuntimeProbeAnswers, type WorldLayer } from './launcher-live-harness'
import { readRunEvents, runFiles, type RunStartEvent } from './runs'
import {
  createRuntimeWorld,
  type LinkedInterpreter,
  runtimeAvailable,
  type RuntimeWorld,
  type RuntimeWorldOptions
} from './runtime-live-harness'
import { launcherLedgerDir } from './runtime-profile'
import { auditSbpl, debuggerDenials } from './sbpl'

import { readAckCommands, readAckPids, sweepAcks } from './index'

interface Probe extends RuntimeProbe {
  /** allowed: ok both ways · refused: EPERM confined, ok plain · exec/mach refusals take their own shape · env: the
   *  planted word is read unconfined and hidden confined. */
  expect: 'allowed' | 'kernel-policy' | 'refused' | 'refused-env' | 'refused-exec' | 'refused-mach'
}

type Results = RuntimeProbeAnswers

const live = runtimeAvailable()
/** How long a booted runtime is left idle while its spawn-guard lines are counted. */
const IDLE_WINDOW_MS = 30_000
const home = os.homedir()

describe.skipIf(!live)('runtime profile (live, macOS Seatbelt)', () => {
  let world: RuntimeWorld
  let probes: Probe[]
  let confined: Results
  let plain: Results
  let sentinel: ReturnType<typeof spawn> | null = null
  const servers: net.Server[] = []
  const skipped: string[] = []

  const listen = (file: string) =>
    new Promise<void>(resolve => {
      const server = net.createServer(socket => socket.end())

      servers.push(server)
      server.listen(file, () => resolve())
    })

  beforeAll(async () => {
    world = createRuntimeWorld()

    const { paths, root, outside } = world
    const project = path.join(root, 'project')
    const probeFile = path.join(project, 'probe.py')
    const token = path.join(paths.membersDir, 'project+0123456789ab+-+0123456789abcdef0123456789abcdef')
    const launcherSocket = path.join(paths.userDataDir, 'confinement', 'run', 'launcher.sock')
    const foreignSocket = path.join(outside, 'other.sock')

    writeFileSync(probeFile, RUNTIME_PROBE)
    writeFileSync(token, '', { mode: 0o600 })
    await listen(launcherSocket)
    await listen(foreignSocket)

    // A-n2: the never-written folders by another spelling (the default volume ignores case), one present and one
    // absent at spawn; a never-read file by another spelling. A-n3: a word planted in a process standing for main
    // (its environment is the kernel's copy, fixed at exec) read back through `ps -E`.
    mkdirSync(path.join(paths.hermesHome, 'plugins'), { recursive: true })
    rmSync(path.join(paths.hermesHome, 'tools'), { recursive: true, force: true })
    const marker = `iclone-live-marker-${process.pid}-${Date.now()}`

    sentinel = spawn('/bin/sleep', ['600'], { env: { ICLONE_LIVE_MARKER: marker }, stdio: 'ignore' })

    probes = [
      { id: 'write Plugins/ (case variant, folder present)', k: 'write', path: path.join(paths.hermesHome, 'Plugins', 'probe.tmp'), expect: 'refused' },
      { id: 'mkdir+write Tools/ (case variant, folder absent)', k: 'mkwrite', path: path.join(paths.hermesHome, 'Tools'), expect: 'refused' },
      { id: 'mkdir+write INSTALLS/ (case variant, folder absent)', k: 'mkwrite', path: path.join(paths.hermesHome, 'INSTALLS'), expect: 'refused' },
      { id: 'read CONSENT.json (case variant)', k: 'read', path: path.join(paths.userDataDir, 'CONSENT.json'), expect: 'refused' },
      // R31 (fx35d): the kernel route is closed, both halves. Unconfined the kernel gives the argv and psutil's ppid and
      // hides this platform target's environment; confined it refuses all three. runtime-env-block.live.test.ts has the
      // non-platform target, whose environment the kernel does show.
      { id: 'kernel argv of a process standing for main', k: 'procargs', pid: sentinel.pid, marker, expect: 'kernel-policy' },
      { id: 'kernel env of a process standing for main', k: 'procenv', pid: sentinel.pid, marker, expect: 'kernel-policy' },
      { id: 'psutil ppid of a process standing for main (kern.proc)', k: 'psutil', pid: sentinel.pid, expect: 'kernel-policy' },
      // fx26a (pre4 major 1): the run token is the run's identity with the kernel; main's sweep is its only remover.
      // fx28: a new file in the folder is all the plugin needs; an open for writing of a token, or its truncation, is not.
      { id: 'make a run token', k: 'create', path: token, expect: 'allowed' },
      { id: 'open a run token for writing', k: 'reopen', path: token, expect: 'refused' },
      { id: 'unlink a run token', k: 'unlink', path: token, expect: 'refused' },
      { id: 'rename a run token', k: 'rename', path: token, expect: 'refused' },
      { id: 'read hermes .env', k: 'read', path: path.join(paths.hermesHome, '.env'), expect: 'allowed' },
      { id: 'read .runtime mark', k: 'read', path: path.join(paths.membersDir, '.runtime'), expect: 'allowed' },
      { id: 'write hermes home', k: 'write', path: path.join(paths.hermesHome, 'probe.tmp'), expect: 'allowed' },
      { id: 'write scratch', k: 'write', path: path.join(paths.scratchRoot, 'probe.tmp'), expect: 'allowed' },
      { id: 'write runtime tmp', k: 'write', path: path.join(root, 'tmp', 'probe.tmp'), expect: 'allowed' },
      { id: 'connect launcher socket', k: 'connect', path: launcherSocket, expect: 'allowed' },
      { id: 'write run dir', k: 'write', path: path.join(paths.userDataDir, 'confinement', 'run', 'probe.tmp'), expect: 'allowed' },
      // The launcher's ledger: the record of what ran is never the runtime's to read or rewrite.
      { id: 'read ledger journal', k: 'read', path: path.join(launcherLedgerDir(paths.userDataDir), 'runs.jsonl'), expect: 'refused' },
      { id: 'read ledger refusals', k: 'read', path: path.join(launcherLedgerDir(paths.userDataDir), 'refused.jsonl'), expect: 'refused' },
      { id: 'write ledger', k: 'write', path: path.join(launcherLedgerDir(paths.userDataDir), 'probe.tmp'), expect: 'refused' },
      { id: 'read outside file', k: 'read', path: path.join(outside, 'secret.txt'), expect: 'refused' },
      { id: 'read consent.json', k: 'read', path: path.join(paths.userDataDir, 'consent.json'), expect: 'refused' },
      { id: 'read .member', k: 'read', path: path.join(paths.membersDir, '.member'), expect: 'refused' },
      { id: 'read .decoy', k: 'read', path: path.join(paths.membersDir, '.decoy'), expect: 'refused' },
      { id: 'read a run token', k: 'read', path: token, expect: 'refused' },
      { id: 'write outside', k: 'write', path: path.join(outside, 'probe.tmp'), expect: 'refused' },
      { id: 'write project', k: 'write', path: path.join(project, 'probe.tmp'), expect: 'refused' },
      { id: 'write userData', k: 'write', path: path.join(paths.userDataDir, 'probe.tmp'), expect: 'refused' },
      { id: 'connect foreign socket', k: 'connect', path: foreignSocket, expect: 'refused' },
      {
        id: 'exec sandbox-exec',
        k: 'exec',
        argv: ['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)', '/usr/bin/true'],
        expect: 'refused-exec'
      },
      { id: 'exec launchctl', k: 'exec', argv: ['/bin/launchctl', 'version'], expect: 'refused-exec' },
      { id: 'exec a shell', k: 'exec', argv: ['/bin/sh', '-c', 'true'], expect: 'refused-exec' },
      { id: 'mach SecurityServer', k: 'mach', name: 'com.apple.SecurityServer', expect: 'refused-mach' }
    ]

    for (const [id, rel] of [
      ['stat ~/.ssh', '.ssh'],
      ['stat ~/.aws', '.aws'],
      ['stat ~/.gnupg', '.gnupg'],
      ['stat ~/Library/Keychains', 'Library/Keychains']
    ] as const) {
      const bait = path.join(home, rel)

      if (existsSync(bait)) {
        probes.push({ id, k: 'stat', path: bait, expect: 'refused' })
      } else {
        skipped.push(`${id}: not on this Mac`)
      }
    }

    const ask = async (confine: boolean): Promise<Results> => {
      return probeAnswers(await world.run(confine, [probeFile, JSON.stringify(probes)], { timeoutMs: 30_000 }))
    }

    confined = await ask(true)
    plain = await ask(false)

    if (process.env.RUNTIME_PROBE_TABLE === '1') {
      console.info(
        probes
          .map(p => `${p.id} | ${confined.self[p.id]} / child ${confined.child?.[p.id]} | plain ${plain.self[p.id]} / child ${plain.child?.[p.id]}`)
          .join('\n')
      )
    }

    if (skipped.length > 0) {
      console.info(`runtime profile baits skipped: ${skipped.join('; ')}`)
    }
  }, 300_000)

  afterAll(() => {
    for (const server of servers) {
      server.close()
    }

    sentinel?.kill("SIGKILL")
    world?.dispose()
  }, 120_000)

  it('the generated profile passes the widening audit', () => {
    expect(auditSbpl(world.profile.text)).toEqual({ widened: false, problems: [] })
  })

  it('the interpreter child ran under the profile too', () => {
    expect(confined.child).toBeDefined()
    expect(confined.child).not.toHaveProperty('error')
    expect(plain.child).not.toHaveProperty('error')
  })

  for (const where of ['self', 'child'] as const) {
    it(`${where}: every probe matches its expectation, paired with its unconfined control`, () => {
      const rows = probes.map(probe => ({
        id: probe.id,
        expect: probe.expect,
        confined: confined[where]?.[probe.id],
        plain: plain[where]?.[probe.id]
      }))

      for (const row of rows) {
        if (row.expect === 'kernel-policy') {
          // psutil's callers in hermes_cli catch its AccessDenied (gateway.py _get_parent_pid: except Exception;
          // _filter_venv_launcher_stubs: except AccessDenied), and the live lifecycle row below runs them for real.
          expect({ id: row.id, plain: row.plain }).toEqual({ id: row.id, plain: row.id.startsWith('kernel env') ? 'hidden' : 'ok' })
          expect({ id: row.id, confined: row.confined }).toEqual({ id: row.id, confined: row.id.startsWith('psutil') ? 'AccessDenied' : 'EPERM' })

          continue
        }

        // The control: unconfined, every probe succeeds (the file exists, the binary runs, the service answers).
        expect({ id: row.id, plain: row.plain }).toEqual({ id: row.id, plain: 'ok' })

        if (row.expect === 'allowed') {
          expect({ id: row.id, confined: row.confined }).toEqual({ id: row.id, confined: 'ok' })
        } else if (row.expect === 'refused') {
          // EPERM, never ENOENT: the target exists (the control just reached it).
          expect({ id: row.id, confined: row.confined }).toEqual({ id: row.id, confined: 'EPERM' })
        } else if (row.expect === 'refused-exec') {
          expect(['EPERM', 'EACCES', 'exit71']).toContain(row.confined)
        } else {
          expect(row.confined).toMatch(/^kr\d+$/)
        }
      }
    })
  }
})

/**
 * The sentences on what the runtime can connect to, one socket and one address at a time. The internet side makes no
 * call to a real host: the probe goes to 192.0.2.1 (RFC 5737, owned by nobody) and counts only the sandbox's own refusal,
 * paired with the same probe unconfined; "any host" itself is shown by the rule in the generated profile.
 */
describe.skipIf(!live)('runtime profile, unix sockets and IP one by one (live, macOS Seatbelt)', () => {
  let world: RuntimeWorld
  let probes: Probe[]
  let confined: Results
  let plain: Results
  let confinedAccepted = 0
  let plainAccepted = 0
  let accepted = 0
  const servers: net.Server[] = []

  const serve = (server: net.Server, ...target: [string] | [number, string]) =>
    new Promise<void>(resolve => {
      servers.push(server)
      server.listen(...(target as [number, string]), () => resolve())
    })

  const row = (where: 'child' | 'self', id: string) => ({ id, confined: confined[where]?.[id], plain: plain[where]?.[id] })

  beforeAll(async () => {
    world = createRuntimeWorld({ mainSockets: true })

    const { paths, root, outside } = world
    const probeFile = path.join(root, 'project', 'probe.py')
    const launcherSocket = path.join(paths.userDataDir, 'confinement', 'run', 'launcher.sock')
    const foreignSocket = path.join(outside, 'other.sock')
    const closing = () => net.createServer(socket => socket.end())
    const permToken = path.join(world.facts.permDir!, 'perm.token')
    const hardLinks = path.join(paths.userDataDir, 'confinement', 'hardlink-acks.json')

    writeFileSync(probeFile, RUNTIME_PROBE)
    writeFileSync(permToken, 'token')
    writeFileSync(hardLinks, '[]')
    writeFileSync(world.facts.policyFile!, '{}')

    for (const file of [launcherSocket, foreignSocket, world.facts.permSocket!, world.facts.paySocket!]) {
      await serve(closing(), file)
    }

    const loopback = net.createServer(socket => {
      accepted += 1
      socket.end()
    })

    await serve(loopback, 0, '127.0.0.1')

    probes = [
      { id: 'unix: name lookup', k: 'connect', path: '/private/var/run/mDNSResponder', expect: 'allowed' },
      { id: 'unix: the launcher', k: 'connect', path: launcherSocket, expect: 'allowed' },
      { id: 'unix: the permission socket', k: 'connect', path: world.facts.permSocket!, expect: 'allowed' },
      { id: 'unix: the payment socket', k: 'connect', path: world.facts.paySocket!, expect: 'allowed' },
      { id: 'unix: a foreign socket', k: 'connect', path: foreignSocket, expect: 'refused' },
      { id: 'ip: a service on loopback', k: 'tcp', host: '127.0.0.1', port: (loopback.address() as net.AddressInfo).port, expect: 'allowed' },
      { id: 'ip: an address outside this Mac', k: 'route', host: '192.0.2.1', port: 443, expect: 'allowed' },
      { id: 'state: the policy file', k: 'read', path: world.facts.policyFile!, expect: 'allowed' },
      { id: 'state: the list of allowed hard links', k: 'read', path: hardLinks, expect: 'allowed' },
      { id: 'state: a socket token', k: 'read', path: permToken, expect: 'allowed' },
      { id: 'state: consent.json', k: 'read', path: path.join(paths.userDataDir, 'consent.json'), expect: 'refused' }
    ]

    const ask = async (confine: boolean): Promise<Results> =>
      probeAnswers(await world.run(confine, [probeFile, JSON.stringify(probes)], { timeoutMs: 30_000 }))

    confined = await ask(true)
    confinedAccepted = accepted
    accepted = 0
    plain = await ask(false)
    plainAccepted = accepted
  }, 300_000)

  afterAll(() => {
    for (const server of servers) {
      server.close()
    }

    world?.dispose()
  }, 120_000)

  for (const where of ['self', 'child'] as const) {
    it(`${where}: name lookup, the launcher, the permission and payment sockets connect, a foreign socket is refused, each paired with its unconfined control`, () => {
      for (const probe of probes.filter(item => item.k === 'connect')) {
        expect(row(where, probe.id)).toEqual({ id: probe.id, confined: probe.expect === 'allowed' ? 'ok' : 'EPERM', plain: 'ok' })
      }
    })

    it(`${where}: a service on loopback answers and an address outside this Mac is not refused, each paired with its unconfined control`, () => {
      for (const probe of probes.filter(item => item.k === 'tcp' || item.k === 'route')) {
        expect(row(where, probe.id)).toEqual({ id: probe.id, confined: 'ok', plain: 'ok' })
      }
    })

    it(`${where}: the policy file, the list of allowed hard links and a socket token are readable, consent.json is not, each paired with its unconfined control`, () => {
      for (const probe of probes.filter(item => item.k === 'read')) {
        expect(row(where, probe.id)).toEqual({ id: probe.id, confined: probe.expect === 'allowed' ? 'ok' : 'EPERM', plain: 'ok' })
      }
    })
  }

  it('the loopback listener saw each connection, from the runtime and its child, both ways', () => {
    expect({ confinedAccepted, plainAccepted }).toEqual({ confinedAccepted: 2, plainAccepted: 2 })
  })

  it('the generated profile allows any internet host and refuses IP nowhere', () => {
    expect(world.profile.text).toContain('(allow network-outbound (remote ip "*:*"))')
    // but for the browser debugger's fixed ports, each denied by number (browser-debugger.live.test.ts)
    const rest = world.profile.text.split('\n').filter(line => !debuggerDenials().includes(line))

    expect(rest.join('\n')).not.toMatch(/\(deny[^)]*network/)
  })
})

/**
 * The interpreter reached through links: a folder link in front of the venv, the venv's `bin/python` pointing into a
 * minor-version alias folder beside the real install (uv's layout for a managed Python), the real binary at the end.
 * The kernel follows each link by reading its metadata, so the profile names every link on the way, or the exec is
 * refused before Python runs (sandbox-exec exits 71). Paired control: the same venv boots without the profile.
 */
describe.skipIf(!live)('runtime profile, an interpreter reached through linked folders (live, macOS Seatbelt)', () => {
  let world: RuntimeWorld
  const boot = ['-c', 'import hermes_bootstrap, sys; print(sys.executable); print(sys.prefix)']

  beforeAll(() => {
    world = createRuntimeWorld({ interpreter: 'linked' })
  }, 300_000)

  afterAll(() => {
    world?.dispose()
  }, 120_000)

  it('the world put a folder link, the venv link and an alias folder on the interpreter’s way', () => {
    const { links } = world.linked as LinkedInterpreter

    expect(links).toHaveLength(3)
    expect(links.map(link => lstatSync(link).isSymbolicLink())).toEqual([true, true, true])
    expect(lstatSync(realpathSync(links[2])).isDirectory()).toBe(true)
    // The chain ends at the base installation's interpreter, inside the folder the alias names.
    expect(realpathSync(world.facts.python).startsWith(`${realpathSync(links[2])}/`)).toBe(true)
  })

  it('boots under the runtime profile as it boots without it: same executable path, same venv prefix', async () => {
    const plain = await world.run(false, boot, { timeoutMs: 30_000 })
    const confined = await world.run(true, boot, { timeoutMs: 30_000 })

    // The control: the linked venv is a working interpreter by itself, and keeps the venv as it was named (the folder
    // link in front), which is what a venv's `bin/python` link is kept for.
    expect({ code: plain.code, err: plain.err }).toEqual({ code: 0, err: '' })
    expect(plain.out.trim().split('\n')).toEqual([world.facts.python, path.dirname(path.dirname(world.facts.python))])

    // Under the profile: no `sandbox-exec: execvp() … Operation not permitted` (exit 71), the same answers.
    expect({ code: confined.code, err: confined.err }).toEqual({ code: 0, err: '' })
    expect(confined.out).toBe(plain.out)
  })

  it('the profile names each link once, as a metadata literal, and the audit still passes', () => {
    const { links } = world.linked as LinkedInterpreter
    const line = world.profile.text.split('\n').find(item => links.every(link => item.includes(`(literal "${link}")`)))

    expect(line).toMatch(/^\(allow file-read-metadata (\(literal "[^"]+"\) ?)+\)$/)
    expect(world.profile.text.match(new RegExp(`\\(literal "${links[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)`, 'g'))).toHaveLength(1)
    expect(auditSbpl(world.profile.text)).toEqual({ widened: false, problems: [] })
  })
})

/**
 * Plugin discovery as Hermes runs it (hermes_cli.plugins discover_plugins, the gate's own probe), then one agent
 * command through the plugin it loaded: the confinement plugin's `SeatbeltEnvironment`, which hands the command to
 * the launcher through the stub. Then Hermes' own tool registry: which tools of the terminal toolset it offers (each
 * tool's check_fn, the catalog a model is given), and one call of the terminal tool through Hermes' real dispatch
 * (model_tools.handle_function_call, no model). Reports the gate probe's shape (judged by the gate's own judgeProbe),
 * the command's result, the offered tools and the dispatch result. `hold <release file>`: skips the direct command,
 * prints its pid, and stays alive until the release file exists (main folds its state while it lives). Leaves
 * through os._exit as the probe does.
 */
/** R33, measured under the deny pair. psutil on the runtime's own child says AccessDenied, never "no such process"; the
 *  registry and the kill path read that as unknown, so the child stays alive to them and the signal still lands. */
const EXPECT_LIFE = {
  timeout: { exit_code: 124 },
  background_started: true,
  tool_poll: 'running',
  tool_kill: 'killed',
  tool_after_kill: 'exited',
  host_held_gone: true,
  host_alive_while_it_lives: true,
  host_alive_once_exited: false,
  descendant_same_group: 'gone',
  descendant_other_group: 'alive',
  psutil_child: 'AccessDenied',
  psutil_self: true,
  psutil_exists: true,
  pid_exists: true,
  start_time_read: false,
  registry_alive: true,
  registry_fate: 'running',
  poll_running: null,
  kill: null,
  poll_killed: -15
}

const DISCOVERY_DRIVER = String.raw`
import importlib, json, os, sys, time
spec_raw, project, tag = sys.argv[1:4]
hold = sys.argv[4:5] == ["hold"]
from hermes_cli.plugins import discover_plugins, get_plugin_manager
discover_plugins()
pm = get_plugin_manager()
rows = {}
for key, lp in pm._plugins.items():
    if str(key).startswith("iclone-"):
        m = lp.manifest
        rows[str(key)] = {"enabled": bool(lp.enabled), "error": lp.error, "path": str(m.path or ""), "source": m.source}
hooks = []
for cb in list(pm._hooks.get("pre_tool_call", [])):
    mod = sys.modules.get(getattr(cb, "__module__", None) or "")
    hooks.append(str(getattr(mod, "__file__", None) or ""))
out = {"plugins": rows, "pre_tool_call": hooks, "meta_path": []}
loaded = pm._plugins.get("iclone-confinement")
module = loaded.module if loaded is not None else None
if module is not None and not hold:
    core = importlib.import_module(module.__name__ + ".core")
    seatbelt = importlib.import_module(module.__name__ + ".seatbelt")
    env = seatbelt.SeatbeltEnvironment(cwd=project, timeout=20, cls="project", index=core.parse_spec(spec_raw), task_id="matrix-" + tag)
    r = env.execute("echo matrix-" + tag)
    out["command"] = {"code": r.get("returncode"), "out": r.get("output", "")[-200:], "confined": core.runtime_confined()}
import model_tools
from tools.registry import invalidate_check_fn_cache
invalidate_check_fn_cache()
model_tools._clear_tool_defs_cache()
defs = model_tools.get_tool_definitions(enabled_toolsets=["terminal"], quiet_mode=True, skip_tool_search_assembly=True)
out["offered"] = sorted(t["function"]["name"] for t in defs)
raw = model_tools.handle_function_call("terminal", {"command": "echo dispatch-" + tag}, task_id="matrix-dispatch-" + tag)
try:
    result = json.loads(raw)
except ValueError:
    result = {"raw": str(raw)[-400:]}
out["dispatch"] = {k: (str(v)[-1200:] if isinstance(v, str) else v) for k, v in result.items() if k in ("output", "exit_code", "error", "raw")}
outside = os.environ.get("MATRIX_OUTSIDE", "")
if outside and not hold:
    raw = model_tools.handle_function_call("terminal", {"command": "touch " + os.path.join(outside, "agent-write-" + tag)}, task_id="matrix-dispatch-" + tag)
    try:
        result = json.loads(raw)
    except ValueError:
        result = {"raw": str(raw)[-400:]}
    out["write"] = {k: (str(v)[-1200:] if isinstance(v, str) else v) for k, v in result.items() if k in ("output", "exit_code", "error", "raw")}
if not hold:
    # R33: the runtime's daily process work under the deny pair, through its real tools: a command past its timeout, a
    # background process started, polled and killed, and what psutil says of the runtime's own child.
    import time, psutil
    from gateway.status import get_process_start_time
    life = {}
    call = lambda name, args: json.loads(model_tools.handle_function_call(name, args, task_id="matrix-life-" + tag))
    began = time.monotonic()
    timed = call("terminal", {"command": "/bin/sleep 60", "timeout": 2})
    life["timeout"] = {"exit_code": timed.get("exit_code"), "seconds": round(time.monotonic() - began)}
    started = call("terminal", {"command": "/bin/sleep 120", "background": True})
    life["background_started"] = bool(started.get("session_id"))
    life["tool_poll"] = call("process_manage", {"action": "poll", "session_id": started.get("session_id")}).get("status")
    life["tool_kill"] = call("process_manage", {"action": "kill", "session_id": started.get("session_id")}).get("status")
    life["tool_after_kill"] = call("process_manage", {"action": "poll", "session_id": started.get("session_id")}).get("status")
    # The live child the tools hold: the stub, the runtime's own, and the command the launcher runs for it. The registry's
    # poll and kill methods and the kill path of the local backend, each on that real pair.
    from tools.environments.local import _kill_process_group_posix
    from tools.process_registry import process_registry
    from gateway.status import _pid_exists
    loaded_module = pm._plugins["iclone-confinement"].module
    seat = importlib.import_module(loaded_module.__name__ + ".seatbelt")
    core_mod = importlib.import_module(loaded_module.__name__ + ".core")
    env = seat.SeatbeltEnvironment(cwd=project, timeout=60, cls="project", index=core_mod.parse_spec(spec_raw), task_id="matrix-life2-" + tag)
    try:
        proc = env._run_bash("echo $$; exec /bin/sleep 120")
    except PermissionError:
        # The spawn guard only takes this driver's frame as a lane in the layout whose plugin sits inside the runtime.
        out["lifecycle"] = {"timeout": life["timeout"], "background_started": life["background_started"], "guarded": True,
                            "tool_poll": life["tool_poll"], "tool_kill": life["tool_kill"], "tool_after_kill": life["tool_after_kill"]}
        print("MATRIX-JSON" + json.dumps(out), flush=True)
        os._exit(0)
    life["command_pid"] = int(proc.stdout.readline().strip() or 0)
    held = proc.pid
    def says(fn):
        try:
            return fn()
        except Exception as exc:
            return type(exc).__name__
    life["psutil_child"] = says(lambda: psutil.Process(held).status())
    life["psutil_children"] = says(lambda: len(psutil.Process(os.getpid()).children()))
    life["psutil_self"] = says(lambda: bool(psutil.Process(os.getpid()).status()))
    life["psutil_exists"] = says(lambda: psutil.pid_exists(held))
    life["pid_exists"] = says(lambda: _pid_exists(held))
    start = says(lambda: get_process_start_time(held))
    life["start_time_read"] = isinstance(start, int)
    life["registry_alive"] = says(lambda: process_registry._is_host_pid_alive(held))
    life["registry_fate"] = says(lambda: process_registry._detached_host_fate(held, start if isinstance(start, int) else None))
    life["poll_running"] = proc.poll()
    began = time.monotonic()
    life["kill"] = says(lambda: _kill_process_group_posix(proc))
    life["kill_seconds"] = round(time.monotonic() - began)
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline and proc.poll() is None:
        time.sleep(0.05)
    life["poll_killed"] = proc.poll()
    # R42: the host kill path, the one the browser daemons take, on a second live child. psutil cannot list its children
    # under the deny pair, so the sweep has nothing to go on: what it still reaches is measured here, not assumed.
    from tools.process_registry import ProcessRegistry
    second = env._run_bash("echo $$; exec /bin/sleep 120")
    life["host_command_pid"] = int(second.stdout.readline().strip() or 0)
    life["host_kill"] = says(lambda: ProcessRegistry._terminate_host_pid(second.pid))
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline and second.poll() is None:
        time.sleep(0.05)
    life["host_held_gone"] = second.poll() is not None
    # fx35f: AccessDenied is not "gone": the kill path sees the child alive while it lives and not once it has exited, so
    # the grace wait runs. Its descendants, one in the child's group and one in a group of its own, seen from a new command:
    # another sandbox gets EPERM from kill -0 for a live process and ESRCH for a gone one, and nothing else can tell.
    third = env._run_bash("echo $$; /bin/sleep 300 & echo $!; set -m; /bin/sleep 300 & echo $!; set +m; exec /bin/sleep 300")
    third_lines = [int(third.stdout.readline().strip() or 0) for _ in range(3)]
    life["host_alive_while_it_lives"] = ProcessRegistry._proc_alive(psutil.Process(third.pid))
    began = time.monotonic()
    life["host_kill_descendants"] = says(lambda: ProcessRegistry._terminate_host_pid(third.pid))
    life["host_kill_seconds"] = round(time.monotonic() - began, 1)
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline and third.poll() is None:
        time.sleep(0.05)
    life["host_alive_once_exited"] = ProcessRegistry._proc_alive(psutil.Process(third.pid)) if third.poll() is None else False
    def fate(pid):
        said = env.execute(f"kill -0 {pid}; echo rc=$?", cwd=project, timeout=15).get("output", "")
        return "gone" if "No such process" in said else "alive" if "not permitted" in said else said[:120]
    def settled(pid):
        deadline = time.monotonic() + 8
        while fate(pid) == "alive" and time.monotonic() < deadline:
            time.sleep(0.2)
        return fate(pid)
    life["other_group_pid"] = third_lines[2]
    life["descendant_same_group"] = settled(third_lines[1])
    life["descendant_other_group"] = settled(third_lines[2])
    out["lifecycle"] = life
out["pid"] = os.getpid()
print("MATRIX-JSON" + json.dumps(out), flush=True)
if hold:
    open(sys.argv[5] + ".ready", "w").close()
    deadline = time.monotonic() + 120
    while not os.path.exists(sys.argv[5]) and time.monotonic() < deadline:
        time.sleep(0.05)
os._exit(0)
`

interface Driven {
  code: number | null
  err: string
  report: ReturnType<typeof parseProbe>
  verdict: null | string
  command: { code: number | null; out: string; confined: boolean } | null
  /** The terminal toolset's tools Hermes' registry offers (each tool's check_fn). */
  offered: string[]
  /** The terminal tool's result through Hermes' own dispatch. */
  dispatch: { output?: string; exit_code?: number; error?: string; raw?: string } | null
  /** The same dispatch of a write outside the agent's grants (the world's `outside` folder). */
  write: { output?: string; exit_code?: number; error?: string; raw?: string } | null
  /** R33: a timeout, a background process start, poll and kill through the real tools; psutil on the runtime's child. */
  lifecycle: Record<string, unknown> | null
}

/**
 * The userData policy across the layouts the runtime really runs in, each under main's real confinement layer (its
 * profile, its launcher). Each row: plugin discovery under the profile finds and loads the confinement plugin where
 * the gate expects it (the runtime's `plugins/`, or the app-owned overlay of an unmanaged dev runtime); one agent
 * command runs through the plugin, the stub and the launcher and lands start and end in the ledger; the runtime boots
 * to its ready file; it reads what it needs and gets EPERM on the rest of userData — the launcher's ledger (both
 * files), the confinement settings and folder, consent, another runtime's folder, a browser profile, the plugin
 * overlay, PM's records, the venv and the Python home — every probe paired with its unconfined control. The packaged
 * rows are a simulation: this checkout's shipped files placed where a packed app places its runtime, not a packed
 * build.
 */
const LAYOUTS: { name: string; options: RuntimeWorldOptions }[] = [
  { name: 'packaged layout (runtime placed as a packed app places it)', options: { runtime: 'packaged' } },
  {
    name: 'fresh-install layout (runtime and HERMES_HOME both inside userData)',
    options: { runtime: 'packaged', hermesHome: 'userData' }
  },
  {
    name: 'fresh-install run of a dev runtime (HERMES_HOME inside userData, plugins in the app-owned overlay)',
    options: { hermesHome: 'userData', interpreter: 'linked', plugins: 'overlay' }
  },
  {
    name: 'dev layout (runtime outside userData, linked venv, plugins in the app-owned overlay)',
    options: { interpreter: 'linked', plugins: 'overlay' }
  }
]

for (const layout of LAYOUTS) {
  describe.skipIf(!live)(`runtime profile, ${layout.name} (live, macOS Seatbelt)`, () => {
    let world: RuntimeWorld
    let wl: WorldLayer
    let probes: Probe[]
    let confined: Results
    let plain: Results
    let driven: { confined: Driven; plain: Driven }
    let ackAfterConfined: number[] = []
    let commandsAfterConfined: ReturnType<typeof readAckCommands>[number] | null = null
    let pluginRoot = ''
    /** The Hermes pids main is told about (a held driver's, while main folds its state). */
    let held: number[] = []
    /** What this row observed, written to MATRIX_EVIDENCE_DIR (when set) for the acceptance table. */
    const evidence: Record<string, unknown> = {}

    const parseDriven = (run: { code: number | null; out: string; err: string }): Driven => {
      const line = run.out.split('\n').find(item => item.startsWith('MATRIX-JSON'))
      const raw = line ? (JSON.parse(line.slice('MATRIX-JSON'.length)) as Record<string, unknown>) : null
      const report = line ? parseProbe(`${PROBE_MARK}${line.slice('MATRIX-JSON'.length)}`) : null

      return {
        code: run.code,
        err: run.err.slice(-1200),
        report,
        verdict: judgeProbe(report, ['iclone-confinement'], pluginRoot),
        command: (raw?.command as Driven['command']) ?? null,
        offered: (raw?.offered as string[] | undefined) ?? [],
        dispatch: (raw?.dispatch as Driven['dispatch']) ?? null,
        write: (raw?.write as Driven['write']) ?? null,
        lifecycle: (raw?.lifecycle as Driven['lifecycle']) ?? null
      }
    }

    /**
     * The driver under the runtime profile in `hold` mode: once it has asked the registry and dispatched (its
     * acknowledgement is written), main is told it is the Hermes and folds the state while it lives.
     */
    const driveHeld = async (tag: string) => {
      // In HERMES_HOME: the held runtime may read it and write its ready mark there (its own folder by profile).
      const release = path.join(world.paths.hermesHome, `release-${tag}`)

      // G22 B1: every runtime has its own file, so an earlier driver's word must go, or a dead pid speaks for this run.
      sweepAcks(wl.ackFile, () => false)

      const running = wl.run(
        [path.join(world.root, 'project', 'matrix-driver.py'), wl.env.ICLONE_CONFINEMENT_SPEC, world.facts.project ?? '', tag, 'hold', release],
        { confined: true, timeoutMs: 180_000 }
      )

      // The driver has asked the registry, dispatched and printed its line once it marks itself ready; it then waits.
      const deadline = Date.now() + 150_000

      while (Date.now() < deadline && !existsSync(`${release}.ready`)) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }

      const commands = readAckCommands(wl.ackFile)[0] ?? null
      let state: Awaited<ReturnType<WorldLayer['layer']['state']>> | null = null

      if (commands) {
        held = [commands.pid]
        state = await wl.layer.state()
        held = []
      }

      writeFileSync(release, '')

      return { driven: parseDriven(await running), commands, state }
    }

    const drive = async (confine: boolean): Promise<Driven> => {
      const tag = confine ? 'confined' : 'plain'
      const spec = wl.env.ICLONE_CONFINEMENT_SPEC

      // G22 B1: every runtime has its own file, so an earlier driver's word must go, or a dead pid speaks for this run.
      sweepAcks(wl.ackFile, () => false)

      const run = await wl.run([path.join(world.root, 'project', 'matrix-driver.py'), spec, world.facts.project ?? '', tag], {
        confined: confine,
        timeoutMs: 120_000,
        env: { MATRIX_OUTSIDE: world.outside }
      })

      return parseDriven(run)
    }

    beforeAll(async () => {
      world = createRuntimeWorld(layout.options)

      const { facts, paths, root } = world
      const project = facts.project as string
      const probeFile = path.join(root, 'project', 'probe.py')
      const confinementDir = path.join(paths.userDataDir, 'confinement')
      const otherRuntime = path.join(paths.userDataDir, 'hermes-runtime', 'b'.repeat(64), 'hermes_bootstrap.py')
      const cookies = path.join(paths.userDataDir, 'Partitions', 'browser', 'Cookies')

      for (const file of [otherRuntime, cookies]) {
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, '# not the runtime’s\n')
      }

      mkdirSync(path.join(paths.hermesHome, 'plugins'), { recursive: true })
      writeFileSync(probeFile, RUNTIME_PROBE)
      writeFileSync(path.join(root, 'project', 'matrix-driver.py'), DISCOVERY_DRIVER)
      // The plugin takes a git checkout as a project root.
      execFileSync('/usr/bin/git', ['init', '-q', project])

      pluginRoot = world.overlay ? path.dirname(world.overlay) : facts.runtimeRoot
      wl = await attachLayer(world, { hermesPids: () => held })

      const ledger = launcherLedgerDir(paths.userDataDir)

      probes = [
        { id: 'read hermes .env', k: 'cat', path: path.join(paths.hermesHome, '.env'), expect: 'allowed' },
        { id: 'write hermes home', k: 'write', path: path.join(paths.hermesHome, 'probe.tmp'), expect: 'allowed' },
        { id: 'read runtime code', k: 'read', path: path.join(facts.runtimeRoot, 'hermes_bootstrap.py'), expect: 'allowed' },
        { id: 'read venv config', k: 'read', path: path.join(facts.venvRoot, 'pyvenv.cfg'), expect: 'allowed' },
        // The run dir is the runtime's own by contract (the launcher socket, the plugin's acknowledgement and refusals).
        { id: 'write run dir', k: 'write', path: path.join(confinementDir, 'run', 'probe.tmp'), expect: 'allowed' },
        { id: 'write hermes plugins', k: 'write', path: path.join(paths.hermesHome, 'plugins', 'probe.tmp'), expect: 'refused' },
        // The launcher's ledger, both files: the record of what ran and of what was refused is never the runtime's.
        { id: 'read ledger journal', k: 'read', path: path.join(ledger, 'runs.jsonl'), expect: 'refused' },
        { id: 'read ledger refusals', k: 'read', path: path.join(ledger, 'refused.jsonl'), expect: 'refused' },
        { id: 'write ledger', k: 'write', path: path.join(ledger, 'probe.tmp'), expect: 'refused' },
        { id: 'read confinement settings', k: 'read', path: path.join(confinementDir, 'settings.json'), expect: 'refused' },
        { id: 'write confinement folder', k: 'write', path: path.join(confinementDir, 'probe.tmp'), expect: 'refused' },
        { id: 'read consent.json', k: 'read', path: path.join(paths.userDataDir, 'consent.json'), expect: 'refused' },
        { id: 'write userData', k: 'write', path: path.join(paths.userDataDir, 'probe.tmp'), expect: 'refused' },
        { id: 'read another runtime', k: 'read', path: otherRuntime, expect: 'refused' },
        { id: 'read a browser profile', k: 'read', path: cookies, expect: 'refused' },
        // The venv is never written, wherever it lies (a world's own venv here: the packaged clone, the linked one).
        { id: 'write venv bin', k: 'write', path: path.join(facts.venvRoot, 'bin', 'probe.tmp'), expect: 'refused' },
        // The runtime's own code is read-only wherever it lies (a probe file in a managed copy, never in this checkout).
        ...(world.managed
          ? [{ id: 'write runtime code', k: 'write' as const, path: path.join(facts.runtimeRoot, 'probe.tmp'), expect: 'refused' as const }]
          : []),
        // PM's records and Python store of the layout (a world's own clone): the interpreter main runs unconfined.
        ...(world.pm
          ? [
              { id: 'write python home bin', k: 'write' as const, path: path.join(facts.pythonHome, 'bin', 'probe.tmp'), expect: 'refused' as const },
              {
                id: 'write beside PM facts.json',
                k: 'write' as const,
                path: path.join(path.dirname(path.dirname(path.dirname(path.dirname(facts.venvRoot)))), 'probe.tmp'),
                expect: 'refused' as const
              }
            ]
          : []),
        // The plugin overlay of an unmanaged dev runtime: read (its own copies and its links into the checkout), never written.
        ...(world.overlay
          ? [
              { id: 'read overlay plugin manifest', k: 'read' as const, path: path.join(world.overlay, 'iclone-confinement', 'plugin.yaml'), expect: 'allowed' as const },
              {
                id: 'read a checkout plugin through its overlay link',
                k: 'read' as const,
                path: path.join(
                  world.overlay,
                  readdirSync(world.overlay).find(name => lstatSync(path.join(world.overlay as string, name)).isSymbolicLink() && existsSync(path.join(world.overlay as string, name, 'plugin.yaml'))) as string,
                  'plugin.yaml'
                ),
                expect: 'allowed' as const
              },
              { id: 'write overlay', k: 'write' as const, path: path.join(world.overlay, 'probe.tmp'), expect: 'refused' as const },
              { id: 'write overlay plugin', k: 'write' as const, path: path.join(world.overlay, 'iclone-confinement', 'probe.tmp'), expect: 'refused' as const }
            ]
          : [])
      ]

      const ask = async (confine: boolean): Promise<Results> =>
        probeAnswers(await wl.run([probeFile, JSON.stringify(probes)], { confined: confine, timeoutMs: 60_000 }))

      confined = await ask(true)
      plain = await ask(false)

      const insideRun = await drive(true)

      ackAfterConfined = readAckPids(wl.ackFile)
      commandsAfterConfined = readAckCommands(wl.ackFile)[0] ?? null
      driven = { confined: insideRun, plain: await drive(false) }
    }, 900_000)

    afterAll(async () => {
      const dir = process.env.MATRIX_EVIDENCE_DIR

      if (dir) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(
          path.join(dir, `${layout.name.split(' (')[0].replace(/[^a-z0-9]+/gi, '-')}.json`),
          `${JSON.stringify({ row: layout.name, ...evidence }, null, 1)}\n`
        )
      }

      await wl?.dispose()

      // fx35f: the descendant in a group of its own outlived the kill; the launcher's stop is what ends it.
      const otherGroup = (driven?.confined?.lifecycle as Record<string, unknown> | undefined)?.other_group_pid as number | undefined
      let left = false

      if (otherGroup) {
        const running = () => {
          try {
            process.kill(otherGroup, 0)

            return true
          } catch {
            return false
          }
        }
        const until = Date.now() + 8_000

        while (running() && Date.now() < until) {
          await new Promise(done => setTimeout(done, 50))
        }

        left = running()

        if (left) {
          process.kill(otherGroup, 'SIGKILL')
        }
      }

      world?.dispose()
      expect(left, 'the launcher stop left the other-group descendant running').toBe(false)
    }, 300_000)

    it('the world is laid out as named, and the profile main spawns with passes the widening audit', () => {
      const { facts, paths } = world
      const inside = (item: string) => item.startsWith(`${paths.userDataDir}/`)

      expect({
        runtime: inside(facts.runtimeRoot),
        venv: inside(facts.venvRoot),
        pythonHome: inside(facts.pythonHome),
        hermesHome: inside(paths.hermesHome),
        overlay: world.overlay ? inside(world.overlay) : null
      }).toEqual({
        runtime: Boolean(world.managed),
        venv: Boolean(world.managed),
        pythonHome: Boolean(world.managed),
        hermesHome: layout.options.hermesHome === 'userData',
        overlay: layout.options.plugins === 'overlay' ? true : null
      })
      expect(auditSbpl(wl.layer.runtimeSpawn(world.pythonArgv([])[0], [], wl.facts).profile.text)).toEqual({ widened: false, problems: [] })
    })

    it('plugin discovery under the profile finds and loads the confinement plugin where the gate expects it, armed, and acknowledges it', () => {
      expect({ code: driven.plain.code, verdict: driven.plain.verdict, err: driven.plain.verdict ? driven.plain.err : '' }).toEqual({ code: 0, verdict: null, err: '' })
      expect({ code: driven.confined.code, verdict: driven.confined.verdict, err: driven.confined.verdict ? driven.confined.err : '' }).toEqual({ code: 0, verdict: null, err: '' })
      expect(driven.confined.report?.plugins['iclone-confinement']).toMatchObject({
        enabled: true,
        error: null,
        path: path.join(pluginRoot, 'plugins', 'iclone-confinement')
      })
      // The plugin wrote its acknowledgement (the pane's "loaded" signal) from inside the profile.
      expect(ackAfterConfined).toHaveLength(1)
    }, 30_000)

    it('one agent command runs through the plugin, the stub and the launcher, and lands start and end in the ledger', () => {
      expect(driven.confined.command).toMatchObject({ code: 0, confined: true })
      expect(driven.confined.command?.out).toContain('matrix-confined')

      const events = readRunEvents(runFiles(world.paths.userDataDir))
      const start = events.find((event): event is RunStartEvent => event.ev === 'start' && event.command === 'echo matrix-confined')

      expect(start).toBeDefined()
      expect(start?.kind).toBe('shell')
      expect(events.find(event => event.ev === 'end' && event.run === start?.run)).toMatchObject({ code: 0 })
      // The control ran the same command unconfined, through the same launcher.
      expect(driven.plain.command).toMatchObject({ code: 0 })
    })

    it('Hermes’ own registry offers the terminal under the profile, and its real dispatch runs a command through the launcher into the ledger', async () => {
      // The terminal tool's check_fn asked the plugin, which asked the launcher: offered, as without the profile.
      expect(driven.confined.offered).toContain('terminal')
      expect(driven.plain.offered).toContain('terminal')
      expect(driven.confined.dispatch).toMatchObject({ exit_code: 0 })
      // R33, under the deny pair: a timeout still stops its command, a background process starts, polls and dies, its pid
      // really gone; psutil on the runtime's own child answers AccessDenied, never "no such process", and the callers
      // treat that as unknown; a process still sees itself.
      const life = driven.confined.lifecycle as Record<string, unknown>

      if (life.guarded) {
        expect(life).toMatchObject({
          timeout: { exit_code: 124 },
          background_started: true,
          tool_poll: 'running',
          tool_kill: 'killed',
          tool_after_kill: 'exited'
        })

        return
      }

      expect(life).toMatchObject(EXPECT_LIFE)
      expect((life.timeout as { seconds: number }).seconds).toBeLessThan(20)
      expect(() => process.kill(life.other_group_pid as number, 0), 'alive after the driver left, seen from outside').not.toThrow()
      expect(life.command_pid).toBeGreaterThan(1)
      expect(life.host_command_pid).toBeGreaterThan(1)
      await expect.poll(() => {
        try {
          process.kill(life.host_command_pid as number, 0)

          return 'alive'
        } catch (error) {
          return (error as NodeJS.ErrnoException).code
        }
      }, { timeout: 8000 }).toBe('ESRCH')
      await expect.poll(() => {
        try {
          process.kill(life.command_pid as number, 0)

          return 'alive'
        } catch (error) {
          return (error as NodeJS.ErrnoException).code
        }
      }, { timeout: 8000 }).toBe('ESRCH')
      expect(driven.confined.dispatch?.output).toContain('dispatch-confined')

      const events = readRunEvents(runFiles(world.paths.userDataDir))
      const start = events.find((event): event is RunStartEvent => event.ev === 'start' && event.command === 'echo dispatch-confined')

      expect(start).toMatchObject({ kind: 'shell' })
      expect(events.find(event => event.ev === 'end' && event.run === start?.run)).toMatchObject({ code: 0 })
      // The acknowledgement the plugin wrote from inside the profile says the agent's commands can run.
      expect(commandsAfterConfined).toEqual({ pid: ackAfterConfined[0], available: true, reason: '' })
      evidence.offered = driven.confined.offered
      evidence.dispatch = { ...driven.confined.dispatch, ledger: { start: start?.run, kind: start?.kind, end: events.find(event => event.ev === 'end' && event.run === start?.run) } }
      evidence.ack = commandsAfterConfined
    })

    it('the agent’s own command is refused a write outside its grants (EPERM), paired with the same write unconfined', () => {
      const target = path.join(world.outside, 'agent-write-confined')

      expect(driven.confined.write?.exit_code).not.toBe(0)
      expect(driven.confined.write?.output ?? '').toContain('Operation not permitted')
      expect(existsSync(target)).toBe(false)
      // The control: the same write, by a process no profile holds, lands.
      writeFileSync(target, '')
      expect(existsSync(target)).toBe(true)
      rmSync(target)
      evidence.write = { confined: driven.confined.write, control: 'ok' }
    })

    it('idle after boot with the parent watchdog armed as the desktop arms it: no spawn-guard line repeats in a 30 s window', async () => {
      const readyFile = path.join(world.readyDir, 'ready-idle.json')
      const parent = process.pid
      const marker = `ps:${execFileSync('/bin/ps', ['-p', String(parent), '-o', 'lstart='], { encoding: 'utf8' }).trim()}`
      const argv = world.pythonArgv(['-m', 'hermes_cli.main', 'serve', '--host', '127.0.0.1', '--port', '0'])
      const launched = wl.layer.runtimeSpawn(argv[0], argv.slice(1), wl.facts)
      const lines: { at: number; text: string }[] = []
      let pending = ''

      const child = spawn(launched.command, launched.args, {
        cwd: wl.facts.project ?? world.root,
        env: {
          ...wl.env,
          HERMES_DESKTOP_READY_FILE: readyFile,
          HERMES_PARENT_PID: String(parent),
          HERMES_PARENT_START_MARKER: marker,
          HERMES_PARENT_NONCE: 'matrix-idle'
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
      })

      const closed = new Promise(resolve => child.on('close', resolve))

      child.stdout.resume()
      child.stderr.on('data', chunk => {
        const parts = (pending + String(chunk)).split('\n')

        pending = parts.pop() ?? ''

        for (const text of parts) {
          lines.push({ at: Date.now(), text })
        }
      })

      const started = Date.now()

      while (!existsSync(readyFile) && Date.now() - started < 90_000) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }

      const readyAt = Date.now()

      await new Promise(resolve => setTimeout(resolve, IDLE_WINDOW_MS))

      try {
        process.kill(-(child.pid ?? 0), 'SIGTERM')
      } catch {
        // already gone
      }

      await closed

      const guard = lines.filter(line => line.text.startsWith('[icloneOS spawn guard]'))
      const idle = guard.filter(line => line.at >= readyAt)
      const repeated = guard.length - new Set(guard.map(line => line.text)).size

      evidence.guard = { boot: guard.length - idle.length, idle: idle.length, repeated, windowMs: IDLE_WINDOW_MS, lines: guard.map(line => line.text) }
      expect(existsSync(readyFile)).toBe(true)
      expect(idle.map(line => line.text)).toEqual([])
      expect(repeated).toBe(0)
    }, 180_000)

    it('loads its own .env as it does without the profile', async () => {
      const load = [
        '-c',
        'import os, hermes_bootstrap; from hermes_cli.env_loader import load_hermes_dotenv; load_hermes_dotenv(); print("key", bool(os.environ.get("OPENAI_API_KEY")))'
      ]

      const unconfined = await wl.run(load, { confined: false, timeoutMs: 30_000 })
      const inside = await wl.run(load, { confined: true, timeoutMs: 30_000 })

      expect({ code: unconfined.code, out: unconfined.out.trim() }).toEqual({ code: 0, out: 'key True' })
      expect({ code: inside.code, out: inside.out.trim(), err: inside.err.slice(-400) }).toEqual({
        code: 0,
        out: 'key True',
        err: unconfined.err.slice(-400)
      })
    }, 60_000)

    it('boots the backend to its ready file under the profile', async () => {
      const readyFile = path.join(world.readyDir, 'ready.json')

      const result = await wl.run(['-m', 'hermes_cli.main', 'serve', '--host', '127.0.0.1', '--port', '0'], {
        confined: true,
        env: { HERMES_DESKTOP_READY_FILE: readyFile },
        until: () => existsSync(readyFile),
        timeoutMs: 90_000
      })

      expect({ ready: existsSync(readyFile), err: existsSync(readyFile) ? '' : result.err.slice(-600) }).toEqual({
        ready: true,
        err: ''
      })
    }, 120_000)

    for (const where of ['self', 'child'] as const) {
      it(`${where}: what it needs is open, the rest of userData is EPERM, each paired with its unconfined control`, () => {
        const ok = (answer: string | undefined) => (answer?.startsWith('ok') ? 'ok' : answer)

        evidence[`refused-${where}`] = Object.fromEntries(
          probes
            .filter(probe => probe.expect === 'refused')
            .map(probe => [probe.id, { confined: confined[where]?.[probe.id], control: ok(plain[where]?.[probe.id]) }])
        )

        for (const probe of probes) {

          expect({ id: probe.id, plain: ok(plain[where]?.[probe.id]) }).toEqual({ id: probe.id, plain: 'ok' })
          expect({ id: probe.id, confined: ok(confined[where]?.[probe.id]) }).toEqual({
            id: probe.id,
            confined: probe.expect === 'allowed' ? 'ok' : 'EPERM'
          })
        }
      })
    }

    it('the helper interpreter main runs outside the sandbox is the layout’s own, trusted, and the launcher ran with it', () => {
      const helper = wl.layer.helperInterpreter()

      expect(helper).toEqual({ python: wl.memberPython, refusals: [] })

      const ready = wl.logs.find(line => /launcher ready \(pid \d+\)/.test(line))
      const pid = Number(/pid (\d+)/.exec(ready ?? '')?.[1])

      expect(pid).toBeGreaterThan(1)

      const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim()

      expect(command.startsWith(`${wl.memberPython} -I -S `)).toBe(true)
      expect(realpathSync(wl.memberPython)).toBe(realpathSync(world.pm?.python ?? world.facts.python))
    })

    // Last in the row: it stops the launcher.
    it('a held runtime with the launcher up folds without the plugin’s reason; with it stopped the terminal is withheld with the plain reason and the verdict is red', async () => {
      const up = await driveHeld('held-up')

      evidence.heldUp = { offered: up.driven.offered, ack: up.commands, runtime: up.state?.runtime.state, launcher: up.state?.runtime.launcher, verdict: up.state?.verdict, reasons: up.state?.reasons }

      expect(up.driven.offered).toContain('terminal')
      expect(up.commands).toMatchObject({ available: true, reason: '' })
      expect(up.state?.runtime).toMatchObject({ state: 'on', launcher: 'up' })
      expect(up.state?.reasons.map(reason => reason.code)).not.toContain('agent-commands-unavailable')

      await wl.layer.stopLauncher()

      const down = await driveHeld('held-down')

      evidence.heldDown = { offered: down.driven.offered, dispatchError: down.driven.dispatch?.error, ack: down.commands, verdict: down.state?.verdict, reasons: down.state?.reasons }

      expect(down.driven.offered).not.toContain('terminal')
      expect(down.driven.dispatch?.error ?? '').toContain('the launcher is not answering')
      expect(down.commands).toMatchObject({ available: false, reason: 'the launcher is not answering' })
      expect(down.state?.runtime).toMatchObject({ state: 'on', launcher: 'down' })
      expect(down.state?.reasons).toContainEqual({
        code: 'agent-commands-unavailable',
        reason: 'the launcher is not answering',
        reportedBy: 'runtime'
      })
      expect(down.state?.reasons).toContainEqual({ code: 'launcher-down' })
      expect(down.state?.verdict).toBe('red')
      // Nothing of the refused dispatch reached the launcher's ledger.
      expect(readRunEvents(runFiles(world.paths.userDataDir)).some(event => event.ev === 'start' && event.command === 'echo dispatch-held-down')).toBe(false)
    }, 420_000)
  })
}
