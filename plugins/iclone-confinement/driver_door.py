"""S10: the one way computer use reaches CuaDriver, and the proof a driver is the real one. Stdlib only: the launcher
loads this file by path, and the runtime loads the same file for its Seatbelt-off path.

With the Seatbelt on the runtime may exec only its interpreter, so it asks the launcher (outside the Seatbelt, started
by main) through stub.py with the command ``iclone-cua-driver <verb>``. The launcher picks the driver itself: no path,
environment or working folder in the request is used, so HERMES_CUA_DRIVER_CMD stays out and the seal stays. Each verb
has one exact shape; everything else is refused. No confined command takes this path: the agent's profile refuses every
unix socket but DNS (sbpl.ts), so only the runtime can knock.

What decides is ``codesign --verify --strict`` against a requirement naming the identifier, Apple's anchor and the
team. ``codesign -dv`` only prints what a signature claims, and a home-made one can claim anything.
"""

from __future__ import annotations

import glob
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid

COMMAND = "iclone-cua-driver"
BUNDLE_ID = "com.trycua.driver"
TEAMS = ("4YEC26S9KF", "YCK386LBJ7")
CODESIGN = "/usr/bin/codesign"
OPEN = "/usr/bin/open"
TRUE = "/usr/bin/true"
APP_NAME = "CuaDriver.app"
APPLICATIONS_APP = "/Applications/" + APP_NAME
REQUIREMENT = (f'=identifier "{BUNDLE_ID}" and anchor apple generic and ('
               + " or ".join(f'certificate leaf[subject.OU] = "{team}"' for team in TEAMS) + ")")
ABSENT = ("CuaDriver is not installed. In icloneOS open Settings > Setup > Computer use, press Install CuaDriver, "
          "allow Accessibility and Screen recording for it, then ask again.")
BAD_SIGNATURE = "Found {path}, but it is not the CuaDriver signed by Cua ({why}), so it will not run. "
PERMISSION = ("macOS has not allowed CuaDriver (com.trycua.driver) to do this. Open System Settings > Privacy & Security, "
              "turn CuaDriver on under Accessibility and under Screen Recording, then ask again.")
SOCKET_NAME = re.compile(r"^hc-[0-9a-f]{8,32}$")
TOOL_NAME = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
MODES = ("standard", "unrestricted")
SOCKET_PATH_MAX = 103
STOP_WAIT_S = 2.0


class DoorRefused(Exception):
    """A plain sentence for the runtime, and through it the model and the user."""


def app_of(path: str) -> str:
    """The CuaDriver.app a path really lands in, or ``""``: a link in ~/.local/bin counts for what it points at."""
    real = os.path.realpath(path)
    if real.endswith(".app") and os.path.isdir(real):
        return real
    head, marker, _ = real.partition(".app/Contents/MacOS/")
    return head + ".app" if marker else ""


def executable_of(app: str) -> str:
    return os.path.join(app, "Contents", "MacOS", "cua-driver")


def signature_problem(app: str, *, run=subprocess.run) -> str:
    """``""`` only for a bundle whose whole signature verifies against the requirement; otherwise why not."""
    try:
        proc = run([CODESIGN, "--verify", "--strict", "-R", REQUIREMENT, app], stdin=subprocess.DEVNULL,
                   capture_output=True, text=True, errors="replace", timeout=30, env={"PATH": "/usr/bin:/bin"})
    except (OSError, subprocess.SubprocessError) as exc:
        return f"the signature could not be checked: {exc}"
    if proc.returncode == 0:
        return ""
    return (proc.stderr or "").strip().splitlines()[-1][:200] if (proc.stderr or "").strip() else "the signature did not verify"


def candidates(home: str, hermes_home: str) -> list:
    """Where a real user's driver is, in the order the package manager's own wins."""
    found = []
    if hermes_home:
        found += sorted(glob.glob(os.path.join(glob.escape(hermes_home), "tools", "*", APP_NAME)), reverse=True)
    found.append(APPLICATIONS_APP)
    if home:
        found.append(os.path.join(home, ".local", "bin", "cua-driver"))
    return found


def locate(home: str, hermes_home: str, *, check=signature_problem) -> tuple:
    """``(app, "")`` for the first candidate whose signature verifies, else ``("", what to do)``. Never runs a candidate:
    the check reads the file, the driver has not started yet."""
    refused = []
    for path in candidates(home, hermes_home):
        if not os.path.lexists(path):
            continue
        app = app_of(path)
        why = check(app) if app else "it is not inside a CuaDriver.app"
        if not why and os.path.isfile(executable_of(app)):
            return app, ""
        refused.append(BAD_SIGNATURE.format(path=path, why=why or "no driver inside"))
    return "", "".join(refused) + ABSENT


def is_request(req) -> bool:
    argv = req.get("argv") if isinstance(req, dict) else None
    return isinstance(argv, list) and bool(argv) and argv[0] == COMMAND


def _shape(args: list) -> tuple:
    """``(args for the driver, socket name or "", serving)``: only the exact shapes computer use sends."""
    if not all(isinstance(a, str) for a in args) or not args:
        raise DoorRefused("that driver request has no verb")
    # The card's verbs (G2 A2): read the driver's state and raise macOS's own dialog. Each exact, no argument of its own.
    if args in (["where"], ["--help"], ["manifest"], ["--version"], ["doctor", "--json"], ["permissions", "status", "--json"],
                ["permissions", "grant"]):
        return args, "", False
    verb, rest = args[0], args[1:]
    flags = []
    for flag in ("--no-overlay", "--dangerously-bypass-approvals", "--embedded", "--no-permissions-gate"):
        if flag in rest:
            rest = [a for a in rest if a != flag]
            flags.append(flag)
    if verb == "call" and len(rest) == 4 and TOOL_NAME.match(rest[0]) and rest[2] == "--socket" and not flags:
        return args, rest[3], False
    mode = None
    if verb == "serve" and len(rest) == 4 and rest[2] == "--permission-mode":
        mode, rest = rest[3], rest[:2]
    if len(rest) != 2 or rest[0] != "--socket":
        raise DoorRefused(f"the driver verb {verb[:32]!r} is not one computer use sends")
    allowed = {"status": (set(), set()), "stop": (set(), set()),
               "mcp": ({"--embedded"}, {"--no-overlay"}),
               "serve": ({"--embedded", "--no-permissions-gate"}, {"--no-overlay"})}.get(verb)
    if allowed is None:
        raise DoorRefused(f"the driver verb {verb[:32]!r} is not one computer use sends")
    if verb == "serve":
        if mode not in MODES:
            raise DoorRefused("with the Seatbelt on the driver serves in the standard or the unrestricted mode only")
        if mode == "unrestricted":
            allowed = (allowed[0] | {"--dangerously-bypass-approvals"}, allowed[1])
    needed, optional = allowed
    if not needed <= set(flags) or not set(flags) <= needed | optional:
        raise DoorRefused(f"the driver verb {verb[:32]!r} came with flags computer use does not send")
    return args, rest[1], verb == "serve"


def parse_homes(environ) -> tuple:
    return environ.get("ICLONE_LAUNCHER_HOME", ""), environ.get("ICLONE_LAUNCHER_HERMES_HOME", "")


class Door:
    def __init__(self, directory: str, home: str, hermes_home: str, *, locator=locate):
        self.directory, self.home, self.hermes_home, self.locator = directory, home, hermes_home, locator
        self.sitters: dict = {}
        self.lock = threading.Lock()

    def socket_path(self, name: str) -> str:
        if not SOCKET_NAME.match(name):
            raise DoorRefused("the driver's socket is named by the launcher, never by a path")
        path = os.path.join(self.directory, name + ".sock")
        if len(path.encode("utf-8")) > SOCKET_PATH_MAX:
            raise DoorRefused("the driver's socket path is too long for this Mac")
        return path

    def plan(self, req: dict) -> dict:
        args, name, serving = _shape(list(req["argv"][1:]))
        app, why = self.locator(self.home, self.hermes_home)
        if not app:
            raise DoorRefused(why)
        exe = executable_of(app)
        real_args = [self.socket_path(a) if a == name and name else a for a in args]
        if args == ["where"]:
            argv, program = [TRUE], TRUE
        elif serving:
            # LaunchServices, so macOS sees com.trycua.driver and not this launcher. It forwards no environment.
            argv = [OPEN, "-n", "-g", "-a", app, "--env", "CUA_DRIVER_RS_TELEMETRY_ENABLED=0", "--args", *real_args]
            program = OPEN
            self._sit(exe, real_args[real_args.index("--socket") + 1])
        else:
            argv, program = [exe, *real_args], exe
        command = "[computer use, the signed driver outside the Seatbelt] " + " ".join(args)[:900]
        run = "driver-" + uuid.uuid4().hex
        return {
            "argv": argv, "executable": program, "cwd": "/",
            "env": {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": self.home or "/", "LANG": "C",
                    "CUA_DRIVER_RS_TELEMETRY_ENABLED": "0"},
            "start": {"run": run, "kind": "shell", "cls": None, "sha": "", "session": None, "command": command, "cwd": "/",
                      "project": None, "net": True, "write": True, "origin": "agent", "unconfined": True},
            "facts": None, "stderr": [],
        }

    def _sit(self, exe: str, path: str) -> None:
        with self.lock:
            if path not in self.sitters:
                self.sitters[path] = start_sitter(exe, path, sys.executable)

    def stop_all(self) -> None:
        """The launcher is going: every daemon it started goes too. A sitter also fires if the launcher dies unasked."""
        with self.lock:
            sitters, self.sitters = list(self.sitters.values()), {}
        for sitter in sitters:
            stop_sitter(sitter)


def start_sitter(exe: str, path: str, python: str) -> subprocess.Popen:
    """A small watcher holding a pipe from its owner: when the owner ends, however it ends, the pipe closes and the
    private daemon is stopped. ``open`` makes the daemon launchd's child, so nothing else would ever stop it."""
    return subprocess.Popen([python, "-I", "-S", os.path.abspath(__file__), "--sit", exe, path], stdin=subprocess.PIPE,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True,
                            env={"PATH": "/usr/bin:/bin"})


def stop_sitter(sitter: subprocess.Popen, wait: float = STOP_WAIT_S + 8.0) -> None:
    try:
        sitter.stdin.close()
    except OSError:
        pass
    try:
        sitter.wait(timeout=wait)
    except subprocess.TimeoutExpired:
        pass


def _peer_pid(path: str):
    """The pid listening on the daemon's socket, as the kernel says (LOCAL_PEERPID), or None when nothing is there."""
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(1.0)
        sock.connect(path)
        return sock.getsockopt(0, 2) if sys.platform == "darwin" else None
    except OSError:
        return None
    finally:
        sock.close()


def sit(exe: str, path: str, *, stdin=None, stop_wait: float = STOP_WAIT_S) -> None:
    """Block until the owner is gone, then ask the daemon to stop, and end it by its own pid if it will not."""
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, signal.SIG_IGN)
    (stdin or sys.stdin.buffer).read()
    pid = _peer_pid(path)
    try:
        subprocess.run([exe, "stop", "--socket", path], stdin=subprocess.DEVNULL, capture_output=True, timeout=3,
                       env={"PATH": "/usr/bin:/bin", "CUA_DRIVER_RS_TELEMETRY_ENABLED": "0"})
    except (OSError, subprocess.SubprocessError):
        pass
    deadline = time.monotonic() + stop_wait
    while time.monotonic() < deadline and _peer_pid(path) is not None:
        time.sleep(0.1)
    if pid and _peer_pid(path) == pid:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    try:
        os.unlink(path)
    except OSError:
        pass


if __name__ == "__main__" and len(sys.argv) == 4 and sys.argv[1] == "--sit":
    sit(sys.argv[2], sys.argv[3])
