"""SECURITY, scheduled scripts: Ignore is the mode set for the folder the icloneOS runtime works in, not the job's own
working folder, else the Settings default. test_iclone_cron_run_mode.py passes the runtime folder as the job's workdir,
so it cannot tell the two apart; here they are two different folders, each its own project, and the job's workdir is
what the scheduler hands ``_iclone_script_check`` (scheduler_script.py). Nothing runs a script: only its check is read."""
from __future__ import annotations

import pytest

from tests.plugins.test_iclone_permissions import _body, plugin  # noqa: F401
from tools import approval

NOT_REFUSED_IN_IGNORE = "shutdown -h now\n"  # a floor Ignore runs; only ever read, never run
TOTAL_DESTRUCTION = "rm -rf /\n"  # refused in every mode; only ever read, never run


class _Policy:
    def __init__(self, body):
        self._body = body

    def body(self):
        return self._body


@pytest.fixture
def folders(plugin, monkeypatch, tmp_path):
    from hermes_plugins import iclone_permissions as mod
    from hermes_plugins.iclone_permissions.classify import project_root

    for name in ("_ICLONE_POLICY_LOCK", "_ICLONE_PERMISSIONS_ACTIVE", "_ICLONE_IGNORE_PROBE", "_ICLONE_UNATTENDED_FLOOR",
                 "_ICLONE_IGNORE_REFUSES"):
        monkeypatch.setattr(approval, name, getattr(approval, name, None), raising=False)
    monkeypatch.setattr(approval, "_ICLONE_POLICY_LOCK", True)
    mod._pin_hermes_approval(approval)
    monkeypatch.setattr(approval, "_iclone_script_deny_rule", lambda _text: None)
    runtime, workdir = tmp_path / "runtime-folder", tmp_path / "job-workdir"
    for folder in (runtime, workdir):
        (folder / ".git").mkdir(parents=True)
    monkeypatch.setattr(mod, "_cwd_for", lambda _task: str(runtime))
    script = workdir / "job.sh"

    def check(body, text):
        from cron import scheduler_script

        monkeypatch.setitem(mod._state, "policy", _Policy(body))
        script.write_text(text)
        return scheduler_script._iclone_script_check(script, str(workdir))[0]

    roots = (project_root(str(runtime)), project_root(str(workdir)))
    assert roots[0] and roots[1] and roots[0] != roots[1], roots
    return check, roots


def test_a_job_workdir_set_to_ignore_does_not_make_its_script_ignore(folders):
    check, (runtime, workdir) = folders
    body = _body(standing="manual", projects={workdir: "ignore"})
    assert check(body, NOT_REFUSED_IN_IGNORE) is not None


def test_a_job_workdir_set_to_manual_does_not_hold_back_the_runtime_folder_s_ignore(folders):
    check, (runtime, workdir) = folders
    body = _body(standing="manual", projects={runtime: "ignore", workdir: "manual"})
    assert check(body, NOT_REFUSED_IN_IGNORE) is None
    assert check(body, TOTAL_DESTRUCTION) is not None


def test_with_no_runtime_folder_row_the_settings_default_decides_whatever_the_workdir_says(folders):
    check, (_runtime, workdir) = folders
    assert check(_body(standing="ignore", projects={workdir: "manual"}), NOT_REFUSED_IN_IGNORE) is None
    assert check(_body(standing="manual", projects={workdir: "ignore"}), NOT_REFUSED_IN_IGNORE) is not None
