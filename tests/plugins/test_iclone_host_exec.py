"""V3-UP r3 (UP3-2, ruling 43) — nothing the confined tools trigger starts a program on the HOST around the sandbox.

Critic r2 N2: one ``write_file("a.ts")`` in a project holding an agent-writable ``node_modules/.bin/tsc`` ran that
``tsc`` from the Hermes process — the managed Node linter was gated by ``isinstance(env, LocalEnvironment)``, which the
seatbelt subclass satisfies. r2 had closed the read/search lane only. r3 closes the CLASS:

1. ENUMERATION — ``tests/plugins/iclone_host_exec_sites.py`` finds, by machine, every process-starting reference in
   the tool layer (tools/, agent/, the bundled plugins; any alias, call or callable, annotations skipped) and every
   tool-layer import of a spawn wrapper living elsewhere; ``plugins/iclone-confinement/tests/fixtures/
   host_exec_sites.json`` decides each one (verdict, what reaches it, why). A new call outside the fixture fails here.
   Every host-lane identity check (``isinstance(…, LocalEnvironment)``) is enumerated the same way.
2. ONE PREDICATE — ``tools/environments/host_lane.host_side_helpers_allowed``: a helper may run on the host only for
   a plain ``LocalEnvironment`` (or a subclass that declares it), never in a process icloneOS confines.
3. ONE TROJAN TEST PER GATED/HARDENED PATH — each runs the real code path with the critic's trojan (a program
   planted where that path would pick it up, writing a marker OUTSIDE the project); the control (a plain host
   environment, unconfined) shows the trojan really runs there, the confining case shows it never runs on the host.
4. THE LANE AS A WHOLE — an audit hook (``sys.addaudithook``) records every process the Hermes process starts while
   the confined tools' operations run against a confining environment: only that environment's own shell starts one.
"""

from __future__ import annotations

import ast
import json
import os
import shutil
import stat
import subprocess
import sys
import threading
import types
from pathlib import Path

import pytest

from hermes_cli import iclone_policy_env as E

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "plugins/iclone-confinement/tests/fixtures/host_exec_sites.json"
THIS = Path(__file__).resolve()


# ---------------------------------------------------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    """A temp HERMES_HOME (never the owner's) and the exec-time env reset after every test."""
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("TERMINAL_ENV", "local")
    monkeypatch.delenv("ICLONE_CONFINEMENT", raising=False)
    E._reset_for_tests({})
    yield home
    E._reset_for_tests(None)


def _confine():
    """As if icloneOS spawned this process with its confinement on (the EXEC-TIME env, not os.environ)."""
    E._reset_for_tests({"ICLONE_CONFINEMENT": "1"})


def _trojan(path: Path, marker: Path) -> Path:
    """A program that appends who ran it (``1`` inside a confining test env's shell, ``host`` otherwise) and exits."""
    path.parent.mkdir(parents=True, exist_ok=True)
    marker.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f'#!/bin/bash\nprintf "%s %s %s\\n" "${{ICLONE_TEST_IN_ENV:-host}}" "$0" "$*" >> "{marker}"\n'
                    "exit 0\n")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


def _host_lines(marker: Path) -> list:
    return [line for line in (marker.read_text().splitlines() if marker.exists() else []) if line.startswith("host ")]


def _project(tmp_path: Path) -> Path:
    project = tmp_path / "proj"
    project.mkdir()
    subprocess.run(["git", "init", "-q", str(project)], check=True, capture_output=True)
    return project


def _confining_env_class():
    from tools.environments.local import LocalEnvironment

    class Confining(LocalEnvironment):
        """A LocalEnvironment subclass that confines its shell, exactly as icloneOS' seatbelt declares itself; its
        children carry ICLONE_TEST_IN_ENV=1 so a marker tells an environment run from a host run."""

        host_side_helpers = False

        def _run_bash(self, cmd_string, **kwargs):
            _IN_ENV.flag = True
            try:
                return super()._run_bash(cmd_string, **kwargs)
            finally:
                _IN_ENV.flag = False

    return Confining


def _host_env_class():
    from tools.environments.local import LocalEnvironment

    class HostShell(LocalEnvironment):
        """The host itself (declared, so the predicate treats it exactly like a plain ``LocalEnvironment``); its own
        shell is flagged so the recorder lists only what runs BESIDE the environment's shell."""

        host_side_helpers = True

        def _run_bash(self, cmd_string, **kwargs):
            _IN_ENV.flag = True
            try:
                return super()._run_bash(cmd_string, **kwargs)
            finally:
                _IN_ENV.flag = False

    return HostShell


def _env(kind: str, project: Path):
    if kind == "host":
        return _host_env_class()(cwd=str(project), timeout=30)
    return _confining_env_class()(cwd=str(project), timeout=30, env={"ICLONE_TEST_IN_ENV": "1"})


# The audit hook (installed once per process; inert unless a test is recording).
_IN_ENV = threading.local()
_RECORD: dict = {"on": False, "spawns": []}
_SPAWN_EVENTS = {"subprocess.Popen", "os.system", "os.posix_spawn", "os.exec", "os.spawn", "os.fork", "os.forkpty",
                 "pty.spawn"}


def _audit(event, args):
    if _RECORD["on"] and event in _SPAWN_EVENTS and not getattr(_IN_ENV, "flag", False):
        what = args[1] if event == "subprocess.Popen" and len(args) > 1 else args[:1]
        _RECORD["spawns"].append((event, str(what)[:300]))


_HOOK_INSTALLED = False


class _recording:
    def __enter__(self):
        global _HOOK_INSTALLED
        if not _HOOK_INSTALLED:
            sys.addaudithook(_audit)
            _HOOK_INSTALLED = True
        _RECORD.update(on=True, spawns=[])
        return _RECORD["spawns"]

    def __exit__(self, *exc):
        _RECORD["on"] = False


# ---------------------------------------------------------------------------------------------------------------------
# 1. The enumeration
# ---------------------------------------------------------------------------------------------------------------------
@pytest.fixture(scope="module")
def sites_module():
    import importlib

    return importlib.import_module("tests.plugins.iclone_host_exec_sites")


def _functions_at(tree, qual: str) -> list:
    """Every function/class body named by ``qual`` (``Cls.method``, ``outer.inner``; a name may repeat)."""
    import ast

    nodes = [tree]
    for part in qual.split("."):
        nodes = [n for parent in nodes for n in ast.walk(parent)
                 if n is not parent and isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                 and n.name == part]
    return nodes


class TestEverySpawnSiteIsEnumerated:
    def test_the_committed_fixture_is_every_spawn_site_of_this_tree(self, sites_module):
        committed = json.loads(FIXTURE.read_text())
        live = sites_module.refresh(ROOT)
        added = sorted(set(live["sites"]) - set(committed["sites"]))
        removed = sorted(set(committed["sites"]) - set(live["sites"]))
        assert (added, removed) == ([], []), (
            f"spawn sites changed (new {added}, gone {removed}): run `python -m tests.plugins.iclone_host_exec_sites . "
            "--write` and decide every UNREVIEWED row")
        assert committed == live, "line numbers moved: regenerate the fixture (decisions are kept)"

    def test_every_site_is_one_of_the_four_outcomes_with_its_reason(self, sites_module):
        committed = json.loads(FIXTURE.read_text())["sites"]
        assert len(committed) >= 500  # the whole shipped runtime (r3's tool layer had 144)
        for key, row in committed.items():
            assert row["verdict"] in sites_module.VERDICTS, key
            assert row["why"].strip(), key
            if row["verdict"] == "a":
                assert key.startswith(sites_module.ENV_DIRS), key
            if row["verdict"] in ("c", "h"):  # justified with the program and file:line
                assert f"{key.split('::')[0]}:{row['line']}" in row["why"], key
            if row["verdict"] == "c":  # ruling 56: an app-fixed program runs inside the agent's Seatbelt
                assert row["why"].startswith("inside the agent's Seatbelt, "), key

    def test_the_runtime_allowlist_is_exactly_the_c_and_h_rows(self, sites_module):
        committed = json.loads(FIXTURE.read_text())
        allow = json.loads((ROOT / sites_module.ALLOWLIST_REL).read_text())
        assert allow["fixed"] == sites_module.fixed_sites(committed)
        assert allow["hermes"] == sites_module.fixed_sites(committed, "h")
        from tools.environments import host_lane

        assert host_lane._load_sites() == (frozenset(allow["fixed"]), frozenset(allow["hermes"]))

    def test_every_fixed_site_starts_its_program_through_confine_program(self, sites_module):
        """Ruling 56, statically: each ``fixed`` function builds its argv with ``host_lane.confine_program`` (the
        guard refuses anything else at runtime; this names the site that would be refused)."""
        import ast

        allow = json.loads((ROOT / sites_module.ALLOWLIST_REL).read_text())
        missing = []
        for site in allow["fixed"]:
            rel, qual = site.split("::", 1)
            tree = ast.parse((ROOT / rel).read_text(encoding="utf-8"))
            spawning = [n for n in _functions_at(tree, qual)
                        if any(isinstance(c, ast.Attribute) and isinstance(c.value, ast.Name)
                               and c.value.id == "subprocess" for c in ast.walk(n))]
            assert spawning, site
            for node in spawning:  # every same-named def that spawns (RPC handlers are all named ``_``)
                if not any(isinstance(n, ast.Name) and n.id == "confine_program" for n in ast.walk(node)):
                    missing.append(f"{site}:{node.lineno}")
        assert missing == [], missing

    def test_every_hermes_child_installs_the_guard_before_anything_else(self, sites_module):
        """(h): the code each ``hermes`` site starts imports hermes_bootstrap first (an entry point does by contract;
        the scripts load it by path), so the child of a confined Hermes is confined the same way."""
        import ast

        targets = {
            "plugins/google_meet/process_manager.py::start": "plugins/google_meet/meet_bot.py",
            "plugins/web/ddgs/provider.py::_spawn_worker": "plugins/web/ddgs/_search_worker.py",
            "tools/mcp_tool.py::_spawn_death_supervisor": "tools/mcp_death_supervisor.py",
            "tools/tts_tool_local.py::_run_helper": "tools/neutts_synth.py",
            "tui_gateway/host_supervisor.py::HostSupervisor._spawn_locked": "tui_gateway/compute_host.py",
            "tui_gateway/server.py::_SlashWorker.__init__": "tui_gateway/slash_worker.py",
            "tools/bot_mode_dm.py::_run_delivery": "hermes_cli/main.py",
            "tools/bot_mode_dm.py::_run_local_turn._turn": "hermes_cli/main.py",
        }
        allow = json.loads((ROOT / sites_module.ALLOWLIST_REL).read_text())
        assert sorted(targets) == allow["hermes"]
        late = []
        for site, target in targets.items():
            tree = ast.parse((ROOT / target).read_text(encoding="utf-8"))
            body = [n for n in tree.body
                    if not (isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant))  # the docstring
                    and not (isinstance(n, ast.ImportFrom) and n.module == "__future__")]
            # the loader's own stdlib imports may precede it; the first statement that does anything else must be it
            head = [n for n in body if not (isinstance(n, ast.Import) and all(a.name in ("importlib.util", "os", "sys")
                                                                               for a in n.names))]
            first = head[0] if head else None
            if isinstance(first, ast.If):  # the load must be what the condition decides, not text in a dead branch
                test = ast.unparse(first.test)
                ok = ("hermes_bootstrap" in test and "not in" in test) or (
                    test.replace("'", '"') == '__name__ == "__main__"' and "hermes_bootstrap" in ast.unparse(first.body[0]))
            else:
                ok = first is not None and "hermes_bootstrap" in ast.unparse(first)
            if not ok:
                late.append(f"{site} -> {target}: {ast.unparse(first)[:60] if first else '-'}")
        assert late == [], late

    def test_what_rulings_50_and_56_name_is_never_an_app_fixed_program(self, sites_module):
        """Cron job scripts, the MCP catalog install, plugin/skill installs, lazy package installs, project git probes,
        the lane-gated helpers and every config-chosen program (MCP stdio servers, secret sources, hooks): b."""
        committed = json.loads(FIXTURE.read_text())["sites"]
        must_be_b = ("cron/", "hermes_cli/mcp_catalog.py", "hermes_cli/plugins_cmd.py", "hermes_cli/skills_hub.py",
                     "pm/", "agent/coding_context.py", "hermes_cli/_subprocess_compat.py",
                     "tools/file_operations_lint.py", "agent/lsp/", "tools/checkpoint_manager.py",
                     "tools/read_extract.py", "agent/skill_preprocessing.py", "tools/subagent_worktree.py",
                     "agent/shell_hooks.py", "tools/browser_use_cli.py", "tools/mcp_tool_transport.py",
                     "agent/secret_sources/", "agent/vault_backends/", "agent/command_token_source.py",
                     "tools/tts_command_provider.py", "tools/file_operations_search.py", "tools/process_registry.py",
                     "tools/code_kernel.py", "skills/", "optional-skills/", "scripts/",
                     # r5 (ruling 56): programs that cannot run inside the agent's Seatbelt are refused when confined
                     "agent/anthropic_credentials.py", "tools/computer_use/", "tools/voice_mode.py",
                     "tools/mcp_oauth.py", "batch_runner.py",
                     # r5 (critic r4 m2): the modules bound onto tui_gateway/server.py
                     "tui_gateway/methods_tools.py", "tui_gateway/methods_complete_helpers.py")
        named = [k for k in committed if k.startswith(must_be_b)]
        assert len(named) > 100
        assert [k for k in named if committed[k]["verdict"] != "b"] == []

    def test_the_scanner_sees_every_spelling_of_a_spawn_and_skips_type_tests(self, sites_module, tmp_path):
        mod = tmp_path / "cron" / "new_job.py"
        mod.parent.mkdir(parents=True)
        mod.write_text(
            "import subprocess, os, asyncio, functools\n"
            "import subprocess as sp\n"
            "from subprocess import Popen as P\n"
            "def lint(path) -> subprocess.Popen:\n"
            "    subprocess.run(['npx', 'tsc', path])\n"
            "    sp.check_output(['node', '--check', path])\n"
            "    P(['python', '-m', 'x'])\n"
            "    os.system('npx eslint .')\n"
            "    runner = functools.partial(subprocess.run, check=False)\n"
            "    return asyncio.create_subprocess_exec('node')\n"
            "def annotated(p: subprocess.Popen) -> None:\n"
            "    x: subprocess.Popen = p\n"
            "    if isinstance(p, subprocess.Popen):\n"
            "        pass\n")
        (tmp_path / "tests").mkdir()
        (tmp_path / "tests" / "x.py").write_text("import subprocess\nsubprocess.run([])\n")
        (tmp_path / "apps").mkdir()
        (tmp_path / "apps" / "y.py").write_text("import subprocess\nsubprocess.run([])\n")
        found = sites_module.scan(tmp_path)
        assert sorted(found) == [
            "cron/new_job.py::lint::asyncio.create_subprocess_exec#1", "cron/new_job.py::lint::os.system#1",
            "cron/new_job.py::lint::subprocess.Popen#1", "cron/new_job.py::lint::subprocess.check_output#1",
            "cron/new_job.py::lint::subprocess.run#1", "cron/new_job.py::lint::subprocess.run#2"]

    def test_a_module_using_subprocess_as_a_bare_global_is_scanned(self, sites_module, tmp_path):
        """Critic r4 m2 (K-UP4a): tui_gateway binds modules onto server.py's globals (``method_ctx.bind_module``), so
        they call ``subprocess.run`` without importing it. A new such spawn is a new row."""
        mod = tmp_path / "tui_gateway" / "methods_complete_helpers.py"
        mod.parent.mkdir(parents=True)
        mod.write_text("def _git_repo_files(root):\n    return subprocess.run(['npx', 'tsc'])\n"
                       "def _quick(cmd):\n    return os.system(cmd)\n")
        assert sorted(sites_module.scan(tmp_path)) == [
            "tui_gateway/methods_complete_helpers.py::_git_repo_files::subprocess.run#1",
            "tui_gateway/methods_complete_helpers.py::_quick::os.system#1"]

    def test_the_scanner_sees_a_spawn_attribute_on_any_object(self, sites_module, tmp_path):
        """A module re-exporting the MCP SDK's names (``transport.stdio_client``) or an event loop's
        ``subprocess_exec``: the attribute name alone is the spawn, whatever object carries it."""
        mod = tmp_path / "agent" / "relay.py"
        mod.parent.mkdir(parents=True)
        mod.write_text("import transport\nasync def go(loop, p):\n    transport.stdio_client(p)\n"
                       "    await loop.subprocess_exec(p)\n    return transport.StdioServerParameters(command=p)\n")
        assert sorted(sites_module.scan(tmp_path)) == [
            "agent/relay.py::go::*.StdioServerParameters#1", "agent/relay.py::go::*.stdio_client#1",
            "agent/relay.py::go::*.subprocess_exec#1"]

    def test_the_scanner_sees_every_library_that_starts_a_program(self, sites_module, tmp_path):
        """Pty, process, browser, MCP stdio and Playwright launchers — a literal list, so a library dropped from the
        scanner's table fails here even while no shipped module uses it."""
        expected = ["anyio.open_process", "anyio.run_process", "mcp.StdioServerParameters",
                    "mcp.client.stdio.stdio_client", "pexpect.popen_spawn", "pexpect.run", "pexpect.spawn",
                    "playwright.async_api.async_playwright", "playwright.sync_api.sync_playwright",
                    "ptyprocess.PtyProcess", "ptyprocess.PtyProcessUnicode", "webbrowser.open", "webbrowser.open_new",
                    "webbrowser.open_new_tab", "winpty.PtyProcess", "multiprocessing.Pool", "multiprocessing.Process",
                    "multiprocessing.get_context", "multiprocessing.pool.Pool",
                    "concurrent.futures.ProcessPoolExecutor"]
        imports, calls = [], []
        for i, dotted in enumerate(expected):
            lib, name = dotted.rsplit(".", 1)
            imports.append(f"from {lib} import {name} as _{i}")
            calls.append(f"    _{i}('x')")
        mod = tmp_path / "cron" / "libs.py"
        mod.parent.mkdir(parents=True)
        mod.write_text("\n".join(imports) + "\ndef go():\n" + "\n".join(calls) + "\n")
        assert sorted(sites_module.scan(tmp_path)) == sorted(f"cron/libs.py::go::{d}#1" for d in expected)

    def test_a_new_site_gets_the_runtime_default_and_fails_the_equality_until_committed(self, sites_module, tmp_path):
        (tmp_path / "cron").mkdir()
        (tmp_path / "cron" / "t.py").write_text("import subprocess\ndef f():\n    subprocess.run(['npx', 'x'])\n")
        (tmp_path / "tools" / "environments").mkdir(parents=True)
        (tmp_path / "tools" / "environments" / "e.py").write_text("import subprocess\ndef g():\n    subprocess.run([])\n")
        rows = sites_module.refresh(tmp_path)["sites"]
        assert rows["cron/t.py::f::subprocess.run#1"]["verdict"] == "b"
        assert rows["tools/environments/e.py::g::subprocess.run#1"]["verdict"] == "a"


# Every identity check against LocalEnvironment in the tool layer, decided: a check that grants a HOST lane must be
# the predicate; the rest only describe the host's path namespace (a confining subclass shares it).
IDENTITY_CHECKS = {
    "tools/environments/host_lane.py::env_is_host": "THE predicate (type is LocalEnvironment, or a declared subclass)",
    "tools/file_operations_search.py::_normalized_filename_search_root": "path math (abspath/normpath), no I/O",
    "tools/file_operations_search.py::SearchMixin._quote_executable": "shell quoting of an executable name",
    "tools/file_operations_search.py::SearchMixin._is_broad_local_search_root":
        "a guard that REFUSES a recursive find of / or $HOME: kept on the host namespace (stricter, never a lane)",
    "tools/file_operations_search.py::SearchMixin._resolve_command": "Windows-only rg.exe candidates (_IS_WINDOWS)",
    "tools/file_operations_search.py::SearchMixin._search_files": "Windows-only MSYS→Windows path translation",
    "tools/tool_result_storage.py::_is_host_side_env":
        "writes Hermes' OWN spill file (tool output, a path Hermes chose) under HERMES_HOME; no agent path, no exec",
}


def _identity_checks(root: Path) -> set:
    found = set()
    for top in ("tools", "agent", "plugins"):
        for path in sorted((root / top).rglob("*.py")):
            rel = path.relative_to(root).as_posix()
            if "/tests/" in f"/{rel}" or path.name.startswith("test_") or rel.startswith("plugins/iclone-"):
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"))
            stack: list = []

            class V(ast.NodeVisitor):
                def _scoped(self, node):
                    stack.append(node.name)
                    self.generic_visit(node)
                    stack.pop()

                visit_FunctionDef = visit_AsyncFunctionDef = visit_ClassDef = _scoped

                def visit_Call(self, node):
                    if (isinstance(node.func, ast.Name) and node.func.id == "isinstance" and len(node.args) == 2
                            and "LocalEnvironment" in ast.unparse(node.args[1])):
                        found.add(f"{rel}::{'.'.join(stack)}")
                    self.generic_visit(node)

                def visit_Compare(self, node):
                    text = ast.unparse(node)
                    if "type(" in text and "LocalEnvironment" in text and any(isinstance(o, (ast.Is, ast.Eq))
                                                                            for o in node.ops):
                        found.add(f"{rel}::{'.'.join(stack)}")
                    self.generic_visit(node)

            V().visit(tree)
    return found


class TestEveryHostLaneIdentityCheckIsDecided:
    def test_no_isinstance_local_environment_grants_a_lane_outside_the_predicate(self):
        live = _identity_checks(ROOT)
        assert sorted(live - set(IDENTITY_CHECKS)) == [], "decide it: the predicate, or a namespace-only reason"
        assert sorted(set(IDENTITY_CHECKS) - live) == [], "a decided check is gone: drop its row"


# ---------------------------------------------------------------------------------------------------------------------
# 2. The predicate
# ---------------------------------------------------------------------------------------------------------------------
class TestTheOnePredicate:
    def test_a_host_helper_runs_only_for_the_host_itself(self, monkeypatch):
        from tools.environments.host_lane import host_side_helpers_allowed
        from tools.environments.local import LocalEnvironment

        bare = lambda cls: cls.__new__(cls)  # noqa: E731 — no shell spawned: only the predicate is under test

        class Undeclared(LocalEnvironment):
            pass

        class Declared(LocalEnvironment):
            host_side_helpers = True

        assert host_side_helpers_allowed(bare(LocalEnvironment)) is True
        assert host_side_helpers_allowed(bare(Undeclared)) is False  # a confining backend that forgot to say so
        assert host_side_helpers_allowed(bare(Declared)) is True
        assert host_side_helpers_allowed(bare(_confining_env_class())) is False
        assert host_side_helpers_allowed(object()) is False
        assert host_side_helpers_allowed() is True  # TERMINAL_ENV=local (fixture)
        for backend in ("iclone_seatbelt", "docker", "ssh"):
            monkeypatch.setenv("TERMINAL_ENV", backend)
            assert host_side_helpers_allowed() is False, backend
        monkeypatch.setenv("TERMINAL_ENV", "local")
        _confine()
        assert host_side_helpers_allowed(bare(LocalEnvironment)) is False  # a flipped backend in a confined Hermes
        assert host_side_helpers_allowed() is False

    def test_the_seatbelt_declares_itself_confining(self):
        from tests.plugins.test_iclone_core_port import TestNativeFileLane  # noqa: F401 (same loader as r2)

        seatbelt = _load_seatbelt()
        assert seatbelt.SeatbeltEnvironment.__dict__["host_side_helpers"] is False

    def test_a_dotenv_cannot_lift_the_confinement(self, monkeypatch):
        from tools.environments.host_lane import confined_process

        _confine()
        monkeypatch.setenv("ICLONE_CONFINEMENT", "0")  # what a .env / managed overlay could write later
        assert confined_process() is True


def _load_seatbelt():
    import importlib
    import importlib.util

    plugin_dir = ROOT / "plugins" / "iclone-confinement"
    if "hermes_plugins" not in sys.modules:
        ns = types.ModuleType("hermes_plugins")
        ns.__path__ = []
        sys.modules["hermes_plugins"] = ns
    if "hermes_plugins.iclone_confinement" not in sys.modules:
        spec = importlib.util.spec_from_file_location(
            "hermes_plugins.iclone_confinement", plugin_dir / "__init__.py", submodule_search_locations=[str(plugin_dir)])
        pkg = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = pkg
        spec.loader.exec_module(pkg)
    return importlib.import_module("hermes_plugins.iclone_confinement.seatbelt")


# ---------------------------------------------------------------------------------------------------------------------
# 3. One trojan test per gated / hardened path
# ---------------------------------------------------------------------------------------------------------------------
def _managed_node(tmp_path: Path, monkeypatch) -> None:
    """A provisioned Hermes-managed Node without a download: ``npx`` resolves the cwd's ``node_modules/.bin`` first,
    exactly what real npx does with a local bin; ``node`` is a stand-in that only reports."""
    bin_dir = tmp_path / "pm-node" / "bin"
    bin_dir.mkdir(parents=True)
    npx = bin_dir / "npx"
    npx.write_text('#!/bin/bash\ntool="$1"; shift\nexec "./node_modules/.bin/$tool" "$@"\n')
    node = bin_dir / "node"
    node.write_text("#!/bin/bash\nexit 0\n")
    for f in (npx, node):
        f.chmod(0o755)
    import hermes_constants

    monkeypatch.setattr(hermes_constants, "with_hermes_node_path",
                        lambda env=None: dict(env or {}, PATH=str(bin_dir)))


class TestTheConfinedLaneNeverRunsProjectCodeOnTheHost:
    def test_post_write_lint_never_runs_project_code_on_the_host_for_a_confining_env(self, tmp_path, monkeypatch):
        """The critic's N2 probe: one write_file("a.ts") with an agent-writable node_modules/.bin/tsc."""
        import agent.lsp
        from tools.file_operations import ShellFileOperations

        project = _project(tmp_path)
        marker = tmp_path / "outside" / "marker"
        _trojan(project / "node_modules" / ".bin" / "tsc", marker)
        _managed_node(tmp_path, monkeypatch)
        monkeypatch.setattr(agent.lsp, "get_service", lambda: None)  # the LSP tier has its own test below
        monkeypatch.chdir(project)  # the operator-trusted default: the project is the launch dir and the session cwd

        ops = ShellFileOperations(_env("host", project), cwd=str(project))
        ops.write_file(str(project / "a.ts"), "let a: number = 1;\n")
        assert _host_lines(marker), "control: on a plain host environment the trojan tsc runs on the host"

        for confined in (False, True):
            marker.unlink(missing_ok=True)
            if confined:
                _confine()
            ops = ShellFileOperations(_env("confining", project), cwd=str(project))
            with _recording() as spawns:
                result = ops.write_file(str(project / f"b{int(confined)}.ts"), "let b: number = 2;\n")
                ops.write_file(str(project / f"c{int(confined)}.js"), "let c = 3;\n")
            assert not getattr(result, "error", None), result
            assert _host_lines(marker) == [], (confined, marker.read_text())
            assert spawns == [], (confined, spawns)

    def test_lsp_server_never_spawns_on_the_host_for_a_confining_env(self, tmp_path, monkeypatch, _home):
        import agent.lsp
        from tools.file_operations import ShellFileOperations

        project = _project(tmp_path)
        marker = tmp_path / "outside" / "marker"
        server = _trojan(project / "node_modules" / ".bin" / "trojan-language-server", marker)
        (_home / "config.yaml").write_text(json.dumps({"lsp": {
            "install_strategy": "manual", "wait_timeout": 2.0, "idle_timeout": 0,
            "trusted_workspaces": [str(project)],
            "servers": {"trojan": {"command": [str(server)], "extensions": [".tro"]}}}}))
        monkeypatch.chdir(project)

        def fresh_service():
            agent.lsp._service = None
            agent.lsp._services_by_home.clear()

        fresh_service()
        try:
            ops = ShellFileOperations(_env("host", project), cwd=str(project))
            ops.write_file(str(project / "a.tro"), "x\n")
            assert _host_lines(marker), "control: the configured server starts on the host for a host environment"
        finally:
            svc = agent.lsp._service
            if svc is not None:
                svc.shutdown()
            fresh_service()
        for confined in (False, True):
            marker.unlink(missing_ok=True)
            if confined:
                _confine()
            for kind in ("confining", "host"):  # confined: even a plain host env (a flipped backend) gets no server
                if kind == "host" and not confined:
                    continue
                ops = ShellFileOperations(_env(kind, project), cwd=str(project))
                with _recording() as spawns:
                    ops.write_file(str(project / f"b{kind}{int(confined)}.tro"), "x\n")
                assert _host_lines(marker) == [] and spawns == [], (kind, confined, spawns)
                assert agent.lsp._service is None or kind == "confining"
        _confine()
        assert agent.lsp.get_service() is None

    def test_lsp_installer_is_refused_in_a_confined_process(self, tmp_path):
        from agent.lsp import install

        marker = tmp_path / "outside" / "marker"
        npm = _trojan(tmp_path / "bin" / "npm", marker)
        assert install._run_installer("npm", "pkg", [str(npm), "install", "pkg"], timeout=10) is True
        assert _host_lines(marker), "control: unconfined, the installer runs"
        marker.unlink()
        _confine()
        with _recording() as spawns:
            assert install._run_installer("npm", "pkg", [str(npm), "install", "pkg"], timeout=10) is False
        assert _host_lines(marker) == [] and spawns == []

    def test_native_file_lane_goes_through_the_environment_when_confining(self, tmp_path, monkeypatch):
        from tools.file_operations import ShellFileOperations

        project = _project(tmp_path)
        (project / "a.txt").write_text("needle\n")
        calls = []
        for name in ("_run_rg_native", "_read_file_native"):
            original = getattr(ShellFileOperations, name)

            def spy(self, *a, _name=name, _orig=original, **k):
                calls.append(_name)
                return _orig(self, *a, **k)

            monkeypatch.setattr(ShellFileOperations, name, spy)
        ops = ShellFileOperations(_env("host", project), cwd=str(project))
        ops.read_file(str(project / "a.txt"))
        ops.search("needle", path=str(project))
        if shutil.which("rg") or sys.platform != "win32":
            assert "_read_file_native" in calls, "control: the host env takes the native lane"
        for confined in (False, True):
            calls.clear()
            if confined:
                _confine()
            ops = ShellFileOperations(_env("confining", project), cwd=str(project))
            with _recording() as spawns:
                assert "needle" in ops.read_file(str(project / "a.txt")).content
                ops.search("needle", path=str(project))
            assert calls == [] and spawns == [], (confined, calls, spawns)

    def test_checkpoint_git_never_runs_on_the_host_when_confined(self, tmp_path, monkeypatch):
        from tools.checkpoint_manager import CheckpointManager

        project = _project(tmp_path)
        (project / "a.txt").write_text("1\n")
        mgr = CheckpointManager(enabled=True)
        with _recording() as spawns:
            assert mgr.ensure_checkpoint(str(project), "control") is True
        assert any("git" in what for _e, what in spawns), "control: a checkpoint is host git"
        assert mgr.unsupported_backend_reason() is None
        for setup in ("seatbelt-backend", "confined"):
            if setup == "confined":
                _confine()
            else:
                monkeypatch.setenv("TERMINAL_ENV", "iclone_seatbelt")
            mgr = CheckpointManager(enabled=True)
            with _recording() as spawns:
                assert mgr.ensure_checkpoint(str(project), setup) is False
            assert spawns == [], (setup, spawns)
            assert "not this host" in (mgr.unsupported_backend_reason() or ""), setup

    def test_pdf_page_scan_never_runs_on_the_host_when_confined(self, tmp_path, monkeypatch):
        from tools import read_extract

        marker = tmp_path / "outside" / "marker"
        bin_dir = tmp_path / "bin"
        _trojan(bin_dir / "pdftotext", marker)
        monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")
        pdf = tmp_path / "doc.pdf"
        pdf.write_bytes(b"%PDF-1.4\n%%EOF\n")
        read_extract._pdf_page_texts(str(pdf))
        assert _host_lines(marker), "control: pdftotext runs on the host"
        for setup in ("seatbelt-backend", "confined"):
            marker.unlink(missing_ok=True)
            if setup == "confined":
                _confine()
            else:
                monkeypatch.setenv("TERMINAL_ENV", "iclone_seatbelt")
            with _recording() as spawns:
                assert read_extract._pdf_page_texts(str(pdf)) is None
            assert _host_lines(marker) == [] and spawns == [], setup

    def test_skill_inline_shell_never_runs_on_the_host_when_confined(self, tmp_path, monkeypatch):
        from agent.skill_preprocessing import run_inline_shell

        marker = tmp_path / "outside" / "marker"
        marker.parent.mkdir()
        command = f"echo host x >> {marker}"
        run_inline_shell(command, tmp_path, 10)
        assert _host_lines(marker), "control: the snippet runs on the host"
        for setup in ("seatbelt-backend", "confined"):
            marker.unlink(missing_ok=True)
            if setup == "confined":
                _confine()
            else:
                monkeypatch.setenv("TERMINAL_ENV", "iclone_seatbelt")
            with _recording() as spawns:
                out = run_inline_shell(command, tmp_path, 10)
            assert out.startswith("[inline-shell disabled") and not marker.exists() and spawns == [], setup

    def test_shell_hooks_do_not_run_in_a_confined_process(self, tmp_path):
        from agent import shell_hooks

        marker = tmp_path / "outside" / "marker"
        hook = _trojan(tmp_path / "hooks" / "on-write.sh", marker)
        spec = shell_hooks.ShellHookSpec(event="pre_tool_call", command=str(hook), fail_closed=True)
        assert shell_hooks._spawn(spec, "{}")["returncode"] == 0
        assert _host_lines(marker), "control: the hook runs on the host"
        marker.unlink()
        _confine()
        with _recording() as spawns:
            result = shell_hooks._spawn(spec, "{}")
        assert result["error"] and _host_lines(marker) == [] and spawns == []
        verdict = shell_hooks._evaluate_result(spec, result)  # a fail_closed pre_tool_call hook that cannot run blocks
        assert isinstance(verdict, dict) and verdict.get("action") == "block", verdict

    def test_subagent_worktree_git_never_runs_on_the_host_when_confined(self, tmp_path, monkeypatch):
        from tools import subagent_worktree

        assert subagent_worktree.local_backend_active() is True  # control: config + live backend local
        monkeypatch.setenv("TERMINAL_ENV", "iclone_seatbelt")  # config.yaml still says local (stale)
        assert subagent_worktree.local_backend_active() is False
        monkeypatch.setenv("TERMINAL_ENV", "local")
        _confine()
        assert subagent_worktree.local_backend_active() is False
        from tools import delegate_tool, delegate_tool_child_run

        monkeypatch.setattr(delegate_tool, "_get_worktree_isolation", lambda: True)
        with _recording() as spawns:
            assert delegate_tool_child_run._create_isolated_worktree(types.SimpleNamespace(), "t1", "s1") is None
        assert spawns == []

    def test_browser_exec_never_runs_agent_python_in_a_confined_process(self, tmp_path, monkeypatch):
        from tools import browser_use_cli

        ran = []
        monkeypatch.setattr(browser_use_cli, "_run_cli_killing_process_group", lambda *a, **k: ran.append(a))
        # outside icloneOS the harness never imports from the inherited cwd (installed or not on this machine)
        monkeypatch.setattr(browser_use_cli, "_harness_site_dir", lambda: "/site-packages")
        cli = browser_use_cli._find_cli()
        assert cli == [sys.executable, "-P", "-m", "browser_harness.run"], cli
        _confine()
        assert browser_use_cli.is_browser_use_cli_mode() is False
        with _recording() as spawns:
            out = browser_use_cli.browser_exec("import os; os.system('touch /tmp/x')", task_id="t1")
        assert "not available here" in str(out) and ran == [] and spawns == []

    def test_python_m_children_never_import_from_the_inherited_cwd(self, tmp_path, monkeypatch):
        """``python -m X`` puts the cwd FIRST on the import path: a project that holds ``pip/``, ``piper/``,
        ``browser_harness/`` or ``plugins/google_meet/`` would run instead of the real module."""
        from tools import env_probe, tts_tool_local

        cwd = tmp_path / "proj"
        marker = tmp_path / "outside" / "marker"
        marker.parent.mkdir()
        body = f"open({str(marker)!r}, 'a').write('host ' + __name__ + '\\n')\n"
        for rel in ("pip/__init__.py", "pip/__main__.py", "piper/__init__.py", "piper/download_voices.py",
                    "trojan_mod/__init__.py", "trojan_mod/__main__.py", "plugins/__init__.py"):
            (cwd / rel).parent.mkdir(parents=True, exist_ok=True)
            (cwd / rel).write_text(body)
        monkeypatch.chdir(cwd)
        clean = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "PYTHONSAFEPATH")}

        subprocess.run([sys.executable, "-m", "trojan_mod"], cwd=cwd, env=clean, capture_output=True, timeout=60)
        assert _host_lines(marker), "control: -m from this cwd imports the planted module"
        marker.unlink()
        subprocess.run([sys.executable, "-P", "-m", "trojan_mod"], cwd=cwd, env=clean, capture_output=True, timeout=60)
        assert _host_lines(marker) == [], "-P: the cwd is not on the import path"

        # env_probe: `python -m pip --version` with the cwd pinned
        env_probe._has_pip_module(sys.executable)
        assert _host_lines(marker) == []

        # tts piper download: the argv carries -P before -m (captured, never executed: it would download)
        seen = []
        monkeypatch.setattr(tts_tool_local, "_run_helper", lambda cmd, timeout: seen.append(cmd) or
                            types.SimpleNamespace(returncode=1, stdout="", stderr="stub"))
        try:
            tts_tool_local._resolve_piper_voice_path("en_US-test", tmp_path / "voices")
        except Exception:  # noqa: BLE001 — only the argv matters here
            pass
        downloads = [c for c in seen if "piper.download_voices" in c]
        assert downloads and all(c[c.index("-m") - 1] == "-P" for c in downloads), seen

        # google_meet: the bot is resolved from Hermes' own tree
        from plugins.google_meet import process_manager

        popen = []

        class FakeProc:
            pid = 4242

        with monkeypatch.context() as patched:  # subprocess.Popen is global: patched only around the start
            patched.setattr(process_manager.subprocess, "Popen", lambda *a, **k: popen.append((a, k)) or FakeProc())
            try:
                process_manager.start("https://meet.google.com/abc-defg-hij", out_dir=tmp_path / "meet")
            except Exception:  # noqa: BLE001 — only the spawn's argv and cwd matter here
                pass
        assert popen, "process_manager.start did not reach its spawn"
        (argv,), kwargs = popen[0]
        assert argv[1:3] == ["-m", "plugins.google_meet.meet_bot"] and Path(kwargs["cwd"]) == ROOT
        probe = subprocess.run([sys.executable, "-c", "import plugins; print(plugins.__file__)"], cwd=kwargs["cwd"],
                               env=clean, capture_output=True, text=True, timeout=60)
        assert Path(probe.stdout.strip()).resolve() == (ROOT / "plugins" / "__init__.py").resolve()
        assert _host_lines(marker) == []

        # the TUI slash worker: -P before -m (its module comes from PYTHONPATH = Hermes' tree, never the cwd)
        from tui_gateway import server as tui_server

        started = []

        class _Stop(Exception):
            pass

        def _capture(argv, *a, **k):
            started.append(list(argv))
            raise _Stop

        with monkeypatch.context() as patched:
            patched.setattr(tui_server.subprocess, "Popen", _capture)
            with pytest.raises(_Stop):
                tui_server._SlashWorker("s-key", "")
        assert started and started[0][1:4] == ["-P", "-m", "tui_gateway.slash_worker"], started


    def test_mcp_stdio_servers_never_start_in_the_project_when_confined(self, tmp_path, monkeypatch, _home):
        """An MCP stdio server starts, by default, in the session's workspace; ``npx``/``npm exec`` resolve the cwd's
        ``node_modules/.bin`` first. In a confined process the default is a Hermes-owned empty directory."""
        from tools import mcp_tool_transport as T

        project = _project(tmp_path)
        marker = tmp_path / "outside" / "marker"
        _trojan(project / "node_modules" / ".bin" / "mcp-server-x", marker)
        npx = tmp_path / "bin" / "npx"  # npx's own resolution order: the cwd's local bins first
        npx.parent.mkdir()
        npx.write_text('#!/bin/bash\n[ "$1" = "-y" ] && shift\nexec "./node_modules/.bin/$1"\n')
        npx.chmod(0o755)
        monkeypatch.setenv("TERMINAL_CWD", str(project))
        config = {"command": str(npx), "args": ["-y", "mcp-server-x"]}

        def spawn(cwd):
            subprocess.run([str(npx), "-y", "mcp-server-x"], cwd=cwd, capture_output=True, timeout=30)

        _command, _env, cwd = T._stdio_launch(config)
        assert Path(cwd).resolve() == project.resolve(), "control: the default cwd is the project"
        spawn(cwd)
        assert _host_lines(marker), "control: npx in the project runs the project's binary on the host"
        marker.unlink()
        _confine()
        _command, _env, cwd = T._stdio_launch(config)
        assert Path(cwd).resolve() == (_home / "mcp" / "stdio-cwd").resolve()
        spawn(cwd)
        assert _host_lines(marker) == []
        assert T._stdio_launch(dict(config, cwd=str(project)))[2] == str(project), "the owner's explicit cwd wins"

    def test_piper_never_downloads_a_voice_while_confined(self, monkeypatch):
        """Ruling 56: piper's downloader is a third-party module with no guard that fetches and writes on its own;
        a confined Hermes does not start it (NeuTTS, Hermes' own script, still runs: it installs the guard first)."""
        import sys as _sys

        from tools import tts_tool_local
        from tools.environments import host_lane

        ran = []
        monkeypatch.setattr(tts_tool_local.subprocess, "run", lambda *a, **k: ran.append(a) or None)
        monkeypatch.setattr(host_lane, "confined_process", lambda: True)
        with pytest.raises(PermissionError, match="Piper voices are not downloaded"):
            tts_tool_local._run_helper([_sys.executable, "-P", "-m", "piper.download_voices", "en_US-x"], 5)
        tts_tool_local._run_helper([_sys.executable, "tools/neutts_synth.py", "--text", "x"], 5)
        monkeypatch.setattr(host_lane, "confined_process", lambda: False)
        tts_tool_local._run_helper([_sys.executable, "-P", "-m", "piper.download_voices", "en_US-x"], 5)
        assert len(ran) == 2  # neutts confined, piper unconfined (control)

    def test_the_confined_browser_opens_web_pages_only(self, monkeypatch):
        """Ruling 56 (critic r4 N4): confined, every scheme but http(s) (and about:blank) is refused before the
        navigation, judged after every wrapper is stripped, and a redirect that lands on one is blocked."""
        from tools import browser_tool
        from tools.environments import host_lane

        local = ["file:///etc/hosts", "FILE:///etc/hosts", "file://localhost/etc/hosts", "view-source:file:///etc/hosts",
                 " VIEW-SOURCE:file:///etc/hosts", "view-source:view-source:file:///etc/hosts",
                 "filesystem:file:///temporary/x", "blob:file:///abc", "chrome://version", "about:config",
                 "data:text/html,<a>", "javascript:alert(1)", "ftp://example.com/", "/etc/hosts"]
        web = ["https://example.com/", "http://example.com/a", "about:blank", "view-source:https://example.com/"]
        monkeypatch.setattr(host_lane, "confined_process", lambda: True)
        for url in local:
            err = browser_tool._local_scheme_error(url)
            assert err and "only web pages" in err["error"], url
        for url in web:  # a wrapper around a web page is still a web page
            assert browser_tool._local_scheme_error(url) is None, f"web page refused: {url}"
        calls = []
        monkeypatch.setattr(browser_tool._session, "_run_browser_command", lambda *a, **k: calls.append(a) or {})
        blocked = browser_tool._post_redirect_block("k", "https://example.com/", "file:///etc/hosts", False)
        assert blocked and "local file or page" in blocked and calls[0][2] == ["about:blank"]
        monkeypatch.setattr(host_lane, "confined_process", lambda: False)
        assert all(browser_tool._local_scheme_error(url) is None for url in local)  # control: the pin's behaviour

    def test_mcp_oauth_opens_only_a_web_page(self, monkeypatch):
        from tools import mcp_oauth

        opened = []
        monkeypatch.setattr(mcp_oauth, "_can_open_browser", lambda: True)
        monkeypatch.setattr(mcp_oauth.webbrowser, "open", lambda url: opened.append(url) or True)
        for url in ("file:///Applications/Calculator.app", "x-apple.systempreferences:com.apple.preference.security",
                    "javascript:alert(1)", "smb://host/share"):
            mcp_oauth._announce_authorization_url(url, 0, None)
        assert opened == []
        mcp_oauth._announce_authorization_url("https://auth.example.com/authorize?x=1", 0, None)
        assert opened == ["https://auth.example.com/authorize?x=1"]


# ---------------------------------------------------------------------------------------------------------------------
# 4. The lane as a whole, under the audit hook
# ---------------------------------------------------------------------------------------------------------------------
class TestTheWholeConfinedLane:
    def _exercise(self, ops, project: Path, tmp_path: Path) -> None:
        """Every confined-lane operation the file tools, their post-write checks and the agent loop run."""
        from agent import tool_executor
        from agent.skill_preprocessing import run_inline_shell
        from tools import read_extract, subagent_worktree
        from tools.checkpoint_manager import CheckpointManager

        for name, text in (("a.ts", "let a: number = 1;\n"), ("b.js", "let b = 2;\n"), ("c.py", "x = 1\n"),
                           ("d.json", "{}\n"), ("e.yaml", "a: 1\n"), ("f.toml", "a = 1\n"), ("g.go", "package a\n"),
                           ("h.rs", "fn main() {}\n"), ("i.tro", "x\n"), ("j.tsx", "let j = 1;\n")):
            ops.write_file(str(project / name), text)
        ops.patch_replace(str(project / "a.ts"), "a: number = 1", "a: number = 2")
        ops.read_file(str(project / "c.py"))
        ops.read_file_bytes(str(project / "c.py"))
        ops.search("x", path=str(project))
        ops.search("*.py", path=str(project), target="files")
        agent = types.SimpleNamespace(_checkpoint_mgr=CheckpointManager(enabled=True))
        tool_executor._ensure_file_checkpoint(agent, "write_file", {"path": str(project / "c.py")}, "t1")
        read_extract._pdf_page_texts(str(tmp_path / "doc.pdf"))
        run_inline_shell("echo inline", project, 10)
        subagent_worktree.local_backend_active()

    def _setup(self, tmp_path, monkeypatch, _home):
        import agent.lsp

        project = _project(tmp_path)
        marker = tmp_path / "outside" / "marker"
        for name in ("tsc", "eslint", "trojan-language-server"):
            _trojan(project / "node_modules" / ".bin" / name, marker)
        bin_dir = tmp_path / "bin"
        _trojan(bin_dir / "pdftotext", marker)
        (tmp_path / "doc.pdf").write_bytes(b"%PDF-1.4\n%%EOF\n")
        monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")
        _managed_node(tmp_path, monkeypatch)
        (_home / "config.yaml").write_text(json.dumps({"lsp": {
            "install_strategy": "manual", "wait_timeout": 2.0, "idle_timeout": 0, "trusted_workspaces": [str(project)],
            "servers": {"trojan": {"command": [str(project / "node_modules/.bin/trojan-language-server")],
                                   "extensions": [".tro"]}}}}))
        agent.lsp._service = None
        agent.lsp._services_by_home.clear()
        monkeypatch.chdir(project)
        return project, marker

    def test_control_a_plain_host_environment_starts_host_programs(self, tmp_path, monkeypatch, _home):
        """Proves the recorder sees what the confining case must not: lint, LSP, checkpoint git, pdftotext,
        inline shell all start host programs for a host environment."""
        import agent.lsp
        from tools.file_operations import ShellFileOperations

        project, marker = self._setup(tmp_path, monkeypatch, _home)
        ops = ShellFileOperations(_env("host", project), cwd=str(project))
        try:
            with _recording() as spawns:
                self._exercise(ops, project, tmp_path)
        finally:
            if agent.lsp._service is not None:
                agent.lsp._service.shutdown()
            agent.lsp._service = None
        joined = " ".join(what for _e, what in spawns)
        for program in ("npx", "git", "pdftotext", "inline", "trojan-language-server"):
            assert program in joined, (program, spawns)
        assert _host_lines(marker)

    @pytest.mark.parametrize("setup", ["seatbelt-subclass", "confined-process"])
    def test_a_confining_environment_starts_nothing_but_its_own_shell(self, tmp_path, monkeypatch, _home, setup):
        import agent.lsp
        from tools.file_operations import ShellFileOperations

        project, marker = self._setup(tmp_path, monkeypatch, _home)
        if setup == "confined-process":
            _confine()
        else:
            monkeypatch.setenv("TERMINAL_ENV", "iclone_seatbelt")
        ops = ShellFileOperations(_env("confining", project), cwd=str(project))
        with _recording() as spawns:
            self._exercise(ops, project, tmp_path)
        assert spawns == [], spawns
        assert _host_lines(marker) == [], marker.read_text()
        assert agent.lsp._service is None
