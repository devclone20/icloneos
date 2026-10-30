# RULES — every parrallello agent obeys these (read once, at the start)

1. **Fresh agent per task.** Ceiling: **≤ 60 tool calls and ≤ 120 k context**. At the ceiling, write a handoff note (≤ 15 lines) to
   `CONTROL/local.nosync/handoff/<front>_<owner>_r<N>.md` and stop. Never "just a bit more".
2. **Never read big files whole.** First `python3 CONTROL/run/tools/codemap.py <file> [--grep PAT]` (function/class line ranges), then
   `sed -n 'a,bp'` of only the functions to change, and `grep -n` to locate.
3. **No command output > 30 lines in context.** Long things run through `CONTROL/run/tools/q.sh <cmd>` (full log to
   `CONTROL/local.nosync/logs/`, prints exit code + last 15 lines). Tests with `--quiet`/`| tail`; big JSON via `jq`/python fields.
4. **Long machine work = 0 tokens.** Renders, builds, caches, benches: `python3 CONTROL/run/tools/bgjob.py start <name> -- <cmd>`;
   wait with `bgjob.py wait <name> --max 540` (≤ 8 lines; each wait ≤ 9 min keeps the cache warm). Never poll logs.
   **Before you return, wait for or `bgjob.py kill` every job YOU started** — orphan jobs duplicate the critic's run and hold slots.
5. **Numbers first, eyes last.** Automatic gates decide. Images only at the end, only as contact sheets
   (`CONTROL/run/tools/sheet.py out.png in... --cols N --width 1600 --labels`), at most 3 per agent. An image read early is re-read on
   every later call.
6. **Iterate small.** Iteration renders ≤ 480 px wide and only the affected tiles; gates `--quick` while iterating; full size / full
   set and `--full` exactly once at the end.
7. **Files, not conversation.** Tickets JSON, handoff notes ≤ 15 lines, verdict JSON. Nobody reads another agent's transcript.
8. **Measure once, reuse forever.** Every new critic measurement goes INTO the front's gate script (dated, with the round). Caches are
   deterministic and keyed: reuse; never delete a current key (manifest before cleaning).
9. **Single writer per file.** Edit ONLY the files in your list. Own scratch: `CONTROL/local.nosync/scratch/<front>_<role>_r<N>/`.
   Shared tools live only in `CONTROL/run/tools/` (never delete or edit another agent's tools).
10. **Snapshot before editing.** `cp` the files you will touch to `CONTROL/local.nosync/snap/<front>/r<N>_pre/` (cp, not git).
11. **Performance only in an exclusive window.** `python3 CONTROL/run/tools/gpu_lock.py acquire --who <label> --max 900` → measure →
    `gpu_lock.py release`. Never hold > 15 min. Exit 4 = window was not clean → mark the measure "unclean" and repeat later. Headless
    Chrome with its own profile in scratch, closed by CDP `Browser.close`, never by kill.
12. **Outputs are for machines:** JSON, numbers, paths. The human report belongs to the lead only.

**Owner rules:**
- never `git commit`/`push` (the lead does);
- never handle credentials;
- never kill processes you did not start (other sessions run renders/servers);
- downloads only CC0 / CC BY / CC BY-SA / PD, with a credit line;
- the project root only through the absolute path you were given;
- the project's own rules (UI language, time scale, etc.) are in its plan §8.
