/* Camera & Action — MINIMAL PORTABLE RECORDER (architecture A: a scene canvas + DOM UI), ≈ 90 lines, no dependencies.
 * From the original method doc (Sample Project, §12.2). A skeleton to start from: it lacks the slot grid with credit,
 * held-frame heartbeats, pause, IndexedDB slices, frames-in-the-file and the UI — take those from recorder-core.js.
 * Host contract: call rec.presented() whenever a frame was really presented, and rec.frameEnd(canvas) at the END of every
 * frame (after the last pass), in the same task that drew it. Register rec's rAF after the host loop.
 */
// recorder-min.js — in-page canvas recorder (no screen capture). Host must call rec.frameEnd(canvas) at the end of
// every frame, in the same task that drew it, and rec.presented() whenever a frame was really presented.
export class MiniRecorder {
  constructor({ canvas, fps = 60, mbps = 24, overlays = () => {}, isResting = () => false }) {
    Object.assign(this, { canvas, fps, mbps, overlays, isResting, state: 'idle' });
    this.copy = document.createElement('canvas'); this.fresh = false; this.live = null; this.wasPresented = false;
  }
  presented() { this.wasPresented = true; }
  frameEnd(cv) {                                   // host hook: all passes are on the canvas now
    if (this.state !== 'recording' || !this.wasPresented) return;
    this.wasPresented = false; this.live = cv;
    if (!this.isResting()) { this.fresh = false; return; }          // moving: composite straight from cv in #tick
    if (this.copy.width !== cv.width || this.copy.height !== cv.height) { this.copy.width = cv.width; this.copy.height = cv.height; }
    this.copy.getContext('2d', { alpha: false }).drawImage(cv, 0, 0); this.fresh = true;   // parked: keep the still
  }
  start() {
    const w = this.canvas.width & ~1, h = this.canvas.height & ~1;
    this.comp = Object.assign(document.createElement('canvas'), { width: w, height: h });
    this.ctx = this.comp.getContext('2d', { alpha: false });
    const mp4 = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1');
    this.mime = mp4 ? 'video/mp4;codecs=avc1' : 'video/webm;codecs=vp9';
    this.stream = this.comp.captureStream(0); this.track = this.stream.getVideoTracks()[0];
    this.mr = new MediaRecorder(this.stream, { mimeType: this.mime, videoBitsPerSecond: this.mbps * 1e6 });
    this.chunks = []; this.mr.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.done = new Promise((r) => (this.mr.onstop = r));
    this.mr.start(1000); this.state = 'recording'; this.nextAt = 0; this.frames = 0;
    requestAnimationFrame(this.tick);             // registered AFTER the host loop → runs after frameEnd in the same task
  }
  tick = (now) => {
    if (this.state !== 'recording') return;
    requestAnimationFrame(this.tick);
    const live = this.live; this.live = null;
    const iv = 1000 / this.fps;
    if (this.nextAt && now < this.nextAt - 2) return;
    this.nextAt = this.nextAt && now - this.nextAt < iv ? this.nextAt + iv : now + iv;
    const src = live ?? (this.fresh ? this.copy : null);
    if (!src && this.frames > 0) return;          // nothing presented: hold (exactly what the screen shows)
    const c = this.ctx, { width: W, height: H } = this.comp;
    c.setTransform(1, 0, 0, 1, 0, 0);
    if (src) c.drawImage(src, 0, 0, W, H); else { c.fillStyle = '#000'; c.fillRect(0, 0, W, H); }
    const s = W / (this.canvas.clientWidth || innerWidth);   // output px per CSS px
    c.setTransform(s, 0, 0, s, 0, 0);
    this.overlays(c, s);                           // draw ONLY allowed sources, from their own data (never the screen)
    this.track.requestFrame(); this.frames++;
  };
  async stop() {
    if (this.state !== 'recording') return null;
    this.state = 'idle'; this.mr.stop(); await this.done;
    for (const t of this.stream.getTracks()) t.stop();
    return new Blob(this.chunks, { type: this.mime.split(';')[0] });   // → <video src=URL.createObjectURL(blob)> / save
  }
}
