"""The confinement launcher: starts every confined command for a Hermes that runs under its own runtime profile.

A sandboxed process cannot apply a second profile (``sandbox_apply`` fails inside a sandbox), so the app's main
process starts this launcher OUTSIDE any sandbox (``<python> -I -S launcher.py``, stdlib only) and Hermes reaches it
through a tiny stub child (stub.py) over a unix socket. The launcher starts only what main allowed:

* the profile text must hash to a profile in the spec main handed THIS process (``ICLONE_CONFINEMENT_SPEC``), or be
  one of those profiles widened for an app-fixed program by lines of the exact shapes programs.py writes, inserted
  before the profile's closing block (so the never rules still win) — and every path such a line grants lies, by
  real path, where the runtime itself may already go: main names the runtime profile's own read roots and write
  roots in this process's environment (``ICLONE_LAUNCHER_READ_ROOTS`` / ``ICLONE_LAUNCHER_WRITE_ROOTS``, the same
  resolved values the runtime profile is given), and the run's own validated roots add to them. A launcher started
  without those two variables refuses every widened profile (exact ones still run);
* ``-D KEY=VALUE`` pairs only, each known key once, every value checked here (paths absolute, real and normalised,
  the project root acceptable, the scratch under the spec's scratch root, flags 0/1, the run token an existing file
  in the members dir whose name matches the profile);
* NET and WRITE_PROJECT never above what main allows (fx7, ``LauncherPolicy``): main writes its own copy of the
  permission policy — the body it signs for the runtime — to ``policy.json`` in the ledger folder at every change,
  and the launcher decides class N and class Wp from it for the run's session and project with V3-F's own code
  (plugins/iclone-permissions/policy.py), the way core.grant_params does inside the runtime. A request asking for
  more than that answer is refused (``policy``), and the refusal is in ``refused.jsonl``. No file, or a file that is
  not main's, is no policy: then NET=1 and WRITE_PROJECT=1 are refused, and a read-only run still goes;
* a widened profile runs only the program it was widened for: the command's own program lies inside an install the
  widening grants exec of;
* the loader variables of the request's environment are dropped.

Each run gets the stub's own fds as 0/1/2, a session of its own, and a journal line at start and at end
(``runs.jsonl`` in the ledger folder ``ICLONE_LAUNCHER_JOURNAL_DIR``, a folder of the launcher's own that the runtime
profile denies, so what ran is recorded by a process the runtime cannot reach; the launcher is its only writer). The
start line says who issued the run (``origin``): the agent, or the runtime's own housekeeping, read from how the
runtime sent it (``run_origin``), never from the command's text. Every
refused request goes to ``refused.jsonl`` beside it, a file with its own rotation: the runtime can make the launcher
refuse at will, and refusals must never rotate a start or end line away. A connection from another user's process is
refused before its request is read. One request carries no fds: ``{"v": 1, "op": "ping"}``, the runtime asking
whether commands can run (its terminal tool is offered only while this answers); it gets ``{"ok": true, "op":
"pong"}`` and is never journaled. The stub forwards TERM/INT/HUP/QUIT to
the run's process group; a stub that goes away before its run ended takes the run's group with it (SIGKILL). The
launcher exits when main dies.
"""

from __future__ import annotations

import fcntl
import hashlib
import hmac
import importlib.util
import json
import os
import re
import shlex
import signal
import socket
import stat as stat_mod
import struct
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SANDBOX_EXEC = "/usr/bin/sandbox-exec"
READY = "ICLONE-LAUNCHER-READY"
MAX_REQUEST = 1 << 20
MAX_ARGV = 4096
READ_TIMEOUT_S = 10.0
MAX_RUNS = 256
JOURNAL_ROTATE = 1 << 20
# Run tokens that already started a run, remembered so none starts a second: main folds one run per token (the first
# start), so a reused token would start a command the ledger never shows and lay its kernel refusals and live
# processes on the earlier run. A start row is at least about 250 bytes, so the journal's two generations (each at
# most JOURNAL_ROTATE plus one line) hold under 8,400 starts; a token older than these has left every row main reads.
STARTED_REMEMBERED = 16384
# fx21 (F1): what a run left behind when its first process ended. SANDBOX_FILTER_PATH | SANDBOX_CHECK_NO_REPORT, as members.ts.
SANDBOX_PATH_CHECK = 0x40000001
LEFT_GRACE_S = 0.25
# A scan that waited this long for a slot lost part of its budget to the queue: running out then says nothing of the folder.
SCAN_QUEUED_S = 1.0
LEFT_POLL_S = 1.0
# proofaudit row 11: how long a stopped background command has for its SIGTERM, then for the SIGKILL to land.
BACKGROUND_TERM_GRACE_S = 2.0
BACKGROUND_KILL_GRACE_S = 1.0
COMMAND_CLIP = 2000
# The refusal file (RefusalLog): its own rotation, clipped rows, one coalescing window per repeated refusal.
REFUSED_ROTATE = 256 << 10
REFUSED_COMMAND_CLIP = 512
REFUSED_DETAIL_CLIP = 400
REFUSED_WINDOW_S = 10.0
REFUSED_OPEN_MAX = 64
# A refused row's largest size, in bytes: text is written as UTF-8 (at most four bytes a character, a character outside
# the BMP included), only a control character or a quote is escaped (at most six bytes); the other fields are short
# and fixed. The clips above count characters, so the bound is six bytes each.
REFUSED_ROW_MAX = 6 * (REFUSED_COMMAND_CLIP + REFUSED_DETAIL_CLIP) + 512
FORWARDED = frozenset({signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGQUIT})
PARAM_KEYS = ("PROJECT_ROOT", "SCRATCH", "OUTPUT_DIR", "NET", "WRITE_PROJECT", "PROJECT_GIT", "MEMBER")
# fx29: the folders among them, judged and passed on in the kernel's spelling.
PLACE_KEYS = ("PROJECT_ROOT", "SCRATCH", "OUTPUT_DIR")
READ_ROOTS_ENV = "ICLONE_LAUNCHER_READ_ROOTS"
# fx20 (lens5 M1): how long one scan of a folder outside the runtime's roots may take (stub.py waits longer: it must
# never say "not answering" while this runs), and how many run at once: a runtime can repeat a request, and each
# scan is a walk of the disk.
SCAN_BUDGET_S = 30.0
SCANS_AT_ONCE = 4
WRITE_ROOTS_ENV = "ICLONE_LAUNCHER_WRITE_ROOTS"
GRANT_ROOTS_ENV = "ICLONE_LAUNCHER_GRANT_ROOTS"
APPLICATIONS = "/Applications"
_CS_DARWIN_USER_TEMP_DIR = 65537
LOADER_ENV = ("DYLD_", "LD_")
# The plugin's word, in a request's environment, that the runtime issued this command for itself (core.ORIGIN_ENV);
# read for the start row and dropped from the command's environment.
ORIGIN_ENV = "ICLONE_RUN_ORIGIN"
_BAD_CHARS = re.compile(r"[\x00\n\r]")
# Main's copy of the permission policy, in the ledger folder (launcher-policy.ts writes it; the runtime profile
# denies the folder), and V3-F's decider beside this plugin in the runtime root main judged.
POLICY_FILE = "policy.json"
POLICY_MAX = 1 << 20
# fx13 (D13): main's passes (one per ask the user allowed: a folder and a time, never a command text), beside the policy.
PASS_FILE = "passes.jsonl"
PASS_MAX = 1 << 20
# fx13 (lens3-policy H1): what a shell reads before its script, or defines as functions, is never the runtime's to set
# for a confined run; these names are dropped from every run's environment.
SHELL_ENV_DROPPED = frozenset({"BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS",
                               # The plugin's hand-over from main: never a confined command's.
                               "ICLONE_CONFINEMENT_SPEC", "ICLONE_CONFINEMENT_LINK_KEY", "ICLONE_CONFINEMENT_ACK"})
SHELL_FUNC_PREFIX = "BASH_FUNC_"
POLICY_WATCH_S = 0.25
POLICY_PAIRS_MAX = 4096
# What the ceiling says for one class, widest first: a run gets the widest answer any mode set anywhere gives.
_WIDTH = {"allow": 2, "ask": 1, "refuse": 0}
# The user levels a confined command meets (V3-F2 functions.py): the shell function always, the files function for a
# project write. The launcher cannot classify parts; this is what it can say for the whole command.
CLASS_FUNCTIONS = {"X": ("shell",), "N": ("shell",), "Wp": ("shell", "files")}
PERMISSIONS_POLICY_PY = os.path.join(os.path.dirname(HERE), "iclone-permissions", "policy.py")


def _load_core():
    """The plugin's own core (stdlib only), loaded by path: the same spec parsing and project-root rule as the
    plugin, without importing the plugin package (which needs Hermes)."""
    spec = importlib.util.spec_from_file_location("iclone_confinement_core", os.path.join(HERE, "core.py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses look their module up while the class is made
    spec.loader.exec_module(module)
    return module


core = _load_core()


def _load_door():
    """S10: the signed driver's door (driver_door.py, stdlib only), by path like core."""
    spec = importlib.util.spec_from_file_location("iclone_driver_door", os.path.join(HERE, "driver_door.py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


driver_door = _load_door()
_screen_spec = importlib.util.spec_from_file_location("iclone_screen_door", os.path.join(HERE, "screen_door.py"))
screen_door = importlib.util.module_from_spec(_screen_spec)  # G9: the screen recording's door, by path like the driver's
sys.modules.setdefault(_screen_spec.name, screen_door)
_screen_spec.loader.exec_module(screen_door)


def _load_browser_door():
    """Ruling R1: agent-browser's door (browser_door.py, stdlib only), by path like core."""
    spec = importlib.util.spec_from_file_location("iclone_browser_door", os.path.join(HERE, "browser_door.py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


browser_door = _load_browser_door()

_TOKEN = re.compile(r"^(" + "|".join(core.ACTIVITY_CLASSES) + r")\+([0-9a-f]{12})\+([A-Za-z0-9_.-]{1,64}|-)\+[0-9a-f]{32}$")

# The widening lines programs.py writes (media_widening, the probe's installs), one regex each. A
# quoted path is what programs._safe lets through: no quote, backslash or control character.
_P = r'"(/[^"\\\x00-\x1f\x7f]*)"'
_GRANT_LINES = [  # (regex, what the line grants its paths: metadata · read · write · exec of a program's install)
    (re.compile(r"^\(allow file-read\* process-exec((?: \(subpath " + _P + r"\))+)\)$"), "exec"),
    (re.compile(r"^\(allow file-read-metadata((?: \(literal " + _P + r"\))+)\)$"), "metadata"),
    (re.compile(r"^\(allow file-read\*((?: \(literal " + _P + r"\))+)\)$"), "read"),
    (re.compile(r"^\(allow file-read\* file-write\*((?: \((?:subpath|literal) " + _P + r"\))+)\)$"), "write"),
]
_FILTER_PATH = re.compile(_P)

# Hermes runs each agent command inside a wrapper script of its own (tools/environments/base_session_env.py): the
# saved passthrough variables, the sourced env snapshot, a cd, then `eval '<command>'` with every quote of the command
# written as '\'' , `__hermes_ec=$?`, the env re-dump and the cwd marker. Inside the eval body a quote is always
# followed by a backslash, so a quote followed by a newline and `__hermes_ec=$?` is the wrapper's own closing, and the
# greedy match ends at the last one. A command fed through stdin is wrapped once more in a heredoc group.
_WRAPPED = re.compile(r"(?:^|\n)eval '(.*)'\n__hermes_ec=\$\?\n", re.DOTALL)
_HEREDOC = re.compile(r"\{\n(.*)\n\} << '(HERMES_STDIN_[0-9a-f]{12})' < <\(.*?\)\n.*\n\2\Z", re.DOTALL)


SESSION_SETUP = "Prepare the shell environment for this session"
_SNAPSHOT_MARK = "__hermes_snap_tmp="


def agent_command(script: str) -> str:
    """The agent's own command text out of the bash script the plugin hands the launcher: the wrapper's eval body,
    unescaped, with a stdin heredoc unwrapped; the whole script when its shape is not Hermes' wrapper. Never raises:
    this is what the ledger shows, not what runs."""
    body = script[: -len("\nexit $?")] if script.endswith("\nexit $?") else script
    match = _WRAPPED.search(body)
    if match is None:
        # Hermes' once-per-session snapshot of the login shell's environment: confined like any command, but not
        # something the agent asked for, so the ledger names it instead of showing its plumbing.
        return SESSION_SETUP if _SNAPSHOT_MARK in body else body
    command = match.group(1).replace("'\\''", "'")
    heredoc = _HEREDOC.match(command)
    return heredoc.group(1) if heredoc else command


background_command = core.background_command


def shown_command(command: list) -> tuple:
    """``(kind, text)`` the ledger shows for a confined command's argv (after the profile and its defines): Hermes'
    bash with the run marker as its ``$0`` is a ``shell`` run shown as the agent's own command; anything else is a
    ``program`` run shown as its argv joined. The trailing marker (``iclone-confined:<class>:<hash>:<session>``, the
    plugin's label for ``ps``) is never part of the text, on a start line or a refused one."""
    kind, text, _wrapped, _background = described_command(command)
    return kind, text


def described_command(command: list) -> tuple:
    """``(kind, text, wrapped, background)``: ``shown_command`` plus whether a shell run came through Hermes' command
    wrapper (``execute()``: a tool acting for the agent; a shell script without it is one the environment ran for
    itself — the session snapshot, its login and sudo probes), and whether it is Hermes' background wrapper, whose own
    exit status says nothing about the command it left running."""
    marker = bool(command) and isinstance(command[-1], str) and command[-1].startswith(core.MARKER_PREFIX + ":")
    shell = marker and len(command) >= 4 and os.path.basename(command[0]) == "bash" and command[-3] == "-c"
    if shell:
        script = command[-2]
        body = script[: -len("\nexit $?")] if script.endswith("\nexit $?") else script
        text = agent_command(script)
        inner = background_command(text)
        return "shell", (text if inner is None else inner)[:COMMAND_CLIP], _WRAPPED.search(body) is not None, inner is not None
    return "program", " ".join(command[:-1] if marker else command)[:COMMAND_CLIP], False, False


def run_origin(kind: str, wrapped: bool, env: dict) -> str:
    """Who issued the run, from how the runtime sent it: ``runtime`` when the plugin marked the request as the
    runtime's own (``ORIGIN_ENV``: its environment probes, the programs it runs to learn about the host) or when a
    shell run did not come through Hermes' command wrapper (the environment's own snapshot and probes); ``agent``
    otherwise. The marker is the plugin's word in the request's environment, never in the command's: it is removed
    before anything starts."""
    if env.get(ORIGIN_ENV) == core.ORIGIN_RUNTIME:
        return core.ORIGIN_RUNTIME
    if kind == "shell" and not wrapped:
        return core.ORIGIN_RUNTIME
    return core.ORIGIN_AGENT


def peer_uid(sock: socket.socket):
    """The uid of the process at the other end of a unix stream socket, or None where the kernel cannot be asked
    (then the 0700 socket folder and the 0600 socket are the protection). macOS and the BSDs answer LOCAL_PEERCRED
    with a struct xucred (version, uid, ...); Linux answers SO_PEERCRED with (pid, uid, gid)."""
    try:
        if hasattr(socket, "LOCAL_PEERCRED") or sys.platform == "darwin":
            raw = sock.getsockopt(getattr(socket, "SOL_LOCAL", 0), getattr(socket, "LOCAL_PEERCRED", 1), 76)
            version, uid = struct.unpack_from("Ii", raw)
            return uid if version == 0 else None
        if hasattr(socket, "SO_PEERCRED"):
            _pid, uid, _gid = struct.unpack("3i", sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            return uid
    except (OSError, struct.error):
        return None
    return None


class Refusal(Exception):
    def __init__(self, code: str, sentence: str):
        super().__init__(sentence)
        self.code = code


def iso_now() -> str:
    return core.iso_now()


# --- validation ------------------------------------------------------------------------------------------------------


def real_grant(path: str):
    """``path`` as the kernel will see it: the deepest existing part resolved through every symlink, the rest (a file
    or folder not made yet) appended as named. None for anything not absolute and normalised (so no ``..``, no ``.``,
    no doubled separator can point elsewhere than it reads)."""
    if not os.path.isabs(path) or os.path.normpath(path) != path or path == os.sep:
        return None
    existing, rest = path, []
    while existing != os.sep and not os.path.lexists(existing):
        existing, name = os.path.split(existing)
        rest.insert(0, name)
    real = os.path.realpath(existing)
    return os.path.join(real, *rest) if rest else real


def _load_policy_module():
    """V3-F's own decision (stdlib only), loaded by path from the runtime root beside this plugin: the mode table, the
    session and project modes and the grants are read by the same code the runtime reads them with. None when it
    cannot be loaded — then nothing decides, and nothing is allowed."""
    try:
        spec = importlib.util.spec_from_file_location("iclone_permissions_policy", PERMISSIONS_POLICY_PY)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module  # dataclasses look their module up while the class is made
        spec.loader.exec_module(module)
        return module
    except Exception:  # noqa: BLE001 — a decider that does not load is no decider
        return None


def _roots_of(value):
    """Both lists of ``{reads, writes}``, or None for anything else."""
    if not isinstance(value, dict):
        return None
    lists = (value.get("reads"), value.get("writes"))
    if not all(isinstance(lst, list) and all(isinstance(p, str) and os.path.isabs(p) for p in lst) for lst in lists):
        return None
    return tuple(lists[0]) + tuple(lists[1])


class LauncherPolicy:
    """The most a confined command may be given, from ``policy.json`` in the ledger folder: main's own copy of the
    policy body it signs for the runtime, rewritten by main at every mode, grant or switch change, so a change in
    the UI is read on the very next request. The file must be a regular file of this user (never followed as a
    link); anything else, or nothing, is no policy."""

    _roots = None

    def __init__(self, directory: str, module=None):
        self.path = os.path.join(directory, POLICY_FILE)
        self.module = _load_policy_module() if module is None else module
        self._key = None
        self._body = None
        self._listed: tuple = ()
        self._asked: tuple = ()
        self._widest: dict = {}

    def runtime_roots(self):
        """The roots of the runtime main spawned last, by real path; None when the file does not say."""
        self.body()
        return None if self._roots is None else tuple(os.path.realpath(r) for r in self._roots)

    def key(self):
        """The file's identity now (None when it is gone): what a watcher compares to know the policy moved."""
        try:
            st = os.lstat(self.path)
        except OSError:
            return None
        return (st.st_ino, st.st_mtime_ns, st.st_ctime_ns, st.st_size)

    def body(self):
        try:
            st = os.lstat(self.path)
        except OSError:
            self._key, self._body, self._listed, self._asked, self._widest = None, None, (), (), {}
            self._roots = None
            return None
        key = (st.st_ino, st.st_mtime_ns, st.st_ctime_ns, st.st_size)
        if key == self._key:
            return self._body
        body, listed, asked, roots = None, (), (), None
        if stat_mod.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and 0 < st.st_size <= POLICY_MAX:
            try:
                fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
                try:
                    data = json.loads(os.read(fd, POLICY_MAX + 1))
                finally:
                    os.close(fd)
                if isinstance(data, dict) and data.get("v") == 1 and isinstance(data.get("body"), dict):
                    body = data["body"]
                    names = data.get("projects")
                    # fx12 (c): the folders main has open or the user named; matched by identity at each request.
                    listed = tuple(p for p in names if isinstance(p, str) and os.path.isabs(p)) \
                        if isinstance(names, list) else ()
                    # fx17 (lens4-pass M2): the listed folders that an allowed ask named (main keeps them only while
                    # a pass or a grant for them is live), never one the user opened or allowed by the button.
                    names = data.get("asked")
                    asked = tuple(p for p in names if isinstance(p, str) and os.path.isabs(p)) \
                        if isinstance(names, list) else ()
                    roots = _roots_of(data.get("roots"))
            except (OSError, ValueError):
                body, listed, asked, roots = None, (), (), None
        self._key, self._body, self._listed, self._asked, self._widest = key, body, listed, asked, {}
        self._roots = roots
        return body

    def asked(self) -> tuple:
        """Identities of the listed folders an allowed ask named (fx17, M2): a run that started while one was listed
        is left alone when it drops, as a pass's expiry leaves a run alone."""
        self.body()
        identities = (folder_identity(p) for p in self._asked)
        return tuple(i for i in identities if i is not None)

    def listed_paths(self) -> tuple:
        """fx29: the listed folders as main spelled them, for the launcher to find a listed ancestor of a project."""
        self.body()
        return self._listed

    def projects(self) -> tuple:
        """Identities of the folders a run may write (main's list), stat-ed now (fx13, lens3-normal m1): a folder
        replaced at the same path since the policy was read is the folder that is there now."""
        self.body()
        identities = (folder_identity(p) for p in self._listed)
        return tuple(i for i in identities if i is not None)

    def widest(self, cls: str):
        """fx12 (b): the widest answer for ``cls`` any mode set anywhere gives — standing, every session mode, every
        project mode, every grant — judged by V3-F's own ``decide`` with ``fns=("shell",)``, the function a confined
        command is. ``allow``, ``ask``, ``refuse``, or None without a body or a decider. The session and the project a
        request names are the runtime's word; narrowing to them is the runtime's job (said in S1), this is the most
        the launcher ever gives."""
        body = self.body()
        if body is None or self.module is None:
            return None
        if cls in self._widest:
            return self._widest[cls]
        sessions = [None] + [s for s in (body.get("sessions") or {}) if isinstance(s, str)]
        projects = [None] + [p for p in (body.get("projects") or {}) if isinstance(p, str)]
        for grant in list(body.get("grants") or []) + list(body.get("fnGrants") or []):
            if not isinstance(grant, dict):
                continue
            if isinstance(grant.get("sessionId"), str):
                sessions.append(grant["sessionId"])
            if isinstance(grant.get("project"), str):
                projects.append(grant["project"])
        widest = None
        pairs = 0
        try:
            for session in dict.fromkeys(sessions):
                for project in dict.fromkeys(projects):
                    pairs += 1
                    if pairs > POLICY_PAIRS_MAX:
                        break
                    verdict = self.module.decide(body, cls=cls, facts={}, floor=None, ceiling_key=None,
                                                 session_id=session, project=project,
                                                 fns=CLASS_FUNCTIONS.get(cls, ("shell",)))
                    outcome = str(verdict.outcome)
                    if outcome not in _WIDTH:
                        continue
                    if widest is None or _WIDTH[outcome] > _WIDTH[widest]:
                        widest = outcome
                    if widest == "allow":
                        break
                if widest == "allow" or pairs > POLICY_PAIRS_MAX:
                    break
        except Exception:  # noqa: BLE001 — a body the decider cannot read is no policy
            widest = None
        self._widest[cls] = widest
        return widest

    def granted(self, cls: str, identity=None) -> bool:
        """fx13 (lens3-normal B1): the user allowed class ``cls`` itself — for a session, a project or standing — and
        that grant lifts the cell it was given in, by V3-F's own ``decide`` for the grant's own session and project
        (a grant under a Plan session lifts nothing). core.py's rule, read here: the owner already allowed the shell
        command itself, so nothing asks again and nothing can pass.
        fx17 (lens4-pass H1): a grant given for one project lifts only a run in that folder, compared by identity;
        a run that names no folder (scratch, ``identity`` None) takes a project grant of any folder, as it takes a
        pass of any folder. A session or standing grant lifts every listed folder: the launcher cannot tell
        sessions apart, and S1 says so. Not cached: the grant's folder is stat-ed now, as the list is."""
        body = self.body()
        if body is None or self.module is None:
            return False
        found = False
        try:
            for grant in body.get("grants") or []:
                if not isinstance(grant, dict) or grant.get("cls") != cls:
                    continue
                session = grant.get("sessionId") if isinstance(grant.get("sessionId"), str) else None
                project = grant.get("project") if isinstance(grant.get("project"), str) else None
                if project is not None and identity is not None and folder_identity(project) != identity:
                    continue
                verdict = self.module.decide(body, cls=cls, facts={}, floor=None, ceiling_key=None,
                                             session_id=session, project=project,
                                             fns=CLASS_FUNCTIONS.get(cls, ("shell",)))
                if str(verdict.outcome) == "allow" and str(verdict.rule) == "grant":
                    found = True
                    break
        except Exception:  # noqa: BLE001 — a body the decider cannot read grants nothing
            found = False
        return found

    def undecided_holds(self, cls: str) -> bool:
        """fx24 (r3-A): a mode set here gives ``cls`` without asking, and all that stops it is a switch nobody decided.
        Then the true reason is the switch, never "no mode allows it": the user's mode already does."""
        body = self.body() or {}
        key = (body.get("ceilingKey") or {}).get(cls)
        if not isinstance(key, str) or (body.get("ceilings") or {}).get(key, "undecided") != "undecided":
            return False
        modes = [body.get("standing")] + list((body.get("sessions") or {}).values()) \
            + list((body.get("projects") or {}).values())
        table = body.get("table") or {}
        return any(isinstance(m, str) and str((table.get(m) or {}).get(cls, "")) == "A" for m in modes)

    def refused_because(self, cls: str) -> str:
        """Why no mode set anywhere allows ``cls`` (fx13, lens3-normal M2): every mode set is Plan, or the class's
        switch is off, or the modes that are set refuse it — the true one, never "every mode is Plan" when it is not."""
        body = self.body() or {}
        modes = [body.get("standing")] + list((body.get("sessions") or {}).values()) \
            + list((body.get("projects") or {}).values())
        modes = [m for m in modes if isinstance(m, str)]
        if modes and all(m == "plan" for m in modes):
            return PLAN_EVERYWHERE
        key = (body.get("ceilingKey") or {}).get(cls)
        if isinstance(key, str) and (body.get("ceilings") or {}).get(key) == "off":
            return f"the {SWITCH_NAMES.get(key, key)} switch is off in Settings"
        return f"the modes set on this Mac ({', '.join(dict.fromkeys(modes)) or 'none'}) refuse it"


SWITCH_NAMES = {"fileWriting": "File writing", "webBrowsing": "Web browsing & network calls",
                "terminal": "Terminal commands"}


def folder_identity(path: str):
    """``(st_dev, st_ino)`` of the folder at ``path`` as it is now, or None when there is no such folder."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (st.st_dev, st.st_ino) if stat_mod.S_ISDIR(st.st_mode) else None


def kernel_spelling(key: str, path: str) -> str:
    """fx26a, fx29 (lead's ruling 1): ``path`` is a folder; what comes back is the text the kernel reports for it, the
    folder's own identity (case and Unicode form are the kernel's to say, never the runtime's text nor a string rule's):
    the run is judged and started in that spelling. A FIFO, a file or nothing at that path is refused without blocking."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError:
        raise Refusal("bad-request", f"{key} is not a folder") from None
    try:
        reported = os.fsdecode(fcntl.fcntl(fd, fcntl.F_GETPATH, bytes(1024)).split(b"\0", 1)[0])
    except OSError:
        raise Refusal("bad-request", f"{key} could not be read back from the kernel") from None
    finally:
        os.close(fd)
    return reported


def canonical_project(path: str):
    """The folder at ``path`` by identity, after the kernel confirms ``path`` is the folder's own spelling: F_GETPATH
    on the opened folder must give the text back (case, Unicode form and firmlinks resolved by the kernel, never by a
    string rule here). Raises ``Refusal`` on any other spelling or on no folder."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        raise Refusal("bad-request", "PROJECT_ROOT is not a folder") from None
    try:
        reported = os.fsdecode(fcntl.fcntl(fd, fcntl.F_GETPATH, bytes(1024)).split(b"\0", 1)[0])
        st = os.fstat(fd)
    except OSError:
        raise Refusal("bad-request", "PROJECT_ROOT could not be read back from the kernel") from None
    finally:
        os.close(fd)
    if reported != path:
        raise Refusal("policy", "PROJECT_ROOT is another spelling of the folder's path; the launcher takes only "
                                "the path the folder itself reports")
    return (st.st_dev, st.st_ino)


class Passes:
    """fx13 (D13): main's passes in ``passes.jsonl`` (a regular file of this uid, never followed as a link). One row
    per ask the user allowed: the folder it was allowed in (by path, matched here by identity) and when it expires.
    A pass lifts an asking cell for every run in that folder until it expires — the runs of the one tool call an
    ``once`` covered, or as long as a broader allow lasts. It binds no command text: the launcher cannot verify which
    command runs (lens3-policy H1), only a folder and a time, and it is never taken, so nothing is replayed."""

    def __init__(self, directory: str):
        self.path = os.path.join(directory, PASS_FILE)
        self._key = None
        self._rows: list = []
        self.lock = threading.Lock()

    def rows(self) -> list:
        try:
            st = os.lstat(self.path)
        except OSError:
            self._key, self._rows = None, []
            return self._rows
        key = (st.st_ino, st.st_mtime_ns, st.st_ctime_ns, st.st_size)
        if key == self._key:
            return self._rows
        rows: list = []
        if stat_mod.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and 0 < st.st_size <= PASS_MAX:
            try:
                fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
                try:
                    data = os.read(fd, PASS_MAX + 1)
                finally:
                    os.close(fd)
                for raw in data.splitlines():
                    try:
                        row = json.loads(raw)
                    except ValueError:
                        continue
                    # fx17 (lens4-pass M1): a row carries the class the user allowed; one without lifts nothing.
                    if isinstance(row, dict) and row.get("v") == 1 and isinstance(row.get("id"), str) \
                            and isinstance(row.get("exp"), (int, float)) and isinstance(row.get("cls"), str) \
                            and (row.get("project") is None or isinstance(row.get("project"), str)):
                        rows.append(row)
            except OSError:
                rows = []
        self._key, self._rows = key, rows
        return rows

    def live(self, project_identity, flag: str, now: float = None):
        """The id of a live pass that lifts ``flag`` for this folder: project writes from a Wp or X row of the folder,
        the network from an N or X row of the folder — or, for a run that names no folder, of any folder (fx17,
        lens4-pass M1: a pass has the class the user allowed, so a write_file allow is never the network, and an
        ask that named no folder lifts nothing). None when there is none. A pass's folder is matched by identity,
        as the project list is."""
        classes = PASS_CLASSES[flag]
        now = time.time() if now is None else now
        with self.lock:
            for row in self.rows():
                if now >= row["exp"] or row["cls"] not in classes or row["project"] is None:
                    continue
                if project_identity is None or folder_identity(row["project"]) == project_identity:
                    return row["id"]
        return None


ONESHOT_FILE = "oneshots.jsonl"
ONESHOT_FLAG = "--iclone-oneshot"
ONESHOT_BACKGROUND_ENV = core.ONESHOT_BACKGROUND_ENV
ONEFILE_FLAG = core.ONEFILE_FLAG
ONEFILE_ENV = core.ONEFILE_ENV
ONEFILE_READ_FLAG = core.ONEFILE_READ_FLAG
ONEFILE_SEEN_ENV = core.ONEFILE_SEEN_ENV
ONESHOT_BACKGROUND = ("This command was not started outside the Seatbelt: what came to start it in the background is not the "
                      "wrapper for the text the owner read. Run the command again as the owner read it, or ask the owner.")
ONEFILE_REFUSED = "This file was not written outside the Seatbelt: {why}. Nothing was changed."
ONEFILE_READ_REFUSED = "This file was not read outside the Seatbelt: {why}."
# G23 M1: a confined command may hold a folder on this path, so no name is followed. Each part is opened from the one
# before it, refusing a link; the temporary and the replace name the folder held open, so a swap cannot aim the write.
ONEFILE_WRITER = """import hashlib, os, stat, sys, unicodedata
def refuse(why):
    sys.exit("This file was not written outside the Seatbelt: " + why + ". Nothing was changed.")
path, home = sys.argv[1], sys.argv[2]
folder, name = os.path.split(path)
if folder != home and not folder.startswith(home + os.sep):
    refuse("it is not under the home folder")
relative = unicodedata.normalize("NFD", unicodedata.normalize("NFD", path[len(home) + 1:]).casefold())
held = relative in (".netrc", ".pgpass", ".npmrc", ".pypirc", ".git-credentials") or relative.startswith(
    (".ssh/", ".aws/", ".gnupg/", ".kube/", ".docker/", ".azure/", ".config/gh/", ".config/gcloud/"))
opening = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
try:
    at = os.open(home, opening)
    for part in folder[len(home):].split(os.sep):
        if not part:
            continue
        try:
            inner = os.open(part, opening, dir_fd=at)
        except FileNotFoundError:
            try:
                os.mkdir(part, 0o700 if held else 0o777, dir_fd=at)
            except FileExistsError:
                pass
            inner = os.open(part, opening, dir_fd=at)
        os.close(at)
        at = inner
except OSError:
    refuse("its folder moved or is a link")
try:
    found = os.stat(name, dir_fd=at, follow_symlinks=False)
    if not stat.S_ISREG(found.st_mode):
        refuse("it is a link or a folder, not a file")
    mode = stat.S_IMODE(found.st_mode)
    seen = sys.argv[3] if len(sys.argv) > 3 else None
    if seen == "none":
        refuse("it exists and the agent has not read it. Read it with read_file first, or change it with patch")
    if seen == "partial":
        refuse("the agent has read only part of it. Read all of it with read_file, every page, or change it with patch")
    if seen is not None:
        current = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=at)
        with os.fdopen(current, "rb") as handle:
            if hashlib.sha256(handle.read()).hexdigest() != seen:
                refuse("it changed since the agent read it. Read it again first")
except FileNotFoundError:
    mode = 0o600 if held else 0o644
temporary = ".iclone-one-%d" % os.getpid()
fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=at)
try:
    with os.fdopen(fd, "wb") as handle:
        while True:
            chunk = sys.stdin.buffer.read(1 << 20)
            if not chunk:
                break
            handle.write(chunk)
        handle.flush()
        os.fsync(handle.fileno())
        os.fchmod(handle.fileno(), mode)
    os.replace(temporary, name, src_dir_fd=at, dst_dir_fd=at)
except BaseException:
    try:
        os.unlink(temporary, dir_fd=at)
    except OSError:
        pass
    raise
"""
# G23-W2: the same walk, no folder made, for the bytes of one file on the stub's stdout.
ONEFILE_READER = """import os, stat, sys
def refuse(why):
    sys.exit("This file was not read outside the Seatbelt: " + why + ".")
path, home = sys.argv[1], sys.argv[2]
folder, name = os.path.split(path)
if folder != home and not folder.startswith(home + os.sep):
    refuse("it is not under the home folder")
opening = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
try:
    at = os.open(home, opening)
    for part in folder[len(home):].split(os.sep):
        if part:
            inner = os.open(part, opening, dir_fd=at)
            os.close(at)
            at = inner
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=at)
except FileNotFoundError:
    refuse("it does not exist")
except OSError:
    refuse("its folder moved, or it is a link")
found = os.fstat(fd)
if not stat.S_ISREG(found.st_mode):
    refuse("it is not a plain file")
if found.st_size > 32 << 20:
    refuse("it is larger than 32 MB. Use the terminal tool")
with os.fdopen(fd, "rb") as handle:
    while True:
        chunk = handle.read(1 << 20)
        if not chunk:
            break
        sys.stdout.buffer.write(chunk)
sys.stdout.buffer.flush()
"""
ONESHOT_ENV = "ICLONE_ONESHOT_COMMAND"
ONESHOT_SHELL = "/bin/bash"
ONESHOT_NONE = ("This command was not started outside the Seatbelt: icloneOS has no approval from the owner for exactly "
                "this text. An edited command needs its own approval. Run the command again as the owner read it, or "
                "ask the owner.")
ONESHOT_EXPIRED = ("This command was not started outside the Seatbelt: the owner's approval for it has expired. "
                   "Run the same command again and the owner will be asked again.")
ONESHOT_USED = ("This command was not started outside the Seatbelt: the owner's approval covered one run and that run "
                "has happened. Run it again and the owner will be asked again.")
ONESHOT_FOLDER = ("This command was not started outside the Seatbelt: the owner approved it in another folder. Run it "
                  "again in this folder and the owner will be asked again.")


class OneShots:
    """G-98 F42: a shell command a human just read and allowed runs once outside the Seatbelt. Main alone writes
    ``oneshots.jsonl`` (this ledger folder, which the runtime profile denies whole), one row per allowed ask: the
    sha256 of the exact text the sheet showed, the folder, an expiry. Nothing here takes the runtime's word: no row
    is no run, another text is no run, a used row is no run (its id is the run token, and a token never starts twice,
    across a launcher restart too: ``started`` is read back from the journal)."""

    def __init__(self, directory: str):
        self.path = os.path.join(directory, ONESHOT_FILE)

    def rows(self) -> list:
        try:
            st = os.lstat(self.path)
            if not stat_mod.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_size > PASS_MAX:
                return []
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                data = os.read(fd, PASS_MAX + 1)
            finally:
                os.close(fd)
        except OSError:
            return []
        rows: list = []
        for raw in data.splitlines():
            try:
                row = json.loads(raw)
            except ValueError:
                continue
            if isinstance(row, dict) and row.get("v") == 1 and isinstance(row.get("id"), str) \
                    and re.fullmatch(r"[0-9a-f]{32}", row["id"]) and isinstance(row.get("sha"), str) and isinstance(row.get("cwd"), str) \
                    and isinstance(row.get("exp"), (int, float)):
                rows.append(row)
        return rows

    def plan_file(self, req: dict, started, index, reading: bool = False) -> dict:
        """G2 A5: one file the owner allowed where the rule refuses any folder. The row is the hash of the exact path the
        sheet named; the launcher writes that path, once, and opens nothing else. A shell row can never be spent here,
        nor a file row as a command (``kind``). G23-W2: a read is its own kind of row, and returns the bytes on stdout. A row
        from Ignore or for a link's target opens a folder a grant could open; only main writes this ledger."""
        refused, verb = (ONEFILE_READ_REFUSED, "read") if reading else (ONEFILE_REFUSED, "write")
        env, cwd = req.get("env"), req.get("cwd")
        path = env.get(ONEFILE_ENV) if isinstance(env, dict) else None
        if not isinstance(path, str) or not path:
            raise Refusal("oneshot-none", refused.format(why="icloneOS has no approval from the owner for it"))
        # G26: the runtime's profile refuses it the stat, so it names a link as if it were the file. The launcher sees it: the
        # row must be for this link's real target and name this link.
        named, named_link = path, False
        try:
            named_link = stat_mod.S_ISLNK(os.lstat(path).st_mode)
        except OSError:
            pass
        if named_link:
            path, why = core.one_file_target(index, named, opened=True)
            if why or path is None:
                raise Refusal("oneshot-none", refused.format(why=why or "that path could not be read"))
        sha = hashlib.sha256(path.encode("utf-8")).hexdigest()
        now = time.time()
        rows = [r for r in self.rows() if r.get("kind") == ("read" if reading else "file") and hmac.compare_digest(r["sha"], sha)
                and (not named_link or r.get("link") == named)]
        live = [r for r in rows if now < r["exp"]]
        fresh = [r for r in live if oneshot_token(r["id"], sha) not in started]
        link = fresh[0].get("link") if fresh and isinstance(fresh[0].get("link"), str) else None
        why = core.one_file_refusal(index, path, bool(fresh) and (fresh[0].get("by") == "ignore" or link is not None))
        if why:
            raise Refusal("oneshot-none", refused.format(why=why))
        if not fresh:
            raise Refusal("oneshot-used" if live else "oneshot-expired" if rows else "oneshot-none", refused.format(
                why=f"the owner's approval covered one {verb} and that has happened" if live else
                "the owner's approval for it has expired" if rows else "icloneOS has no approval from the owner for it"))
        row, folder = fresh[0], os.path.dirname(path)
        if row["cwd"] != folder or not isinstance(cwd, str) or os.path.realpath(cwd) != os.path.dirname(named):
            raise Refusal("oneshot-folder", refused.format(why="the owner approved another place"))
        if link is not None and core.one_file_target(index, link, opened=True) != (path, None):
            raise Refusal("oneshot-folder", refused.format(why="the link the owner approved points somewhere else now"))
        token = oneshot_token(row["id"], sha)
        home = os.path.realpath(index.home)
        how = "in Ignore permissions" if row.get("by") == "ignore" else "approved by you"
        through = f" (through the link {link})" if link else ""
        seen = env.get(ONEFILE_SEEN_ENV)
        wants = [seen] if not reading and isinstance(seen, str) and re.fullmatch(r"none|partial|[0-9a-f]{64}", seen) else []
        return {
            # Starts in the home, never in the folder: a command may hold that name, and the writer walks to it itself.
            "argv": [sys.executable, "-I", "-S", "-c", ONEFILE_READER if reading else ONEFILE_WRITER, path, home, *wants],
            "executable": sys.executable,
            "cwd": home,
            "env": {"PATH": "/usr/bin:/bin", "LANG": "C"}, "one_shot": True,
            "start": {"run": token, "kind": "shell", "cls": None, "sha": sha, "session": env.get("HERMES_SESSION_ID") or None,
                      "command": (f"[ran once outside the Seatbelt, {how}] {'read' if reading else 'write of'} one file: {path}{through}")[:1000],
                      "cwd": folder, "project": None, "net": False, "write": not reading, "origin": "agent",
                      "unconfined": True, "one_shot": row["id"]},
            "facts": None, "stderr": [],
        }

    def plan(self, req: dict, started, scratch_root: str = "") -> dict:
        """The run this request may have. Raises ``Refusal`` with plain text the agent reads."""
        env, cwd = req.get("env"), req.get("cwd")
        text = env.get(ONESHOT_ENV) if isinstance(env, dict) else None
        if not isinstance(text, str) or not text or "\x00" in text:
            raise Refusal("oneshot-none", ONESHOT_NONE)
        sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
        now = time.time()
        rows = [r for r in self.rows() if "kind" not in r and hmac.compare_digest(r["sha"], sha)]
        live = [r for r in rows if now < r["exp"]]
        fresh = [r for r in live if oneshot_token(r["id"], sha) not in started]
        if not rows:
            raise Refusal("oneshot-none", ONESHOT_NONE)
        if not live:
            raise Refusal("oneshot-expired", ONESHOT_EXPIRED)
        if not fresh:
            raise Refusal("oneshot-used", ONESHOT_USED)
        row = fresh[0]
        where = row["cwd"]
        if not isinstance(cwd, str) or os.path.realpath(cwd) != os.path.realpath(where) or not os.path.isdir(where):
            raise Refusal("oneshot-folder", ONESHOT_FOLDER)
        # G2 A4: a background command. The launcher runs Hermes' wrapper only when it is exactly the wrapper for the text
        # the owner read, with its files in the scratch folder. ``set -C``: its redirections create those files (O_EXCL)
        # and never follow a link the runtime planted there.
        wrapper = env.get(ONESHOT_BACKGROUND_ENV)
        argv = [ONESHOT_SHELL, "-l", "-c", text]
        if wrapper is not None:
            if not isinstance(wrapper, str) or background_command(wrapper) != text or not scratch_root \
                    or not core.background_files_inside(wrapper, scratch_root):
                raise Refusal("oneshot-none", ONESHOT_BACKGROUND)
            argv = [ONESHOT_SHELL, "-c", "set -C\n" + wrapper]
        clean = {k: v for k, v in env.items()
                 if isinstance(k, str) and isinstance(v, str) and k and "=" not in k and "\x00" not in k + v
                 and k != ONESHOT_ENV and k != ONESHOT_BACKGROUND_ENV and k != ORIGIN_ENV and not k.startswith(LOADER_ENV)
                 and k not in SHELL_ENV_DROPPED and not k.startswith(SHELL_FUNC_PREFIX)}
        session = clean.get("HERMES_SESSION_ID") or None
        token = oneshot_token(row["id"], sha)
        return {
            "argv": argv, "executable": ONESHOT_SHELL, "cwd": where, "env": clean,
            "one_shot": True, "background": wrapper is not None,
            "start": {"run": token, "kind": "shell", "cls": None, "sha": sha, "session": session,
                      "command": ("[ran once outside the Seatbelt, approved by you] " + text)[:1000],
                      "cwd": where, "project": None, "net": True, "write": True, "origin": "agent",
                      "unconfined": True, "one_shot": row["id"]},
            "facts": None, "stderr": [],
        }


def oneshot_token(row_id: str, sha: str) -> str:
    """The run token of one main row: the shape every run token has, so the ledger and Activity read it as a run."""
    return f"oneshot+{sha[:12]}+outside+{row_id}"


def is_onefile_request(req) -> bool:
    return isinstance(req, dict) and req.get("v") == 1 and req.get("argv") in ([SANDBOX_EXEC, ONEFILE_FLAG], [SANDBOX_EXEC, ONEFILE_READ_FLAG])


def is_oneshot_request(req) -> bool:
    """The stub carries a one-shot in its usual form: ``sandbox-exec --iclone-oneshot``, the text in the environment."""
    return isinstance(req, dict) and req.get("v") == 1 and req.get("argv") == [SANDBOX_EXEC, ONESHOT_FLAG]


# fx17 (M1): the pass rows that lift each flag — the classes core.py's own rule lifts it from.
# proofaudit row 5: an allowed "write a file outside the project" (Wo) is a write, in the one folder the pass names.
PASS_CLASSES = {"WRITE_PROJECT": ("Wp", "Wo", "X"), "NET": ("N", "X")}


class Validator:
    """The request checks, against the spec main handed this launcher (never anything the request says).

    ``roots`` is ``(read roots, write roots)`` of the runtime profile, as main resolved them; None when main named
    none, and then no widened profile passes at all: a confined command must never receive a path grant the runtime
    itself does not hold, and without the roots that cannot be told."""

    def __init__(self, index, journal_dir: str = "", roots=None):
        self.index = index
        self.journal_dir = os.path.realpath(journal_dir) if journal_dir else ""
        self.scratch_root = os.path.realpath(index.scratch_root)
        self.members_dir = os.path.realpath(index.members_dir)
        self.read_roots = None
        self.write_roots = None
        self.grant_roots = ()
        if roots is not None:
            reads, writes, *grants = roots
            self.grant_roots = tuple(sorted({os.path.realpath(g) for g in (grants[0] if grants else ()) if os.path.isabs(g)}))
            self.read_roots = tuple(sorted({os.path.realpath(r) for r in reads if os.path.isabs(r)}))
            self.write_roots = tuple(sorted({os.path.realpath(w) for w in writes if os.path.isabs(w)}))
        # Main's policy lives in the ledger folder; a validator without one holds no policy and allows no flag.
        self.policy = LauncherPolicy(self.journal_dir) if self.journal_dir else None
        self.passes = Passes(self.journal_dir) if self.journal_dir else None

    def scan_root(self, params: dict):
        """fx20 (lens5 M2): the folder only this process can scan for hard links (F7): the run's project when it is
        not the scratch and lies outside the runtime profile's own roots, whatever the flags and whether main lists it
        or not. The runtime scans what it can list itself; a folder listed after it started stays outside its profile,
        which has one project fixed at spawn. Without the roots, nothing is known to be the runtime's: scanned here."""
        root = params["PROJECT_ROOT"]
        if root == params["SCRATCH"]:
            return None
        # fx24: main's word for the runtime spawned now; a launcher left up across a respawn keeps no old project.
        spawned = self.policy.runtime_roots() if self.policy else None
        known = spawned if spawned is not None else (self.read_roots or ()) + (self.write_roots or ())
        return None if any(core._within(root, r) for r in known) else root

    # policy

    def policy_ok(self, params: dict, *, held=None) -> dict:
        """fx12/fx13: the request's flags against main's ceiling — the widest answer any mode set anywhere gives (b),
        the folders main lists (c), and a pass for a cell that asks (D13: a folder and a time the user allowed, never
        a command text). Raises ``Refusal("policy")`` with no policy from main (nothing decides, nothing is allowed),
        for a cell that refuses (with the true reason: Plan, a switch, or the modes), for a request that asks to
        write scratch as a project, or for another spelling of the project. A cell that asks with no pass, or a
        folder main does not list, narrows that flag to 0 instead and says why: reads always go, and a request that
        asked for more gains nothing. Returns ``{"narrowed": {flag: why}, "passes": {flag: id}, "project": identity}``.
        ``held`` = the facts of a live run re-judged by the watch: a flag it holds that would now be narrowed stops
        it, unless it started under a pass (a pass's expiry never kills a run; a downgrade or a removed grant does)."""
        asks_net, asks_write = params["NET"] == "1", params["WRITE_PROJECT"] == "1"
        scratch = params["PROJECT_ROOT"] == params["SCRATCH"]
        identity = None if scratch else canonical_project(params["PROJECT_ROOT"])
        policy = self.policy
        if policy is None:
            # A validator built with no ledger folder at all (the launcher process always has one: ``main`` refuses
            # to start without it) holds no policy and allows no flag; a read-only run goes.
            if asks_net:
                raise Refusal("policy", NO_MODE_NET)
            if asks_write:
                raise Refusal("policy", NO_MODE_WRITES)
            return {"narrowed": {}, "passes": {}, "project": identity, "listed_by": None}
        if policy.body() is None:
            # fx13 (lens3-policy L1): no policy file, or one that is not main's, is no policy — and nothing decides
            # without one, so no confined command runs, read-only included, until main writes it again.
            raise Refusal("policy", NO_POLICY)
        narrowed: dict = {}
        passes: dict = {}
        rejudge = held is not None

        def lift(cls: str, flag: str, refused: str, why: str, lifted_by: tuple) -> None:
            widest = policy.widest(cls)
            if widest == "allow":
                return
            if widest != "ask":
                raise Refusal("policy", f"{refused} ({policy.refused_because(cls)})")
            if any(policy.granted(other, identity) for other in lifted_by):
                return
            if rejudge:
                if (held.get("passes") or {}).get(flag):
                    return
                raise Refusal("policy", NOW_ASKS[flag])
            pass_id = self.passes.live(identity, flag) if self.passes is not None else None
            if pass_id is None:
                narrowed[flag] = SWITCH_WHY[flag] if policy.undecided_holds(cls) else why
            else:
                passes[flag] = pass_id

        listed_by = None
        if asks_write:
            if scratch:
                raise Refusal("policy", "the request asks to write the project (WRITE_PROJECT=1) and names no project")
            listed = identity in policy.projects()
            if not listed and rejudge and held.get("listed_by") != "ask":
                # Main never unlists a folder the user opened or allowed: this unlisting is a downgrade.
                raise Refusal("policy", NOT_A_LISTED_PROJECT)
            if not listed and not rejudge:
                narrowed["WRITE_PROJECT"] = "unlisted-folder"
            else:
                # fx17 (lens4-pass M2): a folder an allowed ask listed drops when its pass or grant is gone; a run
                # that started under that listing is left alone then, as a pass's expiry leaves a run alone (fx13).
                if not rejudge and identity in policy.asked():
                    listed_by = "ask"
                lift("Wp", "WRITE_PROJECT", NO_MODE_WRITES, "needs-allow", ("Wp", "Wo", "X"))
        if asks_net:
            lift("N", "NET", NO_MODE_NET, "needs-network", ("N", "X"))
        return {"narrowed": narrowed, "passes": passes, "project": identity, "listed_by": listed_by}

    # profiles

    def profile_classes(self, text: str, params=None, command=None) -> frozenset:
        """The classes ``text`` is a profile of: an exact spec profile, or one widened for a program whose every grant
        the run (``params``, already validated) may hold, and which runs that program (``command``)."""
        sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
        exact = frozenset(p.cls for p in self.index.profiles.values() if p.sha256 == sha)
        if exact:
            return exact
        if self.read_roots is None or params is None:
            raise Refusal("profile-unknown", "the profile is not one the app generated")
        found = set()
        for profile in self.index.profiles.values():
            try:
                base = core.read_verified(profile)
            except core.ConfinementRefused:
                continue
            if base.count(core.NEVER_MARK) != 1:
                continue
            head, tail = base.split(core.NEVER_MARK)
            closing = core.NEVER_MARK + tail
            if len(text) <= len(head) + len(closing) or not text.startswith(head) or not text.endswith(closing):
                continue
            widening = text[len(head):len(text) - len(closing)]
            if widening.endswith("\n") and self.widening_ok(widening[:-1].split("\n"), params, command):
                found.add(profile.cls)
        if not found:
            raise Refusal("profile-unknown", "the profile is not one the app generated")
        return frozenset(found)

    def widening_ok(self, lines, params, command=None) -> bool:
        """The widening is one programs.py writes, every path it grants is one the run may hold, and it is tied to
        the program that runs: the command's program (by real path) lies inside an install the widening grants exec
        of. No line opens a socket or localhost: the browser that needed them runs outside the Seatbelt (ruling R1)."""
        if not lines or not command:
            return False
        installs = []
        for line in lines:
            if line.startswith("; ") and not _BAD_CHARS.search(line):
                continue
            for regex, kind in _GRANT_LINES:
                match = regex.match(line)
                if match:
                    paths = _FILTER_PATH.findall(match.group(1))
                    if not paths or not all(self.grant_ok(p, kind, params) for p in paths):
                        return False
                    if kind == "exec":
                        installs.extend(real_grant(p) for p in paths)
                    break
            else:
                return False
        program = real_grant(command[0])
        if program is None:
            return False
        # An install granted exec is the program that runs (a widening without one adds to a program the base profile
        # already runs, such as /bin/cat for a media file).
        if installs and not any(core._within(program, install) for install in installs if install):
            return False
        return True

    def grant_ok(self, path: str, kind: str, params) -> bool:
        """One path of a widening line may be granted ``kind`` to this run: metadata (a stat, never a read) where a
        read may go, or of a folder on the way to one of those roots (resolving a path stats every parent); a read
        only where the runtime reads or writes, or inside the run's own project, scratch or output folder; a write
        only where the runtime writes, or inside the run's scratch or output folder (its project too when the run may
        write it); a program's install (read + exec) where a read may go, or an app bundle directly under
        /Applications (the browser's own code is nowhere the runtime goes, and a bundle holds no file of the owner's).
        Every path is judged by its real path, and never one grant_path_ok refuses. Without the runtime roots,
        nothing passes."""
        if self.read_roots is None or self.write_roots is None:
            return False
        if kind == "metadata":
            return self.metadata_ok(path, params)
        if not self.grant_path_ok(path):
            return False
        real = real_grant(path)
        if real is None or not self.grant_path_ok(real):
            return False
        within = core._within
        if kind == "write":
            # fx26a: a write goes to the run's own folders or a cache main named, never the rest of what the runtime holds.
            roots = [*self.grant_roots, params["SCRATCH"], params["OUTPUT_DIR"]]
            if params["WRITE_PROJECT"] == "1":
                roots.append(params["PROJECT_ROOT"])
            return any(within(real, root) for root in roots)
        roots = [*self.read_roots, *self.write_roots, params["PROJECT_ROOT"], params["SCRATCH"], params["OUTPUT_DIR"]]
        if any(within(real, root) for root in roots):
            return True
        if kind == "exec":
            parent, name = os.path.split(real)
            return parent == APPLICATIONS and name.endswith(".app") and os.path.isdir(real)
        return False

    def metadata_ok(self, path: str, params) -> bool:
        """A stat of ``path`` (by real path): inside a root a read may go to, as grant_ok judges a read; or that root
        itself or a folder above it. Never of anything beside or below those folders."""
        if not self.metadata_path_ok(path):
            return False
        real = real_grant(path)
        if real is None:
            return False
        within = core._within
        roots = [*self.read_roots, *self.write_roots, params["PROJECT_ROOT"], params["SCRATCH"], params["OUTPUT_DIR"]]
        if self.grant_path_ok(path) and self.grant_path_ok(real) and any(within(real, root) for root in roots):
            return True
        return any(within(root, real) for root in roots)

    @staticmethod
    def metadata_path_ok(path: str) -> bool:
        return os.path.isabs(path) and os.path.normpath(path) == path and path != os.sep

    def grant_path_ok(self, path: str) -> bool:
        """A path a program widening may read or write: never /, the home folder or an ancestor of it, the members
        dir, the journal dir, or a denied path (either way round). The profile's closing block still applies."""
        if not self.metadata_path_ok(path):
            return False
        inside = core._inside_folder
        if inside(self.index.home, path) or inside(path, self.members_dir):
            return False
        if self.journal_dir and (inside(path, self.journal_dir) or inside(self.journal_dir, path)):
            return False
        return not any(inside(path, d) or inside(d, path) for d in self.index.denied)

    # values

    @staticmethod
    def _plain_path(key: str, value: str) -> str:
        if not value or _BAD_CHARS.search(value) or not os.path.isabs(value) or os.path.normpath(value) != value:
            raise Refusal("bad-request", f"{key} must be an absolute, normalised path")
        if os.path.realpath(value) != value:
            raise Refusal("bad-request", f"{key} must be a real path (no symlink in it)")
        return kernel_spelling(key, value)

    def listed_ancestor(self, params: dict) -> str:
        """fx29 (lead's ruling 2): the launcher is not confined, so it decides the project of a folder the runtime
        could not look above: the nearest folder main lists that holds PROJECT_ROOT, by identity, in the kernel's
        spelling. Never wider than a folder already listed; with none, the project stays as named and narrows as
        before, and the never list still refuses it as a project. fx32p: the nearest listed folder may sit inside a
        repository that is listed too (a sub-folder opened with Open folder lists both): then the project is that
        repository, or every git command in the folder is fatal, since its profile cannot see the root's .git."""
        root = params["PROJECT_ROOT"]
        if root == params["SCRATCH"] or self.policy is None or self.policy.body() is None:
            return root
        listed = {}
        for text in self.policy.listed_paths():
            identity = folder_identity(text)
            if identity is not None:
                listed.setdefault(identity, text)
        at = root
        while True:
            found = listed.get(folder_identity(at))
            if found is not None:
                spelled = root if at == root else kernel_spelling("PROJECT_ROOT", found)
                spelled = spelled if core.acceptable_project_root(spelled, self.index) else root
                holding = core.git_root(spelled)
                if holding is None or holding == spelled or folder_identity(holding) not in listed:
                    return spelled
                repository = kernel_spelling("PROJECT_ROOT", holding)
                return repository if core.acceptable_project_root(repository, self.index) else spelled
            up = os.path.dirname(at)
            if up == at:
                return root
            at = up

    def _under_scratch(self, key: str, value: str) -> None:
        if not (value.startswith(self.scratch_root + os.sep)):
            raise Refusal("bad-request", f"{key} must lie under the scratch root")

    def params(self, items) -> dict:
        found: dict = {}
        for raw in items:
            key, sep, value = raw.partition("=")
            if not sep or key not in PARAM_KEYS:
                raise Refusal("bad-request", f"unknown profile parameter {key!r}")
            if key in found:
                raise Refusal("bad-request", f"profile parameter {key} given twice")
            found[key] = value
        missing = [k for k in PARAM_KEYS if k not in found]
        if missing:
            raise Refusal("bad-request", f"missing profile parameter {missing[0]}")
        for key in ("SCRATCH", "OUTPUT_DIR"):
            found[key] = self._plain_path(key, found[key])
            self._under_scratch(key, found[key])
        project = found["PROJECT_ROOT"] = self._plain_path("PROJECT_ROOT", found["PROJECT_ROOT"])
        if project != found["SCRATCH"] and not core.acceptable_project_root(project, self.index):
            raise Refusal("bad-request", "PROJECT_ROOT is not a folder a command may be confined to")
        for key in ("NET", "WRITE_PROJECT"):
            if found[key] not in ("0", "1"):
                raise Refusal("bad-request", f"{key} must be 0 or 1")
        # fx10: `unborn` lifts the rule on the project's own .git, so it is judged here, never taken from the request.
        if found["PROJECT_GIT"] not in ("locked", "unborn"):
            raise Refusal("bad-request", "PROJECT_GIT must be locked or unborn")
        if found["PROJECT_GIT"] == "unborn" and core.project_git_state(project, found["SCRATCH"]) != "unborn":
            raise Refusal("bad-request", "PROJECT_GIT is unborn but the project already has a .git")
        return found

    def member(self, value: str, classes: frozenset, sha: str) -> tuple:
        """(token name, class, session|None) of an existing run token made for this profile."""
        if _BAD_CHARS.search(value) or not os.path.isabs(value) or os.path.normpath(value) != value \
                or os.path.dirname(value) != self.members_dir:
            raise Refusal("bad-request", "MEMBER must be a run token in the members folder")
        name = os.path.basename(value)
        match = _TOKEN.match(name)
        if not match or match.group(1) not in classes or match.group(2) != sha[:12]:
            raise Refusal("bad-request", "MEMBER does not name a run token of this profile")
        try:
            st = os.lstat(value)
        except OSError:
            raise Refusal("bad-request", "MEMBER names a run token that does not exist") from None
        if not stat_mod.S_ISREG(st.st_mode) or st.st_uid != os.getuid():
            raise Refusal("bad-request", "MEMBER is not a run token file")
        session = match.group(3)
        return name, match.group(1), (None if session == "-" else session)

    def request(self, req) -> dict:
        """The validated run: argv, cwd, env and the journal facts. Raises ``Refusal``."""
        if not isinstance(req, dict) or req.get("v") != 1:
            raise Refusal("bad-request", "the request is not a version 1 run request")
        argv, cwd, env = req.get("argv"), req.get("cwd"), req.get("env")
        if not isinstance(argv, list) or not all(isinstance(a, str) for a in argv) or not 0 < len(argv) <= MAX_ARGV:
            raise Refusal("bad-request", "argv must be a list of strings")
        if any("\x00" in a for a in argv):
            raise Refusal("bad-request", "argv holds a NUL")
        if argv[0] != SANDBOX_EXEC or len(argv) < 3 or argv[1] != "-p":
            raise Refusal("bad-request", "only sandbox-exec -p <profile> may be started")
        sha = hashlib.sha256(argv[2].encode("utf-8")).hexdigest()
        at, defines = 3, []
        while at < len(argv) and argv[at] == "-D":
            if at + 1 >= len(argv):
                raise Refusal("bad-request", "-D without a value")
            defines.append(argv[at + 1])
            at += 2
        command = argv[at:]
        if not command or not os.path.isabs(command[0]):
            raise Refusal("bad-request", "the command must be an absolute program path")
        # fx29 (lead's ruling 1): the working folder before every place field, so a link is refused as a link, on the
        # real path, and never read as a malformed place under the runtime profile.
        if not isinstance(cwd, str) or not os.path.isabs(cwd) or _BAD_CHARS.search(cwd):
            raise Refusal("bad-request", "cwd must be an absolute path")
        # fx24 (r3-B): one folder, one spelling, as _plain_path asks of the others: what the row says is what it means.
        if os.path.normpath(cwd) != cwd or cwd.startswith("//"):
            raise Refusal("cwd-spelling", "the working folder must be given as the folder itself spells it, with no .. and "
                                          "no repeated or trailing slash")
        # fx20 (lens5 m4): no command starts inside a denied folder: Popen's chdir would answer whether a name exists
        # there, though the sandbox refuses every read. The same answer for a name that is there and one that is not.
        real_cwd = os.path.realpath(cwd)
        if any(core._inside_folder(real_cwd, denied) for denied in self.index.denied):
            raise Refusal("bad-request", "the command's folder is one no confined command may enter")
        # fx32p: a folder that was deleted or moved is an ordinary event for a resumed session, not a malformed request.
        try:
            gone = not stat_mod.S_ISDIR(os.lstat(real_cwd).st_mode)
        except OSError:
            gone = True
        if gone:
            raise Refusal("cwd-gone", f"Its working folder {cwd} is not there any more, so it was not started. "
                                      "Move the folder back, or give a folder that exists.")
        # fx26a, fx29: a link is refused with the folder to give; the folder itself, in whatever case or Unicode form
        # the runtime wrote it, runs in the spelling the kernel reports, since the identity is the kernel's answer.
        if real_cwd != cwd:
            raise Refusal("cwd-spelling", link_line(cwd, real_cwd))
        cwd = self._plain_path("cwd", cwd)
        params = self.params(defines)
        # fx29: the places go to the profile in the kernel's spelling, and the project is the listed folder that holds it.
        named = params["PROJECT_ROOT"]
        params["PROJECT_ROOT"] = self.listed_ancestor(params)
        if params["PROJECT_ROOT"] != named:
            # The runtime judged its own folder's .git; the listed folder's is the kernel's answer, taken here.
            params["PROJECT_GIT"] = core.project_git_state(params["PROJECT_ROOT"], params["SCRATCH"])
        respelled = [f"{key}={params[key]}" for raw in defines for key in [raw.partition("=")[0]]]
        argv = argv[:3] + [part for raw in respelled for part in ("-D", raw)] + command
        at = 3 + 2 * len(respelled)
        # Main's policy first: the flags are the request's word, the ceiling is main's — the widest mode anywhere,
        # the folders main lists, a pass for the folder (never a command text). A flag the policy narrows is 0 from
        # here on, so the widening below is judged with the flags the run gets (fx13, lens3-policy H2).
        verdict = self.policy_ok(params)
        for flag in verdict["narrowed"]:
            argv = [f"{flag}=0" if a == f"{flag}=1" else a for a in argv[:at]] + argv[at:]
            params[flag] = "0"
        classes = self.profile_classes(argv[2], params, command)
        run, cls, session = self.member(params["MEMBER"], classes, sha)
        # The program judged is the program started: the resolved path goes to exec, never the request's spelling.
        argv = argv[:at] + [os.path.realpath(command[0])] + command[1:]
        if not isinstance(env, dict):
            raise Refusal("bad-request", "env must be an object")
        clean = {}
        for key, value in env.items():
            if not isinstance(key, str) or not isinstance(value, str) or not key or "=" in key \
                    or "\x00" in key or "\x00" in value:
                raise Refusal("bad-request", "env must map names to strings")
            if key.startswith(LOADER_ENV) or key == ORIGIN_ENV or key in SHELL_ENV_DROPPED \
                    or key.startswith(SHELL_FUNC_PREFIX):
                continue
            clean[key] = value
        kind, shown, wrapped, background = described_command(command)
        project = None if params["PROJECT_ROOT"] == params["SCRATCH"] else params["PROJECT_ROOT"]
        return {
            "argv": argv, "cwd": cwd, "env": clean,
            "start": {"run": run, "kind": kind, "cls": cls, "sha": sha,
                      "session": session, "command": shown, "cwd": cwd,
                      "project": project,
                      "net": params["NET"] == "1", "write": params["WRITE_PROJECT"] == "1",
                      "origin": run_origin(kind, wrapped, env),
                      **({"passes": verdict["passes"]} if verdict["passes"] else {}),
                      **({"background": True} if background else {}),
                      # The contract with the pane (D13 "What the run says"): narrowed, why, and the folder.
                      **({"narrowed": True, "narrowed_why": next(iter(verdict["narrowed"].values()))}
                         if verdict["narrowed"] else {})},
            # What the watch re-judges when the policy moves: the effective flags, the passes held; what _spawn checks
            # again under its lock: an unborn project's identity.
            "facts": {"params": params, "passes": verdict["passes"], "project": verdict["project"],
                      "listed_by": verdict["listed_by"], "unborn": params["PROJECT_GIT"] == "unborn",
                      "scan_root": self.scan_root(params), "cls": cls, "session": session},
            # What the agent reads on the run's stderr when it fails (lens3-normal M4): the reason and what to do.
            "stderr": narrowed_lines(verdict["narrowed"], project),
        }


def link_line(cwd: str, real_cwd: str) -> str:
    """What the agent reads for such a folder: only what can be done, which is to name the folder itself."""
    return (f"icloneOS: {cwd} is a link to {real_cwd}, and a confined command is not started in a folder given through "
            f"a link. Give {real_cwd} itself as the working folder, then run the command again.\n")


def narrowed_lines(narrowed: dict, project) -> list:
    """One plain line per narrowed flag, written on the run's stderr when the run ends and failed (a read that went
    is told nothing: the runtime's tools parse the merged output of their own runs, lens3-normal M2): agent-visible
    text that says why the run had less than it asked and what the user can do."""
    folder = project or "this folder"
    texts = {
        "unlisted-folder": f"icloneOS: this command has no project writes because {folder} is not a folder the app "
                           "has open or you named. Open it in icloneOS, or choose Allow this folder in the "
                           "Containers pane, then run the command again.",
        "needs-allow": f"icloneOS: this command has no project writes because no mode set on this Mac allows them "
                       f"without asking, and you had not allowed a command in {folder} in the last two minutes. "
                       "Allow a command there in icloneOS, or set a mode that allows project writes, then run the "
                       "command again.",
        "needs-file-writing": f"icloneOS: this command has no project writes because File writing is undecided in "
                              f"Settings, and your mode writes without asking only when it is on. Turn File writing "
                              f"on in Settings, or allow a command in {folder} in icloneOS, then run the command "
                              "again.",
        "needs-web-browsing": "icloneOS: this command has no network because Web browsing & network calls is "
                              "undecided in Settings, and your mode reaches the network without asking only when it "
                              "is on. Turn it on in Settings, or allow a command in icloneOS, then run the command "
                              "again.",
        "needs-network": "icloneOS: this command has no network because no mode set on this Mac allows it without "
                         "asking, and you had not allowed a command in the last two minutes. Allow a command in "
                         "icloneOS, or set a mode that allows the network, then run the command again.",
    }
    return [texts[why] + "\n" for why in narrowed.values()]


PLAN_EVERYWHERE = "every mode set on this Mac is Plan"
NO_POLICY = ("main has written no policy for the launcher, and nothing decides without one: no confined command "
             "runs until it does")
NOT_A_LISTED_PROJECT = ("the request asks to write a folder the app has not open and you never named in a "
                        "permission")
NO_MODE_WRITES = "the request asks to write the project (WRITE_PROJECT=1) and no mode set on this Mac allows project writes"
NO_MODE_NET = "the request asks for the network (NET=1) and no mode set on this Mac allows it"
SWITCH_WHY = {"WRITE_PROJECT": "needs-file-writing", "NET": "needs-web-browsing"}
NOW_ASKS = {"WRITE_PROJECT": "the modes now ask before project writes, and this run was never allowed them",
            "NET": "the modes now ask before the network, and this run was never allowed it"}
UNBORN_IN_FLIGHT = ("another confined command is still making this folder's repository (PROJECT_GIT=unborn); "
                    "it runs alone until it ends")
STOPPED_BY_POLICY = "the run was stopped: the modes changed and no longer allow what it was started with"


def describe(req) -> tuple:
    """(session, command) of a request that was refused, for its journal line (best effort): the command shown as a
    start line would show it (``shown_command``), the session from the run token it named."""
    session, command = None, ""
    argv = req.get("argv") if isinstance(req, dict) else None
    if isinstance(argv, list):
        items = [a for a in argv if isinstance(a, str)]
        for item in items:
            if item.startswith("MEMBER="):
                match = _TOKEN.match(os.path.basename(item[len("MEMBER="):]))
                if match and match.group(3) != "-":
                    session = match.group(3)
        at = 3
        while at < len(items) and items[at] == "-D":
            at += 2
        command = shown_command(items[at:])[1]
    return session, command


# --- journal ---------------------------------------------------------------------------------------------------------


class Journal:
    """``runs.jsonl`` (or ``name``): one JSON object per line, 0600, appended with one ``write`` each. Above ``rotate``
    bytes the file becomes ``.1`` (replacing the one before) ahead of the next line, so it holds at most two
    generations: the current one and ``.1``, each at most ``rotate`` bytes plus the line that crossed it."""

    def __init__(self, directory: str, name: str = "runs.jsonl", rotate: int = JOURNAL_ROTATE):
        self.directory = directory
        self.path = os.path.join(directory, name) if directory else ""
        self.rotate = rotate
        self.lock = threading.Lock()

    def append(self, row: dict) -> None:
        if not self.path:
            return
        # UTF-8 as it is, not \uXXXX escapes: a character outside the BMP would otherwise cost twelve bytes, and the
        # row bounds (REFUSED_ROW_MAX, the command clip of a start row) count on at most six.
        line = (json.dumps({"v": 1, **row}, ensure_ascii=False) + "\n").encode("utf-8")
        try:
            with self.lock:
                try:
                    if os.stat(self.path).st_size > self.rotate:
                        os.replace(self.path, self.path + ".1")
                except FileNotFoundError:
                    pass
                fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                try:
                    os.write(fd, line)
                finally:
                    os.close(fd)
        except Exception:  # noqa: BLE001 — the journal never takes the serving loop down
            pass


class RefusalLog:
    """``refused.jsonl`` beside the run journal: every request the launcher refused, in a file of its own, so refusals
    (which the runtime can cause at will over the socket) never rotate a start or end line out of ``runs.jsonl``.

    Repeats are coalesced, one window per key (session, code, detail and command, after clipping): the first refusal of
    a key is written at once with ``count`` 1; identical refusals in the next REFUSED_WINDOW_S seconds are only counted;
    when the window closes (the flusher thread, the next refusal of any key, too many open windows, or close()) one more
    row carries their ``count``, the first of them as ``ts`` and the last as ``last``. This was chosen over a rate limit
    that drops rows and over writing each window only at its end: the first refusal still reaches the pane at once, no
    refusal is left out of a count, and the append-only file is never rewritten.

    Bounds: an identical flood writes at most two rows per window; at most REFUSED_OPEN_MAX windows are open (the one
    refused least recently closes first, so a repeat stays coalesced while varied requests come and go), so memory
    stays bounded; a row is at most REFUSED_ROW_MAX bytes; requests that differ each cost one
    row, and the file's own rotation keeps at most 2 x REFUSED_ROTATE bytes plus one row on disk. So a runtime that
    varies its requests can still push older refusals out of this file (a bounded log can be flooded by whoever can
    make it write), but never a line of ``runs.jsonl``."""

    def __init__(self, directory: str, *, window: float = REFUSED_WINDOW_S, clock=time.monotonic, flusher: bool = True):
        self.file = Journal(directory, "refused.jsonl", REFUSED_ROTATE)
        self.window = window
        self.clock = clock
        self.lock = threading.Lock()
        # key -> [opened at, repeats counted, first repeat ts, last repeat ts], least recently refused first
        self.open: dict = {}
        self.closed = threading.Event()
        self.flusher = None
        self.wants_flusher = flusher

    def record(self, *, session, command: str, code: str, detail: str) -> None:
        key = (session, code, str(detail)[:REFUSED_DETAIL_CLIP], str(command)[:REFUSED_COMMAND_CLIP])
        ts = iso_now()
        with self.lock:
            if self.closed.is_set():
                # After close() nothing closes a window any more: a late refusal (a connection still in flight while
                # the launcher stops) is written as a row of its own, so its count is never lost.
                self._write(key, ts, ts, 1)
                return
            now = self.clock()
            self._close_expired(now)
            window = self.open.get(key)
            if window is not None:
                self.open[key] = self.open.pop(key)
                window[1] += 1
                window[2] = window[2] or ts
                window[3] = ts
                return
            if len(self.open) >= REFUSED_OPEN_MAX:
                self._close(next(iter(self.open)))
            self.open[key] = [now, 0, None, None]
            self._write(key, ts, ts, 1)
            if self.wants_flusher and self.flusher is None and not self.closed.is_set():
                self.flusher = threading.Thread(target=self._flush_loop, daemon=True)
                self.flusher.start()

    def flush_expired(self) -> None:
        with self.lock:
            self._close_expired(self.clock())

    def close(self) -> None:
        """Every open window's count is written; the flusher ends."""
        self.closed.set()
        with self.lock:
            for key in list(self.open):
                self._close(key)

    def _flush_loop(self) -> None:
        while not self.closed.wait(max(self.window / 4, 0.05)):
            self.flush_expired()

    def _close_expired(self, now: float) -> None:
        for key in [k for k, window in self.open.items() if now - window[0] >= self.window]:
            self._close(key)

    def _close(self, key) -> None:
        _opened, repeats, first, last = self.open.pop(key)
        if repeats:
            self._write(key, first, last, repeats)

    def _write(self, key, first: str, last: str, count: int) -> None:
        session, code, detail, command = key
        self.file.append({"ev": "refused", "ts": first, "last": last, "count": count, "session": session,
                          "command": command, "code": code, "detail": detail})


# --- framing ---------------------------------------------------------------------------------------------------------


def send_msg(sock: socket.socket, obj: dict, lock: threading.Lock = None) -> None:
    data = json.dumps(obj).encode("utf-8")
    frame = struct.pack(">I", len(data)) + data
    if lock is None:
        sock.sendall(frame)
    else:
        with lock:
            sock.sendall(frame)


def recv_exact(sock: socket.socket, size: int, buffered: bytearray) -> bytes:
    while len(buffered) < size:
        chunk = sock.recv(min(65536, max(size - len(buffered), 4096)))
        if not chunk:
            raise EOFError
        buffered.extend(chunk)
    out = bytes(buffered[:size])
    del buffered[:size]
    return out


def recv_msg(sock: socket.socket, buffered: bytearray, limit: int = MAX_REQUEST):
    size = struct.unpack(">I", recv_exact(sock, 4, buffered))[0]
    if size > limit:
        raise Refusal("bad-request", "the request is too large")
    return json.loads(recv_exact(sock, size, buffered).decode("utf-8"))


# --- the launcher ----------------------------------------------------------------------------------------------------


class Run:
    def __init__(self, proc: subprocess.Popen, token: str, facts=None):
        self.stderr_fd = None
        self.stderr_lines: list = []
        self.proc = proc
        self.token = token
        self.facts = facts
        self.member = (facts or {}).get("params", {}).get("MEMBER") or ""
        self.one_shot = False
        self.background = False
        self.stop_why = None
        self.finished = False
        self.lock = threading.Lock()

    def signal_group(self, sig: int) -> None:
        with self.lock:
            if self.finished:
                return
            try:
                os.killpg(self.proc.pid, sig)
            except (ProcessLookupError, PermissionError):
                pass


def _sandbox_answers():
    """``(check, pids)``: libSystem's sandbox_check and every pid, or None when they cannot be asked."""
    try:
        import ctypes

        libc = ctypes.CDLL(None)
        check, list_pids = libc.sandbox_check, libc.proc_listallpids
    except (ImportError, OSError, AttributeError):
        return None
    check.restype = ctypes.c_int
    check.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
    size = 8192
    pids = (ctypes.c_int * size)()
    count = list_pids(pids, ctypes.sizeof(pids))
    return check, list(pids[:max(0, min(count, size))])


def orphan_members(members_dir: str) -> list:
    """fx26a: the live processes that read ``.member`` and whose run token is gone (the kernel answers a path check only
    while the file exists, so no run can find them). The folder is listed after the processes are: a token is made
    before its process starts, so a run starting now is never taken for an orphan. No answer is no orphan."""
    asked = _sandbox_answers()
    if asked is None:
        return []
    import ctypes

    check, pids = asked
    path = ctypes.c_char_p
    op = b"file-read-data"
    folder = os.path.realpath(members_dir)
    decoy, runtime = path(os.path.join(folder, ".decoy").encode()), path(os.path.join(folder, ".runtime").encode())
    mark, me, members = path(os.path.join(folder, ".member").encode()), os.getpid(), []
    for pid in pids:
        if pid <= 1 or pid == me or check(pid, None, 0) != 1:
            continue
        if (check(pid, op, SANDBOX_PATH_CHECK, decoy) == 1 and check(pid, op, SANDBOX_PATH_CHECK, runtime) != 0
                and check(pid, op, SANDBOX_PATH_CHECK, mark) == 0):
            members.append(pid)
    try:
        tokens = [path(os.path.join(folder, n).encode()) for n in os.listdir(folder) if not n.startswith(".")]
    except OSError:
        return []
    return [pid for pid in members if not any(check(pid, op, SANDBOX_PATH_CHECK, t) == 0 for t in tokens)]


def confined_members(token_path: str, only: int = None) -> list:
    """fx21 (F1): the live processes of one run, asked of the kernel the way members.ts asks it: sandboxed, may read this
    run's token, may read neither the decoy nor the runtime mark. A Seatbelt profile is inherited and irrevocable, so
    this finds what a process group cannot: a child that called ``setsid`` or double-forked. No answer (no ctypes, no
    libSystem) is no member: the run is then only what its group was, as before."""
    asked = _sandbox_answers()
    if asked is None:
        return []
    import ctypes

    check, pids = asked
    token = os.path.realpath(token_path)
    folder = os.path.dirname(token)
    path = ctypes.c_char_p
    decoy, runtime = path(os.path.join(folder, ".decoy").encode()), path(os.path.join(folder, ".runtime").encode())
    wanted, me, out = path(token.encode()), os.getpid(), []
    for pid in pids if only is None else (only,):
        if pid <= 1 or pid == me or check(pid, None, 0) != 1:
            continue
        if (check(pid, b"file-read-data", SANDBOX_PATH_CHECK, decoy) == 1
                and check(pid, b"file-read-data", SANDBOX_PATH_CHECK, runtime) != 0
                and check(pid, b"file-read-data", SANDBOX_PATH_CHECK, wanted) == 0):
            out.append(pid)
    return out


class Launcher:
    def __init__(self, index, socket_path: str, journal_dir: str, *, sandbox_exec: str = SANDBOX_EXEC, roots=None):
        # The ledger lives apart from the socket's folder: the runtime may write the run dir (its temp files, the
        # plugin's own refusals), so a journal there could be rewritten by what it records.
        socket_dir = os.path.realpath(os.path.dirname(socket_path))
        if not journal_dir or core._inside_folder(os.path.realpath(journal_dir), socket_dir):
            raise RuntimeError("the ledger folder must be a folder of its own, not the socket's")
        self.validator = Validator(index, journal_dir, roots)
        self.one_shots = OneShots(journal_dir)
        self.driver_door = driver_door.Door(os.path.dirname(socket_path), *driver_door.parse_homes(os.environ))
        self.screen_door = screen_door.Door(driver_door.parse_homes(os.environ)[0])
        home, hermes_home = driver_door.parse_homes(os.environ)
        self.browser_door = browser_door.Door(hermes_home, home)
        self.socket_path = socket_path
        self.journal = Journal(journal_dir)
        self.refusals = RefusalLog(journal_dir)
        # The program actually started for argv[0] == /usr/bin/sandbox-exec (tests substitute a stand-in).
        self.sandbox_exec = sandbox_exec
        self.runs: dict = {}
        self.outside: dict = {}  # G2 A4: the group of an approved background command, outside any Seatbelt
        self.left: dict = {}  # fx21: token -> a run whose first process ended, while the kernel still holds members
        self.runs_lock = threading.Lock()
        self.scans = threading.BoundedSemaphore(SCANS_AT_ONCE)
        # fx13 (lens3-policy M2): folder identities whose repository an unborn run is making now.
        self.unborn_live: set = set()
        # Every token that started a run, oldest first (STARTED_REMEMBERED), seeded from this ledger's own journal so a
        # launcher main restarts still knows the tokens its predecessor started.
        self.started: dict = dict.fromkeys(started_tokens(self.journal.path))
        self.server = None
        self.stopping = False

    @staticmethod
    def _private_dir(directory: str) -> None:
        """``directory`` exists, is a real folder of this user and is 0700 (the umask is the caller's)."""
        os.makedirs(directory, mode=0o700, exist_ok=True)
        st = os.lstat(directory)
        if not stat_mod.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
            raise RuntimeError(f"{directory} is not a folder of this user")
        os.chmod(directory, 0o700)

    def bind(self) -> None:
        directory = os.path.dirname(self.socket_path)
        old = os.umask(0o077)
        try:
            self._private_dir(directory)
            self._private_dir(self.journal.directory)
            try:
                st = os.lstat(self.socket_path)
            except FileNotFoundError:
                st = None
            if st is not None:
                if not stat_mod.S_ISSOCK(st.st_mode) or st.st_uid != os.getuid():
                    raise RuntimeError(f"{self.socket_path} exists and is not a stale socket of this user")
                os.unlink(self.socket_path)
            os.umask(0o177)
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(self.socket_path)
            os.chmod(self.socket_path, 0o600)
            server.listen(64)
        finally:
            os.umask(old)
        self.server = server
        threading.Thread(target=self.policy_watch, name="iclone-launcher-policy-watch", daemon=True).start()

    def serve_forever(self) -> None:
        while not self.stopping:
            try:
                conn, _ = self.server.accept()
            except OSError:
                if self.stopping:
                    return
                time.sleep(0.05)
                continue
            threading.Thread(target=self.handle, args=(conn,), daemon=True).start()

    def _refuse(self, conn, lock, req, refusal: Refusal) -> None:
        session, command = describe(req)
        self.refusals.record(session=session, command=command, code=refusal.code, detail=str(refusal))
        try:
            send_msg(conn, {"ok": False, "code": refusal.code, "error": str(refusal)}, lock)
        except OSError:
            pass

    def _receive(self, conn, buffered: bytearray) -> tuple:
        """The request and the three fds that came with its first bytes."""
        data, fds, flags, _ = socket.recv_fds(conn, 65536, 8)
        if not data:
            for fd in fds:
                os.close(fd)
            raise EOFError
        buffered.extend(data)
        if not fds and not flags & getattr(socket, "MSG_CTRUNC", 0):
            # The one request without fds: the runtime asking whether commands can run. Anything else still needs them.
            req = recv_msg(conn, buffered, 4096)
            if req == core.PING or core.is_background_request(req):
                return req, []
            raise Refusal("bad-request", "a request carries exactly three fds (stdin, stdout, stderr)")
        if len(fds) != 3 or flags & getattr(socket, "MSG_CTRUNC", 0):
            for fd in fds:
                os.close(fd)
            raise Refusal("bad-request", "a request carries exactly three fds (stdin, stdout, stderr)")
        try:
            return recv_msg(conn, buffered), fds
        except BaseException:
            for fd in fds:
                os.close(fd)
            raise

    def handle(self, conn: socket.socket) -> None:
        lock = threading.Lock()
        buffered = bytearray()
        req = None
        run = None
        try:
            conn.settimeout(READ_TIMEOUT_S)
            uid = peer_uid(conn)
            # The caller check is the peer's uid, nothing more: the same user, or (where the kernel answers, as macOS
            # does) a uid it could not read is refused too. Which process is calling is not established here; the
            # 0700 socket folder and the 0600 socket keep other users out before this.
            if uid != os.getuid() and (uid is not None or sys.platform == "darwin"):
                self.refusals.record(session=None, command="", code="bad-request",
                                     detail=f"a connection from another user (uid {uid})")
                try:
                    send_msg(conn, {"ok": False, "code": "bad-request", "error": "the launcher answers its own user only"}, lock)
                except OSError:
                    pass
                return
            try:
                req, fds = self._receive(conn, buffered)
            except Refusal as refusal:
                self._refuse(conn, lock, req, refusal)
                return
            except (EOFError, OSError, ValueError, struct.error):
                return
            if req == core.PING:
                send_msg(conn, {"ok": True, "op": "pong"}, lock)
                return
            if core.is_background_request(req):
                send_msg(conn, self._background(req["pid"], req["stop"]), lock)
                return
            try:
                if driver_door.is_request(req):
                    try:
                        plan = self.driver_door.plan(req)
                    except driver_door.DoorRefused as refused:
                        raise Refusal("other", str(refused)) from None
                elif screen_door.is_request(req):
                    try:
                        plan = self.screen_door.plan(req)
                    except screen_door.DoorRefused as refused:
                        raise Refusal("other", str(refused)) from None
                elif browser_door.is_request(req):
                    try:
                        plan = self.browser_door.plan(req)
                    except browser_door.DoorRefused as refused:
                        raise Refusal("other", str(refused)) from None
                elif is_oneshot_request(req):
                    plan = self.one_shots.plan(req, self.started, getattr(self.validator.index, "scratch_root", ""))
                elif is_onefile_request(req):
                    plan = self.one_shots.plan_file(req, self.started, self.validator.index, req["argv"][1] == ONEFILE_READ_FLAG)
                else:
                    plan = self.validator.request(req)
                self._scan_first(plan)
                run = self._spawn(plan, fds)
            except Refusal as refusal:
                self._refuse(conn, lock, req, refusal)
                return
            finally:
                for fd in fds:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
            self.journal.append({"ev": "start", "ts": iso_now(), "run": plan["start"]["run"], "pid": run.proc.pid,
                                 **{k: v for k, v in plan["start"].items() if k != "run"}})
            try:
                send_msg(conn, {"ok": True, "pid": run.proc.pid}, lock)
            except OSError:
                # fx20 (lens5 M1): nobody will wait on this run. It goes now, through the one path that frees its
                # slot, closes the launcher's copy of its stderr (so the reader sees EOF) and writes its end row.
                run.signal_group(signal.SIGKILL)
                self._reap(run, conn, lock)
                return
            threading.Thread(target=self._reap, args=(run, conn, lock), daemon=True).start()
            conn.settimeout(None)
            while True:
                try:
                    msg = recv_msg(conn, buffered, 4096)
                except (EOFError, OSError, ValueError, struct.error, Refusal):
                    break
                sig = msg.get("signal") if isinstance(msg, dict) else None
                if isinstance(sig, int) and sig in FORWARDED:
                    run.signal_group(sig)
            # The stub is gone (or spoke out of turn): a run still going loses its whole group.
            run.signal_group(signal.SIGKILL)
        except Exception:  # noqa: BLE001 — one bad connection never takes the launcher down
            if run is not None:
                run.signal_group(signal.SIGKILL)
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def _scan_first(self, plan: dict) -> None:
        """fx18 (F1), fx20 (lens5 M1, M2): F7's hard-link scan of a folder the confined runtime cannot look into. This
        process is not confined and scans it before the process exists, outside ``runs_lock`` (no other session's
        command, and no downgrade's kill, waits on a disk walk) and within a time budget: a folder too large to scan
        in it is refused with that reason."""
        facts = plan.get("facts") or {}
        root = facts.get("scan_root")
        if root is None:
            return
        too_large = f"the folder {root} is too large to scan for hard links in {int(SCAN_BUDGET_S)} seconds, so the command did not start; run it in a smaller folder"
        # fx23: a request that only waited behind other scans is told that, not that its folder is too large.
        busy = "the launcher is busy scanning other folders, so the command did not start; run it again in a moment"
        asked = time.monotonic()
        deadline = asked + SCAN_BUDGET_S
        if not self.scans.acquire(timeout=SCAN_BUDGET_S):
            raise Refusal("cannot-scan", busy)
        queued = time.monotonic() - asked >= SCAN_QUEUED_S
        try:
            core.check_hardlinks(self.validator.index, root, facts.get("cls"), deadline=deadline)
        except core.ScanTooLarge:
            raise Refusal("cannot-scan", busy if queued else too_large) from None
        except core.ConfinementRefused as exc:
            raise Refusal(exc.code, str(exc)) from None
        finally:
            self.scans.release()

    def _spawn(self, plan: dict, fds) -> Run:
        facts = plan.get("facts") or {}
        unborn = bool(facts.get("unborn")) and facts.get("project") is not None
        with self.runs_lock:
            if len(self.runs) >= MAX_RUNS:
                raise Refusal("bad-request", "too many confined runs at once")
            token = plan["start"]["run"]
            if token in {r.token for r in self.runs.values()}:
                raise Refusal("bad-request", "that run token is already in use")
            if token in self.started:
                raise Refusal("bad-request", "that run token already started a run; every run needs a token of its own")
            # fx13 (lens3-policy M2): `unborn` was judged at the request; here, under the lock, right before the
            # process exists, it is judged again — and one unborn run per folder identity at a time, so a second
            # request cannot write the config or hooks of the repository the first is making.
            if unborn:
                if facts["project"] in self.unborn_live:
                    raise Refusal("policy", UNBORN_IN_FLIGHT)
                params = facts["params"]
                if core.project_git_state(params["PROJECT_ROOT"], params["SCRATCH"]) != "unborn":
                    raise Refusal("bad-request", "PROJECT_GIT is unborn but the project already has a .git")
            try:
                proc = subprocess.Popen(plan["argv"], executable=plan.get("executable") or self.sandbox_exec, stdin=fds[0], stdout=fds[1],
                                        stderr=fds[2], cwd=plan["cwd"], env=plan["env"], close_fds=True,
                                        start_new_session=True)
            except OSError as exc:
                raise Refusal("other", f"the command could not be started: {exc.strerror or exc}") from None
            self.started[token] = None
            while len(self.started) > STARTED_REMEMBERED:
                del self.started[next(iter(self.started))]
            if unborn:
                self.unborn_live.add(facts["project"])
            run = Run(proc, token, plan.get("facts"))
            run.one_shot = bool(plan.get("one_shot"))
            run.background = bool(plan.get("background"))
            if run.background:
                self.outside[proc.pid] = run
            if plan.get("stderr"):
                # The narrowing's line goes on the run's own stderr when it ends and failed (_reap): the fds the
                # stub lent are closed by the caller once the process holds them, so the launcher keeps its own.
                run.stderr_lines = list(plan["stderr"])
                try:
                    run.stderr_fd = os.dup(fds[2])
                except OSError:
                    run.stderr_fd = None
            self.runs[proc.pid] = run
        return run

    def policy_watch(self) -> None:
        """fx12 (#9): a run never outlives a downgrade. Whenever main's policy file moves, every live run is judged
        again with the flags it was started with and the passes it holds; one the new ceiling no longer allows —
        a refuse cell, a cell that now asks and the run never passed, a folder no longer listed — is killed with its
        group and the ledger says why. A pass's expiry alone moves nothing and kills nothing (fx13, D13)."""
        validator = self.validator
        policy = validator.policy
        last = policy.key() if policy is not None else None
        while not self.stopping:
            time.sleep(POLICY_WATCH_S)
            if policy is None:
                continue
            key = policy.key()
            if key == last:
                continue
            last = key
            with self.runs_lock:
                live = [r for r in (*self.runs.values(), *self.left.values()) if r.facts is not None]
            for run in live:
                try:
                    validator.policy_ok(run.facts["params"], held=run.facts)
                except Refusal as refusal:
                    run.signal_group(signal.SIGKILL)
                    if run.finished:
                        run.stop_why = "policy"
                        self._kill_members(run)
                    self.journal.append({"ev": "refused", "ts": iso_now(), "run": run.token, "code": "policy",
                                         "detail": f"{STOPPED_BY_POLICY} ({refusal})"})
            self._kill_orphans("policy")

    def _reap(self, run: Run, conn: socket.socket, lock: threading.Lock) -> None:
        code = run.proc.wait()
        if run.one_shot and not run.background:
            # The approval covers the command and its children while it runs, never a process left behind outside
            # the Seatbelt: what is still in its group ends with it.
            try:
                os.killpg(run.proc.pid, signal.SIGKILL)
            except OSError:
                pass
        with run.lock:
            run.finished = True
        if run.stderr_fd is not None:
            # fx13 (lens3-normal M4): a narrowed run that failed is told why, after its own output (the runtime
            # merges stderr into the output its tools parse, so the line never precedes what a `cat` or `wc`
            # printed) and before its exit reaches the stub, which still holds the other end of this pipe.
            if code != 0:
                for line in run.stderr_lines:
                    try:
                        os.write(run.stderr_fd, line.encode("utf-8"))
                    except OSError:
                        break
            try:
                os.close(run.stderr_fd)
            except OSError:
                pass
            run.stderr_fd = None
        with self.runs_lock:
            self.runs.pop(run.proc.pid, None)
            if run.member:
                self.left[run.token] = run
            if run.facts and run.facts.get("unborn") and run.facts.get("project") is not None:
                self.unborn_live.discard(run.facts["project"])
        exit_code, sig = (code, None) if code >= 0 else (None, -code)
        self.journal.append({"ev": "end", "ts": iso_now(), "run": run.token, "pid": run.proc.pid,
                             "code": exit_code, "signal": sig})
        # fx24: the watch starts before the scan: a survivor that ends during an up-to-30 s scan still gets its rows.
        watch = threading.Thread(target=self._watch_left, args=(run,), daemon=True)
        watch.start()
        self._scan_after(run)
        try:
            send_msg(conn, {"exit": exit_code, "signal": sig}, lock)
        except OSError:
            pass
        watch.join()

    @staticmethod
    def _kill_members(run: Run) -> int:
        """SIGKILL to every process the kernel holds in this run's token; how many it found."""
        found = confined_members(run.member) if run.member else []
        for pid in found:
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        return len(found)

    def _kill_orphans(self, why: str) -> int:
        """fx26a: every process that reads ``.member`` and whose token is gone is tied to no run and no flags, so no
        ceiling can be judged for it: it goes when the policy moves, lowered or raised, and at quit. fx28: a raise is
        no exception, because no command the user wanted can be here: the runtime cannot remove a token and main removes
        only one no live process holds, so a token gone under a live process was removed from outside the app, and
        what is left has no flags to judge and no run to answer for it. How many this round found."""
        validator = getattr(self, "validator", None)
        found = orphan_members(validator.members_dir) if validator is not None else []
        for pid in found:
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        if found:
            with self.runs_lock:
                for run in self.left.values():
                    if run.member and not os.path.exists(run.member):
                        run.stop_why = run.stop_why or why
        return len(found)

    def _background(self, pid: int, stop: bool) -> dict:
        """proofaudit row 11: the runtime's question about a background command it started. It reaches only a process the
        kernel holds in a run of this launcher, and a stop ends that run's whole membership, which is the command and
        what it started: nothing else can be named through this door, and the profile's signal rule stays as it is."""
        outside = self._outside_background(pid, stop)
        if outside is not None:
            return outside
        if _sandbox_answers() is None:
            return {"ok": False, "error": "the kernel cannot be asked which processes are this run's"}
        with self.runs_lock:
            runs = [*self.left.values(), *self.runs.values()]
        run = next((one for one in runs if one.member and pid in confined_members(one.member, only=pid)), None)
        if run is None:
            return {"ok": True, "alive": False, "left": []}
        if not stop:
            return {"ok": True, "alive": True, "left": []}
        run.stop_why = run.stop_why or "the agent's process tool stopped it"
        for sig, grace in ((signal.SIGTERM, BACKGROUND_TERM_GRACE_S), (signal.SIGKILL, BACKGROUND_KILL_GRACE_S)):
            for member in confined_members(run.member):
                try:
                    os.kill(member, sig)
                except (ProcessLookupError, PermissionError):
                    pass
            deadline = time.monotonic() + grace
            while confined_members(run.member) and time.monotonic() < deadline:
                time.sleep(0.05)
        left = confined_members(run.member)
        return {"ok": True, "alive": bool(left), "left": left}

    @staticmethod
    def _group_alive(group: int) -> bool:
        try:
            os.killpg(group, 0)
        except ProcessLookupError:
            return False
        except OSError:
            return True
        return True

    def _outside_background(self, pid: int, stop: bool):
        """G2 A4: an approved background command has no kernel token: its process group, which the launcher started, says
        what it is. Only a pid in such a group is answered. A child that calls setsid leaves it, as for a foreground one."""
        try:
            group = os.getpgid(pid)
        except OSError:
            return None
        run = self.outside.get(group)
        if run is None:
            return None
        if not stop:
            return {"ok": True, "alive": True, "left": []}
        run.stop_why = run.stop_why or "the agent's process tool stopped it"
        for sig, grace in ((signal.SIGTERM, BACKGROUND_TERM_GRACE_S), (signal.SIGKILL, BACKGROUND_KILL_GRACE_S)):
            try:
                os.killpg(group, sig)
            except OSError:
                break
            deadline = time.monotonic() + grace
            while self._group_alive(group) and time.monotonic() < deadline:
                time.sleep(0.05)
        alive = self._group_alive(group)
        return {"ok": True, "alive": alive, "left": [pid] if alive else []}

    def _watch_outside(self, run: Run) -> None:
        group, announced = run.proc.pid, False
        time.sleep(LEFT_GRACE_S)
        while not self.stopping and self._group_alive(group):
            if not announced:
                announced = True
                self.journal.append({"ev": "left-running", "ts": iso_now(), "run": run.token, "pid": group})
            time.sleep(LEFT_POLL_S)
        if self.stopping:
            return
        self.outside.pop(group, None)
        if announced:
            self.journal.append({"ev": "left-ended", "ts": iso_now(), "run": run.token, "pid": group,
                                 "stopped": run.stop_why is not None, "why": run.stop_why})

    def _left_alive(self, run: Run) -> bool:
        """The run's own members; or, its token gone, any member no token claims: the kernel can no longer tell them
        apart, and "it ended" would be a claim nobody can check."""
        if confined_members(run.member):
            return True
        return not os.path.exists(run.member) and bool(orphan_members(os.path.dirname(run.member)))

    def _watch_left(self, run: Run) -> None:
        """fx21 (F1): the run's first process ended, and its ``end`` row says how, but a background command it started
        (``( trap '' HUP; bash -lc … ) &``, what ``terminal background=true`` sends) lives on, in the group or out of it. The launcher
        still owns it: the journal says it is running, then that it ended; ``stop`` and a policy downgrade reach it."""
        if run.background:
            self._watch_outside(run)
            return
        if not run.member:
            return
        time.sleep(LEFT_GRACE_S)
        announced = False
        while not self.stopping and self._left_alive(run):
            if not announced:
                announced = True
                self.journal.append({"ev": "left-running", "ts": iso_now(), "run": run.token, "pid": run.proc.pid})
            time.sleep(LEFT_POLL_S)
        with self.runs_lock:
            if self.stopping:
                return  # stop() writes the row and exits the process
            self.left.pop(run.token, None)
        if announced:
            self.journal.append({"ev": "left-ended", "ts": iso_now(), "run": run.token, "pid": run.proc.pid,
                                 "stopped": run.stop_why is not None, "why": run.stop_why})

    def _scan_after(self, run: Run) -> None:
        """fx20 (lens5 M2): T3 for a folder the runtime cannot look into: a link planted while the run lived is
        recorded in main's refusal row, and the next command there is refused. Before the exit reaches the stub, so
        the row is on disk when the agent hears the run ended."""
        facts = run.facts or {}
        if facts.get("scan_root") is None:
            return
        try:
            core.check_hardlinks_after_run(self.validator.index, [facts["scan_root"]], run.proc.pid, facts.get("session"),
                                           facts.get("cls"), deadline=time.monotonic() + SCAN_BUDGET_S)
        except Exception:  # noqa: BLE001 — a record that failed never keeps the run's exit from the stub
            pass

    def stop(self) -> None:
        """Every live run's group is killed, and everything a run left behind (fx21: asked of the kernel, so a daemon
        out of the group too), with a row saying so; the socket goes; the refusal counts still open are written. The
        signed driver's daemons go last: that wait can take 10 s each and main's SIGKILL comes after 2 s
        (STOP_GRACE_MS), and the sitters end them anyway when this process is gone, so no daemon may hold up a kill."""
        self.stopping = True
        # G28 (packed proof): _watch_outside returns on stopping, so the quit writes this group's ended row itself.
        for group, outside_run in list(self.outside.items()):
            try:
                os.killpg(group, signal.SIGKILL)
            except OSError:
                pass
            self.journal.append({"ev": "left-ended", "ts": iso_now(), "run": outside_run.token, "pid": group,
                                 "stopped": True, "why": "quit"})
        with self.runs_lock:
            live = list(self.runs.values())
            swept = [*live, *self.left.values()]
        for run in live:
            run.signal_group(signal.SIGKILL)
        deadline = time.monotonic() + 0.5
        found: dict = {}
        while True:
            alive = 0
            for run in swept:
                count = self._kill_members(run)
                alive += count
                if count:
                    found[run.token] = run
            orphans = self._kill_orphans("quit")
            alive += orphans
            if orphans:
                found.update({run.token: run for run in swept if run.member and not os.path.exists(run.member)})
            if (not alive and all(r.finished for r in live)) or time.monotonic() >= deadline:
                break
            time.sleep(0.02)
        for run in found.values():
            survivors = len(confined_members(run.member))
            self.journal.append({"ev": "left-ended", "ts": iso_now(), "run": run.token, "pid": run.proc.pid,
                                 "stopped": True, "why": "quit", "survivors": survivors})
        try:
            if self.server is not None:
                self.server.close()
            st = os.lstat(self.socket_path)
            if stat_mod.S_ISSOCK(st.st_mode):
                os.unlink(self.socket_path)
        except OSError:
            pass
        self.refusals.close()
        try:
            self.driver_door.stop_all()
        except Exception:  # noqa: BLE001 — nothing left to save it for: the sitters fire when this process ends
            pass
        try:
            self.screen_door.stop_all()
        except Exception:  # noqa: BLE001 — same: the supervisor's pipe closes when this process ends
            pass
        try:
            self.browser_door.stop_all()
        except Exception:  # noqa: BLE001 — the same: its sitter fires when this process ends
            pass


def started_tokens(journal_path: str) -> list:
    """The run tokens of the start rows in ``journal_path`` and its ``.1`` (oldest first, the newest
    STARTED_REMEMBERED), for a launcher taking over a ledger. A file that cannot be read, or a torn line, adds nothing."""
    tokens: list = []
    for path in (journal_path + ".1", journal_path) if journal_path else ():
        try:
            with open(path, "rb") as handle:
                for raw in handle:
                    try:
                        row = json.loads(raw)
                    except ValueError:
                        continue
                    if isinstance(row, dict) and row.get("ev") == "start" and isinstance(row.get("run"), str):
                        tokens.append(row["run"])
        except OSError:
            continue
    return tokens[-STARTED_REMEMBERED:]


def runtime_roots(env):
    """``(reads, writes)`` of the runtime profile from the two JSON lists main set, or None when either is missing or
    malformed (then every widened profile is refused)."""
    try:
        reads, writes = (json.loads(env[name]) for name in (READ_ROOTS_ENV, WRITE_ROOTS_ENV))
        grants = json.loads(env.get(GRANT_ROOTS_ENV) or "[]")
    except (KeyError, ValueError):
        return None
    lists = (reads, writes, grants)
    if not all(isinstance(lst, list) and all(isinstance(p, str) and os.path.isabs(p) for p in lst) for lst in lists):
        return None
    return lists


def main() -> int:
    parent = os.getppid()
    try:
        index = core.parse_spec(os.environ.get("ICLONE_CONFINEMENT_SPEC", ""))
        socket_path = os.environ.get("ICLONE_LAUNCHER_SOCKET", "")
        journal_dir = os.environ.get("ICLONE_LAUNCHER_JOURNAL_DIR", "")
        if not os.path.isabs(socket_path) or not os.path.isabs(journal_dir):
            raise RuntimeError("ICLONE_LAUNCHER_SOCKET and ICLONE_LAUNCHER_JOURNAL_DIR must be absolute paths")
        launcher = Launcher(index, socket_path, journal_dir, roots=runtime_roots(os.environ))
        launcher.bind()
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"icloneOS confinement launcher could not start: {exc}\n")
        return 1
    done = threading.Event()

    def on_signal(_sig, _frame):
        done.set()

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, on_signal)
    threading.Thread(target=launcher.serve_forever, daemon=True).start()
    sys.stdout.write(f"{READY} {os.getpid()}\n")
    sys.stdout.flush()
    while not done.wait(1.0):
        if os.getppid() != parent:  # main is gone: never outlive it
            break
    launcher.stop()
    return 0


if __name__ == "__main__":
    os._exit(main())
