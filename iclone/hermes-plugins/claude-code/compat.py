"""Compatibility seam, and the main-turn route on every Hermes build.

Builds without the ``ProviderProfile.create_client`` hook hardcode the one external-process
provider they know (copilot-acp), so a plugin profile alone never reaches a client. Builds with
the hook call it with the client kwargs only, so the profile cannot know the agent's session.
Either way the MAIN turn is intercepted one step earlier, where the agent is in hand
(``_provider_supplied_client`` on hook builds, ``create_openai_client`` otherwise). Every wrapped
function only changes its answer for provider ``claude-code-cli``; every other provider, key,
OAuth account and custom endpoint takes the original code path untouched:

* ``hermes_cli.runtime_provider.resolve_runtime_provider`` — claude-code-cli resolves to the
  ``acp://claude-code`` runtime with a placeholder id (no API key exists for this engine);
* ``agent.agent_runtime_helpers.create_openai_client`` — that runtime gets ``ClaudeCodeClient``
  bound to the agent, whose session id is read when each call runs (Hermes builds the client in
  agent_init, before it assigns ``session_id``);
* ``agent.auxiliary_client._read_main_provider`` / ``_read_main_model`` / ``_read_main_base_url`` —
  auxiliary tasks (titles, summaries, memory) are pinned to the engine in use before Claude Code,
  so they never spawn ``claude``.

While Claude Code is the main engine, Hermes has cleared ``model.base_url``; a resolve of bare
``custom`` or of the exact slug recorded in fallback.json then gets the endpoint recorded there (the
URL only, never a key), so fallback and auxiliary turns reach the user's own endpoint and not a
default host. A recorded slug that declares its own base_url keeps it (the recorded one may be stale),
every other named custom provider keeps its own base_url and key, and a recorded
cloud provider (openrouter, anthropic, ...) never lends its URL to a custom resolve. Users without
fallback.json (they never chose Claude Code in the app) pay one stat per resolve, never a config read.
"""

from __future__ import annotations

import importlib.abc
import os
import sys
import threading
import types
from typing import Any, Callable

from .client import (
    BASE_URL,
    PROVIDER_ID,
    ClaudeCodeClient,
    _read_json,
    discover_binary,
    named_custom_base_url,
    plugin_dir,
)

_ALIASES = {PROVIDER_ID}
_PENDING: dict[str, list[Callable[[Any], None]]] = {}
_installed = False
_AUX_NAMES = ("_read_main_provider", "_read_main_model", "_read_main_base_url")
originals: dict[str, Callable[..., Any]] = {}
_fallback_cache: tuple[Any, dict[str, Any]] = (None, {})


def is_claude_code(provider: Any = None, base_url: Any = None) -> bool:
    if str(provider or "").strip().lower() in _ALIASES:
        return True
    return str(base_url or "").strip().lower().startswith(BASE_URL)


def has_native_hook() -> bool:
    from providers.base import ProviderProfile

    return callable(getattr(ProviderProfile, "create_client", None))


def _configured_provider() -> str:
    try:
        from hermes_cli.config import load_config_readonly

        model_cfg = (load_config_readonly() or {}).get("model") or {}
    except Exception:
        return ""
    return str(model_cfg.get("provider") or "").strip().lower() if isinstance(model_cfg, dict) else ""


def _fallback() -> dict[str, Any] | None:
    """fallback.json, or None when it does not exist: one stat per call, parsed again only when it changes."""
    global _fallback_cache
    path = plugin_dir() / "fallback.json"
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = (str(path), st.st_ino, st.st_mtime_ns, st.st_size)
    cached_key, data = _fallback_cache
    if cached_key != key:
        data = _read_json(path)
        _fallback_cache = (key, data)
    return data


def _url_of(data: dict[str, Any]) -> str:
    value = data.get("base_url")
    return value.strip() if isinstance(value, str) and value.strip().startswith(("http://", "https://")) else ""


def _recorded_provider(data: dict[str, Any]) -> str:
    value = data.get("provider")
    return value.strip() if isinstance(value, str) else ""


def fallback_base_url() -> str:
    data = _fallback() or {}
    # A slug that declares its own base_url keeps it: the recorded one may be stale.
    return "" if named_custom_base_url(_recorded_provider(data)) else _url_of(data)


def fallback_target() -> tuple[str, str]:
    data = _fallback() or {}
    provider = _recorded_provider(data)
    model = data.get("model") if isinstance(data.get("model"), str) else ""
    # A slug with no base_url of its own resolves through model.base_url, which is empty on Claude Code.
    if provider.lower().startswith("custom:") and fallback_base_url():
        provider = "custom"
    return provider or "nous", model


def _is_custom(provider: str) -> bool:
    return provider == "custom" or provider.startswith("custom:")


def _recorded_custom_url(wanted: str, data: dict[str, Any], module: Any = None) -> str:
    """The recorded URL, only for bare ``custom`` or the very slug it was recorded for when that slug has no
    base_url of its own; a named slug's key must never travel to another host (another slug's, a stale
    recorded one, or a recorded cloud provider's)."""
    recorded = _recorded_provider(data).lower()
    if not _is_custom(recorded) or wanted not in ("custom", recorded):
        return ""
    if wanted != "custom" and named_custom_base_url(wanted, module):
        return ""
    return _url_of(data)


def runtime_for(requested: Any) -> dict[str, Any]:
    return {
        "provider": PROVIDER_ID,
        "api_mode": "chat_completions",
        "base_url": BASE_URL,
        "api_key": PROVIDER_ID,  # placeholder id, never sent anywhere
        "command": discover_binary() or "claude",
        "args": [],
        "source": "process",
        "requested_provider": requested or PROVIDER_ID,
    }


def _patch_runtime(module: Any, *, own_engine: bool = True) -> None:
    """own_engine=False on hook builds: Hermes resolves claude-code-cli itself; only ``custom`` is helped."""
    original = module.resolve_runtime_provider
    originals["resolve_runtime_provider"] = original

    def resolve_runtime_provider(*, requested: Any = None, **kwargs: Any) -> dict[str, Any]:
        wanted = str(requested or "").strip().lower()
        if own_engine and is_claude_code(wanted):
            return runtime_for(requested)
        if (own_engine and wanted in ("", "auto")) or _is_custom(wanted):
            data = _fallback()
            if data is not None and is_claude_code(_configured_provider()):
                if wanted in ("", "auto"):
                    return runtime_for(requested)
                base_url = _recorded_custom_url(wanted, data, module)
                if base_url and not kwargs.get("explicit_base_url"):
                    kwargs["explicit_base_url"] = base_url
        return original(requested=requested, **kwargs)

    module.resolve_runtime_provider = resolve_runtime_provider


def _patch_helpers(module: Any) -> None:
    original = module.create_openai_client
    originals["create_openai_client"] = original

    def create_openai_client(agent: Any, client_kwargs: dict, *, reason: str, shared: bool) -> Any:
        if is_claude_code(getattr(agent, "provider", None), (client_kwargs or {}).get("base_url")):
            return ClaudeCodeClient(session_key=lambda: getattr(agent, "session_id", None), **(client_kwargs or {}))
        return original(agent, client_kwargs, reason=reason, shared=shared)

    module.create_openai_client = create_openai_client


def _patch_supplied(module: Any) -> None:
    """Hook builds: the main agent's client, bound to the agent so its session id is read per call."""
    original = getattr(module, "_provider_supplied_client", None)
    if not callable(original):
        _patch_helpers(module)
        return
    originals["_provider_supplied_client"] = original

    def _provider_supplied_client(agent: Any, client_kwargs: dict) -> Any:
        if is_claude_code(getattr(agent, "provider", None), (client_kwargs or {}).get("base_url")):
            return ClaudeCodeClient(session_key=lambda: getattr(agent, "session_id", None), **(client_kwargs or {}))
        return original(agent, client_kwargs)

    module._provider_supplied_client = _provider_supplied_client


def _patch_aux(module: Any) -> None:
    read_provider = module._read_main_provider
    read_model = getattr(module, "_read_main_model", None)
    originals["_read_main_provider"] = read_provider

    def _read_main_provider() -> str:
        value = read_provider()
        return fallback_target()[0] if is_claude_code(value) else value

    module._read_main_provider = _read_main_provider
    if callable(read_model):
        originals["_read_main_model"] = read_model

        def _read_main_model() -> str:
            if is_claude_code(read_provider()):
                return fallback_target()[1]
            return read_model()

        module._read_main_model = _read_main_model
    read_base_url = getattr(module, "_read_main_base_url", None)
    if callable(read_base_url):
        originals["_read_main_base_url"] = read_base_url

        def _read_main_base_url() -> str:
            if is_claude_code(read_provider()):
                return fallback_base_url()
            return read_base_url()

        module._read_main_base_url = _read_main_base_url


class _PostImport(importlib.abc.MetaPathFinder):
    """Runs the pending patch right after a target module finishes executing."""

    def find_spec(self, fullname: str, path: Any, target: Any = None) -> Any:
        if fullname not in _PENDING:
            return None
        for finder in sys.meta_path:
            if finder is self or not hasattr(finder, "find_spec"):
                continue
            spec = finder.find_spec(fullname, path, target)
            if spec is None or spec.loader is None or not hasattr(spec.loader, "exec_module"):
                continue
            run = spec.loader.exec_module

            def exec_module(module: Any, _run: Any = run, _name: str = fullname) -> None:
                _run(module)
                for patch in _PENDING.pop(_name, []):
                    patch(module)

            spec.loader.exec_module = exec_module  # type: ignore[method-assign]
            return spec
        return None


_DEFERRED: dict[str, tuple[tuple[str, ...], list[Callable[[Any], None]]]] = {}
_DEFERRED_LOCK = threading.RLock()


def _run_deferred(module: Any) -> None:
    with _DEFERRED_LOCK:
        entry = _DEFERRED.pop(object.__getattribute__(module, "__name__"), None)
        if type(module) is _PatchOnAccess:
            module.__class__ = types.ModuleType
    for patch in entry[1] if entry else ():
        patch(module)


class _PatchOnAccess(types.ModuleType):
    """A module reached mid-import (from its own import chain): patch it on the first outside access.

    Synchronous: the first ``module.attr`` / ``from module import attr`` after the patch can apply runs
    the patch before the attribute is returned. Module-internal global lookups never come here.
    """

    def __getattribute__(self, name: str) -> Any:
        if not (name.startswith("__") and name.endswith("__")):
            namespace = object.__getattribute__(self, "__dict__")
            entry = _DEFERRED.get(namespace.get("__name__", ""))
            spec = namespace.get("__spec__")
            if entry is not None and (
                not getattr(spec, "_initializing", False) or all(key in namespace for key in entry[0])
            ):
                _run_deferred(self)
        return object.__getattribute__(self, name)


def _defer(module: Any, requires: tuple[str, ...], patch: Callable[[Any], None]) -> None:
    with _DEFERRED_LOCK:
        entry = _DEFERRED.setdefault(module.__name__, (requires, []))
        entry[1].append(patch)
        if type(module) is types.ModuleType:
            module.__class__ = _PatchOnAccess


def _after_import(name: str, patch: Callable[[Any], None], requires: tuple[str, ...]) -> None:
    module = sys.modules.get(name)
    if module is not None:
        if all(hasattr(module, key) for key in requires) and not getattr(
            getattr(module, "__spec__", None), "_initializing", False
        ):
            patch(module)
        else:
            _defer(module, requires, patch)
        return
    _PENDING.setdefault(name, []).append(patch)
    if not any(isinstance(f, _PostImport) for f in sys.meta_path):
        sys.meta_path.insert(0, _PostImport())


def install() -> str:
    """Idempotent. Returns "native" when Hermes has the hook, "compat" when the seam was armed."""
    global _installed
    native = has_native_hook()
    mode = "native" if native else "compat"
    if _installed:
        return mode
    _installed = True
    if native:
        _after_import(
            "hermes_cli.runtime_provider",
            lambda module: _patch_runtime(module, own_engine=False),
            ("resolve_runtime_provider",),
        )
        _after_import("agent.agent_runtime_helpers", _patch_supplied, ("_provider_supplied_client",))
    else:
        _after_import("hermes_cli.runtime_provider", _patch_runtime, ("resolve_runtime_provider",))
        _after_import("agent.agent_runtime_helpers", _patch_helpers, ("create_openai_client",))
    _after_import("agent.auxiliary_client", _patch_aux, _AUX_NAMES)
    return mode
