"""v0.0.9 rt: a refused tool call is SHOWN to the client, never silent.

Seen in the Desktop e2e (correction-session-switch): under Manual mode a foreground ``terminal sleep 5`` was refused by
a ``pre_tool_call`` gate (icloneOS permissions) and the client got ``tool.generating`` and then nothing: no approval
request, no ``tool.start`` / ``tool.complete``, no refusal text. The model was told; the owner was not, so it read as
if the command ran. A refusal is now a ``tool.start`` + ``tool.complete`` pair carrying the reason. The refusal itself
is unchanged: the command still never runs.

Real ``hermes serve`` (the argv Desktop spawns) with a sandboxed HOME and a user plugin that refuses one command shape,
standing in for the icloneOS gate (which is inert outside icloneOS).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.e2e.core.terminal._gateway_client import Backend
from tests.fakes.fake_llm_provider import Text, ToolCall

REASON = "RT-GATE: Manual mode refused this command; ask the owner first."
MARK = "rt_refuse_marker"

_PLUGIN_INIT = f'''
def _pre(tool_name="", args=None, **_):
    if tool_name == "terminal" and "{MARK}" in str((args or {{}}).get("command") or ""):
        return {{"action": "block", "message": {REASON!r}}}
    return None


def register(ctx):
    ctx.register_hook("pre_tool_call", _pre)
'''


class Script:
    def __init__(self, command: str, background: bool) -> None:
        self.command, self.background = command, background
        self.tool_results: list[str] = []

    def __call__(self, record: dict):
        messages = record["body"].get("messages") or []
        last = messages[-1] if messages else {}
        if last.get("role") == "tool":
            self.tool_results.append(str(last.get("content") or ""))
            return Text("RT done.")
        args = {"command": self.command}
        if self.background:
            args["background"] = True
        return ToolCall("terminal", args, text="Running it.")


def _backend(root: Path, script: Script) -> Backend:
    plugin = root / "home" / ".hermes" / "plugins" / "rt-gate"
    plugin.mkdir(parents=True)
    (plugin / "plugin.yaml").write_text("name: rt-gate\nversion: \"0.0.1\"\ndescription: test gate\nhooks:\n  - pre_tool_call\n")
    (plugin / "__init__.py").write_text(_PLUGIN_INIT)
    return Backend(root, script, extra_config="plugins:\n  enabled:\n    - rt-gate\nterminal:\n  backend: local\n")


@pytest.mark.parametrize("background", [False, True], ids=["foreground", "background"])
def test_a_refused_terminal_call_is_shown_and_never_runs(tmp_path, background):
    victim = tmp_path / "ran.txt"
    script = Script(f"sleep 1; touch {victim}  # {MARK}", background)
    be = _backend(tmp_path, script).start()
    try:
        a = be.connect("A")
        sid = a.call("session.create", cols=100, source="desktop")["session_id"]
        a.call("prompt.submit", session_id=sid, text="run the gated command")
        a.wait_for(lambda f: (f.get("params") or {}).get("type") == "message.complete"
                   and (f.get("params") or {}).get("session_id") == sid, timeout=90, what="message.complete")

        events = [f.get("params") or {} for f in a.snapshot()]
        mine = [e for e in events if e.get("session_id") == sid]
        starts = [e.get("payload") or {} for e in mine if e.get("type") == "tool.start"]
        completes = [e.get("payload") or {} for e in mine if e.get("type") == "tool.complete"]
        approvals = [f for f in a.snapshot() if f.get("method") == "approval.request"]
        # Never silent: an approval request, or a start/complete pair that carries the refusal.
        assert approvals or (starts and completes), json.dumps([e.get("type") for e in mine])
        assert [s.get("name") for s in starts] == ["terminal"]
        assert [c.get("name") for c in completes] == ["terminal"]
        assert starts[0].get("tool_id") and starts[0]["tool_id"] == completes[0]["tool_id"]
        shown = json.dumps(completes[0])
        assert REASON in shown, shown
        assert completes[0].get("refused") is True

        # The refusal is not loosened: the model got it and the command never ran.
        assert script.tool_results and REASON in script.tool_results[0]
        assert not victim.exists(), "a refused command ran"
    finally:
        be.stop()


def test_a_refused_call_reads_back_as_refused_from_the_stored_session(tmp_path):
    """Reload / switch back: the stored tool row says refused + reason, so a refused command never reads as ran."""
    victim = tmp_path / "ran.txt"
    script = Script(f"sleep 1; touch {victim}  # {MARK}", False)
    be = _backend(tmp_path, script).start()
    try:
        a = be.connect("A")
        sid = a.call("session.create", cols=100, source="desktop")["session_id"]
        a.call("prompt.submit", session_id=sid, text="run the gated command")
        a.wait_for(lambda f: (f.get("params") or {}).get("type") == "message.complete"
                   and (f.get("params") or {}).get("session_id") == sid, timeout=90, what="message.complete")

        # Read back from the session store (session.history reads the DB rows), on a fresh connection.
        b = be.connect("B")
        history = b.call("session.history", session_id=sid)["messages"]
        tools = [m for m in history if m.get("role") == "tool"]
        assert [t.get("name") for t in tools] == ["terminal"], history
        meta = tools[0].get("display_metadata") or {}
        assert meta.get("refused") is True, tools[0]
        assert meta.get("refusal_reason") == REASON, tools[0]

        assert not victim.exists(), "a refused command ran"
    finally:
        be.stop()


def test_an_ordinary_tool_row_is_not_marked_refused(tmp_path):
    script = Script("echo rt-ok", False)
    be = _backend(tmp_path, script).start()
    try:
        a = be.connect("A")
        sid = a.call("session.create", cols=100, source="desktop")["session_id"]
        a.call("prompt.submit", session_id=sid, text="run an allowed command")
        a.wait_for(lambda f: (f.get("params") or {}).get("type") == "message.complete"
                   and (f.get("params") or {}).get("session_id") == sid, timeout=90, what="message.complete")
        history = be.connect("B").call("session.history", session_id=sid)["messages"]
        tools = [m for m in history if m.get("role") == "tool"]
        assert len(tools) == 1
        assert "refused" not in (tools[0].get("display_metadata") or {})
    finally:
        be.stop()
