/* TEMPLATE COPY of the tested tool tools/record-series.mjs of the example series. It drives pages that expose window.CAMERA
   (start("tour"), set(), save(id, true), __camera()) — adapt prepare()/take() to another page's recorder API. Needs ./chrome.mjs and ffmpeg/ffprobe.
   Default paths below are the example series' (the Desktop moves: pass --from and --out). */
/* iclone os · the example series — record every episode with the pages' own recorder (Camera & Action), one video file each.
 *
 *   node tools/record-series.mjs [--out=<folder>] [--from=<folder of the pages>] [--only=sample-project,sample-project]
 *        [--window=1512x982@2] [--quality=better] [--clock=941|real] [--min-fps=58] [--retries=2] [--keep-raw] [--jobs=6]
 *
 * For each episode: a fresh headless Chrome at a laptop-sized screen (1512 × 982 at 2× = a 3024 × 1964 canvas), the delivered
 * page opened as it is, Camera & Action asked for a TOUR take (the tour from its first frame to its last, the page locked, the take
 * stopping by itself), the finished take saved by the recorder's own Save (a download into --out), then looked at with ffprobe:
 * size, codec, length, frames, the largest gap between two frames. A take that could not keep its rate (a busy machine) is taken
 * again. --jobs=N records N episodes at the same time, each in its own Chrome — do not: measured where these were recorded
 * (frames counted IN THE FILES): one take at a time keeps 59.9 fps at 3024 × 1964, two at once 56, three 50, six 35.
 * The pages go on drawing at 60, but the Mac's video encoder cannot keep several streams of that size. One at a time is the way. The recorder's file is then rewritten, without re-encoding, as an ordinary MP4 at an exact constant 60 fps (index at the front, the right H.264 level, a duration in its
 * header) so QuickTime, Final Cut and the web all open it; --keep-raw keeps the recorder's own file beside it.
 * Nothing here looks at the screen: the videos are the pages' own pixels, exactly as Camera & Action records them in a browser.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, renameSync, rmSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadavg } from "node:os";
import { chrome } from "./chrome.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const opt = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith("--")).map(a => { const i = a.indexOf("="); return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));
const FROM = opt.from || [process.env.PROJECT_DIR ?? process.cwd()].find(existsSync);
/* a new dated folder each run (never on top of finished videos); pass --out to choose; better a scratch folder, then copy (iCloud) */
const OUT = opt.out || join(process.env.PROJECT_DIR ?? process.cwd(), "videos " + new Date().toISOString().slice(0, 10));
const [, WW, WH, DPR] = /^(\d+)x(\d+)@(\d+(?:\.\d+)?)$/.exec(opt.window || "1512x982@2").map(Number);
const QUALITY = opt.quality || "better", CLOCK = opt.clock || "941", MIN_FPS = +(opt["min-fps"] || 58), RETRIES = +(opt.retries ?? 2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const f2 = v => Math.round(v * 100) / 100, pad2 = n => String(n).padStart(2, "0"), mmss = s => pad2(Math.floor(s / 60)) + ":" + pad2(Math.round(s % 60));
const LOG = join(OUT, "_recording.log");
const log = m => { const line = new Date().toTimeString().slice(0, 8) + " " + m; console.log(line); try { appendFileSync(LOG, line + "\n"); } catch {} };

if (!FROM) { console.error("the folder of the pages was not found"); process.exit(1); }
mkdirSync(OUT, { recursive: true });
const pages = readdirSync(FROM).filter(f => /^ep\d\d-.*\.html$/.test(f)).sort().filter(f => !opt.only || String(opt.only).split(",").includes(f.replace(".html", "")));
if (!pages.length) { console.error("no episode page in " + FROM); process.exit(1); }

/* what ffprobe says of a file: the stream's facts, and every frame's time (the gaps between them are the smoothness) */
function probe(file) {
  const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,profile,width,height,pix_fmt,avg_frame_rate,nb_frames,duration:format=duration,size,format_name", "-of", "json", file]).toString());
  const ts = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", file], { maxBuffer: 1 << 28 }).toString().trim().split("\n").map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  let max = 0, over = 0; for (let i = 1; i < ts.length; i++) { const g = ts[i] - ts[i - 1]; if (g > max) max = g; if (g > 1.5 / 60) over++; }
  const s = j.streams[0] || {}, dur = ts.length ? ts[ts.length - 1] - ts[0] + 1 / 60 : 0;
  return { codec: s.codec_name, profile: s.profile, w: s.width, h: s.height, pix: s.pix_fmt, frames: ts.length, seconds: dur, fps: ts.length / Math.max(.001, dur), maxGap: max, gapsOver: over, container: j.format.format_name, headerDuration: +j.format.duration || 0, bytes: +j.format.size };
}

/* one episode's page in its own Chrome, the recorder set for the take; nothing recorded yet */
async function prepare(file, attempt) {
  const name = file.replace(".html", ""), c = await chrome({ width: WW, height: WH, tag: "series-chrome", flags: ["--force-color-profile=srgb", "--autoplay-policy=no-user-gesture-required"] });
  const js = (expr, ms = 60000) => Promise.race([c.evaluate(`(async () => JSON.stringify(await (${expr})))()`), sleep(ms).then(() => { throw new Error("no answer in " + ms / 1000 + " s from: " + String(expr).slice(0, 70)); })]).then(s => (s === undefined ? undefined : JSON.parse(s)));
  const H = { file, name, attempt, c, js, close: () => Promise.race([c.close(), sleep(4000)]) };
  try {
    await c.call("Emulation.setDeviceMetricsOverride", { width: WW, height: WH, deviceScaleFactor: DPR, mobile: false });
    await c.call("Page.setDownloadBehavior", { behavior: "allow", downloadPath: OUT });
    await c.open(pathToFileURL(join(FROM, file)).href);
    if (await c.evaluate("typeof window.__render") !== "function") throw new Error("the page did not start");
    await c.evaluate("window.__ready"); await sleep(600);
    if (!(await js("!!(window.CAMERA && window.CAMERA.on)"))) throw new Error("this page has no recorder");
    /* the take's settings: the window's own pixels at 60 fps (the defaults), the file named after its page, a fixed menu clock */
    await js(`(CAMERA.set("size", "screen"), CAMERA.set("aspect", "screen"), CAMERA.set("fps", "60"), CAMERA.set("quality", ${JSON.stringify(QUALITY)}), CAMERA.set("clock", ${JSON.stringify(CLOCK)}), CAMERA.set("pattern", "{page}"), CAMERA.set("after", "toast"), CAMERA.set("countdown", "off"), CAMERA.set("beep", "off"), 1)`);
    const S = await js("window.__camera()"); H.plan = S.plan; H.tour = S.tour;
    if (!H.plan || !H.plan.ok || H.plan.w !== Math.round(WW * DPR) || H.plan.h !== Math.round(WH * DPR)) throw new Error(`the plan is ${H.plan && H.plan.w}x${H.plan && H.plan.h} (${H.plan && H.plan.ext}), wanted ${WW * DPR}x${WH * DPR}`);
    return H;
  } catch (e) { await H.close(); throw e; }
}
/* the take: the tour from its first frame, until the recorder stops by itself */
async function take(H) {
  const { js, name, tour } = H;
  if (!(await js(`CAMERA.start("tour")`))) throw new Error("the take did not start: " + (await js("window.__camera().note")));
  const t0 = Date.now(); let last = Date.now();
  for (;;) {
    await sleep(2500);
    const s = await js("(() => { const s = window.__camera(); return { mode: s.mode, el: s.elapsed, fr: s.stats && s.stats.frames, n: s.recordings.length, note: s.note, errs: window.__errors }; })()");
    if (s.errs && s.errs.length) throw new Error("page errors: " + JSON.stringify(s.errs).slice(0, 300));
    if (s.mode === "idle") { if (s.n === 1) break; throw new Error("the take ended with no recording: " + s.note); }
    if (Date.now() - last > 45000 && s.mode === "recording") { last = Date.now(); log(`  ${name} ${mmss(s.el / 1000)} / ${mmss(tour)} · ${s.fr} frames · ${f2(s.fr / Math.max(.001, s.el / 1000))} fps · load ${f2(loadavg()[0])}`); }
    if (Date.now() - t0 > (tour + 150) * 1000) throw new Error("the take did not stop by itself");
  }
  const R = await js("window.__camera()"), L = R.last; H.rec = R.recordings[0];
  if (L.why !== "tour") throw new Error(`the take was stopped by "${L.why}"`);
  H.take = { seconds: L.ms / 1000, frames: L.frames, fps: L.fps, skipped: L.skipped, presented: L.presented, copied: L.copied, drawn: L.drawn, bytes: H.rec.bytes, mbps: L.mbps, w: L.w, h: L.h, codec: L.codec };
}
/* the recorder's own Save (straight to the folder), then the file's size against the take's bytes */
async function save(H) {
  const r = H.rec, raw = join(OUT, r.name); try { rmSync(raw, { force: true }); } catch {}
  await H.js(`CAMERA.save(${JSON.stringify(r.id)}, true)`);
  for (let i = 0; ; i++) { await sleep(500); if (existsSync(raw) && statSync(raw).size === r.bytes && !existsSync(raw + ".crdownload")) break; if (i >= 600) throw new Error("the saved file did not arrive whole (" + (existsSync(raw) ? statSync(raw).size : 0) + " of " + r.bytes + " bytes)"); }
  H.raw = raw;
}

/* ── the run: waves of --jobs takes at the same time (default 1: this Mac's encoder keeps ONE take of 3024 × 1964 at 60 fps;
   two at once already lose frames in their files). A take under the bar is taken again in a later wave ── */
const JOBS = Math.max(1, +(opt.jobs || 1)), done = [], t00 = Date.now(), best = new Map();
log(`recording ${pages.length} episode${pages.length > 1 ? "s" : ""} from ${FROM} into ${OUT} · window ${WW}x${WH} at ${DPR}x · quality ${QUALITY} · menu clock ${CLOCK === "941" ? "9:41" : "real"} · ${JOBS} at a time`);
let queue = pages.map(f => ({ file: f, attempt: 1 }));
while (queue.length) {
  const wave = queue.splice(0, JOBS), again = [];
  for (let w = 0; loadavg()[0] > 14 && w < 90; w++) { if (!w) log(`  (waiting for the machine: load ${f2(loadavg()[0])})`); await sleep(10000); }
  const hs = (await Promise.all(wave.map(j => prepare(j.file, j.attempt).catch(e => { log(`  ${j.file}: take ${j.attempt} could not be set up — ${e.message}`); if (j.attempt <= RETRIES) again.push({ file: j.file, attempt: j.attempt + 1 }); return null; })))).filter(Boolean);
  if (hs.length) {
    await sleep(1500);                                                       /* every page settled before any take begins */
    const idle = await hs[0].js(`(async () => { let n = 0; const t0 = performance.now(); await new Promise(res => { const f = () => { n++; if (performance.now() - t0 < 1500) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); }); return n / 1.5; })()`);
    log(`wave of ${hs.length}: ${hs.map(h => h.name + " (" + mmss(h.tour) + ")").join(" · ")} · ${hs[0].plan.w}x${hs[0].plan.h} ${hs[0].plan.fps} fps ${hs[0].plan.ext.toUpperCase()} ${hs[0].plan.codec} ≈ ${hs[0].plan.mbps} Mbps · display ${f2(idle)} Hz · load ${f2(loadavg()[0])}`);
    /* all the takes of the wave run to their ends; only then are they saved (a save is disk work: not while another take records) */
    const taken = await Promise.all(hs.map(h => take(h).then(() => h, e => { log(`  ${h.name}: take ${h.attempt} failed — ${e.message}`); h.failed = true; return h; })));
    await Promise.all(taken.filter(h => !h.failed).map(h => save(h).catch(e => { log(`  ${h.name}: ${e.message}`); h.failed = true; })));
    await Promise.all(taken.map(h => h.close()));
    for (const h of taken) {
      if (h.failed) { if (h.attempt <= RETRIES) again.push({ file: h.file, attempt: h.attempt + 1 }); continue; }
      const p = probe(h.raw); h.probe = p; h.idle = idle;
      const ok = Math.abs(h.take.seconds - h.tour) < 1 && p.fps >= MIN_FPS && p.w === Math.round(WW * DPR) && p.h === Math.round(WH * DPR);
      log(`  ${h.name}: ${mmss(p.seconds)} (tour ${mmss(h.tour)}) · ${p.frames} frames · ${f2(p.fps)} fps · largest gap ${Math.round(p.maxGap * 1000)} ms · ${p.gapsOver} gaps over a frame and a half · ${f2(p.bytes / 1e6)} MB${ok ? "" : "  ← under the bar (" + MIN_FPS + " fps)" + (h.attempt <= RETRIES ? ", taking it again" : "")}`);
      const b = best.get(h.name);
      if (!b || p.fps > b.probe.fps) { if (b) rmSync(b.kept, { force: true }); h.kept = h.raw + ".take"; renameSync(h.raw, h.kept); best.set(h.name, h); } else rmSync(h.raw, { force: true });
      if (!ok && h.attempt <= RETRIES) again.push({ file: h.file, attempt: h.attempt + 1 });
    }
  }
  queue = queue.concat(again);
}
for (const file of pages) {
  const name = file.replace(".html", ""), b = best.get(name);
  if (!b) { log(`${file}: NOT RECORDED`); done.push({ name, failed: true }); continue; }
  /* the recorder's file as an ordinary, constant-rate MP4 — the same encoded pictures, never encoded again:
     · its frames exactly 1/60 s apart (the recorder stamps each with the clock's time, so a few sit a hair early or late: an editor's
       timeline wants a constant rate; the display showed them at a constant rate anyway);
     · the H.264 level the stream really is (the browser's encoder writes 5.1; 3024 × 1964 at 60 fps is 5.2);
     · its index at the front and a duration in its header. */
  const rawName = join(OUT, name + ".recorder.mp4"), final = join(OUT, name + ".mp4"), es = join(OUT, name + ".h264");
  renameSync(b.kept, rawName);
  const mbps = Math.ceil(b.probe.w / 16) * Math.ceil(b.probe.h / 16) * 60, level = mbps <= 245760 ? "4.2" : mbps <= 983040 ? "5.1" : mbps <= 2073600 ? "5.2" : "6.2";
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", rawName, "-map", "0:v", "-c:v", "copy", "-bsf:v", "h264_mp4toannexb,h264_metadata=level=" + level, "-f", "h264", es]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-r", "60", "-i", es, "-c", "copy", "-movflags", "+faststart", final]); rmSync(es, { force: true });
  const p2 = probe(final);
  if (p2.frames !== b.probe.frames || p2.w !== b.probe.w) { log(`  ${name}: the rewritten file has ${p2.frames} frames, the recorder's ${b.probe.frames} — keeping the recorder's own file`); renameSync(rawName, final); }
  else if (!opt["keep-raw"]) rmSync(rawName, { force: true });
  b.final = final; b.out = probe(final); done.push(b);
  log(`${name}.mp4 ✓ ${b.out.w}x${b.out.h} ${b.out.codec} ${b.out.profile || ""} · ${mmss(b.out.seconds)} · ${b.out.frames} frames · ${f2(b.out.fps)} fps · ${f2(b.out.bytes / 1e6)} MB`);
}
writeFileSync(join(OUT, "_series.json"), JSON.stringify({ at: new Date().toISOString(), from: FROM, window: [WW, WH, DPR], quality: QUALITY, clock: CLOCK, minutes: f2((Date.now() - t00) / 60000), episodes: done.map(d => d.failed ? d : ({ file: basename(d.final), tour: f2(d.tour), seconds: f2(d.out.seconds), frames: d.out.frames, fps: f2(d.out.fps), maxGapMs: Math.round(d.out.maxGap * 1000), gapsOver: d.out.gapsOver, w: d.out.w, h: d.out.h, codec: d.out.codec, profile: d.out.profile, megabytes: f2(d.out.bytes / 1e6), displayHz: f2(d.idle), take: d.take })) }, null, 1));
const bad = done.filter(d => d.failed).length;
log(bad ? `DONE WITH ${bad} EPISODE(S) MISSING` : `done: ${done.length} videos · ${f2(done.reduce((a, d) => a + d.out.bytes, 0) / 1e9)} GB · ${f2((Date.now() - t00) / 60000)} min`);
process.exit(bad ? 1 : 0);
