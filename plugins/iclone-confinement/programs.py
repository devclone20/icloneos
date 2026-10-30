"""V3-UP r5 (ruling 56) — an app-fixed program runs INSIDE the agent's Seatbelt profile.

The spawn allowlist (spawn_sites.json ``fixed``) decides WHICH program a confined Hermes may start; this module decides
HOW: under the verified profile of the activity class its kind maps to, with a fixed widening rendered here and
inserted BEFORE the profile's closing "never" block — so the secrets, the keychain, the app's own state and the
protected paths stay denied whatever the widening says (Seatbelt applies the last matching rule).

Kinds and what each provably needs (measured live, tests/plugins/test_iclone_programs_live.py):

* ``probe`` (research, network off): nothing beyond the profile — plus read/exec of the program's own install when it
  lives in Hermes' managed tool store (``agent-browser --version``).
* ``media`` (media, network never): read of the exact input files, write of the exact output files Hermes hands the
  program (literals; a folder only when Hermes made it fresh for the run's outputs), metadata of their ancestors,
  plus its own install when it is in the store.
* ``browser`` (research, network = the permission mode's grant): agent-browser and its browser —
  read/exec of their own installs; read/write and unix sockets in the session's own browser folder (its TMPDIR, HOME,
  Chrome profile and control socket); its own loopback (agent-browser drives Chrome over CDP on 127.0.0.1);
  LaunchServices lookup; IOKit's root-domain client (power notifications Chrome registers at start); Chrome's own
  process-singleton entries in the per-user temp dir (Chrome puts them there whatever TMPDIR says; bind only, never a
  connect to another Chrome's singleton) and its own Mach rendezvous name. Chrome's inner sandbox is off
  (``--no-sandbox``): the agent's Seatbelt is the boundary. No read outside the allowed roots is ever added.

Anything the profile cannot express (a quote in a path, a missing spec or class) raises: the program does not run.
"""

from __future__ import annotations

import hashlib
import os
import plistlib
import re
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from . import core

KIND_CLASS = {"probe": "research", "media": "media", "browser": "research"}
NEVER_MARK = "; never, whatever the class or the permission mode"
CHROME_FLAGS = ("--no-sandbox", "--disable-gpu", "--disable-crash-reporter", "--disable-breakpad")
_UNSAFE = re.compile(r'["\\\x00-\x1f\x7f]')


def _safe(path: str) -> str:
    """A plain absolute path for an SBPL string: a quote, backslash or control character could end it early."""
    path = os.path.realpath(os.fsdecode(path))
    if not os.path.isabs(path) or _UNSAFE.search(path):
        raise core.ConfinementRefused(f"refusing to widen a profile with an unsafe path: {path!r}")
    return path


def _q(path: str) -> str:
    return f'"{_safe(path)}"'


def _rx(text: str) -> str:
    """SBPL regex body for a literal string."""
    return re.sub(r"[.+?^${}()|\[\]*]", lambda m: "\\" + m.group(0), text)


def _store_roots() -> Tuple[str, ...]:
    try:
        from pm import paths as pm_paths

        return tuple(sorted({os.path.realpath(str(pm_paths.store_root())),
                             os.path.realpath(str(pm_paths.writable_store_root()))}))
    except Exception:  # noqa: BLE001
        return ()


def _install_of(program: str) -> Optional[str]:
    """The program's own install, when the profile does not already read it: its entry in Hermes' managed store, or
    the ``.app`` bundle it lives in under /Applications. None for anything else (the profile's system reads)."""
    real = os.path.realpath(program)
    for root in _store_roots():
        if real.startswith(root + os.sep):
            entry = real[len(root) + 1:].split(os.sep, 1)[0]
            return os.path.join(root, entry)
    if real.startswith("/Applications/"):
        parts = real.split(os.sep)
        for i, part in enumerate(parts):
            if part.endswith(".app"):
                return os.sep.join(parts[: i + 1])
    return None


def _ancestors_rule(paths: Iterable[str]) -> str:
    """Metadata of each widened path's ancestors, literal by literal (a ``mkdir -p`` or a realpath stats every
    parent): never a listing, never a read — the profile does the same for its own parameter roots."""
    found = set()
    for path in paths:
        at = os.path.dirname(_safe(path))
        while at and at != os.sep:
            found.add(at)
            at = os.path.dirname(at)
    if not found:
        return ""
    return "(allow file-read-metadata " + " ".join(f"(literal {_q(p)})" for p in sorted(found)) + ")"


def _installs_rule(programs: Iterable[str]) -> str:
    installs = sorted({p for p in (_install_of(x) for x in programs if x) if p})
    if not installs:
        return ""
    return "(allow file-read* process-exec " + " ".join(f"(subpath {_q(p)})" for p in installs) + ")"


def _bundle_id(executable: str) -> Optional[str]:
    app = _install_of(executable)
    real = os.path.realpath(executable)
    if app is None or not app.endswith(".app"):
        parts = real.split(os.sep)
        app = next((os.sep.join(parts[: i + 1]) for i, p in enumerate(parts) if p.endswith(".app")), None)
    if app is None:
        return None
    try:
        with open(os.path.join(app, "Contents", "Info.plist"), "rb") as handle:
            ident = plistlib.load(handle).get("CFBundleIdentifier")
    except (OSError, plistlib.InvalidFileException, ValueError):
        return None
    return ident if isinstance(ident, str) and re.fullmatch(r"[A-Za-z0-9.-]+", ident) else None


_CS_DARWIN_USER_TEMP_DIR = 65537  # <unistd.h>; os.confstr_names does not list it


def _user_temp_dir() -> Optional[str]:
    """The per-user temp dir Chrome keeps its singleton in (read without starting a program)."""
    try:
        out = os.confstr(_CS_DARWIN_USER_TEMP_DIR)
    except (OSError, ValueError):
        return None
    return os.path.realpath(out) if out else None


def browser_widening(agent_browser: str, chrome: Optional[str], own_dir: str, temp_dir: Optional[str]) -> List[str]:
    """The browser's needs, as SBPL lines (measured: each one removed breaks a page load, see programs' tests)."""
    lines = [
        "; icloneOS V3-UP r5 (ruling 56): agent-browser and its browser, inside the agent's profile",
        _installs_rule([agent_browser] + ([chrome] if chrome else [])),
        f"(allow file-read* file-write* (subpath {_q(own_dir)}))",
        _ancestors_rule([own_dir] + ([os.path.join(temp_dir, "x")] if temp_dir else [])),
        f"(allow network-bind network-inbound network-outbound (local unix-socket (subpath {_q(own_dir)})) "
        f"(remote unix-socket (subpath {_q(own_dir)})))",
        '(allow network-bind network-inbound (local ip "localhost:*"))',
        '(allow network-outbound (remote ip "localhost:*"))',
        '(allow mach-lookup (global-name "com.apple.coreservices.launchservicesd"))',
        '(allow iokit-open (iokit-user-client-class "RootDomainUserClient"))',
    ]
    ident = _bundle_id(chrome) if chrome else None
    if ident:
        lines.append(f'(allow mach-register mach-lookup (global-name-regex #"^{_rx(ident)}\\.MachPortRendezvousServer\\.[0-9]+$"))')
        if temp_dir:
            singleton = f"^{_rx(_safe(temp_dir))}/{_rx(ident)}\\.[A-Za-z0-9]+"
            lines.append(f'(allow file-read* file-write* (regex #"{singleton}(/|$)"))')
            lines.append(f'(allow network-bind network-inbound (local unix-socket (regex #"{singleton}/")))')
    return [line for line in lines if line]


def media_widening(program: str, reads: Sequence[str], writes: Sequence[str]) -> List[str]:
    lines = ["; icloneOS V3-UP r5 (ruling 56): a media program on the exact files Hermes hands it",
             _installs_rule([program]), _ancestors_rule([*reads, *writes])]
    if reads:
        lines.append("(allow file-read* " + " ".join(f"(literal {_q(p)})" for p in reads) + ")")
    if writes:
        # a file is a literal; a folder Hermes made fresh for this run's outputs (pdftoppm's pages, ffmpeg's segments)
        # is that folder only
        filters = [f"(subpath {_q(p)})" if os.path.isdir(p) else f"(literal {_q(p)})" for p in writes]
        lines.append("(allow file-read* file-write* " + " ".join(filters) + ")")
    return [line for line in lines if line]


def _resolve(program: str, env: Optional[dict]) -> str:
    import shutil

    if os.sep in program:
        return os.path.realpath(program)
    found = shutil.which(program, path=(env or os.environ).get("PATH"))
    if not found:
        raise core.ConfinementRefused(f"{program} is not installed")
    return os.path.realpath(found)


def _project_root(env: Optional[dict], index: core.ProfileIndex) -> Optional[str]:
    cwd = (env or os.environ).get("TERMINAL_CWD") or os.getcwd()
    root = core.git_root(cwd)
    return os.path.realpath(root) if core.acceptable_project_root(root, index) else None


def confine(argv: List[str], *, kind: str, env: Optional[dict] = None, reads: Tuple[str, ...] = (),
            writes: Tuple[str, ...] = ()) -> Tuple[List[str], Optional[dict]]:
    """``(sandbox-exec argv, env)`` running ``argv`` inside the agent's profile for ``kind``."""
    if kind not in KIND_CLASS:
        raise core.ConfinementRefused(f"unknown program kind {kind!r}")
    index = core.trusted_index()
    cls = KIND_CLASS[kind]
    if cls not in index.profiles:
        raise core.ConfinementRefused(f"no confinement profile for class {cls!r}")
    base = core.read_verified(index.profiles[cls])
    if base.count(NEVER_MARK) != 1:
        raise core.ConfinementRefused(f"profile {cls} has no single closing block to widen before")
    source_env = dict(env) if env is not None else dict(os.environ)
    session = source_env.get("HERMES_SESSION_ID") or None
    scratch = core.scratch_dir(index, session or "programs")
    program = _resolve(argv[0], source_env)
    argv = [program, *argv[1:]]
    project = scratch
    net = "0"
    new_env: Optional[dict] = env
    if kind == "probe":
        widening = ["; icloneOS V3-UP r5 (ruling 56): a probe, nothing added", _installs_rule([program])]
    elif kind == "media":
        widening = media_widening(program, reads, writes)
    else:
        own = source_env.get("AGENT_BROWSER_SOCKET_DIR")
        if not own or not os.path.isdir(own):
            raise core.ConfinementRefused("the browser has no folder of its own (AGENT_BROWSER_SOCKET_DIR)")
        if _install_of(program) is None or not any(os.path.realpath(program).startswith(r + os.sep) for r in _store_roots()):
            raise core.ConfinementRefused("agent-browser runs confined only from Hermes' managed tool store")
        chrome = source_env.get("AGENT_BROWSER_EXECUTABLE_PATH") or None
        own = _safe(own)
        for sub in ("t", "home"):
            os.makedirs(os.path.join(own, sub), mode=0o700, exist_ok=True)
        widening = browser_widening(program, chrome, own, _user_temp_dir())
        found = _project_root(source_env, index)
        project = found or scratch
        net = core.grant_params(session, found)["NET"]
        new_env = dict(source_env)
        new_env.update({"TMPDIR": os.path.join(own, "t"), "HOME": os.path.join(own, "home")})
        flags = [f for f in (new_env.get("AGENT_BROWSER_ARGS") or "").split(",") if f]
        new_env["AGENT_BROWSER_ARGS"] = ",".join(flags + [f for f in CHROME_FLAGS if f not in flags])
    text = base.replace(NEVER_MARK, "\n".join(line for line in widening if line) + "\n" + NEVER_MARK)
    sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
    params: Dict[str, str] = {
        "PROJECT_ROOT": project,
        "SCRATCH": scratch,
        "OUTPUT_DIR": os.path.join(scratch, "output"),
        "NET": net,
        "WRITE_PROJECT": "0",
        "MEMBER": core.new_run_token(index, cls, sha, session),
    }
    os.makedirs(params["OUTPUT_DIR"], mode=0o700, exist_ok=True)
    defines = [item for key, value in params.items() for item in ("-D", f"{key}={value}")]
    return [core.SANDBOX_EXEC, "-p", text, *defines, *argv], new_env
