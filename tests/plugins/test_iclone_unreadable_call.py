"""The third of the five checks Ignore keeps (README, SECURITY): a call too unreadable to check is refused. Each of the
three shapes classify.py names (a patch whose files it cannot name, a write that names no file, arguments that cannot be
read) is decided in Ignore and refused, and its readable twin runs. Strings and dicts go only to the classifier and the
decision: nothing is written, patched or fetched."""
from __future__ import annotations

import pytest

from tests.plugins.test_iclone_permissions import _body, plugin  # noqa: F401

UNREADABLE_PATCH = "*** Begin Patch\n*** Frobnicate File: a.txt\n+x\n"


def _circular_args():
    args = {"url": "https://example.invalid/"}
    args["self"] = args  # json.dumps raises ValueError on a cycle, even with default=str
    return args


def _non_string_key_args():
    return {"url": "https://example.invalid/", ("a", "b"): 1}  # json.dumps raises TypeError on a tuple key


def _unreadable_calls(project):
    return [
        ("patch", {"mode": "patch", "patch": UNREADABLE_PATCH}),
        ("patch", {"mode": "patch", "patch": "   "}),
        ("write_file", {"content": "x"}),
        ("write_file", {"path": "", "content": "x"}),
        ("browser_navigate", _circular_args()),
        ("browser_navigate", _non_string_key_args()),
    ]


def _readable_calls(project):
    return [
        ("patch", {"mode": "patch", "patch": "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch\n"}),
        ("write_file", {"path": str(project / "a.txt"), "content": "x"}),
        ("browser_navigate", {"url": "https://example.invalid/"}),
    ]


def _decided(tool, args, project, mode):
    from hermes_plugins.iclone_permissions.classify import classify
    from hermes_plugins.iclone_permissions.policy import decide

    body = _body(standing=mode)
    call = classify(tool, args, str(project), body, session_id="s")
    verdict = decide(body, cls=call.cls, facts=call.facts, floor=call.floor, ceiling_key=call.ceiling_key,
                     session_id="s", project=call.project)
    return call, verdict


@pytest.mark.parametrize("index", range(6))
def test_a_call_too_unreadable_to_check_is_refused_in_ignore(plugin, tmp_path, index):
    tool, args = _unreadable_calls(tmp_path)[index]
    call, verdict = _decided(tool, args, tmp_path, "ignore")
    assert str(call.floor or "").startswith("unreadable:"), (tool, call)
    assert (verdict.outcome, verdict.rule, verdict.floor) == ("refuse", "floor", call.floor), (tool, verdict)


@pytest.mark.parametrize("mode", ["manual", "acceptEdits", "automatic", "plan"])
@pytest.mark.parametrize("index", range(6))
def test_a_call_too_unreadable_to_check_is_refused_in_every_other_mode(plugin, tmp_path, index, mode):
    tool, args = _unreadable_calls(tmp_path)[index]
    _call, verdict = _decided(tool, args, tmp_path, mode)
    assert verdict.outcome == "refuse", (tool, mode, verdict)


@pytest.mark.parametrize("index", range(3))
def test_its_readable_twin_runs_in_ignore(plugin, tmp_path, index):
    tool, args = _readable_calls(tmp_path)[index]
    call, verdict = _decided(tool, args, tmp_path, "ignore")
    assert not str(call.floor or "").startswith("unreadable:"), (tool, call)
    assert verdict.outcome == "allow", (tool, verdict)
