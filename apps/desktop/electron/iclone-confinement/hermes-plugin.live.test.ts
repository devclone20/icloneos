/**
 * V3-G — the one live lab test of the Hermes plugin: the real `SeatbeltEnvironment` (plugins/iclone-confinement)
 * running Hermes' own terminal wrapper under the profiles this TypeScript generated. Skipped when the Hermes venv is
 * not on this machine (`V3G_PY` points at it).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import type { RunnerTask } from 'vitest'
import { afterAll, describe, expect, it } from 'vitest'

import { pluginSpec } from './backend-seatbelt'
import { createLauncherWorld, probeAnswers, RUNTIME_PROBE, type RuntimeProbe } from './launcher-live-harness'
import { BROWSER_PROOF_TITLE, browserProofPlan, isThrowawayHome } from './live-guards'
import { createLiveWorld } from './live-harness'
import { probeVerdict } from './live-verdict.test-helpers'
import { SANDBOX_EXEC } from './probe'
import { launcherLedgerDir } from './runtime-profile'
import { readPs } from './state'

const REPO = path.resolve(import.meta.dirname, '../../../..')
const PY = process.env.V3G_PY ?? path.join(REPO, 'venv/bin/python')
const LIVE = process.platform === 'darwin' && existsSync(SANDBOX_EXEC) && existsSync(PY)

const DRIVER = `
import importlib.util, json, os, sys, types
ns = types.ModuleType("hermes_plugins"); ns.__path__ = []; sys.modules["hermes_plugins"] = ns
d = os.path.join(sys.argv[1], "plugins", "iclone-confinement")
spec = importlib.util.spec_from_file_location("hermes_plugins.iclone_confinement", os.path.join(d, "__init__.py"), submodule_search_locations=[d])
mod = importlib.util.module_from_spec(spec); sys.modules[spec.name] = mod; spec.loader.exec_module(mod)
from hermes_plugins.iclone_confinement import core
from hermes_plugins.iclone_confinement.seatbelt import SeatbeltEnvironment
from tools.file_operations import ShellFileOperations
# grant_params answers 0/0 with no policy module here: this driver's project is the one being written, its network refused.
core.grant_params = lambda session, project, window=None: {"NET": "0", "WRITE_PROJECT": "1"}
env = SeatbeltEnvironment(cwd=sys.argv[3], timeout=20, cls="project", index=core.parse_spec(sys.argv[2]), task_id="v3g-lab")
out = {"project": env.project_root}
for name, cmd in json.loads(sys.argv[4]).items():
    r = env.execute(cmd)
    out[name] = {"code": r.get("returncode"), "out": r.get("output", "")[-1200:]}
# A fresh environment: the shell probes above end with a cd outside the project, whose getcwd warnings would mix
# into the file tools' own output.
files = ShellFileOperations(SeatbeltEnvironment(cwd=sys.argv[3], timeout=20, cls="project", index=core.parse_spec(sys.argv[2]), task_id="v3g-lab-files"))
for name, (path, content) in json.loads(sys.argv[5]).items():
    w = files.write_file(path, content)
    out[name] = {"code": 1 if w.error else 0, "out": str(w.error or "")[-400:]}
r = files.read_file(json.loads(sys.argv[6]))
out["fileReadOutside"] = {"code": 1 if (r.error or "outside-secret" not in r.content) else 0, "out": (r.content or "")[-200:]}
# V3-UP r3 (critic r2 N2): a provisioned Hermes-managed Node (stubbed: its npx resolves the cwd's node_modules/.bin
# first, as real npx does) and a project that ships node_modules/.bin/tsc. A .ts write must not run that tsc on the
# host: the post-write lint goes through this confined shell or not at all.
import hermes_constants
hermes_constants.with_hermes_node_path = lambda env=None: dict(env or {}, PATH=sys.argv[7])
w = files.write_file(os.path.join(sys.argv[3], "lint.ts"), "let a: number = 1;\\n")
out["tsWrite"] = {"code": 1 if w.error else 0, "out": str(w.error or "")[-400:]}
print("V3G-JSON" + json.dumps(out))
`

// Starts one command through the plugin and exits at once: the run outlives its spawner, as a daemon would.
const DAEMON_DRIVER = `
import importlib.util, os, sys, types
ns = types.ModuleType("hermes_plugins"); ns.__path__ = []; sys.modules["hermes_plugins"] = ns
d = os.path.join(sys.argv[1], "plugins", "iclone-confinement")
spec = importlib.util.spec_from_file_location("hermes_plugins.iclone_confinement", os.path.join(d, "__init__.py"), submodule_search_locations=[d])
mod = importlib.util.module_from_spec(spec); sys.modules[spec.name] = mod; spec.loader.exec_module(mod)
from hermes_plugins.iclone_confinement import core
from hermes_plugins.iclone_confinement.seatbelt import SeatbeltEnvironment
env = SeatbeltEnvironment(cwd=sys.argv[3], timeout=20, cls="project", index=core.parse_spec(sys.argv[2]), task_id="v3g-lab-daemon")
proc = env._run_bash(sys.argv[4])
print("V3G-PID" + str(proc.pid))
`

// Ruling R1 (narrows ruling 56 for this site; was V3-UP r5, critic r4 N4): the built-in browser of a confined Hermes. The
// runtime under its own profile knocks on the launcher's door through the stub, and agent-browser and Chromium run OUTSIDE
// the Seatbelt, so file: is the door's and the tool's to refuse, not the profile's. A page that tries to leave for file: is
// Chromium's own rule, proven here. Unconfined (control) the same raw read shows the file, so a refusal above is the door's.
const BROWSER_DRIVER = `
import hermes_bootstrap
import importlib.util, json, os, sys, time, types
repo, spec_raw, project, outside_url, page_url, agent_browser, chrome, sync, web = sys.argv[1:10]
ns = types.ModuleType("hermes_plugins"); ns.__path__ = []; sys.modules["hermes_plugins"] = ns
d = os.path.join(repo, "plugins", "iclone-confinement")
spec = importlib.util.spec_from_file_location("hermes_plugins.iclone_confinement", os.path.join(d, "__init__.py"), submodule_search_locations=[d])
mod = importlib.util.module_from_spec(spec); sys.modules[spec.name] = mod; spec.loader.exec_module(mod)
from hermes_plugins.iclone_confinement import core, programs
from tools.environments import host_lane
core.trust_spec(spec_raw)
host_lane.register_program_confiner(programs.confine)
from tools import browser_tool as bt, browser_tool_install as inst
inst._find_agent_browser = lambda **k: agent_browser
inst._chromium_installed = lambda: True
if chrome:
    os.environ["AGENT_BROWSER_EXECUTABLE_PATH"] = chrome
os.environ["TERMINAL_CWD"] = project
out = {"guard": host_lane.spawn_guard_installed(), "confined": host_lane.confined_process()}
def snap():
    answer = json.loads(bt.browser_snapshot(full=True, task_id="lab"))
    return answer.get("snapshot") or json.dumps(answer)
command = lambda verb, args: bt._session._run_browser_command("lab", verb, args, timeout=60)
raw = lambda url: command("open", [url])
try:
    if out["confined"]:
        out["toolOutside"] = json.loads(bt.browser_navigate(url=outside_url, task_id="lab"))
        out["toolViewSource"] = json.loads(bt.browser_navigate(url="view-source:" + outside_url, task_id="lab"))
        out["toolProjectFile"] = json.loads(bt.browser_navigate(url="file://" + project + "/page.html", task_id="lab"))
    out["rawOutside"] = raw(outside_url)
    out["rawOutsideSnapshot"] = snap()
    out["rawProject"] = raw("file://" + project + "/page.html")
    out["rawProjectSnapshot"] = snap()
    # a spawn from code that is no lane of a confined process (the guard refuses it)
    marker = os.path.join(os.path.dirname(outside_url[len("file://"):]), "spawned-outside-the-lane")
    code = compile("import subprocess; subprocess.run(['/usr/bin/touch', %r])" % marker,
                   os.path.join(repo, "tools", "never_seen_by_the_inventory.py"), "exec")
    try:
        exec(code, {}); out["spawnOutsideLane"] = {"err": None}
    except Exception as exc:
        out["spawnOutsideLane"] = {"err": type(exc).__name__ + ": " + str(exc)}
    out["spawnOutsideLane"]["marker"] = os.path.exists(marker)
    # an app-fixed program's CHILD reading outside the roots: the real probe site, argv /bin/sh -c 'cat <outside>'
    from tui_gateway import host_supervisor
    try:
        out["appFixedChild"] = host_supervisor._check_output(["/bin/sh", "-c", "cat " + outside_url[len("file://"):]])
    except Exception as exc:
        out["appFixedChild"] = type(exc).__name__
    if out["confined"]:
        # the browser is up: a page over http, then that page trying to leave for the file. Chromium's rule, not the profile's.
        out["page"] = raw(page_url)
        out["pageSnapshot"] = json.dumps(command("snapshot", []))  # the tool's private-address check is not what is proven here
        out["leave"] = command("eval", ["location.href=" + json.dumps(outside_url) + ";'tried'"])
        time.sleep(1)
        out["leftUrl"] = command("get", ["url"])
        out["leftSnapshot"] = json.dumps(command("snapshot", []))
        # while it runs, the test asks the kernel whether this process and the browser are sandboxed
        with open(os.path.join(sync, "ready"), "w") as handle:
            handle.write(str(os.getpid()))
        for _ in range(600):
            if os.path.exists(os.path.join(sync, "checked")):
                break
            time.sleep(0.1)
    if web == "1":
        out["web"] = json.loads(bt.browser_navigate(url="https://example.com/", task_id="lab"))
        out["webSnapshot"] = snap()
finally:
    out["refusals"] = [w for _, w in host_lane.spawn_refusals()]
    try:
        bt.cleanup_browser("lab")
    except Exception:
        pass
print("V3UP-JSON" + json.dumps(out, default=str))
`

// sandbox_check(pid, NULL, 0): 1 when that process is under a sandbox, 0 when it is not.
const KERNEL_SAYS = `
import ctypes, json, sys
check = ctypes.CDLL("/usr/lib/libSystem.B.dylib").sandbox_check
check.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
print(json.dumps({pid: check(int(pid), None, 0) for pid in sys.argv[1:]}))
`

// Run by the Hermes interpreter under its own runtime profile, as main starts it: the plugin hands each confined
// command to the launcher through the stub (Seatbelt does not nest). Then one request the app never generated, carried
// to the launcher by the same stub path the plugin builds (core.via_launcher).
const RUNTIME_DRIVER = `
import importlib.util, json, os, subprocess, sys, types
repo, spec_raw, project, bait, marker = sys.argv[1:6]
ns = types.ModuleType("hermes_plugins"); ns.__path__ = []; sys.modules["hermes_plugins"] = ns
d = os.path.join(repo, "plugins", "iclone-confinement")
spec = importlib.util.spec_from_file_location("hermes_plugins.iclone_confinement", os.path.join(d, "__init__.py"), submodule_search_locations=[d])
mod = importlib.util.module_from_spec(spec); sys.modules[spec.name] = mod; spec.loader.exec_module(mod)
from hermes_plugins.iclone_confinement import core
from hermes_plugins.iclone_confinement.seatbelt import SeatbeltEnvironment
env = SeatbeltEnvironment(cwd=project, timeout=20, cls="project", index=core.parse_spec(spec_raw), task_id="runtime-proof")
out = {"confined": core.runtime_confined()}
for name, cmd in (("agentRun", "echo agent-ok-" + marker), ("agentBait", "cat " + bait)):
    r = env.execute(cmd)
    out[name] = {"code": r.get("returncode"), "out": r.get("output", "")[-1200:]}
# A request complete in every other way (the plugin's own parameters and token), only its profile text swapped, so the
# launcher refuses it for the profile and nothing else.
argv = env.sandbox_argv(["/bin/echo", "unknown-profile-" + marker], None)
argv[argv.index("-p") + 1] = "(version 1)(allow default)"
p = subprocess.run(argv, capture_output=True, text=True, timeout=30)
out["unknownProfile"] = {"code": p.returncode, "err": p.stderr[-300:], "out": p.stdout[-100:],
                         "viaStub": len(argv) > 3 and argv[3] == core.STUB}
print("RUNTIME-JSON" + json.dumps(out), flush=True)
`

const AGENT_BROWSER_SRC = [
  process.env.V3UP_AGENT_BROWSER,
  ...(existsSync(path.join(os.homedir(), '.npm/_npx'))
    ? readdirSync(path.join(os.homedir(), '.npm/_npx')).map(dir =>
        path.join(os.homedir(), '.npm/_npx', dir, 'node_modules/agent-browser/bin/agent-browser-darwin-arm64')
      )
    : [])
].find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate as string))

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const PM_LOCK = JSON.parse(readFileSync(path.join(REPO, 'pm/lock.json'), 'utf8')).packages as {
  'agent-browser': { version: string }
  chromium: { version: string }
}

const CHROMIUM_FOLDER = `chromium-${PM_LOCK.chromium.version.split('+')[0]}`

// The door runs only PM's Chromium at PM's path, so the gate's fixture carries it beside agent-browser.
const CHROMIUM_SRC = [
  process.env.V3UP_CHROMIUM,
  AGENT_BROWSER_SRC ? path.join(path.dirname(AGENT_BROWSER_SRC), '..', CHROMIUM_FOLDER) : undefined
].find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate as string))

const BROWSER_PROOF = browserProofPlan({
  fixture: CHROMIUM_SRC ? (AGENT_BROWSER_SRC ?? null) : null,
  chrome: existsSync(CHROME),
  inGate: process.env.ICLONE_LIVE_GATE === '1'
})

const world = LIVE ? createLiveWorld() : null

// Ruling 58: the README's Seatbelt claim stands only on this machine-checkable record — every live probe with what it
// expected and what it got, the app commit, the runtime pin and the interpreter they ran on, and one overall pass.
// Every probe (each denial AND its control) is recorded before the first `expect` of its test can throw, and the
// overall pass also requires vitest's own verdict on every test of this file: a red `it` never writes pass:true.
interface ProofProbe {
  name: string
  layer: string
  expect: string
  observed: string
  pass: boolean
}

const PROOF: ProofProbe[] = []
const ran = new Set<string>()

function probe(name: string, layer: string, expect: string, observed: unknown, pass: boolean) {
  PROOF.push({ name, layer, expect, observed: String(observed).slice(0, 300), pass })
}

function git(...args: string[]): string {
  return execFileSync('/usr/bin/git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim()
}

// vitest's final state of every test in this file (read in the file's afterAll, after each test and its hooks ended).
function testResults(task: RunnerTask): { name: string; state: string }[] {
  if (task.type === 'test') {
    return [{ name: task.name, state: task.result?.state ?? task.mode }]
  }

  return task.type === 'suite' ? task.tasks.flatMap(testResults) : []
}

// vitest 4 hands the file task as the 2nd argument; the 1st (fixtures) must be a destructuring pattern.
// eslint-disable-next-line no-empty-pattern
afterAll(({}, file) => {
  const target = process.env.V3UP_PROOF_FILE

  if (target && LIVE) {
    const dirty = git('status', '--porcelain', '--untracked-files=no') !== ''
    const complete = ['terminal', 'browser', 'runtime'].every(name => ran.has(name))
    const tests = file.tasks.flatMap(testResults)
    const runtimePin = JSON.parse(readFileSync(path.join(REPO, 'iclone', 'RUNTIME_PIN.json'), 'utf8')).sha

    writeFileSync(
      target,
      `${JSON.stringify(
        {
          schema: 'icloneos.confinement-proof/2',
          ruling: 58,
          generatedAt: new Date().toISOString(),
          appCommit: git('rev-parse', 'HEAD'),
          runtimeTree: git('rev-parse', 'HEAD^{tree}'),
          runtimeDirty: dirty,
          runtimePin,
          python: {
            version: execFileSync(PY, ['-I', '-c', 'import sys; print(sys.version)'], { encoding: 'utf8' }).trim(),
            sha256: createHash('sha256')
              .update(readFileSync(realpathSync(PY)))
              .digest('hex')
          },
          platform: `${process.platform} ${os.release()}`,
          testsRan: [...ran].sort(),
          tests,
          probes: PROOF,
          pass:
            complete &&
            !dirty &&
            typeof runtimePin === 'string' &&
            tests.length > 0 &&
            tests.every(test => test.state === 'pass') &&
            PROOF.length > 0 &&
            PROOF.every(item => item.pass)
        },
        null,
        1
      )}\n`
    )
  }

  world?.dispose()
})

describe.runIf(LIVE)('the Hermes plugin under the generated profiles', () => {
  it('confines Hermes’ own terminal: project in, secrets and outside writes out, keychain never', () => {
    if (!world) {
      return
    }

    execFileSync('/usr/bin/git', ['init', '-q', world.project])

    // Ruling 64.4: the credential denials are proven on REAL decoy files (Seatbelt answers ENOENT for a denied path that
    // does not exist, EPERM once it does). The decoys are planted only when HOME is a throwaway directory, never in a
    // real home; each is read unconfined as the control.
    const realHome = realpathSync(os.homedir())
    const throwawayHome = isThrowawayHome(realHome)

    // These probes try to write and read in HOME on purpose: if confinement failed, they would land in a real one.
    expect(throwawayHome, `the terminal probes need a throwaway HOME, got ${realHome}`).toBe(true)

    const decoys: Record<string, string> = {
      '~/.ssh': path.join(os.homedir(), '.ssh', 'id_decoy'),
      '~/.aws': path.join(os.homedir(), '.aws', 'credentials'),
      '~/.gnupg': path.join(os.homedir(), '.gnupg', 'pubring.kbx'),
      keychain: path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db')
    }

    if (throwawayHome) {
      for (const [name, file] of Object.entries(decoys)) {
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, `DECOY-${name.replace(/[^a-z]/g, '')}-${process.pid}\n`)
      }
    }

    const commands = {
      decoySsh: `cat ${decoys['~/.ssh']}`,
      decoyAws: `cat ${decoys['~/.aws']}`,
      decoyGnupg: `cat ${decoys['~/.gnupg']}`,
      decoyKeychain: `cat ${decoys.keychain}`,
      write: 'echo made > lab.txt && cat README.md && git status --short | head -3',
      readOutside: `cat ${world.outside}/secret.txt`,
      writeHome: `touch ${os.homedir()}/.iclone-v3g-lab`,
      keychain: `head -c 4 ${os.homedir()}/Library/Keychains/login.keychain-db`,
      ssh: `ls ${os.homedir()}/.ssh`,
      network: 'nc -z -G 2 1.1.1.1 443',
      cdThenWrite: `cd ${world.root} && echo x > cd-escape.txt`
    }

    // Hermes' file tools run as ShellFileOperations over this same terminal backend, so they are confined too (the
    // pane says so, F6): in the project they write, outside they are refused.
    const fileTools = {
      fileWriteInside: [path.join(world.project, 'tool.txt'), 'tool\n'],
      fileWriteOutside: [path.join(world.outside, 'tool-escape.txt'), 'escape\n']
    }

    // The critic's N2 trojan: an agent-writable node_modules/.bin/tsc that leaves a marker OUTSIDE the project.
    const tscMarker = path.join(world.outside, 'tsc-ran-on-the-host')
    const pmBin = path.join(world.root, 'pm-node-bin')
    mkdirSync(path.join(world.project, 'node_modules', '.bin'), { recursive: true })
    mkdirSync(pmBin, { recursive: true })
    writeFileSync(
      path.join(world.project, 'node_modules', '.bin', 'tsc'),
      `#!/bin/bash\necho "$0 $*" >> '${tscMarker}'\n`,
      {
        mode: 0o755
      }
    )
    writeFileSync(path.join(pmBin, 'npx'), '#!/bin/bash\ntool="$1"; shift\nexec "./node_modules/.bin/$tool" "$@"\n', {
      mode: 0o755
    })
    writeFileSync(path.join(pmBin, 'node'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })

    const raw = execFileSync(
      PY,
      [
        '-c',
        DRIVER,
        REPO,
        pluginSpec(world.paths, world.profiles),
        world.project,
        JSON.stringify(commands),
        JSON.stringify(fileTools),
        JSON.stringify(`${world.outside}/secret.txt`),
        pmBin
      ],
      {
        // The project is the launch directory: the operator-trusted default the critic's probe used.
        cwd: world.project,
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONPATH: REPO,
          HERMES_HOME: path.join(world.root, 'hermes-home'),
          ICLONE_CONFINEMENT: '1'
        },
        timeout: 120_000
      }
    )

    const result = JSON.parse(raw.slice(raw.indexOf('V3G-JSON') + 8)) as Record<
      string,
      { code: number; out: string }
    > & {
      project: string
    }

    ran.add('terminal')
    probe(
      'terminal: cat a file outside the roots',
      'seatbelt shell',
      'refused, no content',
      result.readOutside.out,
      probeVerdict(result.readOutside) === 'refused' && !result.readOutside.out.includes('outside-secret')
    )
    probe(
      'read_file outside the roots',
      'file tool (confined lane)',
      'no content',
      result.fileReadOutside.out,
      !result.fileReadOutside.out.includes('outside-secret')
    )
    probe(
      'write_file outside the roots',
      'file tool (confined lane)',
      'refused, nothing written',
      result.fileWriteOutside.out,
      result.fileWriteOutside.code !== 0 && !existsSync(path.join(world.outside, 'tool-escape.txt'))
    )
    probe('terminal: the login keychain', 'seatbelt shell', 'refused', result.keychain.out, probeVerdict(result.keychain) === 'refused')
    probe('terminal: ~/.ssh', 'seatbelt shell', 'refused', result.ssh.out, probeVerdict(result.ssh) === 'refused')

    if (throwawayHome) {
      const keyOf: Record<string, string> = {
        '~/.ssh': 'decoySsh',
        '~/.aws': 'decoyAws',
        '~/.gnupg': 'decoyGnupg',
        keychain: 'decoyKeychain'
      }

      for (const [name, file] of Object.entries(decoys)) {
        const r = result[keyOf[name]]
        probe(
          `terminal: decoy ${name} (a real file) denied`,
          'seatbelt shell',
          'EPERM: Operation not permitted, no content',
          r.out,
          r.code !== 0 && r.out.includes('Operation not permitted') && !r.out.includes('DECOY-')
        )
        let control = ''

        try {
          control = execFileSync('/bin/cat', [file], { encoding: 'utf8' })
        } catch (error) {
          control = String(error)
        }

        probe(
          `control: decoy ${name} read unconfined`,
          'no confinement',
          'shows the decoy',
          control,
          control.includes('DECOY-')
        )
      }
    }

    probe(
      'project tsc on a .ts write (N2)',
      'host lane',
      'never runs on the host',
      existsSync(tscMarker) ? 'ran' : 'not run',
      !existsSync(tscMarker)
    )
    probe(
      'terminal: a file inside the project',
      'seatbelt shell (control)',
      'readable',
      result.write.out,
      result.write.code === 0 && result.write.out.includes('inside')
    )
    probe(
      'terminal: write in the home directory',
      'seatbelt shell',
      'refused, nothing written',
      result.writeHome.out,
      probeVerdict(result.writeHome) === 'refused' && !existsSync(path.join(os.homedir(), '.iclone-v3g-lab'))
    )
    probe(
      'terminal: network without the grant',
      'seatbelt shell',
      'refused',
      result.network.out,
      result.network.code !== 0
    )
    probe(
      'terminal: cd out of the project, then write',
      'seatbelt shell',
      'refused, nothing written',
      result.cdThenWrite.out,
      probeVerdict(result.cdThenWrite) === 'refused' && !existsSync(path.join(world.root, 'cd-escape.txt'))
    )
    probe(
      'write_file inside the project',
      'file tool (confined lane, control)',
      'written',
      result.fileWriteInside.out,
      result.fileWriteInside.code === 0 && existsSync(path.join(world.project, 'tool.txt'))
    )
    probe(
      'write_file of a .ts inside the project (N2)',
      'file tool (confined lane, control)',
      'written',
      result.tsWrite.out,
      result.tsWrite.code === 0 && existsSync(path.join(world.project, 'lint.ts'))
    )
    expect(result.project).toBe(world.project)
    expect(result.write.code).toBe(0)
    expect(result.write.out).toContain('inside')
    expect(readFileSync(path.join(world.project, 'lab.txt'), 'utf8')).toBe('made\n')

    expect(result.fileWriteInside.code, result.fileWriteInside.out).toBe(0)
    expect(readFileSync(path.join(world.project, 'tool.txt'), 'utf8')).toBe('tool\n')
    expect(existsSync(path.join(world.outside, 'tool-escape.txt'))).toBe(false)
    expect(result.fileReadOutside.out).not.toContain('outside-secret')

    for (const name of ['readOutside', 'writeHome', 'keychain', 'ssh', 'cdThenWrite'] as const) {
      expect(probeVerdict(result[name]), name).toBe('refused')
    }

    for (const name of ['network', 'fileWriteOutside', 'fileReadOutside'] as const) {
      expect(result[name].code, name).not.toBe(0)
    }

    expect(result.readOutside.out).not.toContain('outside-secret')
    expect(result.tsWrite.code, result.tsWrite.out).toBe(0)
    expect(readFileSync(path.join(world.project, 'lint.ts'), 'utf8')).toBe('let a: number = 1;\n')
    expect(existsSync(tscMarker), 'the project tsc ran on the host (V3-UP r2 N2)').toBe(false)
    expect(existsSync(path.join(os.homedir(), '.iclone-v3g-lab'))).toBe(false)
    expect(existsSync(path.join(world.root, 'cd-escape.txt'))).toBe(false)
  }, 150_000)

  it(
    BROWSER_PROOF_TITLE,
    async ctx => {
      if (BROWSER_PROOF.state === 'missing-in-gate') {
        throw new Error(`the gate's browser proof cannot run: ${BROWSER_PROOF.why}`)
      }

      // Vitest's skip, which the gate reads as NOT RUN: a proof that did not run never counts as one that passed.
      if (BROWSER_PROOF.state === 'not-run') {
        console.warn(`NOT RUN: ${BROWSER_PROOF.why}`)
        ctx.skip()
      }

      if (!world || !AGENT_BROWSER_SRC || !CHROMIUM_SRC) {
        return
      }

      let web = '0'

      try {
        execFileSync('/usr/bin/curl', ['-sS', '-m', '8', '-o', '/dev/null', 'https://example.com/'])
        web = '1'
      } catch {
        // offline: the web leg is reported as not run, never as passed
      }

      const lab = await createLauncherWorld()
      const labHome = lab.hermesHome

      const processesOf = () =>
        execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
          .split('\n')
          .filter(line => line.includes(`${labHome}/tools/`))

      const server = http.createServer((_request, response) => {
        response.setHeader('content-type', 'text/html')
        response.end('<html><body><h1>PROJECT-PAGE-OK</h1></body></html>')
      })

      let confined: Record<string, any> = {}
      const kernel: { browser?: number; daemon?: number; runtime?: number } = {}
      let doorRows: string[] = []
      let seen: string[] = []

      try {
        // PM's layout under this world's Hermes home, as a real install leaves it: the door checks the digest on every knock.
        const tools = path.join(labHome, 'tools')
        const target = 'darwin-arm64'
        const agentBrowser = path.join(tools, `agent-browser-${PM_LOCK['agent-browser'].version}-${target}`, 'bin', `agent-browser-${target}`)

        mkdirSync(path.dirname(agentBrowser), { recursive: true })
        copyFileSync(AGENT_BROWSER_SRC, agentBrowser)
        execFileSync('/bin/chmod', ['755', agentBrowser])
        execFileSync('/bin/cp', ['-Rc', CHROMIUM_SRC, path.join(tools, CHROMIUM_FOLDER)])
        writeFileSync(path.join(lab.project, 'page.html'), '<html><body><h1>PROJECT-FILE-OK</h1></body></html>\n')
        writeFileSync(path.join(lab.outside, 'secret2.txt'), 'OUTSIDE-SECRET-N4\n')

        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
        const pageUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
        const driver = path.join(lab.project, 'browser-driver.py')
        const sync = path.join(lab.env.TMPDIR, 'n4')

        mkdirSync(sync, { mode: 0o700 })
        writeFileSync(driver, BROWSER_DRIVER)

        let finished = false

        const running = lab
          .run(
            ['-s', '-P', driver, REPO, lab.env.ICLONE_CONFINEMENT_SPEC, lab.project, `file://${lab.outside}/secret2.txt`, pageUrl, agentBrowser, '', sync, web],
            { confined: true, timeoutMs: 240_000 }
          )
          .finally(() => (finished = true))

        while (!finished && !existsSync(path.join(sync, 'ready'))) {
          await new Promise(resolve => setTimeout(resolve, 200))
        }

        if (existsSync(path.join(sync, 'ready'))) {
          // Each by the program it runs (a line is "pid ppid command"): the driver's argv names agent-browser too, Chromium's
          // helpers name it in their profile folder and have Chromium's own sandbox.
          const up = processesOf()

          const pidsOf = (program: RegExp) =>
            up.filter(line => program.test(line) && !line.includes('--type=')).map(line => line.trim().split(/\s+/)[0])

          const browserPids = pidsOf(/^\s*\d+\s+\d+\s+\S*\/chromium-\d+\//)
          const daemonPids = pidsOf(new RegExp(`^\\s*\\d+\\s+\\d+\\s+\\S*/bin/agent-browser-${target}`))
          const runtimePid = readFileSync(path.join(sync, 'ready'), 'utf8')

          const said = JSON.parse(
            execFileSync(PY, ['-I', '-c', KERNEL_SAYS, ...browserPids, ...daemonPids, runtimePid], { encoding: 'utf8' })
          ) as Record<string, number>

          // 0 only when there is one and none of them is sandboxed
          const worst = (pids: string[]) => (pids.length > 0 ? Math.max(...pids.map(pid => said[pid])) : undefined)

          seen = up.map(line => line.slice(0, 190))
          kernel.browser = worst(browserPids)
          kernel.daemon = worst(daemonPids)
          kernel.runtime = said[runtimePid]
          writeFileSync(path.join(sync, 'checked'), '')
        }

        const driven = await running

        if (!driven.out.includes('V3UP-JSON')) {
          throw new Error(`the browser driver ended (exit ${driven.code}) without its report\n${driven.err.slice(-1600)}\n${lab.logs.join('\n')}`)
        }

        confined = JSON.parse(driven.out.slice(driven.out.indexOf('V3UP-JSON') + 9)) as Record<string, any>
        doorRows = readFileSync(path.join(launcherLedgerDir(lab.userDataDir), 'runs.jsonl'), 'utf8')
          .split('\n')
          .filter(line => line.includes('the browser, outside the Seatbelt'))
      } finally {
        server.close()
        await lab.dispose()
      }

      // The launcher is gone, and its sitter with it: what the door started does not stay.
      let left = processesOf()

      for (let i = 0; i < 40 && left.length > 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 250))
        left = processesOf()
      }

      writeFileSync(path.join(world.root, 'v3up-browser-confined.json'), JSON.stringify({ confined, kernel, doorRows, left }, null, 1))
      ran.add('browser')

      // control: Seatbelt off, the browser runs as the upstream tool runs it, and the same raw read shows the file (so a
      // refusal above is the door's, not a missing file). Run before any expect, so the control is recorded whatever the
      // confined legs did.
      const store = path.join(world.root, 'store')
      const plainBrowser = path.join(store, 'agent-browser-0.26.0-darwin-arm64', 'bin', 'agent-browser-darwin-arm64')

      mkdirSync(path.dirname(plainBrowser), { recursive: true })
      copyFileSync(AGENT_BROWSER_SRC, plainBrowser)
      execFileSync('/bin/chmod', ['755', plainBrowser])
      writeFileSync(path.join(world.outside, 'secret2.txt'), 'OUTSIDE-SECRET-N4\n')

      const plainRaw = execFileSync(
        PY,
        ['-c', BROWSER_DRIVER, REPO, pluginSpec(world.paths, world.profiles), world.project, `file://${world.outside}/secret2.txt`, '', plainBrowser, CHROME, '', '0'],
        {
          cwd: world.project,
          encoding: 'utf8',
          env: {
            ...process.env,
            PYTHONPATH: REPO,
            HERMES_HOME: path.join(world.root, 'hermes-home'),
            ICLONE_CONFINEMENT: '0',
            HERMES_DISABLE_LAZY_INSTALLS: '1'
          },
          timeout: 240_000
        }
      )

      const plain = JSON.parse(plainRaw.slice(plainRaw.indexOf('V3UP-JSON') + 9)) as Record<string, any>

      writeFileSync(path.join(world.root, 'v3up-browser-plain.json'), JSON.stringify(plain, null, 1))

      probe(
        'spawn guard installed, browser driver confined',
        'host lane',
        'guard on, confined',
        `guard ${confined.guard} confined ${confined.confined}`,
        confined.guard === true && confined.confined === true
      )

      for (const name of ['toolOutside', 'toolViewSource', 'toolProjectFile']) {
        probe(
          `browser_navigate ${name}`,
          'browser tool (confined)',
          'refused: web pages only',
          JSON.stringify(confined[name]),
          confined[name]?.success === false && String(confined[name]?.error).includes('only web pages')
        )
      }

      // The door's own refusal by its words: a browser that failed to start for another reason is not this fact.
      const doorRefused = (answer: any) =>
        answer?.success === false && String(answer?.error).includes('is not one the browser tools send')

      const outsideSeen = JSON.stringify(confined.rawOutside) + confined.rawOutsideSnapshot
      probe(
        'browser file:// outside the roots, tool check bypassed',
        'launcher door',
        'refused, nothing shown',
        outsideSeen,
        doorRefused(confined.rawOutside) && !outsideSeen.includes('OUTSIDE-SECRET-N4')
      )
      const projectFileSeen = JSON.stringify(confined.rawProject) + confined.rawProjectSnapshot
      probe(
        'browser file:// inside the project, tool check bypassed',
        'launcher door',
        'refused too: the door takes no file:',
        projectFileSeen,
        doorRefused(confined.rawProject) && !projectFileSeen.includes('PROJECT-FILE-OK')
      )
      probe(
        'browser page over http',
        'launcher door (control)',
        'renders',
        confined.pageSnapshot,
        String(confined.pageSnapshot).includes('PROJECT-PAGE-OK')
      )
      const leftSeen = JSON.stringify(confined.leftUrl) + confined.leftSnapshot
      probe(
        'a page sends itself to file:// outside the roots',
        'Chromium (outside the Seatbelt)',
        'stays on its page, nothing shown',
        leftSeen,
        JSON.stringify(confined.leftUrl).includes('127.0.0.1') && !leftSeen.includes('OUTSIDE-SECRET-N4')
      )
      probe(
        'the browser and its daemon by the kernel',
        'sandbox_check(pid)',
        'runtime 1, daemon 0, browser 0',
        JSON.stringify(kernel),
        kernel.runtime === 1 && kernel.daemon === 0 && kernel.browser === 0
      )
      probe(
        'the launcher journals the browser as outside the Seatbelt',
        'launcher ledger',
        'at least one row per verb used',
        doorRows.length,
        doorRows.length > 0
      )
      probe('nothing left when the launcher stops', 'door sitter', 'no process', JSON.stringify(left), left.length === 0)
      probe(
        'a spawn outside every lane',
        'spawn guard',
        'refused, nothing ran',
        JSON.stringify(confined.spawnOutsideLane),
        confined.spawnOutsideLane?.marker === false && String(confined.spawnOutsideLane?.err).includes('PermissionError')
      )
      probe(
        'child of an app-fixed program reads outside the roots',
        'seatbelt (probe kind)',
        'no content',
        confined.appFixedChild,
        !String(confined.appFixedChild).includes('OUTSIDE-SECRET-N4')
      )
      probe(
        'browser https://example.com',
        'launcher door',
        web === '1' ? 'loads' : 'not run (offline)',
        `${confined.web?.title ?? ''} | ${confined.webSnapshot ?? 'not run'}`,
        web === '1' ? confined.web?.success === true && /Example Domain/.test(String(confined.web?.title)) : true
      )
      const browserRefusals = (confined.refusals ?? []).filter((why: string) => /browser|programs\.py/.test(why))
      probe(
        'the browser started only through its sealed door argv',
        'spawn guard',
        'never refused',
        JSON.stringify(browserRefusals),
        Array.isArray(confined.refusals) && browserRefusals.length === 0
      )
      probe(
        'control: unconfined, the same browser read',
        'no confinement',
        'shows the file',
        plain.rawOutsideSnapshot,
        plain.confined === false && String(plain.rawOutsideSnapshot).includes('OUTSIDE-SECRET-N4')
      )
      probe(
        'control: unconfined, the same app-fixed child',
        'no confinement',
        'shows the file',
        plain.appFixedChild,
        plain.confined === false && String(plain.appFixedChild).includes('OUTSIDE-SECRET-N4')
      )

      expect(confined.guard).toBe(true)
      expect(confined.confined).toBe(true)

      // 1. the tool: local schemes refused while confined
      for (const name of ['toolOutside', 'toolViewSource', 'toolProjectFile']) {
        expect(confined[name].success, name).toBe(false)
        expect(String(confined[name].error), name).toContain('only web pages')
      }

      // 2. the door, the tool's check bypassed: no file:, inside the roots or out. The profile is not what stops it now.
      expect(doorRefused(confined.rawOutside), JSON.stringify(confined.rawOutside)).toBe(true)
      expect(JSON.stringify(confined.rawOutside) + confined.rawOutsideSnapshot).not.toContain('OUTSIDE-SECRET-N4')
      expect(doorRefused(confined.rawProject), JSON.stringify(confined.rawProject)).toBe(true)
      expect(JSON.stringify(confined.rawProject) + confined.rawProjectSnapshot).not.toContain('PROJECT-FILE-OK')

      // 3. the browser does load pages, and a page cannot send itself to the file
      expect(confined.pageSnapshot, JSON.stringify(confined.page)).toContain('PROJECT-PAGE-OK')
      expect(JSON.stringify(confined.leftUrl)).toContain('127.0.0.1')
      expect(leftSeen).not.toContain('OUTSIDE-SECRET-N4')

      // 4. the new fact itself, by the kernel: the runtime is sandboxed, the browser and its daemon are not
      expect(kernel, seen.join('\n')).toEqual({ browser: 0, daemon: 0, runtime: 1 })
      expect(doorRows.length).toBeGreaterThan(0)
      expect(left).toEqual([])

      // 5. the web
      if (web === '1') {
        expect(confined.web.success, JSON.stringify(confined.web)).toBe(true)
        expect(`${confined.web.title} ${confined.webSnapshot}`).toMatch(/Example Domain/)
        expect(String(confined.webSnapshot)).toMatch(/domain/i)
      }

      expect(confined.spawnOutsideLane.marker).toBe(false)
      expect(String(confined.spawnOutsideLane.err)).toContain('PermissionError')
      expect(String(confined.appFixedChild)).not.toContain('OUTSIDE-SECRET-N4')
      // the browser itself was never refused: it started only through its sealed door argv (other refusals are the planted
      // spawn and Hermes' own git version lookups, which degrade to "unknown" by design, K173)
      expect(browserRefusals).toEqual([])

      expect(plain.confined).toBe(false)
      expect(plain.rawOutsideSnapshot).toContain('OUTSIDE-SECRET-N4')
      expect(String(plain.appFixedChild)).toContain('OUTSIDE-SECRET-N4')
      console.log(`[ruling R1, was N4] web leg ${web === '1' ? 'ran' : 'NOT RUN (offline)'}`)
    },
    600_000
  )

  it('F1 — main finds and stops a daemon the agent shell double-forked through the plugin', async () => {
    if (!world) {
      return
    }

    const daemon = `/usr/bin/perl -MPOSIX -e 'exit if fork; POSIX::setsid(); exit if fork; $0 = "v3g-plugin-daemon"; sleep 60'; /bin/sleep 60`

    const raw = execFileSync(
      PY,
      ['-c', DAEMON_DRIVER, REPO, pluginSpec(world.paths, world.profiles), world.project, daemon],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONPATH: REPO,
          HERMES_HOME: path.join(world.root, 'hermes-home'),
          ICLONE_CONFINEMENT: '1'
        },
        timeout: 60_000
      }
    )

    const root = Number(raw.slice(raw.indexOf('V3G-PID') + 7).trim())
    let daemonPid = 0

    for (let tries = 0; tries < 60 && !daemonPid; tries += 1) {
      const snapshot = await world.scan()

      daemonPid =
        snapshot.rows.find(
          row => row.run !== undefined && row.ppid === 1 && row.command.startsWith('v3g-plugin-daemon')
        )?.pid ?? 0
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    expect(daemonPid).toBeGreaterThan(0)

    const run = world.backend.list(await world.scan()).filter(item => item.root === root)

    expect(run.map(item => item.pid)).toContain(daemonPid)
    expect(await world.backend.kill(root)).toMatchObject({ ok: true })
    expect((await readPs()).some(row => row.pid === daemonPid || row.pid === root)).toBe(false)
  }, 90_000)

  it('the runtime under its own profile: decoys, secrets and sandbox-exec refused, agent commands go through the launcher', async () => {
    const lab = await createLauncherWorld()

    try {
      // Decoys are real files in this world's throwaway home: Seatbelt answers ENOENT for a denied path that does not
      // exist and EPERM once it does, and the unconfined control reads each one.
      const marker = `${process.pid}-${Date.now()}`

      const decoys = {
        outside: path.join(lab.home, 'Documents', 'decoy.txt'),
        ssh: path.join(lab.home, '.ssh', 'id_decoy'),
        keychain: path.join(lab.home, 'Library', 'Keychains', 'login.keychain-db')
      }

      for (const [name, file] of Object.entries(decoys)) {
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, `DECOY-${name}-${marker}\n`)
      }

      const ledger = path.join(launcherLedgerDir(lab.userDataDir), 'runs.jsonl')
      const refusedLedger = path.join(launcherLedgerDir(lab.userDataDir), 'refused.jsonl')
      const driver = path.join(lab.project, 'runtime-driver.py')
      const probeFile = path.join(lab.project, 'runtime-probe.py')

      writeFileSync(driver, RUNTIME_DRIVER)
      writeFileSync(probeFile, RUNTIME_PROBE)

      // 1. Agent commands from the confined runtime, through stub and launcher (this also starts the ledger).
      const driven = await lab.run(
        ['-s', '-P', driver, REPO, lab.env.ICLONE_CONFINEMENT_SPEC, lab.project, decoys.outside, marker],
        { confined: true, timeoutMs: 90_000 }
      )

      if (!driven.out.includes('RUNTIME-JSON')) {
        throw new Error(
          `the runtime driver ended (exit ${driven.code}) without its report\n${driven.err.slice(-1600)}\n${lab.logs.join('\n')}`
        )
      }

      const agent = JSON.parse(driven.out.slice(driven.out.indexOf('RUNTIME-JSON') + 12).split('\n')[0]) as {
        confined: boolean
        agentRun: { code: number; out: string }
        agentBait: { code: number; out: string }
        unknownProfile: { code: number; err: string; out: string; viaStub: boolean }
      }

      // 2. The runtime itself and an interpreter child it execs, each probe paired with the same run unconfined.
      const probes: RuntimeProbe[] = [
        { id: 'outside', k: 'cat', path: decoys.outside },
        { id: 'ssh', k: 'cat', path: decoys.ssh },
        { id: 'keychain', k: 'cat', path: decoys.keychain },
        { id: 'ledger', k: 'cat', path: ledger },
        { id: 'sandbox-exec', k: 'exec', argv: [SANDBOX_EXEC, '-p', '(version 1)(allow default)', '/usr/bin/true'] }
      ]

      const ask = async (confined: boolean) =>
        probeAnswers(await lab.run([probeFile, JSON.stringify(probes)], { confined, timeoutMs: 60_000 }))

      const confined = await ask(true)
      const plain = await ask(false)

      type LedgerRow = Record<string, unknown> & { ev?: string; run?: string; command?: string }

      const rows = (file = ledger): LedgerRow[] =>
        existsSync(file)
          ? readFileSync(file, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map(line => JSON.parse(line) as LedgerRow)
          : []

      const startOf = (command: string) => rows().find(row => row.ev === 'start' && row.command === command)
      const endOf = (run: unknown) => rows().find(row => row.ev === 'end' && row.run === run)
      const agentCommand = `echo agent-ok-${marker}`
      const baitCommand = `cat ${decoys.outside}`

      for (
        let tries = 0;
        tries < 100 && !(endOf(startOf(agentCommand)?.run) && endOf(startOf(baitCommand)?.run));
        tries += 1
      ) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }

      const agentStart = startOf(agentCommand)
      const agentEnd = endOf(agentStart?.run)
      const baitStart = startOf(baitCommand)
      const baitEnd = endOf(baitStart?.run)

      // The launcher's refusals have their own file beside the journal, so they never rotate a start or end away.
      const refusedRow = rows(refusedLedger).find(
        row => row.ev === 'refused' && row.command === `/bin/echo unknown-profile-${marker}`
      )

      const appProfiles = new Set(lab.layer.profiles().map(profile => profile.sha256))
      ran.add('runtime')

      const said = (answer: string | undefined) =>
        answer === 'EPERM' ? 'EPERM (Operation not permitted)' : String(answer)

      const deniedRead = (answer: string | undefined) => answer === 'EPERM'
      const shown = (answer: string | undefined, what: string) => String(answer).startsWith(`ok ${what}`)

      probe(
        'runtime: read a decoy outside its roots',
        'runtime profile (Hermes itself)',
        'EPERM (Operation not permitted), no content',
        said(confined.self.outside),
        deniedRead(confined.self.outside)
      )
      probe(
        'runtime child: an interpreter the runtime execs reads the same decoy',
        'runtime profile (inherited by the child)',
        'EPERM (Operation not permitted), no content',
        said(confined.child?.outside),
        deniedRead(confined.child?.outside)
      )
      probe(
        'control: runtime decoy outside the roots read unconfined',
        'no confinement',
        'shows the decoy (self and child)',
        `${plain.self.outside} | child ${plain.child?.outside}`,
        shown(plain.self.outside, 'DECOY-outside') && shown(plain.child?.outside, 'DECOY-outside')
      )

      for (const [id, what] of [
        ['ssh', 'the ~/.ssh decoy'],
        ['keychain', 'the keychain decoy'],
        ['ledger', 'the launcher ledger (runs.jsonl)']
      ] as const) {
        probe(
          `runtime: ${what} refused`,
          'runtime profile never list (self and child)',
          'EPERM (Operation not permitted), no content',
          `${said(confined.self[id])} | child ${said(confined.child?.[id])}`,
          deniedRead(confined.self[id]) && deniedRead(confined.child?.[id])
        )
        probe(
          `control: runtime ${what} read unconfined`,
          'no confinement',
          'shows the file (self and child)',
          `${plain.self[id]} | child ${plain.child?.[id]}`,
          id === 'ledger'
            ? shown(plain.self[id], '{') && shown(plain.child?.[id], '{')
            : shown(plain.self[id], `DECOY-${id}`) && shown(plain.child?.[id], `DECOY-${id}`)
        )
      }

      const execRefused = (answer: string | undefined) => ['EPERM', 'EACCES', 'exit71'].includes(String(answer))

      probe(
        'runtime: exec sandbox-exec directly',
        'runtime profile (self and child)',
        'refused (EPERM, EACCES or exit 71)',
        `${said(confined.self['sandbox-exec'])} | child ${said(confined.child?.['sandbox-exec'])}`,
        execRefused(confined.self['sandbox-exec']) && execRefused(confined.child?.['sandbox-exec'])
      )
      probe(
        'control: sandbox-exec runs unconfined',
        'no confinement',
        'ok (self and child)',
        `${plain.self['sandbox-exec']} | child ${plain.child?.['sandbox-exec']}`,
        plain.self['sandbox-exec'] === 'ok' && plain.child?.['sandbox-exec'] === 'ok'
      )
      probe(
        'launcher: the plugin in the confined runtime routes commands to the launcher',
        'confinement plugin (runtime confined)',
        'runtime confined, the stub carries the request',
        `confined ${agent.confined} · via stub ${agent.unknownProfile.viaStub}`,
        agent.confined && agent.unknownProfile.viaStub
      )
      probe(
        'launcher: an agent command runs inside the agent profile',
        'stub -> launcher -> agent profile',
        'exit 0 with its output; ledger start (an app profile) and end (code 0)',
        `exit ${agent.agentRun.code} · ${agent.agentRun.out.trim()} · start cls ${agentStart?.cls} sha ${String(agentStart?.sha).slice(0, 12)} app ${appProfiles.has(String(agentStart?.sha))} · end code ${agentEnd?.code}`,
        agent.agentRun.code === 0 &&
          agent.agentRun.out.includes(`agent-ok-${marker}`) &&
          agentStart?.kind === 'shell' &&
          appProfiles.has(String(agentStart?.sha)) &&
          agentEnd?.code === 0
      )
      probe(
        'launcher: the agent command reads the decoy outside the roots',
        'stub -> launcher -> agent profile',
        'refused: Operation not permitted, no content; ledger end non-zero',
        `exit ${agent.agentBait.code} · ${agent.agentBait.out.trim()} · end code ${baitEnd?.code}`,
        agent.agentBait.code !== 0 &&
          agent.agentBait.out.includes('Operation not permitted') &&
          !agent.agentBait.out.includes('DECOY-') &&
          baitStart !== undefined &&
          typeof baitEnd?.code === 'number' &&
          baitEnd.code !== 0
      )
      probe(
        'launcher: a request with a profile the app never generated',
        'stub -> launcher',
        'stub exits 126, refused; ledger row refused / profile-unknown; nothing ran',
        `exit ${agent.unknownProfile.code} · ${agent.unknownProfile.err.trim()} · ledger ${refusedRow?.ev}/${refusedRow?.code}`,
        agent.unknownProfile.code === 126 &&
          agent.unknownProfile.err.includes('Refused by icloneOS confinement') &&
          !agent.unknownProfile.out.includes('unknown-profile') &&
          refusedRow?.code === 'profile-unknown'
      )
      probe(
        'control: the same stub path with an app profile runs',
        'stub -> launcher -> agent profile',
        'exit 0 (the agent command above)',
        `exit ${agent.agentRun.code} · sha ${String(agentStart?.sha).slice(0, 12)} app ${appProfiles.has(String(agentStart?.sha))}`,
        agent.agentRun.code === 0 && appProfiles.has(String(agentStart?.sha))
      )

      expect(agent.confined).toBe(true)
      expect(agent.unknownProfile.viaStub).toBe(true)
      expect(confined.child, JSON.stringify(confined.child)).not.toHaveProperty('error')
      expect(plain.child, JSON.stringify(plain.child)).not.toHaveProperty('error')

      for (const id of ['outside', 'ssh', 'keychain', 'ledger']) {
        expect({ id, self: confined.self[id], child: confined.child?.[id] }).toEqual({
          id,
          self: 'EPERM',
          child: 'EPERM'
        })
        expect(plain.self[id], id).toMatch(/^ok \S/)
        expect(plain.child?.[id], id).toMatch(/^ok \S/)
      }

      expect(['EPERM', 'EACCES', 'exit71']).toContain(confined.self['sandbox-exec'])
      expect(['EPERM', 'EACCES', 'exit71']).toContain(confined.child?.['sandbox-exec'])
      expect(plain.self['sandbox-exec']).toBe('ok')
      expect(agent.agentRun, JSON.stringify(agent.agentRun)).toMatchObject({ code: 0 })
      expect(agent.agentRun.out).toContain(`agent-ok-${marker}`)
      expect(agentStart, JSON.stringify(rows())).toMatchObject({ kind: 'shell', cls: 'project' })
      expect(appProfiles.has(String(agentStart?.sha))).toBe(true)
      expect(agentEnd).toMatchObject({ code: 0 })
      expect(agent.agentBait.code).not.toBe(0)
      expect(agent.agentBait.out).toContain('Operation not permitted')
      expect(agent.agentBait.out).not.toContain('DECOY-')
      expect(baitEnd?.code).not.toBe(0)
      expect(agent.unknownProfile.code, agent.unknownProfile.err).toBe(126)
      expect(refusedRow, JSON.stringify(rows())).toMatchObject({ ev: 'refused', code: 'profile-unknown' })
    } finally {
      await lab.dispose()
    }
  }, 240_000)
})
