"""G9, ruling R3: the agent records the screen. A fake screencapture stands in everywhere here (no pixels of a real
screen in a test); the real binary is only in the live proof row. Real launcher socket, real stub, real supervisor."""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import signal
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "plugins" / "iclone-confinement"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


door = _load("iclone_screen_door", PLUGIN / "screen_door.py")
launcher_mod = _load("iclone_launcher_for_screen", PLUGIN / "launcher.py")


def _atom(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I4s", len(payload) + 8, kind) + payload


def _movie(frames: int = 90, duration: int = 3000, timescale: int = 1000) -> bytes:
    """The atoms a real .mov carries that the check reads, moov last as screencapture writes it."""
    mvhd = _atom(b"mvhd", b"\0\0\0\0" + b"\0" * 8 + struct.pack(">II", timescale, duration) + b"\0" * 80)
    hdlr = _atom(b"hdlr", b"\0" * 8 + b"vide" + b"\0" * 12)
    stsz = _atom(b"stsz", b"\0" * 4 + struct.pack(">II", 0, frames) + b"\0\0\0\1" * frames)
    trak = _atom(b"trak", _atom(b"mdia", hdlr + _atom(b"minf", _atom(b"stbl", stsz))))
    return _atom(b"ftyp", b"qt  \0\0\0\0qt  ") + _atom(b"mdat", b"\xaa" * 5000) + _atom(b"moov", mvhd + trak)


def _fake(where: Path, movie: bytes | None, *, die_at_once=False) -> Path:
    """screencapture's real behaviour as measured: SIGINT finishes the file and exits 0; TERM loses it."""
    where.mkdir(parents=True, exist_ok=True)
    (where / "movie").write_bytes(movie or b"")
    marks = where / "argv.txt"
    write = f'/bin/cp "{where}/movie" "$out"' if movie is not None else ":"
    body = "exit 3\n" if die_at_once else f"""
trap '{write}; exit 0' INT
while :; do /bin/sleep 0.05; done
"""
    program = where / "fake-screencapture"
    program.write_text(f'#!/bin/bash\nfor a in "$@"; do echo "$a" >> "{marks}"; done\nfor a in "$@"; do out=$a; done\necho $$ > "{where}/pid"\n{body}')
    program.chmod(0o755)
    return program


def _recorder(tmp_path, program, preflight="skip", **kw):
    return door.Recorder(str(tmp_path / "home"), program=str(program), preflight=preflight, **kw)


def _gone(pid: int, wait: float = 5.0) -> bool:
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.05)
    return False


# --- the exact shapes

@pytest.mark.parametrize("args,verb,seconds", [(["start", "1"], "start", 1), (["start", "60"], "start", 60),
                                               (["start", "600"], "start", 600), (["stop"], "stop", None),
                                               (["status"], "status", None)])
def test_only_the_exact_verbs_pass(args, verb, seconds):
    assert door.shape(args) == (verb, seconds)


@pytest.mark.parametrize("args", [
    [], ["start"], ["start", "0"], ["start", "601"], ["start", "060"], ["start", "-5"], ["start", "6e1"], ["start", " 60"],
    ["start", "60", "--path", "/tmp/x.mov"], ["start", "/tmp/x.mov"], ["start", "60;id"], ["stop", "x"], ["status", "x"],
    ["record", "60"], ["--help"], ["/usr/sbin/screencapture", "-v", "/tmp/x.mov"], ["-v"], [60], ["start", 60], ["stop", None],
])
def test_every_neighbour_is_refused(args):
    with pytest.raises(door.DoorRefused):
        door.shape(args)


def test_the_binary_is_fixed_and_the_request_names_no_path():
    assert door.SCREENCAPTURE == "/usr/sbin/screencapture"
    assert door.DEFAULT_SECONDS == 60 and door.MAX_SECONDS == 600


def test_the_length_flag_is_never_used_because_it_loses_the_file_on_stop(tmp_path):
    fake = _fake(tmp_path / "f", _movie())
    rec = _recorder(tmp_path, fake)
    assert rec.start(30)["ok"] is True
    assert rec.stop()["ok"] is True
    argv = (tmp_path / "f" / "argv.txt").read_text().splitlines()
    assert argv[:2] == ["-v", "-x"] and len(argv) == 3 and "-V" not in argv
    assert argv[2].startswith(str(tmp_path / "home" / "Movies" / "icloneOS Recordings") + "/screen-") and argv[2].endswith(".mov")


# --- start, stop, the file

def test_start_stop_gives_a_checked_file_in_the_folder_it_names(tmp_path):
    rec = _recorder(tmp_path, _fake(tmp_path / "f", _movie(frames=90, duration=3000)))
    started = rec.start(30)
    assert started["ok"] is True and started["recording"] is True and started["seconds"] == 30
    assert started["folder"] == str(tmp_path / "home" / "Movies" / "icloneOS Recordings")
    assert rec.status()["recording"] is True
    done = rec.stop()
    assert done["ok"] is True and done["recording"] is False
    assert Path(done["path"]).is_file() and Path(done["path"]).parent == Path(started["folder"])
    assert done["frames"] == 90 and done["duration_seconds"] == 3.0 and done["bytes"] > 0
    assert oct(Path(started["folder"]).stat().st_mode & 0o777) == "0o700"


def test_one_recording_at_a_time_and_a_second_recorder_is_refused_too(tmp_path):
    fake = _fake(tmp_path / "f", _movie())
    rec = _recorder(tmp_path, fake)
    assert rec.start(30)["ok"] is True
    second = rec.start(30)
    assert second["ok"] is False and "already" in second["reason"]
    other = _recorder(tmp_path, fake).start(30)  # another runtime with the Seatbelt off: the folder's lock says no
    assert other["ok"] is False and "already" in other["reason"]
    assert rec.stop()["ok"] is True
    assert rec.start(30)["ok"] is True
    assert rec.stop()["ok"] is True


def test_the_cap_ends_it_with_nobody_asking_and_stop_collects_the_file(tmp_path):
    fake = _fake(tmp_path / "f", _movie())
    rec = _recorder(tmp_path, fake)
    assert rec.start(1)["ok"] is True
    pid = int((tmp_path / "f" / "pid").read_text())
    assert _gone(pid, 6.0), "the recorder outlived its cap"
    deadline = time.monotonic() + 5
    while rec.status()["recording"] and time.monotonic() < deadline:  # the supervisor ends just after its recorder
        time.sleep(0.05)
    status = rec.status()
    assert status["recording"] is False and status["ok"] is True and Path(status["path"]).is_file()
    assert rec.stop()["ok"] is True


def test_stop_with_nothing_running_is_a_plain_sentence(tmp_path):
    out = _recorder(tmp_path, _fake(tmp_path / "f", _movie())).stop()
    assert out == {"ok": False, "recording": False, "reason": door.NOT_RUNNING}


def test_the_launcher_stopping_ends_it_and_keeps_the_file(tmp_path):
    fake = _fake(tmp_path / "f", _movie())
    rec = _recorder(tmp_path, fake)
    path = rec.start(30)["path"]
    pid = int((tmp_path / "f" / "pid").read_text())
    rec.stop_all()
    assert _gone(pid) and Path(path).is_file()


def test_an_owner_killed_outright_leaves_nothing_running(tmp_path):
    """The owner holds the only write end of the supervisor's pipe: SIGKILL to the owner still ends the recorder."""
    fake = _fake(tmp_path / "f", _movie())
    code = ("import importlib.util,sys,time\n"
            f"s=importlib.util.spec_from_file_location('sd',{str(PLUGIN / 'screen_door.py')!r});m=importlib.util.module_from_spec(s);sys.modules['sd']=m;s.loader.exec_module(m)\n"
            f"r=m.Recorder({str(tmp_path / 'home')!r},program={str(fake)!r},preflight='skip')\n"
            "print(r.start(30)['path'],flush=True);time.sleep(60)\n")
    owner = subprocess.Popen([sys.executable, "-I", "-S", "-c", code], stdout=subprocess.PIPE, text=True)
    path = owner.stdout.readline().strip()
    pid = int((tmp_path / "f" / "pid").read_text())
    owner.kill()
    owner.wait()
    owner.stdout.close()
    assert _gone(pid), "a left-running recorder is a defect"
    assert Path(path).is_file()


# --- the grant, and files that are not recordings

def test_a_missing_grant_is_a_plain_reason_and_starts_nothing(tmp_path):
    fake = _fake(tmp_path / "f", _movie())
    out = _recorder(tmp_path, fake, preflight="deny").start(30)
    assert out["ok"] is False and out["reason"] == door.PERMISSION
    assert "System Settings > Privacy & Security" in out["reason"] and "icloneOS" in out["reason"]
    assert not (tmp_path / "f" / "argv.txt").exists(), "the grant was missing and the recorder ran anyway"
    assert not list((tmp_path / "home" / "Movies" / "icloneOS Recordings").glob("*.mov"))


def test_a_recorder_that_dies_at_once_is_a_plain_reason(tmp_path):
    out = _recorder(tmp_path, _fake(tmp_path / "f", None, die_at_once=True)).start(30)
    assert out["ok"] is False and "System Settings" in out["reason"] and "exit" not in out["reason"].lower()


@pytest.mark.parametrize("name,movie", [("no file", None), ("empty", b""), ("no frames", _movie(frames=0)),
                                        ("no length", _movie(duration=0)), ("noise", b"\x01" * 400)])
def test_what_is_not_a_recording_is_never_called_one_and_is_not_kept(tmp_path, name, movie):
    rec = _recorder(tmp_path, _fake(tmp_path / "f", movie))
    path = rec.start(30)["path"]
    out = rec.stop()
    assert out["ok"] is False and out["recording"] is False, name
    assert "System Settings" in out["reason"] and "Traceback" not in out["reason"]
    assert not Path(path).exists()


def test_a_folder_that_is_a_link_is_refused(tmp_path):
    aim = tmp_path / "elsewhere"
    aim.mkdir()
    (tmp_path / "home" / "Movies").mkdir(parents=True)
    (tmp_path / "home" / "Movies" / "icloneOS Recordings").symlink_to(aim)
    fake = _fake(tmp_path / "f", _movie())
    out = _recorder(tmp_path, fake).start(30)
    assert out["ok"] is False and not (tmp_path / "f" / "argv.txt").exists() and not list(aim.iterdir())


def test_the_movie_reader_is_exact():
    assert door.read_movie_bytes(_movie(frames=7, duration=2500)) == (2.5, 7)
    assert door.read_movie_bytes(b"\x01" * 40) is None


@pytest.mark.skipif(not shutil.which("ffmpeg") or not door.find_ffprobe(), reason="ffmpeg and ffprobe make and read the real fixtures")
def test_a_black_recording_is_refused_and_a_picture_is_not(tmp_path):
    made = {}
    for name, source in (("black", "color=black:s=320x240:r=30"), ("picture", "testsrc=s=320x240:r=30")):
        target = tmp_path / f"{name}.mov"
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", source, "-t", "2", "-pix_fmt", "yuv420p", "-c:v", "libx264", str(target)],
                       check=True, stdin=subprocess.DEVNULL, timeout=60)
        made[name] = target.read_bytes()
    black = _recorder(tmp_path, _fake(tmp_path / "b", made["black"]))
    path = black.start(30)["path"]
    out = black.stop()
    assert out["ok"] is False and "black" in out["reason"] and not Path(path).exists()
    pic = _recorder(tmp_path, _fake(tmp_path / "p", made["picture"]))
    pic.start(30)
    out = pic.stop()
    assert out["ok"] is True and out["black_check"] == "passed" and out["frames"] == 60 and Path(out["path"]).is_file()


def test_without_ffprobe_the_result_says_black_was_not_checked(tmp_path, monkeypatch):
    monkeypatch.setattr(door, "find_ffprobe", lambda: "")
    rec = _recorder(tmp_path, _fake(tmp_path / "f", _movie()))
    rec.start(30)
    out = rec.stop()
    assert out["ok"] is True and out["black_check"] == door.BLACK_NOT_CHECKED


def test_only_the_system_folders_can_name_ffprobe():
    assert set(door.FFPROBE_PATHS) == {"/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"}


# --- through the real launcher and the real stub, as with the Seatbelt on

@pytest.fixture
def live(tmp_path):
    run = Path(f"/tmp/g9d{os.getpid()}")
    run.mkdir(mode=0o700, exist_ok=True)
    sock = run / "l.sock"
    journal = tmp_path / "journal"
    fake = _fake(tmp_path / "f", _movie())
    launcher = launcher_mod.Launcher(SimpleNamespace(scratch_root=str(tmp_path / "scratch"), members_dir=str(tmp_path / "members")), str(sock), str(journal))
    launcher.screen_door = launcher_mod.screen_door.Door(str(tmp_path / "home"), program=str(fake), preflight="skip")
    launcher.bind()
    threading.Thread(target=launcher.serve_forever, daemon=True).start()
    yield sock, launcher, journal, tmp_path / "f"
    launcher.stop()
    shutil.rmtree(run, ignore_errors=True)


def _stub(sock, *args, env=None):
    return subprocess.run([sys.executable, "-I", "-S", str(PLUGIN / "stub.py"), str(sock), "--", door.COMMAND, *args],
                          capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL,
                          env={"ICLONE_RUN_CWD": "/", **(env or {})})


def test_the_door_starts_and_stops_outside_and_answers_in_json(live):
    sock, _launcher, journal, marks = live
    started = _stub(sock, "start", "20", env={"HOME": "/evil", "PATH": "/evil"})
    assert started.returncode == 0, started.stderr
    begun = json.loads(started.stdout)
    assert begun["ok"] is True and "/evil" not in begun["path"]
    assert json.loads(_stub(sock, "status").stdout)["recording"] is True
    done = json.loads(_stub(sock, "stop").stdout)
    assert done["ok"] is True and done["path"] == begun["path"] and Path(done["path"]).is_file()
    deadline = time.monotonic() + 3
    rows = ""
    while time.monotonic() < deadline and "screen recording, outside the Seatbelt" not in rows:
        rows = "".join(p.read_text() for p in journal.glob("*.jsonl"))
    assert "screen recording, outside the Seatbelt" in rows
    assert _gone(int((marks / "pid").read_text()))


@pytest.mark.parametrize("args", [["start"], ["start", "601"], ["start", "60", "/tmp/x.mov"], ["stop", "now"], ["record"],
                                  ["/bin/sh", "-c", "id"], ["-v", "/tmp/x.mov"]])
def test_the_door_refuses_its_neighbours_and_runs_nothing(live, args):
    sock, _launcher, _journal, marks = live
    proc = _stub(sock, *args)
    assert proc.returncode == 126 and proc.stdout == ""
    assert not (marks / "argv.txt").exists()


def test_the_launcher_stopping_ends_a_recording_it_started(live):
    sock, launcher, _journal, marks = live
    path = json.loads(_stub(sock, "start", "20").stdout)["path"]
    pid = int((marks / "pid").read_text())
    launcher.screen_door.stop_all()
    assert _gone(pid) and Path(path).is_file()


# --- the spawn guard

def _decide(argv):
    from tools.environments import host_lane
    frame = SimpleNamespace(f_code=SimpleNamespace(co_filename=str(ROOT / "tools" / "screen_record_tool.py"), co_name="_through_the_door"),
                            f_back=None, f_lineno=1, f_globals={})
    return host_lane.decide_spawn("subprocess.Popen", (argv[0], argv, None, {}), frame, fixed=frozenset(), hermes=frozenset(),
                                  foreign=(), seals=set(), confined=True)


def test_the_guard_lets_only_the_exact_screen_form_through():
    from tools.environments.host_lane import STUB_FILE
    stub, python = os.path.realpath(str(STUB_FILE)), os.path.realpath(sys.executable)
    head = [python, "-I", "-S", stub, "/tmp/l", "--", door.COMMAND]
    for good in (head + ["start", "60"], head + ["stop"], head + ["status"]):
        assert _decide(good)[0] is True, good
    for bad in (head, head + ["start"], head + ["start", "60", "x"], head + ["stop", "x"], head + ["record"],
                [python, "-I", "-S", "/tmp/evil.py", "/tmp/l", "--", door.COMMAND, "stop"],
                [python, "-c", "x", stub, "/tmp/l", "--", door.COMMAND, "stop"],
                [python, "-I", "-S", stub, "/tmp/l", "--", "/usr/sbin/screencapture", "-v", "/tmp/x.mov"],
                ["/usr/sbin/screencapture", "-v", "/tmp/x.mov"]):
        assert _decide(bad)[0] is False, bad


# --- the tool, the ask, the table

@pytest.fixture
def tool():
    import tools.screen_record_tool as module
    module._reset_for_tests()
    yield module
    module._reset_for_tests()


def test_the_schema_offers_three_actions_and_no_path(tool):
    props = tool.SCREEN_RECORD_SCHEMA["parameters"]["properties"]
    assert set(props) == {"action", "seconds"} and props["action"]["enum"] == ["start", "stop", "status"]
    assert props["seconds"]["maximum"] == 600
    assert "whole screen" in tool.SCREEN_RECORD_SCHEMA["description"]


@pytest.mark.parametrize("given,kept", [(None, 60), (5, 5), (600, 600), (900, 600), (0, 60), (-3, 60), ("30", 30), ("abc", 60), (True, 60), (2.5, 2)])
def test_the_length_is_always_inside_the_cap(tool, given, kept):
    assert tool.seconds_of({"seconds": given}) == kept


def test_seatbelt_off_runs_here_and_a_raw_error_never_reaches_the_model(tool, tmp_path, monkeypatch):
    monkeypatch.setattr(tool, "_door_socket", lambda: "")
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    tool._recorder_factory = lambda home: door.Recorder(home, program=str(_fake(tmp_path / "f", _movie())), preflight="skip")
    begun = json.loads(tool.handle({"action": "start", "seconds": 20}))
    assert begun["ok"] is True and begun["path"].startswith(str(tmp_path / "home" / "Movies"))
    done = json.loads(tool.handle({"action": "stop"}))
    assert done["ok"] is True and Path(done["path"]).is_file()
    assert json.loads(tool.handle({"action": "dance"}))["ok"] is False


def test_the_tool_is_offered_with_the_seatbelt_on_where_the_runtime_cannot_exec_the_binary(tool, monkeypatch):
    """Live red, g9on: "Tool 'screen_record' does not exist", because access(X_OK) is refused inside the Seatbelt."""
    monkeypatch.setattr(tool.os, "access", lambda *_: False)
    monkeypatch.setattr(tool.sys, "platform", "darwin")
    monkeypatch.setattr(tool, "_door_socket", lambda: "/tmp/l.sock")
    assert tool.check_requirements() is True
    monkeypatch.setattr(tool, "_door_socket", lambda: "")
    assert tool.check_requirements() is False


def test_seatbelt_on_goes_through_the_stub_and_a_dead_launcher_is_a_sentence(tool, monkeypatch):
    monkeypatch.setattr(tool, "_door_socket", lambda: "/tmp/g9-no-such-launcher.sock")
    out = json.loads(tool.handle({"action": "status"}))
    assert out["ok"] is False and "Traceback" not in out["reason"] and "launcher" in out["reason"]


@pytest.fixture
def classify():
    plugin = ROOT / "plugins" / "iclone-permissions"
    name = "iclone_permissions_g9"
    package = ModuleType(name)
    package.__path__ = [str(plugin)]
    sys.modules[name] = package
    for sub in ("normalize", "policy", "classify"):
        spec = importlib.util.spec_from_file_location(f"{name}.{sub}", plugin / f"{sub}.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[f"{name}.{sub}"] = module
        spec.loader.exec_module(module)
    return sys.modules[f"{name}.classify"]


def test_start_asks_once_naming_the_whole_screen_and_where_the_file_goes(classify):
    got = classify._classify_one("screen_record", {"action": "start", "seconds": 900}, None, {})
    assert got.cls == "S" and got.ceiling_key == "screen"
    assert "whole screen" in got.target and "600 seconds" in got.target and "Movies/icloneOS Recordings" in got.target


@pytest.mark.parametrize("action", ["stop", "status"])
def test_stopping_and_looking_never_ask(classify, action):
    got = classify._classify_one("screen_record", {"action": action}, None, {})
    assert got.cls == "R" and got.floor is None


def test_an_unknown_action_is_not_a_read(classify):
    assert classify._classify_one("screen_record", {"action": "dance"}, None, {}).cls == "S"
    assert classify._classify_one("screen_record", {}, None, {}).cls == "S"


def test_the_manual_and_ignore_cells(classify):
    from_policy = sys.modules["iclone_permissions_g9.policy"]
    assert from_policy.MANUAL_TABLE_ROW["S"] == "Q" and from_policy.MANUAL_TABLE_ROW["R"] == "A"


@pytest.fixture
def perms():
    from tests.plugins.test_iclone_permissions import _load
    return _load()


def test_ignore_lifts_the_switch_as_it_lifts_the_others(perms):
    body = {"ceilings": {"screen": "off"}}
    assert perms._screen_switch_off("screen_record", {"action": "start"}, body, "ignore") is False


@pytest.mark.parametrize("mode", ["manual", "automatic", "plan"])
def test_the_switch_off_refuses_a_start_outside_ignore_and_names_itself(perms, mode):
    from tests.plugins.test_iclone_permissions import _body
    body = _body(standing=mode, ceilings={"screen": "off"})
    assert perms._screen_switch_off("screen_record", {"action": "start"}, body, mode) is True
    assert perms._screen_switch_off("screen_record", {}, body, mode) is True
    assert "Screen recording switch" in perms.SCREEN_SWITCH_OFF and "Settings › Privacy" in perms.SCREEN_SWITCH_OFF


@pytest.mark.parametrize("args,body", [({"action": "stop"}, {"ceilings": {"screen": "off"}}), ({"action": "status"}, {"ceilings": {"screen": "off"}}),
                                       ({"action": "start"}, {"ceilings": {"screen": "on"}}), ({"action": "start"}, {"ceilings": {}}), ({"action": "start"}, None)])
def test_the_switch_does_not_trap_a_running_recording_or_refuse_when_on(perms, args, body):
    assert perms._screen_switch_off("screen_record", args, body) is False


def test_the_switch_is_the_tools_own_not_every_tools(perms):
    assert perms._screen_switch_off("read_file", {"action": "start"}, {"ceilings": {"screen": "off"}}) is False


def test_the_missing_grant_sends_the_user_to_the_setup_row():
    assert "Settings > Setup" in door.PERMISSION and "Allow on Screen recording" in door.PERMISSION


def test_the_tool_is_in_the_computer_use_toolset_and_is_not_deferred():
    import toolsets
    assert "screen_record" in toolsets.TOOLSETS["computer_use"]["tools"]
    from hermes_cli.config_defaults import DEFAULT_CONFIG
    assert "screen_record" not in json.dumps(DEFAULT_CONFIG.get("tools", {}).get("tool_search", {}).get("defer", []))


def test_nothing_in_the_door_can_upload():
    source = (PLUGIN / "screen_door.py").read_text()
    for word in ("urllib", "http", "requests", "socket.", "curl"):
        assert word not in source, word


def test_signals_do_not_stop_the_supervisor_before_the_file_is_finished(tmp_path):
    """TERM to the supervisor must not reach screencapture as TERM: that loses the file (measured on the real binary)."""
    fake = _fake(tmp_path / "f", _movie())
    rec = _recorder(tmp_path, fake)
    path = rec.start(30)["path"]
    rec.proc.send_signal(signal.SIGTERM)
    time.sleep(0.3)
    assert rec.status()["recording"] is True
    rec.stop()
    assert Path(path).is_file()
