"""G9, ruling R3: the agent records the screen into a file the user can find. Stdlib only: the launcher loads this file
by path, and the runtime loads the same file for its Seatbelt-off path.

With the Seatbelt on the runtime may exec only its interpreter, so it asks the launcher (outside the Seatbelt, started
by main) through stub.py with ``iclone-screen-record start <seconds>``, ``stop`` or ``status``. Those three shapes are
all there is: the binary is fixed, no shell runs, and the launcher chooses the file. The answer comes back as JSON on
stdout, through a fixed /bin/echo run the launcher's ledger shows.

Measured on the real /usr/sbin/screencapture before this was written: without ``-V``, SIGINT finishes the file and exits
0 in under 0.1 s. With ``-V`` SIGINT loses the file, and neither stdin nor a pty stops it, so the cap cannot be ``-V``.
SIGTERM, SIGHUP and SIGUSR1 lose the file. So a small supervisor owns the recorder: it enforces the cap and sends SIGINT.
It holds a pipe from its owner, so an owner that ends, however it ends, stops the recording and the file still finishes.
"""

from __future__ import annotations

import fcntl
import json
import os
import select
import signal
import stat
import struct
import subprocess
import sys
import threading
import time
import uuid

COMMAND = "iclone-screen-record"
SCREENCAPTURE = "/usr/sbin/screencapture"
ECHO = "/bin/echo"
FFPROBE_PATHS = ("/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe")  # never one under a folder the runtime can write
FOLDER = ("Movies", "icloneOS Recordings")
SHOWN_FOLDER = "/".join(FOLDER)
LOCK_NAME = ".recording.lock"
DEFAULT_SECONDS = 60
MAX_SECONDS = 600
SETTLE_S = 0.7  # the recorder starts its stream; a stop sooner than this finds nothing to finish
READY_WAIT_S = 8.0
FINISH_WAIT_S = 8.0
PROBE_WAIT_S = 6.0
BLACK_YMAX = 24  # limited-range video: 16 is black
BLACK_NOT_CHECKED = "not checked: ffprobe is not on this Mac"
BLACK_UNREADABLE = "not checked: ffprobe could not read the picture"

_SETTINGS = ("In icloneOS open Settings > Setup and press Allow on Screen recording, or turn icloneOS on in System Settings > "
             "Privacy & Security > Screen & System Audio Recording. macOS applies it after icloneOS restarts; then ask again.")
PERMISSION = "macOS has not allowed icloneOS to record the screen. " + _SETTINGS
BUSY = "A screen recording is already running. Stop it first, then start a new one."
NOT_RUNNING = "No screen recording is running."
NO_FILE = "The recording ended without a usable video, so nothing was kept. macOS may not have allowed it. " + _SETTINGS
BLACK = ("The recording came out black, so it was not kept. Either the display was asleep or locked, or macOS has not "
         "allowed it. " + _SETTINGS)
NO_FOLDER = "The recording's folder could not be used: {folder}. Nothing was recorded."


class DoorRefused(Exception):
    """A plain sentence for the runtime, and through it the model and the user."""


def is_request(req) -> bool:
    argv = req.get("argv") if isinstance(req, dict) else None
    return isinstance(argv, list) and bool(argv) and argv[0] == COMMAND


def shape(args) -> tuple:
    """``(verb, seconds or None)`` for the exact shapes the tool sends; everything else is refused."""
    if args == ["stop"] or args == ["status"]:
        return args[0], None
    if isinstance(args, list) and len(args) == 2 and args[0] == "start" and isinstance(args[1], str) \
            and args[1].isascii() and args[1].isdigit() and str(int(args[1])) == args[1] and 1 <= int(args[1]) <= MAX_SECONDS:
        return "start", int(args[1])
    raise DoorRefused(f"the screen recording door takes start <1 to {MAX_SECONDS}>, stop or status, nothing else")


def find_ffprobe() -> str:
    return next((path for path in FFPROBE_PATHS if os.access(path, os.X_OK)), "")


def read_movie_bytes(data: bytes):
    """``(seconds, video frames)`` from a QuickTime file's own atoms, or None when they are not there. Every Mac has this
    check; ffprobe is an extra most Macs do not have."""
    def atoms(start: int, end: int):
        at = start
        while at + 8 <= end:
            size, kind = struct.unpack(">I4s", data[at:at + 8])
            head = 8
            if size == 1 and at + 16 <= end:
                size, head = struct.unpack(">Q", data[at + 8:at + 16])[0], 16
            elif size == 0:
                size = end - at
            if size < head or at + size > end:
                return
            yield kind, at + head, at + size
            at += size

    def child(start: int, end: int, *path: bytes):
        for kind, inner, stop in atoms(start, end):
            if kind == path[0]:
                return (inner, stop) if len(path) == 1 else child(inner, stop, *path[1:])
        return None

    moov = child(0, len(data), b"moov")
    mvhd = moov and child(*moov, b"mvhd")
    if not mvhd:
        return None
    wide = data[mvhd[0]] == 1
    try:
        timescale, length = struct.unpack(">IQ" if wide else ">II", data[mvhd[0] + (20 if wide else 12):mvhd[0] + (32 if wide else 20)])
    except struct.error:
        return None
    frames = 0
    for kind, inner, stop in atoms(*moov):
        hdlr = child(inner, stop, b"mdia", b"hdlr") if kind == b"trak" else None
        if hdlr and data[hdlr[0] + 8:hdlr[0] + 12] == b"vide":
            stsz = child(inner, stop, b"mdia", b"minf", b"stbl", b"stsz")
            if stsz and stsz[0] + 12 <= stsz[1]:
                frames += struct.unpack(">I", data[stsz[0] + 8:stsz[0] + 12])[0]
    return (length / timescale if timescale else 0.0), frames


def read_movie(path: str):
    """The same read from a file, without holding the picture data: only the atom headers and moov are loaded."""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as handle:
            at = 0
            while at + 8 <= size:
                handle.seek(at)
                head = handle.read(16)
                length, kind = struct.unpack(">I4s", head[:8])
                skip = struct.unpack(">Q", head[8:16])[0] if length == 1 and len(head) == 16 else (size - at if length == 0 else length)
                if skip < 8:
                    return None
                if kind == b"moov":
                    handle.seek(at)
                    return read_movie_bytes(handle.read(skip))
                at += skip
    except (OSError, struct.error):
        return None
    return None


def picture_is_black(path: str, seconds: float):
    """True or False when ffprobe could look, None when it could not. Two frames, by the file's plain name so no filter
    escaping is needed: the name is this file's own."""
    ffprobe = find_ffprobe()
    seen = []
    for at in (seconds * 0.5, seconds * 0.9):
        try:
            proc = subprocess.run([ffprobe, "-v", "error", "-f", "lavfi", "-i",
                                   f"movie={os.path.basename(path)}:seek_point={at:.3f},trim=end_frame=1,signalstats",
                                   "-show_entries", "frame_tags=lavfi.signalstats.YMAX", "-of", "csv=p=0"],
                                  cwd=os.path.dirname(path), stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                  errors="replace", timeout=PROBE_WAIT_S, env={"PATH": "/usr/bin:/bin", "HOME": "/"})
        except (OSError, subprocess.SubprocessError):
            continue
        text = proc.stdout.replace(",", " ").split()
        if proc.returncode == 0 and text and text[0].isdigit():
            seen.append(int(text[0]))
    return all(y <= BLACK_YMAX for y in seen) if seen else None


def _preflight_allows(mode: str) -> bool:
    """macOS's own answer, without raising its dialog: asking would add a row to the TCC database. A build where the call
    cannot be made goes on: what comes out is still checked."""
    if mode != "real":
        return mode != "deny"
    try:
        import ctypes
        core = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
        core.CGPreflightScreenCaptureAccess.restype = ctypes.c_bool
        return bool(core.CGPreflightScreenCaptureAccess())
    except (OSError, AttributeError):
        return True


def supervise(program: str, path: str, seconds: int, preflight: str) -> int:
    """Runs as its own process: one line on stdout says how the start went, then it sits until EOF on stdin (stop, or the
    owner is gone) or the cap, and asks the recorder to finish. TERM, INT and HUP do not stop it: they would lose the file."""
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda *_: None)  # a handler, not SIG_IGN: exec gives the recorder its own SIGINT back

    def say(word: str) -> None:
        os.write(1, word.encode() + b"\n")

    lock = os.open(os.path.join(os.path.dirname(path), LOCK_NAME), os.O_CREAT | os.O_WRONLY | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        say("busy")
        return 75
    if not _preflight_allows(preflight):
        say("denied")
        return 77
    try:
        recorder = subprocess.Popen([program, "-v", "-x", path], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, cwd="/", close_fds=True)
    except OSError:
        say("failed")
        return 70
    deadline = time.monotonic() + seconds
    time.sleep(SETTLE_S)
    if recorder.poll() is not None:
        say("failed")
        return 70
    say("recording")
    while recorder.poll() is None and time.monotonic() < deadline:
        ready, _, _ = select.select([0], [], [], min(0.25, max(0.0, deadline - time.monotonic())))
        if ready and not os.read(0, 64):
            break
    if recorder.poll() is None:
        recorder.send_signal(signal.SIGINT)
    try:
        return recorder.wait(timeout=FINISH_WAIT_S)
    except subprocess.TimeoutExpired:
        recorder.kill()  # it would not finish: never left running, and what it wrote is judged by the check that follows
        recorder.wait()
        return 70


class Recorder:
    """One recording at a time, in this process and, through the folder's lock, on this Mac. ``program`` and
    ``preflight`` are for tests: the door never takes them from a request."""

    def __init__(self, home: str, *, program: str = SCREENCAPTURE, preflight: str = "real", python: str = sys.executable):
        self.home, self.program, self.preflight, self.python = home, program, preflight, python
        self.folder = os.path.join(home, *FOLDER) if home else ""
        self.lock = threading.Lock()
        self.proc = None
        self.path = ""
        self.seconds = 0
        self.began = 0.0
        self.finished = None

    def _folder_problem(self) -> str:
        if not self.folder:
            return "no home folder"
        try:
            os.makedirs(os.path.dirname(self.folder), exist_ok=True)
            try:
                os.mkdir(self.folder, 0o700)
            except FileExistsError:
                pass
            seen = os.lstat(self.folder)
        except OSError as exc:
            return exc.strerror or "it could not be made"
        if not stat.S_ISDIR(seen.st_mode) or seen.st_uid != os.getuid():
            return "it is not a plain folder of yours"
        return ""

    def start(self, seconds: int) -> dict:
        with self.lock:
            if self.proc is not None and self.proc.poll() is None:
                return {"ok": False, "recording": True, "path": self.path, "reason": BUSY}
            self._collect()
            self.finished = None
            problem = self._folder_problem()
            if problem:
                return {"ok": False, "recording": False, "reason": NO_FOLDER.format(folder=problem)}
            path = os.path.join(self.folder, f"screen-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}.mov")
            try:
                proc = subprocess.Popen([self.python, "-I", "-S", os.path.abspath(__file__), "--record", self.program, path,
                                         str(seconds), self.preflight], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True, cwd="/",
                                        env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": self.home, "LANG": "C"})
            except OSError:
                return {"ok": False, "recording": False, "reason": NO_FILE}
            ready, _, _ = select.select([proc.stdout], [], [], READY_WAIT_S)
            word = proc.stdout.readline().decode("ascii", "replace").strip() if ready else ""
            if word != "recording":
                proc.stdin.close()
                proc.stdout.close()
                try:
                    proc.wait(timeout=FINISH_WAIT_S + 2)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                self._discard(path)
                return {"ok": False, "recording": False, "reason": {"busy": BUSY, "denied": PERMISSION}.get(word, NO_FILE)}
            self.proc, self.path, self.seconds, self.began = proc, path, seconds, time.monotonic()
            return {"ok": True, "recording": True, "seconds": seconds, "path": path, "folder": self.folder,
                    "note": f"The whole screen is being recorded. It ends at {seconds} seconds, on stop, or when icloneOS quits."}

    def _end(self) -> None:
        """Close the pipe: the supervisor finishes the file. Waits a little longer than the supervisor can take."""
        proc, self.proc = self.proc, None
        try:
            proc.stdin.close()
        except OSError:
            pass
        try:
            proc.wait(timeout=FINISH_WAIT_S + 3)
        except subprocess.TimeoutExpired:
            proc.kill()  # the recorder's own wait is over; a supervisor stuck past it has no more to finish
            proc.wait()
        proc.stdout.close()

    def _collect(self) -> None:
        if self.proc is not None and self.proc.poll() is not None:
            self._end()
            self.finished = self._verify(self.path)

    def status(self) -> dict:
        with self.lock:
            self._collect()
            if self.proc is not None:
                left = max(0, round(self.seconds - (time.monotonic() - self.began)))
                return {"ok": True, "recording": True, "path": self.path, "folder": self.folder, "seconds_left": left}
            return dict(self.finished) if self.finished else {"ok": True, "recording": False, "note": NOT_RUNNING}

    def stop(self) -> dict:
        with self.lock:
            self._collect()
            if self.proc is not None:
                self._end()
                self.finished = self._verify(self.path)
            result, self.finished = self.finished, None
            return result or {"ok": False, "recording": False, "reason": NOT_RUNNING}

    def stop_all(self) -> None:
        """The launcher or the runtime is going: nothing keeps recording. The file finishes; nobody is left to read it."""
        with self.lock:
            if self.proc is not None:
                self._end()

    @staticmethod
    def _discard(path: str) -> None:
        try:
            os.unlink(path)
        except OSError:
            pass

    def _verify(self, path: str) -> dict:
        read = read_movie(path)
        if not read or read[0] <= 0 or read[1] <= 0:
            self._discard(path)
            return {"ok": False, "recording": False, "reason": NO_FILE}
        check = BLACK_NOT_CHECKED
        if find_ffprobe():
            black = picture_is_black(path, read[0])
            if black:
                self._discard(path)
                return {"ok": False, "recording": False, "reason": BLACK}
            check = "passed" if black is False else BLACK_UNREADABLE
        return {"ok": True, "recording": False, "path": path, "folder": self.folder, "duration_seconds": round(read[0], 3),
                "frames": read[1], "bytes": os.path.getsize(path), "black_check": check}


class Door:
    """The launcher's end of the three verbs. The answer leaves through a fixed /bin/echo, so the run is in the ledger."""

    def __init__(self, home: str, **recorder):
        self.recorder = Recorder(home, **recorder)

    def plan(self, req: dict) -> dict:
        verb, seconds = shape(list(req["argv"][1:]))
        if not self.recorder.home:
            raise DoorRefused("the launcher does not know the home folder, so a recording has nowhere to go")
        answer = {"start": lambda: self.recorder.start(seconds), "stop": self.recorder.stop, "status": self.recorder.status}[verb]()
        label = "start " + str(seconds) if verb == "start" else verb
        return {
            "argv": [ECHO, json.dumps(answer)], "executable": ECHO, "cwd": "/",
            "env": {"PATH": "/usr/bin:/bin", "HOME": self.recorder.home, "LANG": "C"},
            "start": {"run": "screen-" + uuid.uuid4().hex, "kind": "shell", "cls": None, "sha": "", "session": None,
                      "command": f"[screen recording, outside the Seatbelt] {label}", "cwd": "/", "project": None, "net": False,
                      "write": True, "origin": "agent", "unconfined": True},
            "facts": None, "stderr": [],
        }

    def stop_all(self) -> None:
        self.recorder.stop_all()


if __name__ == "__main__" and len(sys.argv) == 6 and sys.argv[1] == "--record":
    sys.exit(supervise(sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]))
