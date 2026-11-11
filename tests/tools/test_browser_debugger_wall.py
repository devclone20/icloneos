"""G19: the runtime read any local file through the door's own verbs: open the debugger's origin, eval fetch('/json/new?file://...').

The wall: DEBUG_PORTS are ports Chromium's network stack refuses (ERR_UNSAFE_PORT) for every page load, fetch and websocket,
whatever the origin, while agent-browser, not Chromium, connects as usual. Real agent-browser and Chromium as the door starts
them, a disposable home. ``raw`` skips the door's refusal of those ports, its second layer, so what these tests hold is the wall.
"""

from __future__ import annotations

import http.server
import importlib.util
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(os.environ.get("ICLONE_BROWSER_FIXTURE", "/private/tmp/g8-pm-tools"))
SESSION = "h_g19"
SECRET = "G19-PLANTED-" + os.urandom(6).hex()

# G20: a security wall's test does not pass by skipping in the gate. The gate sets ICLONE_BROWSER_WALL_REQUIRED=1, and then no fixture is a failure.
REQUIRED = os.environ.get("ICLONE_BROWSER_WALL_REQUIRED") == "1"
pytestmark = pytest.mark.skipif(sys.platform != "darwin" or not (REQUIRED or FIXTURE.is_dir()), reason="needs PM's agent-browser and chromium-1208 at ICLONE_BROWSER_FIXTURE")


def test_the_gate_runs_this_wall_with_its_fixture():
    assert FIXTURE.is_dir(), f"no browser fixture at {FIXTURE}: the wall was not tested"
    runner = (ROOT / "scripts" / "run_tests.sh").read_text(encoding="utf-8")
    assert 'ICLONE_BROWSER_FIXTURE="$ICLONE_BROWSER_FIXTURE"' in runner and 'ICLONE_BROWSER_WALL_REQUIRED="$ICLONE_BROWSER_WALL_REQUIRED"' in runner


def _load():
    spec = importlib.util.spec_from_file_location("browser_door_g19", ROOT / "plugins" / "iclone-confinement" / "browser_door.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


D = _load()


class Pages(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path.startswith("/to/"):
            self.send_response(302)
            self.send_header("Location", self.path[len("/to/"):])
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        body = b"<!doctype html><title>home</title><button onclick=\"document.title='clicked'\">G19 home</button>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class Spy:
    """A listener that counts who reached it: the proof a page's request never left Chromium."""

    def __init__(self, port: int = 0):
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", port))
        self.sock.listen(16)
        self.port = self.sock.getsockname()[1]
        self.sock.settimeout(0.1)
        self.hits = 0
        self.done = False
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while not self.done:
            try:
                conn, _ = self.sock.accept()
            except TimeoutError:
                continue
            except OSError:
                return
            self.hits += 1
            conn.close()

    def close(self):
        self.done = True
        self.sock.close()


class World:
    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix="g19", dir=os.environ.get("TMPDIR") or "/private/tmp")).resolve()
        self.home = self.root / "h"
        self.hh = self.home / ".hermes"
        self.hh.mkdir(parents=True)
        subprocess.run(["/bin/cp", "-Rc", str(FIXTURE), str(self.hh / "tools")], check=True)
        (self.home / ".ssh").mkdir(mode=0o700)
        self.planted = self.home / ".ssh" / "planted"
        self.planted.write_text(SECRET + "\n")
        self.door = D.Door(str(self.hh), str(self.home), lock_path=str(ROOT / "pm" / "lock.json"), sit=False)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Pages)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.web = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.session(SESSION)
        assert self.go("open", self.web + "/")[0] == 0
        self.port = self.debug_ports()[0]
        self.stream = int((self.folder(SESSION) / f"{SESSION}.stream").read_text().strip())

    def folder(self, session):
        return self.root / f"ab-{session}"

    def session(self, session):
        self.folder(session).mkdir(mode=0o700, exist_ok=True)

    def _plan(self, session, *verb):
        return self.door.plan({"argv": [D.COMMAND, "--session", session, "--json", *verb], "env": {"AGENT_BROWSER_SOCKET_DIR": str(self.folder(session))}})

    @staticmethod
    def _run(plan, argv):
        out = subprocess.run(argv, env=plan["env"], cwd=plan["cwd"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=90)
        return out.returncode, out.stdout.decode(errors="replace").strip()

    def go(self, *verb, session=SESSION):
        """Through the door, its shape check and its refusals included."""
        plan = self._plan(session, *verb)
        return self._run(plan, plan["argv"])

    def raw(self, *verb, session=SESSION):
        """The door's environment and program, past its refusal of the debug ports: only the wall is left."""
        plan = self._plan(session, "get", "url")
        return self._run(plan, [plan["argv"][0], "--session", session, "--json", *verb])

    def debug_ports(self):
        lines = subprocess.run(["/bin/ps", "-axo", "command="], capture_output=True, text=True).stdout.splitlines()
        return [int(word.split("=")[1]) for line in lines if str(self.hh) in line and "--type=" not in line
                for word in line.split() if word.startswith("--remote-debugging-port=")]

    def targets(self):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json/list", timeout=5) as answer:
            return json.load(answer)

    def home_page(self):
        assert self.raw("open", self.web + "/")[0] == 0

    def chain_reads_the_file(self):
        """The critic's second half, from wherever the page is now; True when the file came back by any way."""
        said = [self.raw("eval", f"fetch('/json/new?file://{self.planted}',{{method:'PUT'}}).then(r=>r.text()).catch(e=>'refused '+e)")[1]]
        time.sleep(0.5)
        said += [self.raw("get", "url")[1], self.raw("snapshot")[1]]
        file_target = [t for t in self.targets() if t.get("url", "").startswith("file:")]
        return SECRET in " ".join(said) or bool(file_target)

    def on_debug_origin(self):
        url = self.raw("get", "url")[1]
        return f":{self.port}" in url or f":{self.stream}" in url

    def close(self):
        self.server.shutdown()
        for session in (SESSION, "h_g19b"):
            if self.folder(session).exists():
                try:
                    self.go("close", session=session)
                except (D.DoorRefused, subprocess.TimeoutExpired):
                    pass
        time.sleep(0.5)
        lines = subprocess.run(["/bin/ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout.splitlines()
        for line in lines:  # this run's own, by its unique folder
            if str(self.hh) in line:
                try:
                    os.kill(int(line.split()[0]), signal.SIGKILL)
                except OSError:
                    pass
        shutil.rmtree(self.root, ignore_errors=True)


@pytest.fixture(scope="module")
def world():
    built = World()
    yield built
    built.close()


@pytest.fixture
def w(world):
    world.home_page()
    return world


def test_the_critics_exact_chain_does_not_read_the_file(w):
    """rehearsal-A M1, by its own steps, with no help from this test. Through the door it stops at the refusal, past the door at the wall."""
    url = f"http://127.0.0.1:{w.port}/json/version"
    rc, text = w.raw("open", url)
    assert not w.chain_reads_the_file()
    assert rc != 0 and "ERR_UNSAFE_PORT" in text, text
    assert not w.on_debug_origin()
    with pytest.raises(D.DoorRefused, match="debugger"):
        w.go("open", url)


def test_the_ports_are_the_pinned_ones_and_a_real_client_still_reaches_them(w):
    assert w.port in D.DEBUG_PORTS and w.stream in D.DEBUG_PORTS
    with urllib.request.urlopen(f"http://127.0.0.1:{w.port}/json/version", timeout=5) as answer:
        assert "webSocketDebuggerUrl" in json.load(answer)  # so every refusal below is the page's, not a dead port


@pytest.mark.parametrize("form", ["127.0.0.1", "localhost", "[::1]", "0.0.0.0", "2130706433", "0x7f.1", "[::ffff:127.0.0.1]"])
@pytest.mark.parametrize("which", ["port", "stream"])
def test_a_direct_open_of_the_port_never_lands(w, form, which):
    url = f"http://{form}:{getattr(w, which)}/json/version"
    with pytest.raises(D.DoorRefused, match="debugger"):
        w.go("open", url)
    rc, text = w.raw("open", url)
    assert rc != 0 and "ERR_UNSAFE_PORT" in text, text
    assert not w.on_debug_origin()
    assert not w.chain_reads_the_file()


def test_a_real_redirect_does_not_land(w):
    rc, text = w.go("open", f"{w.web}/to/http://127.0.0.1:{w.port}/json/version")  # a plain local page to the door: nothing to refuse
    assert not w.on_debug_origin(), text
    assert not w.chain_reads_the_file()


def test_location_href_from_a_page_does_not_land(w):
    w.go("eval", f"location.href='http://127.0.0.1:{w.port}/json/version';'sent'")
    time.sleep(1)
    assert not w.on_debug_origin()
    assert not w.chain_reads_the_file()


def test_the_devtools_front_end_does_not_land(w):
    url = f"http://127.0.0.1:{w.port}/devtools/inspector.html"
    rc, text = w.raw("open", url)
    assert rc != 0 and "ERR_UNSAFE_PORT" in text, text
    assert not w.on_debug_origin()


NO_CORS = "fetch(%s,{mode:'no-cors'}).then(()=>'REACHED').catch(()=>'REFUSED')"
SOCKET = "new Promise(r=>{const s=new WebSocket(%s);s.onopen=()=>r('REACHED');s.onerror=()=>r('REFUSED');setTimeout(()=>r('REFUSED'),3000)})"


@pytest.mark.parametrize("which", ["port", "stream"])
def test_fetch_from_a_page_is_refused_by_chromium(w, which):
    url = f"http://127.0.0.1:{getattr(w, which)}/json/version"
    assert "REFUSED" in w.go("eval", NO_CORS % json.dumps(url))[1]


def test_every_debug_port_is_refused_to_a_page_and_the_control_is_not(w):
    """Spies on every port in the set no browser holds: a request that left Chromium counts. A Chromium update that drops a port goes red here."""
    held = {p for p in D.DEBUG_PORTS if p in (w.port, w.stream)}
    spies = [Spy(p) for p in D.DEBUG_PORTS if p not in held]
    control = Spy()
    try:
        for spy in spies:
            assert "REFUSED" in w.go("eval", NO_CORS % json.dumps(f"http://127.0.0.1:{spy.port}/"))[1], spy.port
            w.go("eval", SOCKET % json.dumps(f"ws://127.0.0.1:{spy.port}/"))
            rc, text = w.raw("open", f"http://127.0.0.1:{spy.port}/")
            assert rc != 0 and "ERR_UNSAFE_PORT" in text, (spy.port, text)
            w.home_page()
        assert [s.port for s in spies if s.hits] == []
        w.go("eval", SOCKET % json.dumps(f"ws://127.0.0.1:{control.port}/"))
        w.go("eval", NO_CORS % json.dumps(f"http://127.0.0.1:{control.port}/"))
        assert control.hits >= 1  # the page can reach an ordinary port by the same calls
    finally:
        for spy in [*spies, control]:
            spy.close()


def test_websocket_to_the_debugger_from_a_page_never_opens(w):
    with urllib.request.urlopen(f"http://127.0.0.1:{w.port}/json/version", timeout=5) as answer:
        ws = json.load(answer)["webSocketDebuggerUrl"]
    assert "REFUSED" in w.go("eval", SOCKET % json.dumps(ws))[1]


def test_the_argv_never_carries_a_ports_exception(w):
    argv = D.chrome_argv("/c/Chrome", ["--a", "--explicitly-allowed-ports=6665", "--explicitly-allowed-ports"], D.DEBUG_PORTS[0])
    assert argv == ["/c/Chrome", "--a", f"--remote-debugging-port={D.DEBUG_PORTS[0]}"]
    lines = subprocess.run(["/bin/ps", "-axo", "command="], capture_output=True, text=True).stdout.splitlines()
    assert not [line for line in lines if str(w.hh) in line and "explicitly-allowed-ports" in line]


def test_the_verbs_still_work_on_these_ports(w):
    assert "G19 home" in w.go("snapshot", "-c")[1]
    assert w.go("click", "@e1")[0] == 0, "click"
    assert "clicked" in w.go("eval", "document.title")[1]
    shot = w.hh / "g19.png"
    assert w.go("screenshot", "--full", str(shot))[0] == 0 and shot.stat().st_size > 0
    name = "browser-20261106-120000-abc123.webm"
    movie = w.home / "Movies" / "icloneOS Recordings" / name
    assert w.go("record", "start", name)[0] == 0
    time.sleep(1)
    assert w.go("record", "stop")[0] == 0 and movie.stat().st_size > 0


def test_a_busy_port_is_passed_over_and_a_second_session_gets_its_own(world):
    busy = [p for p in D.DEBUG_PORTS if p not in (world.port, world.stream)][0]
    spy = Spy(busy)
    try:
        world.session("h_g19b")
        assert world.go("open", world.web + "/", session="h_g19b")[0] == 0
        ports = world.debug_ports()
        assert len(ports) == 2 and len(set(ports)) == 2 and busy not in ports and set(ports) <= set(D.DEBUG_PORTS)
        assert world.go("close", session="h_g19b")[0] == 0
    finally:
        spy.close()
