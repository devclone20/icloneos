# Template — CONTROL/SAMPLE_PROJECT.md (copy, fill in, ≤ 250 lines)

```markdown
# SAMPLE PROJECT — <project>, until the critic approves everything (parrallello)
> Root: `<absolute path>` (repo <org/repo>). Owner's language: en. Written on <date> by session <id>.
> Startup message: `go — run CONTROL/SAMPLE_PROJECT.md with workflows and background agents, silently`

## 0. Runbook (after "go")
1. get_usage (≥ 92 % of the week → wait). 2. caffeinate. 3. checkpoint + tag pre-P-<date> + push. 4. install.sh.
5. P0 (setup.js) → status.py, tickets/<F>_b1.json exist. 6. Wave 1 (block.js × fronts). 7. 30-min pulse, silence.
8. Events: workflow finished → lead-protocol §1–2 · pulse → anomalies · limit → wait. 9. Finish → §12.

## 1. Starting state (verified <date>)
<what exists, what is already approved — do not touch —, the current tests and the numbers>

## 2. Fronts
| front | 1st round | owners and files (single writer) | numeric targets (what must be done) | gates |
|---|---|---|---|---|
| P1 <name> | 1 | **<owner>:** `<files/globs>` · **forbidden:** `<…>` | <target 1 ≤ X; target 2 ≥ Y; …> | `<script> --quick/--full` |
| P2 … | | | | |

Approval = critic `approved:true` with 0 majors, 0 mediums and every gate PASS (minors may remain, listed).

## 3. Waves and dependencies
| wave | fronts | starts when | in parallel with |
|---|---|---|---|
| 0 | P0 setup | "go" | — |
| 1 | … | P0 done | each other |
| 2 | … | <Px approved — because they share files X> | … |

Shared resources: <render slots N, measurement lock, GPU, RAM>. Who uses how many.

## 4. Tools and gates
Standard parrallello tools in CONTROL/run/tools/. Per-front gates written in P0 from <verdicts or targets>.
Each script: `--quick` (< 5 min) / `--full`; `RESULT_JSON` + `SUMMARY n/m PASS`.

## 5. Block args (one JSON block per front — see SKILL §6)

## 6. Progress bar: weights per front (sum to 100) and expected rounds
| P0 | P1 | P2 | … |

## 7. Expected budget (% of the week) and duration
<expected rounds × ~1.5–2 % and h/round by type; the worst case at the ceiling>

## 8. Owner's rules (do not change)
<licences, credentials, other people's processes, UI language, what is out of scope (backlog)>

## 9. Finish
tag v1.0, release with photos, plan and README updated, memory, keepawake stop, report ≤ 10 lines.
```

**How to cut fronts (what makes a good plan):**
- One front = a set of files that only it edits during its wave. If two themes share a file, they stay in the same
  front or in different waves.
- Targets always with a number and a measurement method (the critic must be able to run it alone). "Looks good" → turn into
  metrics (correlation with the reference, IoU, contrast, counts, ms, fps) plus ≤ 3 contact sheets.
- What has already been approved is **forbidden** to the other fronts (e.g. `fx/blackhole*.js`).
- Plan the waves taking into account what prep can pre-stage: gates, data, exporters and rehearsal tools rarely
  collide.
