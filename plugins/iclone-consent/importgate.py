"""One import hook for the plugin's seams (V3-FX): a module named here is patched the moment it is imported, or at
once if it already is. The upstream modules are never edited; their names are patched in place, so every caller
that looks a function up on the module (``from hermes_cli.debug import run_debug_share`` inside a function, a
module-global call) gets the gated one.

The gate's probe proves the plugin ARMED by finding this finder on ``sys.meta_path`` from the installed copy
(electron/iclone-hermes-plugins.ts ``judgeProbe``).
"""

from __future__ import annotations

import importlib.abc
import logging
import sys
import threading
from typing import Any, Callable, Dict, List

logger = logging.getLogger(__name__)

_PATCHERS: Dict[str, List[Callable[[Any], Any]]] = {}


def _apply(name: str, module: Any) -> None:
    for patcher in _PATCHERS.get(name, []):
        try:
            patcher(module)
        except Exception:  # a seam that cannot apply is logged, never a crash of the runtime
            logger.exception("icloneOS seam for %s could not be applied", name)


class _Loader(importlib.abc.Loader):
    def __init__(self, inner: Any, name: str) -> None:
        self._inner = inner
        self._name = name

    def create_module(self, spec: Any) -> Any:
        return self._inner.create_module(spec)

    def exec_module(self, module: Any) -> None:
        self._inner.exec_module(module)
        _apply(self._name, module)


class _Finder(importlib.abc.MetaPathFinder):
    def __init__(self) -> None:
        # Another finder that resolves through the whole meta path (an import guard) calls back into this one: the
        # names being resolved right now are answered None so the chain ends instead of recursing.
        self._busy = threading.local()

    def find_spec(self, fullname: str, path: Any, target: Any = None) -> Any:
        if fullname not in _PATCHERS:
            return None
        busy = getattr(self._busy, "names", None)
        if busy is None:
            busy = self._busy.names = set()
        if fullname in busy:
            return None
        busy.add(fullname)
        try:
            for finder in sys.meta_path:
                if finder is self or not hasattr(finder, "find_spec"):
                    continue
                spec = finder.find_spec(fullname, path, target)
                if spec is not None:
                    if spec.loader is not None and hasattr(spec.loader, "exec_module") and not isinstance(
                        spec.loader, _Loader
                    ):
                        spec.loader = _Loader(spec.loader, fullname)
                    return spec
            return None
        finally:
            busy.discard(fullname)


_FINDER = _Finder()


def on_import(name: str, patcher: Callable[[Any], Any]) -> None:
    """Patch module ``name`` now if loaded, and when it is imported otherwise."""
    _PATCHERS.setdefault(name, [])
    if patcher not in _PATCHERS[name]:
        _PATCHERS[name].append(patcher)
    if _FINDER not in sys.meta_path:
        sys.meta_path.insert(0, _FINDER)
    loaded = sys.modules.get(name)
    if loaded is not None:
        patcher(loaded)
