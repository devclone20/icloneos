/**
 * V3-G — the one live lab test of the Hermes plugin: the real `SeatbeltEnvironment` (plugins/iclone-confinement)
 * running Hermes' own terminal wrapper under the profiles this TypeScript generated. Skipped when the Hermes venv is
 * not on this machine (`V3G_PY` points at it).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { RunnerTask } from 'vitest'
import { afterAll, describe, expect, it } from 'vitest'

import { pluginSpec } from './backend-seatbelt'
import { createLiveWorld } from './live-harness'
import { SANDBOX_EXEC } from './probe'
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
env = SeatbeltEnvironment(cwd=sys.argv[3], timeout=20, cls="project", index=core.parse_spec(sys.argv[2]), task_id="v3g-lab")
out = {"project": env.project_root}
for name, cmd in json.loads(sys.argv[4]).items():
    r = env.execute(cmd)
    out[name] = {"code": r.get("returncode"), "out": r.get("output", "")[-400:]}
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

// V3-UP r5 (ruling 56, critic r4 N4): the built-in browser of a confined Hermes. agent-browser (from a store of its
// own) and Chrome run inside the agent's research profile, widened only by programs.py's browser needs. Three layers:
// the tool refuses local schemes; with that check bypassed the sandbox still shows nothing outside the roots while a
// project page and the web load; unconfined (control) the same bypassed read shows the file.
const BROWSER_DRIVER = `
import hermes_bootstrap
import importlib.util, json, os, sys, types
from pathlib import Path
repo, spec_raw, project, outside_url, store, agent_browser, chrome = sys.argv[1:8]
ns = types.ModuleType("hermes_plugins"); ns.__path__ = []; sys.modules["hermes_plugins"] = ns
d = os.path.join(repo, "plugins", "iclone-confinement")
spec = importlib.util.spec_from_file_location("hermes_plugins.iclone_confinement", os.path.join(d, "__init__.py"), submodule_search_locations=[d])
mod = importlib.util.module_from_spec(spec); sys.modules[spec.name] = mod; spec.loader.exec_module(mod)
from hermes_plugins.iclone_confinement import core, programs
from tools.environments import host_lane
core.trust_spec(spec_raw)
host_lane.register_program_confiner(programs.confine)
# the permission mode allows the network (V3-F decides that; its own tests cover the modes)
core.grant_params = lambda session, project: {"NET": "1", "WRITE_PROJECT": "1"}
import pm.paths
pm.paths.store_root = lambda: Path(store); pm.paths.writable_store_root = lambda: Path(store)
from tools import browser_tool as bt, browser_tool_install as inst
inst._find_agent_browser = lambda **k: agent_browser
inst._chromium_installed = lambda: True
os.environ["AGENT_BROWSER_EXECUTABLE_PATH"] = chrome
os.environ["TERMINAL_CWD"] = project
out = {"guard": host_lane.spawn_guard_installed(), "confined": host_lane.confined_process()}
snap = lambda: json.loads(bt.browser_snapshot(full=True, task_id="lab")).get("snapshot", "")
raw = lambda url: bt._session._run_browser_command("lab", "open", [url], timeout=60)
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
    out["appFixedChild"] = host_supervisor._check_output(["/bin/sh", "-c", "cat " + outside_url[len("file://"):]])
    if os.environ.get("V3UP_WEB") == "1":
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

const AGENT_BROWSER_SRC = [
  process.env.V3UP_AGENT_BROWSER,
  ...(existsSync(path.join(os.homedir(), '.npm/_npx'))
    ? readdirSync(path.join(os.homedir(), '.npm/_npx')).map(dir =>
        path.join(os.homedir(), '.npm/_npx', dir, 'node_modules/agent-browser/bin/agent-browser-darwin-arm64')
      )
    : [])
].find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate as string))

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

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
    const complete = ['terminal', 'browser'].every(name => ran.has(name))
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
    const throwawayHome = /^\/(private\/)?(tmp|var\/folders)\//.test(realHome)

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
      result.readOutside.code !== 0 && !result.readOutside.out.includes('outside-secret')
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
    probe('terminal: the login keychain', 'seatbelt shell', 'refused', result.keychain.out, result.keychain.code !== 0)
    probe('terminal: ~/.ssh', 'seatbelt shell', 'refused', result.ssh.out, result.ssh.code !== 0)

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
      result.writeHome.code !== 0 && !existsSync(path.join(os.homedir(), '.iclone-v3g-lab'))
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
      result.cdThenWrite.code !== 0 && !existsSync(path.join(world.root, 'cd-escape.txt'))
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

    for (const name of [
      'readOutside',
      'writeHome',
      'keychain',
      'ssh',
      'network',
      'cdThenWrite',
      'fileWriteOutside',
      'fileReadOutside'
    ] as const) {
      expect(result[name].code, name).not.toBe(0)
    }

    expect(result.readOutside.out).not.toContain('outside-secret')
    expect(result.tsWrite.code, result.tsWrite.out).toBe(0)
    expect(readFileSync(path.join(world.project, 'lint.ts'), 'utf8')).toBe('let a: number = 1;\n')
    expect(existsSync(tscMarker), 'the project tsc ran on the host (V3-UP r2 N2)').toBe(false)
    expect(existsSync(path.join(os.homedir(), '.iclone-v3g-lab'))).toBe(false)
    expect(existsSync(path.join(world.root, 'cd-escape.txt'))).toBe(false)
  }, 150_000)

  it.runIf(Boolean(AGENT_BROWSER_SRC) && existsSync(CHROME))(
    'V3-UP r5 N4 — the browser runs inside the agent’s Seatbelt: nothing outside the roots, project page and web load',
    () => {
      if (!world || !AGENT_BROWSER_SRC) {
        return
      }

      const store = path.join(world.root, 'store')
      const agentBrowser = path.join(store, 'agent-browser-0.26.0-darwin-arm64', 'bin', 'agent-browser-darwin-arm64')
      mkdirSync(path.dirname(agentBrowser), { recursive: true })
      copyFileSync(AGENT_BROWSER_SRC, agentBrowser)
      execFileSync('/bin/chmod', ['755', agentBrowser])
      writeFileSync(path.join(world.project, 'page.html'), '<html><body><h1>PROJECT-PAGE-OK</h1></body></html>\n')
      writeFileSync(path.join(world.outside, 'secret2.txt'), 'OUTSIDE-SECRET-N4\n')
      const outsideUrl = `file://${world.outside}/secret2.txt`
      let web = '0'

      try {
        execFileSync('/usr/bin/curl', ['-sS', '-m', '8', '-o', '/dev/null', 'https://example.com/'])
        web = '1'
      } catch {
        // offline: the web leg is reported as not run, never as passed
      }

      const run = (confined: boolean) => {
        const raw = execFileSync(
          PY,
          [
            '-c',
            BROWSER_DRIVER,
            REPO,
            pluginSpec(world.paths, world.profiles),
            world.project,
            outsideUrl,
            store,
            agentBrowser,
            CHROME
          ],
          {
            cwd: world.project,
            encoding: 'utf8',
            env: {
              ...process.env,
              PYTHONPATH: REPO,
              HERMES_HOME: path.join(world.root, 'hermes-home'),
              ICLONE_CONFINEMENT: confined ? '1' : '0',
              V3UP_WEB: confined ? web : '0',
              HERMES_DISABLE_LAZY_INSTALLS: '1'
            },
            timeout: 240_000
          }
        )

        return JSON.parse(raw.slice(raw.indexOf('V3UP-JSON') + 9)) as Record<string, any>
      }

      const confined = run(true)
      writeFileSync(path.join(world.root, 'v3up-browser-confined.json'), JSON.stringify(confined, null, 1))
      ran.add('browser')
      // control: unconfined, the same bypassed read shows the file (so a refusal above is the sandbox's, not a
      // missing file). Run before any expect, so the control is recorded whatever the confined legs did.
      const plain = run(false)
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
          confined[name].success === false && String(confined[name].error).includes('only web pages')
        )
      }

      const outsideSeen = JSON.stringify(confined.rawOutside) + confined.rawOutsideSnapshot
      probe(
        'browser file:// outside the roots, tool check bypassed',
        'seatbelt (agent-browser + Chrome)',
        'nothing shown',
        outsideSeen,
        !outsideSeen.includes('OUTSIDE-SECRET-N4')
      )
      probe(
        'browser page inside the project',
        'seatbelt (control)',
        'renders',
        confined.rawProjectSnapshot,
        String(confined.rawProjectSnapshot).includes('PROJECT-PAGE-OK')
      )
      probe(
        'a spawn outside every lane',
        'spawn guard',
        'refused, nothing ran',
        JSON.stringify(confined.spawnOutsideLane),
        confined.spawnOutsideLane.marker === false && String(confined.spawnOutsideLane.err).includes('PermissionError')
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
        'seatbelt + NET grant',
        web === '1' ? 'loads' : 'not run (offline)',
        `${confined.web?.title ?? ''} | ${confined.webSnapshot ?? 'not run'}`,
        web === '1' ? confined.web?.success === true && /Example Domain/.test(String(confined.web?.title)) : true
      )
      const browserRefusals = (confined.refusals ?? []).filter((why: string) => /browser|programs\.py/.test(why))
      probe(
        'the browser started only through its sealed sandbox argv',
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

      // 2. the sandbox, the tool's check bypassed: outside the roots nothing, the project page loads
      expect(JSON.stringify(confined.rawOutside) + confined.rawOutsideSnapshot).not.toContain('OUTSIDE-SECRET-N4')
      expect(confined.rawProjectSnapshot, JSON.stringify(confined.rawProject)).toContain('PROJECT-PAGE-OK')

      // 3. the web, under the mode's network grant
      if (web === '1') {
        expect(confined.web.success, JSON.stringify(confined.web)).toBe(true)
        expect(`${confined.web.title} ${confined.webSnapshot}`).toMatch(/Example Domain/)
        expect(String(confined.webSnapshot)).toMatch(/domain/i)
      }

      expect(confined.spawnOutsideLane.marker).toBe(false)
      expect(String(confined.spawnOutsideLane.err)).toContain('PermissionError')
      expect(String(confined.appFixedChild)).not.toContain('OUTSIDE-SECRET-N4')
      // the browser itself was never refused: it started only through its sealed sandbox argv (other refusals are
      // the planted spawn and Hermes' own git version lookups, which degrade to "unknown" by design, K173)
      expect(browserRefusals).toEqual([])

      expect(plain.confined).toBe(false)
      expect(plain.rawOutsideSnapshot).toContain('OUTSIDE-SECRET-N4')
      expect(String(plain.appFixedChild)).toContain('OUTSIDE-SECRET-N4')
      console.log(`[V3-UP r5 N4] web leg ${web === '1' ? 'ran' : 'NOT RUN (offline)'}`)
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
})
