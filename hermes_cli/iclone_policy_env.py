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

Where the exec-time environment cannot be read (other platforms) the snapshot is ``os.environ`` at first import, which
``hermes_bootstrap`` makes the first thing every entry point does.
"""

from __future__ import annotations

import os
import select
import stat
import sys
import threading
from typing import Dict, Optional, Tuple

_PREFIX = "ICLONE_"
_KEY_FD_VAR = "ICLONE_POLICY_KEY_FD"
_KEY_PPID_VAR = "ICLONE_POLICY_KEY_PPID"
_KEY_READ_TIMEOUT_S = 3.0
_KEY_MAX_BYTES = 512

_lock = threading.Lock()
_snapshot: Optional[Dict[str, str]] = None
_snapshot_source = "unread"
_key: Optional[Tuple[str, bytes]] = None
_key_taken = False


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
        if text_name.startswith(_PREFIX):
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
    return {k: v for k, v in os.environ.items() if k.startswith(_PREFIX)}, "import"


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
        if name not in snapshot or name == _KEY_FD_VAR:
            os.environ.pop(name, None)
    for name, value in snapshot.items():
        if name != _KEY_FD_VAR:
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


def _reset_for_tests(env: Optional[Dict[str, str]] = None, key: Optional[Tuple[str, bytes]] = None) -> None:
    global _snapshot, _snapshot_source, _key, _key_taken
    with _lock:
        _snapshot = dict(env) if env is not None else None
        _snapshot_source = "test" if env is not None else "unread"
        _key = key
        _key_taken = False
