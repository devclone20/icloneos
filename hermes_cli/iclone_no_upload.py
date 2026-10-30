"""iclone-seam: v3fx-no-upload — ruling 47: under icloneOS, Hermes never uploads diagnostics, logs or pastes.

This is the runtime's own refusal, at the functions that would reach the network (hermes_cli/debug.py,
hermes_cli/diagnostics_upload.py). It needs no plugin loading: ``hermes debug share`` run by the agent from its
terminal (a CLI subcommand that never discovers plugins) is refused here. The iclone-consent plugin's refusal stays as
a second layer for the processes that do load plugins.

"Under icloneOS" is decided two ways, either is enough:
  * the spawn environment the app always seals (every ``ICLONE_CONSENT_<KEY>``; the agent's terminal inherits it);
  * the runtime the app manages, wherever it is started from: its root carries the app's ``ICLONE_MANAGED.json``
    stamp, so even a process whose environment was stripped is refused.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Mapping, Optional

REFUSAL = (
    "icloneOS never uploads diagnostics or logs. "
    "Save a report to a file instead: Settings › Machine › Diagnostics › Save report."
)

MANAGED_STAMP = "ICLONE_MANAGED.json"
_RUNTIME_ROOT = Path(__file__).resolve().parents[1]


class UploadRefused(RuntimeError):
    """Raised instead of any upload; the callers already report a failed upload."""


def under_icloneos(env: Optional[Mapping[str, str]] = None, root: Optional[Path] = None) -> bool:
    environ = os.environ if env is None else env
    if any(key.startswith("ICLONE_CONSENT_") for key in environ):
        return True
    return ((root or _RUNTIME_ROOT) / MANAGED_STAMP).is_file()


def refuse_upload(what: str) -> None:
    """Raise :class:`UploadRefused` when running under icloneOS; no-op for plain Hermes."""
    if under_icloneos():
        raise UploadRefused(f"{REFUSAL} ({what} refused)")


# ── Ruling 47 extension / ruling 54: telemetry export ─────────────────────────────────────────────────────────────
# One rule for every sink lives in hermes_cli/iclone_sinks.py (ruling 57: no enable path in v0.0.3).


def telemetry_endpoint_allowed(endpoint: object, env: Optional[Mapping[str, str]] = None, root: Optional[Path] = None) -> bool:
    """OTLP: plain Hermes as configured; under icloneOS never (ruling 57.1: no enable path in v0.0.3)."""
    from hermes_cli.iclone_sinks import sink_allowed

    return sink_allowed("otlp", endpoint, env, root)


def refuse_telemetry_export(endpoint: object) -> None:
    if not telemetry_endpoint_allowed(endpoint):
        raise UploadRefused(
            "icloneOS never exports diagnostics or telemetry: this version has no setting that turns it on."
        )
