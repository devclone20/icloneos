"""Claude Code provider profile — the USER's own `claude` CLI as an optional Hermes engine.

Installed by the iclone os desktop app into ``$HERMES_HOME/plugins/model-providers/claude-code/``.
Additive: it registers one more provider (id ``claude-code-cli``) and changes nothing about the existing ones. Hermes
builds that ship the ``ProviderProfile.create_client`` hook use it directly; older builds get the
narrow, claude-code-only compatibility seam in ``compat.py``.
"""

from __future__ import annotations

import dataclasses
from typing import Any

from providers import register_provider
from providers.base import ProviderProfile

from . import compat
from .client import BASE_URL, MODELS, PROVIDER_ID, ClaudeCodeClient, auth_status, discover_binary


class ClaudeCodeProfile(ProviderProfile):
    """Claude Code — external process, the CLI owns auth."""

    def create_client(self, **client_kwargs: Any) -> Any:
        # The main turn never reaches this hook (compat.py binds it to the agent first); what does is an
        # auxiliary route (titles, compression, memory), answered by the fallback engine without `claude`.
        return ClaudeCodeClient(auxiliary=True, **client_kwargs)

    def fetch_models(self, *, api_key: str | None = None, base_url: str | None = None, timeout: float = 8.0):
        return list(MODELS)

    def setup_status(self) -> dict[str, Any]:
        binary = discover_binary()
        login = auth_status(binary) if binary else {"loggedIn": False}
        return {
            "available": bool(binary),
            "logged_in": bool(login.get("loggedIn")),
            "login_command": "claude auth login",
        }


def _profile_kwargs() -> dict[str, Any]:
    wanted: dict[str, Any] = {
        "name": PROVIDER_ID,
        "aliases": (),  # "claude"/"claude-code" already name the anthropic provider
        "display_name": "Claude Code (your subscription)",
        "api_mode": "chat_completions",
        "env_vars": (),
        "base_url": BASE_URL,
        "auth_type": "external_process",
        "fallback_models": MODELS,
        "process_command": "claude",
        "process_command_env_vars": ("ICLONE_CLAUDE_BIN",),
    }
    known = {f.name for f in dataclasses.fields(ProviderProfile)} if dataclasses.is_dataclass(ProviderProfile) else set(wanted)
    return {key: value for key, value in wanted.items() if key in known}


claude_code = ClaudeCodeProfile(**_profile_kwargs())
register_provider(claude_code)
compat.install()
