"""V3-RT K-RT15b (lead decision): no importable copy of the runtime may exist outside the tree the app verified.

``uv sync`` installs the core project editable from PM's build snapshot, so the environment's console scripts imported
a 55 MB copy that RT-3 never checks. For an app-shipped runtime (RUNTIME_MANIFEST.json at its root) PM now points the
environment at the verified tree and deletes the copy. Fixtures in tmp only."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from pm.workspace import SHIPPED_RUNTIME_MARKER, SOURCE_PTH, bind_environment_to_source


def _layout(tmp_path: Path, *, shipped: bool):
    source = tmp_path / "hermes-runtime" / "abc"
    (source / "hermes_cli").mkdir(parents=True)
    (source / "hermes_cli" / "__init__.py").write_text("WHERE = 'verified'\n")
    (source / "cli.py").write_text("WHERE = 'verified'\n")
    if shipped:
        (source / SHIPPED_RUNTIME_MARKER).write_text("{}\n")
    workspace = source / ".iclone-deps" / "env" / "workspace"
    (workspace / "hermes_cli").mkdir(parents=True)
    (workspace / "hermes_cli" / "__init__.py").write_text("WHERE = 'copy'\n")
    (workspace / "cli.py").write_text("WHERE = 'copy'\n")
    (workspace / "pyproject.toml").write_text("[project]\nname = 'hermes-agent'\n")
    (workspace / "uv.lock").write_text("version = 1\n")
    (workspace / "my-plugin").mkdir()
    site = source / ".iclone-deps" / "env" / "venv" / "lib" / "python3.14" / "site-packages"
    site.mkdir(parents=True)
    mapping = {"hermes_cli": str(workspace / "hermes_cli"), "cli": str(workspace / "cli.py")}
    (site / "__editable__.hermes_agent-0.0.0.pth").write_text("import __editable___hermes_agent_0_0_0_finder\n")
    (site / "__editable___hermes_agent_0_0_0_finder.py").write_text(f"MAPPING = {mapping!r}\n")
    (site / "__editable__.my_plugin-1.0.pth").write_text("import __editable___my_plugin_1_0_finder\n")
    (site / "__editable___my_plugin_1_0_finder.py").write_text("MAPPING = {}\n")
    return source, workspace, site


def test_a_shipped_runtime_environment_imports_the_verified_tree_and_the_copy_is_gone(tmp_path):
    source, workspace, site = _layout(tmp_path, shipped=True)

    removed = bind_environment_to_source(site.parents[2], workspace, source, project="hermes-agent")

    assert removed == ["cli.py", "hermes_cli"]
    assert sorted(p.name for p in workspace.iterdir()) == ["my-plugin", "pyproject.toml", "uv.lock"]
    assert repr(str(source.resolve())) in (site / SOURCE_PTH).read_text()
    assert not (site / "__editable__.hermes_agent-0.0.0.pth").exists()
    assert not (site / "__editable___hermes_agent_0_0_0_finder.py").exists()
    # A plugin member keeps its own editable install.
    assert (site / "__editable__.my_plugin-1.0.pth").exists()

    probe = ("import site,sys; site.addsitedir(sys.argv[1]); import hermes_cli, cli; "
             "print(hermes_cli.WHERE, cli.WHERE, sys.path.index(sys.argv[2]) < sys.path.index(sys.argv[1]), "
             "all(sys.path.index(p) < sys.path.index(sys.argv[2]) for p in sys.path if p.endswith('lib/python3.' + "
             "str(sys.version_info[1]))))")
    out = subprocess.run([sys.executable, "-I", "-S", "-c", probe, str(site), str(source.resolve())], capture_output=True,
                         text=True, check=True, cwd=str(tmp_path))
    # -S: the interpreter running this test may itself be a bound runtime environment; only the fixture's
    # site-packages (added by the probe) may decide what imports.
    # The verified tree: imported, before site-packages, after the standard library.
    assert out.stdout.split() == ["verified", "verified", "True", "True"]
    # Nothing importable named like the runtime is left anywhere under the app folder but the verified tree.
    copies = [p for p in source.rglob("hermes_cli/__init__.py") if p.parent.parent != source]
    assert copies == []


def test_a_source_tree_without_the_manifest_keeps_the_upstream_editable_install(tmp_path):
    source, workspace, site = _layout(tmp_path, shipped=False)

    assert bind_environment_to_source(site.parents[2], workspace, source, project="hermes-agent") == []
    assert (workspace / "hermes_cli" / "__init__.py").read_text() == "WHERE = 'copy'\n"
    assert (site / "__editable___hermes_agent_0_0_0_finder.py").exists()
    assert not (site / SOURCE_PTH).exists()


def _activate(tmp_path: Path, monkeypatch, *, shipped: bool):
    """Runs the real ``activate_dependencies`` over a tree whose committed environment PM recorded in facts.json, from
    a process that inherited a PYTHONPATH; returns the tree, the selected site-packages and the stdlib entries."""
    import json
    import os
    import sysconfig

    from pm.environments import activate_dependencies, install_state_dir, runtime_facts_path, site_packages

    tree = tmp_path / "hermes-runtime" / "abc"
    tree.mkdir(parents=True)
    if shipped:
        (tree / SHIPPED_RUNTIME_MARKER).write_text("{}\n")
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    venv = install_state_dir(tree) / "environments" / "one" / "venv"
    venv.mkdir(parents=True)
    (venv / "pyvenv.cfg").write_text(f"version = {sys.version_info[0]}.{sys.version_info[1]}\n")
    selected = site_packages(venv)
    selected.mkdir(parents=True)
    (venv.parent / ".lease-managed").touch()
    runtime_facts_path(tree).write_text(json.dumps({"packages": {"venv": {"environment": str(venv)}}}))

    stdlib = [sysconfig.get_path("stdlib"), sysconfig.get_path("platstdlib")]
    # Activation rewrites this process's import path and environment; keep both scoped to the test.
    monkeypatch.setattr(sys, "path", [str(tree), *dict.fromkeys(stdlib), "/elsewhere/lib/site-packages"])
    monkeypatch.setenv("PYTHONPATH", "/inherited/from/the/launcher")
    monkeypatch.setenv("VIRTUAL_ENV", "/the/invoking/shell/venv")
    monkeypatch.setenv("PATH", os.environ.get("PATH", ""))

    activate_dependencies(tree)
    return tree.resolve(), str(selected), list(dict.fromkeys(stdlib))


def test_the_runtime_keeps_the_standard_library_first_for_a_shipped_tree(tmp_path, monkeypatch):
    """Critic r1 M1 (found live): activate_dependencies rebuilt sys.path with the tree first and exported PYTHONPATH.

    Review r4 (R4-02): this used to read pm/environments.py as text; it now runs the real activation and measures it."""
    import os

    tree, selected, stdlib = _activate(tmp_path, monkeypatch, shipped=True)

    # The order this process imports in: the standard library, then the verified tree, then the environment.
    assert sys.path[-2:] == [str(tree), selected]
    assert all(sys.path.index(entry) < sys.path.index(str(tree)) for entry in stdlib)
    assert "/elsewhere/lib/site-packages" not in sys.path
    # Children: an inherited PYTHONPATH would go ahead of their standard library, so a shipped runtime drops it.
    assert "PYTHONPATH" not in os.environ, (
        f"a shipped runtime left PYTHONPATH={os.environ.get('PYTHONPATH')!r} for its children")
    assert "VIRTUAL_ENV" not in os.environ


def test_a_source_tree_without_the_manifest_keeps_the_upstream_tree_first_activation(tmp_path, monkeypatch):
    """The contrast: a plain source tree keeps the upstream order and exports PYTHONPATH (tree, environment)."""
    import os

    tree, selected, stdlib = _activate(tmp_path, monkeypatch, shipped=False)

    assert sys.path[:2] == [str(tree), selected]
    assert os.environ["PYTHONPATH"] == os.pathsep.join([str(tree), selected])


def test_harden_import_path_keeps_the_standard_library_first_for_a_shipped_tree(tmp_path, monkeypatch):
    import hermes_bootstrap

    tree = tmp_path / "hermes-runtime" / "abc"
    tree.mkdir(parents=True)
    stdlib, dynload, site = "/py/lib/python3.14", "/py/lib/python3.14/lib-dynload", "/venv/lib/python3.14/site-packages"
    monkeypatch.setattr(sys, "path", ["", str(tree), stdlib, dynload, site])
    hermes_bootstrap.harden_import_path(str(tree))
    # A plain source tree: the upstream order (the tree first).
    assert sys.path == [str(tree), stdlib, dynload, site]

    (tree / SHIPPED_RUNTIME_MARKER).write_text("{}\n")
    monkeypatch.setattr(sys, "path", ["", str(tree), stdlib, dynload, site])
    hermes_bootstrap.harden_import_path(str(tree))
    assert sys.path == [stdlib, dynload, str(tree), site]


def test_the_fast_startup_path_keeps_the_standard_library_first_for_a_shipped_tree(tmp_path, monkeypatch):
    from hermes_cli import _startup_fast

    tree = tmp_path / "hermes-runtime" / "abc"
    tree.mkdir(parents=True)
    (tree / SHIPPED_RUNTIME_MARKER).write_text("{}\n")
    stdlib, site = "/py/lib/python3.14", "/venv/lib/python3.14/site-packages"
    monkeypatch.setattr(_startup_fast, "project_root_str", lambda: str(tree))
    monkeypatch.setattr(sys, "path", [stdlib, str(tree), site])
    _startup_fast.ensure_project_root_on_path()
    assert sys.path == [stdlib, str(tree), site]
