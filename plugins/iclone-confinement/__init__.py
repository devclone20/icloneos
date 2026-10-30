"""iclone-confinement — Hermes' terminal through the icloneOS confinement layer (V3-G).

Inert unless icloneOS started this Hermes (``ICLONE_CONFINEMENT=1``). Then:

1. two terminal backends are registered: ``iclone_seatbelt`` (live) and ``iclone_container`` (refuses until the owner
   installs Apple ``container`` and spike C1 lands);
2. the ``terminal.backend`` bridge from config.yaml runs now, once, and ``TERMINAL_ENV`` is put back to the backend the
   app chose — a stale ``terminal.backend: local`` can never take the agent's shell out of the sandbox;
3. one ``pre_tool_call`` hook refuses the shell tools if ``TERMINAL_ENV`` is anything else at call time (fail closed);
4. an acknowledgement is written where main said (``ICLONE_CONFINEMENT_ACK``), so the pane can tell a Hermes that
   runs without this plugin (its shell refused: ``iclone_seatbelt`` is then an unknown backend) from a confined one.

The spec main hands over (``ICLONE_CONFINEMENT_SPEC``: the profile hashes) and the key that signs the owner's
hard-link acknowledgements (``ICLONE_CONFINEMENT_LINK_KEY``) are popped at import: no child inherits them, and nothing
next to the profiles on disk is trusted (core.py).

Confinement stays on in every permission mode, Ignore permissions included: Ignore skips the asks, not the sandbox.
Confined: the terminal, code execution and the file tools (they run through the terminal backend). Nothing those tools
trigger runs on the host around it (V3-UP r3, ruling 43): ``tools/environments/host_lane.py`` turns off every host-side
helper — the native file lane, post-write linters, LSP servers and their installer, checkpoint git, the PDF page scan,
skill inline shell, delegated worktrees, shell hooks — and Browser Use's ``browser_exec`` (the agent's Python on the
host); tests/plugins/test_iclone_host_exec.py enumerates every spawn site. Since V3-UP r4/r5 (rulings 50 and 56) the
rule is enforced at runtime: hermes_bootstrap's audit hook (tools/environments/host_lane.py) refuses every stdlib
process creation that is not the environment's shell, an app-fixed program started INSIDE the agent's Seatbelt
(programs.py: the built-in browser and its Chrome, media helpers, probes — the allowlist names which, never whether
they run outside the sandbox), or this runtime's own interpreter, confined. MCP stdio servers, scheduled job scripts,
plugin/skill/package installs, computer use and keychain imports do not run while confined
(tests/fixtures/host_exec_sites.json documents every site, by primitive: a/b/c/h).
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

from . import core

ACTIVE = os.environ.get("ICLONE_CONFINEMENT") == "1"
EXPECTED_BACKEND = os.environ.get("TERMINAL_ENV", "") if ACTIVE else ""
ACK_FILE = os.environ.pop("ICLONE_CONFINEMENT_ACK", "") if ACTIVE else ""
if ACTIVE:
    core.trust_spec(os.environ.pop("ICLONE_CONFINEMENT_SPEC", ""))
    core.trust_link_key(os.environ.pop("ICLONE_CONFINEMENT_LINK_KEY", ""))
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
    if tool_name not in SHELL_TOOLS:
        return None
    current = os.environ.get("TERMINAL_ENV", "local").strip().lower()
    if EXPECTED_BACKEND in OUR_BACKENDS and current == EXPECTED_BACKEND:
        return None
    return {
        "action": "block",
        "message": f"Refused by icloneOS confinement: the agent's shell must run confined ({EXPECTED_BACKEND or 'unset'}), "
                   f"but the terminal backend is {current!r}.",
    }


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

    ctx.register_terminal_environment_provider(SeatbeltProvider())
    ctx.register_terminal_environment_provider(ContainerProvider())
    pin_terminal_backend()
    ctx.register_hook("pre_tool_call", on_pre_tool_call)
    try:
        core.write_ack(ACK_FILE, EXPECTED_BACKEND)
    except OSError:
        logger.warning("could not acknowledge the confinement plugin to the app", exc_info=True)
