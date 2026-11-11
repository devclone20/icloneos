"""G-98 F42 and S2: an agent writes its own iNFT profile in every permission mode, root and iNFT. An allow list by name:
SOUL.md, memories/ and notes/, its own notes folder, text files only. Everything else in the profile home is not the
agent's to change here, whatever it is or however new, and takes the normal way: the gate asks, and the Seatbelt judges.
Platforms, pairing, MCP tokens, scripts, node_modules and hermes-agent are all in that rest, as is the permission file a
memory could be named after. The agent's Seatbelt keeps this folder shut, as it should: a confined command stays out, so
a command the agent was tricked into running cannot reach it. These reads and writes happen here, in the runtime, under
its own profile, for a path the rule below accepts by real path. Off unless the app confined this process."""

from __future__ import annotations

import os
import tempfile
from typing import Optional, Tuple

_OWN_FILE = "soul.md"
_OWN_FOLDERS = frozenset({"memories", "notes"})
_TEXT = (".md", ".txt", ".json")
_NOT_ITS_OWN = "only SOUL.md, memories/ and notes/ are the agent's own"


def refused_reason(relative: str) -> Optional[str]:
    """Why this path inside the agent's own folder is not the agent's to change, or None. Compared in lower case because
    the Mac's disk is: the spelling never reaches another file."""
    parts = relative.split(os.sep)
    lowered = [part.lower() for part in parts]
    if any(part.startswith(".") for part in parts) or any("permission" in part or "policy" in part for part in lowered):
        return "it is a permission or hidden file"
    if len(parts) == 1:
        return None if lowered[0] == _OWN_FILE else _NOT_ITS_OWN
    if lowered[0] not in _OWN_FOLDERS:
        return _NOT_ITS_OWN
    return None if lowered[-1].endswith(_TEXT) else "only text files are the agent's own"


def _own_home() -> Optional[str]:
    from hermes_cli.iclone_policy_env import confined_at_exec

    if not confined_at_exec():
        return None
    from hermes_constants import get_hermes_home

    return os.path.realpath(str(get_hermes_home()))


def own_path(path: object, home: Optional[str] = None) -> Optional[Tuple[str, str]]:
    """``(real path, its path inside the folder)`` when ``path`` lands inside this agent's own folder, else None."""
    if not isinstance(path, str) or not path.strip() or "\x00" in path:
        return None
    home = home or _own_home()
    if home is None:
        return None
    expanded = os.path.expanduser(path.strip())
    real = os.path.realpath(expanded if os.path.isabs(expanded) else os.path.join(home, expanded))
    if not real.startswith(home.rstrip(os.sep) + os.sep):
        return None
    if not os.path.isabs(expanded):  # a relative path means the session's folder, never this one
        return None
    return real, os.path.relpath(real, home)


def writable(path: object) -> Optional[str]:
    """The real path when the agent may write ``path`` in every mode, else None."""
    found = own_path(path)
    return found[0] if found and refused_reason(found[1]) is None else None


def needs_no_ask(path: object) -> bool:
    """G2 A6: the same names, for the ask, in every process icloneOS started: the Seatbelt on or off. With it off the
    ordinary write does the writing; ``writable`` and its direct write stay for the Seatbelt."""
    from hermes_cli.iclone_policy_env import confined_at_exec, isolation_off

    if not (confined_at_exec() or isolation_off()):
        return False
    from hermes_constants import get_hermes_home

    found = own_path(path, os.path.realpath(str(get_hermes_home())))
    return bool(found) and refused_reason(found[1]) is None


def write(real: str, content: str) -> int:
    """Atomic: the file is whole or as it was. A link in the last place is replaced, never followed."""
    os.makedirs(os.path.dirname(real), mode=0o700, exist_ok=True)
    data = content.encode("utf-8", "surrogateescape")
    fd, temporary = tempfile.mkstemp(prefix=".own-", dir=os.path.dirname(real))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.replace(temporary, real)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
    return len(data)


def read_bytes(real: str) -> bytes:
    fd = os.open(real, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, "rb") as handle:
        return handle.read()
