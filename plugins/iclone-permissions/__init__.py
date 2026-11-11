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

import contextvars
import atexit
import collections
import json
import logging
import os
import sys
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


def _active_profile() -> Optional[str]:
    """The profile this call runs under: a routed turn's own, not the launch process's HERMES_PROFILE."""
    try:
        from hermes_constants import get_hermes_home_override

        routed = str(get_hermes_home_override() or "")
    except Exception:  # noqa: BLE001 — no scope to read: the launch value is the only name there is
        routed = ""
    if routed and os.path.basename(os.path.dirname(routed)) == "profiles":
        return os.path.basename(routed)
    return os.environ.get("HERMES_PROFILE") or None


def _share_stats(gate: Dict[str, Any]) -> None:
    """One count for the process: the first copy's, whichever copy decides and whichever writes."""
    global _stats, _stats_lock
    _stats = gate.setdefault("stats", _stats)
    _stats_lock = gate.setdefault("stats_lock", _stats_lock)


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


def _request_folder(tool_name: str, args: Any, task_id: str) -> Optional[str]:
    """fx19: the folder this call really runs in, by the terminal tool's own order: its ``workdir``, else the session's
    cwd record (``_cwd_for``), which is what seatbelt.py's ``execute`` is handed. A relative ``workdir`` is taken from
    the record, as the shell's ``cd`` would."""
    base = _cwd_for(task_id)
    workdir = args.get("workdir") if tool_name == "terminal" and isinstance(args, dict) else None
    if isinstance(workdir, str) and workdir.strip():
        expanded = os.path.expanduser(workdir.strip())
        return expanded if os.path.isabs(expanded) else os.path.join(base or os.getcwd(), expanded)
    return base


def _written_folder(tool_name: str, args: Any, folder: Optional[str]) -> Optional[str]:
    """fx21 (F3): the folder a file tool's write lands in, when the call names one by path (a new subfolder counts as
    the nearest folder that exists), else ``folder``. The runtime may not stat a folder main did not open: that EPERM
    means it is there. Only ``write_file`` and a path-form ``patch`` name one file."""
    path = args.get("path") if tool_name in {"write_file", "patch"} and isinstance(args, dict) else None
    if not isinstance(path, str) or not path.strip():
        return folder
    expanded = os.path.expanduser(path.strip())
    at = os.path.dirname(expanded if os.path.isabs(expanded) else os.path.join(folder or os.getcwd(), expanded))
    while at != os.path.dirname(at):
        try:
            os.stat(at)
            return at
        except PermissionError:
            return at
        except OSError:
            at = os.path.dirname(at)
    return folder


def _confinement_core() -> Any:
    """iclone-confinement's ``core`` when that plugin is live in this runtime, else ``None`` (nothing is confined, and
    classify's own project rule stands). Found by name: the plugin loader decides the package's spelling."""
    for name, module in list(sys.modules.items()):
        if name.endswith(("iclone_confinement.core", "iclone-confinement.core")):
            parent = sys.modules.get(name.rpartition(".")[0])
            return module if getattr(parent, "ACTIVE", False) else None
    return None


def _link_inside(folder: str, project: Optional[str]) -> bool:
    """fx22 (F-b): a component of ``folder`` is a symlink that sits inside ``project``."""
    if not project:
        return False
    real = os.path.realpath(project)
    at = os.path.abspath(folder)
    while at != os.path.dirname(at):
        parent = os.path.dirname(at)
        if os.path.islink(at):
            above = os.path.realpath(parent)
            if above == real or above.startswith(real.rstrip(os.sep) + os.sep):
                return True
        at = parent
    return False


def _confined_project(folder: Optional[str], task_id: str, classified: Optional[str]) -> Optional[str]:
    """fx19: the project ``SeatbeltEnvironment.request_project`` will confine this call to, so the sheet's "In folder",
    the pass and the mode lookup all name the launcher's folder. A folder the rule refuses (home, ~/Library, a .git)
    runs confined to the window's project; with no acceptable window folder either, to scratch: no project.
    fx22: a link inside the window's project names no folder, as a link beside it: its target is not listed by a link."""
    core = _confinement_core()
    if core is None or not folder:
        return classified
    try:
        from tools.file_tools_paths import _configured_terminal_cwd, _registered_task_cwd_override

        index = core.trusted_index()
        window = core.git_root(_registered_task_cwd_override(task_id) or _configured_terminal_cwd() or os.getcwd())
        if _link_inside(folder, window):
            return None
        root = core.git_root(folder)
        if core.acceptable_project_root(root, index):
            return os.path.realpath(root)
        return os.path.realpath(window) if core.acceptable_project_root(window, index) else None
    except Exception:  # noqa: BLE001 — no index, no rule: the confinement refuses the run itself
        return classified


def _confined_cwd(task_id: str) -> Optional[str]:
    """Where a run with no recorded folder starts: the window's folder, by the rule ``_confined_project`` reads."""
    try:
        from tools.file_tools_paths import _configured_terminal_cwd, _registered_task_cwd_override

        return _registered_task_cwd_override(task_id) or _configured_terminal_cwd() or os.getcwd()
    except Exception:  # noqa: BLE001 — no folder, no one-shot: the command stays confined
        return None


def _session_project(task_id: str) -> Optional[str]:
    """F50, S5: the project of the session's own window. A ``workdir`` or a path the agent names never selects a mode."""
    return _confined_project(_confined_cwd(task_id), task_id, None)


def _call_project(tool_name: str, args: Any, folder: Optional[str], task_id: str, classified: Optional[str]) -> Optional[str]:
    """fx19 + fx21 (F3): the sheet's "In folder", the pass and the mode lookup: the project the command runs in, unless
    a file tool's file lands outside it, which names that file's folder by the same rule."""
    project = _confined_project(folder, task_id, classified)
    written = _written_folder(tool_name, args, folder)
    if written == folder or not written:
        return project
    real = os.path.realpath(written)
    if project and (real == project or real.startswith(project.rstrip(os.sep) + os.sep)):
        return project
    return _confined_project(written, task_id, project)


# F40, L2: the session, parents and project of the tool call now running, set by the gate. Hermes' own ask paths run inside
# that call and know only a gateway key, which is not the id the policy's session rows use.
_CURRENT_CALL: "contextvars.ContextVar[Optional[tuple]]" = contextvars.ContextVar("iclone_current_call", default=None)


def _ignore_in_force(session_key: str = "") -> bool:
    """F40: Ignore for this session and folder, read from the signed policy and from nothing an agent can write.
    Unsigned or unreadable is never Ignore. Hermes' own ask paths read this through ``tools.approval``."""
    from .classify import project_root
    from .policy import effective_mode

    policy = _state.get("policy")
    body = policy.body() if policy is not None else None
    if body is None:
        return False
    current = _CURRENT_CALL.get()
    if current is not None:
        return effective_mode(body, current[0] or None, current[2], current[1]) == "ignore"
    lineage = _lineage(session_key) if session_key else None
    return effective_mode(body, session_key or None, project_root(_cwd_for("")), lineage) == "ignore"


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
            "profile": _active_profile(),
            "session_id": session_id or None,
            "subagent_id": kwargs.get("subagent_id") or None,
            "task_id": task_id or None,
        },
        "reason": str(kwargs.get("reason") or ""),  # only the agent's own words; the sheet shows no Why block without them
    }


def _refusal(mode: Optional[str], cause: str, todo: str) -> str:
    """G-98 F42: what a refused agent reads, so it never guesses: the cause, the mode, what to do."""
    named = (mode or "manual").capitalize()
    return f"{_REFUSED}: {cause}. Mode: {named}. What to do: {todo} Do not try another route to the same effect."


SCREEN_SWITCH_OFF = "the Screen recording switch (Let your agent see your screen) in Settings › Privacy is off"
SCREEN_SWITCH_TODO = "tell the owner what you need. They can turn on that switch in Settings > Privacy."


def _screen_switch_off(tool_name: str, args: Any, body: Any, mode: str = "") -> bool:
    """This switch stops a recording in every mode but Ignore, which lifts it as it lifts the other switches (F40; the
    owner's rule: in Ignore only total destruction is refused). Stopping and looking stay open."""
    if mode == "ignore" or tool_name != "screen_record" or (isinstance(args, dict) and args.get("action") in ("stop", "status")):
        return False
    return isinstance(body, dict) and (body.get("ceilings") or {}).get("screen") == "off"


# The Privacy switches as the pane titles them (privacy-copy.tsx; a test holds the two the same): the user finds a switch
# by these words.
_SWITCH_TITLES = {
    "terminal": "Let your agent run commands in a terminal",
    "fileWriting": "Let your agent create and change files",
    "webBrowsing": "Let your agent browse the web and use online tools",
    "automation": "Let your agent control other apps",
    "screen": "Let your agent see your screen",
    "clipboard": "Let your agent use the clipboard",
    "installSoftware": "Let your agent install software",
    "scheduledTasks": "Let your agent schedule tasks for later",
    "sendMessages": "Let your agent send email and messages for you",
    "spendTrade": "Let your agent spend and trade within your limits",
}


def _off_switch(body: Any, call: Any, parts: Any) -> Optional[str]:
    """The title of the switch that stopped this call: its own, else one of the parts it runs. ``None`` when no off
    switch is known, and the words stay general rather than name the wrong one."""
    ceilings = (body or {}).get("ceilings") or {}
    defaults = (body or {}).get("ceilingKey") or {}
    seen = [(call.ceiling_key, call.cls)] + [(p.get("ceilingKey"), p.get("cls")) for p in parts or ()]
    for key, cls in seen:
        key = key or defaults.get(cls)
        if ceilings.get(key) == "off" and key in _SWITCH_TITLES:
            return _SWITCH_TITLES[key]
    return None


def _switch_refused(title: Optional[str]) -> str:
    return f'the "{title}" switch in Settings > Privacy is off' if title else "a switch in Settings › Privacy"


def _todo_for(verdict: Any, floor: Optional[str], switch: Optional[str] = None, own_mode: bool = False) -> str:
    from .policy import floor_asks, is_total_destruction

    if str(getattr(verdict, "floor", None) or floor or "").startswith("unresolved delete:"):
        return ("write the path out literally, or set the variable earlier in this same command to a written path or to "
                "mktemp, then run it again.")
    if floor and not floor_asks(floor):  # G26: a floor that asks elsewhere is refused here by the mode or a switch, and that can change
        if is_total_destruction(floor):
            return "this stays refused in every mode. Tell the owner what you wanted to do; they can do it themselves."
        return "this mode refuses it, and only Ignore permissions runs it. Tell the owner what you wanted to do; they can do it themselves or change the mode with the permission selector in the Message bar."
    if verdict.rule == "mode":
        if own_mode:  # G21 P2: a session's mode beats Settings, and Settings never writes sessions
            return ("tell the owner what you need and why. This chat has its own permission mode, so Settings will not change "
                    "it. They can change it with the permission selector in the Message bar.")
        return "tell the owner what you need and why. They can change the permission mode in Settings > Permissions."
    if verdict.rule == "function":
        return f"tell the owner what you need. They can change the {verdict.fn} level in Settings > Permissions."
    if switch:
        return f'tell the owner what you need. They can turn on "{switch}" in Settings > Privacy.'
    return "tell the owner what you need. They can change this switch in Settings > Privacy."


def _own_profile_write(tool_name: str, args: Any) -> bool:
    if tool_name == "memory":
        from hermes_cli.iclone_policy_env import confined_at_exec, isolation_off

        return confined_at_exec() or isolation_off()  # G2 A6: in every process icloneOS started, the Seatbelt on or off
    if tool_name not in {"write_file", "patch"} or not isinstance(args, dict):
        return False
    if tool_name == "patch" and (str(args.get("mode") or "replace") == "patch" or args.get("patch")):
        return False  # a patch document may name many files
    from tools.iclone_own_profile import needs_no_ask

    return needs_no_ask(args.get("path"))


def _shell_one_shot(tool_name: str, args: Dict[str, Any], target: str, folder: Optional[str]) -> Optional[str]:
    """The folder an approved shell command would run in, when the call can run once outside the Seatbelt: the terminal
    tool, foreground, background or pty (G2 A4), whose whole text is what the owner reads. Anything else stays confined:
    execute_code above all, whose code talks back to the runtime's tools over a socket that exists only here and whose
    run is a script the runtime writes, so there is no one text for the row to hash; its sheet says it stays confined."""
    if tool_name != "terminal" or not isinstance(args, dict):
        return None
    command = args.get("command")
    if not isinstance(command, str) or command != target or not folder or not os.path.isabs(folder):
        return None
    return os.path.realpath(folder)


def _inside_the_run(path: str, folder: Optional[str], task_id: str) -> bool:
    """The kernel lets this run write there, so the run does it and no row is needed."""
    return any(base and (path + os.sep).startswith(os.path.realpath(base).rstrip(os.sep) + os.sep)
               for base in (folder, _session_project(task_id), _confined_cwd(task_id)))


def _file_spelling(args: Any, folder: Optional[str] = None) -> Optional[str]:
    raw = args.get("path") if isinstance(args, dict) else None
    expanded = os.path.expanduser(raw.strip()) if isinstance(raw, str) else ""
    # G28: ../.zshrc lands where classify says it does; with no route for it, Allow would end at the kernel's refusal.
    if expanded and not os.path.isabs(expanded) and folder:
        expanded = os.path.join(folder, expanded)
    if not os.path.isabs(expanded):
        return None
    folder, name = os.path.split(os.path.normpath(expanded))
    return os.path.join(os.path.realpath(folder), name)


def _file_one_shot(tool_name: str, args: Any, mode: Optional[str] = None, folder: Optional[str] = None, task_id: str = "") -> Optional[str]:
    """G2 A5, G23: the exact file main may record for one write outside the Seatbelt: any file under the home that a grant
    for its folder cannot open. Elsewhere that grant does it. Main and the launcher each judge it again. G23-W2: a link
    answers with its real target; a read comes here too, since the kernel refuses every class of confined command a read in
    the home outside its project (one-file-judges.live.test.ts), never in Plan, which stays as it is; Ignore adds a file a
    grant could open, outside this run's own folder."""
    if tool_name not in {"write_file", "patch", "read_file"} or not isinstance(args, dict):
        return None
    if tool_name == "patch" and (str(args.get("mode") or "replace") == "patch" or args.get("patch")):
        return None  # a patch document may name many files
    core = _confinement_core()
    if core is None or not core.runtime_confined():
        return None
    path = _file_spelling(args, folder)
    if path is None:
        return None
    try:
        index = core.trusted_index()
        if tool_name == "read_file" and (mode == "plan" or _inside_the_run(path, folder, task_id)):
            return None
        target, why = core.one_file_target(index, path)
        if why == core.ONE_FILE_GRANT and mode == "ignore" and not _inside_the_run(path, folder, task_id):
            target, why = core.one_file_target(index, path, opened=True)
        return target if why is None else None
    except Exception:  # noqa: BLE001 — no index, no rule: the ask goes on, as for any write
        return None


def _note_answer(core: Any, tool_name: str, args: Dict[str, Any], decided: Dict[str, Any], folder: Optional[str],
                 call_id: str = "", one_file: Optional[str] = None) -> None:
    """Hands main's answer to the run. Authority stays with main: the launcher reads main's record, not this."""
    if core is None:
        return
    if decided.get("oneShot") is True and isinstance(args.get("command"), str):
        core.note_approved_command(args["command"])
        return
    if decided.get("oneFile") is True:
        if one_file and tool_name != "read_file":
            core.note_approved_file(one_file)
        if one_file and tool_name in {"read_file", "patch"}:
            core.note_approved_read(one_file)
        return
    written = _written_folder(tool_name, args, folder)
    raw = args.get("path") if isinstance(args.get("path"), str) else ""
    # A relative path means something else once the run's folder moves: only a path that says where it lands.
    if written and written != folder and os.path.isabs(os.path.expanduser(raw.strip())):
        core.note_approved_folder(written, call_id) if call_id else core.note_approved_folder(written)


_PATCH_DOCUMENT_REFUSED = "with the Seatbelt on a patch document cannot write this file"


def _document_needs_the_route(target: Optional[str], mode: Optional[str], folder: Optional[str], task_id: str) -> bool:
    return any(_file_one_shot("write_file", {"path": path}, mode, folder, task_id) for path in str(target or "").split(", "))


def _is_patch_document(tool_name: str, args: Any) -> bool:
    return tool_name == "patch" and isinstance(args, dict) and (str(args.get("mode") or "replace") == "patch" or bool(args.get("patch")))


def _runtime_confined() -> bool:
    core = _confinement_core()
    return core is not None and core.runtime_confined()


def _runtime_secret_read(tool_name: str, target: Any) -> Optional[str]:
    """G28: the runtime's and this app's own secrets (auth.json, .env, vault, tokens) are read by no mode, so a sheet whose Allow
    the file tools then refuse is never shown. A project's .env keeps its ask: main may answer for that one file."""
    if tool_name not in PATH_READ_TOOLS or not isinstance(target, str) or not os.path.isabs(target):
        return None
    try:
        from agent.file_safety import get_read_block_error

        return get_read_block_error(target, route_answered=True)
    except Exception:  # noqa: BLE001 — the tools refuse it again; this only spares a sheet
        return None


PATH_READ_TOOLS = frozenset({"read_file", "search_files"})


def _block(message: str) -> Dict[str, str]:
    return {"action": "block", "message": message}


def _decide(tool_name: str, args: Dict[str, Any], task_id: str, session_id: str, invocation: str,
            kwargs: Dict[str, Any]) -> Optional[Dict[str, str]]:
    from .classify import CREDENTIAL_WRITE_FLOOR, classify, commit_process_input
    from .functions import functions_of
    from .policy import decide, session_has_own_mode

    started = time.perf_counter()
    policy = _state["policy"]
    channel = _state["channel"]
    body = policy.body()
    lineage = _lineage(session_id)
    folder = _request_folder(tool_name, args, task_id)
    call = classify(tool_name, args, folder, body or {}, session_id=session_id or None, lineage=lineage)
    shut = _runtime_secret_read(tool_name, call.target)
    if shut:
        return _block(f"{_REFUSED}: {shut} This stays refused in every mode, so no one is asked. Do not try another route to the same effect.")
    call.project = _call_project(tool_name, args, folder, task_id, call.project)
    session_project = _session_project(task_id)
    _CURRENT_CALL.set((session_id, lineage, session_project))
    # V3-F2 seam: the call's functions (candidates); each decides with the user's level for it, the strictest wins.
    fns = functions_of(tool_name, args, call, cwd=folder, policy=body or {},
                       session_id=session_id or None, lineage=lineage)  # R3-MONO: + the parts it reads
    verdict = decide(body, cls=call.cls, facts=call.facts, floor=call.floor, ceiling_key=call.ceiling_key,
                     session_id=session_id or None, project=call.project, mode_project=session_project, lineage=lineage, fns=fns)
    if _screen_switch_off(tool_name, args, body, verdict.mode):
        return _block(_refusal(verdict.mode, SCREEN_SWITCH_OFF, SCREEN_SWITCH_TODO))
    payload = _payload(tool_name, call.target, call.cls, call.facts, call.floor, call.ceiling_key, call.project,
                       task_id, session_id, lineage, kwargs)
    payload.update(fns=list(fns), fn=verdict.fn, parts=fns.wire(), unread=fns.unread)
    payload.update(sessionProject=session_project)
    one_shot_cwd = _shell_one_shot(tool_name, args, call.target, folder or _confined_cwd(task_id))
    if one_shot_cwd:
        payload.update(oneShotCwd=one_shot_cwd)
    one_file_path = _file_one_shot(tool_name, args, verdict.mode, folder, task_id)
    if one_file_path:
        payload.update(oneFilePath=one_file_path)
        spelled = _file_spelling(args, folder)
        if spelled and spelled != one_file_path:
            payload.update(oneFileLink=spelled)

    # G-98 F42: the agent's own profile, in every mode: SOUL, memories, its folder files. Never the permission files
    # (tools/iclone_own_profile.py decides by real path); reachable main is still required, as for every write.
    outcome, why = ("allow" if _own_profile_write(tool_name, args) else verdict.outcome), None
    switch = None
    if outcome == "refuse":
        if verdict.rule == "ceiling" and not (verdict.floor or call.floor):
            switch = _off_switch(body, call, fns.wire())
        why = verdict.floor or call.floor or (f"the {verdict.mode} permission mode" if verdict.rule == "mode"
                             else f"your {verdict.fn} level ({verdict.level})" if verdict.rule == "function"
                             else _switch_refused(switch))
    elif call.cls != "R" and not channel.healthy:
        # §4: main unreachable (or never attested) ⇒ nothing but reading, and the refusal is logged for replay.
        outcome, why = "refuse", _UNREACHABLE

    # G23: this write only happens with main's row, and only main writes one: in Ignore it does so at once, in any other
    # mode it shows the sheet, whatever a grant or level says, since no grant opens this folder.
    if outcome == "allow" and one_file_path and not _own_profile_write(tool_name, args):
        outcome = "ask"

    # G25: the route opens one named file and a patch document may name many, so with the Seatbelt on this write can only fail.
    # G27: that holds for every file the route would take, not only the credential list, and before a sheet that cannot help.
    if outcome != "refuse" and _is_patch_document(tool_name, args) and _runtime_confined() and (
            call.floor == CREDENTIAL_WRITE_FLOOR or _document_needs_the_route(call.target, verdict.mode, folder, task_id)):
        if _claim(invocation):
            channel.emit(dict(payload, mode=verdict.mode, outcome="refuse", reason=_PATCH_DOCUMENT_REFUSED))
            _record("refuse")
        return _block(f"{_REFUSED}: {_PATCH_DOCUMENT_REFUSED}. Use the patch tool in replace mode, with path, old_string and new_string, one file at a time.")

    if outcome == "allow":
        # fx47: a stored grant gets no sheet, so nothing else tells the run the folder of this write; the launcher still judges it.
        if verdict.grant_id:
            _note_answer(_confinement_core(), tool_name, args, {}, folder, str(kwargs.get("tool_call_id") or ""))
        if _claim(invocation):
            channel.emit(dict(payload, mode=verdict.mode, outcome="allow", grantId=verdict.grant_id))
            _record("allow", started)
        commit_process_input(args)
        return None

    if outcome == "refuse":
        if _claim(invocation):
            channel.emit(dict(payload, mode=verdict.mode, outcome="refuse", reason=why))
            _record("refuse")
        own_mode = session_has_own_mode(body or {}, session_id or None, lineage)
        return _block(_refusal(verdict.mode, why, _todo_for(verdict, call.floor, switch, own_mode) if why != _UNREACHABLE
                               else "icloneOS must be running. Tell the owner, and retry when it is back."))

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
        _note_answer(_confinement_core(), tool_name, args, decided, folder, str(kwargs.get("tool_call_id") or ""), one_file_path)
        return None
    return _block(_refusal(verdict.mode, str(decided.get("reason") or "refused")[:300],
                           "do not repeat this call unchanged. Ask the owner what they would accept, or do something else."))


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
            call = classify(tool_name, args if isinstance(args, dict) else {}, _request_folder(tool_name, args, task_id),
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


# Every tool here refuses by itself under a backend confinement will not run (tools/terminal_scope.py). A name missing
# from this list only costs a sheet before the same refusal; it never lets anything run.
_BACKEND_TOOLS = frozenset({"terminal", "execute_code", "read_file", "write_file", "patch", "search_files"})


def _backend_refusal(tool_name: str) -> Optional[str]:
    """The reason a backend tool cannot run in this process or scope, or None. It answers before the gate: the owner gets
    no sheet to approve a command that could not run anyway, and blocking here is the same refusal one step earlier."""
    if tool_name not in _BACKEND_TOOLS:
        return None
    from tools.terminal_scope import TerminalPolicyUnavailable, enforce_no_refusal

    try:
        enforce_no_refusal()
    except TerminalPolicyUnavailable as exc:
        return str(exc)
    return None


def _forget_approved_folder(call_id: str = "") -> None:
    """F50: an approved write's folder lasts one tool call, so nothing a later command names can move it there."""
    core = _confinement_core()
    if core is not None:
        core.forget_approved_folder(call_id) if call_id else core.forget_approved_folder()


def _scheduled_script_ignore(body: Optional[Dict[str, Any]]) -> bool:
    """Ignore for a scheduled script: the mode set for the folder the runtime works in, else the Settings default. No session
    counts, so not the chat whose cronjob 'run' fired it, though its call context and session key ride into the run."""
    from .classify import project_root
    from .policy import effective_mode

    return body is not None and effective_mode(body, None, project_root(_cwd_for("")), None) == "ignore"


def _unattended_floor(tool_name: str, args: Dict[str, Any], cwd: Optional[str]) -> Optional[str]:
    """G102: the floor that stops text running with no tool call (a scheduled job's script), on the signed policy, or None.
    Ignore is decided here, by ``_scheduled_script_ignore``, never by the session probe: hence ``_unattended_ignore_refuses``."""
    from .classify import classify
    from .policy import ignore_refuses

    policy = _state.get("policy")
    body = policy.body() if policy is not None else None
    floor = classify(tool_name, args, cwd, body or {}).floor
    if floor and _scheduled_script_ignore(body) and not ignore_refuses(floor):
        return None
    return floor


def _unattended_ignore_refuses(_floor: str) -> bool:
    """A floor ``_unattended_floor`` still names is one this script's Ignore refuses, or one outside it: the session's Ignore,
    which Hermes' approval reads next, must not let it through."""
    return True


def on_post_tool_call(tool_name: str = "", **kwargs: Any) -> None:
    _forget_approved_folder(str(kwargs.get("tool_call_id") or ""))


def on_pre_tool_call(tool_name: str = "", args: Optional[Dict[str, Any]] = None, task_id: str = "",
                     session_id: str = "", **kwargs: Any) -> Optional[Dict[str, str]]:
    invocation = str(kwargs.get("hook_invocation_id") or kwargs.get("tool_call_id") or uuid.uuid4().hex)
    try:
        _forget_approved_folder()
        refusal = _backend_refusal(tool_name)
        if refusal:
            _fail_closed_record(tool_name, args if isinstance(args, dict) else {}, task_id, session_id, invocation, refusal)
            return _block(refusal)
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


def _pin_hermes_approval(approval) -> None:
    approval.mark_iclone_permissions_active()
    approval.set_iclone_ignore_probe(_ignore_in_force)
    approval.set_iclone_unattended_floor(_unattended_floor, _unattended_ignore_refuses)


def register(ctx) -> None:
    if not LOCKED:
        logger.debug("iclone-permissions: not started by icloneOS — inert")
        return
    from hermes_cli.iclone_policy_env import process_gate

    # A routed home imports its own copy of this plugin: one gate per process, or that copy has no key and refuses.
    # A copy that is not the bundled plugin gets none, and no entry in _state: every call it sees is an internal error.
    held = process_gate()
    if held is None:
        logger.warning("iclone-permissions: this copy is not the bundled gate; it refuses every call")
        ctx.register_hook("pre_tool_call", on_pre_tool_call)
        return
    gate, first = held
    _state.update(gate)
    _share_stats(gate)
    ctx.register_hook("pre_tool_call", on_pre_tool_call)
    ctx.register_hook("post_tool_call", on_post_tool_call)
    try:
        from tools import approval

        _pin_hermes_approval(approval)
    except Exception:  # noqa: BLE001
        logger.warning("iclone-permissions: Hermes approval pin unavailable; Hermes keeps its own manual gate")
    if not first:
        return
    hello = _state["channel"].hello({"plugin": PLUGIN_VERSION})
    if not hello.ok:
        logger.warning("iclone-permissions: icloneOS did not attest this process (%s); only reading is allowed", hello.error)
    atexit.register(_at_exit)
