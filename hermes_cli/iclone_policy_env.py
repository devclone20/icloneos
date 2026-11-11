"""icloneOS V3-F — what the icloneOS app handed THIS process when it started it, and nothing a file can change later.

Two facts decide whether the app owns the approval policy of this Hermes process:

* ``ICLONE_*`` settings (the lock, the policy file, the agent socket). They are read from the **exec-time
  environment** — the bytes the kernel recorded when main spawned the process (``KERN_PROCARGS2`` on macOS,
  ``/proc/self/environ`` on Linux). ``$HERMES_HOME/.env``, ``.op.env``, managed env, external secret sources and
  ``config.yaml`` bridges all write ``os.environ`` later; none of them reaches the exec-time copy, so none of them can
  turn the lock off, point the plugin at another socket, or swap the policy file (V3-F critic F-4).
* The **spawn key**. Main never puts it in the environment or argv (``ps eww`` shows both, F-2). It arrives once on an
  inherited pipe whose number is ``ICLONE_POLICY_KEY_FD``; this module reads it at first import, closes the fd, and
  hands it to the iclone-permissions plugin exactly once.

One more name is read from that copy: the ``TERMINAL_ENV`` main chose for a process it confined. It is read at import,
before any bridge, and never lives in the ``ICLONE_*`` snapshot (``confined_backend``): while confined it decides the
terminal backend, and ``config.yaml``, ``.env`` and a profile's config cannot change it. ``TERMINAL_CWD`` is the app's
project the same way (``confined_project``). The confinement plugin's hand-over (spec, link key, ack) is read from this
copy too and never stays in ``os.environ``.

Isolation off is a state main chooses and marks at exec (``ICLONE_CONFINEMENT=off``), not a failure: no pin, no folder,
no refusal, and the terminal backend is whatever config.yaml says. Only main's exec value says so; a ``.env`` that writes
``ICLONE_CONFINEMENT`` in either direction changes nothing (``isolation_off``).

Where the exec-time environment cannot be read (other platforms) the snapshot is ``os.environ`` at first import, which
``hermes_bootstrap`` makes the first thing every entry point does.
"""

from __future__ import annotations

import os
import select
import importlib.util
import stat
import sys
import threading
from typing import Any, Dict, Optional, Tuple

_PREFIX = "ICLONE_"
_KEY_FD_VAR = "ICLONE_POLICY_KEY_FD"
_KEY_PPID_VAR = "ICLONE_POLICY_KEY_PPID"
_KEY_READ_TIMEOUT_S = 3.0
_KEY_MAX_BYTES = 512
_BACKEND_VAR = "TERMINAL_ENV"
_PROJECT_VAR = "TERMINAL_CWD"
_BUNDLED_VAR = "HERMES_BUNDLED_PLUGINS"  # the overlay of an unmanaged dev runtime, set by main (iclone-hermes-plugins.ts)
_NOT_SNAPSHOT = frozenset({_BACKEND_VAR, _PROJECT_VAR, _BUNDLED_VAR})  # read from the kernel's copy; restore_environ never writes them
# Handed to the plugin only. Read from the kernel's copy by every plugin copy; never in os.environ, so no child and no
# confined command inherits them, and restore_environ never brings them back.
_PLUGIN_ONLY = frozenset({"ICLONE_CONFINEMENT_SPEC", "ICLONE_CONFINEMENT_LINK_KEY", "ICLONE_CONFINEMENT_ACK",
                          "ICLONE_GIT_USER_NAME", "ICLONE_GIT_USER_EMAIL"})
_CONFINED_BACKENDS = frozenset({"iclone_seatbelt", "iclone_container"})
# The shipped default (the installer's template, DEFAULT_CONFIG) and a blank ``backend:``, which the config bridge writes
# as the string ``None``: nobody asked for a backend.
_NO_BACKEND_ASKED = frozenset({"", "local", "none"})

_lock = threading.Lock()
_snapshot: Optional[Dict[str, str]] = None
_snapshot_source = "unread"
_key: Optional[Tuple[str, bytes]] = None
_key_taken = False
_refused_request: Optional[str] = None
_gate_lock = threading.Lock()
_ack: Dict[str, Any] = {"path": "", "backend": "", "said": None, "config": ""}
_ack_lock = threading.Lock()
_gate: Optional[Dict[str, Any]] = None
_refusal_listener: Optional[Callable[[], None]] = None


def _parse_env_block(raw: bytes) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for item in raw.split(b"\0"):
        if not item or b"=" not in item:
            continue
        name, _, value = item.partition(b"=")
        try:
            text_name = name.decode("utf-8")
        except UnicodeDecodeError:
            continue
        if text_name.startswith(_PREFIX) or text_name in _NOT_SNAPSHOT:
            out[text_name] = value.decode("utf-8", "replace")
    return out


def _darwin_exec_env() -> Optional[Dict[str, str]]:
    import ctypes
    import ctypes.util

    libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
    ctl_kern, kern_procargs2 = 1, 49
    mib = (ctypes.c_int * 3)(ctl_kern, kern_procargs2, os.getpid())
    size = ctypes.c_size_t(0)
    if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0 or size.value < 4:
        return None
    buffer = ctypes.create_string_buffer(size.value)
    if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
        return None
    raw = buffer.raw[: size.value]
    argc = int.from_bytes(raw[:4], sys.byteorder)
    rest = raw[4:]
    # exec path, NUL padding, then argc argv strings, then the environment until an empty string.
    exec_end = rest.find(b"\0")
    if exec_end < 0:
        return None
    position = exec_end
    while position < len(rest) and rest[position] == 0:
        position += 1
    for _ in range(argc):
        end = rest.find(b"\0", position)
        if end < 0:
            return None
        position = end + 1
    env_end = rest.find(b"\0\0", position)
    return _parse_env_block(rest[position: env_end if env_end >= 0 else len(rest)])


def _linux_exec_env() -> Optional[Dict[str, str]]:
    with open("/proc/self/environ", "rb") as handle:
        return _parse_env_block(handle.read())


def _read_exec_env() -> Tuple[Dict[str, str], str]:
    reader = _darwin_exec_env if sys.platform == "darwin" else _linux_exec_env if sys.platform.startswith("linux") else None
    if reader is not None:
        try:
            found = reader()
            if found is not None:
                return found, "exec"
        except Exception:  # noqa: BLE001 — any failure falls back to the first-import snapshot below
            pass
    return {k: v for k, v in os.environ.items() if k.startswith(_PREFIX) or k in _NOT_SNAPSHOT}, "import"


def _read_key_fd(fd_text: str) -> Optional[Tuple[str, bytes]]:
    """``v1 <keyId> <64 hex>\\n`` on a pipe main wrote and closed. Anything else is no key (the plugin runs Manual)."""
    try:
        fd = int(fd_text)
    except ValueError:
        return None
    if fd < 3:
        return None
    try:
        mode = os.fstat(fd).st_mode
    except OSError:
        return None
    if not (stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode)):
        return None
    chunks = b""
    try:
        while len(chunks) <= _KEY_MAX_BYTES:
            ready, _, _ = select.select([fd], [], [], _KEY_READ_TIMEOUT_S)
            if not ready:
                break
            piece = os.read(fd, _KEY_MAX_BYTES)
            if not piece:
                break
            chunks += piece
    except OSError:
        return None
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
    parts = chunks.decode("ascii", "replace").split()
    if len(parts) != 3 or parts[0] != "v1" or len(parts[2]) != 64:
        return None
    try:
        return parts[1][:64], bytes.fromhex(parts[2])
    except ValueError:
        return None


def _ensure() -> Dict[str, str]:
    global _snapshot, _snapshot_source, _key
    with _lock:
        if _snapshot is None:
            _snapshot, _snapshot_source = _read_exec_env()
            # Not an ICLONE_* setting: restore_environ would write it back in a process that holds the lock unconfined.
            for name in _NOT_SNAPSHOT:
                _snapshot.pop(name, None)
            for name in _PLUGIN_ONLY:
                os.environ.pop(name, None)
            fd_text = _snapshot.get(_KEY_FD_VAR)
            # Never inherited further: a child that sees this name would read whatever its own fd N happens to be.
            os.environ.pop(_KEY_FD_VAR, None)
            # Only the process main itself spawned reads the pipe: a grandchild that still carries the name would
            # otherwise read and close whatever its own fd N is.
            if fd_text and _snapshot.get(_KEY_PPID_VAR) == str(os.getppid()):
                _key = _read_key_fd(fd_text)
        return _snapshot


def exec_env(name: str) -> Optional[str]:
    """An ``ICLONE_*`` value exactly as main passed it at spawn (``None`` when main did not pass it)."""
    return _ensure().get(name)


def locked() -> bool:
    """True when the icloneOS app started this process and owns its approval policy."""
    return exec_env("ICLONE_POLICY_LOCK") == "1"


def take_policy_key() -> Optional[Tuple[str, bytes]]:
    """``(keyId, key)`` once, for the iclone-permissions plugin; every later call gets ``None``."""
    global _key, _key_taken
    _ensure()
    with _lock:
        if _key_taken:
            return None
        _key_taken = True
        handed, _key = _key, None
        return handed


def _bundled_gate_dir() -> str:
    # The folder hermes_cli.plugins calls bundled, as main set it at exec: the runtime's own plugins/, or the overlay it
    # names for an unmanaged dev runtime. A live value that differs (``.env`` writes os.environ) is not main's, so a copy
    # discovered there holds no gate. The discovery lock already refuses a shadow of the gate.
    found, _ = _read_exec_env()
    named = found.get(_BUNDLED_VAR)
    root = named if named else os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(__file__))), "plugins")
    return os.path.join(os.path.realpath(root), "iclone-permissions")


def _gate_module(name: str) -> Any:
    path = os.path.join(_bundled_gate_dir(), name + ".py")
    spec = importlib.util.spec_from_file_location("_iclone_gate_" + name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _build_gate() -> Dict[str, Any]:
    from hermes_constants import get_hermes_home

    channel, policy_module = _gate_module("channel"), _gate_module("policy")
    handed = take_policy_key()  # taken earlier by anyone else: no key, so the gate fails closed
    key_id, key = handed if handed else ("", None)
    policy = policy_module.SignedPolicy(exec_env("ICLONE_POLICY_FILE"), key)
    return {
        "policy": policy,
        "channel": channel.Channel(exec_env("ICLONE_PERM_SOCKET"), exec_env("ICLONE_PERM_TOKEN_FILE"), key, key_id,
                                   os.path.join(str(get_hermes_home()), "iclone-perm-spool"),
                                   on_gen=policy.raise_floor, beat_seconds=channel.BEAT_SECONDS),
    }


def process_gate() -> Optional[Tuple[Dict[str, Any], bool]]:
    """The one permission gate of this process and whether this call built it. Every routed home imports its own copy
    of the plugin, and main handed one key to one pid: every copy shares one key, policy and channel (one write-ahead
    log, one sequence). Main's answers stay the authority; this only says who holds the wire.

    Nobody supplies or seeds it: it is built here, once, from the exec key. Any caller but the bundled plugin gets None
    and changes nothing. This keeps an early module from displacing the gate by accident or by load order; Python in
    the same process can still reach these objects, and that is not claimed as a boundary."""
    global _gate
    caller = sys._getframe(1).f_globals.get("__file__")
    if not caller or os.path.realpath(caller) != os.path.join(_bundled_gate_dir(), "__init__.py"):
        return None
    with _gate_lock:
        if _gate is None:
            _gate = _build_gate()
            return _gate, True
        return _gate, False


def process_ack() -> Tuple[Dict[str, Any], "threading.Lock"]:
    """What this process last told main about the agent's commands, one per process however many plugin copies load.
    Only the first copy arms it; the config note is the launch home's alone."""
    return _ack, _ack_lock


def snapshot_source() -> str:
    """``exec`` (kernel copy) or ``import`` (first-import fallback) — for diagnostics and tests."""
    _ensure()
    return _snapshot_source


def restore_environ() -> None:
    """Undo any ``ICLONE_*`` a dotenv/secret loader wrote: children inherit what main passed, nothing else."""
    if not locked():
        return
    snapshot = _ensure()
    for name in [n for n in os.environ if n.startswith(_PREFIX)]:
        if name not in snapshot or name == _KEY_FD_VAR or name in _PLUGIN_ONLY:
            os.environ.pop(name, None)
    for name, value in snapshot.items():
        if name != _KEY_FD_VAR and name not in _PLUGIN_ONLY:
            os.environ[name] = value
    os.environ.pop("HERMES_YOLO_MODE", None)


def forget(names) -> None:
    """Drop ``names`` from the exec-time snapshot (and ``os.environ``): ``restore_environ`` never brings them back.

    V3-J (fix m-r4-1): a pay env inherited by a process of another profile is dropped at boot, for good."""
    snapshot = _ensure()
    with _lock:
        for name in names:
            snapshot.pop(name, None)
            os.environ.pop(name, None)


def _isolation_off_at_exec() -> bool:
    found, _ = _read_exec_env()
    return found.get("ICLONE_CONFINEMENT") == "off"


def _read_confinement() -> Tuple[bool, Optional[str], Optional[str]]:
    found, _ = _read_exec_env()
    if found.get("ICLONE_CONFINEMENT") != "1":
        return False, None, None
    value = found.get(_BACKEND_VAR, "").strip().lower()
    # Anything else at exec is not a choice main makes: no pin, and every tool refuses (exec_backend_refusal).
    pinned = value if value in _CONFINED_BACKENDS else None
    return True, pinned, (found.get(_PROJECT_VAR) or None) if pinned else None


def confined_backend() -> Optional[str]:
    """The backend main chose for this process when it started it confined; ``None`` for any other process."""
    return _CONFINED_BACKEND


def confined_at_exec() -> bool:
    """Main marked this process confined when it started it, whether or not it also gave it the app's backend."""
    return _CONFINED_AT_EXEC


def isolation_off() -> bool:
    """The user turned isolation off and main started this process that way. Read from main's exec value, once, at import."""
    return _ISOLATION_OFF


def confined_project() -> Optional[str]:
    """The folder main set as ``TERMINAL_CWD`` when it started this process confined. A live value that differs (``.env``,
    ``config.yaml``, ``reload_env`` all write ``os.environ``) is not the app's project."""
    return _CONFINED_PROJECT


def exec_backend_refusal() -> Optional[str]:
    """Marked confined at exec without the app's backend: no tool may get an environment."""
    if _CONFINED_AT_EXEC and _CONFINED_BACKEND is None:
        return ("Refused by icloneOS confinement: this process was started confined without the app's sandbox backend, "
                "so no tool can run. Restart the app.")
    return None


def other_backend_refusal(asked: object) -> Optional[str]:
    """Why a confined process refuses ``asked`` (a backend named by config.yaml or .env), or ``None`` when it may run:
    the shipped default ``local`` only means nobody chose, so the app's backend decides. Another backend stays refused:
    its isolation is what the owner asked for, and running in the sandbox instead would silently change that."""
    pinned = _CONFINED_BACKEND
    wanted = str(asked or "").strip().lower()
    if pinned is None or wanted in _NO_BACKEND_ASKED or wanted == pinned:
        return None
    return (f"Refused by icloneOS confinement: terminal.backend (or TERMINAL_ENV in .env) asks for {wanted!r}, and "
            f"while confinement is on the agent's commands run only in the app's own sandbox ({pinned}). Remove that "
            "setting from config.yaml or .env and restart the app, or turn isolation off in Containers > Backends.")


def settle_backend(target: Dict[str, str]) -> None:
    """A bridge or dotenv just wrote ``target``: while confined the exec value goes back. On ``os.environ`` this also
    records what was asked, because that is the process's own policy: another backend is refused until a later load
    says the default again (``refused_backend``)."""
    global _refused_request
    pinned = _CONFINED_BACKEND
    if pinned is None:
        # Isolation off: a sandbox backend named by a file has no provider in this process, so it would refuse every
        # command under a name that says it is confined. Nothing is confined: the command runs on this Mac, as chosen.
        if _ISOLATION_OFF and str(target.get(_BACKEND_VAR) or "").strip().lower() in _CONFINED_BACKENDS:
            target[_BACKEND_VAR] = "local"
        return
    if target is os.environ:
        asked = str(target.get(_BACKEND_VAR) or "").strip().lower()
        if asked in _NO_BACKEND_ASKED:
            _refused_request = None
        elif asked != pinned:  # the pinned value says nothing: an earlier step of this load may have settled already
            _refused_request = asked
    target[_BACKEND_VAR] = pinned
    if target is os.environ and _refusal_listener is not None:
        _refusal_listener()


def on_refusal_change(listener: Callable[[], None]) -> None:
    """The plugin's ack is told whenever a load settles, so the pane's reason follows a later ``reload_env``."""
    global _refusal_listener
    _refusal_listener = listener


def refused_backend() -> Optional[str]:
    """The refusal for this process's own policy, for a read with no per-turn scope; ``None`` when nothing is refused."""
    return exec_backend_refusal() or other_backend_refusal(_refused_request)


def overlay_refused(name: str) -> bool:
    """A routed home's ``.env`` overlay on a child's env is runtime-side text: it never names the gate, the spec or the
    app's other ``ICLONE_*`` values, and while main confined this process it does not name the backend or the folder."""
    return name.startswith(_PREFIX) or (_CONFINED_AT_EXEC and name in (_BACKEND_VAR, _PROJECT_VAR))


def settle_child(env: Dict[str, str]) -> None:
    """A Hermes child built for a routed home: the launch ``TERMINAL_*`` were stripped, so it would otherwise be marked
    confined with no backend and no folder. It keeps the app's backend and project, and the spec's hashes (not secret)
    its own plugin needs. The link key and the ack stay here: without them the child trusts no hard-link answer. Runs
    after the ``.env`` overlay: the last word is the exec copy."""
    if _CONFINED_BACKEND is None:
        return
    settle_backend(env)
    if _CONFINED_PROJECT:  # the child reads this as main's at its own exec: never a value a .env moved
        env[_PROJECT_VAR] = _CONFINED_PROJECT
    for name in ("ICLONE_CONFINEMENT", "ICLONE_POLICY_LOCK", "ICLONE_CONFINEMENT_SPEC"):
        value = exec_env(name)
        if value:
            env[name] = value


def _reset_for_tests(env: Optional[Dict[str, str]] = None, key: Optional[Tuple[str, bytes]] = None) -> None:
    global _snapshot, _snapshot_source, _key, _key_taken, _gate
    _gate = None
    _ack.clear()
    _ack.update(path="", backend="", said=None, config="")
    with _lock:
        _snapshot = dict(env) if env is not None else None
        _snapshot_source = "test" if env is not None else "unread"
        _key = key
        _key_taken = False


# At import, before any bridge: hermes_bootstrap imports this module first in every entry point. No pipe is read here.
_CONFINED_AT_EXEC, _CONFINED_BACKEND, _CONFINED_PROJECT = _read_confinement()
_ISOLATION_OFF = _isolation_off_at_exec()
