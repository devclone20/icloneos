"""Ruling 47 (V3-FX M3): under icloneOS, Hermes never uploads diagnostics, logs or pastes to any third party.

Upstream ``/debug`` (and ``hermes debug share``, the dashboard's ``POST /api/ops/debug-share``, the gateway's
``diagnostics.share_nous``) upload the debug report and log snapshots to paste.rs / dpaste.com or to Nous storage.
This seam refuses every one of those upload functions with a plain message pointing to the local report; the local
path (``/debug local`` → ``run_debug_share`` with ``local``) still renders the report on this machine.

Inventory (kept in step by tests/plugins/test_iclone_consent.py, which fails on an upload function not listed here):
  hermes_cli.debug: upload_to_pastebin, _upload_paste_rs, _upload_dpaste_com, _post_paste (the pinned runtime's
                    one HTTP helper), build_debug_share, run_debug_share (all but ``local``), _run_debug_share_nous
  hermes_cli.diagnostics_upload: share_to_nous
"""

from __future__ import annotations

import logging
from typing import Any

from . import importgate

logger = logging.getLogger(__name__)

REFUSAL = (
    "icloneOS never uploads diagnostics or logs. "
    "Save a report to a file instead: Settings › Machine › Diagnostics › Save report."
)

DEBUG_UPLOADS = (
    "upload_to_pastebin",
    "_upload_paste_rs",
    "_upload_dpaste_com",
    "_post_paste",
    "build_debug_share",
    "_run_debug_share_nous",
)
SHARE_UPLOADS = ("share_to_nous",)
_MARK = "__iclone_no_upload__"


class UploadRefused(RuntimeError):
    """Raised instead of any upload; callers already report a failed upload."""


def _refuse(name: str):
    def refused(*_args: Any, **_kwargs: Any) -> Any:
        logger.warning("icloneOS refused %s: diagnostics are never uploaded", name)
        raise UploadRefused(REFUSAL)

    refused.__name__ = name
    refused.__iclone_refused__ = True  # type: ignore[attr-defined]
    return refused


def patch_debug(module: Any) -> None:
    if getattr(module, _MARK, False):
        return
    for name in DEBUG_UPLOADS:
        if hasattr(module, name):
            setattr(module, name, _refuse(name))
    original = getattr(module, "run_debug_share", None)
    if callable(original):
        def run_debug_share(args: Any) -> Any:
            if getattr(args, "local", False):
                return original(args)
            print(REFUSAL)
            return None

        run_debug_share.__iclone_refused__ = True  # type: ignore[attr-defined]
        module.run_debug_share = run_debug_share
    setattr(module, _MARK, True)


def patch_share(module: Any) -> None:
    if getattr(module, _MARK, False):
        return
    for name in SHARE_UPLOADS:
        if hasattr(module, name):
            setattr(module, name, _refuse(name))
    setattr(module, _MARK, True)


def install() -> None:
    importgate.on_import("hermes_cli.debug", patch_debug)
    importgate.on_import("hermes_cli.diagnostics_upload", patch_share)
