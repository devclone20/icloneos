# Settings "Camera & Action" and the recorder's UI

## The owner's taste (apply without asking)
- The section is called exactly **Camera & Action**. Everything on screen in **English**. Coherent with the page's own look (pixel
  pages: the page's own kit, fonts and tiles; WebGL pages: the app's sheets) — never a generic web form.
- Every value **typed** (click the value, type, Enter) **or stepped** (− / +, ‹ ›); enums as segmented pills; one-line description
  under every setting that says what it really does (≤ the column's width — measure it; a description that wraps by one word is
  rewritten, not wrapped).
- Changes apply at once and persist; Output changes apply to the next take.
- The window shows, on its first page, **what the next file will be** (`W x H · fps · codec` / `≈ Mbps · up to N MB/min` / where the
  scene sits) and **what is never in a video** (the macOS pointer, other apps, the Dock, notifications, this window, the controls).
- An opacity rail for the window (100 → 15 %, drag / click / wheel) — the owner asked for it "very important" in the Showcase.
- Deleting always asks twice. Notes never cut. The thumbnail never over the open window.
- A sidebar foot: the recorder's state in two words (Ready / Recording 00:12 / Paused / Saving) and the storage used.

## Sections
| section | content |
|---|---|
| Record | heading (Ready to record / Recording · 00:12 of 03:06 / Paused / Cannot record here), the plan's lines, the take buttons (● Record · ● Record the tour · N s · ● Record the series where there is one; ■ Stop · ⏸ Pause while recording), the frame drawn to scale with the scene inside, "Never in a video", two diagnostics lines |
| Output | Format · Size · Aspect · Frame rate · Quality · Bit rate (Custom only) · Margin · Tiles |
| Content | what a take may leave out (page-specific: pixel pointer Always/Tour only/Never, narrator, captions, scale bar, labels, badges, the menu clock Real time / 9:41) · tour take starts (At the welcome / After it) · background (Scene / Black / Transparent = WebM alpha) where it makes sense |
| Behaviour | Rec records (What I do / The tour) · Record / stop (Shift+R) · Pause / resume (Shift+P) · This window (Shift+S) · Countdown · Maximum length (0 = no limit) · Sound cue · When a take ends (Thumbnail / Preview / Download) |
| Files | file-name pattern (field + token pills that insert + a live example `→ name.mp4`) · Save… (Ask where / Downloads) · storage (N recordings · MB · free) |
| Recordings | header (N recordings · MB · Delete all — twice) · rows: thumbnail (opens the preview), name cut in its middle, facts line (W x H · mm:ss · MB · EXT), date · take, Open · Save… · × (twice) · empty state that says how to make one |
| Advanced | Slice (0.25–5 s) · Keyframe (0.5–10 s) · Frame clock (Each frame / Fixed rate) · Diagnostics · Reset Camera & Action (twice) · what this browser records |
| Page | only when the page had no settings of its own: the page's own options (field colour, back to the tour after N s), Restart the tour, Pause the page (in a tour take: Pause the take) |
| Keys | the recorder's keys and the page's keys, in two tables |

## The tested schema (example series, 28 settings — adapt the Content rows to the page)
| section | key | label | choices | default | one-line description |
|---|---|---|---|---|---|
| output | `format` | Format | Auto · MP4 · WebM | `"auto"` | Auto: MP4 (H.264) if the browser records it, else WebM. |
| output | `size` | Size | Screen · 720p · 1080p · 1440p · 2160p | `"screen"` | Screen: this window's pixels. Else the short side. |
| output | `aspect` | Aspect | Screen · 16:9 · 9:16 · 1:1 · Mac | `"screen"` | Never a crop: the Mac is laid out whole in the frame. |
| output | `fps` | Frame rate | 30 fps · 60 fps | `"60"` | The video's rate. Extra display frames are left out. |
| output | `quality` | Quality | Good · Better · Best · Custom | `"better"` | The bit rate, scaled to the frame. Custom: set below. |
| output | `mbps` | Bit rate | 2–200 Mbps (step 1) | `40` | Megabits per second, 2 to 200. |
| output | `margin` | Margin | 0–25 % (step 1) | `0` | Field around the Mac: a share of the short side. |
| output | `grid` | Tiles | Fit · Whole | `"fit"` | Whole: each tile is a whole number of video pixels. |
| content | `pointer` | Pixel pointer | Always · Tour only · Never | `"always"` | The Mac's drawn arrow. Never the macOS pointer. |
| content | `narrator` | Narrator | On · Off | `"on"` | The robot and its typed boxes, while a take runs. |
| content | `clock` | Menu clock | Real time · 9:41 | `"real"` | 9:41: a take shows a fixed time, not the real hour. |
| content | `boot` | Tour take starts | At the welcome · After it | `"welcome"` | After it: the welcome dialog (3.4 s) is left out. |
| behaviour | `take` | Rec records | What I do · The tour | `"free"` | The tour: one whole pass, then it stops by itself. |
| behaviour | `hotkey` | Record / stop | combo | `"Shift+R"` | Starts and stops a take. Esc held 0.7 s stops too. |
| behaviour | `pauseKey` | Pause / resume | combo | `"Shift+P"` | The time a take is paused is not in the video. |
| behaviour | `panelKey` | This window | combo | `"Shift+S"` | Opens and closes Camera & Action. |
| behaviour | `countdown` | Countdown | Off · 3 s · 5 s | `"off"` | Counted on the page before a take, never in the video. |
| behaviour | `max` | Maximum length | 0–120 min (step 1) | `0` | A free take stops by itself after this long. 0: no limit. |
| behaviour | `beep` | Sound cue | On · Off | `"off"` | A tone at the start and the end. No sound in the video. |
| behaviour | `after` | When a take ends | Thumbnail · Preview · Download | `"toast"` | Download: the file goes to Downloads at once. |
| files | `pattern` | File name | text | `"icloneOS_{page}_{take}_{date}_{time}"` |  |
| files | `save` | Save… | Ask where · Downloads | `"ask"` | Ask where: the system's save panel, if there is one. |
| advanced | `slice` | Slice | .25–5 s (step .25) | `1` | How often a take is stored (an MP4: at its keyframes). |
| advanced | `keyframe` | Keyframe | .5–10 s (step .5) | `2` | Shorter: easier to cut, a larger file. |
| advanced | `pace` | Frame clock | Each frame · Fixed rate | `"frame"` | Each frame: sent when drawn. Fixed: sampled at the rate. |
| page | `field` | Field | the page's field colours (stepper) | `"green"` | The field's colour, on the page and in the video (C). |
| page | `idle` | Back to the tour | 0–600 s (step 5) | `25` | Still-mouse seconds before the tour returns. 0: never. |
| — | `opacity` |  | 15–100 % (step 5) | `100` |  |
Sample Project's defaults, for a WebGL page (one versioned object, sanitized on every read):
```js
{ v: 1,
  output:    { format: 'auto', size: 'native', customW: 1920, customH: 1080, aspect: 'native', fps: 60, quality: 'better', customMbps: 40 },
  content:   { captions: true, card: true, scale: true, labels: true, badges: false, crumb: false, background: 'scene' },
  behaviour: { hotkey: 'Shift+R', countdown: 0, autoStart: false, autoStop: true, maxMin: 0, beep: false, hidePointer: false, guide: true },
  files:     { pattern: 'SampleProject_{scene}_{date}_{time}', save: 'ask' },
  advanced:  { timesliceMs: 1000, keyframeS: 2, clock: 'frame' } }
```
Sample Project's 21 `rec*` keys lived in the core's own SETTINGS (section `camera`), presented by its control module in topic cards
(Output · Content · Behaviour · Files · Advanced) — when a page already has a settings system, the recorder's keys join it.

## The controls
- Record control: pixel island `● Rec · Camera` in the menu bar's free middle (never moving the page's own islands), or a 10-px
  raised red key top-left (Showcase), or a small round DOM button (Sample Project). Recording: red pill/key, `■ mm:ss`, pause pill;
  paused: blinking red outline + ▸. Countdown pill reads "Cancel".
- Countdown: one large red digit in a plate at the centre (5 × 7 font × 6), "recording" / "the tour" under it.
- Thumbnail (after a take, 20 s, held while hovered): picture 48 × 31, "Take saved" / "Recovered", `mm:ss · MB`, Preview · Save…, ×.
- Preview window: title "Preview", a black well with the browser's own player over it, name, facts, Delete (twice) · Keep for later ·
  Save… (default).
- The user's pointer over the recorder's things is drawn by the recorder on its own canvas (the page's pointer hidden and moved off);
  hollow (colours swapped) when it is on the page but not in the film (a tour take, a pointer left out of a live take).
