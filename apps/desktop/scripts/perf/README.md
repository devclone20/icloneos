# Desktop perf harness

One systematized way to measure desktop rendering/interaction performance,
diff it against a committed baseline, and fail on regressions. It replaces the
dozen one-off `measure-*` / `profile-*` scripts that each reinvented the CDP
client, arg parsing, stats, and output (and never had a baseline).

## Quick start

```bash
# Isolated instance (recommended) — no running app or LLM credits needed.
# Its own --user-data-dir + HERMES_HOME means it never collides with `hgui`.
npm run perf -- --spawn

# Or: launch an isolated instance once, attach repeatedly (faster iteration).
npm run perf:serve            # leaves an instance on :9222
npm run perf                  # attaches, runs the CI suite, gates on baseline

# One scenario, with a CPU profile:
npm run perf -- stream --cpuprofile --tokens 800

# Representative PRODUCTION numbers (minified React, not the ~3x-slower dev build):
npm run perf -- cold-start stream keystroke transcript --spawn --prod

# Re-capture the baseline on your reference device, then commit baseline.json:
npm run perf -- cold-start stream keystroke transcript --spawn --prod --update-baseline
```

## Dev vs prod

By default the harness measures the **dev** renderer (fast to spin up, good for
relative regression checks). Pass `--prod` (with `--spawn`) to build a
production renderer *with the probe included* (`VITE_PERF_PROBE=1`) and measure
minified React — the representative shipped numbers. The committed baseline is
captured with `--prod`.

## Why isolation matters

The measurement this harness exists to run was historically blocked: a running
`hgui` holds the Electron single-instance lock, so a second instance quit
immediately. `--spawn` / `perf:serve` launch with their own `--user-data-dir`
(separate lock scope), their own `HERMES_HOME` (separate backend + sessions),
and their own `--remote-debugging-port`. Synthetic scenarios drive `$messages`
directly via `window.__PERF_DRIVE__`, so no LLM credits are spent.

## Scenarios

| scenario | tier | measures | replaces |
|---|---|---|---|
| `stream` | ci | streaming longtasks, frame p95/p99, mutation cadence | measure-synthetic-stream, profile-synth-stream, profile-long-stream |
| `stream --real` | backend | same, from a real LLM stream | measure-real-stream, profile-real-stream |
| `keystroke` | ci | composer keystroke → paint latency | measure-latency, profile-typing, leak-typing |
| `transcript` | ci | large-transcript mount + paint cost | (new) |
| `render-churn` | ci | per-component render attribution + store churn while N tabs stream | (new) |
| `idle-cost` | report | busy-but-silent tiles: idle commit rate, + fps while resizing / typing | (new) |
| `right-pane` | report | file tree + persistent xterm tabs under chat/terminal output and split dragging | (new) |
| `cold-start` | cold | launch → CDP → driver → first paint (fresh spawn/run) | (new) |
| `first-token` | backend | Enter → first assistant token painted (TTFT) | (new) |
| `submit` | backend | Enter → cleared → user msg painted, scroll jump | measure-submit, measure-jump |
| `session-switch` | backend | route → first-paint → settle | profile-session-switch |
| `session-load` | backend | how far a session's transcript moves after first paint | (new) |
| `profile-switch` | backend | rail click → sidebar settled | measure-profile-switch |

`ci` + `cold` scenarios need no backend/credits and are gated against
`baseline.json` (`cold-start` requires `--spawn` since it measures a fresh
launch, and must be run in its own invocation). `backend` scenarios need a live
backend (and `--spawn` or a real session/credits) and are report-only.

CPU profiling is a cross-cutting `--cpuprofile` flag on any scenario (it wraps
the run in `Profiler.start/stop` and prints a top-self-time table), replacing
every standalone `profile-*` script.

## Adding a scenario

Create `scenarios/<name>.mjs` exporting `{ name, tier, description, run(cdp, opts) }`
where `run` returns `{ metrics, detail }` (metrics = flat numbers, lower is
better), then register it in `scenarios/index.mjs`. If it's `ci`, add a
`baseline.json` entry (or run `--update-baseline`).

## Layout

- `../lib/cdp.mjs` (`scripts/lib/cdp.mjs`) — the one CDP client for every desktop script: target discovery, typing, CPU-profile wrapper, DOM selectors (tests: `scripts/lib-cdp.test.mjs`).
- `lib/stats.mjs` — percentiles, histograms, CPU-profile self-time ranking.
- `lib/baseline.mjs` — load/compare/update the baseline + regression gate.
- `lib/launch.mjs` — attach, or spawn a fully isolated instance.
- `scenarios/` — one module per measurement.
- `run.mjs` — entrypoint. `serve.mjs` — standalone isolated launcher.
- `image-attach-bench.mjs` — stage-by-stage timing of the image-attach transforms on a real image (no Electron, no LLM).
- `gateway_attach_bench.py` — times the gateway's attach RPCs against the real `tui_gateway` dispatcher while the agent build is still pending.

## Dev helpers (not benchmarks)

`scripts/eval.mjs` (one-shot eval), `scripts/reload.mjs` (hard reload + probe check),
`scripts/probe-renderer.mjs` (boot state), `scripts/probe-thread.mjs` (thread shape) and
`scripts/click-session.mjs <title>` (open a session by title) drive a running renderer
through the same `scripts/lib/cdp.mjs` client. They read the port from
`HERMES_DESKTOP_CDP_PORT` (default 9222).

## Latency budgets in the test suite (`npm run test:perf`)

Wall-clock budgets do not run in the default `vitest run` (K105): under a loaded machine they were red for reasons
that had nothing to do with the code, and a red that is always "load" teaches everyone to ignore red.

```bash
npm run test:perf          # scripts/test-perf.mjs: ICLONE_PERF=1 vitest run --project perf -t '@perf$', then a verdict
```

- The verdict is the last line and the exit code (K127, G3-5): **ok** (exit 0) only when every `@perf` test ran and
  none failed; **NOT-RUN** (exit 3) when some ran and the rest skipped for load (the line gives the count, and the
  gate prints `"ok": null`); **FAIL** (exit 1) for a failure, a file that did not load, no report, a non-zero vitest
  exit, a `@perf` test skipped without a load reason, or nothing measured at all.

- The perf project (`vitest.config.ts`, `PERF_FILES`) runs only the tests named `… @perf`: pane-bus G1 in process
  (10 000 trips, p50 ≤ 5 ms, p99 ≤ 25 ms), G1 over the socket (2 500 trips, same budget), G1 by four shell scripts through the installed `it` (≤ 25 ms
  a hop), Seatbelt G7 (spawn
  overhead p95 ≤ 50 ms) and refusal latency R2 (p95 ≤ 1 s). Files run one at a time.
- In the default run the same tests check correctness on fewer iterations and skip the budget.
- When the 1-minute load average is above half the cores, a perf test reports `SKIP(load …)`, never a pass
  (`electron/perf-gate.test-helpers.ts`). Run it on an idle machine to get a number.
