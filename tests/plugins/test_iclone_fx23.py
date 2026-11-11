"""fx23: the queued scan's true reason (critic B), and the background wrapper's command and mark (proof6 F1, F5)."""
import shlex
import time

from tests.plugins.test_iclone_launcher import L, _flags, w  # noqa: F401
from tests.plugins.test_iclone_launcher_fx20 import _other, _run
from tools.process_registry import background_shell


def _wrapper(command, tmp="/s/tmp", sid="proc_ab12"):
    return background_shell(command, tmp, sid)


def test_a_scan_queued_behind_four_others_is_told_that_not_too_large(w, monkeypatch):
    other = _other(w, "big", planted=False)
    w.policy("acceptEdits", listed=[str(w.proj)])
    lau = w.start()
    monkeypatch.setattr(L, "SCAN_BUDGET_S", 0.05)
    held = 0
    while lau.scans.acquire(blocking=False):
        held += 1
    try:
        r = _run(w, _flags(w, project=other), ["/bin/echo", "never"])
    finally:
        for _ in range(held):
            lau.scans.release()
    assert held == L.SCANS_AT_ONCE
    assert r.returncode != 0 and "never" not in r.stdout
    assert "busy scanning other folders" in r.stderr
    assert "too large" not in r.stderr


def test_a_scan_whose_budget_went_in_the_queue_is_not_called_too_large(w, monkeypatch):
    other = _other(w, "big", planted=False)
    w.policy("acceptEdits", listed=[str(w.proj)])
    lau = w.start()
    real = lau.scans

    class Slow:
        def acquire(self, timeout=None):
            time.sleep(L.SCAN_QUEUED_S + 0.05)
            return real.acquire(timeout=timeout)

        def release(self):
            real.release()

    lau.scans = Slow()

    def out_of_time(*a, **k):
        raise L.core.ScanTooLarge()

    monkeypatch.setattr(L.core, "check_hardlinks", out_of_time)
    r = _run(w, _flags(w, project=other), ["/bin/echo", "never"])
    assert "busy scanning other folders" in r.stderr and "too large" not in r.stderr


def test_the_row_shows_the_command_inside_the_background_wrapper():
    assert L.background_command(_wrapper("sleep 60")) == "sleep 60"
    assert L.background_command(_wrapper("echo 'it''s'; sleep 4; exit 3")) == "echo 'it''s'; sleep 4; exit 3"


def test_anything_else_around_the_wrapper_is_shown_whole_so_nothing_is_hidden():
    plain = _wrapper("sleep 60")
    for text in (f"rm -rf x; {plain}", f"{plain}; rm -rf x", plain.replace("bash -lc", "sh -c"),
                 plain.replace("trap '' HUP; ", ""), plain.replace("trap '' HUP; ", "nohup "),
                 plain.replace("hermes_bg_proc_ab12.log", "other.log"),
                 plain.replace("&& cat", "; rm x && cat"), "sleep 60", "( nohup server ) &"):
        assert L.background_command(text) is None, text


def _script(body):
    return "builtin cd -- /tmp\neval '" + body.replace("'", "'\\''") + "'\n__hermes_ec=$?\nprintf x\nexit $?"


def test_described_command_names_the_wrapper_and_only_the_wrapper():
    marker = f"{L.core.MARKER_PREFIX}:project:x:s"
    assert L.described_command(["/bin/bash", "-x", "-c", _script(_wrapper("sleep 0")), marker])[1:] == ("sleep 0", True, True)
    assert L.described_command(["/bin/bash", "-x", "-c", _script("ls"), marker])[1:] == ("ls", True, False)


def test_the_start_row_carries_the_mark_for_the_pane(w):
    w.policy("acceptEdits", listed=[str(w.proj)])
    w.start()
    marker = f"{L.core.MARKER_PREFIX}:project:x:s"
    tmp = str(w.root / "scratch" / "bg")
    for body, mark in ((_wrapper("true", tmp=tmp), True), ("true", None)):
        _run(w, _flags(w), ["/bin/bash", "--noprofile", "-c", _script(body), marker])
        row = [r for r in w.journal() if r.get("ev") == "start"][-1]
        assert row.get("background") is mark
        assert row["command"] == "true"
