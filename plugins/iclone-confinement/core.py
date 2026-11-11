"""Shared facts of the confinement plugin: the spec main hands over at spawn, the project-root rule, the marker, the
run tokens, and the two per-command parameters decided from V3-F's signed policy (one table, read, never re-implemented).

Trust: everything this plugin relies on arrives in its own spawn env (``ICLONE_CONFINEMENT_SPEC``, popped at import so
no child inherits it): the expected sha256 of each profile, the scratch, members and home roots, the denied paths.
Nothing is read from a folder another process can write except the profile text, and that is used only if it hashes
to what main said, then handed to ``sandbox-exec -p`` from memory (no window between the check and the use).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import shlex
import socket
import stat as stat_mod
import struct
import subprocess
import sys
import threading
import time
import unicodedata
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


def disk_fold(name: str) -> str:
    """Same as agent/disk_name.py, which this stdlib-only module cannot import: the launcher loads it by path."""
    return unicodedata.normalize("NFD", unicodedata.normalize("NFD", name).casefold())

ACTIVITY_CLASSES = ("research", "project", "build", "offline", "media")
SANDBOX_EXEC = "/usr/bin/sandbox-exec"
MARKER_PREFIX = "iclone-confined"
# Who issued a confined command, said to the launcher in the request's environment (never the command's: the launcher
# drops the variable before the command starts). The plugin sets it for the runtime's own housekeeping — the programs
# it runs to learn about the host, the environment it builds only to probe a backend — and the launcher adds the shell
# environment's own scripts (the session snapshot and its probes, which never come through Hermes' command wrapper).
ORIGIN_ENV = "ICLONE_RUN_ORIGIN"
ORIGIN_AGENT = "agent"
ORIGIN_RUNTIME = "runtime"
# The environment Hermes builds only to learn a backend's facts for the system prompt (agent/prompt_builder.py
# ``_run_backend_probe``): every command it runs is the runtime's own.
RUNTIME_PROBE_TASK_IDS = frozenset({"prompt-backend-probe"})
_SESSION_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


def runtime_own_call() -> bool:
    """Whether the backend call under way is one Hermes issues for itself, by the runtime's own word at the call
    (``hermes_cli.observability.shared_metrics_loop.unmetered_backend_calls``: the TUI gateway's directory listing for
    path completion, run in the session's environment each turn). Said to the launcher like a probe's command
    (``ORIGIN_ENV``), never read off the command's text. A runtime without that word has no such calls."""
    try:
        from hermes_cli.observability.shared_metrics_loop import backend_calls_unmetered
    except ImportError:
        return False
    return backend_calls_unmetered()


# The run-refusal codes the app's ledger knows (``RunRefusalCode`` in the app's shared confinement types).
REFUSAL_CODES = frozenset({"bad-request", "cwd-spelling", "cwd-gone", "cannot-scan", "hard-links", "launcher-unavailable", "no-profile",
                           "profile-unknown", "other"})
# The closing block of every generated profile: a program's widening goes right before it, so it never outranks it.
NEVER_MARK = "; never, whatever the class or the permission mode"


class ConfinementRefused(RuntimeError):
    """The layer cannot confine this command: it is refused, never run unconfined. ``code`` says why, in the ledger's
    words (``REFUSAL_CODES``)."""

    def __init__(self, message: str = "", code: str = "other"):
        super().__init__(message)
        self.code = code if code in REFUSAL_CODES else "other"


@dataclass(frozen=True)
class Profile:
    cls: str
    file: str
    sha256: str


@dataclass(frozen=True)
class ProfileIndex:
    profiles: Dict[str, Profile]
    scratch_root: str
    home: str
    denied: List[str]
    members_dir: str
    hardlink_acks: str = ""
    hardlink_report: str = ""
    refusals_dir: str = ""
    # T2'': the pnpm store roots a ``build`` command may be linked into without a gesture (main names them).
    pnpm_store_roots: Tuple[str, ...] = ()
    # fx7: never written by any class, never a project root or around one (main's profiles.ts protectedWrites).
    protected_writes: Tuple[str, ...] = ()
    # G8 (R1): the tool store main named (Hermes' PM store, <hermes home>/tools), where a real install keeps agent-browser.
    tool_store_roots: Tuple[str, ...] = ()
    # G23: what holds the confinement itself and the one-file route's own ledger (main's profiles.ts appOwnFiles).
    app_files: Tuple[str, ...] = ()


_trusted_spec = ""
_link_key = b""


def trust_spec(raw: str) -> None:
    """Called once, at import, with the spec popped from the env main spawned Hermes with."""
    global _trusted_spec
    _trusted_spec = raw


_git_identity: Tuple[str, str] = ("", "")


def trust_git_identity(name: str, email: str) -> None:
    """Called once, at import, with the two values main read from the user's own git config (``user.name`` and
    ``user.email``; popped from the env, so no child inherits them). fx18 (F3): a confined ``git commit`` takes the
    user's identity from them, and nothing else of ``~/.gitconfig``, which may hold credentials, reaches the agent."""
    global _git_identity
    clean = tuple(v.replace("\n", " ").replace("\r", " ").strip() if isinstance(v, str) else "" for v in (name, email))
    _git_identity = (clean[0], clean[1])


def git_identity() -> Tuple[str, str]:
    return _git_identity


def _git_config_quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def seed_scratch_git_config(scratch: str) -> Optional[str]:
    """The session's own global git config (``GIT_CONFIG_GLOBAL`` points here): written once, with the user's
    ``user.name`` and ``user.email`` and nothing else, when the scratch has none yet. A file already there is the
    agent's (its own ``git config --global`` lands in it) and is kept. Returns the path, or ``None`` with no identity."""
    name, email = git_identity()
    path = os.path.join(scratch, ".gitconfig")
    if not (name or email):
        return None
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    except FileExistsError:
        return path
    except OSError:
        return None
    lines = ["[user]"]
    if name:
        lines.append(f"\tname = {_git_config_quote(name)}")
    if email:
        lines.append(f"\temail = {_git_config_quote(email)}")
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    return path


def trust_link_key(raw_hex: str) -> None:
    """Called once, at import, with the key main signs the owner's hard-link acknowledgements with (popped)."""
    global _link_key
    try:
        _link_key = bytes.fromhex(raw_hex) if len(raw_hex) == 64 else b""
    except ValueError:
        _link_key = b""


def trusted_index() -> ProfileIndex:
    return parse_spec(_trusted_spec)


def parse_spec(raw: str) -> ProfileIndex:
    """The spec main generated (backend-seatbelt.ts ``pluginSpec``). Anything missing or malformed refuses."""
    try:
        spec = json.loads(raw)
        profiles_dir = str(spec["profilesDir"])
        profiles = {
            cls: Profile(cls, os.path.join(profiles_dir, f"{cls}.sb"), str(sha))
            for cls, sha in (spec.get("sha256") or {}).items()
            if cls in ACTIVITY_CLASSES and re.fullmatch(r"[0-9a-f]{64}", str(sha))
        }
        index = ProfileIndex(profiles, str(spec["scratchRoot"]), str(spec["home"]),
                             [str(p) for p in spec.get("denied") or []], str(spec["membersDir"]),
                             str(spec.get("hardlinkAcks") or ""), str(spec.get("hardlinkReport") or ""),
                             str(spec.get("refusalsDir") or ""),
                             # r5: the roots are trusted from spec v5 on (main filters the denied directories there);
                             # an older main's roots are ignored and every link keeps the gesture path.
                             tuple(str(p) for p in spec.get("pnpmStoreRoots") or []
                                   if os.path.isabs(str(p)) and int(spec.get("v") or 0) >= 5),
                             tuple(str(p) for p in spec.get("protectedWrites") or [] if os.path.isabs(str(p))),
                             tuple(str(p) for p in spec.get("toolStoreRoots") or [] if os.path.isabs(str(p))),
                             tuple(str(p) for p in spec.get("appFiles") or [] if os.path.isabs(str(p))))
    except (ValueError, KeyError, TypeError, AttributeError) as exc:
        raise ConfinementRefused(f"main did not hand over the confinement spec ({exc}); commands are refused") from exc
    if not all(os.path.isabs(p) for p in (index.scratch_root, index.home, index.members_dir)):
        raise ConfinementRefused("the confinement spec names a relative root; commands are refused")
    return index


def read_verified(profile: Profile) -> str:
    """The profile text, only if it hashes to what main handed over at spawn (a changed file is refused, not run)."""
    try:
        with open(profile.file, "r", encoding="utf-8") as handle:
            text = handle.read()
    except OSError as exc:
        raise ConfinementRefused(f"profile {profile.cls} is unreadable: {exc}", "no-profile") from exc
    if hashlib.sha256(text.encode("utf-8")).hexdigest() != profile.sha256:
        raise ConfinementRefused(f"profile {profile.cls}.sb changed on disk; refusing to run under it", "no-profile")
    return text


def new_run_token(index: ProfileIndex, cls: str, sha256: str, session_id: Optional[str]) -> str:
    """An empty file only this run's sandbox may read (members.ts): how main finds every process of the run."""
    os.makedirs(index.members_dir, mode=0o700, exist_ok=True)
    # fx28: only made when absent: the runtime's profile lets it create a file here and never open one for writing.
    for name in (".member", ".decoy"):
        try:
            os.close(os.open(os.path.join(index.members_dir, name), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
        except FileExistsError:
            pass
    session = session_id if session_id and _SESSION_RE.match(session_id) else "-"
    path = os.path.join(os.path.realpath(index.members_dir), f"{cls}+{sha256[:12]}+{session}+{secrets.token_hex(16)}")
    os.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
    return path


ACK_REASON_MAX = 400


def ack_file_of(path: str, pid: int) -> str:
    """G22 B1: each runtime process has its own acknowledgement beside the path main named (``hermes-ack.<pid>.json``):
    the window's runtime and a profile's runtime are alive together, and main judges each by its own word."""
    stem, ext = os.path.splitext(path)
    return f"{stem}.{pid}{ext}"


def write_ack(path: str, backend: str, commands: Optional[Tuple[bool, str]] = None, note: str = "") -> None:
    """Tells main this Hermes loaded the plugin (the pane reads RED while Hermes runs without it) and, when known,
    whether the agent's commands can run now (``commands``: available, and the plain reason when they cannot). The
    availability is the runtime's own word: main may only turn the verdict red on it, never green. ``note`` is said
    in the pane and decides nothing."""
    if not path or not os.path.isabs(path):
        return
    path = ack_file_of(path, os.getpid())
    body: Dict[str, Any] = {"v": 2, "pid": os.getpid(), "backend": backend}
    if commands is not None:
        available, reason = commands
        body["commands"] = {"available": bool(available), "reason": "" if available else str(reason)[:ACK_REASON_MAX]}
        if note:
            body["commands"]["note"] = str(note)[:ACK_REASON_MAX]
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(body, handle)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


# Where this process acknowledges the plugin, and what it last said about the agent's commands: the acknowledgement is
# rewritten only when that answer changes (every tool listing asks it). One per process: a routed copy of this plugin
# neither clears nor sets the launch copy's word.
def _process_ack() -> Tuple[Dict[str, Any], Any]:
    from hermes_cli.iclone_policy_env import process_ack  # not at import: the launcher loads this module without hermes_cli

    return process_ack()


def arm_ack(path: str, backend: str) -> bool:
    """Called at register, with the acknowledgement file main named and the backend main chose. True for the first
    copy of the process; a later copy changes nothing."""
    state, lock = _process_ack()
    with lock:
        if state["path"]:
            return False
        state.update(path=path, backend=backend, said=None)
        return True


def note_config_unreadable(reason: str) -> None:
    """A config.yaml that cannot be parsed: said with the next answer, until a restart reads it again. Commands still
    run in the sandbox: only a terminal.backend in the file went unread. A note, never a refusal."""
    _process_ack()[0]["config"] = str(reason)


def report_commands(available: bool, reason: str = "") -> None:
    """The acknowledgement carries this answer from now on (rewritten when it changed). Never raises. A refused backend
    answers first: the sandbox being ready says nothing about a process whose every tool refuses."""
    from hermes_cli.iclone_policy_env import refused_backend

    standing = refused_backend()
    if standing:
        available, reason = False, standing
    state, lock = _process_ack()
    note = str(state.get("config") or "")
    said = (bool(available), "" if available else str(reason)[:ACK_REASON_MAX], note)
    with lock:
        if not state["path"] or state["said"] == said:
            return
        try:
            write_ack(state["path"], state["backend"], said[:2], note)
            state["said"] = said
        except OSError:
            logger.warning("could not tell the app whether agent commands can run", exc_info=True)


def _within(child: str, parent: str) -> bool:
    return child == parent or child.startswith(parent.rstrip(os.sep) + os.sep)


def _walk_ceilings() -> list:
    """K-RT9 (same rule as iclone-permissions ``project_root``): the home folder, HERMES_HOME, the runtime root."""
    home = os.path.expanduser("~")
    raws = (os.environ.get("HOME") or home, os.environ.get("HERMES_HOME") or os.path.join(home, ".hermes"),
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    out = []
    for raw in raws:
        try:
            out.append(os.path.realpath(os.path.expanduser(raw)))
        except OSError:
            continue
    return out


def git_root(directory: str) -> Optional[str]:
    """V3-F's project rule: the realpath of the git root above ``directory``, else ``directory`` itself. The walk never
    reaches the home folder or goes above HERMES_HOME or the runtime root (K-RT9)."""
    try:
        here = os.path.realpath(directory)
    except OSError:
        return None
    ceilings = _walk_ceilings()
    home = ceilings[0] if ceilings else None
    bounds = [c for c in ceilings if _within(here, c)]
    at = here
    while True:
        above = any(at != c and _within(c, at) for c in bounds)
        if above or (at != here and at == home and _within(here, home)):
            return here
        if os.path.exists(os.path.join(at, ".git")):
            return at
        parent = os.path.dirname(at)
        if parent == at:
            return here
        at = parent


def _folder_identity(path: str) -> Optional[Tuple[int, int]]:
    """A folder's identity: ``(st_dev, st_ino)`` of what ``path`` names (symlinks followed), or None."""
    try:
        st = os.stat(path)
    except (OSError, ValueError):
        return None
    return st.st_dev, st.st_ino


def _inside_folder(child: str, parent: str) -> bool:
    """r6 (INFO-1): ``child`` is ``parent`` or lies inside it — by real path, or by folder identity, so an alias of the
    same folder (the firmlink ``/System/Volumes/Data/…`` form, a case variant) is the same folder. A path that does not
    exist is judged by its string alone (mirrors profiles.ts ``insideFolder``)."""
    real_child = os.path.realpath(child)
    if _within(real_child, os.path.realpath(parent)):
        return True
    target = _folder_identity(parent)
    if target is None:
        return False
    at = real_child
    while True:
        if _folder_identity(at) == target:
            return True
        up = os.path.dirname(at)
        if up == at:
            return False
        at = up


def project_git_state(project: str, scratch: str) -> str:
    """``unborn`` lifts the profile's rule on the project's own ``.git`` for one run: it has none yet, so git init can
    write one. A scratch folder standing in for a project is nobody's repository. Anything unsure is ``locked``."""
    if project == scratch:
        return "unborn"
    try:
        os.lstat(os.path.join(project, ".git"))
    except FileNotFoundError:
        return "unborn"
    except OSError:
        return "locked"
    return "locked"


def project_root_refusal(root: Optional[str], index: ProfileIndex) -> Optional[str]:
    """Why ``root`` may not be a project (``None`` when it may): the one rule behind ``acceptable_project_root``,
    worded for the agent (fx18: a command whose folder is refused is told which rule refused it, never a bare EPERM).
    Mirrors profiles.ts acceptableProjectRoot: never /, the home or an ancestor, ~/Library, or a denied dir; r6: nor
    a pnpm store root or a folder inside one (a store is never a project). fx7: nor a folder the user's own shell or
    tools later run from — a ``.git`` folder (its hooks), a shell startup file, a binary folder on PATH (the spec's
    ``protectedWrites``) — at, inside or around the root. Folders compare by identity too."""
    if not root or not os.path.isabs(root):
        return "it is not an absolute path"
    real = os.path.realpath(root)
    home = os.path.realpath(index.home)
    if real == os.sep or _inside_folder(home, real):
        return "it is your home folder or a folder above it"
    if _inside_folder(real, os.path.join(home, "Library")):
        return "it is inside ~/Library"
    if ".git" in disk_fold(real).split(os.sep):
        return "it is inside a .git folder"
    if any(_inside_folder(real, store) for store in index.pnpm_store_roots):
        return "it is a package store, never a project"
    if any(_within(real, p) or _within(p, real) or _inside_folder(real, p) or _inside_folder(p, real)
           for p in index.protected_writes):
        return "it is, holds or sits inside a folder your own shell or tools run from"
    if any(_inside_folder(real, denied) or _inside_folder(denied, real) for denied in index.denied):
        return "it is, holds or sits inside a folder icloneOS denies every command"
    return None


def acceptable_project_root(root: Optional[str], index: ProfileIndex) -> bool:
    """True when ``project_root_refusal`` finds no rule against ``root``."""
    return project_root_refusal(root, index) is None


def marker(cls: str, sha256: str, session_id: Optional[str]) -> str:
    session = session_id if session_id and _SESSION_RE.match(session_id) else "-"
    return f"{MARKER_PREFIX}:{cls}:{sha256[:12]}:{session}"


def scratch_dir(index: ProfileIndex, key: str) -> str:
    name = key if key and _SESSION_RE.match(key) else "default"
    path = os.path.join(index.scratch_root, name)
    os.makedirs(os.path.join(path, "tmp"), mode=0o700, exist_ok=True)
    return os.path.realpath(path)


def _permissions_module() -> Optional[Any]:
    """The loaded V3-F plugin (consumed, never edited): its signed policy and its ``decide``."""
    for name, module in list(sys.modules.items()):
        state = getattr(module, "_state", None)
        if name.endswith("iclone_permissions") and isinstance(state, dict) and "policy" in state:
            return module
    return None


def grant_params(session_id: Optional[str], project: Optional[str], window: Optional[str] = None) -> Dict[str, str]:
    """NET and WRITE_PROJECT for one command, from V3-F's table and live grants.

    NET opens only on an *allow* for class N (the mode allows the network, or a live grant covers it): an ask never
    opens a socket mid-command. WRITE_PROJECT holds unless class Wp is *refused* (Plan mode, the file-writing switch
    OFF): the owner already allowed the shell command itself. Without V3-F there is no policy, and no policy opens
    nothing: no network, no project writes (fx7 — the launcher reads the same answer from main's own copy of the
    policy and refuses a request that asks for more, so a runtime that skipped this function gains nothing).
    """
    module = _permissions_module()
    policy_mod = sys.modules.get(f"{module.__name__}.policy") if module is not None else None
    if module is None or policy_mod is None:
        return {"NET": "0", "WRITE_PROJECT": "0"}
    body = module._state["policy"].body()
    net = policy_mod.decide(body, cls="N", facts={}, floor=None, ceiling_key=None, session_id=session_id, project=project,
                          mode_project=project if window is None else window)
    write = policy_mod.decide(body, cls="Wp", facts={}, floor=None, ceiling_key=None, session_id=session_id, project=project,
                            mode_project=project if window is None else window)
    return {"NET": "1" if net.outcome == "allow" else "0", "WRITE_PROJECT": "0" if write.outcome == "refuse" else "1"}


# --- F7: hard links into the project (mirrors electron/iclone-confinement/hardlinks.ts) -------------------------------
#
# Seatbelt judges a path, not an inode: a name inside the project for an inode outside it is read and written under
# the project's rules. The profile refuses to make one (``deny file-link``); this finds the ones that exist before a
# command starts. An inode matters only when a name lies outside the root (``st_nlink`` > names found inside). The full
# scan stats every file, so it is cached per root behind a fingerprint (every directory's inode, mtime and ctime, the
# file count): planting a name anywhere moves its directory's ctime, which no user call can set back, so a planted link
# always misses the cache.
#
# Fail closed (r3 T1): a directory inside the root that cannot be listed hides what it holds, while a process needs
# only ``x`` to traverse it; such a root is refused ("cannot scan") until its permissions are fixed. The same for a
# directory that lists but whose children cannot be stat-ed (r4 T1': ``r`` without ``x``, ``chmod 400``/``600``): the
# names are seen, the link counts are not, and a confined writer can give ``x`` back and read through the link. Only
# ENOENT (a name that vanished between two steps) is nothing to scan; any other error on a directory or on one of its
# children makes that directory unscannable. The scratch dir is scanned like the project (T1, MINOR-2).

#
# The one auto-pass (r4 T2'') is for the ``build`` class alone: a link whose every other name resolves, by inode, to a
# file inside the pnpm store roots main named is the store's own content and runs without a gesture. Every name must
# be accounted for (inside the project or inside the store): a third name elsewhere still asks. One walk of the store
# roots under a budget; past it, or on any error, nothing is passed and the gesture stands.

HARDLINK_PATHS_SHOWN = 3
_CACHE_MAX_AGE_S = 300.0
_STORE_BUDGET_S = 1.0
_STORE_AUTO_PASS_CLASS = "build"
# Per root: [fingerprint, measured_at, linked, files, unscannable, store_passed] (the last is None until a ``build``
# command asked, T2''; it lives and dies with the scan it was computed over, as in hardlinks.ts).
_scan_cache: Dict[str, List[Any]] = {}


class ScanTooLarge(OSError):
    """fx20 (lens5 M1): the walk ran past the caller's time budget. An ``OSError``, so the after-run scan records its
    root as one it could not scan; before a command the caller refuses, naming the size as the reason."""


def _walk(root: str, stat_files: bool, deadline: Optional[float] = None) -> Tuple[str, int, List[Dict[str, Any]], List[str]]:
    fingerprint: List[str] = []
    by_inode: Dict[Tuple[int, int], Dict[str, Any]] = {}
    unscannable: List[str] = []
    stack = [root]
    files = 0
    while stack:
        if deadline is not None and time.monotonic() > deadline:
            raise ScanTooLarge(root)
        directory = stack.pop()
        rel = os.path.relpath(directory, root)
        try:
            st = os.lstat(directory)
            fingerprint.append(f"{rel}\0{st.st_ino}\0{st.st_mtime_ns}\0{st.st_ctime_ns}")
            folder = f"{st.st_dev}:{st.st_ino}"
            entries = list(os.scandir(directory))
        except FileNotFoundError:
            # Gone since its parent was listed: nothing is hidden there.
            continue
        except OSError:
            # Unlistable is not unreadable: whatever it holds is reachable and unseen. Refused (T1).
            fingerprint.append(f"{rel}\0unscannable")
            unscannable.append(directory)
            continue
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    stack.append(entry.path)
                    continue
                files += 1
                if not stat_files or not entry.is_file(follow_symlinks=False):
                    continue
                st = entry.stat(follow_symlinks=False)
            except FileNotFoundError:
                # Gone between the listing and the stat: nothing is there.
                continue
            except OSError:
                # EACCES on a ``chmod 400`` directory, EPERM, ELOOP, EIO…: this child's link count is hidden, and so
                # is the whole directory (T1'): refused. Its subdirectories stay on the stack and report themselves
                # (they cannot be listed either), in both walks alike, so the cached answer stays this refusal.
                unscannable.append(directory)
                break
            if st.st_nlink > 1 and stat_mod.S_ISREG(st.st_mode):
                inode = by_inode.setdefault((st.st_dev, st.st_ino), {"dev": st.st_dev, "ino": st.st_ino, "nlink": st.st_nlink,
                                                                     "paths": [], "names": []})
                inode["paths"].append(entry.path)
                # r6: the name as an identity (the holding folder's dev:ino, the name), shared with the store walk.
                inode["names"].append(f"{folder}/{entry.name}")
    fingerprint.sort()
    fingerprint.append(f"files\0{files}")
    linked = sorted(
        ({**inode, "paths": sorted(inode["paths"])} for inode in by_inode.values() if len(inode["paths"]) < inode["nlink"]),
        key=lambda inode: inode["paths"][0],
    )
    return "\n".join(fingerprint), files, linked, sorted(unscannable)


def linked_inodes(root: str, now: Optional[float] = None,
                  deadline: Optional[float] = None) -> Tuple[List[Dict[str, Any]], bool, List[str]]:
    """The inodes under ``root`` with a name outside it, whether the answer came from the cache, and the directories
    inside it that could not be listed (T1: any of them refuses the root)."""
    at = time.monotonic() if now is None else now
    hit = _scan_cache.get(root)
    if hit and at - hit[1] < _CACHE_MAX_AGE_S and _walk(root, False, deadline)[0] == hit[0]:
        return hit[2], True, hit[4]
    fingerprint, files, linked, unscannable = _walk(root, True, deadline)
    _scan_cache[root] = [fingerprint, at, linked, files, unscannable, None]
    return linked, False, unscannable


def real_store_root(root: str) -> bool:
    """r5 MAJOR-1'': a store root the walk may use is a real directory (``lstat``: a symlink is never one) whose real
    path is itself (nothing above it is a symlink either). A root that is, or lies under, a symlink is whatever it
    points at — ``~/.hermes`` after one ``ln -s`` — and not the store: ignored, the gesture stands. Checked here,
    where the root is walked, whatever the spec said."""
    try:
        return stat_mod.S_ISDIR(os.lstat(root).st_mode) and os.path.realpath(root) == root
    except OSError:
        return False


_STORE_VERSION_DIR = re.compile(r"v\d+")


def store_shaped(root: str) -> bool:
    """r5 MINOR-2: the pnpm store's own layout — ``<root>/store/v<N>`` present as a real directory under a real
    ``store``, or the root itself named ``…/store/v<N>``. A directory without it (``~/.ssh``, ``/tmp``, an empty
    folder) is no store, whatever ``$PNPM_HOME`` says. Not a boundary on its own: ``real_store_root`` is."""
    if re.search(r"/store/v\d+$", root):
        return True
    try:
        store = os.path.join(root, "store")
        return stat_mod.S_ISDIR(os.lstat(store).st_mode) and any(
            _STORE_VERSION_DIR.fullmatch(entry.name) and entry.is_dir(follow_symlinks=False)
            for entry in os.scandir(store))
    except OSError:
        return False


def _store_walk_roots(roots: Tuple[str, ...]) -> List[str]:
    """r6: the roots one resolve walks — real, store-shaped, each once; a root inside another walked root is dropped."""
    valid = [root for root in dict.fromkeys(roots) if real_store_root(root) and store_shaped(root)]
    return [root for root in valid if not any(other != root and _within(root, other) for other in valid)]


def _list_folder(directory: str) -> Optional[Tuple[str, List[Tuple[str, bool, Optional[os.stat_result]]]]]:
    """One store folder, opened without following a symlink and listed through that descriptor (INFO-2: a folder
    swapped for a symlink after its parent was listed is not entered): its identity and, per entry, the name, whether
    it is a real directory, and the ``lstat`` of a regular file (None when it is neither or gone). None: no names."""
    try:
        before = os.lstat(directory)
        if not stat_mod.S_ISDIR(before.st_mode):
            return None
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        return None
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            return None
        rows: List[Tuple[str, bool, Optional[os.stat_result]]] = []
        with os.scandir(fd) as listing:
            for entry in listing:
                try:
                    if entry.is_dir(follow_symlinks=False):
                        rows.append((entry.name, True, None))
                    elif entry.is_file(follow_symlinks=False):
                        rows.append((entry.name, False, entry.stat(follow_symlinks=False)))
                except OSError:
                    continue
        return f"{opened.st_dev}:{opened.st_ino}", rows
    except OSError:
        return None
    finally:
        os.close(fd)


def resolve_in_store(roots: Tuple[str, ...], wanted: List[Dict[str, Any]], budget_s: float = _STORE_BUDGET_S,
                     now: Optional[float] = None) -> Tuple[frozenset, int, float, bool]:
    """T2'': the ``(dev, ino)`` of every wanted inode whose names are all accounted for; the files walked, the seconds
    spent, whether the budget ran out (then nothing passes). r6 (MAJOR-1‴): the SET of an inode's names — the
    project's united with the store's, each a folder identity plus a name — must have exactly ``st_nlink`` members;
    counts are never added. A folder is walked at most once by ``(dev, ino)`` (nested roots, a project that is or
    holds the store, an alias), so no name is met twice, and every member lies in the project or a store root by
    construction. A store directory that cannot be read resolves nothing. Only a real root with the store's layout is
    walked (``real_store_root``, ``store_shaped``), and a symlinked directory under it is never entered."""
    started = time.monotonic() if now is None else now
    names: Dict[Tuple[int, int], set] = {(inode["dev"], inode["ino"]): set(inode["names"]) for inode in wanted}
    visited: set = set()
    files = 0
    timed_out = False
    for root in _store_walk_roots(roots):
        stack = [root]
        while stack and not timed_out:
            directory = stack.pop()
            try:
                st = os.lstat(directory)
            except OSError:
                continue
            if (st.st_dev, st.st_ino) in visited:
                continue
            visited.add((st.st_dev, st.st_ino))
            listed = _list_folder(directory)
            if listed is None:
                continue
            folder, rows = listed
            for name, is_dir, entry_stat in rows:
                if is_dir:
                    stack.append(os.path.join(directory, name))
                    continue
                if entry_stat is None:
                    continue
                files += 1
                if files & 255 == 0 and time.monotonic() - started > budget_s:
                    timed_out = True
                    break
                found = names.get((entry_stat.st_dev, entry_stat.st_ino))
                if found is not None:
                    found.add(f"{folder}/{name}")
        if timed_out:
            break
    # A walk that finished past the budget is past the budget: the bound is on the whole resolve.
    timed_out = timed_out or time.monotonic() - started > budget_s
    passed = frozenset() if timed_out else frozenset(
        (inode["dev"], inode["ino"]) for inode in wanted
        if len(names[(inode["dev"], inode["ino"])]) == inode["nlink"])
    return passed, files, time.monotonic() - started, timed_out


def _store_passed(index: ProfileIndex, root: str, open_inodes: List[Dict[str, Any]], cls: Optional[str]) -> frozenset:
    """The store-resolved inodes of ``root`` for a ``build`` command (T2''), computed once per measured tree and kept
    with that scan (``linked_inodes`` ran just before, so the entry exists)."""
    # r5 MINOR-2: a root inside a denied directory, or holding one, is no store (main filters the same way).
    # r6: by folder identity as well as by path (an alias of a denied folder is that folder, INFO-1).
    roots = tuple(r for r in index.pnpm_store_roots
                  if not any(_inside_folder(r, d) or _inside_folder(d, r) for d in index.denied))
    if cls != _STORE_AUTO_PASS_CLASS or not roots or not open_inodes:
        return frozenset()
    entry = _scan_cache.get(root)
    if entry is None:
        return frozenset()
    if entry[5] is None:
        entry[5] = resolve_in_store(roots, open_inodes)[0]
    return entry[5]


def verified_acks(index: ProfileIndex) -> List[Dict[str, Any]]:
    """The owner's acknowledgements, only if main's signature verifies (a forged or stale file allows nothing)."""
    if not _link_key or not index.hardlink_acks:
        return []
    try:
        with open(index.hardlink_acks, "r", encoding="utf-8") as handle:
            signed = json.load(handle)
        body = str(signed["body"])
        expected = hmac.new(_link_key, body.encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, str(signed["sig"])):
            logger.warning("hard-link acknowledgements do not verify; none is trusted")
            return []
        acks = json.loads(body).get("acks") or []
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return []
    return [ack for ack in acks if isinstance(ack, dict)]


def _report(index: ProfileIndex, root: str, block: Optional[Dict[str, Any]]) -> None:
    """Tells main's pane which project was refused (display only: main re-checks a file before it is acknowledged)."""
    if not index.hardlink_report or not os.path.isabs(index.hardlink_report):
        return
    try:
        with open(index.hardlink_report, "r", encoding="utf-8") as handle:
            report = json.load(handle)
        blocked = report.get("blocked") if isinstance(report, dict) else None
        blocked = blocked if isinstance(blocked, dict) else {}
    except (OSError, ValueError):
        blocked = {}
    if block is None and root not in blocked:
        return
    if block is None:
        blocked.pop(root, None)
    else:
        blocked[root] = block
    os.makedirs(os.path.dirname(index.hardlink_report), mode=0o700, exist_ok=True)
    tmp = f"{index.hardlink_report}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump({"v": 1, "blocked": blocked}, handle)
    os.chmod(tmp, 0o600)
    os.replace(tmp, index.hardlink_report)


def refusal_sentence(root: str, paths: List[str], count: int, kind: str = "hard-links") -> str:
    more = f" and {count - len(paths)} more" if count > len(paths) else ""
    if kind == "cannot-scan":
        what, whose = ("a directory", "its") if count == 1 else ("directories", "their")
        return f"confinement refused to start in {root}: cannot scan {', '.join(paths)}{more} ({what} it cannot list); fix {whose} permissions"
    verb, pronoun = ("is a hard link", "it") if count == 1 else ("are hard links", "them")
    return (f"confinement refused to start in {root}: {', '.join(paths)}{more} {verb} to a file outside the project; "
            f"remove {pronoun} or allow {pronoun} in Containers")


def _open_block(index: ProfileIndex, root: str, cls: Optional[str] = None,
                deadline: Optional[float] = None) -> Optional[Dict[str, Any]]:
    """What refuses ``root`` right now: ``{"kind", "paths", "count"}`` or ``None`` when it is clean. ``cls`` is the
    command's class: ``build`` alone may pass a link whose other names all resolve into the pnpm store (T2'')."""
    linked, _cached, unscannable = linked_inodes(root, deadline=deadline)
    if unscannable:
        return {"kind": "cannot-scan", "paths": unscannable[:HARDLINK_PATHS_SHOWN], "count": len(unscannable)}
    acks = verified_acks(index) if linked else []
    allowed = {(ack.get("dev"), ack.get("ino")) for ack in acks if ack.get("root") == root}
    open_inodes = [inode for inode in linked if (inode["dev"], inode["ino"]) not in allowed]
    passed = _store_passed(index, root, open_inodes, cls)
    open_inodes = [inode for inode in open_inodes if (inode["dev"], inode["ino"]) not in passed]
    if not open_inodes:
        return None
    return {"kind": "hard-links", "paths": [inode["paths"][0] for inode in open_inodes[:HARDLINK_PATHS_SHOWN]],
            "count": len(open_inodes)}


def check_hardlinks(index: ProfileIndex, root: str, cls: Optional[str] = None, deadline: Optional[float] = None) -> None:
    """Before a command in ``root``: refuses while an inode with a name outside it is not acknowledged by the owner,
    or while a directory inside it cannot be listed. ``ScanTooLarge`` past ``deadline`` (``time.monotonic``)."""
    block = _open_block(index, root, cls, deadline)
    try:
        _report(index, root, block)
    except OSError:
        logger.warning("could not tell the app which project was refused", exc_info=True)
    if block:
        raise ConfinementRefused(refusal_sentence(root, block["paths"], block["count"], block["kind"]), block["kind"])


def _refusal_row(index: ProfileIndex, row: Dict[str, Any]) -> None:
    """One line in main's refusal record (``userData/confinement/refusals/<UTC day>.jsonl``, refusals.ts)."""
    if not index.refusals_dir or not os.path.isabs(index.refusals_dir):
        return
    os.makedirs(index.refusals_dir, mode=0o700, exist_ok=True)
    path = os.path.join(index.refusals_dir, f"{row['ts'][:10]}.jsonl")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\n")


def check_hardlinks_after_run(index: ProfileIndex, roots: List[str], pid: int, session_id: Optional[str],
                              cls: Optional[str] = None, deadline: Optional[float] = None) -> None:
    """T3: when a confined command exits, scan again. A link planted while it ran was reachable (Seatbelt has no
    inode filter): that cannot be undone, only recorded, as a refusal-class row main's pane says in that run's name.
    The next command in that root is refused by ``check_hardlinks`` like any other."""
    ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + f".{int(time.time() * 1000) % 1000:03d}Z"
    for root in roots:
        try:
            block = _open_block(index, root, cls, deadline)
        except OSError:
            block = {"kind": "cannot-scan", "paths": [root], "count": 1}
        if not block:
            continue
        operation = "hard-link-appeared" if block["kind"] == "hard-links" else "cannot-scan-after-run"
        rest = block["count"] - len(block["paths"])
        targets = block["paths"] + ([f"… and {rest} more under {root}"] if rest > 0 else [])
        for target in targets:
            try:
                _refusal_row(index, {"ts": ts, "pid": pid, "process": "hard-link", "operation": operation,
                                     "target": target, "sessionId": session_id, "root": root})
            except OSError:
                logger.warning("could not record a hard link that appeared during run %s", pid, exc_info=True)


# --- The launcher (runtime confined): every confined command goes through a stub child to the launcher main runs ----

STUB = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "stub.py"))
LAUNCHER_UNREACHABLE = "the launcher is not answering"


def runtime_confined() -> bool:
    """This Hermes runs under its own runtime profile: it cannot apply a profile itself (profiles do not nest), so
    every confined command is handed to the launcher main started outside any sandbox."""
    return os.environ.get("ICLONE_RUNTIME_CONFINED") == "1" and bool(os.environ.get("ICLONE_CONFINEMENT_LAUNCHER"))


LAUNCHER_NOT_NAMED = "the launcher's socket is not named in this runtime's environment"
# The one request that carries no fds: answered at once, never journaled (launcher.py ``PING``).
PING = {"v": 1, "op": "ping"}
PING_TIMEOUT_S = 2.0


def runtime_confinement_requested() -> bool:
    """Main started this Hermes under its runtime profile (whether or not it also named the launcher)."""
    return os.environ.get("ICLONE_RUNTIME_CONFINED") == "1"


def launcher_problem(timeout: float = PING_TIMEOUT_S) -> Optional[str]:
    """None when the launcher answers a ping on its socket now; otherwise the plain reason commands cannot run. Under
    the runtime profile this is what "Seatbelt is here" means: the runtime never execs sandbox-exec itself (it cannot
    even stat it), the launcher does."""
    socket_path = os.environ.get("ICLONE_CONFINEMENT_LAUNCHER", "")
    if not os.path.isabs(socket_path):
        return LAUNCHER_NOT_NAMED
    try:
        if not stat_mod.S_ISSOCK(os.lstat(socket_path).st_mode):
            return LAUNCHER_UNREACHABLE
    except OSError:
        return LAUNCHER_UNREACHABLE
    reply = _ask_launcher(socket_path, PING, timeout)
    if isinstance(reply, dict) and reply.get("ok") is True and reply.get("op") == "pong":
        return None
    return LAUNCHER_UNREACHABLE


def _ask_launcher(socket_path: str, request: Dict[str, Any], timeout: float) -> Any:
    """One request without fds, one answer; None when the launcher does not give one."""
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(timeout)
        sock.connect(socket_path)
        body = json.dumps(request).encode("utf-8")
        sock.sendall(struct.pack(">I", len(body)) + body)
        buffered = b""
        while len(buffered) < 4 or len(buffered) < 4 + struct.unpack(">I", buffered[:4])[0]:
            if len(buffered) >= 4 and struct.unpack(">I", buffered[:4])[0] > 4096:
                return None
            chunk = sock.recv(4096)
            if not chunk:
                return None
            buffered += chunk
        size = struct.unpack(">I", buffered[:4])[0]
        return json.loads(buffered[4:4 + size].decode("utf-8"))
    except (OSError, ValueError):
        return None
    finally:
        sock.close()


# proofaudit row 11: every command is its own sandbox instance and the profile allows a signal only inside one, so from
# the next instance the kernel answers EPERM for a command that lives. The launcher started it and stands outside every
# profile: it says whether this pid is one of its runs' members and ends it, and only those.
BACKGROUND_OP = "background"
BACKGROUND_STOP_TIMEOUT_S = 10.0


def is_background_request(req: Any) -> bool:
    return (isinstance(req, dict) and req.get("v") == 1 and req.get("op") == BACKGROUND_OP
            and type(req.get("pid")) is int and req["pid"] > 1 and type(req.get("stop")) is bool)


def launcher_background(pid: int, stop: bool) -> Dict[str, Any]:
    """The launcher's word on a background command: ``alive``, and after a stop what is ``left``. No answer raises."""
    reply = _ask_launcher(os.environ.get("ICLONE_CONFINEMENT_LAUNCHER", ""),
                          {"v": 1, "op": BACKGROUND_OP, "pid": pid, "stop": stop},
                          BACKGROUND_STOP_TIMEOUT_S if stop else PING_TIMEOUT_S)
    if not isinstance(reply, dict) or reply.get("ok") is not True:
        raise ConfinementRefused(LAUNCHER_UNREACHABLE, "launcher-unreachable")
    return reply


# --- G-98 F42: the hand-off of an owner's answer from the permission hook to the run. Nothing here is authority: a
# one-shot that main did not record is refused by the launcher, and a folder the owner did not allow runs read-only.
ONESHOT_FLAG = "--iclone-oneshot"
ONESHOT_ENV = "ICLONE_ONESHOT_COMMAND"
ONESHOT_BACKGROUND_ENV = "ICLONE_ONESHOT_BACKGROUND"
ONEFILE_FLAG = "--iclone-onefile"
ONEFILE_ENV = "ICLONE_ONEFILE_PATH"
ONEFILE_READ_FLAG = "--iclone-onefile-read"
ONEFILE_SEEN_ENV = "ICLONE_ONEFILE_SEEN"
ONEFILE_SEEN_PARTIAL = "partial"
ONEFILE_TIMEOUT_S = 120.0
_approved_files: Dict[str, float] = {}
_approved_reads: Dict[str, float] = {}
_seen_files: Dict[str, str] = {}
_seen_pages: Dict[str, Tuple[str, int]] = {}  # G27: digest, the next line a whole-file view still needs
# fx23: one quoted word as shlex.quote writes it, and Hermes' background wrapper (process_registry.spawn_via_env), whole.
_QUOTED = r"(?:'[^']*'|\"'\"|[\w@%+=:,./-])+"
BACKGROUND_SHAPE = re.compile(
    rf"mkdir -p (?P<dir>{_QUOTED}); \( trap '' HUP; bash -lc (?P<command>{_QUOTED}) > (?P<log>{_QUOTED}hermes_bg_[\w-]+\.log) 2>&1; "
    rf"rc=\$\?; printf '%s\\n' \"\$rc\" > (?P<exit>{_QUOTED}hermes_bg_[\w-]+\.exit) \) & "
    rf"echo \$! > (?P<pid>{_QUOTED}hermes_bg_[\w-]+\.pid) && cat (?P=pid)")
_HANDOFF_TTL_S = 120.0
_handoff_lock = threading.Lock()
_approved_commands: Dict[str, float] = {}
# F50: one tool call's folder, held in that call's context. The permission gate runs in the call's context, and a tool
# worker gets a copy of it (propagate_context_to_thread), so no other call and no other session can read it. Before this
# it was a table for the whole process, matched on a run's text for 120 s, which moved later commands into the folder.
_approved_folder: "ContextVar[Optional[Tuple[str, float]]]" = ContextVar("iclone_approved_folder", default=None)
# f57: the same value by tool call id, for a worker whose context was copied before the gate ran.
_approved_folder_of_call: Dict[str, Tuple[str, float]] = {}


def _live(table: Dict[str, float], now: float) -> None:
    for key in [k for k, until in table.items() if until <= now]:
        del table[key]


def note_approved_command(command: str) -> None:
    """Main answered that this exact text may run once outside the Seatbelt."""
    now = time.monotonic()
    with _handoff_lock:
        _live(_approved_commands, now)
        _approved_commands[command] = now + _HANDOFF_TTL_S


def take_approved_command(command: str) -> bool:
    """True once, for exactly the text main's answer named, and only where a launcher can run it."""
    now = time.monotonic()
    with _handoff_lock:
        _live(_approved_commands, now)
        return _approved_commands.pop(command, None) is not None and runtime_confined()


def _one_word(quoted: str) -> Optional[str]:
    try:
        words = shlex.split(quoted)
    except ValueError:
        return None
    return words[0] if len(words) == 1 else None


def background_command(text: str) -> Optional[str]:
    """fx23 (proof6 F5): the agent's command inside Hermes' background wrapper, or None. Only the wrapper's exact shape,
    whole, with its own file names: a command with anything else in it is shown as it is, so nothing it does is hidden."""
    match = BACKGROUND_SHAPE.fullmatch(text)
    return _one_word(match.group("command")) if match else None


def background_files_inside(text: str, root: str) -> bool:
    """G2 A4: outside the Seatbelt the wrapper's own redirections have the owner's whole reach, so each of its files must
    be under the scratch folder; the model never picks where they land."""
    match = BACKGROUND_SHAPE.fullmatch(text)
    if not match:
        return False
    real_root = os.path.realpath(root).rstrip(os.sep) + os.sep
    words = [_one_word(match.group(name)) for name in ("dir", "log", "exit", "pid")]
    return all(word and os.path.isabs(word) and os.path.realpath(word).startswith(real_root) for word in words)


ONE_FILE_NOT_PLAIN = "it is a link or a folder, not a file"
ONE_FILE_GRANT = "a grant for its folder does this"
ONE_FILE_LINK_DANGLING = "it is a link whose target does not exist"
ONE_FILE_LINK_OUTSIDE = "it is a link to a place outside your home folder, or to one of this app's own files"


def one_file_refusal(index: Any, path: Any, opened: bool = False) -> Optional[str]:
    """G2 A5, G23 (the owner's ruling: the user has total freedom and takes the responsibility): why this path is not the
    one file main may record for a write outside the Seatbelt, or None. Any exact file under the home that a grant for its
    folder cannot open, keys, shell startup files, browser profiles and ``.git`` included, in its own real spelling, a plain
    file or nothing yet. A folder a grant can open takes the grant. Only this app's own files stay shut, because writing
    them breaks the mechanism in use (``ProfileIndex.app_files``). G23-W2: ``opened``, main's row says this file goes by the
    route though a grant could open its folder: Ignore, or the target of a link the owner's answer named."""
    if not isinstance(path, str) or not path or any(ch in path for ch in "\x00\r\n") or not os.path.isabs(path) \
            or os.path.normpath(path) != path:
        return "it is not one exact path"
    folder = os.path.dirname(path)
    home = os.path.realpath(index.home)
    if os.path.realpath(folder) != folder or not (folder == home or folder.startswith(home + os.sep)):
        return "only a file under your home folder, in its own real spelling, can be allowed this way"
    if any(_holds(own, path) for own in index.app_files):
        return "it is one of this app's own files"
    if not opened and project_root_refusal(folder, index) is None:
        return ONE_FILE_GRANT
    try:
        mode = os.lstat(path).st_mode
    except (FileNotFoundError, PermissionError):  # the runtime's profile may refuse the stat; the launcher's own judge has none
        return None
    except OSError:
        return "that path could not be read"
    return None if stat_mod.S_ISREG(mode) else ONE_FILE_NOT_PLAIN


def one_file_target(index: Any, path: Any, opened: bool = False) -> "tuple[Optional[str], Optional[str]]":
    """G23-W2: ``(the file to write, why not)``. A plain path answers for itself. A link, such as a ``~/.zshrc`` in a dotfiles
    repo, answers with its real target when that is a file under the home and not one of this app's own files. The target may
    sit in a folder a grant could open: the owner's answer names it, so no grant is what stands in the way."""
    why = one_file_refusal(index, path, opened)
    if why != ONE_FILE_NOT_PLAIN:
        return path, why
    try:
        if not stat_mod.S_ISLNK(os.lstat(path).st_mode):
            return None, why
        real = os.path.realpath(path)
        if not stat_mod.S_ISREG(os.stat(real).st_mode):
            return None, ONE_FILE_NOT_PLAIN
    except FileNotFoundError:
        return None, ONE_FILE_LINK_DANGLING
    except OSError:
        return None, "that path could not be read"
    home = os.path.realpath(index.home)
    if not real.startswith(home + os.sep) or any(_holds(own, real) for own in index.app_files):
        return None, ONE_FILE_LINK_OUTSIDE
    why = one_file_refusal(index, real, opened=True)
    return (None, why) if why else (real, None)


def _holds(held: Any, path: str) -> bool:
    """``held`` is this path, or a folder around it, or this path is a folder around it; by case too, as the Mac reads it."""
    lowered, other = disk_fold(path), disk_fold(str(held))
    return lowered == other or lowered.startswith(other.rstrip(os.sep) + os.sep) or other.startswith(lowered + os.sep)


FILE_STAYS_SHUT = ("icloneOS: {path} was not written. It is one of this app's own files, and the file tools leave those alone "
                   "in every mode, because writing them breaks the confinement in use. What works: the terminal tool, with "
                   "the whole command in its text. In Manual the owner reads that text and, on Allow, it runs once outside "
                   "the Seatbelt. In a mode that does not ask it stays confined and is refused too, so ask the owner to "
                   "switch to Manual, or to make the change.")
FILE_LINK_REFUSED = "icloneOS: {path} was not written: {why}. What works: the terminal tool, with the whole command in its text."
FILE_NOT_PLAIN = ("icloneOS: {path} was not written. It is a link or a folder, and one Allow writes one plain file. Write the "
                  "file the link points to, or use the terminal tool, with the whole command in its text.")


def file_stays_shut(index: Any, path: str) -> Optional[str]:
    """G23: the plain sentence for a write that cannot happen, before a confined shell turns it into a raw error. This app's
    own files, except the folders the runtime writes inside them (the scratch folder sits in the app's data). None for
    anything else: the run goes on and the kernel answers."""
    holes = [os.path.realpath(hole) for hole in (index.scratch_root, index.refusals_dir, index.hardlink_acks) if hole]
    if any(_holds(hole, path) for hole in holes):
        return None
    if any(_holds(own, path) for own in index.app_files):
        return FILE_STAYS_SHUT.format(path=path)
    _, why = one_file_target(index, path)
    if why in (ONE_FILE_LINK_DANGLING, ONE_FILE_LINK_OUTSIDE):
        return FILE_LINK_REFUSED.format(path=path, why=why)
    return FILE_NOT_PLAIN.format(path=path) if why == ONE_FILE_NOT_PLAIN else None


def note_approved_file(path: str) -> None:
    """Main answered that this one file may be written once outside the Seatbelt."""
    now = time.monotonic()
    with _handoff_lock:
        _live(_approved_files, now)
        _approved_files[path] = now + _HANDOFF_TTL_S


def approved_file_waiting(path: str) -> bool:
    """Main's answer for this file is here and unspent. Spending it stays with ``take_approved_file``."""
    now = time.monotonic()
    with _handoff_lock:
        _live(_approved_files, now)
        return path in _approved_files and runtime_confined()


def take_approved_file(path: str) -> bool:
    now = time.monotonic()
    with _handoff_lock:
        _live(_approved_files, now)
        return _approved_files.pop(path, None) is not None and runtime_confined()


def note_approved_read(path: str) -> None:
    """G23-W2: main answered that this one file may be read once outside the Seatbelt."""
    now = time.monotonic()
    with _handoff_lock:
        _live(_approved_reads, now)
        _approved_reads[path] = now + _HANDOFF_TTL_S


def approved_read_waiting(path: str) -> bool:
    """G24: main's answer for reading this file is here and unspent. Spending it stays with ``take_approved_read``."""
    now = time.monotonic()
    with _handoff_lock:
        _live(_approved_reads, now)
        return path in _approved_reads and runtime_confined()


def take_approved_read(path: str) -> bool:
    now = time.monotonic()
    with _handoff_lock:
        _live(_approved_reads, now)
        return _approved_reads.pop(path, None) is not None and runtime_confined()


def note_seen_file(path: str, data: bytes) -> None:
    with _handoff_lock:
        _seen_files[path] = hashlib.sha256(data).hexdigest()
        _seen_pages.pop(path, None)


def note_route_view(path: str, digest: str, first: int, last: int, total: int) -> None:
    """G27: what the agent was shown of a route read. Only contiguous pages of one content, up to its last line, license
    a whole-file write. A later page of other bytes starts over; an earlier full view stays until the writer finds a change."""
    with _handoff_lock:
        held, next_line = _seen_pages.get(path) or (digest, 1)
        if held != digest:
            next_line = 1
        if first <= next_line:
            next_line = max(next_line, last + 1)
        if next_line > total:
            _seen_files[path] = digest
            _seen_pages.pop(path, None)
        else:
            _seen_pages[path] = (digest, next_line)


def forget_seen_file(path: str) -> None:
    with _handoff_lock:
        _seen_files.pop(path, None)
        _seen_pages.pop(path, None)


def one_file_seen(path: str) -> Optional[str]:
    """G23-W2: what the writer must find. None when the runtime can stat this file: the file tools' read-before-write rule
    judged it. Where its profile refuses the stat that rule sees no file, so the writer judges: the digest of the content this
    runtime last showed whole or wrote there, ``partial`` after pages that do not reach the end, or ``none``, and an existing
    file is then never overwritten unread."""
    try:
        os.lstat(path)
        return None
    except PermissionError:
        with _handoff_lock:
            return _seen_files.get(path) or (ONEFILE_SEEN_PARTIAL if path in _seen_pages else "none")
    except OSError:
        return None


def _run_one_file(flag: str, path: str, data: bytes, seen: Optional[str] = None) -> "subprocess.CompletedProcess[bytes]":
    """The launcher does it, against main's row: the path in ONEFILE_ENV, any content on the stub's stdin."""
    session = os.environ.get("HERMES_SESSION_ID")
    env = {"PATH": "/usr/bin:/bin", ONEFILE_ENV: path, "ICLONE_RUN_CWD": os.path.dirname(path),
           **({ONEFILE_SEEN_ENV: seen} if seen else {}), **({"HERMES_SESSION_ID": session} if session else {})}
    from tools.environments.host_lane import STUB_FILE  # the runtime's copy: the one form the spawn guard accepts

    argv = via_launcher([SANDBOX_EXEC, flag])
    argv[3] = os.path.realpath(str(STUB_FILE))
    return subprocess.run(argv, input=data, capture_output=True, env=env, timeout=ONEFILE_TIMEOUT_S)


def send_approved_file(path: str, data: bytes, patch_of: Optional[bytes] = None) -> int:
    """``patch_of``: the bytes this patch read, so the writer finds those. The agent saw only its own lines, so a patch keeps
    a whole-file license only where it had one: a later write_file after a blind patch is still a write over the unread."""
    seen = one_file_seen(path)
    base = hashlib.sha256(patch_of).hexdigest() if patch_of is not None else None
    proc = _run_one_file(ONEFILE_FLAG, path, data, base if base and seen is not None else seen)
    if proc.returncode != 0:
        raise ConfinementRefused(proc.stderr.decode("utf-8", "replace").strip() or "the file was not written", "onefile")
    if base is not None and seen != base:
        forget_seen_file(path)
    else:
        note_seen_file(path, data)
    return len(data)


def read_one_file(path: str) -> bytes:
    proc = _run_one_file(ONEFILE_READ_FLAG, path, b"")
    if proc.returncode != 0:
        raise ConfinementRefused(proc.stderr.decode("utf-8", "replace").strip() or "the file was not read", "onefile")
    return proc.stdout


def one_shot_argv() -> List[str]:
    """The stub in its usual form, so the spawn guard reads one shape; the text travels in ONESHOT_ENV, which the
    launcher pops before the command starts."""
    return via_launcher([SANDBOX_EXEC, ONESHOT_FLAG])


def _current_tool_call() -> str:
    """The tool call this thread works for, bound by the executor in the gate's context and in the worker's."""
    try:
        from tools.approval_context import _approval_tool_call_id
        return _approval_tool_call_id.get() or ""
    except Exception:  # noqa: BLE001
        return ""


def note_approved_folder(folder: str, call_id: str = "") -> None:
    """The owner allowed a file tool's write that names this folder: the runs of that one call are made for it.
    f57: the executor may start the worker before the gate answers, so the call's id carries it to that worker."""
    held = (folder, time.monotonic() + _HANDOFF_TTL_S)
    _approved_folder.set(held)
    if call_id:
        with _handoff_lock:
            _live_folders(time.monotonic())
            _approved_folder_of_call[call_id] = held


def forget_approved_folder(call_id: str = "") -> None:
    """A tool call began or ended: what the last one was allowed is not this one's."""
    _approved_folder.set(None)
    if call_id:
        with _handoff_lock:
            _approved_folder_of_call.pop(call_id, None)


def _live_folders(now: float) -> None:
    for key in [k for k, held in _approved_folder_of_call.items() if held[1] <= now]:
        del _approved_folder_of_call[key]


def approved_folder_of(command: str) -> Optional[str]:
    """The folder of this call's approved write, when this run's text names it; the kernel and the launcher still judge it."""
    held = _approved_folder.get()
    if held is None:
        call_id = _current_tool_call()
        with _handoff_lock:
            held = _approved_folder_of_call.get(call_id) if call_id else None
    if held is None or held[1] <= time.monotonic() or held[0] not in command:
        return None
    return held[0]


def mode_label(session_id: Optional[str] = None, project: Optional[str] = None) -> str:
    """The permission mode, by name, for a sentence the agent reads."""
    module = _permissions_module()
    policy_mod = sys.modules.get(f"{module.__name__}.policy") if module is not None else None
    if policy_mod is None:
        return "Manual"
    try:
        verdict = policy_mod.decide(module._state["policy"].body(), cls="R", facts={}, floor=None, ceiling_key=None,
                                    session_id=session_id, project=project)
        return str(verdict.mode or "manual").capitalize()
    except Exception:  # noqa: BLE001 — a sentence never fails a run
        return "Manual"


def via_launcher(sandbox_argv: List[str]) -> List[str]:
    """The argv that starts ``sandbox_argv``: unchanged unless the runtime is confined, then the stub that carries it
    to the launcher. A launcher socket that is not there refuses here, before anything starts."""
    if not runtime_confined():
        return sandbox_argv
    socket_path = os.environ.get("ICLONE_CONFINEMENT_LAUNCHER", "")
    try:
        is_socket = os.path.isabs(socket_path) and stat_mod.S_ISSOCK(os.lstat(socket_path).st_mode)
    except OSError:
        is_socket = False
    if not is_socket:
        raise ConfinementRefused(LAUNCHER_UNREACHABLE, "launcher-unavailable")
    return [sys.executable, "-I", "-S", STUB, socket_path, "--", *sandbox_argv]


def journal_dir() -> str:
    """Where the run journal lives: ``ICLONE_LAUNCHER_JOURNAL_DIR``, else the launcher socket's folder."""
    explicit = os.environ.get("ICLONE_LAUNCHER_JOURNAL_DIR", "")
    if explicit:
        return explicit if os.path.isabs(explicit) else ""
    socket_path = os.environ.get("ICLONE_CONFINEMENT_LAUNCHER", "")
    return os.path.dirname(socket_path) if os.path.isabs(socket_path) else ""


def iso_now() -> str:
    now = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"


def record_refusal(session_id: Optional[str], command: str, exc: BaseException) -> None:
    """One ``refused`` line in ``<journal dir>/refused.jsonl`` for a command the plugin refused before the launcher was
    asked (the launcher journals its own). Only while the runtime is confined; never raises."""
    if not runtime_confined():
        return
    directory = journal_dir()
    if not directory:
        return
    code = getattr(exc, "code", "other") if isinstance(exc, ConfinementRefused) else "other"
    row = {"v": 1, "ev": "refused", "ts": iso_now(),
           "session": session_id if session_id and _SESSION_RE.match(session_id) else None,
           "command": str(command)[:2000], "code": code, "detail": str(exc)[:2000]}
    try:
        os.makedirs(directory, mode=0o700, exist_ok=True)
        fd = os.open(os.path.join(directory, "refused.jsonl"), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, (json.dumps(row) + "\n").encode("utf-8"))
        finally:
            os.close(fd)
    except OSError:
        logger.warning("could not record a refused command", exc_info=True)
