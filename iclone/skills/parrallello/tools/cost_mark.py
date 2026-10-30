#!/usr/bin/env python3
"""cost_mark.py <label> <weekly_%> <extra_€>   — append a usage mark to CONTROL/run/costs.json (the lead passes the
numbers read from get_usage). Prints one line with the deltas vs the previous mark. Atomic + flocked."""
import fcntl
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
COSTS = Path(os.environ.get("COST_FILE") or ROOT / "CONTROL" / "run" / "costs.json")


def num(s, what):
    try:
        return float(str(s).replace("%", "").replace("€", "").replace(",", ".").strip())
    except ValueError:
        print(f"cost_mark: {what} must be a number, got {s!r}", file=sys.stderr)
        sys.exit(64)


def main():
    if len(sys.argv) != 4:
        print("usage: cost_mark.py <label> <weekly_%> <extra_€>", file=sys.stderr)
        sys.exit(64)
    label, wk, ex = sys.argv[1], num(sys.argv[2], "weekly_%"), num(sys.argv[3], "extra_€")
    COSTS.parent.mkdir(parents=True, exist_ok=True)
    with open(COSTS.with_name(".costs.lock"), "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        try:
            marks = json.loads(COSTS.read_text())
            if not isinstance(marks, list):
                marks = []
        except (OSError, ValueError):
            marks = []
        prev = marks[-1] if marks else None
        m = {"t": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "label": label, "weekly_pct": wk, "extra_eur": ex,
             "d_weekly_pct": round(wk - prev["weekly_pct"], 2) if prev else None,
             "d_extra_eur": round(ex - prev["extra_eur"], 2) if prev else None}
        marks.append(m)
        tmp = COSTS.with_name(f".costs.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(marks, indent=1, ensure_ascii=False))
        os.replace(tmp, COSTS)
    d = f" (+{m['d_weekly_pct']:.2f} pp, +€{m['d_extra_eur']:.2f} since {prev['label']})" if prev else ""
    print(f"cost mark #{len(marks)} {label}: weekly {wk:.2f} % · extra €{ex:.2f}{d}")


if __name__ == "__main__":
    main()
