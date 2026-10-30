"""Cross-package prefetch (G-01): downloads run ahead, publication stays serial.

Real archives over the suite's local range server, a real store, real facts.
The desktop overlay's own regexes (install-packages.ts) judge every line.
"""

from __future__ import annotations

import _thread
import hashlib
import io
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import zipfile
from collections import Counter
from contextlib import contextmanager, nullcontext
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

import pm
import pm.cli
import pm.install
from pm import artifact_mirror, paths, registry
from pm.downloader import DownloadPaused
from pm.install import Prefetch, _install_operation
from pm.lock import Facts, Lockfile
from pm.package import Package, StatePackage
from pm.store import Store, tree_digest
from tests.pm._range_server import RangeHandler, url

OVERLAY = Path(__file__).resolve().parents[2] / "apps/desktop/src/iclone-shared/install-packages.ts"


class CountingHandler(RangeHandler):
    """RangeHandler that also counts every GET per path (probes included)."""

    gets: Counter = Counter()
    order: list = []
    timeline: list = []  # ("get", path) events, shared with spies in the test
    refuse: set = set()  # paths answered 404 while listed
    refuse_delay = 0.0
    lock = threading.Lock()

    def do_GET(self):  # noqa: N802 - http.server API
        with self.lock:
            CountingHandler.gets[self.path] += 1
            CountingHandler.timeline.append(("get", self.path))
            if self.path not in CountingHandler.order:
                CountingHandler.order.append(self.path)
            refused = self.path in CountingHandler.refuse
        if refused:
            time.sleep(self.refuse_delay)
            self.send_error(404)
            return
        super().do_GET()


class BarrierHandler(CountingHandler):
    """Holds each request (≤ 1 s) until ``want`` distinct archives are in flight; records the peak."""

    cond = threading.Condition()
    inflight: Counter = Counter()
    peak = 0
    want = 4

    @classmethod
    def _distinct(cls) -> int:
        return sum(1 for count in cls.inflight.values() if count)

    def do_GET(self):  # noqa: N802 - http.server API
        cls = BarrierHandler
        with cls.cond:
            cls.inflight[self.path] += 1
            cls.peak = max(cls.peak, cls._distinct())
            cls.cond.notify_all()
            cls.cond.wait_for(lambda: cls._distinct() >= cls.want, timeout=1.0)
        try:
            super().do_GET()
        finally:
            with cls.cond:
                cls.inflight[self.path] -= 1
                cls.cond.notify_all()


class StallHandler(CountingHandler):
    """Answers the probe of ``/stall.zip``, never its ranged pieces: the downloader's own connection threads sit in
    a socket read (the case that also holds interpreter exit, which joins them)."""

    arrived = threading.Event()
    release = threading.Event()

    def do_GET(self):  # noqa: N802 - http.server API
        if self.path == "/stall.zip" and self.headers.get("Range") != "bytes=0-0":
            StallHandler.arrived.set()
            StallHandler.release.wait(60)
            return
        super().do_GET()


@pytest.fixture
def server():
    RangeHandler.payloads = {}
    RangeHandler.ranges_seen = []
    RangeHandler.abort_after = None
    RangeHandler.slow_per_chunk = 0.0
    RangeHandler.no_range = False
    RangeHandler.etags = True
    RangeHandler.chunk = 1 << 20
    CountingHandler.gets = Counter()
    CountingHandler.order = []
    CountingHandler.timeline = []
    CountingHandler.refuse = set()
    CountingHandler.refuse_delay = 0.0
    BarrierHandler.inflight = Counter()
    BarrierHandler.peak = 0
    StallHandler.arrived = threading.Event()
    StallHandler.release = threading.Event()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), CountingHandler)
    httpd.daemon_threads = True
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield httpd
    finally:
        StallHandler.release.set()
        httpd.shutdown()
        httpd.server_close()


def _zip(files: dict[str, bytes]) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as stream:
        for name, body in files.items():
            stream.writestr(name, body)
    return out.getvalue()


@pytest.fixture
def world(tmp_path, monkeypatch, server):
    """A store, a lockfile and ``add(name, body, deps=(), sha=None)`` to pin a package."""
    root = tmp_path / "store"
    lock_path = tmp_path / "lock.json"
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setattr(paths, "store_root", lambda: root)
    monkeypatch.setattr(paths, "lockfile_path", lambda: lock_path)
    monkeypatch.setattr(artifact_mirror, "PUBLIC_PREFIX", url(server, "/mirror/"))  # hermetic: no public mirror
    lock = Lockfile(lock_path)

    class World:
        store = pm.Store(root)
        payloads: dict[str, bytes] = {}

        def add(self, name, body, *, deps=(), sha=None):
            cls = type(f"P_{name.replace('-', '_')}", (Package,), {"name": name, "deps": tuple(deps)})
            monkeypatch.setitem(registry._packages, name, cls())
            payload = _zip({f"{name}.dat": body})
            path = f"/{name}.zip"
            RangeHandler.payloads[path] = payload
            self.payloads[name] = payload
            pin = {"url": url(server, path), "sha256": sha or hashlib.sha256(payload).hexdigest()}
            lock.set_pin(name, "1", {"any": [pin]})
            lock.save()
            return pin

        def facts(self):
            return Facts(root / "facts.json")

        def fetched(self):
            return sorted(p.name for p in root.glob("fetch-*"))

    return World()


def _no_prefetch(monkeypatch):
    real = Prefetch.start.__func__

    def start(cls, names, **kwargs):
        return real(cls, [], **kwargs)

    monkeypatch.setattr(Prefetch, "start", classmethod(start))


def _capture_prefetch(monkeypatch) -> list:
    """Every Prefetch _install_names starts, for assertions on its state."""
    seen: list = []
    real = Prefetch.start.__func__

    def start(cls, names, **kwargs):
        seen.append(real(cls, names, **kwargs))
        return seen[-1]

    monkeypatch.setattr(Prefetch, "start", classmethod(start))
    return seen


def _reset(world):
    """Forget every installed entry and fact (a fresh store, same pins)."""
    facts = world.facts()
    for name in list(world.payloads):
        if facts.get(name):
            pm.install._remove_entry(world.store, facts.get(name)["entry"], attempts=1)
    (world.store.root / "facts.json").unlink(missing_ok=True)


def _install(names, capsys):
    failed = pm.cli._install_names(names)
    return failed, capsys.readouterr().out.splitlines()


# ── the overlay's regexes, read from its source so a drift on either side fails here ──

def _overlay_regex(const: str) -> re.Pattern:
    source = OVERLAY.read_text(encoding="utf-8")
    match = re.search(rf"const {const} =\s*\n?\s*/(.+)/\s*$", source, re.M)
    assert match, f"{const} not found in {OVERLAY.name}"
    return re.compile(match.group(1))


def _overlay_parts(lines: list[str], progress: re.Pattern, unpack: re.Pattern) -> dict[str, int]:
    """install-packages.ts reducePackageLine's part counting, line for line: a progress line whose total is not the
    row's current one starts a part; "unpacking" and "repairing" clear the row's total, "verifying" keeps it."""
    clears = (unpack, _overlay_regex("REPAIR_LINE"))
    current: dict[str, str | None] = {}
    parts: Counter = Counter()
    for line in lines:
        if m := progress.match(line):
            name, total = m.group(1), m.group(4)
            if current.get(name) != total:
                parts[name] += 1
            current[name] = total
            continue
        for clear in clears:
            if m := clear.match(line):
                current[m.group(1)] = None
    return dict(parts)


# ── tests ──

def test_concurrency_one_reproduces_the_serial_order_and_result(world, monkeypatch, capsys):
    for index, name in enumerate(("alpha", "beta", "gamma")):
        world.add(name, bytes([index]) * 40_000)
    monkeypatch.setattr(pm.install, "PREFETCH_CONCURRENCY", 1)
    failed, lines = _install(["alpha", "beta", "gamma"], capsys)
    assert failed == 0
    assert CountingHandler.order == ["/alpha.zip", "/beta.zip", "/gamma.zip"]
    assert [l for l in lines if l.startswith("✓")] == ["✓ alpha", "✓ beta", "✓ gamma"]
    facts = world.facts()
    digests = {n: facts.get(n)["digest"] for n in ("alpha", "beta", "gamma")}
    assert all(tree_digest(world.store.entry(facts.get(n)["entry"])) == d for n, d in digests.items())
    assert world.fetched() == []  # every archive released after its publication, as before

    # The same pins installed without any prefetch publish the same bytes.
    for n in ("alpha", "beta", "gamma"):
        pm.install._remove_entry(world.store, facts.get(n)["entry"], attempts=1)
    (world.store.root / "facts.json").unlink()
    _no_prefetch(monkeypatch)
    failed, _ = _install(["alpha", "beta", "gamma"], capsys)
    assert failed == 0
    assert {n: world.facts().get(n)["digest"] for n in digests} == digests


def test_a_wrong_hash_is_refused_nothing_publishes_and_the_others_install(world, monkeypatch, capsys):
    world.add("alpha", b"a" * 30_000)
    world.add("broken", b"b" * 30_000, sha="0" * 64)
    world.add("gamma", b"g" * 30_000)
    failed, lines = _install(["alpha", "broken", "gamma"], capsys)
    assert failed == 1
    assert "✓ alpha" in lines and "✓ gamma" in lines
    errors = [l for l in lines if l.startswith("✗")]
    assert len(errors) == 1 and "broken" in errors[0]
    facts = world.facts()
    assert facts.get("broken") is None
    assert not list(world.store.root.glob("broken-*")) and not list(world.store.root.glob("*" + "0" * 64))
    assert world.fetched() == []

    # The serial path's diagnosis is unchanged: the same error line without prefetch.
    _no_prefetch(monkeypatch)
    for n in ("alpha", "gamma"):
        pm.install._remove_entry(world.store, facts.get(n)["entry"], attempts=1)
    (world.store.root / "facts.json").unlink()
    _, serial_lines = _install(["alpha", "broken", "gamma"], capsys)
    assert [l for l in serial_lines if l.startswith("✗")] == errors


def test_pause_during_prefetch_resumes_without_downloading_completed_archives(world, monkeypatch, capsys):
    world.add("small", b"s" * 20_000)
    big = world.add("big", bytes(range(256)) * (16 * 1024))  # 4 MiB raw, ~4 ranged pieces
    RangeHandler.chunk = 64 * 1024
    RangeHandler.slow_per_chunk = 0.2  # ≥ 3 s per ranged piece: the pause lands mid-transfer
    pause = threading.Event()
    progressed = threading.Event()

    def progress_for(owner):
        def report(stage, done, total, label):
            if owner == "big" and done > 0:
                progressed.set()
        return report

    with _install_operation() as operation:
        prefetch = Prefetch.start(["small", "big"], progress_for=progress_for, pause_event=pause,
                                  _operation=operation)
        with prefetch:
            assert prefetch.wait("small") is True
            # Mid-transfer by the server's own count (the client's first tick can come only when a piece ends).
            deadline = time.monotonic() + 10
            while CountingHandler.gets["/big.zip"] < 2 and time.monotonic() < deadline:
                time.sleep(0.05)
            time.sleep(0.4)
            assert not progressed.is_set() or CountingHandler.gets["/big.zip"] >= 2
            pause.set()
            with pytest.raises(DownloadPaused):
                prefetch.wait("big")
    small_sha = hashlib.sha256(world.payloads["small"]).hexdigest()
    assert world.fetched() == [f"fetch-{small_sha}"]
    small_gets = CountingHandler.gets["/small.zip"]
    RangeHandler.slow_per_chunk = 0.0
    RangeHandler.ranges_seen = []

    failed, lines = _install(["small", "big"], capsys)
    assert failed == 0 and "✓ small" in lines and "✓ big" in lines
    assert CountingHandler.gets["/small.zip"] == small_gets  # the cached archive was not fetched again
    # Partial bytes of the paused archive belong to the downloader's own resume
    # (tests/pm/test_install_download_control.py); here: it completes, verified.
    assert world.facts().get("big")["artifacts"] == [big["sha256"]]


def test_an_already_current_package_downloads_nothing(world, capsys):
    world.add("alpha", b"a" * 10_000)
    assert _install(["alpha"], capsys)[0] == 0
    CountingHandler.gets.clear()
    failed, lines = _install(["alpha"], capsys)
    # A present package: its turn is one named step (the re-hash) and its ✓, no download line.
    assert failed == 0 and lines == ["  alpha: verifying", "✓ alpha"]
    assert sum(CountingHandler.gets.values()) == 0


def test_progress_lines_keep_the_overlay_format_and_part_count(world, capsys):
    world.add("gone", b"z" * 1_000)
    world.add("alpha", b"a" * 6_000_000)
    world.add("beta", b"b" * 5_000_000)
    world.add("broken", b"x" * 5_000_000, sha="1" * 64)
    world.add("gamma", b"g" * 7_000_000, deps=("alpha",))
    CountingHandler.refuse = {"/gone.zip"}  # 404 before its first byte (G-01 F1)
    CountingHandler.refuse_delay = 1.0  # others' archives are on screen by then
    failed, lines = _install(["gone", "alpha", "beta", "broken", "gamma"], capsys)
    assert failed == 2
    progress, unpack = _overlay_regex("PROGRESS_LINE"), _overlay_regex("UNPACK_LINE")
    verify, repair = _overlay_regex("VERIFY_LINE"), _overlay_regex("REPAIR_LINE")
    done, failed_line = _overlay_regex("DONE_LINE"), _overlay_regex("FAILED_LINE")
    previous = None
    for line in lines:  # no torn or unknown line; a failure's message may continue on its own lines, but a
        # continuation never reads as a package's line (G-01 R2-10: a torn progress line after a ✗ still fails)
        known = any(r.match(line) for r in (progress, unpack, verify, repair, done, failed_line))
        assert known or (previous == "failure" and not re.match(r"\s*[\w.+-]+:", line)), line
        previous = "failure" if failed_line.match(line) or (not known and previous == "failure") else "other"
    # One aggregate total per package: the overlay counts one part each, like a serial install.
    assert _overlay_parts(lines, progress, unpack) == {"alpha": 1, "beta": 1, "broken": 1, "gamma": 1}
    for name in ("alpha", "beta", "gamma"):
        mine = [i for i, l in enumerate(lines) if re.match(rf"\s*{name}:|✓ {name}$", l)]
        kinds = ["p" if progress.match(lines[i]) else "u" if unpack.match(lines[i]) else
                 "v" if verify.match(lines[i]) else "d" for i in mine]
        # G-01 r4: every step of the turn is a line naming the package: downloads (ahead), then verifying (what is
        # present, the cached archive), unpacking, verifying (the staged tree), ✓. No step is left to inference.
        assert kinds[-4:] == ["v", "u", "v", "d"] and set(kinds[:-4]) == {"p"}, (name, kinds)
    # Every failure line starts with its package's name: the overlay attributes it by that name, not to the
    # package that printed last (install-packages.test.ts, G-01 F1).
    errors = [l for l in lines if failed_line.match(l)]
    assert [e.split(":")[0] for e in errors] == ["✗ gone", "✗ broken"]
    # The case the name rule exists for: gone failed with no download line of its own while another package was
    # downloading beside it.
    at = lines.index(errors[0])
    assert not any((m := progress.match(l) or unpack.match(l)) and m.group(1) == "gone" for l in lines[:at])
    assert "  gone: verifying" in lines[:at]  # its turn opened by its own line; others' downloads ran on
    opened = [m.group(1) for l in lines[:at] if (m := progress.match(l) or unpack.match(l))]
    assert opened and opened[-1] != "gone"
    assert any(l == f"✓ {opened[-1]}" or l.startswith(f"✗ {opened[-1]}:") for l in lines[at + 1:])


def test_own_publications_are_not_rehashed_within_one_operation(world, monkeypatch, capsys):
    world.add("base", b"n" * 50_000)
    world.add("ext", b"e" * 10_000, deps=("base",))
    verified = []
    real = pm.install._entry_verified

    def spy(package, fact, store, target):
        verified.append(package.name)
        return real(package, fact, store, target)

    monkeypatch.setattr(pm.install, "_entry_verified", spy)
    assert _install(["base", "ext"], capsys)[0] == 0
    assert "base" not in verified  # published and digested by this operation, under its lock
    # A new operation trusts nothing: an explicit install re-hashes what is recorded.
    verified.clear()
    assert _install(["ext"], capsys)[0] == 0
    assert verified.count("base") == 1 and verified.count("ext") == 1


def test_downloads_overlap_up_to_the_bound(world, server, monkeypatch, capsys):
    """G-01 F2: the bound mechanism, raised to 4 here: red when owners never overlap or exceed the bound."""
    monkeypatch.setattr(pm.install, "PREFETCH_CONCURRENCY", 4)
    server.RequestHandlerClass = BarrierHandler
    names = [f"o{i}" for i in range(6)]
    for index, name in enumerate(names):
        world.add(name, bytes([index]) * 30_000)
    failed, lines = _install(names, capsys)
    assert failed == 0 and [l for l in lines if l.startswith("✓")] == [f"✓ {n}" for n in names]
    assert 2 <= BarrierHandler.peak <= 4


def test_by_default_the_next_download_overlaps_the_previous_unpack(world, monkeypatch, capsys):
    """G-01 r6: one owner at a time by default, yet package N+1 downloads while package N unpacks (the measured
    win). Red when the prefetch is disabled: N+1's first request then only comes from its own ensure, after N's ✓."""
    assert pm.install.PREFETCH_CONCURRENCY == 1
    names = [f"s{i}" for i in range(4)]
    for index, name in enumerate(names):
        world.add(name, bytes([index]) * 400_000)
    seen = _capture_prefetch(monkeypatch)
    real = pm.cli.ensure

    def ensure(name, **kwargs):
        result = real(name, **kwargs)
        # The ✓ follows this return. Give the next archive's request a bounded chance to arrive first, so the
        # assertion does not ride on how fast this unpack was; without a prefetch it never arrives in time.
        nxt = names.index(name) + 1
        deadline = time.monotonic() + 3.0
        while nxt < len(names) and time.monotonic() < deadline:
            with CountingHandler.lock:
                if ("get", f"/{names[nxt]}.zip") in CountingHandler.timeline:
                    break
            time.sleep(0.01)
        with CountingHandler.lock:
            CountingHandler.timeline.append(("done", name))
        return result

    monkeypatch.setattr(pm.cli, "ensure", ensure)
    failed, lines = _install(names, capsys)
    assert failed == 0 and [l for l in lines if l.startswith("✓")] == [f"✓ {n}" for n in names]
    assert len(seen) == 1 and len(seen[0]._threads) == 1  # the default bound: one owner at a time
    timeline = list(CountingHandler.timeline)
    for current, following in zip(names, names[1:]):
        assert timeline.index(("get", f"/{following}.zip")) < timeline.index(("done", current)), (current, timeline)


def test_a_transient_prefetch_failure_installs_through_the_serial_path(world, monkeypatch, capsys):
    """G-01 F3: the prefetch's failure is recorded, not raised; the serial path downloads again."""
    world.add("alpha", b"a" * 20_000)
    world.add("flaky", b"f" * 20_000)
    CountingHandler.refuse = {"/flaky.zip"}
    real = Prefetch._fetch

    def fetch(self, owner, owned):
        try:
            return real(self, owner, owned)
        finally:
            if owner == "flaky":
                CountingHandler.refuse.discard("/flaky.zip")  # the network recovers after the first attempt

    monkeypatch.setattr(Prefetch, "_fetch", fetch)
    seen = _capture_prefetch(monkeypatch)
    failed, lines = _install(["alpha", "flaky"], capsys)
    assert failed == 0 and lines[-1] == "✓ flaky" and not [l for l in lines if l.startswith("✗")]
    assert "flaky" in seen[0].failed and "alpha" not in seen[0].failed
    assert CountingHandler.gets["/flaky.zip"] >= 2
    assert world.facts().get("flaky")["artifacts"] == [hashlib.sha256(world.payloads["flaky"]).hexdigest()]


def test_an_owner_with_a_missing_dependency_counts_the_same_parts_as_serial(world, monkeypatch, capsys):
    """G-01 F4: the owner's two archives (dep + own) replayed after a prefetch must not read as new parts."""
    world.add("other", b"o" * 30_000)
    world.add("base", bytes(range(256)) * 6_000)  # 1.5 MiB and 0.6 MiB: distinct totals, two parts like serial
    world.add("ext", bytes(range(256)) * 2_400, deps=("base",))
    progress, unpack = _overlay_regex("PROGRESS_LINE"), _overlay_regex("UNPACK_LINE")
    failed, lines = _install(["other", "ext"], capsys)
    assert failed == 0
    prefetched = _overlay_parts(lines, progress, unpack)
    _reset(world)
    with monkeypatch.context() as m:
        _no_prefetch(m)
        failed, serial = _install(["other", "ext"], capsys)
    assert failed == 0
    assert prefetched == _overlay_parts(serial, progress, unpack) == {"other": 1, "ext": 2}


def test_planning_hashes_nothing_and_a_present_package_is_hashed_as_often_as_serial(world, monkeypatch, capsys):
    """G-01 C-04 + F5: the plan reads facts only; ensure's own verification is unchanged."""
    world.add("alpha", b"a" * 40_000)
    world.add("beta", b"b" * 40_000)
    real = pm.install._entry_verified

    def spy(package, fact, store, target):
        CountingHandler.timeline.append(("verify", package.name))
        return real(package, fact, store, target)

    monkeypatch.setattr(pm.install, "_entry_verified", spy)

    def run(prefetch: bool) -> list:
        _reset(world)
        assert _install(["alpha"], capsys)[0] == 0
        CountingHandler.timeline.clear()
        with monkeypatch.context() as m:
            if not prefetch:
                _no_prefetch(m)
            assert _install(["beta", "alpha"], capsys)[0] == 0
        return list(CountingHandler.timeline)

    serial, prefetched = run(False), run(True)
    assert prefetched.count(("verify", "alpha")) == serial.count(("verify", "alpha")) >= 1
    first_get = next(i for i, e in enumerate(prefetched) if e[0] == "get")
    assert first_get < prefetched.index(("verify", "alpha"))


def test_settle_waits_for_every_download_before_the_lock_is_released(world, monkeypatch, capsys):
    """G-01 F7: a StatePackage ensure closes the operation; no prefetch may still run then."""
    world.add("alpha", b"a" * 10_000)
    world.add("beta", bytes(range(256)) * 4096)  # 1 MiB, paced below
    RangeHandler.chunk = 64 * 1024
    RangeHandler.slow_per_chunk = 0.1

    class VenvStub(StatePackage):
        name = "venvstub"
        deps = ()

    monkeypatch.setitem(registry._packages, "venvstub", VenvStub())
    seen = _capture_prefetch(monkeypatch)
    settled: list[bool] = []
    monkeypatch.setattr(pm.install, "sync_venv",
                        lambda **_: settled.append(all(f.done() for f in seen[0]._futures.values())))
    failed, lines = _install(["alpha", "venvstub", "beta"], capsys)
    assert failed == 0 and settled == [True]
    assert [l for l in lines if l.startswith("✓")] == ["✓ alpha", "✓ venvstub", "✓ beta"]


@pytest.mark.parametrize("gone", ["entry", "file"])
def test_archives_gone_after_the_prefetch_download_again_with_their_progress(world, monkeypatch, capsys, gone):
    """G-01 C-07 + R2-5: wait() is True only while each archive is in the cache as fetch_many reads it (one
    regular file per entry), so the serial download is never silent: the entry removed, or emptied."""
    world.add("alpha", b"a" * 20_000)
    sha = hashlib.sha256(world.payloads["alpha"]).hexdigest()
    progress, unpack = _overlay_regex("PROGRESS_LINE"), _overlay_regex("UNPACK_LINE")
    _, normal = _install(["alpha"], capsys)
    _reset(world)
    real = Prefetch._fetch

    def fetch(self, owner, owned):
        real(self, owner, owned)
        entry = world.store.root / f"fetch-{sha}"
        if gone == "entry":
            shutil.rmtree(entry)  # e.g. `pm gc` in a lock gap
        else:
            for file in entry.iterdir():  # a half-cleaned entry: the directory stays, its archive does not
                file.unlink()

    monkeypatch.setattr(Prefetch, "_fetch", fetch)
    failed, lines = _install(["alpha"], capsys)
    assert failed == 0 and lines[-1] == "✓ alpha"
    # The prefetch's download lines, then the serial download's own (dropped when wait() trusts a stale cache).
    assert len([l for l in lines if progress.match(l)]) == 2 * len([l for l in normal if progress.match(l)]) > 0
    assert CountingHandler.gets["/alpha.zip"] >= 2
    assert _overlay_parts(lines, progress, unpack) == {"alpha": 1}


_DRIVER = """
import hashlib, signal, sys
from pathlib import Path

signal.signal(signal.SIGINT, signal.default_int_handler)  # even when started with SIGINT ignored
signal.signal(signal.SIGTERM, signal.SIG_DFL)
root, lock_path, url = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
import pm.artifact_mirror
import pm.cli

pm.artifact_mirror.PUBLIC_PREFIX = url.rsplit("/", 1)[0] + "/mirror/"  # hermetic: never the public mirror
from pm import paths, registry
from pm.lock import Lockfile
from pm.package import Package

paths.store_root = lambda: root
paths.lockfile_path = lambda: lock_path
registry._packages["stall"] = type("P_stall", (Package,), {"name": "stall", "deps": ()})()
lock = Lockfile(lock_path)
lock.set_pin("stall", "1", {"any": [{"url": url, "sha256": "0" * 64}]})
lock.save()
print("start", flush=True)
sys.exit(pm.cli._install_names(["stall"]))
"""


@pytest.mark.parametrize("sig, code", [(signal.SIGINT, 130), (signal.SIGTERM, -signal.SIGTERM)])
def test_an_interrupt_never_waits_out_a_stalled_download(server, tmp_path, sig, code):
    """G-01 C-03/C-05: the main thread blocks in wait() without polling, and Ctrl-C / SIGTERM end the process
    while a prefetch worker sits in a socket read the server never answers (the read timeout is 60-120 s)."""
    server.RequestHandlerClass = StallHandler
    RangeHandler.payloads["/stall.zip"] = bytes(32 << 20)  # large enough for ranged pieces
    repo = Path(__file__).resolve().parents[2]
    env = {**os.environ, "HERMES_HOME": str(tmp_path / "home"), "PYTHONPATH": str(repo)}
    proc = subprocess.Popen(
        [sys.executable, "-c", _DRIVER, str(tmp_path / "store"), str(tmp_path / "lock.json"), url(server, "/stall.zip")],
        cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        assert StallHandler.arrived.wait(30), proc.stderr.read() if proc.poll() is not None else "no request"
        time.sleep(0.3)  # the main thread is now blocked in Prefetch.wait
        sent = time.monotonic()
        proc.send_signal(sig)
        out, err = proc.communicate(timeout=10)
        elapsed = time.monotonic() - sent
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.communicate()
    assert proc.returncode == code, err[-2000:]
    assert elapsed < pm.install.PREFETCH_STOP_GRACE + 3
    if sig == signal.SIGINT:
        assert "stopped; unfinished downloads resume on the next install" in out


def test_on_a_terminal_only_the_package_being_installed_redraws(world, monkeypatch, capsys):
    """G-01 C-06: downloads overlap, but the one terminal row belongs to the package the loop installs."""
    prefix = "\r\x1b[2K"

    class Terminal:
        rows: list = []

        def write(self, text):
            if text.startswith(prefix) and text[len(prefix):].strip():
                self.rows.append(text[len(prefix):].strip().split(":")[0])

        def flush(self):
            pass

    terminal = Terminal()
    monkeypatch.setattr(pm.cli, "_progress_stream", lambda: terminal)
    world.add("alpha", bytes(range(256)) * 16384)  # 4 MiB, paced below; beta is done long before
    world.add("beta", b"b" * 20_000)
    RangeHandler.chunk = 64 * 1024
    RangeHandler.slow_per_chunk = 0.05
    failed, lines = _install(["alpha", "beta"], capsys)
    assert failed == 0 and lines == ["✓ alpha", "✓ beta"]
    assert "alpha" in terminal.rows and "beta" in terminal.rows
    assert "alpha" not in terminal.rows[terminal.rows.index("beta"):]  # rows follow the install order


def test_on_a_terminal_downloads_draw_while_the_loop_waits_for_them(world, monkeypatch, capsys):
    """G-01 R2-7: while settle() waits for every download (before a StatePackage), the row is not silent."""
    prefix = "\r\x1b[2K"
    rows: list[str] = []

    class Terminal:
        def write(self, text):
            if text.startswith(prefix) and text[len(prefix):].strip():
                rows.append(text[len(prefix):].strip())

        def flush(self):
            pass

    class VenvStub(StatePackage):
        name = "venvstub"
        deps = ()

    monkeypatch.setitem(registry._packages, "venvstub", VenvStub())
    monkeypatch.setattr(pm.install, "sync_venv", lambda **_: None)
    monkeypatch.setattr(pm.cli, "_progress_stream", lambda: Terminal())
    world.add("alpha", b"a" * 10_000)
    world.add("beta", bytes(range(256)) * 4096)  # 1 MiB, paced: still downloading when the loop settles
    RangeHandler.chunk = 64 * 1024
    RangeHandler.slow_per_chunk = 0.1
    failed, lines = _install(["alpha", "venvstub", "beta"], capsys)
    assert failed == 0 and lines == ["✓ alpha", "✓ venvstub", "✓ beta"]
    assert any(re.match(r"beta:\s+\d", row) for row in rows), rows


def test_a_repair_download_of_a_present_dependency_keeps_its_progress(world, monkeypatch, capsys):
    """G-01 R2-6: the owner is prefetched, its present dependency's bytes moved; ensure repairs the dependency
    and that download shows as a part, as without a prefetch (only the prefetched archives' replay is dropped)."""
    world.add("other", b"o" * 30_000)
    world.add("base", bytes(range(256)) * 6_000)
    world.add("ext", bytes(range(256)) * 2_400, deps=("base",))
    progress, unpack = _overlay_regex("PROGRESS_LINE"), _overlay_regex("UNPACK_LINE")
    def run(prefetch: bool) -> dict:
        _reset(world)
        assert _install(["base"], capsys)[0] == 0
        # base's recorded bytes moved (its facts still say present); its archive is not cached any more.
        entry = world.store.entry(world.facts().get("base")["entry"])
        victim = next(path for path in sorted(entry.rglob("*")) if path.is_file())
        victim.chmod(0o644)
        victim.write_bytes(victim.read_bytes() + b"moved")
        gets = CountingHandler.gets["/base.zip"]
        with monkeypatch.context() as m:
            if not prefetch:
                _no_prefetch(m)
            failed, lines = _install(["other", "ext"], capsys)
        assert failed == 0 and CountingHandler.gets["/base.zip"] > gets  # repaired by a download
        # G-01 R3-4: in the prefetched run the repair is its own event naming the row, then its progress lines.
        assert ("  ext: repairing" in lines) == prefetch
        return _overlay_parts(lines, progress, unpack)

    serial, prefetched = run(False), run(True)
    assert prefetched == serial and serial["ext"] == 2


def _blocked_prefetch(monkeypatch) -> tuple[Prefetch, threading.Event]:
    """A Prefetch whose one owner never finishes on its own (a download blocked in a socket read)."""
    release = threading.Event()
    monkeypatch.setattr(Prefetch, "_fetch", lambda self, owner, owned: release.wait(10))
    return Prefetch({"stuck": [[]]}, None), release


def test_wait_delivers_an_interrupt_within_its_slice(monkeypatch):
    """G-01 R2-2: interrupt_main() trips the interrupt without an OS signal, like Ctrl-C on Windows, where an
    untimed lock acquire is never woken (bpo-29971); the bounded wait delivers it within one slice."""
    prefetch, release = _blocked_prefetch(monkeypatch)
    timer = threading.Timer(0.2, _thread.interrupt_main)
    started = time.monotonic()
    timer.start()
    try:
        with pytest.raises(KeyboardInterrupt):
            prefetch.wait("stuck")
        elapsed = time.monotonic() - started
    finally:
        timer.cancel()
        release.set()
        prefetch.close()
    assert elapsed < 0.2 + pm.install.PREFETCH_WAIT_SLICE + 0.5


def test_a_second_interrupt_during_the_join_keeps_the_exit_that_never_waits(monkeypatch):
    """G-01 R2-3: Ctrl-C, then Ctrl-C again while __exit__ joins the workers: stalled stays True, so the CLI
    still exits without the interpreter's join of a worker blocked in a socket read."""
    monkeypatch.setattr(pm.install, "PREFETCH_STOP_GRACE", 1.0)
    prefetch, release = _blocked_prefetch(monkeypatch)
    timer = threading.Timer(0.3, _thread.interrupt_main)
    try:
        with pytest.raises(KeyboardInterrupt):
            with prefetch:
                timer.start()
                raise KeyboardInterrupt  # the first Ctrl-C; the second lands inside the bounded join
        stalled = prefetch.stalled
    finally:
        timer.cancel()
        release.set()
        prefetch.close()
    assert stalled is True


@pytest.mark.parametrize("leave", ["normally", "on an error"])
def test_the_install_lock_is_released_only_after_every_worker_has_ended(tmp_path, monkeypatch, leave):
    """G-01 critic m2 (M8): leaving the Prefetch, normally or on an error, joins its workers before the operation
    releases the install lock, so no archive lands in the store after its lock is released."""
    monkeypatch.setattr(paths, "writable_store_root", lambda: tmp_path / "store")
    started = threading.Event()

    def fetch(self, owner, owned):  # a download that stops between chunks; its last chunk lands after the stop
        started.set()
        deadline = time.monotonic() + 10
        while not self._stop.is_set() and time.monotonic() < deadline:
            time.sleep(0.01)
        time.sleep(0.05)

    monkeypatch.setattr(Prefetch, "_fetch", fetch)
    workers: list[threading.Thread] = []
    events: list[str] = []
    real_lock, real_close = Store.install_lock, Prefetch.close

    @contextmanager
    def install_lock(self):
        with real_lock(self):
            events.append("acquired")
            yield
            events.append("released with a live worker" if any(t.is_alive() for t in workers) else "released")

    def close(self, **kwargs):
        ended = real_close(self, **kwargs)
        events.append("joined" if ended else "close returned with a live worker")
        return ended

    monkeypatch.setattr(Store, "install_lock", install_lock)
    monkeypatch.setattr(Prefetch, "close", close)
    with pytest.raises(OSError) if leave == "on an error" else nullcontext():
        with _install_operation() as operation:
            with Prefetch({"a": [[]], "b": [[]]}, operation.lock(), concurrency=2) as prefetch:
                workers.extend(prefetch._threads)
                assert started.wait(5)
                if leave == "on an error":
                    raise OSError("ensure failed")  # not an InstallError: it leaves the install loop
    assert len(workers) == 2
    assert events == ["acquired", "joined", "released"]


def test_an_interrupt_prints_one_line_and_every_command_exits_130(world, monkeypatch, capsys):
    """G-01 R2-4: one status (130) and one line for Ctrl-C on every path, no traceback; the stalled-worker path
    exits 130 too (the subprocess test). SIGTERM keeps its default handler (-15)."""
    import pm.runtime

    world.add("alpha", b"a" * 10_000)

    def interrupted(*_args, **_kwargs):
        raise KeyboardInterrupt

    monkeypatch.setattr(pm.cli, "ensure", interrupted)
    with pytest.raises(KeyboardInterrupt) as raised:
        pm.cli._install_names(["alpha"])
    assert isinstance(raised.value, pm.cli._Stopped)
    assert capsys.readouterr().out.splitlines().count(pm.cli._STOP_LINE) == 1
    monkeypatch.setattr(pm.runtime, "is_runtime", lambda: False)
    # Outside the runtime the child printed the line (G-01 R3-5): the parent adds none, whatever reached it.
    for error, said in ((raised.value, ""), (KeyboardInterrupt(), "")):
        def run_cli(_argv, error=error):
            raise error

        monkeypatch.setattr(pm.runtime, "run_cli", run_cli)
        assert pm.cli.main(["gc"]) == 130
        assert capsys.readouterr().err.strip() == said


def test_a_dependency_failure_names_the_package_being_installed():
    """G-01 R2-12 / lead: every ✗ starts with the package the loop was installing, so the overlay attributes it
    by that exact name; an error that already starts with it is printed unchanged."""
    dependency, own, prefixed = (pm.install.InstallError(*args) for args in
                                 (("libatomic", "unavailable"), ("ext", "404"), ("node-gyp", "404")))
    assert pm.cli._failure_line("ext", dependency) == f"ext: {dependency}"
    assert pm.cli._failure_line("ext", own) == str(own)
    assert pm.cli._failure_line("node", prefixed) == f"node: {prefixed}"


@pytest.mark.parametrize("prefetch", [True, False])
def test_a_failing_dependency_is_reported_under_the_package_being_installed(world, monkeypatch, capsys, prefetch):
    """G-01 R3-2, end to end through _install_names: ext needs base and base's archive fails its hash. The ✗ PM
    prints names ext, the row the overlay fails (its own FAILED_LINE + FAILED_NAME), and keeps base's cause."""
    world.add("base", b"b" * 50_000, sha="2" * 64)
    world.add("ext", b"e" * 50_000, deps=("base",))
    if not prefetch:
        _no_prefetch(monkeypatch)
    failed, lines = _install(["ext"], capsys)
    failed_line, failed_name = _overlay_regex("FAILED_LINE"), _overlay_regex("FAILED_NAME")
    errors = [m.group(1) for line in lines if (m := failed_line.match(line))]
    assert failed == 1 and [failed_name.match(text).group(1) for text in errors] == ["ext"], lines
    assert errors[0].startswith("ext: base: "), errors


def test_a_cached_archive_that_fails_its_hash_is_a_named_repair_with_its_progress(world, monkeypatch, capsys):
    """G-01 R3-4: the prefetched archive is corrupted in the cache (same size) before the serial pass. ensure
    re-downloads it; that download is announced by name and keeps its progress lines (never dropped by matching
    the prefetched size); the replay of an intact cache moves no byte and stays silent."""
    world.add("alpha", bytes(range(256)) * 40_000)  # ~10 MB: several ticks
    sha = hashlib.sha256(world.payloads["alpha"]).hexdigest()
    progress, unpack = _overlay_regex("PROGRESS_LINE"), _overlay_regex("UNPACK_LINE")
    real = Prefetch._fetch

    def fetch(self, owner, owned):
        real(self, owner, owned)
        (archive,) = (world.store.root / f"fetch-{sha}").iterdir()
        archive.chmod(0o644)
        body = bytearray(archive.read_bytes())
        body[100] ^= 0xFF
        archive.write_bytes(bytes(body))

    with monkeypatch.context() as m:
        m.setattr(Prefetch, "_fetch", fetch)
        failed, lines = _install(["alpha"], capsys)
    assert failed == 0 and lines[-1] == "✓ alpha"
    at = lines.index("  alpha: repairing")
    assert lines[at - 1] == "  alpha: verifying"
    after = lines[at + 1:lines.index("  alpha: unpacking")]
    assert after and all(progress.match(line) for line in after)
    assert any(float(progress.match(line).group(2)) < 100 for line in after)
    _reset(world)
    failed, intact = _install(["alpha"], capsys)  # an intact cache: no repair, no second download line
    assert failed == 0 and "  alpha: repairing" not in intact
    turn = intact[intact.index("  alpha: verifying"):]
    assert not any(progress.match(line) for line in turn)
    assert _overlay_parts(intact, progress, unpack) == {"alpha": 1}


_PARENT = """
import signal, subprocess, sys

signal.signal(signal.SIGINT, signal.default_int_handler)
import pm.cli, pm.runtime

pm.runtime.is_runtime = lambda: False
# run_cli's own shape (pm/runtime.py): wait for the runtime child, return its status.
pm.runtime.run_cli = lambda argv: subprocess.run([sys.executable, "-c", sys.argv[1], *argv]).returncode
sys.exit(pm.cli.main(["gc"]))
"""

_CHILD = """
import os, signal, sys, time

signal.signal(signal.SIGINT, signal.default_int_handler)
import pm.cli, pm.runtime

pm.runtime.is_runtime = lambda: True


def gc(_args):
    os.killpg(os.getpgrp(), signal.SIGINT)  # Ctrl-C at a terminal reaches the whole foreground group
    time.sleep(10)
    return 0


pm.cli.cmd_gc = gc
sys.exit(pm.cli.main(sys.argv[1:]))
"""


@pytest.mark.skipif(not hasattr(os, "killpg"), reason="a process-group Ctrl-C is POSIX")
def test_ctrl_c_on_the_wrapper_path_prints_one_line_and_exits_130(tmp_path):
    """G-01 R3-5: `hermes pm …` outside the runtime runs the runtime child; one Ctrl-C reaches both. The child
    prints the line and exits 130; the parent returns 130 and prints nothing."""
    repo = Path(__file__).resolve().parents[2]
    env = {**os.environ, "HERMES_HOME": str(tmp_path / "home"), "PYTHONPATH": str(repo)}
    done = subprocess.run([sys.executable, "-c", _PARENT, _CHILD], cwd=repo, env=env, capture_output=True,
                          text=True, timeout=60, start_new_session=True)
    assert done.returncode == 130, done.stderr[-2000:]
    assert (done.stdout + done.stderr).count("stopped") == 1, (done.stdout, done.stderr)
    assert "Traceback" not in done.stderr
