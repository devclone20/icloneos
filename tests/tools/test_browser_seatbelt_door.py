"""Ruling R1 narrows ruling 56 for one site: with the Seatbelt on, agent-browser runs outside through the launcher's door.

The door takes exact verbs, runs only the agent-browser the lock pins, builds the program's environment itself, and stops
what it started when the launcher stops. Everything next to those shapes stays refused.
"""

from __future__ import annotations

import atexit
import hashlib
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "plugins" / "iclone-confinement"
SITE_FILE = str(ROOT / "tools" / "browser_tool_session.py")
SITE = "tools/browser_tool_session.py::_popen_agent_browser"
darwin = pytest.mark.skipif(sys.platform != "darwin", reason="the Seatbelt door is macOS")


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def door():
    return _load("iclone_browser_door", PLUGIN / "browser_door.py")


# G102: these tests read payload order, paths and verbs; plan() also takes a free port from DEBUG_PORTS, which another
# test process may hold at that moment (twice "no free port" in full suites). Only the tests about ports pick a real one.
_REAL_PORT_TESTS = frozenset({
    "test_a_busy_debugger_port_is_passed_over_and_all_busy_is_a_refusal",
    "test_the_shim_runs_chrome_on_a_pinned_port_and_answers_for_it",
})
# 2026-11-07 (lead, R6/review/fin24-browser-door.md): the stream-port test left this list. Picking a free port among the
# 14 real ones raced the other real-port tests run by parallel workers ("no free port", fin24 and close3); the real
# choice stays proved by test_a_busy_debugger_port_is_passed_over_and_all_busy_is_a_refusal, and this test keeps its
# point: the port is a denied one until the daemon runs, and a running daemon keeps it.


@pytest.fixture(autouse=True)
def _debug_port_held_by_no_one(request, monkeypatch):
    if request.node.originalname in _REAL_PORT_TESTS or "door" not in request.fixturenames:
        return
    door = request.getfixturevalue("door")
    monkeypatch.setattr(door, "free_debug_port", lambda ports=door.DEBUG_PORTS: ports[0])


HEAD = ["--session", "h_0123456789", "--json"]


def _store(tmp_path, door, *, body="#!/bin/sh\necho ran\n", pin=True):
    """A store and a lock as a fresh install leaves them; returns (hermes_home, lock path, binary)."""
    home = tmp_path / "hh"
    target = door.current_target()
    binary = home / "tools" / f"agent-browser-0.26.0-{target}" / "bin" / f"agent-browser-{target}"
    binary.parent.mkdir(parents=True)
    binary.write_text(body)
    binary.chmod(0o755)
    chrome = home / "tools" / "chromium-1208" / door.chrome_folder(target) / door.CHROME_APP / "Contents" / "MacOS" / door.CHROME_BIN
    chrome.parent.mkdir(parents=True)
    chrome.write_text("#!/bin/sh\n")
    chrome.chmod(0o755)
    lock = tmp_path / "lock.json"
    entry = {"version": "0.26.0"}
    if pin:
        entry["binaries"] = {target: hashlib.sha256(body.encode()).hexdigest()}
    lock.write_text(json.dumps({"packages": {"agent-browser": entry, "chromium": {"version": "1208+145.0.7632.6"}}}))
    return home, lock, binary


SHORT = Path(tempfile.mkdtemp(prefix="g12", dir="/private/tmp"))  # a unix socket's path is short; tmp_path is not
atexit.register(shutil.rmtree, SHORT, ignore_errors=True)


def _req(tmp_path, *args, env=None):
    sockets = SHORT / "ab-h_0123456789"
    sockets.mkdir(parents=True, exist_ok=True, mode=0o700)
    return {"argv": ["iclone-agent-browser", *args], "cwd": "/somewhere",
            "env": {"AGENT_BROWSER_SOCKET_DIR": str(sockets), **(env or {})}}


def _door(tmp_path, door, **kw):
    home, lock, binary = _store(tmp_path, door, **kw)
    made = door.Door(str(home), str(tmp_path / "user"), lock_path=str(lock), sit=False)
    return made, home, binary


# ---- the exact verbs


@pytest.mark.parametrize("tail", [
    ["open", "https://example.com/"], ["open", "http://127.0.0.1:8000/a"], ["open", "about:blank"],
    ["snapshot"], ["snapshot", "-c"], ["click", "@e1"], ["fill", "@e2", "words"], ["press", "Enter"], ["scroll", "down", "500"],
    ["back"], ["eval", "document.title"], ["console"], ["console", "--clear"], ["errors"], ["errors", "--clear"], ["get", "url"],
    ["close"], ["record", "stop"]])
def test_each_verb_the_tools_send_passes(tmp_path, door, tail):
    made, _home, binary = _door(tmp_path, door)
    plan = made.plan(_req(tmp_path, *HEAD, *tail))
    assert plan["argv"] == [str(binary), *HEAD, *tail] and plan["executable"] == str(binary) and plan["cwd"] == "/"
    assert plan["start"]["unconfined"] is True and plan["start"]["origin"] == "agent"


@pytest.mark.parametrize("tail", [
    [], ["install"], ["batch"], ["connect", "9222"], ["upload", "@e1", "/etc/passwd"], ["download", "@e1", "/tmp/x"],
    ["state", "save", "/tmp/x"], ["cookies"], ["get", "cdp-url"], ["get", "html"], ["open"], ["open", "a", "b"],
    ["open", "file:///etc/passwd"], ["open", "FILE:///etc/passwd"], ["open", "view-source:file:///etc/passwd"],
    ["open", "javascript:alert(1)"], ["open", "chrome://settings"], ["open", "data:text/html,x"], ["open", "http://"],
    ["open", "about:config"], ["snapshot", "-x"], ["click"], ["click", "@e1", "--force"], ["fill", "@e1"],
    ["scroll", "down", "-1"], ["scroll", "sideways", "5"], ["console", "--all"], ["back", "x"], ["close", "--all"],
    ["screenshot", "--full", "/tmp/x.png"], ["screenshot", "/tmp/x.png"], ["record", "start", "/tmp/x.webm"],
    ["eval", "--base64", "eA=="], ["click", "a\x00b"]])
def test_every_verb_next_to_them_is_refused(tmp_path, door, tail):
    made, _home, _binary = _door(tmp_path, door)
    with pytest.raises(door.DoorRefused):
        made.plan(_req(tmp_path, *HEAD, *tail))


@pytest.mark.parametrize("head", [
    ["--json", "open", "https://example.com/"],
    ["--session", "h_0123456789", "open", "https://example.com/"],
    ["--session", "../evil", "--json", "get", "url"], ["--session", "/tmp/x", "--json", "get", "url"],
    ["--session", "h_0123456789", "--cdp", "9222", "--json", "get", "url"],
    ["--session", "h_0123456789", "--headed", "--json", "get", "url"],
    ["--session", "h_0123456789", "--engine", "lightpanda", "--json", "get", "url"],
    ["--session", "h_0123456789", "--executable-path", "/bin/sh", "--json", "get", "url"],
    ["--session", "h_0123456789", "--args", "--renderer-cmd-prefix=/bin/sh", "--json", "get", "url"],
    ["--session", "h_0123456789", "--extension", "/tmp/x", "--json", "get", "url"],
    ["--session", "h_0123456789", "--profile", "/Users/x/Chrome", "--json", "get", "url"],
    ["--session", "h_0123456789", "--allow-file-access", "--json", "get", "url"]])
def test_a_flag_or_session_next_to_the_exact_head_is_refused(tmp_path, door, head):
    made, _home, _binary = _door(tmp_path, door)
    with pytest.raises(door.DoorRefused):
        made.plan(_req(tmp_path, *head))


def test_screenshot_and_recording_write_only_their_own_kind_inside_hermes_home(tmp_path, door):
    made, home, _binary = _door(tmp_path, door)
    shots = home / "cache" / "screenshots"
    shots.mkdir(parents=True)
    good = str(shots / "a.png")
    made.plan(_req(tmp_path, *HEAD, "screenshot", "--full", good))
    made.plan(_req(tmp_path, *HEAD, "screenshot", "--annotate", "--full", good))
    made.plan(_req(tmp_path, *HEAD, "record", "start", _webm(home)))
    with pytest.raises(door.DoorRefused):
        made.plan(_req(tmp_path, *HEAD, "record", "start", str(home / "cache" / "a.webm")))
    for bad in (str(shots / "a.sh"), str(shots / ".." / ".." / ".." / "a.png"), "a.png"):
        with pytest.raises(door.DoorRefused):
            made.plan(_req(tmp_path, *HEAD, "screenshot", "--full", bad))
    (shots / "l.png").symlink_to("/tmp/elsewhere.png")
    with pytest.raises(door.DoorRefused):
        made.plan(_req(tmp_path, *HEAD, "screenshot", "--full", str(shots / "l.png")))


# ---- the program


def test_a_swapped_binary_is_refused_and_never_runs(tmp_path, door):
    made, _home, binary = _door(tmp_path, door)
    binary.write_text("#!/bin/sh\necho swapped\n")
    with pytest.raises(door.DoorRefused, match="lock"):
        made.plan(_req(tmp_path, *HEAD, "get", "url"))


def test_a_link_at_the_binarys_path_is_refused(tmp_path, door):
    made, _home, binary = _door(tmp_path, door)
    real = binary.with_name("elsewhere")
    binary.rename(real)
    binary.symlink_to(real)
    with pytest.raises(door.DoorRefused):
        made.plan(_req(tmp_path, *HEAD, "get", "url"))


def test_no_pin_for_this_mac_refuses(tmp_path, door):
    made, _home, _binary = _door(tmp_path, door, pin=False)
    with pytest.raises(door.DoorRefused, match="lock"):
        made.plan(_req(tmp_path, *HEAD, "get", "url"))


def test_an_absent_browser_says_where_to_install_it(tmp_path, door):
    made, _home, binary = _door(tmp_path, door)
    binary.unlink()
    with pytest.raises(door.DoorRefused, match="Settings > Setup > Packages"):
        made.plan(_req(tmp_path, *HEAD, "get", "url"))


def test_the_real_lock_pins_the_macs(door):
    lock = json.loads((ROOT / "pm" / "lock.json").read_text())["packages"]["agent-browser"]
    assert set(lock["binaries"]) == {"darwin-arm64", "darwin-x64"} and lock["version"] == "0.26.0"
    assert all(len(v) == 64 for v in lock["binaries"].values())


def test_the_door_builds_the_environment_and_reads_none_of_the_callers(tmp_path, door):
    made, home, _binary = _door(tmp_path, door)
    hostile = {"AGENT_BROWSER_EXECUTABLE_PATH": "/bin/sh", "AGENT_BROWSER_ARGS": "--renderer-cmd-prefix=/bin/sh",
               "PATH": "/evil", "HOME": "/evil", "DYLD_INSERT_LIBRARIES": "/evil.dylib", "OPENAI_API_KEY": "secret",
               "AGENT_BROWSER_IDLE_TIMEOUT_MS": "60000"}
    plan = made.plan(_req(tmp_path, *HEAD, "get", "url", env=hostile))
    env = plan["env"]
    assert set(env) == {"PATH", "HOME", "LANG", "TMPDIR", "AGENT_BROWSER_SOCKET_DIR", "AGENT_BROWSER_EXECUTABLE_PATH",
                        "ICLONE_DOOR_CHROME", "ICLONE_DOOR_PYTHON", "ICLONE_DOOR_FILE", "ICLONE_DOOR_PORTS", "AGENT_BROWSER_STREAM_PORT",
                        "PLAYWRIGHT_BROWSERS_PATH", "AGENT_BROWSER_IDLE_TIMEOUT_MS"}
    assert env["ICLONE_DOOR_CHROME"].startswith(os.path.realpath(home / "tools" / "chromium-1208"))
    assert env["AGENT_BROWSER_EXECUTABLE_PATH"] == os.path.join(os.path.realpath(home / "tools"), door.CHROME_SHIM)
    assert env["ICLONE_DOOR_PORTS"] == os.path.join(os.path.realpath(home / "tools"), door.PORT_STATE)
    assert env["PATH"] != "/evil" and env["HOME"] == str(tmp_path / "user") and env["AGENT_BROWSER_IDLE_TIMEOUT_MS"] == "60000"
    assert "/evil" not in json.dumps(plan) and "secret" not in json.dumps(plan)


@pytest.mark.parametrize("value", ["1;rm", "-1", "x", "1" * 12])
def test_an_idle_timeout_that_is_not_a_plain_number_is_not_used(tmp_path, door, value):
    made, _home, _binary = _door(tmp_path, door)
    plan = made.plan(_req(tmp_path, *HEAD, "get", "url", env={"AGENT_BROWSER_IDLE_TIMEOUT_MS": value}))
    assert plan["env"]["AGENT_BROWSER_IDLE_TIMEOUT_MS"] == door.IDLE_DEFAULT_MS


@pytest.mark.parametrize("name", ["ab-other", "h_0123456789", ".."])
def test_a_socket_folder_not_named_for_the_session_is_refused(tmp_path, door, name):
    made, _home, _binary = _door(tmp_path, door)
    other = tmp_path / "o" / name
    other.mkdir(parents=True, exist_ok=True, mode=0o700)
    with pytest.raises(door.DoorRefused):
        made.plan({"argv": ["iclone-agent-browser", *HEAD, "get", "url"], "cwd": "/", "env": {"AGENT_BROWSER_SOCKET_DIR": str(other)}})


def test_a_link_as_the_socket_folder_is_refused(tmp_path, door):
    made, _home, _binary = _door(tmp_path, door)
    (tmp_path / "t").mkdir()
    (tmp_path / "t" / "ab-h_0123456789").symlink_to(tmp_path)
    with pytest.raises(door.DoorRefused):
        made.plan({"argv": ["iclone-agent-browser", *HEAD, "get", "url"], "cwd": "/",
                   "env": {"AGENT_BROWSER_SOCKET_DIR": str(tmp_path / "t" / "ab-h_0123456789")}})


def test_the_ledger_names_the_verb_and_never_what_was_typed(tmp_path, door):
    made, _home, _binary = _door(tmp_path, door)
    plan = made.plan(_req(tmp_path, *HEAD, "fill", "@e2", "a-password"))
    assert "a-password" not in plan["start"]["command"] and "outside the Seatbelt" in plan["start"]["command"]
    assert "fill" in plan["start"]["command"]


# ---- the spawn guard


def _decide(argv, *, seals, site_file=SITE_FILE, func="_popen_agent_browser", event="subprocess.Popen"):
    from tools.environments import host_lane

    ns = {"sys": sys, "lane": host_lane, "args": (None, argv, None, None), "seals": seals, "event": event, "doors": frozenset({SITE})}
    code = (f"def {func}():\n"
            "    return lane.decide_spawn(event, args, sys._getframe(0), fixed=frozenset(), hermes=frozenset(), foreign=(),\n"
            "                             seals=seals, doors=doors, confined=True)\n")
    exec(compile(code, site_file, "exec"), ns)
    return ns[func]()


def _sealed(tail=("--session", "h_0123456789", "--json", "get", "url")):
    from tools.environments import host_lane

    argv = [sys.executable, "-I", "-S", os.path.realpath(str(host_lane.STUB_FILE)), "/tmp/l.sock", "--", host_lane.BROWSER_DOOR_COMMAND, *tail]
    return argv, {host_lane.argv_digest(argv)}


def test_the_guard_lets_the_sealed_door_argv_start_once_and_names_r1():
    argv, seals = _sealed()
    allowed, why = _decide(argv, seals=seals)
    assert allowed and "R1" in why and seals == set()
    allowed, _ = _decide(argv, seals=seals)
    assert not allowed


def test_the_guard_refuses_the_door_argv_unsealed():
    argv, _seals = _sealed()
    allowed, why = _decide(argv, seals=set())
    assert not allowed and "R1" in why


def test_the_guard_refuses_the_door_argv_from_any_other_site():
    argv, seals = _sealed()
    allowed, _ = _decide(argv, seals=seals, site_file=str(ROOT / "tools" / "env_probe.py"), func="_run")
    assert not allowed and seals


@pytest.mark.parametrize("change", [
    lambda a: ["/bin/sh", "-c", "agent-browser"],
    lambda a: ["/opt/homebrew/bin/agent-browser", "--json", "get", "url"],
    lambda a: ["/usr/bin/env", *a],
    lambda a: [a[0], "-S", *a[2:]],
    lambda a: [a[0], "-I", "-S", "/tmp/stub.py", *a[4:]],
    lambda a: [*a[:5], "x", *a[6:]],
    lambda a: [*a[:6], "iclone-other", *a[7:]],
    lambda a: [*a[:6], "/bin/sh", *a[7:]],
])
def test_the_guard_refuses_every_shape_next_to_the_door_even_sealed_at_this_site(change):
    from tools.environments import host_lane

    argv, _ = _sealed()
    other = change(argv)
    allowed, _why = _decide(other, seals={host_lane.argv_digest(other)})
    assert not allowed, other


def test_the_guard_refuses_any_other_primitive_at_the_site():
    argv, seals = _sealed()
    allowed, _ = _decide(argv, seals=seals, event="os.posix_spawn")
    assert not allowed and seals


def test_the_site_is_the_door_row_and_no_longer_a_fixed_row():
    allow = json.loads((PLUGIN / "spawn_sites.json").read_text())
    assert allow["door"] == [SITE] and SITE not in allow["fixed"] and SITE not in allow["hermes"]
    rows = json.loads((PLUGIN / "tests" / "fixtures" / "host_exec_sites.json").read_text())["sites"]
    row = rows[f"{SITE}::subprocess.Popen#1"]
    assert row["verdict"] == "r" and "ruling R1" in row["why"] and "ruling 56" in row["why"]


def test_the_door_argv_carries_no_program_and_a_minimal_environment(monkeypatch):
    from tools.environments import host_lane
    import hermes_cli.iclone_policy_env as policy

    monkeypatch.setattr(policy, "exec_env", lambda name: "/tmp/l.sock" if name == "ICLONE_CONFINEMENT_LAUNCHER" else "1")
    argv, env = host_lane.browser_door_argv(
        ["/any/agent-browser", "--session", "h_0123456789", "--json", "get", "url"],
        {"AGENT_BROWSER_SOCKET_DIR": "/t/ab-h_0123456789", "AGENT_BROWSER_IDLE_TIMEOUT_MS": "5", "OPENAI_API_KEY": "secret",
         "AGENT_BROWSER_EXECUTABLE_PATH": "/bin/sh"})
    assert argv[5:7] == ["--", host_lane.BROWSER_DOOR_COMMAND] and "/any/agent-browser" not in argv
    assert env == {"ICLONE_RUN_CWD": "/", "AGENT_BROWSER_SOCKET_DIR": "/t/ab-h_0123456789", "AGENT_BROWSER_IDLE_TIMEOUT_MS": "5"}
    assert host_lane.argv_digest(argv) in host_lane._SEALS
    host_lane._SEALS.discard(host_lane.argv_digest(argv))


def test_with_the_seatbelt_off_the_site_starts_the_program_as_before(tmp_path, monkeypatch):
    from tools import browser_tool_session as session
    from tools.environments import host_lane

    monkeypatch.setattr(host_lane, "confined_process", lambda: False)
    seen = {}

    def fake_popen(argv, **kw):
        seen.update(argv=argv, env=kw.get("env"))
        return SimpleNamespace()

    monkeypatch.setattr(session.subprocess, "Popen", fake_popen)
    session._popen_agent_browser(["/x/agent-browser", "--json", "get", "url"], {"A": "1"}, str(tmp_path), "t")
    assert seen == {"argv": ["/x/agent-browser", "--json", "get", "url"], "env": {"A": "1"}}


def test_confined_the_site_starts_only_the_door(tmp_path, monkeypatch):
    from tools import browser_tool_session as session
    from tools.environments import host_lane

    monkeypatch.setattr(host_lane, "confined_process", lambda: True)
    monkeypatch.setattr(host_lane, "browser_door_argv", lambda argv, env: (["door", *argv[1:]], {"E": "1"}))
    seen = {}
    monkeypatch.setattr(session.subprocess, "Popen", lambda argv, **kw: seen.update(argv=argv, env=kw.get("env")) or SimpleNamespace())
    session._popen_agent_browser(["/x/agent-browser", "--json", "get", "url"], {"A": "1"}, str(tmp_path), "t")
    assert seen == {"argv": ["door", "--json", "get", "url"], "env": {"E": "1"}}


def test_security_says_it_in_one_sentence():
    text = (ROOT / "SECURITY.md").read_text()
    assert "The built-in browser runs outside the Seatbelt, and a page can lead the agent." in text
    # G21 W1, W4: which modes ask, and what the profile does with a network grant.
    assert "With Web browsing on, it asks in Manual and Accept edits, runs with no ask in Automatic, and in Plan opens and reads pages with no ask." in text
    assert "A confined command with network can still reach other devices on your local network over IPv4." in text
    assert "your local network, which confined commands cannot" not in text
    assert "built-in browser runs inside" not in text


# ---- through the launcher, with a stand-in program


launcher_mod = None


@pytest.fixture
def live(tmp_path, door):
    global launcher_mod
    launcher_mod = launcher_mod or _load("iclone_launcher_for_browser_door", PLUGIN / "launcher.py")
    run = Path(f"/tmp/g12d{os.getpid()}")
    run.mkdir(mode=0o700, exist_ok=True)
    body = '#!/bin/sh\necho "args: $*"; echo "exe: $AGENT_BROWSER_EXECUTABLE_PATH"; echo "key: $OPENAI_API_KEY"; exit 7\n'
    home, lock, _binary = _store(tmp_path, door, body=body)
    launcher = launcher_mod.Launcher(SimpleNamespace(scratch_root=str(tmp_path / "scratch"), members_dir=str(tmp_path / "members")),
                                     str(run / "l.sock"), str(tmp_path / "journal"))
    launcher.browser_door = door.Door(str(home), str(tmp_path), lock_path=str(lock), sit=False)
    launcher.bind()
    threading.Thread(target=launcher.serve_forever, daemon=True).start()
    yield run / "l.sock", launcher
    launcher.stop()
    shutil.rmtree(run, ignore_errors=True)


def _stub(sock, tmp_path, *args):
    sockets = SHORT / "ab-h_0123456789"
    sockets.mkdir(parents=True, exist_ok=True, mode=0o700)
    return subprocess.run([sys.executable, "-I", "-S", str(PLUGIN / "stub.py"), str(sock), "--", "iclone-agent-browser", *args],
                          capture_output=True, text=True, timeout=20, stdin=subprocess.DEVNULL,
                          env={"ICLONE_RUN_CWD": "/", "AGENT_BROWSER_SOCKET_DIR": str(sockets), "OPENAI_API_KEY": "secret"})


@darwin
def test_the_launcher_runs_the_pinned_program_and_gives_its_rc_back(live, tmp_path):
    sock, _launcher = live
    proc = _stub(sock, tmp_path, *HEAD, "get", "url")
    assert proc.returncode == 7 and "args: --session h_0123456789 --json get url" in proc.stdout
    assert "exe: " in proc.stdout and "/tools/.iclone-browser-door-chrome" in proc.stdout and "secret" not in proc.stdout


@darwin
def test_the_launcher_refuses_a_shape_next_to_it_and_nothing_runs(live, tmp_path):
    sock, _launcher = live
    proc = _stub(sock, tmp_path, *HEAD, "install")
    assert proc.returncode == 126 and "args:" not in proc.stdout and "Refused by icloneOS confinement" in proc.stderr


# ---- nothing left running


def _listening_daemon(where: Path, mark: Path) -> subprocess.Popen:
    """A stand-in daemon: listens on the session's socket and logs the signal it was stopped by."""
    code = ("import os,signal,socket,sys,time\n"
            "signal.signal(signal.SIGTERM,lambda *a:(open(sys.argv[2],'w').write('term'),os._exit(0)))\n"
            "s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1]);s.listen(1)\n"
            "while True: time.sleep(.1)\n")
    return subprocess.Popen([sys.executable, "-I", "-S", "-c", code, str(where), str(mark)], start_new_session=True)


@darwin
def test_the_sitter_stops_a_daemon_when_its_owner_goes_and_a_daemon_that_ignores_close_too(door):
    run = Path(f"/tmp/g12s{os.getpid()}")
    run.mkdir(mode=0o700, exist_ok=True)
    try:
        sock, mark, closes = run / "h_0123456789.sock", run / "mark", run / "closes"
        daemon = _listening_daemon(sock, mark)
        for _ in range(100):
            if sock.exists():
                break
            time.sleep(0.05)
        exe = run / "ab"
        exe.write_text(f'#!/bin/sh\necho "$*" >> {closes}\n')
        exe.chmod(0o755)
        sitter = door.start_sitter(sys.executable)
        door.sit_on(sitter, str(exe), str(run), "h_0123456789")
        sitter.stdin.close()  # the owner went, however it went
        sitter.wait(timeout=20)
        assert daemon.wait(timeout=5) == 0 and mark.read_text() == "term"
        assert closes.read_text().strip() == "--session h_0123456789 --json close"
    finally:
        shutil.rmtree(run, ignore_errors=True)


@darwin
def test_the_sitter_ends_with_nothing_to_stop(door):
    sitter = door.start_sitter(sys.executable)
    sitter.stdin.close()
    assert sitter.wait(timeout=10) == 0


def test_stop_all_closes_the_one_sitter(tmp_path, door):
    made, _home, _binary = _door(tmp_path, door)
    closed = []
    made.sitter = SimpleNamespace(stdin=SimpleNamespace(close=lambda: closed.append(True)), wait=lambda timeout=None: 0)
    made.stop_all()
    assert closed == [True] and made.sitter is None


def test_the_launcher_stops_the_browser_door_when_it_stops():
    module = (PLUGIN / "launcher.py").read_text()
    assert "self.browser_door.stop_all()" in module and "browser_door.is_request(req)" in module


def test_the_inventory_names_the_door():
    assert "'plugins/iclone-confinement/browser_door.py': 'plugin'" in (ROOT / "apps" / "desktop" / "scripts" / "runtime-artifact.mjs").read_text()


def test_no_socket_of_a_session_is_trusted_past_the_kernel(door):
    """The pid to stop comes from the socket's peer (kernel), never from a file the runtime can write."""
    source = (PLUGIN / "browser_door.py").read_text()
    assert "LOCAL_PEERPID" in source and ".pid" not in source
    assert socket.AF_UNIX  # the import is used by the stand-in above


# G14: the debugger on a port the profiles deny by number, as nothing else can tell a port=0 debugger from a dev server.


def test_a_busy_debugger_port_is_passed_over_and_all_busy_is_a_refusal(door):
    held = []
    try:
        first = socket.socket()
        first.bind(("127.0.0.1", 0))
        first.listen(1)
        held.append(first)
        second = socket.socket()
        second.bind(("127.0.0.1", 0))
        free = second.getsockname()[1]
        second.close()
        assert door.free_debug_port((first.getsockname()[1], free)) == free
        with pytest.raises(door.DoorRefused, match="no free port"):
            door.free_debug_port((first.getsockname()[1],))
    finally:
        for sock in held:
            sock.close()


# p5-lens-text: the pick was probe-then-release with no lock, so two sessions or two doors could leave with the same port. A pick
# is now serialised by flock and leaves a reservation (pid, port, window) every later pick passes over while that pid lives.
# The probe itself is the autouse fixture's (always "free"), so only the lock and the reservations keep the picks apart.


def test_two_concurrent_pickers_never_leave_with_the_same_port(tmp_path, door):
    state = str(tmp_path / "ports")
    gate = threading.Barrier(8)
    picked, errors = [], []

    def pick():
        gate.wait()
        try:
            picked.append(door.reserve_debug_port(state, os.getpid()))
        except Exception as exc:  # noqa: BLE001 - the assertion below names it
            errors.append(exc)

    threads = [threading.Thread(target=pick) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)
    assert not errors and len(picked) == 8 and len(set(picked)) == 8 and set(picked) <= set(door.DEBUG_PORTS)


@darwin
def test_two_processes_picking_at_once_never_share_a_port(tmp_path, door):
    state = tmp_path / "ports"
    script = tmp_path / "pick.py"
    script.write_text(
        "import importlib.util, sys, time\n"
        f"spec = importlib.util.spec_from_file_location('d', {str(PLUGIN / 'browser_door.py')!r})\n"
        "d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)\n"
        "d.free_debug_port = lambda ports=d.DEBUG_PORTS: ports[0]\n"
        "while time.time() < float(sys.argv[2]): pass\n"
        "import os; print(d.reserve_debug_port(sys.argv[1], os.getppid(), hold=60))\n")
    start = time.time() + 1.5
    kids = [subprocess.Popen([sys.executable, "-I", "-S", str(script), str(state), str(start)], stdout=subprocess.PIPE, text=True)
            for _ in range(4)]
    ports = [int(kid.communicate(timeout=30)[0]) for kid in kids]
    assert len(set(ports)) == 4 and set(ports) <= set(door.DEBUG_PORTS)


def test_a_reservation_of_a_dead_pid_or_a_closed_window_is_ignored(tmp_path, door):
    state = tmp_path / "ports"
    state.mkdir(mode=0o700)
    first = door.DEBUG_PORTS[0]
    dead = subprocess.Popen(["/usr/bin/true"])
    dead.wait()
    (state / f"{first}.json").write_text(json.dumps({"pid": dead.pid, "port": first, "until": time.time() + 600}))
    assert door.reserve_debug_port(str(state), os.getpid()) == first  # dead pid: its port is free again
    (state / f"{first}.json").write_text(json.dumps({"pid": os.getpid(), "port": first, "until": time.time() - 1}))
    assert door.reserve_debug_port(str(state), os.getpid()) == first  # live pid, window closed: bound by now or abandoned
    assert door.reserve_debug_port(str(state), os.getpid()) == door.DEBUG_PORTS[1]  # live and open: passed over
    (state / f"{first}.json").write_text("not json")
    assert door.reserve_debug_port(str(state), os.getpid(), ports=(first,)) == first


def test_every_port_reserved_is_a_refusal_and_a_linked_port_folder_does_not_run(tmp_path, door):
    state = tmp_path / "ports"
    for _ in door.DEBUG_PORTS:
        door.reserve_debug_port(str(state), os.getpid())
    with pytest.raises(door.DoorRefused, match="no free port"):
        door.reserve_debug_port(str(state), os.getpid())
    os.symlink(str(state), str(tmp_path / "linked"))
    with pytest.raises(door.DoorRefused, match="port folder"):
        door.reserve_debug_port(str(tmp_path / "linked"), os.getpid())


def test_the_chrome_argv_holds_one_debugger_port_and_it_is_the_pinned_one(door):
    argv = door.chrome_argv("/c/Chrome", ["--a", "--remote-debugging-port=0", "--user-data-dir=/u", "--remote-debugging-port=1"], 39517)
    assert argv == ["/c/Chrome", "--a", "--user-data-dir=/u", "--remote-debugging-port=39517"]


def test_the_shim_is_the_doors_own_text_and_a_planted_one_does_not_run(tmp_path, door):
    root = tmp_path / "tools"
    root.mkdir()
    path = door.chrome_shim(str(root))
    assert Path(path).read_text() == door.CHROME_SHIM_TEXT and os.stat(path).st_mode & 0o777 == 0o700
    Path(path).write_text("#!/bin/sh\nexec /bin/planted\n")
    assert Path(door.chrome_shim(str(root))).read_text() == door.CHROME_SHIM_TEXT
    os.unlink(path)
    os.symlink("/bin/sh", path)
    with pytest.raises(door.DoorRefused):
        door.chrome_shim(str(root))


FAKE_CHROME = """
import http.server, json, sys
port = next(int(a.split("=")[1]) for a in sys.argv if a.startswith("--remote-debugging-port="))
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"webSocketDebuggerUrl": f"ws://127.0.0.1:{port}/devtools/browser/abc"}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
"""


def _fake_chrome(where):
    (where / "fake.py").write_text(FAKE_CHROME)
    chrome = where / "chrome"
    chrome.write_text(f'#!/bin/sh\nexec "{sys.executable}" -I -S "{where / "fake.py"}" "$@"\n')
    chrome.chmod(0o755)
    return chrome


def _free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@darwin
def test_the_shim_runs_chrome_on_a_pinned_port_and_answers_for_it(door):
    where = Path(tempfile.mkdtemp(prefix="g14", dir=str(SHORT)))
    profile = where / "profile"
    profile.mkdir()
    env = {"ICLONE_DOOR_CHROME": str(_fake_chrome(where)), "ICLONE_DOOR_PORTS": str(where / "ports"), "PATH": "/usr/bin:/bin"}
    child = subprocess.Popen([sys.executable, "-I", "-S", str(PLUGIN / "browser_door.py"), "--chrome",
                              "--remote-debugging-port=0", f"--user-data-dir={profile}"], env=env)
    try:
        answer = profile / "DevToolsActivePort"
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and not answer.exists():
            time.sleep(0.1)
        port, where_ws, _ = answer.read_text().split("\n")
        assert int(port) in door.DEBUG_PORTS and where_ws == "/devtools/browser/abc"
        held = json.loads((where / "ports" / f"{int(port)}.json").read_text())
        assert held["pid"] == child.pid and held["port"] == int(port)  # reserved for the pid that became the browser
        # the pid agent-browser holds is the browser: exec, not a parent left waiting
        assert child.poll() is None
    finally:
        child.kill()
        child.wait()


def _shim_exit(where: Path, ports) -> subprocess.CompletedProcess:
    profile = where / "profile"
    profile.mkdir(exist_ok=True)
    env = {"ICLONE_DOOR_CHROME": str(_fake_chrome(where)), "PATH": "/usr/bin:/bin"}
    if ports is not None:
        env["ICLONE_DOOR_PORTS"] = str(ports)
    return subprocess.run([sys.executable, "-I", "-S", str(PLUGIN / "browser_door.py"), "--chrome",
                           "--remote-debugging-port=0", f"--user-data-dir={profile}"], env=env, capture_output=True,
                          text=True, timeout=30)


@darwin
def test_p5b_a_daemon_started_before_the_update_is_told_to_restart_the_browser(door):
    where = Path(tempfile.mkdtemp(prefix="g14", dir=str(SHORT)))
    done = _shim_exit(where, None)
    assert done.returncode != 0 and done.stderr.strip() == door.STALE_DAEMON
    assert "Traceback" not in done.stderr


@darwin
def test_p5b_a_port_folder_that_cannot_be_made_is_the_clear_refusal_not_a_traceback(door):
    where = Path(tempfile.mkdtemp(prefix="g14", dir=str(SHORT)))
    (where / "plain").write_text("x")
    done = _shim_exit(where, where / "plain" / "ports")  # makedirs under a file: an OSError
    assert done.returncode != 0 and done.stderr.startswith(door.PORT_FOLDER_UNUSABLE)
    assert "Traceback" not in done.stderr


@darwin
def test_an_answer_is_only_for_this_browser_never_for_whoever_holds_the_port(door):
    where = Path(tempfile.mkdtemp(prefix="g14", dir=str(SHORT)))
    profile = where / "profile"
    profile.mkdir()
    port = _free_port()
    other = subprocess.Popen([str(_fake_chrome(where)), f"--remote-debugging-port={port}"])
    try:
        for _ in range(100):
            with socket.socket() as sock:
                if sock.connect_ex(("127.0.0.1", port)) == 0:
                    break
            time.sleep(0.05)
        sleeper = subprocess.Popen(["/bin/sleep", "20"])
        try:
            door.write_active_port(sleeper.pid, port, str(profile), wait=1.5)
        finally:
            sleeper.kill()
            sleeper.wait()
        assert not (profile / "DevToolsActivePort").exists()
    finally:
        other.kill()
        other.wait()


# G14: the daemon's own stream listener (screencast and input, no token) is the same hole; its port comes from the same set.


def test_the_stream_port_is_pinned_to_a_denied_port_until_the_daemon_runs(tmp_path, door):
    home, lock, _binary = _store(tmp_path, door)
    folder = SHORT / "ab-h_0123456789"
    folder.mkdir(mode=0o700, exist_ok=True)
    the_door = door.Door(str(home), str(tmp_path), lock_path=str(lock), sit=False)
    req = {"argv": [door.COMMAND, *HEAD, "get", "url"], "env": {"AGENT_BROWSER_SOCKET_DIR": str(folder)}}
    assert int(the_door.plan(req)["env"]["AGENT_BROWSER_STREAM_PORT"]) in door.DEBUG_PORTS
    with socket.socket(socket.AF_UNIX) as daemon:
        path = folder / "h_0123456789.sock"
        daemon.bind(str(path))
        daemon.listen(1)
        try:
            # a running daemon keeps its port: with every port taken, a knock on it is still answered
            assert "AGENT_BROWSER_STREAM_PORT" not in the_door.plan(req)["env"]
        finally:
            path.unlink()


@darwin
def test_a_daemon_listening_outside_the_denied_ports_is_named(door):
    where = Path(tempfile.mkdtemp(prefix="g14", dir=str(SHORT)))
    port = _free_port()
    other = subprocess.Popen([str(_fake_chrome(where)), f"--remote-debugging-port={port}"])
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not door.listens_outside(other.pid):
            time.sleep(0.05)
        assert door.listens_outside(other.pid) == [port]
        assert door.listens_outside(other.pid, (port,)) == []
    finally:
        other.kill()
        other.wait()


# ---- G15: ffmpeg for `record stop`. The daemon spawns it by name from the PATH its first knock gave it.


def _with_ffmpeg(tmp_path, door, *, body="#!/bin/sh\necho frames\n", root=None, artifact="a" * 64, fact_artifact=None, pin=True):
    """A store as PM publishes ffmpeg: an entry, its fact with the tree digest, the lock's artifact pin."""
    from pm.store import tree_digest

    home, lock, binary = _store(tmp_path, door)
    root = root or home / "tools"
    target = door.current_target()
    entry = root / f"ffmpeg-9.0-{target}"
    (entry / "bin").mkdir(parents=True)
    tool = entry / "bin" / "ffmpeg"
    tool.write_text(body)
    tool.chmod(0o755)
    (root / "facts.json").write_text(json.dumps({"schema": 1, "packages": {"ffmpeg": {
        "artifacts": [fact_artifact or artifact], "digest": tree_digest(entry), "entry": entry.name, "target": target, "version": "9.0.1"}}}))
    packages = json.loads(lock.read_text())
    packages["packages"]["ffmpeg"] = {"version": "9.0.1", "artifacts": {target: {"sha256": artifact, "url": "https://x.invalid/ffmpeg.zip"}}}
    lock.write_text(json.dumps(packages))
    return door.Door(str(home), str(tmp_path / "user"), lock_path=str(lock), sit=False), home, tool


def _no_system_ffmpeg(monkeypatch, door, *paths):
    monkeypatch.setattr(door, "SYSTEM_FFMPEG", tuple(str(p) for p in paths))


def _webm(home):
    return "browser-20261106-120000-abc123.webm"  # G20: a bare name; the door joins it to Movies/icloneOS Recordings


def _resolved(env):
    out = subprocess.run(["/bin/sh", "-c", "command -v ffmpeg && ffmpeg"], env={"PATH": env["PATH"]}, capture_output=True, text=True)
    return out.stdout.split()


def test_every_knock_names_the_one_ffmpeg_folder_and_the_browser_needs_no_ffmpeg(tmp_path, door, monkeypatch):
    _no_system_ffmpeg(monkeypatch, door)
    made, home, _binary = _door(tmp_path, door)
    env = made.plan(_req(tmp_path, *HEAD, "get", "url"))["env"]
    assert env["PATH"] == os.path.join(os.path.realpath(home / "tools"), door.FFMPEG_FOLDER) + os.pathsep + door.ENV_PATH


def test_record_gives_the_daemon_the_ffmpeg_pm_published_and_nothing_else_by_name(tmp_path, door, monkeypatch):
    _no_system_ffmpeg(monkeypatch, door)
    made, home, tool = _with_ffmpeg(tmp_path, door)
    env = made.plan(_req(tmp_path, *HEAD, "record", "start", _webm(home)))["env"]
    folder = env["PATH"].split(os.pathsep)[0]
    assert os.listdir(folder) == ["ffmpeg"] and os.path.realpath(os.path.join(folder, "ffmpeg")) == os.path.realpath(tool)
    assert _resolved(env) == [os.path.join(folder, "ffmpeg"), "frames"]
    made.plan(_req(tmp_path, *HEAD, "record", "stop"))
    assert os.listdir(folder) == ["ffmpeg"]


def test_the_ffmpeg_folder_holds_ffmpeg_alone(tmp_path, door, monkeypatch):
    _no_system_ffmpeg(monkeypatch, door)
    made, home, _tool = _with_ffmpeg(tmp_path, door)
    folder = Path(os.path.realpath(home / "tools")) / door.FFMPEG_FOLDER
    folder.mkdir()
    (folder / "node").write_text("#!/bin/sh\n")
    made.plan(_req(tmp_path, *HEAD, "record", "start", _webm(home)))
    assert os.listdir(folder) == ["ffmpeg"]


def test_a_changed_pm_ffmpeg_does_not_run_and_no_other_takes_its_place(tmp_path, door, monkeypatch):
    system = tmp_path / "system-ffmpeg"
    system.write_text("#!/bin/sh\n")
    system.chmod(0o755)
    _no_system_ffmpeg(monkeypatch, door, system)
    made, home, tool = _with_ffmpeg(tmp_path, door)
    good = made.plan(_req(tmp_path, *HEAD, "record", "start", _webm(home)))["env"]
    tool.write_text("#!/bin/sh\necho changed\n")
    with pytest.raises(door.DoorRefused, match="does not match"):
        made.plan(_req(tmp_path, *HEAD, "record", "stop"))
    assert os.listdir(good["PATH"].split(os.pathsep)[0]) == []


def test_a_fact_for_another_artifact_or_target_or_a_linked_binary_does_not_run(tmp_path, door, monkeypatch):
    _no_system_ffmpeg(monkeypatch, door)
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    made, home, _tool = _with_ffmpeg(tmp_path / "a", door)
    facts = home / "tools" / "facts.json"
    data = json.loads(facts.read_text())
    data["packages"]["ffmpeg"]["artifacts"] = ["b" * 64]
    facts.write_text(json.dumps(data))
    with pytest.raises(door.DoorRefused, match="does not match"):
        made.plan(_req(tmp_path, *HEAD, "record", "start", _webm(home)))
    data["packages"]["ffmpeg"]["artifacts"] = ["a" * 64]
    data["packages"]["ffmpeg"]["entry"] = "../outside"
    facts.write_text(json.dumps(data))
    with pytest.raises(door.DoorRefused, match="does not match"):
        made.plan(_req(tmp_path, *HEAD, "record", "start", _webm(home)))
    made, home, tool = _with_ffmpeg(tmp_path / "b", door)
    tool.unlink()
    tool.symlink_to("/bin/sh")
    with pytest.raises(door.DoorRefused, match="does not match"):
        made.plan(_req(tmp_path, *HEAD, "record", "start", _webm(home)))


def test_no_ffmpeg_is_one_plain_sentence_for_record_and_nothing_for_the_rest(tmp_path, door, monkeypatch):
    _no_system_ffmpeg(monkeypatch, door, tmp_path / "absent")
    made, home, _binary = _door(tmp_path, door)
    for verb in (("record", "start", _webm(home)), ("record", "stop")):
        with pytest.raises(door.DoorRefused) as refused:
            made.plan(_req(tmp_path, *HEAD, *verb))
        assert "Settings > Setup > Packages" in str(refused.value) and "ffmpeg" in str(refused.value)
        assert "failed to execute" not in str(refused.value)
    assert made.plan(_req(tmp_path, *HEAD, "open", "https://example.com/"))["argv"][-1] == "https://example.com/"


def test_the_users_own_ffmpeg_at_the_fixed_places_when_pm_has_none(tmp_path, door, monkeypatch):
    cellar = tmp_path / "Cellar" / "ffmpeg"
    cellar.parent.mkdir()
    cellar.write_text("#!/bin/sh\necho frames\n")
    cellar.chmod(0o755)
    bin_link = tmp_path / "ffmpeg-link"
    bin_link.symlink_to(cellar)
    _no_system_ffmpeg(monkeypatch, door, tmp_path / "absent", bin_link)
    made, home, _binary = _door(tmp_path, door)
    env = made.plan(_req(tmp_path, *HEAD, "record", "start", _webm(home)))["env"]
    assert _resolved(env)[1:] == ["frames"]
    assert os.path.realpath(os.path.join(env["PATH"].split(os.pathsep)[0], "ffmpeg")) == os.path.realpath(cellar)
    cellar.chmod(0o777)
    with pytest.raises(door.DoorRefused, match="Settings > Setup > Packages"):
        made.plan(_req(tmp_path, *HEAD, "record", "stop"))


def test_a_system_ffmpeg_inside_the_agents_own_home_is_not_one(tmp_path, door, monkeypatch):
    made, home, _binary = _door(tmp_path, door)
    planted = home / "ffmpeg"
    planted.write_text("#!/bin/sh\n")
    planted.chmod(0o755)
    _no_system_ffmpeg(monkeypatch, door, planted)
    with pytest.raises(door.DoorRefused, match="Settings > Setup > Packages"):
        made.plan(_req(tmp_path, *HEAD, "record", "stop"))


def test_a_linked_ffmpeg_folder_is_refused(tmp_path, door, monkeypatch):
    _no_system_ffmpeg(monkeypatch, door)
    made, home, _tool = _with_ffmpeg(tmp_path, door)
    (Path(os.path.realpath(home / "tools")) / door.FFMPEG_FOLDER).symlink_to(tmp_path)
    with pytest.raises(door.DoorRefused, match="not the plain"):
        made.plan(_req(tmp_path, *HEAD, "record", "stop"))


def test_the_sealed_payloads_store_is_read_before_the_writable_one(tmp_path, door, monkeypatch):
    _no_system_ffmpeg(monkeypatch, door)
    payload = tmp_path / "payload"
    (payload / "tools").mkdir(parents=True)
    made, home, tool = _with_ffmpeg(tmp_path, door, root=payload / "tools")
    (payload / "app" / "pm").mkdir(parents=True)
    (payload / "manifest.json").write_text(json.dumps({"store": "tools"}))
    lock = payload / "app" / "pm" / "lock.json"
    lock.write_text(Path(made.lock_path).read_text())
    made = door.Door(str(home), str(tmp_path / "user"), lock_path=str(lock), sit=False)
    env = made.plan(_req(tmp_path, *HEAD, "record", "start", _webm(home)))["env"]
    assert os.path.realpath(os.path.join(env["PATH"].split(os.pathsep)[0], "ffmpeg")) == os.path.realpath(tool)


def test_the_doors_digest_is_pms(tmp_path, door):
    from pm.store import tree_digest

    (tmp_path / "t" / "bin").mkdir(parents=True)
    (tmp_path / "t" / "__pycache__").mkdir()
    (tmp_path / "t" / "__pycache__" / "x.pyc").write_text("skip")
    (tmp_path / "t" / "bin" / "b").write_text("bytes")
    (tmp_path / "t" / "a.txt").write_text("more")
    (tmp_path / "t" / "link").symlink_to("bin/b")
    (tmp_path / "t" / "dirlink").symlink_to("bin")
    assert door.tree_digest(str(tmp_path / "t")) == tree_digest(tmp_path / "t")


# ---- the runtime's side of the same sentence


def _start_recording(monkeypatch, tmp_path, *, confined, which, result=None):
    import tools.browser_tool as tool

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(tool, "_confined_runtime", lambda: confined)
    monkeypatch.setattr(tool.shutil, "which", lambda *a, **k: which)
    monkeypatch.setattr(tool, "read_raw_config", lambda: {"browser": {"record_sessions": True}}, raising=False)
    monkeypatch.setattr(tool, "cfg_get", lambda *a, **k: True, raising=False)
    monkeypatch.setattr(tool._session, "_run_browser_command", lambda *a, **k: result or {"success": True})
    tool._recording_sessions.discard("t")
    return tool, tool._maybe_start_recording("t")


def test_seatbelt_off_and_no_ffmpeg_the_recording_says_so_at_the_start(monkeypatch, tmp_path):
    tool, note = _start_recording(monkeypatch, tmp_path, confined=False, which=None)
    assert note == tool.RECORD_NEEDS_FFMPEG and "t" not in tool._recording_sessions


def test_seatbelt_on_the_doors_sentence_comes_back_and_any_other_error_stays_in_the_log(monkeypatch, tmp_path, door):
    tool, note = _start_recording(monkeypatch, tmp_path, confined=True, which=None, result={"success": False, "error": door.NO_FFMPEG})
    assert note == door.NO_FFMPEG == tool.RECORD_NEEDS_FFMPEG
    _tool, quiet = _start_recording(monkeypatch, tmp_path, confined=True, which=None, result={"success": False, "error": "Target closed"})
    assert quiet is None
