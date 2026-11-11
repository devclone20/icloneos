"""Discovery shim: tools.registry auto-imports ``tools/*.py``, so this top-level
module registers ``computer_use`` for the ``tools/computer_use/`` package."""

from __future__ import annotations

import json
import re

from tools.computer_use.schema import COMPUTER_USE_SCHEMA
from tools.computer_use.tool import (
    check_computer_use_requirements, handle_computer_use, release_computer_use_session, set_approval_callback,
)
from tools.registry import registry


_PERMISSION_WORDS = re.compile(r"(accessibility|screen.?recording)\W(\w+\W+){0,6}(not|denied|grant|required|missing|permission)"
                               r"|(not|denied|grant|required|missing|permission)\W(\w+\W+){0,6}(accessibility|screen.?recording)", re.IGNORECASE)


def _with_what_to_do(result):
    """S10: a refusal for a missing macOS permission names exactly what to do, under icloneOS, in every state."""
    from tools.computer_use import cua_backend_driver as driver
    if not isinstance(result, str) or not driver.icloneos_started() or not _PERMISSION_WORDS.search(result):
        return result
    try:
        parsed = json.loads(result)
    except ValueError:
        return result
    if not isinstance(parsed, dict) or parsed.get("ok") is True:
        return result
    return json.dumps({**parsed, "what_to_do": driver._door_module().PERMISSION})


registry.register(
    name="computer_use",
    toolset="computer_use",
    schema=COMPUTER_USE_SCHEMA,
    handler=lambda args, **kw: _with_what_to_do(handle_computer_use(args, **kw)),
    check_fn=check_computer_use_requirements,
    requires_env=[],
    description=(
        "Universal desktop control via cua-driver (macOS, Windows, Linux). Works with any "
        "tool-capable model (Anthropic, OpenAI, OpenRouter, local vLLM, "
        "etc.). Background computer-use: does NOT steal the user's cursor "
        "or keyboard focus."
    ),
)


__all__ = ["handle_computer_use", "release_computer_use_session", "set_approval_callback", "check_computer_use_requirements"]
