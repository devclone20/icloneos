/* ============================================================================
   Camera & Action — recorder core, TESTED EXCERPTS (copy, then adapt to the host).
   Source: the example series recorder, sampleproject/mac/camera.js (gates CAM-00…CAM-21 green, critic 9/10).
   These are verbatim slices of one module that lived inside its host engine's scope. Host names they expect:
     cv (the page canvas) · present(t, sweepIn, sweepOut, target, again) (draw the scene into any canvas) · SCREEN (the page's
     present target) · lastView {P, ox, oy} · renderTour(t) / redraw() · mode / tourOffset / paused / pausedAt (a scripted
     tour's clock) · kit/tw/fit/wrapText/button/drawCursor (the host's 1-bit drawing kit) · Q (URLSearchParams) · STILL · EP.
   For a canvas page with no engine of its own, replace the shoot step with drawImage(sceneCanvas → comp) (see
   references/architectures.md) and drop the 1-bit UI parts; keep the plan, the store, the slot grid, the encoder,
   pause, stop + framesIn, save, preview, recovery and the shortcut rules — they are host-independent.
   ========================================================================== */

/* The excerpts are wrapped in one function so the file parses and an editor can navigate it; the original was an IIFE:
   const CAMERA = (() => { …these sections… })(); */
export function cameraCoreExcerpts() {
  "use strict";

/* ─────────────────────────────── CONSTANTS ─────────────────────────────── */
  const RED = "#ff453a";                                 /* the one colour of the recorder: it means recording */
  const STORE_KEY = "example-series.camera.v1", DB = "example-series-rec", DB_V = 1;
  const MAX_SIDE = 4096, MAX_AREA = 4096 * 2304;         /* H.264 level 5.1: past it the encoder refuses in silence */
  const HOLD_ESC = 700, NOTE_MS = 4500, TOAST_MS = 20000, HEARTBEAT = 500, ORPHAN_MS = 10000, RECOVER_MS = 2500, ARM_MS = 4000, BOOT_S = 3.4;
  const QUALITY = { good: 5, better: 10, best: 20 };     /* Mbps for 1080p at 60 fps; scaled by the pixels, × .6 at 30 fps */
  const ASPECT = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, mac: WW / WH };
  const MIMES = { mp4: ["video/mp4;codecs=avc1", "video/mp4"], webm: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"] };
  const TOKENS = ["{page}", "{title}", "{take}", "{date}", "{time}", "{size}", "{fps}"];

/* ─────────────────────────────── SETTINGS: schema, validation, persistence ─────────────────────────────── */
  /* ── the settings: Camera & Action owns them (the page had none); every one has a place in the window and a line that says what it does ── */
  const SECTIONS = [["record", "Record"], ["output", "Output"], ["content", "Content"], ["behaviour", "Behaviour"], ["files", "Files"], ["takes", "Recordings"], ["advanced", "Advanced"], ["page", "Page"], ["keys", "Keys"]];
  const ON_OFF = [["on", "On"], ["off", "Off"]];
  const DEFS = [
    { key: "format", sec: "output", label: "Format", kind: "enum", def: "auto", opts: [["auto", "Auto"], ["mp4", "MP4"], ["webm", "WebM"]], desc: "Auto: MP4 (H.264) if the browser records it, else WebM." },
    { key: "size", sec: "output", label: "Size", kind: "enum", def: "screen", opts: [["screen", "Screen"], ["720", "720p"], ["1080", "1080p"], ["1440", "1440p"], ["2160", "2160p"]], desc: "Screen: this window's pixels. Else the short side." },
    { key: "aspect", sec: "output", label: "Aspect", kind: "enum", def: "screen", opts: [["screen", "Screen"], ["16:9", "16:9"], ["9:16", "9:16"], ["1:1", "1:1"], ["mac", "Mac"]], desc: "Never a crop: the Mac is laid out whole in the frame." },
    { key: "fps", sec: "output", label: "Frame rate", kind: "enum", def: "60", opts: [["30", "30 fps"], ["60", "60 fps"]], desc: "The video's rate. Extra display frames are left out." },
    { key: "quality", sec: "output", label: "Quality", kind: "enum", def: "better", opts: [["good", "Good"], ["better", "Better"], ["best", "Best"], ["custom", "Custom"]], desc: "The bit rate, scaled to the frame. Custom: set below." },
    { key: "mbps", sec: "output", label: "Bit rate", kind: "num", def: 40, min: 2, max: 200, step: 1, unit: "Mbps", when: () => SET.quality === "custom", desc: "Megabits per second, 2 to 200." },
    { key: "margin", sec: "output", label: "Margin", kind: "num", def: 0, min: 0, max: 25, step: 1, unit: "%", desc: "Field around the Mac: a share of the short side." },
    { key: "grid", sec: "output", label: "Tiles", kind: "enum", def: "fit", opts: [["fit", "Fit"], ["whole", "Whole"]], desc: "Whole: each tile is a whole number of video pixels." },
    { key: "pointer", sec: "content", label: "Pixel pointer", kind: "enum", def: "always", opts: [["always", "Always"], ["tour", "Tour only"], ["never", "Never"]], desc: "The Mac's drawn arrow. Never the macOS pointer." },
    { key: "narrator", sec: "content", label: "Narrator", kind: "enum", def: "on", opts: ON_OFF, desc: "The robot and its typed boxes, while a take runs." },
    { key: "clock", sec: "content", label: "Menu clock", kind: "enum", def: "real", opts: [["real", "Real time"], ["941", "9:41"]], desc: "9:41: a take shows a fixed time, not the real hour." },
    { key: "boot", sec: "content", label: "Tour take starts", kind: "enum", def: "welcome", opts: [["welcome", "At the welcome"], ["after", "After it"]], desc: "After it: the welcome dialog (3.4 s) is left out." },
    { key: "take", sec: "behaviour", label: "Rec records", kind: "enum", def: "free", opts: [["free", "What I do"], ["tour", "The tour"]], desc: "The tour: one whole pass, then it stops by itself." },
    { key: "hotkey", sec: "behaviour", label: "Record / stop", kind: "key", def: "Shift+R", desc: "Starts and stops a take. Esc held 0.7 s stops too." },
    { key: "pauseKey", sec: "behaviour", label: "Pause / resume", kind: "key", def: "Shift+P", desc: "The time a take is paused is not in the video." },
    { key: "panelKey", sec: "behaviour", label: "This window", kind: "key", def: "Shift+S", desc: "Opens and closes Camera & Action." },
    { key: "countdown", sec: "behaviour", label: "Countdown", kind: "enum", def: "off", opts: [["off", "Off"], ["3", "3 s"], ["5", "5 s"]], desc: "Counted on the page before a take, never in the video." },
    { key: "max", sec: "behaviour", label: "Maximum length", kind: "num", def: 0, min: 0, max: 120, step: 1, unit: "min", zero: "No limit", desc: "A free take stops by itself after this long. 0: no limit." },
    { key: "beep", sec: "behaviour", label: "Sound cue", kind: "enum", def: "off", opts: ON_OFF, desc: "A tone at the start and the end. No sound in the video." },
    { key: "after", sec: "behaviour", label: "When a take ends", kind: "enum", def: "toast", opts: [["toast", "Thumbnail"], ["preview", "Preview"], ["download", "Download"]], desc: "Download: the file goes to Downloads at once." },
    { key: "pattern", sec: "files", label: "File name", kind: "text", def: "icloneOS_{page}_{take}_{date}_{time}", max: 60, desc: "" },
    { key: "save", sec: "files", label: "Save…", kind: "enum", def: "ask", opts: [["ask", "Ask where"], ["downloads", "Downloads"]], desc: "Ask where: the system's save panel, if there is one." },
    { key: "slice", sec: "advanced", label: "Slice", kind: "num", def: 1, min: .25, max: 5, step: .25, unit: "s", desc: "How often a take is stored (an MP4: at its keyframes)." },
    { key: "keyframe", sec: "advanced", label: "Keyframe", kind: "num", def: 2, min: .5, max: 10, step: .5, unit: "s", desc: "Shorter: easier to cut, a larger file." },
    { key: "pace", sec: "advanced", label: "Frame clock", kind: "enum", def: "frame", opts: [["frame", "Each frame"], ["fixed", "Fixed rate"]], desc: "Each frame: sent when drawn. Fixed: sampled at the rate." },
    { key: "field", sec: "page", label: "Field", kind: "pick", def: "green", opts: COLOR_ORDER.map(c => [c, c[0].toUpperCase() + c.slice(1)]), desc: "The field's colour, on the page and in the video (C)." },
    { key: "idle", sec: "page", label: "Back to the tour", kind: "num", def: 25, min: 0, max: 600, step: 5, unit: "s", zero: "Never", desc: "Still-mouse seconds before the tour returns. 0: never." },
    { key: "opacity", sec: null, kind: "num", def: 100, min: 15, max: 100, step: 5, unit: "%" },   /* this window's own opacity: its rail */
  ];
  const DEF = Object.fromEntries(DEFS.map(d => [d.key, d]));
  const COMBO = /^(?:(?:Ctrl|Alt|Shift|Meta)\+){0,4}(?:[A-Z0-9]|F\d{1,2}|Space|Enter|[`\-=\[\];',./\\])$/;
  const cleanText = (s, max) => String(s ?? "").replace(/[\u0000-\u001f]/g, "").slice(0, max);
  function valid(d, v) {
    if (d.kind === "enum" || d.kind === "pick") return d.opts.some(o => o[0] === v) ? v : d.def;
    if (d.kind === "num") { v = +v; if (!Number.isFinite(v)) return d.def; return Math.round(clamp(v, d.min, d.max) * 100) / 100; }
    if (d.kind === "key") return typeof v === "string" && COMBO.test(v) && (v.includes("+") || /^F\d/.test(v)) ? v : d.def;
    if (d.kind === "text") { const s = cleanText(v, d.max).trim(); return s || d.def; }
    return d.def;
  }
  const SET = {}; for (const d of DEFS) SET[d.key] = d.def;
  const load = () => { try { const o = JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {}; for (const d of DEFS) SET[d.key] = d.key in o ? valid(d, o[d.key]) : d.def; } catch {} };
  const persist = () => { try { const o = {}; for (const d of DEFS) if (SET[d.key] !== d.def) o[d.key] = SET[d.key]; localStorage.setItem(STORE_KEY, JSON.stringify(o)); } catch {} };
  const applied = key => { if (key === "field" && COLOR_ORDER.includes(SET.field)) colorMode = SET.field; };
  function setv(key, v, quiet = false) { const d = DEF[key]; if (!d) return false; v = valid(d, v); if (SET[key] === v) return false; SET[key] = v; persist(); applied(key); if (!quiet) bump(); return true; }
  load();
  if (!Q.has("color")) applied("field"); else SET.field = colorMode;         /* ?color= wins for the visit and is not stored */
  addEventListener("storage", e => { if (e.key === STORE_KEY) { load(); if (!Q.has("color")) applied("field"); bump(); } });   /* changed in another page of the series */

/* ─────────────────────────────── WHAT THE BROWSER RECORDS ─────────────────────────────── */
  /* ── what the browser records ────────────────────────────────────────────── */
  let CAPS = null;
  const can = mime => { try { return typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime); } catch { return false; } };
  const mimeOf = fmt => (MIMES[fmt] || []).find(can) || null;
  const caps = () => CAPS || (CAPS = { mp4: !!mimeOf("mp4"), webm: !!mimeOf("webm"), stream: typeof HTMLCanvasElement !== "undefined" && "captureStream" in HTMLCanvasElement.prototype });
  const codecOf = mime => /avc1|mp4/.test(mime) ? "H.264" : /vp9/.test(mime) ? "VP9" : /vp8/.test(mime) ? "VP8" : "WebM";

/* ─────────────────────────────── THE PLAN: size, aspect, bitrate, the scene laid out in the frame ─────────────────────────────── */
  /* ── the plan: what the next take will be (Output). The frame: the window's own pixels (Screen), or a short side of 720…2160 at the
     chosen aspect; whole even numbers; never past 4096 × 2304. The Mac in it: whole, centred, as large as the frame and the margin
     allow (Tiles → Whole: a whole number of video pixels a tile). `same`: the video frame is exactly the page's canvas — it is copied;
     any other plan presents the bitmap again at the video's own size, so its tiles are drawn, never resampled. ── */
  function plan() {
    const cw = cv.width, ch = cv.height; if (!cw || !ch) return null;
    const c = caps(), want = SET.format, fmt = want !== "auto" && c[want] ? want : c.mp4 ? "mp4" : c.webm ? "webm" : null, mime = fmt ? mimeOf(fmt) : null;
    const ar = SET.aspect === "screen" ? cw / ch : ASPECT[SET.aspect];
    let w, h;
    if (SET.size === "screen") { w = cw; h = ch; if (cw / ch > ar) w = ch * ar; else h = cw / ar; }      /* the largest frame of that aspect this window holds */
    else { const s = +SET.size; if (ar >= 1) { h = s; w = s * ar; } else { w = s; h = s / ar; } }
    const k1 = Math.min(1, MAX_SIDE / Math.max(w, h), Math.sqrt(MAX_AREA / (w * h)));
    w = even(w * k1); h = even(h * k1);
    const m = SET.margin / 100 * Math.min(w, h), whole = SET.grid === "whole";
    let p = Math.min((w - 2 * m) / WW, (h - 2 * m) / WH); if (whole) p = Math.max(1, Math.floor(p));
    let ox = (w - WW * p) / 2, oy = (h - WH * p) / 2; if (whole) { ox = Math.round(ox); oy = Math.round(oy); }
    const fps = +SET.fps || 60;
    const mbps = SET.quality === "custom" ? SET.mbps : Math.round(clamp(QUALITY[SET.quality] * (w * h) / (1920 * 1080) * (fps === 30 ? .6 : 1), 2, 200) * 10) / 10;
    return { ok: !!mime && c.stream, fmt, mime, ext: fmt || "mp4", codec: mime ? codecOf(mime) : "", w, h, fps, mbps, bps: Math.round(mbps * 1e6), pace: SET.pace,
      clamped: k1 < 1, fallback: want !== "auto" && fmt !== want, view: { P: p, ox, oy }, mac: { x: ox, y: oy, w: WW * p, h: WH * p }, tile: p, gaps: p >= 4,
      same: SET.aspect === "screen" && SET.size === "screen" && !SET.margin && !whole && w === cw && h === ch };
  }
  /* the Record page's live lines: what the file is, what it weighs, where the Mac sits in it — and what was capped or replaced */
  function summary() {
    const p = plan(); if (!p) return { lines: ["The page has no size yet."], warn: "" };
    if (!p.ok) return { lines: ["This browser cannot record a canvas."], warn: "" };
    return { lines: [p.w + " x " + p.h + " · " + p.fps + " fps · " + p.ext.toUpperCase() + " " + p.codec, "≈ " + p.mbps + " Mbps · up to " + Math.round(p.mbps * 7.5) + " MB/min",
        "Mac " + Math.round(p.mac.w) + " x " + Math.round(p.mac.h) + " · tile " + fmtNum(p.tile) + " px" + (p.gaps ? "" : " · no gaps under 4 px")],
      warn: [p.clamped ? "Capped at 4096 x 2304." : "", p.fallback ? SET.format.toUpperCase() + " is not recorded by this browser: " + p.ext.toUpperCase() + " instead." : ""].filter(Boolean).join(" ") };
  }

/* ─────────────────────────────── THE STORE: IndexedDB recordings + slices, crash recovery ─────────────────────────────── */
  /* ── the store: IndexedDB `example-series-rec` v1 — `recordings` (keyPath id: the blob, its thumbnail, its facts) and `chunks`
     (keyPath [rec, seq]: the slices of a take still running). put() writes the recording and deletes its slices in one transaction.
     recover(): slices with no recording whose last write is over 10 s old (not a take alive in another tab) become a "Recovered"
     recording. Without IndexedDB everything lives in `mem` for the visit. ── */
  const STORE = (() => {
    let dbp = null; const mem = new Map();
    const db = () => dbp || (dbp = new Promise((res, rej) => {
      try {
        const rq = indexedDB.open(DB, DB_V);
        rq.onupgradeneeded = () => { const d = rq.result; if (!d.objectStoreNames.contains("recordings")) d.createObjectStore("recordings", { keyPath: "id" }); if (!d.objectStoreNames.contains("chunks")) d.createObjectStore("chunks", { keyPath: ["rec", "seq"] }); };
        rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); rq.onblocked = () => rej(new Error("blocked"));
      } catch (e) { rej(e); }
    }).catch(() => null));
    const run = async (stores, rw, fn) => {
      const d = await db(); if (!d) return undefined;
      return new Promise((res, rej) => { let rq; const tx = d.transaction(stores, rw); tx.oncomplete = () => res(rq && "result" in rq ? rq.result : undefined); tx.onerror = tx.onabort = () => rej(tx.error || new Error("storage")); rq = fn(tx); });
    };
    const range = id => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
    return {
      chunk: (rec, n, blob, facts) => run(["chunks"], "readwrite", tx => tx.objectStore("chunks").put({ rec, seq: n, blob, at: Date.now(), facts })).catch(() => {}),
      put: async r => { mem.set(r.id, r); try { if (!(await db())) return false; await run(["recordings", "chunks"], "readwrite", tx => { tx.objectStore("recordings").put(r); tx.objectStore("chunks").delete(range(r.id)); }); return true; } catch { return false; } },   /* false: kept in memory only */
      list: async () => {
        let rows = []; try { rows = (await run(["recordings"], "readonly", tx => tx.objectStore("recordings").getAll())) || []; } catch {}
        const by = new Map([...mem.values(), ...rows].map(r => [r.id, r]));
        return [...by.values()].sort((a, b) => b.at - a.at);
      },
      remove: async id => { mem.delete(id); try { await run(["recordings", "chunks"], "readwrite", tx => { tx.objectStore("recordings").delete(id); tx.objectStore("chunks").delete(range(id)); }); } catch {} },
      clear: async () => { mem.clear(); try { await run(["recordings"], "readwrite", tx => { tx.objectStore("recordings").clear(); }); } catch {} },
      recover: async alive => {
        let rows = []; try { rows = (await run(["chunks"], "readonly", tx => tx.objectStore("chunks").getAll())) || []; } catch { return []; }
        const by = new Map(); for (const c of rows) { if (!by.has(c.rec)) by.set(c.rec, []); by.get(c.rec).push(c); }
        const out = [], nowAt = Date.now(); out.wait = 0;                  /* wait: ms until the youngest slices seen are old enough to judge */
        for (const [id, cs] of by) {
          if (id === alive || mem.has(id)) continue;
          cs.sort((a, b) => a.seq - b.seq);
          const lastW = Math.max(...cs.map(c => c.at)); if (nowAt - lastW < ORPHAN_MS) { out.wait = Math.max(out.wait, ORPHAN_MS - (nowAt - lastW)); continue; }
          const f = cs[0].facts || {}, type = f.mime || "video/mp4", blob = new Blob(cs.map(c => c.blob), { type });
          const r = { id, name: "Recovered_" + String(f.name || "recording." + (f.ext || "mp4")), ext: f.ext || "mp4", mime: type, codec: f.codec || "", w: f.w || 0, h: f.h || 0, fps: f.fps || 0, page: f.page || "", take: f.take || "",
            ms: Math.max(0, lastW - Math.min(...cs.map(c => c.at))) + (f.slice || 1000), bytes: blob.size, at: lastW, frames: 0, blob, thumb: null, recovered: true };
          mem.set(id, r);
          try { await run(["recordings", "chunks"], "readwrite", tx => { tx.objectStore("recordings").put(r); tx.objectStore("chunks").delete(range(id)); }); } catch {}
          out.push(r);
        }
        return out;
      },
    };
  })();
  async function reload() {
    LIST = await STORE.list();
    const bytes = LIST.reduce((a, r) => a + (r.bytes || 0), 0); let free = null;
    try { const e = await navigator.storage.estimate(); if (e && Number.isFinite(e.quota)) free = Math.max(0, e.quota - (e.usage || 0)); } catch {}
    USAGE = { n: LIST.length, bytes, free };
    for (const id of [...BMPS.keys()]) if (!LIST.some(r => r.id === id)) BMPS.delete(id);
    bump();
  }
  const find = id => LIST.find(r => r.id === id) || null;
  /* a recording's thumbnail, drawable: decoded once from its stored JPEG (null until it is; the window is drawn again when it arrives) */
  function thumb(id) {
    if (BMPS.has(id)) return BMPS.get(id);
    const r = find(id); BMPS.set(id, null);
    if (r && r.thumb && typeof createImageBitmap === "function") createImageBitmap(r.thumb).then(b => { BMPS.set(id, b); bump(); }).catch(() => {});
    return null;
  }

/* ─────────────────────────────── THE FILE'S NAME: pattern + tokens ─────────────────────────────── */
  /* ── the file's name: {page} the file this page is (sampleproject, index, sample-project), {title} its title, {take} free or tour,
     {date} YYYY-MM-DD, {time} HH-mm, {size} WxH, {fps}; no accents, nothing a file system refuses, never empty ── */
  const slug = s => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  function fileName(pattern, c, ext, d = new Date()) {
    const map = { page: c.page, title: c.title, take: c.take, size: c.size, fps: c.fps, date: d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()), time: pad2(d.getHours()) + "-" + pad2(d.getMinutes()) };
    let s = String(pattern || "").replace(/\{(\w+)\}/g, (all, k) => k in map ? slug(map[k]) : "");
    s = s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, "_").replace(/_{2,}/g, "_").replace(/-{2,}/g, "-").replace(/^[._-]+|[._-]+$/g, "").slice(0, 120);
    return (s || "icloneOS") + (ext ? "." + ext : "");
  }
  const pageName = () => { try { return decodeURIComponent(location.pathname.split("/").pop() || "").replace(/\.html?$/i, "") || "page"; } catch { return "page"; } };
  const context = kind => ({ page: pageName(), title: EP.title || "", take: kind || SET.take });
  const example = () => { const p = plan(); return fileName(SET.pattern, { ...context(), size: p ? p.w + "x" + p.h : "", fps: p ? p.fps : "" }, p ? p.ext : "mp4"); };

/* ─────────────────────────────── THE SHORTCUTS: capture-phase keys, re-binding, Esc held vs tapped, modal windows ─────────────────────────────── */
  /* ── the shortcuts: read from the event (its code and modifiers), in the capture phase, before the page's own keys; never while a
     field is typed in. A plain key belongs to the page (Space, T, C, Esc, Enter): a shortcut needs Shift, Alt, Ctrl or Meta — or
     is an F-key. Esc held 0.7 s stops a take (a plain Esc still closes the app's open window). While the Camera & Action window,
     its preview, a field or a tour take has the page, no key reaches the app behind. ── */
  const BASES = { Space: "Space", Enter: "Enter", Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backslash: "\\" };
  function comboOf(e) {
    const c = e.code || "", base = /^Key[A-Z]$/.test(c) ? c.slice(3) : /^Digit\d$/.test(c) ? c.slice(5) : /^F\d{1,2}$/.test(c) ? c : BASES[c] || "";
    if (!base) return null;
    const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta"].filter(Boolean);
    return { text: [...mods, base].join("+"), bare: !mods.length && !/^F\d/.test(base) };
  }
  const typing = e => { const tg = e.target; return !!tg && (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA" || tg.isContentEditable); };
  const eat = e => { e.preventDefault(); e.stopPropagation(); };
  addEventListener("keydown", e => {
    if (st.capture) {                                  /* Behaviour → a shortcut is listening: the next combination is it */
      eat(e);
      if (e.key === "Escape") { st.capture = null; bump(); return; }
      if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
      const c = comboOf(e);
      if (!c) return say("That key cannot be a shortcut", false);
      if (c.bare) return say("Add Shift, Alt or Ctrl: plain keys are the page's own", false);
      const other = ["hotkey", "pauseKey", "panelKey"].find(k => k !== st.capture && SET[k] === c.text);
      if (other) return say(c.text + " is already " + DEF[other].label, false);
      const label = DEF[st.capture].label; setv(st.capture, c.text); st.capture = null; say(label + ": " + c.text); return;
    }
    if (st.edit) {                                     /* a field is being typed in: every key is its own */
      if (e.metaKey || e.ctrlKey) return;              /* ⌘V: the paste event below */
      eat(e);
      if (e.key === "Enter") commitEdit();
      else if (e.key === "Escape") { st.edit = null; bump(); }
      else if (e.key === "Backspace") { st.edit.text = st.edit.text.slice(0, -1); bump(); }
      else if (e.key.length === 1) typeInto(e.key);
      return;
    }
    if (typing(e)) return;
    if (e.key === "Escape" && (st.mode === "recording" || st.mode === "countdown")) {   /* held 0.7 s: the take stops. Tapped: a countdown is cancelled; in a take it is the page's own Esc, given when the key is released — so a held Esc does not close a window in the film before the stop */
      eat(e); if (!e.repeat) { if (st.mode === "countdown") stop("esc"); else st.esc = T(); } return;
    }
    const c = comboOf(e);
    if (c && c.text === SET.hotkey && !st.panel) { eat(e); if (!e.repeat) toggle(); return; }
    if (c && c.text === SET.pauseKey && !st.panel) { eat(e); if (!e.repeat) pauseToggle(); return; }
    if (c && c.text === SET.panelKey && !st.panel) { eat(e); if (!e.repeat) showWin(!st.win); return; }
    if (st.panel) {                                    /* the preview is modal: Esc keeps, Enter saves (the default button), Space plays or pauses */
      eat(e);
      if (e.key === "Escape") closePanel();
      else if (e.key === "Enter") { const id = st.panel.id; save(id).then(ok => { if (ok) closePanel(); }); }
      else if (e.key === " " && vid) { try { if (vid.paused) vid.play(); else vid.pause(); } catch {} }
      return;
    }
    if (locked()) { eat(e); return; }                  /* a tour take: Space, T and C would spoil it (the shortcut and Esc held still stop it) */
    if (st.win) {
      if (e.metaKey || e.ctrlKey) return;
      eat(e);
      if (e.key === "Escape") { st.win = false; st.arm = null; bump(); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") { const i = SECTIONS.findIndex(s => s[0] === st.sec), n = SECTIONS.length; st.sec = SECTIONS[(i + (e.key === "ArrowDown" ? 1 : n - 1)) % n][0]; st.arm = null; bump(); }
    }
  }, true);
  addEventListener("keyup", e => {
    if (e.key !== "Escape") return;
    if (st.esc && st.mode === "recording") {                                 /* a tap, not a hold: Esc does what it does without a take */
      if (st.panel) closePanel(); else if (st.win) { st.win = false; bump(); } else if (!locked() && mode === "live" && live) apply(live, { t: liveTime(), act: "close" });
    }
    st.esc = 0;
  }, true);
  addEventListener("blur", () => { st.esc = 0; });
  addEventListener("paste", e => { if (!st.edit) return; e.preventDefault(); for (const ch of String((e.clipboardData && e.clipboardData.getData("text")) || "")) typeInto(ch); });
  function typeInto(ch) {
    const E = st.edit, d = DEF[E.key];
    if (d.kind === "num") { if (!/[0-9.,]/.test(ch) || E.text.length >= 6) return; E.text += ch === "," ? "." : ch; }
    else { if (ch < " " || E.text.length >= d.max) return; E.text += ch; }
    bump();
  }
  function commitEdit() {
    const E = st.edit; if (!E) return; st.edit = null;
    const d = DEF[E.key];
    if (d.kind === "num") { const v = parseFloat(E.text); if (Number.isFinite(v)) setv(E.key, v); }
    else setv(E.key, E.text);
    bump();
  }
  /* a page hidden in the middle of a take (a covered window, another tab) draws nothing: the take is paused until it is back, so
     the video does not hold a frozen stretch — and a tour take's tour waits with it */
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { if (st.mode === "recording" && !st.paused) hold(true, "hidden"); return; }
    if (st.paused && st.paused.why === "hidden") { const s = Math.round((T() - st.paused.at) / 1000); hold(false); if (s >= 1) { if (stats) stats.hidden = (stats.hidden || 0) + s; say("The page was hidden for " + s + " s: left out of the video"); } }
  });

/* ─────────────────────────────── RECORDING: start, begin, encoder, scene, slot grid, take, pause, tick, stop, frames in the file ─────────────────────────────── */
  /* ── recording ───────────────────────────────────────────────────────────── */
  const TILES = document.createElement("canvas"), CAMT = { c: null, x: null, w: () => P.w, h: () => P.h, dpr: () => 1, tiles: TILES, tx: TILES.getContext("2d"), fit: () => P.view };   /* the video frame as a place the engine presents to */
  const fail = (msg, why = "") => { teardown(); st.mode = "idle"; st.cd = null; st.take = null; st.paused = null; say(msg, false, why); };
  function teardown() {
    try { if (stream) for (const t of stream.getTracks()) t.stop(); } catch {}
    comp = ctx = stream = track = mr = null; chunks = []; pend = []; P = null; dirty = false; thumbC = null;
  }
  const locked = () => !!st.take && st.take.kind === "tour" && (st.mode === "recording" || st.mode === "saving");
  function start(kind = SET.take, o = {}) {
    if (st.mode !== "idle") return false;
    kind = kind === "tour" ? "tour" : "free";
    if (kind === "tour" && STILL) { say("A still page has no tour to record", false); return false; }   /* ?still shows one frame: nothing plays */
    const p = plan();
    if (!p || !p.ok) { say(p ? "This browser cannot record a canvas" : "The page has no size yet", false); return false; }
    st.toast = null; st.take = { kind, auto: !!o.auto };
    const n = STILL || o.auto ? 0 : parseInt(SET.countdown, 10) || 0;     /* a still page has no clock to count on */
    if (n > 0) { st.mode = "countdown"; st.cd = { until: T() + n * 1000, n }; bump(); return true; }
    return begin();
  }
  function begin() {
    P = plan();
    if (!P || !P.ok) { fail("This browser cannot record a canvas"); return false; }
    try { comp = document.createElement("canvas"); comp.width = P.w; comp.height = P.h; ctx = comp.getContext("2d", { alpha: false }); CAMT.c = comp; CAMT.x = ctx; } catch (e) { fail("The recorder did not start:", String(e && e.message || e)); return false; }
    recId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); seq = 0; chunks = []; pend = []; thumbC = null;
    const kind = st.take.kind;
    born = { ...context(kind), size: P.w + "x" + P.h, fps: P.fps, at: new Date() };
    stats = { frames: 0, presented: 0, skipped: 0, retaken: 0, held: 0, copied: 0, drawn: 0, bytes: 0, chunks: 0 };
    t0 = T(); lastSlot = -1; lastAt = t0; dirty = false; lastFrame = null;
    st.mode = "recording"; st.cd = null; st.paused = null; st.edit = null; st.capture = null; beep(880); bump();
    if (kind === "tour") {                              /* the tour from its start (or from after the welcome), drawn now: that frame is the take's first */
      const s = SET.boot === "after" ? BOOT_S : 0;
      st.take.t0 = s; st.take.end = tourOf();
      mode = "tour"; paused = false; tourOffset = nowS() - s; renderTour(s); tourOffset = nowS() - s;
    } else if (STILL || paused) { redraw(); if (st.mode === "recording" && !stats.frames && lastA) take(true); }   /* a page that is not drawing: its frame is drawn again for the take (without what the take leaves out) and is the first */
    return st.mode === "recording";                    /* the encoder may already have refused */
  }
  /* the encoder, started by the first frame — after that frame is on the video's canvas: the stream's first frame (the one a player
     shows before it plays) is the scene, never an empty canvas */
  function encoder() {
    try {
      stream = comp.captureStream(P.pace === "fixed" ? P.fps : 0); track = stream.getVideoTracks()[0];
      mr = new MediaRecorder(stream, { mimeType: P.mime, videoBitsPerSecond: P.bps, videoKeyFrameIntervalDuration: SET.keyframe * 1000 });
      const slice = Math.round(SET.slice * 1000), id = recId, facts = { name: fileName(SET.pattern, born, P.ext, born.at), ext: P.ext, mime: P.mime.split(";")[0], codec: P.codec, w: P.w, h: P.h, fps: P.fps, slice, page: born.page, take: born.take };
      mr.ondataavailable = e => { if (!e.data || !e.data.size || !stats) return; chunks.push(e.data); stats.bytes += e.data.size; stats.chunks++; pend.push(STORE.chunk(id, seq++, e.data, facts)); };
      mr.onerror = e => { if (st.mode === "recording") fail("The recorder stopped:", (e.error && e.error.message) || "an encoder error"); };
      mr.start(slice); t0 = T(); lastAt = t0; return true;                 /* the take's clock starts with its first frame */
    } catch (e) { fail("The recorder did not start:", String(e && e.message || e)); return false; }
  }
  /* the engine presented a frame on the page's canvas (same task, nothing of ours on it — nothing of ours is ever on it) */
  function scene(t, sweepIn, sweepOut) {
    lastA = { t, sweepIn, sweepOut };
    if (st.mode === "recording" && ctx && !st.paused) take(false);
  }
  /* the video's rate is a grid of slots from the take's start, one frame a slot. A display faster than the video (120 Hz, 60 fps): the
     in-between frame falls in a slot that has its frame and is skipped. A display at the video's rate, however uneven its frames,
     loses none: a frame a quarter of a slot early is the next slot's, and a frame that comes two slots or more after the last leaves
     one slot of credit, so the frame close behind it (the display catching up) is taken too. Never more than the rate over time. */
  const slotAt = t => Math.floor((t - t0) * P.fps / 1000 + .25);
  function take(force) {
    let t = T(); const slot = mr ? slotAt(t) : 0;
    stats.presented++;
    const due = slot - lastSlot;
    if (due < 1 && !force) { dirty = true; stats.skipped++; return; }
    lastSlot = due >= 2 ? slot - 1 : Math.max(slot, lastSlot);
    if (P.same && !DEBUG.own && cv.width === P.w && cv.height === P.h) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(cv, 0, 0); stats.copied++; }   /* the page's canvas is the frame */
    else { present(lastA.t, lastA.sweepIn, lastA.sweepOut, CAMT, true); stats.drawn++; }                                                                  /* the same bitmap, at the video's size */
    if (!mr) { if (!encoder()) return; t = t0; }                         /* the first frame: now the encoder starts */
    if (P.pace !== "fixed") track.requestFrame();
    stats.frames++; lastAt = t; dirty = false; lastFrame = { t: t - t0, n: stats.frames, at: lastA.t };
    if (!thumbC && t - t0 >= (st.take.kind === "tour" ? 8000 : 1500)) thumbC = small(comp);   /* the thumbnail: a frame from inside the take (a tour ends on an empty field) */
  }
  /* the held frame sent once more (a long hold, the last moment before the stop): one pixel drawn onto itself marks the canvas new */
  const resend = () => { try { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(comp, 0, 0, 1, 1, 0, 0, 1, 1); if (P.pace !== "fixed") track.requestFrame(); } catch {} };
  /* a take paused (the pause pill, its shortcut, or a hidden page): the encoder is paused, the take's clock stops — and a tour take's
     tour with it — so the paused time is not in the video */
  function hold(on, why = "user") {
    if (st.mode !== "recording" || !mr) return;
    if (on && !st.paused) {
      try { mr.pause(); } catch {}
      st.paused = { at: T(), why }; if (st.take.kind === "tour" && !paused) { paused = true; pausedAt = nowS(); }
    } else if (!on && st.paused) {
      const d = T() - st.paused.at; t0 += d; lastAt += d; st.paused = null;
      try { mr.resume(); } catch {}
      if (st.take.kind === "tour" && paused) { tourOffset += nowS() - pausedAt; paused = false; }
    }
    bump();
  }
  const pauseToggle = () => { if (st.mode === "recording" && mr) hold(!st.paused); };
  /* the recorder's clock, once per display frame, before the engine draws */
  function tick() {
    const t = T(), dt = st.tickAt ? t - st.tickAt : 0; st.tickAt = t;
    if (st.esc && t - st.esc >= HOLD_ESC) { st.esc = 0; stop("esc"); return; }
    if (st.toast && (st.hover || "").startsWith("toast")) st.toast.t0 += dt;   /* the pointer over the thumbnail holds it */
    if (st.mode === "countdown") { if (t >= st.cd.until) begin(); return; }
    if (st.mode !== "recording" || st.paused) return;
    if (st.take.kind === "tour") {
      if (paused) { hold(true, "page"); return; }                           /* the page was paused under a tour take: the take pauses with it, never a frozen stretch on the clock */
      if (mr && nowS() - tourOffset >= st.take.end - .5 / P.fps) { tourDone(); return; }
    }
    else if (SET.max > 0 && mr && t - t0 >= SET.max * 60000) { stop("max"); return; }
    if (dirty && (paused || STILL) && mr && slotAt(t) > lastSlot) { stats.retaken++; take(true); return; }   /* the last frame drawn was over the rate and nothing draws after it */
    if (mr && stats.frames && t - lastAt >= HEARTBEAT) { resend(); lastAt = t; stats.held++; }
  }
  /* the tour reached its end: its last frame (the field, swept clean) is the take's last, then the take stops by itself */
  function tourDone() { paused = true; pausedAt = nowS(); renderTour(st.take.end - .001); if (dirty) take(true); stop("tour"); }
  function small(src, max = 480, sw = src.width, sh = src.height) {
    const k = Math.min(1, max / sw), c = document.createElement("canvas"); c.width = Math.max(2, Math.round(sw * k)); c.height = Math.max(2, Math.round(sh * k));
    const x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(src, 0, 0, c.width, c.height); return c;
  }
  /* a recovered take has no thumbnail (its page died before it could make one): one frame of it is read back, and its size with it */
  async function thumbOf(r) {
    let url = "";
    try {
      const v = document.createElement("video"); v.muted = true; v.preload = "auto"; url = URL.createObjectURL(r.blob); v.src = url;
      await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; setTimeout(rej, 8000); });
      await new Promise(res => { v.onseeked = res; v.currentTime = Math.min(1.5, (Number.isFinite(v.duration) ? v.duration : 2) / 2); setTimeout(res, 3000); });
      if (!v.videoWidth) return;
      const c = small(v, 480, v.videoWidth, v.videoHeight), b = await jpeg(c); if (!b) return;
      r.thumb = b; if (!r.w) { r.w = v.videoWidth; r.h = v.videoHeight; }
      await STORE.put(r); await reload(); BMPS.set(r.id, c); bump();       /* the list is read again: it holds the store's own copies */
    } catch {} finally { if (url) URL.revokeObjectURL(url); }
  }
  const jpeg = c => new Promise(r => { try { c.toBlob(b => r(b), "image/jpeg", .84); } catch { r(null); } });
  /* the frames that are really in an MP4 the recorder made: its fragments' own counts (moof → traf → trun), read from the file.
     The recorder knows the frames it SENT; an encoder that cannot keep up (a saturated machine, several takes at once) drops some
     without a word — measured: six takes of 3024 x 1964 at once sent 59 fps each and kept 35 in their files. Only the
     headers are read (a few bytes a fragment). null for a WebM, or when the file is not in fragments. */
  async function framesIn(blob) {
    try {
      const head = async o => new DataView(await blob.slice(o, o + 16).arrayBuffer()), name = (d, o) => String.fromCharCode(d.getUint8(o), d.getUint8(o + 1), d.getUint8(o + 2), d.getUint8(o + 3));
      let off = 0, n = 0, seen = false;
      for (let guard = 0; off + 8 <= blob.size && guard < 200000; guard++) {
        const h = await head(off); let size = h.getUint32(0); const type = name(h, 4);
        if (size === 1) size = h.getUint32(8) * 4294967296 + h.getUint32(12);
        if (size < 8) break;
        if (type === "moof") {
          seen = true; const d = new DataView(await blob.slice(off, off + size).arrayBuffer());
          const walk = (a, b) => { for (let q = a; q + 8 <= b;) { const sz = d.getUint32(q), t = name(d, q + 4); if (sz < 8) break; if (t === "traf") walk(q + 8, q + sz); else if (t === "trun") n += d.getUint32(q + 12); q += sz; } };
          walk(8, size);
        }
        off += size;
      }
      return seen ? n : null;
    } catch { return null; }
  }
  async function stop(why = "user") {
    if (st.mode === "countdown") { st.mode = "idle"; st.cd = null; st.take = null; bump(); return null; }
    if (st.mode !== "recording") return null;
    /* the page is its own again: after a tour take the tour plays from its start; a page that is not drawing shows its frame with everything back */
    const tk = st.take, free = () => { if (tk.kind === "tour") { paused = false; tourOffset = nowS(); } else if (STILL || paused) { try { redraw(); } catch {} } };
    if (!mr) { teardown(); st.mode = "idle"; st.take = null; stats = null; free(); say("Nothing was recorded: the page drew no frame", false); return null; }
    const ms = elapsed(), wasPaused = !!st.paused; st.mode = "saving"; bump();
    const pl = P, sts = stats, id = recId, c0 = born; let r = null, slow = "", why2 = "";
    try {
      if (!wasPaused) { resend(); await new Promise(res => setTimeout(res, 80)); }   /* the video ends where the take ended, not at its last new frame */
      const done = new Promise(res => { mr.onstop = res; });
      mr.stop(); await done; await Promise.allSettled(pend);
      const type = pl.mime.split(";")[0], blob = new Blob(chunks, { type }), sm = thumbC || small(comp), tb = await jpeg(sm);
      const kept = pl.ext === "mp4" ? await framesIn(blob) : null, inFile = kept === null ? sts.frames : kept;   /* the file's own count, where it can be read */
      r = { id, name: fileName(SET.pattern, c0, pl.ext, c0.at), ext: pl.ext, mime: type, codec: pl.codec, w: pl.w, h: pl.h, fps: pl.fps, ms, bytes: blob.size, at: Date.now(), frames: inFile, page: c0.page, title: c0.title, take: c0.take, blob, thumb: tb };
      BMPS.set(id, sm);
      const stored = await STORE.put(r);
      last = { id, name: r.name, ms, bytes: blob.size, frames: sts.frames, encoded: inFile, counted: kept !== null, fps: inFile / Math.max(.001, ms / 1000), sent: sts.frames / Math.max(.001, ms / 1000), skipped: sts.skipped, retaken: sts.retaken, held: sts.held, presented: sts.presented, copied: sts.copied, drawn: sts.drawn,
        w: pl.w, h: pl.h, ext: pl.ext, codec: pl.codec, mbps: blob.size * 8 / Math.max(.001, ms / 1000) / 1e6, stored, take: c0.take, why };
      beep(440); if (!stored) say("No storage here: save this take now", false);
      if (ms > 3000 && sts.held < 2 && !sts.hidden && last.fps < pl.fps * .9) { slow = Math.round(last.fps) + " of " + pl.fps + " fps"; why2 = last.sent >= pl.fps * .9 ? "the encoder did not keep up" : "the page drew no faster"; }   /* the take could not keep its rate: said when it ends, with which of the two it was */
    } catch (e) { teardown(); st.mode = "idle"; st.take = null; st.paused = null; stats = null; free(); say("The take could not be finished:", false, String(e && e.message || e)); await reload(); return null; }
    teardown(); st.mode = "idle"; st.take = null; st.paused = null; stats = null; free();
    await reload();
    /* a series: the next episode's tour take (a take stopped by hand ends the series) */
    if (CHAIN) {
      if (why !== "tour") { CHAIN = null; landed(r, slow, why2); say("The series was stopped here", false); return r; }
      if (SET.after === "download") await save(id, true);
      const [next, ...rest] = CHAIN.rest; setTimeout(() => { location.href = next ? next + "?rec=tour" + (rest.length ? "&chain=" + rest.map(encodeURIComponent).join(",") : "") + (CHAIN.back ? "&back=" + encodeURIComponent(CHAIN.back) : "") : (CHAIN.back || "index.html") + "?camera=takes"; }, 900);
      say(next ? "Next episode…" : "The series is recorded"); return r;
    }
    if (SET.after === "preview") { openPanel(id); if (slow) say(slow + " recorded: " + why2, false); } else { landed(r, slow, why2); if (SET.after === "download") save(id, true); }
    bump(); return r;
  }
  /* a finished take shows itself: its thumbnail under the island — or, with the window open (the thumbnail would cover it), a line of words */
  function landed(r, slow = "", why2 = "") {
    if (st.win) say("Take saved · " + fmtDur(r.ms) + " · " + fmtBytes(r.bytes) + " · " + (slow || "in Recordings"), !slow);     /* one note says both */
    else { st.toast = { id: r.id, t0: T() }; if (slow) say(slow + " recorded: " + why2, false); }
  }
  const toggle = () => { if (st.mode === "idle") start(); else if (st.mode === "recording" || st.mode === "countdown") stop("user"); };

/* ─────────────────────────────── SAVE / DELETE ─────────────────────────────── */
  /* ── Save… / Delete / Keep for later ─────────────────────────────────────── */
  /* Save: called straight from the click (the system's save panel needs the gesture: nothing is awaited before it); no panel, a
     refusal, Save → Downloads or `direct`: an ordinary download */
  async function save(id, direct = false) {
    const r = find(id); if (!r) return false;
    if (!direct && SET.save === "ask" && typeof window.showSaveFilePicker === "function") {
      try {
        const h = await window.showSaveFilePicker({ suggestedName: r.name, types: [{ description: r.ext.toUpperCase() + " video", accept: { [r.mime]: ["." + r.ext] } }] });
        const w = await h.createWritable(); await w.write(r.blob); await w.close();
        say("Saved", true, h.name || r.name); return true;
      } catch (e) { if (e && e.name === "AbortError") return false; }
    }
    try {
      const a = document.createElement("a"), url = URL.createObjectURL(r.blob);
      a.href = url; a.download = r.name; a.style.display = "none"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
      say("Saved to Downloads"); return true;
    } catch (e) { say("Could not save:", false, String(e && e.message || e)); return false; }
  }
  async function remove(id) { if (st.panel && st.panel.id === id) closePanel(); if (st.toast && st.toast.id === id) st.toast = null; BMPS.delete(id); await STORE.remove(id); await reload(); }
  async function clearAll() { closePanel(); st.toast = null; BMPS.clear(); for (const r of LIST) await STORE.remove(r.id); await STORE.clear(); await reload(); }

/* ─────────────────────────────── THE PREVIEW: the browser's own <video controls> over the window's well ─────────────────────────────── */
  /* ── the preview's video: the one DOM element of the module — the browser's own <video controls>, placed over the preview's well ── */
  function openPanel(id) {
    const r = find(id); if (!r) return false;
    closePanel(); st.panel = { id }; st.edit = null; st.capture = null; if (st.toast && st.toast.id === id) st.toast = null;
    try {
      if (!vid) {
        vid = document.createElement("video"); vid.controls = true; vid.playsInline = true; vid.preload = "auto"; vid.setAttribute("aria-label", "Recording preview");
        vid.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;z-index:3;margin:0;padding:0;border:0;outline:none;background:#000;object-fit:contain;display:none";
        /* a WebM from MediaRecorder carries no duration: a seek past its end makes the browser find it */
        vid.addEventListener("loadedmetadata", () => { if (vid.duration === Infinity) { const back = () => { vid.removeEventListener("timeupdate", back); vid.currentTime = 0; }; vid.addEventListener("timeupdate", back); vid.currentTime = 1e7; } });
        document.body.appendChild(vid);
      }
      vidUrl = URL.createObjectURL(r.blob); vid.src = vidUrl;
    } catch {}
    bump(); return true;
  }
  function closePanel() {
    if (!st.panel) return;
    st.panel = null; st.hover = null; st.press = null;
    try { if (vid) { vid.pause(); vid.removeAttribute("src"); vid.load(); vid.style.display = "none"; } if (vidUrl) URL.revokeObjectURL(vidUrl); } catch {}
    vidUrl = ""; bump();
  }

/* ─────────────────────────────── THE RECORDER'S OWN CANVAS (#camui): layers presented as tiles ─────────────────────────────── */
  /* ── the recorder's own canvas: #camui, over the page's, the same size, deaf to the pointer (the page's canvas hears it and the
     engine asks us first). Three 1-bit layers the size of the Mac, each with its paint — the window (Camera & Action, or the
     preview), the chrome (the island, the note, the thumbnail, the countdown, the opacity rail), the pointer — presented the
     engine's way: a tile is a tile, ink is the field at 20 %, paper is the field (painted over whatever the page shows below). ── */
  const ui = document.createElement("canvas"); ui.id = "camui"; ui.setAttribute("aria-hidden", "true");
  ui.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2;display:block;cursor:none";
  document.body.appendChild(ui);
  const ux = ui.getContext("2d");
  const mk = (w, h, o) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d", o); x.imageSmoothingEnabled = false; return [c, x]; };
  function layer() {
    const [c, x] = mk(WW, WH, { willReadFrequently: true }), [, pi] = mk(WW, WH, { willReadFrequently: true }), [, pp] = mk(WW, WH, { willReadFrequently: true });
    const pc = { ink: pi, plate: pp };
    return { c, x, pc, B: kit(x, pc), rects: [], images: [], clear() { x.clearRect(0, 0, WW, WH); pi.clearRect(0, 0, WW, WH); pp.clearRect(0, 0, WW, WH); this.rects = []; this.images = []; },
      mark(rx, ry, rw, rh) { const x0 = Math.max(0, Math.floor(rx)), y0 = Math.max(0, Math.floor(ry)), x1 = Math.min(WW, Math.ceil(rx + rw)), y1 = Math.min(WH, Math.ceil(ry + rh)); if (x1 > x0 && y1 > y0) this.rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }); } };
  }
  const LW = layer(), LC = layer(), LK = layer();
  const [SCc, SCx] = mk(WW, WH), [SSc, SSx] = mk(WW, WH), [STc, STx] = mk(WW, WH), [DVc, DVx] = mk(2, 2);   /* cover · shadow · tiles (world size) · the tiles with their gaps cut (device size) */
  function presentLayer(L, alpha, top, bot) {
    const V = lastView, Pz = V.P, VH_ = SCREEN.h(), D = SCREEN.dpr();
    for (const R of L.rects) {
      const img = L.x.getImageData(R.x, R.y, R.w, R.h).data, pi = L.pc.ink.getImageData(R.x, R.y, R.w, R.h).data, pp = L.pc.plate.getImageData(R.x, R.y, R.w, R.h).data;
      const cd = SCx.createImageData(R.w, R.h), sd = SSx.createImageData(R.w, R.h), td = STx.createImageData(R.w, R.h); let any = false;
      for (let j = 0; j < R.h; j++) {
        const v = clamp((V.oy + (R.y + j + .5) * Pz) / VH_), fr = lerp(top[0], bot[0], v), fg = lerp(top[1], bot[1], v), fb = lerp(top[2], bot[2], v);
        for (let i = 0; i < R.w; i++) {
          const k = (j * R.w + i) * 4; if (img[k + 3] < 128) continue; any = true;
          cd.data[k] = fr; cd.data[k + 1] = fg; cd.data[k + 2] = fb; cd.data[k + 3] = 255;
          const ink = img[k] <= 127, pd = ink ? pi : pp, painted = pd[k + 3] >= 128; if (!ink && !painted) continue;
          td.data[k] = painted ? pd[k] * PAINT_MIX + fr * (1 - PAINT_MIX) : fr * INK_K; td.data[k + 1] = painted ? pd[k + 1] * PAINT_MIX + fg * (1 - PAINT_MIX) : fg * INK_K; td.data[k + 2] = painted ? pd[k + 2] * PAINT_MIX + fb * (1 - PAINT_MIX) : fb * INK_K; td.data[k + 3] = 255;
          sd.data[k + 3] = 255;
        }
      }
      if (!any) continue;
      SCx.clearRect(0, 0, WW, WH); SSx.clearRect(0, 0, WW, WH); STx.clearRect(0, 0, WW, WH); SCx.putImageData(cd, 0, 0); SSx.putImageData(sd, 0, 0); STx.putImageData(td, 0, 0);
      const dx = V.ox + R.x * Pz, dy = V.oy + R.y * Pz, dw = R.w * Pz, dh = R.h * Pz;
      ux.setTransform(D, 0, 0, D, 0, 0); ux.imageSmoothingEnabled = false; ux.globalAlpha = alpha; ux.drawImage(SCc, 0, 0, R.w, R.h, dx, dy, dw, dh);
      ux.save(); ux.beginPath(); ux.rect(dx, dy, dw, dh); ux.clip(); ux.imageSmoothingEnabled = true; ux.globalAlpha = .32 * alpha; ux.filter = `blur(${(Pz * .32 * D).toFixed(1)}px)`; ux.drawImage(SSc, 0, 0, R.w, R.h, dx, dy + Pz * .4, dw, dh); ux.restore();
      /* the tiles, their gaps cut as the engine cuts them (from 4 device pixels a tile) */
      const px0 = Math.max(0, Math.floor(dx * D) - 1), py0 = Math.max(0, Math.floor(dy * D) - 1), px1 = Math.min(ui.width, Math.ceil((dx + dw) * D) + 1), py1 = Math.min(ui.height, Math.ceil((dy + dh) * D) + 1);
      if (px1 <= px0 || py1 <= py0) continue;
      DVx.setTransform(1, 0, 0, 1, 0, 0); DVx.globalCompositeOperation = "source-over"; DVx.clearRect(px0, py0, px1 - px0, py1 - py0); DVx.setTransform(D, 0, 0, D, 0, 0); DVx.imageSmoothingEnabled = false;
      DVx.drawImage(STc, 0, 0, R.w, R.h, dx, dy, dw, dh);
      if (Pz * D >= 4) { DVx.globalCompositeOperation = "destination-out"; DVx.fillStyle = "#000"; const gw = Pz * GAP_TILE; for (let i = 0; i <= R.w; i++) DVx.fillRect(dx + i * Pz - gw / 2, dy, gw, dh); for (let j = 0; j <= R.h; j++) DVx.fillRect(dx, dy + j * Pz - gw / 2, dw, gw); DVx.globalCompositeOperation = "source-over"; }
      ux.setTransform(1, 0, 0, 1, 0, 0); ux.globalAlpha = alpha; ux.drawImage(DVc, px0, py0, px1 - px0, py1 - py0, px0, py0, px1 - px0, py1 - py0);
    }
    ux.setTransform(D, 0, 0, D, 0, 0); ux.imageSmoothingEnabled = true; ux.imageSmoothingQuality = "high"; ux.globalAlpha = alpha;
    for (const im of L.images) { try { ux.drawImage(im.src, V.ox + im.x * Pz, V.oy + im.y * Pz, im.w * Pz, im.h * Pz); } catch {} }
    ux.globalAlpha = 1;
  }

/* ─────────────────────────────── POINTER ROUTING: first refusal on the page's pointer ─────────────────────────────── */
  /* ── the pointer: the recorder's own controls take it first (the engine asks before the app does) ── */
  const hitAt = (x, y) => { for (let i = HITS.length - 1; i >= 0; i--) { const h = HITS[i]; if (x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h) return h; } return null; };
  const PASSIVE = new Set(["island", "toast", "win.body"]);
  const railTo = x => setv("opacity", Math.round((100 - clamp((RAIL.x + RAIL.w - 3.5 - x) / (RAIL.w - 7)) * 85) / 5) * 5);   /* the knob's right end is 100 % */
  function move(x, y) {
    mx = x; my = y;
    if (x < 0) { if (st.hover || st.over) { st.hover = null; st.over = false; bump(); } return false; }
    if (st.drag === "rail") { railTo(x); return true; }
    const h = hitAt(x, y), id = h && !PASSIVE.has(h.id) ? h.id : null;
    if (st.press) { const inside = !!h && h.id === st.press.id; if (inside !== st.press.inside) { st.press.inside = inside; bump(); } }
    if (id !== st.hover) { st.hover = id; bump(); }
    const over = !!h || !!st.panel; if (over !== st.over) { st.over = over; bump(); }
    return over || locked();
  }
  function down(x, y) {
    mx = x; my = y; const h = hitAt(x, y);
    if (st.edit && (!h || h.id !== "edit:" + st.edit.key)) commitEdit();
    if (st.capture && (!h || h.id !== "key:" + st.capture)) { st.capture = null; bump(); }
    if (!h) return !!st.panel || locked();             /* the preview is modal; a tour take keeps the page */
    if (h.id === "rail") { st.drag = "rail"; railTo(x); return true; }
    st.press = { id: h.id, inside: true }; bump(); return true;
  }
  function up(x, y) {
    if (st.drag) { st.drag = null; bump(); return true; }
    const p = st.press; st.press = null; if (!p) return false;
    const h = hitAt(x, y); bump();
    if (h && h.id === p.id) act(p.id);
    return true;
  }
  function wheel(x, y, dy) {
    if (st.panel) return true;
    const h = hitAt(x, y); if (!h) return locked();
    if (h.id === "rail") { setv("opacity", SET.opacity + (dy > 0 ? -5 : 5)); return true; }
    if (st.win && x >= WIN.x && x < WIN.x + WIN.w + 2 && y >= WIN.y && y < WIN.y + WIN.h + 2) {
      st.wheel += dy;
      while (Math.abs(st.wheel) >= 40) { const s = Math.sign(st.wheel); st.wheel -= s * 40; st.scroll[st.sec] = clamp((st.scroll[st.sec] || 0) + s, 0, st.max || 0); }
      bump();
    }
    return true;
  }

/* ─────────────────────────────── BOOT: earlier takes, recovery, deep links, autostart, series ─────────────────────────────── */
  /* ── the page is ready (the engine calls this once): what earlier visits left, then what the address asks for —
     ?camera=<section> opens the window there · ?rec=tour|free starts a take by itself · &chain=a.html,b.html&back=index.html: a series ── */
  const recoverPass = () => STORE.recover(recId).then(rs => {
    if (rs.length) reload().then(() => { say(rs.length === 1 ? "Recovered an interrupted take" : "Recovered " + rs.length + " interrupted takes"); rs.forEach(thumbOf); });
    if (rs.wait > 0) setTimeout(recoverPass, rs.wait + 250);
  }).catch(() => {});
  function boot() {
    reload().catch(() => {});
    if (!STILL) setTimeout(recoverPass, RECOVER_MS);
    const sec = Q.get("camera"); if (sec && SECTIONS.some(s => s[0] === sec)) showWin(true, sec);
    const rec = Q.get("rec");
    if ((rec === "tour" || rec === "free") && !STILL) {
      if (Q.has("chain") || Q.has("back")) CHAIN = { rest: (Q.get("chain") || "").split(",").map(s => { try { return decodeURIComponent(s); } catch { return s; } }).filter(s => /^[\w.-]+\.html$/.test(s)), back: /^[\w.-]+\.html$/.test(Q.get("back") || "") ? Q.get("back") : "" };
      setTimeout(() => { if (!start(rec, { auto: true })) CHAIN = null; }, 800);
    }
    bump();
  }

/* ─────────────────────────────── THE PUBLIC FACE (what the host engine calls) ─────────────────────────────── */
  return {
    on: true, scene, tick, ui: uiFrame, move, down, up, wheel, boot, locked,
    cursor(cur, where) {                               /* before a frame is drawn: is the Mac's pointer part of it? */
      lastWhere = where;
      const rec = st.mode === "recording";
      const out = where === "live" ? (st.over || !!st.panel || (rec && SET.pointer !== "always")) : (rec && SET.pointer === "never");
      if (!out) return;
      /* out of the frame means away from the app too: hidden AND moved off the screen, so nothing under it hovers or looks pressed
         (the app's windows test the pointer's place, not always its `hidden`). A drag in progress keeps its place: it turns the iNFT. */
      cur.hidden = true; if (!(where === "live" && live && live.drag)) { cur.x = -50; cur.y = -50; cur.down = false; }
    },
    mute: () => st.mode === "recording" && SET.narrator === "off",
    clock: () => (st.mode === "recording" && SET.clock === "941" ? "9:41" : null),
    busy: () => st.mode !== "idle" || st.win || !!st.panel,
    idle: () => SET.idle,
    field: c => { if (!Q.has("color")) setv("field", c, true); else SET.field = c; bump(); },
    live: () => st.mode === "recording", state, start, stop, toggle, hold, plan, summary, caps, diag, example, TOKENS, fileName, SET, set: setv, DEFS, SECTIONS,
    list: () => LIST, find, save, remove, clear: clearAll, reload, open: openPanel, close: closePanel,
    blob: id => { const r = find(id); return r ? r.blob : null; }, frame: () => comp, canvas: () => ui, debug: DEBUG, fmtDur, fmtBytes,
    show: showWin,
  };
}
