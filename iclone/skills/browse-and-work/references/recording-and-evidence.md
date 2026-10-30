# Recording, screenshots, evidence

A browsing task is finished when the owner can check it without repeating it.

## The recording that actually runs here

`browser_harness` records a session as a **folder**, not a video:

    $BH_AGENT_WORKSPACE/recordings/<name>/
      meta.json      {name, title, started}
      events.jsonl   one JSON object per action — helper, coords/text, url,
                     viewport, focused-element box, frame filename
      0001.jpg …     a viewport screenshot after each action

Three helpers, pre-imported into every `browser_exec` call:

| Helper | Signature | Notes |
|---|---|---|
| `start_recording` | `(name=None, title=None)` | Returns the directory; survives across calls |
| `stop_recording` | `()` | Ends it |
| `recording_dir` | `()` | Where the active one is going |

Only helpers that **change the screen** produce a frame — `js`, `page_info`
and `capture_screenshot` do not, so an inspection-heavy session does not bloat
into hundreds of identical frames. Recording failures are swallowed by design:
they must never break the run, which also means **a recording can silently not
happen**. If a recording matters, check `recording_dir()` rather than assuming.

`BH_RECORD=0` in the environment disables it even against an explicit
`start_recording()`.

### Making it automatic, once

The harness has its own auto-recording preference, and it is the only switch
that records without the agent remembering to:

    terminal(command="browser-use recordings enable")    # or `disable`
    terminal(command="browser-use recordings")           # status + recent sessions
    terminal(command="browser-use recordings --latest")  # the newest directory

Turn it on when the owner wants every session kept; `start_recording()` stays
the way to record one session on purpose.

### Turning a recording into an MP4

The harness ships the pipeline — do not hand-roll ffmpeg over the frames:

    terminal(command="browser-use video init <recording>")
    terminal(command="browser-use video review <recording>")
    terminal(command="browser-use video export <recording> --reviewed")

`review` compiles it for you to check before `export` writes the verified MP4.

## When to record

**Record when the owner asked to see the work**, when the task is long enough
that a summary will not carry it, or when you are doing something on their
behalf that they may want to audit later.

Honour the owner's standing intent: check `browser.record_sessions` at the
start of a browsing task —

    hermes config get browser.record_sessions

— and when it is `true`, `start_recording()` at the top of your first
`browser_exec` call. That config key is the iclone os titlebar ring/disc glyph
and the Settings → Browser field; it drives the built-in browser path
automatically, but **in Browser-Use CLI mode nothing reads it for you** — you
are the one who honours it. Tell the owner the directory when you are done.

## Screenshots

`capture_screenshot(path=None, full=False, max_dim=None)` saves a shot and
prints its path. Use it whenever the claim is visual — layout, a chart, a
canvas, "the button is greyed out" — because a DOM query cannot see those.

`full=True` for the whole page rather than the viewport. `max_dim` to keep a
large page a reasonable size.

## Turning a recording into a video

That is a separate job — `browser_harness` points at its own
`interaction-skills/make-video.md`. Do not hand-roll ffmpeg over the frames
unless the owner asks for a video and that skill is unavailable.

## Privacy — read before recording, always

On this machine the browser carries the owner's **real logins** (see
`browser-session.md`). A recording therefore captures whatever those logins can
see: mail, dashboards, account pages — and with headed mode on, anything the
owner types into the visible window while it is running.

- Never share, upload, attach or publish a recording without the owner asking
  for that specific one.
- Do not record a session whose purpose is personal unless they asked.
- If a recording caught something sensitive by accident, say so and delete the
  folder. Do not leave it and hope.
- `events.jsonl` stores typed text. The recorder masks some of it (`_mask`),
  but treat the trace as sensitive, not as sanitised.

## What is NOT evidence

- **A helper returning without an exception.** `click_at_xy` dispatching means
  a click happened at a coordinate, not that the page accepted it.
- **Re-running the task "to check".** Re-running a submit submits twice.
- **A wall of output.** Print the two or three lines that carry the proof —
  `page_info()` after the action, the confirmation text, the new row.

## The check before you report

1. `page_info()` (or a targeted `js`) shows the end state you are claiming.
2. Nothing in the console contradicts it.
3. The evidence the task deserves exists and you have said where it is.
