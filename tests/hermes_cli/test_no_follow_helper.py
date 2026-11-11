"""A Hermes process the app starts unconfined never follows what the confined runtime plants in HERMES_HOME.

Runs the real `config set` the app runs at boot, in a child process: arming happens at package import.
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
PLANT_SITES = ["config.yaml", "SOUL.md", "logs/agent.log", "logs/errors.log", ".env"]
CANARY_BYTES = b"updates:\n  check: true\nowner: untouched\n"
CHILD_LIMIT_S = 60


def run_config_set(home: Path, sandbox: Path, armed: bool = True) -> subprocess.CompletedProcess:
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(sandbox),
        "HERMES_HOME": str(home),
        "PYTHONPATH": str(REPO),
        "PYTHONDONTWRITEBYTECODE": "1",
        "TMPDIR": str(sandbox),
    }
    if armed:
        env["HERMES_HOME_NO_LINKS"] = "1"
    return subprocess.run(
        [sys.executable, "-s", "-P", "-m", "hermes_cli.main", "config", "set", "updates.check", "false"],
        env=env, capture_output=True, text=True, timeout=CHILD_LIMIT_S, stdin=subprocess.DEVNULL,
    )


@pytest.fixture
def world(tmp_path):
    sandbox = tmp_path.resolve()
    home = sandbox / "home"
    (home / "logs").mkdir(parents=True)
    outside = sandbox / "outside"
    outside.mkdir()
    return home, sandbox, outside


@pytest.mark.parametrize("site", PLANT_SITES)
def test_a_link_to_a_file_of_the_user_leaves_it_untouched(world, site):
    home, sandbox, outside = world
    canary = outside / "canary.yaml"
    canary.write_bytes(CANARY_BYTES)
    canary.chmod(0o644)
    (home / site).symlink_to(canary)

    run_config_set(home, sandbox)

    assert canary.read_bytes() == CANARY_BYTES
    assert canary.stat().st_mode & 0o777 == 0o644


@pytest.mark.parametrize("site", PLANT_SITES)
def test_a_dangling_link_creates_nothing_outside(world, site):
    home, sandbox, outside = world
    target = outside / "planted-by-the-runtime"
    (home / site).symlink_to(target)

    run_config_set(home, sandbox)

    assert not target.exists()


@pytest.mark.parametrize("site", PLANT_SITES)
def test_a_fifo_never_hangs_it(world, site):
    home, sandbox, _ = world
    os.mkfifo(home / site)

    run_config_set(home, sandbox)  # a hang is subprocess.TimeoutExpired, which fails the test


def test_a_linked_logs_folder_gets_no_file(world):
    home, sandbox, outside = world
    (home / "logs").rmdir()
    (home / "logs").symlink_to(outside)

    run_config_set(home, sandbox)

    assert list(outside.iterdir()) == []


def test_a_hard_link_to_a_file_of_the_user_is_not_written(world):
    home, sandbox, outside = world
    canary = outside / "canary.yaml"
    canary.write_bytes(CANARY_BYTES)
    os.link(canary, home / "logs" / "agent.log")

    run_config_set(home, sandbox)

    assert canary.read_bytes() == CANARY_BYTES


def test_a_clean_home_still_gets_the_setting(world):
    home, sandbox, _ = world

    result = run_config_set(home, sandbox)

    assert result.returncode == 0, result.stderr
    assert "check: false" in (home / "config.yaml").read_text()


def test_a_refusal_names_what_it_found_and_the_way_out(world):
    home, sandbox, outside = world
    canary = outside / "dotfiles-config.yaml"
    canary.write_bytes(CANARY_BYTES)
    (home / "config.yaml").symlink_to(canary)

    result = run_config_set(home, sandbox)

    assert result.returncode != 0
    assert "config.yaml: a symbolic link" in result.stderr
    assert "run this command from a terminal" in result.stderr


def test_unarmed_keeps_the_owners_linked_config_working(world):
    home, sandbox, outside = world
    canary = outside / "dotfiles-config.yaml"
    canary.write_bytes(CANARY_BYTES)
    (home / "config.yaml").symlink_to(canary)

    result = run_config_set(home, sandbox, armed=False)

    assert result.returncode == 0, result.stderr
    assert (home / "config.yaml").is_symlink()
    assert "check: false" in canary.read_text()


SWAP_AFTER_THE_CHECK = """
import os, sys
from pathlib import Path
import hermes_cli
from hermes_cli import no_follow

def nothing_there_yet(path, **_):
    raise FileNotFoundError(path)

# The audit hook looks with lstat. Blinding it is the moment after a clean check, when the runtime swaps the link in:
# only the flags on the open itself are left to refuse it.
no_follow.os.lstat = nothing_there_yet
target = sys.argv[1]
attempts = {
    "builtin open": lambda: open(target, "a").close(),
    "pathlib": lambda: Path(target).write_text("x"),
    "os.open": lambda: os.close(os.open(target, os.O_WRONLY | os.O_CREAT)),
}
for name, attempt in attempts.items():
    try:
        attempt()
    except no_follow.RefusedPathError:
        continue
    sys.exit(f"{name} was not refused")
"""


@pytest.mark.parametrize("kind", ["link", "dangling", "fifo"])
def test_a_swap_after_the_check_is_still_refused_by_the_open_itself(world, kind):
    home, sandbox, outside = world
    canary = outside / "canary.yaml"
    canary.write_bytes(CANARY_BYTES)
    planted = home / "planted"
    if kind == "fifo":
        os.mkfifo(planted)
    else:
        planted.symlink_to(canary if kind == "link" else outside / "created-by-a-follow")
    env = {
        "PATH": os.environ["PATH"], "HOME": str(sandbox), "HERMES_HOME": str(home), "PYTHONPATH": str(REPO),
        "PYTHONDONTWRITEBYTECODE": "1", "HERMES_HOME_NO_LINKS": "1",
    }

    result = subprocess.run(
        [sys.executable, "-s", "-P", "-c", SWAP_AFTER_THE_CHECK, str(planted)],
        env=env, capture_output=True, text=True, timeout=CHILD_LIMIT_S, stdin=subprocess.DEVNULL,
    )

    assert result.returncode == 0, result.stderr
    assert canary.read_bytes() == CANARY_BYTES
    assert sorted(p.name for p in outside.iterdir()) == ["canary.yaml"]


def import_package_alone(root: Path, armed: bool, home: Path) -> subprocess.CompletedProcess:
    env = {"PATH": os.environ["PATH"], "HOME": str(home), "HERMES_HOME": str(home), "PYTHONDONTWRITEBYTECODE": "1"}
    if armed:
        env["HERMES_HOME_NO_LINKS"] = "1"
    code = (f"import sys; sys.path.insert(0, {str(root)!r}); import hermes_cli; "
            "print('hermes_cli.no_follow' in sys.modules)")
    return subprocess.run([sys.executable, "-I", "-c", code], env=env, capture_output=True, text=True,
                          timeout=CHILD_LIMIT_S, stdin=subprocess.DEVNULL)


@pytest.fixture
def tree_without_the_guard(tmp_path):
    root = tmp_path / "torn"
    (root / "hermes_cli").mkdir(parents=True)
    (root / "hermes_cli" / "__init__.py").write_bytes((REPO / "hermes_cli" / "__init__.py").read_bytes())
    return root


def test_unarmed_the_package_imports_on_a_tree_torn_before_the_guards_file(tree_without_the_guard, tmp_path):
    result = import_package_alone(tree_without_the_guard, armed=False, home=tmp_path)

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "False"


def test_armed_a_tree_without_the_guards_file_stops_the_start(tree_without_the_guard, tmp_path):
    result = import_package_alone(tree_without_the_guard, armed=True, home=tmp_path)

    assert result.returncode != 0
    assert "hermes_cli.no_follow" in result.stderr


def test_a_link_above_the_home_is_not_a_planted_link(world):
    """/tmp -> /private/tmp on macOS, a linked ~/Developer: the pin takes the real path, only names inside are judged."""
    home, sandbox, outside = world
    (sandbox / "above").symlink_to(sandbox)
    reached_through_link = sandbox / "above" / "home"

    result = run_config_set(reached_through_link, sandbox)

    assert result.returncode == 0, result.stderr
    assert "check: false" in (home / "config.yaml").read_text()

    canary = outside / "canary"
    canary.write_bytes(CANARY_BYTES)
    (home / "config.yaml").unlink()
    (home / "config.yaml").symlink_to(canary)

    planted = run_config_set(reached_through_link, sandbox)

    assert planted.returncode != 0
    assert canary.read_bytes() == CANARY_BYTES
