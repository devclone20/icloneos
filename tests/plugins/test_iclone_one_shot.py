"""G-98 F42: a given permission works. Every row runs the real launcher and the real stub: a marker on disk or in the
ledger only exists if the action ran."""
import hashlib
import json
import os
import subprocess
import sys
import time

import pytest

from tests.plugins.test_iclone_launcher import L, World
from tests.plugins.test_iclone_permissions import _body, wired  # noqa: F401 (wired is a fixture)

STUB = L.HERE + "/stub.py"


@pytest.fixture
def w():
    world = World()
    world.policy()
    world.start()
    yield world
    world.close()


def grant(w, text, cwd, exp=None):
    row = {"v": 1, "id": os.urandom(16).hex(), "sha": hashlib.sha256(text.encode()).hexdigest(), "cwd": cwd,
           "ts": time.time(), "exp": exp or time.time() + 120}
    with open(os.path.join(str(w.ledger), L.ONESHOT_FILE), "a", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\n")


def run(w, text, cwd):
    env = {"PATH": os.environ["PATH"], "ICLONE_RUN_CWD": cwd, L.ONESHOT_ENV: text, "HOME": str(w.home)}
    return subprocess.run([sys.executable, "-I", "-S", STUB, w.socket, "--", L.SANDBOX_EXEC, L.ONESHOT_FLAG], env=env,
                          capture_output=True, text=True, timeout=30, cwd=cwd)


def folder(w, tmp_path):
    return os.path.realpath(str(tmp_path))


def test_main_s_answer_runs_it_once_outside_and_the_ledger_says_so(w, tmp_path):
    cwd, mark = folder(w, tmp_path), tmp_path / "ran"
    text = f"echo x >> {mark}"
    grant(w, text, cwd)
    assert run(w, text, cwd).returncode == 0
    assert mark.read_text() == "x\n"
    row = [r for r in w.journal() if r.get("ev") == "start"][-1]
    assert row["unconfined"] is True and row["command"].startswith("[ran once outside the Seatbelt")
    assert L.ONESHOT_ENV not in subprocess.run(["/usr/bin/true"], capture_output=True, text=True).stdout


def test_the_command_does_not_see_the_handoff_variable(w, tmp_path):
    cwd, mark = folder(w, tmp_path), tmp_path / "env"
    text = f"env > {mark}"
    grant(w, text, cwd)
    assert run(w, text, cwd).returncode == 0
    assert L.ONESHOT_ENV not in mark.read_text() and "PATH=" in mark.read_text()


def test_without_main_s_answer_nothing_runs(w, tmp_path):
    cwd, mark = folder(w, tmp_path), tmp_path / "ran"
    out = run(w, f"touch {mark}", cwd)
    assert out.returncode != 0 and not mark.exists()
    assert "no approval from the owner" in out.stderr + out.stdout
    assert any(r.get("code") == "oneshot-none" for r in w.refused())


def test_a_replay_is_refused_and_a_restarted_launcher_remembers(w, tmp_path):
    cwd, mark = folder(w, tmp_path), tmp_path / "ran"
    text = f"echo x >> {mark}"
    grant(w, text, cwd)
    assert run(w, text, cwd).returncode == 0
    assert run(w, text, cwd).returncode != 0
    assert mark.read_text() == "x\n"
    assert any(r.get("code") == "oneshot-used" for r in w.refused())
    w.launcher.stop()
    w.start()
    assert run(w, text, cwd).returncode != 0
    assert mark.read_text() == "x\n"


def test_an_edited_command_is_refused(w, tmp_path):
    cwd, mark = folder(w, tmp_path), tmp_path / "ran"
    grant(w, f"echo x >> {mark}", cwd)
    assert run(w, f"echo x >> {mark}; touch {mark}.more", cwd).returncode != 0
    assert not mark.exists() and not (tmp_path / "ran.more").exists()


def test_an_expired_answer_is_refused(w, tmp_path):
    cwd, mark = folder(w, tmp_path), tmp_path / "ran"
    text = f"touch {mark}"
    grant(w, text, cwd, exp=time.time() - 1)
    assert run(w, text, cwd).returncode != 0 and not mark.exists()
    assert any(r.get("code") == "oneshot-expired" for r in w.refused())


def test_another_folder_is_refused(w, tmp_path):
    cwd, mark = folder(w, tmp_path), tmp_path / "ran"
    other = tmp_path / "other"
    other.mkdir()
    text = f"touch {mark}"
    grant(w, text, cwd)
    assert run(w, text, os.path.realpath(str(other))).returncode != 0 and not mark.exists()


def test_a_child_left_behind_ends_with_the_command(w, tmp_path):
    cwd, pidfile = folder(w, tmp_path), tmp_path / "pid"
    text = f"sleep 60 & echo $! > {pidfile}"
    grant(w, text, cwd)
    assert run(w, text, cwd).returncode == 0
    pid = int(pidfile.read_text())
    for _ in range(100):
        try:
            os.kill(pid, 0)
        except OSError:
            return
        time.sleep(0.05)
    pytest.fail("the child outlived the approval")


class TestOwnProfile:
    @pytest.fixture
    def home(self, tmp_path, monkeypatch):
        home = tmp_path / "home"
        (home / "memories").mkdir(parents=True)
        monkeypatch.setenv("HERMES_HOME", str(home))
        monkeypatch.setattr("hermes_cli.iclone_policy_env.confined_at_exec", lambda: True)
        return home

    @pytest.mark.parametrize("rel", ["SOUL.md", "memories/MEMORY.md", "memories/a.md", "notes/b.json"])  # S2: was MEMORY.md, files/notes/
    def test_its_own_files_are_written(self, home, rel):
        from tools.file_operations import ShellFileOperations
        from tools.iclone_own_profile import writable

        ops = object.__new__(ShellFileOperations)
        ops._expand_path = lambda p: p
        out = ShellFileOperations.write_file(ops, str(home / rel), "soul")
        assert out.error is None and out.bytes_written == 4 and (home / rel).read_text() == "soul"
        assert writable(str(home / rel))

    @pytest.mark.parametrize("rel", ["config.yaml", ".env", "auth.json", "state.db", "plugins/x/__init__.py",
                                     "hooks/h.md", "memories/permissions.md", "memories/.hidden", "policy.md",
                                     "profiles/other/SOUL.md", "skills/a/SKILL.md", "memories/x.py"])
    def test_permission_files_and_code_are_not(self, home, rel):
        from tools.iclone_own_profile import writable

        assert writable(str(home / rel)) is None

    def test_a_link_out_of_the_folder_is_not_its_own(self, home, tmp_path):
        from tools.iclone_own_profile import writable

        (tmp_path / "outside").mkdir()
        os.symlink(tmp_path / "outside", home / "memories" / "out")
        assert writable(str(home / "memories" / "out" / "a.md")) is None

    def test_off_when_the_app_did_not_confine(self, home, monkeypatch):
        from tools.iclone_own_profile import writable

        monkeypatch.setattr("hermes_cli.iclone_policy_env.confined_at_exec", lambda: False)
        assert writable(str(home / "SOUL.md")) is None


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS sandbox-exec only")
class TestRealSeatbeltThroughTheRealLauncher:
    @pytest.fixture
    def live(self, tmp_path, monkeypatch):
        import shutil
        import tempfile
        import threading
        from pathlib import Path

        from tests.plugins.test_iclone_confinement import TestSeatbeltLive
        from tests.plugins.test_iclone_launcher import _body

        root, project, _, _sha, env = TestSeatbeltLive().world(tmp_path, monkeypatch)
        base = Path(os.path.realpath(tempfile.mkdtemp(prefix="icl-", dir="/tmp")))
        run, ledger = base / "run", base / "ledger"
        ledger.mkdir(parents=True)
        other = Path(os.path.realpath(root)) / "granted"
        other.mkdir()
        (ledger / L.POLICY_FILE).write_text(json.dumps({"v": 1, "body": _body("acceptEdits"),
                                                        "projects": [str(project), str(other)]}))
        launcher = L.Launcher(env._index, str(run / "launcher.sock"), str(ledger))
        launcher.bind()
        threading.Thread(target=launcher.serve_forever, daemon=True).start()
        monkeypatch.setenv("ICLONE_RUNTIME_CONFINED", "1")
        monkeypatch.setenv("ICLONE_CONFINEMENT_LAUNCHER", str(run / "launcher.sock"))
        core = sys.modules[type(env).__module__].core
        yield env, core, ledger, Path(os.path.realpath(root)), Path(os.path.realpath(project)), other
        launcher.stop()
        shutil.rmtree(base, ignore_errors=True)

    @staticmethod
    def row(ledger, text, cwd):
        with open(ledger / L.ONESHOT_FILE, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"v": 1, "id": os.urandom(16).hex(), "cwd": str(cwd), "ts": time.time(),
                                     "sha": hashlib.sha256(text.encode()).hexdigest(), "exp": time.time() + 120}) + "\n")

    def test_auto_allowed_stays_confined_and_is_told_what_to_do(self, live):
        env, _core, _ledger, root, _project, _other = live
        target = root / "outside-write"
        out = env.execute(f"touch {target}")
        assert out["returncode"] != 0 and not target.exists()
        assert "Cause: the Seatbelt refused" in out["output"] and "What to do:" in out["output"]
        assert "mode " in out["output"]

    def test_the_approved_command_writes_outside_once_and_a_replay_stays_confined(self, live):
        env, core, ledger, root, project, _other = live
        target = root / "approved-write"
        text = f"echo x >> {target}"
        self.row(ledger, text, project)
        core.note_approved_command(text)
        out = env.execute(text)
        assert out["returncode"] == 0 and target.read_text() == "x\n", out
        assert "ran once outside the Seatbelt" in out["output"]
        assert "cd and export do not carry to the next command" in out["output"]
        assert "chain them in one command or use absolute paths" in out["output"]
        again = env.execute(text)  # no answer from main: the Seatbelt judges it
        assert again["returncode"] != 0 and target.read_text() == "x\n"
        core.note_approved_command(text)  # the runtime's word alone: the row is spent
        forged = env.execute(text)
        assert forged["returncode"] != 0 and target.read_text() == "x\n"
        assert "covered one run" in forged["output"]

    def test_the_runtime_asking_without_main_gets_nothing(self, live):
        env, core, _ledger, root, _project, _other = live
        target = root / "forged-write"
        core.note_approved_command(f"touch {target}")
        out = env.execute(f"touch {target}")
        assert out["returncode"] != 0 and not target.exists() and "no approval from the owner" in out["output"]

    def test_an_approved_write_naming_its_folder_widens_and_stays_confined(self, live, monkeypatch):
        env, core, _ledger, root, _project, other = live
        # The permission plugin is not loaded here: its answer for a write in this mode, as the runtime reads it.
        monkeypatch.setattr(core, "grant_params", lambda *_: {"NET": "0", "WRITE_PROJECT": "1"})
        target, beyond = other / "named.txt", root / "beyond.txt"
        refused = env.execute(f"echo x > '{target}'")
        assert refused["returncode"] != 0 and not target.exists()
        core.note_approved_folder(str(other))
        out = env.execute(f"echo x > '{target}'; touch '{beyond}'", cwd=str(env.cwd))
        assert target.read_text() == "x\n", out  # widened
        assert not beyond.exists()  # still inside the Seatbelt



    @staticmethod
    def write_policy(ledger, mode, project, other):
        from tests.plugins.test_iclone_launcher import _body

        (ledger / L.POLICY_FILE).write_text(json.dumps({"v": 1, "body": _body(mode), "projects": [str(project), str(other)],
                                                        "asked": [str(other)]}))

    @staticmethod
    def write_pass(ledger, folder, cls="Wo", ttl=120.0):
        now = time.time()
        with open(ledger / L.PASS_FILE, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"v": 1, "id": os.urandom(8).hex(), "project": str(folder), "cls": cls, "scope": "once",
                                     "ts": now - 1, "exp": now + ttl}) + "\n")

    @staticmethod
    def write_file(env, project, target):
        from tools.file_operations import ShellFileOperations

        return ShellFileOperations(env, cwd=str(project)).write_file(str(target), "w")

    # proofaudit row 5, the owner's complaint: main's pass for "write a file outside the project" has class Wo, and the
    # launcher read only Wp and X, so the Allow narrowed the run to read-only in Manual.
    @pytest.mark.parametrize("mode", ["manual", "automatic", "acceptEdits"])
    def test_an_allowed_write_to_another_folder_lands_in_every_asking_mode(self, live, monkeypatch, mode):
        env, core, ledger, _root, project, other = live
        monkeypatch.setattr(core, "grant_params", lambda *_: {"NET": "0", "WRITE_PROJECT": "1"})
        self.write_policy(ledger, mode, project, other)
        self.write_pass(ledger, other)
        core.note_approved_folder(str(other))
        result = self.write_file(env, project, other / "w.txt")
        assert result.bytes_written == 1 and (other / "w.txt").read_text() == "w", result

    @pytest.mark.parametrize("pass_for", ["none", "elsewhere", "expired"])
    def test_with_no_pass_for_that_folder_manual_still_refuses(self, live, monkeypatch, pass_for):
        env, core, ledger, root, project, other = live
        monkeypatch.setattr(core, "grant_params", lambda *_: {"NET": "0", "WRITE_PROJECT": "1"})
        self.write_policy(ledger, "manual", project, other)
        if pass_for == "elsewhere":
            self.write_pass(ledger, project)
        if pass_for == "expired":
            self.write_pass(ledger, other, ttl=-1.0)
        core.note_approved_folder(str(other))
        result = self.write_file(env, project, other / "w.txt")
        assert result.bytes_written == 0 and not (other / "w.txt").exists(), result

    # fx47's weak item: main's pass for the folder, a signed stored grant and the plugin's real gate, then the real write
    # through the real launcher and Seatbelt. The gate gets no sheet here, so only its own note can tell the run the folder.
    @pytest.mark.parametrize("gated,passed,lands", [(True, True, True), (False, True, False), (True, False, False)],
                             ids=["gate-and-pass", "no-gate", "no-pass"])
    def test_a_write_under_a_stored_grant(self, live, wired, monkeypatch, gated, passed, lands):
        from hermes_cli import iclone_policy_env

        env, core, ledger, _root, project, other = live
        monkeypatch.setattr(core, "grant_params", lambda *_: {"NET": "0", "WRITE_PROJECT": "1"})
        self.write_policy(ledger, "manual", project, other)
        if passed:
            self.write_pass(ledger, other)
        target = other / "granted.txt"
        grant = {"id": "stored-1", "cls": "Wo", "scope": "standing", "sessionId": None, "project": None}
        try:
            mod, main, _ = wired(_body(standing="manual", grants=[grant]))
            monkeypatch.setattr(mod, "_confinement_core", lambda: core)
            if gated:
                assert mod.on_pre_tool_call("write_file", {"path": str(target), "content": "w"}, "t", "s1") is None
                mod._state["channel"].flush(3.0)
                assert main.verbs("ask") == []  # the grant answered: no sheet
                assert [e.get("grantId") for e in main.verbs("event") if e.get("outcome") == "allow"] == ["stored-1"]
            result = self.write_file(env, project, target)
        finally:
            iclone_policy_env._reset_for_tests(None)
        assert (result.bytes_written == 1) is lands, result
        assert target.exists() is lands

    # f55, the owner's complaint in the packed rehearsal: read_file in full, then write_file over the file, refused as
    # "has not seen its full current content". The real tools, the real launcher and Seatbelt, the real gate.
    def overwrite_world(self, live, wired, monkeypatch, mode, profile):
        from tools import file_tools
        from tools.file_operations import ShellFileOperations

        env, _core, _ledger, root, project, _other = live
        home = root / ".hermes"
        if profile == "inft":
            home = home / "profiles" / "inft-111111-7"
        (home / "memories").mkdir(parents=True)
        monkeypatch.setenv("HERMES_HOME", str(home))
        mod, main, _ = wired(_body(standing=mode))
        monkeypatch.setattr("hermes_cli.iclone_policy_env.confined_at_exec", lambda: True)
        monkeypatch.setattr(file_tools, "_get_file_ops", lambda task_id="default": ShellFileOperations(env, cwd=str(project)))
        return file_tools, mod, main, home, project

    @pytest.mark.parametrize("rel", ["SOUL.md", "memories/MEMORY.md"])
    @pytest.mark.parametrize("profile", ["root", "inft"])
    @pytest.mark.parametrize("mode", ["manual", "ignore"])
    def test_the_agents_own_file_read_in_full_can_be_overwritten(self, live, wired, monkeypatch, mode, profile, rel):
        from hermes_cli import iclone_policy_env

        file_tools, mod, main, home, _project = self.overwrite_world(live, wired, monkeypatch, mode, profile)
        target = home / rel
        target.write_text("OLD SOUL\n")
        task = f"f55-{mode}-{profile}-{rel}"
        try:
            read = json.loads(file_tools.read_file_tool(str(target), task_id=task))
            assert "OLD SOUL" in read["content"], read
            args = {"path": str(target), "content": "NEW SOUL\n"}
            assert mod.on_pre_tool_call("write_file", args, task, "s1") is None
            assert main.verbs("ask") == []
            out = json.loads(file_tools.write_file_tool(str(target), "NEW SOUL\n", task_id=task))
        finally:
            iclone_policy_env._reset_for_tests(None)
        assert "error" not in out, out
        assert target.read_text() == "NEW SOUL\n"

    @pytest.mark.parametrize("how", ["never-read", "changed-after-the-read", "half-read"])
    def test_the_fresh_read_rule_still_stands_for_the_soul(self, live, wired, monkeypatch, how):
        from hermes_cli import iclone_policy_env

        file_tools, _mod, _main, home, _project = self.overwrite_world(live, wired, monkeypatch, "manual", "root")
        target = home / "SOUL.md"
        target.write_text("OLD SOUL\nSECOND LINE\n")
        task = f"f55-twin-{how}"
        try:
            if how == "half-read":
                file_tools.read_file_tool(str(target), offset=1, limit=1, task_id=task)
            elif how == "changed-after-the-read":
                file_tools.read_file_tool(str(target), task_id=task)
                target.write_text("ANOTHER WRITER\n")
            out = json.loads(file_tools.write_file_tool(str(target), "NEW SOUL\n", task_id=task))
        finally:
            iclone_policy_env._reset_for_tests(None)
        assert out.get("stale_write_blocked") is True, out
        assert "NEW SOUL" not in target.read_text()

    def test_a_repeated_read_under_the_seatbelt_is_never_answered_from_the_record(self, live, wired, monkeypatch):
        from hermes_cli import iclone_policy_env

        file_tools, _mod, _main, home, _project = self.overwrite_world(live, wired, monkeypatch, "manual", "root")
        target = home / "SOUL.md"
        target.write_text("OLD SOUL\n")
        try:
            reads = [json.loads(file_tools.read_file_tool(str(target), task_id="f55-repeat")) for _ in range(2)]
        finally:
            iclone_policy_env._reset_for_tests(None)
        assert ["OLD SOUL" in read.get("content", "") for read in reads] == [True, True], reads

    def test_the_fresh_read_record_is_for_a_shell_on_this_host_only(self, live):
        from tools.environments.host_lane import env_reads_this_host

        env, *_ = live
        assert env_reads_this_host(env) is True
        assert env_reads_this_host(object()) is False and env_reads_this_host(None) is False

    # The same rule on a plain project file under the Seatbelt: the write itself still goes through the launcher.
    def test_a_project_file_read_in_full_can_be_overwritten_under_the_seatbelt(self, live, wired, monkeypatch):
        from hermes_cli import iclone_policy_env

        _env, core, _ledger, _root, _project, _other = live
        monkeypatch.setattr(core, "grant_params", lambda *_: {"NET": "0", "WRITE_PROJECT": "1"})
        file_tools, _mod, _main, _home, project = self.overwrite_world(live, wired, monkeypatch, "acceptEdits", "root")
        target = project / "notes.txt"
        target.write_text("OLD\n")
        try:
            file_tools.read_file_tool(str(target), task_id="f55-project")
            out = json.loads(file_tools.write_file_tool(str(target), "NEW\n", task_id="f55-project"))
        finally:
            iclone_policy_env._reset_for_tests(None)
        assert "error" not in out, out
        assert target.read_text() == "NEW\n"

    def test_the_write_pass_stays_inside_its_folder_and_never_opens_the_network(self, live, monkeypatch):
        env, core, ledger, root, project, other = live
        monkeypatch.setattr(core, "grant_params", lambda *_: {"NET": "0", "WRITE_PROJECT": "1"})
        self.write_policy(ledger, "manual", project, other)
        self.write_pass(ledger, other)
        core.note_approved_folder(str(other))
        out = env.execute(f"echo x > '{other}/in.txt'; touch '{root}/beyond.txt'", cwd=str(env.cwd))
        assert (other / "in.txt").read_text() == "x\n" and not (root / "beyond.txt").exists(), out
        assert L.Passes(str(ledger)).live(L.folder_identity(str(other)), "NET") is None


def _plugin():
    import importlib.util
    from pathlib import Path

    folder = Path(L.HERE).parent / "iclone-permissions"
    spec = importlib.util.spec_from_file_location("f42_permissions", folder / "__init__.py",
                                                  submodule_search_locations=[str(folder)])
    module = importlib.util.module_from_spec(spec)
    sys.modules["f42_permissions"] = module
    spec.loader.exec_module(module)
    return module


def test_a_refused_agent_reads_mode_cause_and_what_to_do():
    text = _plugin()._refusal("plan", "the plan permission mode", "tell the owner.")
    assert "the plan permission mode" in text and "Mode: Plan" in text and "What to do: tell the owner." in text


@pytest.mark.parametrize("args,target,ok", [
    ({"command": "brew install x"}, "brew install x", True),
    # G2 A4 (lead's ruling): background and pty moved to True, with their tree in test_iclone_one_file_and_background.py.
    ({"command": "brew install x", "background": True}, "brew install x", True),
    ({"command": "brew install x", "pty": True}, "brew install x", True),
    ({"command": "brew install x"}, "brew install y", False),  # what the owner reads is what runs
])
def test_only_a_foreground_shell_text_the_owner_read_can_go_outside(args, target, ok, tmp_path):
    assert bool(_plugin()._shell_one_shot("terminal", args, target, str(tmp_path))) is ok


def test_another_tool_never_goes_outside(tmp_path):
    assert _plugin()._shell_one_shot("execute_code", {"command": "x"}, "x", str(tmp_path)) is None


def test_a_relative_path_never_moves_the_run(tmp_path):
    class Core:
        folders: list = []

        def note_approved_folder(self, folder):
            self.folders.append(folder)

    core, plugin = Core(), _plugin()
    (tmp_path / "a" / "b").mkdir(parents=True)
    plugin._note_answer(core, "write_file", {"path": "../a/b/f.txt"}, {"allowed": True}, str(tmp_path / "a" / "b" / ".."))
    assert core.folders == []
    plugin._note_answer(core, "write_file", {"path": str(tmp_path / "a" / "b" / "f.txt")}, {"allowed": True}, str(tmp_path))
    assert core.folders == [str(tmp_path / "a" / "b")]


# S2, the lead's ruling on secG98: the own profile is an allow list by name. Every row is a path the runtime trusts, runs
# or holds tokens in, from the finding and from the folders the runtime names under its home.
_NOT_THE_AGENTS = [
    "platforms/pairing/telegram-approved.json", "pairing/x.json", "mcp-tokens/srv.json", "scripts/x.js", "scripts/x.bash",
    "scripts/x.command", "scripts/notes.md", "node_modules/a/index.js", "node_modules/a/README.md",
    "hermes-agent/pyproject.toml", "hermes-agent/plugins/x/plugin.yaml", "hermes-agent/README.md",
    "plugin-data/x/config.json", "mcp-installs/x/run.js", "browser-profile/Default/Preferences", "gateway/x.json",
    "skills/a/SKILL.md", "plugins/x/notes.md", "hooks/h.md", "cron/jobs.json", "logs/a.txt", "sessions/s.json",
    "MEMORY.md", "USER.md", "AGENTS.md", "notes.md", "memories", "notes", "brand-new-folder/a.md", "a/memories/b.md",
    "a/notes/b.md", "a/SOUL.md", "memories.md", "memories2/a.md", "notes2/a.md", "SOUL.md.bak", "SOUL",
    "memories/x.py", "memories/x.sh", "memories/x.js", "memories/x", "memories/x.yaml", "memories/x.db", "notes/x.js",
    "notes/x.command", "notes/x.plist", "notes/.env", "notes/.hidden.md", ".notes/a.md", "memories/permissions.md",
    "notes/policy.json", "memories/sub/.git/config", "soul.md/x.md", "SOUL.md/x.md",
]


def _names_the_runtime_uses_under_its_home():
    """Every folder or file named as ``get_hermes_home() / "x"`` in the runtime's own source, so a new one is in the table."""
    import re
    from pathlib import Path

    root = Path(L.HERE).parents[1]
    found = set()
    for top in ("agent", "gateway", "hermes_cli", "tools", "plugins", "cron", "acp_adapter"):
        for path in (root / top).rglob("*.py"):
            found.update(re.findall(r'get_hermes_home\(\)\s*/\s*"([^"/]+)"', path.read_text("utf-8", "replace")))
    return found


class TestOwnProfileAllowList:
    @pytest.fixture
    def home(self, tmp_path, monkeypatch):
        home = tmp_path / "home"
        (home / "memories").mkdir(parents=True)
        monkeypatch.setenv("HERMES_HOME", str(home))
        monkeypatch.setattr("hermes_cli.iclone_policy_env.confined_at_exec", lambda: True)
        return home

    @pytest.mark.parametrize("rel", ["SOUL.md", "memories/MEMORY.md", "memories/USER.md", "memories/sub/a.txt",
                                     "memories/a.json", "notes/a.md", "notes/sub/b.txt", "notes/c.json"])
    def test_soul_memories_and_the_notes_folder_are_the_agents(self, home, rel):
        from tools.iclone_own_profile import writable

        assert writable(str(home / rel)) == os.path.realpath(str(home / rel))

    @pytest.mark.parametrize("rel", _NOT_THE_AGENTS)
    def test_everything_else_in_the_home_is_not(self, home, rel):
        from tools.iclone_own_profile import writable

        assert writable(str(home / rel)) is None

    def test_every_name_the_runtime_uses_under_its_home_starts_refused(self, home):
        from tools.iclone_own_profile import writable

        names = _names_the_runtime_uses_under_its_home()
        assert {"config.yaml", "mcp-tokens", "plugins"} & names, names  # the scan found the runtime's own names
        allowed = {"SOUL.md", "memories", "notes"}
        for name in names - allowed:
            assert writable(str(home / name)) is None, name
            assert writable(str(home / name / "a.md")) is None, name

    @pytest.mark.parametrize("rel", ["memories/../mcp-tokens/srv.json", "notes/../../outside.md", "notes/../SOUL.md/../scripts/x.md"])
    def test_a_path_is_judged_where_it_lands(self, home, rel):
        from tools.iclone_own_profile import writable

        assert writable(str(home) + "/" + rel) is None

    @pytest.mark.parametrize("name,inside", [("SOUL.md", "mcp-tokens/srv.json"), ("memories/t.md", "platforms/p.json"),
                                             ("notes", "scripts")])
    def test_a_link_from_the_allow_list_into_the_home_is_not_its_own(self, home, name, inside):
        from tools.iclone_own_profile import writable

        (home / inside).parent.mkdir(parents=True, exist_ok=True)
        (home / inside).write_text("t") if "." in inside else (home / inside).mkdir()
        (home / name).parent.mkdir(parents=True, exist_ok=True)
        os.symlink(home / inside, home / name)
        assert writable(str(home / name)) is None
        if name == "notes":
            assert writable(str(home / "notes" / "x.md")) is None

    def test_a_read_past_the_seatbelt_follows_the_same_list(self, home):
        from tools.file_operations import ShellFileOperations

        (home / "mcp-tokens").mkdir()
        (home / "mcp-tokens" / "srv.json").write_text("live-token")
        (home / "SOUL.md").write_text("soul text")
        class TheNormalWay(Exception):
            pass

        def normal_way():
            raise TheNormalWay

        ops = object.__new__(ShellFileOperations)
        ops._native_read_enabled = normal_way
        assert ShellFileOperations._read_exact_bytes(ops, str(home / "SOUL.md")) == (b"soul text", None)
        with pytest.raises(TheNormalWay):  # not served past the Seatbelt: it goes the way any other read goes
            ShellFileOperations._read_exact_bytes(ops, str(home / "mcp-tokens" / "srv.json"))


class TestOwnProfileAtTheGate:
    """The plugin's real gate, a signed policy and a fake main: what stays off the list takes the normal way, and asks."""

    @pytest.fixture
    def gate(self, wired, tmp_path, monkeypatch):
        monkeypatch.setattr("hermes_cli.iclone_policy_env.confined_at_exec", lambda: True)
        home = tmp_path / ".hermes"
        home.mkdir(exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))

        def make(**body):
            mod, main, _ = wired(_body(**body))
            monkeypatch.setattr("hermes_cli.iclone_policy_env.confined_at_exec", lambda: True)
            return mod, main, home

        yield make
        from hermes_cli import iclone_policy_env

        iclone_policy_env._reset_for_tests(None)

    @pytest.mark.parametrize("rel", ["platforms/pairing/telegram-approved.json", "mcp-tokens/srv.json", "scripts/x.js",
                                     "node_modules/a/index.js", "hermes-agent/pyproject.toml"])
    def test_manual_asks_for_the_rest_of_the_home(self, gate, rel):
        mod, main, home = gate(standing="manual")
        out = mod.on_pre_tool_call("write_file", {"path": str(home / rel), "content": "x"}, "t", "s1")
        asks = main.verbs("ask")
        assert asks and asks[-1]["target"] == str(home / rel), (out, asks)

    @pytest.mark.parametrize("rel", ["SOUL.md", "memories/MEMORY.md", "notes/a.md"])
    def test_manual_does_not_ask_for_the_agents_own(self, gate, rel):
        mod, main, home = gate(standing="manual")
        assert mod.on_pre_tool_call("write_file", {"path": str(home / rel), "content": "x"}, "t", "s1") is None
        assert main.verbs("ask") == []


def test_the_tool_description_names_the_one_exception_to_persisting_state():
    """g18: the runtime promises that cwd and exports persist; an approved command run once outside the Seatbelt does not
    carry them, and the launcher adds no text around what the owner approved, so the model is told before it relies on it."""
    from tools.terminal_tool import TERMINAL_TOOL_DESCRIPTION as text
    line = next(row for row in text.splitlines() if row.startswith("Environment state persists"))
    assert "once outside the Seatbelt" in line and "cd and export do not carry" in line
    assert "chain them in one command or use absolute paths" in line
