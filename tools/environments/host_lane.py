"""icloneOS V3-UP r3 (ruling 43) — may Hermes run a helper on the HOST for the agent's environment?

Hermes runs a few things in its own process, or as host children, on behalf of the confined tools: the native file
lane (read, exact bytes, existence probe, ripgrep), post-write linters (``node --check``, ``npx tsc``), LSP servers
and their installer, checkpoint git, the PDF page scan, a skill's inline shell, a delegated child's git worktree,
the configured shell hooks, Browser Use's Python harness. On a plain ``LocalEnvironment`` the environment's shell IS
the host, so that is only a faster route to the same place. On anything else — a container, a remote host, or a
``LocalEnvironment`` subclass that confines its shell (icloneOS' seatbelt) — it is a route AROUND the environment: a
project-planted ``node_modules/.bin/tsc`` would run unconfined (critic r2 N2).

``host_side_helpers_allowed`` is the one predicate every such site asks; ``RESUME``'s host-exec enumeration
(``plugins/iclone-confinement/tests/fixtures/host_exec_sites.json``) lists every spawn site and which predicate,
route or reason covers it. Fail closed: any error answers False.
"""

from __future__ import annotations

import os
from typing import Any

_UNSET: Any = object()


def confined_process() -> bool:
    """icloneOS started this Hermes with its confinement on (the EXEC-TIME ``ICLONE_CONFINEMENT``: no dotenv, managed
    overlay or config bridge can turn it off later). Then no host-side helper runs, whatever environment a tool got —
    a flipped ``TERMINAL_ENV`` that hands a file tool a plain ``LocalEnvironment`` included."""
    try:
        from hermes_cli.iclone_policy_env import exec_env

        value = exec_env("ICLONE_CONFINEMENT")
    except Exception:  # noqa: BLE001 — the exec-time copy is unreadable: the live value is the best evidence left
        value = os.environ.get("ICLONE_CONFINEMENT")
    return value == "1"


def env_is_host(env: Any) -> bool:
    """The environment's shell is this host, unconfined: exactly ``LocalEnvironment``, or a subclass that DECLARES
    ``host_side_helpers = True``. An undeclared subclass is not (a future confining backend that forgot to say so
    must not inherit the host lane)."""
    try:
        from tools.environments.local import LocalEnvironment
    except Exception:  # noqa: BLE001
        return False
    if type(env) is LocalEnvironment:
        return True
    return isinstance(env, LocalEnvironment) and getattr(type(env), "host_side_helpers", None) is True


def _configured_backend_is_local() -> bool:
    return (os.environ.get("TERMINAL_ENV") or "local").strip().lower() == "local"


def host_side_helpers_allowed(env: Any = _UNSET) -> bool:
    """True only when a helper may run on the host for the agent's environment: never in a confined process; for a
    given environment, when it is the host (``env_is_host``); without one, when the configured backend is local."""
    try:
        if confined_process():
            return False
        if env is _UNSET or env is None:
            return _configured_backend_is_local()
        return env_is_host(env)
    except Exception:  # noqa: BLE001
        return False

# ---------------------------------------------------------------------------------------------------------------------
# V3-UP r4 (ruling 50) + r5 (ruling 56): the rule enforced at runtime. In a process icloneOS confines, an audit hook
# (installed by ``hermes_bootstrap`` at interpreter start, before any tool can run) sees every stdlib process-creation
# event and refuses it (``PermissionError``) unless it is one of:
#   (a) the environment's own shell — a spawn made inside a method of a NON-host environment (the seatbelt, a
#       container, a remote backend), from the environment backends' own code;
#   (c) an app-fixed program — a site listed ``fixed`` in plugins/iclone-confinement/spawn_sites.json — and only as the
#       exact ``sandbox-exec`` argv ``confine_program`` sealed for it: the program runs INSIDE the agent's Seatbelt
#       profile, widened only by what that program provably needs (ruling 56: the allowlist decides WHICH program,
#       never WHETHER it runs outside the sandbox);
#   (h) the confined runtime itself — a site listed ``hermes`` starting this runtime's own interpreter (or the hermes
#       CLI beside it) with ``ICLONE_CONFINEMENT=1`` in the child's environment, so the child installs this same guard;
#   everything else is (b): refused — whatever module it comes from, listed or not.
# The decision is built once, at install, from closure-local helpers: rebinding this module's names, ``exec_env`` or
# ``decide_spawn.__code__`` afterwards changes nothing. ``_posixsubprocess.fork_exec`` (no audit event of its own;
# multiprocessing's spawn reaches it directly) is wrapped so only ``subprocess.Popen``'s audited path reaches it.
# Out of scope, by design (no agent path runs code inside the Hermes process): native code that starts a program
# without an audit event — cffi's own dlopen/dlsym, the Objective-C runtime (NSTask), a function pointer obtained
# before the hook was installed.
# ---------------------------------------------------------------------------------------------------------------------
import hashlib as _hashlib
import sys as _sys
import threading as _threading
from pathlib import Path as _Path

RUNTIME_ROOT = _Path(__file__).resolve().parents[2]
SITES_FILE = RUNTIME_ROOT / "plugins" / "iclone-confinement" / "spawn_sites.json"
SANDBOX_EXEC = "/usr/bin/sandbox-exec"
SPAWN_EVENTS = frozenset({"subprocess.Popen", "os.system", "os.exec", "os.spawn", "os.posix_spawn", "os.fork",
                          "os.forkpty", "os.startfile", "pty.spawn"})
DLSYM_EVENTS = frozenset({"ctypes.dlsym", "ctypes.dlsym/handle"})
# Process-creation symbols a ctypes caller could resolve to start a program around the events above.
SPAWN_SYMBOLS = frozenset({"system", "popen", "fork", "vfork", "forkpty", "execv", "execve", "execvp", "execvpe",
                           "execl", "execle", "execlp", "posix_spawn", "posix_spawnp", "_posix_spawn", "spawnv",
                           "fork_exec"})
_ENV_DIRS = (RUNTIME_ROOT / "tools" / "environments", RUNTIME_ROOT / "plugins" / "iclone-confinement")
_state = {"installed": False, "refusals": [], "confiner": None}
# Digests of the argv ``confine_program`` built; the installed hook holds THIS object (rebinding the name is moot).
_SEALS: set = set()
_state_lock = _threading.Lock()


def _within(path: str, root: str) -> bool:
    return path == root or path.startswith(root + os.sep)


def _load_sites() -> tuple:
    """(fixed, hermes) sites, ``relpath::qualname``. Unreadable ⇒ none (fail closed: only the environment shell runs)."""
    try:
        import json

        data = json.loads(SITES_FILE.read_text(encoding="utf-8"))
        return (frozenset(str(s) for s in data.get("fixed", []) if isinstance(s, str)),
                frozenset(str(s) for s in data.get("hermes", []) if isinstance(s, str)))
    except Exception:  # noqa: BLE001
        return frozenset(), frozenset()


def _foreign_roots() -> tuple:
    """Code that is not the runtime's: the stdlib and installed packages (a spawn's SITE is the first runtime frame)."""
    import sysconfig

    paths = {sysconfig.get_paths().get(k) for k in ("stdlib", "platstdlib", "purelib", "platlib")}
    roots = {os.path.realpath(p).rstrip(os.sep) for p in paths if p}
    # A runtime installed INTO site-packages is still the runtime: a root that holds it is not foreign (its other
    # packages then count as runtime frames too — stricter, never looser: their spawns are refused unless listed).
    here = str(RUNTIME_ROOT)
    return tuple(sorted(r for r in roots if not _within(here, r)))


def _interpreter_programs() -> frozenset:
    """This runtime's own interpreter and the hermes CLI beside it, by real path."""
    exe = _sys.executable or ""
    found = {os.path.realpath(exe)} if exe else set()
    if exe:
        found.add(os.path.realpath(os.path.join(os.path.dirname(exe), "hermes")))
    return frozenset(p for p in found if p)


def argv_digest(argv) -> str:
    return _hashlib.sha256("\0".join(os.fsdecode(a) for a in argv).encode("utf-8", "surrogateescape")).hexdigest()


def _build_decider(*, fixed: frozenset, hermes: frozenset, foreign: tuple, seals: set, interpreters: frozenset):
    """The decision as one closure over local helpers (nothing it calls is looked up in a module afterwards)."""
    import shutil

    realpath, relpath, dirname, isabs, fsdecode = (os.path.realpath, os.path.relpath, os.path.dirname,
                                                   os.path.isabs, os.fsdecode)
    sep, which, environ, modules = os.sep, shutil.which, os.environ, _sys.modules
    sha256 = _hashlib.sha256
    root = str(RUNTIME_ROOT)
    env_dirs = tuple(str(d) for d in _ENV_DIRS)
    symbols, dlsym_events, sandbox_exec = SPAWN_SYMBOLS, DLSYM_EVENTS, SANDBOX_EXEC

    def within(path: str, base: str) -> bool:
        return path == base or path.startswith(base + sep)

    def site_of(frame):
        frames, site, f = [], None, frame
        while f is not None:
            frames.append(f)
            if site is None:
                filename = realpath(f.f_code.co_filename) if f.f_code.co_filename else ""
                if within(filename, root) and not any(within(filename, r) for r in foreign):
                    rel = relpath(filename, root).replace(sep, "/")
                    qual = getattr(f.f_code, "co_qualname", f.f_code.co_name)
                    qual = ".".join(p for p in qual.split(".") if not p.startswith("<")) or "<module>"
                    site = f"{rel}::{qual}"
            f = f.f_back
        return site, frames

    def env_is_host(env) -> bool:
        local = getattr(modules.get("tools.environments.local"), "LocalEnvironment", None)
        if local is None:
            return False
        if type(env) is local:
            return True
        return isinstance(env, local) and getattr(type(env), "host_side_helpers", None) is True

    def env_on_stack(frames):
        base = getattr(modules.get("tools.environments.base"), "BaseEnvironment", None)
        if base is None:
            return None
        for f in frames:
            filename = realpath(f.f_code.co_filename or "")
            if not any(within(filename, d) for d in env_dirs):
                continue
            try:
                candidate = f.f_locals.get("self")
            except Exception:  # noqa: BLE001
                continue
            if isinstance(candidate, base):
                return candidate
        return None

    def program(event: str, args: tuple) -> str:
        if event == "subprocess.Popen":
            executable, argv, _cwd, env = (tuple(args) + (None,) * 4)[:4]
            prog = executable
            if prog is None:
                prog = argv if isinstance(argv, (str, bytes, os.PathLike)) else (list(argv)[0] if argv else "")
            path_var = env.get("PATH") if isinstance(env, dict) else None
        elif event in ("os.exec", "os.posix_spawn", "os.spawn"):
            prog = args[1] if event == "os.spawn" else args[0]
            path_var = None
        else:
            return ""
        prog = fsdecode(prog) if isinstance(prog, (bytes, os.PathLike)) else str(prog or "")
        if sep not in prog:
            prog = which(prog, path=path_var if path_var is not None else environ.get("PATH")) or prog
        return realpath(prog) if isabs(prog) else prog

    def digest(argv) -> str:
        return sha256("\0".join(fsdecode(a) for a in argv).encode("utf-8", "surrogateescape")).hexdigest()

    def child_confined(args: tuple) -> bool:
        env = (tuple(args) + (None,) * 4)[3]
        env = environ if env is None else env
        try:
            value = env.get("ICLONE_CONFINEMENT", env.get(b"ICLONE_CONFINEMENT"))
        except Exception:  # noqa: BLE001
            return False
        return value in ("1", b"1")

    def decide(event: str, args: tuple, frame) -> tuple:
        if event in dlsym_events:
            name = args[-1] if args else ""
            name = name.decode() if isinstance(name, bytes) else str(name)
            if name in symbols:
                return False, f"ctypes symbol {name!r} would start a program around the spawn guard"
            return True, "not a spawn symbol"
        site, frames = site_of(frame)
        env = env_on_stack(frames)
        if env is not None:
            if env_is_host(env):
                return False, f"(b) a host environment's shell ({type(env).__name__}) in a confined process [{site}]"
            return True, f"(a) the environment's own shell ({type(env).__name__})"
        if site in fixed:
            argv = (tuple(args) + (None,) * 2)[1]
            if event == "subprocess.Popen" and isinstance(argv, (list, tuple)) and argv \
                    and program(event, args) == sandbox_exec and digest(argv) in seals:
                seals.discard(digest(argv))
                return True, f"(c) app-fixed program inside the agent's Seatbelt [{site}]"
            return False, f"(c) {site} runs its program only inside the agent's Seatbelt (ruling 56)"
        if site in hermes:
            prog = program(event, args)
            if event == "subprocess.Popen" and prog in interpreters and child_confined(args):
                return True, f"(h) the confined runtime's own interpreter [{site}]"
            return False, f"(h) {site} may start only this runtime's interpreter, confined ({prog or 'unresolvable'})"
        return False, f"(b) {site or 'a frame outside the runtime'} is not a lane of a confined process"

    return decide


def decide_spawn(event: str, args: tuple, frame=None, *, fixed=None, hermes=None, foreign=None, seals=None,
                 confined=None) -> tuple:
    """(allowed, why) for one process-creation audit event in this process (a fresh decider; tests and tools)."""
    if not (confined_process() if confined is None else confined):
        return True, "not a confined process"
    loaded = _load_sites() if fixed is None or hermes is None else (fixed, hermes)
    decide = _build_decider(fixed=loaded[0] if fixed is None else fixed, hermes=loaded[1] if hermes is None else hermes,
                            foreign=_foreign_roots() if foreign is None else foreign,
                            seals=_SEALS if seals is None else seals, interpreters=_interpreter_programs())
    return decide(event, args, frame if frame is not None else _sys._getframe(1))


def register_program_confiner(confiner) -> bool:
    """The confinement plugin hands over the function that builds a confined argv (first registration wins)."""
    with _state_lock:
        if _state["confiner"] is None:
            _state["confiner"] = confiner
            return True
    return False


def confine_program(argv, *, kind: str, env=None, reads=(), writes=()) -> tuple:
    """``(argv, env)`` to start an app-fixed program with. Unconfined: unchanged. Confined: the program inside the
    agent's Seatbelt profile for ``kind`` (``browser`` | ``media`` | ``probe``), widened only by what it needs —
    ``reads``/``writes`` name the exact files it handles — sealed for the spawn guard. Raises ``PermissionError``
    when it cannot be confined (no spec, no profile, a path the profile cannot express): it then does not run."""
    if not confined_process():
        return list(argv), env
    try:
        confiner = _state["confiner"]
        if confiner is None:
            raise PermissionError("the icloneOS confinement plugin is not loaded in this process")
        wrapped, new_env = confiner(list(argv), kind=kind, env=env, reads=tuple(reads), writes=tuple(writes))
    except PermissionError:
        raise
    except Exception as exc:  # noqa: BLE001 — anything that is not a confined argv is no argv
        raise PermissionError(f"icloneOS confinement cannot run {os.path.basename(str(argv[0]))} here: {exc}") from exc
    _SEALS.add(argv_digest(wrapped))
    return wrapped, new_env


def _guard_fork_exec(getframe, refusals, stderr) -> None:
    """``_posixsubprocess.fork_exec`` has no audit event: only ``subprocess.Popen._execute_child`` (whose
    ``subprocess.Popen`` event the hook already decided) may reach it. multiprocessing's spawn, a direct call: refused."""
    import subprocess

    try:
        import _posixsubprocess
    except ImportError:
        return
    original = _posixsubprocess.fork_exec
    allowed = subprocess.Popen._execute_child.__code__

    def fork_exec(*args, **kwargs):
        caller = getframe(1)
        if caller is not None and caller.f_code is allowed:
            return original(*args, **kwargs)
        why = "(b) _posixsubprocess.fork_exec outside subprocess.Popen (multiprocessing spawn, a direct call)"
        if len(refusals) < 200:
            refusals.append(("_posixsubprocess.fork_exec", why))
            try:
                stderr.write(f"[icloneOS spawn guard] refused _posixsubprocess.fork_exec: {why}\n")
            except Exception:  # noqa: BLE001
                pass
        raise PermissionError(f"icloneOS confinement refused to start a program: {why}")

    _posixsubprocess.fork_exec = fork_exec
    if getattr(subprocess, "_fork_exec", None) is original:
        subprocess._fork_exec = fork_exec


def install_spawn_guard() -> bool:
    """Install the audit hook once (it cannot be removed: ``sys.addaudithook`` has no inverse). Only in a confined
    process; once installed it enforces for the life of the process. True when the guard is (now) active."""
    if not confined_process():
        return False
    with _state_lock:
        if _state["installed"]:
            return True
        fixed, hermes = _load_sites()
        decide = _build_decider(fixed=fixed, hermes=hermes, foreign=_foreign_roots(), seals=_SEALS,
                                interpreters=_interpreter_programs())
        refusals, watched = _state["refusals"], SPAWN_EVENTS | DLSYM_EVENTS
        getframe, stderr = _sys._getframe, _sys.stderr

        def _audit(event: str, args: tuple) -> None:
            if event not in watched:
                return
            allowed, why = decide(event, args, getframe(1))
            if allowed:
                return
            if len(refusals) < 200:
                refusals.append((event, why))
                try:  # one line per refusal on stderr (the app keeps Hermes' stderr); never the argv
                    stderr.write(f"[icloneOS spawn guard] refused {event}: {why}\n")
                except Exception:  # noqa: BLE001
                    pass
            raise PermissionError(f"icloneOS confinement refused to start a program: {why}")

        _sys.addaudithook(_audit)
        _guard_fork_exec(getframe, refusals, stderr)
        _state.update(installed=True)
    return True


def spawn_guard_installed() -> bool:
    return bool(_state["installed"])


def spawn_refusals() -> list:
    return list(_state["refusals"])
