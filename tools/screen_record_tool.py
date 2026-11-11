"""G9, ruling R3: `screen_record`. The agent records the whole screen into a video file the user can open.

The work is in plugins/iclone-confinement/screen_door.py. With the Seatbelt on it runs in the launcher, outside the
Seatbelt, through the exact door verbs; with it off it runs here. Nothing is uploaded. Manual asks on start, through the
permission hook (classify.py); stop and status never ask.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import os
import subprocess
import sys
import threading
from typing import Any, Mapping

from tools.registry import registry

logger = logging.getLogger(__name__)

DEFAULT_SECONDS = 60
MAX_SECONDS = 600
SHOWN_FOLDER = "Movies/icloneOS Recordings"
NO_LAUNCHER = ("The screen recording could not start because the app's launcher is not answering. "
               "Quit and reopen icloneOS, then ask again.")

SCREEN_RECORD_SCHEMA = {
    "name": "screen_record",
    "description": (
        "Record the whole screen of this Mac as a video, including every window on it, and get a .mov file the user can "
        f"open, in {SHOWN_FOLDER} in their home folder. `start` begins and returns at once, `stop` ends it and returns the "
        "file once it has been checked for real frames, `status` says how it stands. One recording at a time; it ends by "
        f"itself after `seconds`, and when the app quits. No audio. Nothing is uploaded. A missing macOS grant comes back "
        "as a plain reason: pass it to the user as it is."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["start", "stop", "status"], "description": "What to do."},
            "seconds": {"type": "integer", "minimum": 1, "maximum": MAX_SECONDS,
                        "description": f"For start: the longest it may run. Default {DEFAULT_SECONDS}, at most {MAX_SECONDS}."},
        },
        "required": ["action"],
    },
}


def seconds_of(args: Mapping[str, Any]) -> int:
    """The length asked for, always inside the cap: the ask and the recording must say the same number."""
    raw = args.get("seconds")
    if isinstance(raw, bool):
        return DEFAULT_SECONDS
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_SECONDS
    return DEFAULT_SECONDS if value < 1 else min(value, MAX_SECONDS)


def ask_sentence(args: Mapping[str, Any]) -> str:
    """What the sheet says in Manual."""
    return (f"Record the whole screen, everything on it, for up to {seconds_of(args)} seconds. "
            f"The video file goes to {SHOWN_FOLDER} in your home folder.")


def _door_module():
    name = "iclone_screen_door"
    if name not in sys.modules:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "iclone-confinement", "screen_door.py")
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


def _door_socket() -> str:
    from tools.computer_use.cua_backend_driver import door_socket
    return door_socket()


_recorder_lock = threading.Lock()
_recorder = None
_recorder_factory = None


def _here():
    """Seatbelt off: this runtime owns the recorder. Its pipe closes when the runtime ends, however it ends."""
    global _recorder
    with _recorder_lock:
        if _recorder is None:
            make = _recorder_factory or _door_module().Recorder
            _recorder = make(os.environ.get("HOME") or os.path.expanduser("~"))
        return _recorder


def _reset_for_tests() -> None:
    global _recorder, _recorder_factory
    with _recorder_lock:
        if _recorder is not None:
            _recorder.stop_all()
        _recorder, _recorder_factory = None, None


def _through_the_door(socket_path: str, verb: list) -> dict:
    from tools.environments.host_lane import STUB_FILE
    argv = [sys.executable, "-I", "-S", os.path.realpath(str(STUB_FILE)), socket_path, "--", _door_module().COMMAND, *verb]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, errors="replace", timeout=60, stdin=subprocess.DEVNULL,
                              env={"ICLONE_RUN_CWD": "/"})
        return json.loads(proc.stdout)
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        logger.debug("screen_record door: %s", exc)
        return {"ok": False, "recording": False, "reason": NO_LAUNCHER}


def handle(args: Mapping[str, Any], **_: Any) -> str:
    args = args if isinstance(args, Mapping) else {}
    action = args.get("action")
    if action not in ("start", "stop", "status"):
        return json.dumps({"ok": False, "recording": False, "reason": "screen_record takes start, stop or status."})
    socket_path = _door_socket()
    if socket_path:
        verb = ["start", str(seconds_of(args))] if action == "start" else [action]
        return json.dumps(_through_the_door(socket_path, verb))
    recorder = _here()
    return json.dumps(recorder.start(seconds_of(args)) if action == "start" else getattr(recorder, action)())


def check_requirements() -> bool:
    """With the Seatbelt on the runtime may not exec the binary, so access() says no: the launcher is the one who runs it."""
    return sys.platform == "darwin" and (bool(_door_socket()) or os.access(_door_module().SCREENCAPTURE, os.X_OK))


registry.register(
    name="screen_record",
    toolset="computer_use",
    schema=SCREEN_RECORD_SCHEMA,
    handler=lambda args, **kw: handle(args, **kw),
    check_fn=check_requirements,
    requires_env=[],
    description="Record the whole screen as a video file (macOS).",
)
