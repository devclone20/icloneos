"""icloneOS V3-J (fix m-r4-1) — a pay env belongs to the profile it was minted for, never to a process that inherits it.

Main gives each Hermes spawn three names: ``ICLONE_PAY_SOCKET``, ``ICLONE_PAY_TOKEN_FILE`` and ``ICLONE_PAY_HOME``,
the identity (``st_dev:st_ino``) of the folder that spawn runs in — its ``HERMES_HOME`` once ``-p`` is applied — as
main's seed pass verified it. Hermes starts other Hermes processes from that environment (a cron delivery to another
profile's Bot Chat, a kanban worker, a dashboard action, a slash worker), and an in-process session of another profile
runs its tools under that profile's HERMES_HOME; a plain ``os.environ.copy()`` would hand all of them the token of the
profile that started them. Four layers keep the token with its profile:

* :func:`for_child` — the cron and kanban cross-profile spawn sites drop the pay names unless the child runs in the
  folder they were minted for;
* all four subprocess env factories in ``tools/environments/local.py`` (``build_subprocess_env``,
  ``_sanitize_subprocess_env``, ``_make_run_env``, ``hermes_subprocess_env``) apply the same rule to the HERMES_HOME
  the env carries when they return (fix m-r5-1, m-r6-1: a terminal child of an in-process session of another profile,
  a slash worker of another profile, the browser/ACP/TUI-host helpers); a caller that rewrites HERMES_HOME after the
  factory binds again itself (``web_server._resolve_chat_argv``, the dashboard chat PTY of another profile);
* :func:`bind_at_boot` — at the start of the entry points a spawn of another profile goes through (``hermes_cli.main``
  right after ``_apply_profile_override``, ``tui_gateway.entry``, ``tui_gateway.slash_worker``): the names are dropped
  when this process does not run in that folder. Python entry points not listed here, and children whose env is built
  by hand outside the factories, are covered only by the last layer;
* the pay socket itself — the ``x402-pay`` client sends the identity of the ``HERMES_HOME`` it runs under, and main
  refuses a token whose minted folder is not that one (``apps/desktop/electron/iclone-x402/ipc.ts``). A process that
  forges that identity is the same-uid case the security review accepts (R-J4).

A missing or unreadable folder, a missing ``ICLONE_PAY_HOME`` or any error means "not bound": the names are dropped.
"""

from __future__ import annotations

import os
import stat
from typing import MutableMapping, Optional

PAY_NAMES = ("ICLONE_PAY_SOCKET", "ICLONE_PAY_TOKEN_FILE", "ICLONE_PAY_HOME")
HOME_NAME = "ICLONE_PAY_HOME"


def home_id(folder: Optional[str]) -> Optional[str]:
    """``st_dev:st_ino`` of ``folder`` (links followed, as Hermes uses it), or None when it is not a readable folder."""
    if not folder:
        return None
    try:
        st = os.stat(folder)
    except (OSError, ValueError, TypeError):
        return None
    if not stat.S_ISDIR(st.st_mode):
        return None
    return f"{st.st_dev}:{st.st_ino}"


def carries_pay_env(env: MutableMapping[str, str]) -> bool:
    return any(name in env for name in PAY_NAMES)


def bound(env: MutableMapping[str, str], hermes_home: Optional[str]) -> bool:
    """True when ``env``'s pay names were minted for the folder ``hermes_home`` is."""
    want = env.get(HOME_NAME, "")
    return bool(want) and home_id(hermes_home) == want


def for_child(env: MutableMapping[str, str], child_home: Optional[str]) -> MutableMapping[str, str]:
    """``env`` for a child that runs in ``child_home`` (None: another profile, or not known): the pay names stay only
    when that folder is the one they were minted for. Mutates and returns ``env``."""
    try:
        keep = child_home is not None and bound(env, child_home)
    except Exception:  # noqa: BLE001 — any doubt drops the names
        keep = False
    if not keep:
        for name in PAY_NAMES:
            env.pop(name, None)
    return env


def _running_home() -> Optional[str]:
    try:
        from hermes_constants import get_hermes_home

        return str(get_hermes_home())
    except Exception:  # noqa: BLE001
        return os.environ.get("HERMES_HOME") or None


def bind_at_boot() -> bool:
    """Drops the pay names from this process (and from the exec-time snapshot ``restore_environ`` re-applies) unless it
    runs in the folder they were minted for. Returns True when they were dropped."""
    if not carries_pay_env(os.environ):
        return False
    try:
        if bound(os.environ, _running_home()):
            return False
    except Exception:  # noqa: BLE001
        pass
    for name in PAY_NAMES:
        os.environ.pop(name, None)
    try:
        from hermes_cli import iclone_policy_env

        iclone_policy_env.forget(PAY_NAMES)
    except Exception:  # noqa: BLE001
        pass
    return True
