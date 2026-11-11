"""Ruling R1 (narrows ruling 56 for one site): with the Seatbelt on, agent-browser runs outside it through this door.

Stdlib only: the launcher loads this file by path. The runtime asks through stub.py with the command
``iclone-agent-browser --session <name> [--engine chrome] --json <verb> <args>``, only after the permission gate. Each verb
has one exact shape and everything else is refused; the launcher picks the program itself, the agent-browser the lock pins
for this Mac, at its path in PM's store, and hashes it on every knock. Of the request's environment only the session's
socket folder and a plain idle number are read, each checked; the rest of the environment is built here, so neither
Chromium's path nor its flags can come from the caller. No shell anywhere.

The daemon and its Chromium outlive each command. One sitter holds a pipe from the launcher: when the launcher ends, however
it ends, the pipe closes and every session this door started is closed and then ended by the pid the kernel gives for the
session's socket, never one read from a file the runtime can write.

Chromium's debugger reads any file it is told to, from outside the Seatbelt, and a page on its origin can tell it to, so it listens
only on DEBUG_PORTS: ports from the restricted list in Chromium's own network stack, which refuses them (ERR_UNSAFE_PORT) to every
page load, redirect, fetch and websocket from any origin and any spelling of the host. agent-browser is not Chromium and connects as
usual. So a page, ``eval`` included, cannot reach the debugger; a list of URLs could not hold that, as any page can navigate. This
holds only without --explicitly-allowed-ports, which chrome_argv drops. Every confined profile refuses the same ports by number
(sbpl.ts, DEBUGGER_PORTS; on any address, measured: ::ffff:0.0.0.0 passes a localhost deny). tests/tools/test_browser_debugger_wall.py
holds both for the Chromium the lock pins, port by port, so an update that drops one goes red.
agent-browser asks for port 0 and waits for Chromium's DevToolsActivePort, which Chromium writes only for port 0, so the door
gives agent-browser a shim for Chromium's path: the shim picks a free port, leaves a short-lived child to write that answer once
this browser itself holds the port, and execs Chromium, so the pid agent-browser holds is the browser's.

The daemon's stream listener (screencast and input, no token) is the same hole, so its port comes from the same set. On a busy
port the daemon falls back to any port without a word, so the shim asks the kernel what its parent listens on and no browser
starts for a daemon listening outside the set.

``record stop`` makes the daemon spawn ffmpeg by name, from the PATH the daemon's first knock gave it, so every knock names one
folder in PM's store and a record verb puts ffmpeg alone in it: PM's, its entry's digest rechecked against PM's fact for the lock's
artifact (the lock pins ffmpeg's archive, not the file inside), or else the user's own at the two fixed places, as the browser finds
it with the Seatbelt off. Those have no pin to check; the file must be a plain one the Seatbelt's write rules do not reach.
"""

from __future__ import annotations

import fcntl
import hashlib
import http.client
import json
import os
import platform
import re
import signal
import socket
import stat
import subprocess
import sys
import threading
import time
import uuid
from urllib.parse import urlsplit

COMMAND = "iclone-agent-browser"
HERE = os.path.dirname(os.path.abspath(__file__))
LOCK = os.path.join(HERE, "..", "..", "pm", "lock.json")
CHROME_APP = "Google Chrome for Testing.app"
CHROME_BIN = "Google Chrome for Testing"
IDLE_DEFAULT_MS = "300000"
ENV_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
ABSENT = "The browser is not installed. In icloneOS open Settings > Setup > Packages, install agent-browser, then ask again."
SESSION = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,47}$")
REF = re.compile(r"^@?e[0-9]{1,6}$")
PIXELS = re.compile(r"^[0-9]{1,6}$")
IDLE = re.compile(r"^[0-9]{1,10}$")
SOCKET_PATH_MAX = 103
STOP_WAIT_S = 2.0
LOCAL_PEERPID = 2
# Ports chromium-1208 refuses, measured one by one (4190 and 6679, on the web's list, it does NOT refuse), a user can bind, without NFS 2049,
# Apple's 3659 and X11 6000, which this Mac may itself serve. Two a session;
# below macOS's ephemeral range, so the system never hands one out; sbpl.ts names the same.
DEBUG_PORTS = (1719, 1720, 1723, 4045, 5060, 5061, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080)
DEBUG_PORT_URL = "That address is the browser's own debugger or stream port, and the agent may not open it as a page."
CHROME_SHIM = ".iclone-browser-door-chrome"  # in PM's store: the confined never write there (HERMES_HOME_NEVER_WRITTEN)
CHROME_SHIM_TEXT = '#!/bin/sh\nexec "$ICLONE_DOOR_PYTHON" -I -S "$ICLONE_DOOR_FILE" --chrome "$@"\n'
ANSWER_WAIT_S = 30.0
PORT_STATE = ".iclone-browser-door-ports"  # in PM's store, beside the shim: one lock and one reservation a port, for every door and shim
PORT_LOCK_WAIT_S = 10.0
FFMPEG_FOLDER = ".iclone-browser-door-bin"  # in PM's store, beside the shim; the name on PATH whether or not ffmpeg is in it yet
SYSTEM_FFMPEG = ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg")
FFMPEG_ENTRY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")
NO_FFMPEG = "Recording the browser needs ffmpeg, and this Mac has none. In icloneOS open Settings > Setup > Packages, install ffmpeg, then ask again. Browsing still works."
RECORD_FOLDER = ("Movies", "icloneOS Recordings")  # screen_door.FOLDER: one place for both videos; a test holds them equal
RECORD_NAME = re.compile(r"browser-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}\.webm\Z")
NOTHING = "/usr/bin/true"  # what a discard runs, once the door has done it: the launcher's answer is a process's
FFMPEG_CHANGED = "ffmpeg does not match what the package manager installed, so the browser will not record. Reinstall it in Settings > Setup > Packages. Browsing still works."


class DoorRefused(Exception):
    """A plain sentence for the runtime, and through it the model and the user."""


def is_request(req) -> bool:
    argv = req.get("argv") if isinstance(req, dict) else None
    return isinstance(argv, list) and bool(argv) and argv[0] == COMMAND


def current_target() -> str:
    return "darwin-arm64" if platform.machine() == "arm64" else "darwin-x64"


def chrome_folder(target: str) -> str:
    return "chrome-mac-arm64" if target == "darwin-arm64" else "chrome-mac-x64"


def _web_url(url: str) -> bool:
    if url == "about:blank":
        return True
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return False
    try:
        port = parts.port
    except ValueError:
        return False
    if port in DEBUG_PORTS:  # for the message: the wall is Chromium's refusal of these ports, see the top of this file
        raise DoorRefused(DEBUG_PORT_URL)
    return True


def _inside(path: str, root: str) -> bool:
    return path.startswith(root + os.sep)


def _output(path: str, suffix: str, hermes_home: str) -> bool:
    """A screenshot goes in the agent's own home, as its own kind, and never through a link."""
    if not os.path.isabs(path) or not path.endswith(suffix) or os.path.islink(path):
        return False
    return bool(hermes_home) and _inside(os.path.realpath(path), os.path.realpath(hermes_home))


def _plain_record_folder(home: str) -> str:
    """The recordings folder, made if it is not there, refused if it is anything but a plain folder of this user."""
    folder = os.path.join(home, *RECORD_FOLDER)
    try:
        os.makedirs(os.path.dirname(folder), exist_ok=True)
        try:
            os.mkdir(folder, 0o700)
        except FileExistsError:
            pass
        seen = os.lstat(folder)
    except OSError as exc:
        raise DoorRefused(f"the recording's folder could not be used: {exc.strerror or 'it could not be made'}") from None
    if not stat.S_ISDIR(seen.st_mode) or seen.st_uid != os.getuid():
        raise DoorRefused("the recording's folder could not be used: it is not a plain folder of yours")
    return folder


def record_path(home: str, name: str) -> str:
    """Where a browser video goes, on both Seatbelt paths: the folder is this code's, the same as Screen recording's, a caller
    gives a name of the one shape the tools make, and nothing already there is written over."""
    if not RECORD_NAME.match(name):
        raise DoorRefused("that is not a name the browser tools give a video")
    if not home:
        raise DoorRefused("the launcher does not know the home folder, so a recording has nowhere to go")
    path = os.path.join(_plain_record_folder(home), name)
    if os.path.lexists(path):
        raise DoorRefused("a browser video of that name is already there")
    return path


def seal_record_target(home: str, name: str) -> None:
    """Just before the writer opens the file. agent-browser's ffmpeg runs outside the Seatbelt with -y and follows a link (measured on
    ffmpeg itself: the link's target was written over). A confined command cannot write this folder and neither it nor Movies can be
    a project root (profiles.ts), so this defends against a link left by the user or by an approved command running outside the
    Seatbelt, and is defense in depth against a confined one. A link or a hard link at the video's name, or a link at the folder's,
    is taken out of the way and its target is never touched. Only the link goes; a plain file stays as it is. A swap in the moment
    between this and the writer's open is not closed here, and no confined command can make one."""
    folder = os.path.join(home, *RECORD_FOLDER)
    try:
        if stat.S_ISLNK(os.lstat(folder).st_mode):
            os.unlink(folder)
    except FileNotFoundError:
        pass
    except OSError as exc:
        raise DoorRefused(f"the recording's folder could not be used: {exc.strerror or 'it could not be checked'}") from None
    path = os.path.join(_plain_record_folder(home), name)
    try:
        seen = os.lstat(path)
    except OSError:
        return  # nothing at the name: the writer makes it
    if stat.S_ISREG(seen.st_mode) and seen.st_nlink == 1 and seen.st_uid == os.getuid():
        return
    if stat.S_ISDIR(seen.st_mode):
        raise DoorRefused("a folder is sitting at the browser video's name, so it was not saved")
    fresh = path + ".new-" + uuid.uuid4().hex
    try:
        os.close(os.open(fresh, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600))
        os.replace(fresh, path)
    except OSError as exc:
        raise DoorRefused(f"the browser video's file could not be made safe: {exc.strerror or 'it could not be replaced'}") from None


def discard_empty_record(home: str, name: str) -> bool:
    """A failed save's empty file, on both Seatbelt paths, and nothing else: a regular file of this user with the tools' name, 0 bytes,
    one link, in the plain folder, never through a link. A file with anything in it is the user's to judge, and stays."""
    if not home or not RECORD_NAME.match(name):
        return False
    folder = os.path.join(home, *RECORD_FOLDER)
    path = os.path.join(folder, name)
    try:
        if not stat.S_ISDIR(os.lstat(folder).st_mode):
            return False
        seen = os.lstat(path)
        if not stat.S_ISREG(seen.st_mode) or seen.st_size != 0 or seen.st_nlink != 1 or seen.st_uid != os.getuid():
            return False
        os.unlink(path)
    except OSError:
        return False
    return True


def _verb_ok(verb: str, rest: list, hermes_home: str) -> bool:
    """Only what the browser tools send. ``get cdp-url`` stays out: it would hand a page-independent debugger to the caller."""
    count = len(rest)
    if verb == "open":
        return count == 1 and _web_url(rest[0])
    if verb == "snapshot":
        return rest in ([], ["-c"])
    if verb == "click":
        return count == 1 and bool(REF.match(rest[0]))
    if verb == "fill":
        return count == 2 and bool(REF.match(rest[0]))
    if verb == "press":
        return count == 1 and bool(rest[0]) and not rest[0].startswith("-")
    if verb == "scroll":
        return count == 2 and rest[0] in ("up", "down") and bool(PIXELS.match(rest[1]))
    if verb in ("back", "close"):
        return not rest
    if verb == "eval":
        return count == 1 and not rest[0].startswith("-")
    if verb in ("console", "errors"):
        return rest in ([], ["--clear"])
    if verb == "get":
        return rest == ["url"]
    if verb == "record":
        return rest == ["stop"] or (count == 2 and rest[0] in ("start", "discard") and RECORD_NAME.match(rest[1]) is not None)
    if verb == "screenshot":
        flags, path = rest[:-1], rest[-1] if rest else ""
        return flags in (["--full"], ["--annotate", "--full"]) and _output(path, ".png", hermes_home)
    return False


def shape(args: list, hermes_home: str) -> tuple:
    """``(session, verb)`` for an exact request; everything next to one is refused."""
    if not args or not all(isinstance(a, str) and "\x00" not in a for a in args):
        raise DoorRefused("that browser request has no verb")
    head = 2
    if args[:1] != ["--session"] or len(args) < 2 or not SESSION.match(args[1]):
        raise DoorRefused("a browser request names its session first")
    if args[head:head + 2] == ["--engine", "chrome"]:
        head += 2
    if args[head:head + 1] != ["--json"] or len(args) <= head + 1:
        raise DoorRefused("with the Seatbelt on the browser takes no other flag: not an attached or a visible browser")
    verb, rest = args[head + 1], args[head + 2:]
    if not _verb_ok(verb, rest, hermes_home):
        raise DoorRefused(f"the browser request {verb[:32]!r} is not one the browser tools send with the Seatbelt on")
    return args[1], verb


def pinned_program(store: str, lock_path: str) -> tuple:
    """``(agent-browser, Chromium)`` at PM's paths for this Mac. agent-browser's digest must be the lock's; the file is read
    here on every knock. A link anywhere under the store, or a file that does not match, does not run."""
    try:
        with open(lock_path, encoding="utf-8") as handle:
            packages = json.load(handle)["packages"]
        entry, chromium = packages["agent-browser"], packages["chromium"]
        version, revision = entry["version"], str(chromium["version"]).split("+")[0]
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise DoorRefused(f"the package lock could not be read, so the browser will not run ({type(exc).__name__})") from None
    target = current_target()
    pin = (entry.get("binaries") or {}).get(target) if isinstance(entry, dict) else None
    if not isinstance(pin, str) or len(pin) != 64:
        raise DoorRefused(f"the package lock pins no agent-browser for {target}, so the browser will not run")
    root = os.path.realpath(store)
    binary = os.path.join(root, f"agent-browser-{version}-{target}", "bin", f"agent-browser-{target}")
    chrome = os.path.join(root, f"chromium-{revision}", chrome_folder(target), CHROME_APP, "Contents", "MacOS", CHROME_BIN)
    for path in (binary, chrome):
        if not os.path.lexists(path):
            raise DoorRefused(ABSENT)
        info = os.lstat(path)
        if os.path.realpath(path) != path or not stat.S_ISREG(info.st_mode) or not info.st_mode & 0o100:
            raise DoorRefused("the browser's program is not the plain file the package manager installs, so it will not run")
    digest = hashlib.sha256()
    with open(binary, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    if digest.hexdigest() != pin:
        raise DoorRefused("agent-browser does not match the package lock, so it will not run. Reinstall it in Settings > Setup > Packages.")
    return binary, chrome


def chrome_shim(root: str) -> str:
    """The door's own text at a path the confined cannot write, rewritten when it is anything else; a link is refused."""
    path = os.path.join(root, CHROME_SHIM)
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        info = None
    if info is not None and not stat.S_ISREG(info.st_mode):
        raise DoorRefused("the browser's starter is not the plain file the door writes, so the browser will not run")
    if info is not None and stat.S_IMODE(info.st_mode) == 0o700:
        with open(path, encoding="utf-8", errors="replace") as handle:
            if handle.read() == CHROME_SHIM_TEXT:
                return path
    spare = f"{path}.{uuid.uuid4().hex}"
    descriptor = os.open(spare, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o700)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(CHROME_SHIM_TEXT)
    os.replace(spare, path)
    return path


def tree_digest(root: str) -> str:
    """pm.store.tree_digest, stdlib only (the launcher loads this file by path); a test holds them equal."""
    files = []
    for folder, dirs, names in os.walk(root):
        descend = []
        for name in sorted(dirs):
            path = os.path.join(folder, name)
            if os.path.islink(path):
                files.append((os.path.relpath(path, root), path))
            elif name != "__pycache__":
                descend.append(name)
        dirs[:] = descend
        files.extend((os.path.relpath(os.path.join(folder, name), root), os.path.join(folder, name)) for name in names)
    digest = hashlib.sha256()
    for rel, path in sorted(files):
        digest.update(rel.encode("utf-8") + b"\0")
        if os.path.islink(path):
            digest.update(os.readlink(path).encode("utf-8"))
        else:
            with open(path, "rb") as handle:
                for chunk in iter(lambda: handle.read(1 << 20), b""):
                    digest.update(chunk)
    return digest.hexdigest()


def store_roots(hermes_home: str, lock_path: str) -> list:
    """Where PM publishes on this install: a sealed payload's store (its manifest, as pm.environments reads it), then the writable one."""
    roots = []
    above = os.path.realpath(os.path.join(os.path.dirname(lock_path), "..", ".."))
    try:
        with open(os.path.join(above, "manifest.json"), encoding="utf-8-sig") as handle:
            relative = json.load(handle)["store"]
        sealed = os.path.realpath(os.path.join(above, relative))
        if _inside(sealed, above):
            roots.append(sealed)
    except (OSError, ValueError, KeyError, TypeError):
        pass
    roots.append(os.path.realpath(os.path.join(hermes_home, "tools")))
    return roots


def pm_ffmpeg(lock_path: str, roots: list):
    """PM's ffmpeg if PM holds one, re-hashed now; ``None`` if it holds none; a fact or a tree that does not match refuses."""
    target = current_target()
    try:
        with open(lock_path, encoding="utf-8") as handle:
            pin = json.load(handle)["packages"]["ffmpeg"]
        version, artifact = pin["version"], pin["artifacts"][target]["sha256"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    for root in roots:
        try:
            with open(os.path.join(root, "facts.json"), encoding="utf-8") as handle:
                fact = json.load(handle)["packages"]["ffmpeg"]
        except (OSError, ValueError, KeyError, TypeError):
            continue
        entry = fact.get("entry") if isinstance(fact, dict) else None
        if (not isinstance(entry, str) or not FFMPEG_ENTRY.match(entry) or fact.get("target") != target or fact.get("version") != version
                or artifact not in (fact.get("artifacts") or []) or not fact.get("digest")):
            raise DoorRefused(FFMPEG_CHANGED)
        where = os.path.join(root, entry)
        for tool in (os.path.join(where, "bin", "ffmpeg"), os.path.join(where, "ffmpeg")):
            if os.path.lexists(tool):
                info = os.lstat(tool)
                if (os.path.realpath(tool) != tool or not stat.S_ISREG(info.st_mode) or not info.st_mode & 0o100
                        or tree_digest(where) != fact["digest"]):
                    raise DoorRefused(FFMPEG_CHANGED)
                return tool
        raise DoorRefused(FFMPEG_CHANGED)
    return None


def system_ffmpeg(hermes_home: str, places=None):
    """The user's own, at the fixed places: a plain file of this user or root that nobody else may write, outside the agent's home."""
    for place in SYSTEM_FFMPEG if places is None else places:
        real = os.path.realpath(place)
        try:
            info = os.stat(real)
        except OSError:
            continue
        if (stat.S_ISREG(info.st_mode) and info.st_mode & 0o100 and not info.st_mode & 0o022 and info.st_uid in (0, os.getuid())
                and not _inside(real, os.path.realpath(hermes_home))):
            return real
    return None


def give_ffmpeg(folder: str, lock_path: str, roots: list, hermes_home: str) -> None:
    """Leave the folder holding ffmpeg and nothing else, or nothing, and refuse."""
    if os.path.islink(folder) or (os.path.lexists(folder) and not os.path.isdir(folder)):
        raise DoorRefused("the browser's ffmpeg folder is not the plain folder the door makes, so the browser will not record")
    os.makedirs(folder, mode=0o700, exist_ok=True)
    tool = None
    try:
        tool = pm_ffmpeg(lock_path, roots) or system_ffmpeg(hermes_home)
    finally:
        for name in os.listdir(folder):
            if name != "ffmpeg" or tool is None:
                os.unlink(os.path.join(folder, name))
    if tool is None:
        raise DoorRefused(NO_FFMPEG)
    spare = os.path.join(folder, f".{uuid.uuid4().hex}")
    os.symlink(tool, spare)
    os.replace(spare, os.path.join(folder, "ffmpeg"))


def free_debug_port(ports=DEBUG_PORTS) -> int:
    for port in ports:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)  # as Chromium binds, so a closed browser's port is free
            try:
                probe.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise DoorRefused("the browser's debugger has no free port: too many browsers are open. Close one and ask again.")


def _reservation_holds(path: str, now: float) -> bool:
    """A reservation counts while its pid lives and its window is open; anything unreadable or of a dead pid is ignored."""
    try:
        with open(path, encoding="utf-8") as handle:
            held = json.load(handle)
        pid, until = int(held["pid"]), float(held["until"])
    except (OSError, ValueError, KeyError, TypeError):
        return False
    return pid > 0 and now < until and _alive(pid)


PORT_FOLDER_UNUSABLE = "the browser's port folder is not the plain folder the door makes, so the browser will not run"
# A browser daemon started before an update keeps the old door's environment until it idles out.
STALE_DAEMON = "the browser was started before icloneOS was updated. Close the browser (or restart icloneOS) and ask again."


def reserve_debug_port(state: str, pid: int, ports=DEBUG_PORTS, hold: float = ANSWER_WAIT_S) -> int:
    """A free port from ``ports`` no live reservation names, reserved for ``pid`` for ``hold`` seconds: until the browser or the
    daemon binds it, after which the probe passes it over anyway. Picks are serialised across processes by flock, so two
    sessions or two doors never leave with the same port."""
    if os.path.islink(state) or (os.path.lexists(state) and not os.path.isdir(state)):
        raise DoorRefused(PORT_FOLDER_UNUSABLE)
    os.makedirs(state, mode=0o700, exist_ok=True)
    descriptor = os.open(os.path.join(state, "lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        deadline = time.monotonic() + PORT_LOCK_WAIT_S
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise DoorRefused("another browser is still picking its port. Ask again.") from None
                time.sleep(0.02)
        now = time.time()
        open_ports = tuple(p for p in ports if not _reservation_holds(os.path.join(state, f"{p}.json"), now))
        if not open_ports:
            raise DoorRefused("the browser's debugger has no free port: too many browsers are open. Close one and ask again.")
        port = free_debug_port(open_ports)
        spare = os.path.join(state, f".{uuid.uuid4().hex}")
        with open(spare, "w", encoding="utf-8") as handle:
            json.dump({"pid": pid, "port": port, "until": now + hold}, handle)
        os.replace(spare, os.path.join(state, f"{port}.json"))
        return port
    finally:
        os.close(descriptor)  # drops the flock


def chrome_argv(chrome: str, args: list, port: int) -> list:
    dropped = ("--remote-debugging-port=", "--explicitly-allowed-ports")  # the second would open the wall this port stands behind
    return [chrome, *(a for a in args if not a.startswith(dropped)), f"--remote-debugging-port={port}"]


def listens_outside(pid: int, ports=DEBUG_PORTS) -> list:
    """The TCP ports ``pid`` listens on outside ``ports``, by the kernel's word. No answer counts as one: it fails closed."""
    try:
        out = subprocess.run(["/usr/sbin/lsof", "-nP", "-a", "-p", str(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
                             capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL, env={"PATH": ENV_PATH})
    except (OSError, subprocess.SubprocessError):
        return [-1]
    if out.returncode != 0 and out.stdout.strip():
        return [-1]
    found = {int(line.rsplit(":", 1)[1]) for line in out.stdout.splitlines() if line.startswith("n") and line.rsplit(":", 1)[-1].isdigit()}
    return sorted(found - set(ports))


def _holds_port(pid: int, port: int) -> bool:
    """The kernel's word that this process listens there: a port answering is not enough, another browser may hold it."""
    try:
        out = subprocess.run(["/usr/sbin/lsof", "-nP", "-a", "-p", str(pid), f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
                             capture_output=True, text=True, timeout=5, stdin=subprocess.DEVNULL, env={"PATH": ENV_PATH}).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return str(pid) in out.split()


def write_active_port(pid: int, port: int, profile: str, wait: float = ANSWER_WAIT_S) -> None:
    """Chromium's own DevToolsActivePort, for the port Chromium writes none for. Nothing at all unless ``pid`` holds it."""
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline and _alive(pid):
        if _holds_port(pid, port):
            client = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
            try:
                client.request("GET", "/json/version")
                where = urlsplit(json.loads(client.getresponse().read())["webSocketDebuggerUrl"]).path
                spare = os.path.join(profile, "DevToolsActivePort." + uuid.uuid4().hex)
                with open(spare, "w", encoding="utf-8") as handle:
                    handle.write(f"{port}\n{where}\n")
                os.replace(spare, os.path.join(profile, "DevToolsActivePort"))
                return
            except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException):
                pass
            finally:
                client.close()
        time.sleep(0.05)


def run_chrome(args: list) -> None:
    """The shim's work, in the process agent-browser started, which becomes Chromium."""
    chrome = os.environ.pop("ICLONE_DOOR_CHROME", "")
    state = os.environ.pop("ICLONE_DOOR_PORTS", "")
    os.environ.pop("ICLONE_DOOR_PYTHON", None)
    os.environ.pop("ICLONE_DOOR_FILE", None)
    profile = next((a.split("=", 1)[1] for a in args if a.startswith("--user-data-dir=")), "")
    if chrome and profile and not state:
        sys.exit(STALE_DAEMON)
    if not chrome or not profile or not os.path.isabs(state):
        sys.exit("the browser's starter was not told which browser, which profile or where ports are reserved")
    if listens_outside(os.getppid()):
        sys.exit("the browser's stream took a port the Seatbelt does not refuse, so the browser will not start. Ask again.")
    try:
        port = reserve_debug_port(state, os.getpid())  # this pid becomes Chromium at the execv below
    except DoorRefused as refused:
        sys.exit(str(refused))
    except OSError as exc:
        sys.exit(f"{PORT_FOLDER_UNUSABLE} ({exc.strerror or type(exc).__name__})")
    subprocess.Popen([sys.executable, "-I", "-S", os.path.abspath(__file__), "--answer", str(os.getpid()), str(port), profile],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True, env={"PATH": ENV_PATH})
    os.execv(chrome, chrome_argv(chrome, args, port))


def _socket_folder(value, session: str) -> str:
    """The session's own folder, named for it, ours, 0700, never a link."""
    wanted = "ab-" + session
    if not isinstance(value, str) or not os.path.isabs(value) or os.path.basename(value) != wanted:
        raise DoorRefused("the browser's socket folder is not the session's own")
    try:
        info = os.lstat(value)
    except OSError:
        raise DoorRefused("the browser's socket folder is not there") from None
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise DoorRefused("the browser's socket folder is not a private folder of this user")
    if len(os.path.join(value, session + ".sock").encode("utf-8")) > SOCKET_PATH_MAX:
        raise DoorRefused("the browser's socket path is too long for this Mac")
    return value


class Door:
    def __init__(self, hermes_home: str, home: str, *, lock_path: str = LOCK, sit: bool = True):
        self.hermes_home, self.home, self.lock_path, self.sit = hermes_home, home, lock_path, sit
        self.sitter = None
        self.watched: set = set()
        self.lock = threading.Lock()
        self.videos: dict = {}  # session -> the video capturing now, as this door named it
        self.stopped: dict = {}  # session -> the video last told to stop: the only one a discard may name

    def plan(self, req: dict) -> dict:
        args = list(req["argv"][1:])
        session, verb = shape(args, self.hermes_home)
        if verb == "record" and args[-2] == "discard":
            return self._discard(session, args[-1])
        if verb == "record" and args[-1] != "stop":
            name = args[-1]
            args[-1] = record_path(self.home, name)  # the request names the file; only this door names the folder
            with self.lock:
                self.videos[session] = name
        elif verb == "record" or verb == "close":  # either one has the daemon's ffmpeg open the file now
            self._before_the_writer(session, verb)
        env = req.get("env") if isinstance(req.get("env"), dict) else {}
        folder = _socket_folder(env.get("AGENT_BROWSER_SOCKET_DIR"), session)
        if not self.hermes_home:
            raise DoorRefused(ABSENT)
        store = os.path.join(self.hermes_home, "tools")
        binary, chrome = pinned_program(store, self.lock_path)
        shim = chrome_shim(os.path.realpath(store))
        ffmpeg_folder = os.path.join(os.path.realpath(store), FFMPEG_FOLDER)
        port_state = os.path.join(os.path.realpath(store), PORT_STATE)
        if verb == "record":
            give_ffmpeg(ffmpeg_folder, self.lock_path, store_roots(self.hermes_home, self.lock_path), self.hermes_home)
        idle = str(env.get("AGENT_BROWSER_IDLE_TIMEOUT_MS") or "")
        child_env = {"PATH": ffmpeg_folder + os.pathsep + ENV_PATH, "HOME": self.home or "/", "LANG": "C", "TMPDIR": os.path.dirname(folder) + os.sep,
                     "AGENT_BROWSER_SOCKET_DIR": folder, "AGENT_BROWSER_EXECUTABLE_PATH": shim,
                     "ICLONE_DOOR_CHROME": chrome, "ICLONE_DOOR_PYTHON": sys.executable, "ICLONE_DOOR_FILE": os.path.abspath(__file__),
                     "ICLONE_DOOR_PORTS": port_state,
                     "PLAYWRIGHT_BROWSERS_PATH": os.path.realpath(store),
                     "AGENT_BROWSER_IDLE_TIMEOUT_MS": idle if IDLE.match(idle) else IDLE_DEFAULT_MS}
        if _peer_pid(os.path.join(folder, session + ".sock")) is None:
            child_env["AGENT_BROWSER_STREAM_PORT"] = str(reserve_debug_port(port_state, os.getpid()))
        if self.sit:
            self._watch(binary, folder, session)
        run = "browser-" + uuid.uuid4().hex
        return {
            "argv": [binary, *args], "executable": binary, "cwd": "/", "env": child_env,
            # the ledger names the verb, never what was typed or which page: those stay in the session.
            "start": {"run": run, "kind": "shell", "cls": None, "sha": "", "session": None,
                      "command": f"[the browser, outside the Seatbelt] {verb}", "cwd": "/", "project": None, "net": True,
                      "write": True, "origin": "agent", "unconfined": True},
            "facts": None, "stderr": [],
        }

    def _before_the_writer(self, session: str, verb: str) -> None:
        with self.lock:
            name = self.videos.pop(session, None)
            if name and verb == "record":
                self.stopped[session] = name
        if not name:
            return
        try:
            seal_record_target(self.home, name)
        except DoorRefused:
            if verb == "record":  # a close still closes: a folder this odd is one the writer cannot go through either
                raise

    def _discard(self, session: str, name: str) -> dict:
        """Removes at most the empty file of the video this door last stopped for this session, and says nothing of what it found: no
        read of the folder goes back to the caller and no browser runs."""
        with self.lock:
            stopped = self.stopped.get(session)
        if stopped != name:
            raise DoorRefused("that is not the browser video this session last stopped")
        discard_empty_record(self.home, name)
        return {"argv": [NOTHING], "executable": NOTHING, "cwd": "/", "env": {"PATH": ENV_PATH}, "facts": None, "stderr": [],
                "start": {"run": "browser-" + uuid.uuid4().hex, "kind": "shell", "cls": None, "sha": "", "session": None,
                          "command": "[the browser, outside the Seatbelt] record", "cwd": "/", "project": None, "net": False,
                          "write": True, "origin": "agent", "unconfined": True}}

    def _watch(self, binary: str, folder: str, session: str) -> None:
        with self.lock:
            if self.sitter is None:
                self.sitter = start_sitter(sys.executable)
            if (folder, session) not in self.watched:
                self.watched.add((folder, session))
                sit_on(self.sitter, binary, folder, session)

    def stop_all(self) -> None:
        with self.lock:
            sitter, self.sitter = self.sitter, None
            self.watched = set()
        if sitter is not None:
            stop_sitter(sitter)


def start_sitter(python: str) -> subprocess.Popen:
    return subprocess.Popen([python, "-I", "-S", os.path.abspath(__file__), "--sit"], stdin=subprocess.PIPE,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True,
                            env={"PATH": ENV_PATH})


def sit_on(sitter: subprocess.Popen, binary: str, folder: str, session: str) -> None:
    sitter.stdin.write((json.dumps({"binary": binary, "folder": folder, "session": session}) + "\n").encode("utf-8"))
    sitter.stdin.flush()


def stop_sitter(sitter: subprocess.Popen, wait: float = 30.0) -> None:
    try:
        sitter.stdin.close()
    except OSError:
        pass
    try:
        sitter.wait(timeout=wait)
    except subprocess.TimeoutExpired:
        pass


def _peer_pid(path: str):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(1.0)
        sock.connect(path)
        return sock.getsockopt(0, LOCAL_PEERPID)
    except OSError:
        return None
    finally:
        sock.close()


def _descendants(pid: int) -> list:
    try:
        out = subprocess.run(["/bin/ps", "-axo", "pid=,ppid="], capture_output=True, text=True, timeout=5,
                             stdin=subprocess.DEVNULL, env={"PATH": ENV_PATH}).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    children: dict = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            children.setdefault(int(parts[1]), []).append(int(parts[0]))
    found, queue = [], [pid]
    while queue:
        for child in children.get(queue.pop(), []):
            found.append(child)
            queue.append(child)
    return found


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _signal_all(pids: list, sig: int) -> None:
    for pid in pids:
        try:
            os.kill(pid, sig)
        except OSError:
            pass


def _stop_session(binary: str, folder: str, session: str, stop_wait: float = STOP_WAIT_S) -> None:
    path = os.path.join(folder, session + ".sock")
    daemon = _peer_pid(path)
    if daemon is None or daemon == os.getpid():
        return
    family = [daemon, *_descendants(daemon)]
    try:
        subprocess.run([binary, "--session", session, "--json", "close"], stdin=subprocess.DEVNULL, capture_output=True, timeout=8,
                       env={"PATH": ENV_PATH, "AGENT_BROWSER_SOCKET_DIR": folder, "LANG": "C"})
    except (OSError, subprocess.SubprocessError):
        pass
    deadline = time.monotonic() + stop_wait
    while time.monotonic() < deadline and any(_alive(p) for p in family):
        time.sleep(0.1)
    _signal_all([p for p in family if _alive(p)], signal.SIGTERM)
    deadline = time.monotonic() + stop_wait
    while time.monotonic() < deadline and any(_alive(p) for p in family):
        time.sleep(0.1)
    _signal_all([p for p in family if _alive(p)], signal.SIGKILL)


def sit(stdin=None) -> None:
    """Note each session as the launcher starts it; when the pipe ends, the owner is gone: stop them all."""
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, signal.SIG_IGN)
    sessions = []
    for line in stdin or sys.stdin.buffer:
        try:
            row = json.loads(line)
            sessions.append((row["binary"], row["folder"], row["session"]))
        except (ValueError, KeyError, TypeError):
            continue
    for binary, folder, session in sessions:
        try:
            _stop_session(binary, folder, session)
        except OSError:
            continue


if __name__ == "__main__" and sys.argv[1:] == ["--sit"]:
    sit()
elif __name__ == "__main__" and sys.argv[1:2] == ["--chrome"]:
    run_chrome(sys.argv[2:])
elif __name__ == "__main__" and sys.argv[1:2] == ["--answer"] and len(sys.argv) == 5:
    write_active_port(int(sys.argv[2]), int(sys.argv[3]), sys.argv[4])
