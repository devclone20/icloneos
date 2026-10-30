# Gates — how a Camera & Action job proves itself

Harness: `templates/gates-harness.mjs` (CDP, headless Chrome with a `tag`-ged profile, `--force-color-profile=srgb`,
`--autoplay-policy=no-user-gesture-required`). Page-side tools in `window.__g`: `keep / keepUI / keepFrame` (grab the page canvas, the
recorder's canvas, the video's own canvas), `decode(id, times)` (the take in a `<video>`, seeked, drawn — with time limits so it can
never hang), `mad` (mean abs difference over a rect, 0–255), `diff` (pixels that differ at all + their box, optional skip rects),
`opaque` (pixels with alpha on the recorder's canvas), `red` (the recorder's red), `ink` (the engine's ink + its box), `rate(ms)`
(the display's real rate). World rects → page canvas px: `(V.ox + x·V.P)·V.dpr`; → video px: `plan.view`.

Run them on every target page; `check` of a build runs the quick set; full suites on the pages that matter; a fresh critic reruns them.

| id | name | how | pass when | why this threshold |
|---|---|---|---|---|
| 00 | no page error | `window.__errors` after every session | empty | the recorder must never throw into the page (notes/lines too wide are pushed there on purpose) |
| 01 | scene untouched | hash the page canvas at 10–15 tour times; page built without the recorder vs with it idle vs with its window open; 2 viewports | byte-identical | architecture C promises it by construction; this is the regression net for any engine change |
| 02 | no UI in the video | `?still&t=X`, one take; frame A (nothing open), then open the window by real clicks, type into a field, re-render X → frame B; stop; decode both instants | page canvas 0 px changed; recorder canvas has the window and the island (red > 0); video A vs B where the window was < 2.5/255; video vs page canvas < 4; red in the island's place of the video = 0 | the codec floor between two encodes of one picture is ≈ 1.3/255; a reference take *recorded separately* would lie (the view changes) |
| 03 | content | the same instant before/with a take that leaves out the pointer, narrator, clock; also on a **paused** page (Space, then start) | the diff is confined to them (≥ 200 px, the clock ≥ 4 px); video = the frame without them; after the take the page is the frame it was (0 px) | proves the settings act on the frame, including a page that is not drawing |
| 04 | file | real click on Rec, real Shift+R to stop | MP4 where supported; decoded length = clock ± 10 % + 0.15 s; `frames + skipped = presented`; ≥ 90 % of the rate; **frames in the file ≥ 97 % of sent**; first frame = scene; two instants differ; copy path used at Screen size; name matches the pattern | frames sent ≠ frames kept (paid); the rate bar is relative to what the display presented |
| 05 | preview / save / delete | thumbnail → preview (`<video>` over the well, ± 1 px) → Save… with `showSaveFilePicker` stubbed → a second take → window opened at once (thumbnail gone, no thumbnail target inside the window) → Recordings lists both → × twice → Delete all twice | name and bytes handed match the take; one click never deletes | the thumbnail once covered the window and ate the second click of Delete all |
| 06 | hold | page paused (Space) 3 s | ≤ 14 frames (heartbeats), video length = take ± 0.4 s, still < 2.5/255, equal to the page canvas < 4 | a page that draws nothing must give a still video of the right length |
| 07 | frame | 1080p 16:9; 1080 9:16 + margin 10 % + whole tiles; 720 1:1 | the plan's size; 0 dark px outside the laid-out scene; the scene fills its rect; whole tiles are integers; margin kept; drawn not copied; video = frame < 6/255 | never a crop; tiles drawn at the video's resolution |
| 08 | keys | Shift+S opens; capture a shortcut: plain key refused, Alt+K taken, starts a take; Shift+P pause/resume; Esc on `document.body`: held 0.7 s with an app window open | the take stops by "esc" and the app's window is still open; a tapped Esc closes it and the take goes on | a held Esc must not change the film before the stop |
| 09 | recovery | a take, reload the page at 6.6 s | a "Recovered" take within 20 s that decodes; its row in Recordings whole, with a thumbnail read back | MP4 slices arrive at keyframes (2 s): 6.6 s holds 3 |
| 10 | countdown | Countdown 3, click Rec | a large red digit on the recorder's canvas (red ≥ 40 px), then a take; 0 red px in the middle of the video's first frame | the countdown is UI |
| 11 | WebM | Format WebM | a WebM that decodes, its length found | MediaRecorder writes no duration |
| 12 | tour take | (on a page with a short tour) Record the tour; mouse moves and clicks; Page → Pause 1.5 s; Restart | locked (mode stays tour, the recorder shows a pointer); the pause pauses the take; Restart refused with a note; the take = the tour ± 0.6 s, video ± 5 %; first/last frame empty field, middle full; named `_tour_` | a tour take must be exactly one pass |
| 13 | pause | Shift+P for ~2 s in the middle; instants read on the page's own clock | take length = recording time ± 0.45 s, video ± 0.55 s | a slow harness made a wall-clock version fail falsely |
| 14 | rate | 30 fps on a 60 Hz display | ≤ 31.5 fps encoded; ≥ 27 when the display is fast; length right | the slot grid |
| 15 | two paths | the same still instant copied (Screen) and presented again (`debug.own`) | 0 px differ, copy = page canvas | the fast path must not change the picture |
| 16 | settings | set by real clicks and typed digits, reload, open another page of the series | kept and shared | one key per origin |
| 17 | series | `index.html?rec=tour&chain=index.html&back=index.html` | two tour takes, back with Recordings open | the chain hands itself on |
| 18 | off | `?camera=off` | no recorder object, no canvas of its own, no error | embeds and review tools |
| 19 | small window | 1024 × 640 | the island and the whole window inside the page; every target reachable | |
| 20 | cost | the display's rate idle (before and after) vs recording Screen vs recording 1080p | recording ≥ 80 % of idle — **valid only** when both idle readings ≥ 58 Hz, within 3 %, load < 50; else "not measurable now" | another session recording at the same time halves everything (paid) |
| 21 | hover | your own session, the app's panel open, the recorder's window over it; pointer inside the window moved onto a card below | 0 px of the page canvas change | the app tested the pointer's place, not `hidden` (paid) |

## Writing a gate well
- Measure **inside one take** (two instants), never against a separate take.
- Each gate prints its numbers on success too (they go into the rounds log and the report).
- Every wait has a limit and says where it stopped (`decode` once hung forever on a video that never loaded).
- Real input through CDP (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent` with modifiers 1 Alt · 2 Ctrl · 4 Meta · 8 Shift); Escape dispatched in the page.
- Timing-sensitive gates run alone on a quiet machine (`uptime`); never while another recording runs.
- A page-specific behaviour (the index keeps its own Finder window) gets a fair branch, not a weaker gate.
- What the gates cannot see is written down ("not covered: renderLive against the delivered page").
