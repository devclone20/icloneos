/* Camera & Action — GATE HARNESS, tested excerpt (copy, then adapt).
 * Source: tools/mac-rec-gates.mjs of the example series . It needs tools/chrome.mjs (a bare CDP client:
 * chrome({ width, height, flags, tag }) → { call, evaluate, open, close }) and a page that exposes:
 *   window.__render(t) (on ?still), window.CAMERA (start/stop/set/show/frame/blob…), window.__camera() (its state: plan, stats,
 *   last, hits with cx/cy in CSS px, view {P, ox, oy, dpr}, window/island rects, recordings…).
 * What it gives: open() → a session with js() (awaits promises), real mouse/keys, tap(hitId), until(), shot(); TOOLS → page-side
 * window.__g: keep / keepUI / keepFrame (grab a canvas), decode(id, times) (the take decoded at given times into ImageData),
 * mad / diff / opaque / red / ink (pixel measures), rate(ms) (the display's real rate).
 * The CAM-02 block below is the canonical "no UI in the video" proof — keep its shape in every project.
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadavg } from "node:os";
import { chrome } from "./chrome.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PAGE = join(dirname(HERE), "appvid", "out", "sampleproject.html");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TAG = "cam-gates-chrome";            /* this suite's own Chromes: no other session's clean-up of "marks-chrome" ends them */

/* the page-side tools: grab a canvas, decode a take at given times, measure rects (canvas px) */
const TOOLS = `(() => { const G = window.__g = {
  cv: () => document.getElementById("screen"), ui: () => document.getElementById("camui"),
  grab(c) { const x = document.createElement("canvas"); x.width = c.width; x.height = c.height; const g = x.getContext("2d", { willReadFrequently: true }); g.drawImage(c, 0, 0); return g.getImageData(0, 0, c.width, c.height); },
  keep(name) { G[name] = G.grab(G.cv()); return [G[name].width, G[name].height]; },
  keepUI(name) { G[name] = G.grab(G.ui()); return [G[name].width, G[name].height]; },
  keepFrame(name) { const c = CAMERA.frame(); if (!c) return null; G[name] = G.grab(c); return [c.width, c.height]; },
  async decode(id, times) {
    const blob = CAMERA.blob(id); if (!blob) throw new Error("no recording " + id);
    const v = document.createElement("video"); v.muted = true; v.preload = "auto"; v.src = URL.createObjectURL(blob);
    const within = (p, ms, what) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error("the video " + what + " (waited " + ms / 1000 + " s; " + blob.size + " bytes, " + blob.type + ")")), ms))]);
    await within(new Promise((r, j) => { v.onloadeddata = r; v.onerror = () => j(new Error("the video does not decode: " + (v.error && v.error.message))); }), 12000, "did not load");
    if (v.duration === Infinity) { await within(new Promise(r => { v.ontimeupdate = () => { v.ontimeupdate = null; r(); }; v.currentTime = 1e7; }), 12000, "did not give its length"); }
    const out = { w: v.videoWidth, h: v.videoHeight, duration: v.duration, type: blob.type, bytes: blob.size };
    const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight; const x = c.getContext("2d", { willReadFrequently: true });
    for (const [name, t] of times) {
      await within(new Promise(r => { v.onseeked = r; v.currentTime = Math.max(0, Math.min(t < 0 ? v.duration + t : t, (Number.isFinite(v.duration) ? v.duration : t) - .02)); }), 12000, "did not seek to " + t);
      await new Promise(r => setTimeout(r, 90));
      x.drawImage(v, 0, 0); G[name] = x.getImageData(0, 0, c.width, c.height);
    }
    URL.revokeObjectURL(v.src); return out;
  },
  clip(a, r) { r = r || { x: 0, y: 0, w: a.width, h: a.height }; const x0 = Math.max(0, Math.round(r.x)), y0 = Math.max(0, Math.round(r.y)); return { x0, y0, x1: Math.min(a.width, Math.round(r.x + r.w)), y1: Math.min(a.height, Math.round(r.y + r.h)) }; },
  /* the mean absolute difference of two images over a rect (0…255); -1 when they are not the same size */
  mad(an, bn, r) { const a = G[an], b = G[bn]; if (!a || !b || a.width !== b.width || a.height !== b.height) return -1; const q = G.clip(a, r); let s = 0, n = 0;
    for (let y = q.y0; y < q.y1; y++) for (let x = q.x0; x < q.x1; x++) { const i = (y * a.width + x) * 4; s += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]); n += 3; }
    return n ? s / n : -1; },
  /* how many pixels of a rect differ at all, and the box that holds them (optionally outside some rects) */
  diff(an, bn, r, skip) { const a = G[an], b = G[bn]; if (!a || !b || a.width !== b.width || a.height !== b.height) return null; const q = G.clip(a, r); let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = q.y0; y < q.y1; y++) for (let x = q.x0; x < q.x1; x++) { if (skip && skip.some(s => x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h)) continue; const i = (y * a.width + x) * 4; if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
    return { n, x0, y0, x1, y1 }; },
  /* pixels of a rect with any opacity (the recorder's canvas is clear where it draws nothing) */
  opaque(an, r) { const a = G[an]; if (!a) return -1; const q = G.clip(a, r); let n = 0; for (let y = q.y0; y < q.y1; y++) for (let x = q.x0; x < q.x1; x++) if (a.data[(y * a.width + x) * 4 + 3] > 24) n++; return n; },
  /* pixels of a rect that are the recorder's red (a strong red, far from the field and from the app's tones) */
  red(an, r) { const a = G[an]; if (!a) return -1; const q = G.clip(a, r); let n = 0; for (let y = q.y0; y < q.y1; y++) for (let x = q.x0; x < q.x1; x++) { const i = (y * a.width + x) * 4; if (a.data[i + 3] > 24 && a.data[i] > 170 && a.data[i + 1] < 110 && a.data[i + 2] < 110) n++; } return n; },
  /* the engine's ink (the field at 20 %): how many pixels, and the box that holds them, inside a rect or outside one */
  ink(an, r, outside) { const a = G[an]; if (!a) return null; const q = outside ? G.clip(a, null) : G.clip(a, r), o = outside ? G.clip(a, r) : null; let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = q.y0; y < q.y1; y++) for (let x = q.x0; x < q.x1; x++) { if (o && x >= o.x0 && x < o.x1 && y >= o.y0 && y < o.y1) continue; const i = (y * a.width + x) * 4; if (a.data[i] < 46 && a.data[i + 1] < 62 && a.data[i + 2] < 62) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
    return { n, x0, y0, x1, y1 }; },
  hash(an) { const d = G[an].data; let h = 2166136261; for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619); return (h >>> 0).toString(16); },
  /* the display's rate over ms, by counting its frames */
  async rate(ms) { let n = 0; const t0 = performance.now(); await new Promise(res => { const f = () => { n++; if (performance.now() - t0 < ms) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); }); return n / ((performance.now() - t0) / 1000); },
}; return true; })()`;

async function open(page, query, [width, height], dpr = 1) {
  const c = await chrome({ width, height, tag: TAG, flags: ["--force-color-profile=srgb", "--autoplay-policy=no-user-gesture-required"] });
  await c.call("Runtime.enable");
  await c.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
  const P = {
    c, dpr, width, height,
    /* the value of an expression, a promise awaited first (JSON.stringify of a promise is "{}") */
    js: (expr, ms = 45000) => Promise.race([c.evaluate(`(async () => JSON.stringify(await (${expr})))()`), new Promise((_, j) => setTimeout(() => j(new Error("no answer in " + ms / 1000 + " s from: " + String(expr).slice(0, 90))), ms))]).then(s => (s === undefined ? undefined : JSON.parse(s))),
    load: async (q = query, file = page, need = true) => {
      await c.open(pathToFileURL(file).href + (q ? "?" + q : ""));
      if (await c.evaluate("typeof window.__render") !== "function") throw new Error("the page did not start: window.__render is missing");
      await c.evaluate("window.__ready"); await c.evaluate(TOOLS); await sleep(250);
      if (need && !(await P.js("!!(window.CAMERA && window.CAMERA.on)"))) throw new Error("this build has no recorder (window.CAMERA)");
    },
    cam: () => P.js("window.__camera()"),
    click: async (x, y) => { for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) { await c.call("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 }); await sleep(type === "mouseMoved" ? 70 : 30); } },
    moveTo: (x, y) => c.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" }),
    hit: async id => (await P.cam()).hits.find(h => h.id === id) || null,
    /* a real click on one of the recorder's own targets, by its id */
    tap: async id => { await sleep(60); const h = await P.hit(id); if (!h) throw new Error("the recorder has no target " + id + " on screen"); await P.click(h.cx, h.cy); await sleep(90); return h; },
    wheel: (x, y, dy) => c.call("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy }),
    /* a real key: mods = 1 Alt · 2 Ctrl · 4 Meta · 8 Shift */
    keyDown: (key, code, vk, mods = 0, text) => c.call("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods, ...(text ? { text } : {}) }),
    keyUp: (key, code, vk, mods = 0) => c.call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods }),
    press: async (key, code, vk, mods = 0, text) => { await P.keyDown(key, code, vk, mods, text); await P.keyUp(key, code, vk, mods); await sleep(60); },
    until: async (expr, ms = 8000) => { const t0 = Date.now(); for (;;) { if (await P.js(expr)) return true; if (Date.now() - t0 > ms) return false; await sleep(60); } },
    shot: async file => { const { data } = await c.call("Page.captureScreenshot", { format: "png" }); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, Buffer.from(data, "base64")); },
    errors: () => P.js("window.__errors || []"),
    close: () => c.close(),
  };
  await P.load();
  return P;
}
const J = v => JSON.stringify(v);
const f2 = v => (typeof v === "number" ? Math.round(v * 100) / 100 : v);
/* a rect of the Mac's own 480 × 312 → the page's canvas pixels (V: the recorder's `view`) · → a video frame's pixels (v: plan.view) */
const w2c = (V, r) => ({ x: (V.ox + r.x * V.P) * V.dpr, y: (V.oy + r.y * V.P) * V.dpr, w: r.w * V.P * V.dpr, h: r.h * V.P * V.dpr });
const w2v = (v, r) => ({ x: v.ox + r.x * v.P, y: v.oy + r.y * v.P, w: r.w * v.P, h: r.h * v.P });
const SHIFT = 8, ALT = 1;
const FULL = { x: 0, y: 0, w: 480, h: 312 };


/* ── the canonical proof (inside checkCam(page, { … }) of the source) ── */
  /* ── CAM-02: a still page, one take, the same instant with and without the Camera & Action window ── */
  await run("CAM-02", [1280, 800], "still&t=40", 1, async P => {
    const S = await P.cam(), V = S.view;
    if (!S.caps.stream || !(S.caps.mp4 || S.caps.webm)) { fail("CAM-02: this browser records no canvas (caps " + J(S.caps) + ")"); return; }
    await P.js(`(window.__render(40), 1)`);
    if (!await P.js("CAMERA.start('free')")) { fail("CAM-02: CAMERA.start() refused: " + (await P.cam()).note); return; }
    const T0 = (await P.cam()).lastFrame; if (!T0) { fail("CAM-02: no frame was taken when the take began on a still page"); return; }
    await sleep(300); await P.js(`(window.__g.keep("P0"), window.__g.keepUI("U0"), 1)`);
    await sleep(500);
    /* the window, by real clicks: the Camera pill, the Files section, the name's field, real keys typed into it */
    await P.tap("cam"); await P.tap("sec:files"); await P.tap("edit:pattern");
    for (const ch of "Earth") await P.keyDown(ch, "Key" + ch.toUpperCase(), ch.toUpperCase().charCodeAt(0), 0, ch);
    await sleep(160);
    const S1 = await P.cam();
    if (!S1.win || S1.sec !== "files" || !S1.edit || !S1.edit.text.endsWith("Earth")) { fail(`CAM-02: the window, its Files section and a typed field did not come by clicks and keys (${J({ win: S1.win, sec: S1.sec, edit: S1.edit })})`); return; }
    await P.js(`(window.__render(40), window.__g.keep("P1"), window.__g.keepUI("U1"), 1)`);
    const T1 = (await P.cam()).lastFrame; if (!T1 || T1.n <= T0.n) { fail("CAM-02: no frame was taken with the window open"); return; }
    await pic(P, "cam02-window-open");
    await sleep(700);
    const r = await P.js("CAMERA.stop()"); if (!r) { fail("CAM-02: the take did not finish: " + (await P.cam()).note); return; }
    const info = await P.js(`window.__g.decode(${J(r.id)}, [["V0", ${(T0.t + 150) / 1000}], ["V1", ${(T1.t + 250) / 1000}]])`);
    const win = w2c(V, { x: S1.window.x, y: S1.window.y, w: S1.window.w + 2, h: S1.window.h + 2 }), isl = w2c(V, S1.island), full = w2c(V, FULL);
    const m = await P.js(`({ page: window.__g.diff("P0", "P1").n, uiWin0: window.__g.opaque("U0", ${J(win)}), uiWin1: window.__g.opaque("U1", ${J(win)}), uiIsl: window.__g.opaque("U1", ${J(isl)}), uiRed: window.__g.red("U1", ${J(isl)}),
      vWin: window.__g.mad("V0", "V1", ${J(win)}), vAll: window.__g.mad("V1", "P1", ${J(full)}), vIsl: window.__g.mad("V1", "P1", ${J(isl)}), vRed: window.__g.red("V1", ${J(isl)}), pRed: window.__g.red("P1", ${J(isl)}) })`);
    const bad = [];
    if (info.w !== S.plan.w || info.h !== S.plan.h) bad.push(`the video is ${info.w}x${info.h}, the plan said ${S.plan.w}x${S.plan.h}`);
    if (m.page !== 0) bad.push(`the page's canvas changed when the window opened (${m.page} px)`);
    if (m.uiWin0 !== 0 || m.uiWin1 < win.w * win.h * .9) bad.push(`the window is not on the recorder's canvas as expected (opaque px ${m.uiWin0} → ${m.uiWin1} of ${Math.round(win.w * win.h)})`);
    if (m.uiIsl < 200 || m.uiRed < 4) bad.push(`the island is not on the recorder's canvas (opaque ${m.uiIsl}, red ${m.uiRed})`);
    if (!(m.vWin >= 0 && m.vWin < 2.5)) bad.push(`the video differs where the window was (${f2(m.vWin)}/255)`);
    if (!(m.vAll >= 0 && m.vAll < 4)) bad.push(`the video is not the page's canvas (${f2(m.vAll)}/255)`);
    if (!(m.vIsl >= 0 && m.vIsl < 6) || m.vRed > m.pRed) bad.push(`the island left a trace in the video (${f2(m.vIsl)}/255, red ${m.vRed} vs the scene's ${m.pRed})`);
    if (bad.length) fail("CAM-02: " + bad.join("; ")); else say(`CAM-02 ok: window open — page's canvas 0 px changed, recorder's canvas ${m.uiWin1} px of window + island (red ${m.uiRed}); video ${info.w}x${info.h}: where the window was ${f2(m.vWin)}/255, against the page's canvas ${f2(m.vAll)}/255, the island's place ${f2(m.vIsl)}/255, red ${m.vRed}`);
  });

