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
The built-in browser is not one of them: with the Seatbelt on it runs outside it, through the launcher's door (ruling R1,
browser_door.py), so no profile is widened for it.

Anything the profile cannot express (a quote in a path, a missing spec or class) raises: the program does not run.
"""

from __future__ import annotations

import hashlib
import os
import re
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from . import core

KIND_CLASS = {"probe": "research", "media": "media"}
NEVER_MARK = core.NEVER_MARK
_UNSAFE = re.compile(r'["\\\x00-\x1f\x7f]')


def _safe(path: str) -> str:
    """A plain absolute path for an SBPL string: a quote, backslash or control character could end it early."""
    path = os.path.realpath(os.fsdecode(path))
    if not os.path.isabs(path) or _UNSAFE.search(path):
        raise core.ConfinementRefused(f"refusing to widen a profile with an unsafe path: {path!r}")
    return path


def _q(path: str) -> str:
    return f'"{_safe(path)}"'


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


def media_widening(program: str, reads: Sequence[str], writes: Sequence[str]) -> List[str]:
    lines = ["; icloneOS host-exec widening: a media program on the exact files Hermes hands it",
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


def confine(argv: List[str], *, kind: str, env: Optional[dict] = None, reads: Tuple[str, ...] = (),
            writes: Tuple[str, ...] = ()) -> Tuple[List[str], Optional[dict]]:
    """``(sandbox-exec argv, env)`` running ``argv`` inside the agent's profile for ``kind`` — carried by the stub to
    the launcher when the runtime itself is confined. A refusal is journaled for the app's run ledger."""
    try:
        wrapped, new_env = _confine(argv, kind=kind, env=env, reads=reads, writes=writes)
        return core.via_launcher(wrapped), new_env
    except core.ConfinementRefused as exc:
        session = (env if env is not None else os.environ).get("HERMES_SESSION_ID") or None
        core.record_refusal(session, " ".join(str(a) for a in argv)[:2000], exc)
        raise


def _confine(argv: List[str], *, kind: str, env: Optional[dict], reads: Tuple[str, ...],
             writes: Tuple[str, ...]) -> Tuple[List[str], Optional[dict]]:
    if kind not in KIND_CLASS:
        raise core.ConfinementRefused(f"unknown program kind {kind!r}")
    index = core.trusted_index()
    cls = KIND_CLASS[kind]
    if cls not in index.profiles:
        raise core.ConfinementRefused(f"no confinement profile for class {cls!r}", "no-profile")
    base = core.read_verified(index.profiles[cls])
    if base.count(NEVER_MARK) != 1:
        raise core.ConfinementRefused(f"profile {cls} has no single closing block to widen before", "no-profile")
    source_env = dict(env) if env is not None else dict(os.environ)
    session = source_env.get("HERMES_SESSION_ID") or None
    scratch = core.scratch_dir(index, session or "programs")
    program = _resolve(argv[0], source_env)
    argv = [program, *argv[1:]]
    project = scratch
    net = "0"
    new_env: Optional[dict] = env
    if kind == "probe":
        widening = ["; icloneOS host-exec widening: a probe, nothing added", _installs_rule([program])]
        # A probe is the runtime learning about the host (which tools exist, their versions): its own housekeeping,
        # said to the launcher in the request's environment and never seen by the program.
        new_env = dict(source_env)
        new_env[core.ORIGIN_ENV] = core.ORIGIN_RUNTIME
    else:
        widening = media_widening(program, reads, writes)
    text = base.replace(NEVER_MARK, "\n".join(line for line in widening if line) + "\n" + NEVER_MARK)
    sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
    params: Dict[str, str] = {
        "PROJECT_ROOT": project,
        "SCRATCH": scratch,
        "OUTPUT_DIR": os.path.join(scratch, "output"),
        "NET": net,
        "WRITE_PROJECT": "0",
        "PROJECT_GIT": core.project_git_state(project, scratch),
        "MEMBER": core.new_run_token(index, cls, sha, session),
    }
    os.makedirs(params["OUTPUT_DIR"], mode=0o700, exist_ok=True)
    defines = [item for key, value in params.items() for item in ("-D", f"{key}={value}")]
    return [core.SANDBOX_EXEC, "-p", text, *defines, *argv], new_env
