"""iclone-seam: v3fx-sinks — ruling 57: in v0.0.3 telemetry is removed, not configured (ruling 54 kept as a check).

1. No enable path (57.1): under the managed env (``under_icloneos``) ``sink_allowed`` is False for every sink, whatever
   config.yaml, .env, a vault or the process env says. There is no owner value in v0.0.3 (an env-carried one can be
   forged by any child), so nothing here reads one.
2. Not shipped beats switched off (57.2): ``TELEMETRY_DISTRIBUTIONS``, ``ANALYTICS_HOSTS`` and ``OTLP_SERVICE_PATHS``
   are the denylist the packaging gate (iclone/telemetry/venv_gate.py) applies to the shipped runtime venv, and the
   package manager refuses any extra whose resolved dependencies include one (``extras_refusal``, pm.install). Code that imports a missing exporter fails closed (no sink).
3. Destination variables stripped (57.4): ``reseal_environ`` re-applies the telemetry-off values after every .env or
   vault load and removes every variable that could redirect traffic (``DESTINATION_ENV_KEYS`` /
   ``DESTINATION_ENV_PATTERN``; ``NO_PROXY`` pinned to ``*``) — the same lists the app's main applies to every child
   (apps/desktop/electron/iclone-telemetry-seal.ts; a test keeps both equal).
4. The registry (57.5): ``SINKS`` and ``REFERENCES`` document every module, plugin or child tool that could send
   telemetry; the enumeration test (tests/hermes_cli/test_iclone_sinks.py) scans the tree with ``scan_tree`` and fails
   on any sink-shaped file in neither. It is one more check, not the proof (an obfuscated import defeats any scan).
"""

from __future__ import annotations

import fnmatch
import os
import re
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, MutableMapping, Optional, Set

from hermes_cli.iclone_no_upload import under_icloneos

# ── 3. the env seal ──────────────────────────────────────────────────────────────────────────────────────────────────
TELEMETRY_OFF_ENV: Dict[str, str] = {
    "CUA_DRIVER_RS_TELEMETRY_ENABLED": "0",
    "CUA_TELEMETRY_ENABLED": "0",
    "ANONYMIZED_TELEMETRY": "false",
    "PHOTON_TELEMETRY": "0",
    "VERCEL_TELEMETRY_DISABLED": "1",
    "DO_NOT_TRACK": "1",
    "HF_HUB_DISABLE_TELEMETRY": "1",
    "DISABLE_TELEMETRY": "1",
    "DISABLE_ERROR_REPORTING": "1",
    "CLAUDE_CODE_ENABLE_TELEMETRY": "0",
    "NEXT_TELEMETRY_DISABLED": "1",
    "NUXT_TELEMETRY_DISABLED": "1",
    "ASTRO_TELEMETRY_DISABLED": "1",
    "GATSBY_TELEMETRY_DISABLED": "1",
    "DOTNET_CLI_TELEMETRY_OPTOUT": "1",
    "AZURE_CORE_COLLECT_TELEMETRY": "0",
    "CHECKPOINT_DISABLE": "1",
    "SCARF_ANALYTICS": "false",
    "GRADIO_ANALYTICS_ENABLED": "False",
    "LANGCHAIN_TRACING_V2": "false",
    "LANGSMITH_TRACING": "false",
    "MEM0_TELEMETRY": "False",
    "POSTHOG_DISABLED": "1",
    "OTEL_SDK_DISABLED": "true",
    "BH_TELEMETRY": "0",
    "BROWSER_HARNESS_TELEMETRY": "0",
    # Ruling 63 (r7, FX_sink_audit A1/A7/B): third-party opt-outs, set OFF for every child — one closed table.
    "TURBO_TELEMETRY_DISABLED": "1",
    "WRANGLER_SEND_METRICS": "false",
    "HOMEBREW_NO_ANALYTICS": "1",
    "STRIPE_CLI_TELEMETRY_OPTOUT": "1",
    "SAM_CLI_TELEMETRY": "0",
    "YARN_ENABLE_TELEMETRY": "0",
    "EXPO_NO_TELEMETRY": "1",
    "STORYBOOK_DISABLE_TELEMETRY": "1",
    "CLOUDSDK_CORE_DISABLE_USAGE_REPORTING": "true",
    "GOTELEMETRY": "off",
    "GH_TELEMETRY": "false",
    "HF_XET_TELEMETRY_ENABLED": "0",
    "MISTRAL_SDK_TELEMETRY": "false",
}

# Variables that carry a destination (a proxy, a collector, an SDK host): removed from every sealed env.
DESTINATION_ENV_KEYS: tuple = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "FTP_PROXY",
    "GRPC_PROXY",
    "SOCKS_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "ftp_proxy",
    "grpc_proxy",
    "socks_proxy",
    "HERMES_NEMO_RELAY_PLUGINS_TOML",
    "SENTRY_DSN",
    "BH_POSTHOG_HOST",
    "MISTRAL_OTLP_TRACES_ENDPOINT",
    "SEGMENT_WRITE_KEY",
)
DESTINATION_ENV_PATTERN = (
    r"^(?:OTEL_EXPORTER_\w+|ICLONE_\w*(?:ENDPOINT|BASE_URL)|(?:HERMES_)?LANGFUSE_\w+|"
    r"(?:POSTHOG|SENTRY|DD|DATADOG|HONEYCOMB|SEGMENT|MIXPANEL|AMPLITUDE|LANGSMITH|LANGCHAIN|LOGFIRE|WANDB|AGENTOPS|"
    r"PHOENIX|TRACELOOP|OPIK|BRAINTRUST|NEW_RELIC|ELASTIC_APM|BUGSNAG|ROLLBAR|NEMO_RELAY|HERMES_NEMO_RELAY)_\w*"
    r"(?:HOST|URL|ENDPOINT|DSN|SITE|TOML|COLLECTOR)|(?![Nn][Oo]_[Pp][Rr][Oo][Xx][Yy]$)[A-Za-z0-9_]*_[Pp][Rr][Oo][Xx][Yy](?:_[Uu][Rr][Ll])?)$"
)
_DESTINATION = re.compile(DESTINATION_ENV_PATTERN)
# NO_PROXY handling: pinned to "*" so a proxy that reaches a child anyway is bypassed by every library that reads it —
# unless the user's own proxy came from main (below), which is then kept exactly as main passed it.
DESTINATION_PINNED_ENV: Dict[str, str] = {"NO_PROXY": "*", "no_proxy": "*"}
# The user's own proxy (main's env at app start, a listed non-telemetry reason: reaching the model provider). The app
# passes exactly these to Hermes; an .env, a vault or config never sets one.
USER_PROXY_ENV_KEYS: tuple = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
                              "http_proxy", "https_proxy", "all_proxy", "no_proxy")
# Main passes the user's proxy EXPLICITLY in this one variable (JSON of USER_PROXY_ENV_KEYS, captured at app start;
# apps/desktop/electron/iclone-spawn-env.ts). A proxy is never inferred from the current env, which a child can forge.
USER_PROXY_CHANNEL = "ICLONE_USER_NETWORK"
_MAIN_PROXIES: Optional[Dict[str, str]] = None
_MAIN_CHANNEL: Optional[str] = None


def snapshot_main_proxies(env: Optional[Mapping[str, str]] = None) -> None:
    """The user's proxy as main passed it on ICLONE_USER_NETWORK, taken once, before any .env or vault load (a
    dotenv never sets ICLONE_*: env_loader._restore_iclone_spawn_env). Anything malformed counts as no proxy."""
    global _MAIN_PROXIES, _MAIN_CHANNEL
    if _MAIN_PROXIES is not None:
        return
    source = os.environ if env is None else env
    raw = source.get(USER_PROXY_CHANNEL) or ""
    proxies: Dict[str, str] = {}
    try:
        import json

        parsed = json.loads(raw) if raw else {}
        if isinstance(parsed, dict):
            proxies = {k: v for k, v in parsed.items() if k in USER_PROXY_ENV_KEYS and isinstance(v, str)}
    except ValueError:
        proxies = {}
    _MAIN_PROXIES, _MAIN_CHANNEL = proxies, (raw if proxies else None)


def is_destination_key(key: str) -> bool:
    return key in DESTINATION_ENV_KEYS or bool(_DESTINATION.match(key))


# ── 2. the denylist the packaging gate and pm apply (PEP 503 names, fnmatch globs) ───────────────────
TELEMETRY_DISTRIBUTIONS: tuple = (
    "nemo-relay",
    "opentelemetry-exporter-*",
    "opentelemetry-proto",
    "langfuse",
    "posthog",
    "sentry-sdk",
    "segment-analytics-python",
    "analytics-python",
    "mixpanel",
    "amplitude-analytics",
    "ddtrace",
    "datadog",
    "datadog-api-client",
    "libhoney",
    "honeycomb-beeline",
    "langsmith",
    "logfire",
    "wandb",
    "traceloop-sdk",
    "agentops",
    "helicone",
    "braintrust",
    "opik",
    "arize-phoenix*",
    "openinference-*",
    "bugsnag",
    "rollbar",
    "newrelic",
    "elastic-apm",
    "scout-apm",
)
ANALYTICS_HOSTS: tuple = (
    "posthog.com",
    "sentry.io",
    "segment.io",
    "segment.com",
    "mixpanel.com",
    "amplitude.com",
    "datadoghq.com",
    "datadoghq.eu",
    "browser-intake-datadoghq.com",
    "honeycomb.io",
    "langfuse.com",
    "smith.langchain.com",
    "logfire-api.pydantic.dev",
    "api.wandb.ai",
    "agentops.ai",
    "google-analytics.com",
    "googletagmanager.com",
    "pulse.walletconnect.org",
    "telemetry.nousresearch.com",
    "cca-lite.coinbase.com",
    "analytics-service-dev.cbhq.net",
    "sentry.hcaptcha.com",
    "as.coinbase.com",
    "analytics-service-internal.cbhq.net",
    "analytics-service-internal-dev.cbhq.net",
)
OTLP_SERVICE_PATHS: tuple = (
    "opentelemetry.proto.collector.trace.v1.TraceService",
    "opentelemetry.proto.collector.metrics.v1.MetricsService",
    "opentelemetry.proto.collector.logs.v1.LogsService",
    "/v1/traces",
    "/v1/metrics",
    "/v1/logs",
    "telemetry/v1/telemetry",
    "envelope/?sentry_version",
)


def normalize_distribution(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def distribution_denied(name: str) -> bool:
    norm = normalize_distribution(name)
    return any(fnmatch.fnmatchcase(norm, glob) for glob in TELEMETRY_DISTRIBUTIONS)


def locked_closure(extras: Iterable[str], lock_path: Optional[Path] = None) -> Optional[Set[str]]:
    """Every distribution the requested hermes-agent extras pull in, resolved from uv.lock — the exact resolution the
    package manager (pm) installs from. None when the lock cannot be read or an extra is unknown."""
    try:
        import tomllib

        lock = tomllib.loads((lock_path or Path(__file__).resolve().parents[1] / "uv.lock").read_text())
        packages = {normalize_distribution(p["name"]): p for p in lock["package"]}
        optional = packages["hermes-agent"].get("optional-dependencies", {})
        todo: List[tuple] = []  # (name, extras of that name requested)
        for extra in extras:
            if extra not in optional:
                return None
            todo += [(normalize_distribution(d["name"]), tuple(d.get("extra", ()))) for d in optional[extra]]
        seen: Set[str] = set()
        expanded: Set[tuple] = set()
        while todo:
            name, wanted = todo.pop()
            if (name, wanted) in expanded:
                continue
            expanded.add((name, wanted))
            package = packages.get(name, {})
            # hermes-agent itself is the base install (RT's job, with the exclusion list); only its extras count here.
            deps = [] if name == "hermes-agent" else list(package.get("dependencies", []))
            if name != "hermes-agent":
                seen.add(name)
            for extra in wanted:  # a dependency's own extras, when the requirement names them
                deps += package.get("optional-dependencies", {}).get(extra, [])
            todo += [(normalize_distribution(d["name"]), tuple(d.get("extra", ()))) for d in deps]
        return seen
    except Exception:
        return None


# Ruling 57.2: never installed into the runtime venv — by RT's build AND by every pm sync (pm/environment.py passes
# ``--no-install-package`` for each). iclone/telemetry/runtime-venv-exclusions.txt mirrors it (a test keeps them equal).
RUNTIME_VENV_EXCLUSIONS: tuple = (
    "langfuse",
    "nemo-relay",
    "opentelemetry-exporter-otlp-proto-common",
    "opentelemetry-exporter-otlp-proto-http",
    "opentelemetry-proto",
)


def _lock_packages(lock_path: Path) -> Dict[str, dict]:
    import tomllib

    lock = tomllib.loads(Path(lock_path).read_text())
    return {normalize_distribution(p["name"]): p for p in lock["package"]}


def sync_exclusions(lock_path: Optional[Path]) -> List[str]:
    """Under icloneOS, every distribution a pm sync must not install: the exclusion list plus every denylisted
    package the lock being synced holds (a plugin or an extra can bring a new one). [] for plain Hermes."""
    if not under_icloneos():
        return []
    names = set(RUNTIME_VENV_EXCLUSIONS)
    try:
        names |= {n for n in _lock_packages(lock_path) if distribution_denied(n)} if lock_path else set()
    except Exception:
        pass  # the exclusion list still applies; the refusals below fail closed on an unreadable lock
    return sorted(names)


def plugin_requirements_refusal(lock_path: Path, root_project: str = "hermes-agent") -> List[str]:
    """Under icloneOS, the denylisted distributions the workspace's plugin members pull in (their RESOLVED closure in
    the generated lock), or a reason when the lock cannot be read. [] = allowed."""
    if not under_icloneos():
        return []
    try:
        packages = _lock_packages(lock_path)
    except Exception:
        return ["(the workspace lock could not be read to check plugin requirements)"]
    root = normalize_distribution(root_project)
    members = [n for n, p in packages.items()
               if n != root and isinstance(p.get("source"), dict) and ({"editable", "virtual", "directory"} & set(p["source"]))]
    seen: Set[str] = set()
    todo = [(normalize_distribution(d["name"]), tuple(d.get("extra", ()))) for m in members
            for d in packages[m].get("dependencies", [])]
    expanded: Set[tuple] = set()
    while todo:
        name, wanted = todo.pop()
        if (name, wanted) in expanded or name == root:
            continue
        expanded.add((name, wanted))
        seen.add(name)
        package = packages.get(name, {})
        deps = list(package.get("dependencies", []))
        for extra in wanted:
            deps += package.get("optional-dependencies", {}).get(extra, [])
        todo += [(normalize_distribution(d["name"]), tuple(d.get("extra", ()))) for d in deps]
    return sorted(n for n in seen if distribution_denied(n))


def extras_refusal(extras: Optional[Iterable[str]], lock_path: Optional[Path] = None) -> List[str]:
    """Under icloneOS, why installing *extras* is refused: a telemetry distribution among their RESOLVED dependencies
    (uv.lock), or a resolution that cannot be read (fail closed). [] = allowed (and always [] for plain Hermes)."""
    if not extras or not under_icloneos():
        return []
    closure = locked_closure(list(extras), lock_path)
    if closure is None:
        return ["(the requested extras could not be resolved from uv.lock to check them)"]
    return sorted(name for name in closure if distribution_denied(name))


# ── 4. the registry ──────────────────────────────────────────────────────────────────────────────────────────────────
SINKS: Dict[str, Dict[str, object]] = {
    "otlp-traces": {
        "files": ["agent/monitoring/otlp_exporter.py"],
        "kind": "OpenTelemetry span export (OTLP proto-http, requests/urllib3)",
        "denied_by": "sink_allowed is False under icloneOS; exporter distributions not shipped; no SDK install",
    },
    "otlp-gateway-health": {
        "files": ["agent/monitoring/gateway_health_export.py"],
        "kind": "OpenTelemetry metrics and diagnostic logs (OTLP proto-http)",
        "denied_by": "sink_allowed is False under icloneOS in _enabled, the metric provider and the log streamer",
    },
    "langfuse": {
        "files": ["plugins/observability/langfuse/__init__.py"],
        "kind": "Langfuse trace export (full turns)",
        "denied_by": "sink_allowed is False under icloneOS before the client is built; langfuse not shipped",
    },
    "nemo-relay": {
        "files": ["agent/relay_runtime.py"],
        "kind": "NeMo Relay plugins: native OTLP (http/grpc), ATOF stream sinks and ATIF storage (critic r5 M1)",
        "denied_by": "nemo-relay not shipped (ImportError -> NoopRelayRuntime); _configured_plugin_inputs is None "
        "under icloneOS; HERMES_NEMO_RELAY_PLUGINS_TOML stripped from every sealed env",
    },
    "shared-metrics": {
        "files": ["hermes_cli/observability/shared_metrics_sender.py",
                  "hermes_cli/observability/shared_metrics_send_config.py"],
        "kind": "shared-metrics packages POSTed to telemetry.nousresearch.com (upstream 1ac3f97)",
        "denied_by": "resolve_send_config: send=False under icloneOS whatever config says; _post refuses; the host is "
        "blocked in every app session",
    },
    "debug-share": {
        "files": ["hermes_cli/debug.py", "hermes_cli/diagnostics_upload.py"],
        "kind": "debug report and logs to paste.rs / dpaste.com / Nous storage",
        "denied_by": "iclone_no_upload: every upload, delete and sweep refused under icloneOS",
    },
    "cua-driver": {
        "files": ["tools/computer_use/cua_backend.py"],
        "kind": "cua-driver product telemetry (PostHog), a child tool",
        "denied_by": "CUA_DRIVER_RS_TELEMETRY_ENABLED=0 always under icloneOS (_cua_telemetry_disabled) + the env seal",
    },
    "browser-use": {
        "files": ["tools/browser_use_cli.py"],
        "kind": "browser-use anonymized telemetry, a child tool",
        "denied_by": "ANONYMIZED_TELEMETRY=false in the env seal (the tool's own default is the same)",
    },
    "photon-sidecar": {
        "files": ["plugins/platforms/photon/cli.py", "plugins/platforms/photon/adapter.py",
                  "plugins/platforms/photon/sidecar/index.mjs"],
        "kind": "Spectrum SDK telemetry in the Photon sidecar, a child tool",
        "denied_by": "PHOTON_TELEMETRY=0 sealed into the sidecar env; .env cannot turn it on",
    },
    "vercel-sandbox": {
        "files": ["tools/environments/vercel_sandbox.py"],
        "kind": "Vercel SDK internal telemetry",
        "denied_by": "VERCEL_TELEMETRY_DISABLED=1 in the env seal",
    },
}

# Sinks inside THIRD-PARTY distributions of the shipped venv (ruling 54, r7: RT's live venv gate found the first).
# The venv gate (iclone/telemetry/venv_gate.py) passes a third-party file with an analytics host or a telemetry module
# with an HTTP client ONLY when it is listed here; anything else is RED. Each one is made inert at import under
# icloneOS, not only switched off by env.
THIRD_PARTY_SINKS: Dict[str, Dict[str, object]] = {
    "browser-harness": {
        # path -> sha256 of the reviewed bytes (ruling 58.2): another version or a changed file is RED in the gate
        "files": {"browser_harness/telemetry.py": "8d48b95afe4b149c2be115e0df18dd9f62496148a194277702d74829455cfa94"},
        "kind": "PostHog (eu.i.posthog.com) events from the browser-harness CLI, sent by a detached urllib child",
        "denied_by": "BH_TELEMETRY / BROWSER_HARNESS_TELEMETRY / ANONYMIZED_TELEMETRY off in the env seal, "
        "BH_POSTHOG_HOST stripped; inert at import: seal_browser_harness() in this process and the CLI child runs "
        "through BROWSER_HARNESS_GUARD (tools/browser_use_cli.py), which replaces the send and capture functions",
    },
    "hf-xet": {
        # the locked 1.6.0 wheel is not in any local cache, so no reviewed digest exists yet: RED until it is read
        "files": {},
        "kind": "Rust xet_transfer_heartbeat telemetry (telemetry/v1/telemetry) to the CAS endpoint during HF transfers",
        "denied_by": "HF_XET_TELEMETRY_ENABLED=0 and HF_HUB_DISABLE_TELEMETRY=1 in the env seal (ruling 63.1; native "
        "code, so env-sealed); the endpoint path is on the gate's denylist so any OTHER file carrying it is RED",
    },
    "vercel-internal-telemetry": {
        "files": {},  # no file of it may carry a host or a sender: the gate stays RED on any hit until it is read
        "kind": "Vercel SDK internal telemetry (hard dependency of vercel / vercel-cache, the `vercel` extra)",
        "denied_by": "VERCEL_TELEMETRY_DISABLED=1 in the env seal (ruling 63.2). Not excluded: whether `vercel` imports "
        "without it could not be proved offline (its wheels are not in the uv cache), so per 63.2 it is sealed and "
        "registered; the venv gate reads it when a real venv carries it",
    },
    "mistralai": {
        "files": {  # mistralai 2.4.8 (the locked version), read from the uv cache
            "mistralai/extra/observability/telemetry.py": "43e4f61e841a14175fa661e3ab222703f0f70d0ba9192bc98422ca82e0aa493c",
            "mistralai/extra/observability/otel.py": "92763738d70937487b674e553a71a9d4026c25f3899f8357282335ffa1156d87",
            # its own unit test names /v1/traces (critic r7 n6); it sends nothing
            "mistralai/extra/tests/test_telemetry.py": "8801685097140ecddb5066be1a827515caa34988852cfafa2ba7868b9f1bd575",
        },
        "kind": "OTLP traces to api.mistral.ai/telemetry/v1/traces (opt-in: MISTRAL_SDK_TELEMETRY or telemetry=)",
        "denied_by": "MISTRAL_SDK_TELEMETRY=false in the env seal, MISTRAL_OTLP_TRACES_ENDPOINT stripped, and the OTLP "
        "exporter is not shipped: it fails closed at import (TelemetryConfigurationError) (ruling 63.8)",
    },
}

# App-side (Electron / Node) sinks: documentation for the review — each is closed in the app's own code.
APP_SIDE_SINKS: Dict[str, Dict[str, str]] = {
    "privy-analytics": {"where": "iclone/privy/privy-login.js", "denied_by": "iclone-analytics-block.ts (every session)"},
    "hcaptcha-sentry": {"where": "privy-login.js (@hcaptcha/react-hcaptcha)", "denied_by": "sentry.hcaptcha.com cancelled"},
    "coinbase-analytics": {"where": "privy-login.js (Coinbase Wallet / Base Account SDK)",
                           "denied_by": "cca-lite / as.coinbase.com and the cbhq.net analytics hosts cancelled"},
    "acp-cli-segment": {
        "where": "acp-cli runtime @account-kit/logging 4.88.5 -> @segment/analytics-next",
        "denied_by": "inert at the shipped pin: createLogger hard-wires noopLogger (pin test "
        "electron/iclone-acp-segment-pin.test.ts on version + integrity); SEGMENT_WRITE_KEY stripped from the child env",
    },
}

# Reviewed and NOT sinks (ruling 63.6): recorded so a reviewer does not re-open them.
REVIEWED_NON_SINKS: Dict[str, str] = {
    "openai / anthropic / parallel-web X-Stainless-* headers": "request metadata on the user's own request to the "
    "provider the user chose (rulings 52, 57: not telemetry; no third party receives it)",
}

# The browser-harness CLI child, under icloneOS: its telemetry module is made inert BEFORE its entry point runs.
BROWSER_HARNESS_GUARD = (
    "import runpy, browser_harness.telemetry as t\n"
    "def _off(*a, **k):\n    return None\n"
    "t.is_enabled = lambda: False\n"
    "t.capture = t.capture_cli_event = t._send_detached = _off\n"
    "t.POSTHOG_HOST = ''\n"
    "runpy.run_module('browser_harness.run', run_name='__main__', alter_sys=True)\n"
)


def seal_browser_harness() -> bool:
    """Under icloneOS make browser-harness telemetry inert in THIS process (when installed). True when sealed."""
    if not under_icloneos():
        return False
    try:
        import importlib

        telemetry = importlib.import_module("browser_harness.telemetry")
    except Exception:
        return False  # not installed: nothing can send

    def _off(*args, **kwargs):
        return None

    telemetry.is_enabled = lambda: False
    telemetry.capture = telemetry.capture_cli_event = telemetry._send_detached = _off
    telemetry.POSTHOG_HOST = ""
    return True


# Files that name a sink without sending anything themselves (setup text, defaults, callers of a refused function).
REFERENCES: Dict[str, str] = {
    "hermes_cli/config_defaults.py": "documented defaults (cua_telemetry off, the Langfuse base URL example)",
    "hermes_cli/tools_config.py": "the Langfuse setup wizard text (its installer is a retired upstream shim)",
    "hermes_cli/subcommands/debug.py": "argparse help text",
    "tui_gateway/methods_config.py": "calls share_to_nous, refused under icloneOS",
    "gateway/slash_commands.py": "calls upload_to_pastebin, refused under icloneOS",
    "hermes_cli/web_server.py": "calls build_debug_share, refused under icloneOS",
    "hermes_cli/web_routers/status.py": "calls build_debug_share, refused under icloneOS",
    "hermes_cli/cli_commands_mixin.py": "calls run_debug_share, refused under icloneOS",
    "hermes_cli/iclone_no_upload.py": "the seam itself",
    "hermes_cli/iclone_sinks.py": "this registry",
    "agent/relay_llm.py": "calls into relay_runtime (the nemo-relay sink above)",
    "tools/lazy_deps.py": "a retired upstream shim (installs only through pm: extras_refusal, sync_exclusions, "
    "plugin_requirements_refusal)",
    "hermes_cli/config_migrations.py": "migration text naming HERMES_NEMO_RELAY_PLUGINS_TOML (no send)",
    "hermes_cli/relay_plugin_cutover.py": "migrates legacy Relay exporter variables to a plugins.toml (no send)",
    "hermes_cli/relay_plugin_migrate.py": "writes a Relay plugins.toml from legacy variables (no send; Relay plugins "
    "are never activated under icloneOS)",
    "hermes_cli/subcommands/migrate.py": "argparse help text of `hermes migrate relay`",
    "tools/browser_tool_session.py": "passes ANONYMIZED_TELEMETRY (sealed false) through to the browser tool",
    "plugins/iclone-consent/importgate.py": "the consent plugin's import gate (refuses the upload functions)",
    "plugins/iclone-consent/noupload.py": "the consent plugin's upload refusal (names what it refuses)",
}

# What makes a file sink-shaped: a telemetry SDK import in any form (statement, a list, importlib or __import__ with
# a literal name), an exporter class, a telemetry env switch, a known collector or analytics host, a paste service or
# the diagnostics upload, a JS require/import of a telemetry package, or a file under an observability/monitoring dir.
SDK_NAMES = (
    "opentelemetry|langfuse|posthog|sentry_sdk|mixpanel|amplitude|analytics|analytics_python|segment|ddtrace|"
    "datadog|libhoney|honeycomb|langsmith|wandb|logfire|openinference|phoenix|helicone|braintrust|opik|agentops|"
    "weave|traceloop|bugsnag|rollbar|newrelic|elasticapm|scout_apm|statsd|prometheus_client|nemo_relay"
)
SDK_IMPORT = re.compile(
    rf"^\s*from\s+({SDK_NAMES})\b|"
    rf"^\s*import\s+(?:[\w.]+(?:\s+as\s+\w+)?\s*,\s*)*({SDK_NAMES})\b|"
    rf"(?:import_module|__import__|find_spec)\(\s*[\"']({SDK_NAMES})\b",
    re.M,
)
JS_SDK_IMPORT = re.compile(
    r"(?:require\(\s*|import\(\s*|from\s+)[\"'](@sentry/[\w-]+|posthog-[\w-]+|posthog|@opentelemetry/[\w-]+|"
    r"mixpanel[\w-]*|@amplitude/[\w-]+|@segment/[\w-]+|analytics-node|dd-trace|@datadog/[\w-]+|langfuse[\w-]*|"
    r"@honeycombio/[\w-]+|newrelic|bugsnag[\w-]*|@bugsnag/[\w-]+|rollbar)[\"'/]",
)
SINK_TEXT = re.compile(
    r"\b[A-Z][A-Z0-9_]*TELEMETRY[A-Z0-9_]*\b|OTLP[A-Za-z]*Exporter|posthog\.com|sentry\.io|langfuse\.com|"
    r"segment\.(?:io|com)|mixpanel\.com|amplitude\.com|datadoghq\.(?:com|eu)|honeycomb\.io|"
    r"smith\.langchain\.com|paste\.rs|dpaste\.com|share_to_nous|upload_to_pastebin|build_debug_share|"
    r"run_debug_share|/v1/traces|/v1/metrics|/v1/telemetry|telemetry\.nousresearch\.com|HERMES_NEMO_RELAY_PLUGINS_TOML"
)
SINK_DIRS = ("plugins/observability/", "agent/monitoring/", "hermes_cli/observability/")
SCAN_TOPS = ("hermes_cli", "tui_gateway", "gateway", "agent", "tools", "acp_adapter", "plugins", "cron", "skills")
SCAN_FILES = ("cli.py", "run_agent.py", "model_tools.py", "batch_runner.py", "mcp_serve.py")
SCAN_SUFFIXES = (".py", ".mjs", ".cjs", ".js")
# monitoring modules that only produce local events (no network): registered as local so the dir rule stays strict.
LOCAL_MONITORING = {
    "agent/monitoring/__init__.py": "package marker",
    "agent/monitoring/emitter.py": "in-process event bus",
    "agent/monitoring/events.py": "event shapes",
    "agent/monitoring/policy.py": "local policy",
    "agent/monitoring/redaction.py": "local redaction",
    "agent/monitoring/gateway_health.py": "local health snapshot",
    "agent/monitoring/cron_health.py": "local cron health snapshot",
    "hermes_cli/observability/__init__.py": "dispatches lifecycle events to the local shared metrics",
    "hermes_cli/observability/relay_shared_metrics.py": "shared metrics through Relay in-process (no exporter)",
    "hermes_cli/observability/shared_metrics.py": "sqlite aggregation, local only",
    "hermes_cli/observability/shared_metrics_contract.py": "metric shapes",
    "hermes_cli/observability/shared_metrics_subscriber.py": "a Relay subscriber that writes the local store",
    "hermes_cli/observability/shared_metrics_catalog.py": "shared metrics, local only (no network)",
    "hermes_cli/observability/shared_metrics_consent.py": "shared metrics, local only (no network)",
    "hermes_cli/observability/shared_metrics_desktop.py": "shared metrics, local only (no network)",
    "hermes_cli/observability/shared_metrics_disabled.py": "shared metrics, local only (no network)",
    "hermes_cli/observability/shared_metrics_efficiency.py": "shared metrics, local only (no network)",
    "hermes_cli/observability/shared_metrics_engagement.py": "shared metrics, local only (no network)",
    "hermes_cli/observability/shared_metrics_events.py": "shared metrics, local only (no network)",
    "hermes_cli/observability/shared_metrics_fields.py": "shared metrics, local only (no network)",
    "hermes_cli/observability/shared_metrics_gateway.py": "shared metrics, local only (no network)",
    "hermes_cli/observability/shared_metrics_harness.py": "shared metrics, local only (no network)",
    "hermes_cli/observability/shared_metrics_install.py": "shared metrics, local only (no network)",
    "hermes_cli/observability/shared_metrics_install_run.py": "shared metrics, local only (no network)",
    "hermes_cli/observability/shared_metrics_loop.py": "shared metrics, local only (no network)",
    "hermes_cli/observability/shared_metrics_model.py": "shared metrics, local only (no network)",
    "hermes_cli/observability/shared_metrics_process.py": "shared metrics, local only (no network)",
    "hermes_cli/observability/shared_metrics_setup.py": "shared metrics, local only (no network)",
    "hermes_cli/observability/shared_metrics_signals.py": "shared metrics, local only (no network)",
    "hermes_cli/observability/shared_metrics_snapshot.py": "shared metrics, local only (no network)",
    "hermes_cli/observability/shared_metrics_startup.py": "shared metrics, local only (no network)",
    "hermes_cli/observability/shared_metrics_update.py": "shared metrics, local only (no network)",
}


def registered_files() -> Set[str]:
    files: Set[str] = set(REFERENCES) | set(LOCAL_MONITORING)
    for sink in SINKS.values():
        files.update(sink["files"])  # type: ignore[arg-type]
    return files


def _candidates(root: Path) -> Iterable[Path]:
    for top in SCAN_TOPS:
        base = root / top
        if base.is_dir():
            for path in sorted(base.rglob("*")):
                if path.suffix in SCAN_SUFFIXES and path.is_file() and "node_modules" not in path.parts:
                    yield path
    for name in SCAN_FILES:
        if (root / name).is_file():
            yield root / name


def scan_tree(root: Path) -> Dict[str, List[str]]:
    """Every sink-shaped file under *root* (relative posix path -> why); tests are excluded, the iclone plugins not."""
    found: Dict[str, List[str]] = {}
    for path in _candidates(root):
        rel = path.relative_to(root).as_posix()
        if "/tests/" in rel or rel.startswith("tests/"):
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        imports = SDK_IMPORT if path.suffix == ".py" else JS_SDK_IMPORT
        why = [next(g for g in m.groups() if g) for m in imports.finditer(text)]
        why += sorted(set(m.group(0) for m in SINK_TEXT.finditer(text)))
        if rel.startswith(SINK_DIRS):
            why.append("observability/monitoring directory")
        if why:
            found[rel] = sorted(set(why))
    return found


def unregistered(root: Path) -> Dict[str, List[str]]:
    known = registered_files()
    return {rel: why for rel, why in scan_tree(root).items() if rel not in known}


# ── 3b. the env-writer inventory (ruling 57.4, r7): every function that writes os.environ or builds a child env from
# .env / secret-source values calls THE seal (reseal_environ) after its write. Closed like the sink registry: the
# enumeration test fails on a candidate in neither list, and on a listed writer that does not call the seal.
ENV_WRITERS: Dict[str, str] = {
    "hermes_cli/config.py:_publish_env_value": "save_env_value / remove_env_value publish to os.environ or the scope",
    "hermes_cli/config.py:reload_env": "the tui_gateway reload.env RPC and CLI /reload",
    "hermes_cli/env_loader.py:_load_dotenv_with_fallback": "every .env layer",
    "hermes_cli/env_loader.py:load_hermes_dotenv": "the secret-source restore after the .env layers",
    "hermes_cli/env_loader.py:_apply_external_secret_sources": "vault values (Bitwarden, 1Password, ...)",
    "hermes_cli/env_loader.py:_revoke_secret_source_writes": "restores prior values of revoked sources",
    "hermes_cli/kanban_pr_acceptance.py:_gh_env": "gh child for a card's profile",
    "hermes_cli/proxy_cli.py:_load_env_file_into_environ": "provider keys backfilled from .env",
    "hermes_cli/send_cmd.py:_load_hermes_env": "hermes send: .env and config scalars",
    "agent/copilot_acp_client.py:_build_subprocess_env": "Copilot ACP child",
    "tools/bot_relay.py:delivery_env": "bot relay delivery child",
    "tools/browser_tool.py:_build_browser_env": "browser driver child",
    "tools/environments/local.py:hermes_subprocess_env": "every non-terminal child",
    "tools/environments/local.py:build_subprocess_env": "the child-env factory",
    "tools/environments/local.py:served_profile_child_env": "profile children, both inherit_credentials modes",
    "plugins/platforms/photon/adapter.py:_sidecar_env": "the Photon sidecar",
    "hermes_cli/plugin_host.py:_env": "the isolated plugin host child",
}
ENV_WRITERS_EXEMPT: Dict[str, str] = {
    "cron/scheduler.py:_run_external_worker_payload": "sets and restores only its own _HERMES_CRON_EXTERNAL_WORKER marker",
    "tools/environments/local.py:strip_launch_profile_env": "only removes keys; every caller is a sealed builder",
}
ENV_SOURCE_NAMES = frozenset({
    "load_env", "load_env_file", "load_dotenv", "DotEnv", "dotenv_values", "build_profile_secret_scope", "apply_all",
    "current_secret_scope", "_SECRET_SOURCE_RESTORE_BY_HOME", "_load_dotenv_with_fallback", "hermes_subprocess_env",
    "served_profile_child_env",
})
_ENV_RESULT_CALLS = ("_bind_pay_env", "_finalize_child_env", "_sanitize_subprocess_env", "delegated_child_subprocess_env")


def _writes_environ(fn) -> bool:
    import ast

    for node in ast.walk(fn):
        targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, ast.AugAssign) else []
        if any(isinstance(t, ast.Subscript) and ast.unparse(t.value) in ("os.environ", "target") for t in targets):
            return True
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr in ("update", "setdefault") and ast.unparse(node.func.value) == "os.environ"):
            return True
    return False


def _returns_env(fn) -> bool:
    import ast

    for node in ast.walk(fn):
        if isinstance(node, ast.Return) and node.value is not None:
            value = node.value
            if isinstance(value, ast.Name) and value.id in ("env", "child_env", "environ", "merged"):
                return True
            if isinstance(value, ast.Call) and ast.unparse(value.func).split(".")[-1] in _ENV_RESULT_CALLS:
                return True
    return False


def env_writer_candidates(root: Path) -> Dict[str, bool]:
    """Every function (path:name) that reads .env / secret-source values and writes os.environ or returns an env,
    mapped to whether it calls ``reseal_environ``."""
    import ast

    found: Dict[str, bool] = {}
    for path in _candidates(root):
        if path.suffix != ".py":
            continue
        rel = path.relative_to(root).as_posix()
        if "/tests/" in rel or rel.startswith("tests/") or rel == "hermes_cli/iclone_sinks.py":
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8", errors="ignore"))
        except SyntaxError:
            continue
        for fn in ast.walk(tree):
            if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            names = {n.id for n in ast.walk(fn) if isinstance(n, ast.Name)}
            names |= {n.attr for n in ast.walk(fn) if isinstance(n, ast.Attribute)}
            key = f"{rel}:{fn.name}"
            if (names & ENV_SOURCE_NAMES and (_writes_environ(fn) or _returns_env(fn))) or key in ENV_WRITERS:
                found[key] = "reseal_environ" in names
    return found


# ── 1. no enable path ────────────────────────────────────────────────────────────────────────────────────────────────


def sink_allowed(sink: str, endpoint: object, env: Optional[Mapping[str, str]] = None,
                 root: Optional[Path] = None) -> bool:
    """Whether *sink* may send to *endpoint*. Plain Hermes: as configured. Under icloneOS (v0.0.3): never."""
    environ = os.environ if env is None else env
    if under_icloneos(environ, root):
        return False
    return bool(str(endpoint or "").strip())


# ── 3c. THE seal at the spawn (r8): every child process Python can start goes through the seal ──────────────────────
# subprocess.Popen (subprocess.run/call/check_output, asyncio's create_subprocess_*, anyio.open_process and the MCP SDK's
# stdio_client all build one), os.execve / execvpe / spawnve / spawnvpe / posix_spawn / posix_spawnp: an explicit env is
# resealed on its way in; a child with no env inherits this process's env, which is sealed itself. Installed by the first
# process-level reseal (every Hermes entry point loads its .env first) and by the consent plugin.
SPAWN_PRIMITIVES = ("subprocess.Popen", "os.execve", "os.execvpe", "os.spawnve", "os.spawnvpe", "os.posix_spawn",
                    "os.posix_spawnp")


def _sealed_env(env):
    if env is None:
        return None
    sealed = dict(env)
    reseal_environ(sealed)
    return sealed


# The spawn-primitive inventory (r8): every way the runtime can start a process, closed like the sink registry. A call
# to a primitive in neither set below is RED in test_every_spawn_primitive_goes_through_the_seal.
#   SEALED   — takes an env and is wrapped by install_spawn_seal (or builds a subprocess.Popen, which is);
#   INHERITS — takes no env: the child inherits this process's env, which is sealed.
SPAWN_PRIMITIVES_SEALED = frozenset({
    "subprocess.Popen", "subprocess.run", "subprocess.call", "subprocess.check_call", "subprocess.check_output",
    "subprocess.getoutput", "subprocess.getstatusoutput", "asyncio.create_subprocess_exec",
    "asyncio.create_subprocess_shell", "anyio.open_process", "anyio.run_process", "os.execve", "os.execvpe",
    "os.spawnve", "os.spawnvpe", "os.posix_spawn", "os.posix_spawnp", "ptyprocess.PtyProcess.spawn",
    "ptyprocess.PtyProcessUnicode.spawn",
})
SPAWN_PRIMITIVES_INHERIT = frozenset({
    "os.execv", "os.execvp", "os.execl", "os.execlp", "os.spawnv", "os.spawnvp", "os.spawnl", "os.spawnlp",
    "os.system", "os.popen", "os.fork", "pty.fork", "pty.spawn", "os.startfile",
})
_PRIMITIVE = re.compile(
    r"^(?:subprocess\.\w+|asyncio\.create_subprocess_\w+|anyio\.(?:open|run)_process|os\.(?:exec\w*|spawn\w*|posix_spawnp?|"
    r"system|popen|fork\w*|startfile)|pty\.(?:fork|spawn)|_posixsubprocess\.\w+|multiprocessing\.\w*Process|"
    r"ptyprocess\.\w+\.spawn|pexpect\.\w+)$")
_NOT_A_SPAWN = frozenset({"subprocess.TimeoutExpired", "subprocess.CalledProcessError", "subprocess.CompletedProcess",
                          "subprocess.SubprocessError", "subprocess.list2cmdline", "subprocess.STARTUPINFO",
                          "os.forkpty_unused", "pty.openpty"})


def spawn_primitives(root: Path) -> Dict[str, str]:
    """Every process-starting primitive the runtime calls (``module.attr`` as written, imports resolved for ``from x
    import y``), mapped to one place it is called (path:line)."""
    import ast

    found: Dict[str, str] = {}
    for path in _candidates(root):
        if path.suffix != ".py":
            continue
        rel = path.relative_to(root).as_posix()
        if "/tests/" in rel or rel.startswith("tests/"):
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8", errors="ignore"))
        except SyntaxError:
            continue
        aliases: Dict[str, str] = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module in ("subprocess", "os", "asyncio", "pty", "anyio",
                                                                     "_posixsubprocess", "multiprocessing"):
                for name in node.names:
                    aliases[name.asname or name.name] = f"{node.module}.{name.name}"
            elif isinstance(node, ast.Import):
                for name in node.names:
                    if name.name in ("subprocess", "os", "asyncio", "pty", "anyio", "_posixsubprocess"):
                        aliases[name.asname or name.name] = name.name
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            text = ast.unparse(node.func)
            head, _, rest = text.partition(".")
            full = f"{aliases[head]}.{rest}" if head in aliases and rest else aliases.get(text, text)
            if _PRIMITIVE.match(full) and full not in _NOT_A_SPAWN:
                found.setdefault(full, f"{rel}:{node.lineno}")
    return found


def install_spawn_seal() -> bool:
    """Wrap every child-process primitive so an explicit env passes the seal (idempotent). True once installed."""
    import subprocess

    # Idempotent per primitive (by a marker on the installed wrapper, not a flag): a Popen class or an os function
    # replaced after the first install is wrapped again.
    original_init = subprocess.Popen.__init__

    def popen_init(self, args, *rest, **kwargs):
        if "env" in kwargs:
            kwargs["env"] = _sealed_env(kwargs["env"])
        elif len(rest) > 9:  # Popen(args, bufsize, executable, stdin, stdout, stderr, preexec_fn, close_fds, shell, cwd, env)
            rest = rest[:9] + (_sealed_env(rest[9]),) + rest[10:]
        return original_init(self, args, *rest, **kwargs)

    popen_init.__iclone_sealed__ = True  # type: ignore[attr-defined]
    if not getattr(original_init, "__iclone_sealed__", False):
        subprocess.Popen.__init__ = popen_init  # type: ignore[method-assign]

    def wrap(name: str, env_index: int):
        original = getattr(os, name, None)
        if original is None or getattr(original, "__iclone_sealed__", False):
            return

        def sealed(*args, **kwargs):
            if "env" in kwargs:
                kwargs["env"] = _sealed_env(kwargs["env"])
            elif len(args) > env_index:
                args = args[:env_index] + (_sealed_env(args[env_index]),) + args[env_index + 1:]
            return original(*args, **kwargs)

        sealed.__iclone_sealed__ = True  # type: ignore[attr-defined]
        setattr(os, name, sealed)

    for name, index in (("execve", 2), ("execvpe", 2), ("spawnve", 3), ("spawnvpe", 3), ("posix_spawn", 2),
                        ("posix_spawnp", 2)):
        wrap(name, index)
    return True


def reseal_environ(environ: Optional[MutableMapping[str, str]] = None) -> None:
    """THE env seal (ruling 57.4; every env writer and builder calls it after its write — ENV_WRITERS). Under icloneOS:
    the telemetry-off values win, every destination variable is removed (proxies of any kind, per-platform ones
    included, collectors, SDK hosts, the Relay plugins file), and the user's own proxy is put back exactly as main
    passed it on ICLONE_USER_NETWORK — or, without one, NO_PROXY is pinned to "*". For a child's env (*environ*
    given) only main's proxies are put back, never the child's own."""
    target = os.environ if environ is None else environ
    if not (under_icloneos() or under_icloneos(target)):
        return
    if environ is None:
        install_spawn_seal()  # the process is sealed: from now on every child it starts is too
    snapshot_main_proxies()
    target.update(TELEMETRY_OFF_ENV)
    for key in [k for k in target if is_destination_key(k) or k in DESTINATION_PINNED_ENV or k == USER_PROXY_CHANNEL]:
        target.pop(key, None)
    user = {k: v for k, v in (_MAIN_PROXIES or {}).items() if k not in DESTINATION_PINNED_ENV}
    if user:  # the user's own proxy, exactly as main passed it (NO_PROXY included, never pinned over it)
        target.update(_MAIN_PROXIES or {})
        target[USER_PROXY_CHANNEL] = _MAIN_CHANNEL or ""
    else:
        target.update(DESTINATION_PINNED_ENV)


def no_auto_install() -> bool:
    """True under icloneOS: no exporter SDK is ever installed from PyPI (refused before any lazy install)."""
    return under_icloneos()
