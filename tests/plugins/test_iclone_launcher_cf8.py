"""CF8: the launcher asks main's hard-link guard over fd 3 (a fake main on a socketpair here), and without it walks
only what moved (core's per-directory records). Every way the channel can fail refuses; nothing else gives a verdict."""
import dataclasses
import json
import os
import re
import socket
import struct
import threading
import time

import pytest

from tests.plugins.test_iclone_launcher import L, _flags, w  # noqa: F401
from tests.plugins.test_iclone_launcher_fx20 import _other, _run

core = L.core


class FakeMain:
    """Main's side of fd 3: reads one JSON line per request and answers with ``behave(request, send)``."""

    def __init__(self, behave):
        ours, theirs = socket.socketpair()
        self.sock = ours
        self.fd = theirs.detach()
        self.behave = behave
        self.requests = []
        threading.Thread(target=self._serve, daemon=True).start()

    def send(self, obj):
        data = obj if isinstance(obj, bytes) else (json.dumps(obj) + "\n").encode()
        try:
            self.sock.sendall(data)
        except OSError:
            pass

    def _serve(self):
        buffered = b""
        while True:
            try:
                chunk = self.sock.recv(65536)
            except OSError:
                return
            if not chunk:
                return
            buffered += chunk
            while b"\n" in buffered:
                line, buffered = buffered.split(b"\n", 1)
                request = json.loads(line)
                self.requests.append(request)
                threading.Thread(target=self.behave, args=(request, self.send), daemon=True).start()


def _ok(request, send):
    send({"id": request["id"], "ok": True})


def _guarded(w, monkeypatch, behave, stall=0.5, refusals=True):
    if refusals:
        w.index = dataclasses.replace(w.index, refusals_dir=str(w.root / "refusals"))
    other = _other(w, "big", planted=False)
    w.policy("acceptEdits", listed=[str(w.proj)])
    lau = w.start()
    main = FakeMain(behave)
    lau.guard = L.GuardChannel(main.fd)
    monkeypatch.setattr(L, "STALL_S", stall)
    return lau, main, other


def _starts(w):
    return [row for row in w.journal() if row.get("ev") == "start"]


def _rows(w):
    folder = w.root / "refusals"
    return [json.loads(x) for p in sorted(folder.glob("*.jsonl")) for x in p.read_text().splitlines()] if folder.exists() else []


def _no_walk(monkeypatch):
    """The launcher never walks itself while main's guard answers."""
    def walked(*a, **k):
        raise AssertionError("the launcher walked the folder itself")
    monkeypatch.setattr(core, "linked_inodes", walked)


# --- the channel ------------------------------------------------------------------------------------------------------


def test_a_clean_verdict_runs_the_command_with_a_fresh_nonce_each_request(w, monkeypatch):
    lau, main, other = _guarded(w, monkeypatch, _ok)
    _no_walk(monkeypatch)
    for _ in range(2):
        r = _run(w, _flags(w, project=other), ["/bin/echo", "ran"])
        assert r.returncode == 0 and "ran" in r.stdout
    before = [q for q in main.requests if q["phase"] == "before"]
    assert len(before) == 2 and before[0]["id"] != before[1]["id"]
    assert all(re.fullmatch(r"[0-9a-f]{32}", q["id"]) for q in main.requests)
    assert set(main.requests[0]) == {"id", "op", "root", "cls", "phase"} and main.requests[0]["op"] == "check"
    assert main.requests[0]["root"] == str(other)
    assert any(q["phase"] == "after" for q in main.requests)


def test_a_refusal_from_main_is_passed_through_with_no_start_row_and_the_slot_freed(w, monkeypatch):
    detail = "confinement refused to start: planted is a hard link to a file outside the project"
    lau, main, other = _guarded(w, monkeypatch, lambda q, send: send(
        {"id": q["id"], "ok": False, "code": "hard-links", "detail": detail}))
    for _ in range(L.SCANS_AT_ONCE + 1):
        r = _run(w, _flags(w, project=other), ["/bin/echo", "never"])
        assert r.returncode == 126 and "never" not in r.stdout and detail in r.stderr
    assert not _starts(w) and not lau.runs


def test_progress_is_forwarded_to_the_stub_and_the_command_then_runs(w, monkeypatch):
    def slow(q, send):
        for n in range(8):
            send({"id": q["id"], "progress": {"dirs": 1000 * n}})
            time.sleep(0.2)
        send({"id": q["id"], "ok": True})

    lau, main, other = _guarded(w, monkeypatch, slow, stall=0.5)
    monkeypatch.setattr(L, "PROGRESS_FORWARD_S", 0.0)
    told = []
    real = L.send_msg

    def recording(sock, obj, lock=None):
        if "progress" in obj:
            told.append(obj)
        return real(sock, obj, lock)

    monkeypatch.setattr(L, "send_msg", recording)
    started = time.monotonic()
    r = _run(w, _flags(w, project=other), ["/bin/echo", "after-progress"])
    assert time.monotonic() - started > 1.4  # longer than the stall: only the progress kept it alive
    assert r.returncode == 0 and "after-progress" in r.stdout
    assert len(told) >= 6 and all(set(m) == {"progress"} for m in told)


def test_main_progress_on_its_one_second_cadence_reaches_the_stub_without_a_two_second_hole(monkeypatch):
    """v0.0.8 S5 (full scale, PERF.launcher first.stub_gap_s 2.0 s > 2 s): main sends a progress frame every second; a
    forward throttle equal to that period dropped every frame that came a few ms early, so the stub saw 2 s holes. Frames
    0.99 s apart (main's cadence with jitter) are each forwarded; the contract to the stub is at most 2 s between frames."""
    clock = [100.0]
    monkeypatch.setattr(L.time, "monotonic", lambda: clock[0])
    sent = []
    monkeypatch.setattr(L, "send_msg", lambda sock, obj, lock=None: sent.append((clock[0], obj)))
    forward = L.Launcher._progress_to(None, threading.Lock())
    for n in range(12):
        clock[0] = 100.0 + 0.99 * n
        forward(1000 * n)
    times = [t for t, _ in sent]
    assert len(sent) == 12 and all(set(m) == {"progress"} for _, m in sent)
    assert max(b - a for a, b in zip(times, times[1:])) < 1.0
    # and it still throttles a chatty main: frames 0.1 s apart are not all forwarded
    sent.clear()
    for n in range(20):
        clock[0] = 200.0 + 0.1 * n
        forward(n)
    assert 2 <= len(sent) <= 5


@pytest.mark.parametrize("talk", ["silent", "one-progress-then-silent"])
def test_a_stalled_or_silent_main_is_refused_at_stall_s(w, monkeypatch, talk):
    def behave(q, send):
        if talk != "silent":
            send({"id": q["id"], "progress": {"dirs": 1}})

    lau, main, other = _guarded(w, monkeypatch, behave, stall=0.5)
    started = time.monotonic()
    r = _run(w, _flags(w, project=other), ["/bin/echo", "never"])
    assert time.monotonic() - started < 5
    assert r.returncode == 126 and L.GUARD_SILENT in r.stderr and "never" not in r.stdout
    assert not _starts(w) and not lau.runs


def test_a_scan_past_the_cap_is_still_being_checked_never_a_smaller_folder(w, monkeypatch):
    def forever(q, send):
        for _ in range(40):
            send({"id": q["id"], "progress": {"dirs": 5}})
            time.sleep(0.1)

    lau, main, other = _guarded(w, monkeypatch, forever, stall=0.5)
    monkeypatch.setattr(L, "FIRST_SCAN_CAP_S", 1.0)
    r = _run(w, _flags(w, project=other), ["/bin/echo", "never"])
    assert r.returncode == 126 and L.STILL_CHECKING in r.stderr and "smaller folder" not in r.stderr
    assert not _starts(w)


def test_eof_on_the_guard_refuses_now_and_every_time_after(w, monkeypatch):
    lau, main, other = _guarded(w, monkeypatch, lambda q, send: main.sock.close(), stall=5.0)
    for _ in range(2):
        started = time.monotonic()
        r = _run(w, _flags(w, project=other), ["/bin/echo", "never"])
        assert time.monotonic() - started < 4
        assert r.returncode == 126 and L.GUARD_GONE in r.stderr
    assert not _starts(w)


@pytest.mark.parametrize("answer", [
    lambda q: {"id": "0" * 32 if q["id"] != "0" * 32 else "1" * 32, "ok": True},  # wrong nonce
    lambda q: {"id": q["id"].upper(), "ok": True},  # not the nonce's spelling
    lambda q: b"this is not json\n",
    lambda q: {"id": q["id"], "ok": "yes"},
    lambda q: {"id": q["id"], "ok": True, "extra": 1},
    lambda q: {"id": q["id"], "ok": False, "code": "anything", "detail": "x"},
    lambda q: {"id": q["id"], "progress": {"dirs": True}},
    lambda q: {"id": q["id"], "ok": False, "code": "cannot-scan", "busy": "yes", "detail": "x"},
    lambda q: {"id": q["id"], "ok": False, "code": "hard-links", "busy": True, "detail": "x"},
    lambda q: {"id": q["id"], "ok": True, "busy": True},
    lambda q: {"id": q["id"], "progress": {"dirs": -1}},  # L2.4 (M21): a count is never negative
], ids=["wrong-nonce", "upper-nonce", "not-json", "ok-not-bool", "extra-key", "unknown-code", "bool-dirs",
        "busy-not-bool", "busy-on-hard-links", "busy-on-ok", "negative-dirs"])
def test_a_wrong_or_malformed_frame_refuses_at_once(w, monkeypatch, answer):
    lau, main, other = _guarded(w, monkeypatch, lambda q, send: send(answer(q)), stall=5.0)
    started = time.monotonic()
    r = _run(w, _flags(w, project=other), ["/bin/echo", "never"])
    assert time.monotonic() - started < 4
    assert r.returncode == 126 and L.GUARD_GARBLED in r.stderr and "never" not in r.stdout
    assert not _starts(w) and not lau.runs


def test_a_verdict_forged_on_the_runtime_socket_is_ignored(w, monkeypatch):
    lau, main, other = _guarded(w, monkeypatch, lambda q, send: None, stall=0.5)
    request = w.request(["/bin/echo", "forged"], params=_flags(w, project=other))
    data = json.dumps(request).encode()
    out_r, out_w = os.pipe()
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(10)
    try:
        sock.connect(w.socket)
        socket.send_fds(sock, [struct.pack(">I", len(data)) + data], [out_w, out_w, out_w])
        os.close(out_w)
        for forged in ({"ok": True}, {"ok": True, "pid": 1}):
            body = json.dumps({"id": "a" * 32, **forged}).encode()
            sock.sendall(struct.pack(">I", len(body)) + body)
        reply = L.recv_msg(sock, bytearray())
        while "progress" in reply:
            reply = L.recv_msg(sock, bytearray())
    finally:
        sock.close()
        os.close(out_r)
    assert reply.get("ok") is False and reply.get("code") == "cannot-scan"
    assert not _starts(w) and not lau.runs


def test_the_guard_fd_is_never_inherited_by_the_command(w, monkeypatch):
    lau, main, other = _guarded(w, monkeypatch, _ok)
    fd = lau.guard.fd
    assert os.get_inheritable(fd) is False
    probe = f"if [ -e /dev/fd/{fd} ]; then echo LEAKED; else echo CLEAN; fi"
    r = _run(w, _flags(w, project=other), ["/bin/sh", "-c", probe])
    assert r.returncode == 0 and "CLEAN" in r.stdout and "LEAKED" not in r.stdout


def test_guard_from_env_pops_the_name_and_a_bad_value_refuses_rather_than_falls_back():
    env = {L.GUARD_FD_ENV: "not-a-number"}
    guard = L.guard_from_env(env)
    assert L.GUARD_FD_ENV not in env and guard is not None
    with pytest.raises(L.Refusal) as refused:
        guard.ask("/p", None, "before")
    assert refused.value.code == "cannot-scan"
    assert L.guard_from_env({}) is None


def test_an_after_phase_timeout_writes_no_false_row(w, monkeypatch):
    lau, main, other = _guarded(w, monkeypatch, lambda q, send: _ok(q, send) if q["phase"] == "before" else None)
    r = _run(w, _flags(w, project=other), ["/bin/echo", "ran"])
    assert r.returncode == 0 and "ran" in r.stdout
    assert any(q["phase"] == "after" for q in main.requests)
    assert not [row for row in _rows(w) if row.get("operation") == "cannot-scan-after-run"]


@pytest.mark.parametrize("busy, rows", [(True, 0), (None, 1), (False, 1)], ids=["busy", "no-busy", "busy-false"])
def test_an_after_phase_cannot_scan_writes_a_row_only_without_busy(w, monkeypatch, busy, rows):
    def behave(q, send):
        if q["phase"] == "before":
            return _ok(q, send)
        # the same detail both ways: the launcher decides on "busy", never on the sentence
        verdict = {"id": q["id"], "ok": False, "code": "cannot-scan", "detail": L.STILL_CHECKING}
        send(verdict if busy is None else {**verdict, "busy": busy})

    lau, main, other = _guarded(w, monkeypatch, behave)
    assert _run(w, _flags(w, project=other), ["/bin/echo", "ran"]).returncode == 0
    assert any(q["phase"] == "after" for q in main.requests)
    assert len([row for row in _rows(w) if row.get("operation") == "cannot-scan-after-run"]) == rows


def test_a_busy_verdict_before_the_run_refuses_as_still_being_checked(w, monkeypatch):
    lau, main, other = _guarded(w, monkeypatch, lambda q, send: send(
        {"id": q["id"], "ok": False, "code": "cannot-scan", "busy": True, "detail": L.STILL_CHECKING}))
    r = _run(w, _flags(w, project=other), ["/bin/echo", "never"])
    assert r.returncode == 126 and L.STILL_CHECKING in r.stderr and not _starts(w)


def test_an_after_phase_refusal_from_main_is_recorded(w, monkeypatch):
    def behave(q, send):
        if q["phase"] == "before":
            return _ok(q, send)
        send({"id": q["id"], "ok": False, "code": "hard-links", "detail": "a hard link appeared"})

    lau, main, other = _guarded(w, monkeypatch, behave)
    assert _run(w, _flags(w, project=other), ["/bin/echo", "ran"]).returncode == 0
    rows = [row for row in _rows(w) if row.get("operation") == "hard-link-appeared"]
    assert rows and rows[0]["root"] == str(other)


@pytest.mark.parametrize("failure, rows", [(core.ScanTooLarge, 0), (PermissionError, 1)], ids=["out-of-time", "unscannable"])
def test_the_fallback_after_phase_out_of_time_writes_no_false_row(w, monkeypatch, failure, rows):
    w.index = dataclasses.replace(w.index, refusals_dir=str(w.root / "refusals"))
    other = _other(w, "big", planted=False)
    w.policy("acceptEdits", listed=[str(w.proj)])
    lau = w.start()
    monkeypatch.setattr(lau, "_scan_first", lambda plan, progress=None: None)

    def failing(*a, **k):
        raise failure(str(other))

    monkeypatch.setattr(core, "linked_inodes", failing)
    assert _run(w, _flags(w, project=other), ["/bin/echo", "ran"]).returncode == 0
    # out of time is not "cannot scan" (no row); a root that truly cannot be scanned still is (one row)
    assert len([row for row in _rows(w) if row.get("operation") == "cannot-scan-after-run"]) == rows


# --- the fallback (no fd 3): core's per-directory records -------------------------------------------------------------


@pytest.fixture
def tree(tmp_path):
    core._scan_cache.clear()
    project = tmp_path / "proj"
    for d in ("a/b/c", "d/e", "f"):
        (project / d).mkdir(parents=True)
    (project / "a" / "b" / "file").write_text("x")
    (tmp_path / "outside.txt").write_text("outside-secret\n")
    yield tmp_path, project
    for d, _subdirs, _files in os.walk(tmp_path):
        os.chmod(d, 0o755)
    core._scan_cache.clear()


def _count_scandir(monkeypatch):
    listed = []
    real = core.os.scandir

    def counting(path):
        listed.append(os.fspath(path))
        return real(path)

    monkeypatch.setattr(core.os, "scandir", counting)
    return listed


def test_a_hit_lists_no_directory_at_all(tree, monkeypatch):
    _tmp, project = tree
    assert core.linked_inodes(str(project)) == ([], False, [])
    listed = _count_scandir(monkeypatch)
    assert core.linked_inodes(str(project)) == ([], True, [])
    assert listed == []


def test_only_a_changed_directory_is_listed_again(tree, monkeypatch):
    _tmp, project = tree
    core.linked_inodes(str(project))
    (project / "d" / "e" / "new").write_text("y")
    listed = _count_scandir(monkeypatch)
    linked, cached, unscannable = core.linked_inodes(str(project))
    assert listed == [str(project / "d" / "e")]
    assert (linked, cached, unscannable) == ([], False, [])
    assert core._scan_cache[str(project)].files == 2


def test_a_planted_link_still_refuses(tree, monkeypatch):
    tmp, project = tree
    assert core.linked_inodes(str(project))[0] == []
    os.link(tmp / "outside.txt", project / "a" / "b" / "c" / "planted")
    linked, cached, _ = core.linked_inodes(str(project))
    assert not cached and [i["paths"] for i in linked] == [[str(project / "a" / "b" / "c" / "planted")]]
    # and it stays refused on the next hit
    listed = _count_scandir(monkeypatch)
    assert [i["paths"] for i in core.linked_inodes(str(project))[0]] == [[str(project / "a" / "b" / "c" / "planted")]]
    assert listed == []


def test_a_link_whose_outside_name_goes_is_seen_without_a_walk_of_its_folder_moving(tree):
    tmp, project = tree
    os.link(tmp / "outside.txt", project / "f" / "linked")
    assert len(core.linked_inodes(str(project))[0]) == 1
    os.unlink(tmp / "outside.txt")  # the outside name goes: the folder inside does not move, the link count does
    assert core.linked_inodes(str(project))[0] == []


def test_an_unlistable_directory_still_refuses(tree, monkeypatch):
    _tmp, project = tree
    core.linked_inodes(str(project))
    hidden = project / "d" / "e"
    hidden.chmod(0)
    try:
        linked, cached, unscannable = core.linked_inodes(str(project))
        assert not cached and unscannable == [str(hidden)]
        with pytest.raises(core.ConfinementRefused) as refused:
            core.check_hardlinks(_index(), str(project))
        assert refused.value.code == "cannot-scan"
        # and it is listed (and refused) again on every check, never answered clean from the records
        assert core.linked_inodes(str(project))[2] == [str(hidden)]
    finally:
        # FX-CWD: a mode-000 folder left behind makes iso_env's isolation walk fail closed (rc 72) for the whole run
        hidden.chmod(0o755)


def test_the_cache_age_forces_a_full_walk_that_finds_an_outside_name_for_a_one_link_file(tree, monkeypatch):
    """D2 (L3 T1, replaces test_the_cache_age_does_not_force_a_full_walk, which locked the regression in): within
    the age a hit lists nothing; past it the fallback walks whole, so an outside name made for an inside file that
    had one link (no inside directory moves) is found within _CACHE_MAX_AGE_S, as in v0.0.7."""
    tmp, project = tree
    at = time.monotonic()
    core.linked_inodes(str(project), now=at)
    os.link(project / "a" / "b" / "file", tmp / "outside-name")
    listed = _count_scandir(monkeypatch)
    assert core.linked_inodes(str(project), now=at + 1) == ([], True, [])
    assert listed == []
    linked, cached, unscannable = core.linked_inodes(str(project), now=at + core._CACHE_MAX_AGE_S + 1)
    assert not cached and unscannable == [] and listed
    assert str(project / "a" / "b" / "file") in json.dumps(linked)


def test_a_stalled_first_scan_records_nothing(tree, monkeypatch):
    _tmp, project = tree
    real = core.os.scandir

    def stuck(path):
        time.sleep(0.3)
        return real(path)

    monkeypatch.setattr(core.os, "scandir", stuck)
    with pytest.raises(core.ScanTooLarge):
        core.linked_inodes(str(project), stall_s=0.1)
    assert str(project) not in core._scan_cache


def _index():
    spec = {"v": 5, "profilesDir": "/nonexistent", "scratchRoot": "/nonexistent/scratch", "home": "/nonexistent/home",
            "membersDir": "/nonexistent/members", "denied": [], "sha256": {}}
    return core.parse_spec(json.dumps(spec))


# --- FX-P1: the cap's second exit, the wedged write, the after-asks, D1 (the window project goes to main) ----------


def test_a_progress_frame_that_lands_past_the_cap_is_still_being_checked(monkeypatch):
    """L2.4 (M18): the cap's other exit (a frame came, the cap passed while it was handled) says the same sentence."""
    main = FakeMain(lambda q, send: send({"id": q["id"], "progress": {"dirs": 3}}))
    monkeypatch.setattr(L, "STALL_S", 5.0)
    monkeypatch.setattr(L, "FIRST_SCAN_CAP_S", 0.3)
    guard = L.GuardChannel(main.fd)
    told = []
    with pytest.raises(L.Refusal) as refused:
        guard.ask("/p", None, "before", lambda dirs: (told.append(dirs), time.sleep(0.5)))
    assert told == [3]
    assert refused.value.code == "cannot-scan" and str(refused.value) == L.STILL_CHECKING


def _wedged_guard():
    """A main that stopped reading, its socket left writable by select (SO_SNDLOWAT free) but with less room than a
    long request needs: the case where a blocking write waits forever (L2.2, the critic's socketpair proof)."""
    ours, theirs = socket.socketpair()
    for sock in (ours, theirs):
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 8192)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8192)
    fd = theirs.detach()
    os.set_blocking(fd, False)
    while True:
        try:
            os.write(fd, b"x" * 512)
        except BlockingIOError:
            break
    ours.recv(2600)
    os.set_blocking(fd, True)  # as main hands it over; the channel decides how it writes
    return ours, fd


def test_a_long_request_to_a_main_that_stopped_reading_refuses_at_stall_s_and_never_wedges_the_lock(monkeypatch):
    ours, fd = _wedged_guard()
    monkeypatch.setattr(L, "STALL_S", 0.5)
    guard = L.GuardChannel(fd)
    outcomes = []

    def ask(root):
        try:
            guard.ask(root, None, "before")
        except L.Refusal as exc:
            outcomes.append(str(exc))

    long_root = "/" + "\u00e9" * 10 + "\u00e9" * 600  # escaped by json.dumps: about 3.6 KB on the wire
    threads = [threading.Thread(target=ask, args=(r,), daemon=True) for r in (long_root, "/short")]
    started = time.monotonic()
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=4)
    assert not any(t.is_alive() for t in threads), "a write to a main that stopped reading hung"
    assert time.monotonic() - started < 4 and len(outcomes) == 2
    ours.close()


def test_after_asks_have_their_own_bound_below_main_s_open_cap(w, monkeypatch):
    """L1.5: an after-ask waits for its own slot; with none free within STALL_S it asks nothing and writes no row."""
    assert L.AFTER_ASKS_AT_ONCE + L.SCANS_AT_ONCE < 64  # guard-channel.ts GUARD_MAX_OPEN
    hard = lambda q, send: send({"id": q["id"], "ok": False, "code": "hard-links", "detail": "a is a hard link"})  # noqa: E731
    lau, main, other = _guarded(w, monkeypatch, hard, stall=0.3)
    assert lau.after_asks._value == L.AFTER_ASKS_AT_ONCE
    lau.after_asks = threading.BoundedSemaphore(1)
    lau.after_asks.acquire()
    run = L.Run.__new__(L.Run)
    run.proc = type("P", (), {"pid": 4242})()
    run.facts = {"scan_root": str(other), "scan_main": True, "session": None, "cls": None}
    lau._scan_after(run)
    assert main.requests == [] and _rows(w) == []
    lau.after_asks.release()
    lau._scan_after(run)
    assert [q["phase"] for q in main.requests] == ["after"] and len(_rows(w)) == 1


def test_an_after_phase_row_carries_main_s_sentence(w, monkeypatch):
    """L2.3: the row names the root and says what main found (the verdict has no path list)."""
    def behave(q, send):
        if q["phase"] == "before":
            send({"id": q["id"], "ok": True})
        else:
            send({"id": q["id"], "ok": False, "code": "hard-links", "detail": "planted is a hard link"})

    lau, main, other = _guarded(w, monkeypatch, behave)
    r = _run(w, _flags(w, project=other), ["/bin/echo", "ran"])
    assert r.returncode == 0
    rows = _rows(w)
    assert len(rows) == 1 and rows[0]["target"] == str(other) and rows[0]["detail"] == "planted is a hard link"


@pytest.mark.parametrize("cause", ["stalled", "cap"])
def test_the_fallback_says_which_of_its_two_limits_stopped_the_check(w, monkeypatch, cause):
    """L6.3: a stall can pass by trying again; the cap cannot (no partial walk is kept), so it says what helps."""
    other = _other(w, "big", planted=False)
    w.policy("acceptEdits", listed=[str(w.proj)])
    w.start()
    monkeypatch.setattr(L, "FIRST_SCAN_CAP_S", 0.4)

    def out_of_time(*a, **k):
        if cause == "cap":
            time.sleep(0.5)
        raise core.ScanTooLarge(str(other))

    monkeypatch.setattr(core, "check_hardlinks", out_of_time)
    r = _run(w, _flags(w, project=other), ["/bin/echo", "never"])
    assert r.returncode == 126 and "never" not in r.stdout and not _starts(w)
    if cause == "cap":
        assert "took longer than" in r.stderr and "open it in icloneOS" in r.stderr and "try again" not in r.stderr
    else:
        assert "stopped progressing" in r.stderr and "try again in a moment" in r.stderr and "took longer" not in r.stderr


def test_d1_the_window_project_inside_the_runtime_s_roots_is_asked_of_main_before_and_after(w, monkeypatch):
    """CF8 D1 (L5.3, L3 T1 part 2): the runtime no longer walks its own project; the launcher asks main about it,
    the same request as for any command's project, and never walks it itself."""
    w.roots = ([str(w.rt), str(w.proj)], [str(w.root / "scratch")])
    w.index = dataclasses.replace(w.index, refusals_dir=str(w.root / "refusals"))
    w.policy("acceptEdits", listed=[str(w.proj)])
    lau = w.start()
    main = FakeMain(_ok)
    lau.guard = L.GuardChannel(main.fd)
    _no_walk(monkeypatch)
    r = _run(w, _flags(w), ["/bin/echo", "ran"])
    assert r.returncode == 0 and "ran" in r.stdout
    assert [(q["root"], q["phase"]) for q in main.requests] == [(str(w.proj), "before"), (str(w.proj), "after")]


def test_d1_a_refusal_for_the_window_project_refuses_with_no_start_row(w, monkeypatch):
    w.roots = ([str(w.rt), str(w.proj)], [str(w.root / "scratch")])
    w.policy("acceptEdits", listed=[str(w.proj)])
    lau = w.start()
    main = FakeMain(lambda q, send: send({"id": q["id"], "ok": False, "code": "hard-links", "detail": "x is linked"}))
    lau.guard = L.GuardChannel(main.fd)
    r = _run(w, _flags(w), ["/bin/echo", "never"])
    assert r.returncode == 126 and "x is linked" in r.stderr and "never" not in r.stdout
    assert not _starts(w) and not lau.runs


def test_d1_a_runtime_root_main_does_not_guard_is_walked_here_bounded_not_asked(w, monkeypatch):
    """A folder inside the runtime's other roots (its venv, plugins) is not one main guards: main would refuse it.
    The launcher walks it itself, within the cap; the scratch is still nobody's here (the runtime's bounded check)."""
    inner = w.rt / "plugins"
    inner.mkdir(exist_ok=True)
    v = w.validator()
    v.read_roots, v.write_roots = (str(w.rt), str(w.proj)), ()
    w.policy("acceptEdits", listed=[str(w.proj)])
    v.policy = L.LauncherPolicy(str(w.ledger), module=None)
    assert v.scan_root({"PROJECT_ROOT": str(inner), "SCRATCH": str(w.scratch)}) == str(inner)
    assert v.scan_by_main(str(inner)) is False
    assert v.scan_by_main(str(w.proj)) is True and v.scan_by_main(str(w.proj / "sub")) is True
    assert v.scan_root({"PROJECT_ROOT": str(w.scratch), "SCRATCH": str(w.scratch)}) is None
    asked = []
    walked = []
    lau = w.start()
    lau.guard = type("G", (), {"ask": lambda self_, *a, **k: asked.append(a)})()
    monkeypatch.setattr(core, "check_hardlinks", lambda *a, **k: walked.append(k.get("deadline")))
    lau._scan_first({"facts": {"scan_root": str(inner), "scan_main": False, "cls": None}})
    assert asked == [] and len(walked) == 1 and walked[0] is not None
