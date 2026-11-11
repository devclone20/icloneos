"""G28, the owner's rule on the last findings: Manual and the modes that ask ask once and then do it, Ignore does not ask, and
only total destruction refuses in every mode. Strings and disposable folders only: nothing here runs a floor command."""
from __future__ import annotations

import os
from types import SimpleNamespace

import pytest

from tests.plugins.test_iclone_one_file_and_background import w  # noqa: F401
from tests.plugins.test_iclone_permissions import _body, plugin, wired  # noqa: F401


def _fs_home(monkeypatch, tmp_path, *, off=True):
    from agent import file_safety as fs

    hermes = tmp_path / ".hermes"
    monkeypatch.setattr(fs, "_hermes_dirs", lambda: [hermes])
    monkeypatch.setattr(fs, "_guard_homes", lambda _p="": {str(tmp_path)})
    monkeypatch.setattr(fs, "_seatbelt_off", lambda: off)
    return fs, hermes


# A-M1: the read block reads a name as the disk does.
@pytest.mark.parametrize("true_name,alias", [
    ("vault/vault.key", "VAULT/vault.key"),
    ("vault/vault.key", "vault/VAULT.KEY"),
    ("mcp-tokens/x.json", "MCP-tokens/x.json"),
    ("browser-profile/Cookies", "BROWSER-PROFILE/Cookies"),
    ("auth.json", "AUTH.JSON"),
    ("auth.json", "auth.jſon"),
    ("skills/.hub/x.md", "SKILLS/.HUB/x.md"),
])
def test_g28_the_read_block_holds_a_disk_alias_like_the_true_name(monkeypatch, tmp_path, true_name, alias):
    fs, hermes = _fs_home(monkeypatch, tmp_path)
    assert fs.get_read_block_error(str(hermes / true_name))
    assert fs.get_read_block_error(str(hermes / alias))


def test_g28_the_read_block_holds_the_vault_folder_under_another_spelling_of_the_home(monkeypatch, tmp_path):
    fs, hermes = _fs_home(monkeypatch, tmp_path)
    assert "vault" in fs.get_read_block_error(str(hermes.parent / ".HERMEſ" / "VAULT"))


@pytest.mark.parametrize("name", [".ENV", ".enV.local", ".ENV.PRODUCTION"])
def test_g28_a_project_env_file_is_held_under_any_case(monkeypatch, tmp_path, name):
    fs, _hermes = _fs_home(monkeypatch, tmp_path)
    assert fs.get_read_block_error(str(tmp_path / "proj" / name))


@pytest.mark.parametrize("name", ["vault-old/k", "authxjson", "sessions/s.json", "pairing/p.json"])
def test_g28_a_near_name_and_a_free_store_stay_readable(monkeypatch, tmp_path, name):
    fs, hermes = _fs_home(monkeypatch, tmp_path)
    assert fs.get_read_block_error(str(hermes / name)) is None


# A-M3: an asking floor on the reads of the credential list while the Seatbelt is off.
def _classified(monkeypatch, tmp_path, tool, rel, *, off=True, secrets=()):
    from tests.plugins.test_iclone_permissions import _load
    _load()
    from hermes_plugins.iclone_permissions import classify as C
    _fs_home(monkeypatch, tmp_path, off=off)
    policy = {"secretPaths": list(secrets)}
    return C.classify(tool, {"path": str(tmp_path / rel)}, str(tmp_path / "proj"), policy)


READS = [("read_file", ".aws/credentials"), ("read_file", ".ssh/id_rsa"), ("read_file", ".SSH/ID_RSA"), ("read_file", ".zshrc"),
         ("read_file", ".ſsh/config"), ("search_files", ".ssh"), ("search_files", ".aws"), ("search_files", ".AWS/"), ("search_files", ".config/gh")]


@pytest.mark.parametrize("tool,rel", READS)
def test_g28_a_read_of_the_list_asks_once_where_the_mode_asks_with_the_seatbelt_off(monkeypatch, tmp_path, tool, rel):
    from hermes_plugins.iclone_permissions.policy import CREDENTIAL_READ_FLOOR, decide
    call = _classified(monkeypatch, tmp_path, tool, rel)
    assert call.floor == CREDENTIAL_READ_FLOOR

    def outcome(mode, **over):
        return decide(_body(standing=mode, **over), cls=call.cls, facts=call.facts, floor=call.floor, ceiling_key=None,
                      session_id="s", project=None).outcome

    for mode in ("manual", "automatic", "acceptEdits"):
        assert outcome(mode) == "ask" == outcome(mode, grants=[{"id": "g", "cls": "R", "scope": "standing"}])
    assert outcome("plan") == "refuse"
    assert outcome("ignore") == "allow"


def test_g28_plan_refusing_that_read_says_to_change_the_mode(monkeypatch, tmp_path):
    from hermes_plugins.iclone_permissions.policy import CREDENTIAL_READ_FLOOR, decide
    import hermes_plugins.iclone_permissions as P
    _classified(monkeypatch, tmp_path, "read_file", ".aws/credentials")
    verdict = decide(_body(standing="plan"), cls="R", facts={}, floor=CREDENTIAL_READ_FLOOR, ceiling_key=None, session_id="s", project=None)
    words = P._todo_for(verdict, CREDENTIAL_READ_FLOOR)
    assert "permission mode" in words and "every mode" not in words


@pytest.mark.parametrize("tool,rel", READS)
def test_g28_with_the_seatbelt_on_that_read_has_no_such_floor(monkeypatch, tmp_path, tool, rel):
    assert _classified(monkeypatch, tmp_path, tool, rel, off=False).floor is None


def test_g28_a_read_off_the_list_still_does_not_ask_with_the_seatbelt_off(monkeypatch, tmp_path):
    assert _classified(monkeypatch, tmp_path, "read_file", "Documents/x.txt").floor is None
    assert _classified(monkeypatch, tmp_path, "search_files", "Documents").floor is None


def _search_result(*paths):
    return SimpleNamespace(matches=[SimpleNamespace(path=p) for p in paths], files=None, counts=None)


@pytest.mark.parametrize("off,ignore,kept", [(True, False, 1), (True, True, 2), (False, False, 2)])
def test_g28_a_search_above_the_list_loses_those_lines_only_where_nothing_asked(monkeypatch, tmp_path, off, ignore, kept):
    import tools.approval as approval
    from tools import file_tools as ft
    _fs_home(monkeypatch, tmp_path, off=off)
    monkeypatch.setattr(approval, "iclone_ignore_in_force", lambda: ignore)
    monkeypatch.setattr(ft, "_resolved_match_path", lambda path, _task: path)
    result = _search_result(str(tmp_path / ".ssh" / "id_rsa"), str(tmp_path / "notes.txt"))
    omitted = ft._filter_read_blocked_search_results(result, "t", str(tmp_path))
    assert len(result.matches) == kept and omitted == 2 - kept


def test_g28_a_search_the_user_allowed_on_the_folder_returns_its_lines(monkeypatch, tmp_path):
    import tools.approval as approval
    from tools import file_tools as ft
    _fs_home(monkeypatch, tmp_path)
    monkeypatch.setattr(approval, "iclone_ignore_in_force", lambda: False)
    monkeypatch.setattr(ft, "_resolved_match_path", lambda path, _task: path)
    result = _search_result(str(tmp_path / ".ssh" / "id_rsa"))
    assert ft._filter_read_blocked_search_results(result, "t", str(tmp_path / ".ssh")) == 0 and len(result.matches) == 1


# B-P3: shutdown, reboot and kill-all ask, and what is approved runs.
MACHINE = ["shutdown -h now", "sudo reboot", "kill -9 -1", "kill -- -1", "halt", "systemctl reboot", ":(){ :|:& };:"]


def _decide(mode, floor):
    from hermes_plugins.iclone_permissions.policy import decide
    return decide(_body(standing=mode), cls="X", facts={}, floor=floor, ceiling_key=None, session_id="s", project=None)


def _command_floor(command):
    from hermes_plugins.iclone_permissions.classify import classify
    return classify("terminal", {"command": command}, "/tmp/proj", {}).floor


@pytest.mark.parametrize("command", MACHINE)
def test_g28_stopping_the_machine_asks_plan_refuses_and_ignore_runs(plugin, command):
    floor = _command_floor(command)
    assert floor and floor.startswith("hardline:") and "total destruction" not in floor
    for mode in ("manual", "automatic", "acceptEdits"):
        assert (_decide(mode, floor).outcome, _decide(mode, floor).rule) == ("ask", "floor")
    plan = _decide("plan", floor)
    assert plan.outcome == "refuse"
    words = plugin._todo_for(plan, floor)
    assert "permission mode" in words and "every mode" not in words
    assert _decide("ignore", floor).outcome == "allow"


@pytest.mark.parametrize("command", MACHINE)
def test_g28_with_the_gate_the_runtime_lets_an_approved_stop_run(monkeypatch, command):
    import tools.approval as approval
    monkeypatch.setattr(approval, "_ICLONE_IGNORE_PROBE", lambda _session: False)
    assert approval._floor_block(command) is None


@pytest.mark.parametrize("command", ["rm -rf /", "rm -rf ~", "diskutil eraseDisk APFS X disk0", "kextunload x", "dd if=/dev/zero of=/dev/disk0"])
def test_g28_total_destruction_stays_shut_with_the_gate_in_every_mode(plugin, monkeypatch, command):
    import tools.approval as approval
    monkeypatch.setattr(approval, "_ICLONE_IGNORE_PROBE", lambda _session: False)
    assert approval._floor_block(command) is not None
    floor = _command_floor(command)
    for mode in ("manual", "automatic", "acceptEdits", "plan", "ignore"):
        verdict = _decide(mode, floor)
        assert (verdict.outcome, verdict.rule) == ("refuse", "floor")
    assert "every mode" in plugin._todo_for(_decide("manual", floor), floor)


def test_g28_with_the_gate_a_delete_it_cannot_resolve_is_the_classifier_s_ask_not_a_refusal(monkeypatch):
    import tools.approval as approval
    monkeypatch.setattr(approval, "_ICLONE_IGNORE_PROBE", lambda _session: False)
    assert approval._floor_block("rm -rf $BUILD_DIR") is None


@pytest.mark.parametrize("command", ["tccutil reset All", "osascript -e 'quit app \"icloneOS\"'"])
def test_g28_system_permissions_and_stopping_icloneos_ask_plan_refuses_and_ignore_runs(plugin, command):
    floor = _command_floor(command)
    assert floor and floor.startswith(("privilege:", "confinement:"))
    for mode in ("manual", "automatic", "acceptEdits"):
        assert (_decide(mode, floor).outcome, _decide(mode, floor).rule) == ("ask", "floor")
    plan = _decide("plan", floor)
    assert plan.outcome == "refuse" and "permission mode" in plugin._todo_for(plan, floor)
    assert "every mode" not in plugin._todo_for(plan, floor)
    assert _decide("ignore", floor).outcome == "allow"


@pytest.mark.parametrize("name", ["auth.json", ".env", "AUTH.JSON", "vault/vault.key"])
@pytest.mark.parametrize("tool", ["read_file", "search_files"])
def test_g28_a_read_of_the_runtime_s_own_secrets_is_refused_before_any_sheet(plugin, monkeypatch, tmp_path, name, tool):
    _fs_home(monkeypatch, tmp_path)
    words = plugin._runtime_secret_read(tool, str(tmp_path / ".hermes" / name))
    assert words and "Access denied" in words


def test_g28_a_project_env_and_an_ordinary_file_keep_their_way(plugin, monkeypatch, tmp_path):
    _fs_home(monkeypatch, tmp_path)
    assert plugin._runtime_secret_read("read_file", str(tmp_path / "proj" / ".env")) is None
    assert plugin._runtime_secret_read("read_file", str(tmp_path / "notes.txt")) is None
    assert plugin._runtime_secret_read("write_file", str(tmp_path / ".hermes" / "auth.json")) is None


def test_g28_the_gate_refuses_that_read_with_no_ask_in_manual(monkeypatch, w):
    from tests.plugins.test_iclone_one_file_and_background import _gate
    plugin, _core, channel = _gate(monkeypatch, w, "manual", {"state": "decided", "allowed": True, "grantId": None})
    monkeypatch.setattr("agent.file_safety._hermes_dirs", lambda: [w.home / ".hermes"])
    said = plugin._decide("read_file", {"path": str(w.home / ".hermes" / "auth.json")}, "t", "s", "v-g28", {})
    assert said and "every mode" in str(said) and not channel.asks


@pytest.mark.parametrize("command", ["printf 'x\\n' | sudo -S true", "sudo --stdin true"])
def test_g28_feeding_the_admin_password_asks_as_the_text_says(plugin, command):
    floor = _command_floor(command)
    assert floor and floor.startswith("sudo:")
    assert _decide("manual", floor).outcome == "ask" and _decide("plan", floor).outcome == "refuse" and _decide("ignore", floor).outcome == "allow"


# A-m2: the floor on a command's text reads a name as the disk does.
@pytest.mark.parametrize("command", ["cat ~/.SSH/id_rsa", "echo x >> ~/.SSH/authorized_keys", "cat ~/.ſsh/authorized_keys"])
def test_g28_a_command_s_key_floor_holds_a_disk_alias(plugin, command):
    home = os.path.expanduser("~")
    from hermes_plugins.iclone_permissions.classify import classify
    floor = classify("terminal", {"command": command}, "/tmp/proj", {"secretPaths": [f"{home}/.ssh/id_*"]}).floor
    assert floor and floor.startswith("secrets:")


def test_g28_a_command_near_the_key_name_has_no_floor(plugin):
    home = os.path.expanduser("~")
    from hermes_plugins.iclone_permissions.classify import classify
    assert classify("terminal", {"command": "cat ~/.SSH/known_hosts"}, "/tmp/proj", {"secretPaths": [f"{home}/.ssh/id_*"]}).floor is None


# Packed proof: the quit ends an approved background command outside the Seatbelt and must say so, as it does for a confined one.
def test_g28_the_quit_writes_the_ended_row_for_a_background_command_run_outside(monkeypatch):
    from tests.plugins.test_iclone_fx21 import TestF1Launcher
    helper = TestF1Launcher()
    Lm, launcher, _members, _ = helper.world(monkeypatch)
    run = helper.run(Lm)
    run.background = run.one_shot = True
    launcher.outside[run.proc.pid] = run
    killed = []
    monkeypatch.setattr(Lm.os, "killpg", lambda group, sig: killed.append(group))
    launcher.journal.rows = []
    launcher.stop()
    ended = [row for row in launcher.journal.rows if row["ev"] == "left-ended" and row["run"] == run.token]
    assert killed == [run.proc.pid] and ended and ended[0]["why"] == "quit" and ended[0]["stopped"] is True


# A-m4: a relative path that lands outside the project is the route's too.
def test_g28_a_relative_path_is_spelled_where_it_lands(plugin, tmp_path):
    folder = tmp_path / "proj"
    folder.mkdir()
    assert plugin._file_spelling({"path": "../.zshrc"}, str(folder)) == os.path.join(os.path.realpath(tmp_path), ".zshrc")
    assert plugin._file_spelling({"path": "../.zshrc"}) is None


def test_g28b_a_line_it_cannot_read_beside_a_guard_pid_asks_like_a_stop(plugin):
    floor = __import__("hermes_plugins.iclone_permissions.classify", fromlist=["classify"]).classify(
        "terminal", {"command": "$X 4242"}, "/tmp/proj", {"guardPids": [4242]}).floor
    assert floor == "confinement: this stops icloneOS, the agent runtime or your whole login session"


@pytest.mark.parametrize("command", ["$X; acp email compose --to x", "$X acp trade hl-order --size 1"])
def test_g28b_a_line_it_cannot_read_beside_a_payment_binary_stays_refused_outside_ignore(plugin, command):
    from hermes_plugins.iclone_permissions.classify import classify
    from hermes_plugins.iclone_permissions.policy import UNREAD_CONFINEMENT_FLOOR

    floor = classify("terminal", {"command": command}, "/tmp/proj", {"guardPids": [4242]}).floor
    assert floor == UNREAD_CONFINEMENT_FLOOR
    for mode in ("manual", "automatic", "acceptEdits", "plan"):
        assert (_decide(mode, floor).outcome, _decide(mode, floor).rule) == ("refuse", "floor"), mode
    assert _decide("ignore", floor).outcome == "allow"
