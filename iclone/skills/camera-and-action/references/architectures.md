# The five architectures — how "no UI in the video" is made true by construction

Pick by how the page draws (SKILL.md §1–§2). In all five the recorder never reads the screen; it composes the video from pixels
the page itself drew, at the end of the frame, in the same task.

---

## A — WebGL scene canvas + DOM UI (Sample Project)

**Host contract** (what the engine must offer):
1. One scene canvas where everything that is scene ends up (passes chained after "present" included) and its own frame loop.
2. `onFrameEnd(canvas)` called **after the last pass**, in the same task. Post-present passes (pixel robots, shots, impact scenes
   drawn on the same canvas after the final quad) are why the hook is at the frame's END, not at present: the first version
   copied at present and lost every robot.
3. `onPresent()` flag when the loop can run without drawing (GPU governor, parked engine): no present → the recorder **holds**.
4. A "resting" signal (`lastDrawAt === 0`): when parked, copy the still into a 2D canvas of its own (the GL buffer may be cleared
   before the next composite); while moving, compose straight from the live GL canvas (saves a ~24 MB blit a frame at 3024 × 1964).
5. The sources of the overlays that BELONG in the film — canvases (drawn as they are) or measurable DOM — and a closed list.
6. A persistent settings store (one versioned key) and IndexedDB.

**Loop order:** the recorder's rAF is registered after the engine's, and re-registered in the same order each frame, so its
`tick` runs after `onFrameEnd` in the same task. `preserveDrawingBuffer` stays false (performance).

**Composite:** output canvas `P.w × P.h` → centre crop to the aspect in CSS px → `drawImage(src, crop × k, …)` with `k = src.width /
cssW` (the canvas's real DPR), `imageSmoothingQuality = 'high'` → `setTransform(s, 0, 0, s, -cx·s, -cy·s)`: from here every overlay
draws in **page CSS pixels** (`getBoundingClientRect()` used as is) → registered scene layers (other canvases) → overlays, back to front.

**Overlays redrawn from their source** (`overlays.js`) — nothing read from the screen:
- Pixel-text windows: the frame from the settings (CSS `box-shadow` does not exist in canvas → `shadowBlur` + `evenodd` clips,
  rasterised once per (w, h, s, settings) into a cached sprite, max 8); the letters = the page's own glyph canvases drawn in their
  rect, clipped to the host box, with the halo (`filter: drop-shadow` → `shadowBlur`).
- `paintText(ctx, root, s)`: TreeWalker over text nodes, `Range.getClientRects()` per line, computed font / letterSpacing /
  textTransform / colour / opacity / first text-shadow, baseline from `fontBoundingBoxAscent/Descent`, optional clip.
- Labels, scale bar (lines and ticks as rects with `shadowBlur`), badges, breadcrumb (off by default) — each in `try/catch` with
  a single warning: a broken overlay never stops a take.
- "Clean screen" (HUD hidden on the page): judge an overlay by its own state class, not by the page's opacity — the film keeps it.
- Background option: Scene · Black · Transparent (WebM with alpha only: overlays alone, to composite elsewhere).

Skeleton to start from: `templates/mini-recorder.js` (≈ 90 lines). Example overlay (a DOM scale bar):

```js
(c, s) => {
  for (const el of document.querySelectorAll('#scale .scale-line, #scale .scale-tick')) {
    const r = el.getBoundingClientRect(); c.fillStyle = getComputedStyle(el).backgroundColor; c.fillRect(r.x, r.y, r.width, r.height);
  }
  const t = document.querySelector('#scale .scale-label'), r = t.getBoundingClientRect(), cs = getComputedStyle(t);
  c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; c.fillStyle = cs.color; c.textBaseline = 'middle';
  c.fillText(t.textContent.trim(), r.x, r.y + r.height / 2);
}
```

---

## B — one 2D canvas with scene AND UI (Sample Project v9)

The page draws everything into one canvas, so there is no "scene canvas" to copy. Split `render()` in two halves and take the frame
between them, in the same call:

```js
function render() {
  const recOn = REC && REC.live(), hover = recOn ? null : S.hover;      // a hover lift is the pointer's trace: off while recording
  drawField(); drawEffects(); drawScene(hover);                        // ── the SCENE half
  if (recOn) REC.scene(cv);                                            // ← the video's frame: not one UI pixel is on the canvas yet
  if (recOn && SET.recDossier === "off") drawDossier();                // content the take leaves out: drawn AFTER the hook (page only)
  drawGrips(); drawHeader(); drawArrows(); drawSettingsWindow();        // ── the UI half
  if (REC) REC.draw(L, hits);                                          // the recorder's own controls, last of all
}
```

Rules: hit-target order stays identical (compute hits for the header before drawing it if the scene needs them); the frame
signature (when the page skips redraws of unchanged frames) includes the recorder's `sig()`; the recorder gets first refusal on
pointer events and keys; `tick()` returning true asks the core to draw again (a dirty frame skipped by the slot grid).
Gate idea that proves it: a still page, one take, the same instant with Settings closed and open (typing in a field) → page differs
by 144/255 in the window's rect, video by 1.6/255 (codec floor).

---

## C — a bitmap engine presented to the page canvas (example series)

The engine draws a small 1-bit bitmap (480 × 312) + paint canvases and `present()`s it to `#screen` as raised tiles. Here a split
render would double the present cost; instead:

1. **The recorder's UI lives on another canvas**: `#camui`, `position:fixed`, same size as `#screen`, `pointer-events:none`,
   z-index above. It is drawn only when its signature changes (mode, timer second, hover, window, note, view, field colour…), in
   three 1-bit layers (window · chrome · pointer), each presented with the engine's own look (paper = the field's colour at that
   row, ink = field × 0.2, tiles with gaps from 4 device px). `#screen` and the bitmap never hold one of its pixels → **CAM-01**:
   the page canvas byte-identical to the page built without the recorder, idle and with its window open.
2. **The frame**: `present(t, sweepIn, sweepOut, target = SCREEN, again = false)` takes a target `{ c, x, w(), h(), dpr(), tiles, tx,
   fit }`. The page's present is unchanged (`T === SCREEN`); the recorder presents the same bitmap into its own canvas at the
   video's size with `again = true` (reuses the three bitmaps just read — no second readback). When the video IS the window's own
   size (Screen/Screen/no margin/Fit) it simply copies `#screen` (`drawImage(cv)`) — CAM-15 proves both paths give the same picture.
3. **The scene laid out whole** in any frame: `P = min((w − 2m)/WW, (h − 2m)/WH)` (Tiles "Whole" floors it), centred; 9:16 and 1:1 never crop.
4. **Hooks** in the engine (`const CAM = () => (typeof CAMERA !== "undefined" && CAMERA && CAMERA.on ? CAMERA : null)`):
   `cursor(cur, "tour"|"live")` before a frame (hide AND move off-screen a pointer the take leaves out, or one over the recorder's
   controls) · `mute()` (narrator) · `clock()` (9:41) · `scene(t, in, out)` after every present · `tick()`/`ui()` once a display
   frame (also on a paused/still page) · `move/down/up/wheel` first refusal (true = not the app's) · `locked()` (a tour take keeps
   the page) · `busy()`/`idle()` (no idle return to the tour during a take) · `field()` · `boot()`; and the engine offers
   `redraw()` (the frame on screen drawn again — a paused page draws nothing by itself).
5. The module is inlined by the builder at a placeholder inside the engine (one scope, one global name), so every page sharing the
   engine gets it; `?camera=off` leaves a page without it (embeds, review tools).

---

## D — a device's exact screen (Sample Project "Screen")

When the owner wants a phone/tablet video of a responsive page, a resized canvas is not enough: captions and cards follow the
viewport's media queries and `position: fixed`. The outer page becomes a **stage**: an `<iframe>` of the device's CSS size
(402 × 874 for an iPhone at @3 → a 1206 × 2622 recording), scaled down to fit the window but never cropped, loading the same app
with `?screen=<id>`. Inside it the viewport, media queries, fixed elements, the engine's DPR and the recorder's frame are the
device's; the outer engine sleeps (`engine.paused`). The device picker (Settings › Camera & Action › Screen, presets in the store)
works from inside through `postMessage` to the parent. This replaced recording in the iOS Simulator (fragile: taps, paste, fps).

---

## E — DOM-only content (no canvas)

There is no pixel source the page owns. Options, in order of preference:
1. **Move the scene into a canvas** (the page's real content becomes drawable) — then A/B/C apply.
2. **Element Capture** (Chrome 132+): records ONE element subtree of the current tab — UI outside it is excluded by the browser.
   It is screen capture (a permission prompt, a user gesture, Chrome only), so say so to the owner:
   ```js
   const stream = await navigator.mediaDevices.getDisplayMedia({ preferCurrentTab: true, video: { frameRate: 60 } });
   const [track] = stream.getVideoTracks();
   const target = await RestrictionTarget.fromElement(document.querySelector('#stage'));   // the element must form a stacking context
   await track.restrictTo(target);                                                        // only that subtree from now on
   const mr = new MediaRecorder(stream, { mimeType: 'video/mp4;codecs=avc1', videoBitsPerSecond: 30e6 });
   ```
   (`CropTarget` + `cropTo()` crops to a rectangle but still shows whatever is drawn over it; `RestrictionTarget` excludes it.)
3. **Frame-by-frame filming** for a page pure in `t`: headless Chrome, `?still&t=<n/60>`, `Page.captureScreenshot` per frame, then
   `ffmpeg -framerate 60 -i f%06d.png -c:v libx264 -crf 12 -pix_fmt yuv420p` — exact frames and timing at any machine speed, but
   offline (minutes per minute) and only for deterministic pages.
