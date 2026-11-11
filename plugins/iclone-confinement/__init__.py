"""iclone-confinement — Hermes' terminal through the icloneOS confinement layer (V3-G).

Inert unless icloneOS started this Hermes (``ICLONE_CONFINEMENT=1``). Then:

1. two terminal backends are registered: ``iclone_seatbelt`` (live) and ``iclone_container`` (refuses until the owner
   installs Apple ``container`` and spike C1 lands);
2. the backend is what the app set at exec (``hermes_cli.iclone_policy_env.confined_backend``), read before any bridge:
   by the time this plugin loads, main.py has already bridged config.yaml into ``os.environ``. A ``terminal.backend:
   local`` (the installer's template says so) means nobody chose, and every bridge, the per-turn scope and the
   tools' own read keep the app's backend; a config or ``.env`` asking for another backend is refused, never run;
3. one ``pre_tool_call`` hook refuses the shell tools if the backend a tool would read is anything else at call time, or
   its policy is refused (fail closed);
4. an acknowledgement is written where main said (``ICLONE_CONFINEMENT_ACK``), so the pane can tell a Hermes that
   runs without this plugin (its shell refused: ``iclone_seatbelt`` is then an unknown backend) from a confined one;
   it also carries whether the agent's commands can run now, and why not (a runtime under its own profile needs the
   launcher to answer), so the pane never reads green while the terminal tool is withheld.

The spec main hands over (``ICLONE_CONFINEMENT_SPEC``: the profile hashes) and the key that signs the owner's
hard-link acknowledgements (``ICLONE_CONFINEMENT_LINK_KEY``) are read from the exec copy (``exec_env``), by every copy of
this plugin, and stay out of ``os.environ``: no command inherits them, and nothing next to the profiles on disk is
trusted (core.py).

Confinement stays on in every permission mode, Ignore permissions included: Ignore skips the asks, not the sandbox.
Confined: the terminal, code execution and the file tools (they run through the terminal backend). Nothing those tools
trigger runs on the host around it (V3-UP r3, ruling 43): ``tools/environments/host_lane.py`` turns off every host-side
helper — the native file lane, post-write linters, LSP servers and their installer, checkpoint git, the PDF page scan,
skill inline shell, delegated worktrees, shell hooks — and Browser Use's ``browser_exec`` (the agent's Python on the
host); tests/plugins/test_iclone_host_exec.py enumerates every spawn site. Since V3-UP r4/r5 (rulings 50 and 56) the
rule is enforced at runtime: hermes_bootstrap's audit hook (tools/environments/host_lane.py) refuses every stdlib
process creation that is not the environment's shell, an app-fixed program started INSIDE the agent's Seatbelt
(programs.py: media helpers, probes — the allowlist names which, never whether
they run outside the sandbox), or this runtime's own interpreter, confined. MCP stdio servers, scheduled job scripts,
plugin/skill/package installs and keychain imports do not run while confined. Computer use does (S10): never as a confined
command; the launcher, outside the Seatbelt, runs the signed driver after its signature check (driver_door.py)
(tests/fixtures/host_exec_sites.json documents every site, by primitive: a/b/c/h).
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

from hermes_cli.iclone_policy_env import confined_backend, exec_env, isolation_off, on_refusal_change

from . import core

# The exec-time value when the app confined this process; a ``.env`` cannot switch this plugin off for it.
_PINNED = confined_backend()
# Isolation off is main's own exec value: a ``.env`` naming the variable cannot arm this plugin against that choice.
ACTIVE = not isolation_off() and (_PINNED is not None or os.environ.get("ICLONE_CONFINEMENT") == "1")
EXPECTED_BACKEND = (_PINNED or os.environ.get("TERMINAL_ENV", "")) if ACTIVE else ""


def _handed(name: str) -> str:
    """What main handed this process at exec, for every copy of this plugin (one per routed home); a value a dotenv
    wrote is not main's."""
    os.environ.pop(name, None)
    return exec_env(name) or ""


ACK_FILE = _handed("ICLONE_CONFINEMENT_ACK") if ACTIVE else ""
if ACTIVE:
    core.trust_spec(_handed("ICLONE_CONFINEMENT_SPEC"))
    core.trust_link_key(_handed("ICLONE_CONFINEMENT_LINK_KEY"))
    core.trust_git_identity(_handed("ICLONE_GIT_USER_NAME"), _handed("ICLONE_GIT_USER_EMAIL"))
# The shell tools: the terminal, its background processes (``process_manage`` at 1ac3f97, ``process`` its legacy
# alias) and code execution.
SHELL_TOOLS = frozenset({"terminal", "process_manage", "process", "execute_code"})
OUR_BACKENDS = frozenset({"iclone_seatbelt", "iclone_container"})


def pin_terminal_backend() -> None:
    """Run Hermes' one-shot config bridge now, then restore the backend main chose."""
    try:
        from tools import terminal_tool

        terminal_tool._ensure_terminal_env_bridged()
    except Exception:  # the bridge is best effort upstream too; the pin below is what matters
        logger.debug("terminal config bridge failed", exc_info=True)
    if EXPECTED_BACKEND in OUR_BACKENDS:
        os.environ["TERMINAL_ENV"] = EXPECTED_BACKEND


def on_pre_tool_call(tool_name: str = "", **_: Any) -> Optional[Dict[str, str]]:
    if not ACTIVE or tool_name not in SHELL_TOOLS:
        return None
    current = os.environ.get("TERMINAL_ENV", "local").strip().lower()
    if _PINNED:
        # What the tool itself will read (a per-turn scope, not os.environ), so this hook and the tool cannot disagree.
        from tools.terminal_scope import TerminalPolicyUnavailable, enforce_no_refusal, terminal_env

        try:
            enforce_no_refusal()
            current = terminal_env("TERMINAL_ENV", "local").strip().lower()
        except TerminalPolicyUnavailable as exc:
            return {"action": "block", "message": str(exc)}
    if EXPECTED_BACKEND in OUR_BACKENDS and current == EXPECTED_BACKEND:
        return None
    return {
        "action": "block",
        "message": f"Refused by icloneOS confinement: the agent's shell must run confined ({EXPECTED_BACKEND or 'unset'}), "
                   f"but the terminal backend is {current!r}.",
    }


def _config_unreadable() -> str:
    """A config.yaml that cannot be parsed says nothing about terminal.backend, so a request for another backend in it
    cannot be refused. Commands still run in the sandbox: the ack carries this as a note, never as a refusal."""
    from hermes_cli.config import fast_safe_load, get_config_path

    try:
        with open(get_config_path(), encoding="utf-8-sig") as handle:
            fast_safe_load(handle)
    except FileNotFoundError:
        return ""
    except Exception as exc:  # noqa: BLE001 — any failure to read it is the thing to report
        return (f"config.yaml could not be read ({type(exc).__name__}), so any terminal.backend in it was not applied. "
                "Commands still run in the sandbox. Fix the file and restart.")
    return ""


def register(ctx) -> None:
    if not ACTIVE:
        return
    # V3-UP r4 (ruling 50): the spawn guard is normally installed by hermes_bootstrap at interpreter start; an entry
    # point that skipped the bootstrap gets it here, before the first tool can run.
    try:
        from tools.environments.host_lane import install_spawn_guard

        install_spawn_guard()
    except Exception:  # noqa: BLE001 — the bootstrap seam is the primary; this is belt and braces
        logger.warning("iclone-confinement: the spawn guard could not be installed here", exc_info=True)
    # V3-UP r5 (ruling 56): every app-fixed program a confined Hermes starts runs inside the agent's profile; the
    # spawn guard lets a listed site start only the sandbox-exec argv this builds.
    try:
        from tools.environments.host_lane import register_program_confiner

        from . import programs

        register_program_confiner(programs.confine)
    except Exception:  # noqa: BLE001 — without it every app-fixed program is refused (fail closed)
        logger.warning("iclone-confinement: app-fixed programs cannot be confined here; they are refused", exc_info=True)
    from .providers import ContainerProvider, SeatbeltProvider

    seatbelt = SeatbeltProvider()
    ctx.register_terminal_environment_provider(seatbelt)
    ctx.register_terminal_environment_provider(ContainerProvider())
    pin_terminal_backend()
    ctx.register_hook("pre_tool_call", on_pre_tool_call)
    # One acknowledgement per process: a routed copy of this plugin has nothing to add to what the first copy says.
    if not core.arm_ack(ACK_FILE, EXPECTED_BACKEND):
        return
    try:
        core.write_ack(ACK_FILE, EXPECTED_BACKEND)
    except OSError:
        logger.warning("could not acknowledge the confinement plugin to the app", exc_info=True)
    # From here on the acknowledgement also says whether the agent's commands can run, and is rewritten whenever that
    # answer changes (every tool listing asks it): main turns the verdict red while they cannot.
    core.note_config_unreadable(_config_unreadable())
    on_refusal_change(seatbelt.is_available)
    if EXPECTED_BACKEND == "iclone_seatbelt":
        seatbelt.is_available()
    else:
        core.report_commands(False, f"the terminal backend is {EXPECTED_BACKEND or 'unset'}, which does not run "
                                    "commands in this version")
