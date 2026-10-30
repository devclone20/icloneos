# bench — the performance instrument

One command measures the parts of icloneOS whose speed a user feels or a release depends on, judges each against a
written budget, checks that each measurement can see a known slowdown, and writes a table. Results never enter the
repository: they carry machine data.

```sh
node bench/run.mjs                      # every row, --quick
node bench/run.mjs --full               # the final measurement (n >= 5 per sample set unless a row declares less)
node bench/run.mjs --only crypto.ops,pty.pane_bus --quick
node bench/run.mjs --control-only       # only the negative controls
npm run bench -- --full                 # same, from the repository root
```

Options: `--only <id>[,<id>]`, `--quick` | `--full`, `--control-only`, `--out <dir>`, `--keep` (keep each row's scratch
directory), `--rows <dir>` (another rows directory; the harness tests use it).

Output: `<out>/results.json` (schema `bench/2`) and `<out>/table.md`, generated from the JSON and never edited by hand.
Exit codes: `0` every control fired, `3` a control did not fire (the whole run is invalid), `2` harness error (a row threw,
returned 0 / NaN / too few samples, a secondary budget or a control contradicted its own numbers, or the exclusive window
could not be released). With nearest rank, the p95 of fewer than 20 samples is the sample maximum: the table prints
`p95=max` then.

Every child process a row starts runs in its own process group. A timeout kills the whole group (SIGTERM, SIGKILL after
5 s); SIGINT or SIGTERM of the runner kills every live group, releases the exclusive window and removes the scratch
directories (unless `--keep`).

## Environment

| variable                                              | meaning                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BENCH_OUT_ROOT`                                      | where `<YYYYmmdd-HHMM>-<sha>/` result folders go when `--out` is not given (default: the OS temp dir).                                                                                                                                                                                                                   |
| `BENCH_PYTHON`                                        | the interpreter for Python rows and the Python test suites. Default: `venv/bin/python` of the checkout, else `python3`. Use the runtime's pinned CPython (the one `pm/lock.json` names) or a venv on it with pytest. The JSON records only how it was chosen, its version and its sha256.                                |
| `BENCH_GPU_LOCK`                                      | path to the machine's exclusive-window tool. When set, every row acquires the window (`--who bench:<id>`, `--max 900`) before it measures and releases it with the same `--who` after; a refused release stops the run (exit 2). A row longer than 15 minutes renews the window between its phases (`ctx.window.renew`). |
| `BENCH_CACHE_DIR`                                     | persistent artifact cache of `install.first_launch` (filled once from the real network by its `prime` step).                                                                                                                                                                                                             |
| `BENCH_PYTEST_DESELECT`                               | file of pytest node ids known to fail on the base (one per line, `#` comments) that `gates.suite` deselects exactly.                                                                                                                                                                                                     |
| `BENCH_INSTALL_BANDWIDTH`, `BENCH_INSTALL_LATENCY_MS` | the loopback network of `install.first_launch` (default 12.5 MB/s, 20 ms per request).                                                                                                                                                                                                                                   |
| `BENCH_TEST_GPU_LOCK`                                 | harness tests only: the real exclusive-window tool, exercised against a lock file in a temp dir. Unset, the two lock-release tests skip.                                                                                                                                                                                 |

## What "unclean" means

Before each row measures, the harness waits for the machine to settle: it polls the 1-minute load average every 10 s
until it is under 4.0, for at most `--cooldown-max` seconds (default 600); the wait and the load at start are in the
row's `cooldown` and `load`. If the cap is hit, the row runs anyway and is unclean.

The exclusive window can take minutes to acquire after the cool-down, so the load is sampled again the moment each
window is held, immediately before the row measures and before each part that renews its window (`ctx.window.renew`).
A sample at or above 4.0 there makes the row unclean and names the part. `load.before` (end of the cool-down),
`load.at_measure` (window held, measuring starts), `load.after` and each window's `load_at_acquire` are in the JSON.

A row can also carry a validity guard (`extra.validity[]`, the same shape as a secondary budget). If any check of it
fails, the row is `INVALID`, not `MISSES`: the run itself does not count, so its number decides nothing
(`not counted (invalid: …)`).

A measurement is `unclean` when the machine was not quiet: load average at or above 4.0 when the row started or when any of its windows was taken, the exclusive
window could not be held (or was not used), or a hold outlasted its promised `--max`. The row is still reported with its
verdict and the reason, but its decision is `repeat (unclean: …)`: an unclean number decides nothing. The table header
says how many rows are clean.

## Verdicts and decisions

Each row has one primary budget (`budget.stat`, e.g. `cold.p95 <= 45000 ms`) and may report secondary budgets in
`extra.secondary[]` as `{name, value, unit, budget, op, ok, reason}`. The harness recomputes every `ok` from
`value op budget` and refuses a row whose own `ok` disagrees. A row MEETS only when the primary budget and every
secondary budget are met; otherwise it MISSES. A row that cannot be measured on this machine is UNMEASURABLE with the
reason, never a number.

Decision column (clean rows only): MEETS → `stays in <lang>` with the number; MISSES → `candidate for a native port (cpu
deficit …)` when the row's `miss_class` is `cpu`, else `fix in place (<class>): …` for `io`, `network`, `memory` or `browser` (a miss that a
rewrite in another language would not fix). A row may class its miss from what it measured by returning
`extra.miss: { class, cause }` (install.first_launch does, from its dominant stage); the decision then ends with
`; cause: <cause>`.

## Rows

- **install.first_launch** — the runtime install of the first launch, per package and stage (download, unpack, stage,
  verify, publish incl. tree digest): the tool closure (ffmpeg, node, npm, python, ripgrep) + the optional defaults
  (agent-browser with chromium, cua-driver), then the venv stage (`uv sync` of `uv.lock`) in a throwaway APFS clone of
  the checkout. Samples are `first_launch_total = install_total + venv_stage`, network-free: pinned artifacts come from
  a loopback Range server at a fixed bandwidth and latency, and `uv` runs from the uv cache the app bundle ships
  (`uv-cache/`, placed the way `pm.packages.uv_cache_dir` places it), with every child's HTTP(S) proxy pointed at an
  unreachable loopback port so a cache miss fails the sample instead of reaching the index. One real-network venv
  sync (which also builds that cache) is reported in `extra.real_network`, not budgeted. Budget 45 s; secondary: node
  unpack <= 4 s, npm unpack <= 3 s. Before each sample (this row only) the 1-minute load must drop under 4.0, waiting
  at most 180 s with the window released; every wait is in `extra.sample_cooldowns` (the control's in its `detail`),
  and a wait that hits the cap makes the row unclean. Stages: every sample records its own timeline (each download
  call with the packages whose artifacts it fetched, each hook span, the order `_install` was entered), and a download
  is credited to the package it fetched, not to the one installing when it ran. Per-stage times (download, unpack,
  stage, verify, publish, `other` = the remainder, never negative) are reported only when every cold sample ran
  serially, that is when every download fetched one package, lies inside that package's own install span and
  overlaps no other package's download, unpack or verify; otherwise (an installer that prefetches the next archive)
  `extra.stages` is `not attributable (downloads overlap)`, only the hook spans are kept, and `extra.miss` is classed
  from those: the cold first launch not covered by them is one `unattributed` bucket, and when it dominates the class
  is `unattributed` (no class, not an assumed `network`). Control: a 2 s server delay on the artifact of the first
  package in install order (read from the base sample's `order`; nothing precedes that download, so no prefetch can
  hide it), 3 cold first launches against 3. Two checks, both required: `first_launch_total` grows by >= 1.6 s
  (median against median), and in every delayed sample the first package's own download span grows by >= 1.6 s
  against the base median, so shared bandwidth cannot hide the delay in the total. The control first runs its own
  untimed real-network venv warm-up, because uv's package-index entries stay fresh for about 10 minutes and the venv
  samples run with the network blocked; it also works with `--control-only`.
- **gates.suite** — wall clock of one complete gate test suite: `vitest --project electron`, `vitest --project ui` and
  the Python core suites (`tests/pm`, `tests/hermes_cli` through `scripts/run_tests.sh --file-retries 0`, known
  failures deselected by exact node id), all three in a throwaway APFS clone with HOME, HERMES_HOME and TMPDIR under
  the row's scratch; the clone carries no `.git` link back to the checkout. cold = first suite, warm = second suite
  (not pooled); the exclusive window is renewed before each part. Budget 30 minutes. Failures are reported, not judged
  by name (per part and sample: the count, the first 50 ids, how many `bench/known_failures/gates.suite.electron.txt`
  lists, the full list in the row scratch). A validity guard closes the ways a run could be fast by running less; a
  run that breaks it is `INVALID`. Per part, on the worse of cold and warm, from each runner's own structured report
  (vitest JSON; per-process records of the pytest plugin): 0 errored files (only electron files that errored in the
  pinned run and on main too are set apart); executed tests equal collected tests (a run cut short executes fewer);
  collected and passed each at least 98 % of the pinned run (`bench/baselines/gates.suite.collected.tsv`, with where
  the counts came from and the state they describe): a test that fails or skips before its body runs does shorten
  the suite, and the passed floor catches it; cold and warm collect the same counts. The row reports duration,
  collected, executed, passed, failed and skipped per part and sample. Control: a 3 s sleep preloaded into vitest, 3 runs against 3, must show up.
- **pty.pane_bus** — round trip of one pane-bus message through the real broker and its Unix-socket HTTP transport:
  pane B waits in `recv --wait`, pane A sends, the clock stops when B has it. Budget one 60 Hz frame (16 ms p95). Also
  reports messages lost under 8×400 concurrent sends (must be 0) and heap per pane (via `broker.run`, transport
  excluded). Control: 20 ms injected before `broker.run` must show up.
- **spawn.policy_overhead** — the extra cost of spawning a command through the app's macOS spawn policy vs a plain
  spawn: the same `/usr/bin/true` through `backend.spawn` (generated profile applied by the system's profile runner) and
  plainly through bash, paired, in a throwaway HOME. Budget:
  overhead p95 <= 50 ms. Also counts, for 3 planted files × 5 profile classes, how many reads were refused in this run,
  and checks that an in-scratch read succeeds and that the planted file is readable without the profile. Controls: a
  fake profile runner that sleeps 50 ms and drops the profile must add the time and drop the refused share to 0.
- **crypto.ops** — per-operation cost of key loading, ES256 mandate signing, x402 EIP-712 signing, spawn-key HMAC and
  the fsync'd audit-chain append; the headline is the slowest (the fsync: `miss_class: io`). `extra.memory_safety` is a
  cited audit of where key bytes live. Controls: a 2 ms delay inside unseal must appear in key loading; the audit
  append without fsync must cost at least 50 % less.
- **index.workspace** — UNMEASURABLE: the app keeps no workspace index. The part that exists is `fs.read_dir`.
- **fs.read_dir** — a full walk of a synthetic 100 k-file / 1101-folder tree through the project tree's own folder
  reader (`readDirForIpc`, 16 folders in flight). The tree is generated just before, so the OS file cache is hot in every
  sample (a cold-disk walk needs `sudo purge` and is not measured). Budget: warm p95 <= 1 s; secondary: re-reading one
  folder after a file is added <= 100 ms. Control: a 2 ms delay per readdir (the reader's `options.fs` seam) must slow
  the walk by at least 0.8 × 68 sequential reads per worker.
- **assets.inft_cards** — an offscreen Electron renderer paints a Book of a thousand distinct 512 px PNGs through the real
  thumbnail limiter (bundled with esbuild); first paint = first 50 cards decoded + two frames; also all of them through a
  100-card window and peak renderer memory (<= 300 MB, `miss_class: browser`). Every sample asserts that every card
  loaded and none failed. Secondary: first paint at 100 ms gateway latency per image. Controls: +150 ms per image at the
  local server (3 against 3), and a server that breaks 2 images must turn the row red. Note for Electron harnesses: an
  ESM main must not top-level-await `app.whenReady()` (`ready` fires only after the module evaluates, so it deadlocks).
- **acp.watchdog** — soak of the ACP work watchdog on a real `setInterval`, accelerated 600× (virtual clock +30 s per
  poll): cycle-time drift per poll in ms (0 or slightly negative is a valid sample), budget 300 ms = 1 % of the 30 s
  production period; poll cycle time, cumulative drift and heap growth per production hour (<= 1 MB/h, linear fit of
  post-gc heap samples). Control: blocking the loop past its period must show as drift.

## Adding a row

1. Create `bench/rows/<id>.mjs` (dotted lower-case id; the file name must equal the id) exporting the row object:
   `id, part, what, hot_path, unit, lang ('TypeScript' | 'Python'), miss_class ('cpu' | 'io' | 'network' | 'memory' | 'browser'),
budget {value, op, stat, reason}, risk, failure_mode, measure(ctx), control(ctx)`, and optionally `min_n` with
   `min_n_reason`, `allow_nonpositive: { reason }` (a deviation or a paired difference, which may be 0 or negative; only a row
   that declares it may report a sample <= 0).
2. `measure(ctx)` returns `{ cold: number[], warm: number[] | null, extra }` (or `{ unmeasurable: 'reason' }`). Define
   cold and warm in `what`. Never hard-code or invent a sample.
3. `control(ctx)` returns one control or an array: `{ name, expected, observed, value, threshold, op, ok }`, plus
   `base` and `variant` sample arrays (n >= 3 each) for a sensitivity control, whose `value` must be
   `median(variant) - median(base)`. The harness recomputes `value` and `ok`. A control that does not fire invalidates
   the run.
4. Helpers of a row (child processes, Electron mains, Python sides) are named `bench/rows/_<id>.<role>.mjs`; files
   starting with `_` are never imported as rows. Child processes that load the app's TypeScript import
   `../lib/ts-hook.mjs` first. A Python side may be `bench/rows/<id>.py`. Start processes only through `ctx.sh` /
   `ctx.python` (process group, timeout, abort); use `percentile` / `median` from `lib/stats.mjs`.
   A child hands its result back through `lib/child_result.mjs` (`writeResult` in the child, `newResultFile` /
   `readResult` in the row), never on stdout: on macOS a pipe is asynchronous, so a child that prints a large JSON line
   and exits can lose everything past the 64 KiB pipe buffer.
5. `ctx.sh` gives every child HOME, HERMES_HOME and TMPDIR under the row's scratch (`ctx.scratchEnv(extra)` builds that
   env); anything that writes into the project root runs in an APFS clone (`cp -c -R`) under `ctx.scratch`.
6. `node --test bench/test` must stay green; `bench/` stays outside the runtime artifact and the app bundle
   (`apps/desktop/scripts/runtime-artifact.mjs` declares it).
