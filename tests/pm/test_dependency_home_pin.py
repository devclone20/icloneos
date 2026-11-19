"""v0.0.9 point A — HERMES_DEPENDENCY_HOME pins the dependency root apart from HERMES_HOME (added by the integration
pass, 17 Nov). Pure path rules, the home's data root left alone, and the lease half: a pinned generation the
confinement profile keeps read-only is used without a lease only when confined (gate G-A covers the packaged app)."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from pm import environments as env


@pytest.fixture(autouse=True)
def _fresh_pin_snapshot():
    # The pin is frozen once per process (at activation); each test here is its own "process".
    env._reset_dependency_home_pin_snapshot()
    yield
    env._reset_dependency_home_pin_snapshot()


def _set_pin(monkeypatch, value):
    """A process launched with this HERMES_DEPENDENCY_HOME: set it, then forget any frozen read."""
    monkeypatch.setenv("HERMES_DEPENDENCY_HOME", value)
    env._reset_dependency_home_pin_snapshot()


def _drop_pin(monkeypatch):
    monkeypatch.delenv("HERMES_DEPENDENCY_HOME", raising=False)
    env._reset_dependency_home_pin_snapshot()


def test_pin_wins_over_hermes_home(monkeypatch, tmp_path):
    pinned = tmp_path / "app-deps"
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "user-home"))
    _set_pin(monkeypatch, str(pinned))
    assert env.dependency_home_root() == pinned
    assert env.installs_root() == pinned / "installs"
    assert env.install_state_dir(Path(tmp_path / "runtime")).is_relative_to(pinned / "installs")


def test_relative_or_empty_pin_is_ignored(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "user-home"))
    for value in ("", "  ", "relative/deps"):
        _set_pin(monkeypatch, value)
        assert env.dependency_home_pin() is None


def test_pinned_root_never_borrows_another_homes_state(monkeypatch, tmp_path):
    _set_pin(monkeypatch, str(tmp_path / "app-deps"))
    # A stale record in the user's own home (the 14 Nov state) must not be adopted.
    stale = tmp_path / ".hermes" / "installs" / env.install_key(tmp_path / "runtime")
    stale.mkdir(parents=True)
    (stale / "facts.json").write_text("{}")
    monkeypatch.setenv("HOME", str(tmp_path))
    assert env.owning_home_root(tmp_path / "runtime") is None


def test_unpinned_behaviour_is_unchanged(monkeypatch, tmp_path):
    _drop_pin(monkeypatch)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "user-home"))
    assert env.dependency_home_pin() is None
    assert env.installs_root() == env.dependency_home_root() / "installs"


def test_pin_leaves_the_homes_own_data_root_alone(monkeypatch, tmp_path):
    # Plugin selection, plugin publication and the config journal stay in the user's home: only dependency
    # state moves to the pinned root.
    from pm import plugins_state

    user_home = tmp_path / "user-home"
    monkeypatch.setenv("HERMES_HOME", str(user_home))
    _drop_pin(monkeypatch)
    unpinned = env.data_home_root()
    _set_pin(monkeypatch, str(tmp_path / "app-deps"))
    assert env.data_home_root() == unpinned != env.dependency_home_root()
    assert plugins_state._profiles_root() == unpinned / "profiles"


# ── the lease half: a pinned generation the confinement profile keeps read-only ──────────────────────────────────


def _read_only_generation(root: Path) -> Path:
    generation = root / "installs" / "k" / "environments" / "g1"
    (generation / ".leases").mkdir(parents=True)
    (generation / ".lease-managed").write_text("")
    (generation / ".leases").chmod(0o555)
    return generation


def _skip_if_root():
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        pytest.skip("root ignores directory modes")


def test_read_only_pinned_generation_boots_without_a_lease_when_confined(monkeypatch, tmp_path):
    from hermes_cli import iclone_policy_env, runtime_state

    _skip_if_root()
    pinned = tmp_path / "app-deps"
    generation = _read_only_generation(pinned)
    try:
        _set_pin(monkeypatch, str(pinned))
        monkeypatch.setattr(iclone_policy_env, "confined_at_exec", lambda: True)
        release = runtime_state.lease_directory(generation)
        release()
        assert list((generation / ".leases").iterdir()) == []
    finally:
        (generation / ".leases").chmod(0o755)


def test_read_only_pinned_generation_still_raises_when_not_confined(monkeypatch, tmp_path):
    from hermes_cli import iclone_policy_env, runtime_state

    _skip_if_root()
    pinned = tmp_path / "app-deps"
    generation = _read_only_generation(pinned)
    try:
        _set_pin(monkeypatch, str(pinned))
        monkeypatch.setattr(iclone_policy_env, "confined_at_exec", lambda: False)
        with pytest.raises(PermissionError):
            runtime_state.lease_directory(generation)
    finally:
        (generation / ".leases").chmod(0o755)


def test_read_only_generation_outside_the_pin_still_raises(monkeypatch, tmp_path):
    from hermes_cli import iclone_policy_env, runtime_state

    _skip_if_root()
    generation = _read_only_generation(tmp_path / "user-home")
    try:
        _set_pin(monkeypatch, str(tmp_path / "app-deps"))
        monkeypatch.setattr(iclone_policy_env, "confined_at_exec", lambda: True)
        with pytest.raises(PermissionError):
            runtime_state.lease_directory(generation)
        _drop_pin(monkeypatch)
        with pytest.raises(PermissionError):
            runtime_state.lease_directory(generation)
    finally:
        (generation / ".leases").chmod(0o755)


def test_writable_pinned_generation_still_takes_a_lease(monkeypatch, tmp_path):
    # Option (i) for the voice extra: the profile grants write to <pinned>/installs/<key>/; leases then work.
    from hermes_cli import runtime_state

    pinned = tmp_path / "app-deps"
    generation = pinned / "installs" / "k" / "environments" / "g1"
    generation.mkdir(parents=True)
    (generation / ".lease-managed").write_text("")
    _set_pin(monkeypatch, str(pinned))
    release = runtime_state.lease_directory(generation)
    try:
        assert runtime_state.leases_held(generation)
    finally:
        release()


def test_the_env_writer_refuses_to_persist_the_pin():
    # Which environment's packages a process imports is runtime-location authority (like PYTHONPATH): the app sets
    # it at spawn, the generic env writer never persists it.
    from hermes_cli.config import validate_env_var_name_for_write

    with pytest.raises(ValueError, match="denylist"):
        validate_env_var_name_for_write("HERMES_DEPENDENCY_HOME")


def test_generation_committed_in_the_pinned_root_is_selected(monkeypatch, tmp_path):
    # The voice extra (17 Nov lead decision): main's unconfined explicit installer commits a new generation under
    # <private>/installs/<key>/; the backend, run with the user's HERMES_HOME and HERMES_DEPENDENCY_HOME=<private>,
    # selects that generation, never one under <HERMES_HOME>/installs.
    import json

    project = tmp_path / "runtime"
    project.mkdir()
    pinned = tmp_path / "app-deps"
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "user-home"))
    _set_pin(monkeypatch, str(pinned))
    venv = pinned / "installs" / env.install_key(project) / "environments" / "g-voice" / "venv"
    venv.mkdir(parents=True)
    (venv / "pyvenv.cfg").write_text("version = 3.14.0\n")
    env.runtime_facts_path(project).write_text(json.dumps({"packages": {"venv": {"environment": str(venv)}}}))
    assert env.committed_venv(project) == venv.resolve()
    assert env.selected_venv(project) == venv.resolve()
    # The same record under the user's home is not what an unpinned lookup there would see.
    _drop_pin(monkeypatch)
    assert env.committed_venv(project) is None


# ── the pin is the launcher's: frozen at activation, before any .env load (v0.0.9 dephome gap) ─────────────────────


def test_pin_is_frozen_at_activation_and_a_later_env_write_cannot_redirect_it(monkeypatch, tmp_path):
    # A hand-edited ~/.hermes/.env is loaded AFTER activate_dependencies; whatever it writes to os.environ must not
    # move the dependency root (or the read-only-generation lease exemption) for the rest of this process.
    project = tmp_path / "runtime"
    project.mkdir()
    pinned = tmp_path / "app-deps"
    _set_pin(monkeypatch, str(pinned))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "user-home"))
    monkeypatch.setattr(env, "_require_own_dependencies", lambda root: None)
    env.activate_dependencies(project)  # nothing committed anywhere: selects nothing, but freezes the pin
    assert env.dependency_home_pin() == pinned

    monkeypatch.setenv("HERMES_DEPENDENCY_HOME", str(tmp_path / "attacker"))  # the .env loader's write
    assert env.dependency_home_pin() == pinned
    assert env.installs_root() == pinned / "installs"
    monkeypatch.delenv("HERMES_DEPENDENCY_HOME")  # nor can it drop the pin
    assert env.dependency_home_root() == pinned
    assert env.owning_home_root(project) is None


def test_an_unpinned_process_cannot_be_pinned_by_a_later_env_write(monkeypatch, tmp_path):
    project = tmp_path / "runtime"
    project.mkdir()
    _drop_pin(monkeypatch)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "user-home"))
    monkeypatch.setattr(env, "_require_own_dependencies", lambda root: None)
    env.activate_dependencies(project)
    monkeypatch.setenv("HERMES_DEPENDENCY_HOME", str(tmp_path / "attacker"))
    assert env.dependency_home_pin() is None
    assert env.dependency_home_root() == env.data_home_root()


def test_activation_is_the_first_reader(monkeypatch, tmp_path):
    # activate_dependencies takes the snapshot itself, before reading any install state.
    calls = []
    real = env.snapshot_dependency_home_pin
    monkeypatch.setattr(env, "snapshot_dependency_home_pin", lambda: calls.append("snap") or real())
    monkeypatch.setattr(env, "install_state_dir", lambda root: calls.append("state") or tmp_path / "none")
    monkeypatch.setattr(env, "payload_venv", lambda root: None)
    monkeypatch.setattr(env, "_require_own_dependencies", lambda root: None)
    env.activate_dependencies(tmp_path)
    assert calls[:2] == ["snap", "state"]


# ── v0.0.9 Q (security m4): a pin that exists must be this user's own folder, writable by nobody else ──────────────

def test_an_existing_private_pin_is_kept(monkeypatch, tmp_path):
    pinned = tmp_path / "app-deps"
    pinned.mkdir(mode=0o700)
    _set_pin(monkeypatch, str(pinned))
    assert env.dependency_home_pin() == pinned


@pytest.mark.parametrize("mode", [0o777, 0o775, 0o757])
def test_a_pin_writable_by_others_is_refused(monkeypatch, tmp_path, mode):
    pinned = tmp_path / "shared-deps"
    pinned.mkdir()
    os.chmod(pinned, mode)
    _set_pin(monkeypatch, str(pinned))
    assert env.dependency_home_pin() is None


def test_a_pin_that_is_a_link_or_a_file_is_refused(monkeypatch, tmp_path):
    real = tmp_path / "real"
    real.mkdir(mode=0o700)
    link = tmp_path / "link"
    link.symlink_to(real)
    _set_pin(monkeypatch, str(link))
    assert env.dependency_home_pin() is None
    plain = tmp_path / "file"
    plain.write_text("x")
    _set_pin(monkeypatch, str(plain))
    assert env.dependency_home_pin() is None


def test_a_pin_owned_by_another_user_is_refused(monkeypatch, tmp_path):
    pinned = tmp_path / "theirs"
    pinned.mkdir(mode=0o700)
    monkeypatch.setattr(os, "geteuid", lambda: os.stat(pinned).st_uid + 1)
    _set_pin(monkeypatch, str(pinned))
    assert env.dependency_home_pin() is None
