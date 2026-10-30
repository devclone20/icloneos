# Lead protocol (parrallello)

## 1. A block finished (≤ 6 calls, no code reading)
1. `get_usage` → `python3 CONTROL/run/tools/cost_mark.py "<F> b<k>" <weekly%> <extra€>`.
2. If the block spent > 9 % of the week: the next block takes ≤ 4 tickets, `maxPerOwner` 2 and a ceiling of 40 calls.
3. **Commit** only the front's paths, `CONTROL/sampleproject/` and `CONTROL/run/`:
   - `git add <paths>`;
   - **`git restore --staged` the files of other fronts in flight**, if a glob caught them;
   - `git commit -F <msg>`, with the Co-Authored-By line. Never `-m` with backticks or `$`;
   - push. The gitleaks hook runs on its own.
4. **Approved:**
   - `progress.py --set <F> status=approved`;
   - rename the verdict to `_APPROVED.json`;
   - `git tag <F>-approved`;
   - 1 line in the plan's status table;
   - launch what the approval unblocks (waves). If prep already left gates, baseline and tickets, the wave starts immediately.
5. **Not approved** → §2.

## 2. Analysis after each block of 3 rounds
1. `python3 CONTROL/run/tools/verdict_digest.py <F> --last 3` (≤ 40 lines) and `head -15` of the handoff notes of the last 2 rounds.
2. Classify each open item:

| class | signal | action |
|---|---|---|
| **Recurring** | open in all 3 rounds; the numbers barely move | **the method is wrong**: change approach instead of tuning parameters; if needed, revert to the snap of the best round |
| **Regression** | closed and reopened | bisect between the `snap/<F>/r<N>_pre/` and revert the guilty edit |
| **Miscalibrated gate** | the reference fails the gate; noise > tolerance; feature below resolution; clock under contention | recalibrate with proof (SKILL §5) and record it in the contract, with a date |
| **Ticket too big / never reached** | `not_done` by ceiling; the foundation item skipped 2+ rounds | split into 2–3, put it FIRST, `maxPerOwner` 2, or split the front into 2 owners by file |
| **List request** | the builder says "the lead must add X to my list" | widen `owners` in the next block, if X does not belong to another front in flight |
| **Obvious small fix** | ≤ 30 lines; clear cause (preset, unit, stale bundle, doc to paste, dependency missing from the venv) | the lead does it now: snapshot, `codemap`, `sed -n`, Edit, `--quick` |

3. Real examples of **method change**:
   - scales/blur tuned for 3 rounds → per-feature height field with the exact column;
   - global stroke downsample → progressive refinement (low resolution in motion; full-resolution tiles accumulated at
     rest, each frame within budget);
   - plates reduced to 1280 px → re-trace at native resolution with ONE parameter-scaling helper;
   - invented depth → inflation by scale (depth ≈ width, by distance to the edge).
4. Write `CONTROL/run/tickets/<F>_b<k+1>.json`:
   - order = foundation first;
   - `goal` with the prefix `METHOD CHANGE` or `FOUNDATION FIRST` when applicable.
5. Add to the front's contract the section "Block k+1 — lead decision" (≤ 15 lines; block numbers, decisions, recalibrations,
   harness).
6. Relaunch with `roundStart` = last round + 1, `prevVerdict` = last verdict, `leadNote` = the decisions, one sentence each.
7. **Ceiling:** 3 blocks (9 rounds) per front. If it does not approve:
   - write `CONTROL/run/DECISION_<F>.md` (what fails, 2 options, recommendation) and send **one line** to the owner;
   - the other fronts continue;
   - the final runs with that front in its last measured state, marked as such.

## 3. Anomalies (30-min pulse)

| signal | action |
|---|---|
| agent returns `null` | at the end of the block, relaunch that round 1× with the same tickets; on the 2nd failure → §2 |
| builder job still running after the critic started (orphan) | `bgjob.py kill <job>`: only jobs registered by us; frees slots and avoids double measurement |
| scratch idle > 45 min **in the most recent round** and the job dead | relaunch the job; if it dies 2×, the ticket goes to `not_done`, with the log |
| render or job stuck (> 2× the expected time, log idle for 30 min) | `bgjob.py kill`; **never** `pkill Blender`/`pkill node` (there are other sessions) |
| stale `measure.lock` (> 20 min) | `gpu_lock.py release` |
| lock held by one front most of the time | note in the leadNote: perf only in the final `--full`, one acquire per measurement |
| disk < 40 GB | delete caches outside the manifest of current keys; never approved renders |
| caffeinate dead | `keepawake.sh start` |
| red test outside the front that touched it | it is a regression: that front's next block starts with the repair ticket |
| file conflict between fronts | the front that is not the owner reverts from the snap |
| the project folder changed name/location | the agents adapt (the cwd survives); the lead rewrites with sed the absolute paths in docs/scripts and in memory; ask the owner not to touch anything else until the end |

## 4. Usage and pace
- `get_usage` every 2 h and at every end of block, never on every pulse.
- Wait mode: background Bash `sleep 7000; echo wake` (timeout 7 200 000), re-armed until `resetsAt`. Each wake-up = 1 `get_usage`.
- Limit cutting in mid-edit: on resume run `--quick`; if it broke, restore from `snap/<F>/r<N>_pre/` and relaunch the block
  from the cut round. `resumeFromRunId` only works in the same session.

## 5. Reading results without spending
```python
# next tickets of the block (the task output is not always pure JSON)
import json
last=None
for l in open('<transcriptDir>/journal.jsonl'):
    d=json.loads(l); r=d.get('result')
    if d.get('type')=='result' and isinstance(r,dict) and 'approved' in r and 'tickets' in r: last=r
```
Lean tickets for the args: `[{id, owner, severity, gate}]` (gates given as a list become one comma-separated string).
