# Recording pages into video files (batch) — and finishing them for editors

Template: `templates/record-series.mjs` (the tested tool of the example series). Tools: `tools/probe-video.sh`, `tools/conform-cfr.sh`.

## The run
1. Find the pages (the Desktop moves: `find ${PROJECT_DIR:?} -maxdepth 6 -name 'ep01-*.html'`); output into a **scratch** folder.
2. Per page, a fresh headless Chrome: `chrome({ width: 1512, height: 982, tag: 'series-chrome', flags: ['--force-color-profile=srgb', '--autoplay-policy=no-user-gesture-required'] })`,
   `Emulation.setDeviceMetricsOverride({ width: 1512, height: 982, deviceScaleFactor: 2 })` → a 3024 × 1964 canvas (a laptop-sized screen),
   `Page.setDownloadBehavior({ behavior: 'allow', downloadPath })`.
3. Set the take through the recorder's own API: Screen size + aspect, 60 fps, quality Better, the page's name as the file pattern, the
   menu clock 9:41 (the same fixed time in every episode), countdown and sound off. Assert the plan is 3024 × 1964 MP4.
4. Wait for a quiet machine (`os.loadavg()[0] < 14`), then `CAMERA.start('tour')`; poll every 2.5 s (log every 30–45 s) until the
   take stops by itself (`why === 'tour'`, length = the tour ± 1 s); throw on page errors; time limit = tour + 150 s.
5. Save through the recorder's own Save (`save(id, true)` → a download), wait until the file has the take's bytes and no `.crdownload`.
6. **ffprobe the file** (the instrument — never the recorder's count of frames sent):
   ```bash
   ffprobe -v error -select_streams v:0 -show_entries packet=pts_time -of csv=p=0 f.mp4   # → frames, span, gaps
   ```
   fps = frames / span; largest gap; gaps over 1.5 frames. Under 58 fps → take it again (keep the best of ≤ 3).
7. **One at a time.** Measured in the files on the machine these were recorded on: 1 take 59.9 fps · 2 at once 56 · 3 at once 50 · 4 → 45 · 6 → 35
   (each page still sent 59: the Mac's video encoder drops what it cannot keep). The owner's "12 at once" was measured and refused.
8. `caffeinate -ims -w <pid>` for the run; never wrap the tool in caffeinate.

## Finishing for editors (no re-encoding, no pixel touched)
MediaRecorder's MP4 is fragmented (`moof/mdat` pairs), stamps frames with the wall clock (a few a hair early or late — VFR) and
labels a 3024 × 1964 @ 60 stream H.264 level 5.1 although its macroblock rate (189 × 123 × 60 = 1.39 M/s) is level 5.2.
`tools/conform-cfr.sh in.mp4 out.mp4 [fps]` does:
```bash
ffmpeg -v error -y -i in.mp4 -map 0:v -c:v copy -bsf:v h264_mp4toannexb,h264_metadata=level=5.2 -f h264 tmp.h264
ffmpeg -v error -y -r 60 -i tmp.h264 -c copy -movflags +faststart out.mp4
```
→ every frame exactly 1/60 s apart (`r_frame_rate = avg_frame_rate = 60/1`), the right level, the index at the front, a duration
in the header. A video becomes shorter than the tour by its dropped frames × 1/60 s (< 0.5 s per episode). Then **decode every file
whole** and require 0 errors — with timestamps passed through, or the null muxer reports false "non monotonic dts" errors:
```bash
ffmpeg -v error -hwaccel videotoolbox -i out.mp4 -map 0:v -fps_mode passthrough -f null -
```
Look at frames of every file (a contact sheet: 3 frames each at 30/60/90 %) and the menu bar of one at full size.

## Delivering
Copy only verified files to the owner's folder (on the Desktop the iCloud file provider indexes every byte: rejected takes and
intermediates there saturate the machine). Add a short `READ ME.txt`: what they are, how they were made, the table (file, episode,
length, frames, size), how they were checked, how to make them again. Never leave rejected takes behind; delete with
`find <dir> -maxdepth 1 -type f -name '*.take' -delete` (a zsh `rm` with an unmatched glob deletes nothing) and confirm with `ls`.

## Report line (what the owner wants to read)
"N of N · 3024 × 1964 · 60 fps exact · MP4 H.264 · <minutes> · <size> · each decoded whole with 0 errors · in <folder>".
