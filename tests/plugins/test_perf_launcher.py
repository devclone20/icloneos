"""CF8 PERF.launcher: the gate that would have caught v0.0.7 (every confined command refused in a 522 597-folder project).

A real Python launcher, started by main's real confinement layer with fd 3, asks main's real hard-link guard
(electron/iclone-confinement/launcher-live-harness.ts through apps/desktop/scripts/perf-v007/launcher-perf-driver.ts)
on a fixture in the owner's shape (scripts/perf-v007/make-fixture.mjs --scale: 7.45 files per folder, his share of
hard-linked names). Items (targets from CF8_DESIGN.md "Gates to add"):

  PERF.launcher.first.not_refused      the first command in a cold project runs (waits, never refused)
  PERF.launcher.first.progress_gap_s   the longest silence on fd 3 during that first check <= 2 s
  PERF.launcher.first.s                the first check finishes inside FIRST_SCAN_CAP_S
  PERF.launcher.channel.used           every later command asked main on fd 3, before and after (no fallback walk)
  PERF.launcher.steady.ok              every later command ran
  PERF.launcher.steady.p95_ms          before-check round trip, nothing dirty: p95 <= 50 ms
  PERF.launcher.steady.dirty_p95_ms    before-check round trip, 10 folders written before each: p95 <= 150 ms
  PERF.launcher.steady.scandir         directory listings inside the project by the launcher process after the first: 0
  PERF.launcher.after.p95_ms           after-check round trip: p95 <= 50 ms
  PERF.launcher.sleep.ok / .ms         past a simulated 61 min sleep the next command runs, end to end <= 2 s
  PERF.launcher.stale.ok               FX-STALE (B1-M1): past the age bound in AWAKE time the next command runs, main ok
  PERF.launcher.stale.progress_gap_s   the longest stretch of that check with no fd-3 frame reporting the walk advancing
                                       (a progress frame whose folder count grew) <= 2 s: the re-walk is a first scan
  PERF.launcher.stale.s                that check finishes inside FIRST_SCAN_CAP_S (the first-scan cap, not the 30 s)
  PERF.launcher.linear.first           first check at 1/8 over first check at 1/16 <= 3.0 (twice the tree: ~2 if linear)
  PERF.launcher.linear.steady          steady p95 at 1/8 <= max(1.5 x, +10 ms) the one at 1/16 (flat in tree size)

Runs only when asked:
  ICLONE_PERF=selftest  the fixture, the listing shim and the judging code against synthetic data (seconds)
  ICLONE_PERF=1         the self-test and the gate at 1/16 and 1/8 (the CI proxy; ~40 s of fixture build)
  ICLONE_PERF_SCALE=full with ICLONE_PERF=1 also runs the owner's full size (522 597 folders / 3 895 210 files,
                        ~16 GB under /private/tmp, ~3.5 min to build), opt-in before a release
  ICLONE_PERF_FIXTURE_1OF16 / _1OF8 / _FULL  reuse a fixture make-fixture.mjs built at that scale (kept afterwards)
  ICLONE_PERF_NODE      the Node that runs the driver (default: the pinned 26.8.1 that run-gates.sh uses)
Machine lines: `RESULT_JSON {"pass":..,"items":[{"id","value","target","pass"}]}` and `SUMMARY n/m PASS (<gate>)`.
"""
import json
import math
import os
import pwd
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
from pathlib import Path

import pytest

MODE = os.environ.get("ICLONE_PERF", "")
pytestmark = pytest.mark.skipif(MODE not in {"1", "selftest"}, reason="PERF.launcher runs only with ICLONE_PERF=1 (or =selftest)")
GATE_ON = MODE == "1"

REPO = Path(__file__).resolve().parents[2]
DESKTOP = REPO / "apps" / "desktop"
PERF_DIR = DESKTOP / "scripts" / "perf-v007"
MAKE_FIXTURE = PERF_DIR / "make-fixture.mjs"
DRIVER = PERF_DIR / "launcher-perf-driver.ts"
SHIM = PERF_DIR / "launcher-shim.py"
TSX = REPO / "node_modules" / "tsx" / "dist" / "cli.mjs"

OWNER_DIRS = 522_597
OWNER_FILES = 3_895_210
OWNER_LINKED_NAMES = 5_152
SCALES = {"1/16": 16, "1/8": 8, "full": 1}
FIXTURE_ENV = {"1/16": "ICLONE_PERF_FIXTURE_1OF16", "1/8": "ICLONE_PERF_FIXTURE_1OF8", "full": "ICLONE_PERF_FIXTURE_FULL"}

FIRST_SCAN_CAP_S = 180.0
PROGRESS_GAP_S = 2.0
STEADY_P95_MS = 50.0
DIRTY_P95_MS = 150.0
AFTER_P95_MS = 50.0
# CF8_DESIGN: <= 50 ms per command steady, <= 150 ms with 10 dirty folders. End to end that is the cost the project's size
# adds over the same pipeline in a one-folder project (the stub, launcher and Seatbelt spawn are paid by both).
STEADY_E2E_OVERHEAD_MS = 50.0
DIRTY_E2E_OVERHEAD_MS = 150.0
SLEEP_MS = 2_000.0
SIMULATED_SLEEP_MS = 61 * 60_000
# FX-STALE (B1-M1): time passing AWAKE past every root's age bound (refreshCadence caps it at 30 min), so the next
# command waits on a re-walk of the whole tree (hardlinks.ts refreshed()). One second past the ceiling.
SIMULATED_AWAKE_MS = 30 * 60_000 + 1_000
OWNER_REPLY_TIMEOUT_S = 60.0
SHAPES = ("window", "own")
LINEAR_FIRST_RATIO = 3.0
LINEAR_FIRST_FLOOR_MS = 250.0
LINEAR_STEADY_RATIO = 1.5
LINEAR_STEADY_SLACK_MS = 10.0
# The end-to-end overhead is a difference of two p95s of ~100 ms process round trips: more jitter than main's own timer.
LINEAR_E2E_SLACK_MS = 25.0
STEADY_COMMANDS = 40
DIRTY_COMMANDS = 20
DIRTY_FOLDERS = 10


# ---- judging (pure: raw driver data in, items out) ------------------------------------------------------------------


def p95(values):
    """Nearest-rank 95th percentile; None for no samples (an empty measure never passes)."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(0.95 * len(ordered)) - 1)]


def item(item_id, value, target, passed):
    return {"id": item_id, "value": value, "target": target, "pass": bool(passed)}


def below(item_id, value, limit, unit):
    return item(item_id, None if value is None else round(value, 2), f"<= {limit:g} {unit}", value is not None and value <= limit)


def round_trips(frames):
    """Per check request on fd 3: its root, phase, request time and verdict time (None when main never answered), the
    times of every frame carrying its id (for the silence measure), and the verdict."""
    checks = {}
    for frame in frames:
        body, t = frame.get("frame") or {}, frame.get("t")
        rid = body.get("id")
        if not isinstance(rid, str) or not isinstance(t, (int, float)):
            continue
        if body.get("op") == "check":
            checks[rid] = {"root": body.get("root"), "phase": body.get("phase"), "t_req": t, "t_verdict": None, "times": [t], "verdict": None}
            continue
        check = checks.get(rid)
        if check is None:
            continue
        check["times"].append(t)
        progress = body.get("progress")
        if isinstance(progress, dict) and isinstance(progress.get("dirs"), int):
            check.setdefault("progress", []).append((t, progress["dirs"]))
        if "ok" in body and check["t_verdict"] is None:
            check["t_verdict"], check["verdict"] = t, body
    return list(checks.values())


def advancing_gap_ms(check):
    """FX-STALE: the longest stretch of one answered check, from its request to its verdict, with no progress frame that
    reports the walk advancing (its folder count above every one before). A frame repeating a count (main's ticker with
    no first scan behind it: B1-M1) is silence, as the stub's "Checking the project folder... N folders" does not move."""
    marks, best = [check["t_req"]], 0
    for t, dirs in check.get("progress", []):
        if dirs > best:
            best = dirs
            marks.append(t)
    marks.append(check["t_verdict"])
    return max(b - a for a, b in zip(marks, marks[1:]))


def identity(path):
    """Main folds a root's spelling (NFC, case) for its identity (D4); the gate compares the same way."""
    return unicodedata.normalize("NFC", path).casefold().rstrip("/") if isinstance(path, str) else None


def inside(target, project):
    """A listing inside the project. An fd or a relative path the process could not resolve counts as inside."""
    if target in ("<fd>", "<rel>"):
        return True
    root, spelled = identity(project), identity(target)
    return spelled is not None and (spelled == root or spelled.startswith(root + "/"))


def e2e_ms(rows):
    return [(row["t1"] - row["t0"]) * 1000.0 for row in rows]


def overhead(rows, base_rows):
    """End-to-end p95 of the fixture's commands over the p95 of the same pipeline in a one-folder project, both as the
    runtime timed them (stub, launcher, main, the command). None without samples on either side or a failed base."""
    measured, base = p95(e2e_ms(rows)), p95(e2e_ms(base_rows))
    if measured is None or base is None or not all(row["ok"] for row in base_rows):
        return None
    return measured - base


def evaluate(raw, base_rows=None):
    """The PERF.launcher items for one world (DRIVER_JSON worlds[shape]). `base_rows`: the no-check baseline (the
    window world's own `base` rows; default: this world's). Every item needs its evidence: with no fd-3 check for the
    fixture, no command or no record, every item fails."""
    rows, project = raw.get("rows") or [], raw["project"]
    fixture_rows = [row for row in rows if row.get("cwd", "fixture") == "fixture"]
    if base_rows is None:
        base_rows = [row for row in rows if row.get("cwd") == "base"]
    complete = bool(rows) and len(rows) == raw.get("plannedRows")
    checks = [c for c in round_trips(raw.get("frames") or []) if inside(c["root"], project) and c["root"] not in ("<fd>", "<rel>")]
    by_phase = {phase: [row for row in fixture_rows if row["phase"] == phase] for phase in ("first", "steady", "dirty", "sleep", "stale", "planted")}
    base_by_phase = {phase: [row for row in base_rows if row["phase"] == phase] for phase in ("steady", "dirty")}

    def checks_in(row, phase):
        t0, t1 = row["t0"] * 1000.0, row["t1"] * 1000.0
        return [c for c in checks if c["phase"] == phase and t0 <= c["t_req"] <= t1]

    def verdict_in(row, phase):
        """The verdict of the first answered `phase` check inside the row: True / False, None when there is none."""
        answered = [c for c in checks_in(row, phase) if c["verdict"] is not None]
        return None if not answered else answered[0]["verdict"].get("ok") is True

    def ms_of(rows_, phase):
        out = []
        for row in rows_:
            out += [c["t_verdict"] - c["t_req"] for c in checks_in(row, phase) if c["t_verdict"] is not None]
        return out

    items = []
    first = by_phase["first"][0] if by_phase["first"] else None
    first_checks = checks_in(first, "before") if first else []
    unanswered = any(c["t_verdict"] is None for c in first_checks)
    asked_first = bool(first_checks) and not unanswered
    items.append(item("PERF.launcher.precondition", f"rows {len(rows)}/{raw.get('plannedRows')}, first fd-3 checks {len(first_checks)}",
                      "every planned command ran and the first one asked main for the project on fd 3", complete and asked_first))
    gaps = [b - a for c in first_checks for a, b in zip(c["times"], c["times"][1:])]
    first_s = None if not asked_first else max(c["t_verdict"] - c["t_req"] for c in first_checks) / 1000.0
    items.append(item("PERF.launcher.first.not_refused", (first or {}).get("ok"), "the first command runs, main said ok on fd 3",
                      bool(first and first["ok"]) and verdict_in(first, "before") is True))
    items.append(below("PERF.launcher.first.progress_gap_s", None if not asked_first else max(gaps, default=0.0) / 1000.0, PROGRESS_GAP_S, "s"))
    stub = [entry for entry in raw.get("stub") or [] if first and first["t0"] <= entry.get("t", -1) <= first["t1"]]
    stub_times = [entry["t"] for entry in stub]
    stub_gap = None
    if asked_first and stub and stub[0].get("kind") == "start" and any(entry.get("kind") == "reply" for entry in stub):
        stub_gap = max((b - a for a, b in zip(stub_times, stub_times[1:])), default=0.0)
    items.append(below("PERF.launcher.first.stub_gap_s", stub_gap, PROGRESS_GAP_S, f"s (stub reply timeout {raw.get('replyTimeoutS')} s)"))
    items.append(below("PERF.launcher.first.s", first_s, FIRST_SCAN_CAP_S, "s"))

    later = by_phase["steady"] + by_phase["dirty"]
    asked = [len(checks_in(row, "before")) >= 1 and len(checks_in(row, "after")) >= 1 for row in later]
    channel = bool(later) and all(asked)
    items.append(item("PERF.launcher.channel.used", f"{sum(asked)}/{len(later)}", "every later command asks main, before and after", channel))
    items.append(item("PERF.launcher.steady.ok", f"{sum(row['ok'] for row in later)}/{len(later)}", "every later command runs, asked on fd 3",
                      channel and all(row["ok"] for row in later)))
    items.append(below("PERF.launcher.steady.p95_ms", p95(ms_of(by_phase["steady"], "before")), STEADY_P95_MS, "ms"))
    items.append(below("PERF.launcher.steady.dirty_p95_ms", p95(ms_of(by_phase["dirty"], "before")), DIRTY_P95_MS, "ms"))
    # The value is always the measured overhead (visible on a red run too); it passes only when main was asked.
    for item_id, over, limit in (("PERF.launcher.steady.e2e_overhead_p95_ms", overhead(by_phase["steady"], base_by_phase["steady"]), STEADY_E2E_OVERHEAD_MS),
                                 ("PERF.launcher.dirty.e2e_overhead_p95_ms", overhead(by_phase["dirty"], base_by_phase["dirty"]), DIRTY_E2E_OVERHEAD_MS)):
        judged = below(item_id, over, limit, "ms over the one-folder baseline, asked on fd 3")
        items.append(dict(judged, **{"pass": judged["pass"] and channel and all(row["ok"] for row in later)}))

    for item_id, record, who in (("PERF.launcher.steady.scandir", raw.get("listings"), "launcher"),
                                 ("PERF.launcher.steady.runtime_scandir", raw.get("runtimeListings"), "runtime")):
        if later and isinstance(record, dict) and isinstance(record.get("listings"), list):
            start, end = later[0]["t0"], later[-1]["t1"]
            whole = record.get("total") == len(record["listings"])
            count = sum(1 for t, target in record["listings"] if start <= t <= end and inside(target, project))
            items.append(item(item_id, count if whole else f">= {count} (record capped)", f"0 listings inside the project by the {who}",
                              channel and whole and count == 0))
        else:
            items.append(item(item_id, None, f"0 listings inside the project by the {who} (record missing)", False))

    items.append(below("PERF.launcher.after.p95_ms", p95(ms_of(later, "after")), AFTER_P95_MS, "ms"))
    sleep = by_phase["sleep"][0] if by_phase["sleep"] else None
    slept = bool(sleep) and verdict_in(sleep, "before") is True
    items.append(item("PERF.launcher.sleep.ok", (sleep or {}).get("ok"), "the command after a long sleep runs, main said ok on fd 3",
                      slept and sleep["ok"]))
    items.append(below("PERF.launcher.sleep.ms", None if not slept else (sleep["t1"] - sleep["t0"]) * 1000.0, SLEEP_MS, "ms"))
    stale = by_phase["stale"][0] if by_phase["stale"] else None
    stale_checks = checks_in(stale, "before") if stale else []
    stale_answered = bool(stale_checks) and all(c["t_verdict"] is not None for c in stale_checks)
    items.append(item("PERF.launcher.stale.ok", (stale or {}).get("ok"),
                      "the command past the age bound (awake time) runs, main said ok on fd 3",
                      bool(stale and stale["ok"]) and verdict_in(stale, "before") is True))
    items.append(below("PERF.launcher.stale.progress_gap_s",
                       None if not stale_answered else max(advancing_gap_ms(c) for c in stale_checks) / 1000.0, PROGRESS_GAP_S, "s"))
    stale_s = None
    if stale_answered and verdict_in(stale, "before") is True:
        stale_s = max(c["t_verdict"] - c["t_req"] for c in stale_checks) / 1000.0
    items.append(below("PERF.launcher.stale.s", stale_s, FIRST_SCAN_CAP_S, "s"))
    planted = by_phase["planted"][0] if by_phase["planted"] else None
    items.append(item("PERF.launcher.planted.refused", None if not planted else planted["ok"],
                      "a hard link to a file outside, planted during the run: refused by main on fd 3",
                      bool(planted) and not planted["ok"] and verdict_in(planted, "before") is False))
    return items


def value_of(items, item_id):
    found = [entry for entry in items if entry["id"] == item_id]
    return found[0]["value"] if found and isinstance(found[0]["value"], (int, float)) else None


def linearity(small, large):
    """small / large: the evaluate() items at 1/16 and at 1/8."""
    first_small = value_of(small, "PERF.launcher.first.s")
    first_large = value_of(large, "PERF.launcher.first.s")
    ratio = None
    if first_small is not None and first_large is not None:
        ratio = (first_large * 1000.0) / max(first_small * 1000.0, LINEAR_FIRST_FLOOR_MS)
    steady_small = value_of(small, "PERF.launcher.steady.p95_ms")
    steady_large = value_of(large, "PERF.launcher.steady.p95_ms")
    bound = None if steady_small is None else max(steady_small * LINEAR_STEADY_RATIO, steady_small + LINEAR_STEADY_SLACK_MS)
    e2e_small = value_of(small, "PERF.launcher.steady.e2e_overhead_p95_ms")
    e2e_large = value_of(large, "PERF.launcher.steady.e2e_overhead_p95_ms")
    e2e_bound = None if e2e_small is None else max(e2e_small * LINEAR_STEADY_RATIO, e2e_small + LINEAR_E2E_SLACK_MS)
    return [
        below("PERF.launcher.linear.first", ratio, LINEAR_FIRST_RATIO, "x (1/8 over 1/16)"),
        item(
            "PERF.launcher.linear.e2e",
            e2e_large,
            f"<= {e2e_bound if e2e_bound is None else round(e2e_bound, 2)} ms (1/16: {e2e_small})",
            e2e_large is not None and e2e_bound is not None and e2e_large <= e2e_bound,
        ),
        item(
            "PERF.launcher.linear.steady",
            steady_large,
            f"<= {bound if bound is None else round(bound, 2)} ms (1/16: {steady_small})",
            steady_large is not None and bound is not None and steady_large <= bound,
        ),
    ]


def report(gate, items):
    passed = all(entry["pass"] for entry in items) and bool(items)
    print("RESULT_JSON " + json.dumps({"pass": passed, "gate": gate, "items": items}), flush=True)
    print(f"SUMMARY {sum(entry['pass'] for entry in items)}/{len(items)} PASS ({gate})", flush=True)
    return passed


# ---- fixture, Node and the driver ------------------------------------------------------------------------------------


def owner_home():
    return pwd.getpwuid(os.getuid()).pw_dir


def node_binary():
    pinned = Path(owner_home()) / "Developer" / "iclone-cache" / "node-v26.8.1" / "node-v26.8.1-darwin-arm64" / "bin" / "node"
    node = os.environ.get("ICLONE_PERF_NODE") or str(pinned)
    if not os.access(node, os.X_OK):
        pytest.fail(f"PERF.launcher: no Node at {node} (set ICLONE_PERF_NODE)")
    return node


def private_scratch(prefix):
    path = os.path.realpath(tempfile.mkdtemp(prefix=prefix, dir="/private/tmp"))
    assert path.startswith("/private/tmp/"), path
    return path


def make_fixture(target, *args):
    run = subprocess.run([node_binary(), str(MAKE_FIXTURE), target, *args], capture_output=True, text=True, timeout=1_800)
    line = next((row for row in run.stdout.splitlines() if row.startswith("FIXTURE_JSON ")), None)
    if run.returncode != 0 or line is None:
        pytest.fail(f"make-fixture {args}: rc={run.returncode} {run.stderr[-600:]}")
    return json.loads(line[len("FIXTURE_JSON "):])


def scale_dirs(scale):
    return round(OWNER_DIRS / SCALES[scale])


def reply_timeout_s(scale):
    """The stub's 60 s reply wait scaled like the walk (the owner's 80 s walk against 60 s): a launcher that leaves the
    stub without progress for the scaled time is refused at every scale, as v0.0.7's was at full size."""
    return OWNER_REPLY_TIMEOUT_S / SCALES[scale]


def run_world(fixture, dirs, scratch, *, reply_s, steady=STEADY_COMMANDS, dirty=DIRTY_COMMANDS):
    """Both worlds (window, own) on one fixture: the DRIVER_JSON body, `worlds` keyed by shape."""
    config = {
        "fixture": fixture,
        "dirs": dirs,
        "scratch": scratch,
        "steady": steady,
        "dirty": dirty,
        "dirtyFolders": DIRTY_FOLDERS,
        "sleepMs": SIMULATED_SLEEP_MS,
        "staleMs": SIMULATED_AWAKE_MS,
        "replyTimeoutS": reply_s,
        "shapes": list(SHAPES),
    }
    if not TSX.is_file():
        pytest.fail(f"PERF.launcher: no tsx at {TSX}")
    log = Path(scratch) / "driver.log"
    with open(log, "w", encoding="utf-8") as err:
        run = subprocess.run(
            [node_binary(), str(TSX), str(DRIVER), json.dumps(config)],
            cwd=str(DESKTOP), stdout=subprocess.PIPE, stderr=err, text=True, timeout=3_600,
        )
    missing = next((row for row in run.stdout.splitlines() if row.startswith("HARNESS_MISSING ")), None)
    if missing:
        pytest.fail(f"PERF.launcher: the live harness lacks the CF8 extension: {missing[len('HARNESS_MISSING '):]}")
    line = next((row for row in run.stdout.splitlines() if row.startswith("DRIVER_JSON ")), None)
    if run.returncode != 0 or line is None:
        pytest.fail(f"PERF.launcher driver rc={run.returncode}: {log.read_text(encoding='utf-8')[-1200:]}")
    return json.loads(line[len("DRIVER_JSON "):])


def judge_worlds(worlds):
    """shape -> items; the own world is measured against the window world's one-folder baseline (its runtime's project
    is the fixture, so it has no check-free folder of its own). A shape the driver did not return fails whole."""
    window = worlds.get("window") or {}
    base = [row for row in window.get("rows") or [] if row.get("cwd") == "base"]
    judged = {}
    for shape in SHAPES:
        if shape not in worlds:
            judged[shape] = [item("PERF.launcher.precondition", None, f"the {shape} world ran", False)]
            continue
        judged[shape] = evaluate(worlds[shape], base)
    return judged


# FX-SLEEP (lead decision pending, measured): linear.first divides two FIRST scans, so both must start from the same
# metadata cache. A fixture built in this run is warm (make-fixture just wrote it); one reused from
# ICLONE_PERF_FIXTURE_* is cold (last touched hours ago). On f06e52ef19 that alone gave 3.85x: isolated worker walks,
# 3 rounds each, were 1/16 914/1099/1088 ms (built, warm) and 1/8 3238 (cold) then 2144/2131 ms (warm): 1.96x. So
# each linearity scale gets one identical untimed lstat pass right before its worlds. Full scale is never warmed: its
# first.s against the 180 s cap stays the cold, honest case. No target changed.
LINEAR_WARM_SCALES = ("1/16", "1/8")


def warm_before(scale):
    """Whether the gate gives `scale` its untimed warm pass (only the two scales linearity compares)."""
    return scale in LINEAR_WARM_SCALES


def warm_fixture(root):
    """One lstat of every name under `root` (no symlink followed, nothing written); returns how many names."""
    names, stack = 0, [root]
    while stack:
        with os.scandir(stack.pop()) as entries:
            for entry in entries:
                entry.stat(follow_symlinks=False)
                names += 1
                if entry.is_dir(follow_symlinks=False):
                    stack.append(entry.path)
    return names


@pytest.fixture(scope="module")
def fixtures():
    """scale -> (fixture dir, folders), each built once (or reused from ICLONE_PERF_FIXTURE_*), removed if built here."""
    built, made = {}, []
    scales = ["1/16", "1/8"] + (["full"] if os.environ.get("ICLONE_PERF_SCALE") == "full" else [])
    try:
        for scale in scales:
            given = os.environ.get(FIXTURE_ENV[scale])
            if given:
                if not (Path(given) / ".perf-v007-fixture").is_file():
                    pytest.fail(f"{FIXTURE_ENV[scale]}={given} is not a make-fixture.mjs fixture")
                built[scale] = (os.path.realpath(given), scale_dirs(scale))
                continue
            parent = private_scratch("pl-fx-")
            made.append(parent)
            info = make_fixture(os.path.join(parent, "fx"), "--scale", scale)
            print(f"PERF.launcher fixture {scale}: {info['dirs']} folders / {info['files']} files in {info['ms'] / 1000:.1f} s", flush=True)
            built[scale] = (info["root"], info["dirs"])
        yield built
    finally:
        for parent in made:
            shutil.rmtree(parent, ignore_errors=True)


@pytest.mark.skipif(not GATE_ON, reason="the gate itself runs with ICLONE_PERF=1")
def test_perf_launcher_gate(fixtures):
    results = {}
    for scale, (fixture, dirs) in fixtures.items():
        if warm_before(scale):
            began = time.monotonic()
            names = warm_fixture(fixture)
            print(f"PERF.launcher warm {scale}: {names} names lstat-ed in {time.monotonic() - began:.1f} s (untimed)", flush=True)
        scratch = private_scratch("pl-run-")
        try:
            worlds = run_world(fixture, dirs, scratch, reply_s=reply_timeout_s(scale))["worlds"]
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
        for shape, items in judge_worlds(worlds).items():
            results[(scale, shape)] = items
            report(f"PERF.launcher@{scale}:{shape}", items)
    lin = [dict(entry, id=f"{entry['id']}:{shape}") for shape in SHAPES for entry in linearity(results[("1/16", shape)], results[("1/8", shape)])]
    everything = [dict(entry, id=f"{entry['id']}@{scale}:{shape}") for (scale, shape), items in results.items() for entry in items] + lin
    assert report("PERF.launcher", everything), [entry for entry in everything if not entry["pass"]]


# ---- self-test: the parts that do not need main ----------------------------------------------------------------------


def test_selftest_warm_pass_covers_every_name_and_only_the_linearity_scales():
    """FX-SLEEP: both scales linearity divides get the same warm pass; full scale stays cold."""
    assert [warm_before(scale) for scale in ("1/16", "1/8", "full")] == [True, True, False]
    parent = private_scratch("pl-wm-")
    try:
        info = make_fixture(os.path.join(parent, "fx"), "--dirs", "300")
        root = info["root"]
        expected = sum(len(dirs) + len(files) for _top, dirs, files in os.walk(root))
        assert warm_fixture(root) == expected > info["files"]
    finally:
        shutil.rmtree(parent, ignore_errors=True)


def test_selftest_fixture_has_the_owner_shape():
    parent = private_scratch("pl-st-")
    try:
        info = make_fixture(os.path.join(parent, "fx"), "--dirs", "1000")
        tree = Path(info["root"]) / "tree"
        names = [entry for entry in tree.rglob("*") if entry.is_file()]
        linked = [entry for entry in names if entry.stat().st_nlink > 1]
        assert info["dirs"] == 1000 and info["files"] == round(1000 * OWNER_FILES / OWNER_DIRS)
        assert sum(1 for entry in tree.rglob("*") if entry.is_dir()) + 1 == 1000
        assert len(names) == info["files"] + info["insideLinks"]
        assert len(linked) == info["linkedNames"] == 2 * max(1, round(info["files"] * OWNER_LINKED_NAMES / OWNER_FILES / 2))
        before = sorted((str(p.relative_to(tree)), p.read_bytes()) for p in names)
        again = make_fixture(os.path.join(parent, "fx"), "--dirs", "1000")
        assert again["files"] == info["files"] and again["linkedNames"] == info["linkedNames"]
        assert sorted((str(p.relative_to(tree)), p.read_bytes()) for p in tree.rglob("*") if p.is_file()) == before
        for bad in (["--scale", "1/8", "--dirs", "3"], ["--files", "10", "--per-dir", "2"], ["--scale", "1/3"]):
            run = subprocess.run([node_binary(), str(MAKE_FIXTURE), os.path.join(parent, "bad"), *bad], capture_output=True, text=True, timeout=60)
            assert run.returncode == 2, (bad, run.stderr)
    finally:
        shutil.rmtree(parent, ignore_errors=True)


FAKE_LAUNCHER = """
import os, sys, time
project, outside = sys.argv[1:3]
assert sys.flags.isolated and sys.flags.no_site, "the launcher's -I -S must hold under the shim"
list(os.scandir(project)); os.listdir(os.path.join(project, "sub"))
for _ in os.walk(project): pass
os.listdir(outside)
fd = os.open(project, os.O_RDONLY); list(os.scandir(fd)); os.close(fd)
time.sleep(0.12)
sys.exit(7)
"""


def test_selftest_shim_records_the_launchers_listings_in_the_same_process():
    scratch = private_scratch("pl-st-")
    try:
        project, outside = os.path.join(scratch, "project"), os.path.join(scratch, "outside")
        os.makedirs(os.path.join(project, "sub", "deep"))
        os.makedirs(outside)
        fake = os.path.join(scratch, "launcher.py")
        Path(fake).write_text(FAKE_LAUNCHER, encoding="utf-8")
        out = os.path.join(scratch, "listings.json")
        wrapper = os.path.join(scratch, "launcher-python")
        Path(wrapper).write_text(f'#!/bin/sh\nexec {json.dumps(sys.executable)} -I -S {json.dumps(str(SHIM))} {json.dumps(out)} "$@"\n', encoding="utf-8")
        os.chmod(wrapper, 0o755)
        run = subprocess.run([wrapper, "-I", "-S", fake, project, outside], capture_output=True, text=True, timeout=30)
        assert run.returncode == 7, run.stderr
        body = json.loads(Path(out).read_text(encoding="utf-8"))
        targets = [target for _, target in body["listings"]]
        inside_project = [target for target in targets if inside(target, os.path.realpath(project)) or inside(target, project)]
        # scandir(project) + listdir(sub) + walk(project, sub, deep) + scandir(fd) inside; listdir(outside) outside.
        assert len(inside_project) == 6, targets
        assert body["total"] == 7 and any(target.startswith(outside) for target in targets)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def test_selftest_driver_runs_both_worlds_end_to_end_on_a_tiny_fixture():
    """L5.4: the driver itself (real main, launcher, stub, runtime) on 1 000 folders, so a crash shows in seconds, not
    in the 1/8 gate. Judges the record, not the speed: every planned row, every record, and the planted link refused."""
    if not (REPO / "venv" / "bin" / "python").exists():
        pytest.fail("PERF.launcher: the worktree has no venv link (the runtime the world confines)")
    parent = private_scratch("pl-st-")
    try:
        info = make_fixture(os.path.join(parent, "fx"), "--dirs", "1000")
        scratch = os.path.join(parent, "run")
        os.makedirs(scratch)
        worlds = run_world(info["root"], info["dirs"], scratch, reply_s=10.0, steady=3, dirty=2)["worlds"]
        assert set(worlds) == set(SHAPES)
        for shape, world in worlds.items():
            planned = 1 + (3 + 2) * (2 if shape == "window" else 1) + 3
            assert len(world["rows"]) == world["plannedRows"] == planned, (shape, len(world["rows"]))
            assert [row["phase"] for row in world["rows"]][-3:] == ["sleep", "stale", "planted"], shape
            assert all(row["ok"] for row in world["rows"] if row["phase"] != "planted"), (shape, [row["out"] for row in world["rows"] if not row["ok"]])
            assert not any("Traceback" in row["out"] for row in world["rows"]), (shape, "the stub wrapper or the runtime driver broke")
            assert not world["rows"][-1]["ok"] and "hard link" in world["rows"][-1]["out"], (shape, world["rows"][-1])
            assert isinstance(world["listings"], dict) and isinstance(world["runtimeListings"], dict), shape
            starts = [entry["t"] for entry in world["stub"] if entry["kind"] == "start"]
            # The planted link may be refused before the stub (v0.0.7's runtime walks its own project itself).
            reached = [any(row["t0"] <= t <= row["t1"] for t in starts) for row in world["rows"] if row["phase"] != "planted"]
            assert all(reached), (shape, "a command never reached the stub")
        assert sum(row["cwd"] == "base" for row in worlds["window"]["rows"]) == 3 + 2
        assert not any(Path(info["root"], "tree").rglob("perf-planted.txt"))
    finally:
        shutil.rmtree(parent, ignore_errors=True)


def synthetic_world(*, first_s=4.0, gap_s=1.5, steady_ms=8.0, dirty_ms=40.0, after_ms=6.0, scandir_in_steady=0, sleep_ok=True,
                    refuse_first=False, stub_gap_s=None, steady_extra_ms=0.0, dirty_extra_ms=0.0, base_ms=30.0,
                    runtime_scandir_in_steady=0, sleep_check=True, planted_ok=False, stale_ok=True, stale_s=6.0,
                    stale_counts=True):
    """One window world as the driver records it: fixture commands (checked on fd 3), each steady/dirty one paired with
    a base command in the runtime's one-folder project (its checks name that root), the stub's frames, both listing
    records. Defaults pass every item; each keyword breaks one."""
    project, base = "/private/tmp/ie-x/fx", "/private/tmp/ie-x/project"
    rows, frames, listings, runtime, stub = [], [], [], [], []
    clock = 1_000_000.0
    stub_gap = gap_s if stub_gap_s is None else stub_gap_s

    def check(rid, root, phase, t_ms, answer_ms, ok):
        frames.append({"t": t_ms, "dir": "request", "frame": {"id": rid, "op": "check", "root": root, "phase": phase}})
        frames.append({"t": t_ms + answer_ms, "dir": "verdict", "frame": {"id": rid, "ok": ok}})

    def command(phase, before_ms, ok=True, wait_s=0.0, gap=None, extra_ms=0.0, checked=True, verdict=None, counts=True):
        nonlocal clock
        t0 = clock
        rid = f"{len(rows):032x}"
        t = t0 * 1000 + 1
        answered = t0 * 1000 + 1 + max(before_ms, wait_s * 1000)
        if checked:
            frames.append({"t": t, "dir": "request", "frame": {"id": rid, "op": "check", "root": project, "phase": "before"}})
            stub.append({"t": t0 + 0.0005, "kind": "start"})
            if wait_s:
                reached = 0
                while t + gap * 1000 < t0 * 1000 + wait_s * 1000:
                    t += gap * 1000
                    # `counts`: main's frames report the walk advancing; else the count never moves (B1-M1, 0 folders).
                    reached = reached + 1 if counts else 0
                    frames.append({"t": t, "dir": "progress", "frame": {"id": rid, "progress": {"dirs": reached if counts else 0}}})
                s = t0 + 0.0005
                while s + stub_gap < t0 + wait_s:
                    s += stub_gap
                    stub.append({"t": s, "kind": "progress"})
            frames.append({"t": answered, "dir": "verdict", "frame": {"id": rid, "ok": ok if verdict is None else verdict}})
            stub.append({"t": answered / 1000.0 + 0.0002, "kind": "reply"})
        t_after = answered + 4
        if checked and ok:
            check("a" + rid[1:], project, "after", t_after, after_ms, True)
        clock = (t_after + after_ms + 20 + extra_ms) / 1000.0
        rows.append({"phase": phase, "cwd": "fixture", "t0": t0, "t1": clock, "code": 0 if ok else 1, "ok": ok, "out": ""})
        clock += 0.01

    def base_command(phase):
        nonlocal clock
        t0 = clock
        check(f"b{len(rows):031x}", base, "before", t0 * 1000 + 1, 1.0, True)
        stub.append({"t": t0 + 0.0005, "kind": "start"})
        clock = t0 + base_ms / 1000.0
        rows.append({"phase": phase, "cwd": "base", "t0": t0, "t1": clock, "code": 0, "ok": True, "out": ""})
        clock += 0.01

    command("first", 0, ok=not refuse_first, wait_s=first_s, gap=gap_s)
    listings.extend([[rows[0]["t0"] + 0.01, project + "/tree"]] * 3)
    for n in range(STEADY_COMMANDS):
        command("steady", steady_ms, extra_ms=steady_extra_ms)
        if n < scandir_in_steady:
            listings.append([rows[-1]["t0"] + 0.001, project + "/tree/d00001"])
        if n < runtime_scandir_in_steady:
            runtime.append([rows[-1]["t0"] + 0.001, "<fd>"])
        listings.append([rows[-1]["t0"] + 0.001, "/private/tmp/ie-x/ud/members"])
        runtime.append([rows[-1]["t0"] + 0.001, base])
        base_command("steady")
    for _ in range(DIRTY_COMMANDS):
        command("dirty", dirty_ms, extra_ms=dirty_extra_ms)
        base_command("dirty")
    command("sleep", 30, ok=sleep_ok, checked=sleep_check)
    command("stale", 0, ok=stale_ok, wait_s=stale_s, gap=1.0, counts=stale_counts)
    command("planted", 2, ok=planted_ok, verdict=planted_ok)
    return {"shape": "window", "project": project, "base": base, "plannedRows": len(rows), "replyTimeoutS": 3.75, "rows": rows,
            "frames": frames, "listings": {"total": len(listings), "listings": listings},
            "runtimeListings": {"total": len(runtime), "listings": runtime}, "stub": stub}


ALL_ITEMS = {
    "PERF.launcher.precondition", "PERF.launcher.first.not_refused", "PERF.launcher.first.progress_gap_s",
    "PERF.launcher.first.stub_gap_s", "PERF.launcher.first.s", "PERF.launcher.channel.used", "PERF.launcher.steady.ok",
    "PERF.launcher.steady.p95_ms", "PERF.launcher.steady.dirty_p95_ms", "PERF.launcher.steady.e2e_overhead_p95_ms",
    "PERF.launcher.dirty.e2e_overhead_p95_ms", "PERF.launcher.steady.scandir", "PERF.launcher.steady.runtime_scandir",
    "PERF.launcher.after.p95_ms", "PERF.launcher.sleep.ok", "PERF.launcher.sleep.ms", "PERF.launcher.planted.refused",
    "PERF.launcher.stale.ok", "PERF.launcher.stale.progress_gap_s", "PERF.launcher.stale.s",
}


def test_selftest_judging_passes_a_good_world_and_names_each_failure():
    good = {entry["id"]: entry for entry in evaluate(synthetic_world())}
    assert all(entry["pass"] for entry in good.values()), [entry for entry in good.values() if not entry["pass"]]
    assert set(good) == ALL_ITEMS
    cases = {
        "PERF.launcher.first.not_refused": dict(refuse_first=True),
        "PERF.launcher.first.progress_gap_s": dict(gap_s=2.6),
        "PERF.launcher.first.stub_gap_s": dict(stub_gap_s=2.6),
        "PERF.launcher.first.s": dict(first_s=181.0),
        "PERF.launcher.steady.p95_ms": dict(steady_ms=51.0),
        "PERF.launcher.steady.dirty_p95_ms": dict(dirty_ms=151.0),
        "PERF.launcher.steady.e2e_overhead_p95_ms": dict(steady_extra_ms=60.0),
        "PERF.launcher.dirty.e2e_overhead_p95_ms": dict(dirty_extra_ms=160.0),
        "PERF.launcher.steady.scandir": dict(scandir_in_steady=1),
        "PERF.launcher.steady.runtime_scandir": dict(runtime_scandir_in_steady=1),
        "PERF.launcher.after.p95_ms": dict(after_ms=51.0),
        "PERF.launcher.sleep.ok": dict(sleep_ok=False),
        "PERF.launcher.sleep.ms": dict(sleep_check=False),
        "PERF.launcher.planted.refused": dict(planted_ok=True),
        "PERF.launcher.stale.ok": dict(stale_ok=False),
        # B1-M1 as 3a3109938f sends it: main's ticker frames every 1 s, the folder count never moving.
        "PERF.launcher.stale.progress_gap_s": dict(stale_counts=False),
        "PERF.launcher.stale.s": dict(stale_s=181.0),
    }
    for failing, kwargs in cases.items():
        judged = {entry["id"]: entry["pass"] for entry in evaluate(synthetic_world(**kwargs))}
        assert judged[failing] is False, (failing, judged)
    unchecked_sleep = {entry["id"]: entry["pass"] for entry in evaluate(synthetic_world(sleep_check=False))}
    assert not unchecked_sleep["PERF.launcher.sleep.ok"]
    silent = synthetic_world()
    silent["frames"] = []
    judged = {entry["id"]: entry["pass"] for entry in evaluate(silent)}
    assert not judged["PERF.launcher.channel.used"] and not judged["PERF.launcher.steady.p95_ms"] and not judged["PERF.launcher.first.s"]
    # L5.5 / D5: no fd-3 check for the fixture (none at all, or only the base's), or no command: EVERY item fails.
    only_base = synthetic_world()
    only_base["frames"] = [frame for frame in only_base["frames"] if frame["frame"].get("root") != only_base["project"] and frame["dir"] != "verdict"]
    for name, raw in (("no frames", silent), ("base checks only", only_base), ("no rows", dict(synthetic_world(), rows=[]))):
        passed = [entry["id"] for entry in evaluate(raw) if entry["pass"]]
        assert passed == [], (name, passed)
    missing_row = synthetic_world()
    missing_row["rows"] = missing_row["rows"][:-1]
    assert not {entry["id"]: entry["pass"] for entry in evaluate(missing_row)}["PERF.launcher.precondition"]
    no_shim = synthetic_world()
    no_shim["listings"] = None
    assert not {entry["id"]: entry["pass"] for entry in evaluate(no_shim)}["PERF.launcher.steady.scandir"]
    no_hook = synthetic_world()
    no_hook["runtimeListings"] = None
    assert not {entry["id"]: entry["pass"] for entry in evaluate(no_hook)}["PERF.launcher.steady.runtime_scandir"]
    own = synthetic_world()
    own["rows"] = [row for row in own["rows"] if row["cwd"] == "fixture"]
    own["plannedRows"] = len(own["rows"])
    judged = {entry["id"]: entry["pass"] for entry in evaluate(own, base_rows=[row for row in synthetic_world()["rows"] if row["cwd"] == "base"])}
    assert all(judged.values()), judged
    assert not {entry["id"]: entry["pass"] for entry in evaluate(own)}["PERF.launcher.steady.e2e_overhead_p95_ms"]
    assert set(judge_worlds({"window": synthetic_world()})) == set(SHAPES)
    assert [entry["pass"] for entry in judge_worlds({"window": synthetic_world()})["own"]] == [False]


def test_selftest_linearity_and_machine_lines(capsys):
    small = evaluate(synthetic_world(first_s=4.0, steady_ms=8.0))
    assert all(entry["pass"] for entry in linearity(small, evaluate(synthetic_world(first_s=8.4, steady_ms=9.0))))
    quadratic = {entry["id"]: entry["pass"] for entry in linearity(small, evaluate(synthetic_world(first_s=16.0, steady_ms=8.0)))}
    growing = {entry["id"]: entry["pass"] for entry in linearity(small, evaluate(synthetic_world(first_s=8.0, steady_ms=19.0)))}
    slower = {entry["id"]: entry["pass"] for entry in linearity(small, evaluate(synthetic_world(first_s=8.0, steady_extra_ms=40.0)))}
    assert quadratic == {"PERF.launcher.linear.first": False, "PERF.launcher.linear.e2e": True, "PERF.launcher.linear.steady": True}
    assert growing == {"PERF.launcher.linear.first": True, "PERF.launcher.linear.e2e": True, "PERF.launcher.linear.steady": False}
    assert slower == {"PERF.launcher.linear.first": True, "PERF.launcher.linear.e2e": False, "PERF.launcher.linear.steady": True}
    assert report("PERF.launcher@selftest", small) is True
    lines = capsys.readouterr().out.splitlines()
    result = json.loads(lines[-2][len("RESULT_JSON "):])
    assert lines[-2].startswith("RESULT_JSON ") and result["pass"] is True
    assert all(set(entry) == {"id", "value", "target", "pass"} for entry in result["items"])
    assert lines[-1] == f"SUMMARY {len(small)}/{len(small)} PASS (PERF.launcher@selftest)"
