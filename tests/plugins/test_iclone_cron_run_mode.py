"""p5-lens-text "not settled": a script fired by ``cronjob(action='run')`` from a chat runs its check inside that chat's tool call.
The gate set the chat's call context (__init__.py ``_CURRENT_CALL``) and the chat's session key for that call and never reset
them; ``cronjob_tools`` runs ``run_one_job`` in the calling thread and the scheduler hands the script to ``copy_context()``,
which carries both. The rule (SECURITY): for a scheduled script, Ignore is the mode set for the folder the runtime works in,
else the Settings default; a mode picked for a chat does not count. Nothing here runs a script: only its check is read."""
from __future__ import annotations

import contextvars
import threading

import pytest

from tests.plugins.test_iclone_permissions import _body, plugin  # noqa: F401
from tools import approval
from tools import approval_context

CHAT = "chat-session"
NOT_REFUSED_IN_IGNORE = "shutdown -h now\n"  # a floor Ignore runs (it asks on a tool call); only ever read, never run
TOTAL_DESTRUCTION = "rm -rf /\n"  # refused in every mode; only ever read, never run


class _Policy:
    def __init__(self, body):
        self._body = body

    def body(self):
        return self._body


@pytest.fixture
def gate(plugin, monkeypatch, tmp_path):
    """The bundled gate pinned into Hermes' approval as register() pins it, on a policy each test writes."""
    from hermes_plugins import iclone_permissions as mod
    from hermes_plugins.iclone_permissions.classify import project_root

    for name in ("_ICLONE_POLICY_LOCK", "_ICLONE_PERMISSIONS_ACTIVE", "_ICLONE_IGNORE_PROBE", "_ICLONE_UNATTENDED_FLOOR",
                 "_ICLONE_IGNORE_REFUSES"):
        monkeypatch.setattr(approval, name, getattr(approval, name, None), raising=False)
    monkeypatch.setattr(approval, "_ICLONE_POLICY_LOCK", True)
    mod._pin_hermes_approval(approval)
    runtime = tmp_path / "runtime-folder"
    runtime.mkdir()
    monkeypatch.setattr(mod, "_cwd_for", lambda _task: str(runtime))
    script = tmp_path / "job.sh"
    monkeypatch.setattr(approval, "_iclone_script_deny_rule", lambda _text: None)

    def check(body, text, *, chat=None):
        monkeypatch.setitem(mod._state, "policy", _Policy(body))
        script.write_text(text)

        def inside():
            if chat is not None:  # as the gate leaves it at __init__.py:593 for the chat's cronjob call
                mod._CURRENT_CALL.set((chat, [chat], str(runtime)))
                approval_context._approval_session_key.set(chat)
            from cron import scheduler_script

            return scheduler_script._iclone_script_check(script, str(runtime))[0]

        return contextvars.copy_context().run(inside)

    return SimpleGate(check, project_root(str(runtime)))


class SimpleGate:
    def __init__(self, check, project):
        self.check, self.project = check, project


def test_a_chat_picked_ignore_does_not_reach_a_script_its_run_action_fires(gate):
    body = _body(standing="manual", sessions={CHAT: "ignore"})
    assert gate.check(body, NOT_REFUSED_IN_IGNORE, chat=CHAT) is not None
    assert gate.check(body, NOT_REFUSED_IN_IGNORE) is not None


def test_a_chat_picked_manual_does_not_hold_back_the_folder_s_or_settings_ignore(gate):
    assert gate.check(_body(standing="ignore", sessions={CHAT: "manual"}), NOT_REFUSED_IN_IGNORE, chat=CHAT) is None
    folder = _body(standing="manual", projects={gate.project: "ignore"}, sessions={CHAT: "manual"})
    assert gate.check(folder, NOT_REFUSED_IN_IGNORE, chat=CHAT) is None


def test_the_rule_without_any_chat_folder_then_settings_default(gate):
    assert gate.check(_body(standing="ignore"), NOT_REFUSED_IN_IGNORE) is None
    assert gate.check(_body(standing="manual"), NOT_REFUSED_IN_IGNORE) is not None
    assert gate.check(_body(standing="ignore", projects={gate.project: "manual"}), NOT_REFUSED_IN_IGNORE) is not None
    assert gate.check(_body(standing="ignore"), TOTAL_DESTRUCTION) is not None  # Ignore still refuses what it refuses


def test_the_chat_context_carried_into_the_scheduler_s_own_thread_does_not_count(gate, plugin, monkeypatch):
    """The scheduler's copy_context() thread (scheduler.py, scheduler_script.py) carries the chat's context: still not counted."""
    from hermes_plugins import iclone_permissions as mod

    body = _body(standing="manual", sessions={CHAT: "ignore"})
    monkeypatch.setitem(mod._state, "policy", _Policy(body))
    seen = {}

    def chat_call():
        mod._CURRENT_CALL.set((CHAT, [CHAT], None))
        approval_context._approval_session_key.set(CHAT)
        assert approval.iclone_ignore_in_force() is True  # the chat's own tool calls do run in its Ignore

        def fired():
            seen["call"] = mod._CURRENT_CALL.get()
            seen["refusal"] = gate.check(body, NOT_REFUSED_IN_IGNORE)

        worker = threading.Thread(target=contextvars.copy_context().run, args=(fired,))
        worker.start()
        worker.join(30)

    contextvars.copy_context().run(chat_call)
    assert seen["call"] == (CHAT, [CHAT], None)  # inherited: the leak path is real
    assert seen["refusal"] is not None
