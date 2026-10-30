"""DDGS search child-process entrypoint, run as ``python plugins/web/ddgs/_search_worker.py``.

Reads one JSON request ``{"query": str, "safe_limit": int}`` from stdin, writes one
envelope ``{"ok": true, "results": [...]}`` / ``{"ok": false, "error": str}`` to
stdout, exits. Test hooks (``"test_hook": "sleep"|"gil"|"empty"``) are honored only
when ``HERMES_DDGS_ALLOW_TEST_HOOKS=1``.
"""

from __future__ import annotations

# icloneOS V3-UP r5 (ruling 56): a child of a confined Hermes installs the same spawn guard before anything else
# (hermes_bootstrap, loaded by path: this runs as a script or with -P, so the runtime root may not be on sys.path).
import importlib.util as _iclone_ilu  # noqa: E402
import os as _iclone_os  # noqa: E402
import sys as _iclone_sys  # noqa: E402

if "hermes_bootstrap" not in _iclone_sys.modules:
    _iclone_root = _iclone_os.path.dirname(_iclone_os.path.dirname(_iclone_os.path.dirname(_iclone_os.path.dirname(_iclone_os.path.abspath(__file__)))))
    _iclone_spec = _iclone_ilu.spec_from_file_location("hermes_bootstrap", _iclone_os.path.join(_iclone_root, "hermes_bootstrap.py"))
    _iclone_mod = _iclone_ilu.module_from_spec(_iclone_spec)
    _iclone_sys.modules["hermes_bootstrap"] = _iclone_mod
    _iclone_spec.loader.exec_module(_iclone_mod)


import json
import os
import sys
import time


def _hold_gil(secs: int) -> None:
    """Block in a foreign call that keeps the GIL — mirrors native ``primp``.
    ``ctypes.PyDLL`` (unlike ``CDLL``/``WinDLL``) does not release the GIL."""
    import ctypes
    if sys.platform == "win32":
        sleep, secs = ctypes.PyDLL("kernel32").Sleep, secs * 1000
    else:
        try:
            sleep = ctypes.PyDLL(None).sleep
        except AttributeError:  # pragma: no cover — macOS libSystem fallback
            sleep = ctypes.PyDLL("/usr/lib/libSystem.B.dylib").sleep
    sleep.argtypes = [ctypes.c_uint]
    sleep(int(secs))


def _hang(block, name: str) -> dict:
    block(30)
    return {"ok": False, "error": f"{name} hook returned unexpectedly"}


_TEST_HOOKS = {"sleep": lambda: _hang(time.sleep, "sleep"), "gil": lambda: _hang(_hold_gil, "gil"), "empty": lambda: {"ok": True, "results": []}}


def _write_envelope(envelope: dict) -> None:
    json.dump(envelope, sys.stdout)
    sys.stdout.flush()


def _fail(error: str, code: int) -> int:
    _write_envelope({"ok": False, "error": error})
    return code


def main() -> int:
    try:
        request = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001
        return _fail(f"invalid request: {exc}", 2)
    hook = request.get("test_hook")
    if hook:
        if os.environ.get("HERMES_DDGS_ALLOW_TEST_HOOKS") != "1":
            return _fail("test_hook refused (hooks not enabled)", 3)
        fn = _TEST_HOOKS.get(str(hook))
        envelope = fn() if fn else {"ok": False, "error": f"unknown test_hook: {hook!r}"}
        _write_envelope(envelope)
        return 0 if envelope.get("ok") else 1
    query, safe_limit = str(request.get("query") or ""), max(1, int(request.get("safe_limit") or 1))
    try:
        from plugins.web.ddgs.provider import _run_ddgs_search  # lazy: light startup, patchable
        _write_envelope({"ok": True, "results": _run_ddgs_search(query, safe_limit)})
        return 0
    except Exception as exc:  # noqa: BLE001
        return _fail(f"{type(exc).__name__}: {exc}", 1)


if __name__ == "__main__":
    raise SystemExit(main())
