"""icloneOS V3-J (fix m-r4-1): a pay env belongs to the profile folder it was minted for.

The critic's probe, kept as tests: Hermes' OWN spawn functions (a cron delivery to another profile's Bot Chat, a
kanban worker) run with a fake ``subprocess`` and a throwaway HOME / HERMES_HOME (never ``~/.hermes``), and the env
they hand the child is read. A child of another profile gets none of the pay names; a child of the same folder keeps
them. A Hermes process started for another profile drops an inherited pay env at boot.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from hermes_cli import iclone_pay_env

PAY_KEYS = {"ICLONE_PAY_SOCKET", "ICLONE_PAY_TOKEN_FILE", "ICLONE_PAY_HOME"}
REPO = Path(__file__).resolve().parents[2]


@pytest.fixture()
def world(tmp_path, monkeypatch):
    """A Hermes home with profiles ``ann`` (the one the token is minted for) and ``bee``; the backend runs as ``ann``."""
    home = tmp_path / ".hermes"
    ann = home / "profiles" / "ann"
    bee = home / "profiles" / "bee"
    for folder in (ann, bee):
        folder.mkdir(parents=True)
        (folder / "config.yaml").write_text("{}\n")  # 1ac3f97: a named profile needs an identity marker to be live
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(ann))
    monkeypatch.setenv("ICLONE_PAY_SOCKET", str(tmp_path / "pay.sock"))
    monkeypatch.setenv("ICLONE_PAY_TOKEN_FILE", str(tmp_path / "pay-0000000000000000.token"))
    monkeypatch.setenv("ICLONE_PAY_HOME", iclone_pay_env.home_id(str(ann)))
    return {"home": home, "ann": ann, "bee": bee}


def _grab(store, name):
    def fake(cmd, *args, **kwargs):
        env = kwargs.get("env")
        store[name] = sorted(k for k in (env if env is not None else os.environ) if k.startswith("ICLONE_PAY"))

        class Result:
            returncode = 0
            stdout = ""
            stderr = ""
            pid = 4242

        return Result()

    return fake


def test_home_id_follows_links_and_refuses_non_folders(tmp_path):
    folder = tmp_path / "f"
    folder.mkdir()
    (tmp_path / "link").symlink_to(folder)
    (tmp_path / "file").write_text("x")
    assert iclone_pay_env.home_id(str(folder)) == iclone_pay_env.home_id(str(tmp_path / "link"))
    assert iclone_pay_env.home_id(str(tmp_path / "file")) is None
    assert iclone_pay_env.home_id(str(tmp_path / "missing")) is None
    assert iclone_pay_env.home_id(None) is None


def test_for_child_keeps_the_names_only_for_the_folder_they_were_minted_for(world):
    same = iclone_pay_env.for_child(dict(os.environ), str(world["ann"]))
    other = iclone_pay_env.for_child(dict(os.environ), str(world["bee"]))
    unknown = iclone_pay_env.for_child(dict(os.environ), None)
    unbound = dict(os.environ)
    unbound.pop("ICLONE_PAY_HOME")
    assert PAY_KEYS <= set(same)
    assert not PAY_KEYS & set(other)
    assert not PAY_KEYS & set(unknown)
    assert not PAY_KEYS & set(iclone_pay_env.for_child(unbound, str(world["ann"])))


def test_cron_bot_chat_delivery_to_another_profile_carries_no_pay_env(world, monkeypatch):
    # 1ac3f97 moved the delivery to cron/scheduler_delivery.py and builds the child env with
    # served_profile_child_env(target_home=…), which binds the pay env to that home (V3-UP r4 port).
    from cron import scheduler_delivery
    from tools import bot_live_delivery

    seen = {}
    monkeypatch.setattr(bot_live_delivery, "find_canonical_live_owner", lambda *a, **k: None)

    def capture(name):
        def fake(argv, env, report_path, timeout):
            seen[name] = sorted(k for k in env if k.startswith("ICLONE_PAY"))
            raise RuntimeError("captured")
        return fake

    monkeypatch.setattr(scheduler_delivery, "_run_bot_chat_turn", capture("bee"))
    scheduler_delivery._deliver_to_bot_chat({"id": "j1", "name": "probe"}, "hello", "bee")
    monkeypatch.setattr(scheduler_delivery, "_run_bot_chat_turn", capture("own"))
    scheduler_delivery._deliver_to_bot_chat({"id": "j2", "name": "probe"}, "hello", "")
    assert seen["bee"] == []
    # The job's own profile: the child runs in the same folder (and checks it again at boot).
    assert set(seen["own"]) == PAY_KEYS


def test_kanban_worker_keeps_the_pay_env_only_in_the_minted_folder(world, monkeypatch, tmp_path):
    from hermes_cli import kanban_db_dispatch as kanban_db  # 1ac3f97 moved _default_spawn here

    seen = {}

    class Task:
        id = "t_probe"
        tenant = None
        skills = None
        model_override = None
        provider_override = None
        branch_name = None
        current_run_id = None
        claim_lock = None
        goal_mode = None
        goal_max_turns = None

        def __init__(self, assignee):
            self.assignee = assignee

        def __getattr__(self, name):
            return None

    # The dispatcher runs from the root home (the kanban board's owner), assigning to each profile.
    monkeypatch.setenv("HERMES_HOME", str(world["home"]))
    monkeypatch.setattr(subprocess, "Popen", _grab(seen, "bee"))
    try:
        kanban_db._default_spawn(Task("bee"), str(tmp_path))
    except Exception:  # noqa: BLE001 — anything after the spawn is not this test's
        pass
    monkeypatch.setattr(subprocess, "Popen", _grab(seen, "ann"))
    try:
        kanban_db._default_spawn(Task("ann"), str(tmp_path))
    except Exception:  # noqa: BLE001
        pass
    assert seen["bee"] == []
    assert set(seen["ann"]) == PAY_KEYS


_BOOT = "\n".join(
    [
        "import json, os, sys",
        "sys.argv = ['hermes'] + json.loads(os.environ['T_ARGS'])",
        "import hermes_cli.main  # noqa: F401 (the override and the pay binding run at import)",
        "from hermes_cli import iclone_policy_env",
        "iclone_policy_env.restore_environ()",
        "print(json.dumps(sorted(k for k in os.environ if k.startswith('ICLONE_PAY'))))",
    ]
)


def _boot(world, args, extra=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith("ICLONE_")}
    env.update(
        {
            "HOME": str(world["home"].parent),
            "HERMES_HOME": str(world["ann"]),
            "PYTHONPATH": str(REPO),
            "T_ARGS": json.dumps(args),
            "ICLONE_POLICY_LOCK": "1",
            "ICLONE_PAY_SOCKET": os.environ["ICLONE_PAY_SOCKET"],
            "ICLONE_PAY_TOKEN_FILE": os.environ["ICLONE_PAY_TOKEN_FILE"],
            "ICLONE_PAY_HOME": os.environ["ICLONE_PAY_HOME"],
        }
    )
    env.update(extra or {})
    out = subprocess.run([sys.executable, "-c", _BOOT], cwd=str(REPO), env=env, capture_output=True, text=True,
                         timeout=180)
    lines = [line for line in out.stdout.splitlines() if line.startswith("[")]
    assert lines, out.stderr[-2000:]
    return json.loads(lines[-1])


def test_a_hermes_started_for_another_profile_drops_the_inherited_pay_env_at_boot(world):
    # `hermes -p bee` from ann's environment (what cron, kanban and the dashboard do), exec-time env included:
    # restore_environ() must not bring the names back.
    assert _boot(world, ["-p", "bee", "--version"]) == []
    # The same process for ann keeps them.
    assert set(_boot(world, ["-p", "ann", "--version"])) == PAY_KEYS
    # A pay env with no folder named is never trusted.
    assert _boot(world, ["-p", "ann", "--version"], {"ICLONE_PAY_HOME": ""}) == []


def test_main_binds_right_after_the_profile_override():
    text = (REPO / "hermes_cli" / "main.py").read_text(encoding="utf-8")
    at = text.index("\n_apply_profile_override()\n")
    assert "_iclone_pay_env.bind_at_boot()" in text[at: at + 600]


# m-r5-1: the subprocess env factories and the tui_gateway entry points.


def test_terminal_child_of_an_in_process_session_of_another_profile_gets_no_pay_env(world):
    from hermes_constants import set_hermes_home_override
    from tools.environments import local

    token = set_hermes_home_override(str(world["bee"]))
    try:
        for env in (local.build_subprocess_env(), local.build_subprocess_env(scrub_secrets=False),
                    local._make_run_env({})):
            assert env["HERMES_HOME"] == str(world["bee"])
            assert not PAY_KEYS & set(env)
    finally:
        _reset_override(token)
    # The session's own profile keeps them (that is where the x402-pay client runs).
    token = set_hermes_home_override(str(world["ann"]))
    try:
        assert PAY_KEYS <= set(local.build_subprocess_env())
        assert PAY_KEYS <= set(local._make_run_env({}))
    finally:
        _reset_override(token)


def _reset_override(token):
    from hermes_constants import reset_hermes_home_override

    reset_hermes_home_override(token)


def test_slash_worker_env_for_another_profile_gets_no_pay_env(world):
    from tools.environments import local

    # tui_gateway.server _SlashWorker builds its env this way, with the session's profile home applied last.
    bee = local.build_subprocess_env(extra={"HERMES_HOME": str(world["bee"])})
    ann = local.build_subprocess_env(extra={"HERMES_HOME": str(world["ann"])})
    raw = local.build_subprocess_env(scrub_secrets=False, extra={"HERMES_HOME": str(world["bee"])})
    assert not PAY_KEYS & set(bee)
    assert not PAY_KEYS & set(raw)
    assert PAY_KEYS <= set(ann)


def test_tui_gateway_entry_points_bind_at_boot():
    for rel in ("tui_gateway/entry.py", "tui_gateway/slash_worker.py"):
        text = (REPO / rel).read_text(encoding="utf-8")
        at = text.index("hermes_bootstrap.harden_import_path()\n")
        assert "_iclone_pay_env.bind_at_boot()" in text[at: at + 600], rel


# m-r6-1: the fourth factory and the dashboard chat PTY of another profile.


def test_hermes_subprocess_env_of_another_profile_gets_no_pay_env(world):
    from hermes_constants import set_hermes_home_override
    from tools.environments import local

    token = set_hermes_home_override(str(world["bee"]))
    try:
        env = local.hermes_subprocess_env(inherit_credentials=True)
        assert env["HERMES_HOME"] == str(world["bee"])
        assert not PAY_KEYS & set(env)
    finally:
        _reset_override(token)
    token = set_hermes_home_override(str(world["ann"]))
    try:
        assert PAY_KEYS <= set(local.hermes_subprocess_env())
    finally:
        _reset_override(token)


def test_dashboard_chat_pty_of_another_profile_gets_no_pay_env(world, monkeypatch):
    from hermes_cli import web_server_chat as web_server  # 1ac3f97 moved _resolve_chat_argv here

    # The dashboard runs from the root home with a token minted for it; the chat PTY is asked for profile bee.
    monkeypatch.setenv("HERMES_HOME", str(world["home"]))
    monkeypatch.setenv("ICLONE_PAY_HOME", iclone_pay_env.home_id(str(world["home"])))
    # The Node TUI build is not under test (and would need npm): only the env the PTY gets is.
    from hermes_cli import main_tui_launch
    monkeypatch.setattr(main_tui_launch, "_make_tui_argv", lambda root, tui_dev=False: (["node", "tui"], str(root)))
    _argv, _cwd, bee = web_server._resolve_chat_argv(profile="bee")
    _argv, _cwd, own = web_server._resolve_chat_argv()
    assert bee["HERMES_HOME"].endswith("bee")
    assert not PAY_KEYS & set(bee)
    assert PAY_KEYS <= set(own)
