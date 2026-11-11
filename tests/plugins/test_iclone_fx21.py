"""fx21: what the real-app proof of v0.0.6 found about file tools and folders.

F2: read_file on a file a confined command may not see says the rule, never "File not found". F3: the sheet names the
folder a written file is in, and a refused write says why. F1's proof is live (left-running.live.test.ts, and the
launcher's own group handling here).
"""

from __future__ import annotations

import importlib.util
import os
import sys
import threading
import time
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _permissions():
    name = "hermes_plugins_fx21.iclone_permissions"
    plugin = ROOT / "plugins" / "iclone-permissions"
    sys.modules.setdefault("hermes_plugins_fx21", types.ModuleType("hermes_plugins_fx21")).__path__ = []
    spec = importlib.util.spec_from_file_location(name, plugin / "__init__.py", submodule_search_locations=[str(plugin)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class _Env:
    """A confined environment as file_operations sees it: the shell answers as Seatbelt would."""

    host_side_helpers = False

    def __init__(self, cwd, answers):
        self.cwd = str(cwd)
        self.project_root = str(cwd)
        self.answers = answers
        self.commands = []

    def project_for(self, folder):
        return os.path.realpath(folder)

    def execute(self, command, cwd=None, **_kw):
        self.commands.append(command)
        for needle, (code, out) in self.answers.items():
            if needle in command:
                return {"returncode": code, "output": out}
        return {"returncode": 0, "output": ""}


def _ops(env):
    from tools.file_operations import ShellFileOperations

    return ShellFileOperations(env, cwd=env.cwd)


class TestF2:
    def world(self, tmp_path):
        project, sibling = tmp_path / "first", tmp_path / "sib"
        project.mkdir()
        sibling.mkdir()
        return project, sibling, sibling / "readme.txt"

    def test_a_refused_read_names_the_rule_and_what_to_do(self, tmp_path):
        from tools import file_operations as fo

        project, sibling, target = self.world(tmp_path)
        env = _Env(project, {fo.MISSING_SENTINEL: (0, fo.MISSING_SENTINEL),
                             "/bin/ls -d": (0, f"ls: {target}: Operation not permitted\n")})
        result = _ops(env).read_file_raw(str(target))
        assert "File not found" not in result.error
        assert not getattr(result, "not_found", False)
        assert "icloneOS confinement refused" in result.error
        assert f"workdir={os.path.realpath(sibling)}" in result.error

    def test_a_file_that_is_really_missing_stays_not_found(self, tmp_path):
        from tools import file_operations as fo

        project, _, target = self.world(tmp_path)
        env = _Env(project, {fo.MISSING_SENTINEL: (0, fo.MISSING_SENTINEL),
                             "/bin/ls -d": (0, f"ls: {target}: No such file or directory\n")})
        result = _ops(env).read_file_raw(str(target))
        assert result.error.startswith("File not found")
        assert result.not_found

    def test_a_missing_file_in_the_project_never_asks_the_kernel(self, tmp_path):
        from tools import file_operations as fo

        project, _, _ = self.world(tmp_path)
        env = _Env(project, {fo.MISSING_SENTINEL: (0, fo.MISSING_SENTINEL)})
        result = _ops(env).read_file_raw(str(project / "sub" / "gone.txt"))
        assert result.not_found
        assert not any("/bin/ls -d" in c for c in env.commands)

    def test_outside_confinement_nothing_changes(self, tmp_path):
        from tools import file_operations as fo

        project, _, target = self.world(tmp_path)
        env = _Env(project, {fo.MISSING_SENTINEL: (0, fo.MISSING_SENTINEL),
                             "/bin/ls -d": (0, "Operation not permitted")})
        env.host_side_helpers = True
        assert _ops(env).read_file_raw(str(target)).not_found


class TestF3Failure:
    def test_fx22_the_launcher_line_about_the_wrong_folder_is_not_said(self, tmp_path):
        project, sibling = tmp_path / "first", tmp_path / "sib"
        project.mkdir()
        sibling.mkdir()
        wrong = f"icloneOS: this command has no project writes because no mode set on this Mac allows them, in {project}.\n"
        env = _Env(project, {"mkdir -p": (1, wrong + "mkdir: sib: Operation not permitted")})
        error = _ops(env).write_file(str(sibling / "a.txt"), "x").error
        assert "no project writes" not in error and "Operation not permitted" in error
        assert f"workdir={os.path.realpath(sibling)}" in error

    def test_a_refused_write_says_why_and_what_to_do(self, tmp_path):
        project, sibling = tmp_path / "first", tmp_path / "sib"
        project.mkdir()
        sibling.mkdir()
        ops = _ops(_Env(project, {}))
        note = ops._confined_write_note(str(sibling / "a.txt"), "mkdir: x: Operation not permitted")
        assert note.startswith("\nicloneOS: this write ran confined to " + os.path.realpath(project))
        assert f"workdir={os.path.realpath(sibling)}" in note and "Allow this folder" in note

    def test_a_refused_write_inside_the_project_adds_nothing_here(self, tmp_path):
        """The launcher's own narrowing line says why there; this note is only about another folder."""
        project = tmp_path / "first"
        (project / "sub").mkdir(parents=True)
        ops = _ops(_Env(project, {}))
        assert ops._confined_write_note(str(project / "sub" / "a.txt"), "Operation not permitted") == ""

    def test_any_other_failure_adds_nothing(self, tmp_path):
        project, sibling = tmp_path / "first", tmp_path / "sib"
        project.mkdir()
        sibling.mkdir()
        assert _ops(_Env(project, {}))._confined_write_note(str(sibling / "a"), "No space left on device") == ""

    def test_the_tool_error_carries_the_note(self, tmp_path):
        project, sibling = tmp_path / "first", tmp_path / "sib"
        project.mkdir()
        sibling.mkdir()
        env = _Env(project, {"mkdir -p": (1, "mkdir: sib: Operation not permitted")})
        result = _ops(env).write_file(str(sibling / "a.txt"), "x")
        assert "Operation not permitted" in result.error and "icloneOS: this write ran confined" in result.error


class TestF3Sheet:
    def perms(self, monkeypatch, project, sibling):
        perms = _permissions()
        monkeypatch.setattr(perms, "_confined_project",
                            lambda folder, _t, classified: os.path.realpath(folder) if folder else classified)
        return perms

    def test_the_sheet_names_the_sibling_a_file_lands_in(self, tmp_path, monkeypatch):
        project, sibling = tmp_path / "first", tmp_path / "sib"
        project.mkdir()
        sibling.mkdir()
        perms = self.perms(monkeypatch, project, sibling)
        got = perms._call_project("write_file", {"path": str(sibling / "a.txt")}, str(project), "t", "c")
        assert got == os.path.realpath(sibling)

    def test_a_new_subfolder_names_the_folder_that_exists(self, tmp_path, monkeypatch):
        project, sibling = tmp_path / "first", tmp_path / "sib"
        project.mkdir()
        sibling.mkdir()
        perms = self.perms(monkeypatch, project, sibling)
        got = perms._call_project("write_file", {"path": str(sibling / "new" / "deep" / "a.txt")}, str(project), "t", "c")
        assert got == os.path.realpath(sibling)

    def test_a_file_inside_the_project_keeps_the_project(self, tmp_path, monkeypatch):
        project = tmp_path / "first"
        (project / "sub").mkdir(parents=True)
        perms = self.perms(monkeypatch, project, None)
        for path in (str(project / "sub" / "a.txt"), "sub/a.txt", "a.txt"):
            assert perms._call_project("write_file", {"path": path}, str(project), "t", "c") == os.path.realpath(project)

    def test_only_a_file_tool_moves_it(self, tmp_path, monkeypatch):
        project, sibling = tmp_path / "first", tmp_path / "sib"
        project.mkdir()
        sibling.mkdir()
        perms = self.perms(monkeypatch, project, sibling)
        got = perms._call_project("terminal", {"path": str(sibling / "a.txt"), "command": "ls"}, str(project), "t", "c")
        assert got == os.path.realpath(project)


class TestF1Launcher:
    """The launcher's ownership of what a run left, on the logic; the kernel's own answer is in left-running.live.test.ts."""

    def world(self, monkeypatch):
        from tests.plugins.test_iclone_launcher import L

        class Rows:
            def __init__(self):
                self.rows = []

            def append(self, row):
                self.rows.append(row)

        class Quiet:
            def close(self):
                pass

        launcher = L.Launcher.__new__(L.Launcher)
        launcher.stopping, launcher.server, launcher.socket_path = False, None, "/nonexistent/fx21.sock"
        launcher.runs_lock, launcher.runs, launcher.left = threading.Lock(), {}, {}
        launcher.outside = {}
        launcher.journal, launcher.refusals = Rows(), Quiet()
        members = {}
        killed = []

        def kill(pid, _sig):
            killed.append(pid)
            for token, pids in members.items():
                if pid in pids:
                    pids.remove(pid)

        monkeypatch.setattr(L, "LEFT_GRACE_S", 0)
        monkeypatch.setattr(L, "LEFT_POLL_S", 0.01)
        monkeypatch.setattr(L, "confined_members", lambda token: list(members.get(token, ())))
        monkeypatch.setattr(L.os, "kill", kill)
        return L, launcher, members, killed

    @staticmethod
    def run(L, token="tok"):
        proc = types.SimpleNamespace(pid=4242)
        run = L.Run(proc, token, {"params": {"MEMBER": token}})
        run.finished = True
        return run

    def test_a_run_that_left_nothing_writes_nothing(self, monkeypatch):
        L, launcher, _, _ = self.world(monkeypatch)
        run = self.run(L)
        launcher.left[run.token] = run
        launcher._watch_left(run)
        assert launcher.journal.rows == [] and launcher.left == {}

    def test_a_command_that_ends_by_itself_is_journalled_as_not_stopped(self, monkeypatch):
        L, launcher, members, _ = self.world(monkeypatch)
        run = self.run(L)
        members["tok"] = [11]
        launcher.left[run.token] = run
        thread = threading.Thread(target=launcher._watch_left, args=(run,))
        thread.start()
        while not launcher.journal.rows:
            time.sleep(0.005)
        assert launcher.journal.rows[0]["ev"] == "left-running"
        members["tok"] = []
        thread.join(5)
        assert launcher.journal.rows[-1]["ev"] == "left-ended" and launcher.journal.rows[-1]["stopped"] is False
        assert launcher.left == {}

    def test_stop_kills_what_a_run_left_and_says_so(self, monkeypatch):
        L, launcher, members, killed = self.world(monkeypatch)
        run = self.run(L)
        members["tok"] = [11, 12]
        launcher.left[run.token] = run
        launcher.stop()
        assert sorted(killed) == [11, 12]
        row = launcher.journal.rows[-1]
        assert (row["ev"], row["stopped"], row["why"], row["survivors"]) == ("left-ended", True, "quit", 0)

    def test_stop_says_when_something_survived(self, monkeypatch):
        L, launcher, members, _ = self.world(monkeypatch)
        run = self.run(L)
        members["tok"] = [11]
        launcher.left[run.token] = run
        monkeypatch.setattr(L.os, "kill", lambda *_a: None)
        launcher.stop()
        assert launcher.journal.rows[-1]["survivors"] == 1

    def test_stop_ends_the_runs_before_it_waits_for_the_driver(self, monkeypatch):
        L, launcher, members, killed = self.world(monkeypatch)
        run = self.run(L)
        members["tok"] = [11, 12]
        launcher.left[run.token] = run
        seen = {}

        class Door:
            @staticmethod
            def stop_all():
                seen["killed"] = sorted(killed)
                seen["row"] = launcher.journal.rows[-1]["ev"]

        launcher.driver_door = Door
        launcher.stop()
        assert seen == {"killed": [11, 12], "row": "left-ended"}

    def test_a_driver_door_that_fails_at_quit_loses_nothing(self, monkeypatch):
        L, launcher, members, killed = self.world(monkeypatch)
        run = self.run(L)
        members["tok"] = [11]
        launcher.left[run.token] = run

        class Door:
            @staticmethod
            def stop_all():
                raise OSError("the door broke")

        launcher.driver_door = Door
        launcher.stop()
        assert killed == [11]
        assert launcher.journal.rows[-1]["survivors"] == 0

    def test_a_policy_downgrade_reaches_what_a_run_left(self, monkeypatch):
        L, launcher, members, killed = self.world(monkeypatch)
        run = self.run(L)
        members["tok"] = [11]
        launcher.left[run.token] = run
        keys = iter(("a", "b"))

        class Validator:
            policy = types.SimpleNamespace(key=lambda: next(keys, "b"))

            @staticmethod
            def policy_ok(_params, held=None):
                raise L.Refusal("policy", "every mode is Plan now")

        launcher.validator = Validator
        monkeypatch.setattr(L, "POLICY_WATCH_S", 0.01)
        thread = threading.Thread(target=launcher.policy_watch, daemon=True)
        thread.start()
        deadline = time.monotonic() + 5
        while not killed and time.monotonic() < deadline:
            time.sleep(0.005)
        launcher.stopping = True
        thread.join(5)
        assert killed == [11] and run.stop_why == "policy"


class TestFx22LinkInside:
    def _world(self, tmp_path, monkeypatch):
        project, sibling = tmp_path / "first", tmp_path / "sib"
        (project / ".git").mkdir(parents=True)
        sibling.mkdir()
        (project / "linked").symlink_to(sibling)
        perms = _permissions()
        core = types.SimpleNamespace(trusted_index=lambda: None, git_root=os.path.realpath,
                                     acceptable_project_root=lambda _r, _i: True)
        monkeypatch.setattr(perms, "_confinement_core", lambda: core)
        import tools.file_tools_paths as paths
        monkeypatch.setattr(paths, "_registered_task_cwd_override", lambda _t: str(project))
        return perms, project, sibling

    def test_a_link_inside_the_project_names_no_folder(self, tmp_path, monkeypatch):
        perms, project, _ = self._world(tmp_path, monkeypatch)
        assert perms._confined_project(str(project / "linked"), "t", "classified") is None
        assert perms._confined_project(str(project / "linked" / "deep"), "t", "classified") is None

    def test_a_real_folder_keeps_its_name(self, tmp_path, monkeypatch):
        perms, project, sibling = self._world(tmp_path, monkeypatch)
        assert perms._confined_project(str(sibling), "t", None) == os.path.realpath(sibling)
        assert perms._confined_project(str(project), "t", None) == os.path.realpath(project)


class TestF3Wiring:
    def test_the_decision_and_the_sheet_use_the_files_folder(self, tmp_path, monkeypatch):
        project, sibling = tmp_path / "first", tmp_path / "sib"
        project.mkdir()
        sibling.mkdir()
        perms = _permissions()
        seen = {}

        class Done(Exception):
            pass

        def payload(_tool, _target, _cls, _facts, _floor, _key, chosen, *_rest):
            seen["project"] = chosen
            raise Done

        monkeypatch.setitem(perms._state, "policy", types.SimpleNamespace(body=lambda: {}))
        monkeypatch.setitem(perms._state, "channel", types.SimpleNamespace(healthy=True))
        monkeypatch.setattr(perms, "_cwd_for", lambda _t: str(project))
        monkeypatch.setattr(perms, "_confined_project",
                            lambda folder, _t, classified: os.path.realpath(folder) if folder else classified)
        monkeypatch.setattr(perms, "_payload", payload)
        try:
            perms._decide("write_file", {"path": str(sibling / "a.txt"), "content": "x"}, "t", "s", "i", {})
        except Done:
            pass
        assert seen["project"] == os.path.realpath(sibling)

    def test_a_folder_the_runtime_may_not_stat_is_there(self, tmp_path, monkeypatch):
        """Under the runtime profile an unlisted sibling answers EPERM: it is the file's folder, not a reason to walk up."""
        perms = _permissions()
        sibling = str(tmp_path / "sib")
        real = os.stat

        def stat(path, *a, **k):
            if str(path) == sibling:
                raise PermissionError(1, "Operation not permitted")
            return real(path, *a, **k)

        monkeypatch.setattr(perms.os, "stat", stat)
        assert perms._written_folder("write_file", {"path": sibling + "/a.txt"}, str(tmp_path)) == sibling
