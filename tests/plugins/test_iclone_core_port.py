"""V3-UP — the iclone core changes, re-implemented on upstream 1ac3f97, each proven at its new location.

One class per core file of the port (UP-2). Each test drives the upstream code path the change now lives in, so a
future upstream catch-up that drops a hook turns this file red. Temp HERMES_HOME only (pytest's tmp_path).
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from hermes_cli import iclone_policy_env as E

ROOT = Path(__file__).resolve().parents[2]
KEY_HEX = "ab" * 32


@pytest.fixture
def spawn_env():
    """Pretend the icloneOS app spawned this process with ``env`` (the exec-time copy); restored after the test."""

    def _set(env):
        E._reset_for_tests(env)

    yield _set
    E._reset_for_tests(None)


# ---------------------------------------------------------------------------------------------------------------
# hermes_cli/env_loader.py — a dotenv never sets ICLONE_* or HERMES_YOLO_MODE in a process the app started
# ---------------------------------------------------------------------------------------------------------------
class TestEnvLoader:
    def _home(self, tmp_path):
        home = tmp_path / "hh"
        home.mkdir()
        (home / ".env").write_text(
            "ICLONE_POLICY_LOCK=0\nICLONE_PERM_SOCKET=/tmp/evil.sock\nICLONE_EXTRA=1\nHERMES_YOLO_MODE=1\n"
        )
        return home

    def _clean(self, monkeypatch):
        for name in ("ICLONE_POLICY_LOCK", "ICLONE_PERM_SOCKET", "ICLONE_EXTRA", "HERMES_YOLO_MODE"):
            monkeypatch.delenv(name, raising=False)

    def test_load_hermes_dotenv_under_the_lock_restores_what_main_passed(self, tmp_path, monkeypatch, spawn_env):
        from hermes_cli.env_loader import load_hermes_dotenv

        self._clean(monkeypatch)
        home = self._home(tmp_path)
        monkeypatch.setenv("ICLONE_POLICY_LOCK", "1")
        monkeypatch.setenv("ICLONE_PERM_SOCKET", "/run/real.sock")
        spawn_env({"ICLONE_POLICY_LOCK": "1", "ICLONE_PERM_SOCKET": "/run/real.sock"})

        load_hermes_dotenv(hermes_home=home, load_external_secrets=False)

        assert os.environ.get("ICLONE_POLICY_LOCK") == "1"
        assert os.environ.get("ICLONE_PERM_SOCKET") == "/run/real.sock"
        assert "ICLONE_EXTRA" not in os.environ
        assert "HERMES_YOLO_MODE" not in os.environ

    def test_each_dotenv_file_load_restores_too(self, tmp_path, monkeypatch, spawn_env):
        """The per-file loader is a hook site of its own (other loaders reuse it, e.g. the managed overlay)."""
        from hermes_cli import env_loader

        self._clean(monkeypatch)
        home = self._home(tmp_path)
        monkeypatch.setenv("ICLONE_POLICY_LOCK", "1")
        spawn_env({"ICLONE_POLICY_LOCK": "1"})

        env_loader._load_dotenv_with_fallback(home / ".env", override=True)

        assert os.environ.get("ICLONE_POLICY_LOCK") == "1"
        assert "ICLONE_PERM_SOCKET" not in os.environ and "ICLONE_EXTRA" not in os.environ
        assert "HERMES_YOLO_MODE" not in os.environ

    def test_without_the_lock_a_dotenv_loads_as_upstream_does(self, tmp_path, monkeypatch, spawn_env):
        from hermes_cli.env_loader import load_hermes_dotenv

        self._clean(monkeypatch)
        home = self._home(tmp_path)
        spawn_env({})

        load_hermes_dotenv(hermes_home=home, load_external_secrets=False)

        assert os.environ.get("ICLONE_EXTRA") == "1"
        assert os.environ.get("HERMES_YOLO_MODE") == "1"

    def test_a_secret_source_writing_after_the_last_dotenv_is_restored_too(self, tmp_path, monkeypatch, spawn_env):
        """r1 critic B15: with no managed overlay, nothing re-reads a dotenv after the external secret sources and
        the terminal bridge, so the final restore is the only one between them and the agent."""
        from hermes_cli import _early_recovery, env_loader, managed_scope

        self._clean(monkeypatch)
        home = tmp_path / "hh"
        home.mkdir()
        monkeypatch.setenv("ICLONE_POLICY_LOCK", "1")
        spawn_env({"ICLONE_POLICY_LOCK": "1"})
        monkeypatch.setattr(managed_scope, "get_managed_dir", lambda: None)
        monkeypatch.setattr(_early_recovery, "_should_skip_external_secret_sources", lambda: False)

        def vault(_home):  # a password-manager item named like the policy switches
            os.environ.update(ICLONE_POLICY_LOCK="0", HERMES_YOLO_MODE="1", ICLONE_EXTRA="1")

        monkeypatch.setattr(env_loader, "_apply_external_secret_sources", vault)
        env_loader.load_hermes_dotenv(hermes_home=home, load_external_secrets=True)

        assert os.environ.get("ICLONE_POLICY_LOCK") == "1"
        assert "HERMES_YOLO_MODE" not in os.environ and "ICLONE_EXTRA" not in os.environ


# ---------------------------------------------------------------------------------------------------------------
# hermes_bootstrap.py — every entry point reads the spawn env and the key pipe before anything else can touch them
# ---------------------------------------------------------------------------------------------------------------
class TestBootstrap:
    def _child(self, tmp_path, code, *, with_lock=True):
        read_fd, write_fd = os.pipe()
        env = {k: v for k, v in os.environ.items() if not k.startswith("ICLONE_")}
        env["HERMES_HOME"] = str(tmp_path / "hh")
        if with_lock:
            env.update(ICLONE_POLICY_LOCK="1", ICLONE_POLICY_KEY_FD=str(read_fd), ICLONE_POLICY_KEY_PPID=str(os.getpid()))
        os.write(write_fd, f"v1 kid-1 {KEY_HEX}\n".encode())
        os.close(write_fd)
        try:
            out = subprocess.run(
                [sys.executable, "-c", "import sys; sys.path.insert(0, %r)\n" % str(ROOT) + code],
                env=env, pass_fds=(read_fd,), capture_output=True, text=True, cwd=str(ROOT), timeout=120,
            )
        finally:
            os.close(read_fd)
        return out

    def test_importing_hermes_bootstrap_reads_the_lock_and_takes_the_key_off_the_pipe(self, tmp_path):
        code = (
            "import os, hermes_bootstrap\n"
            "e = sys.modules.get('hermes_cli.iclone_policy_env')\n"
            "assert e is not None, 'bootstrap never imported the iclone reader'\n"
            "read = e._snapshot is not None\n"
            "fd_gone = 'ICLONE_POLICY_KEY_FD' not in os.environ\n"
            "k = e.take_policy_key()\n"
            "print(read, fd_gone, e.locked(), (k[0], k[1].hex()) if k else None)\n"
        )
        out = self._child(tmp_path, code)
        assert out.returncode == 0, out.stderr[-3000:]
        assert out.stdout.strip().splitlines()[-1] == f"True True True ('kid-1', '{KEY_HEX}')", out.stderr[-3000:]

    def test_without_the_app_bootstrap_reads_nothing_and_is_unlocked(self, tmp_path):
        code = (
            "import os, hermes_bootstrap\n"
            "e = sys.modules['hermes_cli.iclone_policy_env']\n"
            "print(e.locked(), e.take_policy_key())\n"
        )
        out = self._child(tmp_path, code, with_lock=False)
        assert out.returncode == 0, out.stderr[-3000:]
        assert out.stdout.strip().splitlines()[-1] == "False None"


# ---------------------------------------------------------------------------------------------------------------
# model_tools.py — under the lock a pre_tool_call path that errors refuses (moved to _pre_dispatch_guards upstream)
# ---------------------------------------------------------------------------------------------------------------
REFUSED = "BLOCKED by icloneOS permissions: the permission check failed."


def _raise_dispatch(*_a, **_k):
    raise RuntimeError("boom")


class TestModelTools:
    def test_an_erroring_check_refuses_under_the_lock(self, monkeypatch, spawn_env):
        import hermes_cli.plugins as P
        import model_tools as MT

        monkeypatch.setattr(P, "_dispatch_pre_tool_call_hooks", _raise_dispatch)
        spawn_env({"ICLONE_POLICY_LOCK": "1"})
        args, blocked = MT._pre_dispatch_guards("read_file", {"path": "x"}, False, MT._CallIds(), [])
        assert blocked is not None
        assert blocked[1] == "plugin_block" and blocked[2] == REFUSED

    def test_without_the_lock_an_erroring_check_stays_open_as_upstream(self, monkeypatch, spawn_env):
        import hermes_cli.plugins as P
        import model_tools as MT

        monkeypatch.setattr(P, "_dispatch_pre_tool_call_hooks", _raise_dispatch)
        spawn_env({})
        args, blocked = MT._pre_dispatch_guards("read_file", {"path": "x"}, False, MT._CallIds(), [])
        assert blocked is None and args == {"path": "x"}


# ---------------------------------------------------------------------------------------------------------------
# agent/tool_executor.py — the agent loop's pre_tool_call path (upstream: _pre_tool_block) refuses on error when locked
# ---------------------------------------------------------------------------------------------------------------
class TestToolExecutor:
    def _ref(self):
        from agent.tool_executor import _ToolCallRef

        return _ToolCallRef(name="read_file", args={"path": "x"}, task_id="t", call_id="c1", trace=[])

    def _agent(self):
        from types import SimpleNamespace

        return SimpleNamespace(session_id="s1", _current_turn_id="", _current_api_request_id="")

    def test_an_erroring_check_refuses_under_the_lock(self, monkeypatch, spawn_env):
        import hermes_cli.plugins as P
        from agent import tool_executor as TE

        monkeypatch.setattr(P, "_dispatch_pre_tool_call_hooks", _raise_dispatch)
        spawn_env({"ICLONE_POLICY_LOCK": "1"})
        block, args = TE._pre_tool_block(self._agent(), self._ref())
        assert block == REFUSED and args == {"path": "x"}

    def test_an_unreadable_lock_counts_as_locked(self, monkeypatch):
        import hermes_cli.iclone_policy_env as env
        from agent import tool_executor as TE

        def _broken():
            raise OSError("no exec env")

        monkeypatch.setattr(env, "locked", _broken)
        assert TE._pre_tool_hook_failure_message() == REFUSED

    def test_without_the_lock_an_erroring_check_stays_open_as_upstream(self, monkeypatch, spawn_env):
        import hermes_cli.plugins as P
        from agent import tool_executor as TE

        monkeypatch.setattr(P, "_dispatch_pre_tool_call_hooks", _raise_dispatch)
        spawn_env({})
        block, args = TE._pre_tool_block(self._agent(), self._ref())
        assert block is None and args == {"path": "x"}


# ---------------------------------------------------------------------------------------------------------------
# tools/approval.py (+ tools/approval_context.py) — the lock disables yolo and pins approvals.mode
# ---------------------------------------------------------------------------------------------------------------
class TestApproval:
    def _lock(self, monkeypatch, *, active=False):
        import tools.approval as A

        monkeypatch.setattr(A, "_ICLONE_POLICY_LOCK", True)
        monkeypatch.setattr(A, "_ICLONE_PERMISSIONS_ACTIVE", active)
        return A

    def test_under_the_lock_session_yolo_is_off_and_the_mode_is_manual_until_the_gate_registers(self, monkeypatch):
        from tools import approval_context as C

        A = self._lock(monkeypatch)
        A.enable_session_yolo("sess-up")
        try:
            assert A.is_session_yolo_enabled("sess-up") is False
            assert C._get_approval_mode() == "manual"
            assert A.is_approval_bypass_active_for_session("sess-up") is False
            A.mark_iclone_permissions_active()
            assert C._get_approval_mode() == "off"
            assert A.detect_hardline_command("rm -rf ~")[0] is True  # the floor still fires first
        finally:
            A.disable_session_yolo("sess-up")

    def test_the_pin_beats_config_and_a_hosted_room_policy(self, monkeypatch):
        from types import SimpleNamespace

        import gateway.hosted_room_execution_policy as R
        from tools import approval_context as C

        monkeypatch.setattr(C, "_get_approval_config", lambda: {"mode": "smart"})
        monkeypatch.setattr(R, "current_room_execution_policy", lambda: SimpleNamespace(approval_mode="off"))
        self._lock(monkeypatch)
        assert C._get_approval_mode() == "manual"

    def test_an_unreadable_pin_and_an_unreadable_lock_still_pin_manual(self, monkeypatch):
        """r1 critic C10: tools.approval cannot answer AND the spawn-env lock cannot be read: Hermes keeps its own
        manual gate; it never falls through to config.yaml's mode (here ``off``)."""
        import hermes_cli.iclone_policy_env as PE
        import tools.approval as A
        from tools import approval_context as C

        def broken(*_a, **_k):
            raise RuntimeError("unreadable")

        monkeypatch.setattr(C, "_get_approval_config", lambda: {"mode": "off"})
        monkeypatch.setattr(A, "iclone_pinned_approval_mode", broken)
        monkeypatch.setattr(PE, "locked", broken)
        assert C._iclone_pinned_mode() == "manual"
        assert C._get_approval_mode() == "manual"
        monkeypatch.setattr(PE, "locked", lambda: False)
        assert C._iclone_pinned_mode() is None  # readable and unlocked: upstream resolution
        assert C._get_approval_mode() == "off"

    def test_without_the_lock_upstream_resolution_is_unchanged(self, monkeypatch):
        import tools.approval as A
        from tools import approval_context as C

        monkeypatch.setattr(A, "_ICLONE_POLICY_LOCK", False)
        monkeypatch.setattr(C, "_get_approval_config", lambda: {"mode": "smart"})
        assert C._get_approval_mode() == "smart"
        A.enable_session_yolo("sess-up2")
        try:
            assert A.is_session_yolo_enabled("sess-up2") is True
        finally:
            A.disable_session_yolo("sess-up2")

    def test_the_lock_is_frozen_at_import_from_the_spawn_env_and_kills_process_yolo(self, tmp_path):
        env = {k: v for k, v in os.environ.items() if not k.startswith("ICLONE_")}
        env.update(ICLONE_POLICY_LOCK="1", HERMES_YOLO_MODE="1", HERMES_HOME=str(tmp_path / "hh"))
        code = (
            "import sys; sys.path.insert(0, %r)\n"
            "import os, tools.approval as A\n"
            "os.environ['ICLONE_POLICY_LOCK'] = '0'\n"  # a later write changes nothing: frozen at import
            "print(A.iclone_policy_locked(), A._YOLO_MODE_FROZEN, A.iclone_pinned_approval_mode())\n" % str(ROOT)
        )
        out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, cwd=str(ROOT), timeout=120)
        assert out.stdout.strip().splitlines()[-1] == "True False manual", out.stderr[-3000:]


# ---------------------------------------------------------------------------------------------------------------
# hermes_cli/plugins.py (+ plugins_dispatch.py, plugins_discovery.py) — the pre_tool_call policy path under the lock
# ---------------------------------------------------------------------------------------------------------------
def _gate(seen, verdict=None):
    def gate(**kw):
        seen.append(("call", kw.get("hook_invocation_id")))
        return verdict

    gate.__iclone_permissions_gate__ = True
    gate.__hermes_fail_closed__ = lambda reason, payload: seen.append((reason, payload.get("tool_name")))
    return gate


class TestPlugins:
    @pytest.fixture
    def manager(self, monkeypatch):
        import hermes_cli.plugins as P

        manager = P.PluginManager()
        monkeypatch.setattr(P, "_delivery_manager", lambda: manager)
        return manager

    def test_under_the_lock_no_gate_registered_refuses_every_tool(self, manager, spawn_env):
        import hermes_cli.plugins as P

        spawn_env({"ICLONE_POLICY_LOCK": "1"})
        assert P.resolve_pre_tool_block("read_file", {"path": "x"}) == P._ICLONE_GATE_MISSING_MESSAGE
        spawn_env({})
        assert P.resolve_pre_tool_block("read_file", {"path": "x"}) is None  # plain Hermes is untouched

    def test_under_the_lock_a_foreign_pre_tool_call_plugin_is_not_the_gate(self, manager, spawn_env):
        """r1 critic C7: a pre_tool_call hook WITHOUT the icloneOS gate mark (any other plugin) must not stand in
        for the gate: every tool is still refused until the real gate registers."""
        import hermes_cli.plugins as P

        spawn_env({"ICLONE_POLICY_LOCK": "1"})
        seen = []
        manager._hooks["pre_tool_call"] = [lambda **kw: seen.append(kw.get("tool_name"))]
        assert P._iclone_gates() == []
        assert P.resolve_pre_tool_block("read_file", {"path": "x"}) == P._ICLONE_GATE_MISSING_MESSAGE

    def test_hermes_level_blocks_reach_the_gate_observer(self, manager, monkeypatch, spawn_env):
        import time as _time

        import hermes_cli.plugins as P

        seen = []

        def slow(**kw):
            _time.sleep(0.5)

        slow.__hermes_fail_closed__ = lambda reason, payload: seen.append(reason)

        def broken(**kw):
            raise ValueError("x")

        broken.__hermes_fail_closed__ = lambda reason, payload: seen.append(reason)
        monkeypatch.setattr(P, "_resolve_hook_callback_timeout", lambda: 0.2)
        manager._hooks["pre_tool_call"] = [slow]
        first = manager.invoke_hook("pre_tool_call", tool_name="t", args={}, tool_call_id="c1")
        second = manager.invoke_hook("pre_tool_call", tool_name="t", args={}, tool_call_id="c1")
        manager._hooks["pre_tool_call"] = [broken]
        third = manager.invoke_hook("pre_tool_call", tool_name="t", args={})
        assert [r[0]["action"] for r in (first, second, third)] == ["block"] * 3
        assert seen == ["timed out after 0.2s", "still running after an earlier timeout", "raised ValueError"]

    def test_the_async_path_reports_the_same_blocks(self, manager, monkeypatch):
        import asyncio

        import hermes_cli.plugins as P

        seen = []

        def broken(**kw):
            seen.append(("call", kw.get("hook_invocation_id")))
            raise ValueError("x")

        broken.__hermes_fail_closed__ = lambda reason, payload: seen.append((reason, payload.get("hook_invocation_id")))

        async def hung(**kw):
            await asyncio.sleep(1)

        hung.__hermes_fail_closed__ = lambda reason, payload: seen.append((reason, None))
        monkeypatch.setattr(P, "_resolve_hook_callback_timeout", lambda: 0.1)
        manager._hooks["pre_tool_call"] = [broken, hung]
        out = asyncio.run(manager.ainvoke_hook("pre_tool_call", tool_name="t", args={}))
        assert [r["action"] for r in out] == ["block", "block"]
        assert seen[0][1] and seen[1] == ("raised ValueError", seen[0][1]) and seen[2] == ("timed out after 0.1s", None)

    def test_each_invocation_carries_its_own_id(self, manager):
        seen = []
        manager._hooks["pre_tool_call"] = [_gate(seen)]
        manager.invoke_hook("pre_tool_call", tool_name="t", args={})
        manager.invoke_hook("pre_tool_call", tool_name="t", args={})
        ids = [i for kind, i in seen if kind == "call"]
        assert len(ids) == 2 and all(ids) and ids[0] != ids[1]

    def test_concurrent_calls_without_ids_each_get_a_decision(self, manager, monkeypatch):
        import threading as _threading
        import time as _time

        import hermes_cli.plugins as P

        def gate(**kw):
            _time.sleep(0.2)

        monkeypatch.setattr(P, "_resolve_hook_callback_timeout", lambda: 5.0)
        manager._hooks["pre_tool_call"] = [gate]
        out = []
        workers = [_threading.Thread(target=lambda: out.append(manager.invoke_hook("pre_tool_call", tool_name="t",
                                                                                    args={}))) for _ in range(6)]
        [w.start() for w in workers]
        [w.join(10) for w in workers]
        assert out == [[]] * 6

    def test_sub_agent_whitelist_and_rewritten_args_are_refused_and_reported(self, manager, spawn_env):
        import hermes_cli.plugins as P

        seen = []
        spawn_env({"ICLONE_POLICY_LOCK": "1"})
        manager._hooks["pre_tool_call"] = [_gate(seen), lambda **kw: {"action": "modify", "args": {"path": "/etc/hosts"}}]
        block, args = P._dispatch_pre_tool_call_hooks("read_file", {"path": "/tmp/x"})
        assert block == P._ICLONE_ARGS_REWRITTEN_MESSAGE and args is None
        P.set_thread_tool_whitelist({"terminal"})
        try:
            assert "denied" in (P.resolve_pre_tool_block("read_file", {}) or "")
        finally:
            P.clear_thread_tool_whitelist()
        reasons = [kind for kind, _ in seen if kind != "call"]
        assert reasons == ["a plugin rewrote the arguments after the permission check",
                           "the tool is not in this sub-agent's toolset"]

    def test_a_dispatch_error_under_the_lock_is_a_refusal(self, manager, monkeypatch, spawn_env):
        import hermes_cli.plugins as P

        def boom(*a, **k):
            raise RuntimeError("boom")

        manager._hooks["pre_tool_call"] = [_gate([])]
        monkeypatch.setattr(P, "_get_pre_tool_call_directive_details", boom)
        spawn_env({"ICLONE_POLICY_LOCK": "1"})
        block, args = P._dispatch_pre_tool_call_hooks("read_file", {"path": "x"})
        assert block and block.startswith("BLOCKED by icloneOS permissions") and args is None
        spawn_env({})
        with pytest.raises(RuntimeError):  # upstream behaviour without the lock: the caller decides
            P._dispatch_pre_tool_call_hooks("read_file", {"path": "x"})

    def test_discovery_keeps_the_bundled_gate_under_the_lock(self, spawn_env):
        from hermes_cli.plugins_discovery import gate_manifest, resolve_manifest_winners
        from hermes_cli.plugins_manifest import PluginManifest

        bundled = PluginManifest(name="iclone-permissions", source="bundled", kind="backend",
                                 path="/b/iclone-permissions")
        user = PluginManifest(name="iclone-permissions", source="user", kind="backend", path="/u/iclone-permissions")
        disabled = {"iclone-permissions"}
        spawn_env({"ICLONE_POLICY_LOCK": "1"})
        assert resolve_manifest_winners([bundled, user])["iclone-permissions"] is bundled
        assert gate_manifest(bundled, disabled, None).action == "load_now"
        spawn_env({})
        assert resolve_manifest_winners([bundled, user])["iclone-permissions"] is user  # upstream override rule
        assert gate_manifest(bundled, disabled, None).action == "placeholder"


# ---------------------------------------------------------------------------------------------------------------
# tui_gateway (config.set moved to methods_config_set.py upstream) — the gateway refuses policy keys under the lock
# ---------------------------------------------------------------------------------------------------------------
class TestGatewayConfigSet:
    def _set(self, key, value="off"):
        from tui_gateway import server

        return server._methods["config.set"]("r1", {"key": key, "value": value})

    def test_policy_keys_are_refused_under_the_lock(self, monkeypatch):
        import tools.approval as A
        from tui_gateway import server

        monkeypatch.setattr(A, "_ICLONE_POLICY_LOCK", True)
        for key in ("yolo", "approvals.mode", "approval_mode", "command_allowlist", "approvals.timeout"):
            out = self._set(key)
            assert out.get("error", {}).get("code") == 4030, (key, out)
            assert server._iclone_policy_key(key), key
        assert not server._iclone_policy_key("model")

    def test_without_the_lock_config_set_is_upstream(self, monkeypatch):
        import tools.approval as A

        monkeypatch.setattr(A, "_ICLONE_POLICY_LOCK", False)
        assert self._set("approvals.timeout").get("error", {}).get("code") == 4002  # upstream: unknown key

    def test_an_unimportable_lock_refuses_the_policy_keys(self, monkeypatch):
        """r1 critic C5: when tools.approval cannot be imported nobody can say whether icloneOS owns the policy, so
        the policy keys are refused (fail closed) and every other key still works."""
        from tui_gateway import server

        monkeypatch.setitem(sys.modules, "tools.approval", None)  # ``from tools.approval import …`` raises
        for key in ("yolo", "approvals.mode", "approval_mode", "command_allowlist", "approvals.timeout"):
            assert server._iclone_policy_key(key), key
            assert self._set(key).get("error", {}).get("code") == 4030, key
        assert not server._iclone_policy_key("model")


# ---------------------------------------------------------------------------------------------------------------
# agent/agent_runtime_helpers.py — the pin's concurrent-path pre_tool_call (invoke_tool) refuses on error when locked
# ---------------------------------------------------------------------------------------------------------------
class TestAgentRuntimeHelpers:
    def _agent(self):
        from types import SimpleNamespace

        return SimpleNamespace(session_id="s1", _current_turn_id="", _current_api_request_id="")

    def test_an_erroring_check_refuses_under_the_lock(self, monkeypatch, spawn_env):
        import hermes_cli.plugins as P
        from agent import agent_runtime_helpers as H

        monkeypatch.setattr(P, "_dispatch_pre_tool_call_hooks", _raise_dispatch)
        spawn_env({"ICLONE_POLICY_LOCK": "1"})
        block, args = H._pre_tool_block_message(self._agent(), "read_file", {"path": "x"}, "t", "c1", [])
        assert block == REFUSED and args == {"path": "x"}

    def test_without_the_lock_an_erroring_check_stays_open_as_upstream(self, monkeypatch, spawn_env):
        import hermes_cli.plugins as P
        from agent import agent_runtime_helpers as H

        monkeypatch.setattr(P, "_dispatch_pre_tool_call_hooks", _raise_dispatch)
        spawn_env({})
        block, args = H._pre_tool_block_message(self._agent(), "read_file", {"path": "x"}, "t", "c1", [])
        assert block is None and args == {"path": "x"}


# ---------------------------------------------------------------------------------------------------------------
# plugins/iclone-* — every runtime symbol the plugins import resolves at the pin (two had moved upstream)
# ---------------------------------------------------------------------------------------------------------------
class TestPluginImportsAtThePin:
    def test_the_permission_gate_anchors_on_the_sessions_workspace_not_the_process_cwd(self, monkeypatch, tmp_path):
        import tools.file_tools_paths as FP
        from tests.plugins.test_iclone_permissions import _load

        monkeypatch.setattr(FP, "_authoritative_workspace_root", lambda task_id="default": str(tmp_path / "proj"))
        mod = _load()
        assert mod._cwd_for("t1") == str(tmp_path / "proj") != os.getcwd()

    def test_the_seatbelt_backend_imports_the_stdin_writer(self):
        import importlib.util
        import types as _types

        import tools.environments.base_output as BO

        plugin_dir = ROOT / "plugins" / "iclone-confinement"
        if "hermes_plugins" not in sys.modules:
            ns = _types.ModuleType("hermes_plugins")
            ns.__path__ = []
            sys.modules["hermes_plugins"] = ns
        for name in [n for n in sys.modules if n.startswith("hermes_plugins.iclone_confinement")]:
            del sys.modules[name]
        spec = importlib.util.spec_from_file_location(
            "hermes_plugins.iclone_confinement", plugin_dir / "__init__.py", submodule_search_locations=[str(plugin_dir)])
        pkg = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = pkg
        spec.loader.exec_module(pkg)
        seatbelt = importlib.import_module("hermes_plugins.iclone_confinement.seatbelt")
        assert seatbelt._pipe_stdin is BO._pipe_stdin


# ---------------------------------------------------------------------------------------------------------------
# tools/file_operations.py — the pin's in-process file lane never serves a confining environment (V3-UP r2, M3)
# ---------------------------------------------------------------------------------------------------------------
class TestNativeFileLane:
    @staticmethod
    def _ops(env):
        from tools.file_operations import ShellFileOperations

        ops = ShellFileOperations.__new__(ShellFileOperations)
        ops.env = env
        return ops

    @staticmethod
    def _bare(cls):
        return cls.__new__(cls)  # no shell spawned: only the predicate is under test

    def test_the_plain_local_environment_keeps_the_fast_path(self, monkeypatch):
        from tools.environments.local import LocalEnvironment

        monkeypatch.delenv("HERMES_NATIVE_FILE_READ", raising=False)
        if sys.platform == "win32":
            pytest.skip("the native lane is POSIX only")
        assert self._ops(self._bare(LocalEnvironment))._native_read_enabled() is True

    def test_an_undeclared_local_subclass_takes_the_shell_path(self, monkeypatch):
        from tools.environments.local import LocalEnvironment

        class Wrapped(LocalEnvironment):  # e.g. any future confining backend that forgot to opt out
            pass

        monkeypatch.delenv("HERMES_NATIVE_FILE_READ", raising=False)
        assert self._ops(self._bare(Wrapped))._native_read_enabled() is False

    def test_a_subclass_that_declares_host_reads_keeps_the_fast_path(self, monkeypatch):
        from tools.environments.local import LocalEnvironment

        class HostShell(LocalEnvironment):
            host_side_helpers = True  # r3: the one host-lane declaration (tools/environments/host_lane.py)

        monkeypatch.delenv("HERMES_NATIVE_FILE_READ", raising=False)
        if sys.platform == "win32":
            pytest.skip("the native lane is POSIX only")
        assert self._ops(self._bare(HostShell))._native_read_enabled() is True

    def test_the_seatbelt_environment_opts_out_and_every_native_entry_follows(self, monkeypatch):
        import importlib.util
        import types as _types

        plugin_dir = ROOT / "plugins" / "iclone-confinement"
        if "hermes_plugins" not in sys.modules:
            ns = _types.ModuleType("hermes_plugins")
            ns.__path__ = []
            sys.modules["hermes_plugins"] = ns
        for name in [n for n in sys.modules if n.startswith("hermes_plugins.iclone_confinement")]:
            del sys.modules[name]
        spec = importlib.util.spec_from_file_location(
            "hermes_plugins.iclone_confinement", plugin_dir / "__init__.py", submodule_search_locations=[str(plugin_dir)])
        pkg = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = pkg
        spec.loader.exec_module(pkg)
        seatbelt = importlib.import_module("hermes_plugins.iclone_confinement.seatbelt")
        assert seatbelt.SeatbeltEnvironment.__dict__["host_side_helpers"] is False

        monkeypatch.delenv("HERMES_NATIVE_FILE_READ", raising=False)
        env = self._bare(seatbelt.SeatbeltEnvironment)
        env.cwd = "/"
        ops = self._ops(env)
        ops.cwd = "/"
        assert ops._native_read_enabled() is False

        # Every native entry point routes to the backend shell instead: the shell is the only reader.
        from tools.file_operations_common import ExecuteResult

        shell = []
        monkeypatch.setattr(ops, "_exec", lambda cmd, **kw: shell.append(cmd) or ExecuteResult(stdout="not_found"))
        monkeypatch.setattr(ops, "_read_file_native", lambda *a, **k: pytest.fail("in-process read on a confined env"))
        monkeypatch.setattr(ops, "_run_rg_native", lambda *a, **k: pytest.fail("in-process rg on a confined env"))
        assert ops._path_exists_probe("/etc/hosts").stdout == "not_found" and shell
        ops._run_rg_bounded(["rg", "x", "/etc"], 5, 5)
        assert any(c.startswith("rg x /etc") for c in shell)
