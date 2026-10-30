"""V3-F2 — per-function levels in the Hermes plugin (contract RESUME/contracts/V3F2_function_levels.md).

F2-1 the vocabulary equals the TypeScript source (tests/fixtures/functions.json, written by functions.test.ts);
F2-2 every row at ``mode`` is exactly V3-F; F2-3 the level semantics replay the fixture case by case; F2-4 the
strictest candidate decides; F2-5 the mapping module (every registered tool, the shell tables, fail closed);
F2-7 every floor refuses at every level of every function; F2-10 the real hook end to end with a fake main.

Floors are exercised structurally (a placeholder floor reason) and through structured tools with placeholder paths and
a synthetic guard pid — no refused command spelling lives in this file beyond those placeholders.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.plugins.test_iclone_permissions import (  # noqa: F401
    FIXTURE, INFT, KEY, KID, MODES, CLASSES, FakeMain, _body, _events, _isolated, _load, _spawn_env,
    _write_policy, plugin, wired,
)
from tests.plugins.test_iclone_permissions import PLUGIN_DIR

MONEY = ("payments", "trading", "shopping", "acp")
MESSAGES = ("email", "messaging")
FN_FIXTURE = json.loads((PLUGIN_DIR / "tests" / "fixtures" / "functions.json").read_text())
FUNCTIONS = FN_FIXTURE["functions"]
LEVELS = FN_FIXTURE["levels"]
CEILING_KEYS = ("terminal", "fileWriting", "webBrowsing", "automation", "screen", "clipboard", "installSoftware",
                "scheduledTasks", "sendMessages", "spendTrade")


def _ceilings(value):
    return {k: value for k in CEILING_KEYS}


def _policy(plugin_mod):
    from hermes_plugins.iclone_permissions import policy

    return policy


def _decide(policy, body, cls, facts=None, floor=None, fns=("shell",)):
    return policy.decide(body, cls=cls, facts=facts or {}, floor=floor, ceiling_key=None, session_id="s1",
                         project="/lab/proj", lineage=None, fns=fns)


def _fns_of(mask):
    return tuple(fn for i, fn in enumerate(FUNCTIONS) if mask & (1 << i))


def _xorshift32(seed):
    """The parts table's generator (functions.test.ts `xorshift32`, same steps on 32-bit words)."""
    state = [(seed & 0xFFFFFFFF) or 1]

    def r(n):
        x = state[0]
        x ^= (x << 13) & 0xFFFFFFFF
        x ^= x >> 17
        x ^= (x << 5) & 0xFFFFFFFF
        state[0] = x
        return x % n

    return r


def _parts_cases(table):
    """The same cases, in the same order, as functions.test.ts `partsCases` (draw order is part of the contract)."""
    order = FN_FIXTURE["order"]
    r = _xorshift32(table["seed"])
    classes, facts, ceilings = order["classes"], order["factSets"], table["ceilings"]

    def term():
        return {"cls": classes[r(len(classes))], "facts": facts[r(len(facts))],
                "floor": table["floor"] if r(10) == 0 else None, "ceiling": ceilings[r(len(ceilings))],
                "mask": r(512)}

    for _ in range(table["count"]):
        mode = order["modes"][r(len(order["modes"]))]
        levels = {fn: LEVELS[r(len(LEVELS))] for fn in FUNCTIONS}
        line = term()
        parts = [term() for _ in range(r(4))]
        for part in parts:
            line["mask"] |= part["mask"]
        granted_classes = [c for c in classes if r(6) == 0 and c != "$"]
        granted_fns = [fn for fn in FUNCTIONS if r(6) == 0]
        unread = r(5) == 0
        yield mode, levels, line, parts, granted_classes, granted_fns, unread


# ---------------------------------------------------------------------------------------------------
# F2-1 / F2-3 — the fixture
# ---------------------------------------------------------------------------------------------------

class TestF2Vocabulary:
    def test_f2_1_the_plugin_speaks_the_typescript_vocabulary(self, plugin):
        policy = _policy(plugin)
        assert list(policy.FUNCTIONS) == FN_FIXTURE["functions"]
        assert list(policy.LEVELS) == FN_FIXTURE["levels"]
        assert policy.LEVEL_CELLS == FN_FIXTURE["levelCells"]

    def test_r2_m6_the_pane_knows_every_switch_a_row_can_meet(self, plugin):
        # each structured tool's switch is on its row's list; a shell line's class switches and the unknown tool's
        # switch are on every row's list; the text tools' own switches are on the Shell row's list
        from hermes_plugins.iclone_permissions import functions as m
        from hermes_plugins.iclone_permissions.classify import CLASS_RULES, TOOL_CLASSES

        keys = FN_FIXTURE["ceilingKeys"]
        rows = {"messaging": m._MESSAGING_TOOLS | {"send_message"}, "email": {"send_message"},
                "files": m._FILE_TOOLS, "publish": m._PUBLISH_TOOLS, "shell": m._SHELL_TOOLS}
        for fn, tools in rows.items():
            for tool in tools:
                key = TOOL_CLASSES[tool][1]
                assert key is None or key in keys[fn], (fn, tool, key)
        line = {key for _cls, key, _rule in CLASS_RULES} | {TOOL_CLASSES.get("a_tool_nobody_registered",
                                                                              ("X", "terminal"))[1]}
        for fn in FUNCTIONS:
            assert line <= set(keys[fn]), fn

    def test_r2_m1_main_knows_the_same_text_tools(self, plugin):
        # main re-applies the class coverage (authority.ts parsePluginCall) with the same list of text tools
        from hermes_plugins.iclone_permissions.functions import _SHELL_TOOLS

        assert sorted(_SHELL_TOOLS) == FN_FIXTURE["shellTextTools"]

    def test_r3_mono_the_coverage_rule_is_mains_rule(self, plugin):
        # R3-MONO: one coverage + family-closure rule, held equal to main's coverFunctions over every tool of the
        # table × every class × every subset of the nine rows (fixture `coverCodes`, written by functions.test.ts)
        from hermes_plugins.iclone_permissions.functions import cover

        codes, i, diffs = FN_FIXTURE["coverCodes"], 0, []
        for tool in FN_FIXTURE["coverTools"]:
            for cls in FN_FIXTURE["order"]["classes"]:
                for mask in range(512):
                    got = sum(1 << FUNCTIONS.index(fn) for fn in cover(tool, cls, _fns_of(mask)))
                    if got != int(codes[2 * i:2 * i + 2], 36):
                        diffs.append((tool, cls, _fns_of(mask), _fns_of(got), _fns_of(int(codes[2 * i:2 * i + 2], 36))))
                    i += 1
        assert 2 * i == len(codes) == 2 * 7 * 10 * 512
        assert diffs[:5] == []

    def test_r3_mono_a_row_decides_on_the_line_and_every_part_like_main(self, plugin):
        # R3-MONO: the decision over a line and its parts (each with its own class, facts, floor, switch and class
        # grant) equals main's decideFunctions on the seeded table (fixture `parts`, the same xorshift32 cases)
        policy = _policy(plugin)
        from hermes_plugins.iclone_permissions.functions import Functions, Part

        table = FN_FIXTURE["parts"]
        legend = {v: k for k, v in FN_FIXTURE["codeLegend"].items()}
        diffs = []
        for n, case in enumerate(_parts_cases(table)):
            mode, levels, line, parts, classes, fns_granted, unread = case
            ceilings = {"kL": line["ceiling"], **{f"k{i}": part["ceiling"] for i, part in enumerate(parts)}}
            body = _body(standing=mode, functions=levels, ceilings=ceilings,
                         grants=[{"id": f"g{c}", "cls": c, "scope": "standing"} for c in classes],
                         fnGrants=[{"id": f"f{fn}", "fn": fn, "scope": "standing"} for fn in fns_granted])
            fns = Functions(_fns_of(line["mask"]), [
                Part(part["cls"], tuple(sorted(part["facts"].items())), part["floor"], f"k{i}", _fns_of(part["mask"]))
                for i, part in enumerate(parts)], True, unread=unread)
            v = policy.decide(body, cls=line["cls"], facts=line["facts"], floor=line["floor"], ceiling_key="kL",
                              session_id="s1", project=None, lineage=None, fns=fns)
            want = table["codes"][2 * n:2 * n + 2]
            got = (v.outcome + "/" + v.rule, str(FUNCTIONS.index(v.fn)) if v.fn else "-")
            if got != (legend[want[0]], want[1]):
                diffs.append((n, got, (legend[want[0]], want[1])))
        assert 2 * table["count"] == len(table["codes"])
        assert diffs[:5] == []

    def test_r3_u_main_knows_the_same_no_function_tools(self, plugin):
        # main treats an empty list from any other tool as every function (R3-U): the two lists are one list
        from hermes_plugins.iclone_permissions.functions import _NO_FUNCTION

        assert sorted(_NO_FUNCTION) == FN_FIXTURE["noFunctionTools"]

    def test_f2_3_every_case_of_the_fixture_decides_the_same_in_python(self, plugin):
        policy = _policy(plugin)
        order = FN_FIXTURE["order"]
        legend = {v: k for k, v in FN_FIXTURE["codeLegend"].items()}
        codes = FN_FIXTURE["codes"]
        i, diffs = 0, []
        for level in order["levels"]:
            for mode in order["modes"]:
                for cls in order["classes"]:
                    for facts in order["factSets"]:
                        for ceiling in order["ceilings"]:
                            for floor in order["floors"]:
                                for class_grant, fn_grant in order["grants"]:
                                    body = _body(
                                        standing=mode, ceilings=_ceilings(ceiling), functions={"shell": level},
                                        grants=[{"id": "g1", "cls": cls, "scope": "standing"}] if class_grant and cls != "$" else [],
                                        fnGrants=[{"id": "fg1", "fn": "shell", "scope": "standing"}] if fn_grant else [],
                                    )
                                    v = _decide(policy, body, cls, facts, floor)
                                    got = f"{v.outcome}/{v.rule}"
                                    if got != legend[codes[i]]:
                                        diffs.append((level, mode, cls, facts, ceiling, floor, class_grant, fn_grant, got,
                                                      legend[codes[i]]))
                                    i += 1
        assert i == len(codes) == 50_400
        assert diffs[:5] == []


# ---------------------------------------------------------------------------------------------------
# F2-2 / F2-4
# ---------------------------------------------------------------------------------------------------

FACTS81 = [{k: v for k, v in zip(("dangerous", "getOnly", "inProject", "privileged"), combo) if v is not None}
           for combo in __import__("itertools").product((None, False, True), repeat=4)]


class TestF2DefaultIsV3F:
    def test_f2_2_all_rows_at_mode_equal_v3f_on_every_case(self, plugin):
        policy = _policy(plugin)
        sets = [(), *[(fn,) for fn in FUNCTIONS], ("email", "shell"), tuple(FUNCTIONS)]
        cases, diffs = 0, []
        for mode in MODES:
            for cls in CLASSES:
                for facts in FACTS81:
                    for ceiling in ("on", "off", "undecided"):
                        for floor in (None, "floor: placeholder"):
                            for granted in (False, True):
                                body = _body(standing=mode, ceilings=_ceilings(ceiling),
                                             functions={fn: "mode" for fn in FUNCTIONS},
                                             grants=[{"id": "g1", "cls": cls, "scope": "standing"}] if granted else [],
                                             fnGrants=[{"id": "fg1", "fn": fn, "scope": "standing"} for fn in FUNCTIONS])
                                base = policy.decide(body, cls=cls, facts=facts, floor=floor, ceiling_key=None,
                                                     session_id="s1", project=None)
                                for fns in sets:
                                    v = _decide(policy, body, cls, facts, floor, fns)
                                    cases += 1
                                    if (v.outcome, v.rule, v.grant_id) != (base.outcome, base.rule, base.grant_id):
                                        diffs.append((mode, cls, facts, ceiling, floor, granted, fns))
        assert diffs[:5] == []
        assert cases >= 38_000

    def test_f2_4_a_candidate_never_loosens(self, plugin):
        policy = _policy(plugin)
        sev = {"allow": 0, "ask": 1, "refuse": 2}
        trio = ("email", "payments", "shell")
        violations = checks = 0
        for a in LEVELS:
            for b in LEVELS:
                for c in LEVELS:
                    body = _body(standing="automatic", functions=dict(zip(trio, (a, b, c))))
                    for cls in ("$", "M", "X"):
                        for base in (("email",), ("payments",), ("shell",), ("email", "payments")):
                            for extra in trio:
                                checks += 1
                                if sev[_decide(policy, body, cls, {}, None, base + (extra,)).outcome] < \
                                        sev[_decide(policy, body, cls, {}, None, base).outcome]:
                                    violations += 1
        assert checks == 216 * 3 * 4 * 3
        assert violations == 0

    @pytest.mark.parametrize("first", ["mode", "askOnce", "askAlways"])
    @pytest.mark.parametrize("second", ["mode", "askOnce", "askAlways"])
    def test_r2_m4_an_ask_tie_goes_to_the_stricter_level(self, plugin, first, second):
        policy = _policy(plugin)
        rank = ["mode", "askOnce", "askAlways"].index
        v = _decide(policy, _body(standing="manual", functions={"email": first, "shell": second}), "M", {}, None,
                    ("email", "shell"))
        assert v.outcome == "ask"
        assert (v.fn, v.level) == (("shell", second) if rank(second) > rank(first) else ("email", first))

    def test_without_a_signed_body_levels_cannot_widen(self, plugin):
        policy = _policy(plugin)
        v = policy.decide(None, cls="$", facts={}, floor=None, ceiling_key=None, session_id=None, project=None,
                          fns=("payments",))
        assert (v.outcome, v.rule, v.mode) == ("ask", "unsigned", "manual")

    def test_an_unknown_level_in_the_body_is_ask_always(self, plugin):
        policy = _policy(plugin)
        body = _body(functions={"payments": "root"}, fnGrants=[{"id": "fg", "fn": "payments", "scope": "standing"}])
        assert _decide(policy, body, "$", fns=("payments",)).outcome == "ask"


# ---------------------------------------------------------------------------------------------------
# F2-5 — the mapping module
# ---------------------------------------------------------------------------------------------------

def _fns(tool, args, cwd="/tmp"):
    from hermes_plugins.iclone_permissions.classify import classify
    from hermes_plugins.iclone_permissions.functions import functions_of

    return functions_of(tool, args, classify(tool, args, cwd, {}))


SHELL_CASES = [
    ("agentcard email send --to a@example.invalid --subject s", ("email",)),
    ("agentcard email reply --id 1", ("email",)),
    ("agentcard card create --amount 5", ("shopping",)),
    ("agentcard checkout --merchant m", ("shopping",)),
    ("agentcard wallet fetch https://example.invalid/x", ("payments",)),
    ("agentcard card create --memo wallet", ("payments", "shopping")),
    ("npx agentcard wallet send 1", ("payments",)),
    ("onchainos swap execute --from a --to b", ("trading",)),
    ("onchainos bridge send", ("trading",)),
    ("onchainos wallet send --to x", ("payments",)),
    ("onchainos payment pay", ("payments",)),
    ("privy wallets send", ("payments",)),
    ("cast send 0x0 --value 1", ("payments",)),
    ("acp trade hl-order --size 1", ("trading",)),
    ("acp --inft i01 trade hl-order", ("trading",)),
    ("acp client fund --job 1", ("acp",)),
    ("acp provider submit --job 1", ("acp",)),
    ("acp wallet topup 1", ("payments",)),
    ("acp message send --to x", ("messaging",)),
    ("acp email compose --to x", ("email",)),
    ("acp client fund --job 1 trade", ("trading", "acp")),
    ("git push origin main", ("publish",)),
    ("git -C repo push", ("shell", "publish")),
    ("git status", ("shell",)),
    ("npm publish", ("publish",)),
    ("pnpm publish --access public", ("publish",)),
    ("gh release create v1", ("publish",)),
    ("gh pr create --fill", ("publish",)),
    ("vercel --prod", ("publish",)),
    ("docker push img", ("publish",)),
    ("scp a host:b", ("publish",)),
    ("curl -d x=1 https://example.invalid", ("publish",)),
    ("curl -X POST https://example.invalid", ("publish",)),
    ("curl https://example.invalid", ("shell",)),
    ("rm -rf build", ("files",)),
    ("cp a b", ("files",)),
    ("mv a b", ("files",)),
    ("mkdir -p out", ("files",)),
    ("ls -la", ("shell",)),
    ("python3 -c 'print(1)'", ("shell",)),
    ("agentcard email send --to a@example.invalid; ls", ("email", "shell")),
    # piped data into a money CLI is an unknown consumer: the line has a Shell part (the class adds rows, see below)
    ("ls | agentcard email send --stdin", ("email", "shell")),
    ("", ("shell",)),
]

STRUCTURED_CASES = [
    ("send_message", {"target": "email:a@example.invalid", "message": "hi"}, ("email",)),
    ("send_message", {"target": "telegram", "message": "hi"}, ("messaging",)),
    ("send_message", {"target": "x:@someone", "message": "hi"}, ("messaging",)),
    ("discord", {"action": "send"}, ("messaging",)),
    ("react_to_message", {}, ("messaging",)),
    ("a2a_call", {}, ("messaging",)),
    ("write_file", {"path": "/tmp/proj/a.txt", "content": "x"}, ("files",)),
    ("patch", {"path": "/tmp/proj/a.txt"}, ("files",)),
    ("memory", {"action": "add"}, ("files",)),
    ("kanban_create", {}, ("files",)),
    ("browser_click", {}, ("publish",)),
    ("browser_type", {}, ("publish",)),
    ("browser_navigate", {"url": "https://example.invalid"}, ()),
    ("web_search", {"query": "q"}, ()),
    ("read_file", {"path": "/tmp/a"}, ()),
    ("computer_use", {}, ()),
    ("setup_mcp", {}, ()),
    ("image_generate", {}, ()),
    ("execute_code", {"code": "print(1)"}, ("shell",)),
    ("cronjob", {}, ("shell",)),
    ("process", {"action": "submit", "session_id": "s", "data": "ls"}, ("shell",)),
    # R2-M3: process input gets the same tables as terminal text (Shell stays)
    ("process", {"action": "submit", "session_id": "s", "data": "git push origin main"}, ("shell", "publish")),
    ("process", {"action": "write", "session_id": "s", "data": "rm -rf build"}, ("shell", "files")),
    ("process", {"action": "kill", "session_id": "s"}, ("shell",)),
    ("terminal", {"cmd": "git push origin main"}, ("publish",)),
    # R2-M1: a tool the mapping does not know (a dynamic `mcp_*` tool, a future tool) is every function
    ("mcp_unknown_server_tool", {}, ("email", "payments", "trading", "shopping", "acp", "messaging", "shell", "files",
                                     "publish")),
    ("a_tool_nobody_registered", {}, ("email", "payments", "trading", "shopping", "acp", "messaging", "shell", "files",
                                      "publish")),
]


class TestF2Mapping:
    def test_f2_5_every_registered_tool_is_mapped_explicitly(self, plugin):
        from hermes_plugins.iclone_permissions import functions as m
        from hermes_plugins.iclone_permissions.classify import TOOL_CLASSES

        # V3-UP r3: the Tool Search lookups and the memory providers' queries have a no-function list of their own
        tables = (m._MESSAGING_TOOLS, m._FILE_TOOLS, m._PUBLISH_TOOLS, m._SHELL_TOOLS, m._NO_FUNCTION,
                  m._NO_FUNCTION_PROVIDER_READS)
        missing = [t for t in TOOL_CLASSES if t != "send_message" and not any(t in table for table in tables)]
        doubled = [t for t in TOOL_CLASSES if sum(t in table for table in tables) > 1]
        assert missing == [] and doubled == []
        assert len(TOOL_CLASSES) >= 90  # 99 at V3-F 8567724f64

    @pytest.mark.parametrize("command,expected", SHELL_CASES, ids=[f"sh{i}" for i in range(len(SHELL_CASES))])
    def test_f2_5_shell_lines(self, plugin, command, expected):
        # the word tables (attribution); the class then only ADDS rows (test_f2_5_text_coverage_*)
        from hermes_plugins.iclone_permissions.functions import _ordered, _shell_text_functions

        assert _ordered(_shell_text_functions(command)) == expected

    @pytest.mark.parametrize("command,expected", SHELL_CASES, ids=[f"shc{i}" for i in range(len(SHELL_CASES))])
    def test_f2_5_shell_lines_through_the_classifier(self, plugin, command, expected):
        from hermes_plugins.iclone_permissions.classify import classify
        from hermes_plugins.iclone_permissions.functions import functions_of

        call = classify("terminal", {"command": command}, "/tmp", {})
        got = set(functions_of("terminal", {"command": command}, call))
        assert set(expected) <= got  # the attributed rows always decide
        if call.cls == "$":
            assert set(MONEY) <= got
        if call.cls == "M":
            assert set(MESSAGES) <= got
        if call.cls in ("$", "M") and "shell" in got:
            assert set(MONEY + MESSAGES) <= got
        extra = got - set(expected) - {"shell"}
        assert extra <= set(MONEY + MESSAGES + ("files",)), (call.cls, got)

    @pytest.mark.parametrize("tool,args,expected", STRUCTURED_CASES,
                             ids=[f"st{i}" for i in range(len(STRUCTURED_CASES))])
    def test_f2_5_structured_tools(self, plugin, tool, args, expected):
        assert _fns(tool, args) == expected

    def test_f2_5_class_coverage_and_fail_closed(self, plugin):
        from hermes_plugins.iclone_permissions.functions import functions_of

        # a `$`/`M` line with a Shell part: the money AND message rows join for that part (R2-M2)
        assert functions_of("terminal", {"command": "ls"}, SimpleNamespace(cls="$", unknown=False)) == \
            ("email", "payments", "trading", "shopping", "acp", "messaging", "shell")
        assert functions_of("terminal", {"command": "ls"}, SimpleNamespace(cls="M", unknown=False)) == \
            ("email", "payments", "trading", "shopping", "acp", "messaging", "shell")
        assert functions_of("terminal", {"command": "ls"}, SimpleNamespace(cls="D", unknown=False)) == \
            ("shell", "files")
        # a structured tool whose name pins another row still reaches a class it does not name
        assert functions_of("browser_click", {}, SimpleNamespace(cls="$", unknown=False)) == \
            ("payments", "trading", "shopping", "acp", "publish")
        assert functions_of("browser_click", {}, SimpleNamespace(cls="M", unknown=False)) == \
            ("email", "messaging", "publish")
        assert functions_of("browser_click", {}, SimpleNamespace(cls="D", unknown=False)) == ("files", "publish")
        assert functions_of("terminal", {"command": "rm a"}, SimpleNamespace(cls="R", unknown=False)) == ()
        # the classifier's unknown adds Shell to a line it attributes elsewhere
        assert functions_of("terminal", {"command": "rm a"}, SimpleNamespace(cls="D", unknown=True)) == \
            ("shell", "files")

    @pytest.mark.parametrize("cls,family", [("$", MONEY), ("M", MESSAGES)])
    def test_f2_5_text_coverage_family_whatever_row_the_words_name(self, plugin, cls, family):
        # R2-M2 family: a fully attributed `$`/`M` line (one row named, no Shell part) is still decided by its family
        from hermes_plugins.iclone_permissions import functions as m

        for named in family:
            got = m.cover("terminal", cls, {named})
            assert set(family) <= set(got) and "shell" not in got, (named, got)

    @pytest.mark.parametrize("cls", ["$", "M"])
    @pytest.mark.parametrize("named", ["email", "payments", "publish", "files"])
    def test_f2_5_text_coverage_per_part(self, plugin, cls, named):
        # R2-M2 per part: a Shell part beside ANY attributed part adds every money and message row
        from hermes_plugins.iclone_permissions import functions as m

        got = set(m.cover("terminal", cls, {named, "shell"}))
        assert set(MONEY + MESSAGES) <= got

    def test_f2_5_text_coverage_leaves_other_classes_alone(self, plugin):
        from hermes_plugins.iclone_permissions import functions as m

        assert m.cover("terminal", "X", {"shell"}) == ("shell",)
        assert m.cover("terminal", "X", {"publish"}) == ("publish",)
        assert m.cover("terminal", "D", {"shell"}) == ("shell", "files")

    def test_f2_5_a_runner_path_is_folded_to_the_money_program(self, plugin):
        # R2-M2: the normaliser's output for a script runner + install path (placeholder argv) reads as the CLI
        from hermes_plugins.iclone_permissions.classify import _MONEY_PROGS
        from hermes_plugins.iclone_permissions.functions import program_functions

        for word in sorted(_MONEY_PROGS):
            for runner in ("node", "bun", "deno"):
                cmd = SimpleNamespace(prog=runner, args=["--flag", f"./lib/{word}/dist/main.js", "placeholder"],
                                      runner="", code=[], unresolvable=False)
                bare = SimpleNamespace(prog=word, args=["placeholder"], runner="", code=[], unresolvable=False)
                assert program_functions(cmd) == program_functions(bare) != {"shell"}, (runner, word)
        plain = SimpleNamespace(prog="node", args=["./lib/tool/main.js"], runner="", code=[], unresolvable=False)
        assert program_functions(plain) == {"shell"}

    def test_f2_5_the_mapper_never_changes_the_classifier_verdict(self, plugin):
        from hermes_plugins.iclone_permissions.classify import classify
        from hermes_plugins.iclone_permissions.functions import functions_of

        for command, _ in SHELL_CASES:
            call = classify("terminal", {"command": command}, "/tmp", {})
            before = (call.cls, dict(call.facts), call.floor, call.unknown, call.target)
            functions_of("terminal", {"command": command}, call)
            assert (call.cls, dict(call.facts), call.floor, call.unknown, call.target) == before

    def test_f2_5_a_mapper_crash_is_all_nine(self, plugin, monkeypatch):
        from hermes_plugins.iclone_permissions import functions as m

        def boom(*_a, **_k):
            raise RuntimeError("x")

        monkeypatch.setattr(m, "_shell_text_functions", boom)
        assert m.functions_of("terminal", {"command": "ls"}, SimpleNamespace(cls="X", unknown=False)) == tuple(FUNCTIONS)


# ---------------------------------------------------------------------------------------------------
# Critic r1 probes (RESUME/run.nosync/scratch/V3F2_critic_r1_probes/): each one refuses or asks
# ---------------------------------------------------------------------------------------------------

def _real(tool, args):
    from hermes_plugins.iclone_permissions.classify import classify
    from hermes_plugins.iclone_permissions.functions import functions_of

    call = classify(tool, args, "/tmp", {})
    return call, functions_of(tool, args, call)


def _probe_decide(policy, body, call, fns):
    return policy.decide(body, cls=call.cls, facts=dict(call.facts), floor=call.floor, ceiling_key=None,
                         session_id="s1", project="/lab/proj", lineage=None, fns=fns)


class TestF2CriticR1Probes:
    def test_pr1_an_unknown_tool_never_lands_on_a_lone_shell_row(self, plugin):
        # every money/message row Manual, Shell Ignore: a placeholder MCP-style tool is decided by every row
        policy = _policy(plugin)
        call, fns = _real("mcp_placeholdersrv_placeholder_action", {"amount": "1"})
        body = _body(standing="manual", functions={**{f: "manual" for f in FUNCTIONS}, "shell": "ignore"})
        assert fns == tuple(FUNCTIONS)
        assert _probe_decide(policy, body, call, fns).outcome == "refuse"

    @pytest.mark.parametrize("level,want", [("ignore", "allow"), ("askAlways", "ask"), ("manual", "refuse")])
    def test_pr1_each_row_reaches_an_unknown_tool(self, plugin, level, want):
        policy = _policy(plugin)
        call, fns = _real("a_placeholder_tool_v9", {})
        for fn in FUNCTIONS:
            body = _body(standing="manual", functions={**{f: "ignore" for f in FUNCTIONS}, fn: level})
            v = _probe_decide(policy, body, call, fns)
            assert v.outcome == want, (fn, level, v)
            if want != "allow":
                assert v.fn == fn


    def test_pr2_a_dollar_line_naming_one_money_row_reaches_every_money_row(self, plugin):
        policy = _policy(plugin)
        from hermes_plugins.iclone_permissions.functions import functions_of

        line = SHELL_CASES[4][0]  # the payments-row line of the table
        fns = functions_of("terminal", {"command": line}, SimpleNamespace(cls="$", unknown=False))
        body = _body(standing="manual", functions={**{f: "ignore" for f in FUNCTIONS}, "trading": "manual",
                                                   "shopping": "manual", "acp": "manual"})
        assert _decide(policy, body, "$", {}, None, fns).outcome != "allow"

    def test_pr2b_an_m_line_naming_email_reaches_messaging(self, plugin):
        policy = _policy(plugin)
        from hermes_plugins.iclone_permissions.functions import functions_of

        line = SHELL_CASES[0][0]  # the email-row line of the table
        fns = functions_of("terminal", {"command": line}, SimpleNamespace(cls="M", unknown=False))
        body = _body(standing="manual", functions={**{f: "ignore" for f in FUNCTIONS}, "messaging": "manual"})
        assert _decide(policy, body, "M", {}, None, fns).outcome != "allow"

    def test_pr2r_prepending_an_attributed_read_never_loosens_a_runner_spend(self, plugin):
        # the critic's real line (runner + install path) alone, and after a payments-row read
        policy = _policy(plugin)
        part = "node ./node_modules/onchainos/dist/cli.js swap execute --from a --to b"
        lead = "agentcard wallet balance"
        body = _body(standing="manual", functions={**{f: "ignore" for f in FUNCTIONS}, "trading": "manual"})
        alone_call, alone = _real("terminal", {"command": part})
        both_call, both = _real("terminal", {"command": f"{lead}; {part}"})
        va = _probe_decide(policy, body, alone_call, alone)
        vb = _probe_decide(policy, body, both_call, both)
        assert "trading" in alone and "trading" in both
        assert va.outcome == vb.outcome == "refuse"


    def test_pr8_process_input_reaches_the_row_terminal_reaches(self, plugin):
        policy = _policy(plugin)
        line = "git push origin main"  # a SHELL_CASES publish line
        body = _body(standing="manual", functions={**{f: "ignore" for f in FUNCTIONS}, "publish": "manual"})
        t_call, t_fns = _real("terminal", {"command": line})
        p_call, p_fns = _real("process", {"action": "submit", "session_id": "s-probe", "data": line})
        vt, vp = _probe_decide(policy, body, t_call, t_fns), _probe_decide(policy, body, p_call, p_fns)
        assert vt.outcome == vp.outcome == "refuse" and vp.fn == "publish"

    def test_pr8_a_line_typed_in_pieces_is_mapped_whole(self, plugin):
        # the pending input the classifier keeps for the session is part of the text the mapper reads
        from hermes_plugins.iclone_permissions.classify import commit_process_input

        commit_process_input({"action": "write", "session_id": "s-pieces", "data": "git pu"})
        try:
            _, fns = _real("process", {"action": "submit", "session_id": "s-pieces", "data": "sh origin main"})
            assert "publish" in fns
        finally:
            commit_process_input({"action": "submit", "session_id": "s-pieces", "data": ""})


# ---------------------------------------------------------------------------------------------------
# R3-MONO — decision is monotone in parts (critic r2 C2-1 and the class of another part)
# ---------------------------------------------------------------------------------------------------

# The critic r2 probe lines (V3F2_critic_r2_probes, all from SHELL_CASES): two spend lines and three message lines.
R2_SPEND = (SHELL_CASES[7][0], SHELL_CASES[13][0])
R2_MESSAGE = ((SHELL_CASES[18][0], "email"), (SHELL_CASES[0][0], "messaging"), (SHELL_CASES[19][0], "messaging"))


def _line(body, tool, args, cwd="/tmp"):
    """One call through the classifier, the mapper and the decision (R5-K: no clock anywhere in it)."""
    from hermes_plugins.iclone_permissions import policy
    from hermes_plugins.iclone_permissions.classify import classify
    from hermes_plugins.iclone_permissions.functions import functions_of

    call = classify(tool, args, cwd, body)
    fns = functions_of(tool, args, call, cwd=cwd, policy=body)
    return call, fns, policy.decide(body, cls=call.cls, facts=dict(call.facts), floor=call.floor,
                                    ceiling_key=call.ceiling_key, session_id="s1", project=call.project, fns=fns)


class TestF2R3Monotone:
    @pytest.mark.parametrize("standing", ["manual", "ignore", "automatic", "plan"])
    @pytest.mark.parametrize("message,strict", R2_MESSAGE, ids=["msgM-email", "msgE-messaging", "msgE2-messaging"])
    @pytest.mark.parametrize("spend", R2_SPEND, ids=["spend1", "spend2"])
    @pytest.mark.parametrize("order", ["spend-first", "message-first"])
    def test_c2_1_a_message_part_keeps_both_message_rows_beside_a_spend(self, plugin, standing, message, strict, spend,
                                                                         order):
        # C2-1 (M-2 category, mixed family): alone the message line is refused (one message row at Manual, the rest
        # at Ignore); joined with a spend part, in either order, it is still refused
        body = _body(standing=standing, functions={**{f: "ignore" for f in FUNCTIONS}, strict: "manual"})
        _, fa, va = _line(body, "terminal", {"command": message})
        joined = f"{spend}; {message}" if order == "spend-first" else f"{message}; {spend}"
        _, fb, vb = _line(body, "terminal", {"command": joined})
        assert va.outcome == "refuse" and set(MESSAGES) <= set(fa)
        assert vb.outcome == "refuse" and set(MESSAGES + MONEY) <= set(fb), (fb, vb)

    def test_r3_a_part_decides_with_its_own_class(self, plugin):
        # Shell at Automatic asks for code (a dangerous X part); a spend part beside it gives the whole line `$`
        # (Automatic's `$` cell is clean ⇒ allow). The code part still decides with its own class: ask.
        code = SHELL_CASES[39][0]
        body = _body(standing="manual", functions={**{f: "ignore" for f in FUNCTIONS}, "shell": "automatic"})
        ca, _, va = _line(body, "terminal", {"command": code})
        cb, fb, vb = _line(body, "terminal", {"command": f"{code}; {R2_SPEND[0]}"})
        assert (ca.cls, va.outcome) == ("X", "ask")
        assert cb.cls == "$" and vb.outcome == "ask" and vb.fn == "shell", (fb.parts, vb)

    def test_r3_an_empty_part_is_still_shell(self, plugin):
        # an empty segment is a line with no command: Shell (fail closed), alone and as a part
        body = _body(standing="manual", functions={**{f: "ignore" for f in FUNCTIONS}, "shell": "manual"})
        _, _, va = _line(body, "terminal", {"command": ""})
        _, fb, vb = _line(body, "terminal", {"command": "; " + SHELL_CASES[21][0]})
        assert va.outcome == vb.outcome == "refuse" and "shell" in fb

    def test_r3_the_parts_are_read_only_when_a_level_is_set(self, plugin):
        # at the shipped defaults no part is read (no classifier cost, V3-F exactly); main is told (`parts: null`)
        line = f"{R2_SPEND[0]}; {R2_MESSAGE[0][0]}"
        _, fns, _ = _line(_body(standing="manual"), "terminal", {"command": line})
        assert fns.read is False and fns.parts == () and fns.wire() is None
        _, fns, _ = _line(_body(standing="manual", functions={"email": "askOnce"}), "terminal", {"command": line})
        assert fns.read is True and {p.cls for p in fns.parts} == {"$", "M"}
        assert [set(p["fns"]) for p in fns.wire()] == [set(p.fns) for p in fns.parts]

    def test_r3_a_heredoc_body_is_never_split_into_parts(self, plugin):
        from hermes_plugins.iclone_permissions.functions import _runs

        assert _runs("cat > notes.txt <<'EOF'\nalpha\nbeta\nEOF\nls") == ["cat > notes.txt <<'ICLONE_F2_HEREDOC_0'\n"
                                                                         "alpha\nbeta\nICLONE_F2_HEREDOC_0", "ls"]

    def test_r3_a_line_too_long_to_read_in_parts_is_every_function(self, plugin):
        body = _body(standing="manual", functions={"email": "askOnce"})
        _, fns, _ = _line(body, "terminal", {"command": "; ".join(["ls"] * 30)})
        assert tuple(fns) == tuple(FUNCTIONS) and fns.parts == ()


# ---------------------------------------------------------------------------------------------------
# R3-C27 — code is read through the same tables (critic r2 C2-7, PR-8 category, carrier = interpreter code)
# ---------------------------------------------------------------------------------------------------

C27_PUSH = SHELL_CASES[21][0]   # the publish line of the table
C27_CALLS = (
    ("terminal", {"command": "python3 -c 'import os; os.system(\"" + C27_PUSH + "\")'"}),
    ("execute_code", {"code": "import os; os.system('" + C27_PUSH + "')"}),
    ("execute_code", {"code": "import subprocess; subprocess.run(" + repr(C27_PUSH.split()) + ")"}),
)


class TestF2R3Code:
    @pytest.mark.parametrize("tool,args", C27_CALLS, ids=["terminal-code", "execute_code", "execute_code-argv"])
    @pytest.mark.parametrize("standing", ["manual", "ignore", "automatic"])
    def test_c2_7_a_publish_inside_code_is_decided_by_the_publish_row(self, plugin, tool, args, standing):
        # Publish at Manual, Shell (and every other row) at Ignore: the plain line is refused, and so is the same
        # line carried by interpreter code — through terminal and through execute_code
        body = _body(standing=standing, functions={**{f: "ignore" for f in FUNCTIONS}, "publish": "manual"})
        _, _, plain = _line(body, "terminal", {"command": C27_PUSH})
        _, fns, v = _line(body, tool, args)
        assert plain.outcome == "refuse"
        assert "publish" in fns and "shell" in fns and v.outcome == "refuse" and v.fn == "publish", (fns, v)

    def test_c27_the_defaults_still_read_the_code_words(self, plugin):
        # at the defaults (no level set) the words are read too: main sees Publish on the call
        _, fns, _ = _line(_body(standing="manual"), "execute_code", C27_CALLS[1][1])
        assert set(fns) == {"shell", "publish"} and fns.read is False

    def test_c27_each_shell_out_is_a_part_with_its_own_class(self, plugin):
        # code carrying interpreter code AND a spend: the code's class is the spend's; Shell at Automatic still asks
        # for the code part, as it would alone
        inner = SHELL_CASES[39][0]
        code = f"import os; os.system({inner!r}); os.system({R2_SPEND[0]!r})"
        body = _body(standing="manual", functions={**{f: "ignore" for f in FUNCTIONS}, "shell": "automatic"})
        call, fns, v = _line(body, "execute_code", {"code": code})
        assert call.cls == "$" and {p.cls for p in fns.parts} >= {"X", "$"}
        assert v.outcome == "ask" and v.fn == "shell", (fns.parts, v)

    def test_c27_a_string_that_is_not_run_only_adds_rows(self, plugin):
        # a literal the classifier reads as a possible command line is read the same way here: it can add a row,
        # never remove Shell
        _, fns, _ = _line(_body(), "execute_code", {"code": "print('" + R2_MESSAGE[0][0] + "')"})
        assert "shell" in fns and set(MESSAGES) <= set(fns)


# ---------------------------------------------------------------------------------------------------
# F2-7 — the integrity floors are not configurable
# ---------------------------------------------------------------------------------------------------

class TestF2Floors:
    def test_f2_7_every_floor_refuses_at_every_level_of_every_function(self, plugin):
        from hermes_plugins.iclone_permissions.classify import FLOOR_RULES

        policy = _policy(plugin)
        refused = total = 0
        for name, _rule in FLOOR_RULES:
            for level in LEVELS:
                body = _body(standing="automatic", functions={fn: level for fn in FUNCTIONS},
                             fnGrants=[{"id": f"fg-{fn}", "fn": fn, "scope": "standing"} for fn in FUNCTIONS])
                for fn in FUNCTIONS:
                    for cls in CLASSES:
                        total += 1
                        v = _decide(policy, body, cls, {"dangerous": False}, f"{name}: placeholder", (fn,))
                        refused += (v.outcome, v.rule) == ("refuse", "floor")
        assert len(FLOOR_RULES) == 7
        assert refused == total == 7 * 6 * 9 * 10

    def test_f2_7_writing_the_gate_and_stopping_it_stay_refused_with_every_row_at_ignore(self, wired, tmp_path):
        guard = tmp_path / "permissions"
        guard.mkdir()
        body = _body(standing="automatic", functions={fn: "ignore" for fn in FUNCTIONS},
                     protectedPaths=[str(guard)], guardPids=[987654])
        mod, main, _ = wired(body)
        writes = mod.on_pre_tool_call("write_file", {"path": str(guard / "functions.json"), "content": "{}"}, "t", "s1")
        stops = mod.on_pre_tool_call("terminal", {"command": "kill 987654"}, "t", "s1")
        mod._state["channel"].flush(3.0)
        assert writes and writes["action"] == "block"
        assert stops and stops["action"] == "block"
        refusals = _events(main, "refuse")
        assert len(refusals) == 2
        assert all(r.get("floor") for r in refusals)


# ---------------------------------------------------------------------------------------------------
# F2-10 — the real hook, end to end
# ---------------------------------------------------------------------------------------------------

REPRESENTATIVE = {
    "email": ("send_message", {"target": "email:a@example.invalid", "message": "hi"}),
    "payments": ("terminal", {"command": "agentcard wallet fetch https://example.invalid/x"}),
    "trading": ("terminal", {"command": "acp trade hl-order --size 1"}),
    "shopping": ("terminal", {"command": "agentcard card create --amount 5"}),
    "acp": ("terminal", {"command": "acp client fund --job 1"}),
    "messaging": ("send_message", {"target": "telegram", "message": "hi"}),
    "shell": ("terminal", {"command": "ls -la"}),
    "files": ("write_file", {"path": "/tmp/v3f2-outside/a.txt", "content": "x"}),
    "publish": ("terminal", {"command": "git push origin main"}),
}


class TestF2EndToEnd:
    @pytest.mark.parametrize("fn", FUNCTIONS)
    def test_f2_10_each_function_at_each_level(self, wired, fn):
        tool, args = REPRESENTATIVE[fn]
        expected = {"ignore": "allow", "manual": "refuse", "askAlways": "ask", "askOnce": "ask"}
        for level, want in expected.items():
            asks = []

            def answer(verb, payload):
                if verb == "ask":
                    asks.append(payload)
                    return 1, {"state": "decided", "allowed": False, "reason": "denied in the test"}
                return (0, {"attested": True}) if verb == "hello" else (0, {})

            # the rest of the row's class family at Ignore: a shell spend/message is decided by its whole family
            family = MONEY if fn in MONEY else ()
            body = _body(standing="manual", functions={**{f: "ignore" for f in family}, fn: level})
            mod, main, _ = wired(body, answer=answer)
            result = mod.on_pre_tool_call(tool, dict(args), "t", "s1")
            mod._state["channel"].flush(3.0)
            if want == "allow":
                assert result is None, (fn, level, result)
                event = _events(main, "allow")[-1]
                assert fn in event["fns"] and event["fn"] in (fn, *family)  # an allow tie names the first row
            elif want == "refuse":
                assert result["action"] == "block" and fn in result["message"], (fn, level, result)
                assert asks == []
                assert _events(main, "refuse")[-1]["fn"] == fn
            else:
                assert result["action"] == "block" and asks, (fn, level, result)
                assert fn in asks[-1]["fns"]

    def test_f2_10_ask_once_grant_allows_locally_and_names_its_grant(self, wired):
        body = _body(standing="manual", functions={**{f: "ignore" for f in MONEY}, "payments": "askOnce"},
                     fnGrants=[{"id": "fg-1", "fn": "payments", "scope": "session", "sessionId": "s1"}])
        mod, main, _ = wired(body)
        tool, args = REPRESENTATIVE["payments"]
        assert mod.on_pre_tool_call(tool, dict(args), "t", "s1") is None
        mod._state["channel"].flush(3.0)
        event = _events(main, "allow")[-1]
        assert (event["grantId"], event["fn"]) == ("fg-1", "payments")
        assert main.verbs("ask") == []
        # another session is not covered by that grant: it asks main (the fake main allows)
        assert mod.on_pre_tool_call(tool, dict(args), "t", "s2") is None
        assert [a["fns"] for a in main.verbs("ask")] == [list(MONEY)]

    def test_f2_10_one_line_two_rows_the_strictest_decides(self, wired):
        body = _body(standing="manual", functions={"email": "ignore", "shell": "manual"})
        mod, main, _ = wired(body)
        result = mod.on_pre_tool_call("terminal", {"command": "agentcard email send --to a@example.invalid; ls"}, "t", "s1")
        mod._state["channel"].flush(3.0)
        assert result["action"] == "block"
        assert _events(main, "refuse")[-1]["fn"] == "shell"

    def test_f2_10_defaults_send_the_functions_but_decide_as_v3f(self, wired):
        mod, main, _ = wired(_body(standing="automatic"))
        assert mod.on_pre_tool_call("terminal", {"command": "ls -la"}, "t", "s1") is None
        mod._state["channel"].flush(3.0)
        event = _events(main, "allow")[-1]
        assert event["fns"] == ["shell"] and event["fn"] == "shell"

# ---------------------------------------------------------------------------------------------------
# R4-UNREAD — what is not fully read fails closed (critic r3 C3-1, long-pad and middle-run categories)
# ---------------------------------------------------------------------------------------------------

# The critic r3 probe lines (V3F2_critic_r3_probes, test_critic_r3_struct.py), placeholder paths: a dangerous X line,
# a line that leaves the project then deletes, and a spend (SHELL_CASES[7]).
R3_DX = "chmod -R 777 /tmp/placeholder"
R3_CDRM = "cd /var/placeholder; rm -rf x"
R3_SPEND = SHELL_CASES[7][0]
ALL_AUTO = {f: "automatic" for f in FUNCTIONS}
ALL_IGNORE = {f: "ignore" for f in FUNCTIONS}
C3_1_BODIES = {
    "allAuto": dict(standing="automatic", functions=ALL_AUTO),
    "allIgnore_shellAuto": dict(standing="ignore", functions={**ALL_IGNORE, "shell": "automatic"}),
    "allIgnore_filesAuto": dict(standing="ignore", functions={**ALL_IGNORE, "files": "automatic"}),
}


def _count_reads(monkeypatch):
    from hermes_plugins.iclone_permissions import functions as m

    reads = []
    real = m._part
    monkeypatch.setattr(m, "_part", lambda *a, **k: reads.append(a[1]) or real(*a, **k))
    return reads


class TestF2R4Unread:
    @pytest.mark.parametrize("pad", [21, 22, 23, 30])
    @pytest.mark.parametrize("bname", ["allAuto", "allIgnore_shellAuto"])
    def test_c3_1_s1_a_line_past_the_segment_cap_asks(self, plugin, bname, pad):
        # S1 (long-pad): the dangerous X line asks under Shell at Automatic; padded with harmless segments and a spend
        # (23–32 segments) it is unread — every function, no part, the user levels ask (r3: allowed past 24)
        body = _body(**C3_1_BODIES[bname])
        joined = R3_DX + "; " + "; ".join(["true"] * pad + [R3_SPEND])
        _, _, va = _line(body, "terminal", {"command": R3_DX})
        _, fns, vj = _line(body, "terminal", {"command": joined})
        assert va.outcome == "ask"
        assert fns.unread and tuple(fns) == tuple(FUNCTIONS) and fns.wire() == []
        assert vj.outcome == "ask", vj

    @pytest.mark.parametrize("pad,read", [(0, True), (3, True), (5, False), (10, False)])
    @pytest.mark.parametrize("bname", ["allAuto", "allIgnore_filesAuto"])
    def test_c3_1_s2_a_middle_run_is_read_or_the_line_is_unread(self, plugin, bname, pad, read):
        # S2 (middle-run): leaving the project then deleting asks under Files at Automatic. Between a padded spend and
        # a spend it asks too: read in full up to _K_SEG segments (every run is a part, the middle run included),
        # unread past them (r3: allowed at 9 and 14 segments).
        body = _body(**C3_1_BODIES[bname])
        head = "; ".join([R3_SPEND] + ["true"] * pad)
        joined = "; ".join([head, R3_CDRM, R3_SPEND])
        _, _, vb = _line(body, "terminal", {"command": R3_CDRM})
        _, fns, vj = _line(body, "terminal", {"command": joined})
        assert vb.outcome == "ask"
        assert fns.unread is (not read) and bool(fns.wire()) is read
        assert vj.outcome == "ask", (fns.unread, vj)

    @pytest.mark.parametrize("mode", MODES)
    @pytest.mark.parametrize("cls", [c for c in CLASSES if c != "R"])
    def test_r4_an_unread_call_asks_at_every_user_level_and_no_grant_lifts_it(self, plugin, mode, cls):
        # every user level, every mode, every grant the owner could hold: an unread call never allows — a row at a
        # user level asks (Manual refuses), even a row the call does not name; a floor and the line's own OFF switch
        # refuse first; the rows at Follow mode are V3-F exactly, so with none at a user level nothing changes
        policy = _policy(plugin)
        from hermes_plugins.iclone_permissions.functions import Functions

        unread = Functions(("shell",), (), True, unread=True)
        grants = dict(grants=[{"id": f"g{c}", "cls": c, "scope": "standing"} for c in CLASSES],
                      fnGrants=[{"id": f"f{fn}", "fn": fn, "scope": "standing"} for fn in FUNCTIONS])
        for facts in ({}, {"dangerous": False, "inProject": True, "privileged": False, "getOnly": True}):
            for level in LEVELS[1:]:
                for ceiling in ("on", "undecided"):
                    body = _body(standing=mode, ceilings=_ceilings(ceiling), functions={"email": level}, **grants)
                    v3f = _SEV[_decide(policy, body, cls, facts, fns=None).outcome]
                    want = max(_SEV["refuse" if level == "manual" else "ask"], v3f)
                    v = _decide(policy, body, cls, facts, fns=unread)
                    assert _SEV[v.outcome] == want and v.grant_id is None, (level, ceiling, facts, v)
                    assert _decide(policy, body, cls, facts, "floor: placeholder", fns=unread).outcome == "refuse"
                body = _body(standing=mode, ceilings=_ceilings("off"), functions={"email": level}, **grants)
                assert _decide(policy, body, cls, facts, fns=unread).outcome == "refuse"
            body = _body(standing=mode, **grants)
            a, b = _decide(policy, body, cls, facts, fns=unread), _decide(policy, body, cls, facts, fns=None)
            assert (a.outcome, a.rule, a.grant_id) == (b.outcome, b.rule, b.grant_id)

    def test_r4_reading_stays_free_and_the_defaults_read_nothing(self, plugin, monkeypatch):
        reads = _count_reads(monkeypatch)
        long = "; ".join(["true"] * 40)
        _, fns, v = _line(_body(standing="manual"), "terminal", {"command": long})
        assert (fns.read, fns.unread, fns.wire(), reads) == (False, False, None, [])
        _, fns, v = _line(_body(standing="ignore", functions=ALL_IGNORE), "terminal", {"command": long})
        assert (fns.read, fns.unread, fns.wire(), reads, v.outcome) == (True, True, [], [], "ask")
        _, fns, v = _line(_body(standing="ignore", functions=ALL_IGNORE), "read_file", {"path": "/tmp/x"})
        assert v.outcome == "allow"

    def test_r4_unread_never_comes_from_the_class(self, plugin, monkeypatch):
        # the same harmless segments: 8 are read (allowed at Ignore), 9 are unread (asked) — the class is the same
        reads = _count_reads(monkeypatch)
        body = _body(standing="ignore", functions=ALL_IGNORE)
        segs = [f"true placeholder-{i}" for i in range(9)]
        c8, f8, v8 = _line(body, "terminal", {"command": "; ".join(segs[:8])})
        assert len(reads) == 8 * 9 // 2 - 1  # every run but the line itself (part 0)
        c9, f9, v9 = _line(body, "terminal", {"command": "; ".join(segs)})
        assert c8.cls == c9.cls and (f8.unread, v8.outcome) == (False, "allow") and (f9.unread, v9.outcome) == (True, "ask")
        assert len(reads) == 8 * 9 // 2 - 1  # past the segment cap nothing is read

    def test_r4_a_read_call_always_carries_its_whole_line_as_part_0(self, plugin):
        body = _body(standing="manual", functions={"email": "askOnce"})
        for tool, args in (("terminal", {"command": SHELL_CASES[38][0]}), ("execute_code", {"code": "print(1)"}),
                           ("cronjob", {"action": "create"})):
            call, fns, _ = _line(body, tool, args)
            wire = fns.wire()
            assert wire and wire[0]["cls"] == call.cls and wire[0]["fns"] == list(fns), (tool, wire)

    def test_r4_a_shell_out_is_a_line_like_any_other(self, plugin):
        # S1 carried by code (execute_code and terminal code): the shell-out's own parts are read, or it is unread
        body = _body(**C3_1_BODIES["allIgnore_shellAuto"])
        short = R3_DX + "; " + R3_SPEND
        long = R3_DX + "; " + "; ".join(["true"] * 23 + [R3_SPEND])
        for line, unread in ((short, False), (long, True)):
            for tool, args in (("execute_code", {"code": f"import os; os.system('{line}')"}),
                               ("terminal", {"command": f"python3 -c \"import os; os.system('{line}')\""})):
                _, fns, v = _line(body, tool, args)
                assert fns.unread is unread and v.outcome == "ask", (tool, unread, fns.unread, v)

    def test_r4_more_parts_than_main_reads_and_code_past_the_depth_are_unread(self, plugin):
        from hermes_plugins.iclone_permissions import functions as m
        from hermes_plugins.iclone_permissions.classify import _CODE_DEPTH_MAX

        body = _body(standing="ignore", functions=ALL_IGNORE)
        code = "import os\n" + "\n".join(f"os.system('true placeholder-{i}')" for i in range(m._PARTS_MAX))
        _, fns, v = _line(body, "execute_code", {"code": code})
        assert fns.unread and v.outcome == "ask"
        with pytest.raises(m._Unread):
            m._code_texts("import os; os.system('true placeholder')", _CODE_DEPTH_MAX, m._Work())

    def test_r4_an_error_while_mapping_is_unread(self, plugin, monkeypatch):
        from hermes_plugins.iclone_permissions import functions as m

        monkeypatch.setattr(m, "_runs", lambda *a: 1 / 0)
        _, fns, v = _line(_body(standing="ignore", functions=ALL_IGNORE), "terminal", {"command": "true; true"})
        assert fns.unread and tuple(fns) == tuple(FUNCTIONS) and fns.wire() is None and v.outcome == "ask"


# ---------------------------------------------------------------------------------------------------
# R5-K — the work is counted before any part is read; no clock decides anything (critic r4 C4-2)
# ---------------------------------------------------------------------------------------------------

def _harmless(n):
    return "; ".join(f"true placeholder-{i}" for i in range(n))


class TestF2R5Budget:
    def test_r5_k_seg_segments_are_read_in_full_one_more_is_unread_with_nothing_read(self, plugin, monkeypatch):
        from hermes_plugins.iclone_permissions import functions as m

        reads = _count_reads(monkeypatch)
        body = _body(standing="ignore", functions=ALL_IGNORE)
        k = m._K_SEG
        _, fk, vk = _line(body, "terminal", {"command": _harmless(k)})
        assert (fk.unread, len(reads), vk.outcome) == (False, k * (k + 1) // 2 - 1, "allow")
        reads.clear()
        _, f1, v1 = _line(body, "terminal", {"command": _harmless(k + 1)})
        assert (f1.unread, reads, f1.wire(), v1.outcome) == (True, [], [], "ask")

    def test_r5_the_count_includes_the_segments_of_every_shell_out(self, plugin, monkeypatch):
        # K_SEG − 3 harmless segments + one segment of interpreter code carrying a 2-segment shell-out = K_SEG:
        # read; with a 3-segment shell-out the count passes K_SEG: unread, nothing read
        from hermes_plugins.iclone_permissions import functions as m

        reads = _count_reads(monkeypatch)
        body = _body(standing="ignore", functions=ALL_IGNORE)
        head = _harmless(m._K_SEG - 3)
        for inner, unread in (("true; true", False), ("true; true; true", True)):
            reads.clear()
            _, fns, _ = _line(body, "terminal", {"command": f"{head}; python3 -c \"import os; os.system('{inner}')\""})
            assert fns.unread is unread and bool(reads) is not unread, (inner, fns.unread, len(reads))

    def test_r5_more_parts_than_main_reads_is_counted_before_the_first_read(self, plugin, monkeypatch):
        # with the segment cap lifted, PARTS_MAX decides alone: 10 segments = 55 parts (read), 11 = 66 (unread)
        from hermes_plugins.iclone_permissions import functions as m

        monkeypatch.setattr(m, "_K_SEG", 100)
        reads = _count_reads(monkeypatch)
        body = _body(standing="ignore", functions=ALL_IGNORE)
        _, f10, _ = _line(body, "terminal", {"command": _harmless(10)})
        assert not f10.unread and len(f10.wire()) <= m._PARTS_MAX and len(reads) == 54
        reads.clear()
        _, f11, _ = _line(body, "terminal", {"command": _harmless(11)})
        assert f11.unread and reads == []

    def test_r5_the_decision_is_a_pure_function_no_clock_moves_it(self, plugin, monkeypatch):
        # every clock the process has jumps by 1 000 s at each read of it: the reading and the decision of every line
        # (read, unread, code) are the ones the frozen machine gives — a clock anywhere in the decision would show
        import time

        from hermes_plugins.iclone_permissions import functions as m

        lines = [_harmless(2), _harmless(m._K_SEG), _harmless(m._K_SEG + 1), R3_DX + "; " + R3_SPEND]
        body = _body(**C3_1_BODIES["allIgnore_shellAuto"])
        calls = [("terminal", {"command": line}) for line in lines]
        calls.append(("execute_code", {"code": f"import os; os.system({R3_DX!r}); os.system({R3_SPEND!r})"}))

        def seen():
            out = []
            for tool, args in calls:
                call, fns, v = _line(body, tool, args)
                out.append((tuple(fns), fns.unread, fns.wire(), v.outcome, v.rule, v.fn))
            return out

        still = seen()
        jump = {"t": 0.0}

        def clock(*_a):
            jump["t"] += 1000.0
            return jump["t"]

        for name in ("perf_counter", "monotonic", "time", "process_time"):
            monkeypatch.setattr(time, name, clock)
        for name in ("perf_counter_ns", "monotonic_ns", "time_ns"):
            monkeypatch.setattr(time, name, lambda *_a: int(clock() * 1e9))
        assert seen() == still


# ---------------------------------------------------------------------------------------------------
# R5-G — a call is FULLY READ only when the whole of it is in the closed grammar (critic r4 C4-4, C4-5)
# ---------------------------------------------------------------------------------------------------

# The critic r4 corpus (V3F2_critic_r4_probes), used as written: B1 is test_c4_load.py's benign set; W*, F* are
# test_c4_wrap2.py's forms and G* test_c4_struct.py's (each takes the pieces it joins, placeholder tokens inside).
C4_B1 = (
    "ls -la; pwd",
    "git status && git diff --stat",
    "cd src && ls",
    "mkdir -p build && cd build && ls",
    "git add -A && git status && git diff --cached --stat",
    "cd placeholder-app && ls && cat README.md && git log --oneline -5",
    "cat notes.txt | grep todo | sort | uniq -c | head -5",
    "cd placeholder-app; git status; git diff --stat; ls -la; pwd",
    "cd placeholder-app && git fetch && git status && git log -3 && git diff && ls",
    "mkdir -p out && cd out && touch a && touch b && ls && cd .. && pwd",
    "ls; pwd; date; whoami; uname -a; echo done; ls -la; git status",
)
C4_PAD = "; ".join(["true"] * 3)
C4_W = {
    "W1": "sh -c '{a}; {b}'", "W2": "zsh -c '{a}; {b}'", "W3": "env bash -c '{a}; {b}'",
    "W4": "nohup bash -c '{a}; {b}'", "W5": "timeout 5 bash -c '{a}; {b}'", "W6": "echo x | xargs -I{{}} sh -c '{a}; {b}'",
    "W7": "bash <<'EOS'\n{a}\n{b}\nEOS", "W8": "true $( {a} ) $( {b} )", "W9": "bash -c '{a}' ; true",
    "W10": "bash -c \"{a} && {b}\"",
}
C4_F = {"F1": "f() {{ {x}; }}; f", "F2": "function f {{ {x}; }}; f", "F3": "f() {{ true; {x}; }}; f", "F4": "{{ {x}; }}"}
C4_G = {
    "G1": "( {a}; {b} )", "G2": "{{ {a}; {b}; }}", "G3": "echo $( {a}; {b} )", "G4": "echo `{a}; {b}`",
    "G5": "bash -c '{a}; {b}'", "G6": "sh <<'EOS'\n{a}\n{b}\nEOS", "G7": "f() {{ {a}; {b}; }}; f",
    "G8": "eval '{a}; {b}'", "G9": "if true; then {a}; {b}; fi", "G10": "for i in 1; do {a}; {b}; done",
    "G11": "( " + C4_PAD + "; {a}; " + C4_PAD + "; {b}; " + C4_PAD + " )",
    "G12": "bash -c '" + C4_PAD + "; {a}; " + C4_PAD + "; {b}; " + C4_PAD + "; " + C4_PAD + "'",
}
C4_DX = R3_DX
C4_SPEND = R3_SPEND
C4_PUB = SHELL_CASES[21][0]


def _c4_forms():
    """Every r4 opaque form joined around the critic's own pieces: (id, joined line, pieces)."""
    out = [(k, v.format(a=C4_DX, b=C4_SPEND), (C4_DX, C4_SPEND)) for k, v in C4_W.items()]
    out += [(k, v.format(a=C4_DX, b=C4_SPEND), (C4_DX, C4_SPEND)) for k, v in C4_G.items()]
    out += [(k, v.format(x=C4_PUB), (C4_PUB,)) for k, v in C4_F.items()]
    return out


class TestF2R5Grammar:
    @pytest.mark.parametrize("line", C4_B1)
    def test_r5_g_the_critics_benign_lines_are_in_the_grammar(self, plugin, line):
        from hermes_plugins.iclone_permissions.functions import _grammar_line

        assert _grammar_line(line)

    @pytest.mark.parametrize("fid,line,pieces", _c4_forms(), ids=[f[0] for f in _c4_forms()])
    def test_r5_g_every_r4_opaque_form_is_unread(self, plugin, fid, line, pieces):
        # wrapper bodies, function bodies, substitution, stdin-as-code, compound commands: none is the plain shape,
        # so none is fully read — whatever the recogniser does not accept is unread by construction
        from hermes_plugins.iclone_permissions.functions import _grammar_line

        assert all(_grammar_line(p) for p in pieces) and not _grammar_line(line)
        _, fns, _ = _line(_body(**C3_1_BODIES["allAuto"]), "terminal", {"command": line})
        assert fns.unread and tuple(fns) == tuple(FUNCTIONS), fid

    @pytest.mark.parametrize("line,full", [
        ("placeholdercli --placeholder-switch value", True),
        ("placeholdercli 'quoted literal' \"double literal\"", True),
        ("placeholdercli > placeholder.out 2> placeholder.err", True),
        ("sort < placeholder.in >> placeholder.out", True),
        ("placeholdercli < placeholder.in", False),             # file data to a consumer the normaliser does not know
        ("placeholdercli > placeholder.out 2>&1", False),       # the normaliser splits a duplication's & as an operator
        ("PLACEHOLDER=1 placeholdercli", True),
        ("PLACEHOLDER=1", True),
        ("env PLACEHOLDER=1 placeholdercli", True),
        ("nohup placeholdercli", True),
        ("timeout 5 placeholdercli", True),
        ("nice placeholdercli", True),
        ("time placeholdercli", True),
        ("nohup timeout 5 placeholdercli && placeholdercli || placeholdercli & placeholdercli", True),
        ("placeholdercli;\n\nplaceholdercli;", True),
        ("sh placeholder-script.sh", True),
        ("python3 placeholder_script.py --placeholder-switch", True),
        ("python3 -c \"import os; os.system('placeholdercli do-thing')\"", True),
        ("env --placeholder-switch placeholdercli", False),     # a wrapper's word outside its closed table
        ("timeout placeholder placeholdercli", False),
        ("env", False),                                         # a wrapper with nothing to run
        ("placeholdercli \"$(placeholdercli)\"", False),        # a substitution
        ("placeholdercli 'unterminated", False),
        ("placeholdercli &&", False),                           # an operator with no command after it
        ("; placeholdercli", False),
        ("placeholdercli ;; placeholdercli", False),
        ("placeholdercli \\\nplaceholdercli", False),            # a continuation
        ("python3", False),                                     # an interpreter with no file and no code read here
        ("sh", False),
    ])
    def test_r5_g_the_recogniser_accepts_the_plain_shape_only(self, plugin, line, full):
        from hermes_plugins.iclone_permissions.functions import _grammar_line

        assert _grammar_line(line) is full, line

    def test_r5_g_code_is_in_the_grammar_only_when_its_shell_outs_are(self, plugin):
        from hermes_plugins.iclone_permissions.functions import _grammar_code

        assert _grammar_code("import os; os.system('placeholdercli do-thing')", 0)
        assert not _grammar_code("import os; os.system(" + repr(C4_W["W1"].format(a="true", b="true")) + ")", 0)
        body = _body(standing="ignore", functions=ALL_IGNORE)
        code = "import os; os.system(" + repr(C4_G["G1"].format(a=C4_DX, b=C4_SPEND)) + ")"
        _, fns, v = _line(body, "execute_code", {"code": code})
        assert fns.unread and v.outcome == "ask"

    def test_r5_g_an_unread_line_within_the_count_still_carries_its_parts(self, plugin):
        # outside the grammar but within K_SEG: every part is read and sent, beside the unread flag (R5-D keeps them)
        body = _body(standing="ignore", functions=ALL_IGNORE)
        call, fns, v = _line(body, "terminal", {"command": "X=placeholder; $X; " + C4_SPEND})
        wire = fns.wire()
        assert fns.unread and tuple(fns) == tuple(FUNCTIONS) and v.outcome != "allow"
        assert wire and wire[0]["cls"] == call.cls and len(wire) > 1

    def test_r5_g_the_unread_flag_reaches_main_in_the_payload(self, wired):
        # the hook's own payload: a plain line is sent with unread false; a line outside the grammar asks main with
        # unread true and the parts it read
        asks = []

        def answer(verb, payload):
            if verb == "ask":
                asks.append(payload)
                return 1, {"state": "decided", "allowed": False, "reason": "denied in the test"}
            return (0, {"attested": True}) if verb == "hello" else (0, {})

        mod, main, _ = wired(_body(standing="ignore", functions=ALL_IGNORE), answer=answer)
        assert mod.on_pre_tool_call("terminal", {"command": "ls -la"}, "t", "s1") is None
        mod._state["channel"].flush(3.0)
        event = _events(main, "allow")[-1]
        assert event["unread"] is False and event["parts"]
        result = mod.on_pre_tool_call("terminal", {"command": "X=placeholder; $X"}, "t", "s1")
        assert result["action"] == "block" and asks and asks[-1]["unread"] is True and len(asks[-1]["parts"]) > 1


# ---------------------------------------------------------------------------------------------------
# R5-ARG (lead, after round 5) — globs and plain parameter expansions are read in ARGUMENT positions only
# ---------------------------------------------------------------------------------------------------

# The B1 benign set with glob and variable arguments (placeholder names): every one read in full, allowed.
R5_ARG_B1 = C4_B1 + (
    "ls -la *.placeholder; pwd",
    "cat placeholder-dir/*.txt | grep todo | sort | uniq -c | head -5",
    "cd \"$PLACEHOLDER_DIR\" && ls && git status",
    "git diff --stat ${PLACEHOLDER_REF} && git log --oneline -5",
    "ls placeholder-[ab].txt && echo $PLACEHOLDER",
    "mkdir -p out/$PLACEHOLDER && cd out && touch placeholder-? && ls",
)
# The same tokens where they are NOT arguments — or are an executor's input — and the forms that stay out.
R5_ARG_OUT = {
    "program": ("$PLACEHOLDER_PROG placeholder-arg", "placeholder* placeholder-arg", "${PLACEHOLDER_PROG}"),
    "wrapper inner program": ("nohup $PLACEHOLDER_PROG", "timeout 5 placeholder*", "env A=1 ${PLACEHOLDER_PROG}"),
    "executor input": ("sh $PLACEHOLDER_SCRIPT", "sh placeholder-*.sh", "python3 placeholder.py $PLACEHOLDER",
                       "source ${PLACEHOLDER_SCRIPT}"),
    "redirection target": ("placeholdercli > $PLACEHOLDER_OUT", "placeholdercli > placeholder*.out",
                           "placeholdercli < ${PLACEHOLDER_IN}"),
    "assignment": ("PLACEHOLDER=$OTHER placeholdercli", "env PLACEHOLDER=$OTHER placeholdercli"),
    "not plain": ("placeholdercli ${PLACEHOLDER:-placeholder}", "placeholdercli $1", "placeholdercli $((1+1))",
                  "placeholdercli {a,b}", "placeholdercli \"$(placeholdercli)\"", "placeholdercli `placeholdercli`"),
}


class TestF2R5Arg:
    @pytest.mark.parametrize("line", R5_ARG_B1)
    @pytest.mark.parametrize("bname", ["allAuto", "shellAuto"])
    def test_r5_arg_benign_lines_with_glob_and_variable_arguments_are_read_and_allowed(self, plugin, tmp_path, bname,
                                                                                      line):
        from hermes_plugins.iclone_permissions.functions import _grammar_line

        over = {"allAuto": dict(standing="automatic", functions=ALL_AUTO),
                "shellAuto": dict(standing="ignore", functions={**ALL_IGNORE, "shell": "automatic"})}[bname]
        _, fns, v = _line(_body(**over), "terminal", {"command": line}, cwd=str(tmp_path))
        assert _grammar_line(line) and not fns.unread and v.outcome == "allow", (line, fns.unread, v)

    @pytest.mark.parametrize("where,line", [(w, l) for w, ls in R5_ARG_OUT.items() for l in ls])
    def test_r5_arg_the_same_tokens_anywhere_else_are_unread(self, plugin, where, line):
        from hermes_plugins.iclone_permissions.functions import _grammar_line

        assert not _grammar_line(line), (where, line)
        _, fns, v = _line(_body(standing="ignore", functions=ALL_IGNORE), "terminal", {"command": line})
        assert fns.unread and v.outcome != "allow", (where, line, v)


# ---------------------------------------------------------------------------------------------------
# R5-D — the unread decision keeps everything known (critic r4 C4-1, C4-3)
# ---------------------------------------------------------------------------------------------------

# The critic r4 corpus, as written: A1 (test_c4_unread.py, a variable run beside a message line), K1
# (test_c4_switch.py, a placeholder program and a spend, the Terminal switch OFF).
C4_VARRUN = "X=placeholder; $X; acp email compose --to x"
C4_A1 = C4_VARRUN + "; true"
C4_PIECE = "placeholdercli do-thing"
C4_K1_BODIES = {
    "allAuto": dict(functions=ALL_AUTO), "allIgnore": dict(functions=ALL_IGNORE),
    "allMode_shellAuto": dict(functions={"shell": "automatic"}),
}
C4_K1_PADS = (0, 3, 7, 30)
C4_TERMINAL_OFF = {**{k: "on" for k in CEILING_KEYS}, "terminal": "off"}
C4_RL_LEVELS = {**ALL_IGNORE, "shell": "mode"}   # a row at Follow mode beside rows at a user level (C4-3, read line)


def _c4_k1(pad):
    return "; ".join([C4_PIECE] + ["true"] * pad + [C4_SPEND])


def _c4_g_bodies():
    return {"DX+SPEND": (C4_DX, C4_SPEND, "allAuto"), "DX+SPEND/shell": (C4_DX, C4_SPEND, "allIgnore_shellAuto"),
            "PUB+SPEND/pubManual": (C4_PUB, C4_SPEND, "allIgnore_pubManual")}


C4_G_BODIES = {
    "allAuto": dict(standing="automatic", functions=ALL_AUTO),
    "allIgnore_shellAuto": dict(standing="ignore", functions={**ALL_IGNORE, "shell": "automatic"}),
    "allIgnore_pubManual": dict(standing="ignore", functions={**ALL_IGNORE, "publish": "manual"}),
}
C4_F_ROWS = (("publish", C4_PUB), ("email", "agentcard email send --to a@example.invalid"), ("payments", C4_SPEND),
             ("files", "rm -rf /var/placeholder"))


def _c4_probe_cases():
    """(id, body over, pieces, joined, want): every r4 probe the critic ran, as the gate decides it."""
    out = [("A1", dict(standing="automatic", functions=ALL_AUTO), (), C4_A1, "refuse")]
    for bname, over in C4_K1_BODIES.items():
        for pad in C4_K1_PADS:
            out.append((f"K1-{bname}-pad{pad}", dict(standing="automatic", ceilings=C4_TERMINAL_OFF, **over),
                        (C4_PIECE, C4_SPEND), _c4_k1(pad), "refuse"))
    out.append(("RL-shellMode", dict(standing="automatic", ceilings=C4_TERMINAL_OFF, functions=C4_RL_LEVELS),
                (C4_PIECE, C4_SPEND), _c4_k1(0), "refuse"))
    for wid, form in C4_W.items():
        out.append((wid, C4_G_BODIES["allAuto"], (C4_DX, C4_SPEND), form.format(a=C4_DX, b=C4_SPEND), "atLeast"))
    for gid, form in C4_G.items():
        for pid, (a, b, bname) in _c4_g_bodies().items():
            out.append((f"{gid}-{pid}", C4_G_BODIES[bname], (a, b), form.format(a=a, b=b), "atLeast"))
    for fid, form in C4_F.items():
        for row, x in C4_F_ROWS:
            out.append((f"{fid}-{row}", dict(standing="ignore", functions={**ALL_IGNORE, row: "manual"}), (x,),
                        form.format(x=x), "atLeast"))
    return out


class TestF2R5Unread:
    @pytest.mark.parametrize("pid,over,pieces,joined,want", _c4_probe_cases(), ids=[c[0] for c in _c4_probe_cases()])
    def test_r5_d_every_r4_probe(self, plugin, pid, over, pieces, joined, want):
        # A1 and K1 refuse; a row at Follow mode keeps a read part's OFF switch; the wrapper, substitution, stdin and
        # function-body forms never decide below the pieces they hold
        body = _body(**over)
        got = _SEV[_line(body, "terminal", {"command": joined}, cwd="/var/empty/iclone-f2-c4")[2].outcome]
        alone = [_SEV[_line(body, "terminal", {"command": p}, cwd="/var/empty/iclone-f2-c4")[2].outcome]
                 for p in pieces]
        if want == "refuse":
            assert got == _SEV["refuse"] and all(a <= got for a in alone), (pid, alone, got)
        else:
            assert got >= max(alone), (pid, alone, got)

    def test_r5_d_c_a_read_part_is_never_dropped(self, plugin):
        # A1: the whole line has no floor, a part read out of its assignment's context does; the line is unread
        # (outside the grammar) and refuses with the part kept as a term
        call, fns, v = _line(_body(standing="automatic", functions=ALL_AUTO), "terminal", {"command": C4_A1},
                             cwd="/var/empty/iclone-f2-c4")
        assert call.floor is None and fns.unread and any(p.floor for p in fns.parts)
        assert (v.outcome, v.rule) == ("refuse", "floor")

    @pytest.mark.parametrize("key", CEILING_KEYS)
    def test_r5_d_d_an_unread_call_meets_every_switch(self, plugin, key):
        # an unread call may touch every function: any one switch OFF refuses it at a user level; none OFF, it asks
        policy = _policy(plugin)
        from hermes_plugins.iclone_permissions.functions import Functions

        unread = Functions(FUNCTIONS, (), True, unread=True)
        for level in LEVELS[1:]:
            off = _body(standing="ignore", ceilings={**_ceilings("on"), key: "off"}, functions={"email": level})
            on = _body(standing="ignore", functions={"email": level})
            assert (_decide(policy, off, "X", fns=unread).outcome, _decide(policy, off, "X", fns=unread).rule) == \
                ("refuse", "ceiling")
            assert _decide(policy, on, "X", fns=unread).outcome == ("refuse" if level == "manual" else "ask")
        # no row at a user level: V3-F exactly, whatever switch is OFF elsewhere
        plain = _body(standing="ignore", ceilings={**_ceilings("on"), key: "off"})
        a, b = _decide(policy, plain, "X", fns=unread), _decide(policy, plain, "X", fns=None)
        assert (a.outcome, a.rule, a.grant_id) == (b.outcome, b.rule, b.grant_id)

    def test_r5_d_a_follow_mode_row_takes_a_read_parts_off_switch(self, plugin):
        # C4-3 read-line case: Shell at Follow mode decided V3-F on the whole `$` line and lost the X part's switch
        body = _body(standing="automatic", ceilings=C4_TERMINAL_OFF, functions=C4_RL_LEVELS)
        _, fa, va = _line(body, "terminal", {"command": C4_PIECE}, cwd="/var/empty/iclone-f2-c4")
        call, fj, vj = _line(body, "terminal", {"command": _c4_k1(0)}, cwd="/var/empty/iclone-f2-c4")
        assert va.outcome == "refuse" and not fj.unread and call.cls == "$"
        assert (vj.outcome, vj.rule, vj.fn, vj.level) == ("refuse", "ceiling", "shell", "mode")

    def test_r5_d_a_follow_mode_row_decides_v3f_on_every_part_it_touches(self, plugin):
        # R5-GATE seed 27182818: Shell at Follow mode (the rest at Ignore, standing Ignore), the Terminal switch
        # undecided, a class grant for M: a harmless shell piece asks alone (an undecided switch); joined after a
        # message the whole line is M (granted, its switch ON) — the Follow-mode row still asks on the shell part
        body = _body(standing="ignore", ceilings={**{k: "on" for k in CEILING_KEYS}, "terminal": "undecided"},
                     functions=C4_RL_LEVELS, grants=[{"id": "gM", "cls": "M", "scope": "session", "sessionId": "s1"}])
        _, _, va = _line(body, "terminal", {"command": "git status"})
        call, fj, vj = _line(body, "terminal", {"command": SHELL_CASES[1][0] + " && git status"})
        assert va.outcome == "ask" and call.cls == "M" and not fj.unread
        assert (vj.outcome, vj.fn, vj.level) == ("ask", "shell", "mode"), vj


# ---------------------------------------------------------------------------------------------------
# R5-GATE — the critic r4 real-clock rows: B1 (benign lines, normal load) and A2 (the same line, 20 runs)
# ---------------------------------------------------------------------------------------------------

C4_B1_BODIES = {
    "allAuto": dict(standing="automatic", functions=ALL_AUTO),
    "shellAuto": dict(standing="ignore", functions={**ALL_IGNORE, "shell": "automatic"}),
}
C4_B1_REPS = 30


class TestF2R5RealClock:
    def test_r5_b1_benign_lines_within_k_seg_never_ask_on_the_real_clock(self, plugin, tmp_path, monkeypatch):
        # the critic's B1 (11 benign lines of 2–8 segments) and R5-ARG's glob and variable variants, all-Automatic
        # and Shell-Automatic, 30 runs each on the machine's real clock under whatever load it has. The reference is the same call with every clock frozen; a
        # run is spurious when it asks where the reference allows. Within K_SEG: 0 spurious, every line allowed.
        import os
        import statistics
        import time

        from hermes_plugins.iclone_permissions import functions as m

        cwd = str(tmp_path)
        load = os.getloadavg()
        frozen = {}
        with monkeypatch.context() as still:
            for name in ("perf_counter", "monotonic", "time", "process_time"):
                still.setattr(time, name, lambda: 0.0)
            for bname, over in C4_B1_BODIES.items():
                for line in R5_ARG_B1:
                    frozen[(bname, line)] = _line(_body(**over), "terminal", {"command": line}, cwd=cwd)[2].outcome
        spurious = within = 0
        work = []
        for bname, over in C4_B1_BODIES.items():
            body = _body(**over)
            for line in R5_ARG_B1:
                for _ in range(C4_B1_REPS):
                    started = time.perf_counter()
                    _, fns, v = _line(body, "terminal", {"command": line}, cwd=cwd)
                    work.append((time.perf_counter() - started) * 1000)
                    if _nseg(line) <= m._K_SEG:
                        within += 1
                        spurious += v.outcome != "allow" and frozen[(bname, line)] == "allow"
        work.sort()
        print(f"R5-B1 load={load[0]:.1f}/{os.getloadavg()[0]:.1f} k_seg={m._K_SEG} runs={len(work)} within_k={within} "
              f"spurious={spurious} reference_allow={sum(o == 'allow' for o in frozen.values())}/{len(frozen)} "
              f"call_p50={statistics.median(work):.1f}ms call_p95={work[int(len(work) * .95) - 1]:.1f}ms")
        assert spurious == 0 and within == len(work)
        assert set(frozen.values()) == {"allow"}

    @pytest.mark.parametrize("pad", [1, 2, 5])
    def test_r5_a2_the_same_line_decides_the_same_20_times(self, plugin, pad):
        # the critic's A2: the A1 line padded to 4, 5 and 8 segments, 20 runs on the real clock — refused every time
        body = _body(standing="automatic", functions=ALL_AUTO)
        line = "; ".join([C4_VARRUN] + ["true"] * pad)
        outs = [_line(body, "terminal", {"command": line}, cwd="/var/empty/iclone-f2-c4")[2].outcome for _ in range(20)]
        print(f"R5-A2 segs={pad + 3} outcomes={ {o: outs.count(o) for o in set(outs)} }")
        assert outs == ["refuse"] * 20


# ---------------------------------------------------------------------------------------------------
# r5 lead contingency — one flag (F2_LOOSENING_ENABLED) turns Functions into tightening only, on both sides
# ---------------------------------------------------------------------------------------------------

class TestF2R5Tightening:
    def test_the_flag_and_the_levels_it_hides_are_mains(self, plugin):
        policy = _policy(plugin)
        assert FN_FIXTURE["loosening"] == {"enabled": policy.F2_LOOSENING_ENABLED,
                                           "levels": list(policy.LOOSENING_LEVELS)}

    def test_flag_off_a_loosening_level_in_the_body_is_follow_mode(self, plugin, monkeypatch):
        # with the flag off, the signed body cannot loosen anything: a loosening row decides as Follow mode (V3-F),
        # reads no part; Ask always and Manual still decide
        from hermes_plugins.iclone_permissions import functions as m
        from hermes_plugins.iclone_permissions.functions import Functions

        policy = _policy(plugin)
        monkeypatch.setattr(policy, "F2_LOOSENING_ENABLED", False)
        fns = Functions(FUNCTIONS, (), True)
        for mode in MODES:
            for cls in CLASSES:
                for level in policy.LOOSENING_LEVELS:
                    body = _body(standing=mode, functions={fn: level for fn in FUNCTIONS})
                    a, b = _decide(policy, body, cls, fns=fns), _decide(policy, body, cls, fns=None)
                    assert (a.outcome, a.rule) == (b.outcome, b.rule), (mode, cls, level)
                    assert not m._levels_set(body)
                body = _body(standing=mode, functions={fn: "manual" for fn in FUNCTIONS})
                assert _decide(policy, body, cls, fns=fns).outcome == ("allow" if cls == "R" else "refuse")


# ---------------------------------------------------------------------------------------------------
# R4-GEN — the property gate: decide(A op B …) >= max(decide(A), decide(B), …), over three length ranges
# ---------------------------------------------------------------------------------------------------

# Every line of the critic probe folders (V3F2_critic_r1_probes, V3F2_critic_r2_probes) that is not already a
# SHELL_CASES line: placeholder programs, the runner-path spend, harmless prefixes, a code line carrying a push.
PROBE_LINES = (
    "agentcard wallet balance",                                                  # r1 PR-2r lead
    "node ./node_modules/onchainos/dist/cli.js swap execute --from a --to b",    # r1 PR-2r, r2 C2-3 part
    "true",                                                                      # r1 PR-2 alone
    "true; true",                                                                # r2 C2-3 prefix
    "placeholdercli do-thing",                                                   # r2 C2-3/C2-4 placeholder program
    "ls | cat",                                                                  # r2 C2-3 prefix
    "python3 -c 'import os; os.system(\"git push origin main\")'",               # r2 C2-7 terminal code
    "git pu",                                                                    # r2 C2-6 first piece
    "sh origin main",                                                            # r2 C2-6 second piece
    # r3 (V3F2_critic_r3_probes): the dangerous X line, leave-project-then-delete, a placeholder program, a wrapped
    # publish, a message inside code, a privileged read, an assignment run as a command, a pipe into a placeholder
    "chmod -R 777 /tmp/placeholder", "cd /var/placeholder; rm -rf x", "placeholdercli do-thing",
    "bash -c 'git push origin main'", "python3 -c \"import os; os.system('acp message send --to x')\"",
    "sudo ls", "X=placeholder; $X", "ls -la | placeholdercli do-thing",
)
# The empty SHELL_CASES line is left out: it runs nothing, and V3-F's classifier (frozen, F2-6) reads it as an X
# whose facts were not measured, so `""` asks in Automatic where `; ls` (a syntax error that also runs nothing)
# allows — a V3-F reading of no command, not a part a level could lose (the gate counts V3-F's own share apart).
PROP_LINES = tuple(dict.fromkeys([c for c, _ in SHELL_CASES if c] + list(PROBE_LINES)))
PROP_SEED = int(__import__("os").environ.get("V3F2_PROP_SEED", "20261021"))
# Joined lines of 1–8 segments (read in parts within _K_SEG), 9–24 and 25–60 (unread: the work counted past _K_SEG). Each joins 2–3 pieces — themselves corpus lines joined with random operators, several segments each when the
# range allows — with any of the six top-level operators.
PROP_RANGES = ((1, 8), (9, 24), (25, 60))
# R5-GATE: a fourth set of joined lines puts 1–2 corpus pieces inside the critic r4 opaque forms (wrapper bodies,
# function bodies, groups and compound commands, substitution, stdin-as-code: C4_W, C4_G, C4_F as written).
PROP_FORMS = tuple(C4_W.values()) + tuple(C4_G.values()) + tuple(C4_F.values())
PROP_SETS = len(PROP_RANGES) + 1
# The seeds R5-GATE runs (V3F2_PROP_SEED picks one; the gate adds a fresh one per run).
PROP_SEEDS = (20261021, 31415926, 27182818, 16180339)
PROP_OPS = ("; ", " && ", " || ", " | ", "\n", " & ")
PROP_JOINED = 200        # joined lines per range
PROP_SAMPLES = 50        # (mode, level matrix, function grants) per joined line ⇒ 3 × 200 × 50 = 30 000
# The environments a line is read in: its Privacy switches (any of on / undecided / OFF per switch) and the class
# grants of the body (standing, this session, another session) — the classifier reads both.
PROP_ENVS_N = 8
PROP_SWITCHES = ("on", "on", "undecided", "off")
PROP_GRANT_SCOPES = ("standing", "s1", "s9")
# The lines are read in a directory no test and no user process can write (it does not exist, and only root could
# create it): a relative path in a corpus line never meets a file another run left in a shared temp directory.
PROP_CWD = "/var/empty/iclone-f2-prop"
LINES_FIXTURE = PLUGIN_DIR / "tests" / "fixtures" / "functions_lines.json"
_SEV = {"allow": 0, "ask": 1, "refuse": 2}


def _grant(scope, **what):
    if scope == "standing":
        return {**what, "scope": "standing"}
    return {**what, "scope": "session", "sessionId": scope}


def _prop_envs(rng):
    envs = [{"ceilings": _ceilings("on"), "grants": []}, {"ceilings": _ceilings("undecided"), "grants": []}]
    while len(envs) < PROP_ENVS_N:
        grants = [_grant(rng.choice(PROP_GRANT_SCOPES), id=f"g{cls}", cls=cls)
                  for cls in CLASSES if cls not in ("R", "$") and rng.random() < 0.25]
        envs.append({"ceilings": {k: rng.choice(PROP_SWITCHES) for k in CEILING_KEYS}, "grants": grants})
    return envs


def _env_body(env, **over):
    return _body(ceilings=env["ceilings"], grants=env["grants"], **over)


def _prop_levels(rng):
    """Half uniform matrices, half the critics' shape: one or two rows strict, every other row lax."""
    if rng.random() < 0.5:
        return {fn: rng.choice(LEVELS) for fn in FUNCTIONS}
    lax = rng.choice(("ignore", "automatic"))
    levels = {fn: lax for fn in FUNCTIONS}
    for fn in rng.sample(FUNCTIONS, rng.choice((1, 2))):
        levels[fn] = rng.choice(("manual", "askAlways", "askOnce", "automatic", "mode"))
    return levels


def _prop_fn_grants(rng):
    return [_grant(rng.choice(PROP_GRANT_SCOPES), id=f"f{fn}", fn=fn) for fn in FUNCTIONS if rng.random() < 0.2]


def _nseg(line):
    from hermes_plugins.iclone_permissions.functions import _segments

    return len(_segments(line)[0])


def _prop_piece(rng, size, by_size):
    """Corpus lines joined with random operators until the piece has ``size`` segments (never more)."""
    lines, left = [], size
    while left > 0:
        fits = [n for n in by_size if n <= left]
        line = rng.choice(by_size[rng.choice(fits)])
        lines.append(line)
        left -= _nseg(line)
    out = lines[0]
    for line in lines[1:]:
        out += rng.choice(PROP_OPS) + line
    return out


def _prop_joined(rng, n_envs):
    """(range index, pieces, joined line, env index) — PROP_JOINED per range, seeded."""
    by_size = {}
    for line in PROP_LINES:
        n = _nseg(line)
        if n >= 1:
            by_size.setdefault(n, []).append(line)
    out = []
    for r_i, (lo, hi) in enumerate(PROP_RANGES):
        count = 0
        while count < PROP_JOINED:
            k = rng.choice((2, 2, 3))
            total = rng.randint(max(lo, k), hi)
            sizes = [2 if total >= 2 * k else 1] * k
            for _ in range(total - sum(sizes)):
                sizes[rng.randrange(k)] += 1
            pieces = [_prop_piece(rng, size, by_size) for size in sizes]
            joined = pieces[0]
            for piece in pieces[1:]:
                joined += rng.choice(PROP_OPS) + piece
            if lo <= _nseg(joined) <= hi:
                out.append((r_i, tuple(pieces), joined, rng.randrange(n_envs)))
                count += 1
    for _ in range(PROP_JOINED):
        form = rng.choice(PROP_FORMS)
        pieces = [_prop_piece(rng, rng.choice((1, 1, 2, 3)), by_size) for _ in range(1 if "{x}" in form else 2)]
        joined = form.format(x=pieces[0]) if "{x}" in form else form.format(a=pieces[0], b=pieces[1])
        out.append((len(PROP_RANGES), tuple(pieces), joined, rng.randrange(n_envs)))
    return out


_READINGS = {}   # (line, env index) → (call, fns): shared by the property gate and main's lines table


def _prop_read(line, env_i, envs, _unused=None):
    from hermes_plugins.iclone_permissions.classify import classify
    from hermes_plugins.iclone_permissions.functions import functions_of

    key = (line, env_i)
    if key not in _READINGS:
        env = envs[env_i]
        body = _env_body(env, functions={"shell": "askOnce"})
        call = classify("terminal", {"command": line}, PROP_CWD, body, session_id="s1")
        _READINGS[key] = (call, functions_of("terminal", {"command": line}, call, cwd=PROP_CWD, policy=body,
                                             session_id="s1"))
    return _READINGS[key]


def _prop_decide(policy, reading, env, mode, levels, fn_grants, fns_on=True):
    call, fns = reading
    body = _env_body(env, standing=mode, functions=levels, fnGrants=fn_grants)
    return _SEV[policy.decide(body, cls=call.cls, facts=dict(call.facts), floor=call.floor,
                              ceiling_key=call.ceiling_key, session_id="s1", project=call.project,
                              fns=fns if fns_on else None).outcome]


def _prop_setup(plugin):
    import random

    rng = random.Random(PROP_SEED)
    envs = _prop_envs(rng)
    return rng, envs, _prop_joined(rng, len(envs)), None


def _whole_only(reading):
    """The same reading with part 0 alone: the line decided on its own whole reading (class, facts, floor, switch);
    an unread line stays unread (main's ``wholeOnly``, the same rule)."""
    from hermes_plugins.iclone_permissions.functions import Functions

    call, fns = reading
    return call, Functions(tuple(fns), fns.parts[:1], True, unread=fns.unread)


class TestF2R4Property:
    """R4-GEN. A joined line read in full never decides below a piece it joins (every part decides with its own
    class). An UNREAD joined line (R4-UNREAD) never allows when a piece does not, and keeps every refusal a piece gets
    from its own whole reading (its floor, its switch, a Manual row, its mode cell); a piece refused only through the
    floor of one of its own sub-runs read out of context (the assignment before a variable dropped, …) asks — that is
    the rule as written (an unread line asks; only its own floors, switches and Manual refuse) and it is counted apart.
    V3-F's own share (every row at its default) is counted apart: the classifier is frozen (F2-6)."""

    def test_r4_prop_decision_is_monotone_in_parts_over_three_ranges_and_the_forms(self, plugin):
        policy = _policy(plugin)
        rng, envs, joined_lines, _ = _prop_setup(plugin)
        n = PROP_SETS
        combos, f2, unread, part_floor_asks = [0] * n, [0] * n, [0] * n, [0] * n
        v3f = 0
        examples = []
        for r_i, pieces, joined, env_i in joined_lines:
            env = envs[env_i]
            readings = [_prop_read(p, env_i, envs) for p in pieces]
            whole = _prop_read(joined, env_i, envs)
            unread[r_i] += whole[1].unread
            for _ in range(PROP_SAMPLES):
                mode, levels, grants = rng.choice(MODES), _prop_levels(rng), _prop_fn_grants(rng)
                combos[r_i] += 1
                alone = max(_prop_decide(policy, r, env, mode, levels, grants) for r in readings)
                got = _prop_decide(policy, whole, env, mode, levels, grants)
                want = alone
                if whole[1].unread:
                    own = max(_prop_decide(policy, _whole_only(r), env, mode, levels, grants) for r in readings)
                    want = max(min(alone, _SEV["ask"]), own)
                    part_floor_asks[r_i] += got < alone
                if got < want:
                    f2[r_i] += 1
                    if len(examples) < 3:
                        examples.append((r_i, env_i, mode, {f: lv for f, lv in levels.items() if lv != "mode"},
                                         [r[0].cls for r in readings], whole[0].cls, whole[1].unread))
                # V3-F alone on the same combination (every row at its default): the classifier's own share
                if max(_prop_decide(policy, r, env, mode, {}, grants, False) for r in readings) > \
                        _prop_decide(policy, whole, env, mode, {}, grants, False):
                    v3f += 1
        print(f"R4-PROP seed={PROP_SEED} combinations={sum(combos)} lines={len(PROP_LINES)} envs={len(envs)} "
              f"ranges={'/'.join('%d-%d' % r for r in PROP_RANGES)}/forms per_range={'/'.join(map(str, combos))} "
              f"unread_joined={'/'.join(map(str, unread))} f2_violations={'/'.join(map(str, f2))} "
              f"unread_part_floor_asks={'/'.join(map(str, part_floor_asks))} v3f_violations={v3f}")
        assert sum(f2) == 0, examples
        assert sum(combos) >= 40_000 and min(combos) >= 10_000
        assert min(unread[1:]) == PROP_JOINED  # every line past _K_SEG, and every opaque form, is unread

    def test_r4_prop_the_lines_table_main_replays_is_current(self, plugin):
        # functions_lines.json (main's half of R4-GEN, functions.test.ts): the same joined lines and pieces, as the
        # plugin reads them in their env — class, facts, floor, switch key, functions and the PARTS IT SENDS MAIN
        # ([] = unread) — and each env's switches and the classes its grants cover for this session, so main's own
        # parse, cover, unread rule and decision are tested on real readings. V3F2_WRITE_LINES=1 rewrites it.
        import os

        _rng, envs, joined_lines, _ = _prop_setup(plugin)
        current = _lines_table(envs, joined_lines)
        out = os.environ.get("V3F2_LINES_OUT")
        if out:  # R5-GATE: the table for any seed, written where main is told to read it (V3F2_LINES_PATH)
            Path(out).write_text(json.dumps(current, separators=(",", ":")) + "\n")
        if PROP_SEED != PROP_SEEDS[0]:
            return  # the committed table is the default seed's
        if os.environ.get("V3F2_WRITE_LINES") == "1":
            LINES_FIXTURE.write_text(json.dumps(current, separators=(",", ":")) + "\n")
        assert json.loads(LINES_FIXTURE.read_text()) == current


def _mask(fns):
    return sum(1 << FUNCTIONS.index(fn) for fn in fns)


def _lines_table(envs, joined_lines):
    from hermes_plugins.iclone_permissions.policy import matching_grant

    classes = FN_FIXTURE["order"]["classes"]
    facts_keys = ("dangerous", "getOnly", "inProject", "privileged")

    def term(cls, facts, floor, key, fns):
        facts = dict(facts)
        return [classes.index(cls), [facts.get(k) for k in facts_keys], bool(floor), key, _mask(fns)]

    payloads, index = [], {}
    # the generated envs, then the probes' own: the Terminal switch OFF (K1)
    envs = list(envs) + [{"ceilings": C4_TERMINAL_OFF, "grants": []}]
    k1_env = len(envs) - 1

    def payload(line, env_i):
        if (line, env_i) not in index:
            call, fns = _prop_read(line, env_i, envs)
            index[(line, env_i)] = len(payloads)
            payloads.append([term(call.cls, call.facts, call.floor, call.ceiling_key, fns),
                             [term(p.cls, p.facts, p.floor, p.ceiling_key, p.fns) for p in fns.parts],
                             bool(fns.unread)])
        return index[(line, env_i)]

    combos = [[payload(p, env_i) for p in pieces] + [payload(joined, env_i), env_i, r_i]
              for r_i, pieces, joined, env_i in joined_lines]
    # critic r3 C3-1 S1 (long-pad) and S2 (middle-run), read in env 0, decided by main under the critic's bodies
    probes = []
    for bname, pad in (("allAuto", 21), ("allIgnore_shellAuto", 23), ("allAuto", 30)):
        pieces = (R3_DX, "; ".join(["true"] * pad + [R3_SPEND]))
        probes.append({"id": f"S1-{bname}-pad{pad}", **C3_1_BODIES[bname],
                       "pieces": [payload(p, 0) for p in pieces], "joined": payload("; ".join(pieces), 0)})
    for bname, pad in (("allAuto", 0), ("allIgnore_filesAuto", 5), ("allAuto", 10)):
        pieces = ("; ".join([R3_SPEND] + ["true"] * pad), R3_CDRM, R3_SPEND)
        probes.append({"id": f"S2-{bname}-pad{pad}", **C3_1_BODIES[bname],
                       "pieces": [payload(p, 0) for p in pieces], "joined": payload("; ".join(pieces), 0)})
    # critic r4 (R5-D, R5-G): every probe, read in its own switches, decided by main under the critic's bodies
    for pid, over, pieces, joined, want in _c4_probe_cases():
        env_i = k1_env if over.get("ceilings") == C4_TERMINAL_OFF else 0
        probes.append({"id": pid, "standing": over.get("standing", "manual"), "functions": over["functions"],
                       "env": env_i, "want": want, "pieces": [payload(p, env_i) for p in pieces],
                       "joined": payload(joined, env_i)})
    return {
        "note": "Generated by tests/plugins/test_iclone_permissions_functions.py (V3F2_WRITE_LINES=1). R4-GEN: "
                "payload = [line term, the parts the plugin sends ([] = unread), the unread flag]; term = [class index, facts "
                "(dangerous, getOnly, inProject, privileged), floor, switch key, functions mask]; combo = [piece "
                "payloads…, joined payload, env, range]; env = the switches and the classes granted to session s1.",
        "seed": PROP_SEED,
        "ranges": [list(r) for r in PROP_RANGES] + [[0, 0]],  # the last set: the opaque forms
        "envs": [{"ceilings": env["ceilings"],
                  "granted": [c for c in classes if c != "$" and matching_grant(_env_body(env), c, "s1", None)]}
                 for env in envs],
        "payloads": payloads,
        "combos": combos,
        "probes": probes,
    }
