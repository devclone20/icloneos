# Traps already paid (with the date, the cause and the fix)

## The frame
- **WebGL copied outside its task** → black/stale frames (`preserveDrawingBuffer:false`). Fix: compose in the same task, from the end-of-frame hook. (Sample Project)
- **Copied at "present" with passes after it** → the pixel robots, shots and impact scenes were missing. Fix: the hook at the frame's END; `onPresent` only a flag. (Sample Project)
- **A blit of the GL canvas every frame** cost frames at 3024 × 1964. Fix: compose straight from the live canvas while moving; copy only when parked. (Sample Project, SMOOTH r1)
- **The video's first frame was black.** Fix: start the encoder inside the first frame, after it is on the output canvas. (Showcase)
- **Frame loss ~10 % from a 2 ms throttle tolerance** → slot grid with a quarter-slot lead → slot grid with one slot of credit (1–2 of ~195 lost). (Showcase)
- **The video ended on a stale frame** when the last drawn frame was skipped by the rate → `tick()` asks for it again in the next slot; one resend before stop. (Showcase)
- **A paused page ignored Content** (pointer, narrator, clock stayed in the take's frame) → the engine's `redraw()` at begin and stop. (example series critic r1)
- **A still page (`?still`) recorded a live session** after the mouse crossed it → `enterLive()` returns on a still page. (example series critic r2)
- **The app hovered under the recorder's window** (its card got a hover frame — in the video) → a pointer out of the frame is hidden AND moved to (−50, −50). (example series critic r1)

## The UI
- **The thumbnail drawn over the open window** covered its first rows and took the second click of Delete all → never with the window open; opening the window clears it. (critic r1)
- **A tour take not locked against the window's own Pause/Restart** → 22 s of frozen film on the wall clock → in a tour take Pause is the take's pause, Restart refused, `tick()` pauses the take when the page is paused under it. (critic r1)
- **Notes cut on screen** (`fit(text, 236)`) → a 340-px place, static texts measured, a wider one pushed to `window.__errors`; names and error words as a tail. (critic r2)
- **Facts lines cut / overlapping the pills by one Mac pixel**, a recovered take's suffix cut → `whole()` guard + layout; the name says "Recovered_". (critics r1–r3)
- **Toast text cut "00:03 · 11.0…"**, phone preview facts cut → wider card; drop whole facts from the end. (Showcase)
- **A held Esc closed the app's window before the stop** → Esc eaten while recording; a tap does the page's Esc on key-up. (example series)
- **Sidebar name too wide in Chicago 12** (117 px of 96) → a short side name ("Camera"), the title stays "Camera & Action". (Showcase)
- **`await` before `showSaveFilePicker`** loses the gesture → call it straight from the click. (Sample Project)
- **The preview's keys reached the app** → the preview is modal for keys. (Sample Project)
- **One-click deletes** → every delete asks twice. (critic r1)

## Measuring
- **Frames sent ≠ frames in the file.** A bench counting the recorder's `frames` said "8 takes at once keep 60 fps"; the files held 35. Count with ffprobe, or with the recorder's `framesIn()` (MP4 `trun`).
- **A separate reference take** lies (the view changes) → two instants inside ONE take. (Sample Project)
- **`JSON.stringify(promise)` = `{}`** → await in the page, then stringify. (Showcase)
- **A raw CDP Escape stalls the headless display** → `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`. (Showcase)
- **MP4 slices arrive at keyframes** (header ~2.5 s, then every 2 s), WebM every timeslice → recovery gates record ≥ 6.6 s. (Showcase)
- **Recovery never happened when the page reopened at once** (slices < 10 s old skipped) → `recover()` returns `wait` and reschedules itself. (Showcase)
- **4:2:0 chroma on 1-px tile grids** → judge fidelity per area: native size ≈ 1/255, a Showcase grid 3–6/255; thresholds from measured presets. (Showcase)
- **A light model pixel read as a red digit** → baseline grab without the digit + counts. (Showcase)
- **A wall-clock pause gate failed on a slow machine** → read every instant on the page's own clock. (example series)
- **The cost gate judged while another recording ran** (34 Hz) → valid only with steady idle readings (≥ 58 Hz, ± 3 %) and load < 50. (critic r2)
- **The null muxer reports "non monotonic dts"** on a VFR file → decode checks use `-fps_mode passthrough`. (series)
- **A decode with no time limit hung the gate run for 400 s** → every wait in the harness has a limit. (example series)

## The machine and the shared tools
- **A saturated Mac** (other sessions: load 700–960; an iOS Simulator with 316 processes) → Chrome does not start in 15–45 s, rates are meaningless → wait (`until` loop on `sysctl -n vm.loadavg`), say "not measurable now".
- **`pkill -f marks-chrome`** killed other sessions' Chromes → end only your own pids, or parentless ones; suites pass their own `tag`.
- **A start limit added to the shared `tools/chrome.mjs` was never cleared** → every headless Chrome of every session died 45 s after start for 55 min ("chrome exited null"). Test a shared tool with a blank page alive 60 s before and after editing it.
- **`close()` waited forever on a Chrome that had already died** → resolve at once when it is gone.
- **Gigabytes of takes written on the Desktop** → iCloud's file provider at 100 % CPU → intermediates in scratch, finished files only on the Desktop.
- **zsh: an unmatched glob aborts the whole `rm`** — and the deletion was reported as done → `find … -delete`, then `ls`, then speak.
- **`timeout` is not on macOS**; **headless `claude -p` is not logged in** from the desktop app (it cannot test slash names).
- **A project folder can be reorganised under you** → builders use candidate lists of folders and never create a stray one; skills point to names to find, not fixed paths.

## Encoder and files
- **Above 4096 × 2304 the H.264 encoder refuses in silence** (or falls to WebM) → cap the plan. (Sample Project)
- **Chrome's encoder overshoots the bitrate** (30 Mbps asked → ~41 measured; Better at 3024 × 1964 ≈ 23–30 Mbps real) → say "up to N MB/min". (Sample Project, series)
- **MediaRecorder MP4 = fragmented, VFR timestamps, level 5.1 label on a 5.2 stream, Baseline profile** → conform for editors without re-encoding (`tools/conform-cfr.sh`). (series)
- **Two or more takes at once lose frames in the file** (the encoder) → batch one at a time. (series)
