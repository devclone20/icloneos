"""G-01 R4-1: a failed venv sync names the venv on every ✗ line it prints.

The venv sync is the most common real first-launch failure (a proxy in front of
uv, a wheel that will not build). The desktop overlay fails a row only by the
``<name>:`` its ✗ line carries, so both the contained uv tail and the error PM
prints after it must start with ``venv:``. The exact output is pinned in a
fixture the overlay's reducer test replays, so the two sides cannot drift.
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

from pm import cli
from pm.environment import _UV_LABELS, classify_uv_failure
from pm.progress import LiveTail, failure_owner

FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "apps"
    / "desktop"
    / "src"
    / "iclone-shared"
    / "__fixtures__"
    / "venv-sync-failure.txt"
)

UV_OUTPUT = (
    "Resolved 212 packages in 1.21s\n"
    "  × Failed to build `pyaudio==0.2.14`\n"
    "  ├─▶ The build backend returned an error\n"
    "  ╰─▶ Call to `setuptools.build_meta.build_wheel` failed (exit status: 1)\n"
    "      src/pyaudio/device_api.c:9:10: fatal error: 'portaudio.h' file not found\n"
)


def _failing_sync(*_args, **_kwargs):
    # What pm.environment does for `uv sync` off a terminal: a contained tail, then the classified error.
    tail = LiveTail(_UV_LABELS["sync"], sys.stdout, indent="  ")
    tail.write(UV_OUTPUT)
    tail.close(False)
    raise classify_uv_failure("sync", 1, UV_OUTPUT)


def _failure_lines(out: str) -> list[str]:
    return [line.strip() for line in out.splitlines() if line.lstrip().startswith("✗ ")]


def test_install_names_the_venv_on_every_failure_line_and_matches_the_overlay_fixture(
    monkeypatch, capsys
):
    monkeypatch.setattr("pm.install.sync_venv", _failing_sync)

    assert cli._install_python_environments([], sync=True, test_environment=None) == 1

    out = capsys.readouterr().out
    failures = _failure_lines(out)
    assert len(failures) == 2
    assert all(line.startswith("✗ venv: ") for line in failures), failures
    assert out == FIXTURE.read_text(encoding="utf-8")


def test_update_names_the_venv_too(monkeypatch, capsys):
    monkeypatch.setattr("pm.install.sync_venv", _failing_sync)

    assert cli._sync_venv_step() is False

    failures = _failure_lines(capsys.readouterr().out)
    assert len(failures) == 2
    assert all(line.startswith("✗ venv: ") for line in failures), failures


def test_the_owner_is_scoped_to_its_block_and_an_explicit_owner_wins():
    out = io.StringIO()
    with failure_owner("venv"):
        inside = LiveTail("Installing Python dependencies", out)
        explicit = LiveTail("Pruning the uv cache", out, owner="uv")
    outside = LiveTail("Resolving Python dependencies", out)
    for tail in (inside, explicit, outside):
        tail.close(False)

    assert _failure_lines(out.getvalue()) == [
        "✗ venv: Installing Python dependencies failed",
        "✗ uv: Pruning the uv cache failed",
        "✗ Resolving Python dependencies failed",
    ]
