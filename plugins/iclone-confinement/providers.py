"""The two terminal backends Hermes can select (``TERMINAL_ENV``): ``iclone_seatbelt`` and ``iclone_container``."""

from __future__ import annotations

import errno
import os
import platform
import re
import selectors
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

from agent.terminal_env_provider import TerminalEnvironmentProvider

from . import core

CONTAINER_PINNED = "1.5.0"
CONTAINER_PKG_SHA256 = "a24808cb202318fa1c3bbee0c6c6887fe1225fe899d7b687a0ddd939bd6573f8"
CONTAINER_OWNER_COMMAND = " && ".join([
    "cd ~/Downloads",
    f"curl -fLO https://github.com/apple/container/releases/download/{CONTAINER_PINNED}/container-{CONTAINER_PINNED}-installer-signed.pkg",
    f'echo "{CONTAINER_PKG_SHA256}  container-{CONTAINER_PINNED}-installer-signed.pkg" | shasum -a 256 -c -',
    f"sudo installer -pkg container-{CONTAINER_PINNED}-installer-signed.pkg -target /",
    "container system start",
    "container --version",
])


def _profiles_dir() -> str:
    return os.environ.get("ICLONE_CONFINEMENT_DIR", "")


def _activity_class() -> str:
    cls = os.environ.get("ICLONE_CONFINEMENT_CLASS", "project")
    return cls if cls in core.ACTIVITY_CLASSES else "project"


class SeatbeltProvider(TerminalEnvironmentProvider):
    """Commands run on this Mac, inside a Seatbelt profile the app generated."""

    # Host paths stay host paths, and the approval prompts still apply: Seatbelt narrows, it does not isolate.
    is_remote = False
    is_container = False

    @property
    def name(self) -> str:
        return "iclone_seatbelt"

    @property
    def display_name(self) -> str:
        return "icloneOS Seatbelt"

    @property
    def env_description(self) -> str:
        return "this Mac, confined by icloneOS (project and scratch only; no keychain, no home secrets)"

    @property
    def skip_container_guards(self) -> bool:
        return False

    def is_available(self) -> bool:
        return platform.system() == "Darwin" and os.path.exists(core.SANDBOX_EXEC) and bool(_profiles_dir())

    def probe(self) -> Tuple[str, str]:
        if self.is_available():
            return ("ready", "")
        return ("unavailable", "Seatbelt is macOS only and needs the icloneOS app's profiles.")

    def create_environment(self, *, cwd: str, timeout: int, task_id: str = "default", image: Optional[str] = None,
                           container_config: Optional[dict] = None, **kwargs: Any):
        from .seatbelt import SeatbeltEnvironment

        if not self.is_available():
            raise core.ConfinementRefused("Seatbelt is not available here; commands are refused rather than run unconfined")
        return SeatbeltEnvironment(cwd=cwd, timeout=timeout, cls=_activity_class(), index=core.trusted_index(),
                                   task_id=task_id)


# K133: the only places that count, in this order — the app checks the same list (electron/iclone-confinement/probe.ts)
# and both are held to tests/fixtures/container_detect.json. Never a PATH lookup: a stray shim must not stand in for it.
CONTAINER_CANDIDATES = ("/usr/local/bin/container", "/opt/homebrew/bin/container")

# G3-1: "installed" is the app's definition, not "a file exists": the CLI's own answer to `--version`, anchored at the
# start (a different tool, or any x.y.z anywhere in a message, is not it), within the same timeout, on the same Macs.
CONTAINER_VERSION_RE = re.compile(r"^container CLI version ([0-9]+\.[0-9]+\.[0-9]+)(?=[ \t\r\n]|$)", re.ASCII)
CONTAINER_VERSION_TIMEOUT_MS = 3000
# G3 r2 m-1: how both sides read a check's raw bytes (the app's CHECK_OUTPUT_* and answerText, held to the shared
# fixture): at most this many bytes per stream (more is stopped, a definite failure), decoded as UTF-8 with invalid
# bytes replaced (never an exception), stripped of exactly " \t\r\n" (str.strip() would also take \x1c-\x1f and
# Unicode spaces), matched with ASCII digits only.
CHECK_OUTPUT_MAX_BYTES = 64 * 1024
CHECK_OUTPUT_STRIP = " \t\r\n"
CONTAINER_MIN_DARWIN_MAJOR = 25  # macOS 26
# The detection is re-measured when older than this (the app's PROBE_TTL_MS): the probe and the refusal read one answer.
CONTAINER_DETECT_TTL_S = 15.0


def _output_text(raw: bytes) -> str:
    """The bytes a check printed, as text: UTF-8, invalid bytes replaced (U+FFFD), nothing stripped (a BOM stays)."""
    return raw.decode("utf-8", "replace")


def _answer_text(raw: bytes) -> str:
    """What a check said, as both sides read it."""
    return _output_text(raw).strip(CHECK_OUTPUT_STRIP)


@dataclass(frozen=True)
class RunAnswer:
    code: Optional[int]
    stdout: bytes = b""  # raw, at most CHECK_OUTPUT_MAX_BYTES
    stderr: bytes = b""
    timed_out: bool = False
    error: Optional[str] = None


def _kill_group(proc: subprocess.Popen) -> None:
    """SIGKILL the check's whole process group (it leads its own session): nothing it started outlives the probe."""
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except OSError:
        try:
            proc.kill()  # a no-op once the leader is reaped (returncode set)
        except OSError:
            pass


def _run_version(binary: str, timeout_ms: int) -> RunAnswer:
    """G3 r2 m-2: the app's ``runFile`` rule. ``--version`` runs as the leader of its own session; at the timeout the
    whole group gets SIGKILL and the answer is given at once. A program that ignores SIGTERM, or a child it left holding
    the pipe, can neither hold the probe past the timeout nor outlive it."""
    deadline = time.monotonic() + timeout_ms / 1000
    try:
        from tools.environments.host_lane import confine_program  # V3-UP r5 (ruling 56)

        argv, env = confine_program([binary, "--version"], kind="probe")
        proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, env=env,
                                stderr=subprocess.PIPE, start_new_session=True)
    except OSError as error:
        return RunAnswer(code=None, error=errno.errorcode.get(error.errno or 0, type(error).__name__))
    assert proc.stdout is not None and proc.stderr is not None
    stdout_fd, stderr_fd = proc.stdout.fileno(), proc.stderr.fileno()
    out = {stdout_fd: bytearray(), stderr_fd: bytearray()}
    timed_out = False
    too_large = False
    code: Optional[int] = None
    with selectors.DefaultSelector() as pipes:
        pipes.register(proc.stdout, selectors.EVENT_READ)
        pipes.register(proc.stderr, selectors.EVENT_READ)
        try:
            while pipes.get_map() and not timed_out and not too_large:
                left = deadline - time.monotonic()
                if left <= 0:
                    timed_out = True
                    break
                for key, _ in pipes.select(left):
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        pipes.unregister(key.fileobj)
                        continue
                    out[key.fd] += chunk
                    # More than the CLI's one line: stopped (the group, SIGKILL), a definite failure, never the timeout.
                    if len(out[key.fd]) > CHECK_OUTPUT_MAX_BYTES:
                        too_large = True
                        break
            if not timed_out and not too_large:
                try:
                    code = proc.wait(timeout=max(deadline - time.monotonic(), 0))
                except subprocess.TimeoutExpired:
                    timed_out = True
        finally:
            # G3 r3 m-3 (the app's settle): the group is killed on EVERY exit path, so a child the check left running,
            # even one that dropped its pipes, dies with the probe. After a normal exit the leader is reaped, but its
            # group id cannot be reused while a member lives (POSIX); an empty group is ESRCH, ignored.
            _kill_group(proc)
            proc.wait()
            proc.stdout.close()
            proc.stderr.close()
    stdout, stderr = bytes(out[stdout_fd][:CHECK_OUTPUT_MAX_BYTES]), bytes(out[stderr_fd][:CHECK_OUTPUT_MAX_BYTES])
    if timed_out:
        return RunAnswer(code=None, stdout=stdout, stderr=stderr, timed_out=True)
    if too_large:
        return RunAnswer(code=None, stdout=stdout, stderr=stderr, error="output-too-large")
    if code is not None and code < 0:  # killed by a signal that was not the timeout's: the app's `error: SIGxxx`
        try:
            return RunAnswer(code=None, stdout=stdout, stderr=stderr, error=signal.Signals(-code).name)
        except ValueError:
            return RunAnswer(code=None, stdout=stdout, stderr=stderr, error=f"signal {-code}")
    return RunAnswer(code=code, stdout=stdout, stderr=stderr)


def _darwin_major() -> int:
    try:
        return int(platform.release().split(".")[0])
    except ValueError:
        return 0


@dataclass(frozen=True)
class ContainerHost:
    """What detection reads from this Mac; tests pass their own (the shared fixture's cases)."""

    exists: Callable[[str], bool] = os.path.exists
    executable: Callable[[str], bool] = lambda path: os.access(path, os.X_OK)
    run: Callable[[str, int], RunAnswer] = _run_version
    platform: str = field(default_factory=lambda: sys.platform)
    arch: str = field(default_factory=lambda: {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine(), platform.machine()))
    darwin_major: int = field(default_factory=_darwin_major)


@dataclass(frozen=True)
class ContainerDetection:
    """The app's BackendStatusView for container, in the same vocabulary (status, detail, version): installed,
    broken, not-installed, unsupported, or unknown (the check timed out: neutral, G3-2)."""

    status: str
    detail: str
    version: Optional[str]
    binary: Optional[str]
    evidence: str


def container_binary(exists: Optional[Callable[[str], bool]] = None) -> Optional[str]:
    exists = exists or os.path.exists
    for candidate in CONTAINER_CANDIDATES:
        if exists(candidate):
            return candidate
    return None


def _answer_evidence(binary: str, answer: RunAnswer) -> str:
    how = "timed out" if answer.timed_out else f"exit {answer.code}" + (f" ({answer.error})" if answer.error else "")
    return f"{binary} --version: {how}: {_answer_text(answer.stderr or answer.stdout)[:200]}"


def detect_container(host: Optional[ContainerHost] = None) -> ContainerDetection:
    """G3-1: the same rule as the app's ``probeContainer``: Apple silicon on macOS 26+, the first fixed path that exists,
    executable, answering ``--version`` with exit 0 and the CLI's own format. Anything else present is broken (red)."""
    host = host or ContainerHost()
    if host.platform != "darwin" or host.arch != "arm64" or host.darwin_major < CONTAINER_MIN_DARWIN_MAJOR:
        return ContainerDetection("unsupported", "needs-apple-silicon", None, None,
                                  f"{host.platform} {host.arch} darwin {host.darwin_major}")
    binary = container_binary(host.exists)
    if binary is None:
        return ContainerDetection("not-installed", "not-installed", None, None, ", ".join(CONTAINER_CANDIDATES))
    if not host.executable(binary):
        return ContainerDetection("broken", "no-version", None, binary, f"{binary}: not executable (never run)")
    answer = host.run(binary, CONTAINER_VERSION_TIMEOUT_MS)
    # G3-2: a check that did not finish in time on a busy Mac says nothing about the install: neutral, never broken.
    if answer.timed_out:
        return ContainerDetection("unknown", "probe-timeout", None, binary, _answer_evidence(binary, answer))
    match = CONTAINER_VERSION_RE.match(_answer_text(answer.stdout)) if answer.code == 0 else None
    if match is None:
        return ContainerDetection("broken", "no-version", None, binary, _answer_evidence(binary, answer))
    version = match.group(1)
    return ContainerDetection("installed", "not-wired", version, binary,
                              f"{binary} {version}: not used in this version (no spike C1 baseline; Seatbelt confines)")


_detected: dict = {}
# G3 r2 m-3 (the app's one probe in flight): callers that overlap wait for the one detection running and read its
# answer, so an older answer can never overwrite a newer one. Kept for the TTL from when it landed.
_detect_lock = threading.Lock()


def container_detection() -> ContainerDetection:
    """This Mac's detection, re-measured when older than the TTL: ``probe`` and the refusal read the same answer."""
    with _detect_lock:
        last = _detected.get("last")
        if last is None or time.monotonic() - last[0] >= CONTAINER_DETECT_TTL_S:
            detection = detect_container()
            last = (time.monotonic(), detection)
            _detected["last"] = last
        return last[1]


# What detection saw, in the refusal's words — the app's backend-container.ts SEEN, word for word.
_SEEN: Dict[str, Callable[[ContainerDetection], str]] = {
    "installed": lambda d: f"installed{f' ({d.version})' if d.version else ''} but not used",
    "not-installed": lambda d: "not installed on this Mac",
    "broken": lambda d: "installed, but its check failed",
    "unknown": lambda d: "installed, but its check did not finish in time",
    "unsupported": lambda d: "this Mac cannot run it",
}


def container_refusal(detection: Optional[ContainerDetection]) -> str:
    """K131: the backend is not available in this version (no spike C1 baseline; Seatbelt is the sandbox), said with
    what detection saw — an installed ``container`` is never told to be installed."""
    seen = f": {_SEEN[detection.status](detection)}" if detection else ""
    return (f"Apple container is not available in this version of icloneOS{seen}. "
            "The command is refused rather than run unconfined.")


def container_probe(detection: ContainerDetection) -> Tuple[str, str]:
    """The Hermes picker's ``(status, detail)`` for a detection: the app's English catalogue sentences."""
    if detection.status == "not-installed":
        return ("needs_setup", f"Apple container is not installed — owner step (admin password once): {CONTAINER_OWNER_COMMAND}")
    if detection.status == "installed":
        return ("unavailable", f"Apple container {detection.version} is installed, but this version of icloneOS does not use it "
                               "(Seatbelt confines).")
    if detection.status == "unsupported":
        return ("unavailable", "Apple container needs Apple silicon and macOS 26 or later.")
    if detection.status == "unknown":
        return ("unavailable", "Apple container could not be checked: the check did not finish in time (this Mac may have been busy). "
                               "It runs again shortly.")
    return ("unavailable", "Apple container is installed, but it did not answer a version check: the install looks broken.")


class ContainerProvider(TerminalEnvironmentProvider):
    """Apple ``container`` micro-VMs (doc 12). Not used in this version: detected and reported, every command refused."""

    @property
    def name(self) -> str:
        return "iclone_container"

    @property
    def display_name(self) -> str:
        return "Apple container (icloneOS)"

    def is_available(self) -> bool:
        return False

    def probe(self) -> Tuple[str, str]:
        return container_probe(container_detection())

    def setup_instructions(self) -> List[str]:
        return [CONTAINER_OWNER_COMMAND]

    def create_environment(self, *, cwd: str, timeout: int, task_id: str = "default", image: Optional[str] = None,
                           container_config: Optional[dict] = None, **kwargs: Any):
        from tools.environments.base import EnvironmentConnectionError

        raise EnvironmentConnectionError(f"Refused by icloneOS confinement: {container_refusal(container_detection())}")
