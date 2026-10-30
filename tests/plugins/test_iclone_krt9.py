"""V3-RT K-RT9: the walk up for a git root never reaches the home folder and never goes above HERMES_HOME or the runtime
root. The owner's home folder IS a git repository, and the app's own folders live under it: before this, every folder
in the home without its own ``.git`` was one project (the home), and a runtime tree without ``.git`` reported the home
repository's HEAD as its own commit. Fixtures: a temp "home" inside a git repository, never the real home."""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def _plugin_module(plugin: str, name: str):
    pkg = f"krt9_{plugin.replace('-', '_')}"
    if pkg not in sys.modules:
        ns = types.ModuleType("krt9_ns")
        ns.__path__ = []
        directory = ROOT / "plugins" / plugin
        spec = importlib.util.spec_from_file_location(pkg, directory / "__init__.py",
                                                      submodule_search_locations=[str(directory)])
        module = importlib.util.module_from_spec(spec)
        sys.modules[pkg] = module
        spec.loader.exec_module(module)
    return importlib.import_module(f"{pkg}.{name}")


@pytest.fixture()
def world(tmp_path, monkeypatch):
    """repo/ (a git repository) holding home/ (HOME, itself also a git repository) and hh/ (HERMES_HOME)."""
    repo = (tmp_path / "repo").resolve()
    home = repo / "home"
    hermes_home = repo / "hh"
    for directory in (repo / ".git", home / ".git", home / "proj" / "sub", home / "code" / ".git", home / "code" / "sub",
                      hermes_home / "profiles" / "p1", repo / "elsewhere" / "deep"):
        directory.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    return types.SimpleNamespace(repo=repo, home=home, hermes_home=hermes_home)


@pytest.mark.parametrize("walker", ["permissions", "confinement"])
def test_the_walk_stops_below_the_home_folder_and_inside_hermes_home(world, walker):
    if walker == "permissions":
        walk = _plugin_module("iclone-permissions", "classify").project_root
    else:
        walk = _plugin_module("iclone-confinement", "core").git_root

    # A folder in the home without its own .git is its own project: never the home, never the repo around it.
    assert walk(str(world.home / "proj" / "sub")) == str(world.home / "proj" / "sub")
    # A real project inside the home is still found from a subfolder.
    assert walk(str(world.home / "code" / "sub")) == str(world.home / "code")
    # The home itself, asked directly, is where the call runs: that is the answer.
    assert walk(str(world.home)) == str(world.home)
    # Inside HERMES_HOME the walk never goes above it (the repo around it is not the project).
    assert walk(str(world.hermes_home / "profiles" / "p1")) == str(world.hermes_home / "profiles" / "p1")
    # Outside the home and HERMES_HOME the rule is unchanged: the git root above.
    assert walk(str(world.repo / "elsewhere" / "deep")) == str(world.repo)


def test_a_runtime_tree_without_git_inside_a_repository_has_no_git_identity(world):
    from hermes_cli import version_info

    runtime = world.home / "runtime" / "hermes-agent"
    runtime.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(world.home)], check=True)
    subprocess.run(["git", "-C", str(world.home), "-c", "user.email=t@example.invalid", "-c", "user.name=t",
                    "commit", "-q", "--allow-empty", "-m", "home"], check=True,
                   env={**os.environ, "GIT_CONFIG_NOSYSTEM": "1"})

    info = version_info._git_version_info(runtime)

    assert info.commit is None
    # A tree with its own repository is still identified.
    own = world.repo / "own"
    own.mkdir()
    subprocess.run(["git", "init", "-q", str(own)], check=True)
    subprocess.run(["git", "-C", str(own), "-c", "user.email=t@example.invalid", "-c", "user.name=t",
                    "commit", "-q", "--allow-empty", "-m", "own"], check=True)
    assert version_info._git_version_info(own).commit


def _legacy_checkout(hermes_home: Path) -> Path:
    legacy = hermes_home / "hermes-agent"
    legacy.mkdir(parents=True)
    (legacy / "README.md").write_text("0.0.2\n")
    env = {**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}
    subprocess.run(["git", "init", "-q", str(legacy)], check=True, env=env)
    subprocess.run(["git", "-C", str(legacy), "add", "-A"], check=True, env=env)
    subprocess.run(["git", "-C", str(legacy), "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q",
                    "-m", "legacy"], check=True, env=env)
    return legacy


def _tree_state(root: Path) -> dict:
    return {str(p.relative_to(root)): (p.stat().st_mtime_ns, p.stat().st_size, p.read_bytes() if p.is_file() else b"")
            for p in [root, *root.rglob("*")]}


def test_a_shipped_runtime_never_takes_the_users_checkout_as_its_identity(world, monkeypatch):
    """Found live (RT-4 round 2): the app's runtime has no .git, so the identity lookup fell back to
    $HERMES_HOME/hermes-agent, ran `git status` there and rewrote the user's index. A shipped runtime has no such
    fallback; a source tree without the manifest keeps the upstream behaviour."""
    from hermes_cli import banner, version_info

    legacy = _legacy_checkout(world.hermes_home)
    monkeypatch.setattr("hermes_constants.get_process_hermes_home", lambda: world.hermes_home, raising=False)
    monkeypatch.setattr("hermes_cli.banner.get_hermes_home", lambda: world.hermes_home)

    shipped = world.repo / "elsewhere" / "app-runtime"
    shipped.mkdir(parents=True)
    (shipped / version_info.SHIPPED_RUNTIME_MARKER).write_text("{}\n")
    before = _tree_state(legacy)

    assert version_info._resolve_repo_dir(shipped) is None
    # The upstream fallback is unchanged for a tree that is not an app-shipped runtime.
    plain = world.repo / "elsewhere" / "plain-tree"
    plain.mkdir(parents=True)
    assert version_info._resolve_repo_dir(plain) == legacy

    monkeypatch.setattr(banner, "__file__", str(shipped / "hermes_cli" / "banner.py"))
    assert banner._resolve_repo_dir() is None

    # Reading an identity never writes the tree it reads (no index refresh).
    version_info._git_version_info(legacy)
    assert _tree_state(legacy) == before
