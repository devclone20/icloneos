"""The Seatbelt terminal environment: Hermes' local environment, with every bash wrapped in
``sandbox-exec -p <verified profile text> -D …`` and the marker as its ``$0`` so the app's pane can see it in ``ps``.
Each command gets a run token (``-D MEMBER=``) so main can find, count and stop every process of it, daemons included.
"""

from __future__ import annotations

import logging
import os
import subprocess
from typing import Any, Callable, Dict, List, Optional

try:  # upstream 1ac3f97 moved the stdin writer into base_output; the import base had it in base (V3-UP)
    from tools.environments.base_output import _pipe_stdin
except ImportError:  # pragma: no cover — a pre-split runtime
    from tools.environments.base import _pipe_stdin
from tools.environments.local import LocalEnvironment, _find_bash, _make_run_env, _resolve_safe_cwd

from . import core

logger = logging.getLogger(__name__)


class _ConfinedPopen(subprocess.Popen):
    """``Popen`` that runs ``on_exit`` once, the first time its exit is observed (T3: the scan after the run)."""

    def __init__(self, *args: Any, on_exit: Optional[Callable[[], None]] = None, **kwargs: Any):
        self._iclone_on_exit = on_exit
        super().__init__(*args, **kwargs)

    def _iclone_exited(self) -> None:
        hook, self._iclone_on_exit = self._iclone_on_exit, None
        if hook is not None:
            try:
                hook()
            except Exception:  # a failed scan after the run must never raise into Hermes' wait loop
                logger.warning("the scan after a confined run failed", exc_info=True)

    def poll(self) -> Optional[int]:
        code = super().poll()
        if code is not None:
            self._iclone_exited()
        return code

    def wait(self, timeout: Optional[float] = None) -> int:
        code = super().wait(timeout)
        self._iclone_exited()
        return code


class SeatbeltEnvironment(LocalEnvironment):
    """Spawn-per-call like ``local``; the project root is fixed when the environment is made, so a ``cd`` never
    turns another directory into the writable project."""

    # V3-UP (M3, r3 ruling 43): Hermes runs helpers on the host for a ``LocalEnvironment`` — the native file lane
    # (read_file, the exact-byte read, search, the existence probe), the managed Node linters, LSP servers and their
    # installer, the host stats of file_tools. This environment's shell is confined, so it is not the host: it opts
    # out (tools/environments/host_lane.py ``host_side_helpers_allowed``) and every one of them goes through its
    # confined shell or does not run.
    host_side_helpers = False

    def __init__(self, cwd: str = "", timeout: int = 60, env: Optional[dict] = None, *, cls: str,
                 index: core.ProfileIndex, task_id: str = "default"):
        self._index = index
        if cls not in self._index.profiles:
            raise core.ConfinementRefused(f"no confinement profile for class {cls!r}")
        self._cls = cls
        self._profile = self._index.profiles[cls]
        self._scratch = core.scratch_dir(self._index, task_id)
        root = core.git_root(cwd or os.getcwd())
        self._project = os.path.realpath(root) if core.acceptable_project_root(root, self._index) else self._scratch
        merged = dict(env or {})
        merged.update({"TMPDIR": os.path.join(self._scratch, "tmp"), "GIT_CONFIG_GLOBAL": os.path.join(self._scratch, ".gitconfig")})
        super().__init__(cwd=cwd if self._project != self._scratch else self._scratch, timeout=timeout, env=merged)

    @property
    def project_root(self) -> str:
        return self._project

    def get_temp_dir(self) -> str:
        return os.path.join(self._scratch, "tmp")

    def scanned_roots(self) -> List[str]:
        """F7: the project and the scratch (T1: the scratch too) are scanned before every command and after it."""
        return [self._project, self._scratch] if self._project != self._scratch else [self._scratch]

    def sandbox_argv(self, bash_args: list, session_id: Optional[str]) -> list:
        text = core.read_verified(self._profile)
        sha = core.hashlib.sha256(text.encode("utf-8")).hexdigest()
        writable = self._project != self._scratch
        for root in self.scanned_roots():
            core.check_hardlinks(self._index, root, self._cls)
        grants = core.grant_params(session_id, self._project if writable else None)
        params: Dict[str, str] = {
            "PROJECT_ROOT": self._project,
            "SCRATCH": self._scratch,
            "OUTPUT_DIR": os.path.join(self._scratch, "output"),
            "NET": grants["NET"],
            "WRITE_PROJECT": grants["WRITE_PROJECT"] if writable else "0",
        }
        os.makedirs(params["OUTPUT_DIR"], mode=0o700, exist_ok=True)
        params["MEMBER"] = core.new_run_token(self._index, self._cls, sha, session_id)
        defines = [item for key, value in params.items() for item in ("-D", f"{key}={value}")]
        return [core.SANDBOX_EXEC, "-p", text, *defines, *bash_args, core.marker(self._cls, sha, session_id)]

    def _run_bash(self, cmd_string: str, *, login: bool = False, timeout: int = 120,
                  stdin_data: Optional[str] = None) -> subprocess.Popen:
        bash = _find_bash()
        # ``exit $?`` keeps bash alive as the marked parent: a lone simple command would be exec'd in place of bash
        # and take the marker out of ``ps`` with it.
        script = f"{cmd_string}\nexit $?"
        bash_args = [bash, "-l", "-c", script] if login else [bash, "-c", script]
        run_env = _make_run_env(self.env)
        session_id = run_env.get("HERMES_SESSION_ID") or None
        confined = True
        try:
            args = self.sandbox_argv(bash_args, session_id)
        except (core.ConfinementRefused, OSError) as exc:
            logger.warning("confinement refused a command: %s", exc)
            confined = False
            args = ["/bin/sh", "-c", 'printf "%s\\n" "$1" >&2; exit 126', "iclone-confinement", f"Refused by icloneOS confinement: {exc}"]
        self.cwd = _resolve_safe_cwd(self.cwd)
        index, roots, cls = self._index, self.scanned_roots(), self._cls
        after_run: Dict[str, Any] = {}

        def on_exit() -> None:
            core.check_hardlinks_after_run(index, roots, after_run.get("pid", 0), session_id, cls)

        proc = _ConfinedPopen(
            args,
            on_exit=on_exit if confined else None,
            text=True,
            env=run_env,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.PIPE if stdin_data is not None else subprocess.DEVNULL,
            start_new_session=True,
            cwd=self.cwd,
        )
        after_run["pid"] = proc.pid
        try:
            proc._hermes_pgid = os.getpgid(proc.pid)
        except ProcessLookupError:
            pass
        if stdin_data is not None:
            _pipe_stdin(proc, stdin_data)
        return proc
