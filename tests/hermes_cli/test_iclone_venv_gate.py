"""iclone-seam: v3fx-sinks — ruling 57.2 (V3-FX r6): the packaging gate of the shipped runtime venv.

Synthetic venvs prove each red reason (a denylisted distribution under any spelling, a native library or a module with
an OTLP service path or an analytics host, a first-party file the registry does not name) and the green case; the
exclusion list the RT pack applies equals the pinned lock's denylisted packages.
"""

from __future__ import annotations

import importlib.util
import sys
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("fx_venv_gate", ROOT / "iclone" / "telemetry" / "venv_gate.py")
gate = importlib.util.module_from_spec(spec)
sys.modules["fx_venv_gate"] = gate
spec.loader.exec_module(gate)

MACHO = b"\xcf\xfa\xed\xfe" + b"\0" * 60


def _venv(tmp_path: Path) -> Path:
    venv = tmp_path / "venv"
    site = venv / "lib" / "python3.11" / "site-packages"
    site.mkdir(parents=True)
    (venv / "bin").mkdir()
    _dist(site, "requests", "2.32.0", {"requests/__init__.py": b"import urllib3\n"})
    return venv


def _site(venv: Path) -> Path:
    return venv / "lib" / "python3.11" / "site-packages"


def _dist(site: Path, name: str, version: str, files: dict) -> None:
    meta = site / f"{name.replace('-', '_')}-{version}.dist-info"
    meta.mkdir()
    (meta / "METADATA").write_text(f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n\n")
    record = []
    for rel, data in files.items():
        path = site / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        record.append(f"{rel},,")
    (meta / "RECORD").write_text("\n".join(record) + "\n")


def test_a_clean_venv_is_green(tmp_path):
    report = gate.scan(_venv(tmp_path))
    assert report["ok"] is True
    assert report["distributions"] == 1 and report["modules"] == 1


@pytest.mark.parametrize("name", ["nemo-relay", "nemo_relay", "Opentelemetry_Exporter_OTLP_Proto_HTTP", "PostHog",
                                  "sentry-sdk", "segment-analytics-python", "mixpanel", "amplitude-analytics", "ddtrace",
                                  "libhoney", "langfuse", "opentelemetry-proto"])
def test_a_denylisted_distribution_is_red_under_any_spelling(tmp_path, name):
    venv = _venv(tmp_path)
    _dist(_site(venv), name, "1.0", {})
    report = gate.scan(venv)
    assert report["ok"] is False
    assert report["denied_distributions"] == [f"{name}==1.0"]


def test_a_native_library_with_an_otlp_service_path_is_red(tmp_path):
    venv = _venv(tmp_path)
    blob = MACHO + b"\0opentelemetry.proto.collector.trace.v1.TraceService\0"
    _dist(_site(venv), "innocent-native", "1.0", {"innocent/_native.abi3.so": blob})
    report = gate.scan(venv)
    assert report["ok"] is False
    assert report["content_hits"][0]["file"].endswith("innocent/_native.abi3.so")
    assert report["content_hits"][0]["native"] is True


def test_an_executable_without_a_suffix_is_read_as_native(tmp_path):
    venv = _venv(tmp_path)
    tool = venv / "bin" / "helper"
    tool.write_bytes(MACHO + b"https://api.segment.io/v1/track")
    tool.chmod(0o755)
    report = gate.scan(venv)
    assert [h["file"] for h in report["content_hits"]] == ["bin/helper"]


def test_a_module_with_an_analytics_host_is_red(tmp_path):
    venv = _venv(tmp_path)
    _dist(_site(venv), "chatty", "1.0", {"chatty/ping.py": b"URL = 'https://us.i.posthog.com/capture'\n"})
    report = gate.scan(venv)
    assert report["ok"] is False
    assert report["content_hits"][0]["found"] == ["posthog.com"]


def test_a_first_party_file_passes_only_when_the_registry_names_it(tmp_path):
    venv = _venv(tmp_path)
    _dist(_site(venv), "hermes-agent", "0.21.3", {
        "agent/monitoring/otlp_exporter.py": b"PATH = '/v1/traces'\n",
        "tools/new_ping.py": b"PATH = 'https://api.mixpanel.com/track'\n",
    })
    report = gate.scan(venv)
    assert [r["file"].split("site-packages/")[1] for r in report["registered_first_party"]] == [
        "agent/monitoring/otlp_exporter.py"]
    assert [h["file"].split("site-packages/")[1] for h in report["content_hits"]] == ["tools/new_ping.py"]


def test_an_empty_venv_is_not_green(tmp_path):
    (tmp_path / "empty").mkdir()
    assert gate.scan(tmp_path / "empty")["ok"] is False


def test_the_cli_exit_code(tmp_path, capsys):
    venv = _venv(tmp_path)
    assert gate.main([str(venv)]) == 0
    _dist(_site(venv), "posthog", "3.0", {})
    assert gate.main([str(venv)]) == 1
    assert "DENIED distribution posthog==3.0" in capsys.readouterr().out


def test_the_exclusion_list_is_every_denylisted_package_of_the_pinned_lock():
    from hermes_cli import iclone_sinks

    lock = tomllib.loads((ROOT / "uv.lock").read_text())
    denied = sorted(p["name"] for p in lock["package"] if iclone_sinks.distribution_denied(p["name"]))
    assert sorted(gate.exclusion_list()) == denied
    assert "nemo-relay" in denied


# ── r7 n3: fail closed (ruling 58.1) ─────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(("rel", "data"), [
    ("chatty/__pycache__/ping.cpython-311.pyc", b"\x00\x00https://us.i.posthog.com/capture"),
    ("chatty/ping.js", b"fetch('https://o1.ingest.sentry.io/api/1/envelope/')"),
    ("chatty/ping.pyw", b"URL = 'https://api.segment.io/v1/t'"),
])
def test_compiled_and_script_files_are_read(tmp_path, rel, data):
    venv = _venv(tmp_path)
    _dist(_site(venv), "chatty", "1.0", {rel: data})
    report = gate.scan(venv)
    assert report["ok"] is False
    assert [h["file"].split("site-packages/")[1] for h in report["content_hits"]] == [rel]


def test_an_archive_is_opened(tmp_path):
    import io
    import zipfile

    venv = _venv(tmp_path)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("seg/ping.py", "URL = 'https://api.segment.io/v1/t'\n")
        zf.writestr("EGG-INFO/PKG-INFO", "Metadata-Version: 2.1\nName: segment-analytics-python\nVersion: 2\n")
    (_site(venv) / "seg-2.egg").write_bytes(buf.getvalue())
    report = gate.scan(venv)
    assert report["ok"] is False
    assert any("segment-analytics-python" in d for d in report["denied_distributions"])
    assert report["content_hits"][0]["file"].endswith("seg-2.egg")


def test_an_unreadable_file_is_red(tmp_path):
    import os

    venv = _venv(tmp_path)
    _dist(_site(venv), "locked", "1.0", {"locked/mod.py": b"URL = 'https://app.posthog.com'\n"})
    target = _site(venv) / "locked" / "mod.py"
    target.chmod(0)
    try:
        if os.access(target, os.R_OK):
            pytest.skip("running as a user that can read mode-000 files")
        report = gate.scan(venv)
    finally:
        target.chmod(0o644)
    assert report["ok"] is False
    assert any("locked/mod.py" in u for u in report["unreadable"])


def test_a_dist_info_without_metadata_is_red(tmp_path):
    venv = _venv(tmp_path)
    (_site(venv) / "posthog-3.0.dist-info").mkdir()
    report = gate.scan(venv)
    assert report["ok"] is False
    assert any("posthog-3.0.dist-info" in u for u in report["unreadable"])


def test_a_symlinked_module_is_read_through(tmp_path):
    venv = _venv(tmp_path)
    outside = tmp_path / "outside.py"
    outside.write_text("URL = 'https://api.mixpanel.com/track'\n")
    (_site(venv) / "linked.py").symlink_to(outside)
    report = gate.scan(venv)
    assert [h["file"].split("site-packages/")[1] for h in report["content_hits"]] == ["linked.py"]


def test_the_exclusion_file_equals_the_runtime_constant():
    from hermes_cli import iclone_sinks

    assert sorted(gate.exclusion_list()) == sorted(iclone_sinks.RUNTIME_VENV_EXCLUSIONS)


# ── r7: sinks inside third-party distributions ───────────────────────────────────────────────────────────────────────


def _reviewed(monkeypatch, dist, rel, data):
    import hashlib

    from hermes_cli import iclone_sinks

    entry = {"files": {rel: hashlib.sha256(data).hexdigest()}}
    monkeypatch.setitem(iclone_sinks.THIRD_PARTY_SINKS, dist, entry)


def test_a_third_party_telemetry_module_is_red_unless_registered(tmp_path, monkeypatch):
    venv = _venv(tmp_path)
    sender = b"import urllib.request\nHOST = 'https://eu.i.posthog.com'\nurllib.request.urlopen(HOST)\n"
    _reviewed(monkeypatch, "browser-harness", "browser_harness/telemetry.py", sender)
    _dist(_site(venv), "browser-harness", "0.1.13", {"browser_harness/telemetry.py": sender})
    report = gate.scan(venv)
    assert report["ok"] is True  # registered in THIRD_PARTY_SINKS and made inert in code
    assert [r.get("third_party") for r in report["registered_first_party"]] == ["browser-harness"]

    _dist(_site(venv), "other-tool", "1.0", {"other_tool/telemetry.py": b"import urllib.request\nurl = cfg['host']\n"})
    report = gate.scan(venv)
    assert report["ok"] is False
    assert report["content_hits"][0]["found"] == ["telemetry module with an HTTP client"]


def test_a_registered_path_with_other_bytes_is_red(tmp_path, monkeypatch):
    """Ruling 58.2 (critic r7 n2): allowed by the reviewed bytes, never by the path alone."""
    venv = _venv(tmp_path)
    _reviewed(monkeypatch, "browser-harness", "browser_harness/telemetry.py", b"the reviewed bytes")
    evil = b"import urllib.request\nurllib.request.urlopen('https://api.mixpanel.com/track')\n"
    _dist(_site(venv), "browser-harness", "0.1.99", {"browser_harness/telemetry.py": evil})
    report = gate.scan(venv)
    assert report["ok"] is False
    assert report["content_hits"][0]["file"].endswith("browser_harness/telemetry.py")


def test_the_shipped_browser_harness_digest_is_the_reviewed_one():
    from hermes_cli import iclone_sinks

    assert iclone_sinks.THIRD_PARTY_SINKS["browser-harness"]["files"] == {
        "browser_harness/telemetry.py": "8d48b95afe4b149c2be115e0df18dd9f62496148a194277702d74829455cfa94"}


def test_a_symlinked_package_directory_is_followed_and_a_loop_ends(tmp_path):
    """Ruling 58.1 (critic r7 n3)."""
    venv = _venv(tmp_path)
    outside = tmp_path / "outside_pkg"
    outside.mkdir()
    (outside / "ping.py").write_text("URL = 'https://us.i.posthog.com'\n")
    (outside / "loop").symlink_to(outside)  # a directory loop
    (_site(venv) / "linkedpkg").symlink_to(outside)
    report = gate.scan(venv)
    assert report["ok"] is False
    assert any(h["file"].endswith("linkedpkg/ping.py") for h in report["content_hits"])


def test_a_registered_third_party_file_with_a_new_name_is_still_red(tmp_path):
    venv = _venv(tmp_path)
    _dist(_site(venv), "browser-harness", "0.2.0", {"browser_harness/analytics.py": b"URL='https://us.i.posthog.com'"})
    assert gate.scan(venv)["ok"] is False


def test_a_third_party_compiled_module_counts_as_its_source(tmp_path, monkeypatch):
    """uv --compile-bytecode writes .pyc files no RECORD lists: they belong to their source's distribution."""
    venv = _venv(tmp_path)
    sender = b"import urllib.request\nHOST = 'https://eu.i.posthog.com'\n"
    _reviewed(monkeypatch, "browser-harness", "browser_harness/telemetry.py", sender)
    _dist(_site(venv), "browser-harness", "0.1.13", {"browser_harness/telemetry.py": sender})
    (_site(venv) / "browser_harness" / "__pycache__").mkdir()
    (_site(venv) / "browser_harness" / "__pycache__" / "telemetry.cpython-314.pyc").write_bytes(b"\0" + sender)
    report = gate.scan(venv)
    assert report["ok"] is True


# ── ruling 63: the hf-xet endpoint and a Sentry envelope on any host are on the denylist ─────────────────────────────


def test_the_hf_xet_telemetry_path_is_red_unless_it_is_the_registered_library(tmp_path, monkeypatch):
    venv = _venv(tmp_path)
    blob = MACHO + b"\0emitting telemetry/v1/telemetry\0"
    _reviewed(monkeypatch, "hf-xet", "hf_xet/hf_xet.abi3.so", blob)
    _dist(_site(venv), "hf-xet", "1.6.0", {"hf_xet/hf_xet.abi3.so": blob})
    assert gate.scan(venv)["ok"] is True  # registered: env-sealed (HF_XET_TELEMETRY_ENABLED=0)
    _dist(_site(venv), "other-native", "1.0", {"other/_x.abi3.so": blob})
    report = gate.scan(venv)
    assert report["ok"] is False
    assert report["content_hits"][0]["found"] == ["telemetry/v1/telemetry"]


def test_a_sentry_envelope_on_any_host_is_red(tmp_path):
    venv = _venv(tmp_path)
    _dist(_site(venv), "captcha", "1.0", {"captcha/report.js": b"u='https://sentry.example.org/api/9/envelope/?sentry_version=7'"})
    assert gate.scan(venv)["ok"] is False
