// Hard-reload the renderer over CDP (no-HMR dev runs don't apply edits on
// their own), then print whether the perf probe and the composer came back.
//
//   node scripts/reload.mjs
//
// Targets the 5174 dev renderer first, else any http(s) page (a renderer on
// another dev port — what the merged reload-renderer.mjs did). It refuses
// devtools:// and file:// pages: reloading one of those is never the intent.
import { CDP, devTargetOrExit, SELECTORS, sleep } from './lib/cdp.mjs'

const target = await devTargetOrExit({ prefer: '5174' })

if (!String(target.url).startsWith('http')) {
  console.error(`renderer not found: the only page target is ${target.url}`)
  process.exit(1)
}

const cdp = await CDP.open(target)

await cdp.send('Page.reload', { ignoreCache: true })
console.log('reload sent')
await sleep(2500)
console.log(
  await cdp.eval(
    `JSON.stringify({ hasProbe: !!window.__PERF_PROBE__, composer: !!document.querySelector(${JSON.stringify(SELECTORS.composer)}), url: location.hash })`
  )
)
cdp.close()
