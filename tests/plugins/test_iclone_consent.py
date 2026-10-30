"""V3-FX FX-4 — the iclone-consent plugin: Hermes' own microphone capture (wake word, voice mode, /voice) obeys the
icloneOS microphone switch. Off = the microphone is never opened; a stream already open stops when the switch goes
off; outside icloneOS nothing changes.

A fake ``sounddevice`` (a module on disk, so the import hook is exercised as in the runtime) counts every stream
that would have opened the microphone.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PLUGIN_DIR = ROOT / "plugins" / "iclone-consent"
# The runtime tree the no-upload checks scan and import from: this checkout, or (gate X6) a throwaway extraction of
# the pinned runtime the app ships (put first on PYTHONPATH too, so its own modules are the ones patched).
RUNTIME_ROOT = Path(os.environ.get("ICLONE_UPLOAD_RUNTIME") or ROOT)
PKG = "hermes_plugins.iclone_consent"

FAKE_SD = '''
OPENED = []
STARTED = []
class PortAudioError(Exception):
    pass
class CallbackAbort(Exception):
    pass
class _Base:
    def __init__(self, samplerate=None, blocksize=None, device=None, channels=None, dtype=None, latency=None,
                 extra_settings=None, callback=None, **kwargs):
        self.callback = callback
        self.aborted = False
        OPENED.append(type(self).__name__)
    def start(self):
        STARTED.append(type(self).__name__)
    def abort(self):
        self.aborted = True
    def close(self):
        pass
    def __enter__(self):
        return self
    def __exit__(self, *exc):
        return False
class InputStream(_Base):
    def read(self, frames):
        return [0] * frames, False
class RawInputStream(InputStream):
    pass
class Stream(InputStream):
    pass
class RawStream(InputStream):
    pass
class OutputStream(_Base):
    pass
def rec(frames, **kwargs):
    return InputStream(**kwargs)
'''


@pytest.fixture()
def fake_sd(tmp_path, monkeypatch):
    lib = tmp_path / "lib"
    lib.mkdir()
    (lib / "sounddevice.py").write_text(FAKE_SD)
    monkeypatch.syspath_prepend(str(lib))
    sys.modules.pop("sounddevice", None)
    yield lib
    sys.modules.pop("sounddevice", None)


@pytest.fixture()
def record(tmp_path):
    path = tmp_path / "userData" / "consent.json"
    path.parent.mkdir()

    def write(microphone):
        permissions = {} if microphone is None else {"microphone": microphone}
        path.write_text(json.dumps({"version": 1, "permissions": permissions}))
        # A new stamp even within the same clock tick (the gate caches by mtime and size).
        stamp = time.time_ns() + write.bump
        write.bump += 1_000_000_000
        os.utime(path, ns=(stamp, stamp))

    write.bump = 0
    write.path = path
    return write


def _load(monkeypatch, env):
    for name in [n for n in sys.modules if n.startswith(PKG)]:
        del sys.modules[name]
    if "hermes_plugins" not in sys.modules:
        ns = types.ModuleType("hermes_plugins")
        ns.__path__ = []
        sys.modules["hermes_plugins"] = ns
    for key in ("ICLONE_CONSENT_MICROPHONE", "ICLONE_CONSENT_RECORD"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    spec = importlib.util.spec_from_file_location(
        PKG, PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)]
    )
    mod = importlib.util.module_from_spec(spec)
    mod.__package__ = PKG
    sys.modules[PKG] = mod
    spec.loader.exec_module(mod)
    mod.register(object())
    gate = sys.modules[f"{PKG}.micgate"]
    monkeypatch.setattr(gate, "RECHECK_SECONDS", 0.0)
    return gate


@pytest.fixture(autouse=True)
def _unhook():
    yield
    hooks = sys.modules.get(f"{PKG}.importgate")
    if hooks is not None:
        if hooks._FINDER in sys.meta_path:
            sys.meta_path.remove(hooks._FINDER)
        hooks._PATCHERS.clear()


def test_off_in_the_record_never_opens_the_microphone(monkeypatch, fake_sd, record):
    record(False)
    _load(monkeypatch, {"ICLONE_CONSENT_MICROPHONE": "1", "ICLONE_CONSENT_RECORD": str(record.path)})
    import sounddevice as sd

    for cls in ("InputStream", "RawInputStream", "Stream", "RawStream"):
        with pytest.raises(sd.PortAudioError, match="switched off in icloneOS"):
            getattr(sd, cls)(samplerate=16000, channels=1)
    with pytest.raises(sd.PortAudioError):
        sd.rec(10)
    assert sd.OPENED == []
    # Playback is not capture: the output stream is untouched.
    sd.OutputStream()
    assert sd.OPENED == ["OutputStream"]


def test_on_and_undecided_open_as_before(monkeypatch, fake_sd, record):
    record(True)
    _load(monkeypatch, {"ICLONE_CONSENT_MICROPHONE": "0", "ICLONE_CONSENT_RECORD": str(record.path)})
    import sounddevice as sd

    sd.InputStream(channels=1).start()
    record(None)  # the record says nothing about the microphone: undecided is not off (the app's permissionAllowed)
    sd.InputStream(channels=1)
    assert sd.OPENED == ["InputStream", "InputStream"]
    assert isinstance(sd.InputStream(), sd.InputStream)


def test_the_live_record_wins_over_the_spawn_value_both_ways(monkeypatch, fake_sd, record):
    record(True)
    _load(monkeypatch, {"ICLONE_CONSENT_MICROPHONE": "1", "ICLONE_CONSENT_RECORD": str(record.path)})
    import sounddevice as sd

    sd.InputStream()
    record(False)  # the owner switches the microphone off while Hermes runs
    with pytest.raises(sd.PortAudioError):
        sd.InputStream()
    record(True)
    sd.InputStream()
    assert sd.OPENED == ["InputStream", "InputStream"]


def test_without_a_readable_record_the_spawn_value_decides(monkeypatch, fake_sd, tmp_path):
    missing = tmp_path / "gone" / "consent.json"
    _load(monkeypatch, {"ICLONE_CONSENT_MICROPHONE": "0", "ICLONE_CONSENT_RECORD": str(missing)})
    import sounddevice as sd

    with pytest.raises(sd.PortAudioError):
        sd.InputStream()
    assert sd.OPENED == []


def test_m7_a_record_that_cannot_be_read_keeps_the_microphone_closed_over_a_stale_spawn_on(monkeypatch, fake_sd, record):
    record(True)
    _load(monkeypatch, {"ICLONE_CONSENT_MICROPHONE": "1", "ICLONE_CONSENT_RECORD": str(record.path)})
    import sounddevice as sd

    sd.InputStream()
    record.path.write_text("{ half written")
    os.utime(record.path, ns=(time.time_ns() + 9_000_000_000, time.time_ns() + 9_000_000_000))
    with pytest.raises(sd.PortAudioError):
        sd.InputStream()
    assert sd.OPENED == ["InputStream"]


def test_the_record_path_is_popped_and_only_a_consent_json_is_trusted(monkeypatch, fake_sd, tmp_path):
    other = tmp_path / "other.json"
    other.write_text(json.dumps({"permissions": {"microphone": True}}))
    gate = _load(monkeypatch, {"ICLONE_CONSENT_MICROPHONE": "0", "ICLONE_CONSENT_RECORD": str(other)})

    assert "ICLONE_CONSENT_RECORD" not in os.environ  # no child of Hermes inherits the pointer
    assert gate.RECORD == ""
    import sounddevice as sd

    with pytest.raises(sd.PortAudioError):
        sd.InputStream()


def test_an_open_stream_stops_when_the_switch_goes_off(monkeypatch, fake_sd, record):
    record(True)
    _load(monkeypatch, {"ICLONE_CONSENT_MICROPHONE": "1", "ICLONE_CONSENT_RECORD": str(record.path)})
    import sounddevice as sd

    frames = []
    callback_stream = sd.InputStream(channels=1, callback=lambda *a: frames.append(a))
    blocking = sd.InputStream(channels=1)
    callback_stream.callback("in", 1, None, None)
    blocking.read(4)
    assert len(frames) == 1

    record(False)
    with pytest.raises(sd.CallbackAbort):
        callback_stream.callback("in", 1, None, None)
    with pytest.raises(sd.PortAudioError):
        blocking.read(4)
    assert blocking.aborted is True
    assert len(frames) == 1
    with pytest.raises(sd.PortAudioError):
        blocking.start()


def test_already_imported_sounddevice_is_gated_too(monkeypatch, fake_sd, record):
    import sounddevice as sd  # imported before the plugin registered

    record(False)
    _load(monkeypatch, {"ICLONE_CONSENT_MICROPHONE": "1", "ICLONE_CONSENT_RECORD": str(record.path)})
    with pytest.raises(sd.PortAudioError):
        sd.InputStream()
    assert sd.OPENED == []


def test_outside_icloneos_the_plugin_is_inert(monkeypatch, fake_sd):
    gate = _load(monkeypatch, {})
    import sounddevice as sd

    assert gate.ACTIVE is False
    assert sys.modules[f"{PKG}.importgate"]._FINDER not in sys.meta_path
    assert not hasattr(sd, "MicrophoneConsentOff")
    sd.InputStream()
    assert sd.OPENED == ["InputStream"]


def test_voice_mode_recorder_refused_without_opening(monkeypatch, fake_sd, record):
    """The real upstream voice-mode recorder (tools/voice_mode.py) goes through the gate: no stream, an error it reports."""
    pytest.importorskip("numpy")
    record(False)
    _load(monkeypatch, {"ICLONE_CONSENT_MICROPHONE": "1", "ICLONE_CONSENT_RECORD": str(record.path)})
    from tools import voice_mode

    import sounddevice as sd

    recorder = voice_mode.AudioRecorder()
    with pytest.raises(Exception, match="switched off in icloneOS"):
        recorder.start()
    assert sd.OPENED == []


# ── Ruling 47 (V3-FX M3): no diagnostics or log upload to any third party ─────────────────────────────────────────

ACTIVE_ENV = {"ICLONE_CONSENT_MICROPHONE": "1"}


@pytest.fixture()
def fresh_debug():
    """The runtime's own debug modules, imported fresh (this checkout's code, the tree under test)."""
    for name in ("hermes_cli.debug", "hermes_cli.diagnostics_upload"):
        sys.modules.pop(name, None)
    yield
    for name in ("hermes_cli.debug", "hermes_cli.diagnostics_upload"):
        sys.modules.pop(name, None)


def _no_network(monkeypatch):
    """Any outbound socket in the test is a failure: an upload that was not refused."""
    import socket

    def boom(*_a, **_k):
        raise AssertionError("network used: an upload was not refused")

    monkeypatch.setattr(socket.socket, "connect", boom)
    monkeypatch.setattr(socket, "create_connection", boom)


def test_every_upload_function_is_refused_after_import(monkeypatch, fresh_debug):
    _no_network(monkeypatch)
    _load(monkeypatch, ACTIVE_ENV)
    import hermes_cli.debug as debug
    import hermes_cli.diagnostics_upload as uploads

    noupload = sys.modules[f"{PKG}.noupload"]
    present = [name for name in noupload.DEBUG_UPLOADS if hasattr(debug, name)]
    assert {"upload_to_pastebin", "build_debug_share"} <= set(present)
    for name in present:
        with pytest.raises(noupload.UploadRefused, match="never uploads"):
            getattr(debug, name)("report", "x")
    with pytest.raises(noupload.UploadRefused):
        uploads.share_to_nous(b"bundle")


def test_debug_share_refused_with_the_local_report_named_and_local_still_works(monkeypatch, capsys, fresh_debug):
    import types as _t

    _no_network(monkeypatch)
    import hermes_cli.debug as debug

    calls = []
    monkeypatch.setattr(debug, "run_debug_share", lambda args: calls.append(args), raising=True)
    _load(monkeypatch, ACTIVE_ENV)  # the module was already imported: patched at once

    for words in ({"nous": True, "local": False}, {"nous": False, "local": False}):
        debug.run_debug_share(_t.SimpleNamespace(lines=200, expire=7, yes=True, **words))
    assert calls == []
    assert capsys.readouterr().out.count("Settings › Machine › Diagnostics › Save report") == 2

    debug.run_debug_share(_t.SimpleNamespace(lines=200, expire=7, yes=True, nous=False, local=True))
    assert len(calls) == 1


def test_the_cli_slash_debug_path_is_refused(monkeypatch, capsys, fresh_debug):
    """/debug as the slash worker runs it (cli_commands_mixin imports run_debug_share at call time)."""
    _no_network(monkeypatch)
    _load(monkeypatch, ACTIVE_ENV)
    from hermes_cli.cli_commands_mixin import CLICommandsMixin  # noqa: F401 — the real handler

    handler = getattr(CLICommandsMixin, "_handle_debug_command")
    handler(object(), "/debug nous")
    handler(object(), "/debug")
    assert capsys.readouterr().out.count("never uploads") == 2


def test_outside_icloneos_the_upload_seam_is_off(monkeypatch, fresh_debug):
    _load(monkeypatch, {})
    import hermes_cli.debug as debug

    assert not getattr(debug.upload_to_pastebin, "__iclone_refused__", False)


# The runtime's functions named for an upload, paste or share in a module that makes outbound HTTP calls. A new one
# fails this test until it is classified: "refused" (diagnostics or logs: the seam must refuse it, checked above) or
# a reason it is not a diagnostics upload. Scanned: the runtime tree this app ships its plugins into.
UPLOAD_INVENTORY = {
    # The union of this checkout's tree and the pinned runtime the app ships (gate X6 runs this file in both).
    "hermes_cli/debug.py": {
        "refused": ["_upload_paste_rs", "_upload_dpaste_com", "_post_paste", "upload_to_pastebin", "build_debug_share",
                    "run_debug_share", "_run_debug_share_nous"],
        "local": ["_sweep_expired_pastes", "_best_effort_sweep_expired_pastes", "_extract_paste_id", "_is_dpaste_url",
                  "delete_paste", "collect_share_bundle", "_confirm_upload"],
    },
    "hermes_cli/diagnostics_upload.py": {"refused": ["share_to_nous", "request_upload_url"]},
    "hermes_cli/web_server.py": {
        "refused": ["run_debug_share_endpoint"],
        "local": ["_decode_chat_image_upload", "upload_chat_image", "upload_managed_file", "upload_managed_file_stream",
                  "transcribe_audio_upload", "_safe_backup_upload_name", "run_import_upload"],
    },
    "hermes_cli/web_routers/status.py": {"refused": ["run_debug_share_endpoint"]},
    # The dashboard's own server receiving files from its own window, not sending anything out.
    "hermes_cli/web_routers/files.py": {"local": ["_decode_chat_image_upload", "stream_upload_to_path",
                                                  "upload_chat_image", "upload_managed_file",
                                                  "upload_managed_file_stream"]},
    "hermes_cli/web_routers/audio.py": {"local": ["transcribe_audio_upload"]},
    "hermes_cli/web_routers/ops.py": {"local": ["_safe_backup_upload_name", "run_import_upload"]},
    # Sign-in state shared between local Hermes processes (a file lock and a store), named "shared".
    "hermes_cli/auth.py": {"local": ["_nous_shared_auth_dir", "_nous_shared_store_path", "_nous_shared_store_lock",
                                     "_merge_shared_nous_oauth_state", "_write_shared_nous_state",
                                     "_read_shared_nous_state", "_clear_shared_nous_state",
                                     "_try_import_shared_nous_state", "_persist_shared_refresh"]},
    "hermes_cli/auth_nous.py": {"local": ["_clear_shared_nous_state", "_merge_shared_nous_oauth_state",
                                          "_nous_shared_auth_dir", "_nous_shared_shape", "_nous_shared_store_lock",
                                          "_nous_shared_store_path", "_offer_shared_nous_import",
                                          "_read_shared_nous_state", "_shared_lock_timeout",
                                          "_try_import_shared_nous_state", "_write_shared_nous_state",
                                          "merge_shared", "shared_lock"]},
    "hermes_cli/anon_auth.py": {"local": ["_shared_identity_key"]},
}
# Messaging platforms and tools send media the owner or the agent chose to send, to the service it was sent to: not
# diagnostics. They are listed by module so a new diagnostics upload hidden there still shows.
MESSAGING_PREFIXES = ("gateway/platforms/", "gateway/relay/", "plugins/platforms/", "plugins/memory/",
                      "plugins/kanban/", "tools/managed_tool_gateway.py", "tools/send_message_senders.py")


def _scan_upload_functions():
    import re

    net = re.compile(r"requests\.(post|put)|httpx\.(post|put)|\.post\(|urlopen\(|urllib\.request\.Request")
    fn = re.compile(r"^\s*(?:async\s+)?def\s+(\w*(?:upload|paste|share)\w*)\s*\(", re.M | re.I)
    found = {}
    for top in ("hermes_cli", "tui_gateway", "gateway", "agent", "tools", "acp_adapter", "plugins"):
        for path in sorted((RUNTIME_ROOT / top).rglob("*.py")):
            rel = path.relative_to(RUNTIME_ROOT).as_posix()
            if "/tests/" in rel or rel.startswith("plugins/iclone-"):
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            if net.search(text):
                names = sorted(set(fn.findall(text)))
                if names:
                    found[rel] = names
    return found


def test_upload_inventory_is_complete_and_every_diagnostics_upload_is_refused(monkeypatch, fresh_debug):
    found = _scan_upload_functions()
    unclassified = {}
    for rel, names in found.items():
        if rel.startswith(MESSAGING_PREFIXES):
            continue
        listed = set(sum(UPLOAD_INVENTORY.get(rel, {}).values(), []))
        missing = [name for name in names if name not in listed]
        if missing:
            unclassified[rel] = missing
    assert unclassified == {}, f"classify these upload/paste/share functions (ruling 47): {unclassified}"

    # Every "refused" name that lives in a module the seam patches is refused by it.
    noupload_names = set()
    _load(monkeypatch, ACTIVE_ENV)
    noupload = sys.modules[f"{PKG}.noupload"]
    noupload_names.update(noupload.DEBUG_UPLOADS, ["run_debug_share"], noupload.SHARE_UPLOADS)
    for rel in ("hermes_cli/debug.py", "hermes_cli/diagnostics_upload.py"):
        for name in UPLOAD_INVENTORY[rel]["refused"]:
            if name == "request_upload_url":
                continue  # only share_to_nous calls it; refusing share_to_nous refuses the upload
            assert name in noupload_names, f"{rel}:{name} is a diagnostics upload the seam does not refuse"


def test_only_the_seamed_modules_name_a_paste_service_or_the_nous_upload():
    """A paste/upload endpoint in any other runtime module is a new third-party diagnostics path."""
    import re

    pattern = re.compile(r"paste\.rs|dpaste\.com|share_to_nous|upload_to_pastebin|build_debug_share")
    allowed = {
        "hermes_cli/debug.py", "hermes_cli/diagnostics_upload.py",  # the seam refuses them
        "hermes_cli/web_server.py", "tui_gateway/methods_config.py", "gateway/slash_commands.py",
        "hermes_cli/cli_commands_mixin.py",  # callers: they look the refused function up at call time
        "hermes_cli/subcommands/debug.py",  # argparse help text only (an example paste URL for `debug delete`)
        "hermes_cli/web_routers/status.py",  # the pinned runtime's dashboard endpoint: calls build_debug_share
        "hermes_cli/iclone_sinks.py",  # ruling 54's sink registry (names the paste path it denies)
    }
    hits = set()
    for top in ("hermes_cli", "tui_gateway", "gateway", "agent", "tools", "acp_adapter", "plugins"):
        for path in (RUNTIME_ROOT / top).rglob("*.py"):
            rel = path.relative_to(RUNTIME_ROOT).as_posix()
            if "/tests/" in rel or rel.startswith("plugins/iclone-"):
                continue
            if pattern.search(path.read_text(encoding="utf-8", errors="ignore")):
                hits.add(rel)
    assert hits <= allowed, f"new modules naming a diagnostics upload: {sorted(hits - allowed)}"
