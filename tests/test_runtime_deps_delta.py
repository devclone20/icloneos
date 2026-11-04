"""The runtime's dependency delta from the upstream pin, named (v0.0.4 deps r4, F6).

The RT-1 inventory (apps/desktop/scripts/runtime-artifact.mjs) registers ``pyproject.toml`` and ``uv.lock`` as whole
``deps`` rows: it accepts ANY difference in those two files against ``iclone/runtime/UPSTREAM_PIN``. This test names
the difference, package by package, so a dropped dependency or an unrelated upstream delta cannot ride in under the
row. Changing either file on purpose means changing the tables below in the same commit.

What is pinned is the dependency delta (package versions, requirement entries, overrides). The 14-day age-window
exclusions (``tool.uv.exclude-newer-package``) are resolution policy, not a delta: they are added and dropped on their
own dates, so they are left out and dropping one is a one-line change.

A clone without the upstream pin commit (shallow, or the public release clone fetched by tag) cannot read the pin's
files: the tests skip and say which commit to fetch, rather than error (v0.0.4 review R2-5).
"""

from __future__ import annotations

import subprocess
import tomllib
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]

# name -> (versions at the upstream pin, versions now) in uv.lock.
LOCK_DELTA = {
    "aiohttp": ({"3.14.3"}, {"3.14.4"}),
    "brotlicffi": ({"1.2.0.2"}, {"1.2.1.0"}),
    "certifi": ({"2026.5.20"}, {"2026.10.18"}),
    "filelock": ({"3.32.4"}, {"4.2.1"}),
    "httpcore2": ({"2.7.0"}, {"2.12.0"}),
    "httpx2": ({"2.7.0"}, {"2.12.0"}),
    "httpx2-jsfetch": (set(), {"1.0"}),  # new in httpx2 2.12's own dependencies
    # opentelemetry-api 1.45 no longer depends on importlib-metadata, the only path to it and to zipp
    "importlib-metadata": ({"8.7.1"}, set()),
    "mcp": ({"2.0.0"}, {"2.2.0"}),  # GHSA-w4fh-qvv9-3v23, GHSA-5h93-6whr-6q8j, GHSA-rwrf-2pqf-9j8j, GHSA-84m7-p3x7-pcfv
    "mcp-types": ({"2.0.0"}, {"2.2.0"}),  # released with mcp, pinned exactly by it
    "msgpack": ({"1.2.1"}, {"1.2.3"}),
    "multidict": ({"6.7.1"}, {"6.9.1"}),  # GHSA-54p9-h82j-f925
    "oauthlib": ({"3.3.1"}, {"4.0.0"}),
    # GHSA-xcq7-p3pf-p88h (opentelemetry-api); the [otlp] pins move the whole stack in lockstep
    "opentelemetry-api": ({"1.39.1"}, {"1.45.1"}),
    "opentelemetry-exporter-http-transport": (set(), {"0.66b1"}),  # new in the 1.45 exporter's dependencies
    "opentelemetry-exporter-otlp-common": (set(), {"0.66b1"}),  # new in the 1.45 exporter's dependencies
    "opentelemetry-exporter-otlp-proto-common": ({"1.39.1"}, {"1.45.1"}),
    "opentelemetry-exporter-otlp-proto-http": ({"1.39.1"}, {"1.45.1"}),
    "opentelemetry-proto": ({"1.39.1"}, {"1.45.1"}),
    "opentelemetry-sdk": ({"1.39.1"}, {"1.45.1"}),
    "opentelemetry-semantic-conventions": ({"0.60b1"}, {"0.66b1"}),  # see the override below
    "pillow": ({"12.3.0"}, {"13.0.0"}),
    "pyasn1": ({"0.6.4"}, {"0.6.5"}),  # GHSA-2qm8-x737-gmw5, GHSA-mm57-4v3p-rchx, GHSA-9m75-vc3g-4x39, GHSA-fm9c-5rcf-2q5p
    "pyjwt": ({"2.13.0"}, {"2.15.0"}),
    "tornado": ({"6.5.8"}, {"6.6"}),  # GHSA-r4j5-9xpp-3985, GHSA-pcg2-g6cj-q92c, GHSA-pw9p-v7r6-gx4p
    "urllib3": ({"2.7.0"}, {"2.8.0"}),
    "yarl": ({"1.24.5"}, {"1.25.1"}),
    "zipp": ({"4.1.0"}, set()),  # see importlib-metadata
}

_PY314 = "; python_version >= '3.14'"
# pyproject.toml key -> (entries removed, entries added); a scalar key -> (before, after).
PYPROJECT_DELTA = {
    "dependency-groups.dev": (
        {"httpx2==2.7.0", "mcp==2.0.0"},
        {"httpx2==2.12.0", "mcp==2.2.0"},
    ),
    "project.dependencies": (
        {
            f"Pillow==12.3.0{_PY314}",
            f"PyJWT[crypto]==2.13.0{_PY314}",
            f"certifi==2026.5.20{_PY314}",
            f"urllib3>=2.7.0,<3{_PY314}",
        },
        {
            f"Pillow==13.0.0{_PY314}",
            f"PyJWT[crypto]==2.15.0{_PY314}",
            f"certifi==2026.10.18{_PY314}",
            f"urllib3>=2.8.0,<3{_PY314}",
        },
    ),
    "project.optional-dependencies.computer-use": (
        {"httpx2==2.7.0", "mcp==2.0.0"},
        {"httpx2==2.12.0", "mcp==2.2.0"},
    ),
    "project.optional-dependencies.google": ({"pyasn1==0.6.4"}, {"pyasn1==0.6.5"}),
    "project.optional-dependencies.matrix": (
        {"aiohttp==3.14.3; sys_platform == 'linux'"},
        {"aiohttp==3.14.4; sys_platform == 'linux'"},
    ),
    "project.optional-dependencies.mcp": (
        {"httpx2==2.7.0", "mcp==2.0.0"},
        {"httpx2==2.12.0", "mcp==2.2.0"},
    ),
    "project.optional-dependencies.messaging": (
        {"aiohttp==3.14.3", "brotlicffi==1.2.0.2"},
        {"aiohttp==3.14.4", "brotlicffi==1.2.1.0"},
    ),
    "project.optional-dependencies.otlp": (
        {
            "opentelemetry-sdk==1.39.1",
            "opentelemetry-exporter-otlp-proto-http==1.39.1",
        },
        {
            "opentelemetry-sdk==1.45.1",
            "opentelemetry-exporter-otlp-proto-http==1.45.1",
        },
    ),
    "project.optional-dependencies.slack": ({"aiohttp==3.14.3"}, {"aiohttp==3.14.4"}),
    "project.optional-dependencies.sms": ({"aiohttp==3.14.3"}, {"aiohttp==3.14.4"}),
    "project.optional-dependencies.teams": ({"aiohttp==3.14.3"}, {"aiohttp==3.14.4"}),
    # mistralai 2.4.8 caps semantic-conventions below 0.61, the OpenTelemetry 1.45.1 fix needs 0.66b1
    "tool.uv.override-dependencies": (
        set(),
        {
            f"pillow==13.0.0{_PY314}",
            "opentelemetry-semantic-conventions==0.66b1",
        },
    ),
}


def _upstream_pin() -> str:
    lines = (
        (REPO / "iclone" / "runtime" / "UPSTREAM_PIN")
        .read_text(encoding="utf-8")
        .splitlines()
    )
    return next(
        line.strip() for line in lines if line.strip() and not line.startswith("#")
    )


# Resolution policy, not dependency delta: never part of PYPROJECT_DELTA (see the module docstring).
AGE_WINDOW_PREFIX = "tool.uv.exclude-newer-package."


def _at_pin(name: str) -> dict:
    if not (REPO / ".git").exists():
        pytest.skip("not a git checkout: the upstream pin's files are read from git")
    pin = _upstream_pin()
    present = subprocess.run(
        ["git", "cat-file", "-e", f"{pin}:{name}"],
        cwd=REPO,
        capture_output=True,
        check=False,
    )
    if present.returncode != 0:
        pytest.skip(
            f"upstream pin {pin} ({name}) is not in this clone's objects "
            f"(shallow or release clone): run `git fetch origin {pin}` to check the delta"
        )
    blob = subprocess.run(
        ["git", "cat-file", "blob", f"{pin}:{name}"],
        cwd=REPO,
        capture_output=True,
        check=True,
    ).stdout
    return tomllib.loads(blob.decode("utf-8"))


def _now(name: str) -> dict:
    return tomllib.loads((REPO / name).read_text(encoding="utf-8"))


def _versions(lock: dict) -> dict[str, set[str]]:
    versions: dict[str, set[str]] = {}
    for package in lock["package"]:
        versions.setdefault(package["name"], set()).add(package.get("version", ""))
    return versions


def _flat(table: dict, prefix: str = "") -> dict:
    out = {}
    for key, value in table.items():
        if isinstance(value, dict):
            out.update(_flat(value, f"{prefix}{key}."))
        else:
            out[f"{prefix}{key}"] = value
    return out


def test_uv_lock_differs_from_the_upstream_pin_only_in_the_named_packages():
    before, after = _versions(_at_pin("uv.lock")), _versions(_now("uv.lock"))
    delta = {
        name: (before.get(name, set()), after.get(name, set()))
        for name in before.keys() | after.keys()
        if before.get(name) != after.get(name)
    }
    assert delta == LOCK_DELTA


def test_uv_lock_manifest_adds_only_the_pillow_and_semconv_overrides():
    before, after = _at_pin("uv.lock")["manifest"], _now("uv.lock")["manifest"]
    assert {
        key for key in before.keys() | after.keys() if before.get(key) != after.get(key)
    } == {"overrides"}
    added = [o for o in after["overrides"] if o not in before["overrides"]]
    removed = [o for o in before["overrides"] if o not in after["overrides"]]
    assert removed == []
    assert added == [
        {
            "name": "opentelemetry-semantic-conventions",
            "specifier": "==0.66b1",
        },
        {
            "name": "pillow",
            "marker": "python_full_version >= '3.14'",
            "specifier": "==13.0.0",
        },
    ]


def _pyproject_delta(before: dict, after: dict) -> dict:
    before, after = _flat(before), _flat(after)
    delta = {}
    for key in before.keys() | after.keys():
        old, new = before.get(key), after.get(key)
        if old == new or key.startswith(AGE_WINDOW_PREFIX):
            continue
        if isinstance(old, list) or isinstance(new, list):
            old_set, new_set = set(map(str, old or [])), set(map(str, new or []))
            delta[key] = (old_set - new_set, new_set - old_set)
        else:
            delta[key] = (old, new)
    return delta


def test_pyproject_differs_from_the_upstream_pin_only_in_the_named_entries():
    assert (
        _pyproject_delta(_at_pin("pyproject.toml"), _now("pyproject.toml"))
        == PYPROJECT_DELTA
    )


def test_dropping_an_age_window_exclusion_leaves_the_delta_unchanged():
    """Removing an age-window exclusion on its date must not change the pinned dependency delta."""
    before, after = _at_pin("pyproject.toml"), _now("pyproject.toml")
    window = after["tool"]["uv"]["exclude-newer-package"]
    assert window, "the age window has no exclusion to drop"
    for name in window:
        trimmed = {
            **after,
            "tool": {
                **after["tool"],
                "uv": {
                    **after["tool"]["uv"],
                    "exclude-newer-package": {k: v for k, v in window.items() if k != name},
                },
            },
        }
        assert _pyproject_delta(before, trimmed) == PYPROJECT_DELTA, name
    assert _pyproject_delta(before, after) == PYPROJECT_DELTA


def test_a_clone_without_the_upstream_pin_skips_and_names_the_commit(monkeypatch):
    """R2-5: a missing pin commit is a skip that says what to fetch, never a CalledProcessError."""
    pin = _upstream_pin()
    calls = []

    def missing(argv, **kwargs):
        calls.append(argv)
        if argv[:3] == ["git", "cat-file", "-e"]:
            return subprocess.CompletedProcess(
                argv, 128, b"", b"fatal: Not a valid object name"
            )
        raise subprocess.CalledProcessError(
            128, argv, b"", b"fatal: Not a valid object name"
        )

    monkeypatch.setattr(subprocess, "run", missing)
    with pytest.raises(pytest.skip.Exception) as skipped:
        _at_pin("uv.lock")
    assert pin in str(skipped.value)
    assert f"git fetch origin {pin}" in str(skipped.value)
    assert calls == [["git", "cat-file", "-e", f"{pin}:uv.lock"]]


def test_a_clone_with_the_upstream_pin_reads_its_files(monkeypatch):
    pin = _upstream_pin()
    calls = []

    def present(argv, **kwargs):
        calls.append(argv)
        out = b"version = 1\n" if argv[:3] == ["git", "cat-file", "blob"] else b""
        return subprocess.CompletedProcess(argv, 0, out, b"")

    monkeypatch.setattr(subprocess, "run", present)
    assert _at_pin("uv.lock") == {"version": 1}
    assert calls == [
        ["git", "cat-file", "-e", f"{pin}:uv.lock"],
        ["git", "cat-file", "blob", f"{pin}:uv.lock"],
    ]


# v0.0.4 review m4: the age window is left out of PYPROJECT_DELTA, so its own changes are pinned here. Each entry is
# (value at the upstream pin, value now), None meaning absent. A new `X = false` (a package let in before 14 days) or a
# changed date turns this test red until it is added here.
AGE_WINDOW_DELTA = {
    # tornado 6.6 (GHSA-r4j5-9xpp-3985, GHSA-pcg2-g6cj-q92c, GHSA-pw9p-v7r6-gx4p), admitted up to its own upload
    # time and nothing newer; the pyproject line goes after 2026-11-04T15:32Z, and this entry with it.
    "tornado": (None, "2026-10-21T15:32:00Z"),
}


def _age_window(project: dict) -> dict:
    return project.get("tool", {}).get("uv", {}).get("exclude-newer-package", {})


def test_the_age_window_differs_from_the_upstream_pin_only_in_the_pinned_exceptions():
    before = _age_window(_at_pin("pyproject.toml"))
    after = _age_window(_now("pyproject.toml"))
    delta = {
        name: (before.get(name), after.get(name))
        for name in before.keys() | after.keys()
        if before.get(name) != after.get(name)
    }
    assert delta == AGE_WINDOW_DELTA
