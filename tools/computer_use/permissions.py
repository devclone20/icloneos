"""Cross-platform Computer Use readiness + macOS permission helpers. "Ready to drive" differs per platform: macOS
needs explicit TCC grants (Accessibility + Screen Recording) via cua-driver ``permissions status`` / ``permissions
grant``; Windows/Linux have no TCC toggles, so readiness == driver health. The grants attach to cua-driver's OWN
identity (``com.trycua.driver``), not Hermes, so ``grant`` launches CuaDriver via LaunchServices for correct dialog
attribution. ``cua-driver doctor --json`` is the universal signal; ``computer_use_status`` folds it with the macOS
detail into one payload for the desktop card, the ``permissions`` CLI and ``/api/tools/computer-use/status``."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from contextlib import suppress
from typing import Any, Dict, Optional, Tuple

from hermes_cli._subprocess_compat import windows_hide_flags

_RUNTIME_PLATFORMS = frozenset({"darwin", "win32", "linux"})  # mirrors the toolset platform_gate
_BOOLS = ("accessibility", "screen_recording", "screen_recording_capturable")
CUA_DRIVER_BUNDLE_ID = "com.trycua.driver"  # the only identity TCC rows and the private daemon are keyed to
_TCC_SERVICES = {"accessibility": "Accessibility", "screen_recording": "ScreenCapture"}  # status field -> tccutil service
TCC_FIELDS = tuple(_TCC_SERVICES)

def stale_tcc_grant_hint(*missing: str) -> str:
    """Recovery text for grants the daemon reports missing while System Settings shows the CuaDriver toggle ON.

    TCC keys each row to the app's code-signing requirement, so a row written for an earlier CuaDriver build can
    stop matching after a driver update: the toggle stays ON, the daemon is denied, and flipping the toggle does
    not rewrite the requirement (trycua/cua#3170). Only a reset + re-grant recovers it, so the hint names the
    exact rows for the *missing* status fields.
    """
    resets = " && ".join(f"tccutil reset {_TCC_SERVICES[f]} {CUA_DRIVER_BUNDLE_ID}" for f in missing if f in _TCC_SERVICES)
    if not resets:
        return ""
    return ("If System Settings already shows CuaDriver ON, the stored grant is stale (it no longer matches the installed "
            f"driver's signature): run `{resets}`, then `hermes computer-use permissions grant`.")

def _child_env() -> Dict[str, str]:
    """cua-driver child env (telemetry policy + provider secrets stripped); ``os.environ`` on import error.

    cua-driver is a third-party binary — it must never inherit provider API keys (#53503/#55709/#58889
    lineage). Each layer degrades gracefully so permission probes never break on a helper import error.
    """
    try:
        from tools.computer_use.cua_backend import sanitized_cua_driver_env
        return sanitized_cua_driver_env()
    except Exception:
        return dict(os.environ)

def _run(binary: str, *args: str, timeout: float) -> subprocess.CompletedProcess:
    from tools.computer_use.cua_backend_driver import spawn_argv, spawn_env  # the Seatbelt on: the launcher's door, by name
    argv = [binary, *args]
    return subprocess.run(spawn_argv(argv), capture_output=True, text=True, encoding='utf-8', errors='replace',
                          timeout=timeout, env=spawn_env(argv, _child_env()), stdin=subprocess.DEVNULL, creationflags=windows_hide_flags())

def _is_door(binary: str) -> bool:
    from tools.computer_use.cua_backend_driver import _door_module
    return binary == _door_module().COMMAND

def _door_finds_driver(binary: str, out: Dict[str, Any]) -> bool:
    """G2 A3: the door's word is a command, not a driver on disk. Asks the launcher, which checks the signature. An
    absent or forged driver reads not installed, so Install shows; a launcher that does not answer claims nothing."""
    door = None
    try:
        from tools.computer_use.cua_backend_driver import _door_module
        door = _door_module()
        proc = _run(binary, "where", timeout=40)
    except (OSError, subprocess.SubprocessError) as exc:
        out["error"] = f"CuaDriver could not be looked for: {exc}"
        return False
    if proc.returncode == 0:
        return True
    why = (proc.stderr or "").strip().partition("Refused by icloneOS confinement: ")[2].strip() or (proc.stderr or "").strip()
    if door.ABSENT in why:
        out["installed"] = False
        out["error"] = why.replace(door.ABSENT, "").strip() or None
    else:
        out["error"] = why or "CuaDriver could not be looked for"
    return False

def _json_out(binary: str, *args: str, timeout: float) -> Any:
    """Run ``binary args`` and parse stdout as JSON (``None`` on empty output)."""
    raw = (_run(binary, *args, timeout=timeout).stdout or "").strip()
    return json.loads(raw) if raw else None

def _doctor(binary: str) -> Optional[Dict[str, Any]]:
    """``cua-driver doctor --json`` → ``{ok, checks:[{label,status,message}]}`` (None on any failure)."""
    try:
        data = _json_out(binary, "doctor", "--json", timeout=12)
    except Exception:
        data = None
    if not isinstance(data, dict):
        return None
    checks = [{k: str(p.get(k, "")) for k in ("label", "status", "message")} for p in data.get("probes", []) if isinstance(p, dict)]
    return {"ok": bool(data.get("ok")), "checks": checks}

# ``permissions status`` answers only through a daemon already running under com.trycua.driver; without one it says
# "unknown", which is the usual case, since the agent's daemon is private to a session. So a status read starts its own
# short-lived private daemon through the signature-checked CuaDriver.app (macOS judges com.trycua.driver, not the app)
# and asks it ``check_permissions`` with prompt false, which never raises a dialog. Same launch as a computer-use session.
_PRIVATE_STATUS_TTL_SECONDS = 3.0  # the card and the Set up row read together, and each read starts a process
_PRIVATE_START_SECONDS = 8.0
_private_status_lock = threading.Lock()
_private_status_cache: Tuple[float, str, Optional[Dict[str, Any]]] = (0.0, "", None)

def _private_socket_path() -> str:
    name = f"hc-{uuid.uuid4().hex[:12]}.sock"
    candidate = os.path.join(tempfile.gettempdir(), name)
    return candidate if len(candidate) < 100 else os.path.join("/tmp", name)  # sun_path holds 104 bytes

def _private_daemon_launch(binary: str, socket_path: str) -> list[str]:
    if _is_door(binary):  # the launcher starts it through LaunchServices, and its sitter ends it with the launcher
        return [binary, "serve", "--embedded", "--socket", socket_path, "--no-permissions-gate", "--permission-mode", "standard"]
    from tools.computer_use.cua_backend import _CUA_TELEMETRY_ENV_VAR
    from tools.computer_use.cua_backend_daemon import _embedded_daemon_spawn_command

    command = _embedded_daemon_spawn_command(binary, ["serve", "--embedded", "--socket", socket_path, "--no-permissions-gate"],
                                             platform=sys.platform)
    if command[0] != "/usr/bin/open":
        return command
    # LaunchServices forwards no environment: the telemetry policy and the home must be named, or the daemon uses launchd's.
    forwarded = {k: v for k, v in {"HOME": os.environ.get("HOME"),
                                   _CUA_TELEMETRY_ENV_VAR: _child_env().get(_CUA_TELEMETRY_ENV_VAR)}.items() if v}
    return [command[0], *[arg for k, v in forwarded.items() for arg in ("--env", f"{k}={v}")], *command[1:]]

def _private_daemon_status(binary: str) -> Dict[str, Any]:
    """``check_permissions`` from a private daemon, or ``{"error": ...}`` when it cannot answer. Serialized and cached
    for a moment; the daemon never outlives the read."""
    global _private_status_cache
    with _private_status_lock:
        at, cached_binary, cached = _private_status_cache
        if cached is not None and cached_binary == binary and time.monotonic() - at < _PRIVATE_STATUS_TTL_SECONDS:
            return cached
        # Through the door a socket is a name, never a path; one per process, so its sitter is one too.
        socket_path = f"hc-{os.getpid():012x}" if _is_door(binary) else _private_socket_path()
        result: Dict[str, Any]
        try:
            launch = _private_daemon_launch(binary, socket_path)
            launched = _run(launch[0], *launch[1:], timeout=10)
            if launched.returncode != 0:
                raise RuntimeError(f"it did not start (exit {launched.returncode})")
            deadline = time.monotonic() + _PRIVATE_START_SECONDS
            while _run(binary, "status", "--socket", socket_path, timeout=2).returncode != 0:
                if time.monotonic() > deadline:
                    raise TimeoutError("CuaDriver did not start")
                time.sleep(0.2)
            data = _json_out(binary, "call", "check_permissions", '{"prompt":false}', "--socket", socket_path, timeout=8)
            result = data if isinstance(data, dict) else {"error": "CuaDriver gave no permission status"}
        except Exception as exc:  # unsigned app, refused launch, no answer: a reason for the card, never a guess
            result = {"error": f"CuaDriver could not report its permissions: {exc}"}
        finally:
            with suppress(Exception):
                _run(binary, "stop", "--socket", socket_path, timeout=3)
            with suppress(OSError):
                os.remove(socket_path)
        _private_status_cache = (time.monotonic(), binary, result)
        return result

def _mac_permissions(binary: str, out: Dict[str, Any]) -> None:
    """Fold ``cua-driver permissions status --json`` booleans (+ ``source``) into ``out``; when no daemon is running,
    the same fields from a private daemon."""
    try:
        data = _json_out(binary, "permissions", "status", "--json", timeout=10)
        if isinstance(data, dict) and data.get("status") == "unknown" and data.get("daemon_running") is False:
            data = _private_daemon_status(binary)
            if isinstance(data.get("error"), str):
                out["error"] = data["error"]
    except subprocess.TimeoutExpired:
        out["error"] = "cua-driver permissions status timed out"
    except Exception as exc:  # spawn failure or malformed JSON
        out["error"] = f"cua-driver permissions status failed: {exc}"
    else:
        if isinstance(data, dict):
            out.update({k: data[k] for k in _BOOLS if isinstance(data.get(k), bool)})
            if isinstance(data.get("source"), dict):
                out["source"] = data["source"]

def computer_use_status(driver_cmd: Optional[str] = None) -> Dict[str, Any]:
    """OS-aware readiness for the desktop card; key order is an API payload contract. ``ready`` is the single signal the
    UI keys off: macOS = both TCC grants, elsewhere = driver health (no TCC model); ``None`` = unknown (binary missing /
    probe failed). ``can_grant`` is macOS-only."""
    from plugins.computer_use import DEFAULT_BACKEND, configured_backend_name, get_active_provider
    from tools.computer_use.cua_backend_driver import resolve_cua_driver_cmd  # same resolver as the tool itself
    plat, name = sys.platform, configured_backend_name()
    binary = resolve_cua_driver_cmd(driver_cmd) if name == DEFAULT_BACKEND else None
    out: Dict[str, Any] = {"platform": plat, "platform_supported": plat in _RUNTIME_PLATFORMS,
                           "installed": bool(binary), "version": None, "ready": None, "can_grant": plat == "darwin",
                           "checks": [], "source": None, "error": None, **{k: None for k in _BOOLS}}
    if name != DEFAULT_BACKEND:  # another driver is selected: cua-driver probes and TCC grants do not apply
        out.update(platform_supported=True, can_grant=False)
        try:
            provider = get_active_provider()
        except LookupError as e:
            out["error"] = str(e)
            return out
        out.update(installed=True, version=f"{provider.display_name} (computer_use.backend: {provider.name})",
                   ready=provider.is_available())
        return out
    if not binary:
        return out
    if _is_door(binary) and not _door_finds_driver(binary, out):
        return out
    with suppress(Exception):
        out["version"] = (_run(binary, "--version", timeout=5).stdout or "").strip() or None
    doctor = _doctor(binary)
    if doctor is not None:
        out["checks"] = doctor["checks"]
    if plat == "darwin":
        _mac_permissions(binary, out)
        if out["error"] is None and (out["accessibility"] is not None or out["screen_recording"] is not None):
            out["ready"] = out["accessibility"] is True and out["screen_recording"] is True
    elif doctor is not None:
        out["ready"] = doctor["ok"]  # no TCC model off macOS
    return out

def request_permissions_grant(driver_cmd: Optional[str] = None) -> int:
    """Run ``cua-driver permissions grant`` (macOS), streaming its output. Returns the driver's exit code (0 ok), 2 if
    the binary is missing, 64 on a non-macOS platform (no TCC model to grant)."""
    if sys.platform != "darwin":
        print("Computer Use permissions are a macOS concept; nothing to grant here.")
        return 64
    from tools.computer_use.cua_backend_driver import resolve_cua_driver_cmd
    binary = resolve_cua_driver_cmd(driver_cmd)
    if not binary:
        print("cua-driver: not installed. Run: hermes computer-use install")
        return 2
    print("Requesting Accessibility + Screen Recording for CuaDriver.\n"
          f"macOS will show a dialog attributed to CuaDriver ({CUA_DRIVER_BUNDLE_ID}) — approve it, then return here.")
    try:
        from tools.computer_use.cua_backend_driver import spawn_argv, spawn_env
        argv = [binary, "permissions", "grant"]
        return int(subprocess.run(spawn_argv(argv), env=spawn_env(argv, _child_env()), stdin=subprocess.DEVNULL).returncode)
    except KeyboardInterrupt:  # pragma: no cover - interactive
        return 130
    except Exception as exc:  # pragma: no cover - defensive
        print(f"cua-driver permissions grant failed: {exc}", file=sys.stderr)
        return 2
