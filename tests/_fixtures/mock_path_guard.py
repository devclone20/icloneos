"""A mock used as a path must never reach the file system.

``MagicMock`` implements ``__fspath__`` as ``MagicMock/<mock name>/<id>``: handed to ``os.mkdir`` (directly, through
``Path.mkdir`` or ``os.makedirs``) it makes a *relative* directory in the current working directory, which is the
repository root under the suite. The v0.0.9 G smoke (18 Nov) found ``MagicMock/mock.get_process_hermes_home()/<id>/state.db``
left in the tree. This guard turns that into a failure of the test that did it, at the call site, instead of a dirty tree
found a run later. Tests that need a home use ``tmp_path`` or the ``_hermetic_environment`` home.
"""

from __future__ import annotations

import os

import pytest

_MOCK_ROOTS = ("MagicMock", "NonCallableMagicMock", "AsyncMock", "NonCallableMock", "PropertyMock")


def is_mock_path(path: object) -> bool:
    """True for a relative path that a ``unittest.mock`` object produced through ``__fspath__``."""
    try:
        text = os.fspath(path)  # type: ignore[arg-type]
    except TypeError:
        return False
    if isinstance(text, bytes):
        text = os.fsdecode(text)
    first = text.replace("\\", "/").split("/", 1)[0]
    return not os.path.isabs(text) and first in _MOCK_ROOTS


def install(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Patch ``os.mkdir`` so a mock-derived path raises AssertionError; returns the list of refused paths."""
    refused: list[str] = []
    real_mkdir = os.mkdir

    def guarded(path, *args, **kwargs):
        if is_mock_path(path):
            refused.append(os.fspath(path))
            raise AssertionError(
                f"a mock was used as a path and would create {os.fspath(path)!r} in the working directory: "
                "give the code under test a real tmp_path instead of a MagicMock home"
            )
        return real_mkdir(path, *args, **kwargs)

    monkeypatch.setattr(os, "mkdir", guarded)
    return refused


@pytest.fixture(autouse=True)
def _no_mock_paths_on_disk(monkeypatch, request):
    refused = install(monkeypatch)
    yield
    if refused and not request.node.get_closest_marker("allow_mock_paths"):
        pytest.fail(f"a mock-derived path reached os.mkdir (swallowed in the test): {refused[:3]}", pytrace=False)
