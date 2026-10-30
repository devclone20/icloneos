"""V3-G — the iclone-confinement plugin: inert outside icloneOS, the backend pin, the fail-closed hook, the project
rule, the per-command parameters read from V3-F's table, and (macOS) the real ``sandbox-exec`` wrapping."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import platform
import re
import stat
import subprocess
import sys
import time
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PLUGIN_DIR = ROOT / "plugins" / "iclone-confinement"
PKG = "hermes_plugins.iclone_confinement"
LIVE = platform.system() == "Darwin" and os.path.exists("/usr/bin/sandbox-exec")

# V3-F's MODE_TABLE rows for the two classes the confinement reads (electron/iclone-permissions/modes.ts).
TABLE = {
    "ignore": {"N": "A", "Wp": "A"},
    "manual": {"N": "Q", "Wp": "Q"},
    "automatic": {"N": "A", "Wp": "A"},
    "plan": {"N": "A:get", "Wp": "R!"},
    "acceptEdits": {"N": "Q", "Wp": "A"},
}


def _load(env: dict | None = None):
    for name in [n for n in sys.modules if n.startswith(PKG)]:
        del sys.modules[name]
    if "hermes_plugins" not in sys.modules:
        ns = types.ModuleType("hermes_plugins")
        ns.__path__ = []
        sys.modules["hermes_plugins"] = ns
    saved = {k: os.environ.get(k) for k in (env or {})}
    os.environ.update(env or {})
    try:
        spec = importlib.util.spec_from_file_location(PKG, PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)])
        mod = importlib.util.module_from_spec(spec)
        mod.__package__ = PKG
        sys.modules[PKG] = mod
        spec.loader.exec_module(mod)
        return mod
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _sub(mod, name: str):
    return importlib.import_module(f"{mod.__name__}.{name}")


class FakeCtx:
    def __init__(self):
        self.providers = []
        self.hooks = []

    def register_terminal_environment_provider(self, provider):
        self.providers.append(provider)

    def register_hook(self, name, fn):
        self.hooks.append((name, fn))


ACTIVE_ENV = {"ICLONE_CONFINEMENT": "1", "TERMINAL_ENV": "iclone_seatbelt", "ICLONE_CONFINEMENT_DIR": "/nonexistent"}


class TestRegistration:
    def test_inert_outside_icloneos(self, monkeypatch):
        monkeypatch.delenv("ICLONE_CONFINEMENT", raising=False)
        mod = _load()
        ctx = FakeCtx()
        mod.register(ctx)
        assert ctx.providers == [] and ctx.hooks == []

    def test_registers_both_backends_and_the_hook(self, monkeypatch):
        mod = _load(ACTIVE_ENV)
        monkeypatch.setattr(mod, "pin_terminal_backend", lambda: None)
        ctx = FakeCtx()
        mod.register(ctx)
        assert sorted(p.name for p in ctx.providers) == ["iclone_container", "iclone_seatbelt"]
        assert [name for name, _ in ctx.hooks] == ["pre_tool_call"]

    def test_names_are_not_builtin_backends(self):
        from agent.terminal_env_registry import BUILTIN_BACKEND_NAMES

        mod = _load(ACTIVE_ENV)
        providers = _sub(mod, "providers")
        assert {providers.SeatbeltProvider().name, providers.ContainerProvider().name}.isdisjoint(BUILTIN_BACKEND_NAMES)

    def test_pin_beats_a_stale_terminal_backend_local_in_config(self, monkeypatch):
        mod = _load(ACTIVE_ENV)
        from tools import terminal_tool

        def stale_bridge():
            os.environ["TERMINAL_ENV"] = "local"

        monkeypatch.setattr(terminal_tool, "_ensure_terminal_env_bridged", stale_bridge)
        monkeypatch.setenv("TERMINAL_ENV", "iclone_seatbelt")
        mod.pin_terminal_backend()
        assert os.environ["TERMINAL_ENV"] == "iclone_seatbelt"


class TestHook:
    def test_shell_tools_refused_when_the_backend_is_not_ours(self, monkeypatch):
        mod = _load(ACTIVE_ENV)
        monkeypatch.setenv("TERMINAL_ENV", "local")
        for tool in ("terminal", "process", "execute_code"):
            verdict = mod.on_pre_tool_call(tool_name=tool, args={"command": "ls"})
            assert verdict and verdict["action"] == "block" and "confinement" in verdict["message"]

    def test_shell_tools_pass_when_confined_and_other_tools_are_not_ours(self, monkeypatch):
        mod = _load(ACTIVE_ENV)
        monkeypatch.setenv("TERMINAL_ENV", "iclone_seatbelt")
        assert mod.on_pre_tool_call(tool_name="terminal") is None
        monkeypatch.setenv("TERMINAL_ENV", "local")
        assert mod.on_pre_tool_call(tool_name="read_file") is None

    def test_negative_control_without_the_lock_every_shell_call_is_refused(self, monkeypatch):
        mod = _load({**ACTIVE_ENV, "TERMINAL_ENV": ""})
        monkeypatch.setenv("TERMINAL_ENV", "")
        assert mod.on_pre_tool_call(tool_name="terminal")["action"] == "block"


class TestCore:
    def index(self, tmp_path, home):
        core = _sub(_load(ACTIVE_ENV), "core")
        return core, core.ProfileIndex({}, str(tmp_path / "scratch"), str(home), [str(home / ".ssh")], str(tmp_path / "members"))

    def test_project_root_rule_mirrors_typescript(self, tmp_path):
        home = tmp_path / "home"
        (home / "dev" / "app").mkdir(parents=True)
        core, index = self.index(tmp_path, home)
        assert core.acceptable_project_root(str(home / "dev" / "app"), index)
        for bad in ["/", str(tmp_path), str(home), str(home / "Library" / "x"), str(home / ".ssh"), "rel", None]:
            assert not core.acceptable_project_root(bad, index), bad

    def test_git_root(self, tmp_path):
        core = _sub(_load(ACTIVE_ENV), "core")
        (tmp_path / "repo" / ".git").mkdir(parents=True)
        (tmp_path / "repo" / "a" / "b").mkdir(parents=True)
        assert core.git_root(str(tmp_path / "repo" / "a" / "b")) == os.path.realpath(tmp_path / "repo")

    def test_marker_matches_typescript(self):
        core = _sub(_load(ACTIVE_ENV), "core")
        sha = "a" * 64
        assert core.marker("project", sha, "s-1") == f"iclone-confined:project:{sha[:12]}:s-1"
        assert core.marker("build", sha, "bad/../x") == f"iclone-confined:build:{sha[:12]}:-"

    @pytest.mark.parametrize("mode", [0o400, 0o600])
    def test_t1p_a_child_the_scan_cannot_stat_makes_its_directory_unscannable_not_gone(self, tmp_path, mode):
        core = _sub(_load(ACTIVE_ENV), "core")
        project = tmp_path / "proj"
        hidden = project / "hidden"
        (hidden / "sub").mkdir(parents=True)
        (tmp_path / "outside.txt").write_text("outside-secret\n")
        os.link(tmp_path / "outside.txt", hidden / "x")
        hidden.chmod(mode)
        try:
            # The premise: it lists (r), its children do not stat (no x): the link count is invisible.
            assert sorted(os.listdir(hidden)) == ["sub", "x"]
            with pytest.raises(PermissionError):
                os.lstat(hidden / "x")
            linked, cached, unscannable = core.linked_inodes(str(project))
            assert (linked, cached, unscannable) == ([], False, [str(hidden), str(hidden / "sub")])
            assert core.linked_inodes(str(project))[1:] == (True, [str(hidden), str(hidden / "sub")])
        finally:
            hidden.chmod(0o755)
        linked, cached, unscannable = core.linked_inodes(str(project))
        assert cached is False and unscannable == [] and [i["paths"] for i in linked] == [[str(hidden / "x")]]

    def _store_world(self, tmp_path, count=200, store_files=300):
        """T2'': a pnpm store under the fixture's ``Library/pnpm`` and a project linked into it."""
        core = _sub(_load(ACTIVE_ENV), "core")
        store_root = tmp_path / "Library" / "pnpm"
        files = store_root / "store" / "v3" / "files"
        files.mkdir(parents=True)
        for i in range(store_files):
            (files / f"h{i}").write_text(f"blob {i}\n")
        project = tmp_path / "proj"
        for i in range(count):
            pkg = project / "node_modules" / ".pnpm" / f"pkg{i}"
            pkg.mkdir(parents=True)
            os.link(files / f"h{i}", pkg / "index.js")
        (tmp_path / "outside.txt").write_text("outside-secret\n")
        index = core.ProfileIndex({}, str(tmp_path / "scratch"), str(tmp_path / "home"), [], str(tmp_path / "members"),
                                  pnpm_store_roots=(str(store_root),))
        return core, index, project, files, store_root

    def test_t2pp_the_spec_names_the_store_roots_absolute_only_and_from_v5_on(self):
        core = _sub(_load(ACTIVE_ENV), "core")
        base = {"v": 5, "profilesDir": "/p", "scratchRoot": "/s", "home": "/h", "membersDir": "/m", "sha256": {}}
        assert core.parse_spec(json.dumps(base)).pnpm_store_roots == ()
        spec = json.dumps({**base, "pnpmStoreRoots": ["/h/Library/pnpm", "relative/pnpm", "/opt/pnpm"]})
        assert core.parse_spec(spec).pnpm_store_roots == ("/h/Library/pnpm", "/opt/pnpm")
        # r5: an older main's roots were not sieved for denied directories; they are ignored (gesture path).
        for older in (4, 3, "4", None):
            spec = json.dumps({**base, "v": older, "pnpmStoreRoots": ["/h/Library/pnpm"]})
            assert core.parse_spec(spec).pnpm_store_roots == (), older
        assert core.parse_spec(json.dumps({**base, "v": 6, "pnpmStoreRoots": ["/h/Library/pnpm"]})).pnpm_store_roots == ("/h/Library/pnpm",)

    def test_t2pp_r5_store_shaped_and_a_denied_root_passes_nothing(self, tmp_path):
        core = _sub(_load(ACTIVE_ENV), "core")
        shaped = tmp_path / "shaped"
        (shaped / "store" / "v10").mkdir(parents=True)
        bare = tmp_path / "bare"
        bare.mkdir()
        (bare / "id_ed25519").write_text("not a key\n")
        wrong = tmp_path / "wrong"
        (wrong / "store" / "vx").mkdir(parents=True)
        (wrong / "store" / "v3").write_text("a file\n")
        linked_store = tmp_path / "linked-store"
        linked_store.mkdir()
        os.symlink(shaped / "store", linked_store / "store")
        linked_version = tmp_path / "linked-version"
        (linked_version / "store").mkdir(parents=True)
        os.symlink(shaped / "store" / "v10", linked_version / "store" / "v10")
        assert core.store_shaped(str(shaped)) and core.store_shaped(str(shaped / "store" / "v10"))
        assert core.store_shaped("/Volumes/x/pnpm/store/v3")
        for no in (bare, wrong, linked_store, linked_version, tmp_path / "never", shaped / "store"):
            assert not core.store_shaped(str(no)), no
        # Both ways: a real root without the layout passes nothing; with it, the same link passes.
        project = tmp_path / "proj"
        (project / "node_modules").mkdir(parents=True)
        (bare / "blob").write_text("blob\n")
        os.link(bare / "blob", project / "node_modules" / "blob.js")
        args = ({}, str(tmp_path / "scratch"), str(tmp_path / "home"))
        index = core.ProfileIndex(*args, [], str(tmp_path / "members"), pnpm_store_roots=(str(bare),))
        assert core._open_block(index, str(project), "build") == {
            "kind": "hard-links", "paths": [str(project / "node_modules" / "blob.js")], "count": 1}
        (bare / "store" / "v3").mkdir(parents=True)
        core._scan_cache.clear()
        assert core._open_block(index, str(project), "build") is None
        # A root inside a denied directory, or holding one, is no store even with the layout.
        for denied in ([str(bare)], [str(tmp_path)], [str(bare / "store")]):
            core._scan_cache.clear()
            sieved = core.ProfileIndex(*args, denied, str(tmp_path / "members"), pnpm_store_roots=(str(bare),))
            assert core._open_block(sieved, str(project), "build")["count"] == 1, denied

    def test_t2pp_a_pnpm_fixture_passes_in_build_only_and_only_what_resolves_into_the_store(self, tmp_path):
        core, index, project, files, store_root = self._store_world(tmp_path)
        assert core._open_block(index, str(project), "build") is None
        for cls in ("project", "offline", "research", "media", None):
            block = core._open_block(index, str(project), cls)
            assert block is not None and block["kind"] == "hard-links" and block["count"] == 200, cls
        # A link into a non-store root is a gesture in build too, named alone.
        planted = project / "node_modules" / ".pnpm" / "pkg0" / "secret.js"
        os.link(tmp_path / "outside.txt", planted)
        block = core._open_block(index, str(project), "build")
        assert block == {"kind": "hard-links", "paths": [str(planted)], "count": 1}
        assert core._open_block(index, str(project), "project")["count"] == 201

    def test_t2pp_a_third_name_outside_the_store_still_asks_every_name_must_be_accounted_for(self, tmp_path):
        core, index, project, files, _store_root = self._store_world(tmp_path)
        # h1: 1 name in the project + 1 in the store = 2 of nlink 3.
        os.link(files / "h1", tmp_path / "h1-elsewhere")
        block = core._open_block(index, str(project), "build")
        assert block == {"kind": "hard-links", "paths": [str(project / "node_modules" / ".pnpm" / "pkg1" / "index.js")], "count": 1}
        assert core._open_block(index, str(project), "project")["count"] == 200

    def test_t2pp_past_the_budget_or_without_store_roots_nothing_passes(self, tmp_path):
        core, index, project, _files, store_root = self._store_world(tmp_path)
        linked, _, _ = core.linked_inodes(str(project))
        passed, walked, seconds, timed_out = core.resolve_in_store((str(store_root),), linked, 1.0)
        assert (len(passed), walked, timed_out) == (200, 300, False) and seconds < 1.0
        passed, _walked, _seconds, timed_out = core.resolve_in_store((str(store_root),), linked, 0.0)
        assert (len(passed), timed_out) == (0, True)
        bare = core.ProfileIndex({}, index.scratch_root, index.home, [], index.members_dir)
        assert core._open_block(bare, str(project), "build")["count"] == 200
        store_root.chmod(0o000)
        try:
            assert core.resolve_in_store((str(store_root),), linked, 1.0)[0] == frozenset()
        finally:
            store_root.chmod(0o755)

    def test_t2pp_r5_a_symlinked_store_root_is_not_the_store_the_same_inode_asks(self, tmp_path):
        import shutil

        core, index, project, files, store_root = self._store_world(tmp_path, count=0)
        outside = tmp_path / "outside"
        outside.mkdir()
        (outside / "secret").write_text("outside-secret\n")
        planted = project / "node_modules" / ".pnpm" / "evil" / "index.js"
        planted.parent.mkdir(parents=True)
        # Control: the secret moved INTO the real store is store content (store name + project name = nlink 2): passes.
        shutil.move(outside / "secret", files / "secret")
        os.link(files / "secret", planted)
        assert core.real_store_root(str(store_root))
        assert core._open_block(index, str(project), "build") is None
        # The attack: the root itself is a symlink to where the secret lives; os.scandir follows it.
        shutil.move(files / "secret", outside / "secret")
        shutil.rmtree(store_root)
        os.symlink(outside, store_root)
        # The store's shape is one more mkdir for the same writer: it is not the boundary, the real root is.
        (outside / "store" / "v3").mkdir(parents=True)
        assert sorted(e.name for e in os.scandir(store_root)) == ["secret", "store"]
        assert not core.real_store_root(str(store_root))
        core._scan_cache.clear()
        linked, _, _ = core.linked_inodes(str(project))
        passed, walked, _seconds, timed_out = core.resolve_in_store((str(store_root),), linked, 1.0)
        assert (passed, walked, timed_out) == (frozenset(), 0, False)
        assert core._open_block(index, str(project), "build") == {"kind": "hard-links", "paths": [str(planted)], "count": 1}

    def test_t2pp_r5_a_root_under_a_symlinked_ancestor_is_not_the_store_and_a_symlinked_dir_inside_one_is_not_entered(self, tmp_path):
        core = _sub(_load(ACTIVE_ENV), "core")
        real = tmp_path / "real" / "pnpm"
        files = real / "store" / "v3" / "files"
        files.mkdir(parents=True)
        os.symlink(tmp_path / "real", tmp_path / "link")
        via_link = tmp_path / "link" / "pnpm"
        (files / "blob").write_text("blob\n")
        project = tmp_path / "proj"
        (project / "node_modules").mkdir(parents=True)
        os.link(files / "blob", project / "node_modules" / "blob.js")
        # lstat sees a real directory through the ancestor; realpath does not.
        assert stat.S_ISDIR(os.lstat(via_link).st_mode) and not core.real_store_root(str(via_link))
        assert core.real_store_root(str(real))
        args = ({}, str(tmp_path / "scratch"), str(tmp_path / "home"), [], str(tmp_path / "members"))
        assert core._open_block(core.ProfileIndex(*args, pnpm_store_roots=(str(via_link),)), str(project), "build") == {
            "kind": "hard-links", "paths": [str(project / "node_modules" / "blob.js")], "count": 1}
        core._scan_cache.clear()
        assert core._open_block(core.ProfileIndex(*args, pnpm_store_roots=(str(real),)), str(project), "build") is None
        # A symlinked directory inside the real store is not entered: a link to what it points at still asks.
        outside = tmp_path / "outside"
        outside.mkdir()
        (outside / "secret").write_text("outside-secret\n")
        os.symlink(outside, files / "elsewhere")
        planted = project / "node_modules" / "secret.js"
        os.link(outside / "secret", planted)
        core._scan_cache.clear()
        linked, _, _ = core.linked_inodes(str(project))
        passed, walked, _seconds, _timed_out = core.resolve_in_store((str(real),), linked, 1.0)
        assert (len(passed), walked) == (1, 1)
        assert core._open_block(core.ProfileIndex(*args, pnpm_store_roots=(str(real),)), str(project), "build") == {
            "kind": "hard-links", "paths": [str(planted)], "count": 1}

    # --- r6 MAJOR-1‴: the names of an inode are a set (project ∪ store), never a sum ---------------------------------

    def _secret_in_store(self, tmp_path):
        """A fake home with the agent's secret, the pnpm store at ``Library/pnpm`` and the secret hard-linked into it."""
        core = _sub(_load(ACTIVE_ENV), "core")
        home = Path(os.path.realpath(tmp_path)) / "home"
        env = home / ".hermes" / ".env"
        store_root = home / "Library" / "pnpm"
        files = store_root / "store" / "v3" / "files"
        env.parent.mkdir(parents=True)
        files.mkdir(parents=True)
        env.write_text("OPENAI_API_KEY=sk-not-real\n")
        (files / "legit").write_text("blob\n")
        os.link(env, files / "evil-blob")
        core._scan_cache.clear()
        return core, home, env, store_root, files

    def _index(self, core, home, roots, denied=()):
        return core.ProfileIndex({}, str(home / "scratch"), str(home), [str(d) for d in denied], str(home / "members"),
                                 pnpm_store_roots=tuple(str(r) for r in roots))

    def test_r6_the_critics_d3_the_project_is_the_store_root_the_secret_linked_into_it_asks_in_every_class(self, tmp_path):
        core, home, env, store_root, files = self._secret_in_store(tmp_path)
        index = self._index(core, home, [store_root])
        assert os.lstat(env).st_nlink == 2
        for project in (store_root, store_root / "store" / "v3"):
            for cls in ("build", "project", "offline", "research", "media"):
                assert core._open_block(index, str(project), cls) == {
                    "kind": "hard-links", "paths": [str(files / "evil-blob")], "count": 1}, (project, cls)

    def test_r6_the_critics_d4_the_project_holds_the_store_build_asks(self, tmp_path):
        core, home, env, _store_root, library_files = self._secret_in_store(tmp_path)
        share = home / ".local" / "share"
        files = share / "pnpm" / "store" / "v3" / "files"
        files.mkdir(parents=True)
        # Only this store holds the secret: its own name and the store's, nlink 2 (the sum counted the store name twice).
        os.unlink(library_files / "evil-blob")
        os.link(env, files / "evil-blob")
        assert os.lstat(env).st_nlink == 2
        index = self._index(core, home, [share / "pnpm"])
        assert core._open_block(index, str(share), "build") == {
            "kind": "hard-links", "paths": [str(files / "evil-blob")], "count": 1}

    def test_r6_the_critics_d1b_nested_roots_and_one_project_link_to_a_secret_in_the_store_build_asks(self, tmp_path):
        core, home, env, store_root, files = self._secret_in_store(tmp_path)
        project = home / "proj"
        (project / "node_modules").mkdir(parents=True)
        os.link(files / "evil-blob", project / "node_modules" / "evil.js")
        os.link(files / "legit", project / "node_modules" / "legit.js")
        assert os.lstat(env).st_nlink == 3
        # The roots main hands over for $PNPM_HOME=…/Library/pnpm/store/v3: nested.
        index = self._index(core, home, [store_root, home / ".local" / "share" / "pnpm", store_root / "store" / "v3"])
        assert core._open_block(index, str(project), "build") == {
            "kind": "hard-links", "paths": [str(project / "node_modules" / "evil.js")], "count": 1}
        linked, _, _ = core.linked_inodes(str(project))
        passed, walked, _seconds, timed_out = core.resolve_in_store(index.pnpm_store_roots, linked, 1.0)
        assert (len(passed), walked, timed_out) == (1, 2, False)

    def test_r6_the_same_names_by_every_spelling_count_once(self, tmp_path):
        core, home, _env, store_root, files = self._secret_in_store(tmp_path)
        project = home / "proj"
        project.mkdir()
        os.link(files / "evil-blob", project / "evil.js")
        os.link(files / "legit", project / "legit.js")
        linked, _, _ = core.linked_inodes(str(project))
        spellings = [(store_root,), (store_root, store_root), (store_root, store_root / "store" / "v3", files)]
        alias = Path("/System/Volumes/Data" + str(store_root))
        if alias.exists():
            spellings.append((store_root, alias))
        for roots in spellings:
            passed, walked, _seconds, _timed_out = core.resolve_in_store(tuple(str(r) for r in roots), linked, 1.0)
            assert (len(passed), walked) == (1, 2), roots

    def test_r6_a_store_root_or_a_folder_inside_one_is_no_project(self, tmp_path):
        core, home, _env, store_root, _files = self._secret_in_store(tmp_path)
        share = home / ".local" / "share" / "pnpm"
        (share / "store" / "v3" / "pkg").mkdir(parents=True)
        (home / "proj").mkdir()
        index = self._index(core, home, [store_root, share], denied=[home / ".ssh"])
        assert core.acceptable_project_root(str(home / "proj"), index)
        assert not core.acceptable_project_root(str(share), index)
        assert not core.acceptable_project_root(str(share / "store" / "v3" / "pkg"), index)
        # Without the roots (an older spec) the store folder was a project: the roots are what refuse it.
        assert core.acceptable_project_root(str(share), self._index(core, home, []))
        alias = "/System/Volumes/Data" + str(share)
        if os.path.exists(alias):
            assert not core.acceptable_project_root(alias, index)

    def test_r6_info1_a_store_root_naming_an_alias_of_a_denied_folder_passes_nothing(self, tmp_path):
        core, home, _env, _store_root, _files = self._secret_in_store(tmp_path)
        hermes = home / ".hermes"
        (hermes / "store" / "v3").mkdir(parents=True)
        (hermes / "auth.json").write_text('{"token": "not-real"}\n')
        project = home / "proj"
        project.mkdir()
        os.link(hermes / "auth.json", project / "env.js")
        aliases = [a for a in ("/System/Volumes/Data" + str(hermes), str(home / ".HERMES")) if os.path.exists(a)]
        if platform.system() == "Darwin":
            assert "/System/Volumes/Data" + str(hermes) in aliases
        for alias in aliases:
            core._scan_cache.clear()
            # Unsieved, the alias with the store's shape passes the secret (its own name + the project's = nlink 2).
            assert core._open_block(self._index(core, home, [alias]), str(project), "build") is None, alias
            core._scan_cache.clear()
            assert core._open_block(self._index(core, home, [alias], denied=[hermes]), str(project), "build") == {
                "kind": "hard-links", "paths": [str(project / "env.js")], "count": 1}, alias

    def test_a_missing_or_malformed_spec_refuses(self):
        core = _sub(_load(ACTIVE_ENV), "core")
        for raw in ["", "{", "[]", json.dumps({"profilesDir": "/p"}),
                    json.dumps({"profilesDir": "/p", "scratchRoot": "rel", "home": "/h", "membersDir": "/m"})]:
            with pytest.raises(core.ConfinementRefused):
                core.parse_spec(raw)

    def test_f2_the_spec_is_popped_at_import_so_no_child_inherits_it(self, monkeypatch):
        monkeypatch.setenv("ICLONE_CONFINEMENT_SPEC", json.dumps({"x": 1}))
        monkeypatch.setenv("ICLONE_CONFINEMENT_ACK", "/tmp/ack.json")
        mod = _load(ACTIVE_ENV)
        assert "ICLONE_CONFINEMENT_SPEC" not in os.environ and "ICLONE_CONFINEMENT_ACK" not in os.environ
        assert mod.ACK_FILE == "/tmp/ack.json"
        assert _sub(mod, "core")._trusted_spec == json.dumps({"x": 1})

    def test_f7_the_link_key_is_popped_at_import_so_no_child_inherits_it(self, monkeypatch):
        monkeypatch.setenv("ICLONE_CONFINEMENT_LINK_KEY", "ab" * 32)
        mod = _load(ACTIVE_ENV)
        assert "ICLONE_CONFINEMENT_LINK_KEY" not in os.environ
        assert _sub(mod, "core")._link_key == bytes.fromhex("ab" * 32)

    def test_f5_register_acknowledges_with_its_pid(self, tmp_path, monkeypatch):
        ack = tmp_path / "run" / "hermes-ack.json"
        monkeypatch.setenv("ICLONE_CONFINEMENT_ACK", str(ack))
        mod = _load(ACTIVE_ENV)
        mod.register(FakeCtx())
        assert json.loads(ack.read_text()) == {"pid": os.getpid(), "backend": "iclone_seatbelt"}
        assert ack.stat().st_mode & 0o777 == 0o600

    def test_f5_an_inert_plugin_acknowledges_nothing(self, tmp_path, monkeypatch):
        ack = tmp_path / "hermes-ack.json"
        monkeypatch.delenv("ICLONE_CONFINEMENT", raising=False)
        monkeypatch.setenv("ICLONE_CONFINEMENT_ACK", str(ack))
        _load().register(FakeCtx())
        assert not ack.exists()


class _Policy:
    def __init__(self, body):
        self._body = body

    def body(self):
        return self._body


def _install_v3f(monkeypatch, body):
    """V3-F's real ``policy.decide`` under a fake plugin module carrying ``_state['policy']``."""
    name = "hermes_plugins.iclone_permissions"
    spec = importlib.util.spec_from_file_location(f"{name}.policy", ROOT / "plugins" / "iclone-permissions" / "policy.py")
    policy = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, f"{name}.policy", policy)
    spec.loader.exec_module(policy)
    fake = types.ModuleType(name)
    fake._state = {"policy": _Policy(body)}
    monkeypatch.setitem(sys.modules, name, fake)
    monkeypatch.setitem(sys.modules, f"{name}.policy", policy)


def _body(standing, grants=(), ceilings=None):
    full = {mode: {**{c: "Q" for c in ["R", "Wo", "X", "$", "M", "S", "I", "D"]}, **row} for mode, row in TABLE.items()}
    return {"v": 1, "standing": standing, "projects": {}, "sessions": {}, "table": full,
            "ceilings": ceilings or {"webBrowsing": "on", "fileWriting": "on"},
            "ceilingKey": {"N": "webBrowsing", "Wp": "fileWriting"}, "grants": list(grants)}


class TestGrantParams:
    @pytest.mark.parametrize("mode,net,write", [
        ("ignore", "1", "1"),       # Ignore keeps confinement on (owner D2): only the asks are skipped
        ("automatic", "1", "1"),
        ("manual", "0", "1"),       # an ask never opens the network mid-command
        ("acceptEdits", "0", "1"),
        ("plan", "0", "0"),         # read-only
    ])
    def test_each_mode(self, monkeypatch, mode, net, write):
        core = _sub(_load(ACTIVE_ENV), "core")
        _install_v3f(monkeypatch, _body(mode))
        assert core.grant_params("s1", "/p") == {"NET": net, "WRITE_PROJECT": write}

    def test_a_live_network_grant_opens_it_in_manual(self, monkeypatch):
        core = _sub(_load(ACTIVE_ENV), "core")
        _install_v3f(monkeypatch, _body("manual", grants=[{"cls": "N", "id": "g1", "scope": "session", "sessionId": "s1", "project": None}]))
        assert core.grant_params("s1", "/p")["NET"] == "1"
        assert core.grant_params("other", "/p")["NET"] == "0"

    def test_the_switch_off_closes_it_even_in_ignore(self, monkeypatch):
        core = _sub(_load(ACTIVE_ENV), "core")
        _install_v3f(monkeypatch, _body("ignore", ceilings={"webBrowsing": "off", "fileWriting": "off"}))
        assert core.grant_params("s1", "/p") == {"NET": "0", "WRITE_PROJECT": "0"}

    def test_without_v3f_no_network(self, monkeypatch):
        core = _sub(_load(ACTIVE_ENV), "core")
        for name in [n for n in sys.modules if n.endswith("iclone_permissions")]:
            monkeypatch.delitem(sys.modules, name)
        assert core.grant_params("s1", "/p") == {"NET": "0", "WRITE_PROJECT": "1"}


CONTAINER_DETECT = json.loads((PLUGIN_DIR / "tests" / "fixtures" / "container_detect.json").read_text())


def _bytes(latin1: str) -> bytes:
    """G3 r2 m-1: the fixture's raw bytes, one character per byte (latin-1), never decoded text."""
    assert all(ord(char) <= 0xFF for char in latin1), f"not one byte per character: {latin1!r}"
    return latin1.encode("latin-1")


def _container_host(providers, case, calls=None):
    """The fixture case as the plugin's detection host (the app's probe.test.ts builds the same one)."""
    answer = case["answer"]

    def run(binary, timeout_ms):
        if calls is not None:
            calls.append((binary, timeout_ms))
        return providers.RunAnswer(code=answer["code"], stdout=_bytes(answer["stdoutBytes"]),
                                   stderr=_bytes(answer["stderrBytes"]), timed_out=answer["timedOut"],
                                   error=answer["error"])

    return providers.ContainerHost(exists=lambda p: p in case["present"], executable=lambda p: p in case["executable"],
                                   run=run, platform=case["host"]["platform"], arch=case["host"]["arch"],
                                   darwin_major=case["host"]["darwinMajor"])


def _verdict(name):
    return next(case for case in CONTAINER_DETECT["verdicts"] if case["name"] == name)


class TestContainer:
    def test_refuses_with_the_owner_step(self, monkeypatch):
        providers = _sub(_load(ACTIVE_ENV), "providers")
        detection = providers.detect_container(_container_host(providers, _verdict("not installed")))
        monkeypatch.setattr(providers, "container_detection", lambda: detection)
        provider = providers.ContainerProvider()
        assert provider.is_available() is False
        status, detail = provider.probe()
        assert status == "needs_setup" and "owner step" in detail and "container-1.5.0-installer-signed.pkg" in detail
        from tools.environments.base import EnvironmentConnectionError

        with pytest.raises(EnvironmentConnectionError) as refused:
            provider.create_environment(cwd="/", timeout=5)
        assert "not available in this version of icloneOS: not installed on this Mac" in str(refused.value)

    def test_k131_installed_is_refused_as_not_used_never_as_not_installed(self, monkeypatch):
        providers = _sub(_load(ACTIVE_ENV), "providers")
        detection = providers.detect_container(_container_host(providers, _verdict("good: the CLI's own answer")))
        monkeypatch.setattr(providers, "container_detection", lambda: detection)
        provider = providers.ContainerProvider()
        assert provider.is_available() is False
        status, detail = provider.probe()
        assert status == "unavailable" and "does not use it" in detail and "1.5.0" in detail
        assert "not installed" not in detail and "owner step" not in detail
        from tools.environments.base import EnvironmentConnectionError

        with pytest.raises(EnvironmentConnectionError) as refused:
            provider.create_environment(cwd="/", timeout=5)
        message = str(refused.value)
        assert message == ("Refused by icloneOS confinement: Apple container is not available in this version of "
                           "icloneOS: installed (1.5.0) but not used. The command is refused rather than run unconfined.")

    def test_g3_probe_and_refusal_read_one_detection(self, monkeypatch):
        """The picker's probe and the spawn refusal come from the same detection (one TTL cache), never two answers."""
        providers = _sub(_load(ACTIVE_ENV), "providers")
        cases = iter([_verdict("good: the CLI's own answer"), _verdict("non-zero exit, even with a good-looking answer")])
        detections = []
        real = providers.detect_container

        def detect(host=None):
            detections.append(real(_container_host(providers, next(cases))))
            return detections[-1]

        monkeypatch.setattr(providers, "detect_container", detect)
        clock = [100.0]
        monkeypatch.setattr(providers.time, "monotonic", lambda: clock[0])
        provider = providers.ContainerProvider()
        from tools.environments.base import EnvironmentConnectionError

        assert "1.5.0" in provider.probe()[1]
        with pytest.raises(EnvironmentConnectionError) as refused:
            provider.create_environment(cwd="/", timeout=5)
        assert "installed (1.5.0) but not used" in str(refused.value) and len(detections) == 1
        clock[0] += providers.CONTAINER_DETECT_TTL_S
        assert "did not answer a version check" in provider.probe()[1]
        with pytest.raises(EnvironmentConnectionError) as refused:
            provider.create_environment(cwd="/", timeout=5)
        assert "installed, but its check failed" in str(refused.value) and len(detections) == 2


    def test_g3r2_overlapping_callers_share_one_detection(self, monkeypatch):
        """G3 r2 m-3: callers that overlap (the picker and a spawn on two threads) wait for the one detection running
        and read its answer: one --version per TTL window, and an older answer never lands over a newer one."""
        import threading

        providers = _sub(_load(ACTIVE_ENV), "providers")
        providers._detected.clear()
        started = []
        release = threading.Event()

        def detect(host=None):
            started.append(threading.get_ident())
            release.wait(5)
            return providers.ContainerDetection("installed", "not-wired", f"1.5.{len(started)}", "/usr/local/bin/container", "")

        monkeypatch.setattr(providers, "detect_container", detect)
        seen = []
        callers = [threading.Thread(target=lambda: seen.append(providers.container_detection())) for _ in range(4)]
        for caller in callers:
            caller.start()
        time.sleep(0.2)
        release.set()
        for caller in callers:
            caller.join(5)
        assert len(started) == 1
        assert [d.version for d in seen] == ["1.5.1"] * 4


class TestContainerDetectionK133:
    """The plugin and the app agree on "installed": the same fixed paths, never PATH (fixture shared with probe.test.ts)."""

    def test_candidates_are_the_fixture_list(self):
        providers = _sub(_load(ACTIVE_ENV), "providers")
        assert list(providers.CONTAINER_CANDIDATES) == CONTAINER_DETECT["candidates"]
        assert all(os.path.isabs(c) for c in CONTAINER_DETECT["candidates"])
        assert len(CONTAINER_DETECT["cases"]) >= 6

    @pytest.mark.parametrize("case", CONTAINER_DETECT["cases"], ids=lambda c: c["name"])
    def test_case(self, monkeypatch, case):
        import shutil

        providers = _sub(_load(ACTIVE_ENV), "providers")
        present = set(case["present"])
        monkeypatch.setattr(providers.os.path, "exists", lambda p: p in present)
        monkeypatch.setattr(shutil, "which", lambda name, *a, **k: case["onPath"] if name == "container" else None)
        assert providers.container_binary() == case["installed"]
        good = {**_verdict("good: the CLI's own answer"), "present": case["present"], "executable": case["present"]}
        detection = providers.detect_container(_container_host(providers, good))
        assert detection.binary == case["installed"]
        assert detection.status == ("installed" if case["installed"] else "not-installed")
        monkeypatch.setattr(providers, "container_detection", lambda: detection)
        status, _ = providers.ContainerProvider().probe()
        assert status == ("unavailable" if case["installed"] else "needs_setup")


class TestContainerVerdictG3:
    """G3-1: the same verdict as the app's probeContainer for every version-answer case of the shared fixture."""

    def test_the_rule_is_the_fixture_rule(self):
        providers = _sub(_load(ACTIVE_ENV), "providers")
        assert providers.CONTAINER_VERSION_RE.pattern == CONTAINER_DETECT["versionPattern"]
        assert providers.CONTAINER_VERSION_TIMEOUT_MS == CONTAINER_DETECT["versionTimeoutMs"]
        assert providers.CONTAINER_MIN_DARWIN_MAJOR == CONTAINER_DETECT["platform"]["minDarwinMajor"]
        assert len(CONTAINER_DETECT["verdicts"]) >= 12

    def test_the_fixture_covers_every_kind_of_answer(self):
        cases = CONTAINER_DETECT["verdicts"]
        kinds = {
            "installed": lambda v: v["expect"]["status"] == "installed",
            "not executable": lambda v: v["present"] and not v["executable"],
            "garbage / wrong tool": lambda v: v["answer"]["code"] == 0 and v["executable"] and v["expect"]["status"] == "broken",
            "non-zero exit": lambda v: v["answer"]["code"] not in (None, 0),
            "timeout": lambda v: v["answer"]["timedOut"] and v["expect"]["status"] == "unknown",
            # an exec error proper: not the overflow stop (G3 r2 m-4: that case alone must not satisfy this kind)
            "exec error": lambda v: v["answer"]["error"] not in (None, CONTAINER_DETECT["output"]["overflowError"])
            and not v["answer"]["timedOut"],
            "Intel": lambda v: v["host"]["arch"] != "arm64",
            "before macOS 26": lambda v: v["host"]["platform"] == "darwin" and v["host"]["darwinMajor"] < 25,
            "not installed": lambda v: v["expect"]["status"] == "not-installed",
            # G3 r2 m-1: the byte-level edges the two sides once split on.
            "non-UTF-8 after a good line": lambda v: any(c >= 0x80 for c in _bytes(v["answer"]["stdoutBytes"]))
            and v["expect"]["status"] == "installed",
            "non-ASCII, broken": lambda v: any(c >= 0x80 for c in _bytes(v["answer"]["stdoutBytes"]))
            and v["expect"]["status"] == "broken",
            "trailing \\x1c": lambda v: "\x1c" in v["answer"]["stdoutBytes"],
            "leading blank line": lambda v: v["answer"]["stdoutBytes"].startswith("\n") and v["expect"]["status"] == "installed",
            "over the bound": lambda v: v["answer"]["error"] == CONTAINER_DETECT["output"]["overflowError"]
            and v["expect"]["status"] == "broken",
        }
        assert [name for name, kind in kinds.items() if not any(kind(v) for v in cases)] == []

    @pytest.mark.parametrize("case", CONTAINER_DETECT["verdicts"], ids=lambda c: c["name"])
    def test_verdict(self, case):
        providers = _sub(_load(ACTIVE_ENV), "providers")
        calls = []
        detection = providers.detect_container(_container_host(providers, case, calls))
        expect = case["expect"]
        assert (detection.status, detection.detail, detection.version) == (expect["status"], expect["detail"], expect["version"])
        assert providers.container_refusal(detection) == (
            f"Apple container is not available in this version of icloneOS: {expect['seen']}. "
            "The command is refused rather than run unconfined.")
        # Runs `--version` only on a supported Mac, on an executable fixed path, with the shared timeout.
        assert calls == ([(detection.binary, CONTAINER_DETECT["versionTimeoutMs"])] if expect["runs"] else [])
        status, detail = providers.container_probe(detection)
        assert status == ("needs_setup" if expect["status"] == "not-installed" else "unavailable")
        if expect["status"] == "installed":
            assert "does not use it" in detail and expect["version"] in detail
        else:
            assert "does not use it" not in detail
        # G3-2: "looks broken" only for a definite failure; a timeout says it could not be checked.
        assert ("looks broken" in detail) == (expect["status"] == "broken")
        assert ("could not be checked" in detail) == (expect["status"] == "unknown")
        # G3 r2 m-1: the stub runner hands over the fixture's RAW BYTES; the text read from them is the fixture's.
        if "read" in case:
            assert detection.evidence.endswith(f": {case['read']}"), detection.evidence

    def test_default_host_reads_this_machine(self):
        providers = _sub(_load(ACTIVE_ENV), "providers")
        host = providers.ContainerHost()
        assert host.platform == sys.platform
        assert host.arch == {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine(), platform.machine())
        assert isinstance(host.darwin_major, int)
        if sys.platform == "darwin":
            assert host.darwin_major == int(platform.release().split(".")[0])

    def test_real_runner_timeout_and_exec_errors(self, tmp_path):
        """The default runner, on real files: a hang is a timeout, a non-program is an exec error, never an exception."""
        providers = _sub(_load(ACTIVE_ENV), "providers")
        hang = tmp_path / "hang"
        hang.write_text("#!/bin/sh\nsleep 5\n")
        hang.chmod(0o755)
        answer = providers._run_version(str(hang), 200)
        assert answer.timed_out is True and answer.code is None
        junk = tmp_path / "junk"
        junk.write_bytes(b"\x00\x01not a program")
        junk.chmod(0o755)
        answer = providers._run_version(str(junk), 2000)
        assert answer.code is None and answer.error and answer.timed_out is False
        good = tmp_path / "container"
        good.write_text("#!/bin/sh\necho 'container CLI version 1.5.0 (build: release)'\n")
        good.chmod(0o755)
        answer = providers._run_version(str(good), 2000)
        assert answer.code == 0 and providers.CONTAINER_VERSION_RE.match(providers._answer_text(answer.stdout)).group(1) == "1.5.0"


    def test_bytes_are_read_with_the_fixture_rule(self):
        """G3 r2 m-1: the bound, the strip set and the overflow error are the fixture's; decoding never raises."""
        providers = _sub(_load(ACTIVE_ENV), "providers")
        output = CONTAINER_DETECT["output"]
        assert providers.CHECK_OUTPUT_MAX_BYTES == output["maxBytes"]
        assert providers.CHECK_OUTPUT_STRIP == output["strip"]
        assert providers.CONTAINER_VERSION_RE.flags & re.ASCII
        assert len(CONTAINER_DETECT["programs"]) >= 15
        lengths = {p.get("stdoutLength") for p in CONTAINER_DETECT["programs"]}
        assert {output["maxBytes"], output["maxBytes"] + 1} <= lengths  # G3 r3 m-2: the exact-boundary pair stays
        assert providers._answer_text(b"\n \t container\r\n") == "container"
        assert providers._answer_text(b"\xff\xfe") == "\ufffd\ufffd"
        assert providers._answer_text(b"x\x1c") == "x\x1c"
        assert providers._answer_text(b"\xef\xbb\xbfx") == "\ufeffx"
        assert providers._answer_text(b"x\xc2\xa0") == "x\u00a0"

    def test_programs_keep_the_two_edges_mutations_once_survived(self):
        """G3 r2 m-4: a kill that is not the timeout, and a good answer after leading blank space, stay shared cases."""
        def body(program):
            return next(iter(program["files"].values()), {"bytes": ""})["bytes"]

        programs = CONTAINER_DETECT["programs"]
        assert any(re.search(r"kill -(KILL|TERM) \$\$", body(p)) and p["expect"]["status"] == "broken" for p in programs)
        assert any('printf "\\n  container' in body(p) and p["expect"]["status"] == "installed" for p in programs)

    @pytest.mark.parametrize("program", CONTAINER_DETECT["programs"], ids=lambda c: c["name"])
    def test_program_through_the_real_runner(self, tmp_path, program):
        """Real files, the REAL runner (spawn, bound, decode): the app's probe.test.ts runs the same programs."""
        providers = _sub(_load(ACTIVE_ENV), "providers")
        to = {c: str(tmp_path / str(i) / "ctr") for i, c in enumerate(providers.CONTAINER_CANDIDATES)}
        for candidate, file in program["files"].items():
            os.makedirs(os.path.dirname(to[candidate]), exist_ok=True)
            Path(to[candidate]).write_bytes(_bytes(file["bytes"]))
            os.chmod(to[candidate], file["mode"])
        host = providers.ContainerHost(exists=lambda p: os.path.exists(to[p]), executable=lambda p: os.access(to[p], os.X_OK),
                                       run=lambda binary, ms: providers._run_version(to[binary], ms),
                                       platform="darwin", arch="arm64", darwin_major=25)
        detection = providers.detect_container(host)
        assert {"status": detection.status, "version": detection.version} == program["expect"]
        # G3 r3 m-2: the bound, to the byte: exactly maxBytes is kept whole; one more is stopped.
        if "stdoutLength" in program:
            n, cap = program["stdoutLength"], CONTAINER_DETECT["output"]["maxBytes"]
            answer = providers._run_version(to[providers.CONTAINER_CANDIDATES[0]], providers.CONTAINER_VERSION_TIMEOUT_MS)
            assert len(answer.stdout) == min(n, cap)
            assert answer.error == (CONTAINER_DETECT["output"]["overflowError"] if n > cap else None)
            assert answer.code == (None if n > cap else 0)

    def test_real_runner_over_the_bound_is_an_error_never_the_timeout(self, tmp_path):
        providers = _sub(_load(ACTIVE_ENV), "providers")
        prog = tmp_path / "container"
        prog.write_text("#!/bin/sh\nhead -c 2000000 /dev/zero\n")
        prog.chmod(0o755)
        answer = providers._run_version(str(prog), providers.CONTAINER_VERSION_TIMEOUT_MS)
        assert (answer.code, answer.timed_out, answer.error) == (None, False, CONTAINER_DETECT["output"]["overflowError"])
        assert len(answer.stdout) <= providers.CHECK_OUTPUT_MAX_BYTES

    @staticmethod
    def _gone(pid: int, within_s: float = 3.0) -> bool:
        """The process no longer exists (a killed orphan is reaped by launchd shortly after)."""
        end = time.monotonic() + within_s
        while time.monotonic() < end:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return True
            time.sleep(0.02)
        return False

    @pytest.mark.parametrize("body", [
        # ignores SIGTERM and keeps a child: the old runner waited for it (5.2 s, 12.2 s, unbounded)
        "trap '' TERM\nsleep 30 &\necho $! > \"$PIDFILE\"\nwait\n",
        # exits at once while its child holds the pipe
        "sleep 30 &\necho $! > \"$PIDFILE\"\nexit 0\n",
    ], ids=["ignores-TERM", "child-holds-pipe"])
    def test_real_runner_timeout_kills_the_group_with_sigkill(self, tmp_path, monkeypatch, body):
        """G3 r2 m-2: the timeout is enforced and nothing the check started outlives it (the app's runFile, same rule)."""
        providers = _sub(_load(ACTIVE_ENV), "providers")
        pidfile = tmp_path / "child.pid"
        monkeypatch.setenv("PIDFILE", str(pidfile))
        prog = tmp_path / "container"
        prog.write_text("#!/bin/sh\n" + body)
        prog.chmod(0o755)
        spawned = []
        real_popen = providers.subprocess.Popen

        def popen(*args, **kwargs):
            spawned.append(real_popen(*args, **kwargs))
            return spawned[-1]

        monkeypatch.setattr(providers.subprocess, "Popen", popen)
        started = time.monotonic()
        answer = providers._run_version(str(prog), 600)
        took = time.monotonic() - started
        assert answer.timed_out is True and answer.code is None and answer.error is None
        assert took < 0.6 + 1.5, took
        child = int(pidfile.read_text().strip())
        assert self._gone(child), f"orphan {child} survived the timeout"
        # G3 r3 (critic r2 n-2): the check it killed is reaped, not left a zombie until garbage collection.
        assert len(spawned) == 1 and spawned[0].returncode is not None

    def test_real_runner_a_normal_exit_still_kills_the_group(self, tmp_path, monkeypatch):
        """G3 r3 m-3: a check that answers, leaves a child that dropped its pipes, and exits 0 reads installed, and
        the child dies with the probe (the group is killed on every exit path, not only the timeout)."""
        providers = _sub(_load(ACTIVE_ENV), "providers")
        pidfile = tmp_path / "child.pid"
        monkeypatch.setenv("PIDFILE", str(pidfile))
        prog = tmp_path / "container"
        prog.write_text('#!/bin/sh\necho "container CLI version 1.5.0"\nsleep 30 </dev/null >/dev/null 2>&1 &\n'
                        'echo $! > "$PIDFILE"\nexit 0\n')
        prog.chmod(0o755)
        answer = providers._run_version(str(prog), 3000)
        assert (answer.code, answer.timed_out, answer.error) == (0, False, None)
        assert providers._answer_text(answer.stdout) == "container CLI version 1.5.0"
        child = int(pidfile.read_text().strip())
        assert self._gone(child), f"orphan {child} survived a normal exit"

    def test_real_runner_a_signal_that_is_not_the_timeout_is_an_error(self, tmp_path):
        """A check killed by someone else is a definite failure (SIGKILL named), never read as the timeout."""
        providers = _sub(_load(ACTIVE_ENV), "providers")
        prog = tmp_path / "container"
        prog.write_text("#!/bin/sh\nkill -KILL $$\n")
        prog.chmod(0o755)
        answer = providers._run_version(str(prog), 3000)
        assert (answer.code, answer.timed_out, answer.error) == (None, False, "SIGKILL")


# A small deny-default profile with the same parameters as the generated ones (the TS generator is exercised by the
# vitest live suite; this checks the Python wrapping: params, marker, scratch, tamper refusal).
MINI_PROFILE = """(version 1)
(deny default (with message "iclone-confined:project"))
(allow process-fork)
(allow process-exec (subpath "/bin") (subpath "/usr") (subpath "/System"))
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow file-read* (subpath "/bin") (subpath "/usr") (subpath "/System") (subpath "/private/var/db/dyld") (subpath "/dev") (literal "/") (subpath "/private/etc"))
(allow file-read-metadata (literal "/private") (literal "/private/var") (literal "/var") (literal "/etc") (literal "/tmp") (literal "/Users"))
(allow file-read-metadata (regex #"^/private/var/folders"))
(allow file-read* (subpath (param "PROJECT_ROOT")) (subpath (param "SCRATCH")))
(allow file-write* (subpath (param "SCRATCH")))
(if (equal? (param "WRITE_PROJECT") "1") (allow file-write* (subpath (param "PROJECT_ROOT"))))
(allow file-write-data file-ioctl (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.bsd.dirhelper"))
"""


LINK_KEY = bytes(range(32))


def _sign_acks(path: Path, acks: list, key: bytes = LINK_KEY) -> None:
    import hmac

    body = json.dumps({"acks": acks})
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"v": 1, "body": body, "sig": hmac.new(key, body.encode(), hashlib.sha256).hexdigest()}))


@pytest.mark.skipif(not LIVE, reason="macOS sandbox-exec only")
class TestSeatbeltLive:
    def world(self, tmp_path, monkeypatch, cls="project", classes=("project",)):
        root = Path(os.path.realpath(tmp_path))
        project = root / "proj"
        (project / ".git").mkdir(parents=True)
        (project / "README").write_text("inside\n")
        (root / "outside.txt").write_text("outside-secret\n")
        profiles = root / "profiles"
        profiles.mkdir()
        sha = hashlib.sha256(MINI_PROFILE.encode()).hexdigest()
        for name in classes:
            (profiles / f"{name}.sb").write_text(MINI_PROFILE)
        spec = json.dumps({
            "v": 5, "profilesDir": str(profiles), "scratchRoot": str(root / "scratch"), "home": str(root / "home"),
            "membersDir": str(root / "members"), "denied": [], "sha256": {name: sha for name in classes},
            "hardlinkAcks": str(root / "userData" / "hardlink-acks.json"),
            "hardlinkReport": str(root / "userData" / "run" / "hardlinks.json"),
            "refusalsDir": str(root / "userData" / "refusals"),
            # T2'': a world-local pnpm store root (never the real ~/Library/pnpm).
            "pnpmStoreRoots": [str(root / "pnpm-store")],
        })
        (root / "home").mkdir()
        mod = _load({**ACTIVE_ENV, "ICLONE_CONFINEMENT_DIR": str(profiles), "ICLONE_CONFINEMENT_SPEC": spec,
                     "ICLONE_CONFINEMENT_LINK_KEY": LINK_KEY.hex()})
        seatbelt = _sub(mod, "seatbelt")
        monkeypatch.setenv("HOME", str(root / "home"))
        index = _sub(mod, "core").trusted_index()
        env = seatbelt.SeatbeltEnvironment(cwd=str(project), timeout=20, cls=cls, index=index, task_id="t-1")
        return root, project, profiles, sha, env

    def test_reads_and_writes_the_project_refuses_outside(self, tmp_path, monkeypatch):
        root, project, _, _, env = self.world(tmp_path, monkeypatch)
        assert env.project_root == str(project)
        ok = env.execute("echo made > made.txt && cat README")
        assert ok["returncode"] == 0 and "inside" in ok["output"]
        assert (project / "made.txt").read_text() == "made\n"
        leak = env.execute(f"cat {root}/outside.txt")
        assert leak["returncode"] != 0 and "outside-secret" not in leak["output"]
        write = env.execute(f"echo x > {root}/escaped.txt")
        assert write["returncode"] != 0 and not (root / "escaped.txt").exists()

    def test_v3up_m3_the_file_tools_read_and_search_through_the_confined_shell(self, tmp_path, monkeypatch):
        """At 1ac3f97 read_file / search / the existence probe run IN the Hermes process for a LocalEnvironment;
        the seatbelt environment (a subclass) must keep them on its confined shell, or a planted secret outside the
        project is read past sandbox-exec (V3-UP r1 critic M3)."""
        from tools.file_operations import ShellFileOperations

        root, project, _, _, env = self.world(tmp_path, monkeypatch)
        monkeypatch.delenv("HERMES_NATIVE_FILE_READ", raising=False)  # the runtime default: native lane on
        files = ShellFileOperations(env)
        assert files._native_read_enabled() is False
        inside = files.read_file(str(project / "README"))
        assert inside.error is None and "inside" in inside.content
        leak = files.read_file(str(root / "outside.txt"))
        assert "outside-secret" not in (leak.content or "")
        found = files.search("outside-secret", path=str(root), target="content")
        assert "outside-secret" not in json.dumps([m.__dict__ for m in found.matches]) + str(found.files)
        assert files._read_exact_bytes(str(root / "outside.txt"))[0] in (None, b"")

    def test_the_marker_is_visible_in_ps_for_the_whole_run(self, tmp_path, monkeypatch):
        _, _, _, sha, env = self.world(tmp_path, monkeypatch)
        proc = env._run_bash("/bin/sleep 2")
        try:
            time.sleep(0.4)
            out = subprocess.run(["/bin/ps", "-axww", "-o", "pid=,command="], capture_output=True, text=True).stdout
            assert f"iclone-confined:project:{sha[:12]}:" in out
        finally:
            proc.kill()

    def test_a_cd_never_moves_the_writable_project(self, tmp_path, monkeypatch):
        root, project, _, _, env = self.world(tmp_path, monkeypatch)
        env.execute(f"cd {root}")
        result = env.execute("echo x > moved.txt")
        assert result["returncode"] != 0 and not (root / "moved.txt").exists()

    def test_a_changed_profile_is_refused_not_run(self, tmp_path, monkeypatch):
        _, _, profiles, _, env = self.world(tmp_path, monkeypatch)
        (profiles / "project.sb").write_text(MINI_PROFILE + "(allow default)\n")
        result = env.execute("echo should-not-run")
        assert result["returncode"] == 126 and "changed on disk" in result["output"]

    def test_f2_the_critics_attack_profile_and_index_rewritten_together_stays_refused(self, tmp_path, monkeypatch):
        # Round 1 trusted an index.json next to the profiles: rewrite both and the shell ran free. Now the hashes come
        # from main's spawn env only; a planted index is never read.
        root, _, profiles, _, env = self.world(tmp_path, monkeypatch)
        (root / "canary.txt").write_text("CANARY-TAMPER\n")
        evil = "(version 1)\n(allow default)\n"
        (profiles / "project.sb").write_text(evil)
        (profiles / "index.json").write_text(json.dumps({
            "v": 1, "scratchRoot": str(root), "home": str(root / "home"), "denied": [],
            "profiles": {"project": {"file": str(profiles / "project.sb"), "sha256": hashlib.sha256(evil.encode()).hexdigest()}},
        }))
        result = env.execute(f"cat {root}/canary.txt; echo free > {root}/freed.txt")
        assert result["returncode"] == 126 and "CANARY-TAMPER" not in result["output"]
        assert not (root / "freed.txt").exists()

    def test_f2_a_swap_after_the_check_changes_nothing_the_verified_text_is_what_runs(self, tmp_path, monkeypatch):
        root, project, profiles, _, env = self.world(tmp_path, monkeypatch)
        argv = env.sandbox_argv(["/bin/bash", "-c", "true"], "s-1")
        assert argv[1] == "-p" and argv[2] == MINI_PROFILE and str(profiles) not in " ".join(argv[:3])
        (profiles / "project.sb").write_text("(version 1)\n(allow default)\n")
        proc = subprocess.run([*argv[:-4], "/bin/cat", f"{root}/outside.txt"], capture_output=True, text=True)
        assert proc.returncode != 0 and "outside-secret" not in proc.stdout

    def test_f1_every_command_gets_a_run_token_only_its_sandbox_may_read(self, tmp_path, monkeypatch):
        root, _, _, sha, env = self.world(tmp_path, monkeypatch)
        argv = env.sandbox_argv(["/bin/bash", "-c", "true"], "s-1")
        member = next(item.split("=", 1)[1] for item in argv if item.startswith("MEMBER="))
        assert os.path.dirname(member) == str(root / "members")
        assert os.path.basename(member).startswith(f"project+{sha[:12]}+s-1+")
        assert (root / "members" / ".member").exists() and (root / "members" / ".decoy").exists()
        other = env.sandbox_argv(["/bin/bash", "-c", "true"], "s-1")
        assert member not in other

    def test_plan_mode_keeps_the_project_read_only(self, tmp_path, monkeypatch):
        _, project, _, _, env = self.world(tmp_path, monkeypatch)
        _install_v3f(monkeypatch, _body("plan"))
        result = env.execute("echo x > plan.txt")
        assert result["returncode"] != 0 and not (project / "plan.txt").exists()

    # --- F7: hard links into the project ---------------------------------------------------------------------------

    def test_f7_a_planted_hard_link_refuses_the_command_and_tells_the_pane(self, tmp_path, monkeypatch):
        root, project, _, _, env = self.world(tmp_path, monkeypatch)
        os.link(root / "outside.txt", project / "planted")
        control = subprocess.run(["/bin/cat", str(project / "planted")], capture_output=True, text=True)
        assert control.stdout == "outside-secret\n"
        read = env.execute("cat planted")
        write = env.execute("echo PWNED >> planted")
        assert read["returncode"] == 126 and "outside-secret" not in read["output"]
        assert "confinement refused to start in" in read["output"] and str(project / "planted") in read["output"]
        assert write["returncode"] == 126 and (root / "outside.txt").read_text() == "outside-secret\n"
        report = json.loads((root / "userData" / "run" / "hardlinks.json").read_text())
        assert report["blocked"][str(project)] == {"kind": "hard-links", "paths": [str(project / "planted")], "count": 1}
        os.unlink(project / "planted")
        ok = env.execute("cat README")
        assert ok["returncode"] == 0 and "inside" in ok["output"]
        assert str(project) not in json.loads((root / "userData" / "run" / "hardlinks.json").read_text())["blocked"]

    def test_f7_an_acknowledged_inode_runs_and_only_that_inode(self, tmp_path, monkeypatch):
        root, project, _, _, env = self.world(tmp_path, monkeypatch)
        acks = root / "userData" / "hardlink-acks.json"
        os.link(root / "outside.txt", project / "planted")
        st = os.lstat(project / "planted")
        ack = {"root": str(project), "path": str(project / "planted"), "dev": st.st_dev, "ino": st.st_ino, "at": "t"}
        _sign_acks(acks, [ack])
        assert env.execute("cat README")["returncode"] == 0
        (root / "other.txt").write_text("other\n")
        os.link(root / "other.txt", project / "second")
        second = env.execute("cat README")
        assert second["returncode"] == 126 and str(project / "second") in second["output"]
        assert str(project / "planted") not in second["output"]

    def test_f7_a_forged_acknowledgement_allows_nothing(self, tmp_path, monkeypatch):
        root, project, _, _, env = self.world(tmp_path, monkeypatch)
        os.link(root / "outside.txt", project / "planted")
        st = os.lstat(project / "planted")
        ack = {"root": str(project), "path": str(project / "planted"), "dev": st.st_dev, "ino": st.st_ino, "at": "t"}
        _sign_acks(root / "userData" / "hardlink-acks.json", [ack], key=b"\x01" * 32)
        assert env.execute("cat planted")["returncode"] == 126

    def test_f7_the_scan_is_cached_and_a_planted_link_invalidates_it(self, tmp_path, monkeypatch):
        root, project, _, _, env = self.world(tmp_path, monkeypatch)
        core = sys.modules[f"{PKG}.core"]
        (project / "deep" / "er").mkdir(parents=True)
        assert core.linked_inodes(str(project)) == ([], False, [])
        assert core.linked_inodes(str(project)) == ([], True, [])
        os.link(root / "outside.txt", project / "deep" / "er" / "late")
        linked, cached, _unscannable = core.linked_inodes(str(project))
        assert not cached and [inode["paths"] for inode in linked] == [[str(project / "deep" / "er" / "late")]]
        os.link(project / "README", project / "deep" / "twin")
        assert [inode["paths"] for inode in core.linked_inodes(str(project))[0]] == [[str(project / "deep" / "er" / "late")]]

    # --- r3 T1: an unlistable directory is a refusal, and the scratch is scanned too ---------------------------------

    def test_t1_the_critics_chmod_311_folder_hiding_a_link_is_refused_not_scanned_around(self, tmp_path, monkeypatch):
        root, project, _, _, env = self.world(tmp_path, monkeypatch)
        hidden = project / "hidden"
        hidden.mkdir()
        os.link(root / "outside.txt", hidden / "x")
        hidden.chmod(0o311)
        try:
            # The premise: traversal needs only x, so the link is readable through the unlistable folder.
            assert subprocess.run(["/bin/cat", str(hidden / "x")], capture_output=True, text=True).stdout == "outside-secret\n"
            read = env.execute("cat hidden/x")
            assert read["returncode"] == 126 and "outside-secret" not in read["output"]
            assert f"confinement refused to start in {project}: cannot scan {hidden}" in read["output"]
            write = env.execute("echo PWNED >> hidden/x")
            assert write["returncode"] == 126 and (root / "outside.txt").read_text() == "outside-secret\n"
            report = json.loads((root / "userData" / "run" / "hardlinks.json").read_text())
            assert report["blocked"][str(project)] == {"kind": "cannot-scan", "paths": [str(hidden)], "count": 1}
        finally:
            hidden.chmod(0o755)
        # Listable again: the link itself refuses.
        again = env.execute("cat hidden/x")
        assert again["returncode"] == 126 and f"{hidden / 'x'} is a hard link" in again["output"]
        os.unlink(hidden / "x")
        assert env.execute("cat README")["returncode"] == 0

    @pytest.mark.parametrize("mode", [0o400, 0o600])
    def test_t1p_the_critics_chmod_400_folder_chmod_711_from_inside_is_refused_before_it_runs(self, tmp_path, monkeypatch, mode):
        root, project, _, _, env = self.world(tmp_path, monkeypatch)
        hidden = project / "hidden"
        hidden.mkdir()
        os.link(root / "outside.txt", hidden / "x")
        hidden.chmod(mode)
        try:
            # The premise: the folder lists, its children do not stat, and giving x back reads the secret through
            # the link (unconfined here; confined too, MAJOR-1', since file-write-mode is inside file-write*).
            assert os.listdir(hidden) == ["x"]
            with pytest.raises(PermissionError):
                os.lstat(hidden / "x")
            control = subprocess.run(["/bin/sh", "-c", f"chmod 711 '{hidden}' && cat '{hidden}/x'"], capture_output=True, text=True)
            assert control.stdout == "outside-secret\n"
            hidden.chmod(mode)
            read = env.execute("chmod 711 hidden; cat hidden/x")
            assert read["returncode"] == 126 and "outside-secret" not in read["output"]
            assert f"confinement refused to start in {project}: cannot scan {hidden}" in read["output"]
            assert stat.S_IMODE(hidden.stat().st_mode) == mode
            write = env.execute("chmod 711 hidden; echo PWNED >> hidden/x")
            assert write["returncode"] == 126 and (root / "outside.txt").read_text() == "outside-secret\n"
            assert stat.S_IMODE(hidden.stat().st_mode) == mode
            report = json.loads((root / "userData" / "run" / "hardlinks.json").read_text())
            assert report["blocked"][str(project)] == {"kind": "cannot-scan", "paths": [str(hidden)], "count": 1}
        finally:
            hidden.chmod(0o755)
        again = env.execute("cat hidden/x")
        assert again["returncode"] == 126 and f"{hidden / 'x'} is a hard link" in again["output"]
        os.unlink(hidden / "x")
        assert env.execute("cat README")["returncode"] == 0

    def test_t1_a_link_planted_under_the_scratch_refuses_the_command(self, tmp_path, monkeypatch):
        root, _, _, _, env = self.world(tmp_path, monkeypatch)
        scratch = Path(env.get_temp_dir()).parent
        os.link(root / "outside.txt", scratch / "planted")
        read = env.execute(f"cat {scratch / 'planted'}")
        assert read["returncode"] == 126 and "outside-secret" not in read["output"]
        assert f"confinement refused to start in {scratch}" in read["output"]
        os.unlink(scratch / "planted")
        assert env.execute("cat README")["returncode"] == 0

    # --- r4 T2'': a pnpm store in build runs with 0 gestures; every other class still asks -----------------------------

    def test_t2pp_a_pnpm_store_in_build_runs_without_a_gesture_and_project_still_asks(self, tmp_path, monkeypatch):
        root, project, _, _, build = self.world(tmp_path, monkeypatch, cls="build", classes=("project", "build"))
        files = root / "pnpm-store" / "store" / "v3" / "files"
        files.mkdir(parents=True)
        for i in range(20):
            (files / f"h{i}").write_text(f"blob {i}\n")
            pkg = project / "node_modules" / ".pnpm" / f"pkg{i}"
            pkg.mkdir(parents=True)
            os.link(files / f"h{i}", pkg / "index.js")
        ran = build.execute("cat node_modules/.pnpm/pkg7/index.js")
        assert ran["returncode"] == 0 and ran["output"].strip() == "blob 7"
        assert not (root / "userData" / "hardlink-acks.json").exists() or "pkg7" not in (root / "userData" / "hardlink-acks.json").read_text()
        assert not (root / "userData" / "run" / "hardlinks.json").exists()
        # No exit row for the passed links (T3 scans with the run's class).
        refusals = root / "userData" / "refusals"
        assert not refusals.exists() or not any("hard-link-appeared" in f.read_text() for f in refusals.iterdir())
        seatbelt = sys.modules[f"{PKG}.seatbelt"]
        proj = seatbelt.SeatbeltEnvironment(cwd=str(project), timeout=20, cls="project", index=build._index, task_id="t-2")
        refused = proj.execute("cat node_modules/.pnpm/pkg7/index.js")
        assert refused["returncode"] == 126 and "blob 7" not in refused["output"]
        assert "are hard links to a file outside the project" in refused["output"]
        report = json.loads((root / "userData" / "run" / "hardlinks.json").read_text())
        assert report["blocked"][str(project)]["count"] == 20
        # A link into a non-store root asks in build too, named alone.
        planted = project / "node_modules" / ".pnpm" / "pkg0" / "secret.js"
        os.link(root / "outside.txt", planted)
        mixed = build.execute("cat node_modules/.pnpm/pkg0/secret.js")
        assert mixed["returncode"] == 126 and "outside-secret" not in mixed["output"]
        assert f"{planted} is a hard link" in mixed["output"]

    def test_t2pp_r5_a_symlinked_store_root_is_not_the_store_build_is_refused_and_the_secret_unread(self, tmp_path, monkeypatch):
        root, project, _, _, build = self.world(tmp_path, monkeypatch, cls="build", classes=("project", "build"))
        secrets = root / "secrets"
        secrets.mkdir()
        (secrets / ".env").write_text("OPENAI_API_KEY=sk-test-not-real\n")
        os.symlink(secrets, root / "pnpm-store")  # the "store" main named is the secrets folder
        (secrets / "store" / "v3").mkdir(parents=True)  # the shape is one more mkdir: not the boundary
        evil = project / "node_modules" / ".pnpm" / "evil" / "index.js"
        evil.parent.mkdir(parents=True)
        os.link(secrets / ".env", evil)
        assert sorted(e.name for e in os.scandir(root / "pnpm-store")) == [".env", "store"]
        ran = build.execute("cat node_modules/.pnpm/evil/index.js")
        assert ran["returncode"] == 126 and "sk-test-not-real" not in ran["output"]
        assert f"{evil} is a hard link" in ran["output"]
        seatbelt = sys.modules[f"{PKG}.seatbelt"]
        proj = seatbelt.SeatbeltEnvironment(cwd=str(project), timeout=20, cls="project", index=build._index, task_id="t-2")
        refused = proj.execute("cat node_modules/.pnpm/evil/index.js")
        assert refused["returncode"] == 126 and "sk-test-not-real" not in refused["output"]
        # The same .env by its own path: the profile denies it, so the link was the only road.
        direct = build.execute(f"cat {secrets / '.env'}")
        assert direct["returncode"] != 0 and "sk-test-not-real" not in direct["output"]

    def test_r6_the_agent_cds_into_the_store_the_secret_linked_into_it_is_unread_in_every_class(self, tmp_path, monkeypatch):
        classes = ("project", "build", "offline", "research", "media")
        root, _project, _, _, build = self.world(tmp_path, monkeypatch, cls="build", classes=classes)
        secrets = root / "secrets"
        secrets.mkdir()
        (secrets / ".env").write_text("OPENAI_API_KEY=sk-test-not-real\n")
        store = root / "pnpm-store"
        files = store / "store" / "v3" / "files"
        files.mkdir(parents=True)
        blob = files / "evil-blob"
        os.link(secrets / ".env", blob)
        assert "sk-test-not-real" in blob.read_text()  # the premise: unconfined, the store's name reads the secret
        core = sys.modules[f"{PKG}.core"]
        # The algorithm alone: the store name is one of two, the other (the secret's own) is outside: it asks.
        assert core._open_block(build._index, str(store), "build") == {"kind": "hard-links", "paths": [str(blob)], "count": 1}
        seatbelt = sys.modules[f"{PKG}.seatbelt"]
        for cwd in (store, store / "store" / "v3"):
            for cls in classes:
                env = seatbelt.SeatbeltEnvironment(cwd=str(cwd), timeout=20, cls=cls, index=build._index, task_id=f"t-{cls}")
                # A store is never the project: the run gets its scratch.
                assert env.project_root != str(cwd) and env.project_root == env._scratch, (cwd, cls)
                ran = env.execute(f"cat {blob}")
                assert "sk-test-not-real" not in ran["output"], (cwd, cls)

    # --- r3 T3: a link planted during the run is found when the run exits --------------------------------------------

    def test_t3_the_critics_0_3s_plant_is_recorded_as_a_refusal_row_in_that_runs_name(self, tmp_path, monkeypatch):
        import threading

        root, project, _, _, env = self.world(tmp_path, monkeypatch)
        planted = project / "during-run"
        timer = threading.Timer(0.3, lambda: os.link(root / "outside.txt", planted))
        timer.start()
        try:
            result = env.execute("sleep 1.2; cat during-run")
        finally:
            timer.cancel()
        # Not prevented (Seatbelt has no inode filter) …
        assert result["returncode"] == 0 and "outside-secret" in result["output"]
        # … but detected: one refusal-class row, naming the run, the path and the root.
        rows = [json.loads(line) for day in (root / "userData" / "refusals").glob("*.jsonl")
                for line in day.read_text().splitlines() if line]
        appeared = [row for row in rows if row["operation"] == "hard-link-appeared"]
        assert len(appeared) == 1
        assert appeared[0]["target"] == str(planted) and appeared[0]["root"] == str(project)
        assert appeared[0]["process"] == "hard-link" and appeared[0]["pid"] > 1
        assert (root / "userData" / "refusals" / f"{appeared[0]['ts'][:10]}.jsonl").stat().st_mode & 0o777 == 0o600
        # The next command in that root is refused like any other.
        nxt = env.execute("cat during-run")
        assert nxt["returncode"] == 126 and f"{planted} is a hard link" in nxt["output"]
        os.unlink(planted)
        assert env.execute("cat README")["returncode"] == 0

    def test_t3_a_clean_run_writes_no_row(self, tmp_path, monkeypatch):
        root, _, _, _, env = self.world(tmp_path, monkeypatch)
        assert env.execute("cat README")["returncode"] == 0
        assert not (root / "userData" / "refusals").exists()
