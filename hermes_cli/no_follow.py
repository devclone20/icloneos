"""Armed in a Hermes process the desktop app starts OUTSIDE its confinement, on a home the confined runtime can write.

The runtime can plant a link, a FIFO or a hard link at any name in HERMES_HOME, so a plain ``open`` here would let it aim
this process's authority at any file of the user, or hang it. Mirror of ``apps/desktop/electron/lib/no-follow-fs.ts``.

Off unless the app sets ``HERMES_HOME_NO_LINKS=1``: on the command line a linked ``config.yaml`` (a dotfile manager) is the
owner's own choice, and ``utils.atomic_replace`` keeps it working there.

Opens go through one descriptor: ``O_NOFOLLOW_ANY`` on macOS (every component, so a swap between a check and the open is
refused too), ``O_NONBLOCK`` (a FIFO never hangs), then ``fstat`` on it. ``chmod``, ``chown``, ``truncate``, ``utime``,
``rename``, ``unlink``, ``mkdir``, ``link``, ``symlink`` and sqlite take a path, so an audit hook checks that path first:
a swap inside that window stays open for those calls, and it can change a mode, never redirect file contents.
"""

from __future__ import annotations

import builtins
import errno
import io
import os
import stat
import sys
from pathlib import Path
from typing import Any, Callable

ENV_FLAG = "HERMES_HOME_NO_LINKS"

# <sys/fcntl.h> on macOS 11+; the kernel answers EINVAL to it combined with O_NOFOLLOW, and it covers the last component.
_O_NOFOLLOW_ANY_DARWIN = 0x20000000
_NEVER_FOLLOW = _O_NOFOLLOW_ANY_DARWIN if sys.platform == "darwin" else getattr(os, "O_NOFOLLOW", 0)
_NEVER_HANG = getattr(os, "O_NONBLOCK", 0)

# The runtime's profile denies writes there (HERMES_HOME_NEVER_WRITTEN in runtime-profile.ts); a venv in them holds links.
_NEVER_WRITTEN_BY_RUNTIME = ("plugins", "installs", "tools")

# Calls that act on what their last component points at: a link there is refused.
_FOLLOWS_LAST = {"os.chmod": 0, "os.chown": 0, "os.truncate": 0, "os.utime": 0, "sqlite3.connect": 0, "shutil.copyfile": 1}
# Calls that act on the name itself: only the folders on the way matter. Values are the argument positions of the paths.
_ACTS_ON_NAME = {"os.remove": (0,), "os.rmdir": (0,), "os.mkdir": (0,), "os.rename": (0, 1), "os.link": (1,), "os.symlink": (1,)}


# The way out, for an owner who placed the link: on the command line this guard is off, so the linked file keeps working.
WAY_OUT = ("the app never follows links or special files in the agent's home; replace it with a plain file, "
           "or run this command from a terminal")

# What each refusal is, in the words the user reads in the app's log.
_REFUSAL_WORDS = {errno.ELOOP: "a symbolic link", errno.ENXIO: "a pipe with no reader", errno.ENOTDIR: "a file or a link where a folder was expected",
                  errno.EOPNOTSUPP: "a socket", errno.EMLINK: "a hard link"}


class RefusedPathError(PermissionError):
    """A link, a FIFO, a hard link or another special file where this process expected a plain file of its own."""

    def __init__(self, shown: str, why: str) -> None:
        super().__init__(f"refused {shown}: {why} ({WAY_OUT})")


_home_as_given: str | None = None
_home_real: str | None = None
_exempt_real: tuple[str, ...] = ()
_plain_os_open = os.open
_REFUSAL_ERRNOS = frozenset({errno.ELOOP, errno.ENXIO, errno.ENOTDIR, errno.EOPNOTSUPP, errno.EMLINK})


def is_armed() -> bool:
    return _home_real is not None


def _inside(path: str, folder: str) -> bool:
    return path == folder or path.startswith(folder + os.sep)


def _to_text(path: Any) -> str | None:
    if isinstance(path, (str, bytes, os.PathLike)):
        return os.fsdecode(path)

    return None


def _under_pinned_home(path: Any) -> str | None:
    """``path`` rewritten onto the home's real path pinned at arm time, or None when this guard has no say over it."""
    if _home_real is None or _home_as_given is None:
        return None

    text = _to_text(path)

    if text is None:
        return None

    absolute = os.path.abspath(text)

    for base in (_home_real, _home_as_given):
        if _inside(absolute, base):
            pinned = os.path.join(_home_real, os.path.relpath(absolute, base))

            return None if any(_inside(pinned, folder) for folder in _exempt_real) else os.path.normpath(pinned)

    return None


def _check_stat(st: os.stat_result, shown: str) -> None:
    if stat.S_ISDIR(st.st_mode):
        return

    if not stat.S_ISREG(st.st_mode):
        raise RefusedPathError(shown, "not a regular file (a pipe, a socket, a device or a folder)")

    # The profile denies the runtime `file-link`, so a second name is not one of ours: it may be any file of the user.
    if st.st_nlink > 1:
        raise RefusedPathError(shown, "a hard link")


def _check_folders_down_to(pinned: str, shown: str) -> None:
    relative = os.path.relpath(pinned, _home_real)
    folder = _home_real or ""

    for part in relative.split(os.sep)[:-1]:
        folder = os.path.join(folder, part)

        try:
            st = os.lstat(folder)
        except FileNotFoundError:
            return

        if not stat.S_ISDIR(st.st_mode):
            raise RefusedPathError(shown, f"{folder} is a link or not a folder")


def _check_following_call(pinned: str, shown: str) -> None:
    _check_folders_down_to(pinned, shown)

    try:
        st = os.lstat(pinned)
    except FileNotFoundError:
        return

    if stat.S_ISLNK(st.st_mode):
        raise RefusedPathError(shown, "a symbolic link")

    _check_stat(st, shown)


def _guarded_os_open(path: Any, flags: int, mode: int = 0o777, *, dir_fd: int | None = None) -> int:
    pinned = None if dir_fd is not None else _under_pinned_home(path)

    if pinned is None:
        return _plain_os_open(path, flags, mode, dir_fd=dir_fd)

    try:
        # `tempfile` asks for O_NOFOLLOW itself; next to the macOS flag that would be the EINVAL noted above.
        fd = _plain_os_open(pinned, (flags & ~os.O_NOFOLLOW) | _NEVER_FOLLOW | _NEVER_HANG, mode)
    except OSError as error:
        # ELOOP a link, ENXIO a reader-less FIFO, EOPNOTSUPP a socket. ENOTDIR a file or link used as a parent.
        if error.errno in _REFUSAL_ERRNOS:
            raise RefusedPathError(str(path), _REFUSAL_WORDS.get(error.errno, f"not a plain file ({error.strerror})")) from error

        raise

    try:
        _check_stat(os.fstat(fd), str(path))
    except BaseException:
        os.close(fd)
        raise

    return fd


def _guarded_opener(path: Any, flags: int) -> int:
    return _guarded_os_open(path, flags, 0o666)


def _guarding_open(plain_open: Callable[..., Any]) -> Callable[..., Any]:
    def guarded_open(file: Any, mode: str = "r", buffering: int = -1, encoding: str | None = None,
                     errors: str | None = None, newline: str | None = None, closefd: bool = True,
                     opener: Callable[[str, int], int] | None = None) -> Any:
        if opener is None and _under_pinned_home(file) is not None:
            opener = _guarded_opener

        return plain_open(file, mode, buffering, encoding, errors, newline, closefd, opener)

    return guarded_open


def _audit(event: str, args: tuple[Any, ...]) -> None:
    if event == "open":
        follows, names = (args[0],) if args else (), ()
    elif event in _FOLLOWS_LAST:
        follows, names = (args[_FOLLOWS_LAST[event]],), ()
    elif event in _ACTS_ON_NAME:
        follows, names = (), tuple(args[i] for i in _ACTS_ON_NAME[event])
    else:
        return

    for path in follows:
        pinned = _under_pinned_home(path)

        if pinned is not None:
            _check_following_call(pinned, str(path))

    for path in names:
        pinned = _under_pinned_home(path)

        if pinned is not None:
            _check_folders_down_to(pinned, str(path))


def refuse_if_link(path: Any) -> None:
    """For a caller about to resolve a link on purpose: the resolved path would lie outside this guard's sight."""
    if _under_pinned_home(path) is not None and os.path.islink(os.fspath(path)):
        raise RefusedPathError(str(path), "a symbolic link")


def arm(home: str | os.PathLike[str]) -> None:
    """Idempotent. Pins the home's real path now: from here on a replaced home is a link in the path, and refused."""
    global _home_as_given, _home_real, _exempt_real

    if is_armed():
        return

    _home_as_given = os.path.abspath(os.fspath(home))
    _home_real = os.path.realpath(_home_as_given)
    code_roots = [os.path.realpath(sys.prefix), os.path.realpath(str(Path(__file__).resolve().parent.parent))]
    # This process already runs from the code roots, so the runtime cannot have chosen them by planting a name now.
    _exempt_real = (*code_roots, *(os.path.join(_home_real, name) for name in _NEVER_WRITTEN_BY_RUNTIME))

    builtins.open = _guarding_open(builtins.open)
    io.open = _guarding_open(io.open)
    os.open = _guarded_os_open
    sys.addaudithook(_audit)


def arm_from_env() -> None:
    if os.environ.get(ENV_FLAG) != "1":
        return

    home = os.environ.get("HERMES_HOME")

    if not home:
        raise SystemExit(f"{ENV_FLAG}=1 without HERMES_HOME: refusing to run unguarded")

    arm(home)
