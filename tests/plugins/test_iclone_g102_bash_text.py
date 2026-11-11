"""G102 (panel 4 A major 2): bash reads a script file while it runs, so a line appended after the check would run
unchecked. A checked ``.sh`` now runs as ``bash -c '. "$0"' path``: ``.`` reads the whole file before running any of it,
``$0`` and ``BASH_SOURCE[0]`` are the real path, and the text is out of argv. Bodies only write marker files in
disposable folders; nothing here deletes or stops anything."""
from __future__ import annotations

import os
import sys
import time

import pytest

from tests.plugins.test_iclone_permissions import plugin  # noqa: F401

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX bash semantics")


@pytest.fixture
def gate_in_process(plugin, monkeypatch):
    from hermes_plugins.iclone_permissions import policy
    from tools import approval

    monkeypatch.setattr(approval, "_ICLONE_IGNORE_PROBE", lambda _key: False)
    monkeypatch.setattr(approval, "_ICLONE_UNATTENDED_FLOOR", plugin._unattended_floor)
    monkeypatch.setattr(approval, "_ICLONE_IGNORE_REFUSES", policy.ignore_refuses, raising=False)


def _pin_script(monkeypatch, script):
    from cron import scheduler_script

    monkeypatch.setattr(scheduler_script, "_resolve_script_path", lambda _p: (script, None))


def test_the_known_window_a_line_appended_after_the_re_stat_before_bash_reads_runs(gate_in_process, monkeypatch,
                                                                                 tmp_path):
    # The documented residual (SECURITY.md): bash opens the path by name, so a write between the last re-stat and
    # bash reading the file at start is run unchecked. This pins it so no claim says otherwise.
    from cron import scheduler_script

    script, ran, appended = tmp_path / "job.sh", tmp_path / "ran", tmp_path / "appended"
    script.write_text(f'echo ran > "{ran}"\n')
    real_popen = scheduler_script.subprocess.Popen

    def append_then_spawn(*args, **kwargs):
        with open(script, "a") as handle:
            handle.write(f'echo appended > "{appended}"\n')
        return real_popen(*args, **kwargs)

    monkeypatch.setattr(scheduler_script.subprocess, "Popen", append_then_spawn)
    _pin_script(monkeypatch, script)
    ok, out = scheduler_script._run_job_script(str(script))
    assert ok is True, out
    assert ran.read_text().strip() == "ran"
    assert appended.read_text().strip() == "appended"


def test_a_line_the_running_script_appends_to_its_own_file_does_not_run(gate_in_process, monkeypatch, tmp_path):
    # ``bash path`` reads on and runs the appended line; ``.`` read the whole file before its first line ran.
    from cron import scheduler_script

    script, before, appended = tmp_path / "job.sh", tmp_path / "before", tmp_path / "appended"
    appended_line = f'echo appended > "{appended}"\n'
    script.write_text(
        "printf '%s\\n' 'echo appended > \"'\"$(dirname \"$0\")\"'/appended\"' >> \"$0\"\n"
        f'echo before > "{before}"\n'
    )
    _pin_script(monkeypatch, script)
    ok, out = scheduler_script._run_job_script(str(script))
    assert ok is True, out
    assert before.read_text().strip() == "before"
    assert script.read_text().endswith(appended_line)
    assert not appended.exists()


def test_the_script_runs_with_its_real_path_as_dollar_zero_and_bash_source(gate_in_process, monkeypatch, tmp_path):
    from cron import scheduler_script

    script = tmp_path / "job.sh"
    (tmp_path / "sibling.txt").write_text("sibling-content\n")
    script.write_text(
        'echo "$0"\necho "${BASH_SOURCE[0]}"\npwd -P\n'
        'cat "$(dirname "${BASH_SOURCE[0]}")/sibling.txt"\necho "args=$#"\n'
    )
    _pin_script(monkeypatch, script)
    ok, out = scheduler_script._run_job_script(str(script))
    assert ok is True, out
    assert out.splitlines() == [str(script), str(script), os.path.realpath(tmp_path), "sibling-content", "args=0"]


def test_a_top_level_exit_status_is_the_run_s_status(gate_in_process, monkeypatch, tmp_path):
    from cron import scheduler_script

    script, after = tmp_path / "job.sh", tmp_path / "after"
    script.write_text(f'echo out\nexit 3\necho after > "{after}"\n')
    _pin_script(monkeypatch, script)
    ok, out = scheduler_script._run_job_script(str(script))
    assert ok is False and "exited with code 3" in out, out
    assert not after.exists()


def test_a_script_redirecting_fd_3_runs_to_the_end(gate_in_process, monkeypatch, tmp_path):
    from cron import scheduler_script

    script, marker3, done = tmp_path / "job.sh", tmp_path / "marker3", tmp_path / "done"
    script.write_text(f'exec 3>"{marker3}"\necho ok >&3\nexec 3>&-\necho done > "{done}"\n')
    _pin_script(monkeypatch, script)
    ok, out = scheduler_script._run_job_script(str(script))
    assert ok is True, out
    assert marker3.read_text().strip() == "ok" and done.read_text().strip() == "done"


def test_a_shell_script_larger_than_a_pipe_buffer_runs_whole(gate_in_process, monkeypatch, tmp_path):
    # The marker is the LAST line of a body past 64 KiB: ``.`` reads it whole, not one buffer.
    from cron import scheduler_script

    script, marker = tmp_path / "job.sh", tmp_path / "big"
    script.write_text(("# " + "p" * 997 + "\n") * 96 + f'echo big > "{marker}"\n')
    assert script.stat().st_size > 1 << 16
    _pin_script(monkeypatch, script)
    ok, out = scheduler_script._run_job_script(str(script))
    assert ok is True, out
    assert marker.read_text().strip() == "big"


def test_the_script_text_is_not_in_the_shell_s_argv(gate_in_process, monkeypatch, tmp_path):
    from cron import scheduler_script

    token = f"g102-secret-{os.getpid()}-{time.monotonic_ns()}"
    script, marker = tmp_path / "job.sh", tmp_path / "argv"
    script.write_text(f'# {token}\nps -o args= -p $$ > "{marker}"\n')
    _pin_script(monkeypatch, script)
    ok, out = scheduler_script._run_job_script(str(script))
    assert ok is True, out
    args = marker.read_text()
    assert f'. "$0" {script}' in args and token not in args


@pytest.mark.parametrize("body", [b"echo a\x00echo b\n", b"echo \xff\xfe\n"])
def test_a_shell_script_that_is_not_nul_free_utf8_is_refused(gate_in_process, monkeypatch, tmp_path, body):
    from cron import scheduler_script

    script = tmp_path / "job.sh"
    script.write_bytes(body)
    monkeypatch.setattr(scheduler_script.subprocess, "Popen", lambda *a, **k: pytest.fail("the script ran"))
    _pin_script(monkeypatch, script)
    ok, out = scheduler_script._run_job_script(str(script))
    assert ok is False and "not plain UTF-8 text" in out


def _same_size_rewrite_keeping_mtime(path):
    before = os.stat(path)
    time.sleep(0.02)
    path.write_bytes(path.read_bytes().replace(b"hello", b"HELLO"))
    os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
    after = os.stat(path)
    assert (after.st_ino, after.st_size, after.st_mtime_ns) == (before.st_ino, before.st_size, before.st_mtime_ns)
    assert after.st_ctime_ns != before.st_ctime_ns


@pytest.mark.parametrize("name, body", [("job.py", 'print("hello")\n'), ("job.sh", "echo hello\n")])
def test_the_re_stat_catches_a_change_only_ctime_shows(gate_in_process, tmp_path, name, body):
    from cron import scheduler_script

    script = tmp_path / name
    script.write_text(body)
    refusal, checked = scheduler_script._iclone_script_check(script, None)
    assert refusal is None and checked is not None
    assert scheduler_script._changed_since_check(script, checked) is None
    _same_size_rewrite_keeping_mtime(script)
    assert "changed after it was checked" in (scheduler_script._changed_since_check(script, checked) or "")


def _rewrite_after_the_check(monkeypatch):
    from cron import scheduler_script

    real = scheduler_script._iclone_script_check

    def check_then_rewrite(path, workdir):
        result = real(path, workdir)
        _same_size_rewrite_keeping_mtime(path)
        return result

    monkeypatch.setattr(scheduler_script, "_iclone_script_check", check_then_rewrite)
    monkeypatch.setattr(scheduler_script.subprocess, "Popen", lambda *a, **k: pytest.fail("the script ran"))


def test_a_ctime_only_change_after_the_check_stops_a_chosen_interpreter_run(gate_in_process, monkeypatch, tmp_path):
    from cron import scheduler_script

    script = tmp_path / "job.py"
    script.write_text('print("hello")\n')
    _rewrite_after_the_check(monkeypatch)
    _pin_script(monkeypatch, script)
    ok, out = scheduler_script._run_job_script(str(script), interpreter=sys.executable)
    assert ok is False and "changed after it was checked" in out


def test_a_ctime_only_change_after_the_check_stops_a_shell_run(gate_in_process, monkeypatch, tmp_path):
    from cron import scheduler_script

    script = tmp_path / "job.sh"
    script.write_text("echo hello\n")
    _rewrite_after_the_check(monkeypatch)
    _pin_script(monkeypatch, script)
    ok, out = scheduler_script._run_job_script(str(script))
    assert ok is False and "changed after it was checked" in out


# p5-lens-text: a non-interactive bash sources $BASH_ENV (and sh $ENV) before the -c command, so a startup file named in the
# launch environment would run ahead of the checked text, unchecked. The run clears both.
@pytest.mark.parametrize("checked", [True, False], ids=["gate-in-process", "no-gate"])
def test_a_startup_file_named_by_bash_env_or_env_does_not_run_before_the_script(plugin, monkeypatch, tmp_path, checked,
                                                                               request):
    import subprocess

    from cron import scheduler_script

    if checked:
        request.getfixturevalue("gate_in_process")
    startup, marker, ran = tmp_path / "startup.sh", tmp_path / "startup-ran", tmp_path / "ran"
    startup.write_text(f'echo startup > "{marker}"\n')
    # the control: this file is one bash really sources from BASH_ENV, so the assertion below is not vacuous
    subprocess.run(["/bin/bash", "-c", "true"], env={"PATH": "/usr/bin:/bin", "BASH_ENV": str(startup)}, check=True)
    assert marker.read_text().strip() == "startup"
    marker.unlink()
    monkeypatch.setenv("BASH_ENV", str(startup))
    monkeypatch.setenv("ENV", str(startup))
    seen = {}
    real_popen = scheduler_script.subprocess.Popen

    def spy(argv, *args, **kwargs):
        seen["env"] = dict(kwargs["env"])
        return real_popen(argv, *args, **kwargs)

    monkeypatch.setattr(scheduler_script.subprocess, "Popen", spy)
    script = tmp_path / "job.sh"
    script.write_text(f'echo ran > "{ran}"\n')
    _pin_script(monkeypatch, script)
    ok, out = scheduler_script._run_job_script(str(script))
    assert ok is True, out
    assert ran.read_text().strip() == "ran"
    assert not marker.exists()
    assert "BASH_ENV" not in seen["env"] and "ENV" not in seen["env"]
