"""proofaudit row 11: a background command through the real launcher and the real Seatbelt. Every command runs in its own
sandbox instance and the profile allows a signal only inside one, so a later ``kill`` from another instance is refused
by the kernel; the runtime must not read that refusal as "it ended", and the kill must really end the command."""
import os
import subprocess
import sys
import time

import pytest

import tests.plugins.test_iclone_confinement as _Mini
from tests.plugins.test_iclone_one_shot import TestRealSeatbeltThroughTheRealLauncher as _Live
from tools.process_registry import ProcessRegistry

# The launcher really signals what it started, which has left this test's process tree through the wrapper's own exit.
pytestmark = [pytest.mark.skipif(sys.platform != "darwin", reason="macOS sandbox-exec only"),
              pytest.mark.live_system_guard_bypass]

def _alive(word: str) -> list:
    """The host's own view, from outside every sandbox: which processes carry this marker on their command line."""
    out = subprocess.run(["/bin/ps", "-axo", "pid=,command="], capture_output=True, text=True, check=True).stdout
    return [line.split()[0] for line in out.splitlines() if word in line and "/bin/ps" not in line]


def _until(check, seconds: float = 15.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.05)
    return check()


_RUN_MARK = f"39{os.getpid() % 1000:03d}"


def _marker() -> str:
    return f"{_RUN_MARK}{time.monotonic_ns() % 1000:03d}"


class TestBackgroundThroughTheRealLauncher:
    live = _Live.live

    @pytest.fixture(autouse=True)
    def real_member_rule(self, monkeypatch):
        """MINI_PROFILE with the one line every real profile has (sbpl.ts): the launcher knows a run's processes by it."""
        monkeypatch.setattr("tests.plugins.test_iclone_confinement.MINI_PROFILE",
                            _Mini.MINI_PROFILE + '\n(allow file-read* (literal (param "MEMBER")))\n')

    @pytest.fixture(autouse=True)
    def nothing_left_behind(self):
        yield
        # Only what this test's own markers name: a failing row must not leave a sleep on the machine.
        for pid in _alive(f"sleep {_RUN_MARK}"):
            os.kill(int(pid), 9)

    @pytest.fixture
    def registry(self, live, monkeypatch, tmp_path):
        monkeypatch.setattr("tools.process_registry.CHECKPOINT_PATH", tmp_path / "processes.json")
        env, core, _ledger, _root, project, _other = live
        # MINI_PROFILE keeps the real signal rule but not the real scratch ancestors: the wrapper's mkdir -p lands here.
        monkeypatch.setattr(core, "grant_params", lambda *_: {"NET": "0", "WRITE_PROJECT": "1"})
        (project / "bg").mkdir()  # as core.scratch_dir makes the real one: the wrapper's pid write does not wait for its mkdir
        monkeypatch.setattr(env, "get_temp_dir", lambda: str(project / "bg"))
        return live, ProcessRegistry()


    def test_the_kernel_refuses_a_signal_from_another_sandbox_instance(self, registry):
        """The cause, as the kernel says it: the command is there, and the next instance may not signal it."""
        (env, _core, _ledger, _root, project, _other), reg = registry
        seconds = _marker()
        session = reg.spawn_via_env(env, f"sleep {seconds}", cwd=str(project))
        try:
            assert _until(lambda: _alive(f"sleep {seconds}"))
            out = env.execute(f"LC_ALL=C kill -0 {session.pid}; echo rc=$?")["output"]
            assert "Operation not permitted" in out and "rc=1" in out, out
            gone = env.execute("LC_ALL=C kill -0 999999; echo rc=$?")["output"]
            assert "No such process" in gone, gone
        finally:
            reg.kill_process(session.id)


    def test_a_living_command_reads_running_and_the_kill_really_ends_it(self, registry):
        (env, _core, _ledger, _root, project, _other), reg = registry
        seconds = _marker()
        session = reg.spawn_via_env(env, f"sleep {seconds}", cwd=str(project))
        assert _until(lambda: _alive(f"sleep {seconds}"))
        time.sleep(5)  # past two turns of the poller, which runs every 2 s
        polled = reg.poll(session.id)
        assert polled["status"] == "running", polled
        answer = reg.kill_process(session.id)
        assert answer["status"] == "killed", answer
        assert _alive(f"sleep {seconds}") == []


    def test_a_command_that_starts_children_dies_with_them(self, registry):
        (env, _core, _ledger, _root, project, _other), reg = registry
        seconds = _marker()
        session = reg.spawn_via_env(env, f"sleep {seconds} & sleep {seconds} & wait", cwd=str(project))
        assert _until(lambda: len(_alive(f"sleep {seconds}")) >= 2)
        assert reg.kill_process(session.id)["status"] == "killed"
        assert _alive(f"sleep {seconds}") == []


    def test_a_command_that_ends_alone_reports_its_real_code_and_output(self, registry):
        (env, _core, _ledger, _root, project, _other), reg = registry
        session = reg.spawn_via_env(env, "sleep 3; echo MARK11; exit 7", cwd=str(project))
        assert _until(lambda: reg.poll(session.id)["status"] == "exited", 20)
        polled = reg.poll(session.id)
        assert polled["exit_code"] == 7 and "MARK11" in polled["output_preview"], polled


    def test_a_kill_after_the_end_says_already_exited_with_the_real_code(self, registry):
        (env, _core, _ledger, _root, project, _other), reg = registry
        session = reg.spawn_via_env(env, "exit 4", cwd=str(project))
        assert _until(lambda: reg.poll(session.id)["status"] == "exited", 20)
        answer = reg.kill_process(session.id)
        assert answer["status"] == "already_exited" and answer["exit_code"] == 4, answer

    def test_the_launcher_names_only_its_own_runs_members(self, registry):
        """Outside a run's membership this door answers "not alive" and sends nothing, the caller's own parent included."""
        (env, _core, _ledger, _root, project, _other), reg = registry
        stranger = subprocess.Popen(["/bin/sleep", "60"])
        try:
            assert env.stop_background(stranger.pid) == []
            assert env.background_alive(stranger.pid) is False
            assert env.stop_background(os.getppid()) == []
            assert stranger.poll() is None
        finally:
            stranger.kill()
            stranger.wait()

    def test_a_command_that_ignores_the_term_gets_the_kill(self, registry):
        (env, _core, _ledger, _root, project, _other), reg = registry
        seconds = _marker()
        session = reg.spawn_via_env(env, f"trap '' TERM; sleep {seconds}", cwd=str(project))
        assert _until(lambda: _alive(f"sleep {seconds}"))
        time.sleep(0.5)
        assert reg.kill_process(session.id)["status"] == "killed"
        assert _alive(f"sleep {seconds}") == []

    def test_without_a_launcher_the_runtime_itself_ends_it(self, registry, monkeypatch):
        (env, _core, _ledger, _root, project, _other), reg = registry
        monkeypatch.delenv("ICLONE_RUNTIME_CONFINED")
        seconds = _marker()
        session = reg.spawn_via_env(env, f"sleep {seconds}", cwd=str(project))
        assert _until(lambda: _alive(f"sleep {seconds}"))
        time.sleep(3)
        assert reg.poll(session.id)["status"] == "running"
        assert reg.kill_process(session.id)["status"] == "killed"
        assert _alive(f"sleep {seconds}") == []

    def test_without_a_launcher_a_command_that_ends_reports_its_real_code(self, registry, monkeypatch):
        (env, _core, _ledger, _root, project, _other), reg = registry
        monkeypatch.delenv("ICLONE_RUNTIME_CONFINED")
        session = reg.spawn_via_env(env, "exit 5", cwd=str(project))
        assert _until(lambda: reg.poll(session.id)["status"] == "exited", 20)
        assert reg.poll(session.id)["exit_code"] == 5
