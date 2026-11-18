"""fx20: lens5's launcher findings. M1: the scan runs outside ``runs_lock``, within a budget, and the stub outlasts it;
a failed reply reaps the run. M2: a folder outside the runtime's roots is scanned before and after, whatever the flags.
m4: no cwd in a denied folder. H1: a listed folder has no mode, and only the modes decide what a command there may do."""
import dataclasses
import json
import os
import re
import select
import subprocess
import threading
import time

import pytest

from tests.plugins.test_iclone_launcher import L, STUB_PY, _flags, w  # noqa: F401


def _other(w, name="other", planted=True):
    other = w.root / name
    (other / ".git").mkdir(parents=True)
    if planted:
        os.link(w.root / "outside.txt", other / "planted")  # an inode with a name outside the folder
    return other


def _run(w, flags, cmd, timeout=40):
    return subprocess.run(w.stub(w.argv(cmd, params=flags)), capture_output=True, text=True, timeout=timeout)


# M2


def test_m2_unlisted_folder_asking_less_is_scanned_too(w):
    other = _other(w)
    w.policy("acceptEdits", listed=[str(w.proj)])
    w.start()
    r = _run(w, _flags(w, project=other, write="0"), ["/bin/cat", str(other / "planted")])
    assert r.returncode != 0 and "outside-secret" not in r.stdout


def test_m2_folder_listed_after_the_runtime_started_is_scanned(w):
    other = _other(w)
    w.policy("acceptEdits", listed=[str(w.proj), str(other)])
    w.start()
    r = _run(w, _flags(w, project=other), ["/bin/cat", str(other / "planted")])
    assert r.returncode != 0 and "outside-secret" not in r.stdout


def test_m2_the_runtimes_own_folder_is_scanned_by_the_launcher_too(w):
    # CF8 D1: the confined runtime no longer walks its own project (it was left to that walk, with no bound and no
    # age); the launcher checks it like any other command's project, so a planted link there refuses the command.
    other = _other(w)
    w.policy("acceptEdits", listed=[str(w.proj), str(other)])
    w.start(roots=([str(w.rt), str(other)], [str(w.root / "scratch")]))
    r = _run(w, _flags(w, project=other), ["/bin/cat", str(other / "planted")])
    assert r.returncode != 0 and "outside-secret" not in r.stdout


def test_m2_a_link_planted_during_the_run_is_recorded_after_it(w):
    other = _other(w, planted=False)
    w.policy("acceptEdits", listed=[str(w.proj), str(other)])
    lau = w.start()
    refusals = str(w.root / "refusals")
    lau.validator.index = dataclasses.replace(lau.validator.index, refusals_dir=refusals)
    r = _run(w, _flags(w, project=other), ["/bin/ln", str(w.root / "outside.txt"), str(other / "linked")])
    assert r.returncode == 0, r.stderr
    rows = [json.loads(line) for f in sorted(os.listdir(refusals)) for line in open(os.path.join(refusals, f))]
    after = [row for row in rows if row["operation"] == "hard-link-appeared"]
    assert after and after[0]["root"] == str(other) and after[0]["target"] == str(other / "linked")


# M1


def test_m1_the_scan_holds_no_lock_and_another_session_runs_during_it(w, monkeypatch):
    other = _other(w, "big", planted=False)
    w.policy("acceptEdits", listed=[str(w.proj)])
    lau = w.start(roots=([str(w.rt), str(w.proj)], [str(w.root / "scratch")]))
    real = L.core.check_hardlinks
    scanning, release = threading.Event(), threading.Event()

    def held(*a, **k):
        if a[1] == str(other):  # CF8 D1: the other session's own project is scanned too; only this one is held
            scanning.set()
            assert release.wait(30)
        return real(*a, **k)

    monkeypatch.setattr(L.core, "check_hardlinks", held)
    out = {}
    t = threading.Thread(target=lambda: out.update(r=_run(w, _flags(w, project=other), ["/bin/echo", "big"])))
    t.start()
    assert scanning.wait(20)
    free = lau.runs_lock.acquire(timeout=5)
    if free:
        lau.runs_lock.release()
    second = _run(w, _flags(w), ["/bin/echo", "other-session"], timeout=20)
    release.set()
    t.join()
    assert free is True
    assert second.returncode == 0 and "other-session" in second.stdout
    assert out["r"].returncode == 0 and "big" in out["r"].stdout


def test_m1_a_scan_longer_than_ten_seconds_is_waited_for_and_never_called_not_answering(w, monkeypatch):
    other = _other(w, "big", planted=False)
    w.policy("acceptEdits", listed=[str(w.proj)])
    w.start()
    real = L.core.check_hardlinks

    def slow(*a, **k):
        time.sleep(11)
        return real(*a, **k)

    monkeypatch.setattr(L.core, "check_hardlinks", slow)
    r = _run(w, _flags(w, project=other), ["/bin/echo", "after-scan"])
    assert "not answering" not in r.stderr
    assert r.returncode == 0 and "after-scan" in r.stdout


def test_m1_a_folder_slower_than_the_old_budget_is_waited_for_with_progress_then_runs(w, monkeypatch):
    # CF8: a first scan that progresses has no fixed budget (it was refused at SCAN_BUDGET_S): it is waited for, the
    # stub hears its progress, and the command runs. The security half stays: a scan that stalls is refused, with no
    # start row, and its slot is back for the next one.
    other = _other(w, "big", planted=False)
    for i in range(12):
        (other / f"d{i}").mkdir()
    w.policy("acceptEdits", listed=[str(w.proj)])
    lau = w.start()
    monkeypatch.setattr(L, "SCAN_BUDGET_S", 1e-9)
    monkeypatch.setattr(L, "PROGRESS_FORWARD_S", 0.0)
    monkeypatch.setattr(L.core, "_PROGRESS_EVERY_S", 0.0)
    monkeypatch.setattr(L.core, "FIRST_SCAN_STALL_S", 0.5)
    real_scandir = L.core.os.scandir

    def slow_scandir(path):
        time.sleep(0.15)  # 14 folders: ~2 s, far past the stall each step stays under
        return real_scandir(path)

    monkeypatch.setattr(L.core.os, "scandir", slow_scandir)
    r = _run(w, _flags(w, project=other), ["/bin/echo", "after-scan"])
    assert r.returncode == 0 and "after-scan" in r.stdout
    assert "not answering" not in r.stderr and "too large" not in r.stderr

    L.core._scan_cache.clear()
    starts = len([row for row in w.journal() if row.get("ev") == "start"])

    def stalled_scandir(path):
        time.sleep(0.8)  # one folder longer than the stall: no progress, refused
        return real_scandir(path)

    monkeypatch.setattr(L.core.os, "scandir", stalled_scandir)
    r = _run(w, _flags(w, project=other), ["/bin/echo", "never"])
    assert r.returncode != 0 and "never" not in r.stdout
    assert "stopped progressing" in r.stderr and "not answering" not in r.stderr
    assert "smaller folder" not in r.stderr
    assert len([row for row in w.journal() if row.get("ev") == "start"]) == starts
    assert not lau.runs
    # The slot is back: a later scan that progresses goes through.
    monkeypatch.setattr(L.core.os, "scandir", real_scandir)
    assert _run(w, _flags(w, project=other), ["/bin/echo", "fits"]).returncode == 0


def test_m1_a_fallback_scan_that_keeps_progressing_is_still_refused_past_the_cap(w, monkeypatch):
    # L6.1: the launcher's own fallback (no fd 3) bounds a first scan by FIRST_SCAN_CAP_S however it progresses: each
    # folder stays under the stall, the walk as a whole runs past the cap. Refused for that reason (not as a stall),
    # with no start row and no run, and the slot is back for the next scan.
    other = _other(w, "big", planted=False)
    for i in range(12):
        (other / f"d{i}").mkdir()
    w.policy("acceptEdits", listed=[str(w.proj)])
    lau = w.start()
    assert lau.guard is None
    L.core._scan_cache.clear()
    monkeypatch.setattr(L, "FIRST_SCAN_CAP_S", 0.5)
    monkeypatch.setattr(L.core, "FIRST_SCAN_STALL_S", 5.0)
    real_scandir = L.core.os.scandir

    def slow_scandir(path):
        time.sleep(0.15)  # 14 folders: ~2 s, each one far under the stall
        return real_scandir(path)

    monkeypatch.setattr(L.core.os, "scandir", slow_scandir)
    starts = len([row for row in w.journal() if row.get("ev") == "start"])
    r = _run(w, _flags(w, project=other), ["/bin/echo", "never"])
    assert r.returncode != 0 and "never" not in r.stdout
    assert re.search(r"took longer than|ran past", r.stderr) and "stopped progressing" not in r.stderr
    assert len([row for row in w.journal() if row.get("ev") == "start"]) == starts
    assert not lau.runs
    monkeypatch.setattr(L.core.os, "scandir", real_scandir)
    monkeypatch.setattr(L, "FIRST_SCAN_CAP_S", 180.0)
    assert _run(w, _flags(w, project=other), ["/bin/echo", "fits"]).returncode == 0


def test_m1_the_stub_outlasts_the_launchers_budget():
    reply = float(re.search(r"^REPLY_TIMEOUT_S = ([0-9.]+)$", STUB_PY.read_text(), re.M).group(1))
    assert reply > L.SCAN_BUDGET_S


def test_m1_a_failed_reply_reaps_the_run_frees_the_slot_writes_the_end_and_closes_the_pipe(w, monkeypatch):
    other = _other(w, "unlisted", planted=False)
    w.policy("acceptEdits", listed=[str(w.proj)])
    lau = w.start()
    real = L.send_msg

    def fails_once(sock, obj, lock=None):
        if obj.get("ok") is True and "pid" in obj:
            raise OSError("the stub is gone")
        return real(sock, obj, lock)

    monkeypatch.setattr(L, "send_msg", fails_once)
    r, wfd = os.pipe()
    stub = subprocess.Popen(w.stub(w.argv(["/bin/sleep", "60"], params=_flags(w, project=other))),
                            stdout=wfd, stderr=wfd, stdin=subprocess.DEVNULL)
    os.close(wfd)
    stub.wait(timeout=30)
    # EOF, within a deadline: nothing the launcher holds keeps the runtime's pipe open.
    deadline = time.monotonic() + 15
    eof = False
    while time.monotonic() < deadline and not eof:
        ready, _, _ = select.select([r], [], [], 1.0)
        eof = bool(ready) and os.read(r, 4096) == b""
    os.close(r)
    assert eof
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and lau.runs:
        time.sleep(0.05)
    assert not lau.runs
    events = [row.get("ev") for row in w.journal()]
    assert "start" in events and "end" in events


# m4


def test_m4_a_cwd_inside_a_denied_folder_is_refused_alike_whether_the_name_exists_or_not(w):
    denied = w.root / "denied"
    (denied / "exists").mkdir(parents=True)
    w.policy("acceptEdits")
    answers = []
    for cwd in (denied / "exists", denied / "missing", denied):
        with pytest.raises(L.Refusal) as err:
            w.validator().request({**w.request(["/bin/pwd"]), "cwd": str(cwd)})
        answers.append((err.value.code, str(err.value)))
    assert len(set(answers)) == 1
    assert w.validator().request({**w.request(["/bin/pwd"]), "cwd": str(w.proj)})["cwd"] == str(w.proj)


# H1, the launcher's half: main writes the folder in the list and no row in the modes.


@pytest.mark.parametrize("standing,write", [("automatic", True), ("manual", False)])
def test_h1_a_listed_folder_with_no_mode_row_follows_the_modes(w, standing, write):
    other = _other(w, planted=False)
    w.policy(standing, listed=[str(w.proj), str(other)], projects={}, sessions={}, grants=[], folders=[str(other)])
    start = w.validator().request(w.request(["/bin/echo"], params=_flags(w, project=other)))["start"]
    assert start["write"] is write
    if not write:
        assert start["narrowed_why"] == "needs-allow"


def test_h1_manual_with_an_allow_in_that_folder_writes(w):
    other = _other(w, planted=False)
    w.policy("manual", listed=[str(w.proj), str(other)], projects={}, sessions={}, grants=[], folders=[str(other)])
    w.pass_(project=str(other))
    start = w.validator().request(w.request(["/bin/echo"], params=_flags(w, project=other)))["start"]
    assert start["write"] is True


def test_h1_at_plan_a_listed_folder_writes_nothing(w):
    other = _other(w, planted=False)
    w.policy("plan", listed=[str(w.proj), str(other)], projects={}, sessions={}, grants=[], folders=[str(other)])
    start = w.validator().request(w.request(["/bin/echo"], params=_flags(w, project=other, write="0")))["start"]
    assert start["write"] is False
    with pytest.raises(L.Refusal):
        w.validator().request(w.request(["/bin/echo"], params=_flags(w, project=other)))
