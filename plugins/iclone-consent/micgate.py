"""The microphone gate: every ``sounddevice`` input stream asks the icloneOS consent switch first.

Source of the switch, live: the app's own consent record (``ICLONE_CONSENT_RECORD``, its path, popped at import so no
child of this Hermes inherits it), read again whenever it changes on disk — the owner can switch the microphone off
while Hermes runs. When there is no record yet, the value the app composed at spawn (``ICLONE_CONSENT_MICROPHONE``:
``1`` on, ``0`` off, ``ask`` undecided) decides; a record that exists but cannot be read keeps the microphone closed
(m7: a stale spawn-time "on" is never trusted over it). Exactly the app's rule (``permissionAllowed``): only an explicit OFF
refuses; undecided is not off.

What is gated (``sounddevice``'s four classes that open an input: InputStream, RawInputStream, Stream, RawStream, and
so ``rec``/``playrec`` which build them):
  * opening a stream, and starting one, while the switch is off raises ``sounddevice.MicrophoneConsentOff`` (a
    ``PortAudioError``, which every capture path already handles as "no microphone");
  * a stream already open stops itself within ``RECHECK_SECONDS`` of the switch going off (callback streams abort,
    blocking ``read`` raises).
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
from typing import Any, Optional, Tuple

from . import importgate

logger = logging.getLogger(__name__)

SWITCH_ENV = "ICLONE_CONSENT_MICROPHONE"
RECORD_ENV = "ICLONE_CONSENT_RECORD"
RECHECK_SECONDS = 0.5
REFUSAL = "the microphone is switched off in icloneOS (Settings › Privacy); Hermes does not open it"
STREAM_CLASSES = ("InputStream", "RawInputStream", "Stream", "RawStream")
_MARK = "__iclone_mic_gate__"

ACTIVE = SWITCH_ENV in os.environ


def _trusted_record(value: str) -> str:
    value = value.strip()
    return value if value and os.path.isabs(value) and os.path.basename(value) == "consent.json" else ""


RECORD = _trusted_record(os.environ.pop(RECORD_ENV, "")) if ACTIVE else ""

_lock = threading.Lock()
_cache: Tuple[Optional[Tuple[int, int]], Optional[bool]] = (None, None)


def _from_record() -> Optional[bool]:
    """The record's verdict, or None when it cannot be read (the spawn value decides then)."""
    global _cache
    if not RECORD:
        return None
    try:
        st = os.stat(RECORD)
    except OSError:
        return None
    stamp = (st.st_mtime_ns, st.st_size)
    with _lock:
        if _cache[0] == stamp:
            return _cache[1]
    try:
        with open(RECORD, "r", encoding="utf-8") as fh:
            record = json.load(fh)
    except (OSError, ValueError):
        # m7: the record is there but cannot be read — the owner may have just switched the microphone off, so the
        # spawn-time value (possibly a stale "on") is not trusted: closed until the record reads again.
        verdict: Optional[bool] = False
    else:
        permissions = record.get("permissions") if isinstance(record, dict) else None
        verdict = permissions.get("microphone") is not False if isinstance(permissions, dict) else False
    with _lock:
        _cache = (stamp, verdict)
    return verdict


def microphone_allowed() -> bool:
    if not ACTIVE:
        return True
    verdict = _from_record()
    if verdict is not None:
        return verdict
    return os.environ.get(SWITCH_ENV, "").strip() != "0"


class _Watch:
    """Re-asks the switch at most every RECHECK_SECONDS (the audio thread must stay cheap)."""

    def __init__(self) -> None:
        self._at = 0.0
        self._ok = True

    def ok(self) -> bool:
        now = time.monotonic()
        if now - self._at >= RECHECK_SECONDS:
            self._at = now
            self._ok = microphone_allowed()
        return self._ok


def _gated(sd: Any, base: type, refused: type) -> type:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        if not microphone_allowed():
            raise refused(REFUSAL)
        watch = _Watch()
        self._iclone_watch = watch
        args_list = list(args)
        if kwargs.get("callback") is not None:
            kwargs["callback"] = _watched_callback(sd, kwargs["callback"], watch)
        elif len(args_list) > 7 and args_list[7] is not None:  # callback is the 8th positional parameter
            args_list[7] = _watched_callback(sd, args_list[7], watch)
        base.__init__(self, *args_list, **kwargs)

    def start(self) -> Any:
        if not microphone_allowed():
            raise refused(REFUSAL)
        return base.start(self)

    def read(self, *args: Any, **kwargs: Any) -> Any:
        watch = getattr(self, "_iclone_watch", None)
        if watch is not None and not watch.ok():
            try:
                base.abort(self)
            finally:
                raise refused(REFUSAL)
        return base.read(self, *args, **kwargs)

    namespace = {"__init__": __init__, "start": start, "__module__": getattr(base, "__module__", "sounddevice")}
    if hasattr(base, "read"):
        namespace["read"] = read
    cls = type(base.__name__, (base,), namespace)
    cls.__qualname__ = getattr(base, "__qualname__", base.__name__)
    return cls


def _watched_callback(sd: Any, callback: Any, watch: _Watch) -> Any:
    abort = getattr(sd, "CallbackAbort", None)

    def gated_callback(*args: Any) -> Any:
        if not watch.ok():
            if abort is not None:
                raise abort
            return None
        return callback(*args)

    return gated_callback


def patch(sd: Any) -> bool:
    """Gate a loaded ``sounddevice`` module in place. Idempotent; False when there was nothing to gate."""
    if getattr(sd, _MARK, False):
        return True
    base_error = getattr(sd, "PortAudioError", Exception)
    refused = type("MicrophoneConsentOff", (base_error,), {"__module__": __name__})
    gated_any = False
    for name in STREAM_CLASSES:
        base = getattr(sd, name, None)
        if isinstance(base, type):
            setattr(sd, name, _gated(sd, base, refused))
            gated_any = True
    sd.MicrophoneConsentOff = refused
    setattr(sd, _MARK, True)
    return gated_any


def install() -> None:
    """Gate ``sounddevice`` now if it is loaded, and on import otherwise (importgate.py)."""
    importgate.on_import("sounddevice", patch)
    logger.info("icloneOS microphone consent gate armed (record: %s)", "live" if RECORD else "spawn value only")
