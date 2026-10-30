"""iclone-seam: v3fx-no-upload (ruling 47, V3-FX r3 M3-r2).

The agent runs ``hermes debug share`` from its own terminal: a CLI subcommand that never loads plugins, so only the
runtime's own seam (hermes_cli/iclone_no_upload.py) can refuse it. These tests run it exactly that way — a ``hermes``
on the terminal's PATH, the environment the app's spawn seal always carries, the network trapped (every connect and
name lookup recorded and refused) — and require 0 network attempts, a non-zero exit and the plain message.
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

CONSENT_KEYS = ("AUTOMATION", "CLIPBOARD", "SCREEN", "TERMINAL", "FILE_WRITING", "WEB_BROWSING", "INSTALL_SOFTWARE",
                "SCHEDULED_TASKS", "SEND_MESSAGES", "SPEND_TRADE", "MICROPHONE", "NOTIFICATIONS", "KEYCHAIN")
SPAWN_ENV = {f"ICLONE_CONSENT_{key}": "ask" for key in CONSENT_KEYS}

TRAP = textwrap.dedent('''
    import json, os, socket
    _LOG = os.environ["FX_TRAP_LOG"]
    def _record(kind, target):
        with open(_LOG, "a") as fh:
            fh.write(json.dumps([kind, str(target)]) + "\\n")
        raise OSError("network trapped by the test")
    socket.socket.connect = lambda self, address: _record("connect", address)
    socket.socket.connect_ex = lambda self, address: _record("connect_ex", address)
    socket.create_connection = lambda address, *a, **k: _record("create_connection", address)
    socket.getaddrinfo = lambda host, *a, **k: _record("getaddrinfo", host)
''')


@pytest.fixture()
def agent_terminal(tmp_path):
    """A `hermes` on PATH as the agent's terminal has it, running this tree's CLI with the network trapped."""
    trap_dir = tmp_path / "trap"
    trap_dir.mkdir()
    (trap_dir / "_fx_net_trap.py").write_text(TRAP)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    shim = bin_dir / "hermes"
    shim.write_text(
        "#!/bin/sh\n"
        f'exec "{sys.executable}" -c "import sys, runpy, _fx_net_trap; sys.argv = [\'hermes\'] + sys.argv[1:]; '
        f'runpy.run_module(\'hermes_cli.main\', run_name=\'__main__\')" "$@"\n'
    )
    shim.chmod(shim.stat().st_mode | stat.S_IXUSR)
    home = tmp_path / "hermes-home"
    home.mkdir()
    log = tmp_path / "net.log"
    overlay = [p for p in os.environ.get("PYTHONPATH", "").split(os.pathsep) if p and Path(p).resolve() != ROOT]

    def run(args, *, spawn_env=True):
        env = {
            "PATH": f"{bin_dir}:/usr/bin:/bin",
            "HOME": str(tmp_path),
            "HERMES_HOME": str(home),
            "PYTHONPATH": os.pathsep.join([str(ROOT), str(trap_dir), *overlay]),
            "ICLONE_GATE_TREE": str(ROOT),
            "PYTHONDONTWRITEBYTECODE": "1",
            "FX_TRAP_LOG": str(log),
            "NO_COLOR": "1",
        }
        if spawn_env:
            env.update(SPAWN_ENV)
        log.write_text("")
        done = subprocess.run(["hermes", *args], env=env, capture_output=True, text=True, timeout=120,
                              stdin=subprocess.DEVNULL, cwd=tmp_path)
        attempts = [json.loads(line) for line in log.read_text().splitlines() if line.strip()]
        return done, attempts

    return run


@pytest.mark.parametrize("args", [["debug", "share", "--yes"], ["debug", "share", "--nous", "--yes"], ["debug", "share"]])
def test_the_agent_cannot_upload_with_hermes_debug_share(agent_terminal, args):
    done, attempts = agent_terminal(args)

    assert attempts == [], f"network attempted: {attempts}"
    assert done.returncode != 0
    assert "icloneOS never uploads diagnostics or logs" in done.stderr
    assert "Settings › Machine › Diagnostics › Save report" in done.stderr
    assert "Uploading" not in done.stdout


def test_the_local_report_still_works_and_touches_no_network(agent_terminal):
    done, attempts = agent_terminal(["debug", "share", "--local"])

    assert attempts == []
    assert done.returncode == 0, done.stderr[-2000:]


def test_control_outside_icloneos_the_same_command_does_reach_for_the_network(agent_terminal):
    """Proves the trap sees an upload: plain Hermes (no app environment, no managed stamp) tries paste.rs."""
    done, attempts = agent_terminal(["debug", "share", "--yes"], spawn_env=False)

    assert any("paste.rs" in target or "dpaste" in target for _, target in attempts), (attempts, done.stderr[-1500:])


def test_a_stripped_environment_is_still_refused_inside_the_managed_runtime(tmp_path, monkeypatch):
    """The runtime the app manages carries ICLONE_MANAGED.json at its root: env or not, it is icloneOS."""
    from hermes_cli import iclone_no_upload as seam

    assert seam.under_icloneos(env={}, root=tmp_path) is False
    (tmp_path / seam.MANAGED_STAMP).write_text("{}")
    assert seam.under_icloneos(env={}, root=tmp_path) is True
    assert seam.under_icloneos(env={"ICLONE_CONSENT_MICROPHONE": "0"}, root=tmp_path / "nowhere") is True


def test_every_network_function_of_the_debug_share_path_refuses_in_process(monkeypatch):
    for key, value in SPAWN_ENV.items():
        monkeypatch.setenv(key, value)
    # The runtime's own modules, fresh: another test may have left the plugin's (second-layer) patch on them.
    import hermes_cli

    for name in ("hermes_cli.debug", "hermes_cli.diagnostics_upload"):
        # Restored afterwards as a PAIR (sys.modules entry and package attribute), or a later reload breaks.
        monkeypatch.setattr(hermes_cli, name.rsplit(".", 1)[1], getattr(hermes_cli, name.rsplit(".", 1)[1], None),
                            raising=False)
        monkeypatch.delitem(sys.modules, name, raising=False)
    import importlib

    debug = importlib.import_module("hermes_cli.debug")
    diagnostics_upload = importlib.import_module("hermes_cli.diagnostics_upload")
    from hermes_cli.iclone_no_upload import UploadRefused

    for call in (lambda: debug._upload_paste_rs("x"), lambda: debug._upload_dpaste_com("x"),
                 lambda: debug.upload_to_pastebin("x"), lambda: debug.build_debug_share(),
                 lambda: diagnostics_upload.share_to_nous(b"x"), lambda: diagnostics_upload.request_upload_url()):
        with pytest.raises(UploadRefused, match="never uploads"):
            call()


# ── r4 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────


def test_hermes_debug_delete_contacts_no_paste_service(agent_terminal):
    """A paste URL handed to `debug delete` is a channel out too: refused, 0 attempts, exit non-zero."""
    done, attempts = agent_terminal(["debug", "delete", "https://paste.rs/abc123"])

    assert attempts == [], f"network attempted: {attempts}"
    assert done.returncode != 0
    assert "icloneOS never uploads diagnostics or logs" in done.stderr


def test_the_default_root_is_where_the_app_writes_the_stamp(tmp_path):
    """n1: with no env and no root given, the stamp at the runtime tree's own root (where the app writes it) counts."""
    import importlib.util

    from hermes_cli import iclone_no_upload as seam

    assert seam._RUNTIME_ROOT == ROOT

    # The same module in a copy of the tree layout: <root>/hermes_cli/iclone_no_upload.py with the stamp at <root>.
    copy_root = tmp_path / "runtime"
    (copy_root / "hermes_cli").mkdir(parents=True)
    module_file = copy_root / "hermes_cli" / "iclone_no_upload.py"
    module_file.write_text((ROOT / "hermes_cli" / "iclone_no_upload.py").read_text())
    spec = importlib.util.spec_from_file_location("fx_seam_copy", module_file)
    copy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(copy)

    assert copy.under_icloneos(env={}) is False
    (copy_root / "ICLONE_MANAGED.json").write_text("{}")
    assert copy.under_icloneos(env={}) is True


def test_the_sweep_and_the_bundle_put_touch_no_network_under_icloneos(monkeypatch):
    for key, value in SPAWN_ENV.items():
        monkeypatch.setenv(key, value)
    import hermes_cli

    for name in ("hermes_cli.debug", "hermes_cli.diagnostics_upload"):
        # Restored afterwards as a PAIR (sys.modules entry and package attribute), or a later reload breaks.
        monkeypatch.setattr(hermes_cli, name.rsplit(".", 1)[1], getattr(hermes_cli, name.rsplit(".", 1)[1], None),
                            raising=False)
        monkeypatch.delitem(sys.modules, name, raising=False)
    import importlib

    debug = importlib.import_module("hermes_cli.debug")
    uploads = importlib.import_module("hermes_cli.diagnostics_upload")
    from hermes_cli.iclone_no_upload import UploadRefused

    monkeypatch.setattr(debug, "_load_pending", lambda: [{"url": "https://paste.rs/x", "expire_at": 0}])
    monkeypatch.setattr(debug.urllib.request, "urlopen", lambda *a, **k: (_ for _ in ()).throw(AssertionError("net")))
    assert debug._sweep_expired_pastes() == (0, 0)
    with pytest.raises(UploadRefused):
        debug.delete_paste("https://paste.rs/x")
    with pytest.raises(UploadRefused):
        uploads.put_bundle("https://example.invalid/put", b"x")


@pytest.mark.parametrize(
    "endpoint",
    ["http://localhost:4318/v1/traces", "http://127.0.0.1:4318", "http://[::1]:4318/v1/traces",
     "https://collector.example.com/v1/traces"],
)
def test_otlp_export_is_never_allowed_under_icloneos(endpoint):
    """Ruling 57.1: no enable path in v0.0.3 — not a config value, not an env value handed to the child."""
    from hermes_cli.iclone_no_upload import telemetry_endpoint_allowed

    assert telemetry_endpoint_allowed(endpoint, env=dict(SPAWN_ENV)) is False
    assert telemetry_endpoint_allowed(endpoint, env=dict(SPAWN_ENV, ICLONE_OTLP_ENDPOINT=endpoint)) is False
    # Plain Hermes (no app env, no stamp) is untouched.
    assert telemetry_endpoint_allowed(endpoint, env={}, root=ROOT / "nowhere") is True


def test_otlp_config_from_config_yaml_is_not_enabled_and_cannot_build(monkeypatch):
    for key, value in SPAWN_ENV.items():
        monkeypatch.setenv(key, value)
    from agent.monitoring import gateway_health_export, otlp_exporter
    from hermes_cli.iclone_no_upload import UploadRefused

    remote = {"monitoring": {"gateway_health_export": {"enabled": True},
                             "export": {"otlp": {"enabled": True, "endpoint": "https://collector.example.com/v1/traces"}}}}
    local = {"monitoring": {"gateway_health_export": {"enabled": True},
                            "export": {"otlp": {"enabled": True, "endpoint": "http://127.0.0.1:4318/v1/traces"}}}}

    assert otlp_exporter.is_enabled(remote) is False
    assert gateway_health_export._enabled(remote) is False
    # Ruling 57: a loopback collector in config.yaml is off too.
    assert otlp_exporter.is_enabled(local) is False
    assert gateway_health_export._enabled(local) is False
    monkeypatch.setattr(otlp_exporter, "_require_sdk", lambda **_: {"OTLPSpanExporter": lambda **k: k})
    with pytest.raises(UploadRefused):
        otlp_exporter.build_exporter(remote)
    with pytest.raises(UploadRefused):
        gateway_health_export._start_metric_provider(remote, {"OTLPMetricExporter": lambda **k: k})
