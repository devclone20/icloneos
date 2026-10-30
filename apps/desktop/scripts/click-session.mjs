// Click a sidebar session by partial title match, then print the page state
// three seconds later.
//
//   node scripts/click-session.mjs 'Phaser particle'
import { CDP, devTargetOrExit, SELECTORS, sleep } from './lib/cdp.mjs'

const title = process.argv[2] || 'Phaser particle'
const cdp = await CDP.open(await devTargetOrExit())

console.log(
  'click:',
  await cdp.eval(`(() => {
    const titleMatch = ${JSON.stringify(title)}
    const all = document.querySelectorAll('button, a, div[role="button"]')
    const found = [...all].find(el => (el.textContent || '').includes(titleMatch))
    if (!found) return { found: false, tried: titleMatch }
    found.scrollIntoView()
    found.click()
    return { found: true, tag: found.tagName, text: (found.textContent || '').slice(0, 80) }
  })()`)
)
await sleep(3000)
console.log(
  'after click:',
  await cdp.eval(`({
    url: location.href,
    hasComposer: !!document.querySelector(${JSON.stringify(SELECTORS.composer)}),
    threadMessages: document.querySelectorAll('[data-slot="aui_message"]').length,
    bodyTextSnippet: document.body.innerText.slice(0, 500),
    title: document.title
  })`)
)
cdp.close()
