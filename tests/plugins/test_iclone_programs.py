"""V3-UP r5 (ruling 56): plugins/iclone-confinement/programs.py — how an app-fixed program is confined.

The live proof is apps/desktop/electron/iclone-confinement/hermes-plugin.live.test.ts (the real generated profiles,
and the browser's door); this pins the profile text programs.confine builds for each kind, without running it.
"""
from __future__ import annotations

import hashlib
import importlib
import importlib.util
import json
import os
import re
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PLUGIN_DIR = ROOT / "plugins" / "iclone-confinement"
PKG = "hermes_plugins.iclone_confinement"
NEVER = "; never, whatever the class or the permission mode"
BASE = f"""(version 1)
(deny default (with message "iclone-confined:research"))
(allow file-read* (subpath "/usr") (subpath "/System"))
(allow file-read* (subpath (param "PROJECT_ROOT")) (subpath (param "SCRATCH")))
{NEVER}
(deny file-read* file-write* (subpath "/Users/x/.ssh") (with message "iclone-confined:research"))
"""


def _load(env: dict):
    for name in [n for n in sys.modules if n.startswith(PKG)]:
        del sys.modules[name]
    if "hermes_plugins" not in sys.modules:
        ns = types.ModuleType("hermes_plugins")
        ns.__path__ = []
        sys.modules["hermes_plugins"] = ns
    saved = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    # R13: the plugin reads main's hand-over from the exec copy; here that copy is what this load was given. Read at
    # import, so the copy goes back as soon as the plugin has it.
    from hermes_cli import iclone_policy_env

    iclone_policy_env._reset_for_tests({k: v for k, v in env.items() if k.startswith("ICLONE_")})
    try:
        spec = importlib.util.spec_from_file_location(PKG, PLUGIN_DIR / "__init__.py",
                                                      submodule_search_locations=[str(PLUGIN_DIR)])
        mod = importlib.util.module_from_spec(spec)
        sys.modules[PKG] = mod
        spec.loader.exec_module(mod)
        return mod
    finally:
        for k, v in saved.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
        iclone_policy_env._reset_for_tests()


@pytest.fixture
def world(tmp_path, monkeypatch):
    root = Path(os.path.realpath(tmp_path))
    profiles = root / "profiles"
    profiles.mkdir()
    sha = hashlib.sha256(BASE.encode()).hexdigest()
    for cls in ("research", "media"):
        (profiles / f"{cls}.sb").write_text(BASE)
    spec = json.dumps({"v": 5, "profilesDir": str(profiles), "scratchRoot": str(root / "scratch"),
                       "home": str(root / "home"), "membersDir": str(root / "members"), "denied": [],
                       "sha256": {"research": sha, "media": sha}})
    (root / "home").mkdir()
    mod = _load({"ICLONE_CONFINEMENT": "1", "TERMINAL_ENV": "iclone_seatbelt", "ICLONE_CONFINEMENT_SPEC": spec})
    programs = importlib.import_module(f"{PKG}.programs")
    core = importlib.import_module(f"{PKG}.core")
    store = root / "store"
    store.mkdir()
    monkeypatch.setattr(programs, "_store_roots", lambda: (str(store),))
    return types.SimpleNamespace(root=root, programs=programs, core=core, store=str(store), rtmp=str(root / "rtmp"))


def _added(text: str) -> list:
    """The rules the widening added (between the base profile's body and its never-block)."""
    start = text.index("; icloneOS host-exec widening")
    return [line for line in text[start:text.index(NEVER)].splitlines() if line and not line.startswith(";")]


def _define(argv: list, name: str) -> str:
    return next(argv[i + 1].split("=", 1)[1] for i, a in enumerate(argv) if a == "-D" and argv[i + 1].startswith(name + "="))


@pytest.mark.parametrize("kind", ["browser", "browser_net", "Browser", ""])
def test_the_browser_is_no_kind_of_program_here(world, kind):
    """Ruling R1: it runs outside the Seatbelt through the launcher's door, so nothing may widen a profile for it."""
    with pytest.raises(world.core.ConfinementRefused, match="unknown program kind"):
        world.programs.confine(["/usr/bin/true", "open", "https://example.com"], kind=kind, env={"PATH": "/usr/bin:/bin"})


@pytest.mark.parametrize("module, name", [("core", "browser_net"), ("core", "net_outcome"), ("programs", "browser_widening")])
def test_the_browsers_old_widening_is_gone(world, module, name):
    """A widening left behind is a line a request could still name: G16 found the launcher accepting one."""
    assert not hasattr(getattr(world, module), name)


class TestMediaAndProbes:
    def test_a_media_program_reads_and_writes_only_the_files_named(self, world):
        inp, out = world.root / "in.wav", world.root / "out.ogg"
        inp.write_text("x")
        folder = world.root / "pages"
        folder.mkdir()
        argv, _ = world.programs.confine(["/usr/bin/true", "-i", str(inp), str(out)], kind="media",
                                         reads=(str(inp),), writes=(str(out), str(folder)))
        added = _added(argv[2])
        assert f'(allow file-read* (literal "{inp}"))' in added
        assert f'(allow file-read* file-write* (literal "{out}") (subpath "{folder}"))' in added
        assert _define(argv, "NET") == "0"

    def test_a_probe_adds_nothing_and_never_opens_the_network(self, world, monkeypatch):
        monkeypatch.setattr(world.core, "grant_params", lambda s, p: {"NET": "1", "WRITE_PROJECT": "1"})
        argv, env = world.programs.confine(["/usr/sbin/sysctl", "-n", "hw.ncpu"], kind="probe")
        assert _added(argv[2]) == [], "a probe adds no rule"
        assert _define(argv, "NET") == "0", "a probe never gets the network"
        # The runtime learning about the host is its own housekeeping: said to the launcher in the request's
        # environment (the launcher drops it before the program starts).
        assert env is not None and env[world.core.ORIGIN_ENV] == world.core.ORIGIN_RUNTIME
        assert {k: v for k, v in env.items() if k != world.core.ORIGIN_ENV} == dict(os.environ)


def test_a_terminal_command_gets_no_network_on_an_ask(world, monkeypatch):
    """An ask never opens a socket mid-command for the shell: grant_params is unchanged."""
    monkeypatch.setattr(world.core, "_permissions_module", lambda: None)
    assert world.core.grant_params("s1", None)["NET"] == "0"
