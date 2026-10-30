"""V3-RT K-RT15b, driven through PM itself: ``Venv.apply`` binds a shipped runtime and leaves any other source alone.

Review r3 (R3-M1): the guard ``if (project / SHIPPED_RUNTIME_MARKER).is_file():`` in ``pm/packages.py`` opened a branch on
a security path, and the only proof cited for it read ``packages.py`` as text. These tests run the real ``Venv.apply``
(a real ``uv`` sync, offline, against a local wheel) on a source tree in tmp and assert what lands on disk:

- with ``RUNTIME_MANIFEST.json`` at the source root the new environment carries ``SOURCE_PTH`` naming the verified tree,
  the core project's editable pointer is gone, the build snapshot holds no copied package, and the environment's own
  Python imports the runtime package from the verified tree (``if False:`` on the guard turns this red);
- without the manifest the environment keeps the editable pointer and gets no ``SOURCE_PTH``;
- without the manifest, a repair over a broken live pyproject and lock still succeeds (removing the guard turns this
  red: the name would be read from the broken pyproject on every apply).

``uv`` writes the core project's editable pointer only for a packaged project, and a build backend is not reachable
offline, so the fixture project is ``package = false`` and the sync step is wrapped to add the two files ``uv`` writes
for an editable core (``__editable__.<name>-<version>.pth`` + its finder, mapping into the snapshot). Everything after
the sync, the guard and the bind included, is PM's own code."""

from __future__ import annotations

import importlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from pm.workspace import SHIPPED_RUNTIME_MARKER, SOURCE_PTH
from tests.pm._fixtures import _wheel

PROJECT = "krt-proof"
STEM = "krt_proof"
PACKAGE = "krt_runtime_probe"


@pytest.fixture
def source(tmp_path, monkeypatch):
    """A minimal app tree PM can sync from, isolated from the real home, with a real ``uv``."""
    import pm.paths as paths
    from pm.runtime import runtime_environment

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("HERMES_RUNTIME_DIR", str(tmp_path / "tools"))
    monkeypatch.delenv("HERMES_INSTALL_ROOT", raising=False)
    (tmp_path / "home").mkdir()

    repo = Path(__file__).resolve().parents[2]
    core = tmp_path / "app"
    core.mkdir()
    for name in ("hermes_bootstrap.py", "hermes_constants.py"):
        shutil.copy2(repo / name, core / name)
    shutil.copytree(repo / "pm", core / "pm", ignore=shutil.ignore_patterns("__pycache__"))
    cli = core / "hermes_cli"
    cli.mkdir()
    for name in ("__init__.py", "runtime_state.py", "_early_recovery.py", "_parser.py", "venv_sync.py", "steward.py",
                 "iclone_sinks.py", "iclone_no_upload.py"):
        shutil.copy2(repo / "hermes_cli" / name, cli / name)
    (core / PACKAGE).mkdir()
    (core / PACKAGE / "__init__.py").write_text("WHERE = 'verified'\n", encoding="utf-8")
    wheels = tmp_path / "wheels"
    wheels.mkdir()
    _wheel(wheels, "krt_dep", "1.0")
    (core / "pyproject.toml").write_text(
        f'[project]\nname="{PROJECT}"\nversion="1"\nrequires-python=">=3.11"\ndependencies=["krt-dep==1.0"]\n'
        '[tool.uv]\npackage=false\nno-index=true\noffline=true\n'
        f'find-links=[{json.dumps(wheels.as_posix())}]\n', encoding="utf-8",
    )
    uv = shutil.which("uv")
    assert uv, "these tests drive a real uv sync"
    monkeypatch.setattr(paths, "repo_root", lambda: core)
    monkeypatch.setattr("pm._uv._toolchain", lambda **kwargs: (Path(uv), Path(sys.executable)))
    monkeypatch.setattr(importlib.import_module("pm.install"), "lazy_installs_allowed", lambda: True)
    clean = {**runtime_environment(), "UV_PYTHON": sys.executable, "UV_OFFLINE": "1"}
    clean.pop("UV_NO_CONFIG", None)
    subprocess.run([uv, "lock"], cwd=core, env=clean, capture_output=True, check=True, timeout=60)

    import pm.workspace as workspace

    real_sync = workspace.lock_and_sync

    def sync_with_editable_core(*args, root, environment, **kwargs):
        real_sync(*args, root=root, environment=environment, **kwargs)
        from pm.environments import site_packages

        site = site_packages(Path(environment.executable).parent.parent)
        mapping = {PACKAGE: str(root / PACKAGE)}
        (site / f"__editable__.{STEM}-1.pth").write_text(f"import __editable___{STEM}_1_finder\n", encoding="utf-8")
        (site / f"__editable___{STEM}_1_finder.py").write_text(
            "import sys, importlib.util\n"
            f"MAPPING = {mapping!r}\n"
            "class _Finder:\n"
            "    @classmethod\n"
            "    def find_spec(cls, name, path=None, target=None):\n"
            "        if name in MAPPING:\n"
            "            return importlib.util.spec_from_file_location(name, MAPPING[name] + '/__init__.py')\n"
            "sys.meta_path.append(_Finder)\n", encoding="utf-8")

    monkeypatch.setattr(workspace, "lock_and_sync", sync_with_editable_core)
    return core


def _apply(**kwargs) -> dict:
    from pm.registry import get_package

    return get_package("venv").apply([], **kwargs)


def _imported_from(venv: Path) -> str:
    python = venv / ("Scripts/python.exe" if (venv / "Scripts").is_dir() else "bin/python")
    out = subprocess.run([str(python), "-I", "-c", f"import {PACKAGE}; print({PACKAGE}.__file__)"],
                         capture_output=True, text=True, check=True, timeout=60)
    return str(Path(out.stdout.strip()).resolve())


def test_apply_binds_a_shipped_runtime_to_the_verified_tree_and_drops_the_copy(source):
    from pm.environments import site_packages

    (source / SHIPPED_RUNTIME_MARKER).write_text("{}\n", encoding="utf-8")

    result = _apply()

    venv, snapshot = result["environment"], result["resolved_lock"].parent
    site = site_packages(venv)
    pth = site / SOURCE_PTH
    assert pth.is_file(), "a shipped runtime's environment was not bound to the verified tree"
    assert repr(str(source.resolve())) in pth.read_text(encoding="utf-8")
    assert not (site / f"__editable__.{STEM}-1.pth").exists()
    assert not (site / f"__editable___{STEM}_1_finder.py").exists()
    assert not (snapshot / PACKAGE).exists(), "the unverified copy of the runtime is still in the build snapshot"
    assert {"pyproject.toml", "uv.lock"} <= {entry.name for entry in snapshot.iterdir()}
    assert _imported_from(venv) == str((source / PACKAGE / "__init__.py").resolve())


def test_apply_leaves_a_source_without_the_manifest_on_its_editable_install(source):
    from pm.environments import site_packages

    result = _apply()

    venv, snapshot = result["environment"], result["resolved_lock"].parent
    site = site_packages(venv)
    assert not (site / SOURCE_PTH).exists()
    assert (site / f"__editable__.{STEM}-1.pth").is_file()
    assert (snapshot / PACKAGE / "__init__.py").is_file()
    assert _imported_from(venv) == str((snapshot / PACKAGE / "__init__.py").resolve())


def test_a_repair_without_the_manifest_never_reads_the_broken_live_pyproject(source):
    from pm.install import sync_venv
    from pm.plugin_inputs import Members

    sync_venv([], explicit=True, plugins=Members([]))
    (source / "pyproject.toml").write_text("broken [project\n", encoding="utf-8")
    (source / "uv.lock").write_text("broken lock [\n", encoding="utf-8")

    # The failure this guards is an exception from deep inside apply (TOMLDecodeError); it is turned into this test's
    # own assertion so the gate's mutation row can tell "the repair read the live pyproject" from a broken fixture.
    try:
        result = _apply(repair=True)
    except Exception as error:
        raise AssertionError(f"the repair read the broken live pyproject: {error!r}") from error
    assert result["environment"].is_dir()
