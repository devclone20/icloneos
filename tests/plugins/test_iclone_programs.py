"""V3-UP r5 (ruling 56): plugins/iclone-confinement/programs.py — how an app-fixed program is confined.

The live proof is apps/desktop/electron/iclone-confinement/hermes-plugin.live.test.ts (the real generated profiles,
agent-browser and Chrome); this pins the profile text programs.confine builds for each kind, without running it.
"""
from __future__ import annotations

import hashlib
import importlib
import importlib.util
import json
import os
import plistlib
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
    ab = store / "agent-browser-0.26.0-darwin-arm64" / "bin" / "agent-browser"
    ab.parent.mkdir(parents=True)
    ab.write_text("#!/bin/sh\n")
    app = root / "Apps" / "Browser.app"
    (app / "Contents" / "MacOS").mkdir(parents=True)
    (app / "Contents" / "MacOS" / "Browser").write_text("")
    with open(app / "Contents" / "Info.plist", "wb") as handle:
        plistlib.dump({"CFBundleIdentifier": "com.example.Browser"}, handle)
    own = root / "ab-own"
    own.mkdir()
    monkeypatch.setattr(programs, "_store_roots", lambda: (str(store),))
    monkeypatch.setattr(programs, "_install_of",
                        lambda p: (str(store / "agent-browser-0.26.0-darwin-arm64") if str(p).startswith(str(store))
                                   else str(app) if str(p).startswith(str(app)) else None))
    monkeypatch.setattr(programs, "_user_temp_dir", lambda: str(root / "T"))
    return types.SimpleNamespace(root=root, programs=programs, core=core, ab=str(ab),
                                 chrome=str(app / "Contents" / "MacOS" / "Browser"), app=str(app), own=str(own),
                                 store=str(store))


def _browser(w, **env):
    base = {"AGENT_BROWSER_SOCKET_DIR": w.own, "AGENT_BROWSER_EXECUTABLE_PATH": w.chrome, "PATH": "/usr/bin:/bin"}
    return w.programs.confine([w.ab, "open", "https://example.com"], kind="browser", env={**base, **env})


def _added(text: str) -> list:
    """The rules the widening added (between the base profile's body and its never-block)."""
    start = text.index("; icloneOS V3-UP r5")
    return [line for line in text[start:text.index(NEVER)].splitlines() if line and not line.startswith(";")]


def _define(argv: list, name: str) -> str:
    return next(argv[i + 1].split("=", 1)[1] for i, a in enumerate(argv) if a == "-D" and argv[i + 1].startswith(name + "="))


class TestTheBrowserIsConfinedNotFreed:
    def test_the_widening_sits_before_the_never_block(self, world):
        argv, _ = _browser(world)
        text = argv[2]
        assert argv[:2] == ["/usr/bin/sandbox-exec", "-p"] and argv[-3:] == [os.path.realpath(world.ab), "open",
                                                                              "https://example.com"]
        assert text.index("; icloneOS V3-UP r5") < text.index(NEVER), "a widening after the never-block wins over it"
        assert text.rstrip().endswith('(deny file-read* file-write* (subpath "/Users/x/.ssh") '
                                      '(with message "iclone-confined:research"))')

    def test_it_reads_nothing_outside_its_own_install_and_folder(self, world):
        argv, _ = _browser(world)
        reads = [line for line in _added(argv[2]) if re.search(r"\(allow [^)]*file-read\*", line)]
        allowed = (world.own, world.app, os.path.join(world.store, "agent-browser-0.26.0-darwin-arm64"))
        for line in reads:
            for path in re.findall(r'\((?:subpath|literal) "([^"]+)"\)', line):
                assert path.startswith(allowed), (path, line)
            for rx in re.findall(r'\(regex #"([^"]+)"\)', line):
                assert rx.startswith("^" + re.escape(str(world.root / "T")).replace("\\/", "/")) or \
                    rx.startswith("^" + str(world.root / "T").replace(".", "\\.")), rx
                assert "com\\.example\\.Browser\\." in rx, rx
        meta = [line for line in _added(argv[2]) if line.startswith("(allow file-read-metadata")]
        assert meta and all("(subpath" not in line for line in meta), "ancestors are literals, never a listing"

    def test_chromes_own_sandbox_is_off_and_its_state_lives_in_its_folder(self, world):
        argv, env = _browser(world, AGENT_BROWSER_ARGS="--mute-audio")
        flags = env["AGENT_BROWSER_ARGS"].split(",")
        assert flags[0] == "--mute-audio" and {"--no-sandbox", "--disable-gpu"} <= set(flags)
        assert env["TMPDIR"].startswith(world.own) and env["HOME"].startswith(world.own)

    def test_the_network_is_the_modes_grant(self, world, monkeypatch):
        monkeypatch.setattr(world.core, "grant_params", lambda s, p: {"NET": "1", "WRITE_PROJECT": "1"})
        assert _define(_browser(world)[0], "NET") == "1"
        monkeypatch.setattr(world.core, "grant_params", lambda s, p: {"NET": "0", "WRITE_PROJECT": "1"})
        assert _define(_browser(world)[0], "NET") == "0"

    def test_an_agent_browser_outside_the_store_or_without_a_folder_does_not_run(self, world, tmp_path):
        stray = tmp_path / "agent-browser"
        stray.write_text("")
        with pytest.raises(world.core.ConfinementRefused, match="managed tool store"):
            world.programs.confine([str(stray), "open", "x"], kind="browser",
                                   env={"AGENT_BROWSER_SOCKET_DIR": world.own})
        with pytest.raises(world.core.ConfinementRefused, match="folder of its own"):
            world.programs.confine([world.ab], kind="browser", env={})

    def test_a_path_the_profile_cannot_express_is_refused(self, world):
        quoted = world.root / 'own"dir'
        quoted.mkdir()
        with pytest.raises(world.core.ConfinementRefused, match="unsafe path"):
            _browser(world, AGENT_BROWSER_SOCKET_DIR=str(quoted))


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
        assert env is None
