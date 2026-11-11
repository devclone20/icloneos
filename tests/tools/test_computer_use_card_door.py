"""G2 A2, A3: the Computer use card with the Seatbelt on. Real launcher socket, real stub, a stand-in driver with TCC NOT
granted. Only a real macOS grant can prove the dialog and its attribution; this proves the click reaches the driver."""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "plugins" / "iclone-confinement"
darwin = pytest.mark.skipif(sys.platform != "darwin", reason="the macOS TCC card")


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


door = _load("iclone_driver_door", PLUGIN / "driver_door.py")
launcher_mod = _load("iclone_launcher_for_card", PLUGIN / "launcher.py")
SOCK = "hc-0123456789ab"

STAND_IN = """#!/bin/sh
case "$*" in
  "--version") echo 0.28.2 ;;
  "doctor --json") echo '{"ok":true,"checks":[]}' ;;
  "permissions status --json")
    if [ -f "%(granted)s" ]; then echo '{"accessibility":true,"screen_recording":true}'
    else echo '{"accessibility":false,"screen_recording":false}'; fi ;;
  "permissions grant") echo "the dialog was raised" ; touch "%(granted)s" ;;
  *) echo "unexpected: $*" >&2 ; exit 9 ;;
esac
"""


@pytest.fixture
def world(tmp_path, monkeypatch):
    run = Path(f"/tmp/g2c{os.getpid()}")
    run.mkdir(mode=0o700, exist_ok=True)
    app = tmp_path / "CuaDriver.app"
    (app / "Contents" / "MacOS").mkdir(parents=True)
    exe = app / "Contents" / "MacOS" / "cua-driver"
    granted = tmp_path / "tcc-granted"
    exe.write_text(STAND_IN % {"granted": granted})
    exe.chmod(0o755)
    launcher = launcher_mod.Launcher(SimpleNamespace(scratch_root=str(tmp_path / "scratch"), members_dir=str(tmp_path / "members")),
                                     str(run / "l.sock"), str(tmp_path / "journal"))
    launcher.driver_door.locator = lambda *_: (str(app), "")
    launcher.bind()
    threading.Thread(target=launcher.serve_forever, daemon=True).start()
    from tools.computer_use import cua_backend_driver as driver

    monkeypatch.setattr(driver, "door_socket", lambda: str(run / "l.sock"))
    monkeypatch.setattr("plugins.computer_use.configured_backend_name", lambda: "cua", raising=False)
    from plugins.computer_use import DEFAULT_BACKEND

    monkeypatch.setattr("plugins.computer_use.configured_backend_name", lambda: DEFAULT_BACKEND)
    yield SimpleNamespace(socket=str(run / "l.sock"), granted=granted, launcher=launcher, journal=tmp_path / "journal")
    launcher.stop()
    shutil.rmtree(run, ignore_errors=True)


@darwin
def test_a2_the_status_reads_through_the_door_with_tcc_not_granted(world):
    from tools.computer_use.permissions import computer_use_status

    out = computer_use_status()
    assert out["error"] is None and out["installed"] is True and out["version"] == "0.28.2"
    assert out["accessibility"] is False and out["screen_recording"] is False and out["ready"] is False


@darwin
def test_a2_allow_in_the_real_action_process_reaches_the_driver_and_the_card_then_reads_ready(world, tmp_path):
    """The action is a child of the confined server: a process of its own, reading its own exec environment."""
    env = {"PATH": os.environ["PATH"], "HOME": str(tmp_path), "HERMES_HOME": str(tmp_path / "hh"),
           "ICLONE_CONFINEMENT": "1", "ICLONE_CONFINEMENT_LAUNCHER": world.socket, "PYTHONPATH": str(ROOT)}
    code = "import sys; from tools.computer_use.permissions import request_permissions_grant as g; sys.exit(g())"
    proc = subprocess.run([sys.executable, "-c", code], env=env, cwd=str(ROOT), capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    assert "the dialog was raised" in proc.stdout and world.granted.exists()
    from tools.computer_use.permissions import computer_use_status

    assert computer_use_status()["ready"] is True
    rows = [json.loads(line) for name in os.listdir(world.journal) if name.endswith("jsonl") and "oneshot" not in name
            for line in (world.journal / name).read_text().splitlines()]
    assert any("permissions grant" in str(row.get("command")) and row.get("unconfined") for row in rows)


def test_a2_the_private_status_daemon_uses_shapes_the_door_accepts(monkeypatch):
    from tools.computer_use import permissions as p

    seen = []

    def fake_run(binary, *args, timeout):
        seen.append([binary, *args])
        out = '{"accessibility":false,"screen_recording":false}' if args[0] == "call" else ""
        return SimpleNamespace(returncode=0, stdout=out, stderr="")

    monkeypatch.setattr(p, "_run", fake_run)
    monkeypatch.setattr(p, "_private_status_cache", (0.0, None, None))
    out = p._private_daemon_status(door.COMMAND)
    assert out.get("accessibility") is False
    for argv in seen:
        assert argv[0] == door.COMMAND
        assert door._shape(argv[1:])[0] == argv[1:]


@pytest.mark.parametrize("args", [["--version"], ["doctor", "--json"], ["permissions", "status", "--json"], ["permissions", "grant"]])
def test_a2_each_card_verb_has_its_one_exact_shape(args):
    assert door._shape(args) == (args, "", False)


@pytest.mark.parametrize("args", [
    ["permissions"], ["permissions", "reset"], ["permissions", "status"], ["permissions", "grant", "--all"],
    ["permissions", "grant", "--socket", SOCK], ["permissions", "status", "--json", "--bundle", "x"],
    ["doctor"], ["doctor", "--json", "--fix"], ["--version", "x"], ["update"], ["install"],
])
def test_a2_the_neighbours_of_the_card_verbs_stay_refused(args):
    with pytest.raises(door.DoorRefused):
        door._shape(args)


@darwin
def test_a3_no_driver_with_the_seatbelt_on_reads_not_installed_so_install_shows(world):
    world.launcher.driver_door.locator = lambda *_: ("", door.ABSENT)
    from tools.computer_use.permissions import computer_use_status

    out = computer_use_status()
    assert out["installed"] is False and out["ready"] is None and out["error"] is None


@darwin
def test_a3_a_forged_driver_reads_not_installed_and_says_why(world):
    world.launcher.driver_door.locator = lambda *_: ("", door.BAD_SIGNATURE.format(path="/x", why="no") + door.ABSENT)
    from tools.computer_use.permissions import computer_use_status

    out = computer_use_status()
    assert out["installed"] is False and "not the CuaDriver signed by Cua" in out["error"]


def test_a3_a_launcher_that_does_not_answer_is_no_claim_that_the_driver_is_absent(monkeypatch, tmp_path):
    from tools.computer_use import cua_backend_driver as driver
    from tools.computer_use.permissions import computer_use_status

    monkeypatch.setattr(driver, "door_socket", lambda: str(tmp_path / "gone.sock"))
    from plugins.computer_use import DEFAULT_BACKEND

    monkeypatch.setattr("plugins.computer_use.configured_backend_name", lambda: DEFAULT_BACKEND)
    out = computer_use_status()
    assert out["installed"] is True and out["ready"] is None and "not answering" in out["error"]


def test_a3_no_driver_with_the_seatbelt_off_reads_not_installed(monkeypatch):
    from tools.computer_use import cua_backend_driver as driver
    from tools.computer_use.permissions import computer_use_status
    from plugins.computer_use import DEFAULT_BACKEND

    monkeypatch.setattr(driver, "door_socket", lambda: "")
    monkeypatch.setattr(driver, "resolve_cua_driver_cmd", lambda *_: None)
    monkeypatch.setattr("plugins.computer_use.configured_backend_name", lambda: DEFAULT_BACKEND)
    assert computer_use_status()["installed"] is False


def test_a3_the_path_named_to_the_user_is_where_the_install_button_lives():
    assert "Settings > Setup > Computer use" in door.ABSENT and "Settings > Permissions" not in door.ABSENT
    panes = (ROOT / "apps/desktop/src/app/settings/panes.tsx").read_text()
    setup = (ROOT / "apps/desktop/src/app/settings/setup-settings.tsx").read_text()
    rows = (ROOT / "apps/desktop/src/components/setup/rows.tsx").read_text()
    copy = (ROOT / "apps/desktop/src/components/setup/copy.ts").read_text()
    assert "setup-settings" in panes and "CuaDriverAction" in rows and 'data-setup-item="computerUse"' in rows
    assert "rows" in setup.lower() and "name: 'Computer use'" in copy


def _install(monkeypatch, found):
    from hermes_cli import tools_config_cua as cua
    from tools.computer_use import cua_backend_driver as driver, permissions

    monkeypatch.delenv("HERMES_CUA_DRIVER_CMD", raising=False)
    monkeypatch.setattr(driver, "door_socket", lambda: "/tmp/g2-door.sock")
    monkeypatch.setattr("pm.ensure", lambda *a, **k: None)
    monkeypatch.setattr(permissions, "_run", lambda b, *a, timeout: found)
    monkeypatch.setattr(cua, "_cua_driver_contract_status", lambda *_: pytest.fail("exec of the door word"))
    monkeypatch.setattr(cua, "_run_text", lambda *_a, **_k: pytest.fail("lsregister under the Seatbelt"))
    return cua


def test_a3_install_with_the_seatbelt_on_asks_the_door_and_runs_nothing_itself(monkeypatch):
    cua = _install(monkeypatch, SimpleNamespace(returncode=0, stderr=""))
    assert cua.install_cua_driver(show_installer_progress=False) is True


def test_a3_install_with_the_seatbelt_on_fails_plainly_when_the_door_finds_none(monkeypatch):
    cua = _install(monkeypatch, SimpleNamespace(returncode=126, stderr="Refused by icloneOS confinement: " + door.ABSENT))
    assert cua.install_cua_driver(show_installer_progress=False) is False
