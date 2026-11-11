/**
 * R19, then R31-R33: the kernel's copy of another process's command line and exec environment (sysctl KERN_PROCARGS2) is
 * refused to everything confined, measured with the real rendered runtime profile, the real launcher and main's real spawn
 * env, against the runtime itself and an unrelated process whose environment the kernel does show. Seatbelt lets that call
 * through when either half allows it (sysctl-read for an unnamed call, or process-info on the target), so these rows go red
 * the day a profile re-opens either half. It prints names, never values.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createLauncherWorld, type LauncherWorld } from './launcher-live-harness'
import { RUNTIME_ROOT, runtimeAvailable } from './runtime-live-harness'

/** Argument: pids. Answer: for each pid every route to it, the names in its KERN_PROCARGS2 environment, the parent's
 *  answer, and which of the facts the profiles keep open still answer (each by its name, the value never leaves). */
const BLOCK = String.raw`
import ctypes, errno, json, os, sys

def block(pid):
    libc = ctypes.CDLL(None, use_errno=True)
    mib = (ctypes.c_int * 3)(1, 49, pid)
    buf = ctypes.create_string_buffer(1 << 20)
    size = ctypes.c_size_t(1 << 20)
    if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0:
        return {"rc": errno.errorcode.get(ctypes.get_errno(), "?")}
    raw = buf.raw[:size.value]
    argc = int.from_bytes(raw[:4], "little")
    at = raw.index(b"\0", 4)
    while at < len(raw) and raw[at] == 0:
        at += 1
    parts = raw[at:].split(b"\0")
    names, secret_lengths = [], {}
    for part in parts[argc:]:
        if not part:
            break
        name, _, value = part.partition(b"=")
        name = name.decode("utf-8", "replace")
        names.append(name)
        if name in ("ICLONE_CONFINEMENT_LINK_KEY", "HERMES_DASHBOARD_SESSION_TOKEN"):
            secret_lengths[name] = len(value)
    return {"rc": 0, "names": sorted(names), "secret_lengths": secret_lengths}

def kinfo(pid):
    # kern.proc.pid, what psutil and ps read a process's parent and start time from: a refused call, or an empty answer.
    libc = ctypes.CDLL(None, use_errno=True)
    mib = (ctypes.c_int * 4)(1, 14, 1, pid)
    buf = ctypes.create_string_buffer(4096)
    size = ctypes.c_size_t(4096)
    if libc.sysctl(mib, 4, buf, ctypes.byref(size), None, 0) != 0:
        return errno.errorcode.get(ctypes.get_errno(), "?")
    return 0 if size.value > 0 else "empty"

def pidinfo(pid):
    libc = ctypes.CDLL(None, use_errno=True)
    buf = ctypes.create_string_buffer(256)
    return 0 if libc.proc_pidinfo(pid, 3, 0, buf, 136) > 0 else "refused"

def fact(name):
    libc = ctypes.CDLL(None, use_errno=True)
    size = ctypes.c_size_t(4096)
    buf = ctypes.create_string_buffer(4096)
    return 0 if libc.sysctlbyname(name.encode(), buf, ctypes.byref(size), None, 0) == 0 else errno.errorcode.get(ctypes.get_errno(), "?")

def routes(pid):
    return dict(block(pid), kinfo=kinfo(pid), pidinfo=pidinfo(pid))

asked = [int(a) for a in sys.argv[1:]]
facts = {n: fact(n) for n in ("kern.osrelease", "kern.ostype", "kern.osproductversion", "kern.version", "kern.hostname", "hw.ncpu", "hw.memsize", "machdep.cpu.brand_string")}
facts["os.cpu_count"] = 0 if os.cpu_count() else "none"
facts["os.uname"] = 0 if os.uname().release else "none"
print("BLOCK-JSON" + json.dumps({
    "self": routes(os.getpid()),
    "asked": {str(p): routes(p) for p in asked},
    "parent": routes(os.getppid()),
    "facts": facts,
    "named_route": fact("kern.procargs2"),
}), flush=True)
`

const DRIVER = String.raw`
import importlib.util, json, os, subprocess, sys, types
repo, spec_raw, script, sleeper = sys.argv[1:5]
ns = types.ModuleType("hermes_plugins"); ns.__path__ = []; sys.modules["hermes_plugins"] = ns
d = os.path.join(repo, "plugins", "iclone-confinement")
spec = importlib.util.spec_from_file_location("hermes_plugins.iclone_confinement", os.path.join(d, "__init__.py"), submodule_search_locations=[d])
mod = importlib.util.module_from_spec(spec); sys.modules[spec.name] = mod; spec.loader.exec_module(mod)
from hermes_plugins.iclone_confinement import core
from hermes_plugins.iclone_confinement.seatbelt import SeatbeltEnvironment
core.grant_params = lambda session, project, window=None: {"NET": "1", "WRITE_PROJECT": "1"}
me = os.getpid()
out = {"pid": me, "environ_has_link_key": "ICLONE_CONFINEMENT_LINK_KEY" in os.environ}
child = subprocess.run([sys.executable, "-I", "-S", script, str(me), sleeper], capture_output=True, text=True, timeout=30)
out["interpreter_child"] = child.stdout
env = SeatbeltEnvironment(cwd=os.getcwd(), timeout=30, cls="project", index=core.parse_spec(spec_raw), task_id="env-block")
r = env.execute("/usr/bin/python3 -I -S " + script + " " + str(me) + " " + sleeper)
out["command"] = r.get("output", "")
out["command_code"] = r.get("returncode")
r = env.execute("/bin/ps -E -ww -o command= -p " + sleeper + " 2>/dev/null | /usr/bin/grep -c FX35_PLANTED_NAME=")
out["ps_count"] = r.get("output", "").strip().split("\n")[0]
# fx35e (R41): each tool the sentence names, with what it says about the sleeper and whether it failed.
out["refused_tools"] = {}
for name, line in (("ps", "/bin/ps -o pid= -p " + sleeper), ("top", "/usr/bin/top -l 1 -pid " + sleeper + " -stats pid"), ("pgrep", "/usr/bin/pgrep -f FX35_PLANTED_NAME"), ("lsof", "/usr/sbin/lsof -p " + sleeper), ("nohup", "/usr/bin/nohup /usr/bin/true")):
    r = env.execute(line)
    text = r.get("output", "")
    out["refused_tools"][name] = {"code": r.get("returncode"), "names_it": sleeper in text.split(), "text": text[-160:]}
r = env.execute("/usr/bin/uname -r >/dev/null; echo uname=$?; /usr/sbin/sysctl -n hw.ncpu >/dev/null; echo ncpu=$?")
out["names_from_tools"] = r.get("output", "")
print("DRIVER-JSON" + json.dumps(out), flush=True)
os._exit(0)
`

interface BlockAnswer {
  rc: string | number
  kinfo?: string | number
  pidinfo?: string | number
  names?: string[]
  /** The length of a secret's value, the proof it is there; never the value. */
  secret_lengths?: Record<string, number>
  pid?: number
}

interface ProbeAnswer {
  self: BlockAnswer
  asked: Record<string, BlockAnswer>
  parent: BlockAnswer
  facts: Record<string, string | number>
  named_route: string | number
}

const parseProbe = (text: string): ProbeAnswer => {
  const at = text.indexOf('BLOCK-JSON')

  if (at < 0) {
    throw new Error(`no probe answer: ${text.slice(0, 600)}`)
  }

  return JSON.parse(text.slice(at + 'BLOCK-JSON'.length).split('\n')[0]) as ProbeAnswer
}

const live = runtimeAvailable()

const SLEEPER_NAME = 'FX35_PLANTED_NAME'

describe.skipIf(!live)('another process in the kernel, real profile and launcher (live, macOS Seatbelt)', () => {
  let world: LauncherWorld
  let sleeper: ChildProcess
  let child: ProbeAnswer
  let command: ProbeAnswer
  let plain: ProbeAnswer
  let driven: { pid: number; environ_has_link_key: boolean; command_code: number; ps_count: string; names_from_tools: string; refused_tools: Record<string, { code: number; names_it: boolean; text: string }> }

  const finish = (proc: ChildProcess, what: string) =>
    new Promise<string>((resolve, reject) => {
      let out = ''
      let err = ''
      const killer = setTimeout(() => proc.kill('SIGKILL'), 90_000)

      proc.stdout?.on('data', chunk => (out += String(chunk)))
      proc.stderr?.on('data', chunk => (err += String(chunk)))
      proc.on('close', code => {
        clearTimeout(killer)

        if (out.includes(what)) {
          resolve(out)
        } else {
          reject(new Error(`${what} never came (exit ${code})\n${err.slice(-1600)}\n${world.logs.join('\n')}`))
        }
      })
    })

  beforeAll(async () => {
    world = await createLauncherWorld()

    const script = path.join(world.project, 'block-probe.py')
    const driver = path.join(world.project, 'block-driver.py')

    writeFileSync(script, BLOCK)
    writeFileSync(driver, DRIVER)

    // What start-hermes.ts puts beside the layer's own keys; a throwaway value of the real length.
    world.env.HERMES_DASHBOARD_SESSION_TOKEN = randomBytes(32).toString('hex')

    const plainProbe = world.launch(['-I', '-S', script], false)

    // A process outside the world, nobody's child but the test's: the runtime's own interpreter (ad-hoc, linker-signed:
    // the kernel shows its environment to anyone it lets ask) with a planted name.
    sleeper = spawn(plainProbe.command, ['-I', '-S', '-c', 'import time; time.sleep(300)'], {
      env: { [SLEEPER_NAME]: randomBytes(16).toString('hex') },
      stdio: 'ignore',
      detached: true
    })
    sleeper.unref()

    const sleeperPid = String(sleeper.pid)
    const launch = world.launch(['-s', '-P', driver, RUNTIME_ROOT, world.layer.spawnEnv().ICLONE_CONFINEMENT_SPEC, script, sleeperPid], true)

    const stdout = await finish(
      spawn(launch.command, launch.args, { cwd: world.project, env: world.env, stdio: ['ignore', 'pipe', 'pipe'] }),
      'DRIVER-JSON'
    )

    const parsed = JSON.parse(stdout.slice(stdout.indexOf('DRIVER-JSON') + 'DRIVER-JSON'.length).split('\n')[0]) as typeof driven & {
      interpreter_child: string
      command: string
    }

    driven = parsed
    child = parseProbe(parsed.interpreter_child)
    command = parseProbe(parsed.command)
    plain = parseProbe(
      await finish(
        spawn(plainProbe.command, [...plainProbe.args, sleeperPid], { cwd: world.project, stdio: ['ignore', 'pipe', 'pipe'] }),
        'BLOCK-JSON'
      )
    )
  }, 120_000)

  afterAll(async () => {
    sleeper?.kill('SIGKILL')
    await world?.dispose()
  })

  // The control: unconfined, the kernel answers with the planted name, so a refusal below is the profile and not the target.
  it('outside confinement the sleeper is readable, with its planted name', () => {
    const block = plain.asked[String(sleeper.pid)]

    expect(block.rc).toBe(0)
    expect(block.names).toContain(SLEEPER_NAME)
    expect(block.kinfo).toBe(0)
  })

  it('the runtime popped the key from its environment, and each reader answered', () => {
    expect(driven.command_code).toBe(0)
    expect(driven.environ_has_link_key).toBe(false)
    expect(child.self.rc).toBe(0)
    expect(command.self.rc).toBe(0)
  })

  it('both readers get EPERM from the kernel for the runtime and for an unrelated process, and no name of theirs', () => {
    for (const who of [child, command]) {
      for (const pid of [driven.pid, sleeper.pid]) {
        const block = who.asked[String(pid)]

        expect({ pid: pid === driven.pid ? 'runtime' : 'sleeper', rc: block.rc }).toEqual({ pid: pid === driven.pid ? 'runtime' : 'sleeper', rc: 'EPERM' })
        expect(block.names).toBeUndefined()
        expect(block.secret_lengths).toBeUndefined()
      }
    }
  })

  it('the other routes to the same process answer nothing either: kern.proc.pid, proc_pidinfo, the parent, the name', () => {
    for (const who of [child, command]) {
      for (const block of [who.asked[String(driven.pid)], who.asked[String(sleeper.pid)], who.parent]) {
        expect(block.rc).toBe('EPERM')
        expect(block.kinfo).not.toBe(0)
        expect(block.pidinfo).toBe('refused')
      }

      expect(who.named_route).toBe('EPERM')
    }
  })

  it('fx35e (R41): ps, top, pgrep, lsof and nohup do not work inside confinement, and none of them names the sleeper', () => {
    const tools = driven.refused_tools

    expect(Object.keys(tools).sort()).toEqual(['lsof', 'nohup', 'pgrep', 'ps', 'top'])

    for (const [name, seen] of Object.entries(tools)) {
      expect(seen.code, `${name} ${seen.text}`).not.toBe(0)
      expect(seen.names_it, `${name} ${seen.text}`).toBe(false)
    }
  })

  it('/bin/ps run as a confined command finds nothing of the sleeper', () => {
    expect(driven.ps_count).toBe('0')
  })

  it('a reader still sees itself, and a confined command inherits no secret', () => {
    for (const who of [child, command]) {
      expect(who.self.kinfo).toBe(0)
      expect(who.self.pidinfo).toBe(0)
      expect(who.self.names).not.toContain('ICLONE_CONFINEMENT_LINK_KEY')
    }

    expect(command.self.names).not.toContain('HERMES_DASHBOARD_SESSION_TOKEN')
  })

  it.each(['kern.osrelease', 'kern.ostype', 'kern.osproductversion', 'kern.version', 'kern.hostname', 'hw.ncpu', 'hw.memsize', 'machdep.cpu.brand_string', 'os.cpu_count', 'os.uname'])('%s still answers both readers', name => {
    expect({ name, child: child.facts[name], command: command.facts[name] }).toEqual({ name, child: 0, command: 0 })
  })

  it('uname and sysctl hw.ncpu, the tools themselves, still answer a confined command', () => {
    expect(driven.names_from_tools).toContain('uname=0')
    expect(driven.names_from_tools).toContain('ncpu=0')
  })
})
