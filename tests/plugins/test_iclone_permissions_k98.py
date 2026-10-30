"""K98 (V3-K pass 2, S2) — the plugin's half. main's ``protectedPaths`` (pinned in
``plugins/iclone-permissions/tests/fixtures/protected_paths_k98.json`` by the vitest
``protected-paths.k98.test.ts``) reaches the plugin in the signed policy body. With that list, every way of
removing or rewriting V3-I's audit chain, the pocket key or a confinement membership token is a floor refusal in
all five modes, whatever the mode table says. Temp HERMES_HOME only (autouse fixture of the plugin tests)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.plugins.test_iclone_permissions import (  # noqa: F401
    MODES, _decide_all_modes, _isolated, plugin,
)

FIXTURE = json.loads((Path(__file__).resolve().parents[2] / "plugins" / "iclone-permissions" / "tests" / "fixtures"
                      / "protected_paths_k98.json").read_text())
PROTECTED = FIXTURE["protectedPaths"]
UD = FIXTURE["input"]["userDataDir"]
AUDIT = f"{UD}/acp-work/audit"
POCKET = f"{UD}/payments/keys/pocket.sealed"
MEMBERS = f"{FIXTURE['input']['home']}/Library/Caches/iclone-os-confinement/members"

TERMINAL = [
    f"rm -rf {AUDIT}",
    f"rm {AUDIT}/chain.jsonl",
    f"mv {AUDIT} /tmp/old-audit",
    f": > {AUDIT}/chain.jsonl",
    f"rm -f {POCKET}",
    f"mv {POCKET} /tmp/k",
    f"rm -rf {UD}/payments",
    f"touch {MEMBERS}/forged",
    f"rm -rf {MEMBERS}",
]

FILE_TOOLS = [
    ("write_file", {"path": f"{AUDIT}/chain.jsonl", "content": ""}),
    ("write_file", {"path": f"{AUDIT}/interim.key", "content": "x"}),
    ("write_file", {"path": POCKET, "content": ""}),
    ("write_file", {"path": f"{MEMBERS}/forged", "content": ""}),
    ("patch", {"mode": "patch", "patch": f"*** Begin Patch\n*** Delete File: {POCKET}\n*** End Patch\n"}),
    ("patch", {"mode": "patch", "patch": f"*** Begin Patch\n*** Delete File: {AUDIT}/chain.jsonl\n*** End Patch\n"}),
]


def _floored_everywhere(plugin_mod, tool, args, cwd):
    res = _decide_all_modes(plugin_mod, tool, args, cwd, protectedPaths=PROTECTED)
    assert set(res) == set(MODES)
    return {m: (v.outcome, v.rule, c.floor) for m, (v, c) in res.items()}


@pytest.mark.parametrize("command", TERMINAL)
def test_terminal_cannot_reset_audit_or_remove_pocket_key(plugin, tmp_path, command):
    got = _floored_everywhere(plugin, "terminal", {"command": command}, str(tmp_path))
    for mode, (outcome, rule, floor) in got.items():
        assert (outcome, rule) == ("refuse", "floor"), (mode, command, got[mode])
        assert floor and floor.startswith("policy"), (mode, command, floor)


@pytest.mark.parametrize("tool,args", FILE_TOOLS)
def test_file_tools_cannot_reset_audit_or_remove_pocket_key(plugin, tmp_path, tool, args):
    got = _floored_everywhere(plugin, tool, args, str(tmp_path))
    for mode, (outcome, rule, floor) in got.items():
        assert (outcome, rule) == ("refuse", "floor"), (mode, tool, got[mode])


def test_without_the_k98_paths_the_same_writes_are_not_floored(plugin, tmp_path):
    """Negative control: the floor comes from the three K98 entries, not from something else in the command."""
    k98 = {f"{UD}/acp-work", f"{UD}/payments", MEMBERS}
    without = [p for p in PROTECTED if p not in k98]
    assert len(without) == len(PROTECTED) - 3
    for command in (f"rm -rf {AUDIT}", f"rm -f {POCKET}", f"touch {MEMBERS}/forged"):
        res = _decide_all_modes(plugin, "terminal", {"command": command}, str(tmp_path), protectedPaths=without)
        assert any(c.floor is None for _, c in res.values()), command


def test_project_writes_beside_the_store_names_stay_ordinary(plugin, tmp_path):
    (tmp_path / ".git").mkdir()
    res = _decide_all_modes(plugin, "write_file", {"path": str(tmp_path / "acp-work" / "audit" / "notes.md")},
                            str(tmp_path), protectedPaths=PROTECTED)
    assert all(c.floor is None for _, c in res.values())
