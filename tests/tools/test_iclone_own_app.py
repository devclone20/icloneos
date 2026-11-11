"""S9, the matrix row: computer use against icloneOS's own window. The real tool entry, the real input layer of the cua
backend with only its driver call recorded, and the signed policy read by the plugin's real Ignore probe, in every mode.
The real driver is not used here: its events would land on this machine's real desktop."""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List
from unittest.mock import patch

import pytest

from tests.plugins.test_iclone_permissions import _body, wired  # noqa: F401 (wired is a fixture)
from tools import approval
from tools.computer_use import tool as cu_tool
from tools.computer_use.backend import ActionResult
from tools.computer_use.cua_backend import CuaDriverBackend

ASKING_MODES = ["manual", "automatic", "acceptEdits", "plan"]

INPUTS: List[Dict[str, Any]] = [
    {"action": "click", "coordinate": [40, 40]},
    {"action": "click", "element": 3},
    {"action": "double_click", "coordinate": [40, 40]},
    {"action": "right_click", "coordinate": [40, 40]},
    {"action": "drag", "from_coordinate": [1, 1], "to_coordinate": [9, 9]},
    {"action": "scroll", "direction": "down"},
    {"action": "type", "text": "hello"},
    {"action": "key", "keys": "return"},
    {"action": "key", "keys": "space"},
    {"action": "set_value", "value": "ignore", "element": 3},
]

OTHER_PID = 987_654
OTHER_WINDOW = 11
APP_WINDOW = 22


def _driver(pid: int, name: str, windows: Any = ()) -> CuaDriverBackend:
    """The real backend's input layer over a recorder: what reaches ``driver`` would have reached the machine."""
    backend = object.__new__(CuaDriverBackend)
    backend._active_pid, backend._active_window_id, backend._last_app = pid, OTHER_WINDOW, name
    backend._last_target = None
    backend._snapshot_tokens = {}
    backend.sent = []
    backend._action = lambda tool, args, **_: backend.sent.append((tool, dict(args))) or ActionResult(ok=True, action=tool)

    def listed():
        if isinstance(windows, Exception):
            raise windows
        return list(windows)

    backend.list_windows = listed
    backend.bring_to_front = lambda **_: ActionResult(ok=False, action="bring_to_front")  # _raisable: one that does
    backend.start = backend.stop = lambda *_a, **_k: None
    backend.is_available = lambda: True
    backend._session = type("S", (), {"supports_input_property": staticmethod(lambda *_: True),
                                      "_has_tool": staticmethod(lambda *_: True)})()
    return backend


@pytest.fixture
def in_mode(wired, monkeypatch, grant_computer_use_approvals):  # noqa: F811
    from hermes_cli import iclone_policy_env

    monkeypatch.setattr(approval, "_ICLONE_POLICY_LOCK", True)

    def make(mode: str):
        mod, _main, _ = wired(_body(standing=mode))
        approval.set_iclone_ignore_probe(mod._ignore_in_force)

    yield make
    approval.set_iclone_ignore_probe(None)
    iclone_policy_env._reset_for_tests(None)


def _send(backend: CuaDriverBackend, args: Dict[str, Any]) -> Any:
    cu_tool.reset_backend_for_tests()
    with patch.object(cu_tool, "_new_backend", lambda mode: backend), \
            patch("tools.bot_desktop.runtime.ensure_started_for_tool", lambda: None):
        try:
            return cu_tool.handle_computer_use(dict(args), session_id="s1")
        finally:
            cu_tool.reset_backend_for_tests()


@pytest.mark.parametrize("mode", ASKING_MODES)
@pytest.mark.parametrize("args", INPUTS, ids=lambda a: f"{a['action']}-{next(iter(a.values()))}-{len(a)}")
def test_input_on_the_app_is_refused_in_every_mode_but_ignore(in_mode, mode, args):
    in_mode(mode)
    backend = _driver(os.getppid(), "Electron")
    out = json.loads(_send(backend, args))
    assert out["code"] == "own_app_control" and "owner" in out["error"], out
    assert backend.sent == []


@pytest.mark.parametrize("args", INPUTS, ids=lambda a: f"{a['action']}-{next(iter(a.values()))}-{len(a)}")
def test_in_ignore_it_runs_by_the_owners_rule(in_mode, args):
    in_mode("ignore")
    backend = _driver(os.getppid(), "Electron")
    out = _send(backend, args)
    assert "own_app_control" not in str(out)
    assert backend.sent, out


@pytest.mark.parametrize("mode", ASKING_MODES)
def test_the_same_input_on_another_app_runs(in_mode, mode):
    """The twin: the rule is about this app, so the refusals above are not the tool refusing everything."""
    in_mode(mode)
    backend = _driver(OTHER_PID, "Finder")
    assert "own_app_control" not in str(_send(backend, {"action": "click", "coordinate": [40, 40]}))
    assert [tool for tool, _ in backend.sent] == ["click"]
    assert backend.sent[0][1]["pid"] == OTHER_PID


@pytest.mark.parametrize("name", ["iclone os", "iClone OS", "icloneOS", " iclone os "])
def test_the_app_by_its_name_when_the_pid_is_not_an_ancestor(in_mode, name):
    in_mode("manual")
    backend = _driver(OTHER_PID, name)
    assert json.loads(_send(backend, {"action": "click", "coordinate": [1, 1]}))["code"] == "own_app_control"
    assert backend.sent == []


def test_a_real_ancestor_above_the_parent_is_the_app_too():
    from tools.iclone_own_app import app_pids

    import psutil

    pids = app_pids()
    assert os.getppid() in pids and os.getpid() not in pids and 0 not in pids and 1 not in pids
    assert {parent.pid for parent in psutil.Process().parents() if parent.pid > 1} <= pids


def _raisable(backend: CuaDriverBackend, raises: bool, above: Any, after: Any) -> List[Any]:
    """The window list follows a raise of the target, as it does on the machine: after Allow the app's sheet window is in
    front, and only the raise puts the target back above it."""
    raised: List[Any] = []
    backend.list_windows = lambda: list(after if raised else above)

    def bring_to_front(pid: Any, window_id: Any) -> ActionResult:
        if raises:
            raised.append((pid, window_id))
        return ActionResult(ok=raises, action="bring_to_front")

    backend.bring_to_front = bring_to_front
    return raised


_ABOVE = [{"pid": os.getppid(), "window_id": APP_WINDOW, "app_name": "Electron", "z_index": 9},
          {"pid": OTHER_PID, "window_id": OTHER_WINDOW, "app_name": "Calculator", "z_index": 1}]


@pytest.mark.parametrize("mode", ASKING_MODES)
def test_after_allow_the_target_is_raised_and_the_foreground_drag_runs(in_mode, mode):
    in_mode(mode)
    backend = _driver(OTHER_PID, "Calculator")
    raised = _raisable(backend, True, _ABOVE, list(reversed(_ABOVE)))
    args = {"action": "drag", "from_coordinate": [1, 1], "to_coordinate": [9, 9], "delivery_mode": "foreground"}
    assert "own_app_control" not in str(_send(backend, args))
    assert raised == [(OTHER_PID, OTHER_WINDOW)] and backend.sent


def test_a_raise_that_leaves_the_app_on_top_is_still_refused(in_mode):
    in_mode("manual")
    backend = _driver(OTHER_PID, "Calculator")
    _raisable(backend, True, _ABOVE, _ABOVE)
    out = json.loads(_send(backend, {"action": "click", "coordinate": [1, 1], "delivery_mode": "foreground"}))
    assert out["code"] == "own_app_control" and backend.sent == []


def test_a_raise_that_fails_is_refused(in_mode):
    in_mode("manual")
    backend = _driver(OTHER_PID, "Calculator")
    _raisable(backend, False, _ABOVE, list(reversed(_ABOVE)))
    out = json.loads(_send(backend, {"action": "click", "coordinate": [1, 1], "delivery_mode": "foreground"}))
    assert out["code"] == "own_app_control" and backend.sent == []


@pytest.mark.parametrize("mode", ASKING_MODES)
def test_a_foreground_click_on_another_app_with_the_app_above_it_is_refused(in_mode, mode):
    in_mode(mode)
    above = [{"pid": os.getppid(), "window_id": APP_WINDOW, "app_name": "Electron", "z_index": 9},
             {"pid": OTHER_PID, "window_id": OTHER_WINDOW, "app_name": "Finder", "z_index": 1}]
    backend = _driver(OTHER_PID, "Finder", above)
    out = json.loads(_send(backend, {"action": "click", "coordinate": [1, 1], "delivery_mode": "foreground"}))
    assert out["code"] == "own_app_control" and backend.sent == []


def test_a_foreground_click_with_the_app_under_the_target_runs(in_mode):
    in_mode("manual")
    below = [{"pid": OTHER_PID, "window_id": OTHER_WINDOW, "app_name": "Finder", "z_index": 9},
             {"pid": os.getppid(), "window_id": APP_WINDOW, "app_name": "Electron", "z_index": 1}]
    backend = _driver(OTHER_PID, "Finder", below)
    assert "own_app_control" not in str(_send(backend, {"action": "click", "coordinate": [1, 1], "delivery_mode": "foreground"}))
    assert backend.sent and backend.sent[0][1]["delivery_mode"] == "foreground"


def test_a_foreground_click_with_no_window_list_is_refused(in_mode):
    in_mode("manual")
    backend = _driver(OTHER_PID, "Finder", OSError("driver gone"))
    out = json.loads(_send(backend, {"action": "click", "coordinate": [1, 1], "delivery_mode": "foreground"}))
    assert out["code"] == "own_app_control" and backend.sent == []


def test_background_input_never_needs_the_list(in_mode):
    in_mode("manual")
    backend = _driver(OTHER_PID, "Finder", OSError("driver gone"))
    assert "own_app_control" not in str(_send(backend, {"action": "click", "coordinate": [1, 1]}))
    assert backend.sent


def test_a_look_at_the_app_is_not_input(in_mode):
    in_mode("manual")
    backend = _driver(os.getppid(), "Electron")
    backend.list_apps = lambda: []
    assert "own_app_control" not in str(_send(backend, {"action": "list_apps"}))


def test_outside_the_app_the_rule_does_not_exist(monkeypatch, grant_computer_use_approvals):
    monkeypatch.setattr(approval, "_ICLONE_POLICY_LOCK", False)
    backend = _driver(os.getppid(), "iclone os")
    assert "own_app_control" not in str(_send(backend, {"action": "click", "coordinate": [1, 1]}))
    assert backend.sent


def test_a_probe_that_fails_is_not_ignore(monkeypatch, grant_computer_use_approvals):
    monkeypatch.setattr(approval, "_ICLONE_POLICY_LOCK", True)

    def boom(_key):
        raise RuntimeError("no policy")

    approval.set_iclone_ignore_probe(boom)
    try:
        backend = _driver(os.getppid(), "Electron")
        assert json.loads(_send(backend, {"action": "click", "coordinate": [1, 1]}))["code"] == "own_app_control"
        assert backend.sent == []
    finally:
        approval.set_iclone_ignore_probe(None)
