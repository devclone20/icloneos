"""Lens MINOR 1: the driver door's hc-*.sock follow the private socket folder's rules. A known prefix only, made only in
the checked folder (a real folder of this user, 0700, never a link), and the door's own dead sockets removed when the
launcher starts and when it stops; a live daemon's socket and anything not the door's are left alone."""

from __future__ import annotations

import importlib.util
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "plugins" / "iclone-confinement"
darwin = pytest.mark.skipif(sys.platform != "darwin", reason="the launcher's unix socket path is the macOS one")


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


door = _load("iclone_driver_door", PLUGIN / "driver_door.py")
launcher_mod = _load("iclone_launcher_for_door_sockets", PLUGIN / "launcher.py")

NAME = "hc-0123456789abcdef"


def _dead_socket(path: Path) -> None:
    """A socket file nothing listens on: what a crashed run leaves."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(str(path))
    s.close()


LISTEN = """
import os, signal, socket, sys
s = socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen(8)
signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
print("up", flush=True)
while True: s.accept()[0].close()
"""


def _daemon(path: Path) -> subprocess.Popen:
    proc = subprocess.Popen([sys.executable, "-c", LISTEN, str(path)], stdout=subprocess.PIPE, text=True)
    assert proc.stdout.readline().strip() == "up"
    return proc


@pytest.fixture
def folder():
    """The new layout: a short private folder (ic-<hash>), launcher.sock in it, the door's sockets beside it."""
    where = Path(f"/tmp/icdd{os.getpid()}")
    shutil.rmtree(where, ignore_errors=True)
    where.mkdir(mode=0o700)
    yield where
    shutil.rmtree(where, ignore_errors=True)


def _launcher(folder: Path, tmp_path: Path):
    index = SimpleNamespace(scratch_root=str(tmp_path / "scratch"), members_dir=str(tmp_path / "members"))
    return launcher_mod.Launcher(index, str(folder / "launcher.sock"), str(tmp_path / "journal"))


def _hc(folder: Path) -> list:
    return sorted(p.name for p in folder.iterdir() if p.name.startswith("hc-"))


@darwin
def test_the_door_works_on_the_new_layout_through_the_real_launcher_and_stub(folder, tmp_path):
    drv = tmp_path / "drv"
    (drv / "Contents" / "MacOS").mkdir(parents=True)
    exe = drv / "Contents" / "MacOS" / "cua-driver"
    exe.write_text('#!/bin/sh\necho "driver said: $*"\n')
    exe.chmod(0o755)
    launcher = _launcher(folder, tmp_path)
    launcher.driver_door.locator = lambda *_: (str(drv), "")
    launcher.bind()
    threading.Thread(target=launcher.serve_forever, daemon=True).start()
    try:
        proc = subprocess.run([sys.executable, "-I", "-S", str(PLUGIN / "stub.py"), str(folder / "launcher.sock"), "--",
                               door.COMMAND, "status", "--socket", NAME], capture_output=True, text=True, timeout=20,
                              stdin=subprocess.DEVNULL, env={"ICLONE_RUN_CWD": "/"})
        assert proc.returncode == 0, proc.stderr
        assert f"driver said: status --socket {folder}/{NAME}.sock" in proc.stdout
    finally:
        launcher.stop()


@darwin
def test_own_dead_sockets_go_on_start_a_live_one_and_strangers_stay(folder, tmp_path):
    _dead_socket(folder / f"{NAME}.sock")
    live = _daemon(folder / "hc-00000000aaaaaaaa.sock")
    (folder / "hc-0000000011111111.sock").write_text("not a socket")  # not a socket: never the door's to remove
    _dead_socket(folder / "other.sock")  # not the door's name
    launcher = _launcher(folder, tmp_path)
    try:
        launcher.bind()
        assert _hc(folder) == ["hc-0000000011111111.sock", "hc-00000000aaaaaaaa.sock"]
        assert (folder / "other.sock").exists() and (folder / "launcher.sock").exists()
    finally:
        launcher.stop()
        live.kill()
        live.stdout.close()


@darwin
def test_nothing_of_the_door_is_left_after_shutdown(folder, tmp_path):
    exe = tmp_path / "drv"
    exe.write_text("#!/bin/sh\nexit 0\n")  # a driver whose stop does nothing: the sitter ends the daemon itself
    exe.chmod(0o755)
    launcher = _launcher(folder, tmp_path)
    launcher.bind()
    path = Path(launcher.driver_door.socket_path(NAME))
    daemon = _daemon(path)
    try:
        launcher.driver_door._sit(str(exe), str(path))
        _dead_socket(folder / "hc-00000000bbbbbbbb.sock")  # a run's daemon that died while the launcher lived
        launcher.stop()
        assert daemon.wait(timeout=15) == 0
        assert _hc(folder) == []
        assert not (folder / "launcher.sock").exists()
    finally:
        daemon.kill()
        daemon.stdout.close()


@pytest.fixture
def base():
    """A short scratch base: socket paths must fit sun_path, and pytest's own tmp_path is too long for that."""
    where = Path(f"/tmp/icdb{os.getpid()}")
    shutil.rmtree(where, ignore_errors=True)
    where.mkdir(mode=0o700)
    yield where
    shutil.rmtree(where, ignore_errors=True)


def _door(directory: Path):
    return door.Door(str(directory), "", "", locator=lambda *_: ("/x.app", ""))


def test_a_folder_that_is_a_link_is_refused(base):
    real = base / "real"
    real.mkdir(mode=0o700)
    (base / "link").symlink_to(real)
    with pytest.raises(door.DoorRefused, match="private socket folder"):
        _door(base / "link").socket_path(NAME)


def test_a_folder_others_may_open_is_refused(base):
    loose = base / "loose"
    loose.mkdir()
    loose.chmod(0o755)
    with pytest.raises(door.DoorRefused, match="private socket folder"):
        _door(loose).socket_path(NAME)


def test_a_missing_folder_is_refused_not_made(base):
    with pytest.raises(door.DoorRefused, match="private socket folder"):
        _door(base / "gone").socket_path(NAME)
    assert not (base / "gone").exists()


def test_a_file_already_at_the_socket_path_that_is_not_a_socket_is_refused(base):
    tight = base / "tight"
    tight.mkdir(mode=0o700)
    (tight / f"{NAME}.sock").write_text("keep")
    with pytest.raises(door.DoorRefused):
        _door(tight).socket_path(NAME)
    assert (tight / f"{NAME}.sock").read_text() == "keep"


def test_the_checked_folder_gives_the_path_inside_it(base):
    tight = base / "tight"
    tight.mkdir(mode=0o700)
    assert _door(tight).socket_path(NAME) == str(tight / f"{NAME}.sock")
