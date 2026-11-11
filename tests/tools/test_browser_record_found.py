"""G20: the browser record button leaves a video the user can find, says so, and stops at once.

The file goes to Movies/icloneOS Recordings, the folder Screen recording uses, on both Seatbelt paths. The code fixes the
folder and the name's shape: with the Seatbelt on the runtime sends a bare name and the door joins it to its own folder; off,
the tool asks the same function. Nothing deletes from that folder.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

import pytest

from tools import browser_tool as b

ROOT = Path(__file__).resolve().parents[2]
NAME = "browser-20261106-120000-abc123.webm"
FOLDER = ("Movies", "icloneOS Recordings")


def _load(file: str):
    name = f"g20_{file}"
    spec = importlib.util.spec_from_file_location(name, ROOT / "plugins" / "iclone-confinement" / f"{file}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


door = _load("browser_door")
screen = _load("screen_door")


@pytest.fixture(autouse=True)
def _clean():
    b._recording_sessions.clear()
    b._recording_files.clear()
    b._record_notices.clear()
    yield
    b._recording_sessions.clear()
    b._recording_files.clear()
    b._record_notices.clear()


def _config(monkeypatch, on=True):
    monkeypatch.setattr("hermes_cli.config.read_raw_config", lambda: {"browser": {"record_sessions": on}})


def _commands(monkeypatch, result=None):
    calls = []

    def run(key, verb, args, **_k):
        calls.append((key, verb, list(args)))
        return result or {"success": True}

    monkeypatch.setattr(b._session, "_run_browser_command", run)
    return calls


def test_the_browser_video_folder_is_the_folder_screen_recording_uses():
    assert door.RECORD_FOLDER == screen.FOLDER == FOLDER


def test_the_door_joins_a_bare_name_to_its_own_folder(tmp_path):
    path = door.record_path(str(tmp_path), NAME)
    assert path == str(tmp_path / "Movies" / "icloneOS Recordings" / NAME)
    assert (tmp_path / "Movies" / "icloneOS Recordings").is_dir()


@pytest.mark.parametrize("bad", [
    "/tmp/x.webm", "../x.webm", "a/b.webm", "x.webm", "browser-20261106-120000-abc123.mov",
    "browser-20261106-120000-ABC123.webm", NAME + "\n", ".." + NAME, "", NAME + ".webm",
])
def test_the_caller_chooses_no_folder_and_no_other_name(tmp_path, bad):
    with pytest.raises(door.DoorRefused):
        door.record_path(str(tmp_path), bad)


def test_the_door_will_not_go_through_a_link_or_over_a_file(tmp_path):
    (tmp_path / "Movies").mkdir()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (tmp_path / "Movies" / "icloneOS Recordings").symlink_to(elsewhere)
    with pytest.raises(door.DoorRefused):
        door.record_path(str(tmp_path), NAME)
    (tmp_path / "Movies" / "icloneOS Recordings").unlink()
    (tmp_path / "Movies" / "icloneOS Recordings").mkdir()
    (tmp_path / "Movies" / "icloneOS Recordings" / NAME).write_bytes(b"kept")
    with pytest.raises(door.DoorRefused):
        door.record_path(str(tmp_path), NAME)
    assert (tmp_path / "Movies" / "icloneOS Recordings" / NAME).read_bytes() == b"kept"


def test_a_full_path_is_not_a_record_request_the_door_takes(tmp_path):
    assert door._verb_ok("record", ["start", NAME], str(tmp_path)) is True
    assert door._verb_ok("record", ["start", str(tmp_path / NAME)], str(tmp_path)) is False
    assert door._verb_ok("record", ["stop"], str(tmp_path)) is True


def test_seatbelt_on_the_tool_sends_a_bare_name_and_tells_the_agent_the_file(monkeypatch):
    _config(monkeypatch)
    monkeypatch.setattr(b, "_confined_runtime", lambda: True)
    calls = _commands(monkeypatch)
    note = b._maybe_start_recording("t")
    verb = calls[0]
    name = verb[2][1]
    assert verb[1] == "record" and verb[2][0] == "start" and door.RECORD_NAME.match(name)
    assert note == (f"This browser session is being recorded. The video goes to Movies/icloneOS Recordings/{name} in the "
                    "user's home folder, and it is saved when the browser closes or the user turns recording off.")
    assert b.recording_status()["capturing"] == [name]


def test_seatbelt_off_the_tool_writes_in_the_same_folder(monkeypatch, tmp_path):
    _config(monkeypatch)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(b, "_confined_runtime", lambda: False)
    monkeypatch.setattr(b.shutil, "which", lambda *a, **k: "/opt/homebrew/bin/ffmpeg")
    calls = _commands(monkeypatch)
    b._maybe_start_recording("t")
    path = calls[0][2][1]
    assert os.path.dirname(path) == str(tmp_path / "Movies" / "icloneOS Recordings")
    assert door.RECORD_NAME.match(os.path.basename(path))


def test_nothing_deletes_from_the_folder():
    assert not hasattr(b._lifecycle, "_cleanup_old_recordings")
    assert "browser_recordings" not in (ROOT / "tools" / "browser_tool.py").read_text(encoding="utf-8")
    assert "browser_recordings" not in (ROOT / "tools" / "browser_tool_lifecycle.py").read_text(encoding="utf-8")


def test_a_saved_video_gives_the_user_a_notice_with_its_name(monkeypatch):
    calls = _commands(monkeypatch)
    b._recording_sessions.add("t")
    b._recording_files["t"] = NAME
    b._maybe_stop_recording("t")
    assert calls == [("t", "record", ["stop"])]
    assert [(n["ok"], n["message"]) for n in b.recording_status()["notices"]] == [
        (True, f"Browser video saved: {NAME}, in Movies/icloneOS Recordings.")]
    assert b.recording_status()["capturing"] == []


def test_a_failed_save_says_so_to_the_user(monkeypatch):
    _commands(monkeypatch, {"success": False, "error": "ffmpeg: Output file does not contain any stream (234)"})
    b._recording_sessions.add("t")
    b._recording_files["t"] = NAME
    b._maybe_stop_recording("t")
    assert [(n["ok"], n["message"]) for n in b.recording_status()["notices"]] == [
        (False, "The browser video was not saved: the page gave no frames, so there is no video.")]


def test_a_recording_that_cannot_start_says_so_to_the_user(monkeypatch):
    _config(monkeypatch)
    monkeypatch.setattr(b, "_confined_runtime", lambda: True)
    _commands(monkeypatch, {"success": False, "error": "Target closed"})
    assert b._maybe_start_recording("t") is None
    assert [(n["ok"], n["message"]) for n in b.recording_status()["notices"]] == [
        (False, "The browser recording did not start: Target closed.")]


def test_notices_count_up_and_keep_the_last_twenty():
    for i in range(25):
        b._say_recording(True, f"n{i}")
    notices = b.recording_status()["notices"]
    assert len(notices) == 20 and notices[-1]["message"] == "n24"
    assert [n["seq"] for n in notices] == sorted(n["seq"] for n in notices)


def test_the_button_off_stops_and_saves_at_once_without_closing_the_browser(monkeypatch):
    _config(monkeypatch, on=False)
    calls = _commands(monkeypatch)
    b._recording_sessions.add("t")
    b._recording_files["t"] = NAME
    view = b.sync_recordings()
    assert calls == [("t", "record", ["stop"])] and view["capturing"] == []
    assert view["notices"][-1]["message"] == f"Browser video saved: {NAME}, in Movies/icloneOS Recordings."


def test_the_stop_does_not_depend_on_the_headed_window_or_the_reaper(monkeypatch):
    # Headed skips the turn's cleanup, so before this the file waited for the idle reaper.
    _config(monkeypatch, on=False)
    monkeypatch.setenv("AGENT_BROWSER_HEADED", "1")
    monkeypatch.setattr("tools.browser_tool_cloud._is_headed_mode", lambda: True)
    calls = _commands(monkeypatch)
    b._recording_sessions.add("t")
    b._recording_files["t"] = NAME
    b.sync_recordings()
    assert calls == [("t", "record", ["stop"])]


def test_the_button_on_starts_on_an_open_session_with_a_page(monkeypatch):
    _config(monkeypatch)
    monkeypatch.setattr(b, "_confined_runtime", lambda: True)
    calls = _commands(monkeypatch)
    monkeypatch.setitem(b._active_sessions, "open", {"_first_nav": False})
    monkeypatch.setitem(b._active_sessions, "blank", {"_first_nav": True})
    monkeypatch.setitem(b._active_sessions, "opening", {"_first_nav": False, "_record_after_open": True})
    view = b.sync_recordings()
    assert [c[0] for c in calls] == ["open"] and len(view["capturing"]) == 1


def test_two_stops_of_one_recording_run_the_stop_once(monkeypatch):
    calls = _commands(monkeypatch)
    b._recording_sessions.add("t")
    b._recording_files["t"] = NAME
    b._maybe_stop_recording("t")
    b._maybe_stop_recording("t")
    assert len(calls) == 1 and len(b.recording_status()["notices"]) == 1


def test_a_recording_dropped_by_the_janitor_says_so(monkeypatch):
    b._recording_sessions.add("t")
    b._recording_files["t"] = NAME
    b._lifecycle._force_reap_browser_session("t")
    assert [(n["ok"], n["message"]) for n in b.recording_status()["notices"]] == [
        (False, f"The browser video {NAME} is not confirmed: the browser could not be closed cleanly. Check Movies/icloneOS Recordings. The file may be incomplete or absent.")]
    assert "t" not in b._recording_sessions


def test_the_gateway_answers_without_loading_the_browser_tool_when_nothing_ran():
    text = (ROOT / "tui_gateway" / "methods_tools.py").read_text(encoding="utf-8")
    assert '{"record_status", "record_sync", "record_stop"}' in text
    assert 'sys.modules.get("tools.browser_tool")' in text
