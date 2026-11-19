"""v0.0.9 rt: a background terminal process belongs to the session that started it.

The sidebar's background dot reads ``process.list`` (``tui_gateway.server._session_processes``), which keeps only
the processes whose ``session_key`` equals the session's. The terminal tool stamped that key from
``get_current_session_key``: the turn's approval ContextVar, else ``HERMES_SESSION_KEY`` through
``get_session_env``, whose last resort is the PROCESS environment, and only then the tool call's own ``task_id``
(which a TUI turn sets to the session key). On a gateway host the process environment is not any one session's
identity, so a tool call that ran without the turn's ContextVars was filed under whatever key the process
environment held: missing from its own session's list, and shown in another's.
"""

from __future__ import annotations

import json
import threading

import pytest

import gateway.session_context as session_context
from tools.process_registry import process_registry

S_KEY = "20261119_000000_rtsess"
T_KEY = "20261119_000001_rtother"


@pytest.fixture
def server(monkeypatch, tmp_path):
    monkeypatch.setenv("TERMINAL_ENV", "local")
    monkeypatch.setenv("TERMINAL_CWD", str(tmp_path))
    monkeypatch.delenv("HERMES_SESSION_KEY", raising=False)
    from tui_gateway import server as srv
    started: list[str] = []
    yield srv, started
    for proc_id in started:
        process_registry.kill_process(proc_id)


def _session(srv, sid: str, key: str, tmp_path) -> dict:
    record = {"session_key": key, "cwd": str(tmp_path)}
    with srv._sessions_lock:
        srv._sessions[sid] = record
    return record


def _spawn(task_id: str, started: list[str]) -> str:
    from tools.terminal_tool import terminal_tool
    out = json.loads(terminal_tool("sleep 30", background=True, task_id=task_id))
    assert out.get("session_id"), out
    started.append(out["session_id"])
    return out["session_id"]


def _spawn_on_bare_thread(task_id: str, started: list[str]) -> str:
    """A tool call on a thread that carries none of the turn's ContextVars (a fresh context)."""
    box: dict = {}

    def run() -> None:
        try:
            box["id"] = _spawn(task_id, started)
        except BaseException as exc:  # surfaced below
            box["exc"] = exc

    worker = threading.Thread(target=run)
    worker.start()
    worker.join(30)
    if "exc" in box:
        raise box["exc"]
    return box["id"]


def _listed(srv, record: dict) -> list[str]:
    return [entry["session_id"] for entry in srv._session_processes(record)]


def _in_turn(srv, key: str, sid: str, fn):
    """Bind exactly what a TUI prompt turn binds (prompt_turn._prepare_turn_input)."""
    from tools.approval_context import reset_current_session_key, set_current_session_key
    approval = set_current_session_key(key)
    tokens = srv._set_session_context(key, ui_session_id=sid)
    try:
        return fn()
    finally:
        srv._clear_session_context(tokens)
        reset_current_session_key(approval)


def test_process_started_in_session_s_is_listed_for_s_even_off_the_turn_context(server, monkeypatch, tmp_path):
    """Red before the fix: the process was filed under the process environment's key (T), not S."""
    srv, started = server
    s = _session(srv, "sidS", S_KEY, tmp_path)
    t = _session(srv, "sidT", T_KEY, tmp_path)
    try:
        # A gateway host: some session has been bound in this process, and the process environment holds a key that
        # is not this call's session (an inherited launcher value, or a CLI/slash child's leftover).
        _in_turn(srv, T_KEY, "sidT", lambda: None)
        assert session_context.session_context_engaged()
        monkeypatch.setenv("HERMES_SESSION_KEY", T_KEY)

        proc_id = _spawn_on_bare_thread(S_KEY, started)

        assert process_registry.get(proc_id).session_key == S_KEY
        assert proc_id in _listed(srv, s)
        assert proc_id not in _listed(srv, t)
    finally:
        srv._sessions.pop("sidS", None)
        srv._sessions.pop("sidT", None)


def test_a_turn_bound_process_is_listed_for_its_session(server, tmp_path):
    srv, started = server
    s = _session(srv, "sidS", S_KEY, tmp_path)
    try:
        proc_id = _in_turn(srv, S_KEY, "sidS", lambda: _spawn(S_KEY, started))
        assert process_registry.get(proc_id).session_key == S_KEY
        assert proc_id in _listed(srv, s)
    finally:
        srv._sessions.pop("sidS", None)


def test_session_s_never_sees_session_t_processes(server, monkeypatch, tmp_path):
    """No widening: each session lists its own background processes and never the other's."""
    srv, started = server
    s = _session(srv, "sidS", S_KEY, tmp_path)
    t = _session(srv, "sidT", T_KEY, tmp_path)
    try:
        s_proc = _in_turn(srv, S_KEY, "sidS", lambda: _spawn(S_KEY, started))
        t_proc = _in_turn(srv, T_KEY, "sidT", lambda: _spawn(T_KEY, started))
        # Off-context spawn for T while the process environment names S: still T's alone.
        monkeypatch.setenv("HERMES_SESSION_KEY", S_KEY)
        t_bare = _spawn_on_bare_thread(T_KEY, started)

        assert s_proc in _listed(srv, s)
        assert {t_proc, t_bare}.isdisjoint(_listed(srv, s))
        assert {t_proc, t_bare} <= set(_listed(srv, t))
        assert s_proc not in _listed(srv, t)
    finally:
        srv._sessions.pop("sidS", None)
        srv._sessions.pop("sidT", None)


def test_the_turn_contextvar_still_wins_over_the_task_id(server, tmp_path):
    """A delegated child's task id is its own; inside the parent's turn context the process is the parent session's."""
    srv, started = server
    s = _session(srv, "sidS", S_KEY, tmp_path)
    try:
        proc_id = _in_turn(srv, S_KEY, "sidS", lambda: _spawn("child-task-1", started))
        assert process_registry.get(proc_id).session_key == S_KEY
        assert proc_id in _listed(srv, s)
    finally:
        srv._sessions.pop("sidS", None)


def test_cli_without_a_gateway_keeps_the_process_environment_key(server, monkeypatch):
    """No gateway in this process (never engaged): the legacy os.environ key is unchanged."""
    _srv, started = server
    monkeypatch.setattr(session_context, "_session_context_engaged", False)
    monkeypatch.setenv("HERMES_SESSION_KEY", "cli-env-key")
    proc_id = _spawn_on_bare_thread("default", started)
    assert process_registry.get(proc_id).session_key == "cli-env-key"
