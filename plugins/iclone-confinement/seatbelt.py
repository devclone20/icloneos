"""The Seatbelt terminal environment: Hermes' local environment, with every bash wrapped in
``sandbox-exec -p <verified profile text> -D …`` and the marker as its ``$0`` so the app's pane can see it in ``ps``.
Each command gets a run token (``-D MEMBER=``) so main can find, count and stop every process of it, daemons included.
"""

from __future__ import annotations

import contextvars
import logging
import os
import signal
import subprocess
import sys
import time
from typing import Any, Callable, Dict, List, Optional

try:  # upstream 1ac3f97 moved the stdin writer into base_output; the import base had it in base (V3-UP)
    from tools.environments.base_output import _pipe_stdin
except ImportError:  # pragma: no cover — a pre-split runtime
    from tools.environments.base import _pipe_stdin
from tools.environments.local import LocalEnvironment, _find_bash, _make_run_env, _resolve_safe_cwd

try:  # the cwd marker splitter moved with the session-environment split (V3-UP)
    from tools.environments.base_session_env import _split_cwd_marker
except ImportError:  # pragma: no cover — a pre-split runtime
    from tools.environments.base import _split_cwd_marker

RUNTIME_SHELL = "/bin/bash"


def _shell() -> str:
    """The bash a confined command runs under. A confined runtime names ``/bin/bash`` by its path alone: inside a
    sandbox that may not exec it, access(2) answers no and Hermes' lookup finds no shell, yet it is the launcher
    outside the sandbox that execs it. Unconfined, Hermes' own lookup decides."""
    if core.runtime_confined() and os.path.isfile(RUNTIME_SHELL):
        return RUNTIME_SHELL
    return _find_bash()


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


# fx18 (F1): the folder one request runs in — the terminal tool's ``workdir`` or the session's tracked cwd — set by
# ``execute`` and read by ``_run_bash`` on the deadline worker (``run_bounded_sync`` copies the context). The dict is
# shared between the two, so the worker reports back which project the run was confined to and why.
_REQUEST: contextvars.ContextVar = contextvars.ContextVar("iclone_request", default=None)


def request_cwd(folder: str) -> str:
    """The one spelling the launcher takes, as far as this runtime can say it: normalised, and macOS's own root links
    (/tmp is /private/tmp) are not a second name the agent chose. Any other link is the launcher's to refuse."""
    spelled = os.path.normpath(folder)
    if spelled.startswith("//"):
        spelled = "/" + spelled.lstrip("/")
    top = spelled.split(os.sep)[1] if spelled.startswith(os.sep) else ""
    return f"/private{spelled}" if top in ("tmp", "var", "etc") else spelled


class SeatbeltEnvironment(LocalEnvironment):
    """Spawn-per-call like ``local``. fx18 (F1): the project root is resolved per request from the folder the
    request runs in, by the same rule as ``core.acceptable_project_root`` (its git root; never home, ``~/Library``,
    a denied or protected folder), so a ``workdir``, or a ``cd`` that persisted within this message (Hermes resets the
    cwd record for the next message), confines the next command to that folder — read-only until main lists it, which the launcher narrows and says. A folder the rule
    refuses keeps the window's project, and the run's output says which rule refused it; a ``cd`` that leaves the
    project inside one command cannot be seen in advance and is explained after the run."""

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
            raise core.ConfinementRefused(f"no confinement profile for class {cls!r}", "no-profile")
        self._cls = cls
        self._profile = self._index.profiles[cls]
        # An environment the runtime builds for its own probe: everything it runs is housekeeping, said to the
        # launcher in the request (core.ORIGIN_ENV), so the ledger does not list it as the agent's.
        self._runtime_own = task_id in core.RUNTIME_PROBE_TASK_IDS
        self._scratch = core.scratch_dir(self._index, task_id)
        self._project = self.project_for(cwd or os.getcwd()) or self._scratch
        merged = dict(env or {})
        merged.update({"TMPDIR": os.path.join(self._scratch, "tmp"), "GIT_CONFIG_GLOBAL": os.path.join(self._scratch, ".gitconfig")})
        # fx18 (F3): the session's global git config starts with the user's own name and e-mail, nothing else.
        core.seed_scratch_git_config(self._scratch)
        super().__init__(cwd=cwd if self._project != self._scratch else self._scratch, timeout=timeout, env=merged)

    @property
    def project_root(self) -> str:
        """The window's project: the folder the environment was made for (the fallback of every request)."""
        return self._project

    def project_for(self, folder: str) -> Optional[str]:
        """The project a command in ``folder`` is confined to: the realpath of its git root when the root may be a
        project, else ``None``."""
        root = core.git_root(folder)
        return os.path.realpath(root) if core.acceptable_project_root(root, self._index) else None

    def request_project(self) -> tuple:
        """fx18 (F1): ``(project, refused)`` for the request in flight: the project of the request's folder, or the
        window's project with the rule that refused the folder (``None`` outside a request, or when the folder is
        the window's own)."""
        request = _REQUEST.get()
        folder = request.get("cwd") if request else None
        if not folder:
            return self._project, None
        project = self.project_for(folder)
        if project is not None:
            return project, None
        why = core.project_root_refusal(core.git_root(folder), self._index) or "it is not a folder"
        return self._project, why

    def runtime_can_list(self, folder: str) -> bool:
        """Whether this (confined) runtime may list ``folder``: a folder main did not open is outside the runtime's
        own profile, though the command's sandbox, made for that folder, reads it."""
        try:
            with os.scandir(folder):
                return True
        except PermissionError:
            return False
        except OSError:
            return True

    def scanned_by_launcher(self, root: str, project: str) -> bool:
        """fx18 (F1): the hard-link scan (F7) of a project the runtime cannot look into is the launcher's, which is
        not confined and scans any folder outside the runtime's own roots, listed or not, before and after the run
        (fx20, lens5 M2); this runtime skips it only then, and only when the run goes through the launcher (without
        one, the scan here refuses as before)."""
        return root == project and project != self._project and core.runtime_confined() and not self.runtime_can_list(project)

    def _extract_cwd_from_output(self, result: dict) -> None:
        """Hermes drops a reported cwd that ``isdir`` denies; here ``isdir`` is also false for a folder the runtime
        may not stat (EPERM) though the shell is in it. That folder is kept: it is where the next command runs,
        confined to it, and what the explanation after a failed ``cd`` names."""
        prev_cwd = self.cwd
        raw = result.get("output", "")  # the base strips the marker line from the output
        super()._extract_cwd_from_output(result)
        if self.cwd == prev_cwd and not result.get("cwd_observed"):
            split = _split_cwd_marker(raw, self._cwd_marker)
            reported = split[0] if split else None
            if reported and reported != prev_cwd and self._exists_unreadable(reported):
                self.cwd = reported
                result["cwd_observed"] = True
                result["cwd"] = reported

    @staticmethod
    def _exists_unreadable(path: str) -> bool:
        try:
            os.stat(path)
        except PermissionError:
            return True
        except OSError:
            return False
        return False

    def get_temp_dir(self) -> str:
        return os.path.join(self._scratch, "tmp")

    # proofaudit row 11: a background command is its own sandbox instance, and from the next one the kernel refuses a
    # signal (the profile's rule, kept), so ``kill -0`` and ``kill`` run through this shell say nothing true. The launcher
    # answers instead; a runtime with no launcher stands outside every profile and asks the kernel itself. The registry
    # (tools/process_registry.py) reads these two; another environment has neither and keeps its own shell's answer.
    def background_alive(self, pid: int) -> bool:
        if core.runtime_confined():
            return bool(core.launcher_background(pid, stop=False)["alive"])
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            pass
        return True

    def stop_background(self, pid: int) -> List[int]:
        """Ends the command and what it started; the pids still alive afterwards."""
        if core.runtime_confined():
            return list(core.launcher_background(pid, stop=True)["left"])
        try:
            group = os.getpgid(pid)
        except ProcessLookupError:
            return []
        if group == os.getpgrp():
            raise core.ConfinementRefused("a background command shares the runtime's process group", "bad-group")
        for sig, grace in ((signal.SIGTERM, 2.0), (signal.SIGKILL, 1.0)):
            try:
                os.killpg(group, sig)
            except ProcessLookupError:
                return []
            deadline = time.monotonic() + grace
            while time.monotonic() < deadline:
                try:
                    os.killpg(group, 0)
                except ProcessLookupError:
                    return []
                time.sleep(0.05)
        return [pid]

    def scanned_roots(self, project: Optional[str] = None) -> List[str]:
        """F7: the project and the scratch (T1: the scratch too) are scanned before every command and after it."""
        project = project or self._project
        return [project, self._scratch] if project != self._scratch else [self._scratch]

    def sandbox_argv(self, bash_args: list, session_id: Optional[str], project: Optional[str] = None) -> list:
        text = core.read_verified(self._profile)
        sha = core.hashlib.sha256(text.encode("utf-8")).hexdigest()
        project = project or self._project
        writable = project != self._scratch
        # Never widen (fx18): a folder other than the window's is writable only through the launcher, which lists
        # the folders main opened and narrows every other one to read-only; a runtime running sandbox-exec itself
        # (no launcher) writes only the window's project, whatever the mode.
        listed_here = project == self._project or core.runtime_confined()
        for root in self.scanned_roots(project):
            if self.scanned_by_launcher(root, project):
                continue
            core.check_hardlinks(self._index, root, self._cls)
        grants = core.grant_params(session_id, project if writable else None, self._project)
        params: Dict[str, str] = {
            "PROJECT_ROOT": project,
            "SCRATCH": self._scratch,
            "OUTPUT_DIR": os.path.join(self._scratch, "output"),
            "NET": grants["NET"],
            "WRITE_PROJECT": grants["WRITE_PROJECT"] if writable and listed_here else "0",
            "PROJECT_GIT": core.project_git_state(project, self._scratch),
        }
        os.makedirs(params["OUTPUT_DIR"], mode=0o700, exist_ok=True)
        params["MEMBER"] = core.new_run_token(self._index, self._cls, sha, session_id)
        defines = [item for key, value in params.items() for item in ("-D", f"{key}={value}")]
        argv = [core.SANDBOX_EXEC, "-p", text, *defines, *bash_args, core.marker(self._cls, sha, session_id)]
        # A confined runtime cannot apply a profile itself: the stub hands this exact argv to the launcher.
        return core.via_launcher(argv)

    def _bash_args(self, cmd_string: str, login: bool) -> list:
        """The bash that runs one command (``sandbox_argv`` wraps it; the marker becomes its ``$0``)."""
        bash = _shell()
        # ``exit $?`` keeps bash alive as the marked parent: a lone simple command would be exec'd in place of bash
        # and take the marker out of ``ps`` with it.
        script = f"{cmd_string}\nexit $?"
        return [bash, "-l", "-c", script] if login else [bash, "-c", script]

    def _wrap_command(self, command: str, cwd: str) -> str:
        """The base wrapper's cwd marker runs ``pwd -P``, which is getcwd(2): refused (EPERM) once a ``cd`` has left
        the project, so the runtime would not learn where the shell ended. Bash's own ``$PWD`` is the folder the
        shell believes it is in, and the explanation after the run needs exactly that."""
        script = super()._wrap_command(command, cwd)
        return script.replace('"$(pwd -P)"', '"$(pwd -P 2>/dev/null || printf %s "$PWD")"', 1)

    def write_approved_file(self, path: str, content: str, patch_of: Optional[str] = None) -> Optional[int]:
        """G2 A5: the one file main's answer named, written by the launcher. G23: a file the route cannot write is refused
        here in plain text, naming what works, before a confined shell turns it into a raw error. None for any other write,
        which runs as ever."""
        if not os.path.isabs(path):
            return None
        folder, name = os.path.split(os.path.normpath(path))
        real = os.path.join(os.path.realpath(folder), name)
        # G23-W2: main's answer names a link's real target.
        target = os.path.realpath(real)
        if core.take_approved_file(target):
            base = None if patch_of is None else patch_of.encode("utf-8", "surrogateescape")
            return core.send_approved_file(target, content.encode("utf-8", "surrogateescape"), base)
        try:
            index = core.trusted_index()
        except core.ConfinementRefused:  # no spec, no rule: the run answers as ever
            return None
        shut = core.file_stays_shut(index, real)
        if shut:
            raise core.ConfinementRefused(shut, "onefile")
        return None

    def read_approved_file(self, path: str) -> Optional[bytes]:
        """G23-W2: the bytes of the one file main's answer named, once, from the launcher. None for any other read."""
        if not os.path.isabs(path):
            return None
        target = os.path.realpath(os.path.normpath(path))
        return core.read_one_file(target) if core.take_approved_read(target) else None

    def note_route_view(self, path: str, digest: str, first: int, last: int, total: int) -> None:
        """G27: the lines of a route read the agent was really shown, after the tool's own budget cut them."""
        core.note_route_view(os.path.realpath(os.path.normpath(path)), digest, first, last, total)

    def approved_read_waiting(self, path: str) -> bool:
        """G24: main answered for reading this exact file: the read block on a project's .env stands aside for it."""
        if not os.path.isabs(path):
            return False
        return core.approved_read_waiting(os.path.realpath(os.path.normpath(path)))

    def approved_file_waiting(self, path: str) -> bool:
        """G23: main answered for this exact file: a gate that would ask again or refuse by name stands aside for it."""
        if not os.path.isabs(path):
            return False
        return core.approved_file_waiting(os.path.realpath(os.path.normpath(path)))

    def execute(self, command: str, cwd: str = "", **kwargs: Any) -> dict:
        """One request: the folder it runs in (``cwd``, the terminal tool's ``workdir`` or the session's tracked
        cwd, else the environment's) decides the project for its run, and a run that failed outside its project is
        told why in its own output (fx18, F1)."""
        # G-98 F42: the owner's answer. An approved shell command runs once outside the Seatbelt (the launcher holds
        # main's record of it); an approved write that names a folder runs its tool's commands made for that folder,
        # still confined. Without an answer nothing here changes.
        # G2 A4: a background command comes inside Hermes' wrapper; the owner's answer names the text he read.
        one_shot_text = command if core.take_approved_command(command) else None
        if one_shot_text is None:
            inner = core.background_command(command)
            one_shot_text = inner if inner is not None and core.take_approved_command(inner) else None
        one_shot = one_shot_text is not None
        if one_shot and one_shot_text != command:
            os.makedirs(self.get_temp_dir(), exist_ok=True)  # the launcher checks the wrapper's files in it before the wrapper's mkdir
        cwd = (None if one_shot else core.approved_folder_of(command)) or cwd
        request: Dict[str, Any] = {"cwd": cwd or self.cwd, "project": None, "refused": None, "command": command,
                                   "one_shot": one_shot, "one_shot_text": one_shot_text}
        token = _REQUEST.set(request)
        try:
            result = super().execute(command, cwd, **kwargs)
        finally:
            _REQUEST.reset(token)
        note = self.explain_after_run(request, result)
        if note:
            result["output"] = (result.get("output") or "").rstrip("\n") + "\n" + note + "\n"
        return result

    def explain_after_run(self, request: Dict[str, Any], result: dict) -> Optional[str]:
        """The plain text a run gets when its folder was not its project: a failed run whose folder was refused as a
        project (which rule), or any run whose shell ended outside the project it was confined to (a ``cd`` inside the
        command; proof4 F4: exit 0 too, since ``cmd; echo rc=$?`` exits 0 with its write refused). A run that succeeded
        where it was confined is told nothing: the runtime's tools parse the output of their own runs."""
        if request.get("one_shot"):
            return None if result.get("returncode") == 126 else ("icloneOS: this command ran once outside the Seatbelt, as the owner approved it. Its cd and export do not carry to "
                                                                     "the next command: chain them in one command or use absolute paths.")
        if request.get("project") is None:
            return None
        project, folder = request["project"], request["cwd"]
        if request.get("refused") and result.get("returncode") != 0:
            return (f"icloneOS: this command ran confined to {project} because {folder} cannot be a project folder "
                    f"({request['refused']}), so files in {folder} were refused. Run it from inside a project folder "
                    f"(or give workdir inside one), and open that folder in icloneOS if the command must write there.")
        ended = result.get("cwd") if result.get("cwd_observed") else None
        if not ended or self._inside(ended, project) or self._inside(ended, self._scratch):
            return self._kernel_refusal(request, result)
        # A success that started there and stayed there has nothing to explain: it never moved.
        if result.get("returncode") == 0 and os.path.realpath(ended) == os.path.realpath(folder):
            return None
        next_project = self.project_for(ended)
        if next_project is None:
            why = core.project_root_refusal(core.git_root(ended), self._index) or "it is not a folder"
            tail = (f"{ended} cannot be a project folder ({why}): a command there stays confined to {project}, "
                    f"so change back to a folder inside it.")
        else:
            tail = (f"To run a command there, give workdir={ended} on that command (a cd does not carry over to your "
                    f"next message): it is confined to {next_project}, and it can write there if that folder is "
                    f"open in icloneOS or the user allowed a command in it; otherwise that command runs read-only and "
                    f"says so. If it is read-only because the folder is not listed, its row in the Containers pane "
                    f"offers Allow this folder.")
        return (f"icloneOS: this command moved from {project} to {ended}, outside the folder it was confined to, "
                f"where it cannot write. A read there is refused too. {tail}")

    def _kernel_refusal(self, request: Dict[str, Any], result: dict) -> Optional[str]:
        """G-98 F42: a command the Seatbelt refused is told so in plain text, mode, cause and what to do, so the model
        never guesses at a permission error. Only a failed run whose own output says the kernel refused it."""
        output = result.get("output") or ""
        if result.get("returncode") == 0 or "Operation not permitted" not in output:
            return None
        project = request["project"]
        mode = core.mode_label(session_id=request.get("session_id"), project=project)
        # G21 P1: the pane offers Allow this folder only for a run narrowed because its folder is not listed
        # (containers-data.ts folderToOffer), and the launcher's own line on this output is what says so.
        unlisted = "is not a folder the app has open or you named" in output
        if mode == "Ignore":  # nothing asks here, so no approval is on offer
            return (f"icloneOS: mode {mode}. Cause: the Seatbelt refused this command, which is confined to {project}; Ignore "
                    "permissions does not lift the Seatbelt, and nothing asks in this mode. What to do: tell the user what you "
                    "need and why. " + ("They can open that folder in icloneOS, use Allow this folder in the Containers pane, or "
                                        "turn Isolation off in Settings > Agent > Permissions." if unlisted else
                                        "They can open that folder in icloneOS or turn Isolation off in Settings > Agent > "
                                        "Permissions.") + " To write one file under your home folder, outside the project, the write_file tool "
                    "does it directly in this mode, except this app's own files.")
        return (f"icloneOS: mode {mode}. Cause: the Seatbelt refused this command, which is confined to {project}; a command "
                "allowed without asking stays confined. What to do: tell the user what you need and why. They can open that "
                "folder in icloneOS" + (" or use Allow this folder in the Containers pane" if unlisted else "")
                + ", and a shell command they approve on a sheet runs once outside the Seatbelt. If a stored grant for commands answered "
                "this one, no sheet comes while it stands: they can revoke it in Settings > Agent > Permissions to be asked again. "
                "Turning Isolation off there also lifts the Seatbelt.")

    @staticmethod
    def _inside(path: str, root: str) -> bool:
        try:
            real = os.path.realpath(path)
        except OSError:
            return False
        return real == root or real.startswith(root.rstrip(os.sep) + os.sep)

    def _run_bash(self, cmd_string: str, *, login: bool = False, timeout: int = 120,
                  stdin_data: Optional[str] = None) -> subprocess.Popen:
        run_env = _make_run_env(self.env)
        # The runtime's own housekeeping: an environment built only to probe, or a call Hermes marks as its own at
        # the call (core.runtime_own_call). The launcher drops the variable before the command starts.
        if self._runtime_own or core.runtime_own_call():
            run_env[core.ORIGIN_ENV] = core.ORIGIN_RUNTIME
        session_id = run_env.get("HERMES_SESSION_ID") or None
        request = _REQUEST.get()
        if request is not None:  # the selector's mode is per session: the refusal text must read the same one
            request["session_id"] = session_id
        confined = True
        project, refused = self.request_project()
        request = _REQUEST.get()
        if request is not None:
            request.update({"project": project, "refused": refused})
        one_shot = bool(request and request.get("one_shot"))
        try:
            if one_shot:
                # The exact text the owner read, never the wrapper around it: the launcher hashes what it runs.
                args = core.one_shot_argv()
                run_env[core.ONESHOT_ENV] = request["one_shot_text"]
                if request["one_shot_text"] != request["command"]:
                    run_env[core.ONESHOT_BACKGROUND_ENV] = request["command"]
            else:
                args = self.sandbox_argv(self._bash_args(cmd_string, login), session_id, project)
        except (core.ConfinementRefused, OSError) as exc:
            logger.warning("confinement refused a command: %s", exc)
            # The pane shows the command the agent gave, not the wrapper script around it.
            core.record_refusal(session_id, request.get("command") or cmd_string if request else cmd_string, exc)
            confined = False
            # The runtime's own interpreter says why and exits 126: under the runtime profile it is the one program
            # the runtime may start itself (not /bin/sh), so the refusal reaches the agent as text, never as an error.
            args = [sys.executable, "-I", "-S", "-c", "import sys; sys.stderr.write(sys.argv[1] + '\\n'); sys.exit(126)",
                    f"Refused by icloneOS confinement: {exc}"]
        self.cwd = _resolve_safe_cwd(self.cwd)
        # The command starts in the request's folder: the launcher (not confined) is told it in ICLONE_RUN_CWD, which
        # the stub pops, since this runtime and the stub may not enter a folder main did not open, and a shell
        # started elsewhere fails every getcwd until the wrapper's cd. Here Popen keeps a folder this runtime can use.
        folder = request.get("cwd") if request else None
        if folder and confined and core.runtime_confined():
            # One spelling: the launcher refuses another. A model's workdir may end in a slash or say ``a/../b``.
            run_env["ICLONE_RUN_CWD"] = request_cwd(folder)
        index, cls = self._index, self._cls
        roots = [] if one_shot else [r for r in self.scanned_roots(project) if not self.scanned_by_launcher(r, project)]
        after_run: Dict[str, Any] = {}

        def on_exit() -> None:
            core.check_hardlinks_after_run(index, roots, after_run.get("pid", 0), session_id, cls)

        proc = _ConfinedPopen(
            args,
            on_exit=on_exit if confined and not one_shot else None,
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
