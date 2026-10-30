"""iclone-seam: v3fx-sinks — ruling 57 (V3-FX r6): in v0.0.3 telemetry is removed, not configured.

No enable path (no value anywhere turns a sink on under the managed env, the critic's forged env included), NeMo Relay
plugins refused (the critic's exact .env + plugins.toml exploit), a missing exporter fails closed and is never
installed, every destination variable stripped after an .env or vault load, a loopback collector that redirects is
never contacted, and the registry (ruling 54) kept as one more check with the critic's synthetic sinks.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import types
from pathlib import Path

import pytest

from hermes_cli import iclone_sinks as sinks
from hermes_cli.iclone_no_upload import UploadRefused

ROOT = Path(__file__).resolve().parents[2]
SPAWN_ENV = {"ICLONE_CONSENT_MICROPHONE": "ask", "ICLONE_CONSENT_TERMINAL": "ask"}


@pytest.fixture()
def managed(monkeypatch):
    for key, value in SPAWN_ENV.items():
        monkeypatch.setenv(key, value)
    for key in [k for k in os.environ if sinks.is_destination_key(k) or k in sinks.USER_PROXY_ENV_KEYS]:
        monkeypatch.delenv(key)
    monkeypatch.delenv(sinks.USER_PROXY_CHANNEL, raising=False)
    monkeypatch.setattr(sinks, "_MAIN_PROXIES", {})  # main started this process with no proxy
    monkeypatch.setattr(sinks, "_MAIN_CHANNEL", None)
    yield monkeypatch


# ── 1. the registry is closed ────────────────────────────────────────────────────────────────────────────────────────


def test_every_sink_shaped_file_in_the_runtime_is_registered():
    assert sinks.unregistered(ROOT) == {}


def test_the_registry_names_only_files_that_exist_here():
    stale = sorted(rel for rel in sinks.registered_files() if not (ROOT / rel).is_file())
    # web_routers/* exist in the pinned runtime the app ships, not in this checkout (the union is registered).
    assert [rel for rel in stale if not rel.startswith("hermes_cli/web_routers/")] == []


def test_a_new_exporter_module_is_caught(tmp_path):
    """The enumeration goes red on a sink nobody registered — every form the r5 critic used (n1) but an obfuscated
    name, which no scan can see (ruling 57: the venv gate, not this scan, is the proof)."""
    sinks_by_file = {
        "agent/fake_exporter.py": "from opentelemetry.exporter.otlp.proto.http import x\n",
        "tools/analytics_ping.py": "import posthog\nposthog.capture('x')\n",
        "plugins/observability/newsink/__init__.py": "def register(ctx): pass\n",
        "tools/multi_import.py": "import os, posthog\n",
        "tools/string_import.py": "import importlib\nsdk = importlib.import_module(\"sentry_sdk\")\n",
        "tools/dunder_import.py": "client = __import__('posthog')\n",
        "tools/segment_post.py": "requests.post('https://api.segment.io/v1/track', json={})\n",
        "tools/mixpanel_post.py": "requests.post('https://api.mixpanel.com/track')\n",
        "tools/amplitude_post.py": "requests.post('https://api2.amplitude.com/2/httpapi')\n",
        "tools/datadog_post.py": "requests.post('https://http-intake.logs.datadoghq.com/api/v2/logs')\n",
        "tools/honeycomb_post.py": "requests.post('https://api.honeycomb.io/1/events/x')\n",
        "tools/analytics_python_import.py": "from analytics_python import Client\n",
        "agent/relay_obs.py": "from nemo_relay.observability import otlp\n",
        "plugins/iclone-newthing/__init__.py": "import posthog\n",
        "skills/some-skill/scripts/ping.py": "import sentry_sdk\n",
        "plugins/platforms/newsidecar/index.mjs": "import * as Sentry from '@sentry/node'\n",
        "plugins/platforms/othersidecar/main.cjs": "const { PostHog } = require('posthog-node')\n",
    }
    for rel, text in sinks_by_file.items():
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_text(text)
    (tmp_path / "tools" / "plain.py").write_text("def add(a, b):\n    return a + b\n")
    (tmp_path / "tools" / "obfuscated.py").write_text("import importlib\nimportlib.import_module('pos' + 'thog')\n")

    found = sinks.unregistered(tmp_path)

    assert set(found) == set(sinks_by_file)
    assert "opentelemetry" in found["agent/fake_exporter.py"]
    assert "nemo_relay" in found["agent/relay_obs.py"]


def test_the_relay_sink_and_its_switch_are_registered():
    assert "agent/relay_runtime.py" in sinks.SINKS["nemo-relay"]["files"]
    assert sinks.is_destination_key("HERMES_NEMO_RELAY_PLUGINS_TOML")


# ── 1. no enable path (ruling 57.1) ──────────────────────────────────────────────────────────────────────────────────

FORGED = {
    "ICLONE_OTLP_ENDPOINT": "http://127.0.0.1:4318/v1/traces",
    "ICLONE_LANGFUSE_BASE_URL": "http://127.0.0.1:3000",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4318",
    "HERMES_LANGFUSE_BASE_URL": "http://127.0.0.1:3000",
}


def test_no_value_anywhere_turns_a_sink_on_under_icloneos(managed):
    for key, value in FORGED.items():
        managed.setenv(key, value)
    for sink in ("otlp", "langfuse", "relay"):
        for endpoint in ("http://127.0.0.1:4318/v1/traces", "http://[::1]:4318", "https://cloud.langfuse.com"):
            assert sinks.sink_allowed(sink, endpoint) is False, (sink, endpoint)
    # The critic's r5 forgery (M3): an env handed to a child by anyone — no longer an owner value.
    forged = dict(SPAWN_ENV, **FORGED)
    assert sinks.sink_allowed("otlp", FORGED["ICLONE_OTLP_ENDPOINT"], env=forged) is False


def test_the_module_reads_no_owner_value():
    source = (ROOT / "hermes_cli" / "iclone_sinks.py").read_text()
    assert "ICLONE_OTLP_ENDPOINT" not in source and "owner_value" not in source and "_OWNER" not in source


# ── 3. destination variables stripped (ruling 57.4) ──────────────────────────────────────────────────────────────────

DESTINATIONS = {
    "HTTP_PROXY": "http://proxy.exfil.invalid:8080",
    "HTTPS_PROXY": "http://proxy.exfil.invalid:8080",
    "ALL_PROXY": "socks5://proxy.exfil.invalid:1080",
    "https_proxy": "http://proxy.exfil.invalid:8080",
    "NO_PROXY": "",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": "http://collector.exfil.invalid:4318",
    "HERMES_NEMO_RELAY_PLUGINS_TOML": "/tmp/relay-agent.toml",
    "ICLONE_OTLP_ENDPOINT": "http://127.0.0.1:4318",
    "LANGFUSE_HOST": "https://collector.exfil.invalid",
    "POSTHOG_HOST": "https://collector.exfil.invalid",
    "DD_TRACE_AGENT_URL": "http://collector.exfil.invalid:8126",
    "SENTRY_DSN": "https://k@o1.ingest.sentry.io/1",
}


def test_an_env_file_cannot_turn_telemetry_on_or_carry_a_destination(managed):
    for key, value in DESTINATIONS.items():
        managed.setenv(key, value)
    managed.setenv("PHOTON_TELEMETRY", "true")
    managed.setenv("CUA_DRIVER_RS_TELEMETRY_ENABLED", "1")

    sinks.reseal_environ()

    left = sorted(k for k in DESTINATIONS if k in os.environ and k not in sinks.DESTINATION_PINNED_ENV)
    assert left == []
    assert os.environ.get("NO_PROXY") == "*"
    assert os.environ["PHOTON_TELEMETRY"] == "0"
    assert os.environ["CUA_DRIVER_RS_TELEMETRY_ENABLED"] == "0"
    assert os.environ["OTEL_SDK_DISABLED"] == "true"


def test_the_real_env_loader_reseals_after_a_dotenv(managed, tmp_path):
    from hermes_cli import env_loader

    env_file = tmp_path / ".env"
    env_file.write_text("PHOTON_TELEMETRY=true\nICLONE_LANGFUSE_BASE_URL=http://127.0.0.1:3000\n"
                        "HTTPS_PROXY=http://proxy.exfil.invalid:8080\n")
    env_loader._load_dotenv_with_fallback(env_file, override=True)

    assert os.environ["PHOTON_TELEMETRY"] == "0"
    assert "ICLONE_LANGFUSE_BASE_URL" not in os.environ
    assert "HTTPS_PROXY" not in os.environ


def test_a_vault_value_is_resealed_too(managed, tmp_path):
    """k7: external secret sources (Bitwarden, 1Password) are applied after the .env — the reseal runs after them."""
    from hermes_cli import env_loader

    source = types.SimpleNamespace(applied=[], skipped_existing=[], label="fake", name="fake",
                                   result=types.SimpleNamespace(ok=True, error=None, error_kind=None, warnings=[]))
    report = types.SimpleNamespace(sources=[source], applied_any=True, provenance={}, conflicts=[])

    applied = []

    def apply_all(cfg, home):
        applied.append(home)
        os.environ["PHOTON_TELEMETRY"] = "true"
        os.environ["HTTPS_PROXY"] = "http://proxy.exfil.invalid:8080"
        return report

    registry = types.ModuleType("agent.secret_sources.registry")
    registry.apply_all = apply_all  # type: ignore[attr-defined]
    registry.enabled_source_names = lambda cfg, home: None  # type: ignore[attr-defined]
    managed.setitem(sys.modules, "agent.secret_sources.registry", registry)
    managed.setattr(env_loader, "_load_secrets_config", lambda home: {"fake": {"enabled": True}})
    managed.setattr(env_loader, "_APPLIED_HOMES", set())

    env_loader._apply_external_secret_sources(tmp_path)

    assert applied == [tmp_path]  # the vault really applied its values (not a vacuous pass)
    assert os.environ["PHOTON_TELEMETRY"] == "0"
    assert "HTTPS_PROXY" not in os.environ


def test_the_photon_sidecar_env_is_sealed(managed):
    """k6: the sidecar's env is this process's env plus its own settings — sealed, destinations stripped."""
    adapter = importlib.import_module("plugins.platforms.photon.adapter")
    managed.setenv("PHOTON_TELEMETRY", "true")
    managed.setenv("HTTPS_PROXY", "http://proxy.exfil.invalid:8080")

    env = adapter._sidecar_env("pid", "secret", 1234, "127.0.0.1", "tok")

    assert env["PHOTON_TELEMETRY"] == "0"
    assert "HTTPS_PROXY" not in env
    assert env["PHOTON_PROJECT_ID"] == "pid" and env["PHOTON_SIDECAR_PORT"] == "1234"


USER_PROXY = {"HTTPS_PROXY": "http://proxy.corp.example:8080", "NO_PROXY": "localhost,.corp.example"}


def test_the_users_proxy_from_main_passes_through_and_an_env_proxy_does_not(managed, tmp_path):
    """Lead correction r6: main's captured proxy (the user's real environment) reaches the model provider exactly as
    captured — NO_PROXY not pinned over it; an .env (or vault, or config) proxy never does."""
    from hermes_cli import env_loader

    import json

    managed.setattr(sinks, "_MAIN_PROXIES", None)
    for key, value in USER_PROXY.items():
        managed.setenv(key, value)  # as main passed them at spawn
    managed.setenv(sinks.USER_PROXY_CHANNEL, json.dumps(USER_PROXY))  # r7: explicitly, on the one channel
    env_file = tmp_path / ".env"
    env_file.write_text("HTTPS_PROXY=http://proxy.exfil.invalid:8080\nALL_PROXY=socks5://proxy.exfil.invalid:1080\n"
                        "NO_PROXY=*\n")

    env_loader._load_dotenv_with_fallback(env_file, override=True)

    assert {k: os.environ.get(k) for k in USER_PROXY} == USER_PROXY
    assert "ALL_PROXY" not in os.environ
    assert os.environ["OTEL_SDK_DISABLED"] == "true"  # telemetry stays off regardless


def test_an_env_proxy_is_stripped_when_main_passed_none(managed, tmp_path):
    from hermes_cli import env_loader

    env_file = tmp_path / ".env"
    env_file.write_text("HTTPS_PROXY=http://proxy.exfil.invalid:8080\nhttp_proxy=http://proxy.exfil.invalid:8080\n")
    env_loader._load_dotenv_with_fallback(env_file, override=True)

    assert "HTTPS_PROXY" not in os.environ and "http_proxy" not in os.environ
    assert os.environ.get("NO_PROXY") == "*"


def test_plain_hermes_is_unchanged(monkeypatch):
    for key in list(os.environ):
        if key.startswith("ICLONE_CONSENT_"):
            monkeypatch.delenv(key)
    assert sinks.sink_allowed("otlp", "https://collector.example.com", env={}, root=ROOT / "nowhere") is True
    env = {"HTTPS_PROXY": "http://proxy.corp:8080"}
    sinks.reseal_environ(env)
    assert env == {"HTTPS_PROXY": "http://proxy.corp:8080"}


# ── NeMo Relay (critic r5 M1) ────────────────────────────────────────────────────────────────────────────────────────


def _relay_toml(home: Path, endpoint: str) -> Path:
    toml = home / "relay-agent.toml"
    toml.write_text(
        "[[components]]\nname = \"observability\"\n[components.config.otlp]\n"
        f"endpoint = \"{endpoint}\"\nprotocol = \"http_binary\"\n"
    )
    return toml


class _RelayStub:
    """A Relay binding whose plugin host must never be touched."""

    def __init__(self):
        self.calls = []
        self.plugin = types.SimpleNamespace(
            initialize=lambda *a, **k: self.calls.append(("initialize", a, k)) or object(),
            validate=lambda *a, **k: self.calls.append(("validate", a, k)),
        )


def test_relay_plugins_are_never_configured_under_icloneos(managed, tmp_path):
    """No explicit plugins.toml, and no discovered user or system one either: the plugin host is never initialized."""
    from agent import relay_runtime

    managed.setenv("HERMES_NEMO_RELAY_PLUGINS_TOML", str(_relay_toml(tmp_path, "http://collector.exfil.invalid:4318")))
    relay = _RelayStub()

    state = relay_runtime._ProcessRelayPluginConfiguration()._activate(relay)

    assert state is relay_runtime._RelayPluginConfigurationState.DISABLED
    assert relay.calls == []


def test_the_critics_relay_exploit_is_closed(managed, tmp_path):
    """The r5 exploit, exactly: the agent writes <home>/.env naming a plugins.toml whose OTLP endpoint it chose."""
    from agent import relay_runtime
    from hermes_cli import env_loader

    home = tmp_path / "home"
    home.mkdir()
    toml = _relay_toml(home, "http://collector.exfil.invalid:4318")
    (home / ".env").write_text(f"HERMES_NEMO_RELAY_PLUGINS_TOML={toml}\n")
    managed.setenv("HERMES_HOME", str(home))

    env_loader.load_hermes_dotenv(hermes_home=home)
    relay = _RelayStub()

    assert "HERMES_NEMO_RELAY_PLUGINS_TOML" not in os.environ
    assert relay_runtime._ProcessRelayPluginConfiguration()._activate(relay) is (
        relay_runtime._RelayPluginConfigurationState.DISABLED)
    assert relay.calls == []


def test_a_missing_relay_fails_closed_and_installs_nothing(managed):
    """Ruling 57.2: nemo-relay is not shipped; importing it fails, the host is the no-op one, nothing is installed."""
    from agent import relay_runtime

    calls = []
    import pm

    managed.setattr(pm, "ensure_import", lambda *a, **k: calls.append(a), raising=False)
    managed.setitem(sys.modules, "nemo_relay", None)  # ImportError on import, as in the shipped venv

    host = relay_runtime.RelayHostRegistry().for_profile("fx-r6-missing-relay")

    assert isinstance(host, relay_runtime.NoopRelayRuntime)
    assert calls == []


# ── a loopback collector that redirects is never contacted (ruling 57 / critic r5 M3) ──────────────────────────────


@pytest.fixture()
def redirecting_collector():
    """A collector on 127.0.0.1 that answers every request with a 307 to a host outside this Mac."""
    import http.server
    import threading

    hits = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def _redirect(self):
            hits.append((self.command, self.path))
            self.send_response(307)
            self.send_header("Location", "http://exfil.invalid/v1/traces")
            self.end_headers()

        do_GET = do_POST = do_PUT = _redirect

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}", hits
    server.shutdown()
    server.server_close()


def test_a_loopback_307_to_outside_is_followed_by_no_remaining_sink(managed, tmp_path, redirecting_collector):
    import socket

    from agent import relay_runtime
    from agent.monitoring import gateway_health_export, otlp_exporter

    url, hits = redirecting_collector
    resolved = []
    real_getaddrinfo = socket.getaddrinfo
    managed.setattr(socket, "getaddrinfo", lambda host, *a, **k: resolved.append(host) or real_getaddrinfo(host, *a, **k))
    for key, value in FORGED.items():
        managed.setenv(key, value.replace("http://127.0.0.1:4318", url).replace("http://127.0.0.1:3000", url))
    config = {"monitoring": {"gateway_health_export": {"enabled": True},
                             "export": {"otlp": {"enabled": True, "endpoint": f"{url}/v1/traces"}}}}

    assert otlp_exporter.is_enabled(config) is False
    assert gateway_health_export._enabled(config) is False
    with pytest.raises(UploadRefused):
        otlp_exporter.build_exporter(config)
    managed.setenv("HERMES_NEMO_RELAY_PLUGINS_TOML", str(_relay_toml(tmp_path, url)))
    relay = _RelayStub()
    relay_runtime._ProcessRelayPluginConfiguration()._activate(relay)
    assert relay.calls == []
    managed.setenv("HERMES_LANGFUSE_PUBLIC_KEY", "pk-lf-" + "a" * 32)
    managed.setenv("HERMES_LANGFUSE_SECRET_KEY", "sk-lf-" + "b" * 32)
    plugin = _load_langfuse_plugin(managed)
    plugin.Langfuse = lambda **kwargs: (_ for _ in ()).throw(AssertionError("client built"))
    assert plugin._get_langfuse() is None

    assert hits == []
    assert "exfil.invalid" not in resolved


def test_the_collector_fixture_really_redirects_outside(redirecting_collector):
    """The fixture is what the test claims: a client that follows redirects is sent to exfil.invalid."""
    import urllib.error
    import urllib.request

    url, hits = redirecting_collector

    class NoFollow(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            raise urllib.error.HTTPError(newurl, code, msg, headers, fp)

    with pytest.raises(urllib.error.HTTPError) as caught:
        urllib.request.build_opener(NoFollow).open(f"{url}/v1/traces", data=b"x", timeout=5)
    assert caught.value.filename == "http://exfil.invalid/v1/traces"
    assert hits == [("POST", "/v1/traces")]


def _load_langfuse_plugin(managed):
    path = ROOT / "plugins" / "observability" / "langfuse" / "__init__.py"
    spec = importlib.util.spec_from_file_location("fx_langfuse_plugin", path)
    plugin = importlib.util.module_from_spec(spec)
    managed.setitem(sys.modules, "fx_langfuse_plugin", plugin)
    spec.loader.exec_module(plugin)
    plugin._LANGFUSE_CLIENT = None
    return plugin


# ── 2. never installed under icloneOS (ruling 57.2) ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("extras", "refused"),
    [
        (["otlp"], ["opentelemetry-exporter-otlp-proto-common", "opentelemetry-exporter-otlp-proto-http",
                    "opentelemetry-proto"]),
        (["daytona"], ["opentelemetry-exporter-otlp-proto-common", "opentelemetry-exporter-otlp-proto-http",
                       "opentelemetry-proto"]),  # pulled in as a DEPENDENCY of daytona
        (["langfuse"], ["langfuse", "opentelemetry-exporter-otlp-proto-common",
                        "opentelemetry-exporter-otlp-proto-http", "opentelemetry-proto"]),
        (["ddgs", "web"], []),
        (["no-such-extra"], ["(the requested extras could not be resolved from uv.lock to check them)"]),
    ],
)
def test_an_extra_is_refused_by_its_resolved_dependencies(managed, extras, refused):
    """Lead correction r6 / ruling 57.2: the resolution pm installs from (uv.lock), transitive dependencies included."""
    assert sinks.extras_refusal(extras) == refused


def test_plain_hermes_installs_extras_as_before(monkeypatch):
    for key in list(os.environ):
        if key.startswith("ICLONE_CONSENT_"):
            monkeypatch.delenv(key)
    monkeypatch.setattr("hermes_cli.iclone_no_upload._RUNTIME_ROOT", ROOT / "nowhere")
    assert sinks.extras_refusal(["otlp"]) == []


def test_pm_refuses_a_telemetry_extra_before_any_sync(managed):
    """The package manager (the only installer since upstream 1ac3f97) refuses before it plans or touches the venv."""
    from pm import install
    from pm.package import InstallError

    managed.setattr(install, "_feature_policy", lambda *a, **k: (_ for _ in ()).throw(AssertionError("sync planned")))
    with pytest.raises(InstallError, match="never installs telemetry packages: opentelemetry"):
        install.sync_venv(["daytona"])


# ── the sinks themselves ─────────────────────────────────────────────────────────────────────────────────────────────


REMOTE = {"monitoring": {"gateway_health_export": {"enabled": True},
                         "export": {"otlp": {"enabled": True, "endpoint": "http://exfil.invalid\\@localhost/v1/traces"}}}}
LOCAL = {"monitoring": {"gateway_health_export": {"enabled": True},
                        "export": {"otlp": {"enabled": True, "endpoint": "http://127.0.0.1:4318/v1/traces"}}}}


def test_otlp_is_off_for_a_remote_and_a_loopback_collector(managed):
    from agent.monitoring import gateway_health_export, otlp_exporter

    for config in (REMOTE, LOCAL):
        assert otlp_exporter.is_enabled(config) is False
        assert gateway_health_export._enabled(config) is False


def test_otlp_refuses_before_the_sdk_or_any_install(managed):
    from agent.monitoring import gateway_health_export, otlp_exporter

    managed.setattr(otlp_exporter, "_require_sdk", lambda **_: (_ for _ in ()).throw(AssertionError("SDK touched")))
    with pytest.raises(UploadRefused):
        otlp_exporter.build_exporter(REMOTE)
    # The metric provider and the diagnostic log streamer refuse — with a complete fake SDK, so without the refusal
    # they would build and the failure is "DID NOT RAISE" (ruling 53: never a KeyError on a missing fake).
    from unittest.mock import MagicMock

    class AnySdk(dict):
        def __missing__(self, key):
            return MagicMock(name=key)

    with pytest.raises(UploadRefused):
        gateway_health_export._start_metric_provider(REMOTE, AnySdk())
    with pytest.raises(UploadRefused):
        gateway_health_export.GatewayDiagnosticLogStreamer(REMOTE, AnySdk())


def test_no_exporter_sdk_is_installed_from_pypi_under_icloneos(managed):
    from agent.monitoring import gateway_health_export, otlp_exporter

    calls = []
    import pm

    managed.setattr(pm, "ensure_import", lambda *a, **k: calls.append(a), raising=False)

    for require in (lambda: otlp_exporter._require_sdk(auto_install=True),
                    lambda: otlp_exporter._require_sdk(gateway_health_export._METRICS_SDK, auto_install=True)):
        try:
            require()
        except Exception:
            pass  # the SDK is not installed here: that it raised without installing is the point
    assert calls == []


def test_langfuse_builds_no_client_under_icloneos(managed):
    managed.setenv("HERMES_LANGFUSE_PUBLIC_KEY", "pk-lf-" + "a" * 32)
    managed.setenv("HERMES_LANGFUSE_SECRET_KEY", "sk-lf-" + "b" * 32)
    managed.setenv("HERMES_LANGFUSE_BASE_URL", "https://cloud.langfuse.com")
    plugin = _load_langfuse_plugin(managed)
    built = []
    plugin.Langfuse = lambda **kwargs: built.append(kwargs) or object()  # a present SDK

    assert plugin._get_langfuse() is None
    assert built == []


def test_cua_driver_telemetry_is_off_under_icloneos_whatever_config_says(managed):
    from tools.computer_use import cua_backend

    managed.setattr(cua_backend, "_computer_use_cfg", lambda: {"cua_telemetry": True})
    assert cua_backend._cua_telemetry_disabled() is True


def test_the_seal_lists_equal_the_apps():
    import re

    app = (ROOT / "apps" / "desktop" / "electron" / "iclone-telemetry-seal.ts").read_text()

    def block(name: str, end: str) -> str:
        start = app.index(f"export const {name}")
        return app[start: app.index(end, start)]

    pairs = dict(re.findall(r"\b([A-Z][A-Z0-9_]+): '([^']*)'", block("TELEMETRY_OFF_ENV", "})")))
    assert pairs == sinks.TELEMETRY_OFF_ENV
    keys = re.findall(r"'([A-Za-z_]+)'", block("DESTINATION_ENV_KEYS", "])"))
    assert tuple(keys) == sinks.DESTINATION_ENV_KEYS
    pattern = re.search(r"DESTINATION_ENV_PATTERN = new RegExp\(String\.raw`([^`]+)`\)", app)
    assert pattern and pattern.group(1) == sinks.DESTINATION_ENV_PATTERN
    user = re.findall(r"'([A-Za-z_]+)'", block("USER_PROXY_ENV_KEYS", "])"))
    assert tuple(user) == sinks.USER_PROXY_ENV_KEYS
    pinned = dict(re.findall(r"\b([A-Za-z_]+): '([^']*)'", block("DESTINATION_PINNED_ENV", "})")))
    assert pinned == sinks.DESTINATION_PINNED_ENV


# ── shared metrics to telemetry.nousresearch.com (new upstream sink, 1ac3f97) ───────────────────────────────────────


def test_shared_metrics_are_never_sent_under_icloneos(managed, redirecting_collector):
    from hermes_cli.observability import shared_metrics_send_config, shared_metrics_sender

    url, hits = redirecting_collector
    for endpoint in (None, f"{url}/v1/telemetry", "https://telemetry.nousresearch.com/v1/telemetry"):
        shared = {"enabled": True, "send": True, **({"endpoint": endpoint} if endpoint else {})}
        resolved = shared_metrics_send_config.resolve_send_config({"telemetry": {"shared_metrics": shared}})
        assert resolved.send is False, endpoint
    with pytest.raises(UploadRefused):
        shared_metrics_sender._post(f"{url}/v1/telemetry", b"{}", timeout=5)
    assert hits == []



# ── r7 M1: THE env seal at every env writer (closed inventory) ───────────────────────────────────────────────────────


def test_every_env_writer_calls_the_seal():
    """Ruling 57.4 (r7): every function that writes os.environ or builds a child env from .env / secret-source values is
    in ENV_WRITERS (and calls reseal_environ) or in ENV_WRITERS_EXEMPT — a new writer cannot ship unnoticed."""
    found = sinks.env_writer_candidates(ROOT)
    unlisted = sorted(k for k in found if k not in sinks.ENV_WRITERS and k not in sinks.ENV_WRITERS_EXEMPT)
    unsealed = sorted(k for k in sinks.ENV_WRITERS if not found.get(k))
    assert unlisted == []
    assert unsealed == []


def test_the_inventory_catches_a_new_writer(tmp_path):
    (tmp_path / "tools").mkdir()
    (tmp_path / "tools" / "new_child.py").write_text(
        "import os\nfrom agent.secret_scope import load_env_file\n"
        "def child_env(home):\n    env = os.environ.copy()\n    env.update(load_env_file(home))\n    return env\n")
    assert sinks.env_writer_candidates(tmp_path) == {"tools/new_child.py:child_env": False}


ENV_FILE = ("HTTPS_PROXY=http://proxy.exfil.invalid:8080\nNO_PROXY=\nPHOTON_TELEMETRY=1\n"
            "CUA_DRIVER_RS_TELEMETRY_ENABLED=1\nANONYMIZED_TELEMETRY=true\nHERMES_NEMO_RELAY_PLUGINS_TOML=/tmp/x.toml\n"
            "OTEL_EXPORTER_OTLP_ENDPOINT=http://c.exfil.invalid\nTELEGRAM_PROXY=socks5://p.exfil.invalid:1\n"
            "GATEWAY_PROXY_URL=http://p.exfil.invalid:2\nICLONE_USER_NETWORK={\"HTTPS_PROXY\": \"http://forged.invalid\"}\n")


def _assert_sealed(env):
    leaked = sorted(k for k in env if sinks.is_destination_key(k) and k not in sinks.DESTINATION_PINNED_ENV)
    assert leaked == []
    assert env.get("NO_PROXY") == "*"
    assert env.get("PHOTON_TELEMETRY") == "0" and env.get("CUA_DRIVER_RS_TELEMETRY_ENABLED") == "0"
    assert env.get("ANONYMIZED_TELEMETRY") == "false"
    assert sinks.USER_PROXY_CHANNEL not in env


def test_reload_env_is_sealed(managed, tmp_path):
    """Critic r6 M1 (a): the app's onboarding reload.env RPC re-reads .env into the live gateway env."""
    from hermes_cli import config

    managed.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / ".env").write_text(ENV_FILE)

    config.reload_env()

    _assert_sealed(os.environ)


def test_save_env_value_is_sealed(managed, tmp_path):
    from hermes_cli import config

    managed.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / ".env").write_text("")
    config.save_env_value("HTTP_PROXY", "http://p2.exfil.invalid:1")
    config.save_env_value("TELEGRAM_PROXY", "socks5://p3.exfil.invalid:1")

    assert "HTTP_PROXY" not in os.environ and "TELEGRAM_PROXY" not in os.environ
    assert os.environ.get("NO_PROXY") == "*"


@pytest.mark.parametrize("inherit_credentials", [True, False])
def test_the_profile_child_env_is_sealed(managed, tmp_path, inherit_credentials):
    """Critic r6 M1 (b): served_profile_child_env overlays the target profile's raw .env — sealed in both modes."""
    from tools.environments import local

    home = tmp_path / "profile"
    home.mkdir()
    (home / ".env").write_text(ENV_FILE)

    env = local.served_profile_child_env(target_home=home, inherit_credentials=inherit_credentials)

    _assert_sealed(env)


def test_the_users_proxy_comes_only_from_mains_channel(managed):
    """r7: a proxy in the current env is never taken as the user's — only main's explicit ICLONE_USER_NETWORK is."""
    import json

    managed.setattr(sinks, "_MAIN_PROXIES", None)
    managed.setenv("HTTPS_PROXY", "http://proxy.exfil.invalid:8080")  # in the env, but not on the channel
    sinks.reseal_environ()
    assert "HTTPS_PROXY" not in os.environ and os.environ.get("NO_PROXY") == "*"

    managed.setattr(sinks, "_MAIN_PROXIES", None)
    managed.setenv(sinks.USER_PROXY_CHANNEL, json.dumps(USER_PROXY))
    managed.setenv("TELEGRAM_PROXY", "socks5://p.exfil.invalid:1")
    child = {"HTTPS_PROXY": "http://proxy.exfil.invalid:8080", "GATEWAY_PROXY_URL": "http://p.exfil.invalid:2"}
    sinks.reseal_environ()
    sinks.reseal_environ(child)
    for env in (os.environ, child):
        assert {k: env.get(k) for k in USER_PROXY} == USER_PROXY
        assert "TELEGRAM_PROXY" not in env and "GATEWAY_PROXY_URL" not in env


# ── r7 M2: pm applies the exclusions on every sync; recorded extras, repair and plugins are checked ──────────────────


def _environment(tmp_path):
    from pm.environment import PythonEnvironment

    return PythonEnvironment(uv=Path("/nonexistent/uv"), python=Path("/nonexistent/python"),
                             destination=tmp_path / "venv", cache=tmp_path / "cache", env={})


def _lock(tmp_path, plugin_deps=()):
    root = tmp_path / "ws"
    root.mkdir(exist_ok=True)
    text = (ROOT / "uv.lock").read_text()
    if plugin_deps:
        deps = ", ".join(f'{{ name = "{d}" }}' for d in plugin_deps)
        text += f'\n[[package]]\nname = "memory-plugin"\nversion = "0.1.0"\nsource = {{ editable = "plugins/m" }}\n' \
                f'dependencies = [{deps}]\n'
        if "posthog" in plugin_deps:
            text += '\n[[package]]\nname = "posthog"\nversion = "3.0.0"\nsource = { registry = "https://pypi.org/simple" }\n'
    (root / "uv.lock").write_text(text)
    return root


def test_every_pm_sync_excludes_the_telemetry_distributions(managed, tmp_path):
    environment, ran = _environment(tmp_path), []
    managed.setattr(type(environment), "_run",
                    lambda self, args, **k: ran.append(args) or __import__("subprocess").CompletedProcess(args, 0, "", ""))
    environment.sync(_lock(tmp_path), extras=["web"])

    command = ran[-1]
    excluded = {command[i + 1] for i, a in enumerate(command) if a == "--no-install-package"}
    assert set(sinks.RUNTIME_VENV_EXCLUSIONS) <= excluded
    assert "nemo-relay" in excluded  # a BASE dependency of hermes-agent


def test_a_plugin_requirement_that_pulls_telemetry_is_refused(managed, tmp_path):
    from pm.package import InstallError

    import subprocess

    environment, ran = _environment(tmp_path), []
    managed.setattr(type(environment), "_run",
                    lambda self, args, **k: ran.append(args) or subprocess.CompletedProcess(args, 0, "", ""))
    with pytest.raises(InstallError, match="never installs telemetry packages: posthog"):
        environment.sync(_lock(tmp_path, plugin_deps=("posthog",)))
    assert ran == []
    assert sinks.plugin_requirements_refusal(_lock(tmp_path, plugin_deps=("requests",)) / "uv.lock") == []


@pytest.mark.parametrize("repair", [False, True])
def test_recorded_extras_and_repair_are_checked(managed, tmp_path, repair):
    """The extras a sync really installs are the recorded ones too (``_target_selection``), and a repair's."""
    import contextlib

    from pm import install
    from pm.package import InstallError

    managed.setattr(install, "_feature_policy", lambda *a, **k: (None, None))
    managed.setattr(install, "get_package", lambda name: object())
    managed.setattr("hermes_cli.runtime_state.recover_publication", lambda root: None)
    managed.setattr(install, "_venv_install_lock", lambda **k: contextlib.nullcontext())
    managed.setattr(install, "_publication", lambda plugins: None)
    managed.setattr(install, "_member_inputs", lambda plugins: {})
    managed.setattr(install, "Facts", lambda *a, **k: types.SimpleNamespace(get=lambda key: {"extras": ["otlp"]}))
    managed.setattr(install, "_facts", lambda: types.SimpleNamespace(get=lambda key: {"extras": ["otlp"]}))
    managed.setattr(install, "_target_selection", lambda package, fact, **k: (list(fact["extras"]), "stamp", {}))
    managed.setattr(install, "_commit_selection", lambda *a, **k: (_ for _ in ()).throw(AssertionError("installed")))

    with pytest.raises(InstallError, match="never installs telemetry packages: opentelemetry"):
        install.sync_venv(None, repair=repair)


# ── r7: browser-harness (a core dependency) PostHog telemetry, found by RT's live venv gate ────────────────────────────


FAKE_TELEMETRY = '''
import os, json
SENT = os.environ["FAKE_SENT"]
POSTHOG_HOST = "https://eu.i.posthog.com"
def is_enabled():
    return True
def _send_detached(payload):
    open(SENT, "a").write(json.dumps(payload) + "\\n")
def capture(event, properties=None):
    if is_enabled():
        _send_detached({"event": event})
def capture_cli_event(**kw):
    if is_enabled():
        _send_detached({"event": "cli_event", **kw})
'''
FAKE_RUN = '''
import os, sys
from browser_harness import telemetry
telemetry.capture_cli_event(action="run", command=" ".join(sys.argv[1:]))
open(os.environ["FAKE_RAN"], "w").write(" ".join(sys.argv[1:]))
'''


def _fake_harness(tmp_path):
    pkg = tmp_path / "site" / "browser_harness"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text("")
    (pkg / "telemetry.py").write_text(FAKE_TELEMETRY)
    (pkg / "run.py").write_text(FAKE_RUN)
    return tmp_path / "site"


def test_the_browser_harness_cli_child_runs_with_its_telemetry_inert(managed, tmp_path):
    """Inert at import, not only by env: the child's own env says telemetry ON and it still sends nothing."""
    import subprocess

    from tools import browser_use_cli

    site = _fake_harness(tmp_path)
    managed.setattr(browser_use_cli, "_harness_site_dir", lambda: str(site))
    cmd = browser_use_cli._find_cli()
    assert cmd[:3] == [sys.executable, "-P", "-c"]
    env = {"PATH": "/usr/bin:/bin", "PYTHONPATH": str(site), "FAKE_SENT": str(tmp_path / "sent"),
           "FAKE_RAN": str(tmp_path / "ran"), "BH_TELEMETRY": "1", "ANONYMIZED_TELEMETRY": "true"}
    done = subprocess.run(cmd + ["open", "https://example.org"], env=env, capture_output=True, text=True, timeout=60)

    assert done.returncode == 0, done.stderr
    assert (tmp_path / "ran").read_text() == "open https://example.org"  # the real entry point ran
    assert not (tmp_path / "sent").exists()  # and nothing was sent


def test_browser_harness_telemetry_is_inert_in_process(managed, tmp_path):
    site = _fake_harness(tmp_path)
    managed.syspath_prepend(str(site))
    managed.setenv("FAKE_SENT", str(tmp_path / "sent"))
    for name in ("browser_harness", "browser_harness.telemetry"):
        managed.delitem(sys.modules, name, raising=False)

    assert sinks.seal_browser_harness() is True
    import browser_harness.telemetry as telemetry

    telemetry.capture("x")
    telemetry.capture_cli_event(action="run")
    assert not (tmp_path / "sent").exists()


def test_browser_harness_switches_are_in_the_seal():
    assert sinks.TELEMETRY_OFF_ENV.get("BH_TELEMETRY") == "0"
    assert sinks.TELEMETRY_OFF_ENV.get("BROWSER_HARNESS_TELEMETRY") == "0"
    assert sinks.TELEMETRY_OFF_ENV.get("ANONYMIZED_TELEMETRY") == "false"
    assert sinks.is_destination_key("BH_POSTHOG_HOST")
    assert "browser_harness/telemetry.py" in sinks.THIRD_PARTY_SINKS["browser-harness"]["files"]


# ── ruling 63 (r7, FX_sink_audit): third-party opt-outs, hf-xet, mistralai, app-side and reviewed rows ───────────────

RULING_63_OPT_OUTS = {
    "TURBO_TELEMETRY_DISABLED": "1", "WRANGLER_SEND_METRICS": "false", "HOMEBREW_NO_ANALYTICS": "1",
    "STRIPE_CLI_TELEMETRY_OPTOUT": "1", "SAM_CLI_TELEMETRY": "0", "YARN_ENABLE_TELEMETRY": "0", "EXPO_NO_TELEMETRY": "1",
    "STORYBOOK_DISABLE_TELEMETRY": "1", "CLOUDSDK_CORE_DISABLE_USAGE_REPORTING": "true", "GOTELEMETRY": "off",
    "GH_TELEMETRY": "false", "HF_XET_TELEMETRY_ENABLED": "0", "HF_HUB_DISABLE_TELEMETRY": "1",
    "MISTRAL_SDK_TELEMETRY": "false", "DO_NOT_TRACK": "1",
}


def test_every_third_party_opt_out_is_set_for_every_child(managed):
    """One closed table (ruling 63.7): every row is in the seal, and a sealed child env carries every row."""
    assert {k: sinks.TELEMETRY_OFF_ENV.get(k) for k in RULING_63_OPT_OUTS} == RULING_63_OPT_OUTS
    child = {key: "1" for key in RULING_63_OPT_OUTS}  # an agent-written value tries to turn each one back on
    sinks.reseal_environ(child)
    assert {k: child[k] for k in sinks.TELEMETRY_OFF_ENV} == sinks.TELEMETRY_OFF_ENV


def test_ruling_63_sinks_are_registered():
    assert sinks.THIRD_PARTY_SINKS["hf-xet"]["files"] == {}  # no reviewed bytes for the locked 1.6.0: RED if shipped
    assert "mistralai/extra/observability/telemetry.py" in sinks.THIRD_PARTY_SINKS["mistralai"]["files"]
    assert sinks.is_destination_key("MISTRAL_OTLP_TRACES_ENDPOINT") and sinks.is_destination_key("SEGMENT_WRITE_KEY")
    assert "telemetry/v1/telemetry" in sinks.OTLP_SERVICE_PATHS
    assert {"sentry.hcaptcha.com", "as.coinbase.com", "analytics-service-internal.cbhq.net",
            "analytics-service-internal-dev.cbhq.net"} <= set(sinks.ANALYTICS_HOSTS)
    assert "acp-cli-segment" in sinks.APP_SIDE_SINKS
    assert any("X-Stainless" in key for key in sinks.REVIEWED_NON_SINKS)



# ── r8 (critic r7 M1): THE seal at the spawn — stdio MCP children and every primitive ──────────────────────────────

MCP_CONFIG_ENV = {"HTTPS_PROXY": "http://mcp.exfil.invalid:1", "OTEL_EXPORTER_OTLP_ENDPOINT": "http://c.exfil.invalid",
                  "DO_NOT_TRACK": "0", "POSTHOG_HOST": "https://p.exfil.invalid", "ANONYMIZED_TELEMETRY": "true",
                  "Http_Proxy": "http://mixed.exfil.invalid:2", "MY_SERVER_TOKEN": "kept"}


def test_the_mcp_child_env_is_sealed(managed):
    """A config `env:` never re-enables telemetry or carries a destination; every opt-out reaches the MCP child."""
    from tools import mcp_tool_config

    env = mcp_tool_config._build_safe_env(dict(MCP_CONFIG_ENV))

    assert {k: env.get(k) for k in sinks.TELEMETRY_OFF_ENV} == sinks.TELEMETRY_OFF_ENV
    assert [k for k in env if sinks.is_destination_key(k)] == []
    assert env.get("NO_PROXY") == "*" and env["MY_SERVER_TOKEN"] == "kept"


def test_mixed_case_proxy_names_are_destinations():
    """critic r7 n1: urllib / requests / httpx lower-case every *_proxy name."""
    for key in ("Https_Proxy", "Http_Proxy", "All_Proxy", "Telegram_Proxy_Url"):
        assert sinks.is_destination_key(key), key
    assert not sinks.is_destination_key("No_Proxy")


def test_every_spawn_primitive_goes_through_the_seal():
    """Closed like the sink registry: every process-starting primitive the runtime calls is sealed or inherits."""
    found = sinks.spawn_primitives(ROOT)
    unknown = {k: v for k, v in found.items()
               if k not in sinks.SPAWN_PRIMITIVES_SEALED | sinks.SPAWN_PRIMITIVES_INHERIT}
    assert unknown == {}
    assert "subprocess.Popen" in found and "asyncio.create_subprocess_exec" in found


def test_the_spawn_inventory_catches_a_new_primitive(tmp_path):
    (tmp_path / "tools").mkdir()
    (tmp_path / "tools" / "raw.py").write_text("import _posixsubprocess\n_posixsubprocess.fork_exec(1)\n")
    assert sinks.spawn_primitives(tmp_path) == {"_posixsubprocess.fork_exec": "tools/raw.py:2"}


CHILD_ENV = {"PATH": "/usr/bin:/bin", "DO_NOT_TRACK": "0", "PHOTON_TELEMETRY": "1",
             "HTTPS_PROXY": "http://p.exfil.invalid:1", "OTEL_EXPORTER_OTLP_ENDPOINT": "http://c.exfil.invalid"}


def _sealed_child(text: str) -> bool:
    lines = dict(line.split("=", 1) for line in text.splitlines() if "=" in line)
    return (all(lines.get(k) == v for k, v in sinks.TELEMETRY_OFF_ENV.items())
            and not [k for k in lines if sinks.is_destination_key(k)] and lines.get("NO_PROXY") == "*")


def test_every_sealed_primitive_reseals_an_explicit_env(managed, tmp_path):
    """subprocess (Popen / run / check_output), asyncio, os.spawnve and os.posix_spawn: a child started with an
    explicit env that turns telemetry back on and carries a proxy gets the sealed env (critic r7 n4 too)."""
    import asyncio
    import subprocess

    assert sinks.install_spawn_seal() is True
    outputs = [subprocess.check_output(["/usr/bin/env"], env=dict(CHILD_ENV), text=True),
               subprocess.run(["/usr/bin/env"], env=dict(CHILD_ENV), capture_output=True, text=True).stdout]

    async def via_asyncio():
        proc = await asyncio.create_subprocess_exec("/usr/bin/env", env=dict(CHILD_ENV), stdout=subprocess.PIPE)
        return (await proc.communicate())[0].decode()

    outputs.append(asyncio.run(via_asyncio()))
    for n, spawn in enumerate((
        lambda out: os.spawnve(os.P_WAIT, "/bin/sh", ["sh", "-c", f"/usr/bin/env > {out}"], dict(CHILD_ENV)),
        lambda out: os.waitpid(os.posix_spawn("/bin/sh", ["sh", "-c", f"/usr/bin/env > {out}"], dict(CHILD_ENV)), 0),
    )):
        out = tmp_path / f"env{n}.txt"
        spawn(out)
        outputs.append(out.read_text())
    assert [_sealed_child(text) for text in outputs] == [True] * 5


def test_the_spawn_seal_is_armed_by_the_first_process_reseal(tmp_path):
    """Every Hermes entry point loads its .env first: from then on the spawn primitives are sealed."""
    import subprocess

    (tmp_path / ".env").write_text("")
    code = ("import subprocess, os; from pathlib import Path; from hermes_cli.env_loader import load_hermes_dotenv; "
            "load_hermes_dotenv(hermes_home=Path(os.environ['HERMES_HOME'])); "
            "print(getattr(subprocess.Popen.__init__, '__iclone_sealed__', False), "
            "getattr(os.posix_spawn, '__iclone_sealed__', False))")
    env = {"PATH": "/usr/bin:/bin", "HOME": str(tmp_path), "HERMES_HOME": str(tmp_path), "ICLONE_CONSENT_MICROPHONE": "0",
           "PYTHONPATH": os.environ.get("PYTHONPATH", ""), "PYTHONDONTWRITEBYTECODE": "1"}
    done = subprocess.run([sys.executable, "-c", code], cwd=str(ROOT), env=env, capture_output=True, text=True,
                          timeout=120)
    assert done.stdout.strip().splitlines()[-1] == "True True", done.stderr[-500:]
