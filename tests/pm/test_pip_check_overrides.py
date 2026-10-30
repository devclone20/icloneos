"""`uv pip check` and the project's declared uv overrides (v0.0.4 deps r2).

A uv override replaces a dependency's own pin on purpose (pillow==13.0.0 over browser-harness's pillow==12.3.0, for the
13.0.0 security fixes); `uv pip check` still reports the requirer's pin. PM tolerates exactly that line, and only when
the installed version IS the declared exact override. Everything else stays fail-closed.

r4 (S1/S2/F4/F5): only for the environment of the project ``check()`` is asked about (its own pyproject and uv.lock),
only when the override's marker applies to the interpreter uv checked, only for a requirer that project locks and
PM does not exclude; and the declared override is the version of the direct ``Pillow==`` pin."""

from __future__ import annotations

from pathlib import Path

import pytest

from pm import environment

FRAME = ["Using Python 3.14.7 environment at: runtime", "Checked 65 packages in 37ms"]
PILLOW = (
    "The package `browser-harness` requires `pillow==12.3.0`, but `13.0.0` is installed"
)


def _pyproject(tmp_path: Path, overrides: str) -> Path:
    path = tmp_path / "pyproject.toml"
    path.write_text(
        f"[project]\nname = 'x'\n\n[tool.uv]\noverride-dependencies = [{overrides}]\n",
        encoding="utf-8",
    )
    return path


def _lock(project: Path, *names: str) -> None:
    (project / "uv.lock").write_text(
        "version = 1\n"
        + "".join(f'\n[[package]]\nname = "{n}"\nversion = "1"\n' for n in names),
        encoding="utf-8",
    )


@pytest.fixture
def declared(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """``use(overrides)`` writes the project's pyproject (and a uv.lock holding browser-harness and pillow) and
    returns the project directory to pass as ``project=``."""
    project = tmp_path / "project"
    project.mkdir()

    def use(
        overrides: str, locked: tuple[str, ...] = ("browser-harness", "pillow")
    ) -> Path:
        _pyproject(project, overrides)
        _lock(project, *locked)
        return project

    monkeypatch.setattr(environment, "venv_exclusions", lambda: ["nemo-relay"])
    return use


def _report(*lines: str) -> str:
    return "\n".join([
        *FRAME,
        f"Found {len(lines)} incompatibilit{'y' if len(lines) == 1 else 'ies'}",
        *lines,
    ])


def test_every_exact_override_the_repo_declares_is_read():
    import re
    import tomllib

    entries = tomllib.loads(environment.PROJECT_PYPROJECT.read_text(encoding="utf-8"))[
        "tool"
    ]["uv"]["override-dependencies"]
    exact = {
        (environment._pep503(m.group(1)), m.group(2))
        for m in (
            re.match(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*==\s*([^;\s]+)", entry)
            for entry in entries
        )
        if m
    }
    assert environment.declared_overrides() == exact


def test_a_mismatch_on_a_declared_exact_override_is_tolerated(declared):
    project = declared("\"pillow==13.0.0; python_version >= '3.14'\"")
    assert environment._only_excluded_missing(_report(PILLOW), project=project) == (
        True,
        "",
    )


def test_it_still_counts_with_an_excluded_missing_line(declared):
    project = declared('"Pillow==13.0.0"')
    missing = (
        "The package `hermes-agent` requires `nemo-relay>=1`, but it's not installed"
    )
    assert environment._only_excluded_missing(
        _report(PILLOW, missing), project=project
    ) == (True, "")


def _uv_pip_check(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, report: str):
    """A PythonEnvironment whose `uv pip check` exits 1 with `report` (what uv prints on an incompatibility)."""
    import subprocess

    def run(self, args, **_kwargs):
        assert args[:2] == ["pip", "check"]
        return subprocess.CompletedProcess(["uv", *args], 1, report, "")

    monkeypatch.setattr(environment.PythonEnvironment, "_run", run)
    return environment.PythonEnvironment(
        uv=tmp_path / "uv",
        python=tmp_path / "python",
        destination=tmp_path / "venv",
        cache=tmp_path / "cache",
        env={},
    )


@pytest.mark.parametrize("overrides", ["", '"pynacl==1.6.2"'])
def test_a_mismatch_with_no_override_fails_pip_check(
    declared, monkeypatch, tmp_path, overrides
):
    project = declared(overrides)
    with pytest.raises(environment.InstallError, match="dependency validation failed"):
        _uv_pip_check(monkeypatch, tmp_path, _report(PILLOW)).check(project=project)


def test_an_installed_version_that_differs_from_a_declared_exact_override_fails_pip_check(
    declared, monkeypatch, tmp_path
):
    # Declared pillow==13.0.1, installed 13.0.0: the override does not cover what is installed, so it is a real
    # mismatch.
    project = declared('"pillow==13.0.1"')
    with pytest.raises(environment.InstallError, match="dependency validation failed"):
        _uv_pip_check(monkeypatch, tmp_path, _report(PILLOW)).check(project=project)


def test_the_declared_exact_override_that_is_installed_passes_pip_check(
    declared, monkeypatch, tmp_path
):
    project = declared('"pillow==13.0.0"')
    _uv_pip_check(monkeypatch, tmp_path, _report(PILLOW)).check(project=project)


@pytest.mark.parametrize(
    "overrides", ['"pillow>=13"', '"pillow~=13.0"', '"pynacl>=1.6,<1.7"']
)
def test_a_non_exact_override_never_tolerates(declared, overrides):
    project = declared(overrides)
    tolerated, reason = environment._only_excluded_missing(
        _report(PILLOW), project=project
    )
    assert not tolerated and "line not understood" in reason


def test_an_unreadable_pyproject_declares_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(environment, "PROJECT_PYPROJECT", tmp_path / "missing.toml")
    assert environment.declared_overrides() == frozenset()
    (tmp_path / "bad.toml").write_text("[tool.uv\n", encoding="utf-8")
    assert environment.declared_overrides(tmp_path / "bad.toml") == frozenset()


def test_the_count_must_still_match(declared):
    project = declared('"pillow==13.0.0"')
    report = _report(PILLOW).replace(
        "Found 1 incompatibility", "Found 2 incompatibilities"
    )
    assert environment._only_excluded_missing(report, project=project)[0] is False


def test_a_repeated_override_line_refuses(declared):
    project = declared('"pillow==13.0.0"')
    tolerated, reason = environment._only_excluded_missing(
        _report(PILLOW, PILLOW), project=project
    )
    assert not tolerated and "repeated" in reason


# ---- r4: the requirer (S1), the project asked about (F4), the marker (S2), the direct pin (F5/S8) ----


def test_an_excluded_requirer_is_refused_even_on_a_declared_override(declared):
    project = declared(
        '"pillow==13.0.0"', locked=("browser-harness", "pillow", "nemo-relay")
    )
    line = (
        "The package `nemo-relay` requires `pillow==12.3.0`, but `13.0.0` is installed"
    )
    tolerated, reason = environment._only_excluded_missing(
        _report(line), project=project
    )
    assert not tolerated and "an excluded distribution is installed" in reason


def test_a_requirer_the_project_does_not_lock_is_refused(declared):
    project = declared('"pillow==13.0.0"', locked=("pillow",))
    tolerated, reason = environment._only_excluded_missing(
        _report(PILLOW), project=project
    )
    assert not tolerated and "does not lock" in reason


def test_an_unreadable_lock_locks_nothing(declared):
    project = declared('"pillow==13.0.0"')
    (project / "uv.lock").write_text("[[package\n", encoding="utf-8")
    assert (
        environment._only_excluded_missing(_report(PILLOW), project=project)[0] is False
    )


def test_an_environment_that_is_not_the_project_tolerates_no_override(
    declared, monkeypatch, tmp_path
):
    # PM's own pyproject declaring the override does not reach a check() made without the project.
    project = declared('"pillow==13.0.0"')
    monkeypatch.setattr(environment, "PROJECT_PYPROJECT", project / "pyproject.toml")
    assert environment._only_excluded_missing(_report(PILLOW))[0] is False
    with pytest.raises(environment.InstallError, match="dependency validation failed"):
        _uv_pip_check(monkeypatch, tmp_path, _report(PILLOW)).check()


def test_another_projects_override_is_not_read(declared, tmp_path):
    declared('"pillow==13.0.0"')
    other = tmp_path / "other"
    other.mkdir()
    _pyproject(other, "")
    _lock(other, "browser-harness", "pillow")
    assert (
        environment._only_excluded_missing(_report(PILLOW), project=other)[0] is False
    )


def test_a_report_without_the_checked_interpreter_tolerates_no_override(declared):
    project = declared('"pillow==13.0.0"')
    report = _report(PILLOW).replace(
        "Using Python 3.14.7 environment at: runtime\n", ""
    )
    assert environment._only_excluded_missing(report, project=project)[0] is False


@pytest.mark.parametrize(
    "marker",
    [
        "sys_platform == 'never'",
        "python_version >= '3.15'",
        "python_version < '3.14'",
        "not a marker",
    ],
)
def test_an_override_whose_marker_does_not_apply_is_refused(
    declared, monkeypatch, tmp_path, marker
):
    project = declared(f'"pillow==13.0.0; {marker}"')
    with pytest.raises(environment.InstallError, match="dependency validation failed"):
        _uv_pip_check(monkeypatch, tmp_path, _report(PILLOW)).check(project=project)


def test_an_override_whose_marker_applies_to_the_checked_interpreter_is_tolerated(
    declared, monkeypatch, tmp_path
):
    project = declared("\"pillow==13.0.0; python_version >= '3.14'\"")
    _uv_pip_check(monkeypatch, tmp_path, _report(PILLOW)).check(project=project)
    # The same project, checked on a 3.13 interpreter: the marker is false there.
    older = _report(PILLOW).replace("Python 3.14.7", "Python 3.13.9")
    assert environment._only_excluded_missing(older, project=project)[0] is False


def _direct_exact_pins() -> dict[str, str]:
    import re
    import tomllib

    project = tomllib.loads(environment.PROJECT_PYPROJECT.read_text(encoding="utf-8"))[
        "project"
    ]
    pins = {}
    for entry in project["dependencies"]:
        if m := re.match(
            r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*==\s*([^;\s]+)", entry
        ):
            pins[environment._pep503(m.group(1))] = m.group(2)
    return pins


def test_the_pillow_override_is_the_direct_pillow_pin():
    """F5/S8: drop the override, or bump ``Pillow==`` without it, and this goes red (uv would silently resolve the
    override over the project's own pin)."""
    overrides = dict(environment.declared_overrides())
    direct = _direct_exact_pins()
    assert overrides.get("pillow") == "13.0.0"
    assert direct.get("pillow") == overrides["pillow"]
    # Every exact override that is also a direct exact pin names the same version.
    for name in overrides.keys() & direct.keys():
        assert overrides[name] == direct[name], name


def test_the_real_uv_report_of_the_project_venv_is_tolerated(monkeypatch, tmp_path):
    """The report uv 0.12 printed for the v0.0.4 runtime venv (r4 evidence real_uv_pip_check.txt), read against the
    repo's own pyproject.toml and uv.lock."""
    repo = environment.PROJECT_PYPROJECT.parent
    report = "\n".join([
        "Using Python 3.14.7 environment at: runtime/venv",
        "Checked 114 packages in 2ms",
        "Found 1 incompatibility",
        PILLOW,
    ])
    assert environment._only_excluded_missing(report, project=repo) == (True, "")
    _uv_pip_check(monkeypatch, tmp_path, report).check(project=repo)
