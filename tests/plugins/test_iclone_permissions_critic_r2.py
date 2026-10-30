"""V3-F critic r2 — my own probes against HEAD 370500c9dc. Reuses the builder's harness (FakeMain, wired).
Temp HERMES_HOME only (the autouse fixture sets it under tmp_path)."""
# r6 builder: copied verbatim from the r2 critic's file into the branch as a permanent regression. The only edits
# are the expectation drifts listed under "r6 drift" below, each a decision already taken by ticket (never a
# weakening of a floor): grep the file for "r6 drift".

from __future__ import annotations

import hashlib
import hmac
import importlib
import json
import os
import socket
import threading
import time
from pathlib import Path

import pytest

from tests.plugins.test_iclone_permissions import (  # noqa: F401 — fixtures: _isolated, plugin, wired
    FakeMain, INFT, KEY, KID, MODES, _body, _decide_all_modes, _events, _isolated, _load, _locked_manager, _spawn_env,
    _write_policy, plugin, wired,
)


def _all_modes_refuse(plugin_mod, tool, args, cwd, **over):
    out = {}
    for mode, (verdict, call) in _decide_all_modes(plugin_mod, tool, args, cwd, **over).items():
        out[mode] = (verdict.outcome, verdict.rule, call.cls, call.floor)
    return out


# ------------------------------------------------------------------ new bypass attempts (check 2)
class TestNewBypasses:
    def _guards(self, tmp_path):
        ud = tmp_path / "ud"
        hh = tmp_path / ".hermes"
        (ud / "permissions" / "policy").mkdir(parents=True)
        (ud / "permissions" / "audit").mkdir(parents=True)
        hh.mkdir(exist_ok=True)
        protected = [str(ud / "permissions"), str(ud / "consent.json"), str(hh / "config.yaml"), str(hh / ".env"), str(hh / "plugins")]
        return ud, hh, protected

    def test_b1_symlink_in_project_into_a_floor_path_then_write_through_it(self, plugin, tmp_path):
        ud, hh, protected = self._guards(tmp_path)
        proj = tmp_path / "proj"; proj.mkdir(); (proj / ".git").mkdir()
        (proj / "link").symlink_to(ud / "permissions")
        res = _all_modes_refuse(plugin, "write_file", {"path": "link/mode.json"}, str(proj), protectedPaths=protected)
        assert all(v[0] == "refuse" and v[1] == "floor" for v in res.values()), res
        res2 = _all_modes_refuse(plugin, "terminal", {"command": "echo x > link/mode.json"}, str(proj), protectedPaths=protected)
        assert all(v[0] == "refuse" for v in res2.values()), res2

    def test_b2_patch_move_to_header_pointing_outside_and_into_a_floor(self, plugin, tmp_path):
        ud, hh, protected = self._guards(tmp_path)
        proj = tmp_path / "proj"; proj.mkdir(); (proj / ".git").mkdir()
        patch = f"*** Begin Patch\n*** Update File: a.txt\n*** Move to: {hh}/.env\n@@\n-a\n+b\n*** End Patch\n"
        res = _all_modes_refuse(plugin, "patch", {"mode": "patch", "patch": patch}, str(proj), protectedPaths=protected)
        assert all(v[0] == "refuse" for v in res.values()), res
        patch2 = f"*** Begin Patch\n*** Update File: a.txt\n*** Move to: {tmp_path}/outside/b.txt\n@@\n-a\n+b\n*** End Patch\n"
        res2 = _all_modes_refuse(plugin, "patch", {"mode": "patch", "patch": patch2}, str(proj), protectedPaths=protected)
        # outside the project: Wo (never Wp). Accept edits / automatic must ask, plan refuse
        assert res2["acceptEdits"][0] == "ask" and res2["automatic"][0] == "ask" and res2["plan"][0] == "refuse", res2
        assert all(v[2] in ("Wo", "D") for v in res2.values()), res2

    @pytest.mark.parametrize("form", [
        # r6 drift (accepted since r2, m1 design): a write whose TARGET is computed by `$(…)` is the m1 class — dangerous
        # (Automatic asks), R1 in Ignore until V3-G confinement — not the floor. Held in test_b3_expansion_target_is_m1.
        "cp /tmp/x --target-directory={ud}/permissions",
        "cat /tmp/x > {hh}/.env",
        "cat /tmp/x >> {hh}/.e\\nv",
        "tee {ud}/permissions/mode.json < /tmp/x",
        "python3 -c \"open('{hh}/.env','w').write('ICLONE_POLICY_LOCK=0')\"",
    ])
    def test_b3_shell_forms_that_name_a_floor_path(self, plugin, tmp_path, form):
        ud, hh, protected = self._guards(tmp_path)
        cmd = form.format(hh=hh, ud=ud)
        res = _all_modes_refuse(plugin, "terminal", {"command": cmd}, str(tmp_path), protectedPaths=protected)
        assert all(v[0] == "refuse" and v[1] == "floor" for v in res.values()), (cmd, res)

    def test_b3_expansion_target_is_m1(self, plugin, tmp_path):
        ud, hh, protected = self._guards(tmp_path)
        cmd = "cat x > $(echo {hh})/.env".format(hh=hh)
        res = _all_modes_refuse(plugin, "terminal", {"command": cmd}, str(tmp_path), protectedPaths=protected)
        assert res["automatic"][0] in ("ask", "refuse"), res

    def test_b4_process_submit_typed_in_pieces_across_calls_is_judged_whole(self, wired, tmp_path):
        mod, main, _ = wired(_body(standing="ignore"))
        pieces = ["rm ", "-r", "f ", "~"]
        results = [mod.on_pre_tool_call("process", {"action": "write", "session_id": "p1", "data": p}, "t", "s") for p in pieces[:-1]]
        assert all(r is None for r in results), results  # partial, harmless pieces may pass in Ignore
        final = mod.on_pre_tool_call("process", {"action": "submit", "session_id": "p1", "data": pieces[-1]}, "t", "s")
        assert final and final["action"] == "block" and "hardline" in final["message"], final
        mod._state["channel"].flush(3.0)
        assert len(_events(main, "refuse")) == 1

    def test_b5_policy_body_same_gen_different_content_is_not_taken_over_the_announced_gen(self, wired, tmp_path):
        """Main announced gen 100 on every answer. A file at gen 100 with a wider mode verifies (same key) — that is
        the design (gen is a floor, not an exact match). A file at gen 99 must be refused."""
        mod, main, _ = wired(_body(standing="manual", gen=100))
        pol = mod._state["policy"]
        assert pol.body()["standing"] == "manual"
        _write_policy(Path(pol._path), _body(standing="ignore", gen=99))
        os.utime(pol._path, None)
        assert pol.body() is None  # replay below the floor ⇒ Manual
        mod.on_pre_tool_call("terminal", {"command": "ls"}, "t", "s")  # Manual ⇒ X is an ask (fake main allows)
        mod._state["channel"].flush(3.0)
        assert len(main.verbs("ask")) == 1 and main.verbs("ask")[0]["mode"] == "manual"

    def test_b6_forged_socket_answer_with_a_stale_signature_is_not_an_answer(self, wired, tmp_path):
        """A fake main replays a previously valid signed answer (signed for another request MAC)."""
        stale = {}

        def answer(verb, payload):
            return 0, {"state": "decided", "allowed": True, "reason": "allowed"}

        mod, main, _ = wired(_body(standing="manual"), answer=answer)
        ch = mod._state["channel"]
        # capture one legit answer envelope by calling main directly once, then serve it back for everything
        text = json.dumps({"askId": "x", "pid": os.getpid(), "keyId": KID})
        mac = ch.sign("await", text)
        token = Path(ch._token_file).read_text().strip()
        conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); conn.connect(ch._sock_path)
        conn.sendall((json.dumps({"v": 1, "token": token, "inft": None, "argv": ["perm", "await", KID, text, mac]}) + "\n").encode())
        out = b"".join(iter(lambda: conn.recv(65536), b"")); conn.close()
        env = json.loads([l for l in out.decode().splitlines() if l][0])["d"]
        stale["env"] = env
        main.close(); os.unlink(main.path)

        class Replayer(FakeMain):
            def _one(self, conn):
                with conn:
                    conn.makefile("rb").readline()
                    conn.sendall((json.dumps({"t": "o", "d": stale["env"]}) + "\n" + json.dumps({"t": "x", "c": 0}) + "\n").encode())

        rep = Replayer(Path(main.path))
        try:
            ans = ch.await_answer("x", 1.0)
            assert not ans.ok and ans.error == "unsigned"
            r = ch._request("ask", json.dumps({"seq": 999, "pid": os.getpid(), "keyId": KID}), ch.sign("ask", "{}"), 2.0)
            assert not r.ok
        finally:
            rep.close()

    @pytest.mark.parametrize("cmd", [
        "acp wallet send-transaction --dry-run --to 0x1 --amount 1",
        "acp wallet send-transaction --to 0x1 --amount 1 --note --dry-run",
        "acp wallet send-transaction --to 0x1 --amount 1 -- --dry-run",
        "acp client fund j1 --memo=--dry-run",
        "acp wallet send-transaction --to 0x1 --amount 1 --dry-run; acp wallet send-transaction --to 0x1 --amount 1",
    ])
    def test_b7_dry_run_not_last_or_as_an_option_value_still_spends(self, plugin, tmp_path, cmd):
        from hermes_plugins.iclone_permissions.classify import classify
        assert classify("terminal", {"command": cmd}, str(tmp_path), _body()).cls == "$", cmd

    def test_b7b_dry_run_last_is_not_spend(self, plugin, tmp_path):
        from hermes_plugins.iclone_permissions.classify import classify
        assert classify("terminal", {"command": "acp wallet send-transaction --to 0x1 --amount 1 --dry-run"}, str(tmp_path), _body()).cls == "X"

    @pytest.mark.parametrize("cmd", ["it send-key C-m", "it send p1 'rm -rf ~'", "it exec --pane p1 npm install -g x"])
    def test_b8_it_send_key_forms_are_x_dangerous(self, plugin, tmp_path, cmd):
        from hermes_plugins.iclone_permissions.classify import classify
        c = classify("terminal", {"command": cmd}, str(tmp_path), _body())
        # r6 drift (r5 T-M3): a pane proxy is max(X, the class of its payload) — `npm install -g` carried is I, `rm -rf ~`
        # carried is D. Never lower than a dangerous X.
        assert c.cls in ("$", "M", "I", "S", "D") or (c.cls, c.facts.get("dangerous")) == ("X", True), (cmd, c)

    def test_b9_subagent_toolset_denial_is_recorded(self, wired):
        import hermes_cli.plugins as P
        mod, main, _ = wired(_body(standing="ignore"))
        manager = P.PluginManager()
        manager._hooks["pre_tool_call"] = [mod.on_pre_tool_call]
        P._thread_tool_whitelist.allowed = {"read_file"}
        try:
            with _locked_manager(manager):
                msg = P.resolve_pre_tool_block("terminal", {"command": "ls"}, task_id="t", session_id="s")
        finally:
            P._thread_tool_whitelist.allowed = None
        assert msg
        mod._state["channel"].flush(3.0)
        reasons = [p["reason"] for p in _events(main, "refuse")]
        assert any("sub-agent" in r for r in reasons), reasons

    def test_b10_tool_call_before_hello_arrived_is_refused_and_recorded_after(self, wired, tmp_path):
        """Main has received hello but not answered it yet. A call in that window must refuse non-reads; the event
        must still land. V3-UP r3 (UP3-3): the window is held open by an event, not a sleep — main answers hello only
        after both calls were decided, so no load can make the call land after hello (r2: red once per loaded run)."""
        hello_seen, release = threading.Event(), threading.Event()

        def answer(verb, payload):
            if verb == "hello":
                hello_seen.set()
                assert release.wait(30), "the test never released hello"
            return 0, {"attested": True} if verb == "hello" else {}

        mod, main, _ = wired(_body(standing="ignore"), answer=answer, hello=False)
        ch = mod._state["channel"]
        hello = threading.Thread(target=lambda: ch.hello({"plugin": "t"}, wait=30.0), daemon=True)
        hello.start()
        try:
            assert hello_seen.wait(10), "main never received hello"
            assert not ch.healthy
            r = mod.on_pre_tool_call("terminal", {"command": "ls"}, "t", "s")
            assert r and r["action"] == "block" and "not reachable" in r["message"], r
            assert mod.on_pre_tool_call("read_file", {"path": "/tmp/x"}, "t", "s") is None
            assert not ch.healthy, "hello was answered inside the window: the test proves nothing"
        finally:
            release.set()
        hello.join(30)
        assert ch.healthy
        ch.flush(8.0)
        for _ in range(100):  # the events land after the window closes; wait for them, never for a fixed time
            outcomes = [p["outcome"] for p in _events(main)]
            if len(outcomes) >= 2:
                break
            time.sleep(0.05)
        assert outcomes.count("refuse") == 1 and outcomes.count("allow") == 1, outcomes

    @pytest.mark.parametrize("cmd", [
        "kill $(pgrep -f electron)",
        "kill -9 `pgrep -x icloneOS`",
        "kill -TERM 4242",
        "kill -s KILL 4242",
        "launchctl kill SIGKILL gui/501/com.iclone.os",
        "osascript -e 'tell application \"icloneOS\" to quit'",
        "killall -9 Electron",
        "pkill -9 -f hermes_sim",
        "kill -- 4242",
        "kill 4242 4243",
    ])
    def test_b11_kill_forms_against_main_or_hermes(self, plugin, tmp_path, cmd):
        res = _all_modes_refuse(plugin, "terminal", {"command": cmd}, str(tmp_path), guardPids=[4242])
        # record the per-form verdict; assert refuse in every mode
        assert all(v[0] == "refuse" for v in res.values()), (cmd, res)

    def test_b12_dotenv_in_hermes_home_cannot_set_lock_0_for_a_grandchild_env(self, tmp_path, monkeypatch):
        """Also: a child that sets HERMES_YOLO_MODE in os.environ is reverted by restore_environ."""
        from hermes_cli import iclone_policy_env as E
        E._reset_for_tests({"ICLONE_POLICY_LOCK": "1", "ICLONE_POLICY_FILE": "/p"})
        os.environ["ICLONE_POLICY_LOCK"] = "0"
        os.environ["ICLONE_POLICY_FILE"] = "/evil"
        os.environ["ICLONE_PERM_SOCKET"] = "/evil.sock"
        os.environ["HERMES_YOLO_MODE"] = "1"
        E.restore_environ()
        assert os.environ["ICLONE_POLICY_LOCK"] == "1" and os.environ["ICLONE_POLICY_FILE"] == "/p"
        assert "ICLONE_PERM_SOCKET" not in os.environ and "HERMES_YOLO_MODE" not in os.environ
        assert E.locked() and E.exec_env("ICLONE_PERM_SOCKET") is None

    # r7 i1: a verdict, not a return value. `~` and `..` resolve to the secret; the file tool expands only `~`
    # (tools/file_operations.py `_expand_path`), so a `$HOME/…` path names a literal file under the cwd and is a read.
    @pytest.mark.parametrize("args,floored", [
        ({"path": "~/.hermes/.env"}, True),
        ({"path": "$HOME/.ssh/id_rsa"}, False),
        ({"path": "../.ssh/id_rsa"}, True),
    ])
    def test_b13_secret_reads_through_relative_and_expanded_paths(self, plugin, tmp_path, args, floored, monkeypatch):
        home = tmp_path; (home / ".ssh").mkdir(); (home / ".hermes").mkdir(exist_ok=True)
        (home / ".ssh" / "id_rsa").write_text("x"); (home / ".hermes" / ".env").write_text("x")
        monkeypatch.setenv("HOME", str(home))
        secrets = [str(home / ".ssh" / "id_*"), str(home / ".hermes" / ".env")]
        proj = home / "proj"; proj.mkdir()
        res = _all_modes_refuse(plugin, "read_file", args, str(proj), secretPaths=secrets)
        if floored:
            assert all(v[0] == "refuse" and v[1] == "floor" and (v[3] or "").startswith("secrets")
                       for v in res.values()), res
        else:
            assert all(v[2] == "R" and v[3] is None for v in res.values()), res

    def test_b14_write_file_with_project_root_inside_a_guard_is_still_a_floor(self, plugin, tmp_path):
        ud, hh, protected = self._guards(tmp_path)
        proj = ud / "permissions"  # session cwd IS the protected dir
        res = _all_modes_refuse(plugin, "write_file", {"path": "mode.json"}, str(proj), protectedPaths=protected)
        assert all(v[0] == "refuse" and v[1] == "floor" for v in res.values()), res

    @pytest.mark.parametrize("cmd,expect_cls", [
        ("cast send 0x4DFB27E4E6ADE6AFC8A21AB14751EE8B7AC75631 'transferFrom(address,address,uint256)' a b 1", "floor"),
        ("cast send 4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631 'transferFrom(address,address,uint256)' a b 1", "floor"),
        ("cast send 0xabc 'setApprovalForAll(address,bool)' 0x1 true", "floor"),
        ("acp wallet send-transaction --to 0xabc --data 0xa22cb465", "floor"),
        (f"cast send {INFT} 0x23b872dd0000", "floor"),
        (f"cast send {INFT} 'approve(address,uint256)' 0x1 7", "floor"),
        (f"cast send {INFT} 'permit(...)'", "floor"),
        (f"cast call {INFT} 'ownerOf(uint256)' 7", "ok"),
    ])
    def test_b15_floor8_forms(self, plugin, tmp_path, cmd, expect_cls):
        from hermes_plugins.iclone_permissions.classify import classify
        c = classify("terminal", {"command": cmd}, str(tmp_path), _body())
        if expect_cls == "floor":
            assert c.floor and c.floor.startswith("inft"), (cmd, c)
        else:
            assert not c.floor, (cmd, c)

    @pytest.mark.parametrize("tool,args", [
        ("execute_code", {"code": f"import web3; c=w3.eth.contract('{INFT}'); c.functions.safeTransferFrom(a,b,7).transact()"}),
        ("execute_code", {"code": f"send_raw('{INFT}', '0x42842e0e' + '00'*96)"}),
        ("mcp_evm_send", {"to": INFT, "function": "transferFrom", "args": []}),
        ("mcp_evm_send", {"to": INFT, "data": "0xb88d4fde"}),
        ("mcp_evm_sign", {"typedData": {"primaryType": "Permit", "domain": {"verifyingContract": INFT}}}),
        ("mcp_evm_send", {"to": "0xdead", "data": "0xa22cb465"}),
        ("browser_type", {"text": f"setApprovalForAll {INFT}"}),
    ])
    def test_b16_floor8_through_code_and_non_read_tool_args_in_all_modes(self, plugin, tmp_path, tool, args):
        res = _all_modes_refuse(plugin, tool, args, str(tmp_path))
        assert all(v[0] == "refuse" and v[1] == "floor" for v in res.values()), (tool, res)

    def test_b17_read_tool_arg_mentioning_the_contract_is_not_a_floor(self, plugin, tmp_path):
        res = _all_modes_refuse(plugin, "read_file", {"path": f"/tmp/{INFT}-transferFrom.txt"}, str(tmp_path))
        assert all(v[0] == "allow" for v in res.values()), res


# ------------------------------------------------------------------ new fault sites (check 3)
class TestNewFaults:
    def test_f1_wal_append_raising_is_a_refusal_with_a_record(self, wired, monkeypatch):
        mod, main, _ = wired(_body(standing="ignore"))
        ch = mod._state["channel"]
        monkeypatch.setattr(ch, "_wal_append", lambda item: (_ for _ in ()).throw(MemoryError()))
        r = mod.on_pre_tool_call("terminal", {"command": "ls"}, "t", "s")
        assert r and r["action"] == "block", r

    def test_f2_signer_raising_is_a_refusal(self, wired, monkeypatch):
        mod, main, _ = wired(_body(standing="ignore"))
        ch = mod._state["channel"]
        monkeypatch.setattr(ch, "sign", lambda verb, text: (_ for _ in ()).throw(RuntimeError("hmac down")))
        r = mod.on_pre_tool_call("write_file", {"path": "/tmp/x"}, "t", "s")
        assert r and r["action"] == "block", r

    def test_f3_socket_closing_mid_answer_never_allows(self, wired):
        class Cutter(FakeMain):
            def _one(self, conn):
                with conn:
                    conn.makefile("rb").readline()
                    conn.sendall(b'{"t":"o","d":"{\\"r\\":\\"{\\\\\\"code\\\\\\":0,\\\\\\"state\\\\\\":\\\\\\"decided\\\\\\",\\\\\\"allowed\\\\\\":true}')
                    # no sig, no terminator: close
        mod, main, _ = wired(_body(standing="manual"), hello=False)
        main.close(); os.unlink(main.path)
        cut = Cutter(Path(main.path))
        try:
            mod._state["channel"]._healthy = True
            r = mod.on_pre_tool_call("terminal", {"command": "ls"}, "t", "s")
            assert r and r["action"] == "block", r
        finally:
            cut.close()

    def test_f4_getppid_change_does_not_hand_the_key_twice(self, monkeypatch):
        from hermes_cli import iclone_policy_env as E
        E._reset_for_tests({"ICLONE_POLICY_LOCK": "1"}, (KID, KEY))
        assert E.take_policy_key() == (KID, KEY)
        monkeypatch.setattr(os, "getppid", lambda: 1)
        assert E.take_policy_key() is None

    def test_f5_policy_body_raising_is_a_refusal(self, wired, monkeypatch):
        mod, main, _ = wired(_body(standing="ignore"))
        monkeypatch.setattr(mod._state["policy"], "body", lambda: (_ for _ in ()).throw(OSError("efault")))
        r = mod.on_pre_tool_call("terminal", {"command": "ls"}, "t", "s")
        assert r and r["action"] == "block", r
        mod._state["channel"].flush(3.0)
        assert [p["reason"] for p in _events(main, "refuse")] and "internal error" in _events(main, "refuse")[0]["reason"]


# ------------------------------------------------------------------ attestation (check 8)
class TestAttestation:
    def test_never_hello_every_non_read_refused_reads_allowed(self, wired):
        mod, main, _ = wired(_body(standing="ignore"), answer=lambda v, p: (1, {"attested": False, "reason": "no"}), hello=False)
        for tool, args in (("terminal", {"command": "ls"}), ("write_file", {"path": "/tmp/x"}), ("web_search", {"query": "x"}),
                           ("send_message", {"target": "x"}), ("mcp_x", {})):
            r = mod.on_pre_tool_call(tool, args, "t", "s")
            assert r and r["action"] == "block", (tool, r)
        assert mod.on_pre_tool_call("read_file", {"path": "/tmp/x"}, "t", "s") is None
