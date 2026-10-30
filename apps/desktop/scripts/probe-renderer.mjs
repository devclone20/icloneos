// Dump the renderer's boot state: URL, root mount, composer, boot stage, body text.
//
//   node scripts/probe-renderer.mjs
import { CDP, devTargetOrExit, SELECTORS } from './lib/cdp.mjs'

const target = await devTargetOrExit()
console.log('target:', target.url)

const cdp = await CDP.open(target)

console.log(
  JSON.stringify(
    await cdp.eval(`({
      url: location.href,
      title: document.title,
      rootChildren: document.getElementById('root')?.children.length ?? 0,
      rootInner: (document.getElementById('root')?.innerHTML ?? '').slice(0, 300),
      hasComposer: !!document.querySelector(${JSON.stringify(SELECTORS.composer)}),
      bootStage: document.querySelector('[data-slot*="boot"]')?.getAttribute('data-slot') ?? null,
      bodyText: document.body.innerText.slice(0, 300),
      errorCount: window.__errors?.length ?? 'n/a'
    })`),
    null,
    2
  )
)
cdp.close()
