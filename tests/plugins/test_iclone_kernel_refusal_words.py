"""G20: what the agent relays when the kernel refuses a command names a way out that exists in this mode."""

from __future__ import annotations

import importlib
import importlib.util
import os
import sys

import pytest

ROOT = os.path.join(os.path.dirname(__file__), "..", "..", "plugins", "iclone-confinement")


def _plugin_module(name):
    pkg = "iclone_confinement_kernel_words"
    if pkg not in sys.modules:
        spec = importlib.util.spec_from_file_location(pkg, os.path.join(ROOT, "__init__.py"), submodule_search_locations=[ROOT])
        mod = importlib.util.module_from_spec(spec)
        sys.modules[pkg] = mod
        spec.loader.exec_module(mod)
    return importlib.import_module(f"{pkg}.{name}")


seatbelt = _plugin_module("seatbelt")
FAILED = {"returncode": 1, "output": "touch: /x: Operation not permitted"}
REQUEST = {"project": "/p", "session_id": "s1"}


def _launcher_line(why):
    """The launcher's own line, so a change of its words fails here rather than silently dropping the button."""
    name = "iclone_launcher_kernel_words"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, "launcher.py"))
        sys.modules[name] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sys.modules[name])
    return sys.modules[name].narrowed_lines({"WRITE_PROJECT": why}, "/p")[0]


UNLISTED = {"returncode": 1, "output": "touch: /x: Operation not permitted\n" + _launcher_line("unlisted-folder")}


def _said(monkeypatch, mode, result=FAILED):
    seen = {}

    def label(session_id=None, project=None):
        seen.update(session_id=session_id, project=project)
        return mode

    monkeypatch.setattr(seatbelt.core, "mode_label", label)
    return seatbelt.SeatbeltEnvironment._kernel_refusal(None, REQUEST, result), seen


def test_in_ignore_it_offers_no_approval_that_never_comes(monkeypatch):
    text, seen = _said(monkeypatch, "Ignore")
    assert text == ("icloneOS: mode Ignore. Cause: the Seatbelt refused this command, which is confined to /p; Ignore permissions "
                    "does not lift the Seatbelt, and nothing asks in this mode. What to do: tell the user what you need and why. "
                    "They can open that folder in icloneOS or turn Isolation off in Settings > Agent > Permissions. To write one file under your home folder, outside the project, the write_file tool does it directly in this mode, except this app's own files.")
    assert seen == {"session_id": "s1", "project": "/p"}


def test_in_ignore_the_button_is_named_only_for_an_unlisted_folder(monkeypatch):
    text, _seen = _said(monkeypatch, "Ignore", UNLISTED)
    assert text == ("icloneOS: mode Ignore. Cause: the Seatbelt refused this command, which is confined to /p; Ignore permissions "
                    "does not lift the Seatbelt, and nothing asks in this mode. What to do: tell the user what you need and why. "
                    "They can open that folder in icloneOS, use Allow this folder in the Containers pane, or turn Isolation off in "
                    "Settings > Agent > Permissions. To write one file under your home folder, outside the project, the write_file tool does it directly in this mode, except this app's own files.")


@pytest.mark.parametrize("mode", ["Manual", "Automatic", "Plan", "Acceptedits"])
def test_in_the_other_modes_it_names_the_right_places(monkeypatch, mode):
    text, _seen = _said(monkeypatch, mode)
    assert text == (f"icloneOS: mode {mode}. Cause: the Seatbelt refused this command, which is confined to /p; a command allowed "
                    "without asking stays confined. What to do: tell the user what you need and why. They can open that folder in "
                    "icloneOS, and a shell command they approve on a sheet runs once outside the Seatbelt. If a stored grant for commands answered this one, no sheet comes while it stands: they can revoke it in Settings > Agent > Permissions to be asked again. Turning Isolation off there also lifts the Seatbelt.")


@pytest.mark.parametrize("mode", ["Manual", "Automatic", "Plan", "Acceptedits"])
def test_in_the_other_modes_the_button_is_named_only_for_an_unlisted_folder(monkeypatch, mode):
    text, _seen = _said(monkeypatch, mode, UNLISTED)
    assert text == (f"icloneOS: mode {mode}. Cause: the Seatbelt refused this command, which is confined to /p; a command allowed "
                    "without asking stays confined. What to do: tell the user what you need and why. They can open that folder in "
                    "icloneOS or use Allow this folder in the Containers pane, and a shell command they approve on a sheet runs once outside the Seatbelt. If a stored grant for commands answered this one, no sheet comes while it stands: they can revoke it in Settings > Agent > Permissions to be asked again. Turning Isolation off there also lifts the Seatbelt.")


@pytest.mark.parametrize("why", ["needs-allow", "needs-file-writing", "needs-network", "needs-web-browsing"])
def test_a_run_narrowed_for_any_other_reason_names_no_button(monkeypatch, why):
    text, _seen = _said(monkeypatch, "Manual", {"returncode": 1, "output": "Operation not permitted\n" + _launcher_line(why)})
    assert "Allow this folder" not in text


def test_only_a_failed_run_the_kernel_refused_is_told(monkeypatch):
    assert seatbelt.SeatbeltEnvironment._kernel_refusal(None, REQUEST, {"returncode": 0, "output": "Operation not permitted"}) is None
    assert seatbelt.SeatbeltEnvironment._kernel_refusal(None, REQUEST, {"returncode": 1, "output": "no"}) is None


def test_the_run_writes_down_its_session_for_the_sentence():
    source = open(seatbelt.__file__, encoding="utf-8").read()
    assert 'request["session_id"] = session_id' in source


def test_the_ledger_speaks_to_the_user_and_the_sheet_gets_only_the_agents_words():
    launcher = open(os.path.join(ROOT, "launcher.py"), encoding="utf-8").read()
    assert "approved by the owner" not in launcher and launcher.count("approved by you") == 2
    gate = open(os.path.join(ROOT, "..", "iclone-permissions", "__init__.py"), encoding="utf-8").read()
    assert "wants to run" not in gate and 'str(kwargs.get("reason") or "")' in gate
