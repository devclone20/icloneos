"""F50, b.automatic: an approved write's folder belongs to that one tool call. Proof run p1 at a7a5c9fa45: Allow once on
write_file in a folder, then in Automatic a later `touch <folder>/x` was confined to that folder and wrote there, because
the hand-off was a process-wide table matched on the command's text for 120 s."""
import importlib
import importlib.util
import os
import sys
import threading

import pytest

from tests.plugins.test_iclone_launcher import L
from tests.plugins.test_iclone_permissions import _body, plugin  # noqa: F401

CORE = os.path.join(L.HERE, "core.py")


@pytest.fixture
def core():
    spec = importlib.util.spec_from_file_location("iclone_core_f50", CORE)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    yield module
    del sys.modules[spec.name]


def test_the_call_that_was_approved_reads_its_folder(core):
    core.note_approved_folder("/x/outside")
    assert core.approved_folder_of("mkdir -p '/x/outside/granted'") == "/x/outside"
    assert core.approved_folder_of("echo elsewhere") is None


def test_a_later_tool_call_naming_that_folder_gets_nothing(core):
    core.note_approved_folder("/x/outside")
    core.forget_approved_folder()  # the gate does this at the start of every tool call and after each one
    assert core.approved_folder_of("touch /x/outside/auto-b") is None


def test_another_session_running_beside_it_gets_nothing(core):
    core.note_approved_folder("/x/outside")
    seen = []
    worker = threading.Thread(target=lambda: seen.append(core.approved_folder_of("touch /x/outside/y")))
    worker.start()
    worker.join()
    assert seen == [None]


def test_the_tool_worker_of_that_call_still_reads_it(core):
    """model_tools and tool_executor hand a tool to a worker with propagate_context_to_thread: the worker must see it."""
    import contextvars

    core.note_approved_folder("/x/outside")
    seen = []
    context = contextvars.copy_context()
    worker = threading.Thread(target=lambda: context.run(lambda: seen.append(core.approved_folder_of("mv a /x/outside/b"))))
    worker.start()
    worker.join()
    assert seen == ["/x/outside"]


def test_the_worker_started_before_the_gate_still_reads_it(core):
    """f57, b.grant live: the executor copies the worker's context, then the gate runs on the coordinator
    (agent/tool_executor.py authorization_gate.run), so a value set in the gate's context never reaches that worker.
    The tool call id does: it is bound in both."""
    import contextvars

    from tools.approval_context import _approval_tool_call_id

    seen = []
    token = _approval_tool_call_id.set("call-1")
    context = contextvars.copy_context()  # the worker's copy, taken before the gate
    _approval_tool_call_id.reset(token)
    contextvars.copy_context().run(core.note_approved_folder, "/x/outside", "call-1")  # the gate, on the coordinator
    for read in (lambda: core.approved_folder_of("mkdir -p '/x/outside/g'"),):
        worker = threading.Thread(target=lambda: context.run(lambda: seen.append(read())))
        worker.start()
        worker.join()
    assert seen == ["/x/outside"]
    other = contextvars.copy_context()
    other.run(_approval_tool_call_id.set, "call-2")
    assert other.run(core.approved_folder_of, "touch /x/outside/y") is None
    core.forget_approved_folder("call-1")
    assert context.run(core.approved_folder_of, "mkdir -p '/x/outside/g'") is None


def test_the_gate_hands_the_tool_call_id_with_the_folder(tmp_path):
    from tests.plugins.test_iclone_one_shot import _plugin

    gate, noted = _plugin(), []
    stand_in = type("Core", (), {"note_approved_folder": staticmethod(lambda *a: noted.append(a))})
    gate._note_answer(stand_in, "write_file", {"path": str(tmp_path / "f.txt")}, {"allowed": True}, "/elsewhere", "call-9")
    assert noted == [(str(tmp_path), "call-9")]


def test_the_gate_drops_the_folder_before_and_after_every_call(monkeypatch):
    from tests.plugins.test_iclone_one_shot import _plugin

    gate = _plugin()
    dropped = []
    stand_in = type("Core", (), {"forget_approved_folder": staticmethod(lambda: dropped.append(1))})
    monkeypatch.setattr(gate, "_confinement_core", lambda: stand_in)
    monkeypatch.setattr(gate, "_decide", lambda *a, **k: None)
    monkeypatch.setattr(gate, "_backend_refusal", lambda _n: None)
    gate.on_pre_tool_call(tool_name="terminal", args={"command": "x"}, task_id="t", session_id="s")
    gate.on_post_tool_call(tool_name="terminal")
    assert dropped == [1, 1]


def test_in_ignore_the_terminal_never_prompts_for_the_admin_password(monkeypatch):
    """d.no_sheet at p1: `sudo -V` in Ignore put the sudo prompt on the ws channel. L2: in Ignore no layer asks."""
    import tools.approval as approval
    import tools.terminal_tool as terminal
    import tools.terminal_tool_sudo as sudo

    prompted = []
    monkeypatch.setattr(terminal, "_get_sudo_password_callback", lambda: lambda: prompted.append(1) or "pw")
    monkeypatch.setattr(approval, "iclone_ignore_in_force", lambda: True)
    assert sudo._prompt_for_sudo_password(command="sudo -V") == "" and prompted == []
    monkeypatch.setattr(approval, "iclone_ignore_in_force", lambda: False)
    assert sudo._prompt_for_sudo_password(command="sudo -V") == "pw" and prompted == [1]


def test_s5_workdir_never_selects_a_mode(plugin):
    from hermes_plugins.iclone_permissions.policy import decide

    A, B = "/w/a", "/w/b"
    body = _body(standing="manual", projects={A: "ignore"})
    ask = dict(cls="X", facts={}, floor=None, ceiling_key=None, session_id="s")
    assert decide(body, project=A, mode_project=B, **ask).outcome == "ask"  # a Manual window on B names workdir=A
    assert decide(body, project=A, mode_project=A, **ask).outcome == "allow"  # a window on A is that project's
    assert decide(_body(standing="manual", projects={A: "ignore"}, sessions={"s": "manual"}), project=A, mode_project=A, **ask).outcome == "ask"


def test_s5_the_gate_reads_the_mode_by_the_window_not_the_workdir(tmp_path, monkeypatch):
    from tests.plugins.test_iclone_one_shot import _plugin

    gate = _plugin()
    window, other = tmp_path / "b", tmp_path / "a"
    window.mkdir(), other.mkdir()
    seen = {}

    def spy(*_a, **k):
        seen.update(k)
        raise RuntimeError("stop here")

    policy = importlib.import_module(f"{gate.__name__}.policy")
    monkeypatch.setattr(policy, "decide", spy)
    monkeypatch.setattr(gate, "decide", spy, raising=False)
    monkeypatch.setattr(gate, "_confined_cwd", lambda _t: str(window))
    monkeypatch.setattr(gate, "_confined_project", lambda folder, _t, _c: folder)
    gate._state.setdefault("policy", type("P", (), {"body": staticmethod(lambda: {})})())
    gate._state.setdefault("channel", object())
    gate.on_pre_tool_call(tool_name="terminal", args={"command": "ls", "workdir": str(other)}, task_id="t", session_id="s")
    assert seen.get("mode_project") == str(window) and seen.get("project") == str(other)
