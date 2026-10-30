#!/usr/bin/env python3
"""verdict_digest.py <front> [--last 3]   (<= 40 lines, for the lead between blocks; no transcript reading)
Reads CONTROL/sampleproject/<front>_critic_r<N>.json (plus the historical alias: P1=integrationB, P2=galaxy, P3=nebula,
P4=jets) and prints:
  - the score trend over the last K rounds,
  - an item x round table: M major · d medium · n minor · . absent, and the state in the latest round:
    OPEN (new in the latest round), RECUR (open and seen in >= 2 rounds), CLOSED (seen before, gone now),
  - gates failing in >= 2 consecutive rounds, from CONTROL/local.nosync/gates/<front>_r<N>.json (a gate script's
    RESULT_JSON object) or from a `gates` field inside the verdict.
Items are matched across rounds by their `id` when the critic gives dict items with one, else by headline overlap
(words before the first ':'; overlap >= 0.6) or body Jaccard >= 0.30, since the critics' M1/M2 numbering restarts."""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
VERD = ROOT / "CONTROL" / "sampleproject"
GATES = ROOT / "CONTROL" / "local.nosync" / "gates"
ALIAS = {"P1": ["integrationB"], "P2": ["galaxy"], "P3": ["nebula"], "P4": ["jets"]}
try:  # parrallello: per-project aliases of old verdict names in CONTROL/run/fronts.json {"alias": {F: [names]}}
    ALIAS = json.loads((Path(__file__).resolve().parents[1] / "fronts.json").read_text()).get("alias", ALIAS)
except (OSError, ValueError):
    pass
SEV = (("majors", "M"), ("mediums", "d"), ("minors", "n"))
STOP = set("that this with from have were been their there which into than then they them these those when what "
           "still only also does done each every more most much very same such some over under about after before "
           "while where would could should must will just like make made other the and for not but are was has its "
           "per via all any can now one two new out off too yet who why how see""".split())
META = set("major majors medium mediums minor minors fixed partly mostly round regressed regression critic builder "
           "hero heroes reads read".split())
MAXLINES = 40


def round_files(front):
    names = [front] + ALIAS.get(front, [])
    found = {}
    for nm in reversed(names):  # the front's own name wins over the alias for the same round
        for p in VERD.glob(f"{nm}_critic_r*.json"):
            m = re.match(rf"{re.escape(nm)}_critic_r(\d+)(?:_APPROVED)?\.json$", p.name)
            if m:
                found[int(m.group(1))] = p
    return dict(sorted(found.items()))


def text_of(it):
    if isinstance(it, dict):
        for k in ("item", "text", "title", "summary", "issue", "desc", "description"):
            if isinstance(it.get(k), str):
                return it[k], it.get("id")
        return json.dumps(it)[:400], it.get("id")
    return str(it), None


def toks(s):
    s = re.sub(r"^\s*(?:\[?[A-Za-z]{0,3}\d+\]?[.):\s—-]+)", "", s.lower())  # drop per-round numbering
    w = [t for t in re.findall(r"[a-z][a-z0-9_]{2,}", s) if t not in STOP]
    return set(w[:40])


def head_toks(s):
    """Headline words: the text before the first ':' (if within 140 chars), else its first 12 words; meta words out."""
    s0 = re.sub(r"\(r\d+[^)]*\)", " ", s)
    c = s0.find(":")
    h = s0[:c] if 0 < c <= 140 else s0
    w = [t for t in toks(h) if t not in META and not re.match(r"r\d+$", t)]
    return set(sorted(w, key=lambda t: h.lower().find(t))[:12])


def same(a, b):
    ha, hb = a["head"], b["head"]
    shared = len(ha & hb)
    if ha and hb and shared >= min(2, len(ha), len(hb)) and shared / min(len(ha), len(hb)) >= 0.6:
        return 0.6 + shared / max(len(ha), len(hb)) * 0.4
    return jacc(a["toks"], b["toks"])


def label(s, n=46):
    s = re.sub(r"^\s*(?:\[?[A-Za-z]{0,3}\d+\]?[.):\s—-]+)", "", s).strip()
    s = re.sub(r"\s+", " ", s)
    return s[:n - 1] + "…" if len(s) > n else s


def load_items(d):
    out = []
    for key, sev in SEV:
        for it in d.get(key) or []:
            t, iid = text_of(it)
            out.append({"sev": sev, "text": t, "id": iid, "toks": toks(t), "head": head_toks(t)})
    for it in d.get("defects") or []:  # older schema: defects[{item, severity}]
        t, iid = text_of(it)
        sv = str(it.get("severity", "")).lower() if isinstance(it, dict) else ""
        sev = "M" if sv in ("critical", "major", "high") else "d" if sv in ("medium", "moderate") else "n"
        out.append({"sev": sev, "text": t, "id": iid, "toks": toks(t), "head": head_toks(t)})
    return out


def jacc(a, b):
    return len(a & b) / len(a | b) if a and b else 0.0


def gate_fails(front, rnd, d):
    p = GATES / f"{front}_r{rnd}.json"
    obj = None
    if p.exists():
        try:
            obj = json.loads(p.read_text())
        except ValueError:
            obj = None
    if obj is None:
        obj = d.get("gates")
    items = obj.get("items", []) if isinstance(obj, dict) else obj if isinstance(obj, list) else []
    return {str(i.get("id")) for i in items if isinstance(i, dict) and i.get("pass") is False}, bool(items)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("front")
    ap.add_argument("--last", type=int, default=3)
    a = ap.parse_args()
    files = round_files(a.front)
    if not files:
        print(f"no verdicts for {a.front} in {VERD}")
        sys.exit(2)
    rounds = list(files.items())[-max(1, a.last):]
    lines = []
    data = []
    for r, p in rounds:
        try:
            d = json.loads(p.read_text())
        except ValueError as e:
            d = {"_err": str(e)}
        data.append((r, p, d))
    trend = []
    for r, p, d in data:
        sc = d.get("score_0_10")
        trend.append(f"r{r} {sc if sc is not None else '?'}{' APPROVED' if d.get('approved') else ''}")
    s0, s1 = data[0][2].get("score_0_10"), data[-1][2].get("score_0_10")
    delta = f"  ({s1 - s0:+.1f})" if isinstance(s0, (int, float)) and isinstance(s1, (int, float)) and len(data) > 1 else ""
    lines.append(f"{a.front} score: " + " -> ".join(trend) + delta)
    # chain items across rounds
    chains = []  # each: {"label", "cells": {round: sev}, "toks", "id"}
    for r, p, d in data:
        used = set()
        for it in load_items(d):
            best, bj = None, 0.0
            for ci, ch in enumerate(chains):
                if ci in used or r in ch["cells"]:
                    continue
                if it["id"] is not None and ch["id"] is not None:
                    j = 1.0 if str(it["id"]) == str(ch["id"]) else 0.0
                else:
                    j = same(it, ch)
                if j > bj:
                    best, bj = ci, j
            if best is not None and bj >= 0.30:
                ch = chains[best]
                ch["cells"][r] = it["sev"]; ch["toks"] = it["toks"]; ch["head"] = it["head"]; ch["label"] = label(it["text"])
                used.add(best)
            else:
                chains.append({"label": label(it["text"]), "cells": {r: it["sev"]}, "toks": it["toks"], "head": it["head"],
                               "id": it["id"]})
                used.add(len(chains) - 1)
    rs = [r for r, _, _ in data]
    last = rs[-1]
    for ch in chains:
        seen = len(ch["cells"])
        if last in ch["cells"]:
            ch["state"] = "RECUR" if seen >= 2 else "OPEN"
        else:
            ch["state"] = "CLOSED"
    order = {"RECUR": 0, "OPEN": 1, "CLOSED": 2}
    sevk = {"M": 0, "d": 1, "n": 2}
    chains.sort(key=lambda c: (order[c["state"]], sevk[c["cells"].get(last, min(c["cells"].values(), key=sevk.get))]))
    counts = {k: sum(1 for c in chains if c["state"] == k) for k in order}
    lines.append(f"items: RECUR {counts['RECUR']} · OPEN {counts['OPEN']} · CLOSED {counts['CLOSED']}   "
                 f"(latest r{last}: " + " ".join(f"{k} {len(data[-1][2].get(k) or [])}" for k, _ in SEV) + ")")
    lines.append("  " + " ".join(f"r{r:<3}" for r in rs) + " state  item")
    # gates
    gate_rows = []
    fails_by_round = []
    for r, p, d in data:
        f, has = gate_fails(a.front, r, d)
        fails_by_round.append((r, f, has))
    persistent = set()
    if len(fails_by_round) >= 2:
        for g in fails_by_round[-1][1]:
            run = 0
            for r, f, has in reversed(fails_by_round):
                if g in f:
                    run += 1
                else:
                    break
            if run >= 2:
                persistent.add((g, run))
    if any(h for _, _, h in fails_by_round):
        gate_rows.append("gates failing >= 2 rounds: " + (", ".join(f"{g} ({n})" for g, n in sorted(persistent)) or "none"))
    else:
        gate_rows.append(f"gates: no results recorded (save RESULT_JSON to {GATES.relative_to(ROOT)}/{a.front}_r<N>.json)")
    room = MAXLINES - len(lines) - len(gate_rows) - 1
    shown = chains if len(chains) <= room else chains[:room - 1]
    for c in shown:
        cells = " ".join(f"{c['cells'].get(r, '.'):<4}" for r in rs)
        lines.append(f"  {cells} {c['state']:<6} {c['label']}")
    if len(shown) < len(chains):
        hidden = chains[len(shown):]
        lines.append(f"  ... +{len(hidden)} more (" + ", ".join(f"{k} {sum(1 for c in hidden if c['state'] == k)}"
                                                         for k in order) + ")")
    lines += gate_rows
    lines.append("files: " + " ".join(p.name for _, p, _ in data))
    print("\n".join(lines[:MAXLINES]))


if __name__ == "__main__":
    main()
