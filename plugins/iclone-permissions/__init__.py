"""iclone-permissions — the five permission modes of icloneOS, enforced on every tool call (V3-F).

Inert unless icloneOS started this Hermes (the lock in the EXEC-TIME environment, hermes_cli/iclone_policy_env.py).
Then one ``pre_tool_call`` hook:

1. classify the call (classify.py) — one action class, the literal target, the footnote facts, the floor — and map it
   to the user's functions (functions.py, V3-F2: a separate pure module that never changes the classifier's verdict);
2. decide locally from the policy main signed for this spawn (policy.py) — allow and refuse are logged ahead and
   delivered to main in order (channel.py); a forged, missing or replayed policy means Manual;
3. an ask is registered with main in the same order; main decides again from its own state and, if it is a real
   ask, puts it on the consent sheet. The hook waits a bounded time for the owner, then blocks with "waiting for
   your permission" — the sheet stays up, and the agent's retry gets the answer.

Fail closed everywhere: an exception anywhere in the hook is a refusal with a record; main unreachable means nothing
but reading; a block Hermes itself decides (timeout, a rewritten argument, a sub-agent's toolset) is recorded too.
The spawn key never touches the environment or argv: it arrives once on an inherited pipe.
"""

from __future__ import annotations

import atexit
import collections
import json
import logging
import os
import threading
import time
import uuid
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

PLUGIN_VERSION = "0.2.0"


def _spawn_lock() -> bool:
    try:
        from hermes_cli.iclone_policy_env import locked

        return locked()
    except Exception:  # noqa: BLE001 — outside a Hermes checkout: the plain env is all there is
        return os.environ.get("ICLONE_POLICY_LOCK") == "1"


def _spawn_env(name: str) -> Optional[str]:
    try:
        from hermes_cli.iclone_policy_env import exec_env

        return exec_env(name)
    except Exception:  # noqa: BLE001
        return None


LOCKED = _spawn_lock()

# The ask wait stays well inside Hermes' pre_tool_call timeout (default 30 s; past it the callback is abandoned and
# that caller thread's next call is refused for 60 s — measured in tests/plugins/test_iclone_permissions.py).
_ASK_WAIT_CAP_S = 20.0
_ASK_WAIT_MARGIN_S = 5.0

_REFUSED = "BLOCKED by icloneOS permissions"
_INTERNAL_ERROR = "icloneOS permissions: internal error, refused (fail closed). Do not try another route to the same effect."
_UNREACHABLE = "icloneOS is not reachable, so nothing but reading is allowed (fail closed)"

_state: Dict[str, Any] = {}

# Soak evidence (V3-F §6): every decision record this process produced, and the local-allow latency, written to
# $HERMES_HOME/iclone-perm-stats/<pid>.json so the gate can compare it with main's audit records for this pid.
_STATS_EVERY = 50
_LATENCY_KEEP = 20_000
_stats_lock = threading.Lock()
_stats: Dict[str, Any] = {"pid": os.getpid(), "decisions": 0, "allow": 0, "refuse": 0, "ask": 0,
                          "hermes_blocked": 0, "allow_ms": []}

# One decision record per tool call: the hook and Hermes' own fail-closed path race to claim the invocation.
_CLAIMS_KEEP = 20_000
_claims_lock = threading.Lock()
_claims: "collections.OrderedDict[str, bool]" = collections.OrderedDict()

_LINEAGE_KEEP = 2_000
_lineage_lock = threading.Lock()
_lineage_cache: "collections.OrderedDict[str, List[str]]" = collections.OrderedDict()


def _claim(invocation: str) -> bool:
    with _claims_lock:
        if invocation in _claims:
            return False
        _claims[invocation] = True
        while len(_claims) > _CLAIMS_KEEP:
            _claims.popitem(last=False)
        return True


def _record(outcome: str, started: Optional[float] = None) -> None:
    with _stats_lock:
        _stats["decisions"] += 1
        _stats[outcome] += 1
        if outcome == "allow" and started is not None:
            samples: List[float] = _stats["allow_ms"]
            samples.append(round((time.perf_counter() - started) * 1000, 3))
            del samples[:-_LATENCY_KEEP]
        due = _stats["decisions"] % _STATS_EVERY == 0
    if due:
        _write_stats()


def _hermes_home() -> str:
    return os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")


def _write_stats() -> None:
    folder = os.path.join(_hermes_home(), "iclone-perm-stats")
    try:
        os.makedirs(folder, mode=0o700, exist_ok=True)
        with _stats_lock:
            text = json.dumps(_stats)
        target = os.path.join(folder, f"{os.getpid()}.json")
        with open(target + ".tmp", "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(target + ".tmp", target)
    except OSError:
        pass


def ask_wait_seconds() -> float:
    try:
        from hermes_cli.plugins import _resolve_hook_callback_timeout

        timeout = float(_resolve_hook_callback_timeout())
    except Exception:  # noqa: BLE001
        timeout = 30.0
    if timeout <= 0:  # the hook runs synchronously, unbounded
        return _ASK_WAIT_CAP_S
    return max(0.0, min(_ASK_WAIT_CAP_S, timeout - _ASK_WAIT_MARGIN_S))


def _cwd_for(task_id: str) -> Optional[str]:
    """The session's own workspace (Hermes' per-session cwd record), the anchor its file tools resolve against."""
    try:
        try:  # upstream 1ac3f97 moved it to file_tools_paths; the old location silently fell back to the process cwd
            from tools.file_tools_paths import _authoritative_workspace_root
        except ImportError:  # pragma: no cover — a pre-split runtime
            from tools.file_tools import _authoritative_workspace_root

        cwd = _authoritative_workspace_root(task_id or "default")
        if cwd:
            return str(cwd)
    except Exception:  # noqa: BLE001
        pass
    return os.getcwd()


def _lineage(session_id: str) -> List[str]:
    """This session, then its parents to the root (delegated sub-agents and compressed segments inherit, §2, F-16)."""
    if not session_id:
        return []
    with _lineage_lock:
        cached = _lineage_cache.get(session_id)
    if cached is not None:
        return cached
    chain = [session_id]
    found = False
    try:
        from hermes_cli.goals import _get_session_db

        db = _get_session_db()
        if db is not None:
            root_to_tip = db._session_lineage_root_to_tip(session_id)
            if root_to_tip:
                chain = [sid for sid in reversed(root_to_tip) if sid][:16] or chain
                found = True
    except Exception:  # noqa: BLE001 — no lineage known: the session's own id, then project/standing
        pass
    if found:
        with _lineage_lock:
            _lineage_cache[session_id] = chain
            while len(_lineage_cache) > _LINEAGE_KEEP:
                _lineage_cache.popitem(last=False)
    return chain


def build(policy_file: Optional[str], key: Optional[bytes], key_id: str, sock: Optional[str], token_file: Optional[str],
          spool_dir: Optional[str], beat_seconds: Optional[float] = None) -> Dict[str, Any]:
    from .channel import BEAT_SECONDS, Channel
    from .policy import SignedPolicy

    policy = SignedPolicy(policy_file, key)
    return {
        "policy": policy,
        "channel": Channel(sock, token_file, key, key_id, spool_dir, on_gen=policy.raise_floor,
                           beat_seconds=beat_seconds or BEAT_SECONDS),
    }


def _payload(tool_name: str, target: str, cls: str, facts: Dict[str, bool], floor: Optional[str],
             ceiling_key: Optional[str], project: Optional[str], task_id: str, session_id: str,
             lineage: List[str], kwargs: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "tool": tool_name,
        "target": target,
        "cls": cls,
        "facts": facts,
        "floor": floor,
        "ceilingKey": ceiling_key,
        "project": project,
        "lineage": lineage,
        "agent": {
            "inft": _spawn_env("ICLONE_INFT") or os.environ.get("ICLONE_INFT") or None,
            "profile": os.environ.get("HERMES_PROFILE") or None,
            "session_id": session_id or None,
            "subagent_id": kwargs.get("subagent_id") or None,
            "task_id": task_id or None,
        },
        "reason": str(kwargs.get("reason") or f"{tool_name} wants to run"),
    }


def _block(message: str) -> Dict[str, str]:
    return {"action": "block", "message": message}


def _decide(tool_name: str, args: Dict[str, Any], task_id: str, session_id: str, invocation: str,
            kwargs: Dict[str, Any]) -> Optional[Dict[str, str]]:
    from .classify import classify, commit_process_input
    from .functions import functions_of
    from .policy import decide

    started = time.perf_counter()
    policy = _state["policy"]
    channel = _state["channel"]
    body = policy.body()
    lineage = _lineage(session_id)
    call = classify(tool_name, args, _cwd_for(task_id), body or {}, session_id=session_id or None, lineage=lineage)
    # V3-F2 seam: the call's functions (candidates); each decides with the user's level for it, the strictest wins.
    fns = functions_of(tool_name, args, call, cwd=_cwd_for(task_id), policy=body or {},
                       session_id=session_id or None, lineage=lineage)  # R3-MONO: + the parts it reads
    verdict = decide(body, cls=call.cls, facts=call.facts, floor=call.floor, ceiling_key=call.ceiling_key,
                     session_id=session_id or None, project=call.project, lineage=lineage, fns=fns)
    payload = _payload(tool_name, call.target, call.cls, call.facts, call.floor, call.ceiling_key, call.project,
                       task_id, session_id, lineage, kwargs)
    payload.update(fns=list(fns), fn=verdict.fn, parts=fns.wire(), unread=fns.unread)

    outcome, why = verdict.outcome, None
    if outcome == "refuse":
        why = call.floor or (f"the {verdict.mode} permission mode" if verdict.rule == "mode"
                             else f"your {verdict.fn} level ({verdict.level})" if verdict.rule == "function"
                             else "a switch in Settings › Privacy")
    elif call.cls != "R" and not channel.healthy:
        # §4: main unreachable (or never attested) ⇒ nothing but reading, and the refusal is logged for replay.
        outcome, why = "refuse", _UNREACHABLE

    if outcome == "allow":
        if _claim(invocation):
            channel.emit(dict(payload, mode=verdict.mode, outcome="allow", grantId=verdict.grant_id))
            _record("allow", started)
        commit_process_input(args)
        return None

    if outcome == "refuse":
        if _claim(invocation):
            channel.emit(dict(payload, mode=verdict.mode, outcome="refuse", reason=why))
            _record("refuse")
        return _block(f"{_REFUSED}: {why}. Do not try another route to the same effect.")

    if not _claim(invocation):
        return _block(f"{_REFUSED}: this call was already refused.")
    _record("ask")
    answer, _seq = channel.register_ask(dict(payload, mode=verdict.mode))
    if not answer.ok:
        return _block(f"{_REFUSED}: {_UNREACHABLE}.")
    decided = answer.body
    if decided.get("state") == "pending" and isinstance(decided.get("askId"), str):
        remaining = ask_wait_seconds() - (time.perf_counter() - started)
        waited = channel.await_answer(decided["askId"], remaining) if remaining > 0 else None
        if waited is None or not waited.ok or waited.body.get("state") != "decided":
            return _block(
                "Waiting for the owner's permission in icloneOS (the request stays open for two minutes). "
                "Tell the owner what you asked for, then retry this same call once they answered."
            )
        decided = waited.body
    if decided.get("allowed") is True:
        commit_process_input(args)
        return None
    return _block(f"{_REFUSED}: {str(decided.get('reason') or 'refused')[:300]}.")


def _fail_closed_record(tool_name: str, args: Any, task_id: str, session_id: str, invocation: str, reason: str) -> None:
    """A refusal record for a call no normal decision covered. Best effort by design: it must never raise."""
    try:
        if not _claim(invocation):
            return
        channel = _state.get("channel")
        if channel is None:
            return
        cls, target, project = "X", str(tool_name), None
        try:
            from .classify import classify

            policy = _state.get("policy")
            call = classify(tool_name, args if isinstance(args, dict) else {}, _cwd_for(task_id),
                            (policy.body() if policy else None) or {})
            cls, target, project = call.cls, call.target, call.project
        except BaseException:  # noqa: BLE001 — the classifier is what failed: record it as an unknown shell
            pass
        payload = _payload(str(tool_name), target, cls, {}, None, None, project, task_id, session_id,
                           [session_id] if session_id else [], {})
        channel.emit(dict(payload, mode="manual", outcome="refuse", reason=reason[:300]))
        _record("refuse")
    except BaseException:  # noqa: BLE001
        logger.exception("iclone-permissions: could not record a fail-closed refusal")


def on_pre_tool_call(tool_name: str = "", args: Optional[Dict[str, Any]] = None, task_id: str = "",
                     session_id: str = "", **kwargs: Any) -> Optional[Dict[str, str]]:
    invocation = str(kwargs.get("hook_invocation_id") or kwargs.get("tool_call_id") or uuid.uuid4().hex)
    try:
        return _decide(tool_name, args if isinstance(args, dict) else {}, task_id, session_id, invocation, kwargs)
    except BaseException as exc:  # noqa: BLE001 — F-1: an exception is a refusal, never a run
        logger.warning("iclone-permissions: %s while deciding %s — refused", type(exc).__name__, tool_name)
        _fail_closed_record(tool_name, args, task_id, session_id, invocation,
                            f"internal error ({type(exc).__name__}); refused (fail closed)")
        return _block(_INTERNAL_ERROR)


def on_hermes_fail_closed(reason: str, payload: Dict[str, Any]) -> None:
    """Hermes blocked a call this gate did not decide (timeout, still running, rewritten args, sub-agent toolset)."""
    with _stats_lock:
        _stats["hermes_blocked"] += 1
    invocation = str(payload.get("hook_invocation_id") or payload.get("tool_call_id") or uuid.uuid4().hex)
    _fail_closed_record(str(payload.get("tool_name") or ""), payload.get("args") or {}, str(payload.get("task_id") or ""),
                        str(payload.get("session_id") or ""), invocation, f"Hermes refused it: {reason}")


on_pre_tool_call.__iclone_permissions_gate__ = True  # type: ignore[attr-defined]
on_pre_tool_call.__hermes_fail_closed__ = on_hermes_fail_closed  # type: ignore[attr-defined]


def _at_exit() -> None:
    channel = _state.get("channel")
    if channel is not None:
        channel.close(2.0)
    _write_stats()


def register(ctx) -> None:
    if not LOCKED:
        logger.debug("iclone-permissions: not started by icloneOS — inert")
        return
    try:
        from hermes_cli.iclone_policy_env import take_policy_key

        handed = take_policy_key()
    except Exception:  # noqa: BLE001
        handed = None
    key_id, key = handed if handed else ("", None)
    _state.update(
        build(
            _spawn_env("ICLONE_POLICY_FILE"),
            key,
            key_id,
            _spawn_env("ICLONE_PERM_SOCKET"),
            _spawn_env("ICLONE_PERM_TOKEN_FILE"),
            os.path.join(_hermes_home(), "iclone-perm-spool"),
        )
    )
    ctx.register_hook("pre_tool_call", on_pre_tool_call)
    try:
        from tools import approval

        approval.mark_iclone_permissions_active()
    except Exception:  # noqa: BLE001
        logger.warning("iclone-permissions: Hermes approval pin unavailable; Hermes keeps its own manual gate")
    hello = _state["channel"].hello({"plugin": PLUGIN_VERSION})
    if not hello.ok:
        logger.warning("iclone-permissions: icloneOS did not attest this process (%s); only reading is allowed", hello.error)
    atexit.register(_at_exit)
