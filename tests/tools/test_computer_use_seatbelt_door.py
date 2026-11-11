"""F54, ruling S10: computer use with the Seatbelt on. Real codesign, real launcher socket, real stub, a driver the test
writes; nothing here touches a real driver daemon, TCC or an app. The one read of /Applications is codesign --verify."""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "plugins" / "iclone-confinement"
darwin = pytest.mark.skipif(sys.platform != "darwin", reason="codesign and LaunchServices are the macOS path")


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


door = _load("iclone_driver_door", PLUGIN / "driver_door.py")
launcher_mod = _load("iclone_launcher_for_door", PLUGIN / "launcher.py")


def _fake_app(where: Path, script: str, *, sign=True, identifier="com.trycua.driver") -> Path:
    """A bundle whose binary leaves a mark if it ever runs, ad-hoc signed claiming the real identifier."""
    app = where / "CuaDriver.app"
    (app / "Contents" / "MacOS").mkdir(parents=True)
    exe = app / "Contents" / "MacOS" / "cua-driver"
    exe.write_text(script)
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    (app / "Contents" / "Info.plist").write_text(
        '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>cua-driver</string>'
        f'<key>CFBundleIdentifier</key><string>{identifier}</string></dict></plist>')
    if sign:
        subprocess.run(["/usr/bin/codesign", "-s", "-", "-f", "-i", identifier, str(app)], check=True, capture_output=True)
    return app


# ── the signature decides ──────────────────────────────────────────────────────────────────────────────────────────


@darwin
def test_a_home_made_signature_claiming_the_identifier_is_refused_and_never_runs(tmp_path):
    mark = tmp_path / "ran"
    app = _fake_app(tmp_path, f"#!/bin/sh\ntouch {mark}\n")
    claimed = subprocess.run(["/usr/bin/codesign", "-dv", str(app)], capture_output=True, text=True).stderr
    assert "Identifier=com.trycua.driver" in claimed  # what the old read would have accepted as far as the name goes
    assert door.signature_problem(str(app)) != ""
    assert not mark.exists()


@darwin
@pytest.mark.parametrize("place", ["pm", "local-bin"])
def test_a_malicious_driver_at_a_searched_path_does_not_run(tmp_path, place, monkeypatch):
    monkeypatch.setattr(door, "APPLICATIONS_APP", str(tmp_path / "nothing" / "CuaDriver.app"))
    mark, home, hermes = tmp_path / "ran", tmp_path / "home", tmp_path / "hermes"
    home.mkdir(), hermes.mkdir()
    if place == "pm":
        entry = hermes / "tools" / "cua-driver-0.21.0"
        entry.mkdir(parents=True)
        _fake_app(entry, f"#!/bin/sh\ntouch {mark}\n")
    else:
        app = _fake_app(tmp_path, f"#!/bin/sh\ntouch {mark}\n")
        (home / ".local" / "bin").mkdir(parents=True)
        (home / ".local" / "bin" / "cua-driver").symlink_to(app / "Contents" / "MacOS" / "cua-driver")
    app_found, why = door.locate(str(home), str(hermes))
    assert app_found == ""
    assert "not the CuaDriver signed by Cua" in why and "Install CuaDriver" in why
    with pytest.raises(door.DoorRefused, match="Install CuaDriver"):
        door.Door(str(tmp_path), str(home), str(hermes)).plan({"argv": [door.COMMAND, "where"]})
    assert not mark.exists()


@darwin
@pytest.mark.skipif(not os.path.isdir("/Applications/CuaDriver.app"), reason="no real driver on this Mac")
def test_the_real_driver_passes_the_check():
    assert door.signature_problem("/Applications/CuaDriver.app") == ""


def test_absent_names_exactly_what_to_do(tmp_path, monkeypatch):
    monkeypatch.setattr(door, "APPLICATIONS_APP", str(tmp_path / "none"))
    assert door.locate(str(tmp_path), str(tmp_path))[1] == door.ABSENT
    assert "Settings > Setup > Computer use" in door.ABSENT and "Install CuaDriver" in door.ABSENT
    assert "Accessibility" in door.PERMISSION and "System Settings" in door.PERMISSION


def test_candidates_are_the_real_user_places_in_order():
    assert door.candidates("/h", "") == ["/Applications/CuaDriver.app", "/h/.local/bin/cua-driver"]


# ── only the shapes computer use sends ─────────────────────────────────────────────────────────────────────────────

SOCK = "hc-0123456789ab"


@pytest.mark.parametrize("args", [
    ["where"], ["--help"], ["manifest"], ["status", "--socket", SOCK], ["stop", "--socket", SOCK],
    ["mcp", "--embedded", "--socket", SOCK], ["mcp", "--no-overlay", "--embedded", "--socket", SOCK],
    ["call", "list_apps", "{}", "--socket", SOCK],
    ["serve", "--embedded", "--socket", SOCK, "--no-permissions-gate", "--permission-mode", "standard"],
    ["serve", "--embedded", "--socket", SOCK, "--no-permissions-gate", "--permission-mode", "unrestricted",
     "--dangerously-bypass-approvals", "--no-overlay"],
])
def test_allowed_shapes(args):
    assert door._shape(args)[0] == args


@pytest.mark.parametrize("args", [
    [], ["sh", "-c", "id"], ["call", "x", "{}"], ["status"], ["--version", "--socket", SOCK],
    ["serve", "--embedded", "--socket", SOCK, "--no-permissions-gate", "--permission-mode", "bounded"],
    ["serve", "--embedded", "--socket", SOCK, "--no-permissions-gate", "--permission-mode", "standard", "--dangerously-bypass-approvals"],
    ["serve", "--socket", SOCK, "--permission-mode", "standard"],
    ["serve", "--embedded", "--socket", SOCK, "--no-permissions-gate", "--capability-manifest", "/tmp/m", "--approve-capability-manifest"],
    ["mcp", "--socket", SOCK], ["status", "--socket", SOCK, "--evil"],
])
def test_other_shapes_are_refused(args):
    with pytest.raises(door.DoorRefused):
        door._shape(args)


@pytest.mark.parametrize("name", ["/tmp/evil.sock", "../x", "hc-XYZ", "hc-12", "hc-0123456789ab/../../x"])
def test_the_socket_is_a_name_never_a_path(tmp_path, name):
    d = door.Door(str(tmp_path), "", "", locator=lambda *_: ("/x.app", ""))
    with pytest.raises(door.DoorRefused, match="named by the launcher"):
        d.plan({"argv": [door.COMMAND, "status", "--socket", name]})


def test_nothing_the_request_carries_reaches_the_driver(tmp_path):
    d = door.Door(str(tmp_path), "/h", "", locator=lambda *_: ("/x.app", ""))
    plan = d.plan({"argv": [door.COMMAND, "manifest"], "cwd": "/evil",
                   "env": {"HERMES_CUA_DRIVER_CMD": "/evil", "DYLD_INSERT_LIBRARIES": "/evil"}})
    assert plan["executable"] == "/x.app/Contents/MacOS/cua-driver" and plan["cwd"] == "/"
    assert set(plan["env"]) == {"PATH", "HOME", "LANG", "CUA_DRIVER_RS_TELEMETRY_ENABLED"}
    assert plan["start"]["unconfined"] is True and "outside the Seatbelt" in plan["start"]["command"]


def test_serve_goes_through_launchservices_and_gets_a_sitter(tmp_path, monkeypatch):
    sat = []
    monkeypatch.setattr(door, "start_sitter", lambda exe, path, python: sat.append((exe, path)) or "s")
    d = door.Door("/tmp/f54", "/h", "", locator=lambda *_: ("/x.app", ""))
    plan = d.plan({"argv": [door.COMMAND, "serve", "--embedded", "--socket", SOCK, "--no-permissions-gate", "--permission-mode", "standard"]})
    path = "/tmp/f54/" + SOCK + ".sock"
    assert plan["argv"][:5] == [door.OPEN, "-n", "-g", "-a", "/x.app"] and path in plan["argv"]
    assert "CUA_DRIVER_RS_TELEMETRY_ENABLED=0" in plan["argv"]
    assert sat == [("/x.app/Contents/MacOS/cua-driver", path)]


# ── through the real launcher and the real stub ────────────────────────────────────────────────────────────────────


@pytest.fixture
def live(tmp_path, monkeypatch):
    run = Path(f"/tmp/f54d{os.getpid()}")
    run.mkdir(mode=0o700, exist_ok=True)
    sock = run / "l.sock"
    script = tmp_path / "drv"
    (script / "Contents" / "MacOS").mkdir(parents=True)
    exe = script / "Contents" / "MacOS" / "cua-driver"
    exe.write_text('#!/bin/sh\necho "driver said: $*"; echo "env $HERMES_CUA_DRIVER_CMD"; exit 7\n')
    exe.chmod(0o755)
    journal = tmp_path / "journal"
    launcher = launcher_mod.Launcher(SimpleNamespace(scratch_root=str(tmp_path / "scratch"), members_dir=str(tmp_path / "members")), str(sock), str(journal))
    launcher.driver_door.locator = lambda *_: (str(script), "")
    launcher.bind()
    thread = threading.Thread(target=launcher.serve_forever, daemon=True)
    thread.start()
    yield sock, launcher, journal
    launcher.stop()
    shutil.rmtree(run, ignore_errors=True)


def _stub(sock, *args, env=None):
    return subprocess.run([sys.executable, "-I", "-S", str(PLUGIN / "stub.py"), str(sock), "--", door.COMMAND, *args],
                          capture_output=True, text=True, timeout=20, stdin=subprocess.DEVNULL,
                          env={"ICLONE_RUN_CWD": "/", **(env or {})})


@darwin
def test_the_door_runs_the_driver_outside_and_gives_its_rc_back(live):
    sock, _launcher, journal = live
    proc = _stub(sock, "manifest", env={"HERMES_CUA_DRIVER_CMD": "/evil"})
    assert proc.returncode == 7 and "driver said: manifest" in proc.stdout and "/evil" not in proc.stdout
    deadline = time.monotonic() + 3
    rows = ""
    while time.monotonic() < deadline and "outside the Seatbelt" not in rows:
        rows = "".join(p.read_text() for p in journal.glob("*.jsonl"))
    assert "the signed driver outside the Seatbelt" in rows


@darwin
def test_the_door_refuses_a_verb_through_the_real_launcher_in_plain_words(live):
    proc = _stub(live[0], "sh", "-c", "id")
    assert proc.returncode != 0 and "not one computer use sends" in proc.stderr and "uid=" not in proc.stdout


# ── the daemon ends with its owner ─────────────────────────────────────────────────────────────────────────────────


LISTEN = """
import os, signal, socket, sys, time
s = socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen(8)
signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
print("up", flush=True)
while True: s.accept()[0].close()
"""


def _daemon(path):
    proc = subprocess.Popen([sys.executable, "-c", LISTEN, str(path)], stdout=subprocess.PIPE, text=True)
    assert proc.stdout.readline().strip() == "up"
    return proc


@darwin
@pytest.mark.parametrize("how", ["asked", "owner-killed"])
def test_the_sitter_ends_a_daemon_that_ignores_stop(tmp_path, how):
    run = Path(f"/tmp/f54s{os.getpid()}{how[0]}")
    run.mkdir(exist_ok=True)
    path = run / "d.sock"
    daemon = _daemon(path)
    exe = tmp_path / "drv"
    exe.write_text("#!/bin/sh\nexit 0\n")
    exe.chmod(0o755)
    try:
        if how == "asked":
            door.stop_sitter(door.start_sitter(str(exe), str(path), sys.executable))
        else:  # the runtime is killed, no atexit runs: the pipe closes all the same
            owner = subprocess.Popen([sys.executable, "-c", (
                "import importlib.util as u, os, signal, sys\n"
                f"s = u.spec_from_file_location('d', {str(PLUGIN / 'driver_door.py')!r}); m = u.module_from_spec(s); s.loader.exec_module(m)\n"
                f"m.start_sitter({str(exe)!r}, {str(path)!r}, sys.executable)\nos.kill(os.getpid(), signal.SIGKILL)\n")])
            owner.wait(timeout=10)
        assert daemon.wait(timeout=10) == 0
        deadline = time.monotonic() + 10  # the sitter removes the socket after the daemon goes; no fixed sleep
        while path.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not path.exists()
    finally:
        daemon.kill()
        daemon.stdout.close()
        shutil.rmtree(run, ignore_errors=True)


# ── the runtime's side ─────────────────────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def driver_mod():
    from tools.computer_use import cua_backend_driver as driver
    return driver


def _confined(monkeypatch, driver):
    monkeypatch.setattr(driver, "door_socket", lambda: "/tmp/l.sock")
    monkeypatch.setattr(driver, "icloneos_started", lambda: True)


def test_confined_the_runtime_names_the_door_and_carries_it_by_the_stub(monkeypatch, driver_mod):
    _confined(monkeypatch, driver_mod)
    monkeypatch.setenv("HERMES_CUA_DRIVER_CMD", "/evil/driver")
    assert driver_mod.resolve_cua_driver_cmd() == door.COMMAND
    argv = driver_mod.spawn_argv([door.COMMAND, "manifest"])
    assert argv[:3] == [sys.executable, "-I", "-S"] and argv[3].endswith("plugins/iclone-confinement/stub.py")
    assert argv[4:] == ["/tmp/l.sock", "--", door.COMMAND, "manifest"]
    assert driver_mod.spawn_env([door.COMMAND], {"A": "1"}) == {"A": "1", "ICLONE_RUN_CWD": "/"}
    assert driver_mod.spawn_argv(["/bin/echo"]) == ["/bin/echo"]


def test_confined_the_serve_never_touches_open_itself(monkeypatch, driver_mod):
    _confined(monkeypatch, driver_mod)
    from tools.computer_use.cua_backend_daemon import _embedded_daemon_spawn_command, _EmbeddedCuaDaemon
    assert _embedded_daemon_spawn_command(door.COMMAND, ["serve"], platform="darwin") == [door.COMMAND, "serve"]
    assert door.SOCKET_NAME.match(_EmbeddedCuaDaemon("", "standard").socket_path)


def test_mcp_invocation_keeps_the_door_whatever_the_manifest_names(monkeypatch, driver_mod):
    _confined(monkeypatch, driver_mod)
    monkeypatch.setattr(driver_mod, "_driver_json", lambda *a, **k: {"mcp_invocation": {"command": "/evil/x", "args": ["mcp"]}})
    monkeypatch.setattr(driver_mod, "_mcp_args_with_overlay_flag", lambda args, driver_cmd=None: list(args))
    assert driver_mod._resolve_mcp_invocation(door.COMMAND)[0] == door.COMMAND


@darwin
def test_offered_under_icloneos_with_no_driver_and_refused_with_what_to_do(monkeypatch, driver_mod):
    from tools.computer_use.cua_backend import CuaDriverBackend
    monkeypatch.setattr(driver_mod, "icloneos_started", lambda: True)
    monkeypatch.setattr(driver_mod, "resolve_cua_driver_cmd", lambda override=None: None)
    assert CuaDriverBackend().is_available() is True
    monkeypatch.setattr(door, "APPLICATIONS_APP", "/nonexistent/CuaDriver.app")
    assert "Install CuaDriver" in driver_mod.cua_driver_install_hint()


def test_outside_icloneos_nothing_changes(monkeypatch, driver_mod):
    from tools.computer_use.cua_backend import CuaDriverBackend
    monkeypatch.setattr(driver_mod, "icloneos_started", lambda: False)
    monkeypatch.setattr(driver_mod, "door_socket", lambda: "")
    backend = CuaDriverBackend()
    assert backend._embedded_daemon is None
    assert "hermes computer-use install" in driver_mod.cua_driver_install_hint()


def test_under_icloneos_every_mode_gets_its_own_daemon(monkeypatch, driver_mod):
    from tools.computer_use.cua_backend import CuaDriverBackend
    monkeypatch.setattr(driver_mod, "icloneos_started", lambda: True)
    assert CuaDriverBackend()._embedded_daemon is not None


def test_stale_confinement_note_is_gone():
    text = (PLUGIN / "__init__.py").read_text()
    assert "computer use and keychain imports do not run while confined" not in text


# ── the ask, the schema, the app ───────────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def classify_mod():
    pkg = ModuleType("iclone_permissions_for_door")  # its __init__ needs Hermes' plugin host; classify needs only the package
    pkg.__path__ = [str(ROOT / "plugins" / "iclone-permissions")]
    sys.modules[pkg.__name__] = pkg
    return importlib.import_module(pkg.__name__ + ".classify")


@pytest.mark.parametrize("args, want", [
    ({"action": "key", "keys": "4", "app": "Calculator"}, "Press the key 4 in Calculator"),
    ({"action": "type", "text": "42", "app": "Notes"}, "Type '42' in Notes"),
    ({"action": "click", "element": 3, "app": "Calculadora"}, "Click on element 3 in Calculadora"),
    ({"action": "right_click", "coordinate": [1, 2], "app": "Mail"}, "Right click on point [1, 2] in Mail"),
    ({"action": "capture", "app": "Safari"}, "See the screen in Safari"),
    ({"action": "focus_app", "app": "Calculator"}, "Bring Calculator forward"),
    ({"action": "key", "keys": "4"}, "Press the key 4 in the app in front (no app named)"),
])
def test_the_ask_names_the_action_and_the_app(classify_mod, args, want):
    assert classify_mod._computer_use_target(args, None) == want


def test_the_ask_names_the_app_the_session_focused(classify_mod, monkeypatch):
    from tools.computer_use import tool
    monkeypatch.setattr(tool, "active_app_for_session", lambda sid: "Calculadora")
    assert classify_mod._computer_use_target({"action": "key", "keys": "2"}, "s") == "Press the key 2 in Calculadora"


def test_b4_the_ask_shows_the_name_the_driver_gave_for_a_bundle_id(classify_mod, monkeypatch):
    from tools.computer_use import tool
    monkeypatch.setattr(tool, "active_app_for_session", lambda sid: "Calculator")
    args = {"action": "key", "keys": "4", "app": "com.apple.calculator"}
    assert classify_mod._computer_use_target(args, "s") == "Press the key 4 in Calculator"


def test_g23_a_bundle_id_only_ending_like_the_app_in_front_is_shown_with_it(classify_mod, monkeypatch):
    from tools.computer_use import tool
    monkeypatch.setattr(tool, "active_app_for_session", lambda sid: "Calculator")
    args = {"action": "key", "keys": "4", "app": "com.evil.calculator"}
    assert classify_mod._computer_use_target(args, "s") == "Press the key 4 in Calculator (com.evil.calculator)"


@pytest.mark.parametrize("focused", [None, "Calculadora", "Notes"])
def test_b4_the_bundle_id_stays_when_no_name_is_proved_for_it(classify_mod, monkeypatch, focused):
    from tools.computer_use import tool
    monkeypatch.setattr(tool, "active_app_for_session", lambda sid: focused)
    args = {"action": "key", "keys": "4", "app": "com.apple.calculator"}
    assert classify_mod._computer_use_target(args, "s") == "Press the key 4 in Calculator (com.apple.calculator)"


@pytest.mark.parametrize("app, shown", [("com.microsoft.VSCode", "VSCode (com.microsoft.VSCode)"),
                                        ("Visual Studio Code", "Visual Studio Code"), ("Notes", "Notes"),
                                        ("Safari.app", "Safari"), ("Visual Studio Code.APP", "Visual Studio Code"),
                                        ("com.example.app", "App (com.example.app)"), ("Draw.io.app", "Draw.io"),
                                        ("Draw.io", "Draw.io"), ("/Applications/Safari.app", "Safari"),
                                        ("/Applications/Draw.io.app/", "Draw.io"),
                                        ("com.apple.Safari.app", "Safari (com.apple.Safari)"),
                                        ("Com.Example.App", "App (Com.Example.App)")])
def test_p2b_an_app_is_shown_by_name_and_a_bundle_id_only_beside_it(classify_mod, monkeypatch, app, shown):
    from tools.computer_use import tool
    monkeypatch.setattr(tool, "active_app_for_session", lambda sid: None)
    assert classify_mod._computer_use_target({"action": "left_click_drag", "app": app}, "s").endswith(f"in {shown}")


def test_the_schema_tells_the_truth_about_what_asks():
    from tools.computer_use.schema import COMPUTER_USE_SCHEMA
    text = json.dumps(COMPUTER_USE_SCHEMA)
    assert "`capture` is free" not in text and "in Manual every action asks" in text and "in Ignore nothing asks" in text
    assert "com.apple.calculator" in text



@pytest.mark.parametrize("asked, want", [("Calculadora", [1]), ("com.apple.calculator", [1]), ("Calculator", [1]), ("calculator", [1])])
def test_an_app_by_bundle_id_or_localised_name(asked, want):
    from tools.computer_use import cua_backend_capture as capture
    host = type("H", (), {"list_apps": lambda self: [{"pid": 1, "name": "Calculadora", "bundle_id": "com.apple.calculator"},
                                                     {"pid": 2, "name": "Notas", "bundle_id": "com.apple.Notes"}]})()
    windows = [{"pid": 1, "app_name": "Calculadora"}, {"pid": 2, "app_name": "Notas"}]
    match = next(v for v in vars(capture).values() if isinstance(v, type) and hasattr(v, "_match_windows_for_app"))
    assert [w["pid"] for w in match._match_windows_for_app(host, windows, asked)] == want


def test_two_apps_with_the_same_tail_are_not_narrowed_to_one():
    from tools.computer_use import cua_backend_capture as capture
    host = type("H", (), {"list_apps": lambda self: [{"pid": 1, "name": "Calc", "bundle_id": "com.apple.calculator"},
                                                     {"pid": 2, "name": "Other", "bundle_id": "com.evil.calculator"}]})()
    windows = [{"pid": 1, "app_name": "Calc"}, {"pid": 2, "app_name": "Other"}]
    match = next(v for v in vars(capture).values() if isinstance(v, type) and hasattr(v, "_match_windows_for_app"))
    assert {w["pid"] for w in match._match_windows_for_app(host, windows, "Calculator")} == {1, 2}  # never a silent pick of one


# ── the guard ──────────────────────────────────────────────────────────────────────────────────────────────────────


def _decide(argv, monkeypatch):
    from tools.environments import host_lane
    frame = SimpleNamespace(f_code=SimpleNamespace(co_filename=str(ROOT / "tools" / "computer_use" / "cua_backend.py"), co_name="_run_quiet"),
                            f_back=None, f_lineno=1, f_globals={})
    return host_lane.decide_spawn("subprocess.Popen", (argv[0], argv, None, {}), frame, fixed=frozenset(), hermes=frozenset(),
                                  foreign=(), seals=set(), confined=True)


def test_the_guard_lets_only_the_exact_door_form_through(monkeypatch):
    from tools.environments.host_lane import STUB_FILE
    stub = os.path.realpath(str(STUB_FILE))
    python = os.path.realpath(sys.executable)
    good = [python, "-I", "-S", stub, "/tmp/l", "--", door.COMMAND, "manifest"]
    assert _decide(good, monkeypatch)[0] is True
    for bad in ([python, "-I", "-S", stub, "/tmp/l", "--", "/bin/sh", "-c", "id"],
                [python, "-I", "-S", "/tmp/evil.py", "/tmp/l", "--", door.COMMAND, "manifest"],
                [python, "-c", "x", stub, "/tmp/l", "--", door.COMMAND, "manifest"],
                ["/Applications/CuaDriver.app/Contents/MacOS/cua-driver", "manifest"],
                ["/usr/bin/open", "-a", "/Applications/CuaDriver.app"]):
        assert _decide(bad, monkeypatch)[0] is False, bad




def test_a_missing_permission_says_exactly_where(monkeypatch, driver_mod):
    from tools import computer_use_tool as shim
    monkeypatch.setattr(driver_mod, "icloneos_started", lambda: True)
    out = json.loads(shim._with_what_to_do(json.dumps({"ok": False, "error": "Accessibility permission not granted"})))
    assert "System Settings > Privacy & Security" in out["what_to_do"]
    plain = json.dumps({"ok": True, "text": "Display 42"})
    assert shim._with_what_to_do(plain) == plain
    monkeypatch.setattr(driver_mod, "icloneos_started", lambda: False)
    denied = json.dumps({"ok": False, "error": "Accessibility permission not granted"})
    assert shim._with_what_to_do(denied) == denied


def test_the_requirement_names_the_anchor_the_identifier_and_every_team():
    assert door.REQUIREMENT.startswith('=identifier "com.trycua.driver" and anchor apple generic and (')
    assert all(f'certificate leaf[subject.OU] = "{team}"' in door.REQUIREMENT for team in door.TEAMS)


def test_the_bundle_tail_beats_another_app_whose_name_holds_the_word():
    from tools.computer_use import cua_backend_capture as capture
    host = type("H", (), {"list_apps": lambda self: [{"pid": 1, "name": "Calculadora", "bundle_id": "com.apple.calculator"},
                                                     {"pid": 3, "name": "Calculator Pro", "bundle_id": "com.x.pro"}]})()
    windows = [{"pid": 1, "app_name": "Calculadora"}, {"pid": 3, "app_name": "Calculator Pro"}]
    match = next(v for v in vars(capture).values() if isinstance(v, type) and hasattr(v, "_match_windows_for_app"))
    assert [w["pid"] for w in match._match_windows_for_app(host, windows, "Calculator")] == [1]


@darwin
def test_the_launcher_stopping_stops_the_daemons_it_started(live):
    _sock, launcher, _journal = live
    stopped = []
    launcher.driver_door.stop_all = lambda: stopped.append(True)
    launcher.stop()
    assert stopped == [True]


# ── what the real app found: the runtime's socket name, the provider's check, a key aimed by bundle id ─────────────


def test_the_door_reads_the_name_main_gives_the_runtime(monkeypatch, driver_mod):
    """index.ts hands the runtime ICLONE_CONFINEMENT_LAUNCHER; ICLONE_LAUNCHER_SOCKET is the launcher's own."""
    import hermes_cli.iclone_policy_env as policy
    from tools.environments import host_lane
    monkeypatch.setattr(host_lane, "confined_process", lambda: True)
    seen = {"ICLONE_CONFINEMENT_LAUNCHER": "/tmp/right.sock", "ICLONE_LAUNCHER_SOCKET": "/tmp/wrong.sock"}
    monkeypatch.setattr(policy, "exec_env", seen.get)
    assert driver_mod.door_socket() == "/tmp/right.sock"
    assert (ROOT / "apps/desktop/electron/iclone-confinement/index.ts").read_text().count("ICLONE_CONFINEMENT_LAUNCHER: launcherSocket") == 1


def test_the_check_the_registry_really_calls_offers_the_tool_under_icloneos(monkeypatch, driver_mod):
    """plugins/computer_use/cua decides, not the backend's is_available: the tool must not vanish silently."""
    provider = next(v for k, v in vars(_load("cua_provider_for_door", ROOT / "plugins/computer_use/cua/__init__.py")).items()
                    if isinstance(v, type) and "display_name" in vars(v))
    monkeypatch.setattr(driver_mod, "cua_driver_binary_available", lambda: False)
    monkeypatch.setattr(driver_mod, "icloneos_started", lambda: True)
    assert provider().is_available() is (sys.platform == "darwin")


@pytest.mark.parametrize("asked, wrong", [("com.apple.calculator", None), ("Calculator", None), ("Calculadora", None),
                                          ("com.apple.Notes", "Calculadora"), ("Notes", "Calculadora")])
def test_a_key_aimed_by_bundle_id_or_name_at_the_app_in_focus(asked, wrong):
    from tools.computer_use.tool import _input_target_mismatch
    backend = SimpleNamespace(_last_app="Calculadora", list_apps=lambda: [
        {"pid": 1, "name": "Calculadora", "bundle_id": "com.apple.calculator"}, {"pid": 2, "name": "Notas", "bundle_id": "com.apple.Notes"}])
    assert _input_target_mismatch(backend, asked) == wrong


def test_a_list_that_cannot_be_read_still_refuses_the_mismatch():
    from tools.computer_use.tool import _input_target_mismatch

    def broken():
        raise OSError("no daemon")
    assert _input_target_mismatch(SimpleNamespace(_last_app="Calculadora", list_apps=broken), "com.apple.calculator") == "Calculadora"


def test_under_icloneos_nothing_downloads_on_first_use_and_absent_says_what_to_do(monkeypatch, driver_mod):
    import pm
    from tools.computer_use.cua_backend import CuaDriverBackend
    monkeypatch.setattr(driver_mod, "icloneos_started", lambda: True)
    monkeypatch.setattr(driver_mod, "door_socket", lambda: "")
    monkeypatch.setattr(driver_mod, "resolve_cua_driver_cmd", lambda override=None: None)
    monkeypatch.setattr(door, "APPLICATIONS_APP", "/nonexistent/CuaDriver.app")
    monkeypatch.setattr(pm, "ensure", lambda *a, **k: pytest.fail("a download on first use"))
    with pytest.raises(RuntimeError, match="Install CuaDriver"):
        CuaDriverBackend().start()


# ── lead's ruling on placement: computer_use through the door passes, nothing else leaves the Seatbelt ─────────────


def _placed(monkeypatch, driver_mod, backend):
    from tools.bot_desktop import placement
    monkeypatch.setattr(driver_mod, "door_socket", lambda: "/tmp/l.sock")
    monkeypatch.setattr(placement, "_terminal_backend", lambda: backend)
    monkeypatch.setattr(placement, "_setting", lambda: "auto")


def test_computer_use_through_the_door_is_not_stopped_by_placement(monkeypatch, driver_mod):
    from tools.computer_use.cua_backend import sandbox_mcp_invocation
    _placed(monkeypatch, driver_mod, "iclone_seatbelt")
    assert sandbox_mcp_invocation() is None


def test_a_browser_call_runs_with_the_seatbelt_on_ruling_r1(monkeypatch, driver_mod):
    """Ruling R1 reverses F54's refusal for the browser, and only for it: confine_program keeps agent-browser and
    Chrome inside the agent's profile, the mode decides the network."""
    from tools.bot_desktop import placement, runtime
    _placed(monkeypatch, driver_mod, "iclone_seatbelt")
    assert runtime.tool_placement(browser=True) == placement.GATEWAY


def test_r1_names_the_browser_only(monkeypatch, driver_mod):
    from tools.bot_desktop import runtime
    _placed(monkeypatch, driver_mod, "iclone_seatbelt")
    with pytest.raises(RuntimeError, match="cannot host a screen yet"):
        runtime.tool_placement()
    _placed(monkeypatch, driver_mod, "iclone_container")
    with pytest.raises(RuntimeError, match="cannot host a screen yet"):
        runtime.tool_placement(browser=True)


def test_another_backend_gets_no_door_through_placement(monkeypatch, driver_mod):
    from tools.computer_use.cua_backend import sandbox_mcp_invocation
    _placed(monkeypatch, driver_mod, "iclone_container")
    with pytest.raises(RuntimeError, match="cannot host a screen yet"):
        sandbox_mcp_invocation()


def test_without_the_door_placement_still_decides(monkeypatch, driver_mod):
    from tools.computer_use.cua_backend import sandbox_mcp_invocation
    _placed(monkeypatch, driver_mod, "iclone_seatbelt")
    monkeypatch.setattr(driver_mod, "door_socket", lambda: "")
    with pytest.raises(RuntimeError, match="cannot host a screen yet"):
        sandbox_mcp_invocation()
