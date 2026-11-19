"""The guard that keeps a MagicMock path from creating ``MagicMock/...`` in the repository (v0.0.9 G smoke, 18 Nov)."""

import os
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from tests._fixtures import mock_path_guard


@pytest.mark.allow_mock_paths
def test_a_mock_home_cannot_create_a_directory_in_the_working_directory(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    mock = MagicMock()
    home = mock.get_process_hermes_home()
    with pytest.raises(AssertionError, match="a mock was used as a path"):
        (Path(home) / "state.db").parent.mkdir(parents=True, exist_ok=True)
    assert not (tmp_path / "MagicMock").exists()


@pytest.mark.allow_mock_paths
def test_makedirs_is_refused_too(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with pytest.raises(AssertionError):
        os.makedirs(MagicMock())
    assert not (tmp_path / "MagicMock").exists()


def test_real_relative_and_absolute_paths_are_untouched(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    os.makedirs("Mocking/real")
    os.mkdir(tmp_path / "MagicMockish")
    assert (tmp_path / "Mocking" / "real").is_dir() and (tmp_path / "MagicMockish").is_dir()
    assert mock_path_guard.is_mock_path("MagicMock")  # makedirs creates this parent first
    assert mock_path_guard.is_mock_path("MagicMock/mock.x()/123")
    assert not mock_path_guard.is_mock_path(str(tmp_path / "MagicMock" / "a"))
