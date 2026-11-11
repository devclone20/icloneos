"""G2 A4, A5, A6: what the owner's Allow does beyond a plain foreground command. Real launcher and stub."""
import hashlib
import json
import os
import signal
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unicodedata
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.plugins.test_iclone_launcher import L, World
from tests.plugins.test_iclone_one_shot import _plugin, grant, run

STUB = L.HERE + "/stub.py"
darwin = pytest.mark.skipif(sys.platform != "darwin", reason="the launcher's macOS path")


@pytest.fixture
def w():
    world = World()
    world.policy()
    world.start()
    (world.home / "Library").mkdir()
    yield world
    world.close()


def grant_file(w, path, exp=None):
    row = {"v": 1, "id": os.urandom(16).hex(), "kind": "file", "sha": hashlib.sha256(path.encode()).hexdigest(),
           "cwd": os.path.dirname(path), "ts": time.time(), "exp": exp or time.time() + 120}
    with open(os.path.join(str(w.ledger), L.ONESHOT_FILE), "a", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\n")


def write(w, path, content=b"hello\n"):
    env = {"PATH": os.environ["PATH"], "ICLONE_RUN_CWD": os.path.dirname(path) or "/", L.ONEFILE_ENV: path, "HOME": str(w.home)}
    return subprocess.run([sys.executable, "-I", "-S", STUB, w.socket, "--", L.SANDBOX_EXEC, L.ONEFILE_FLAG], env=env,
                          input=content, capture_output=True, timeout=30)


# ── A5 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("rel", ["notes.txt", "Library/notes.txt", ".my-notes", "Library/.hidden", "Library/app/sub/notes.txt",
                                 "Library/Application Support/Some App/settings.json"])
def test_a5_allow_writes_that_one_file_directly_in_home_or_library(w, rel):
    path = str(w.home / rel)
    grant_file(w, path)
    proc = write(w, path, b"approved\n")
    assert proc.returncode == 0, proc.stderr
    assert open(path, "rb").read() == b"approved\n"
    row = [r for r in w.journal() if r.get("ev") == "start"][-1]
    assert row["unconfined"] is True and row["command"].startswith("[ran once outside the Seatbelt") and path in row["command"]
    assert not [n for n in os.listdir(os.path.dirname(path)) if n.startswith(".iclone-one-")]  # no temporary left


def test_a5_it_is_one_write_and_one_file_never_the_folder(w):
    path, other = str(w.home / "a.txt"), str(w.home / "b.txt")
    grant_file(w, path)
    assert write(w, other).returncode == 126 and not os.path.exists(other)
    assert write(w, path, b"1").returncode == 0
    second = write(w, path, b"2")
    assert second.returncode == 126 and open(path, "rb").read() == b"1"


def test_a5_an_existing_file_keeps_its_mode(w):
    path = w.home / "mode.txt"
    path.write_text("old")
    path.chmod(0o640)
    grant_file(w, str(path))
    assert write(w, str(path), b"new").returncode == 0
    assert path.read_text() == "new" and (path.stat().st_mode & 0o777) == 0o640


@pytest.mark.parametrize("rel", [".zshrc", ".gitconfig", ".ssh/authorized_keys", ".ssh/config", "Library/LaunchAgents/evil.plist",
                                 ".local/bin/tool", "Library/app/.git/hooks/pre-commit", "elsewhere/.git/config", ".npmrc",
                                 ".pgpass", "Library/Keychains/x", "Library/Application Support/Google/Chrome/Default/Login Data",
                                 "Library/Safari/Bookmarks.plist", "Library/Caches/pip/d/x"])
def test_g23_owner_ruling_the_launcher_writes_every_held_kind_with_main_s_row(w, rel):
    path = str(w.home / rel)
    grant_file(w, path)
    proc = write(w, path, b"the owner allowed\n")
    assert proc.returncode == 0, proc.stderr
    assert open(path, "rb").read() == b"the owner allowed\n"


@pytest.mark.parametrize("rel", [".zshrc", ".ssh/config", "Library/LaunchAgents/evil.plist"])
def test_g23_a_held_kind_with_no_row_stays_unwritten(w, rel):
    path = str(w.home / rel)
    assert write(w, path).returncode == 126 and not os.path.exists(path)


@pytest.mark.parametrize("rel", ["sub/x.txt", ".hermes/plugins/x.py", ".hermes/config.yaml", ".HERMES/config.yaml", ".Hermes/.env"])
def test_g23_this_app_s_own_files_and_a_folder_a_grant_opens_take_no_row(w, rel):
    path = str(w.home / rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    grant_file(w, path)
    proc = write(w, path)
    assert proc.returncode == 126 and not os.path.exists(path)


def test_g23_the_app_data_outside_the_home_takes_no_row(w):
    path = str(w.root / "userData" / "confinement" / "ledger" / "oneshots.jsonl")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    grant_file(w, path)
    assert write(w, path).returncode == 126 and not os.path.exists(path)


def test_g22_a_sub_folder_in_library_reached_through_a_link_is_refused(w):
    target = w.root / "elsewhere"
    target.mkdir()
    (w.home / "Library" / "away").symlink_to(target)
    path = str(w.home / "Library" / "away" / "x.txt")
    grant_file(w, path)
    assert write(w, path).returncode == 126 and not (target / "x.txt").exists()


def test_a5_a_link_is_refused_and_its_target_untouched(w):
    target = w.root / "outside.txt"
    link = w.home / "link.txt"
    link.symlink_to(target)
    grant_file(w, str(link))
    assert write(w, str(link), b"owned").returncode == 126
    assert target.read_text() == "outside-secret\n" and link.is_symlink()


def test_a5_a_folder_is_refused(w):
    folder = w.home / "Desktop"
    folder.mkdir()
    grant_file(w, str(folder))
    assert write(w, str(folder)).returncode == 126 and folder.is_dir()


def test_a5_a_denied_or_protected_name_is_refused(w):
    path = str(w.root / "denied")  # not in the home at all
    grant_file(w, path)
    assert write(w, path).returncode == 126


def test_a5_a_spelling_that_moves_the_path_is_refused(w):
    path = str(w.home) + "/sub/../x.txt"
    grant_file(w, path)
    assert write(w, path).returncode == 126 and not os.path.exists(str(w.home / "x.txt"))


def test_a5_a_file_row_can_not_run_as_a_command_nor_a_command_row_write_a_file(w):
    path = str(w.home / "script.txt")
    grant_file(w, path)
    assert run(w, path, str(w.home)).returncode == 126
    grant(w, str(w.home / "other.txt"), str(w.home))
    assert write(w, str(w.home / "other.txt")).returncode == 126 and not os.path.exists(str(w.home / "other.txt"))


def test_a5_the_runtime_offers_only_a_file_directly_in_home_or_library(w, monkeypatch):
    plugin = _plugin()
    core = L.core
    monkeypatch.setattr(plugin, "_confinement_core", lambda: core)
    monkeypatch.setattr(core, "trusted_index", lambda: w.index)
    monkeypatch.setattr(core, "runtime_confined", lambda: True)
    home = str(w.home)
    for tool, args, ok in [
        ("write_file", {"path": home + "/x.txt"}, True),
        ("write_file", {"path": home + "/Library/x.txt"}, True),
        ("patch", {"path": home + "/x.txt", "mode": "replace", "old_string": "a", "new_string": "b"}, True),
        ("write_file", {"path": home + "/.my-notes"}, True),
        ("write_file", {"path": home + "/Library/app/sub/x.txt"}, True),
        ("write_file", {"path": home + "/.zshrc"}, True),
        ("write_file", {"path": home + "/.gitconfig"}, True),
        ("write_file", {"path": home + "/Library/LaunchAgents/x.plist"}, True),
        ("write_file", {"path": home + "/.ssh/config"}, True),
        ("write_file", {"path": home + "/.hermes/config.yaml"}, False),
        ("write_file", {"path": home + "/sub/x.txt"}, False),
        ("write_file", {"path": str(w.proj / "x.txt")}, False),
        ("write_file", {"path": "x.txt"}, False),
        ("patch", {"path": home + "/x.txt", "mode": "patch", "patch": "..."}, False),
        ("terminal", {"path": home + "/x.txt"}, False),
    ]:
        assert bool(plugin._file_one_shot(tool, args)) is ok, (tool, args)


def _confinement():
    import importlib
    import importlib.util
    from pathlib import Path

    folder = Path(L.HERE)
    if "g2_confinement" not in sys.modules:
        spec = importlib.util.spec_from_file_location("g2_confinement", folder / "__init__.py", submodule_search_locations=[str(folder)])
        module = importlib.util.module_from_spec(spec)
        sys.modules["g2_confinement"] = module
        spec.loader.exec_module(module)
    return importlib.import_module("g2_confinement.seatbelt")


def test_a5_the_file_tool_takes_the_approval_once_and_never_without_it(monkeypatch):
    seatbelt = _confinement()
    env = object.__new__(seatbelt.SeatbeltEnvironment)
    sent = []
    monkeypatch.setattr(seatbelt.core, "runtime_confined", lambda: True)
    monkeypatch.setattr(seatbelt.core, "send_approved_file", lambda path, data, _base=None: sent.append((path, data)) or len(data))
    assert env.write_approved_file("/h/x.txt", "hi") is None and sent == []
    seatbelt.core.note_approved_file("/h/x.txt")
    assert env.write_approved_file("/h/y.txt", "hi") is None and sent == []
    assert env.write_approved_file("/h/x.txt", "hi") == 2 and sent == [("/h/x.txt", b"hi")]
    assert env.write_approved_file("/h/x.txt", "again") is None and len(sent) == 1


def test_g23_this_app_s_own_file_tells_the_agent_the_route_that_works(w, monkeypatch):
    seatbelt = _confinement()
    env = object.__new__(seatbelt.SeatbeltEnvironment)
    monkeypatch.setattr(seatbelt.core, "trusted_index", lambda: w.index)
    monkeypatch.setattr(seatbelt.core, "runtime_confined", lambda: True)
    own = w.home / ".hermes" / "config.yaml"
    with pytest.raises(seatbelt.core.ConfinementRefused) as refused:
        env.write_approved_file(str(own), "x")
    said = str(refused.value)
    assert str(own) in said and "terminal tool" in said and "getcwd" not in said and "not even after" not in said
    assert not own.exists()
    # Nothing is said about a file the kernel may yet let through: the run goes on as ever.
    assert env.write_approved_file(str(w.proj / "x.txt"), "x") is None
    # G23: a held kind with no answer from main is no refusal in words either: the gate asks first.
    assert env.write_approved_file(str(w.home / ".zshrc"), "x") is None
    assert env.write_approved_file(str(w.home / "Library" / "Caches" / "x"), "x") is None


def test_a5_write_file_uses_the_environment_s_approved_write_after_the_deny_list(monkeypatch, tmp_path):
    from tools.file_operations import ShellFileOperations

    ops = object.__new__(ShellFileOperations)
    ops._expand_path = lambda p: p
    wrote = []
    ops.env = type("E", (), {"write_approved_file": lambda self, p, c: wrote.append(p) or len(c)})()
    out = ShellFileOperations.write_file(ops, str(tmp_path / "x.txt"), "abc")
    assert out.error is None and out.bytes_written == 3 and wrote == [str(tmp_path / "x.txt")]
    monkeypatch.setattr("tools.file_operations.get_write_denied_error", lambda p: "denied by the list")
    wrote.clear()
    out = ShellFileOperations.write_file(ops, str(tmp_path / "y.txt"), "abc")
    assert out.error == "denied by the list" and wrote == []


@pytest.mark.parametrize("tail,ok", [
    (["/usr/bin/sandbox-exec", "--iclone-onefile"], True),
    (["/usr/bin/sandbox-exec", "--iclone-onefile", "/etc/x"], False),
    (["/usr/bin/sandbox-exec", "--iclone-onefile-read"], True),
    (["/usr/bin/sandbox-exec", "--iclone-onefile-read", "/etc/x"], False),
    (["/usr/bin/sandbox-exec", "--iclone-oneshot"], False),
    (["/bin/sh", "--iclone-onefile"], False),
])
def test_a5_the_spawn_guard_lets_exactly_this_stub_form_through(monkeypatch, tail, ok):
    from tests.tools.test_computer_use_seatbelt_door import _decide
    from tools.environments.host_lane import STUB_FILE

    argv = [sys.executable, "-I", "-S", os.path.realpath(str(STUB_FILE)), "/tmp/l.sock", "--", *tail]
    assert _decide(argv, monkeypatch)[0] is ok


def test_a5_the_argv_really_sent_passes_the_guard_when_the_plugin_lives_in_another_tree(monkeypatch, request):
    """The app's plugin tree is not the runtime root (red live: g2.root_wrote at 2e2d1e8d08)."""
    from tests.tools.test_computer_use_seatbelt_door import _decide

    core = _confinement().core
    short = tempfile.mkdtemp(prefix="a5", dir="/private/tmp")  # a socket path has a short limit; pytest's tmp_path can pass it
    request.addfinalizer(lambda: shutil.rmtree(short, ignore_errors=True))
    sock = os.path.join(short, "l.sock")
    server = socket.socket(socket.AF_UNIX)
    server.bind(sock)
    monkeypatch.setenv("ICLONE_CONFINEMENT_LAUNCHER", sock)
    monkeypatch.setattr(core, "runtime_confined", lambda: True)
    monkeypatch.setattr(core, "STUB", "/elsewhere/plugins/iclone-confinement/stub.py")
    sent = []
    monkeypatch.setattr(core.subprocess, "run", lambda argv, **k: sent.append(argv) or SimpleNamespace(returncode=0, stderr=b""))
    assert core.send_approved_file("/h/x.txt", b"hi") == 2
    server.close()
    assert _decide(sent[0], monkeypatch)[0] is True


# ── A4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────


def _wrapper(w, text, session="ab12cd34"):
    from tools.process_registry import background_shell

    (w.scratch / "tmp").mkdir(parents=True, exist_ok=True)
    return background_shell(text, str(w.scratch / "tmp"), session)


def run_bg(w, text, cwd, wrapper):
    env = {"PATH": os.environ["PATH"], "ICLONE_RUN_CWD": cwd, L.ONESHOT_ENV: text, L.ONESHOT_BACKGROUND_ENV: wrapper, "HOME": str(w.home)}
    # Files, as the wrapper's background subshell keeps its stdout open: the runtime's reader stops at the stub's exit.
    with tempfile.TemporaryFile("w+") as out, tempfile.TemporaryFile("w+") as err:
        done = subprocess.run([sys.executable, "-I", "-S", STUB, w.socket, "--", L.SANDBOX_EXEC, L.ONESHOT_FLAG], env=env,
                              stdout=out, stderr=err, text=True, timeout=30, cwd=cwd)
        out.seek(0)
        err.seek(0)
        return SimpleNamespace(returncode=done.returncode, stdout=out.read(), stderr=err.read())


def _until(check, seconds=8.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.05)
    return False


@darwin
def test_a4_allow_on_a_background_command_runs_outside_and_keeps_running_until_stopped(w, tmp_path):
    cwd = os.path.realpath(str(tmp_path))
    mark = tmp_path / "bg-ran"
    text = f"echo out; echo x > {mark}; sleep 60"
    grant(w, text, cwd)
    proc = run_bg(w, text, cwd, _wrapper(w, text))
    assert proc.returncode == 0, proc.stderr
    pid = int(proc.stdout.strip().splitlines()[-1])
    assert _until(mark.exists), "the approved command did not run outside the Seatbelt"
    log = w.scratch / "tmp" / "hermes_bg_ab12cd34.log"
    assert _until(lambda: log.exists() and "out" in log.read_text())
    time.sleep(1.0)  # the wrapper has ended: the approval covers the command the owner read, still running
    assert w.launcher._background(pid, False)["alive"] is True
    row = [r for r in w.journal() if r.get("ev") == "start"][-1]
    assert row["unconfined"] is True and row["command"].startswith("[ran once outside the Seatbelt") and text in row["command"]
    stopped = w.launcher._background(pid, True)
    assert stopped["left"] == [] and w.launcher._background(pid, False)["alive"] is False


@darwin
@pytest.mark.live_system_guard_bypass
def test_g17_a_hangup_does_not_read_as_ended_while_the_command_lives(w, tmp_path):
    """proof9 row 11, real app: a hangup to the pid the tool answered, and the poll read exited -1 with the command alive."""
    cwd = os.path.realpath(str(tmp_path))
    text = "sleep 5; echo G17DONE"
    grant(w, text, cwd)
    proc = run_bg(w, text, cwd, _wrapper(w, text))
    pid = int(proc.stdout.strip().splitlines()[-1])
    log = w.scratch / "tmp" / "hermes_bg_ab12cd34.log"
    time.sleep(1.0)
    group = os.getpgid(pid)
    os.kill(pid, signal.SIGHUP)
    seen = []
    for _ in range(4):
        time.sleep(0.5)
        try:
            now = os.getpgid(pid)
        except OSError as exc:
            now = repr(exc)
        seen.append((now, w.launcher._background(pid, False)["alive"]))
    print("group", group, "seen", seen)
    assert all(alive for _, alive in seen), seen
    assert _until(lambda: "G17DONE" in log.read_text(), 8.0)


@darwin
def test_a4_a_background_command_ends_with_the_launcher(w, tmp_path):
    cwd = os.path.realpath(str(tmp_path))
    text = "sleep 60"
    grant(w, text, cwd)
    pid = int(run_bg(w, text, cwd, _wrapper(w, text)).stdout.strip().splitlines()[-1])
    assert _until(lambda: w.launcher._background(pid, False)["alive"])
    w.launcher.stop()

    def gone():
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        return False

    assert _until(gone)


def test_a4_a_replay_of_a_background_command_stays_refused(w, tmp_path):
    cwd = os.path.realpath(str(tmp_path))
    text = "true"
    grant(w, text, cwd)
    assert run_bg(w, text, cwd, _wrapper(w, text)).returncode == 0
    assert run_bg(w, text, cwd, _wrapper(w, text, "ab12cd35")).returncode == 126


@pytest.mark.parametrize("bad", ["other-text", "log-outside", "shape"])
def test_a4_a_wrapper_not_exactly_the_one_for_the_text_runs_nothing(w, tmp_path, bad):
    cwd = os.path.realpath(str(tmp_path))
    mark = tmp_path / "ran"
    target = tmp_path / "victim"
    text = f"touch {mark}"
    grant(w, text, cwd)
    if bad == "other-text":
        wrapper = _wrapper(w, f"touch {target}")
    elif bad == "log-outside":
        wrapper = _wrapper(w, text).replace(shlex.quote(str(w.scratch / "tmp")), shlex.quote(str(tmp_path)))
    else:
        wrapper = _wrapper(w, text) + f"; touch {target}"
    assert run_bg(w, text, cwd, wrapper).returncode == 126
    time.sleep(0.3)
    assert not mark.exists() and not target.exists() and not (tmp_path / "hermes_bg_ab12cd34.log").exists()


def test_a4_a_link_planted_as_the_log_is_never_written_through(w, tmp_path):
    cwd = os.path.realpath(str(tmp_path))
    victim = tmp_path / "victim"
    victim.write_text("kept\n")
    (w.scratch / "tmp").mkdir(parents=True, exist_ok=True)
    (w.scratch / "tmp" / "hermes_bg_ab12cd34.log").symlink_to(victim)
    text = "echo overwritten"
    grant(w, text, cwd)
    run_bg(w, text, cwd, _wrapper(w, text))
    time.sleep(0.5)
    assert victim.read_text() == "kept\n"


def test_a4_a_foreground_one_shot_still_takes_its_children_with_it(w, tmp_path):
    cwd = os.path.realpath(str(tmp_path))
    mark = tmp_path / "late"
    text = f"(sleep 1; touch {mark}) &"
    grant(w, text, cwd)
    assert run(w, text, cwd).returncode == 0
    time.sleep(1.6)
    assert not mark.exists()


def test_a4_the_runtime_hands_the_inner_text_and_the_wrapper(monkeypatch, tmp_path):
    seatbelt = _confinement()
    from tools.environments.local import LocalEnvironment
    from tools.process_registry import background_shell

    env = object.__new__(seatbelt.SeatbeltEnvironment)
    env._scratch = str(tmp_path)
    seen = {}
    monkeypatch.setattr(LocalEnvironment, "execute", lambda self, c, cwd="", **k: seen.update(seatbelt._REQUEST.get()) or {"output": "123", "returncode": 0})
    monkeypatch.setattr(seatbelt.core, "runtime_confined", lambda: True)
    monkeypatch.setattr(env, "explain_after_run", lambda *_: None, raising=False)
    wrapper = background_shell("npm run dev", "/tmp/s", "abc")
    seen.clear()
    env.execute(wrapper, cwd="/p")  # no approval
    assert not seen.get("one_shot")
    seatbelt.core.note_approved_command("npm run dev")
    env.execute(background_shell("npm run other", "/tmp/s", "abc"), cwd="/p")
    assert not seen.get("one_shot")
    env.execute(wrapper, cwd="/p")
    assert seen["one_shot"] is True and seen["one_shot_text"] == "npm run dev" and seen["command"] == wrapper


@pytest.mark.parametrize("args,target,ok", [
    ({"command": "npm run dev", "background": True}, "npm run dev", True),
    ({"command": "brew install x", "pty": True}, "brew install x", True),
    ({"command": "npm run dev", "background": True}, "npm run other", False),
])
def test_a4_background_and_pty_are_offered_for_the_text_the_owner_reads(args, target, ok, tmp_path):
    assert bool(_plugin()._shell_one_shot("terminal", args, target, str(tmp_path))) is ok


def test_a4_execute_code_is_never_offered_outside(tmp_path):
    assert _plugin()._shell_one_shot("execute_code", {"code": "x", "command": "x"}, "x", str(tmp_path)) is None


# ── A6 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────


class TestOwnProfileSeatbeltOff:
    @pytest.fixture
    def home(self, tmp_path, monkeypatch):
        home = tmp_path / "home"
        (home / "memories").mkdir(parents=True)
        monkeypatch.setenv("HERMES_HOME", str(home))
        monkeypatch.setattr("hermes_cli.iclone_policy_env.confined_at_exec", lambda: False)
        monkeypatch.setattr("hermes_cli.iclone_policy_env.isolation_off", lambda: True)
        return home

    @pytest.mark.parametrize("rel", ["SOUL.md", "memories/MEMORY.md"])
    def test_own_files_do_not_ask(self, home, rel):
        assert _plugin()._own_profile_write("write_file", {"path": str(home / rel)}) is True

    def test_memory_does_not_ask(self, home):
        assert _plugin()._own_profile_write("memory", {}) is True

    @pytest.mark.parametrize("rel", ["config.yaml", ".env", "auth.json", "memories/x.db", "../SOUL.md", "plugins/a.md"])
    def test_the_neighbours_still_ask(self, home, rel):
        assert _plugin()._own_profile_write("write_file", {"path": str(home / rel)}) is False

    def test_the_direct_write_branch_stays_for_the_seatbelt(self, home):
        from tools.iclone_own_profile import writable

        assert writable(str(home / "SOUL.md")) is None

    def test_a_process_icloneos_did_not_start_still_asks(self, home, monkeypatch):
        monkeypatch.setattr("hermes_cli.iclone_policy_env.isolation_off", lambda: False)
        assert _plugin()._own_profile_write("memory", {}) is False
        assert _plugin()._own_profile_write("write_file", {"path": str(home / "SOUL.md")}) is False


# ── G23: the writer holds the folder it checked; one file never lands where a command can swap the path ───────────────


def writer(path, home, **kwargs):
    return subprocess.Popen([sys.executable, "-I", "-S", "-c", L.ONEFILE_WRITER, path, str(home)], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)


def test_g23_m1_a_link_in_the_folder_path_is_refused_and_nothing_made_behind_it(w):
    victim = w.root / "victim"
    victim.mkdir()
    folder = w.home / "Library" / "app"
    folder.mkdir(parents=True)
    (folder / "d").symlink_to(victim)
    proc = writer(str(folder / "d" / "new" / "x"), w.home)
    _, err = proc.communicate(b"owned", timeout=30)
    assert proc.returncode != 0 and b"Nothing was changed" in err
    assert os.listdir(victim) == []


def test_g23_m1_a_folder_swapped_for_a_link_after_the_walk_never_redirects_the_write(w):
    victim = w.root / "victim"
    victim.mkdir()
    (victim / "x").write_text("secret")
    parent = w.home / "Library" / "app"
    held = parent / "d"
    held.mkdir(parents=True)
    proc = writer(str(held / "x"), w.home)
    deadline = time.time() + 20
    while not [n for n in os.listdir(held) if n.startswith(".iclone-one-")]:
        assert time.time() < deadline and proc.poll() is None
        time.sleep(0.01)
    held.rename(parent / "moved")
    held.symlink_to(victim)
    proc.communicate(b"written", timeout=30)
    assert (victim / "x").read_text() == "secret" and os.listdir(victim) == ["x"]
    assert proc.returncode == 0 and (parent / "moved" / "x").read_bytes() == b"written"


def test_g23_m1_the_walk_makes_each_missing_folder(w):
    path = w.home / "Library" / "a" / "b" / "c" / "x"
    proc = writer(str(path), w.home)
    proc.communicate(b"made", timeout=30)
    assert proc.returncode == 0 and path.read_bytes() == b"made" and (path.stat().st_mode & 0o777) == 0o644


def test_g23_m1_a_target_turned_into_a_link_is_refused(w):
    victim = w.root / "victim.txt"
    victim.write_text("secret")
    path = w.home / "t.txt"
    path.symlink_to(victim)
    proc = writer(str(path), w.home)
    proc.communicate(b"owned", timeout=30)
    assert proc.returncode != 0 and victim.read_text() == "secret" and path.is_symlink()


def _shut_index(w):
    data = w.root / "userData"
    return SimpleNamespace(home=str(w.home), protected_writes=(str(w.home / ".zshrc"),), denied=[str(data), str(w.home / ".ssh")],
                           app_files=(str(data), str(w.home / ".hermes")), pnpm_store_roots=(), scratch_root=str(data / "scratch"),
                           refusals_dir=str(data / "refusals"), hardlink_acks="")


@pytest.mark.parametrize("where", ["userData/consent.json", "USERDATA/consent.json"])
def test_g23_this_app_s_own_files_get_the_plain_sentence_by_any_case(w, where):
    said = L.core.file_stays_shut(_shut_index(w), str(w.root / where))
    assert said and "own files" in said and "the terminal tool" in said and "not even after" not in said


def test_g23_a_held_kind_gets_no_refusal_sentence(w):
    index = _shut_index(w)
    for rel in (".zshrc", ".ssh/config", "Library/app/.git/config", ".pgpass"):
        assert L.core.file_stays_shut(index, str(w.home / rel)) is None


def test_g23_the_holes_in_the_app_data_stay_open(w):
    index, data = _shut_index(w), w.root / "userData"
    for hole in ("scratch/x.txt", "scratch/repo/.git/config", "refusals/x"):
        assert L.core.file_stays_shut(index, str(data / hole)) is None


def test_g23_a_link_in_the_home_is_told_what_works(w):
    index = _shut_index(w)
    link = w.home / "dotlink"
    link.symlink_to(w.root / "outside.txt")
    assert "link" in L.core.file_stays_shut(index, str(link))


# ── G23: per mode. Main alone issues the row; the runtime asks it whenever this route is the way. ─────────────────────


class _Channel:
    healthy = True

    def __init__(self, body):
        self.body, self.asks, self.emits = body, [], []

    def register_ask(self, payload):
        self.asks.append(payload)
        return SimpleNamespace(ok=True, body=self.body), 1

    def emit(self, payload):
        self.emits.append(payload)


def _body(mode):
    from tests.plugins.test_iclone_permissions import _body as real_body

    return real_body(standing=mode)


def _gate(monkeypatch, w, mode, answer):
    plugin, core = _plugin(), L.core
    monkeypatch.setattr(plugin, "_confinement_core", lambda: core)
    monkeypatch.setattr(core, "runtime_confined", lambda: True)
    monkeypatch.setattr(core, "trusted_index", lambda: w.index)
    channel = _Channel(answer)
    body = _body(mode)
    monkeypatch.setitem(plugin._state, "channel", channel)
    monkeypatch.setitem(plugin._state, "policy", SimpleNamespace(body=lambda: body))
    return plugin, core, channel


@pytest.mark.parametrize("mode", ["manual", "acceptEdits", "automatic", "ignore"])
def test_g23_every_mode_but_plan_goes_to_main_and_main_s_answer_opens_the_route(monkeypatch, w, mode):
    path = str(w.home / ".zshrc")
    plugin, core, channel = _gate(monkeypatch, w, mode, {"state": "decided", "allowed": True, "grantId": None, "oneFile": True})
    assert plugin._decide("write_file", {"path": path, "content": "x"}, "t", "s", f"i-{mode}", {}) is None
    assert channel.asks and channel.asks[0]["oneFilePath"] == path and channel.asks[0]["mode"] == mode
    assert core.approved_file_waiting(path) is True and core.take_approved_file(path) is True


def test_g23_ignore_without_main_s_row_opens_nothing(monkeypatch, w):
    path = str(w.home / ".gitconfig")
    plugin, core, channel = _gate(monkeypatch, w, "ignore", {"state": "decided", "allowed": True, "grantId": None})
    assert plugin._decide("write_file", {"path": path, "content": "x"}, "t", "s", "i-none", {}) is None
    assert channel.asks and core.approved_file_waiting(path) is False


def test_g23_plan_stays_read_only_and_says_to_switch(monkeypatch, w):
    path = str(w.home / ".zshrc")
    plugin, core, channel = _gate(monkeypatch, w, "plan", {"state": "decided", "allowed": True})
    said = plugin._decide("write_file", {"path": path, "content": "x"}, "t", "s", "i-plan", {})
    assert said["action"] == "block" and "Plan" in said["message"] and "mode" in said["message"]
    assert not channel.asks and core.approved_file_waiting(path) is False


# ── G23: after main's answer no other list says no and no gate asks twice ────────────────────────────────────────────


@pytest.mark.parametrize("rel", [".npmrc", ".pgpass", ".ssh/authorized_keys", ".aws/credentials"])
def test_g23_the_tool_deny_list_stands_aside_only_for_main_s_answer(monkeypatch, tmp_path, rel):
    from tools import file_operations as fo
    monkeypatch.setattr("agent.file_safety._homes_and_resolved", lambda p: ({str(tmp_path)}, str(tmp_path / rel)))
    path = str(tmp_path / rel)
    answered = {path}
    env = SimpleNamespace(approved_file_waiting=lambda p: p in answered, write_approved_file=lambda p, c: answered.discard(p) or len(c))
    ops = SimpleNamespace(env=env, _expand_path=lambda p: p, _reject_unencodable=lambda p, c: None,
                          _fail_closed_syntax_error=lambda p, e, c: None)
    monkeypatch.setattr("tools.iclone_own_profile.writable", lambda p: None)
    assert fo.ShellFileOperations.write_file(ops, path, "abc").bytes_written == 3
    assert "denied" in fo.ShellFileOperations.write_file(ops, path, "abc").error


# ── G23-W2: a file is edited, never blindly replaced; links, the Seatbelt off, Ignore in a folder a grant could open ──────


def _row(w, path, **extra):
    row = {"v": 1, "id": os.urandom(16).hex(), "sha": hashlib.sha256(path.encode()).hexdigest(), "cwd": os.path.dirname(path),
           "ts": time.time(), "exp": time.time() + 120, **extra}
    with open(os.path.join(str(w.ledger), L.ONESHOT_FILE), "a", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\n")


def _read(w, path):
    env = {"PATH": os.environ["PATH"], "ICLONE_RUN_CWD": os.path.dirname(path) or "/", L.ONEFILE_ENV: path, "HOME": str(w.home)}
    return subprocess.run([sys.executable, "-I", "-S", STUB, w.socket, "--", L.SANDBOX_EXEC, L.ONEFILE_READ_FLAG], env=env,
                          capture_output=True, timeout=30)


def _held(w, rel, content=b"secret\xff\n"):
    path = w.home / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return str(path)


def test_w2_read_returns_that_file_s_bytes_once_with_a_row_of_its_own(w):
    path = _held(w, ".ssh/config")
    _row(w, path, kind="read")
    proc = _read(w, path)
    assert proc.returncode == 0 and proc.stdout == b"secret\xff\n", proc.stderr
    row = [r for r in w.journal() if r.get("ev") == "start"][-1]
    assert row["unconfined"] is True and "read one file" in row["command"] and path in row["command"] and row["write"] is False
    assert _read(w, path).returncode == 126


def test_w2_a_read_needs_its_own_kind_of_row(w):
    path = _held(w, ".ssh/config")
    assert _read(w, path).returncode == 126
    grant_file(w, path)
    assert _read(w, path).returncode == 126
    assert open(path, "rb").read() == b"secret\xff\n"
    other = _held(w, ".aws/credentials")
    _row(w, other, kind="read")
    assert write(w, other).returncode == 126 and open(other, "rb").read() == b"secret\xff\n"


def test_w2_a_read_never_reaches_this_app_s_own_files(w):
    path = _held(w, ".hermes/.env")
    _row(w, path, kind="read")
    proc = _read(w, path)
    assert proc.returncode == 126 and proc.stdout == b""


def test_w2_the_reader_follows_no_link(w):
    victim = w.root / "victim"
    victim.mkdir()
    (victim / "x").write_text("outside")
    folder = w.home / "Library" / "a"
    folder.mkdir()
    (folder / "d").symlink_to(victim)
    proc = subprocess.run([sys.executable, "-I", "-S", "-c", L.ONEFILE_READER, str(folder / "d" / "x"), str(w.home)], capture_output=True)
    assert proc.returncode != 0 and proc.stdout == b""


def test_w2_a_file_the_runtime_could_not_stat_is_never_overwritten_unread(w):
    path = _held(w, ".ssh/config", b"old")
    proc = subprocess.Popen([sys.executable, "-I", "-S", "-c", L.ONEFILE_WRITER, path, str(w.home), "none"], stdin=subprocess.PIPE,
                            stderr=subprocess.PIPE)
    _, err = proc.communicate(b"new", timeout=30)
    assert proc.returncode != 0 and b"read" in err and open(path, "rb").read() == b"old"
    stale = subprocess.Popen([sys.executable, "-I", "-S", "-c", L.ONEFILE_WRITER, path, str(w.home), "0" * 64], stdin=subprocess.PIPE,
                             stderr=subprocess.PIPE)
    stale.communicate(b"new", timeout=30)
    assert stale.returncode != 0 and open(path, "rb").read() == b"old"
    seen = subprocess.Popen([sys.executable, "-I", "-S", "-c", L.ONEFILE_WRITER, path, str(w.home), hashlib.sha256(b"old").hexdigest()],
                            stdin=subprocess.PIPE)
    seen.communicate(b"new", timeout=30)
    assert seen.returncode == 0 and open(path, "rb").read() == b"new"
    fresh = str(w.home / ".ssh" / "fresh")
    made = subprocess.Popen([sys.executable, "-I", "-S", "-c", L.ONEFILE_WRITER, fresh, str(w.home), "none"], stdin=subprocess.PIPE)
    made.communicate(b"made", timeout=30)
    assert made.returncode == 0 and open(fresh, "rb").read() == b"made"


def test_w2_a_runtime_that_cannot_stat_it_sends_what_it_saw(monkeypatch, tmp_path):
    core, path = L.core, str(tmp_path / "x")
    assert core.one_file_seen(path) is None
    monkeypatch.setattr(core.os, "lstat", lambda *_a, **_k: (_ for _ in ()).throw(PermissionError()))
    assert core.one_file_seen(path) == "none"
    core.note_seen_file(path, b"old")
    assert core.one_file_seen(path) == hashlib.sha256(b"old").hexdigest()
    core.forget_seen_file(path)


def _route_env(data=b"alpha beta\n"):
    written = []
    taken = {"read": True}

    def read(_path):
        was, taken["read"] = taken["read"], False
        return data if was else None

    def boom(*_a, **_k):
        raise AssertionError("no confined run may be needed")

    env = SimpleNamespace(cwd="/", read_approved_file=read, approved_file_waiting=lambda _p: True,
                          write_approved_file=lambda p, c, **_k: written.append((p, c)) or len(c), execute=boom)
    return env, written


def test_w2_patch_on_a_route_file_reads_then_writes_and_no_confined_run_is_needed(monkeypatch):
    from tools import file_operations as fo
    monkeypatch.setattr("agent.file_safety.get_write_denied_error", lambda *_a, **_k: "denied")
    env, written = _route_env()
    ops = fo.ShellFileOperations(env, cwd="/")
    monkeypatch.setattr(ops, "_check_lint_delta", lambda *_a, **_k: None)
    result = ops.patch_replace("/lab/.ssh/config", "alpha", "gamma")
    assert result.success is True, result.error
    assert written == [("/lab/.ssh/config", "gamma beta\n")]


def test_w2_read_file_takes_the_route_when_main_answered():
    from tools import file_operations as fo
    env, _ = _route_env(b"one\ntwo\nthree\n")
    result = fo.ShellFileOperations(env, cwd="/").read_file("/lab/.ssh/config", 1, 2)
    assert "one" in result.content and "two" in result.content and "three" not in result.content
    assert result.total_lines == 3 and result.truncated is True and result.file_size == 14


def test_w2_patch_asks_no_second_time_after_main_s_answer(monkeypatch):
    from tools import file_tools as ft

    def asked(*_a, **_k):
        raise AssertionError("a second ask")

    monkeypatch.setattr("hermes_cli.iclone_policy_env.confined_at_exec", lambda: True)
    monkeypatch.setattr(ft, "_check_protected_instruction_write", asked)
    monkeypatch.setattr(ft, "_check_approval_required_write", asked)
    monkeypatch.setattr(ft, "_get_file_ops", lambda _t: SimpleNamespace(env=SimpleNamespace(approved_file_waiting=lambda _p: True)))
    monkeypatch.setattr(ft, "_resolve_or_none", lambda p, _t, **_k: p)
    monkeypatch.setattr(ft, "_check_sensitive_path", lambda *_a, **_k: None)
    monkeypatch.setattr(ft, "_check_binary_document_write", lambda *_a, **_k: None)
    assert ft._write_precheck_error(["/lab/.ssh/config"], ["/lab/.ssh/config"], "t", True) is None


def _gate_shut(monkeypatch, w, mode, answer):
    plugin, core, channel = _gate(monkeypatch, w, mode, answer)
    monkeypatch.setattr(core, "trusted_index", lambda: _shut_index(w))
    return plugin, core, channel


@pytest.mark.parametrize("mode", ["manual", "ignore"])
@pytest.mark.parametrize("rel", [".ssh/config", ".zshrc"])
def test_w2_a_read_the_kernel_refuses_goes_to_main_and_main_s_answer_opens_it(monkeypatch, w, mode, rel):
    path = _held(w, rel)
    plugin, core, channel = _gate_shut(monkeypatch, w, mode, {"state": "decided", "allowed": True, "grantId": None, "oneFile": True})
    assert plugin._decide("read_file", {"path": path}, "t", "s", f"r-{mode}", {}) is None
    assert channel.asks[0]["oneFilePath"] == path and core.take_approved_read(path) is True
    assert core.approved_file_waiting(path) is False


def test_w2_a_read_in_the_run_s_own_folder_asks_nothing_and_plan_opens_nothing(monkeypatch, w):
    readable, denied = _held(w, "project/x"), _held(w, ".ssh/config")
    plugin, core, channel = _gate_shut(monkeypatch, w, "manual", {"state": "decided", "allowed": True})
    monkeypatch.setattr(plugin, "_session_project", lambda _t: str(w.home / "project"))
    assert plugin._decide("read_file", {"path": readable}, "t", "s", "r-free", {}) is None and not channel.asks
    plugin, core, channel = _gate_shut(monkeypatch, w, "plan", {"state": "decided", "allowed": True})
    assert plugin._decide("read_file", {"path": denied}, "t", "s", "r-plan", {}) is None and not channel.asks


def test_w2_one_answer_for_a_patch_opens_its_read_and_its_write(monkeypatch, w):
    path = _held(w, ".ssh/config")
    plugin, core, _ = _gate_shut(monkeypatch, w, "ignore", {"state": "decided", "allowed": True, "grantId": None, "oneFile": True})
    assert plugin._decide("patch", {"path": path, "old_string": "a", "new_string": "b"}, "t", "s", "p-1", {}) is None
    assert core.take_approved_read(path) is True and core.take_approved_file(path) is True


def _dotfile(w, target_rel="sub/zshrc"):
    target = w.home / target_rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("old\n")
    link = w.home / ".zshrc"
    link.symlink_to(target)
    return str(link), str(target)


def test_w2_a_dotfile_link_resolves_to_its_real_target(w):
    link, target = _dotfile(w)
    assert L.core.one_file_target(_shut_index(w), link) == (target, None)
    assert L.core.one_file_target(_shut_index(w), str(w.home / "Documents" / "x"))[1] == L.core.ONE_FILE_GRANT


def test_w2_a_dangling_or_outside_or_own_link_gets_a_plain_refusal(w):
    index, core = _shut_index(w), L.core
    (w.root / "outside.txt").write_text("x")
    (w.home / "away").symlink_to(w.root / "outside.txt")
    (w.home / "gone").symlink_to(w.home / "not-there")
    own = w.home / ".hermes" / "config.yaml"
    own.parent.mkdir(parents=True, exist_ok=True)
    own.write_text("x")
    (w.home / "mine").symlink_to(own)
    for name, why in (("away", core.ONE_FILE_LINK_OUTSIDE), ("gone", core.ONE_FILE_LINK_DANGLING), ("mine", core.ONE_FILE_LINK_OUTSIDE)):
        assert core.one_file_target(index, str(w.home / name)) == (None, why)
        said = core.file_stays_shut(index, str(w.home / name))
        assert "was not written" in said and why in said


def test_w2_a_row_for_a_link_writes_its_target_and_activity_names_both(w):
    link, target = _dotfile(w)
    _row(w, target, kind="file", link=link)
    proc = write(w, target, b"new\n")
    assert proc.returncode == 0, proc.stderr
    assert open(target, "rb").read() == b"new\n" and os.path.islink(link) and os.path.realpath(link) == target
    row = [r for r in w.journal() if r.get("ev") == "start"][-1]
    assert target in row["command"] and link in row["command"]


def test_w2_a_link_that_moved_after_the_answer_opens_nothing(w):
    link, target = _dotfile(w)
    _row(w, target, kind="file", link=link)
    os.unlink(link)
    (w.home / "elsewhere").write_text("x")
    os.symlink(w.home / "elsewhere", link)
    assert write(w, target, b"new\n").returncode == 126 and open(target, "rb").read() == b"old\n"


def test_w2_the_gate_sends_the_target_and_the_link_and_opens_the_target(monkeypatch, w):
    link, target = _dotfile(w)
    plugin, core, channel = _gate_shut(monkeypatch, w, "manual", {"state": "decided", "allowed": True, "grantId": None, "oneFile": True})
    assert plugin._decide("write_file", {"path": link, "content": "x"}, "t", "s", "l-1", {}) is None
    assert channel.asks[0]["oneFilePath"] == target and channel.asks[0]["oneFileLink"] == link
    assert core.approved_file_waiting(target) is True
    assert core.take_approved_file(target) is True


@pytest.mark.parametrize("rel", [".npmrc", ".pgpass", ".netrc", ".ssh/authorized_keys", ".ssh/config", ".aws/credentials"])
def test_w2_the_seatbelt_off_opens_the_credential_list(monkeypatch, tmp_path, rel):
    from agent import file_safety as fs
    path = str(tmp_path / rel)
    monkeypatch.setattr(fs, "_guard_homes", lambda _p="": {str(tmp_path)})
    monkeypatch.setattr(fs, "_seatbelt_off", lambda: False)
    assert fs.is_write_approval_required(path) if rel == ".ssh/config" else fs.get_write_denied_error(path)
    monkeypatch.setattr(fs, "_seatbelt_off", lambda: True)
    assert fs.get_write_denied_error(path) is None and fs.is_write_approval_required(path) is False


@pytest.mark.parametrize("rel", [".env", "state.db", "vault/key", "auth/google_oauth.json"])
def test_w2_the_seatbelt_off_leaves_this_app_s_own_files_refused(monkeypatch, tmp_path, rel):
    from agent import file_safety as fs
    hermes = tmp_path / ".hermes"
    monkeypatch.setattr(fs, "_hermes_home_path", lambda: hermes)
    monkeypatch.setattr(fs, "_hermes_root_path", lambda: hermes)
    monkeypatch.setattr(fs, "_guard_homes", lambda _p="": {str(tmp_path)})
    monkeypatch.setattr(fs, "_seatbelt_off", lambda: True)
    assert fs.get_write_denied_error(str(hermes / rel))


def test_w2_a_credential_in_a_folder_of_this_app_stays_refused_with_the_seatbelt_off(monkeypatch, tmp_path):
    from agent import file_safety as fs
    hermes = tmp_path / ".ssh" / "app"
    monkeypatch.setattr(fs, "_hermes_home_path", lambda: hermes)
    monkeypatch.setattr(fs, "_hermes_root_path", lambda: hermes)
    monkeypatch.setattr(fs, "_guard_homes", lambda _p="": {str(tmp_path)})
    monkeypatch.setattr(fs, "_seatbelt_off", lambda: True)
    assert fs.get_write_denied_error(str(hermes / "x"))


@pytest.mark.parametrize("mode,asked", [("manual", True), ("ignore", True)])
def test_w2_the_seatbelt_off_manual_goes_to_main_once_with_no_route(monkeypatch, w, mode, asked):
    plugin, core, channel = _gate(monkeypatch, w, mode, {"state": "decided", "allowed": True, "grantId": None})
    monkeypatch.setattr(core, "runtime_confined", lambda: False)
    path = str(w.home / ".npmrc")
    assert plugin._decide("write_file", {"path": path, "content": "x"}, "t", "s", f"o-{mode}", {}) is None
    if mode == "manual":
        assert len(channel.asks) == 1
    assert all("oneFilePath" not in ask for ask in channel.asks)


def test_w2_ignore_s_row_writes_a_file_in_a_folder_a_grant_could_open(w):
    path = str(w.home / "Documents" / "x.txt")
    _row(w, path, kind="file", by="ignore")
    proc = write(w, path, b"in ignore\n")
    assert proc.returncode == 0, proc.stderr
    assert open(path, "rb").read() == b"in ignore\n"
    row = [r for r in w.journal() if r.get("ev") == "start"][-1]
    assert "in Ignore permissions" in row["command"] and path in row["command"]


def test_w2_a_row_that_is_not_ignore_s_never_opens_that_folder(w):
    path = str(w.home / "Documents" / "x.txt")
    _row(w, path, kind="file")
    assert write(w, path).returncode == 126 and not os.path.exists(path)


def test_w2_ignore_reads_a_file_a_grant_could_open_by_the_same_route(monkeypatch, w):
    path = _held(w, "Documents/x.txt")
    plugin, core, channel = _gate_shut(monkeypatch, w, "ignore", {"state": "decided", "allowed": True, "grantId": None, "oneFile": True})
    assert plugin._decide("read_file", {"path": path}, "t", "s", "d-r", {}) is None
    assert channel.asks[0]["oneFilePath"] == path and core.take_approved_read(path) is True


def test_w2_only_ignore_takes_the_route_for_that_folder(monkeypatch, w):
    path = str(w.home / "Documents" / "x.txt")
    answer = {"state": "decided", "allowed": True, "grantId": None, "oneFile": True}
    plugin, core, channel = _gate_shut(monkeypatch, w, "ignore", answer)
    monkeypatch.setattr(plugin, "_session_project", lambda _t: str(w.home / "project"))
    assert plugin._decide("write_file", {"path": path, "content": "x"}, "t", "s", "d-1", {}) is None
    assert channel.asks[0]["oneFilePath"] == path and core.take_approved_file(path) is True
    plugin, core, channel = _gate_shut(monkeypatch, w, "manual", answer)
    monkeypatch.setattr(plugin, "_session_project", lambda _t: str(w.home / "project"))
    assert plugin._decide("write_file", {"path": path, "content": "x"}, "t", "s", "d-2", {}) is None
    assert "oneFilePath" not in channel.asks[0]


def test_w2_ignore_leaves_a_file_inside_the_run_s_own_folder_to_the_run(monkeypatch, w):
    path = str(w.home / "project" / "x.txt")
    plugin, core, channel = _gate_shut(monkeypatch, w, "ignore", {"state": "decided", "allowed": True, "grantId": None})
    monkeypatch.setattr(plugin, "_session_project", lambda _t: str(w.home / "project"))
    assert plugin._decide("write_file", {"path": path, "content": "x"}, "t", "s", "d-3", {}) is None
    assert all("oneFilePath" not in ask for ask in channel.asks)


_G24_LISTED = [".ssh/authorized_keys", ".ssh/config", ".netrc", ".npmrc", ".aws/credentials", ".config/gh/hosts.yml", ".SSH/id_rsa"]


def _g24_verdict(monkeypatch, tmp_path, rel, mode):
    from tests.plugins.test_iclone_permissions import _body, _load
    _load()
    from hermes_plugins.iclone_permissions import classify as C
    from hermes_plugins.iclone_permissions.policy import decide
    monkeypatch.setattr("agent.file_safety._guard_homes", lambda _p="": {str(tmp_path)})
    body = _body(standing=mode, grants=[{"id": "zz-g", "cls": "Wo", "scope": "standing"}])
    call = C.classify("write_file", {"path": str(tmp_path / rel), "content": "x"}, str(tmp_path / "project"), body, session_id="s")
    return decide(body, cls=call.cls, facts=call.facts, floor=call.floor, ceiling_key=call.ceiling_key, session_id="s", project=call.project), call


@pytest.mark.parametrize("rel", _G24_LISTED)
@pytest.mark.parametrize("mode", ["manual", "automatic"])
def test_g24_a_stored_class_grant_never_opens_the_credential_list(monkeypatch, tmp_path, rel, mode):
    verdict, call = _g24_verdict(monkeypatch, tmp_path, rel, mode)
    assert call.floor and call.floor.startswith("secrets:")
    assert verdict.outcome == "ask"


def test_g24_the_same_grant_still_opens_an_ordinary_file(monkeypatch, tmp_path):
    verdict, call = _g24_verdict(monkeypatch, tmp_path, "Documents/x.txt", "manual")
    assert call.floor is None and verdict.outcome == "allow"


@pytest.mark.parametrize("rel", _G24_LISTED)
def test_g24_ignore_lifts_the_credential_floor(monkeypatch, tmp_path, rel):
    verdict, _ = _g24_verdict(monkeypatch, tmp_path, rel, "ignore")
    assert verdict.outcome == "allow"


def test_g24_a_failed_patch_on_a_route_read_returns_no_nearby_line(monkeypatch):
    from tools import file_operations as fo
    from tools.fuzzy_match import format_no_match_hint
    content = "[default]\naws_access=one\naws_secret=abc123\nregion=two\n"
    miss = "aws_secret=nothing like it\nqqqqqq wwwwww eeeeee\nrrrrrr tttttt"
    assert "abc123" in format_no_match_hint("Could not find match", 0, miss, content)  # the hint a non-route patch still gets
    env, written = _route_env(content.encode())
    ops = fo.ShellFileOperations(env, cwd="/")
    result = ops.patch_replace("/lab/.aws/credentials", miss, "x")
    assert result.success is not True and written == []
    assert "abc123" not in str(result.error)


def test_g24_a_patch_on_a_route_read_shows_only_the_lines_it_changed(monkeypatch):
    from tools import file_operations as fo
    env, _ = _route_env(b"aws_secret=abc123\nother\n")
    ops = fo.ShellFileOperations(env, cwd="/")
    monkeypatch.setattr(ops, "_check_lint_delta", lambda *_a, **_k: None)
    result = ops.patch_replace("/lab/.aws/credentials", "other", "gamma")
    assert result.success is True, result.error
    assert "abc123" not in result.diff and "gamma" in result.diff


def _g24_env_read(monkeypatch, tmp_path, waiting):
    from tools import file_tools as ft
    from tools import file_operations as fo
    monkeypatch.setattr("hermes_cli.iclone_policy_env.confined_at_exec", lambda: True)
    path = tmp_path / ".env"
    path.write_bytes(b"API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789\n")
    env = SimpleNamespace(cwd="/", approved_file_waiting=lambda _p: False, approved_read_waiting=lambda _p: waiting,
                          read_approved_file=lambda _p: path.read_bytes() if waiting else None,
                          execute=lambda *_a, **_k: {"output": "", "returncode": 1})
    ops = fo.ShellFileOperations(env, cwd="/")
    monkeypatch.setattr(ft, "_get_file_ops", lambda _t: ops)
    return ft.read_file_tool(str(path), task_id="g24")


def test_g24_a_row_main_answered_reads_the_env_file_whole(monkeypatch, tmp_path):
    out = _g24_env_read(monkeypatch, tmp_path, True)
    assert "sk-abcdefghijklmnopqrstuvwxyz0123456789" in out and "Access denied" not in out


def test_g24_with_no_row_the_env_file_stays_refused(monkeypatch, tmp_path):
    out = _g24_env_read(monkeypatch, tmp_path, False)
    assert "Access denied" in out and "sk-abcdefghijklmnopqrstuvwxyz" not in out


def test_g24_a_row_never_opens_this_app_s_own_env(monkeypatch, tmp_path):
    from agent import file_safety as fs
    hermes = tmp_path / ".hermes"
    monkeypatch.setattr(fs, "_hermes_home_path", lambda: hermes)
    monkeypatch.setattr(fs, "_hermes_root_path", lambda: hermes)
    assert fs.get_read_block_error(str(hermes / ".env"), route_answered=True)
    assert fs.get_read_block_error(str(tmp_path / "project" / ".env"), route_answered=True) is None
    assert fs.get_read_block_error(str(tmp_path / "project" / ".env"))


def test_g24_the_runtime_knows_a_read_row_waits_without_taking_it(monkeypatch):
    core = L.core
    monkeypatch.setattr(core, "runtime_confined", lambda: True)
    core.note_approved_read("/lab/.env")
    assert core.approved_read_waiting("/lab/.env") is True and core.approved_read_waiting("/lab/other") is False
    assert core.take_approved_read("/lab/.env") is True and core.approved_read_waiting("/lab/.env") is False


@pytest.mark.parametrize("rel", [".aws/sub/credentials", ".netrc", ".config/gcloud/key.json", ".ssh/id_new"])
def test_g24_a_new_held_path_is_private(w, rel):
    target = w.home / rel
    proc = writer(str(target), w.home)
    _, err = proc.communicate(b"k", timeout=30)
    assert proc.returncode == 0, err
    assert target.stat().st_mode & 0o777 == 0o600
    if rel.count("/"):
        assert (w.home / rel.split("/")[0]).stat().st_mode & 0o777 == 0o700


def test_g24_a_new_ordinary_file_keeps_the_usual_modes(w):
    target = w.home / "Library" / "fresh" / "x"
    proc = writer(str(target), w.home)
    _, err = proc.communicate(b"k", timeout=30)
    assert proc.returncode == 0, err
    assert target.stat().st_mode & 0o777 == 0o644
    assert target.parent.stat().st_mode & 0o777 != 0o700


_G25_WIDER = [
    "Library/Keychains/login.keychain-db", "Library/Application Support/Google/Chrome/Default/Cookies", "Library/Safari/History.db",
    ".zshrc", ".bash_profile", ".profile", ".gitconfig", "Library/LaunchAgents/x.plist", ".ZSHRC",
]


@pytest.mark.parametrize("rel", _G25_WIDER)
@pytest.mark.parametrize("mode", ["manual", "automatic"])
def test_g25_a_stored_grant_never_opens_the_wider_list(monkeypatch, tmp_path, rel, mode):
    verdict, call = _g24_verdict(monkeypatch, tmp_path, rel, mode)
    assert call.floor and call.floor.startswith("secrets:")
    assert verdict.outcome == "ask"


@pytest.mark.parametrize("rel", _G25_WIDER)
def test_g25_ignore_lifts_the_wider_list(monkeypatch, tmp_path, rel):
    verdict, _ = _g24_verdict(monkeypatch, tmp_path, rel, "ignore")
    assert verdict.outcome == "allow"


@pytest.mark.parametrize("rel", _G25_WIDER)
def test_g25_the_wider_list_asks_and_never_becomes_a_refusal(monkeypatch, tmp_path, rel):
    from agent import file_safety as fs
    monkeypatch.setattr(fs, "_guard_homes", lambda _p="": {str(tmp_path)})
    assert fs.is_home_credential_path(str(tmp_path / rel)) is True
    assert fs.get_write_denied_error(str(tmp_path / rel)) is None


def test_g25_the_two_floor_lists_are_equal():
    import re
    from pathlib import Path
    from agent import file_safety as fs
    source = (Path(__file__).parents[2] / "apps/desktop/electron/iclone-permissions/classify-policy.ts").read_text()

    def listed(name):
        return set(re.findall(r"'([^']+)'", re.search(rf"const {name} = \[(.*?)\]", source, re.S).group(1)))

    assert listed("HOME_CREDENTIAL_DIRS") == {*fs.HOME_CREDENTIAL_DIRS, *fs.HOME_ASK_DIRS}
    assert listed("HOME_CREDENTIAL_FILES") == {*(f[0] for f in fs._HOME_CREDENTIAL_FILES if len(f) == 1), *fs.HOME_ASK_FILES}


def test_g25_the_exact_folder_ssh_is_on_the_list(monkeypatch, tmp_path):
    verdict, call = _g24_verdict(monkeypatch, tmp_path, ".ssh", "manual")
    assert call.floor and call.floor.startswith("secrets:") and verdict.outcome == "ask"


def test_g25_a_listed_name_in_this_app_s_folder_goes_straight_to_its_refusal(monkeypatch, tmp_path):
    from agent import file_safety as fs
    profile_home = tmp_path / ".hermes" / "profiles" / "x" / "home"
    monkeypatch.setattr(fs, "_guard_homes", lambda _p="": {str(profile_home)})
    monkeypatch.setattr(fs, "_hermes_dirs", lambda: [tmp_path / ".hermes"])
    assert fs.is_home_credential_path(str(profile_home / ".ssh" / "id_rsa")) is False


def _g25_patch_document(path):
    return {"mode": "patch", "patch": f"*** Begin Patch\n*** Update File: {path}\n@@\n-a\n+b\n*** End Patch\n"}


@pytest.mark.parametrize("mode", ["manual", "acceptEdits", "automatic", "ignore"])
def test_g25_a_patch_document_on_the_list_is_refused_before_the_sheet(monkeypatch, w, mode):
    path = str(w.home / ".zshrc")
    plugin, _core, channel = _gate(monkeypatch, w, mode, {"state": "decided", "allowed": True, "grantId": None})
    monkeypatch.setattr("agent.file_safety._guard_homes", lambda _p="": {str(w.home)})
    said = plugin._decide("patch", _g25_patch_document(path), "t", "s", f"v-{mode}", {})
    assert said and "replace mode" in str(said)
    assert not channel.asks


def test_g25_with_the_seatbelt_off_a_patch_document_on_the_list_asks_once(monkeypatch, w):
    path = str(w.home / ".zshrc")
    plugin, core, channel = _gate(monkeypatch, w, "manual", {"state": "decided", "allowed": True, "grantId": None})
    monkeypatch.setattr(core, "runtime_confined", lambda: False)
    monkeypatch.setattr("agent.file_safety._guard_homes", lambda _p="": {str(w.home)})
    assert plugin._decide("patch", _g25_patch_document(path), "t", "s", "v-off", {}) is None
    assert len(channel.asks) == 1


def test_g25_the_acp_bridge_never_writes_the_list(monkeypatch, tmp_path):
    from agent import copilot_acp_client as acp
    monkeypatch.setattr("agent.file_safety._guard_homes", lambda _p="": {str(tmp_path)})
    monkeypatch.setattr("agent.file_safety._seatbelt_off", lambda: True)
    for rel in (".ssh/authorized_keys", ".zshrc"):
        with pytest.raises(PermissionError):
            acp._fs_write_text_file({"path": str(tmp_path / rel), "content": "k"}, str(tmp_path))
        assert not (tmp_path / rel).exists()
    acp._fs_write_text_file({"path": str(tmp_path / "notes.txt"), "content": "k"}, str(tmp_path))
    assert (tmp_path / "notes.txt").read_text() == "k"


def test_g25_a_route_patch_returns_no_lint_output(monkeypatch):
    from tools import file_operations as fo
    env, _ = _route_env(b"aws_secret=abc123\nother\n")
    ops = fo.ShellFileOperations(env, cwd="/")
    monkeypatch.setattr(ops, "_check_lint_delta", lambda *_a, **_k: SimpleNamespace(to_dict=lambda: {"line": "aws_secret=abc123"}))
    result = ops.patch_replace("/lab/.aws/credentials", "other", "gamma")
    assert result.success is True, result.error
    assert result.lint is None


def test_g25_a_command_into_authorized_keys_has_a_floor(monkeypatch, tmp_path):
    from tests.plugins.test_iclone_permissions import _body as real_body, _load
    _load()
    from hermes_plugins.iclone_permissions import classify as C
    monkeypatch.setenv("HOME", str(tmp_path))
    call = C.classify("terminal", {"command": "echo k >> ~/.ssh/authorized_keys"}, str(tmp_path / "project"), real_body(standing="manual"), session_id="s")
    assert call.floor and call.floor.startswith("secrets:")


# G26, measured on the real app: the runtime's profile refuses it the stat, so it names a link as if it were the file.


def test_g26_a_write_that_names_the_link_lands_on_the_target_and_the_link_stays(w):
    link, target = _dotfile(w)
    inode = os.lstat(link).st_ino
    _row(w, target, kind="file", link=link)
    assert write(w, link, b"new\n").returncode == 0
    assert open(target, "rb").read() == b"new\n"
    assert os.readlink(link) == target and os.lstat(link).st_ino == inode


def test_g26_a_read_that_names_the_link_returns_the_target(w):
    link, target = _dotfile(w)
    _row(w, target, kind="read", link=link)
    done = _read(w, link)
    assert done.returncode == 0 and done.stdout == b"old\n"


def test_g26_a_row_for_the_target_without_this_link_opens_nothing_through_it(w):
    link, target = _dotfile(w)
    _row(w, target, kind="file")
    assert write(w, link, b"new\n").returncode == 126 and open(target, "rb").read() == b"old\n"


def test_g26_a_row_for_another_link_opens_nothing_through_this_one(w):
    link, target = _dotfile(w)
    other = w.home / ".zshrc2"
    other.symlink_to(target)
    _row(w, target, kind="file", link=str(other))
    assert write(w, link, b"new\n").returncode == 126 and open(target, "rb").read() == b"old\n"


def test_g26_a_dangling_link_is_refused_in_its_own_words_and_creates_nothing(w):
    link = w.home / ".zshrc"
    link.symlink_to(w.home / "nowhere")
    _row(w, str(link), kind="file")
    done = write(w, str(link), b"new\n")
    assert done.returncode == 126 and L.core.ONE_FILE_LINK_DANGLING.encode() in done.stderr
    assert not (w.home / "nowhere").exists()


# ---- G27 M1: a floor reads a name as the disk does, on one corpus with disk-name.test.ts ----------------------------

_DISK_NAMES = json.loads((Path(__file__).parents[1] / "fixtures" / "iclone_disk_names.json").read_text(encoding="ascii"))


@pytest.mark.parametrize("fold", ["agent", "launcher core"])
def test_g27_every_folding_code_point_gets_the_corpus_answer(fold):
    from agent.disk_name import disk_fold
    judge = disk_fold if fold == "agent" else L.core.disk_fold
    wrong = {point: judge(chr(int(point, 16))) for point, want in _DISK_NAMES["folds"].items() if judge(chr(int(point, 16))) != want}
    assert wrong == {}


@pytest.mark.parametrize("form", ["NFC", "NFD"])
@pytest.mark.parametrize("rel,listed", _DISK_NAMES["credential"])
def test_g27_the_credential_list_reads_a_name_as_the_disk_does(monkeypatch, tmp_path, rel, listed, form):
    from agent import file_safety as fs
    home = str(tmp_path / "José")
    other_form = unicodedata.normalize("NFD" if form == "NFC" else "NFC", home)
    monkeypatch.setattr(fs, "_guard_homes", lambda _p="": {unicodedata.normalize(form, home)})
    monkeypatch.setattr(fs, "_hermes_dirs", lambda: [tmp_path / ".hermes"])
    assert fs.is_home_credential_path(os.path.join(other_form, rel)) is listed


@pytest.mark.parametrize("rel", [".ſsh/authorized_keys", ".zſhrc", "Library/LaunchAgentſ/x.plist", ".SSH/id_rsa"])
@pytest.mark.parametrize("mode", ["manual", "automatic"])
def test_g27_a_stored_grant_never_opens_a_disk_alias_of_the_list(monkeypatch, tmp_path, rel, mode):
    verdict, call = _g24_verdict(monkeypatch, tmp_path, rel, mode)
    assert call.floor and call.floor.startswith("secrets:") and verdict.outcome == "ask"


@pytest.mark.parametrize("rel", ["iCloneOS/consent.json", "iCloneOS/CONSENT.JSON", "icloneoſ/consent.json", "ICLONEOS/consent.json"])
def test_g27_the_policy_floor_holds_every_spelling_of_a_guarded_path(tmp_path, rel):
    from tests.plugins.test_iclone_permissions import _load
    _load()
    from hermes_plugins.iclone_permissions import classify as C
    root = tmp_path / "iCloneOS"
    assert C._guarded(str(tmp_path / rel), [str(root)]) is True
    assert C._guarded(str(tmp_path / "iCloneOS-other" / "consent.json"), [str(root)]) is False


def test_g27_a_project_root_is_still_read_by_its_own_spelling(tmp_path):
    from tests.plugins.test_iclone_permissions import _load
    _load()
    from hermes_plugins.iclone_permissions import classify as C
    assert C._within(str(tmp_path / "PROJECT" / "x"), str(tmp_path / "project")) is False


def test_g27_a_plugin_folder_in_capitals_keeps_the_policy_floor(monkeypatch, tmp_path):
    from tests.plugins.test_iclone_permissions import _body, _load
    _load()
    from hermes_plugins.iclone_permissions import classify as C
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / ".hermes"))
    body = _body(standing="manual")
    call = C.classify("write_file", {"path": str(tmp_path / ".HERMES" / "PLUGINS" / "x" / "__init__.py"), "content": "x"},
                      str(tmp_path / "project"), body, session_id="s")
    assert call.floor and call.floor.startswith("policy:")


def test_g27_the_runtime_s_own_stores_stay_refused_by_every_spelling(monkeypatch, tmp_path):
    from agent import file_safety as fs
    monkeypatch.setattr(fs, "_guard_homes", lambda _p="": {str(tmp_path)})
    monkeypatch.setattr(fs, "_hermes_dirs", lambda: [tmp_path / ".hermes"])
    monkeypatch.setattr(fs, "_seatbelt_off", lambda: True)
    assert fs.get_write_denied_error(str(tmp_path / ".HERMES" / "STATE.DB"))
    assert fs.get_write_denied_error(str(tmp_path / ".hermes" / "ſtate.db"))
    assert fs.get_write_denied_error(str(tmp_path / ".hermes" / "states.db")) is None


def test_g27_with_the_seatbelt_on_a_disk_alias_is_refused_like_the_true_name(monkeypatch, tmp_path):
    from agent import file_safety as fs
    monkeypatch.setattr(fs, "_guard_homes", lambda _p="": {str(tmp_path)})
    monkeypatch.setattr(fs, "_hermes_dirs", lambda: [tmp_path / ".hermes"])
    monkeypatch.setattr(fs, "_seatbelt_off", lambda: False)
    assert fs.get_write_denied_error(str(tmp_path / ".ſsh" / "authorized_keys"))


def test_g27_the_approval_gated_file_asks_by_every_spelling(monkeypatch, tmp_path):
    from agent import file_safety as fs
    monkeypatch.setattr(fs, "_guard_homes", lambda _p="": {str(tmp_path)})
    monkeypatch.setattr(fs, "_seatbelt_off", lambda: False)
    assert fs.is_write_approval_required(str(tmp_path / ".\u017fsh" / "config")) is True
    assert fs.is_write_approval_required(str(tmp_path / ".SSH" / "CONFIG")) is True


def test_g27_a_new_key_under_a_disk_alias_is_written_0600(tmp_path):
    made = subprocess.Popen([sys.executable, "-I", "-S", "-c", L.ONEFILE_WRITER, str(tmp_path / ".ſsh" / "key"), str(tmp_path)],
                            stdin=subprocess.PIPE)
    made.communicate(b"k", timeout=30)
    assert made.returncode == 0 and stat.S_IMODE(os.stat(tmp_path / ".ssh" / "key").st_mode) == 0o600


def test_g27_this_app_s_own_files_are_held_by_every_spelling():
    holds = L.core._holds
    assert holds("/h/Library/Application Support/iCloneOS", "/h/library/application support/ICLONEOſ/consent.json")
    assert not holds("/h/Library/Application Support/iCloneOS", "/h/library/application support/iCloneOS2/consent.json")


# ---- G27 M2: a page of a route read does not license replacing the whole file ---------------------------------------

def _g27_route(monkeypatch, tmp_path, text, name="long.txt"):
    from tools import file_operations as fo
    from tools import file_tools as ft
    core, path = L.core, tmp_path / name
    path.write_text(text)
    core.forget_seen_file(str(path))
    monkeypatch.setattr("hermes_cli.iclone_policy_env.confined_at_exec", lambda: True)
    monkeypatch.setattr(core, "_run_one_file", lambda _f, _p, _d, _s=None: subprocess.CompletedProcess([], 0, path.read_bytes(), b""))
    env = SimpleNamespace(cwd="/", approved_file_waiting=lambda _p: False, approved_read_waiting=lambda _p: True,
                          read_approved_file=core.read_one_file, note_route_view=core.note_route_view,
                          execute=lambda *_a, **_k: {"output": "", "returncode": 1})
    monkeypatch.setattr(ft, "_get_file_ops", lambda _t: fo.ShellFileOperations(env, cwd="/"))
    return ft, core, path


def _g27_seen(monkeypatch, core, path):
    with monkeypatch.context() as stat_refused:
        stat_refused.setattr(core.os, "lstat", lambda *_a, **_k: (_ for _ in ()).throw(PermissionError()))
        return core.one_file_seen(str(path))


def _g27_writer(path, home, seen):
    run = subprocess.run([sys.executable, "-I", "-S", "-c", L.ONEFILE_WRITER, str(path), str(home), seen], input=b"new\n",
                         capture_output=True, timeout=30)
    return run.returncode, run.stderr.decode()


_G27_LONG = "".join(f"line {n}\n" for n in range(1000))


def test_g27_one_page_refuses_write_file_and_says_read_all_of_it_or_patch(monkeypatch, tmp_path):
    ft, core, path = _g27_route(monkeypatch, tmp_path, _G27_LONG)
    assert "line 2" in ft.read_file_tool(str(path), 1, 3, task_id="g27-page")
    seen = _g27_seen(monkeypatch, core, path)
    assert seen == "partial"
    code, said = _g27_writer(path, tmp_path, seen)
    assert code != 0 and path.read_text() == _G27_LONG
    assert "only part of it" in said and "Read all of it" in said and "patch" in said


def test_g27_every_page_in_order_licenses_the_write(monkeypatch, tmp_path):
    ft, core, path = _g27_route(monkeypatch, tmp_path, _G27_LONG)
    ft.read_file_tool(str(path), 1, 500, task_id="g27-pages")
    assert _g27_seen(monkeypatch, core, path) == "partial"
    ft.read_file_tool(str(path), 501, 500, task_id="g27-pages")
    seen = _g27_seen(monkeypatch, core, path)
    assert seen == hashlib.sha256(_G27_LONG.encode()).hexdigest()
    assert _g27_writer(path, tmp_path, seen)[0] == 0 and path.read_text() == "new\n"


def test_g27_a_gap_between_pages_licenses_nothing(monkeypatch, tmp_path):
    ft, core, path = _g27_route(monkeypatch, tmp_path, _G27_LONG)
    ft.read_file_tool(str(path), 1, 100, task_id="g27-gap")
    ft.read_file_tool(str(path), 901, 100, task_id="g27-gap")
    assert _g27_seen(monkeypatch, core, path) == "partial"


def test_g27_a_page_of_other_bytes_starts_over(monkeypatch, tmp_path):
    ft, core, path = _g27_route(monkeypatch, tmp_path, _G27_LONG)
    ft.read_file_tool(str(path), 1, 500, task_id="g27-moved")
    path.write_text(_G27_LONG.replace("line 3\n", "changed\n"))
    ft.read_file_tool(str(path), 501, 500, task_id="g27-moved")
    assert _g27_seen(monkeypatch, core, path) == "partial"


def test_g27_a_short_file_read_whole_licenses_the_write(monkeypatch, tmp_path):
    ft, core, path = _g27_route(monkeypatch, tmp_path, "one\ntwo\n")
    ft.read_file_tool(str(path), task_id="g27-short")
    assert _g27_seen(monkeypatch, core, path) == hashlib.sha256(b"one\ntwo\n").hexdigest()


def test_g27_the_tool_s_char_budget_is_a_partial_view(monkeypatch, tmp_path):
    ft, core, path = _g27_route(monkeypatch, tmp_path, _G27_LONG)
    monkeypatch.setattr(ft, "_get_max_read_chars", lambda: 200)
    ft.read_file_tool(str(path), 1, 2000, task_id="g27-budget")
    assert _g27_seen(monkeypatch, core, path) == "partial"


def test_g27_a_clamped_long_line_is_not_a_full_view(monkeypatch, tmp_path):
    ft, core, path = _g27_route(monkeypatch, tmp_path, "x" * 200000 + "\n")
    ft.read_file_tool(str(path), task_id="g27-clamp")
    assert _g27_seen(monkeypatch, core, path) == "none"


def test_g27_patch_after_a_page_still_works_and_gives_no_license(monkeypatch, tmp_path):
    ft, core, path = _g27_route(monkeypatch, tmp_path, _G27_LONG)
    ft.read_file_tool(str(path), 1, 3, task_id="g27-patch")
    sent = []
    monkeypatch.setattr(core, "_run_one_file", lambda _f, _p, data, seen=None: sent.append((data, seen)) or subprocess.CompletedProcess([], 0, b"", b""))
    with monkeypatch.context() as stat_refused:
        stat_refused.setattr(core.os, "lstat", lambda *_a, **_k: (_ for _ in ()).throw(PermissionError()))
        assert core.send_approved_file(str(path), b"patched", _G27_LONG.encode()) == 7
        assert sent == [(b"patched", hashlib.sha256(_G27_LONG.encode()).hexdigest())]
        assert core.one_file_seen(str(path)) == "none"


def test_g27_a_patch_of_a_file_seen_whole_keeps_its_license(monkeypatch, tmp_path):
    ft, core, path = _g27_route(monkeypatch, tmp_path, "one\ntwo\n")
    ft.read_file_tool(str(path), task_id="g27-kept")
    monkeypatch.setattr(core, "_run_one_file", lambda *_a: subprocess.CompletedProcess([], 0, b"", b""))
    with monkeypatch.context() as stat_refused:
        stat_refused.setattr(core.os, "lstat", lambda *_a, **_k: (_ for _ in ()).throw(PermissionError()))
        core.send_approved_file(str(path), b"one\nTWO\n", b"one\ntwo\n")
        assert core.one_file_seen(str(path)) == hashlib.sha256(b"one\nTWO\n").hexdigest()


def test_g27_patch_replace_names_the_bytes_it_read():
    from tools import file_operations as fo
    named = []
    env = SimpleNamespace(cwd="/", approved_file_waiting=lambda _p: True, read_approved_file=lambda _p: b"alpha\n",
                          write_approved_file=lambda _p, c, patch_of=None: named.append((c, patch_of)) or len(c))
    assert fo.ShellFileOperations(env, cwd="/").patch_replace("/lab/.ssh/config", "alpha", "gamma").success is True
    assert named == [("gamma\n", "alpha\n")]


def test_g27_the_launcher_hands_the_word_partial_to_the_writer(w):
    path = _held(w, ".ssh/config", b"kept\n")
    grant_file(w, path)
    env = {"PATH": os.environ["PATH"], "ICLONE_RUN_CWD": os.path.dirname(path), L.ONEFILE_ENV: path, "HOME": str(w.home),
           L.ONEFILE_SEEN_ENV: "partial"}
    proc = subprocess.run([sys.executable, "-I", "-S", STUB, w.socket, "--", L.SANDBOX_EXEC, L.ONEFILE_FLAG], env=env, input=b"new\n",
                          capture_output=True, timeout=30)
    assert proc.returncode != 0 and b"only part of it" in proc.stderr and open(path, "rb").read() == b"kept\n"


def test_g27_a_route_row_names_the_chat_that_asked(monkeypatch):
    core = L.core
    seen = {}
    monkeypatch.setenv("HERMES_SESSION_ID", "chat-1")
    monkeypatch.setattr(core, "via_launcher", lambda argv: ["a", "b", "c", "d", *argv])
    monkeypatch.setattr(core.subprocess, "run", lambda _a, **k: seen.update(k["env"]) or subprocess.CompletedProcess([], 0, b"", b""))
    core._run_one_file(core.ONEFILE_FLAG, "/h/x", b"")
    assert seen["HERMES_SESSION_ID"] == "chat-1"


def test_g27_a_patch_document_on_any_route_file_is_refused_before_the_sheet(monkeypatch, w):
    path = str(w.home / ".vimrc")
    plugin, _core, channel = _gate(monkeypatch, w, "manual", {"state": "decided", "allowed": True, "grantId": None})
    monkeypatch.setattr("agent.file_safety._guard_homes", lambda _p="": {str(w.home)})
    said = plugin._decide("patch", _g25_patch_document(path), "t", "s", "v-g27", {})
    assert said and "replace mode" in str(said) and not channel.asks


def test_g27_a_patch_document_with_no_route_file_goes_on_as_ever(monkeypatch, w):
    path = str(w.proj / "x.py")
    plugin, _core, _channel = _gate(monkeypatch, w, "manual", {"state": "decided", "allowed": True, "grantId": None})
    monkeypatch.setattr("agent.file_safety._guard_homes", lambda _p="": {str(w.home)})
    assert "replace mode" not in str(plugin._decide("patch", _g25_patch_document(path), "t", "s", "v-g27b", {}))
