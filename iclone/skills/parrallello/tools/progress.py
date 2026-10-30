#!/usr/bin/env python3
"""progress.py — run state in CONTROL/run/state.json and the global bar (SAMPLE_PROJECT §8.3).
  progress.py                                    bar + one line per stage
  progress.py --bar                              only `██████░░░░ 58 %`
  progress.py --set P2 round=13 status=running   update a stage (key=value; ints/floats/true/false parsed)
Stage status: pending | running | approved | blocked. Weights: P0 4, P1 14, P2 16, P3 22, P4 10, P7 4, P5 15, P6 15.
An approved stage counts its whole weight; a running/blocked one counts weight x min(0.9, done / planned), with
planned rounds P0 1, P1 4, P2 4, P3 6, P4 3, P7 2, P5 3, P6 2 and done = `done` if set, else round - start
(start = the block's roundStart: P1 2, P2 12, P3 10, others 1; override with start=N). Writes are atomic + flocked."""
import fcntl
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
STATE = Path(os.environ.get("PROGRESS_STATE") or ROOT / "CONTROL" / "run" / "state.json")
ORDER = ["P0", "P1", "P2", "P3", "P4", "P7", "P5", "P6"]
WEIGHT = {"P0": 4, "P1": 14, "P2": 16, "P3": 22, "P4": 10, "P7": 4, "P5": 15, "P6": 15}
PLANNED = {"P0": 1, "P1": 4, "P2": 4, "P3": 6, "P4": 3, "P7": 2, "P5": 3, "P6": 2}
START = {"P1": 2, "P2": 12, "P3": 10}
# parrallello: per-project override in CONTROL/run/fronts.json
#   {"order":[...], "weight":{F:w}, "planned":{F:rounds}, "start":{F:first_round}}
try:
    _f = json.loads((Path(__file__).resolve().parents[1] / "fronts.json").read_text())
    ORDER, WEIGHT = _f.get("order", ORDER), _f.get("weight", WEIGHT)
    PLANNED, START = _f.get("planned", PLANNED), _f.get("start", START)
except (OSError, ValueError):
    pass
STATUSES = {"pending", "running", "approved", "blocked"}


def load():
    try:
        st = json.loads(STATE.read_text())
    except (OSError, ValueError):
        st = {}
    st.setdefault("stages", {})
    for k in ORDER:
        st["stages"].setdefault(k, {"status": "pending"})
    return st


def parse(v):
    if v.lower() in ("true", "false"):
        return v.lower() == "true"
    for f in (int, float):
        try:
            return f(v)
        except ValueError:
            pass
    return v


def done_rounds(k, s):
    if isinstance(s.get("done"), (int, float)):
        return max(0, s["done"])
    if isinstance(s.get("round"), (int, float)):
        return max(0, s["round"] - s.get("start", START.get(k, 1)))
    return 0


def stage_pct(k, s):
    """Fraction of the stage counted in the global bar."""
    if s.get("status") == "approved":
        return 1.0
    if s.get("status") in ("running", "blocked"):
        return min(0.9, done_rounds(k, s) / PLANNED.get(k, 1))
    return 0.0


def total(st):
    w = sum(WEIGHT.values())
    return 100.0 * sum(WEIGHT[k] * stage_pct(k, st["stages"][k]) for k in ORDER) / w


def bar(p, n=10):
    f = min(n, max(0, round(p / 100 * n)))
    return "█" * f + "░" * (n - f) + f" {p:.0f} %"


def main():
    a = sys.argv[1:]
    if a and a[0] == "--set":
        if len(a) < 3 or a[1] not in WEIGHT:
            print(f"usage: progress.py --set <{'|'.join(ORDER)}> key=value...", file=sys.stderr)
            sys.exit(64)
        k, kv = a[1], a[2:]
        STATE.parent.mkdir(parents=True, exist_ok=True)
        with open(STATE.with_name(".state.lock"), "w") as lk:
            fcntl.flock(lk, fcntl.LOCK_EX)
            st = load()
            s = st["stages"][k]
            for item in kv:
                key, sep, val = item.partition("=")
                if not sep or not key:
                    print(f"bad pair {item!r}", file=sys.stderr)
                    sys.exit(64)
                v = parse(val)
                if key == "status" and v not in STATUSES:
                    print(f"status must be one of {sorted(STATUSES)}", file=sys.stderr)
                    sys.exit(64)
                s[key] = v
            s["updated"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
            st["updated"] = s["updated"]
            st["global_pct"] = round(total(st), 1)
            tmp = STATE.with_name(f".state.{os.getpid()}.tmp")
            tmp.write_text(json.dumps(st, indent=1, ensure_ascii=False))
            os.replace(tmp, STATE)
        print(f"{k} " + " ".join(f"{x}={s[x]}" for x in s if x != "updated") + f" · {bar(total(st))}")
        return
    st = load()
    p = total(st)
    if "--bar" in a:
        print(bar(p))
        return
    print(bar(p))
    for k in ORDER:
        s = st["stages"][k]
        extra = f" r{s['round']}" if "round" in s else ""
        print(f"  {k:<3} {s.get('status', 'pending'):<8}{extra:<5} {stage_pct(k, s) * 100:3.0f} % of {WEIGHT[k]}"
              + (f" · {s['note']}" if s.get("note") else ""))


if __name__ == "__main__":
    main()
