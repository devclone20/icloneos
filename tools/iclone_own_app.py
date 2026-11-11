"""S9: computer use against icloneOS itself. Main's gesture lock asks for real input on this app's window, and input from
the cua driver may be exactly that, so the lock cannot tell the agent from the owner. This rule lives where the target is
known: in any mode but Ignore, the tool refuses input aimed at the app's own process, which owns the selector, the
isolation control and every native alert of the app. It also refuses a foreground delivery while a window of the app is
above the target, since foreground input lands on what is on top. In Ignore permissions it is allowed, by the owner's
rule. Outside the app (no policy lock) there is no such app to protect. A check in the runtime, not a kernel wall."""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, FrozenSet, Optional

logger = logging.getLogger(__name__)

_APP_NAMES = frozenset({"iclone os", "icloneos"})


def app_pids() -> FrozenSet[int]:
    """This runtime's ancestors: the app's main process, which owns its windows, is one of them."""
    pids = {os.getppid()}
    try:
        pids.add(os.getpgrp())
    except OSError:  # pragma: no cover
        pass
    try:
        import psutil

        pids.update(parent.pid for parent in psutil.Process().parents())
    except Exception:  # noqa: BLE001 (the parent and the group above still stand)
        logger.debug("computer_use: the runtime's ancestors could not be read", exc_info=True)
    return frozenset(pid for pid in pids if pid > 1 and pid != os.getpid())


def _is_app(pid: Any, name: Any, own: FrozenSet[int]) -> bool:
    return pid in own or (isinstance(name, str) and name.strip().lower() in _APP_NAMES)


def _app_is_above_target(backend: Any, own: FrozenSet[int]) -> bool:
    """Whether a window of the app is over the target, frontmost first. A list that cannot be read counts as yes."""
    try:
        windows = backend.list_windows()
    except Exception:  # noqa: BLE001
        logger.debug("computer_use: the window list could not be read for a foreground delivery", exc_info=True)
        return True
    target = getattr(backend, "_active_window_id", None)
    for window in windows:
        if target is not None and window.get("window_id") == target:
            return False
        if _is_app(window.get("pid"), window.get("app_name"), own):
            return True
    return False


def _raised_target(backend: Any, own: FrozenSet[int]) -> bool:
    """After Allow the app's own window is in front, so a foreground act the owner just allowed would always be refused.
    The act already takes the foreground: raise its target, and it may go only if the list then shows the target on top."""
    try:
        if not backend.bring_to_front(pid=backend._active_pid, window_id=backend._active_window_id).ok:
            return False
    except Exception:  # noqa: BLE001
        logger.debug("computer_use: the target could not be raised for a foreground delivery", exc_info=True)
        return False
    for _ in range(5):  # the window server takes a moment to reorder
        if not _app_is_above_target(backend, own):
            return True
        time.sleep(0.1)
    return False


def _refused(action: str, what: str) -> str:
    return json.dumps({
        "ok": False, "action": action, "code": "own_app_control",
        "error": f"Refused: {what}. The permission selector, the isolation control and the app's native alerts answer "
                 "only to the owner's hand in this permission mode.",
        "hint": "Tell the owner what you need and let them click it. In Ignore permissions this is allowed.",
    })


def refusal(backend: Any, action: str, delivery_mode: Optional[str]) -> Optional[str]:
    """The JSON refusal for an input action on the sticky target, or None when it may go."""
    from tools.approval import iclone_ignore_in_force, iclone_policy_locked

    if not iclone_policy_locked() or iclone_ignore_in_force():
        return None
    own = app_pids()
    if _is_app(getattr(backend, "_active_pid", None), getattr(backend, "_last_app", None), own):
        return _refused(action, "computer use does not drive icloneOS's own window or alerts")
    if delivery_mode == "foreground" and _app_is_above_target(backend, own) and not _raised_target(backend, own):
        return _refused(action, "a window of icloneOS is above the target, and foreground input lands on what is on top")
    return None
