# The recorder core — every function, what it must do, and why

Code: `templates/recorder-core.js` (verbatim from the tested example series recorder). Below, the contract of each piece.

## State
```
st = { mode: idle | countdown | recording | saving, cd, take: { kind: free|tour, auto, t0, end }, paused: { at, why } | null,
       hover, press, drag, over, toast, panel, win, sec, scroll, edit, capture, note, arm, esc, tickAt }
P (the plan of the running take) · comp/ctx (output canvas) · stream/track · mr · chunks · pend (IndexedDB writes) · recId · seq
born (the take's context: page, title, take, size, fps, at) · t0, lastSlot, lastAt, dirty · stats · last · lastFrame · lastA (last scene args)
```

## plan()
Inputs: the page canvas size (device px), settings (format, size, aspect, margin, grid, fps, quality, mbps, pace).
- format: `auto` → `mp4` if `MediaRecorder.isTypeSupported('video/mp4;codecs=avc1')`, else `webm` (vp9 → vp8 → plain); a forced format the browser lacks falls back and says so (`fallback`).
- size: `screen` = the largest frame of the aspect the canvas holds (Screen + Screen = the canvas itself); `720…2160` = the short side; × k1 = min(1, 4096 / long side, √(4096·2304 / area)) (`clamped`); even numbers.
- the scene in the frame (architecture C): `P = min((w − 2m)/WW, (h − 2m)/WH)` (m = margin % × short side); Tiles "Whole" → `max(1, floor(P))` and rounded offsets; `same` = the frame IS the page canvas (copy path).
- bitrate: `QUALITY[good|better|best] = 5|10|20 Mbps at 1080p60`, × pixels / (1920·1080), × .6 at 30 fps, clamp 2–200; custom = typed.
- `summary()` turns it into the Record page's lines: `W x H · fps · MP4 H.264` / `≈ M Mbps · up to N MB/min` / `scene … · tile …` + warnings.

## The store (IndexedDB `<project>-rec`, v1)
- `recordings` keyPath `id` (blob, JPEG thumb, facts: name, ext, mime, codec, w, h, fps, ms, bytes, at, frames, page, title, take, recovered).
- `chunks` keyPath `[rec, seq]` — a running take's slices, written as they arrive (`ondataavailable`).
- `put(r)` writes the recording AND deletes its chunks in one transaction; returns false when there is no storage (then the take lives in memory for the visit and a note says "No storage here: save this take now").
- `recover(alive)`: chunk groups with no recording whose last write is over 10 s old (not a take alive in another tab) → a "Recovered_<name>" recording; returns `out.wait` = ms until younger slices can be judged → `recoverPass` reschedules itself (a page reopened seconds after a crash still gets its take). A recovered take gets a thumbnail and its size read back from one frame of its video (`thumbOf`) and the list is reloaded (the list holds the store's copies).
- Settings: one localStorage key `<project>.camera.v1` holding only the values that differ from the defaults, validated on every read (enums, ranges, the shortcut regex, the pattern), applied at once, synced across pages by the `storage` event. Pages of one origin share it (Chrome `file://` included).

## Shortcuts (one capture-phase `keydown` listener on window)
Order: (1) a shortcut being captured (Escape cancels; modifiers alone wait; plain keys refused — "Add Shift, Alt or Ctrl"; a combo already used by another of the recorder's shortcuts refused) · (2) a field being typed (every key is its own; ⌘V comes through the `paste` event) · (3) DOM inputs: ignore · (4) **Esc while recording/countdown**: eat it; a countdown is cancelled at once; in a take start the hold timer, and on **key-up** a short tap does the page's own Esc (close the recorder's window, or the app's window) — a held Esc must never close a window in the film before the stop · (5) the record / pause / window shortcuts (`comboOf(e)` from `e.code` + modifiers) · (6) the preview is modal (Esc keeps, Enter saves, Space plays) · (7) a tour take swallows the page's keys · (8) with the window open, the page's keys are swallowed (arrows walk the sections). `stopPropagation` in the window's capture phase keeps the page's own bubble listeners out.

## start(kind) → begin()
- refuses when busy, when the browser cannot record, and a tour take on a `?still` page.
- countdown (not on a still page, not on autostart) → `st.mode = countdown`, `tick()` begins it.
- `begin()`: plan, the output canvas `{ alpha: false }`, recId, `born`, stats `{ frames, presented, skipped, retaken, held, copied, drawn, bytes, chunks }`, `t0`, mode recording.
  - tour take: set `take.t0/end` FIRST, then `mode = tour; paused = false; tourOffset = now − s; renderTour(s)` → that frame is the first (the encoder starts inside it), `tourOffset` set again after.
  - a page that is not drawing (paused or still): `redraw()` so the frame carries the take's Content settings, then it is the first.

## encoder()
`comp.captureStream(pace === 'fixed' ? fps : 0)` · `new MediaRecorder(stream, { mimeType, videoBitsPerSecond, videoKeyFrameIntervalDuration })` · `ondataavailable` → chunks + store slices with the take's facts (so recovery can name it) · `onerror` → fail with the encoder's words · `mr.start(slice)` · `t0 = now` (the take's clock starts with its first frame). Called from inside the first `take()`.

## scene() / take(force) — the slot grid
```
lastA = { t, sweepIn, sweepOut }                       // always (a paused page re-presents from it)
if (recording && !paused) take(false)
take: slot = mr ? floor((now − t0)·fps/1000 + .25) : 0; presented++
      due = slot − lastSlot; if (due < 1 && !force) { dirty = true; skipped++; return }
      lastSlot = due >= 2 ? slot − 1 : max(slot, lastSlot)          // one slot of credit after a gap
      shoot (copy page canvas | present bitmap at video size)
      if (!mr) { encoder(); t = t0 }
      if (pace !== 'fixed') track.requestFrame(); frames++; lastAt = t; dirty = false
      thumbnail candidate: the first frame past 1.5 s (free) / 8 s (tour — a tour ends on an empty field)
```

## hold(on, why) — pause
On: `mr.pause()`, `st.paused = { at, why }`, a tour take pauses the page's tour clock (`paused = true; pausedAt`). Off: `t0 += d; lastAt += d`, `mr.resume()`, the tour clock shifted (`tourOffset += now − pausedAt; paused = false`). Triggers: the pause pill, Shift+P, `visibilitychange` (hidden → pause with why "hidden", visible → resume + a note "The page was hidden for N s: left out of the video"), and `tick()` finding the page paused under a tour take (why "page").

## tick() — once per display frame
Esc held ≥ 700 ms → stop("esc") · thumbnail held while hovered · countdown end → begin() · nothing more while not recording or paused · tour take: the page paused under it → hold; tour time ≥ end − ½ frame → `tourDone()` (render the last frame, take it, stop("tour")) · free take: maximum length → stop("max") · a dirty frame on a page that is not drawing → retake · heartbeat: `resend()` every 500 ms with nothing new.

## stop(why)
Countdown → cancel. No encoder yet → "Nothing was recorded". Else: `elapsed` (frozen at the pause if paused), mode saving; `resend()` + 80 ms (unless paused) → `mr.stop()` + await `onstop` + await the slices → Blob → **framesIn(blob)** (MP4: walk top-level boxes, for each `moof` walk `traf` → `trun.sample_count`; a few bytes a fragment) → `r.frames` = frames in the file → JPEG thumbnail (the candidate, or the last frame) → `STORE.put` → `last = { …, frames (sent), encoded (in the file), counted, fps (encoded/s), sent (sent/s), why }` → a slow take note (`< .9 × fps`: which of the two) → teardown, mode idle, the page given back (tour: restart from 0; a paused page: `redraw()`), reload the list → a series goes on (`?rec=tour&chain=…`) or ends, else After: preview / thumbnail (a note when the window is open) / download.

## save(id, direct)
`showSaveFilePicker({ suggestedName, types })` called straight from the gesture (Save… = Ask where), else `<a download>` with an object URL revoked after 30 s. Notes: "Saved <name>" (a tail cut in its middle), "Saved to Downloads", "Could not save: …".

## Preview
One `<video controls playsInline preload=auto>` element, `position:fixed`, placed every frame over the preview's well (CSS px from the page's view), shown only while the preview is open; a WebM's duration found by seeking to 1e7 once.

## File names
Tokens are the page's own context (`{page} {title} {take} {date} {time} {size} {fps}` for the example series; `{scene} {target}` for Sample Project; `{cat} {name} {folder} {kind}` for the Showcase). Slug: NFKD, no accents, `[^A-Za-z0-9._-]` → `-`, collapse, trim, ≤ 120 chars, never empty (falls back to the project's name).

## state() / diag()
`window.__camera()` returns everything a gate needs: mode, take, paused, elapsed, countdown, locked, plan, stats, last, lastFrame, settings, window/island/preview/well rects, view `{P, ox, oy, dpr}`, hits with their CSS centres, caps, tour length, page name, chain, video rect, recordings, usage. Diagnostics lines: while recording `REC mm:ss · fps · frames` / `over the rate · retaken · held · hidden` / `MB · Mbps · slices stored`; after: `Last take: W x H · mm:ss · MB` / `N frames in the file (M sent) · fps · Mbps`.
