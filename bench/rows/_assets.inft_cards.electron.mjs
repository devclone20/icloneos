// Electron main of the `assets.inft_cards` row: an offscreen renderer paints an iNFT Book of 1 000 cards whose images
// go through the real thumbnail limiter (src/app/settings/inft-book/thumb-cache.ts, bundled by the row) exactly as
// book-card.tsx uses it: wait for a slot, set src (decoding=async), give the slot back on load or error.
//
// BENCH_ARGS.plan is a list of mounts run in order inside this one process:
//   { kind: 'fresh' | 'reload', delayMs, firstPageOnly, broken: [card ids] }
// 'fresh'  = a new window in its own in-memory partition (empty HTTP cache, own renderer process, own image cache);
// 'reload' = the previous window loads the Book again (warm: HTTP cache and renderer kept).
// delayMs is added by the image server before every image response of that mount; `broken` ids are answered with a
// 404 (even position in the list) or 200 + bytes that are not a PNG (odd position), so their <img> fires `error`.
// Every mount reports how many cards fired `load` and how many fired `error`; the row asserts the counts.
// Writes `{ runs, peak }` to BENCH_ARGS.result (bench/lib/child_result.mjs) and exits by itself.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'

import { writeResult } from '../lib/child_result.mjs'

const args = JSON.parse(process.env.BENCH_ARGS ?? '{}')
const dbg = text => process.env.BENCH_DEBUG && process.stderr.write(`${text}\n`)
dbg('main start')
app.setPath('userData', path.join(args.scratch, 'userData'))
app.dock?.hide()
// A hard stop: a run that cannot finish must fail loudly, never hang the harness.
setTimeout(() => {
  process.stderr.write('assets.inft_cards: timed out after 150 s\n')
  app.exit(1)
}, 150_000).unref()

const page = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#0b0b0c}
#grid{display:grid;grid-template-columns:repeat(10,120px);gap:8px}img{width:120px;height:120px;display:block}</style>
<div id="grid"></div><script src="/thumb-cache.js"></script><script>
const { requestThumbSlot, rememberThumb, thumbKey } = ThumbCache
const CARDS = ${Number(args.cards)}, PAGE = 50, WINDOW = 100
const grid = document.getElementById('grid'), mounted = []
const count = { loaded: 0, errored: 0 }
const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
function mount(i) {
  return new Promise(resolve => {
    const img = document.createElement('img')
    img.decoding = 'async'; img.alt = ''
    grid.appendChild(img); mounted.push(img)
    const release = requestThumbSlot(() => {
      img.onload = () => {
        count.loaded++
        rememberThumb(thumbKey({ id: 'base:0xbook:' + i, imageUrl: img.src }), 'ok'); release(); resolve()
      }
      img.onerror = () => { count.errored++; release(); resolve() }
      img.src = '/img/' + i + '.png'
    })
    while (mounted.length > WINDOW) mounted.shift().remove()   // the virtual window unmounts what scrolled out
  })
}
window.runBook = async firstPageOnly => {
  const firstPage = []
  for (let i = 0; i < PAGE; i++) firstPage.push(mount(i))
  await Promise.all(firstPage)
  await frame()
  const firstPaint = performance.now()
  const firstPageCount = { ...count }
  const total = firstPageOnly ? PAGE : CARDS
  for (let i = PAGE; i < total; i += PAGE) {
    const batch = []
    for (let k = i; k < Math.min(total, i + PAGE); k++) batch.push(mount(k))
    await Promise.all(batch); await frame()
  }
  return { firstPaint, all: performance.now(), mounted: total, firstPage: firstPageCount, ...count }
}
</script>`

let current = { delayMs: 0, broken: [] }
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/book.html') return res.end(page)
  if (req.url === '/thumb-cache.js') return res.end(fs.readFileSync(args.bundle))
  const m = /^\/img\/(\d+)\.png$/.exec(req.url)
  if (!m) return res.writeHead(404).end()
  const id = Number(m[1])
  const { delayMs, broken } = current
  setTimeout(() => {
    const at = broken.indexOf(id)
    if (at >= 0 && at % 2 === 0) return res.writeHead(404).end()
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' })
    if (at >= 0) return res.end(Buffer.from(`not a png ${id} `.repeat(64)))
    res.end(fs.readFileSync(path.join(args.images, `${id}.png`)))
  }, delayMs)
})

// Offscreen windows are never put on screen; `show: false` on top of offscreen stops frame production (rAF never fires).
const open = partition =>
  new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, partition }
  })

// The previous mount's window is gone (renderer and its image cache released) before the next one opens.
const close = win =>
  win && !win.isDestroyed() ? new Promise(resolve => (win.once('closed', resolve), win.close())) : Promise.resolve()

// A throw in the async main must end the process now, not after the row's timeout.
process.on('unhandledRejection', err => {
  console.error(err)
  process.exit(1)
})

// No top-level await in an ESM main: Electron emits `ready` only after the entry module has finished evaluating.
app
  .whenReady()
  .then(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${server.address().port}/book.html`
    let peak = { totalMB: 0, rendererMB: 0 }
    const sampler = setInterval(() => {
      const metrics = app.getAppMetrics()
      const total = metrics.reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024
      const renderer = metrics.filter(m => m.type === 'Tab').reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024
      peak = { totalMB: Math.max(peak.totalMB, total), rendererMB: Math.max(peak.rendererMB, renderer) }
    }, 50)
    const runs = []
    let win = null
    for (const [i, mount] of args.plan.entries()) {
      if (mount.kind !== 'reload' || !win) {
        await close(win)
        // A partition name without `persist:` is in-memory: a fresh HTTP cache and a renderer of its own per mount.
        win = open(`bench-mount-${i}`)
      }
      current = { delayMs: Number(mount.delayMs ?? 0), broken: mount.broken ?? [] }
      await win.loadURL(url)
      dbg(`mount ${i} ${JSON.stringify(mount)}`)
      runs.push(await win.webContents.executeJavaScript(`runBook(${Boolean(mount.firstPageOnly)})`))
    }
    clearInterval(sampler)
    await close(win)
    writeResult(args.result, { runs, peak })
    server.close()
    app.quit()
  })
  .catch(error => {
    // Any failed mount is a failed run: exit non-zero so the row reports an error, never a partial result.
    process.stderr.write(`assets.inft_cards: ${error?.stack ?? error}\n`)
    app.exit(1)
  })
