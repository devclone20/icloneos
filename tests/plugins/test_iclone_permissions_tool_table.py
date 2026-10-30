"""V3-UP r2 (M1) + r3 (UP3-1, ruling 43) — the permission classifier's table against EVERY tool name the runtime under
test can put in front of the permission hook.

r2 derived "dispatchable" as registry ∪ aliases ∪ inline tools ∪ manifests and so never saw the Tool Search bridge
(``tool_search``/``tool_describe``, default-on at 1ac3f97): reaching a deferred read such as ``todo_list`` cost an
owner prompt in every mode and was impossible in Plan. r3 closes the CLASS: ``tests/plugins/iclone_tool_universe.py``
derives the whole universe by machine — registry, every literal registration in the code (AST), every bundled
plugin's ``register(ctx)``, every manifest, every bundled memory provider and context engine, the agent loop's inline
and injected tools, the legacy aliases, the bridge names and the Tool Search index — into the committed
``plugins/iclone-permissions/tests/fixtures/tool_universe.json``. This file holds:

1. the committed fixture equal to a fresh derivation of THIS tree (exhaustive against the live pin: a name, a source
   or a path argument upstream adds turns it red until the fixture is regenerated and the name decided);
2. 0 unknowns: every derived name has a class (or is a bridge wrapper) — the test fails on the first unknown;
3. every string argument that may name a file or a directory is decided (``classify.PATH_ARGS`` or ``NOT_LOCAL``),
   and each decided one carries its floor in every mode;
4. the lookups are reads, end to end under the lock with the real plugin: ``tool_search`` → ``todo_list`` through the
   bridge never prompts in any mode, while a genuinely unknown ``mcp__x__y`` still lands in ``$``.
"""

from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys
import types
from pathlib import Path

import pytest

from tests.plugins.test_iclone_permissions import (  # noqa: F401 (_isolated: autouse temp home)
    FIXTURE, MODES, _body, _isolated, _load, _locked_manager, wired)

ROOT = Path(__file__).resolve().parents[2]
UNIVERSE_FIXTURE = ROOT / "plugins/iclone-permissions/tests/fixtures/tool_universe.json"

# Names the table keeps although nothing dispatches them at this pin, each with its reason. The test also fails the
# day one of them becomes dispatchable again, so this list can only shrink by a decision.
KEPT_UNREGISTERED = {
    # Not an agent tool since before 10b3883 (tools/send_message_tool.py: "intentionally NOT registered"); V3-F2's
    # email/messaging split keys on the name (functions.py ``_structured``, the pane's mirror and its tests).
    "send_message": "V3-F2 email/messaging split",
}

# Path-argument candidates (the derivation's broad name/description match) that never name a file or a directory on
# this machine, each with its reason. Together with ``classify.PATH_ARGS`` and the file tools' own arguments they
# must equal the derived candidates exactly.
NOT_LOCAL = {
    ("a2a_discover", "url"): "the remote agent's base URL",
    ("browser_scroll", "direction"): "up/down",
    ("computer_use", "direction"): "a scroll direction",
    ("delegate_task", "tasks[].context"): "free text for the child; its own calls are classified",
    ("feishu_drive_add_comment", "file_token"): "a Feishu document token",
    ("feishu_drive_add_comment", "file_type"): "an enum (docx, …)",
    ("feishu_drive_list_comment_replies", "file_token"): "a Feishu document token",
    ("feishu_drive_list_comment_replies", "file_type"): "an enum",
    ("feishu_drive_list_comments", "file_token"): "a Feishu document token",
    ("feishu_drive_list_comments", "file_type"): "an enum",
    ("feishu_drive_reply_comment", "file_token"): "a Feishu document token",
    ("feishu_drive_reply_comment", "file_type"): "an enum",
    ("kanban_attach", "filename"): "a leaf name in the task's attachment store (directories stripped)",
    ("kanban_attach_url", "filename"): "a leaf name in the task's attachment store",
    ("kanban_attach_url", "url"): "an http(s) URL Hermes fetches",
    ("kanban_create", "workspace_kind"): "an enum (scratch, dir, worktree)",
    ("meet_join", "url"): "a meet.google.com URL",
    ("retaindb_delete_file", "file_id"): "a RetainDB file id",
    ("retaindb_ingest_file", "file_id"): "a RetainDB file id",
    ("retaindb_read_file", "file_id"): "a RetainDB file id",
    ("retaindb_upload_file", "remote_path"): "the destination inside RetainDB's store",
    ("search_files", "file_glob"): "a glob applied under ``path`` (the file tool's own path argument)",
    ("search_files", "output_mode"): "an enum",
    ("session_search", "profile"): "a Hermes profile name (its database, read-only)",
    ("skill_view", "file_path"): "a file inside the skill's own directory; skill_view refuses traversal",
    ("spotify_library", "uris[]"): "spotify: URIs",
    ("spotify_playback", "context_uri"): "a spotify: URI",
    ("spotify_playback", "uris[]"): "spotify: URIs",
    ("spotify_playlists", "uris[]"): "spotify: URIs",
    ("spotify_queue", "uri"): "a spotify: URI",
    ("viking_browse", "path"): "a viking:// path inside OpenViking",
    ("viking_forget", "uri"): "a viking:// memory URI",
    ("viking_read", "uri"): "a viking:// URI",
    ("viking_read", "uris[]"): "viking:// URIs",
    ("web_extract", "urls[]"): "http(s) URLs",
    ("xai_video_edit", "video_url"): "a public https URL (xAI fetches it)",
    ("xai_video_extend", "video_url"): "a public https URL (xAI fetches it)",
}
# The file tools' own path arguments: classified by PATH_READERS / PATH_WRITERS / the patch parser.
FILE_TOOL_ARGS = {("read_file", "path"), ("search_files", "path"), ("write_file", "path"), ("patch", "path")}


@pytest.fixture(scope="module")
def universe(tmp_path_factory):
    """The universe of THIS tree, from a fresh interpreter with a throwaway HERMES_HOME."""
    home = tmp_path_factory.mktemp("tool-universe-home")
    env = dict(os.environ, HERMES_HOME=str(home / ".hermes"), PYTHONDONTWRITEBYTECODE="1")
    env["PYTHONPATH"] = os.pathsep.join([str(ROOT)] + [p for p in env.get("PYTHONPATH", "").split(os.pathsep) if p])
    (home / ".hermes").mkdir()
    out = subprocess.run([sys.executable, "-m", "tests.plugins.iclone_tool_universe", str(ROOT)], cwd=str(ROOT),
                         env=env, capture_output=True, text=True, timeout=300)
    assert out.returncode == 0 and "UNIVERSE-JSON" in out.stdout, out.stderr[-3000:]
    data = json.loads(out.stdout[out.stdout.index("UNIVERSE-JSON") + len("UNIVERSE-JSON"):].strip().splitlines()[0])
    assert len(data["registry"]) >= 90, data["registry"]  # 98 at 1ac3f97: a broken discovery must not pass
    return data


@pytest.fixture(scope="module")
def tool_universe():
    return importlib.import_module("tests.plugins.iclone_tool_universe")


@pytest.fixture()
def classify():
    _load()
    return importlib.import_module("hermes_plugins.iclone_permissions.classify")


def _decide(classified, mode, ceilings=None, grants=None, **over):
    policy = importlib.import_module("hermes_plugins.iclone_permissions.policy")
    body = {"table": FIXTURE["table"], "standing": mode, "ceilings": ceilings or {}, "grants": grants or []}
    body.update(over)
    return policy.decide(body, cls=classified.cls, facts=classified.facts, floor=classified.floor,
                         ceiling_key=classified.ceiling_key, session_id="s1", project=None)


ON = {k: "on" for k in FIXTURE["ceilingKey"].values() if k}


def _policy(**over):
    """A signed body's decision inputs (the table, every switch on), as the hook hands them to the classifier."""
    return dict({"table": FIXTURE["table"], "ceilings": ON, "ceilingKey": FIXTURE["ceilingKey"]}, **over)


# ---------------------------------------------------------------------------------------------------------------------
# 1–2. The universe: committed, exhaustive, 0 unknowns
# ---------------------------------------------------------------------------------------------------------------------
class TestTheUniverseIsDerivedAndCommitted:
    def test_every_bundled_plugin_and_provider_could_be_read(self, universe):
        assert universe["errors"] == {}, universe["errors"]
        assert universe["schemaless"] == [], universe["schemaless"]

    def test_every_source_is_live(self, universe):
        """A source that silently returns nothing would hide its names: each one must see the names it exists for."""
        assert {"tool_search", "tool_describe", "tool_call"} == set(universe["bridges"])
        assert "todo_list" in universe["search_index"], "the Tool Search index no longer returns the deferred reads"
        assert {"retaindb_remember", "fact_store", "brv_query", "viking_search"} <= set(universe["memory"])
        assert {"meet_join", "spotify_search", "a2a_call"} <= set(universe["plugins"])
        assert "message_agent" in universe["injected"] and "todo_list" in universe["inline"]
        assert universe["aliases"].get("process") == "process_manage"
        assert universe["families"] == {"mcp": "mcp__", "connectors": "connectors__"}

    def test_the_committed_fixture_is_this_tree(self, universe, tool_universe):
        committed = json.loads(UNIVERSE_FIXTURE.read_text())
        live = json.loads(json.dumps(tool_universe.fixture_view(universe)))
        added = sorted(set(live["names"]) - set(committed["names"]))
        removed = sorted(set(committed["names"]) - set(live["names"]))
        assert (added, removed) == ([], []), (
            f"the runtime's tool universe changed (added {added}, removed {removed}): regenerate with "
            "`python -m tests.plugins.iclone_tool_universe . --write` and classify every new name")
        assert committed == live

    def test_zero_unknowns_every_name_the_runtime_can_dispatch_has_a_class(self, universe, tool_universe, classify):
        known = set(classify.TOOL_CLASSES) | set(classify.BRIDGE_WRAPPERS)
        for name in tool_universe.names(universe):  # the first unknown fails, named
            assert name in known, f"{name!r} reaches the permission hook with no class (sources: {_sources(universe, name)})"

    def test_no_entry_names_a_tool_the_runtime_no_longer_has(self, universe, tool_universe, classify):
        live = set(tool_universe.names(universe))
        dead = sorted(set(classify.TOOL_CLASSES) - live - set(KEPT_UNREGISTERED))
        assert dead == [], f"TOOL_CLASSES entries nothing dispatches at this tree: {dead}"
        assert sorted(set(KEPT_UNREGISTERED) & live) == [], "a kept name is live again: classify it"
        assert set(KEPT_UNREGISTERED) <= set(classify.TOOL_CLASSES)

    def test_every_name_the_tool_search_index_returns_has_a_class(self, universe, classify):
        assert set(universe["search_index_built"]) <= set(universe["search_index"])
        missing = sorted(set(universe["search_index"]) - set(classify.TOOL_CLASSES))
        assert missing == []

    def test_a_legacy_name_has_exactly_the_class_of_the_name_it_dispatches_as(self, universe, classify):
        assert universe["aliases"], "1ac3f97 has legacy aliases; an empty map means the discovery is broken"
        for old, new in universe["aliases"].items():
            assert classify.TOOL_CLASSES[old] == classify.TOOL_CLASSES[new], (old, new)
            assert (old in classify.PROCESS_TOOLS) == (new in classify.PROCESS_TOOLS), (old, new)
            assert classify.PATH_ARGS.get(old) == classify.PATH_ARGS.get(new), (old, new)

    @pytest.mark.parametrize("family", ["mcp", "connectors"])
    def test_a_dynamic_family_is_the_unknown_class_ruling_40(self, universe, classify, family):
        name = universe["families"][family] + "x__y"
        k = classify.classify(name, {}, "/tmp", {}, session_id="s1")
        assert (k.cls, k.ceiling_key) == classify.UNKNOWN_TOOL_CLASS

    def test_the_v3f2_function_tables_hold_the_same_names(self, classify):
        functions = importlib.import_module("hermes_plugins.iclone_permissions.functions")
        tables = (functions._MESSAGING_TOOLS, functions._FILE_TOOLS, functions._PUBLISH_TOOLS, functions._SHELL_TOOLS,
                  functions._NO_FUNCTION, functions._NO_FUNCTION_PROVIDER_READS)
        named = set().union(*tables)
        assert named == set(classify.TOOL_CLASSES) - {"send_message"}
        assert sum(len(t) for t in tables) == len(named), "a tool sits in two function tables"
        assert functions._PROCESS_TOOLS == classify.PROCESS_TOOLS
        assert sorted(functions._SHELL_TOOLS) == FIXTURE_FUNCTIONS()["shellTextTools"]
        assert sorted(functions._NO_FUNCTION) == FIXTURE_FUNCTIONS()["noFunctionTools"]
        provider_reads = json.loads((ROOT / "plugins/iclone-permissions/tests/fixtures/functions_provider_reads.json")
                                    .read_text())["noFunctionProviderReads"]
        assert sorted(functions._NO_FUNCTION_PROVIDER_READS) == provider_reads  # main's mirror, functions.ts
        for name in functions._NO_FUNCTION_PROVIDER_READS:  # a provider read is no function, like any other read
            k = classify.classify(name, {"query": "x"}, "/tmp", {}, session_id="s1")
            assert list(functions.functions_of(name, {"query": "x"}, k)) == [], name

    def test_the_confinement_hook_covers_every_shell_tool_the_runtime_has(self, universe, tool_universe):
        from tests.plugins.test_iclone_confinement import _load as load_confinement

        shell_tools = load_confinement().SHELL_TOOLS
        backend = {n for n, ts in universe["toolsets"].items() if ts in ("terminal", "code_execution")}
        backend |= {old for old, new in universe["aliases"].items() if new in backend}
        assert {"terminal", "process_manage", "execute_code"} <= backend
        assert sorted(backend - shell_tools) == []
        assert sorted(shell_tools - set(tool_universe.names(universe))) == []


def _sources(universe, name):
    return sorted(k for k in ("registry", "static", "plugins", "manifests", "memory", "context", "inline", "injected",
                              "aliases", "bridges", "search_index") if name in universe[k])


def FIXTURE_FUNCTIONS():
    return json.loads((ROOT / "plugins/iclone-permissions/tests/fixtures/functions.json").read_text())


# ---------------------------------------------------------------------------------------------------------------------
# 3. Path arguments: every candidate decided, every decided one carries its floor
# ---------------------------------------------------------------------------------------------------------------------
def _decided_local(classify):
    return {(tool, spec): kind for tool, specs in classify.PATH_ARGS.items() for spec, kind in specs}


def _args_at(spec, value):
    """Build arguments carrying ``value`` at ``spec`` (``a``, ``a[]``, ``a[].b``, ``a[].b[]``)."""
    head, _, rest = spec.partition(".")
    many = head.endswith("[]")
    key = head[:-2] if many else head
    inner = _args_at(rest, value) if rest else value
    return {key: [inner] if many else inner}


class TestEveryPathArgumentIsDecided:
    def test_the_derived_candidates_are_exactly_the_decided_ones(self, universe, classify):
        live = {(tool, spec) for tool, specs in universe["path_args"].items() for spec in specs}
        decided = set(_decided_local(classify)) | set(NOT_LOCAL) | FILE_TOOL_ARGS
        aliases = {(old, spec) for old, new in universe["aliases"].items() for (tool, spec) in decided if tool == new}
        assert sorted(live - decided) == [], "path-like arguments nobody decided (PATH_ARGS or NOT_LOCAL)"
        assert sorted(decided - live - aliases) == [], "decisions for arguments the runtime no longer has"
        assert set(_decided_local(classify).values()) <= {"read", "anchor", "cwd", "write"}

    def test_a_secret_named_by_any_read_anchor_or_cwd_argument_is_refused_in_every_mode(self, classify, tmp_path):
        secret_dir = tmp_path / "secrets"
        secret_dir.mkdir()
        (secret_dir / "id_rsa").write_text("k")
        policy = {"secretPaths": [str(secret_dir)]}
        for (tool, spec), kind in sorted(_decided_local(classify).items()):
            if kind == "write":
                continue
            target = str(secret_dir / "id_rsa") if kind == "read" else str(secret_dir)
            for value in (target, "file://" + target):
                args = _args_at(spec, value)
                if tool == "terminal":
                    args["command"] = "cat id_rsa"
                k = classify.classify(tool, args, str(tmp_path), policy, session_id="s1")
                assert k.floor and k.floor.startswith("secrets"), (tool, spec, value, k)
                for mode in MODES:
                    assert _decide(k, mode, ON).outcome == "refuse", (tool, spec, mode)

    def test_the_same_arguments_off_the_secret_carry_no_floor(self, classify, tmp_path):
        (tmp_path / "ok.png").write_text("x")
        policy = {"secretPaths": [str(tmp_path / "secrets")]}
        for (tool, spec), kind in sorted(_decided_local(classify).items()):
            if kind == "write":
                continue
            for value in (str(tmp_path / "ok.png"), "https://example.com/a.png", "data:image/png;base64,AA=="):
                k = classify.classify(tool, _args_at(spec, value), str(tmp_path), policy, session_id="s1")
                assert not k.floor, (tool, spec, value, k.floor)

    def test_a_terminal_command_resolves_its_relative_paths_in_its_workdir(self, classify, tmp_path):
        """``rm -rf build`` in the project is a delete in the project (Ignore allows it); the same text with
        ``workdir`` elsewhere deletes OUTSIDE it, so Ignore asks — the classifier used to resolve it in the cwd."""
        project = tmp_path / "proj"
        (project / ".git").mkdir(parents=True)
        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        here = classify.classify("terminal", {"command": "rm -rf build"}, str(project), {}, session_id="s1")
        there = classify.classify("terminal", {"command": "rm -rf build", "workdir": str(elsewhere)}, str(project), {},
                                  session_id="s1")
        relative = classify.classify("terminal", {"command": "rm -rf build", "workdir": "../elsewhere"}, str(project),
                                     {}, session_id="s1")
        assert (here.cls, here.facts.get("inProject")) == ("D", True)
        assert _decide(here, "ignore", ON).outcome == "allow"
        for k in (there, relative):
            assert (k.cls, k.facts.get("inProject")) == ("D", False)
            assert _decide(k, "ignore", ON).outcome == "ask"

    def test_every_write_argument_is_classified_as_the_write_and_its_guard_is_the_floor(self, classify, tmp_path):
        project = tmp_path / "proj"
        (project / ".git").mkdir(parents=True)
        guarded = tmp_path / "guarded"
        guarded.mkdir()
        policy = _policy(protectedPaths=[str(guarded)])
        writes = [(tool, spec) for (tool, spec), kind in _decided_local(classify).items() if kind == "write"]
        assert writes, "text_to_speech writes where it is told"
        for tool, spec in writes:
            inside = classify.classify(tool, _args_at(spec, "out.mp3"), str(project), policy, session_id="s1")
            outside = classify.classify(tool, _args_at(spec, str(tmp_path / "x.mp3")), str(project), policy,
                                        session_id="s1")
            floor = classify.classify(tool, _args_at(spec, str(guarded / "x.mp3")), str(project), policy,
                                      session_id="s1")
            base = classify.classify(tool, {}, str(project), policy, session_id="s1")
            assert outside.cls == "Wo" and _decide(outside, "automatic", ON).outcome == "ask", tool
            assert _decide(inside, "automatic", ON).outcome == _decide(base, "automatic", ON).outcome, tool
            assert floor.floor and all(_decide(floor, m, ON).outcome == "refuse" for m in MODES), tool


# ---------------------------------------------------------------------------------------------------------------------
# 4. The lookups, the wrapper and the unknown family
# ---------------------------------------------------------------------------------------------------------------------
class TestTheLookupsAreReads:
    @pytest.mark.parametrize("name,args", [("tool_search", {"queries": ["todo list"]}),
                                           ("tool_describe", {"names": ["todo_list"]})])
    def test_a_lookup_is_r_and_allowed_in_every_mode_plan_included(self, classify, name, args):
        k = classify.classify(name, args, "/tmp", {}, session_id="s1")
        assert (k.cls, k.ceiling_key, k.floor) == ("R", None, None)
        for mode in MODES:
            assert _decide(k, mode, ON).outcome == "allow", mode

    def test_tool_call_is_the_class_of_what_it_wraps(self, classify, tmp_path):
        policy = _policy(secretPaths=[str(tmp_path / "id_rsa")])
        cases = {
            "todo_list": ({"name": "todo_list", "arguments": {"todos": []}}, "R"),
            "a batch of reads": ({"calls": [{"name": "todo_list", "arguments": {}},
                                            {"name": "session_search", "arguments": {"query": "x"}}]}, "R"),
            "a read and a write": ({"calls": [{"name": "todo_list", "arguments": {}},
                                              {"name": "write_file", "arguments": {"path": "/elsewhere/a"}}]},
                                   "Wo"),
            "connectors": ({"calls": [{"name": "connectors__gmail__send", "arguments": {"to": "x"}}]}, "$"),
            "arguments as JSON text": ({"name": "todo_list", "arguments": "{\"todos\": []}"}, "R"),
        }
        for label, (args, cls) in cases.items():
            assert classify.classify("tool_call", args, str(tmp_path), policy, session_id="s1").cls == cls, label
        secret = classify.classify("tool_call", {"name": "read_file", "arguments": {"path": str(tmp_path / "id_rsa")}},
                                   str(tmp_path), policy, session_id="s1")
        assert secret.floor and secret.floor.startswith("secrets")

    @pytest.mark.parametrize("args", [{}, {"calls": []}, {"calls": "not json"}, {"calls": [1]},
                                      {"name": "tool_call", "arguments": {"name": "tool_call", "arguments": {
                                          "name": "todo_list", "arguments": {}}}}])
    def test_an_unreadable_or_deeply_nested_tool_call_is_the_strictest_class(self, classify, args):
        k = classify.classify("tool_call", args, "/tmp", {}, session_id="s1")
        assert (k.cls, k.ceiling_key) == classify.UNKNOWN_TOOL_CLASS
        assert _decide(k, "plan", ON).outcome == "refuse" and _decide(k, "ignore", ON).outcome == "ask"


    def test_wrappers_nested_past_the_cap_are_the_strictest_class_even_if_the_bridge_ever_accepts_them(
            self, classify, monkeypatch):
        """Today the bridge's own parser refuses a wrapper inside a wrapper; the classifier must not depend on it
        (a future parser that accepts nesting must neither recurse without bound nor read the innermost call)."""
        import tools.tool_search_validation as V

        def permissive(args):
            return ([{"name": args.get("name"), "arguments": args.get("arguments") or {}}], None)

        monkeypatch.setattr(V, "normalize_tool_call_entries", permissive)
        inner = {"name": "todo_list", "arguments": {}}
        for _ in range(2):
            inner = {"name": "tool_call", "arguments": inner}
        k = classify.classify("tool_call", inner, "/tmp", {}, session_id="s1")
        assert (k.cls, k.ceiling_key) == classify.UNKNOWN_TOOL_CLASS
        deep = {"name": "todo_list", "arguments": {}}
        for _ in range(500):
            deep = {"name": "tool_call", "arguments": deep}
        assert classify.classify("tool_call", deep, "/tmp", {}, session_id="s1").cls == "$"


class TestTheBridgeEndToEndUnderTheLock:
    """The real plugin, Hermes' own hook dispatch and the agent loop's own bridge unwrap; main is a FakeMain that
    records every ask. A prompt is an ``ask`` main receives."""

    @staticmethod
    def _agent():
        return types.SimpleNamespace(session_id="s1", enabled_toolsets=None, disabled_toolsets=None,
                                     _current_turn_id="", _current_api_request_id="")

    @staticmethod
    def _call(name, args):
        fn = types.SimpleNamespace(name=name, arguments=json.dumps(args))
        return types.SimpleNamespace(id="c1", function=fn, type="function")

    def _run(self, wired, mode, calls):
        import hermes_cli.plugins as P
        from agent import tool_executor as TE

        mod, main, _ = wired(_body(standing=mode))
        manager = P.PluginManager()
        manager._hooks["pre_tool_call"] = [mod.on_pre_tool_call]
        out = []
        with _locked_manager(manager):
            for name, args in calls:
                parsed = TE._parse_tool_call(self._agent(), self._call(name, args))
                assert parsed.scope_block is None, parsed.scope_block
                block, _ = TE._pre_tool_block(self._agent(), parsed.ref("t1"))
                out.append((parsed.name, block))
        return out, main

    def test_tool_search_then_todo_list_through_the_bridge_never_prompts_in_any_mode(self, wired):
        import model_tools

        found, _ = model_tools._dispatch_bridge_tool("tool_search", {"queries": ["todo list"]}, None, None)
        assert "todo_list" in json.loads(found)["tools"], "the bridge no longer finds the deferred todo tool"
        for mode in MODES:
            out, main = self._run(wired, mode, [
                ("tool_search", {"queries": ["todo list"]}),
                ("tool_describe", {"names": ["todo_list"]}),
                ("tool_call", {"calls": [{"name": "todo_list", "arguments": {"todos": []}}]}),
            ])
            assert out == [("tool_search", None), ("tool_describe", None), ("todo_list", None)], (mode, out)
            assert main.verbs("ask") == [], (mode, main.verbs("ask"))

    def test_a_genuinely_unknown_mcp_tool_still_lands_in_spend(self, wired):
        for mode in MODES:
            out, main = self._run(wired, mode, [("mcp__x__y", {"amount": 5})])
            (name, block), = out
            assert name == "mcp__x__y"
            if mode == "plan":
                assert block and main.verbs("ask") == [], mode
            else:
                assert len(main.verbs("ask")) == 1, mode
                assert (main.verbs("ask")[0]["tool"], main.verbs("ask")[0]["cls"]) == ("mcp__x__y", "$")


# ---------------------------------------------------------------------------------------------------------------------
# r1/r2 rows at the pin (kept), the state writers (UP3-3 m3) and the unknown class
# ---------------------------------------------------------------------------------------------------------------------
SPEND = {"action": "write", "session_id": "p1", "data": "acp wallet send-transaction --to 0xabc --amount 5\n"}


class TestTheCriticsRowsAtThePin:
    """r1 critic M1, reproduced with the names the pin's dispatcher hands the hook (P-C1)."""

    @pytest.mark.parametrize("name", ["process_manage", "process"])
    def test_a_spend_typed_into_a_running_shell_still_asks_in_ignore(self, classify, name):
        k = classify.classify(name, SPEND, "/tmp", {}, session_id="s1")
        assert k.cls == "$"
        assert _decide(k, "ignore", {"terminal": "on", "spendTrade": "on"}).outcome == "ask"

    @pytest.mark.parametrize("name", ["cronjob_manage", "cronjob"])
    def test_a_cron_job_is_refused_with_the_scheduled_tasks_switch_off(self, classify, name):
        k = classify.classify(name, {"action": "create", "prompt": "x", "schedule": "every 5m"}, "/tmp", {}, session_id="s1")
        assert (k.cls, k.ceiling_key) == ("X", "scheduledTasks")
        assert _decide(k, "ignore", {"scheduledTasks": "off", "terminal": "on"}).outcome == "refuse"

    @pytest.mark.parametrize("name", ["process_manage", "process"])
    def test_looking_at_a_background_process_is_a_read_in_plan(self, classify, name):
        k = classify.classify(name, {"action": "poll", "session_id": "p1"}, "/tmp", {}, session_id="s1")
        assert k.cls == "R" and _decide(k, "plan").outcome == "allow"

    @pytest.mark.parametrize("name", ["todo_list", "gui_tour", "show_tip", "desktop_preview", "browser_vault_list",
                                      "tool_search", "tool_describe", "brv_status"])
    def test_the_apps_own_reads_never_prompt_in_manual(self, classify, name):
        k = classify.classify(name, {}, "/tmp", {}, session_id="s1")
        assert k.cls == "R" and _decide(k, "manual").outcome == "allow"

    def test_the_new_writers_and_installers_ask_in_manual(self, classify):
        expected = {"desktop_project": ("Wo", "fileWriting"), "kanban_schedule": ("Wo", "fileWriting"),
                    "manage_connections": ("I", "installSoftware"), "manage_catalog": ("I", "installSoftware"),
                    "browser_vault_save_login": ("Wo", "fileWriting"), "browser_vault_unlock": ("S", "automation"),
                    "message_agent": ("M", "sendMessages")}
        for name, (cls, key) in expected.items():
            k = classify.classify(name, {}, "/tmp", {}, session_id="s1")
            assert (k.cls, k.ceiling_key) == (cls, key), name
            assert _decide(k, "manual", {key: "on"}).outcome == "ask", name

    @pytest.mark.parametrize("name,args", [("browser_vault_fill", {"handle": "vault_card_1"}),
                                           ("browser_vault_enter_code", {"handle": "vault_totp_1"})])
    def test_a_vault_credential_action_asks_by_default_in_every_mode(self, classify, name, args):
        """Ruling 43: ``browser_vault_enter_code`` (a 2FA code minted from a saved seed) is classed like the fill —
        it asks in every mode, Ignore included; Plan refuses it; the spend switch OFF refuses it."""
        k = classify.classify(name, args, "/tmp", {}, session_id="s1")
        assert (k.cls, k.ceiling_key) == ("$", "spendTrade")
        for mode in ("ignore", "manual", "automatic", "acceptEdits"):
            assert _decide(k, mode, ON).outcome == "ask", mode
        assert _decide(k, "plan", ON).outcome == "refuse"
        assert _decide(k, "ignore", dict(ON, spendTrade="off")).outcome == "refuse"

    @pytest.mark.parametrize("name", ["browser_vault_fill", "browser_vault_enter_code"])
    def test_the_owners_per_function_levels_can_lower_a_vault_credential_action(self, classify, name):
        """…and the owner's per-function settings let the user lower it (V3-F2 levels on every function it names)."""
        policy = importlib.import_module("hermes_plugins.iclone_permissions.policy")
        functions = importlib.import_module("hermes_plugins.iclone_permissions.functions")
        k = classify.classify(name, {"handle": "vault_1"}, "/tmp", {}, session_id="s1")
        fns = functions.functions_of(name, {"handle": "vault_1"}, k)
        assert set(fns) >= {"publish", "payments"}, fns
        body = {"table": FIXTURE["table"], "standing": "manual", "ceilings": ON, "grants": [],
                "functions": {fn: "ignore" for fn in fns}}
        lowered = policy.decide(body, cls=k.cls, facts=k.facts, floor=k.floor, ceiling_key=k.ceiling_key,
                                session_id="s1", project=None, fns=fns)
        assert lowered.outcome == "allow", lowered
        body["functions"] = {}
        assert policy.decide(body, cls=k.cls, facts=k.facts, floor=k.floor, ceiling_key=k.ceiling_key,
                             session_id="s1", project=None, fns=fns).outcome == "ask"


class TestTheBrowserUrlIsAPathArgument:
    """Ruling 56 (critic r4 N4): the browser renders a local resource as readily as a web page, so its url is a path
    argument in every mode — a file: URL under any wrapper scheme meets the secrets floor, and a browser's own page
    (chrome:, about: but about:blank) has no path to judge: it is floored too (fail closed)."""

    def test_a_secret_under_every_local_spelling_is_refused_in_every_mode(self, classify, tmp_path):
        secret = tmp_path / "secrets" / "id_rsa"
        secret.parent.mkdir()
        secret.write_text("k")
        policy = {"secretPaths": [str(secret.parent)]}
        for url in (f"file://{secret}", f"FILE://{secret}", f"file://localhost{secret}", f"view-source:file://{secret}",
                    f"VIEW-SOURCE:file://{secret}", f"filesystem:file://{secret}", f"blob:file://{secret}",
                    f"view-source:filesystem:file://{secret}"):
            k = classify.classify("browser_navigate", {"url": url}, str(tmp_path), policy, session_id="s1")
            assert k.floor and k.floor.startswith("secrets"), (url, k)
            for mode in MODES:
                assert _decide(k, mode, ON).outcome == "refuse", (url, mode)

    def test_a_browsers_own_page_is_floored_and_the_web_is_not(self, classify, tmp_path):
        for url in ("chrome://version", "chrome://settings/passwords", "about:config", "view-source:chrome://version",
                    "devtools://devtools/bundled/inspector.html"):
            k = classify.classify("browser_navigate", {"url": url}, str(tmp_path), {}, session_id="s1")
            assert k.floor and k.floor.startswith("secrets"), (url, k)
        for url in ("https://example.com/", "http://example.com/x", "about:blank"):
            k = classify.classify("browser_navigate", {"url": url}, str(tmp_path), {}, session_id="s1")
            assert not k.floor and k.cls == "N", (url, k)


class TestBrowserExecIsCodeExecution:
    """Browser Use's ``browser_exec`` runs the agent's PYTHON on the host (V3-UP r3): it is read like execute_code —
    at least X and dangerous, and a spend or a message inside its code lifts it (it was N: Ignore and Automatic
    allowed arbitrary host code). In a process icloneOS confines it does not run at all (test_iclone_host_exec.py)."""

    def test_plain_browser_code_is_dangerous_shell(self, classify):
        k = classify.classify("browser_exec", {"code": "new_tab('https://example.com'); print(page_info())"}, "/tmp",
                              {}, session_id="s1")
        assert (k.cls, k.ceiling_key, k.facts.get("dangerous")) == ("X", "terminal", True)
        assert _decide(k, "automatic", ON).outcome == "ask" and _decide(k, "plan", ON).outcome == "refuse"

    def test_a_spend_inside_the_code_is_spend(self, classify):
        k = classify.classify("browser_exec", {"code": "import os; os.system('acp wallet send-transaction --to 0xabc "
                                                         "--amount 5')"}, "/tmp", {}, session_id="s1")
        assert k.cls == "$" and _decide(k, "ignore", ON).outcome == "ask"


# The agent's persistent state outside any project — Hermes' memory, its skills, the kanban board, the bundled memory
# providers' stores: a write there is Wo (asks in Automatic and in Accept edits, Plan refuses it). A row lowered to R
# or Wp (critic r2 m3: ``memory`` Wo → R survived the full permission set) turns this red.
STATE_WRITERS = ("memory", "skill_manage", "kanban_create", "kanban_comment", "kanban_complete", "kanban_schedule",
                 "desktop_project", "browser_vault_save_login", "brv_curate", "fact_store", "fact_feedback",
                 "retaindb_remember", "retaindb_forget", "retaindb_ingest_file", "retaindb_delete_file",
                 "retaindb_upload_file", "viking_remember", "viking_forget", "viking_add_resource")


class TestTheAgentsOwnStateIsWrittenOutsideTheProject:
    @pytest.mark.parametrize("name", STATE_WRITERS)
    def test_a_state_writer_is_wo_and_asks_where_an_outside_write_asks(self, classify, name):
        k = classify.classify(name, {"action": "add", "content": "x"}, "/tmp", {}, session_id="s1")
        assert (k.cls, k.ceiling_key) == ("Wo", "fileWriting"), name
        assert _decide(k, "automatic", ON).outcome == "ask"
        assert _decide(k, "acceptEdits", ON).outcome == "ask"
        assert _decide(k, "plan", ON).outcome == "refuse"
        assert _decide(k, "ignore", dict(ON, fileWriting="off")).outcome == "refuse"

    def test_every_state_writer_is_named_here(self, classify):
        """A new Wo row must be added above (and so pinned); a removed one fails the parametrization."""
        wo = {n for n, v in classify.TOOL_CLASSES.items() if v[0] == "Wo"}
        kanban_writes = {n for n in wo if n.startswith("kanban_")}
        assert wo - kanban_writes == set(STATE_WRITERS) - kanban_writes


# A memory provider's QUERY sends the agent's text to the provider (a remote service or a local CLI holding a
# credential): N, never the GET-only kind, so Plan refuses it and Manual asks (critic r3 m2: ``retaindb_search`` N → R
# survived every suite; the writers were pinned, the queries were not).
PROVIDER_QUERIES = ("brv_query", "retaindb_profile", "retaindb_search", "retaindb_context", "retaindb_list_files",
                    "retaindb_read_file", "viking_search", "viking_read", "viking_browse")


class TestAMemoryProvidersQueryIsNetwork:
    @pytest.mark.parametrize("name", PROVIDER_QUERIES)
    def test_a_provider_query_is_n_and_plan_refuses_it(self, classify, name):
        k = classify.classify(name, {"query": "what did I say about my bank"}, "/tmp", {}, session_id="s1")
        assert (k.cls, k.ceiling_key, k.facts.get("getOnly")) == ("N", "webBrowsing", False), name
        assert _decide(k, "plan", ON).outcome == "refuse"
        assert _decide(k, "manual", ON).outcome == "ask"
        assert _decide(k, "ignore", dict(ON, webBrowsing="off")).outcome == "refuse"

    def test_every_memory_provider_query_is_named_here(self, universe, classify):
        memory = set(universe["memory"])
        queries = {n for n in memory if classify.TOOL_CLASSES[n][0] == "N"}
        assert queries == set(PROVIDER_QUERIES)


class TestAnUnknownToolIsTheStrictestClass:
    @pytest.mark.parametrize("name", ["a_tool_nobody_registered", "mcp__stripe__create_charge",
                                      "connectors__gmail__send_email", "a_user_memory_provider_tool"])
    def test_it_asks_in_every_mode_and_plan_refuses_it(self, classify, name):
        k = classify.classify(name, {"amount": 5}, "/tmp", {}, session_id="s1")
        assert (k.cls, k.ceiling_key) == classify.UNKNOWN_TOOL_CLASS == ("$", "spendTrade")
        assert "unclassified tool" in k.target
        on = {"spendTrade": "on", "terminal": "on"}
        for mode in ("ignore", "manual", "automatic", "acceptEdits"):
            assert _decide(k, mode, on).outcome == "ask", mode
        assert _decide(k, "plan", on).outcome == "refuse"
        assert _decide(k, "ignore", {"spendTrade": "off", "terminal": "on"}).outcome == "refuse"

    def test_no_grant_lifts_it(self, classify):
        k = classify.classify("a_tool_nobody_registered", {}, "/tmp", {}, session_id="s1")
        grant = {"id": "g1", "cls": k.cls, "scope": "standing"}
        assert _decide(k, "manual", {"spendTrade": "on"}, [grant]).outcome == "ask"
