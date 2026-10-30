"""claude-code plugin tests — stdlib unittest, fakes only (the real CLI is never spawned)."""

import importlib.util
import json
import os
import stat
import sys
import tempfile
import time
import types
import unittest
import uuid
from pathlib import Path
from unittest import mock

PLUGIN = Path(__file__).resolve().parents[1]
APP = PLUGIN.parents[2]
if str(APP) not in sys.path:
    sys.path.insert(0, str(APP))


def _load_plugin():
    name = "_hermes_user_provider_claude_code"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, PLUGIN / "__init__.py", submodule_search_locations=[str(PLUGIN)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


plugin = _load_plugin()
cc = sys.modules["_hermes_user_provider_claude_code.client"]
compat = sys.modules["_hermes_user_provider_claude_code.compat"]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.log = self.tmp / "log.jsonl"
        self.binary = self.tmp / "claude"
        # A sh wrapper: a shebang cannot carry the spaces in this repo's path.
        script = PLUGIN / "tests" / "fake_claude.py"
        self.binary.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n')
        self.binary.chmod(0o755)
        self.env = mock.patch.dict(os.environ, {"FAKE_CLAUDE_LOG": str(self.log), "ANTHROPIC_API_KEY": "sk-fake-never-used"})
        self.env.start()
        # Discovery must never find the machine's real CLI from a test.
        self.disc = mock.patch.object(cc, "discover_binary", return_value=None)
        self.disc.start()
        cc._auth_cache.clear()
        self.fallbacks = []

    def tearDown(self):
        cc.shutdown_all()
        self.disc.stop()
        self.env.stop()

    def mode(self, value):
        os.environ["FAKE_CLAUDE_MODE"] = value

    def client(self, key="sess-1", command=None):
        def fallback(base, reason, kwargs):
            self.fallbacks.append(reason)
            return "NOUS"

        return cc.ClaudeCodeClient(
            session_key=key, command=str(command or self.binary), plugin_base=self.tmp, fallback=fallback
        )

    def entries(self, kind):
        if not self.log.exists():
            return []
        return [e for e in map(json.loads, self.log.read_text().splitlines()) if e["kind"] == kind]

    def ask(self, client, messages, **kw):
        return client.chat.completions.create(model="claude-haiku-5-5", messages=messages, **kw)


SYS = {"role": "system", "content": "You are #6."}


class Parsing(unittest.TestCase):
    def test_auth_status_three_shapes(self):
        ok = cc.parse_auth_status(json.dumps({"loggedIn": True, "authMethod": "claude.ai", "subscriptionType": "max", "email": "e"}))
        self.assertEqual(ok, {"loggedIn": True, "authMethod": "claude.ai", "subscriptionType": "max"})
        out = cc.parse_auth_status(json.dumps({"loggedIn": False, "authMethod": "none"}))
        self.assertFalse(out["loggedIn"])
        err = cc.parse_auth_status(json.dumps({"type": "result", "is_error": True, "result": "Not logged in"}))
        self.assertEqual(err["authMethod"], "none")
        self.assertFalse(cc.parse_auth_status("garbage")["loggedIn"])

    def test_classify_results(self):
        self.assertIsNone(cc.classify_result({"is_error": False, "result": "OK"}))
        self.assertEqual(cc.classify_result({"is_error": True, "result": "Not logged in · Please run /login"}), "not_logged_in")
        self.assertEqual(cc.classify_result({"is_error": True, "result": "usage limit reached · resets at 1am"}), "auth_usage")
        self.assertEqual(cc.classify_result({"is_error": True, "subtype": "error_max_budget_usd", "result": ""}), "budget")

    def test_lean_argv_and_identical_resume(self):
        first = cc.build_argv("/x/claude", model="m", prompt_file="/p", session_id="s", resume=False)
        again = cc.build_argv("/x/claude", model="m", prompt_file="/p", session_id="s", resume=True)
        for flag in ("--restricted", "--strict-mcp-config", "--setting-sources", "--max-budget-usd", "--system-prompt-file"):
            self.assertIn(flag, first)
        self.assertEqual(first[first.index("--tools") + 1], "")
        self.assertEqual(first[first.index("--permission-mode") + 1], "dontAsk")
        self.assertNotIn("--bare", first)
        self.assertEqual(first[:-2], again[:-2])
        self.assertEqual(again[-2:], ["--resume", "s"])

    def test_transcript_matches_copilot_strategy(self):
        from agent.copilot_acp_client import _format_messages_as_prompt

        msgs = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}, {"role": "user", "content": "go"}]
        ours = cc.format_transcript(msgs)
        theirs = _format_messages_as_prompt(msgs)
        self.assertIn(ours, theirs)

    def test_rate_limit_window(self):
        window = cc.window_from_rate_limit({"rate_limit_info": {"status": "allowed_warning", "unifiedWindows": {
            "five_hour": {"utilization": 0.9, "resetsAt": 10}}}})
        self.assertEqual(window["status"], "allowed_warning")
        self.assertEqual(window["fiveHour"], {"utilization": 0.9, "resetsAt": 10})
        self.assertIsNone(window["sevenDay"])


class Turns(Base):
    def test_ok_turn_status_and_no_api_key_in_child(self):
        self.mode("ok")
        out = self.ask(self.client(), [SYS, {"role": "user", "content": "Reply with the single word OK"}])
        self.assertEqual(out.choices[0].message.content, "OK")
        self.assertEqual(out.choices[0].finish_reason, "stop")
        spawn = self.entries("spawn")[0]
        self.assertFalse(spawn["env_api_key"])
        self.assertFalse(spawn["env_auth_token"])
        status = json.loads((self.tmp / "status.json").read_text())
        self.assertEqual(status["window"]["fiveHour"]["utilization"], 0.63)
        self.assertNotIn("OK", json.dumps(status))

    def test_tool_call_round_trip_reuses_process(self):
        self.mode("ok")
        client = self.client()
        tools = [{"type": "function", "function": {"name": "memory", "description": "m", "parameters": {"type": "object"}}}]
        msgs = [SYS, {"role": "user", "content": "USE_TOOL please"}]
        first = self.ask(client, msgs, tools=tools)
        self.assertEqual(first.choices[0].finish_reason, "tool_calls")
        call = first.choices[0].message.tool_calls[0]
        self.assertEqual(call.function.name, "memory")
        msgs += [
            {"role": "assistant", "content": "", "tool_calls": [{"id": call.id, "type": "function",
                                                                  "function": {"name": "memory", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": call.id, "content": "remembered 42"},
        ]
        second = self.ask(client, msgs, tools=tools)
        self.assertEqual(second.choices[0].message.content, "OK")
        self.assertEqual(len(self.entries("spawn")), 1)
        turns = self.entries("turn")
        self.assertIn(f"Tool result ({call.id}):\nremembered 42", turns[1]["content"])
        self.assertNotIn("USE_TOOL", turns[1]["content"])

    def test_prompt_file_0600_and_deleted(self):
        self.mode("ok")
        self.ask(self.client(), [SYS, {"role": "user", "content": "hi"}])
        self.assertEqual(self.entries("spawn")[0]["prompt_mode"], 0o600)
        self.assertEqual(list((self.tmp / "work" / ".prompts").iterdir()), [])

    def test_idle_kill_then_resume_with_identical_argv(self):
        self.mode("ok")
        client = self.client()
        msgs = [SYS, {"role": "user", "content": "one"}]
        self.ask(client, msgs)
        self.assertEqual(cc.reap_idle(now=time.monotonic() + 10_000, idle_seconds=600), 1)
        msgs += [{"role": "assistant", "content": "OK"}, {"role": "user", "content": "two"}]
        self.ask(client, msgs)
        spawns = self.entries("spawn")
        self.assertEqual(len(spawns), 2)
        self.assertEqual(spawns[0]["argv"][:-2], spawns[1]["argv"][:-2])
        self.assertEqual(spawns[1]["argv"][-2], "--resume")
        self.assertEqual(spawns[0]["argv"][-1], spawns[1]["argv"][-1])
        self.assertEqual(self.entries("turn")[1]["content"], "two")

    def test_divergent_history_starts_new_generation(self):
        self.mode("ok")
        client = self.client()
        self.ask(client, [SYS, {"role": "user", "content": "one"}])
        self.ask(client, [SYS, {"role": "user", "content": "edited"}])
        spawns = self.entries("spawn")
        self.assertEqual(len(spawns), 2)
        self.assertNotEqual(spawns[0]["argv"][-1], spawns[1]["argv"][-1])
        self.assertIn("--session-id", spawns[1]["argv"])

    def test_malformed_stream_line_is_skipped(self):
        self.mode("malformed")
        out = self.ask(self.client(), [SYS, {"role": "user", "content": "hi"}])
        self.assertEqual(out.choices[0].message.content, "OK")


class Fallback(Base):
    def test_not_logged_in_falls_back_without_a_turn(self):
        self.mode("notlogged")
        self.assertEqual(self.ask(self.client(), [SYS, {"role": "user", "content": "hi"}]), "NOUS")
        self.assertEqual(self.fallbacks, ["not_logged_in"])
        self.assertEqual(self.entries("spawn"), [])
        status = json.loads((self.tmp / "status.json").read_text())
        self.assertEqual(status["lastFallback"]["reason"], "not_logged_in")

    def test_not_logged_in_during_turn(self):
        self.mode("notlogged_turn")
        self.assertEqual(self.ask(self.client(), [SYS, {"role": "user", "content": "hi"}]), "NOUS")
        self.assertEqual(self.fallbacks, ["not_logged_in"])

    def test_binary_missing(self):
        self.assertEqual(self.ask(self.client(command=self.tmp / "nope"), [{"role": "user", "content": "hi"}]), "NOUS")
        self.assertEqual(self.fallbacks, ["binary_missing"])

    def test_rejected_window(self):
        self.mode("rejected")
        self.assertEqual(self.ask(self.client(), [SYS, {"role": "user", "content": "hi"}]), "NOUS")
        self.assertEqual(self.fallbacks, ["window_rejected"])
        status = json.loads((self.tmp / "status.json").read_text())
        self.assertEqual(status["window"]["status"], "rejected")

    def test_success_after_rejected_window_keeps_the_answer(self):
        self.mode("rejected_ok")
        self.assertEqual(self.ask(self.client(), [SYS, {"role": "user", "content": "hi"}]).choices[0].message.content, "OK")
        self.assertEqual(self.fallbacks, [])

    def test_exit_mid_turn(self):
        self.mode("exit_mid")
        self.assertEqual(self.ask(self.client(), [SYS, {"role": "user", "content": "hi"}]), "NOUS")
        self.assertEqual(self.fallbacks, ["process_exit"])

    def test_fallback_runs_once_and_errors_propagate(self):
        self.mode("notlogged")
        calls = []

        def failing(base, reason, kwargs):
            calls.append(reason)
            raise RuntimeError("nous down")

        client = cc.ClaudeCodeClient(session_key="s", command=str(self.binary), plugin_base=self.tmp, fallback=failing)
        with self.assertRaises(RuntimeError):
            self.ask(client, [{"role": "user", "content": "hi"}])
        self.assertEqual(calls, ["not_logged_in"])

    def test_aux_calls_never_spawn(self):
        self.mode("ok")
        client = self.client(key=None)
        self.assertEqual(self.ask(client, [{"role": "user", "content": "title this"}]), "NOUS")
        self.assertEqual(self.fallbacks, ["no_session"])
        self.assertIn("no_session", cc.FALLBACK_REASONS)
        self.assertEqual(json.loads((self.tmp / "status.json").read_text())["lastFallback"]["reason"], "no_session")
        self.assertEqual(self.entries("spawn") + self.entries("auth"), [])

    def test_profile_hook_route_is_auxiliary_silent_and_never_spawns(self):
        from providers import get_provider_profile

        self.mode("ok")
        client = get_provider_profile("claude-code-cli").create_client(
            api_key="claude-code-cli", base_url=cc.BASE_URL, command=str(self.binary), args=[]
        )
        client._base = self.tmp
        client._fallback = lambda base, reason, kwargs: self.fallbacks.append(reason) or "NOUS"
        self.assertEqual(self.ask(client, [{"role": "user", "content": "summarise"}]), "NOUS")
        self.assertEqual(self.fallbacks, ["aux"])
        self.assertFalse((self.tmp / "status.json").exists())  # no "unavailable" banner for a pinned task
        self.assertEqual(self.entries("spawn") + self.entries("auth"), [])

    def test_hook_build_main_route_is_bound_to_the_agent(self):
        self.mode("ok")
        fake = types.SimpleNamespace(_provider_supplied_client=lambda agent, kw: "PROFILE")
        compat._patch_supplied(fake)
        self.assertEqual(fake._provider_supplied_client(types.SimpleNamespace(provider="nous"), {"base_url": "https://x"}), "PROFILE")
        agent = types.SimpleNamespace(provider="claude-code-cli")
        client = fake._provider_supplied_client(agent, {"base_url": cc.BASE_URL, "api_key": "claude-code-cli", "command": str(self.binary)})
        client._base = self.tmp
        client._fallback = lambda *a: self.fallbacks.append(a[1]) or "NOUS"
        agent.session_id = "20261017_hook"
        self.assertEqual(self.ask(client, [SYS, {"role": "user", "content": "Reply with OK"}]).choices[0].message.content, "OK")
        self.assertEqual((self.fallbacks, len(self.entries("spawn"))), ([], 1))

    def test_client_built_before_session_id_answers_the_main_turn(self):
        # Hermes's real order: agent_init builds the client, then assigns agent.session_id.
        self.mode("ok")
        fake = types.SimpleNamespace(create_openai_client=lambda agent, kw, reason, shared: "ORIGINAL")
        compat._patch_helpers(fake)
        agent = types.SimpleNamespace(provider="claude-code-cli")
        client = fake.create_openai_client(agent, {"base_url": cc.BASE_URL, "command": str(self.binary)}, reason="agent_init", shared=True)
        client._base = self.tmp
        client._fallback = lambda *a: self.fallbacks.append(a[1]) or "NOUS"
        agent.session_id = "20261017_000000_abcd"
        r = self.ask(client, [SYS, {"role": "user", "content": "Reply with OK"}])
        self.assertEqual(r.choices[0].message.content, "OK")
        self.assertEqual(self.fallbacks, [])
        self.assertEqual(len(self.entries("spawn")), 1)
        self.assertIn(str(uuid.uuid5(cc._NS, "20261017_000000_abcd:0")), self.entries("spawn")[0]["argv"])


class Seams(unittest.TestCase):
    def test_registered_as_external_process_provider(self):
        from providers import get_provider_profile

        profile = get_provider_profile("claude-code-cli")
        self.assertIsNotNone(profile)
        self.assertEqual(profile.auth_type, "external_process")
        self.assertEqual(profile.base_url, "acp://claude-code")
        self.assertEqual(list(profile.fetch_models()), list(cc.MODELS))
        # Additive: the existing anthropic aliases keep resolving to anthropic.
        self.assertEqual(get_provider_profile("claude-code").name, "anthropic")
        self.assertEqual(get_provider_profile("claude").name, "anthropic")

    def test_runtime_seam_changes_only_claude_code(self):
        seen = []
        fake = types.SimpleNamespace(resolve_runtime_provider=lambda **kw: seen.append(kw) or {"provider": kw["requested"]})
        with mock.patch.object(compat, "_configured_provider", return_value="nous"):
            compat._patch_runtime(fake)
            self.assertEqual(fake.resolve_runtime_provider(requested="anthropic"), {"provider": "anthropic"})
            self.assertEqual(fake.resolve_runtime_provider(requested=None), {"provider": None})
            self.assertEqual(fake.resolve_runtime_provider(requested="claude-code"), {"provider": "claude-code"})
            rt = fake.resolve_runtime_provider(requested="claude-code-cli")
        self.assertEqual((rt["provider"], rt["base_url"], rt["api_mode"]), ("claude-code-cli", "acp://claude-code", "chat_completions"))
        self.assertEqual(len(seen), 3)

    def test_client_seam_binds_session_and_leaves_others(self):
        fake = types.SimpleNamespace(create_openai_client=lambda agent, kw, reason, shared: "ORIGINAL")
        compat._patch_helpers(fake)
        other = types.SimpleNamespace(provider="nous", session_id="s1")
        self.assertEqual(fake.create_openai_client(other, {"base_url": "https://x"}, reason="r", shared=True), "ORIGINAL")
        mine = types.SimpleNamespace(provider="claude-code-cli", session_id="s1")
        client = fake.create_openai_client(mine, {"base_url": "acp://claude-code", "api_key": "claude-code-cli"}, reason="r", shared=True)
        self.assertIsInstance(client, cc.ClaudeCodeClient)
        self.assertEqual(client.current_session_key(), "s1")
        mine.session_id = "s2"  # read per call, never frozen at construction
        self.assertEqual(client.current_session_key(), "s2")

    def test_aux_seam_pins_nous(self):
        fake = types.SimpleNamespace(_read_main_provider=lambda: "claude-code-cli", _read_main_model=lambda: "claude-opus-5-5")
        with mock.patch.object(compat, "fallback_target", return_value=("nous", "hermes-4")):
            compat._patch_aux(fake)
            self.assertEqual(fake._read_main_provider(), "nous")
            self.assertEqual(fake._read_main_model(), "hermes-4")
        keep = types.SimpleNamespace(_read_main_provider=lambda: "anthropic", _read_main_model=lambda: "m")
        compat._patch_aux(keep)
        self.assertEqual((keep._read_main_provider(), keep._read_main_model()), ("anthropic", "m"))

    def test_custom_endpoint_survives_claude_code(self):
        tmp = Path(tempfile.mkdtemp(prefix="cc_custom_"))
        url = "http://127.0.0.1:9/v1"
        (tmp / "fallback.json").write_text(json.dumps({"provider": "custom:local-(127.0.0.1:9)", "model": "m", "base_url": url}))
        with mock.patch.object(compat, "plugin_dir", return_value=tmp):
            self.assertEqual(compat.fallback_target(), ("custom", "m"))
            self.assertEqual(compat.fallback_base_url(), url)
            aux = types.SimpleNamespace(_read_main_provider=lambda: "claude-code-cli", _read_main_model=lambda: "x", _read_main_base_url=lambda: "")
            compat._patch_aux(aux)
            self.assertEqual((aux._read_main_provider(), aux._read_main_base_url()), ("custom", url))
            seen = []
            rt = types.SimpleNamespace(resolve_runtime_provider=lambda **kw: seen.append(kw) or {"provider": kw["requested"]})
            compat._patch_runtime(rt)
            with mock.patch.object(compat, "_configured_provider", return_value="claude-code-cli"):
                rt.resolve_runtime_provider(requested="custom")
                rt.resolve_runtime_provider(requested="custom", explicit_base_url="http://other/v1")
            with mock.patch.object(compat, "_configured_provider", return_value="custom"):
                rt.resolve_runtime_provider(requested="custom")
        self.assertEqual([kw.get("explicit_base_url") for kw in seen], [url, "http://other/v1", None])
        calls = []
        fake_aux = types.ModuleType("agent.auxiliary_client")
        fake_aux.resolve_provider_client = lambda p, m, **kw: (calls.append((p, m, kw)) or None, None)
        fake_rt = types.ModuleType("hermes_cli.runtime_provider")
        fake_rt.resolve_runtime_provider = lambda **kw: {"base_url": kw["explicit_base_url"], "provider": "custom"}
        with mock.patch.dict(sys.modules, {"agent.auxiliary_client": fake_aux, "hermes_cli.runtime_provider": fake_rt}):
            with self.assertRaises(cc.ClaudeCodeUnavailable):
                cc._default_fallback(tmp, "not_logged_in", {"messages": []})
        self.assertEqual(calls, [("custom:local-(127.0.0.1:9)", "m", {"main_runtime": {"base_url": url, "provider": "custom"}})])

    def test_recorded_url_reaches_only_bare_custom_or_the_recorded_slug(self):
        tmp = Path(tempfile.mkdtemp(prefix="cc_slug_"))
        url = "http://127.0.0.1:9/v1"
        cases = [
            ({"provider": "custom:a", "model": "m", "base_url": url}, {"custom": url, "custom:a": url, "custom:b": None}),
            ({"provider": "custom", "model": "m", "base_url": url}, {"custom": url, "custom:a": None, "custom:b": None}),
            ({"provider": "openrouter", "model": "x/y", "base_url": "https://openrouter.ai/api/v1"},
             {"custom": None, "custom:a": None, "custom:b": None}),
            ({"provider": "anthropic", "model": "m", "base_url": "https://api.anthropic.com"}, {"custom": None, "custom:b": None}),
        ]
        for fallback, expected in cases:
            (tmp / "fallback.json").write_text(json.dumps(fallback))
            seen = []
            rt = types.SimpleNamespace(resolve_runtime_provider=lambda **kw: seen.append(kw) or {})
            with mock.patch.object(compat, "plugin_dir", return_value=tmp), \
                    mock.patch.object(compat, "_configured_provider", return_value="claude-code-cli"):
                compat._patch_runtime(rt, own_engine=False)
                for requested in expected:
                    rt.resolve_runtime_provider(requested=requested)
            got = {kw["requested"]: kw.get("explicit_base_url") for kw in seen}
            self.assertEqual(got, expected, fallback["provider"])

    def test_a_slug_with_its_own_base_url_beats_the_recorded_one(self):
        tmp = Path(tempfile.mkdtemp(prefix="cc_stale_"))
        a, a_old = "http://127.0.0.1:9/v1", "http://127.0.0.3:9/v1"
        (tmp / "fallback.json").write_text(json.dumps({"provider": "custom:a", "model": "model-a", "base_url": a_old}))
        named = {"custom:a": {"name": "a", "base_url": a, "api_key": "sk-fake-AAAA"}}

        def runtime_module():
            module = types.ModuleType("hermes_cli.runtime_provider")
            module.seen = []
            module._get_named_custom_provider = lambda p: named.get(p.strip().lower())
            module.resolve_runtime_provider = lambda **kw: module.seen.append(kw) or {"provider": kw["requested"]}
            return module

        for own_engine in (True, False):  # no-hook and hook builds
            rt = runtime_module()
            with mock.patch.object(compat, "plugin_dir", return_value=tmp), \
                    mock.patch.object(compat, "_configured_provider", return_value="claude-code-cli"):
                compat._patch_runtime(rt, own_engine=own_engine)
                for requested in ("custom:a", "custom:b", "custom"):
                    rt.resolve_runtime_provider(requested=requested)
            got = {kw["requested"]: kw.get("explicit_base_url") for kw in rt.seen}
            self.assertEqual(got, {"custom:a": None, "custom:b": None, "custom": a_old}, own_engine)
        rt = runtime_module()
        with mock.patch.object(compat, "plugin_dir", return_value=tmp), \
                mock.patch.dict(sys.modules, {"hermes_cli.runtime_provider": rt}):
            self.assertEqual((compat.fallback_target(), compat.fallback_base_url()), (("custom:a", "model-a"), ""))
            named.clear()  # the slug no longer declares a URL: the recorded one is all there is
            self.assertEqual((compat.fallback_target(), compat.fallback_base_url()), (("custom", "model-a"), a_old))
        named["custom:a"] = {"name": "a", "base_url": a, "api_key": "sk-fake-AAAA"}
        calls = []
        fake_aux = types.ModuleType("agent.auxiliary_client")
        fake_aux.resolve_provider_client = lambda p, m, **kw: (calls.append((p, m, kw)) or None, None)
        rt = runtime_module()
        with mock.patch.dict(sys.modules, {"agent.auxiliary_client": fake_aux, "hermes_cli.runtime_provider": rt}):
            with self.assertRaises(cc.ClaudeCodeUnavailable):
                cc._default_fallback(tmp, "not_logged_in", {"messages": []})
        self.assertEqual(rt.seen, [{"requested": "custom:a"}])
        self.assertEqual(calls, [("custom:a", "model-a", {"main_runtime": {"provider": "custom:a"}})])
        for hostile in ({"base_url": ["http://x"]}, {"base_url": 7}, {"base_url": "  "}, {}, "x", None):
            module = types.SimpleNamespace(_get_named_custom_provider=lambda p, h=hostile: h)
            self.assertEqual(cc.named_custom_base_url("custom:a", module), "")
        # Any own string counts, whatever its scheme: it only ever skips an injection.
        for own in ("file:///etc/passwd", "ftp://h", "HTTPS://h/v1", "Http://h/v1"):
            module = types.SimpleNamespace(_get_named_custom_provider=lambda p, u=own: {"base_url": f" {u} "})
            self.assertEqual(cc.named_custom_base_url("custom:a", module), own)
        boom = types.SimpleNamespace(_get_named_custom_provider=mock.Mock(side_effect=RuntimeError("cfg")))
        self.assertEqual(cc.named_custom_base_url("custom:a", boom), "")
        self.assertEqual(cc.named_custom_base_url("custom", boom), "")
        boom._get_named_custom_provider.assert_called_once()

    def test_an_own_base_url_with_an_upper_case_scheme_still_beats_the_recorded_one(self):
        tmp = Path(tempfile.mkdtemp(prefix="cc_case_"))
        a_old = "http://127.0.0.3:9/v1"
        (tmp / "fallback.json").write_text(json.dumps({"provider": "custom:a", "model": "model-a", "base_url": a_old}))
        for own in ("HTTPS://127.0.0.1:9/v1", "Http://127.0.0.1:9/v1"):
            named = {"custom:a": {"name": "a", "base_url": own, "api_key": "sk-fake-AAAA"}}

            def runtime_module():
                module = types.ModuleType("hermes_cli.runtime_provider")
                module.seen = []
                module._get_named_custom_provider = lambda p: named.get(p.strip().lower())
                module.resolve_runtime_provider = lambda **kw: module.seen.append(kw) or {"provider": kw["requested"]}
                return module

            for own_engine in (True, False):
                rt = runtime_module()
                with mock.patch.object(compat, "plugin_dir", return_value=tmp), \
                        mock.patch.object(compat, "_configured_provider", return_value="claude-code-cli"):
                    compat._patch_runtime(rt, own_engine=own_engine)
                    for requested in ("custom:a", "Custom:A", "custom"):
                        rt.resolve_runtime_provider(requested=requested)
                got = [(kw["requested"], kw.get("explicit_base_url")) for kw in rt.seen]
                self.assertEqual(got, [("custom:a", None), ("Custom:A", None), ("custom", a_old)], (own, own_engine))
            rt = runtime_module()
            with mock.patch.object(compat, "plugin_dir", return_value=tmp), \
                    mock.patch.dict(sys.modules, {"hermes_cli.runtime_provider": rt}):
                self.assertEqual((compat.fallback_target(), compat.fallback_base_url()), (("custom:a", "model-a"), ""), own)
            calls = []
            fake_aux = types.ModuleType("agent.auxiliary_client")
            fake_aux.resolve_provider_client = lambda p, m, **kw: (calls.append((p, m, kw)) or None, None)
            rt = runtime_module()
            with mock.patch.dict(sys.modules, {"agent.auxiliary_client": fake_aux, "hermes_cli.runtime_provider": rt}):
                with self.assertRaises(cc.ClaudeCodeUnavailable):
                    cc._default_fallback(tmp, "not_logged_in", {"messages": []})
            self.assertEqual(rt.seen, [{"requested": "custom:a"}], own)
            self.assertEqual(calls, [("custom:a", "model-a", {"main_runtime": {"provider": "custom:a"}})], own)

    def test_two_named_slugs_keep_their_own_host_and_key_through_hermes(self):
        import shutil
        import subprocess

        a, b = "http://127.0.0.1:9/v1", "http://127.0.0.2:9/v1"
        child = (
            "import importlib, json, os, sys, types; sys.path.insert(0, os.environ['APP']);"
            "pkg = types.ModuleType('ccp'); pkg.__path__ = [os.environ['PLUGCOPY']]; sys.modules['ccp'] = pkg;"
            "importlib.import_module('ccp.compat').install();"
            "from hermes_cli.runtime_provider import resolve_runtime_provider as r;"
            "print('RESULT ' + json.dumps({s: [str(r(requested=s).get(k) or '') for k in ('base_url', 'api_key')]"
            " for s in ('custom:a', 'custom:b', 'custom')}))"
        )
        # The third is stale: config moved a to its own URL after fallback.json recorded another one.
        fallbacks = [{"provider": "custom:a", "model": "model-a", "base_url": a},
                     {"provider": "openrouter", "model": "x/y", "base_url": "https://openrouter.ai/api/v1"},
                     {"provider": "custom:a", "model": "model-a", "base_url": "http://127.0.0.3:9/v1"}]
        for fallback in fallbacks:
            with tempfile.TemporaryDirectory() as tmp:
                home = Path(tmp)
                (home / "config.yaml").write_text(
                    "model:\n  provider: claude-code-cli\n  default: claude-opus-5-5\ncustom_providers:\n"
                    f"  - name: a\n    base_url: {a}\n    api_key: sk-fake-AAAA\n    model: model-a\n"
                    f"  - name: b\n    base_url: {b}\n    api_key: sk-fake-BBBB\n    model: model-b\n"
                )
                copy = home / "plugins" / "model-providers" / "claude-code"
                shutil.copytree(PLUGIN, copy, ignore=shutil.ignore_patterns("__pycache__", "tests"))
                (copy / "fallback.json").write_text(json.dumps(fallback))
                env = {k: v for k, v in os.environ.items()
                       if not k.startswith(("ANTHROPIC_", "OPENAI_", "OPENROUTER_", "CUSTOM_"))}
                env.update(HERMES_HOME=str(home), HOME=str(home), APP=str(APP), PLUGCOPY=str(copy))
                proc = subprocess.run([sys.executable, "-I", "-c", child], cwd=str(home), env=env,
                                      capture_output=True, text=True, timeout=120)
            line = next((x for x in proc.stdout.splitlines() if x.startswith("RESULT ")), None)
            self.assertIsNotNone(line, proc.stderr[-400:])
            got = json.loads(line[7:])
            self.assertEqual(got["custom:b"], [b, "sk-fake-BBBB"], fallback["provider"])
            self.assertEqual(got["custom:a"], [a, "sk-fake-AAAA"], fallback["provider"])
            if fallback["base_url"] == a:  # aux/fallback turns (bare custom) reach a with a's key
                self.assertEqual(got["custom"], [a, "sk-fake-AAAA"])

    def test_no_config_read_without_fallback_json(self):
        tmp = Path(tempfile.mkdtemp(prefix="cc_nofb_"))
        rt = types.SimpleNamespace(resolve_runtime_provider=lambda **kw: {"provider": kw["requested"]})
        reads = mock.Mock(return_value="nous")
        parse = mock.Mock(side_effect=cc._read_json)
        with mock.patch.object(compat, "plugin_dir", return_value=tmp), \
                mock.patch.object(compat, "_configured_provider", reads), mock.patch.object(compat, "_read_json", parse):
            compat._patch_runtime(rt)
            for requested in ("", "auto", None, "custom", "custom:a"):
                rt.resolve_runtime_provider(requested=requested)
            self.assertEqual(reads.call_count, 0)
            (tmp / "fallback.json").write_text(json.dumps({"provider": "nous", "model": "m"}))
            rt.resolve_runtime_provider(requested="")
            rt.resolve_runtime_provider(requested="custom")
            self.assertEqual((reads.call_count, parse.call_count), (2, 1))  # parsed once while unchanged
            os.replace(tmp / "fallback.json", tmp / "old.json")
            (tmp / "fallback.json").write_text(json.dumps({"provider": "custom:a", "model": "m2", "base_url": "http://h/v1"}))
            self.assertEqual(compat.fallback_target(), ("custom", "m2"))
            self.assertEqual(parse.call_count, 2)
            (tmp / "fallback.json").unlink()
            rt.resolve_runtime_provider(requested="auto")
            self.assertEqual(reads.call_count, 2)

    def test_mid_import_module_is_patched_on_first_access(self):
        name = "_cc_fake_mid_import"
        module = types.ModuleType(name)
        module.__spec__ = types.SimpleNamespace(_initializing=True)
        sys.modules[name] = module
        self.addCleanup(sys.modules.pop, name, None)
        applied = []
        compat._after_import(name, lambda m: applied.append(m.resolve), ("resolve",))
        self.assertEqual(applied, [])
        self.assertIs(type(module), compat._PatchOnAccess)
        module.__dict__["resolve"] = "ORIGINAL"  # the module body goes on defining names
        self.assertEqual(module.resolve, "ORIGINAL")
        self.assertEqual(applied, ["ORIGINAL"])
        self.assertIs(type(module), types.ModuleType)
        _ = module.resolve
        self.assertEqual(len(applied), 1)

    def test_mid_import_module_waits_for_the_end_when_a_name_is_missing(self):
        name = "_cc_fake_mid_import_2"
        module = types.ModuleType(name)
        module.__spec__ = types.SimpleNamespace(_initializing=True)
        module.first = 1
        sys.modules[name] = module
        self.addCleanup(sys.modules.pop, name, None)
        applied = []
        compat._after_import(name, lambda m: applied.append(getattr(m, "second", None)), ("first", "second"))
        self.assertEqual(module.first, 1)
        self.assertEqual(applied, [])
        module.__spec__._initializing = False  # import finished without defining "second"
        self.assertEqual(module.first, 1)
        self.assertEqual(applied, [None])

    def test_cold_resolve_in_a_real_import_order(self):
        import subprocess

        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            target = home / "plugins" / "model-providers" / "claude-code"
            import shutil

            shutil.copytree(PLUGIN, target, ignore=shutil.ignore_patterns("__pycache__", "tests"))
            fake = Path(tmp) / "claude"
            fake.write_text("#!/bin/sh\nexit 0\n")
            fake.chmod(0o755)
            code = (
                "import sys; sys.path.insert(0, '.');"
                "import hermes_cli.runtime_provider as rp;"
                "a = rp.resolve_runtime_provider(requested='claude-code-cli')['base_url'];"
                "exec('try:\\n b = rp.resolve_runtime_provider(requested=\\'nous\\').get(\\'provider\\')\\n"
                "except Exception as e:\\n b = type(e).__name__');"
                "print('RESULT', a, b, type(rp).__name__)"
            )
            env = {k: v for k, v in os.environ.items() if not k.startswith(("ANTHROPIC_", "NOUS_"))}
            env.update(HERMES_HOME=str(home), ICLONE_CLAUDE_BIN=str(fake))
            proc = subprocess.run(
                [sys.executable, "-I", "-c", code], cwd=str(APP), env=env, capture_output=True, text=True, timeout=120
            )
        line = next((x for x in proc.stdout.splitlines() if x.startswith("RESULT ")), proc.stderr[-400:])
        self.assertTrue(line.startswith("RESULT acp://claude-code "), line)
        self.assertTrue(line.endswith(" module"), line)
        self.assertNotIn("claude-code-cli", line.split()[2], line)  # other providers keep the original path

    def test_no_api_key_headers_or_token_reads_in_source(self):
        for path in PLUGIN.glob("*.py"):
            text = path.read_text().lower()
            for banned in ("x-api-key", "authorization", "bearer", ".credentials.json", "accesstoken", "keychain"):
                self.assertNotIn(banned, text, f"{banned} in {path.name}")


if __name__ == "__main__":
    unittest.main()
