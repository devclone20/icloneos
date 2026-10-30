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
import stat as stat_mod
import sys
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

ACTIVITY_CLASSES = ("research", "project", "build", "offline", "media")
SANDBOX_EXEC = "/usr/bin/sandbox-exec"
MARKER_PREFIX = "iclone-confined"
_SESSION_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


class ConfinementRefused(RuntimeError):
    """The layer cannot confine this command: it is refused, never run unconfined."""


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


_trusted_spec = ""
_link_key = b""


def trust_spec(raw: str) -> None:
    """Called once, at import, with the spec popped from the env main spawned Hermes with."""
    global _trusted_spec
    _trusted_spec = raw


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
                                   if os.path.isabs(str(p)) and int(spec.get("v") or 0) >= 5))
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
        raise ConfinementRefused(f"profile {profile.cls} is unreadable: {exc}") from exc
    if hashlib.sha256(text.encode("utf-8")).hexdigest() != profile.sha256:
        raise ConfinementRefused(f"profile {profile.cls}.sb changed on disk; refusing to run under it")
    return text


def new_run_token(index: ProfileIndex, cls: str, sha256: str, session_id: Optional[str]) -> str:
    """An empty file only this run's sandbox may read (members.ts): how main finds every process of the run."""
    os.makedirs(index.members_dir, mode=0o700, exist_ok=True)
    for name in (".member", ".decoy"):
        with open(os.path.join(index.members_dir, name), "a", encoding="utf-8"):
            pass
    session = session_id if session_id and _SESSION_RE.match(session_id) else "-"
    path = os.path.join(os.path.realpath(index.members_dir), f"{cls}+{sha256[:12]}+{session}+{secrets.token_hex(16)}")
    os.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
    return path


def write_ack(path: str, backend: str) -> None:
    """Tells main this Hermes loaded the plugin (the pane reads RED while Hermes runs without it)."""
    if not path or not os.path.isabs(path):
        return
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump({"pid": os.getpid(), "backend": backend}, handle)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


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


def acceptable_project_root(root: Optional[str], index: ProfileIndex) -> bool:
    """Mirrors profiles.ts acceptableProjectRoot: never /, the home or an ancestor, ~/Library, or a denied dir; r6: nor
    a pnpm store root or a folder inside one (a store is never a project). Folders compare by identity too."""
    if not root or not os.path.isabs(root):
        return False
    real = os.path.realpath(root)
    home = os.path.realpath(index.home)
    if real == os.sep or _inside_folder(home, real) or _inside_folder(real, os.path.join(home, "Library")):
        return False
    if any(_inside_folder(real, store) for store in index.pnpm_store_roots):
        return False
    return not any(_inside_folder(real, denied) or _inside_folder(denied, real) for denied in index.denied)


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


def grant_params(session_id: Optional[str], project: Optional[str]) -> Dict[str, str]:
    """NET and WRITE_PROJECT for one command, from V3-F's table and live grants.

    NET opens only on an *allow* for class N (the mode allows the network, or a live grant covers it): an ask never
    opens a socket mid-command. WRITE_PROJECT holds unless class Wp is *refused* (Plan mode, the file-writing switch
    OFF): the owner already allowed the shell command itself. Without V3-F the strict reading holds: no network.
    """
    module = _permissions_module()
    policy_mod = sys.modules.get(f"{module.__name__}.policy") if module is not None else None
    if module is None or policy_mod is None:
        return {"NET": "0", "WRITE_PROJECT": "1"}
    body = module._state["policy"].body()
    net = policy_mod.decide(body, cls="N", facts={}, floor=None, ceiling_key=None, session_id=session_id, project=project)
    write = policy_mod.decide(body, cls="Wp", facts={}, floor=None, ceiling_key=None, session_id=session_id, project=project)
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


def _walk(root: str, stat_files: bool) -> Tuple[str, int, List[Dict[str, Any]], List[str]]:
    fingerprint: List[str] = []
    by_inode: Dict[Tuple[int, int], Dict[str, Any]] = {}
    unscannable: List[str] = []
    stack = [root]
    files = 0
    while stack:
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


def linked_inodes(root: str, now: Optional[float] = None) -> Tuple[List[Dict[str, Any]], bool, List[str]]:
    """The inodes under ``root`` with a name outside it, whether the answer came from the cache, and the directories
    inside it that could not be listed (T1: any of them refuses the root)."""
    at = time.monotonic() if now is None else now
    hit = _scan_cache.get(root)
    if hit and at - hit[1] < _CACHE_MAX_AGE_S and _walk(root, False)[0] == hit[0]:
        return hit[2], True, hit[4]
    fingerprint, files, linked, unscannable = _walk(root, True)
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


def _open_block(index: ProfileIndex, root: str, cls: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """What refuses ``root`` right now: ``{"kind", "paths", "count"}`` or ``None`` when it is clean. ``cls`` is the
    command's class: ``build`` alone may pass a link whose other names all resolve into the pnpm store (T2'')."""
    linked, _cached, unscannable = linked_inodes(root)
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


def check_hardlinks(index: ProfileIndex, root: str, cls: Optional[str] = None) -> None:
    """Before a command in ``root``: refuses while an inode with a name outside it is not acknowledged by the owner,
    or while a directory inside it cannot be listed."""
    block = _open_block(index, root, cls)
    try:
        _report(index, root, block)
    except OSError:
        logger.warning("could not tell the app which project was refused", exc_info=True)
    if block:
        raise ConfinementRefused(refusal_sentence(root, block["paths"], block["count"], block["kind"]))


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
                              cls: Optional[str] = None) -> None:
    """T3: when a confined command exits, scan again. A link planted while it ran was reachable (Seatbelt has no
    inode filter): that cannot be undone, only recorded, as a refusal-class row main's pane says in that run's name.
    The next command in that root is refused by ``check_hardlinks`` like any other."""
    ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + f".{int(time.time() * 1000) % 1000:03d}Z"
    for root in roots:
        try:
            block = _open_block(index, root, cls)
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
