"""A model that takes no images, under the Seatbelt: the frames reach vision_analyze through the bytes path.

The Seatbelt backend is not "local" to tools/image_source.py, so a host read is allowed only inside a media cache root.
The data URL of a native image part used to land in the system temp folder, outside every root, and the description
came back as "not reachable inside the sandbox".
"""
import asyncio
import base64

import pytest

from agent.vision_message_prep import VisionMessagePrepMixin
from tools.image_source import ImageResolutionError, ResolveContext, resolve_image_source

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


@pytest.fixture
def seatbelt(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("TERMINAL_ENV", "iclone_seatbelt")
    return tmp_path


def _read(path):
    return asyncio.run(resolve_image_source(str(path), ResolveContext(task_id=None)))


def test_a_data_url_is_readable_by_vision_under_the_seatbelt(seatbelt):
    url = "data:image/png;base64," + base64.b64encode(PNG).decode()
    path, cleanup = VisionMessagePrepMixin._materialize_data_url_for_vision(url)
    try:
        assert _read(path).data == PNG
    finally:
        cleanup.unlink()


def test_a_staged_composer_image_is_readable_by_vision_under_the_seatbelt(seatbelt):
    staged = seatbelt / "images" / "frame.png"
    staged.parent.mkdir()
    staged.write_bytes(PNG)
    assert _read(staged).data == PNG


def test_any_other_host_path_stays_refused_under_the_seatbelt(seatbelt, tmp_path_factory):
    outside = tmp_path_factory.mktemp("outside") / "frame.png"
    outside.write_bytes(PNG)
    with pytest.raises(ImageResolutionError):
        _read(outside)
