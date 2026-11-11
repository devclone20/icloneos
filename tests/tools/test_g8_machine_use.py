"""G8, the owner's order on real use of the machine (rulings R1, R2, R4 in RESUME/release/v0.0.6/work/NOTES.md).

R1: browser search works with the Seatbelt on: inside the agent's profile, network from the mode, floor unchanged.
R2: computer_use is offered directly. R4: an error names what the user can do in the app, not a CLI this Mac lacks; a
fresh install fetches the driver version the real-driver rows ran.
"""
from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def under_the_app(monkeypatch):
    from hermes_cli import iclone_policy_env
    monkeypatch.setattr(iclone_policy_env, "locked", lambda: True)


def _seatbelt(monkeypatch):
    from tools.bot_desktop import placement
    monkeypatch.setattr(placement, "_terminal_backend", lambda: "iclone_seatbelt")
    monkeypatch.setattr(placement, "_setting", lambda: "auto")


def test_r1_the_browser_preflight_passes_with_the_seatbelt_on(monkeypatch):
    from tools import browser_tool_session as s, browser_tool_install as install
    _seatbelt(monkeypatch)
    monkeypatch.setattr(install, "_find_agent_browser", lambda **k: "/store/agent-browser")
    monkeypatch.setattr(install, "_chromium_installed", lambda: True)
    assert s._browser_command_preflight() == {"browser_cmd": "/store/agent-browser"}


def test_r1_absent_agent_browser_stays_offered_under_the_app(monkeypatch, under_the_app):
    from tools import browser_tool as bt, browser_tool_install as install
    monkeypatch.setattr(bt, "_is_browser_use_cli_mode", lambda: False)
    monkeypatch.setattr(bt, "_is_camofox_mode", lambda: False)
    monkeypatch.setattr(install._cdp, "_get_cdp_override_raw", lambda: "")

    def absent(**_):
        raise FileNotFoundError("no")

    monkeypatch.setattr(install, "_find_agent_browser", absent)
    assert install.check_browser_requirements() is True


def test_r1_absent_agent_browser_is_still_hidden_outside_the_app(monkeypatch):
    from tools import browser_tool as bt, browser_tool_install as install
    monkeypatch.setattr(bt, "_is_browser_use_cli_mode", lambda: False)
    monkeypatch.setattr(bt, "_is_camofox_mode", lambda: False)
    monkeypatch.setattr(install._cdp, "_get_cdp_override_raw", lambda: "")

    def absent(**_):
        raise FileNotFoundError("no")

    monkeypatch.setattr(install, "_find_agent_browser", absent)
    assert install.check_browser_requirements() is False


def test_r1_absent_browser_gives_a_next_step_in_the_app(monkeypatch, under_the_app):
    from tools import browser_tool_install as install
    text = install._browser_install_hint()
    assert "Install again" in text and "Settings > Setup" in text and "web_search" in text
    assert "hermes" not in text and "npx" not in text


def test_r1_a_failed_fetch_names_no_cli_in_the_app(monkeypatch, under_the_app):
    import pm
    from tools import browser_tool_install as install
    monkeypatch.setattr(pm, "installed_package", lambda name: None)
    monkeypatch.setattr(install.shutil, "which", lambda *a, **k: None)
    monkeypatch.setattr(install, "_is_termux_environment", lambda: False)

    def refuse(name):
        raise OSError("run hermes pm install")

    monkeypatch.setattr(pm, "ensure", refuse)
    with pytest.raises(FileNotFoundError) as got:
        install._find_agent_browser()
    assert "hermes" not in str(got.value) and "Settings > Setup" in str(got.value)


def test_r1_the_chromium_hint_names_the_app_too(monkeypatch, under_the_app):
    from tools import browser_tool_install as install, browser_tool_session as s
    monkeypatch.setattr(install, "_find_agent_browser", lambda **k: "/store/agent-browser")
    monkeypatch.setattr(install, "_chromium_installed", lambda: False)
    monkeypatch.setattr(install, "_maybe_autoinstall_chromium", lambda: False)
    monkeypatch.setattr(install, "_running_in_docker", lambda: False)
    monkeypatch.setattr(s._cloud, "_is_local_mode", lambda: True)
    monkeypatch.setattr(s._cloud, "_get_browser_engine", lambda: "chrome")
    out = s._browser_command_preflight()
    assert "Settings > Setup" in out["error"] and "hermes" not in out["error"]


def test_r1_the_same_browser_with_the_seatbelt_off(monkeypatch, under_the_app):
    """browser_exec has no live row and runs the agent's Python on the host; the app has one browser in both states."""
    from tools import browser_use_cli as cli
    monkeypatch.setattr(cli, "_camofox_active", lambda *a: False)
    monkeypatch.setattr(cli, "get_browser_backend", lambda: "")
    assert cli.is_browser_use_cli_mode() is False


def test_r1_an_explicit_browser_use_backend_is_kept_with_the_seatbelt_off(monkeypatch, under_the_app):
    from tools import browser_use_cli as cli
    monkeypatch.setattr(cli, "_camofox_active", lambda *a: False)
    monkeypatch.setattr(cli, "get_browser_backend", lambda: cli._BACKEND_KEY)
    assert cli.is_browser_use_cli_mode() is True


def test_r2_computer_use_is_not_deferred():
    from hermes_cli.config_defaults import DEFAULT_CONFIG
    assert "computer_use" not in DEFAULT_CONFIG["tools"]["tool_search"]["defer"]


def test_skill_sends_no_one_to_a_refused_path():
    text = " ".join((ROOT / "skills/autonomous-ai-agents/computer-use/SKILL.md").read_text(encoding="utf-8").split())
    assert "Reserve `computer_use` for browser" not in text
    assert "Either works with the Seatbelt on or off" in text and "visible browser app" in text


def test_r4_repair_text_names_the_app(under_the_app, monkeypatch):
    from tools.computer_use import cua_backend
    assert "Settings > Setup > Computer use" in cua_backend._repair_step()
    assert "hermes" not in cua_backend._repair_step()
    monkeypatch.setattr(cua_backend.sys, "platform", "darwin")
    monkeypatch.setattr(cua_backend, "_linux_session_locked", lambda: None)
    assert "hermes" not in cua_backend._empty_discovery_reason()


def test_r4_repair_text_is_unchanged_outside_the_app():
    from tools.computer_use import cua_backend
    assert "hermes computer-use install" in cua_backend._repair_step()


def test_r4_setup_copy_names_no_cli():
    assert "hermes computer-use" not in (ROOT / "apps/desktop/src/components/setup/copy.ts").read_text(encoding="utf-8")


def test_r4_a_fresh_install_fetches_the_proved_driver():
    entry = json.loads((ROOT / "pm/lock.json").read_text(encoding="utf-8"))["packages"]["cua-driver"] \
        if "packages" in json.loads((ROOT / "pm/lock.json").read_text(encoding="utf-8")) else None
    assert entry is not None and entry["version"] == "0.28.2"
    assert all("0.28.2" in a["url"] and "0.21.0" not in a["url"] for a in entry["artifacts"].values())
    assert entry["artifacts"]["darwin-arm64"]["sha256"] == "e273181b26709c88b1d809474deb3c592b4efae3530b11d76318f1887fc3fbb1"


def test_r1_the_exec_bit_is_read_from_the_mode_not_from_access(tmp_path, monkeypatch):
    """A confined runtime may exec only its interpreter: access(X_OK) answers no for a store binary whose mode says yes,
    and agent-browser then looks not installed with the Seatbelt on."""
    import os
    from pm import install
    binary = tmp_path / "agent-browser"
    binary.write_text("")
    binary.chmod(0o755)
    monkeypatch.setattr(os, "access", lambda *a, **k: False)
    monkeypatch.setattr(Path, "chmod", lambda *a, **k: pytest.fail("no chmod for a binary already executable"))
    assert install._heal_exec_bit(binary) is True


# R1, the socket folder. Confined, /tmp is closed to the runtime and to the browser it launches: the folder lives in the
# runtime's own temp folder (a root the launcher already grants), and the socket in it must fit the kernel's cap on a
# real home, not only on a test's short one.
OWNER_LENGTH_TMP = "/Users/" + "x" * 15 + "/Library/Caches/iclone-os-confinement/tmp"  # a 15-letter account name


@pytest.fixture
def short_tmp():
    # pytest's tmp_path is too deep for a socket: that is the point of the cap.
    folder = Path(tempfile.mkdtemp(prefix="g8", dir="/private/tmp"))
    yield folder
    shutil.rmtree(folder, ignore_errors=True)


@pytest.fixture
def confined(monkeypatch):
    from hermes_cli import iclone_policy_env
    monkeypatch.setattr(iclone_policy_env, "confined_backend", lambda: "iclone_seatbelt")


def test_r1_confined_the_socket_folder_lives_in_the_runtime_temp_folder(monkeypatch, confined, short_tmp):
    from tools import browser_tool as bt, browser_tool_session as s
    monkeypatch.setenv("TMPDIR", str(short_tmp))
    folder = s._prepare_session_socket_dir("h_0123456789")
    assert Path(folder).parent == short_tmp.resolve()
    assert Path(folder).is_dir() and (Path(folder).stat().st_mode & 0o777) == 0o700
    assert (Path(folder) / "h_0123456789.owner_pid").is_file()
    assert bt._socket_safe_tmpdir() == str(short_tmp.resolve())


def test_r1_the_socket_fits_the_kernel_cap_on_a_real_home(monkeypatch, confined):
    from tools import browser_tool as bt
    monkeypatch.setenv("TMPDIR", OWNER_LENGTH_TMP)
    socket = Path(bt._session_socket_dir("h_0123456789")) / "h_0123456789.sock"
    assert str(socket).startswith(OWNER_LENGTH_TMP + "/")
    assert len(str(socket)) <= 103


def test_r1_a_socket_past_the_cap_is_refused_in_words(monkeypatch, confined):
    from tools import browser_tool_session as s
    monkeypatch.setenv("TMPDIR", "/private/tmp/" + "x" * 90)
    with pytest.raises(OSError, match="too long"):
        s._prepare_session_socket_dir("h_0123456789")


def test_r1_seatbelt_off_keeps_the_short_root(monkeypatch):
    from hermes_cli import iclone_policy_env
    from tools import browser_tool as bt
    monkeypatch.setattr(iclone_policy_env, "confined_backend", lambda: None)
    assert bt._session_socket_dir("h_0123456789") == "/tmp/agent-browser-h_0123456789"


def test_r1_the_orphan_reaper_finds_the_confined_folders(monkeypatch, confined, short_tmp):
    from tools import browser_tool_lifecycle as life
    monkeypatch.setenv("TMPDIR", str(short_tmp))
    from tools import browser_tool_session as s
    folder = s._prepare_session_socket_dir("h_0123456789")
    seen = []
    monkeypatch.setattr(life, "_reap_socket_dir", lambda d, name, tracked: seen.append((d, name)) or False)
    life._reap_orphaned_browser_sessions()
    assert seen == [(folder, "h_0123456789")]
