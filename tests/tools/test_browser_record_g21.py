"""G21: a browser video the save could not finish. Nothing the user might want is deleted, a slow stop is not a failure and never
recycles the session, the notices survive a restart, a stop and a start cannot cross, and a swapped link never takes the video."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from tools import browser_tool as b
from tools import browser_tool_session as s

ROOT = Path(__file__).resolve().parents[2]
NAME = "browser-20261106-120000-abc123.webm"
OTHER = "browser-20261106-120000-def456.webm"
SESSION = "h_abc"
SHOWN = "Movies/icloneOS Recordings"


def _load_door():
    name = "g21_browser_door"
    spec = importlib.util.spec_from_file_location(name, ROOT / "plugins" / "iclone-confinement" / "browser_door.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


door = _load_door()


@pytest.fixture(autouse=True)
def _clean(tmp_path, monkeypatch):
    def wipe():
        b._recording_sessions.clear()
        b._recording_files.clear()
        b._record_starting.clear()
        b._record_notices.clear()
    wipe()
    b._record_exit_done = False
    b._record_pending_read = False
    monkeypatch.setattr(b, "_record_pending_path", lambda: tmp_path / "browser_record_notices.json")
    yield
    wipe()
    b._record_exit_done = False


def _config(monkeypatch, on=True):
    monkeypatch.setattr("hermes_cli.config.read_raw_config", lambda: {"browser": {"record_sessions": on}})


def _capturing(key="t", name=NAME):
    b._recording_sessions.add(key)
    b._recording_files[key] = name


def _run_answers(monkeypatch, answers):
    calls = []

    def run(key, verb, args=None, timeout=None, **_k):
        calls.append((key, verb, list(args or []), timeout))
        return answers.get((args or [""])[0], {"success": True})

    monkeypatch.setattr(b._session, "_run_browser_command", run)
    monkeypatch.setattr(b, "_confined_runtime", lambda: True)
    return calls


def _messages():
    return [n["message"] for n in b.recording_status()["notices"]]


# -- W2: the stop's bound and its failure

def test_the_stop_outlasts_the_measured_25_seconds():
    assert b._RECORD_STOP_TIMEOUT_S > 25


def test_a_stop_that_runs_out_of_time_says_not_confirmed_and_leaves_the_file_alone(monkeypatch):
    calls = _run_answers(monkeypatch, {"stop": {"success": False, "error": "Command timed out after 40 seconds", "timed_out": True}})
    _capturing()
    b._maybe_stop_recording("t")
    assert [c[2][0] for c in calls] == ["stop"]  # the daemon may still be writing: nothing goes to the door to remove
    assert _messages() == [f"The browser video {NAME} is not confirmed: the browser did not answer in time. Check {SHOWN}. The file may be incomplete or absent."]


def test_a_closed_tab_says_not_confirmed_in_plain_words(monkeypatch):
    _run_answers(monkeypatch, {"stop": {"success": False, "error": "CDP error: Target closed"}})
    _capturing()
    b._maybe_stop_recording("t")
    assert _messages() == [f"The browser video {NAME} is not confirmed: the tab was closed before the video finished. Check {SHOWN}. The file may be incomplete or absent."]


def test_a_failed_save_asks_the_door_to_remove_the_empty_file_and_only_that(monkeypatch):
    calls = _run_answers(monkeypatch, {"stop": {"success": False, "error": "ffmpeg failed: 1"}})
    _capturing()
    b._maybe_stop_recording("t")
    assert [c[2] for c in calls] == [["stop"], ["discard", NAME]]
    assert _messages() == [f"The browser video {NAME} is not confirmed: ffmpeg failed: 1. Check {SHOWN}. The file may be incomplete or absent."]


def test_no_frames_is_still_not_saved_and_removes_the_empty_file(monkeypatch):
    calls = _run_answers(monkeypatch, {"stop": {"success": False, "error": "Output file does not contain any stream"}})
    _capturing()
    b._maybe_stop_recording("t")
    assert [c[2] for c in calls] == [["stop"], ["discard", NAME]]
    assert _messages() == ["The browser video was not saved: the page gave no frames, so there is no video."]


def test_seatbelt_off_the_tool_removes_through_the_same_function(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    _run_answers(monkeypatch, {"stop": {"success": False, "error": "ffmpeg failed: 1"}})
    monkeypatch.setattr(b, "_confined_runtime", lambda: False)
    path = Path(door.record_path(str(tmp_path), NAME))
    path.write_bytes(b"")
    _capturing()
    b._maybe_stop_recording("t")
    assert not path.exists()


def test_a_failed_removal_cannot_change_what_the_user_reads(monkeypatch):
    def run(_key, _verb, args=None, **_k):
        if args[0] == "discard":
            raise OSError("no")
        return {"success": False, "error": "ffmpeg failed: 1"}

    monkeypatch.setattr(b._session, "_run_browser_command", run)
    monkeypatch.setattr(b, "_confined_runtime", lambda: True)
    _capturing()
    b._maybe_stop_recording("t")
    assert len(_messages()) == 1 and "not confirmed" in _messages()[0]
    assert "t" not in b._recording_sessions


def test_a_saved_video_gives_the_path_the_writer_answered(monkeypatch):
    _run_answers(monkeypatch, {"stop": {"success": True, "data": {"path": f"/Users/x/Movies/icloneOS Recordings/{NAME}"}}})
    _capturing()
    b._maybe_stop_recording("t")
    notice = b.recording_status()["notices"][-1]
    assert notice["ok"] is True and notice["file"] == NAME
    assert notice["path"] == f"/Users/x/Movies/icloneOS Recordings/{NAME}"


# -- W2 and minor 1: the door

def _folder(home):
    return Path(door.record_path(str(home), NAME)).parent


def test_the_door_removes_only_an_empty_regular_file_of_the_one_name(tmp_path):
    folder = _folder(tmp_path)
    (folder / NAME).write_bytes(b"")
    assert door.discard_empty_record(str(tmp_path), NAME) is True
    assert not (folder / NAME).exists()


def test_the_door_keeps_a_partial_file(tmp_path):
    folder = _folder(tmp_path)
    (folder / NAME).write_bytes(b"\x1a\x45")
    assert door.discard_empty_record(str(tmp_path), NAME) is False
    assert (folder / NAME).read_bytes() == b"\x1a\x45"


def test_the_door_removes_no_link_and_no_other_name(tmp_path):
    folder = _folder(tmp_path)
    empty = tmp_path / "empty"
    empty.write_bytes(b"")
    (folder / NAME).symlink_to(empty)
    assert door.discard_empty_record(str(tmp_path), NAME) is False
    assert (folder / NAME).is_symlink() and empty.exists()
    (folder / "mine.webm").write_bytes(b"")
    assert door.discard_empty_record(str(tmp_path), "mine.webm") is False
    assert door.discard_empty_record(str(tmp_path), "../" + NAME) is False
    assert (folder / "mine.webm").exists()


def test_the_door_removes_no_hard_link_and_nothing_through_a_linked_folder(tmp_path):
    folder = _folder(tmp_path)
    (folder / OTHER).write_bytes(b"")
    os.link(folder / OTHER, folder / NAME)
    assert door.discard_empty_record(str(tmp_path), NAME) is False
    assert (folder / NAME).exists()
    (folder / NAME).unlink()
    away = tmp_path / "away"
    folder.rename(away)
    folder.symlink_to(away)
    (away / NAME).write_bytes(b"")
    assert door.discard_empty_record(str(tmp_path), NAME) is False
    assert (away / NAME).exists()


def _door_for(home):
    return door.Door(str(home / "hermes"), str(home), sit=False)


def _request(home, *rest):
    folder = home / "sock" / f"ab-{SESSION}"
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(folder, 0o700)
    return {"argv": [door.COMMAND, "--session", SESSION, "--json", *rest], "env": {"AGENT_BROWSER_SOCKET_DIR": str(folder)}}


@pytest.fixture
def fake_program(monkeypatch):
    monkeypatch.setattr(door, "pinned_program", lambda _store, _lock: ("/fake/agent-browser", "/fake/chrome"))
    monkeypatch.setattr(door, "chrome_shim", lambda _store: "/fake/shim")
    monkeypatch.setattr(door, "give_ffmpeg", lambda *_a, **_k: None)
    monkeypatch.setattr(door, "_socket_folder", lambda value, _session: value)  # pytest's long tmp path is over the socket limit
    monkeypatch.setattr(door, "_peer_pid", lambda _path: 1)


def test_the_door_verb_takes_a_bare_name_and_nothing_else(tmp_path):
    assert door._verb_ok("record", ["discard", NAME], str(tmp_path)) is True
    for bad in (str(tmp_path / NAME), "../" + NAME, "mine.webm", NAME + "\n"):
        assert door._verb_ok("record", ["discard", bad], str(tmp_path)) is False
    assert door._verb_ok("record", ["discard"], str(tmp_path)) is False
    assert door._verb_ok("record", ["discard", NAME, "x"], str(tmp_path)) is False


def test_the_door_removes_only_the_video_it_was_told_to_stop(tmp_path, fake_program):
    the_door = _door_for(tmp_path)
    (tmp_path / "hermes").mkdir()
    with pytest.raises(door.DoorRefused):
        the_door.plan(_request(tmp_path, "record", "discard", NAME))  # never started here
    the_door.plan(_request(tmp_path, "record", "start", NAME))
    target = _folder_only(tmp_path) / NAME
    target.write_bytes(b"")
    with pytest.raises(door.DoorRefused):
        the_door.plan(_request(tmp_path, "record", "discard", NAME))  # still capturing: not the runtime's to end this way
    assert target.exists()
    the_door.plan(_request(tmp_path, "record", "stop"))
    plan = the_door.plan(_request(tmp_path, "record", "discard", NAME))
    assert not target.exists()
    assert plan["argv"] == ["/usr/bin/true"] and plan["executable"] == "/usr/bin/true"  # nothing of the browser runs for it


def _folder_only(home):
    return home / "Movies" / "icloneOS Recordings"


@pytest.mark.parametrize("verb", [("record", "stop"), ("close",)])
def test_a_link_swapped_in_never_takes_the_video(tmp_path, fake_program, verb):
    the_door = _door_for(tmp_path)
    (tmp_path / "hermes").mkdir()
    the_door.plan(_request(tmp_path, "record", "start", NAME))
    keep = tmp_path / "keep.txt"
    keep.write_text("mine")
    (_folder_only(tmp_path) / NAME).symlink_to(keep)
    the_door.plan(_request(tmp_path, *verb))
    placed = _folder_only(tmp_path) / NAME
    assert not placed.is_symlink() and placed.is_file() and placed.stat().st_size == 0
    assert keep.read_text() == "mine"


def test_a_hard_link_swapped_in_never_takes_the_video(tmp_path, fake_program):
    the_door = _door_for(tmp_path)
    (tmp_path / "hermes").mkdir()
    the_door.plan(_request(tmp_path, "record", "start", NAME))
    keep = tmp_path / "keep.txt"
    keep.write_text("mine")
    os.link(keep, _folder_only(tmp_path) / NAME)
    the_door.plan(_request(tmp_path, "record", "stop"))
    assert (_folder_only(tmp_path) / NAME).stat().st_ino != keep.stat().st_ino
    assert keep.read_text() == "mine"


def test_a_linked_folder_swapped_in_never_takes_the_video(tmp_path, fake_program):
    the_door = _door_for(tmp_path)
    (tmp_path / "hermes").mkdir()
    the_door.plan(_request(tmp_path, "record", "start", NAME))
    away = tmp_path / "away"
    away.mkdir()
    folder = _folder_only(tmp_path)
    folder.rmdir()
    folder.symlink_to(away)
    (away / NAME).symlink_to(tmp_path / "keep.txt")
    the_door.plan(_request(tmp_path, "record", "stop"))
    assert folder.is_dir() and not folder.is_symlink()
    assert (away / NAME).is_symlink()  # theirs: left where it is


def test_a_plain_capture_file_is_not_touched_at_the_stop(tmp_path, fake_program):
    the_door = _door_for(tmp_path)
    (tmp_path / "hermes").mkdir()
    the_door.plan(_request(tmp_path, "record", "start", NAME))
    placed = _folder_only(tmp_path) / NAME
    placed.write_bytes(b"\x1a\x45")
    inode = placed.stat().st_ino
    the_door.plan(_request(tmp_path, "record", "stop"))
    assert placed.stat().st_ino == inode and placed.read_bytes() == b"\x1a\x45"


# -- P6 and W3: the session survives the stop, on the real command path

class _Proc:
    def __init__(self, hang):
        self.hang, self.returncode, self.killed = hang, 0, False

    def wait(self, timeout=None):
        if self.hang and not self.killed:
            raise subprocess.TimeoutExpired("agent-browser", timeout)
        return 0

    def kill(self):
        self.killed = True


def _real_path(monkeypatch, *, headed=False, hang=False, stdout='{"success":true,"data":{"path":"/m/v.webm"}}'):
    argvs, recycled = [], []
    info = {"session_name": SESSION, "features": {"local": True}}

    def popen(argv, _env, socket_dir, tag, _stdin=None):
        argvs.append(list(argv))
        for slot, text in (("stdout", stdout), ("stderr", "")):
            Path(socket_dir, f"_{slot}_{tag}").write_text(text, encoding="utf-8")
        return _Proc(hang)

    monkeypatch.setattr(s, "_browser_command_preflight", lambda *_a: {"browser_cmd": "/fake/agent-browser"})
    monkeypatch.setattr(s, "_get_session_info", lambda _k: info)
    monkeypatch.setattr(s, "_popen_agent_browser", popen)
    monkeypatch.setattr(s, "_ensure_screen_for_headed_chromium", lambda: None)
    monkeypatch.setattr(s, "_handle_browser_command_timeout", lambda *a: recycled.append("timeout"))
    monkeypatch.setattr(s, "_recycle_local_session", lambda *a: recycled.append("backend"))
    monkeypatch.setattr(s._cloud, "_is_headed_mode", lambda: headed)
    monkeypatch.setattr(s._cloud, "_get_browser_engine", lambda: "auto")
    return argvs, recycled


def test_a_record_stop_that_times_out_never_recycles_the_session(monkeypatch):
    _, recycled = _real_path(monkeypatch, hang=True)
    result = s._run_browser_command("t", "record", ["stop"], timeout=1)
    assert recycled == [] and result["success"] is False and result["timed_out"] is True


def test_another_command_that_times_out_still_recycles(monkeypatch):
    _, recycled = _real_path(monkeypatch, hang=True)
    s._run_browser_command("t", "snapshot", [], timeout=1)
    assert recycled == ["timeout"]


def test_a_record_stop_with_a_broken_answer_never_recycles_or_retries(monkeypatch):
    argvs, recycled = _real_path(monkeypatch, stdout="")
    monkeypatch.setattr(s, "_is_recoverable_local_backend_failure", lambda *_a: True)
    s._run_browser_command("t", "record", ["stop"], timeout=1)
    assert recycled == [] and len(argvs) == 1


def test_the_headed_branch_really_sends_the_stop_and_keeps_the_session(monkeypatch):
    # W3: this drives the argv builder and the output reader; only agent-browser itself is not here. No close goes with it.
    argvs, recycled = _real_path(monkeypatch, headed=True)
    _config(monkeypatch, on=False)
    _capturing()
    view = b.sync_recordings()
    assert len(argvs) == 1 and argvs[0][-2:] == ["record", "stop"] and "--headed" in argvs[0]
    assert recycled == [] and view["capturing"] == []
    assert view["notices"][-1]["path"] == "/m/v.webm"


# -- product minor 5, wall minor 5: a start and a stop cannot cross

def test_off_waits_for_a_start_in_flight_and_stops_it(monkeypatch):
    in_start, release, calls = threading.Event(), threading.Event(), []

    def run(key, _verb, args=None, **_k):
        calls.append(args[0])
        if args[0] == "start":
            in_start.set()
            release.wait(5)
        return {"success": True}

    monkeypatch.setattr(b._session, "_run_browser_command", run)
    monkeypatch.setattr(b, "_confined_runtime", lambda: True)
    state = {"on": True}
    monkeypatch.setattr("hermes_cli.config.read_raw_config", lambda: {"browser": {"record_sessions": state["on"]}})
    starter = threading.Thread(target=b._maybe_start_recording, args=("t",))
    starter.start()
    assert in_start.wait(5)
    state["on"] = False
    stopper = threading.Thread(target=b.sync_recordings)
    stopper.start()
    stopper.join(0.2)
    assert stopper.is_alive()  # it waits for the start, it does not miss it
    release.set()
    starter.join(5)
    stopper.join(5)
    assert calls == ["start", "stop"] and b.recording_status()["capturing"] == []


def test_two_starts_for_one_session_run_one(monkeypatch):
    calls, gate = [], threading.Event()

    def run(_key, _verb, args=None, **_k):
        calls.append(args[0])
        gate.wait(0.2)
        return {"success": True}

    monkeypatch.setattr(b._session, "_run_browser_command", run)
    monkeypatch.setattr(b, "_confined_runtime", lambda: True)
    _config(monkeypatch)
    threads = [threading.Thread(target=b._maybe_start_recording, args=("t",)) for _ in range(2)]
    [t.start() for t in threads]
    [t.join(5) for t in threads]
    assert calls == ["start"]


def test_a_string_false_in_the_config_is_off_as_the_app_reads_it(monkeypatch):
    calls = _run_answers(monkeypatch, {})
    monkeypatch.setattr("hermes_cli.config.read_raw_config", lambda: {"browser": {"record_sessions": "false"}})
    assert b._maybe_start_recording("t") is None and calls == []
    assert b.recording_status()["armed"] is False


# -- P3, P4, P5: what the button reads

def test_the_answer_carries_a_boot_id_that_holds_for_this_process(monkeypatch):
    _config(monkeypatch)
    first, second = b.recording_status(), b.recording_status()
    assert first["boot"] and first["boot"] == second["boot"]
    assert first["armed"] is True


def test_record_stop_ends_every_capture_with_the_setting_on(monkeypatch):
    calls = _run_answers(monkeypatch, {})
    _config(monkeypatch, on=True)
    _capturing("a", NAME)
    _capturing("b", OTHER)
    view = b.stop_recordings()
    assert sorted(c[0] for c in calls) == ["a", "b"] and view["capturing"] == []


def test_a_quit_stops_saves_and_the_next_start_reads_it(monkeypatch):
    _run_answers(monkeypatch, {})
    _capturing()
    b.stop_recordings_for_exit(wait_s=5)
    assert json.loads(b._record_pending_path().read_text())[0]["message"] == f"Browser video saved: {NAME}, in {SHOWN}."
    b._record_notices.clear()
    b._record_pending_read = False
    _config(monkeypatch)
    assert _messages() == [f"Browser video saved: {NAME}, in {SHOWN}."]
    assert not b._record_pending_path().exists()


def test_a_quit_that_runs_out_of_time_says_so_at_the_next_start(monkeypatch):
    never = threading.Event()
    monkeypatch.setattr(b._session, "_run_browser_command", lambda *_a, **_k: never.wait(5) or {"success": True})
    _capturing()
    b.stop_recordings_for_exit(wait_s=0.1)
    said = json.loads(b._record_pending_path().read_text())
    never.set()
    assert said[-1]["ok"] is False
    assert said[-1]["message"] == f"The app closed before {NAME} finished saving. It is not confirmed: check {SHOWN}. The file may be incomplete."


def test_the_exit_runs_once_and_is_silent_without_a_capture(monkeypatch):
    calls = _run_answers(monkeypatch, {})
    b.stop_recordings_for_exit(wait_s=1)
    assert calls == [] and not b._record_pending_path().exists()
    _capturing()
    b.stop_recordings_for_exit(wait_s=1)  # the signal handler and atexit can both reach it: the first one held
    assert calls == [] and "t" in b._recording_sessions


def test_a_damaged_notice_file_is_dropped_without_a_word(monkeypatch):
    _config(monkeypatch)
    b._record_pending_path().write_text("{not json")
    assert _messages() == [] and not b._record_pending_path().exists()


def test_the_shutdown_grace_covers_a_capture_only_when_one_runs():
    from tui_gateway import entry
    assert entry._shutdown_grace_for_recordings(1.0) == 1.0
    _capturing()
    assert entry._shutdown_grace_for_recordings(1.0) == b._RECORD_EXIT_WAIT_S + 1.0


def _preflight_reaches_the_daemon(monkeypatch):
    seen = []
    monkeypatch.setattr("tools.bot_desktop.runtime.tool_placement", lambda **_k: "host")
    monkeypatch.setattr(s._install, "_find_agent_browser", lambda: "/stand-in/agent-browser")
    monkeypatch.setattr(s._install, "_chromium_installed", lambda: True)
    monkeypatch.setattr(s, "_get_session_info", lambda _t: {"session_name": "x"})

    def fenced(_info, _run):
        seen.append(True)
        return "chrome", {"success": True}

    monkeypatch.setattr(s, "run_fenced_pair", fenced)
    return seen


def test_a_stop_goes_out_from_an_interrupted_turn(monkeypatch):
    """Live, g21-run1: the quit interrupted the turn, its cleanup asked for the stop, and the stop came back "Interrupted" with no daemon asked: the capture ran on for two minutes."""
    from tools.interrupt import set_interrupt
    seen = _preflight_reaches_the_daemon(monkeypatch)
    set_interrupt(True)
    try:
        assert s._run_browser_command("t", "open", ["https://example.com/"]) == {"success": False, "error": "Interrupted"}
        assert seen == []
        assert s._run_browser_command("t", "record", ["stop"], timeout=5) == {"success": True}
        assert s._run_browser_command("t", "record", ["discard", NAME], timeout=5) == {"success": True}
        assert len(seen) == 2
    finally:
        set_interrupt(False)


def test_a_notice_nobody_read_before_the_exit_waits_for_the_next_start(monkeypatch):
    """Live, g21-run1: the turn's own cleanup ended the capture, the exit then found nothing live and kept nothing."""
    _run_answers(monkeypatch, {"stop": {"success": True, "data": {"path": f"/h/{SHOWN}/{NAME}"}}})
    _capturing()
    b._maybe_stop_recording("t")
    b.stop_recordings_for_exit(wait_s=1)
    assert [n["message"] for n in json.loads(b._record_pending_path().read_text())] == [f"Browser video saved: {NAME}, in {SHOWN}."]


def test_a_notice_the_window_has_read_is_not_said_twice(monkeypatch):
    _config(monkeypatch)
    _run_answers(monkeypatch, {"stop": {"success": True}})
    _capturing()
    b._maybe_stop_recording("t")
    assert [n["seq"] for n in b.recording_status()["notices"]]
    b.stop_recordings_for_exit(wait_s=1)
    assert not b._record_pending_path().exists()


def test_the_desktop_backend_saves_at_the_stop_and_waits_for_it(monkeypatch):
    """The desktop's backend is `serve`: uvicorn re-raises SIGTERM after the lifespan ends, so neither entry.py's handler nor atexit ever runs there. The lifespan is the only place."""
    from fastapi.testclient import TestClient
    from hermes_cli import web_server
    import tui_gateway.server as gateway

    done = threading.Event()
    calls = []

    def save():
        calls.append("started")
        thread = threading.Thread(target=lambda: (done.wait(0.3), calls.append("saved")))
        thread.start()
        return thread

    monkeypatch.setattr(gateway, "_start_saving_browser_videos", save)
    with TestClient(web_server.app):
        assert calls == []
    assert calls == ["started", "saved"]


def test_the_signal_starts_the_save_and_the_bound_beats_the_kill(monkeypatch):
    """M1: Electron sends SIGTERM, waits 5 s (backend.ts waitForBackendExit), then SIGKILLs the group; uvicorn alone can spend 3 s of that before the lifespan ends."""
    import signal as _signal
    from hermes_cli import web_server
    import tui_gateway.server as gateway

    calls = []
    monkeypatch.setattr(gateway, "_start_saving_browser_videos", lambda: calls.append("started"))
    monkeypatch.setattr(web_server.app.state, "auth_required", False, raising=False)
    _config_, server = web_server._build_uvicorn_server("127.0.0.1", 0)
    server.handle_exit(_signal.SIGTERM, None)
    assert calls == ["started"] and server.should_exit is True
    assert b._RECORD_EXIT_WAIT_S < 5


def test_the_exit_save_is_one_thread_however_many_ask(monkeypatch):
    import tui_gateway.server as gateway

    monkeypatch.setitem(sys.modules, "tools.browser_tool", b)
    monkeypatch.setattr(gateway, "_browser_video_saver", None, raising=False)
    release = threading.Event()
    monkeypatch.setattr(b, "stop_recordings_for_exit", lambda: release.wait(2))
    first = gateway._start_saving_browser_videos()
    assert gateway._start_saving_browser_videos() is first
    release.set()
    first.join(2)


def test_a_stop_killed_by_a_signal_leaves_the_empty_file_alone(monkeypatch):
    """M2: the group SIGTERM kills the stop's client (returncode -15); the daemon may still hold the file open."""
    calls = _run_answers(monkeypatch, {"stop": {"success": False, "error": "Command failed with code -15", "returncode": -15}})
    _capturing()
    b._maybe_stop_recording("t")
    assert [c for c in calls if c[2][:1] == ["discard"]] == []
    assert "not confirmed" in b._record_notices[-1]["message"]


def test_a_turn_end_does_not_wait_for_a_slow_stop_and_the_next_call_waits_for_it(monkeypatch):
    """M3: a stop can take 25 s and more (live: 27.6 s after a closed tab); the transcript's save sits behind the turn's cleanup."""
    from tools import browser_tool_lifecycle as lc

    order = []
    release = threading.Event()

    def stop(_key):
        release.wait(3)
        order.append("stopped")
        with b._cleanup_lock:
            b._recording_sessions.discard(_key)

    monkeypatch.setattr(b, "_maybe_stop_recording", stop)
    monkeypatch.setattr(lc._session, "_run_browser_command", lambda _k, verb, *_a, **_kw: order.append(verb) or {"success": True})
    monkeypatch.setattr(lc, "_session_has_expired", lambda _info: False)
    monkeypatch.setattr(lc, "_release_session_resources", lambda _k, _i: order.append("released"))
    info = {"session_name": "x", "features": {}}
    monkeypatch.setitem(b._active_sessions, "t", info)
    _capturing()
    lc.cleanup_browser("t")
    assert order == []  # the turn went on, the stop is out
    lc.cleanup_browser("t")  # a second cleanup does not start a second stop
    waited = threading.Event()

    def next_call():
        lc.wait_for_cleanup("t")
        waited.set()

    threading.Thread(target=next_call, daemon=True).start()
    assert not waited.wait(0.2)
    release.set()
    assert waited.wait(3)
    assert order == ["stopped", "close", "released"]
