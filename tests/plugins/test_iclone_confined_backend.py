"""FX35: while a process was started confined, what the app set at exec decides the terminal backend.

Every case is a real process with a throwaway HOME and the exec environment main gives a confined Hermes, in the real
order: ``import hermes_cli.main`` (its module-level dotenv pass and config bridge) and only then plugin discovery. That
order is what the old test of the pin got backwards: it imported the plugin with the right value and simulated the
bridge afterwards. The scenario letters are the table in the v0.0.5 shell-refusal diagnosis.

The kernel half (a real command, a refused write, the ack) is ``shell-with-template.live.test.ts``.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
TEMPLATE = REPO / "cli-config.yaml.example"
SEATBELT = "iclone_seatbelt"
APP_PROJECT = "/private/tmp/fx35-app-project"
CONFINED_EXEC = {"ICLONE_CONFINEMENT": "1", "TERMINAL_ENV": SEATBELT, "ICLONE_CONFINEMENT_SPEC": "{}",
                 "TERMINAL_CWD": APP_PROJECT}

# Imports the real main, then does what main's serve path does, then reports what each reader sees.
DRIVER = r"""
import json, os, sys
sys.argv = ["hermes"] + sys.argv[1:]
import hermes_cli.main  # the module body: load_hermes_dotenv and its config bridge
from hermes_cli.config import apply_terminal_config_to_env
apply_terminal_config_to_env()  # main.py's bridge just before discovery
from hermes_cli.plugins import discover_plugins
discover_plugins()

def plugin():
    for name, mod in list(sys.modules.items()):
        if name.startswith("hermes_plugins.iclone_confinement") and hasattr(mod, "EXPECTED_BACKEND"):
            yield mod

def hook():
    verdicts = [m.on_pre_tool_call(tool_name="terminal") for m in plugin()]
    bad = [v["message"] for v in verdicts if v]
    return bad[0] if bad else "pass"

def tool():
    from tools.terminal_tool import _get_env_config
    from tools.terminal_scope import TerminalPolicyUnavailable
    try:
        return _get_env_config()["env_type"]
    except TerminalPolicyUnavailable as exc:
        return "refused: " + str(exc)

mods = list(plugin())
report = {"expected": sorted({m.EXPECTED_BACKEND for m in mods}), "start_env": os.environ.get("TERMINAL_ENV"),
          "start_hook": hook()}
# The first tool with no scope runs the one-shot bridge (the third defect), then a later one.
report["first_tool"] = tool()
report["first_env"] = os.environ.get("TERMINAL_ENV")
report["first_hook"] = hook()
report["later_tool"] = tool()
report["later_hook"] = hook()
ack = os.environ.get("FX35_ACK")
own = ack and "%s.%d%s" % (*(lambda s: (s[0], os.getpid(), s[1]))(os.path.splitext(ack)),)
report["ack"] = json.load(open(own)).get("backend") if own and os.path.exists(own) else None
print("FX35-JSON" + json.dumps(report))
"""


def run_driver(tmp_path: Path, argv=(), exec_env=None, driver: str = DRIVER, extra: tuple = ()) -> dict:
    home = tmp_path / "h"
    ack = tmp_path / "ack.json"
    env = {
        "PATH": "/usr/bin:/bin", "HOME": str(home), "HERMES_HOME": str(home / ".hermes"),
        "PYTHONPATH": str(REPO), "PYTHONDONTWRITEBYTECODE": "1", "LANG": "C", "FX35_ACK": str(ack),
        "TMPDIR": os.environ.get("TMPDIR", "/private/tmp"),
        **(exec_env if exec_env is not None else {**CONFINED_EXEC, "ICLONE_CONFINEMENT_ACK": str(ack)}),
    }
    run = subprocess.run([sys.executable, "-c", driver, *argv, *extra], cwd=str(tmp_path), env=env,
                         capture_output=True, text=True, timeout=180)
    line = next((part for part in (run.stdout + "\n" + run.stderr).splitlines() if part.startswith("FX35-JSON")), None)
    assert line, f"driver ended rc={run.returncode} without a report\n{run.stdout[-800:]}\n{run.stderr[-3000:]}"
    return json.loads(line[len("FX35-JSON"):])


def hermes_home(tmp_path: Path) -> Path:
    path = tmp_path / "h" / ".hermes"
    path.mkdir(parents=True, exist_ok=True)
    return path


def profile_home(tmp_path: Path, name: str) -> Path:
    path = hermes_home(tmp_path) / "profiles" / name
    path.mkdir(parents=True, exist_ok=True)
    return path


def assert_confined(report: dict) -> None:
    assert report["expected"] == [SEATBELT]
    assert report["ack"] == SEATBELT
    for key in ("start_env", "first_env", "first_tool", "later_tool"):
        assert report[key] == SEATBELT, f"{key}: {report}"
    for key in ("start_hook", "first_hook", "later_hook"):
        assert report[key] == "pass", f"{key}: {report}"


# Scenario A-H: nothing here may refuse an honest command or leave the sandbox.
def _a_none(tmp_path):
    hermes_home(tmp_path)
    return ()


def _b_empty(tmp_path):
    (hermes_home(tmp_path) / "config.yaml").write_text("terminal: {}\n")
    return ()


def _c_template(tmp_path):
    shutil.copyfile(TEMPLATE, hermes_home(tmp_path) / "config.yaml")
    return ()


def _d_literal(tmp_path):
    (hermes_home(tmp_path) / "config.yaml").write_text('terminal:\n  backend: "local"\n')
    return ()


def _e_profile_no_section(tmp_path):
    (hermes_home(tmp_path) / "config.yaml").write_text("model: {}\n")
    (profile_home(tmp_path, "inft-x") / "config.yaml").write_text("model: {}\n")
    return ("--profile", "inft-x")


def _f_profile_template(tmp_path):
    shutil.copyfile(TEMPLATE, profile_home(tmp_path, "inft-y") / "config.yaml")
    return ("--profile", "inft-y")


def _g_dotenv(tmp_path):
    (hermes_home(tmp_path) / ".env").write_text("TERMINAL_ENV=local\n")
    return ()


def _h_saved(tmp_path):
    home = hermes_home(tmp_path)
    env = {"PATH": "/usr/bin:/bin", "HOME": str(tmp_path / "h"), "HERMES_HOME": str(home), "PYTHONPATH": str(REPO),
           "PYTHONDONTWRITEBYTECODE": "1"}
    subprocess.run([sys.executable, "-c",
                    "from hermes_cli.config import load_config, save_config; save_config(load_config())"],
                   cwd=str(tmp_path), env=env, check=True, capture_output=True, timeout=120)
    return ()


@pytest.mark.parametrize(
    "scenario",
    [_a_none, _b_empty, _c_template, _d_literal, _e_profile_no_section, _f_profile_template, _g_dotenv, _h_saved],
    ids=["A-no-config", "B-empty-terminal", "C-installer-template", "D-literal-local", "E-profile-no-section",
         "F-profile-template", "G-dotenv-local", "H-saved-config"],
)
def test_scenario_table_every_reader_sees_the_app_backend(tmp_path, scenario):
    assert_confined(run_driver(tmp_path, scenario(tmp_path)))


@pytest.mark.parametrize("backend", ["docker", "ssh", "modal", "singularity", "daytona", "vercel_sandbox", "iclone_container"])
def test_a_config_asking_for_another_backend_stays_refused_with_a_clear_message(tmp_path, backend):
    (hermes_home(tmp_path) / "config.yaml").write_text(f"terminal:\n  backend: {backend}\n")
    report = run_driver(tmp_path)
    # The environment never says the other backend: a reader that skips the refusal still gets the sandbox.
    assert report["expected"] == [SEATBELT] and report["start_env"] == SEATBELT and report["first_env"] == SEATBELT
    for key in ("start_hook", "first_hook", "later_hook", "first_tool", "later_tool"):
        assert backend in report[key] and "icloneOS confinement" in report[key] and "restart" in report[key], report[key]


def test_a_dotenv_asking_for_another_backend_stays_refused(tmp_path):
    (hermes_home(tmp_path) / ".env").write_text("TERMINAL_ENV=docker\n")
    report = run_driver(tmp_path)
    assert report["start_env"] == SEATBELT and "docker" in report["start_hook"] and "docker" in report["first_tool"]


def test_explicit_local_in_config_beats_a_stale_foreign_dotenv(tmp_path):
    """Upstream's precedence (config over .env, #29186) still decides what was ASKED; only then the pin applies."""
    home = hermes_home(tmp_path)
    (home / ".env").write_text("TERMINAL_ENV=docker\n")
    shutil.copyfile(TEMPLATE, home / "config.yaml")
    assert_confined(run_driver(tmp_path))


def test_a_top_level_terminal_that_is_not_a_mapping_still_settles(tmp_path):
    (hermes_home(tmp_path) / "config.yaml").write_text("terminal: 5\n")
    assert_confined(run_driver(tmp_path))


def test_a_dotenv_cannot_switch_the_plugin_off_for_a_confined_process(tmp_path):
    """No lock here, so restore_environ does not undo it: without the plugin its backend would be unknown, a refusal."""
    (hermes_home(tmp_path) / ".env").write_text("ICLONE_CONFINEMENT=0\nTERMINAL_ENV=local\n")
    assert_confined(run_driver(tmp_path))


# Turn routed to a profile: the second defect. The real scope function, under a real multiplex.
ROUTED = DRIVER.replace('print("FX35-JSON" + json.dumps(report))', r"""
from tui_gateway.launch_profile_policy import activate_multi_profile_hosting
from tui_gateway.server import _session_profile_runtime_scope  # tui_gateway.server wires the split modules together
from tools.terminal_scope import get_terminal_scope, terminal_env, TerminalPolicyUnavailable
activate_multi_profile_hosting()
routed = {}
for name in sys.argv[-1].split(","):
    with _session_profile_runtime_scope({"profile_home": os.path.join(os.environ["HERMES_HOME"], "profiles", name)}):
        scope = get_terminal_scope()
        routed[name] = {"scope": scope.get("TERMINAL_ENV") if scope is not None else None,
                        "cwd": scope.get("TERMINAL_CWD") if scope is not None else None,
                        "refusal": getattr(scope, "reason", None), "tool": tool(), "hook": hook()}
with _session_profile_runtime_scope({"profile_home": None}):
    scope = get_terminal_scope()
    routed["launch"] = {"scope": scope.get("TERMINAL_ENV") if scope is not None else None, "tool": tool(), "hook": hook()}
report["routed"] = routed
print("FX35-JSON" + json.dumps(report))
""")


def test_turn_routed_to_a_profile_gets_the_app_backend(tmp_path):
    shutil.copyfile(TEMPLATE, hermes_home(tmp_path) / "config.yaml")
    (profile_home(tmp_path, "inft-none") / "config.yaml").write_text("model: {}\n")
    shutil.copyfile(TEMPLATE, profile_home(tmp_path, "inft-tmpl") / "config.yaml")
    profile_home(tmp_path, "inft-empty")
    (profile_home(tmp_path, "inft-env") / ".env").write_text("TERMINAL_ENV=local\n")
    report = run_driver(tmp_path, driver=ROUTED, extra=("inft-none,inft-tmpl,inft-empty,inft-env",))
    assert_confined(report)
    for name, seen in report["routed"].items():
        assert seen["tool"] == SEATBELT and seen["hook"] == "pass", (name, seen)
        assert seen["scope"] in (SEATBELT, None), (name, seen)
    assert report["routed"]["inft-tmpl"]["scope"] == SEATBELT
    # A profile with no cwd of its own runs in the app's project, not in a sandbox default the sandbox would refuse.
    for name in ("inft-none", "inft-tmpl", "inft-empty"):
        assert report["routed"][name]["cwd"] == APP_PROJECT, report["routed"][name]


@pytest.mark.parametrize("backend", ["docker", "ssh", "modal"])
def test_turn_routed_to_a_profile_asking_for_another_backend_is_refused(tmp_path, backend):
    (hermes_home(tmp_path) / "config.yaml").write_text("terminal: {}\n")
    (profile_home(tmp_path, "inft-other") / "config.yaml").write_text(f"terminal:\n  backend: {backend}\n")
    report = run_driver(tmp_path, driver=ROUTED, extra=("inft-other",))
    seen = report["routed"]["inft-other"]
    assert backend in (seen["refusal"] or "") and "icloneOS confinement" in seen["refusal"]
    assert backend in seen["tool"] and backend in seen["hook"]
    # A healthy sibling turn is not poisoned by it.
    assert report["routed"]["launch"]["tool"] == SEATBELT and report["routed"]["launch"]["hook"] == "pass"


# Reload in the middle of a session: the third case the diagnosis names.
RELOAD = DRIVER.replace('print("FX35-JSON" + json.dumps(report))', r"""
from hermes_cli.env_loader import load_hermes_dotenv
home = os.environ["HERMES_HOME"]
open(os.path.join(home, "config.yaml"), "w").write('terminal:\n  backend: "local"\n')
load_hermes_dotenv()
report["reload_local"] = {"env": os.environ.get("TERMINAL_ENV"), "tool": tool(), "hook": hook()}
open(os.path.join(home, ".env"), "w").write("TERMINAL_ENV=local\n")
open(os.path.join(home, "config.yaml"), "w").write("model: {}\n")
load_hermes_dotenv()
report["reload_dotenv"] = {"env": os.environ.get("TERMINAL_ENV"), "tool": tool(), "hook": hook()}
# A load for another home runs no config bridge at all; its .env still reaches this process's environment.
other = os.path.join(os.environ["HOME"], "other-home")
os.makedirs(other, exist_ok=True)
open(os.path.join(other, ".env"), "w").write("TERMINAL_ENV=local\n")
load_hermes_dotenv(hermes_home=other)
report["reload_other_home"] = os.environ.get("TERMINAL_ENV")
# Anything that writes the variable directly (save_env_value does) cannot move what a tool reads.
os.environ["TERMINAL_ENV"] = "local"
report["flipped"] = {"tool": tool(), "hook": hook()}
print("FX35-JSON" + json.dumps(report))
""")


def test_a_reload_in_the_middle_of_a_session_changes_nothing(tmp_path):
    (hermes_home(tmp_path) / "config.yaml").write_text("terminal: {}\n")
    report = run_driver(tmp_path, driver=RELOAD)
    assert_confined(report)
    assert report["reload_local"] == {"env": SEATBELT, "tool": SEATBELT, "hook": "pass"}
    assert report["reload_dotenv"] == {"env": SEATBELT, "tool": SEATBELT, "hook": "pass"}
    assert report["reload_other_home"] == SEATBELT
    assert report["flipped"] == {"tool": SEATBELT, "hook": "pass"}


# The other two bridges a confined process could run.
OTHER_BRIDGES = DRIVER.replace('print("FX35-JSON" + json.dumps(report))', r"""
os.environ["TERMINAL_ENV"] = "local"
from gateway.run import _bridge_config_to_env
_bridge_config_to_env({"terminal": {"backend": "local"}})
report["gateway"] = os.environ.get("TERMINAL_ENV")
from hermes_cli.cli_config_load import _mirror_config_to_env
os.environ["TERMINAL_ENV"] = "local"
_mirror_config_to_env({"terminal": {"backend": "local"}}, True)
report["cli"] = os.environ.get("TERMINAL_ENV")
child = {"TERMINAL_ENV": "local"}
apply_terminal_config_to_env(env=child)
report["child_env"] = child["TERMINAL_ENV"]
odd = {"TERMINAL_ENV": "local"}
apply_terminal_config_to_env(env=odd, config={"terminal": 5})  # the path that returns early: no terminal mapping
report["child_env_odd_config"] = odd["TERMINAL_ENV"]
print("FX35-JSON" + json.dumps(report))
""")


def test_the_gateway_cli_and_pty_bridges_cannot_write_local_over_the_app_value(tmp_path):
    shutil.copyfile(TEMPLATE, hermes_home(tmp_path) / "config.yaml")
    report = run_driver(tmp_path, driver=OTHER_BRIDGES)
    assert report["gateway"] == SEATBELT and report["cli"] == SEATBELT and report["child_env"] == SEATBELT
    assert report["child_env_odd_config"] == SEATBELT


# A writer no settle covers, in the gap before discovery: the plugin still reads the exec value, not the environment.
LATE_WRITER = DRIVER.replace('''from hermes_cli.plugins import discover_plugins
discover_plugins()
''', '''from hermes_cli.plugins import discover_plugins
os.environ["TERMINAL_ENV"] = "local"
discover_plugins()
''')


def test_the_plugin_takes_the_exec_value_even_when_the_environment_moved_before_it_loaded(tmp_path):
    assert LATE_WRITER != DRIVER
    (hermes_home(tmp_path) / "config.yaml").write_text("terminal: {}\n")
    assert_confined(run_driver(tmp_path, driver=LATE_WRITER))


# What must NOT change.
def test_a_process_the_app_did_not_confine_behaves_as_before(tmp_path):
    shutil.copyfile(TEMPLATE, hermes_home(tmp_path) / "config.yaml")
    report = run_driver(tmp_path, exec_env={})
    assert report["expected"] == [""] or report["expected"] == []
    assert report["start_env"] == "local" and report["first_tool"] == "local"  # the hook is not registered here


def test_seatbelt_named_at_exec_without_the_confinement_flag_is_not_confinement(tmp_path):
    shutil.copyfile(TEMPLATE, hermes_home(tmp_path) / "config.yaml")
    report = run_driver(tmp_path, exec_env={"TERMINAL_ENV": SEATBELT})
    assert report["start_env"] == "local" and report["first_tool"] == "local"


def test_a_docker_config_in_an_unconfined_process_still_selects_docker(tmp_path):
    (hermes_home(tmp_path) / "config.yaml").write_text("terminal:\n  backend: docker\n")
    report = run_driver(tmp_path, exec_env={})
    assert report["start_env"] == "docker" and report["first_tool"] == "docker"


def test_a_dotenv_cannot_claim_confinement_for_an_unconfined_process(tmp_path):
    """The backend value is only the exec one: a .env naming seatbelt and the flag gets no pin."""
    home = hermes_home(tmp_path)
    (home / ".env").write_text("ICLONE_CONFINEMENT=1\nTERMINAL_ENV=iclone_seatbelt\n")
    (home / "config.yaml").write_text('terminal:\n  backend: "local"\n')
    report = run_driver(tmp_path, exec_env={})
    assert report["start_env"] == "local" and report["first_tool"] == "local"


@pytest.mark.parametrize("value", ["local", "", "docker"])
def test_confined_at_exec_with_a_backend_that_is_not_the_apps_stays_closed(tmp_path, value):
    """Main never does this; if something does, the shell tools stay refused instead of being pinned to anything."""
    shutil.copyfile(TEMPLATE, hermes_home(tmp_path) / "config.yaml")
    ack = tmp_path / "ack.json"
    report = run_driver(tmp_path, exec_env={"ICLONE_CONFINEMENT": "1", "TERMINAL_ENV": value,
                                            "ICLONE_CONFINEMENT_SPEC": "{}", "ICLONE_CONFINEMENT_ACK": str(ack)})
    assert SEATBELT not in report["expected"]
    assert report["start_hook"] != "pass" and report["first_hook"] != "pass" and report["later_hook"] != "pass"


def test_the_exec_value_is_kept_outside_the_iclone_snapshot():
    """restore_environ writes the snapshot back and forget() edits it: neither may hold this name, or a lock without
    confinement would start pinning the backend of a process that is not confined."""
    code = ("from hermes_cli import iclone_policy_env as e;"
            "assert e.exec_env('TERMINAL_ENV') is None; assert e.confined_backend() == 'iclone_seatbelt';"
            "e.forget(['TERMINAL_ENV']); assert e.confined_backend() == 'iclone_seatbelt'; print('ok')")
    run = subprocess.run([sys.executable, "-c", code], cwd=str(REPO), capture_output=True, text=True, timeout=60,
                         env={"PATH": "/usr/bin:/bin", "PYTHONPATH": str(REPO), "PYTHONDONTWRITEBYTECODE": "1",
                              "ICLONE_CONFINEMENT": "1", "TERMINAL_ENV": SEATBELT})
    assert run.stdout.strip() == "ok", run.stderr[-1500:]


# --- fx35b: the rulings of the fix pass (pass-rulings R10-R14). Each driver is the real import order in a real process. ---
FX35B_BOOT = r"""
import json, os, sys
plan = json.loads(sys.argv[1])
sys.argv = ["hermes"]
import hermes_cli.main
from hermes_cli.config import apply_terminal_config_to_env, reload_env
apply_terminal_config_to_env()
from hermes_cli.iclone_policy_env import confined_project, other_backend_refusal, refused_backend
from hermes_cli.plugins import discover_plugins
discover_plugins()
import model_tools
report = {}
def call(tool, args):
    raw = model_tools.handle_function_call(tool, args, task_id="t", enabled_tools=["terminal", "read_file", "write_file"])
    return json.loads(raw) if isinstance(raw, str) else raw
def ack_commands():
    stem, ext = os.path.splitext(os.environ["FX35_ACK"])
    return json.load(open(f"{stem}.{os.getpid()}{ext}")).get("commands")
def routed(name):
    from tui_gateway.launch_profile_policy import activate_multi_profile_hosting
    from tui_gateway.server import _session_profile_runtime_scope
    activate_multi_profile_hosting()
    return _session_profile_runtime_scope({"profile_home": os.path.join(os.environ["HERMES_HOME"], "profiles", name)})
"""
FX35B_END = '\nprint("FX35-JSON" + json.dumps(report))\n'
OFFERED = ["terminal", "execute_code", "read_file", "write_file"]  # process_manage: behind tool_search, the live rows


def fx35b(tmp_path: Path, body: str, config: str | None = None, dotenv: str | None = None, plan: dict | None = None,
          exec_env: dict | None = None, early: str = "") -> dict:
    home = hermes_home(tmp_path)
    if config is not None:
        (home / "config.yaml").write_text(config)
    if dotenv is not None:
        (home / ".env").write_text(dotenv)
    ack = tmp_path / "ack.json"
    env = {**CONFINED_EXEC, "ICLONE_CONFINEMENT_ACK": str(ack), **(exec_env or {})}
    env = {k: v for k, v in env.items() if v is not None}
    boot = FX35B_BOOT.replace("discover_plugins()\n", early + "discover_plugins()\n", 1)
    return run_driver(tmp_path, exec_env=env, driver=boot + body + FX35B_END, extra=(json.dumps(plan or {}),))


def test_r10_a_refused_backend_keeps_every_tool_offered_and_the_call_and_the_ack_say_why(tmp_path):
    seen = fx35b(tmp_path, """
report["offered"] = [t["function"]["name"] for t in model_tools.get_tool_definitions(enabled_toolsets=["hermes-cli"], quiet_mode=True)]
report["reason"] = refused_backend()
report["terminal"] = call("terminal", {"command": "echo x"})
report["read"] = call("read_file", {"path": "x.txt"})
report["ack"] = ack_commands()
""", config="terminal:\n  backend: docker\n")
    assert "'docker'" in seen["reason"]
    assert set(OFFERED) <= set(seen["offered"])
    assert seen["terminal"]["error"] == seen["reason"] and seen["read"]["error"] == seen["reason"]
    assert seen["ack"] == {"available": False, "reason": seen["reason"][:len(seen["ack"]["reason"])]}


def test_r10_an_unconfined_process_with_a_broken_policy_still_hides_the_tools():
    from tools import terminal_scope, terminal_tool

    assert terminal_tool._confined_refusal(terminal_scope.TerminalPolicyUnavailable("x")) is False


def test_r11_the_apps_project_is_the_exec_copy_not_what_a_dotenv_or_reload_wrote(tmp_path):
    project, evil = tmp_path / "proj", tmp_path / "evil"
    project.mkdir(), evil.mkdir()
    profile_home(tmp_path, "inft-a")
    seen = fx35b(tmp_path, """
from tools.terminal_scope import get_terminal_scope
report["project"] = confined_project()
with routed("inft-a"):
    report["boot"] = get_terminal_scope()["TERMINAL_CWD"]
open(os.path.join(os.environ["HERMES_HOME"], ".env"), "a").write("TERMINAL_CWD=" + plan["evil"] + "\\n")
reload_env()
report["live"] = os.environ.get("TERMINAL_CWD")
with routed("inft-a"):
    report["reloaded"] = get_terminal_scope()["TERMINAL_CWD"]
""", dotenv=f"TERMINAL_CWD={evil}\n", plan={"evil": str(evil)}, exec_env={"TERMINAL_CWD": str(project)})
    assert seen["project"] == str(project) and seen["live"] == str(evil)
    assert seen["boot"] == str(project) and seen["reloaded"] == str(project)


def test_r12_marked_confined_without_the_backend_refuses_every_tool_and_spawns_no_ssh(tmp_path):
    stub = tmp_path / "bin"
    stub.mkdir()
    log = tmp_path / "ssh.log"
    (stub / "ssh").write_text(f"#!/bin/sh\necho \"$@\" >> {log}\n")
    (stub / "ssh").chmod(0o755)
    seen = fx35b(tmp_path, """
os.environ["PATH"] = plan["stub"] + ":" + os.environ["PATH"]
report["reason"] = refused_backend()
report["read"] = call("read_file", {"path": "x.txt"})
report["write"] = call("write_file", {"path": "x.txt", "content": "y"})
report["terminal"] = call("terminal", {"command": "echo x"})
""", config="terminal:\n  backend: ssh\n  ssh_host: example.invalid\n  ssh_user: u\n", plan={"stub": str(stub)},
                 exec_env={"TERMINAL_ENV": None})
    assert "started confined without" in seen["reason"]
    for tool in ("read", "write"):
        assert seen[tool]["error"] == seen["reason"], tool
    assert "error" in seen["terminal"] and not seen["terminal"].get("output")
    assert not log.exists()


def test_r12_a_served_child_stays_pinned_and_reload_env_settles(tmp_path):
    project = tmp_path / "proj"
    project.mkdir()
    profile_home(tmp_path, "inft-a")
    seen = fx35b(tmp_path, """
from tools.environments.local import served_profile_child_env
with routed("inft-a"):
    child = served_profile_child_env(target_home=os.path.join(os.environ["HERMES_HOME"], "profiles", "inft-a"))
report["child"] = {k: child.get(k) for k in ("TERMINAL_ENV", "TERMINAL_CWD", "ICLONE_CONFINEMENT_SPEC", "ICLONE_CONFINEMENT_LINK_KEY", "ICLONE_CONFINEMENT_ACK")}
report["before"] = [refused_backend(), ack_commands()]
open(os.path.join(os.environ["HERMES_HOME"], ".env"), "w").write("TERMINAL_ENV=docker\\n")
reload_env()
report["after"] = [refused_backend(), os.environ.get("TERMINAL_ENV"), ack_commands()]
open(os.path.join(os.environ["HERMES_HOME"], ".env"), "w").write("TERMINAL_ENV=local\\n")
reload_env()
report["cleared"] = refused_backend()
""", config="terminal:\n  backend: local\n",
                 exec_env={"TERMINAL_CWD": str(project), "ICLONE_CONFINEMENT_SPEC": "{}", "ICLONE_CONFINEMENT_LINK_KEY": "ab" * 32})
    assert seen["child"] == {"TERMINAL_ENV": SEATBELT, "TERMINAL_CWD": str(project), "ICLONE_CONFINEMENT_SPEC": "{}",
                             "ICLONE_CONFINEMENT_LINK_KEY": None, "ICLONE_CONFINEMENT_ACK": None}
    assert seen["before"][0] is None
    assert "'docker'" in seen["after"][0] and seen["after"][1] == SEATBELT
    assert seen["after"][2]["available"] is False and "'docker'" in seen["after"][2]["reason"]
    assert seen["cleared"] is None


def test_r13_every_plugin_copy_reads_the_exec_copy_and_the_names_stay_out_of_the_environment(tmp_path):
    profile_home(tmp_path, "inft-a")
    profile_home(tmp_path, "inft-b")
    seen = fx35b(tmp_path, """
from hermes_cli.env_loader import load_hermes_dotenv
from tools.environments.local import _make_run_env
NAMES = ("ICLONE_CONFINEMENT_SPEC", "ICLONE_CONFINEMENT_LINK_KEY", "ICLONE_CONFINEMENT_ACK")
load_hermes_dotenv()
report["environ"] = [n for n in NAMES if n in os.environ]
report["command"] = [n for n in NAMES if n in _make_run_env({})]
for name in ("inft-a", "inft-b"):
    with routed(name):
        discover_plugins()
report["copies"] = {}
for name, mod in list(sys.modules.items()):
    if name.startswith("hermes_plugins.iclone_confinement") and name.endswith(".core"):
        plugin = sys.modules[name[:-len(".core")]]
        report["copies"][name] = [plugin.ACK_FILE, mod._trusted_spec]
report["environ_after"] = [n for n in NAMES if n in os.environ]
""", dotenv="ICLONE_CONFINEMENT_ACK=/planted\n", exec_env={"ICLONE_CONFINEMENT_SPEC": "{}", "ICLONE_CONFINEMENT_LINK_KEY": "ab" * 32, "ICLONE_POLICY_LOCK": "1"})
    assert seen["environ"] == [] and seen["command"] == [] and seen["environ_after"] == []
    assert len(seen["copies"]) == 3, seen["copies"]
    for name, (ack, spec) in seen["copies"].items():
        assert ack == str(tmp_path / "ack.json"), name
        assert spec == "{}", name


def test_r13_the_launcher_drops_the_hand_over_from_a_commands_env():
    from importlib import util

    spec = util.spec_from_file_location("iclone_launcher_r13", REPO / "plugins" / "iclone-confinement" / "launcher.py")
    text = spec.loader.get_source("iclone_launcher_r13")
    dropped = text.split("SHELL_ENV_DROPPED = frozenset(", 1)[1].split(")", 1)[0]
    for name in ("ICLONE_CONFINEMENT_SPEC", "ICLONE_CONFINEMENT_LINK_KEY", "ICLONE_CONFINEMENT_ACK"):
        assert name in dropped


@pytest.mark.parametrize("config,refused", [("terminal:\n  backend:\n", None), ("terminal:\n  backend: dockr\n", "'dockr'")])
def test_r14_a_blank_backend_is_nobody_asked_and_a_typo_is_named(tmp_path, config, refused):
    seen = fx35b(tmp_path, 'report["reason"] = refused_backend()\n', config=config)
    if refused is None:
        assert seen["reason"] is None
    else:
        assert refused in seen["reason"]


def test_r14_placement_resolve_answers_under_a_refused_backend(tmp_path):
    seen = fx35b(tmp_path, """
from tools.bot_desktop import placement
report["backend"] = placement.resolve().backend
""", config="terminal:\n  backend: docker\n")
    assert seen["backend"] == SEATBELT


@pytest.mark.parametrize("config", ["terminal:\n  backend: [docker\n", "terminal:\n\tbackend: docker\n"])
def test_r14_a_config_that_cannot_be_parsed_is_reported_in_the_ack(tmp_path, config):
    # R20 changed the field: a note, not a refusal. The driver has no launcher, so the sandbox's own answer here is not
    # ready: the broken file changes nothing in available or reason, only the note (compare the clean config).
    seen = fx35b(tmp_path, 'report["ack"] = ack_commands()\n', config=config)
    assert "config.yaml could not be read" in seen["ack"]["note"]
    clean = fx35b(tmp_path, 'report["ack"] = ack_commands()\n', config="terminal:\n  backend: local\n")
    assert "note" not in clean["ack"]
    assert {k: seen["ack"][k] for k in ("available", "reason")} == clean["ack"]


def test_r14_a_config_that_parses_is_not_reported_as_unreadable(tmp_path):
    seen = fx35b(tmp_path, 'report["ack"] = ack_commands()\n', config="terminal:\n  backend: local\n")
    assert "note" not in (seen["ack"] or {})


def test_r9_the_process_gate_builds_once_for_the_bundled_plugin_and_every_copy_shares_it(tmp_path):
    seen = fx35b(tmp_path, """
report.update(EARLY)
""", exec_env={"ICLONE_POLICY_LOCK": "1"}, early="""
from hermes_cli import iclone_policy_env as e
init = os.path.join(e._bundled_gate_dir(), "__init__.py")
scope = {"__file__": init, "e": e}
exec("first = e.process_gate()\\nsecond = e.process_gate()", scope)
EARLY = {"same": scope["first"][0] is scope["second"][0], "built": [scope["first"][1], scope["second"][1]],
         "keys": sorted(k for k in scope["first"][0] if k in ("channel", "policy"))}
""")
    assert seen["same"] is True and seen["built"] == [True, False] and seen["keys"] == ["channel", "policy"]


R18_LOCK = {"ICLONE_POLICY_LOCK": "1", "ICLONE_PERM_SOCKET": "/nonexistent/s", "ICLONE_PERM_TOKEN_FILE": "/nonexistent/t"}


def test_r18_no_caller_supplies_the_gate_and_a_wrong_first_caller_gets_nothing(tmp_path):
    seen = fx35b(tmp_path, """
plugin = sys.modules["hermes_plugins.iclone_permissions"]
report.update(EARLY)
report["holds"] = [type(plugin._state["channel"]).__name__, plugin._state["channel"]._key_id, plugin._state["channel"].usable]
""", exec_env=R18_LOCK, early="""
import inspect
from hermes_cli import iclone_policy_env as e
e._ensure()
e._key = ("kid-r18", b"k" * 32)
EARLY = {"params": list(inspect.signature(e.process_gate).parameters), "wrong": e.process_gate(),
         "built_by_wrong": e._gate is not None, "key_kept": e._key is not None}
""")
    assert seen["params"] == []
    assert seen["wrong"] is None and seen["built_by_wrong"] is False and seen["key_kept"] is True
    assert seen["holds"] == ["Channel", "kid-r18", True]


def test_r18_a_module_that_took_the_key_first_leaves_the_gate_keyless_fail_closed(tmp_path):
    seen = fx35b(tmp_path, """
plugin = sys.modules["hermes_plugins.iclone_permissions"]
report["early"] = EARLY
report["usable"] = plugin._state["channel"].usable
report["refused"] = plugin.on_pre_tool_call(tool_name="terminal", args={"command": "echo x"}, task_id="t", session_id="s", tool_call_id="c")
""", exec_env=R18_LOCK, early="""
from hermes_cli import iclone_policy_env as e
e._ensure()
e._key = ("kid-r18", b"k" * 32)
EARLY = e.take_policy_key()[0]
""")
    assert seen["early"] == "kid-r18" and seen["usable"] is False
    assert seen["refused"]["action"] == "block"


def test_r20_an_unreadable_config_is_a_note_commands_stay_available(tmp_path):
    seen = fx35b(tmp_path, """
report["reason"] = refused_backend()
next(m for n, m in sys.modules.items() if n.startswith("hermes_plugins.iclone_confinement") and n.endswith(".core")).report_commands(True)
report["ack"] = ack_commands()
""", config="terminal: [broken\n")
    assert seen["reason"] is None
    assert seen["ack"]["available"] is True and seen["ack"]["reason"] == ""
    assert "could not be read" in seen["ack"]["note"] and "Commands still run in the sandbox" in seen["ack"]["note"]


def test_the_ack_is_one_per_process_a_routed_copy_neither_clears_nor_sets_the_launch_note(tmp_path):
    profile_home(tmp_path, "inft-a")
    (profile_home(tmp_path, "inft-b") / "config.yaml").write_text("terminal: [broken\n")
    kept = fx35b(tmp_path, '''
with routed("inft-a"):
    discover_plugins()
copies = [m for n, m in sys.modules.items() if n.startswith("hermes_plugins.iclone_confinement") and n.endswith(".core")]
report["copies"] = len(copies)
for copy in copies:
    copy.report_commands(True)
report["ack"] = ack_commands()
''', config="terminal: [broken\n")
    assert kept["copies"] == 2 and kept["ack"]["available"] is True and "could not be read" in kept["ack"]["note"]
    clean = fx35b(tmp_path, '''
with routed("inft-b"):
    discover_plugins()
copies = [m for n, m in sys.modules.items() if n.startswith("hermes_plugins.iclone_confinement") and n.endswith(".core")]
report["copies"] = len(copies)
for copy in copies:
    copy.report_commands(True)
report["ack"] = ack_commands()
''', config="terminal:\n  backend: local\n")
    assert clean["copies"] == 2 and clean["ack"] == {"available": True, "reason": ""}


def test_r18_a_copy_that_is_not_the_bundled_plugin_holds_no_gate_and_refuses(tmp_path):
    seen = fx35b(tmp_path, """
import importlib.util, shutil
from hermes_cli import iclone_policy_env as e
copy = os.path.join(os.environ["HERMES_HOME"], "gate-copy")
shutil.copytree(e._bundled_gate_dir(), copy, ignore=shutil.ignore_patterns("tests", "__pycache__"))
spec = importlib.util.spec_from_file_location("hermes_plugins.gate_copy", os.path.join(copy, "__init__.py"), submodule_search_locations=[copy])
fake = importlib.util.module_from_spec(spec); sys.modules[spec.name] = fake; spec.loader.exec_module(fake)
hooks = []
class Ctx:
    def register_hook(self, name, fn): hooks.append(name)
fake.register(Ctx())
report["hooks"] = hooks
report["state"] = sorted(fake._state)
report["refused"] = fake.on_pre_tool_call(tool_name="terminal", args={"command": "echo x"}, task_id="t", session_id="s", tool_call_id="c")
""", exec_env=R18_LOCK)
    assert seen["hooks"] == ["pre_tool_call"] and seen["state"] == []
    assert seen["refused"]["action"] == "block"


def _overlay(tmp_path, name="overlay"):
    """An unmanaged dev runtime's plugin folder: a real copy of the gate, as prepareDevPluginOverlay makes it."""
    folder = tmp_path / name / "plugins"
    source = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "plugins", "iclone-permissions")
    shutil.copytree(source, folder / "iclone-permissions", ignore=shutil.ignore_patterns("tests", "__pycache__"))
    return folder


def test_fx39_the_overlay_main_names_at_exec_holds_the_gate(tmp_path):
    folder = _overlay(tmp_path)
    seen = fx35b(tmp_path, """
plugin = sys.modules["hermes_plugins.iclone_permissions"]
report["file"] = os.path.realpath(plugin.__file__)
report["holds"] = sorted(k for k in plugin._state if k in ("channel", "policy"))
""", exec_env={**R18_LOCK, "HERMES_BUNDLED_PLUGINS": str(folder)})
    assert seen["file"] == os.path.join(os.path.realpath(folder), "iclone-permissions", "__init__.py")
    assert seen["holds"] == ["channel", "policy"]


def test_fx39_a_folder_main_did_not_name_at_exec_holds_nothing(tmp_path):
    named, moved = _overlay(tmp_path, "named"), _overlay(tmp_path, "moved")
    seen = fx35b(tmp_path, """
import importlib.util
from hermes_cli import iclone_policy_env as e
copy = os.path.join(os.environ["FX39_MOVED"], "iclone-permissions")
os.environ["HERMES_BUNDLED_PLUGINS"] = os.environ["FX39_MOVED"]  # as a .env would: the live value, not main's
spec = importlib.util.spec_from_file_location("hermes_plugins.gate_moved", os.path.join(copy, "__init__.py"), submodule_search_locations=[copy])
fake = importlib.util.module_from_spec(spec); sys.modules[spec.name] = fake; spec.loader.exec_module(fake)
class Ctx:
    def register_hook(self, name, fn): pass
fake.register(Ctx())
report["state"] = sorted(fake._state)
report["dir"] = e._bundled_gate_dir()
report["refused"] = fake.on_pre_tool_call(tool_name="terminal", args={"command": "echo x"}, task_id="t", session_id="s", tool_call_id="c")
""", exec_env={**R18_LOCK, "HERMES_BUNDLED_PLUGINS": str(named), "FX39_MOVED": str(moved)})
    assert seen["state"] == [] and seen["refused"]["action"] == "block"
    assert seen["dir"] == os.path.join(os.path.realpath(named), "iclone-permissions")


def test_routed_calls_name_their_own_profile_and_every_copy_counts_in_one_stats(tmp_path):
    profile_home(tmp_path, "inft-a")
    seen = fx35b(tmp_path, """
launch = sys.modules["hermes_plugins.iclone_permissions"]
report["launch_profile"] = launch._active_profile()
with routed("inft-a"):
    discover_plugins()
    report["routed_profile"] = launch._active_profile()
    report["payload"] = launch._payload("t", "x", "c", {}, None, None, None, "t", "s", [], {})["agent"]["profile"]
copies = [m for n, m in sys.modules.items() if n.startswith("hermes_plugins.iclone_permissions") and n.count(".") == 1]
report["copies"] = len(copies)
report["one_stats"] = len({id(m._stats) for m in copies})
""", exec_env=R18_LOCK)
    assert seen["routed_profile"] == "inft-a" and seen["launch_profile"] is None and seen["payload"] == "inft-a"
    assert seen["copies"] == 2 and seen["one_stats"] == 1


R17_HOSTILE = """ICLONE_CONFINEMENT=0
ICLONE_POLICY_LOCK=0
TERMINAL_ENV=ssh
TERMINAL_CWD=/
ICLONE_CONFINEMENT_SPEC=forged
ICLONE_CONFINEMENT_LINK_KEY=forged
ICLONE_CONFINEMENT_ACK=/forged
R17_PROVIDER_KEY=kept
"""

R17_BODY = """
from tools.environments.local import served_profile_child_env
target = os.path.join(os.environ["HERMES_HOME"], "profiles", "inft-a")
with routed("inft-a"):
    report["child"] = served_profile_child_env(target_home=target, inherit_credentials=True)
report["path"] = [p for p in sys.path if p]
"""

R17_PROBE = """
import json
from hermes_cli import iclone_policy_env as e
print(json.dumps({"locked": e.locked(), "marked": e.confined_at_exec(), "pin": e.confined_backend(),
                  "project": e.confined_project(), "spec": e.exec_env("ICLONE_CONFINEMENT_SPEC")}))
"""

R17_NAMES = ("TERMINAL_ENV", "TERMINAL_CWD", "ICLONE_CONFINEMENT", "ICLONE_POLICY_LOCK", "ICLONE_CONFINEMENT_SPEC",
             "ICLONE_CONFINEMENT_LINK_KEY", "ICLONE_CONFINEMENT_ACK", "R17_PROVIDER_KEY")


def r17_child(seen: dict) -> tuple[dict, dict]:
    """The env the slash worker's factory built, exec'ed for real (from here: the driver's own spawn guard refuses it)."""
    child = dict(seen["child"], PYTHONPATH=os.pathsep.join(seen["path"]))
    ran = subprocess.run([sys.executable, "-c", R17_PROBE], env=child, capture_output=True, text=True, timeout=60)
    assert ran.returncode == 0, ran.stderr[-600:]
    return json.loads(ran.stdout), {k: seen["child"].get(k) for k in R17_NAMES}


def test_r17_the_slash_worker_path_with_a_hostile_routed_env_stays_pinned_and_locked_in_a_real_child(tmp_path):
    project = tmp_path / "proj"
    project.mkdir()
    (profile_home(tmp_path, "inft-a") / ".env").write_text(R17_HOSTILE)
    seen = fx35b(tmp_path, R17_BODY, config="terminal:\n  backend: local\n",
                 exec_env={"TERMINAL_CWD": str(project), "ICLONE_POLICY_LOCK": "1", "ICLONE_CONFINEMENT_SPEC": "{}",
                           "ICLONE_CONFINEMENT_LINK_KEY": "ab" * 32})
    ran, names = r17_child(seen)
    assert ran == {"locked": True, "marked": True, "pin": SEATBELT, "project": str(project), "spec": "{}"}
    assert names == {"TERMINAL_ENV": SEATBELT, "TERMINAL_CWD": str(project), "ICLONE_CONFINEMENT": "1", "ICLONE_POLICY_LOCK": "1",
                     "ICLONE_CONFINEMENT_SPEC": "{}", "ICLONE_CONFINEMENT_LINK_KEY": None, "ICLONE_CONFINEMENT_ACK": None,
                     "R17_PROVIDER_KEY": "kept"}


def test_r17_locked_and_not_confined_the_overlay_still_cannot_set_iclone_names(tmp_path):
    (profile_home(tmp_path, "inft-a") / ".env").write_text("ICLONE_POLICY_LOCK=0\nICLONE_CONFINEMENT=1\nTERMINAL_ENV=ssh\n")
    seen = fx35b(tmp_path, R17_BODY, exec_env={"ICLONE_POLICY_LOCK": "1", "ICLONE_CONFINEMENT": None, "TERMINAL_ENV": None})
    ran, names = r17_child(seen)
    assert ran["locked"] is True and ran["marked"] is False
    assert names["ICLONE_CONFINEMENT"] is None
    # Not confined: a routed profile's own backend stays what it was before FX35.
    assert names["TERMINAL_ENV"] == "ssh"


def test_r12_marked_confined_without_the_backend_refuses_inside_a_routed_scope_too(tmp_path):
    (profile_home(tmp_path, "inft-a") / "config.yaml").write_text("terminal:\n  backend: ssh\n  ssh_host: example.invalid\n  ssh_user: u\n")
    seen = fx35b(tmp_path, """
report["reason"] = refused_backend()
with routed("inft-a"):
    report["read"] = call("read_file", {"path": "x.txt"})
""", exec_env={"TERMINAL_ENV": None})
    assert "started confined without" in seen["reason"] and seen["read"]["error"] == seen["reason"]


def test_r9_a_routed_copy_says_no_second_hello_and_registers_no_second_exit(tmp_path):
    profile_home(tmp_path, "inft-a")
    seen = fx35b(tmp_path, """
import atexit
real, exits = atexit.register, []
atexit.register = lambda fn, *a, **k: (exits.append(getattr(fn, "__name__", "")), real(fn, *a, **k))[1]
with routed("inft-a"):
    discover_plugins()
report["copies"] = len([n for n in sys.modules if n.startswith("hermes_plugins.iclone_permissions") and n.count(".") == 1])
report["exits"] = exits.count("_at_exit")
""", exec_env={"ICLONE_POLICY_LOCK": "1"})
    assert seen["copies"] == 2 and seen["exits"] == 0


# F41: isolation off is a state main chooses and marks at exec, not a refusal. Real process, real order, as above.
OFF_EXEC = {"ICLONE_CONFINEMENT": "off"}


def assert_off_runs(report: dict, backend: str = "local") -> None:
    assert report["expected"] == [""], report
    assert report["ack"] is None, report
    for key in ("first_tool", "later_tool"):
        assert report[key] == backend, f"{key}: {report}"
    for key in ("start_hook", "first_hook", "later_hook"):
        assert report[key] == "pass", f"{key}: {report}"


def test_off_the_real_template_runs_on_this_mac(tmp_path):
    shutil.copy(TEMPLATE, hermes_home(tmp_path) / "config.yaml")
    assert_off_runs(run_driver(tmp_path, exec_env=OFF_EXEC))


def test_off_a_backend_the_user_picked_is_what_runs_never_refused(tmp_path):
    (hermes_home(tmp_path) / "config.yaml").write_text("terminal:\n  backend: docker\n")
    assert_off_runs(run_driver(tmp_path, exec_env=OFF_EXEC), "docker")


def test_off_a_dotenv_cannot_arm_the_plugin_against_main(tmp_path):
    home = hermes_home(tmp_path)
    (home / ".env").write_text(f"ICLONE_CONFINEMENT=1\nTERMINAL_ENV={SEATBELT}\n")
    assert_off_runs(run_driver(tmp_path, exec_env=OFF_EXEC))


def test_off_a_file_naming_the_sandbox_runs_here_under_its_true_name(tmp_path):
    (hermes_home(tmp_path) / "config.yaml").write_text(f"terminal:\n  backend: {SEATBELT}\n")
    assert_off_runs(run_driver(tmp_path, exec_env=OFF_EXEC))


def test_on_a_dotenv_saying_off_changes_nothing(tmp_path):
    (hermes_home(tmp_path) / ".env").write_text("ICLONE_CONFINEMENT=off\n")
    assert_confined(run_driver(tmp_path))


def test_on_docker_is_still_refused_and_names_the_control(tmp_path):
    (hermes_home(tmp_path) / "config.yaml").write_text("terminal:\n  backend: docker\n")
    report = run_driver(tmp_path)
    assert "Containers > Backends" in report["first_tool"], report


# F41: a run with isolation off leaves installs/<key>/ behind (boot bookkeeping); the runtime profile never writes there.
LOCK_DRIVER = r"""
import json, sys
from pathlib import Path
from pm.environments import install_state_dir
from hermes_cli.runtime_state import runtime_lock
project = Path(sys.argv[1])
state = install_state_dir(project)
state.mkdir(parents=True)
state.chmod(0o555)
out = {}
for name, wait in (("reader", 0.1), ("writer", None)):
    try:
        with runtime_lock(project, timeout=wait) as held:
            out[name] = held
    except PermissionError:
        out[name] = "PermissionError"
state.chmod(0o755)
print("FX35-JSON" + json.dumps(out))
"""


def test_back_on_a_reader_starts_past_install_state_left_while_off(tmp_path):
    report = run_driver(tmp_path, exec_env=CONFINED_EXEC, driver=LOCK_DRIVER, extra=(str(tmp_path),))
    assert report == {"reader": False, "writer": "PermissionError"}


def test_outside_confinement_the_access_error_is_still_reported(tmp_path):
    report = run_driver(tmp_path, exec_env={}, driver=LOCK_DRIVER, extra=(str(tmp_path),))
    assert report == {"reader": "PermissionError", "writer": "PermissionError"}
