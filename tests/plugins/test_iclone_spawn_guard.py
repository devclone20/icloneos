"""V3-UP r4 (UP4-1, ruling 50) — in a confined process every process creation passes the host lane, at runtime.

Critic r3 N3: the r3 inventory followed calls one step from the tool layer, so cron job scripts, the MCP catalog
install, plugin/skill installs and lazy package installs started programs on the host unlisted. r4 enforces the rule
where it cannot be missed: ``hermes_bootstrap`` installs ``tools/environments/host_lane.py``'s audit hook at interpreter
start in every process icloneOS confines (exec-time ``ICLONE_CONFINEMENT=1``), and the hook refuses every
process-creation event that is not (a) the environment's own shell or (c) an app-fixed program at a listed site.

Every scenario runs in a FRESH interpreter started the way the app starts the runtime (``ICLONE_CONFINEMENT=1`` in its
exec-time environment, ``import hermes_bootstrap`` first), with a temp HOME/HERMES_HOME; a refused spawn must leave
no marker behind.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def _run(tmp_path: Path, body: str, *, confined: bool = True, timeout: int = 120, prelude: str = "") -> dict:
    """Run ``body`` after ``import hermes_bootstrap`` in a fresh interpreter; it prints one JSON line (RESULT=…)."""
    home = tmp_path / "home"
    hh = tmp_path / "hh"
    for d in (home, hh):
        d.mkdir(exist_ok=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith("ICLONE_")}
    env.update(HOME=str(home), HERMES_HOME=str(hh), PYTHONDONTWRITEBYTECODE="1", HERMES_DISABLE_LAZY_INSTALLS="1",
               npm_config_offline="true", TERMINAL_ENV="local")
    env["PYTHONPATH"] = os.pathsep.join([str(ROOT)] + [p for p in env.get("PYTHONPATH", "").split(os.pathsep) if p])
    if confined:
        env["ICLONE_CONFINEMENT"] = "1"
    script = prelude + "import hermes_bootstrap, json, os, sys\n" + textwrap.dedent(body)
    out = subprocess.run([sys.executable, "-c", script], cwd=str(tmp_path), env=env, capture_output=True, text=True,
                         timeout=timeout)
    lines = [ln for ln in out.stdout.splitlines() if ln.startswith("RESULT=")]
    assert lines, f"rc={out.returncode}\nstdout={out.stdout[-2000:]}\nstderr={out.stderr[-3000:]}"
    result = json.loads(lines[-1][len("RESULT="):])
    result["stderr"] = out.stderr
    return result


# A probe of one primitive: code COMPILED under a file name inside the runtime tree that no inventory row names
# (``tools/never_seen.py``) — what any new module, or a site the inventory missed, looks like to the guard.
_PRIMITIVES = {
    "subprocess.run": "import subprocess; subprocess.run(['/usr/bin/touch', M])",
    "subprocess.Popen": "import subprocess; subprocess.Popen(['/usr/bin/touch', M]).wait()",
    "subprocess.check_output": "import subprocess; subprocess.check_output(['/usr/bin/touch', M])",
    "os.system": "import os; os.system('/usr/bin/touch ' + M)",
    "os.popen": "import os; os.popen('/usr/bin/touch ' + M).read()",
    "os.posix_spawn": "import os; os.waitpid(os.posix_spawn('/usr/bin/touch', ['touch', M], dict(os.environ)), 0)",
    "os.spawnv": "import os; os.spawnv(os.P_WAIT, '/usr/bin/touch', ['touch', M])",
    "os.fork": "import os\npid = os.fork()\nif pid == 0:\n    open(M, 'w').close(); os._exit(0)\nos.waitpid(pid, 0)",
    "pty.spawn": "import pty; pty.spawn(['/usr/bin/touch', M])",
    "os.forkpty": "import os\npid, fd = os.forkpty()\nif pid == 0:\n    open(M, 'w').close(); os._exit(0)\nos.waitpid(pid, 0)",
    "asyncio.create_subprocess_exec": (
        "import asyncio\nasync def go():\n    p = await asyncio.create_subprocess_exec('/usr/bin/touch', M)\n"
        "    await p.wait()\nasyncio.run(go())"),
    "ctypes.system": "import ctypes; ctypes.CDLL(None).system(('/usr/bin/touch ' + M).encode())",
    # critic r4 m1: the paths without an audit event of their own, each closed in r5
    "_ctypes.dlsym (by handle)": (
        "import ctypes, _ctypes\nh = ctypes.CDLL(None)._handle\n"
        "f = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_char_p)(_ctypes.dlsym(h, 'system'))\n"
        "f(('/usr/bin/touch ' + M).encode())"),
    "_posixsubprocess.fork_exec": (
        "import _posixsubprocess, os\n"
        "r, w = os.pipe()\n"
        "base = ([b'touch', M.encode()], [b'/usr/bin/touch'], True, (r, w), None, None, -1, -1, -1, -1, -1, -1,"
        " r, w, True, False, -1, None, None, None, -1, None)\n"
        "try:\n    pid = _posixsubprocess.fork_exec(*base, False)\n"  # 3.11 backport: + use_vfork
        "except TypeError:\n    pid = _posixsubprocess.fork_exec(*base)\n"
        "os.close(w); os.read(r, 64); os.waitpid(pid, 0)"),
    "multiprocessing spawn": (
        "import multiprocessing as mp, os\n"
        "ctx = mp.get_context('spawn')\np = ctx.Process(target=os.getpid)\np.start(); p.join()\n"
        "open(M, 'w').close() if p.exitcode == 0 else None"),
    "concurrent ProcessPoolExecutor": (
        "import concurrent.futures as cf, os, multiprocessing as mp\n"
        "with cf.ProcessPoolExecutor(1, mp_context=mp.get_context('spawn')) as ex:\n"
        "    ex.submit(os.getpid).result(timeout=60)\n"
        "open(M, 'w').close()"),
    "os.execv (in a child)": (
        "import os, subprocess, sys\n"
        "subprocess.run([sys.executable, '-c', 'import os; os.execv(\"/usr/bin/touch\", [\"touch\", \"' + M + '\"])'])"),
}


def _probe(primitive: str, marker: Path, filename: str) -> str:
    code = f"M = {str(marker)!r}\n" + _PRIMITIVES[primitive]
    return f"""
        err = None
        try:
            exec(compile({code!r}, {filename!r}, "exec"), {{"__name__": "probe"}})
        except Exception as exc:
            err = f"{{type(exc).__name__}}: {{exc}}"
        print("RESULT=" + json.dumps({{"err": err, "marker": os.path.exists({str(marker)!r})}}))
    """


class TestEveryPrimitiveIsRefusedOutsideTheLane:
    @pytest.mark.parametrize("primitive", sorted(_PRIMITIVES))
    def test_a_spawn_from_a_module_the_inventory_never_saw_is_refused(self, tmp_path, primitive):
        marker = tmp_path / "outside" / "ran"
        marker.parent.mkdir()
        unseen = str(ROOT / "tools" / "never_seen_by_the_inventory.py")
        r = _run(tmp_path, _probe(primitive, marker, unseen))
        assert r["marker"] is False, (primitive, r)
        if primitive != "os.execv (in a child)":  # the child is refused before it runs; the parent sees no error
            assert r["err"] and "PermissionError" in r["err"] or "refused" in str(r["err"]), (primitive, r)
        assert "spawn guard" in r["stderr"] or primitive == "ctypes.system"

    def test_code_outside_the_runtime_tree_is_refused_too(self, tmp_path):
        marker = tmp_path / "ran"
        r = _run(tmp_path, _probe("subprocess.run", marker, str(tmp_path / "elsewhere.py")))
        assert r["marker"] is False and "PermissionError" in r["err"]

    @pytest.mark.parametrize("primitive", sorted(set(_PRIMITIVES) - {"os.execv (in a child)"}))
    def test_control_unconfined_the_same_probe_runs(self, tmp_path, primitive):
        """Every probe above is able to start a program: unconfined, the same code leaves its marker."""
        marker = tmp_path / "ran"
        unseen = str(ROOT / "tools" / "never_seen_by_the_inventory.py")
        r = _run(tmp_path, _probe(primitive, marker, unseen), confined=False)
        assert r["marker"] is True and r["err"] is None, (primitive, r)


class TestTheCriticsRowsAreRefusedAtRuntime:
    """K1/K12 (a cron job script, its workdir), K2 (an MCP catalog bootstrap), K3b (a git probe reached two hops away)
    — the real functions, in a confined process."""

    def test_k1_k12_a_cron_job_script_in_the_agents_workdir_never_runs(self, tmp_path):
        marker = tmp_path / "outside" / "cron-ran"
        r = _run(tmp_path, f"""
            from pathlib import Path
            scripts = Path(os.environ["HERMES_HOME"]) / "scripts"
            scripts.mkdir(parents=True, exist_ok=True)
            job = scripts / "job.sh"
            job.write_text("#!/bin/bash\\nmkdir -p {marker.parent}; touch {marker}\\n")
            job.chmod(0o755)
            from cron.scheduler_script import _run_job_script
            try:
                ok, out = _run_job_script(str(job), workdir={str(tmp_path)!r})
            except Exception as exc:
                ok, out = False, f"{{type(exc).__name__}}: {{exc}}"
            print("RESULT=" + json.dumps({{"ok": ok, "out": out[-300:], "marker": os.path.exists({str(marker)!r})}}))
        """)
        assert r["ok"] is False and r["marker"] is False, r
        assert "cron/scheduler_script.py::_run_job_script" in r["stderr"]

    def test_k2_an_mcp_catalog_bootstrap_never_runs(self, tmp_path):
        marker = tmp_path / "outside" / "bootstrap-ran"
        marker.parent.mkdir()
        r = _run(tmp_path, f"""
            from pathlib import Path
            from hermes_cli import mcp_catalog
            try:
                mcp_catalog._run_bootstrap(Path({str(tmp_path)!r}), ["touch {marker}"])
                err = None
            except Exception as exc:
                err = f"{{type(exc).__name__}}: {{exc}}"
            print("RESULT=" + json.dumps({{"err": err, "marker": os.path.exists({str(marker)!r})}}))
        """)
        assert r["marker"] is False and r["err"], r
        assert "hermes_cli/mcp_catalog.py::_run_bootstrap" in r["stderr"]

    def test_k3b_a_git_probe_two_hops_from_a_tool_never_runs(self, tmp_path):
        r = _run(tmp_path, f"""
            from hermes_cli._subprocess_compat import bounded_git_probe
            out = bounded_git_probe(["git", "-C", {str(tmp_path)!r}, "status"], timeout=5)
            print("RESULT=" + json.dumps({{"out": out}}))
        """)
        # the spawn happens in the probe's generic helper (hermes_cli/local_runtime/processes.py): refused there
        assert r["out"] == "" and "[icloneOS spawn guard] refused" in r["stderr"], r


class TestTheLaneItself:
    def test_a_confining_environments_shell_runs_and_a_host_environments_does_not(self, tmp_path):
        project = tmp_path / "proj"
        project.mkdir()
        r = _run(tmp_path, f"""
            from tools.environments.local import LocalEnvironment
            class Confining(LocalEnvironment):
                host_side_helpers = False
            out = {{}}
            env = Confining(cwd={str(project)!r}, timeout=30)
            out["confining"] = env.execute("echo through-the-shell").get("output", "")
            try:
                host = LocalEnvironment(cwd={str(project)!r}, timeout=30)
                out["host"] = host.execute("echo host").get("output", "")
            except Exception as exc:
                out["host"] = f"{{type(exc).__name__}}: {{exc}}"
            print("RESULT=" + json.dumps(out))
        """)
        assert "through-the-shell" in r["confining"], r
        assert "host" not in r["host"].split() or "PermissionError" in r["host"] or "refused" in r["host"], r

    def test_only_the_environment_code_itself_is_the_shell_lane(self, tmp_path):
        """A non-host environment's ``self`` on the stack is not enough: the (a) lane is the environment backends' own
        code (tools/environments/, the confinement plugin). A subclass defined anywhere else that starts a program
        from its own method is refused like any other site."""
        marker = tmp_path / "ran"
        src = (
            "import subprocess\n"
            "from tools.environments.local import LocalEnvironment\n"
            "class Elsewhere(LocalEnvironment):\n"
            "    host_side_helpers = False\n"
            "    def side_door(self, m):\n"
            "        subprocess.run(['/usr/bin/touch', m])\n"
        )
        unseen = str(ROOT / "tools" / "never_seen_by_the_inventory.py")
        r = _run(tmp_path, f"""
            ns = {{"__name__": "probe"}}
            exec(compile({src!r}, {unseen!r}, "exec"), ns)
            env = ns["Elsewhere"](cwd={str(tmp_path)!r}, timeout=30)
            err = None
            try:
                env.side_door({str(marker)!r})
            except Exception as exc:
                err = f"{{type(exc).__name__}}: {{exc}}"
            print("RESULT=" + json.dumps({{"err": err, "marker": os.path.exists({str(marker)!r})}}))
        """)
        assert r["marker"] is False and "PermissionError" in (r["err"] or ""), r

    # A stand-in for the confinement plugin's builder (plugins/iclone-confinement/programs.py, proved live in
    # hermes-plugin.live.test.ts): the hook does not read the profile, it lets a listed site start only the exact
    # sandbox-exec argv confine_program sealed.
    _FAKE_CONFINER = (
        "from tools.environments import host_lane\n"
        "host_lane.register_program_confiner(lambda argv, *, kind, env=None, reads=(), writes=(): "
        "(['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)', *argv], env))\n")

    def test_a_listed_site_runs_its_program_inside_the_sandbox(self, tmp_path):
        if sys.platform != "darwin":
            pytest.skip("sandbox-exec and sysctl hw.ncpu are macOS")
        r = _run(tmp_path, self._FAKE_CONFINER + textwrap.dedent("""
            from tools.transcription_local import _sysctl_value
            print("RESULT=" + json.dumps({"v": _sysctl_value("hw.ncpu"), "refusals": host_lane.spawn_refusals()}))
        """))
        assert r["v"] and str(r["v"]).strip().isdigit() and r["refusals"] == [], r

    def test_a_listed_site_without_a_confiner_runs_nothing(self, tmp_path):
        r = _run(tmp_path, """
            from tools.environments import host_lane
            from tools.transcription_local import _sysctl_value
            print("RESULT=" + json.dumps({"v": _sysctl_value("hw.ncpu")}))
        """)
        assert r["v"] == "", r

    def test_a_listed_site_starting_its_program_directly_is_refused(self, tmp_path):
        """Ruling 56: the allowlist decides WHICH program, never WHETHER it runs outside the sandbox."""
        r = _run(tmp_path, self._FAKE_CONFINER + textwrap.dedent("""
            frame_file = str(host_lane.RUNTIME_ROOT / "tools" / "transcription_local.py")
            code = "import subprocess\\ndef _sysctl_value():\\n    return subprocess.check_output(['/usr/sbin/sysctl', '-n', 'hw.ncpu'])\\n"
            ns = {}
            exec(compile(code, frame_file, "exec"), ns)
            try:
                ns["_sysctl_value"](); err = None
            except Exception as exc:
                err = f"{type(exc).__name__}: {exc}"
            print("RESULT=" + json.dumps({"err": err}))
        """))
        assert r["err"] and "only inside the agent's Seatbelt" in r["err"], r

    def test_a_sealed_argv_is_good_for_that_argv_once(self, tmp_path):
        r = _run(tmp_path, self._FAKE_CONFINER + textwrap.dedent("""
            import subprocess
            frame_file = str(host_lane.RUNTIME_ROOT / "tools" / "transcription_local.py")
            code = ("import subprocess\\ndef _sysctl_value(argv):\\n"
                    "    return subprocess.check_output(argv)\\n")
            ns = {}
            exec(compile(code, frame_file, "exec"), ns)
            argv, _ = host_lane.confine_program(["/usr/sbin/sysctl", "-n", "hw.ncpu"], kind="probe")
            out = {}
            for name, run in (("tampered", argv[:-1] + ["kern.hostname"]), ("sealed", argv), ("replayed", argv)):
                try:
                    ns["_sysctl_value"](run); out[name] = None
                except Exception as exc:
                    out[name] = f"{type(exc).__name__}: {exc}"
            print("RESULT=" + json.dumps(out))
        """))
        if sys.platform != "darwin":
            pytest.skip("sandbox-exec is macOS")
        assert r["sealed"] is None, r["sealed"]
        assert "PermissionError" in str(r["tampered"]), f"tampered ran: {r['tampered']}"
        assert "PermissionError" in str(r["replayed"]), f"replayed ran: {r['replayed']}"

    def test_the_runtimes_own_interpreter_starts_only_confined(self, tmp_path):
        """(h): a ``hermes`` site starts this runtime's interpreter only with ICLONE_CONFINEMENT=1 in the child's env
        (the child installs this guard first) — and nothing else."""
        r = _run(tmp_path, """
            from tools.environments import host_lane
            frame_file = str(host_lane.RUNTIME_ROOT / "plugins" / "web" / "ddgs" / "provider.py")
            code = ("import subprocess, sys, os\\ndef _spawn_worker(argv, env):\\n"
                    "    return subprocess.run(argv, env=env, capture_output=True).returncode\\n")
            ns = {}
            exec(compile(code, frame_file, "exec"), ns)
            confined = dict(os.environ, ICLONE_CONFINEMENT="1")
            bare = {k: v for k, v in os.environ.items() if k != "ICLONE_CONFINEMENT"}
            out = {}
            for name, argv, env in (("confined", [sys.executable, "-c", "pass"], confined),
                                    ("unconfined child", [sys.executable, "-c", "pass"], bare),
                                    ("another program", ["/usr/bin/true"], confined)):
                try:
                    out[name] = ns["_spawn_worker"](argv, env)
                except Exception as exc:
                    out[name] = f"{type(exc).__name__}: {exc}"
            print("RESULT=" + json.dumps(out))
        """)
        assert r["confined"] == 0, r
        assert "PermissionError" in str(r["unconfined child"]), f"unconfined child ran: {r['unconfined child']}"
        assert "PermissionError" in str(r["another program"]), f"another program ran: {r['another program']}"

    def test_the_hook_cannot_be_lifted_from_inside_the_process(self, tmp_path):
        """Critic r4 m1: rebinding exec_env, the old helper names, decide_spawn (and its __code__), the seals or the
        module state after install changes nothing — the decision is a closure built at install."""
        marker = tmp_path / "ran"
        r = _run(tmp_path, f"""
            from tools.environments import host_lane
            from hermes_cli import iclone_policy_env
            iclone_policy_env.exec_env = lambda name: None
            host_lane.confined_process = lambda: False
            host_lane._site_of = lambda *a, **k: ("tools/environments/local.py::x", [])
            host_lane._environment_on_stack = lambda frames: object()
            host_lane.decide_spawn.__code__ = (lambda *a, **k: (True, "lifted")).__code__
            host_lane.decide_spawn = lambda *a, **k: (True, "lifted")
            host_lane._build_decider = lambda **k: (lambda *a: (True, "lifted"))
            host_lane._SEALS = set()
            host_lane._state["installed"] = False
            host_lane.install_spawn_guard()
            code = compile("import subprocess; subprocess.run(['/usr/bin/touch', {str(marker)!r}])",
                           str(host_lane.RUNTIME_ROOT / "tools" / "never_seen.py"), "exec")
            try:
                exec(code, {{}}); err = None
            except Exception as exc:
                err = f"{{type(exc).__name__}}: {{exc}}"
            print("RESULT=" + json.dumps({{"err": err, "marker": os.path.exists({str(marker)!r})}}))
        """)
        assert r["marker"] is False and r["err"] and "PermissionError" in r["err"], r

    def test_the_guard_is_installed_at_interpreter_start_only_when_confined(self, tmp_path):
        body = """
            from tools.environments import host_lane
            print("RESULT=" + json.dumps({"on": host_lane.spawn_guard_installed()}))
        """
        assert _run(tmp_path, body)["on"] is True
        assert _run(tmp_path, body, confined=False)["on"] is False

    def test_an_environment_rewritten_before_the_bootstrap_cannot_skip_the_guard(self, tmp_path):
        """The install reads the EXEC-TIME value (the kernel's copy of what the app passed), not ``os.environ``: code
        that runs before the bootstrap (a ``.pth`` file, a sitecustomize, a wrapper) setting ICLONE_CONFINEMENT=0
        leaves the guard installed."""
        if sys.platform not in ("darwin",) and not sys.platform.startswith("linux"):
            pytest.skip("the exec-time reader exists on macOS and Linux")
        marker = tmp_path / "ran"
        unseen = str(ROOT / "tools" / "never_seen_by_the_inventory.py")
        r = _run(tmp_path, _probe("subprocess.run", marker, unseen),
                 prelude="import os\nos.environ['ICLONE_CONFINEMENT'] = '0'\n")
        assert r["marker"] is False and "PermissionError" in (r["err"] or "")

    def test_a_dotenv_cannot_switch_the_guard_off(self, tmp_path):
        """The decision reads the EXEC-TIME environment: ICLONE_CONFINEMENT=0 written later changes nothing."""
        marker = tmp_path / "ran"
        unseen = str(ROOT / "tools" / "never_seen_by_the_inventory.py")
        r = _run(tmp_path, "os.environ['ICLONE_CONFINEMENT'] = '0'\n" + textwrap.dedent(
            _probe("subprocess.run", marker, unseen)))
        assert r["marker"] is False and "PermissionError" in r["err"]


class TestNoBypassIsReachableFromTheTools:
    def test_no_shipped_module_reaches_a_launcher_the_guard_cannot_see(self):
        """What remains out of the hook's sight is native code that starts a program with no audit event: cffi's own
        dlopen/dlsym and the Objective-C runtime (NSTask). Residual by design — no agent path runs code inside the
        Hermes process — and none of it is used by the shipped runtime. ``_posixsubprocess`` and multiprocessing are
        covered (the probes above): the wrapper refuses every caller but subprocess' own audited path."""
        import ast

        sys.path.insert(0, str(ROOT))
        from tests.plugins.iclone_host_exec_sites import _in_scope

        hits = []
        for path in ROOT.rglob("*.py"):
            rel = path.relative_to(ROOT).as_posix()
            if not _in_scope(rel):
                continue
            try:
                tree = ast.parse(path.read_text(encoding="utf-8"))
            except (SyntaxError, UnicodeDecodeError):
                continue
            for node in ast.walk(tree):
                names = []
                if isinstance(node, ast.Import):
                    names = [a.name for a in node.names]
                elif isinstance(node, ast.ImportFrom) and node.module:
                    names = [node.module] + [f"{node.module}.{a.name}" for a in node.names]
                for n in names:
                    if n.split(".")[0] in ("_posixsubprocess", "cffi", "objc", "Foundation", "AppKit"):
                        hits.append(f"{rel}:{node.lineno} {n}")
                if isinstance(node, ast.Attribute) and node.attr in ("fork_exec", "spawnv_passfds", "NSTask"):
                    hits.append(f"{rel}:{node.lineno} .{node.attr}")
        allowed = {"tools/environments/host_lane.py"}  # the guard itself wraps fork_exec
        assert [h for h in hits if h.split(":")[0] not in allowed] == [], hits


class TestTheConfinedRuntimeStarts:
    def test_hermes_serve_reaches_ready_with_the_guard_on(self, tmp_path):
        """The real entry point the app spawns (``hermes serve``), confined: the backend gets ready; the only refusals
        are its own version/introspection git calls on its checkout (it degrades: the version reads unknown)."""
        import select
        import time

        home, hh = tmp_path / "home", tmp_path / "hh"
        home.mkdir()
        hh.mkdir()
        env = {k: v for k, v in os.environ.items() if not k.startswith("ICLONE_")}
        env.update(HOME=str(home), HERMES_HOME=str(hh), PYTHONDONTWRITEBYTECODE="1", ICLONE_CONFINEMENT="1",
                   HERMES_DISABLE_LAZY_INSTALLS="1", npm_config_offline="true", TERMINAL_ENV="local")
        env["PYTHONPATH"] = os.pathsep.join([str(ROOT)] + [p for p in env.get("PYTHONPATH", "").split(os.pathsep) if p])
        code = ("import hermes_bootstrap, sys\nfrom tools.environments import host_lane\n"
                "print('GUARD', host_lane.spawn_guard_installed(), file=sys.stderr, flush=True)\n"
                "sys.argv = ['hermes', 'serve', '--host', '127.0.0.1', '--port', '0']\n"
                "from hermes_cli.main import main\nmain()\n")
        proc = subprocess.Popen([sys.executable, "-c", code], cwd=str(tmp_path), env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)
        ready, out = False, ""
        try:
            deadline = time.time() + 120
            while time.time() < deadline and not ready:
                r, _, _ = select.select([proc.stdout], [], [], 1.0)
                if r:
                    line = proc.stdout.readline()
                    out += line
                    ready = "HERMES_BACKEND_READY" in line
                if proc.poll() is not None:
                    break
        finally:
            proc.terminate()
            try:
                _o, err = proc.communicate(timeout=30)
            except subprocess.TimeoutExpired:
                proc.kill()
                _o, err = proc.communicate()
        assert "GUARD True" in err and ready, (out[-2000:], err[-3000:])
        refused = [ln for ln in err.splitlines() if ln.startswith("[icloneOS spawn guard] refused")]
        assert all("(b) hermes_cli/" in ln for ln in refused), refused
