"""F40: in Ignore permissions no layer asks. One test per layer, each with its Manual twin so it can pass only when the
path ran: the twin proves the human prompt is really behind this path, and the Ignore case proves it was not called."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from tools import approval, approval_prompt, approval_gateway_wait, write_approval
from tools import approval_context as ctx

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "plugins" / "iclone-permissions"


def _plugin_policy():
    name = "iclone_permissions_policy_f40"
    spec = importlib.util.spec_from_file_location(name, PLUGIN / "policy.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


policy = _plugin_policy()
_writer_body = importlib.import_module("tests.plugins.test_iclone_permissions")._body


def _body(mode: str, *, levels=None, ceilings=None) -> dict:
    """The writer's shape, from the one body test_iclone_permissions keeps equal to buildPolicyBody: only what a row varies."""
    body = _writer_body(standing=mode, functions=levels or {}, fnGrants=[])
    body["ceilings"] = {**body["ceilings"], **(ceilings or {})}
    return body


@pytest.fixture
def ignore(monkeypatch):
    """Ignore in force through the real probe seam (lock on, probe answering), never an env var."""
    monkeypatch.setattr(approval, "_ICLONE_POLICY_LOCK", True)
    approval.set_iclone_ignore_probe(lambda session_key: True)
    yield
    approval.set_iclone_ignore_probe(None)


@pytest.fixture
def manual(monkeypatch):
    monkeypatch.setattr(approval, "_ICLONE_POLICY_LOCK", True)
    approval.set_iclone_ignore_probe(lambda session_key: False)
    yield
    approval.set_iclone_ignore_probe(None)


# --- the plugin gate and the per-function levels --------------------------------------------------------------------


@pytest.mark.parametrize("cls", ["Wp", "Wo", "X", "N", "$", "M", "S", "I", "D"])
def test_plugin_gate_allows_every_class_in_ignore_and_asks_in_manual(cls):
    asked = policy.decide(_body("manual"), cls=cls, facts={}, floor=None, ceiling_key=None, session_id="s", project=None)
    assert asked.outcome == "ask"
    done = policy.decide(_body("ignore"), cls=cls, facts={}, floor=None, ceiling_key=None, session_id="s", project=None)
    assert (done.outcome, done.rule) == ("allow", "mode")


def test_function_level_switches_and_unread_do_not_ask_or_refuse_in_ignore():
    fns = SimpleNamespace(unread=True, parts=(), __iter__=None)

    class Fns(list):
        unread = True
        parts = ()

    levels = {"shell": "askAlways", "payments": "manual"}
    ceilings = {"terminal": "off", "spendTrade": "undecided"}
    verdict = policy.decide(_body("ignore", levels=levels, ceilings=ceilings), cls="X", facts={}, floor=None,
                            ceiling_key="terminal", session_id="s", project=None, fns=Fns(["shell"]))
    assert verdict.outcome == "allow"
    twin = policy.decide(_body("manual", levels=levels, ceilings=ceilings), cls="X", facts={}, floor=None,
                         ceiling_key="terminal", session_id="s", project=None, fns=Fns(["shell"]))
    assert twin.outcome != "allow"
    assert fns.unread


def test_a_floor_stays_refused_in_ignore_on_the_line_and_on_a_part():
    line = policy.decide(_body("ignore"), cls="X", facts={}, floor="hardline: total destruction, wipes the disk", ceiling_key=None,
                         session_id="s", project=None)
    assert (line.outcome, line.rule, line.floor) == ("refuse", "floor", "hardline: total destruction, wipes the disk")

    class Fns(list):
        unread = False
        parts = (SimpleNamespace(floor="inft: transfer an iNFT", fns=("shell",), cls="X", facts={}),
                 SimpleNamespace(floor="hardline: total destruction, x", fns=("shell",), cls="X", facts={}),)

    part = policy.decide(_body("ignore"), cls="X", facts={}, floor=None, ceiling_key=None, session_id="s", project=None,
                         fns=Fns(["shell"]))
    assert (part.outcome, part.floor) == ("refuse", "hardline: total destruction, x")  # F40 L1: the one floor left


def test_unsigned_policy_is_never_ignore():
    verdict = policy.decide(None, cls="X", facts={}, floor=None, ceiling_key=None, session_id="s", project=None)
    assert verdict.outcome == "ask" and verdict.mode == "manual"


# --- the probe seam -------------------------------------------------------------------------------------------------


def test_probe_is_off_without_the_lock_and_when_it_fails(monkeypatch):
    monkeypatch.setattr(approval, "_ICLONE_POLICY_LOCK", False)
    approval.set_iclone_ignore_probe(lambda session_key: True)
    assert approval.iclone_ignore_in_force() is False  # no lock, no probe taken

    monkeypatch.setattr(approval, "_ICLONE_POLICY_LOCK", True)

    def boom(session_key):
        raise RuntimeError("policy unreadable")

    approval.set_iclone_ignore_probe(boom)
    assert approval.iclone_ignore_in_force() is False
    approval.set_iclone_ignore_probe(lambda session_key: "yes")  # only a real True counts
    assert approval.iclone_ignore_in_force() is False
    approval.set_iclone_ignore_probe(None)


# --- dangerous-command approvals: the prompt, and the ACP callback behind it ----------------------------------------


def test_dangerous_prompt_never_reaches_the_callback_in_ignore(ignore):
    calls = []
    choice = approval_prompt.prompt_dangerous_approval(
        "rm -rf build", "recursive delete", approval_callback=lambda *a, **k: calls.append(a) or "deny")
    assert choice == "once" and calls == []


def test_dangerous_prompt_reaches_the_callback_in_manual(manual):
    calls = []
    choice = approval_prompt.prompt_dangerous_approval(
        "rm -rf build", "recursive delete", approval_callback=lambda *a, **k: calls.append(a) or "deny")
    assert choice == "deny" and len(calls) == 1


# --- the gateway wait: the app's approval.request sheet -------------------------------------------------------------


def test_gateway_decision_notifies_nobody_in_ignore(ignore):
    notified = []
    decision = approval_gateway_wait._await_gateway_decision(
        "f40-session", notified.append, {"command": "npm i", "description": "d", "pattern_key": "k", "pattern_keys": ["k"]})
    assert decision["resolved"] is True and decision["choice"] == "once" and notified == []


def test_gateway_decision_notifies_in_manual(manual, monkeypatch):
    notified = []

    def notify(data):
        notified.append(data)
        raise RuntimeError("stop the wait here")

    decision = approval_gateway_wait._await_gateway_decision(
        "f40-session-2", notify, {"command": "npm i", "description": "d", "pattern_key": "k", "pattern_keys": ["k"]})
    assert len(notified) == 1 and decision.get("notify_failed")


# --- MCP: the trust gate and elicitation ----------------------------------------------------------------------------


def test_mcp_consent_accepts_without_a_prompt_in_ignore(ignore, monkeypatch):
    monkeypatch.setattr(ctx, "_is_gateway_approval_context", lambda: True)
    monkeypatch.setattr(approval, "_gateway_notify_cb", lambda key: pytest.fail("a prompt was sent"), raising=False)
    assert approval_prompt.request_elicitation_consent("write?", "d", surface="mcp-trust/x") == "accept"


def test_mcp_consent_is_not_accepted_in_manual_with_nobody_to_answer(manual, monkeypatch):
    monkeypatch.setattr(ctx, "_is_gateway_approval_context", lambda: True)
    monkeypatch.setattr(approval, "_gateway_notify_cb", lambda key: None, raising=False)
    assert approval_prompt.request_elicitation_consent("write?", "d", surface="mcp-trust/x") == "decline"


def test_mcp_trust_gate_runs_the_untrusted_tool_in_ignore(ignore, monkeypatch):
    from tools import mcp_tool_handlers as handlers

    monkeypatch.setitem(handlers._core._server_trust_levels, "srv", handlers._core._TRUST_UNTRUSTED)
    monkeypatch.setattr("tools.mcp_tool_scope._server_key", lambda name: name)
    monkeypatch.setattr(handlers, "_tool_is_read_only", lambda s, t: False)
    assert handlers._trust_gate_check("srv", "write_thing") is None


def test_mcp_trust_gate_blocks_the_untrusted_tool_in_manual(manual, monkeypatch):
    from tools import mcp_tool_handlers as handlers

    monkeypatch.setitem(handlers._core._server_trust_levels, "srv", handlers._core._TRUST_UNTRUSTED)
    monkeypatch.setattr("tools.mcp_tool_scope._server_key", lambda name: name)
    monkeypatch.setattr(handlers, "_tool_is_read_only", lambda s, t: False)
    monkeypatch.setattr(approval_prompt, "request_elicitation_consent", lambda *a, **k: "decline", raising=True)
    assert "NOT run" in (handlers._trust_gate_check("srv", "write_thing") or "")


# --- ACP: the edit approval ---------------------------------------------------------------------------------------


def _edit_requester(asked):
    import asyncio

    from acp_adapter.edit_approval import make_acp_edit_approval_requester

    async def request_permission(**kwargs):
        asked.append(kwargs)
        return SimpleNamespace(outcome=SimpleNamespace(outcome="selected", option_id="deny"))

    loop = asyncio.new_event_loop()
    import threading

    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    return make_acp_edit_approval_requester(request_permission, loop, "s", timeout=5), loop


PROPOSAL = SimpleNamespace(path="a.txt", old_text="a", new_text="b", tool_name="patch", arguments={}, display_title="e")


def test_acp_edit_is_not_asked_in_ignore(ignore):
    asked = []
    requester, loop = _edit_requester(asked)
    try:
        assert requester(PROPOSAL) is True and asked == []
    finally:
        loop.call_soon_threadsafe(loop.stop)


def test_acp_edit_is_asked_in_manual(manual):
    asked = []
    requester, loop = _edit_requester(asked)
    try:
        assert requester(PROPOSAL) is False and len(asked) == 1
    finally:
        loop.call_soon_threadsafe(loop.stop)


# --- memory and skill writes that wait for a review -----------------------------------------------------------------


def test_write_approval_writes_at_once_in_ignore(ignore, monkeypatch):
    monkeypatch.setattr(write_approval, "write_approval_enabled", lambda subsystem: True)
    assert write_approval.evaluate_gate(write_approval.SKILLS).allow is True


def test_write_approval_stages_in_manual(manual, monkeypatch):
    monkeypatch.setattr(write_approval, "write_approval_enabled", lambda subsystem: True)
    assert write_approval.evaluate_gate(write_approval.SKILLS).allow is False


# --- the floors of the runtime run before any of the above ----------------------------------------------------------


def test_hardline_floor_stays_refused_in_ignore(ignore):
    assert approval._floor_block("rm -rf /") is not None


def test_l2_hermes_own_ask_reads_the_session_and_project_of_the_call_in_hand(monkeypatch, plugin):
    """L2: the session row and the project row reach Hermes' own ask, though it knows only a gateway key."""
    from hermes_plugins import iclone_permissions as mod

    class Pol:
        def __init__(self, body):
            self._body = body

        def body(self):
            return self._body

    for over, current, want in (
            ({"sessions": {"s1": "ignore"}}, ("s1", ["s1"], "/p"), True),
            ({"sessions": {"s1": "ignore"}}, ("s2", ["s2"], "/p"), False),
            ({"projects": {"/p": "ignore"}}, ("s2", ["s2"], "/p"), True),
            (dict(standing="ignore", sessions={"s1": "manual"}), ("s1", ["s1"], "/p"), False),
    ):
        body = _writer_body(**over)
        monkeypatch.setitem(mod._state, "policy", Pol(body))
        token = mod._CURRENT_CALL.set(current)
        try:
            assert mod._ignore_in_force("gateway:chat:1") is want, (over, current)
        finally:
            mod._CURRENT_CALL.reset(token)


from tests.plugins.test_iclone_permissions import plugin  # noqa: E402,F401
