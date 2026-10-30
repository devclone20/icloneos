// Dump the open thread's shape: turn pairs, message counts, DOM size,
// viewport scroll metrics, composer and busy state.
//
//   node scripts/probe-thread.mjs
import { CDP, devTargetOrExit, SELECTORS } from './lib/cdp.mjs'

const cdp = await CDP.open(await devTargetOrExit())

console.log(
  await cdp.eval(`(() => {
    const viewport = document.querySelector(${JSON.stringify(SELECTORS.threadViewport)})

    return {
      url: location.href,
      title: document.title,
      turnPairs: document.querySelectorAll(${JSON.stringify(SELECTORS.turnPair)}).length,
      assistantMsgs: document.querySelectorAll(${JSON.stringify(SELECTORS.assistantMessage)}).length,
      userMsgs: document.querySelectorAll('[data-message-role="user"], [data-slot="aui_user-message-root"]').length,
      totalDomNodes: document.querySelectorAll('*').length,
      threadViewportScrollHeight: viewport?.scrollHeight ?? null,
      threadViewportClientHeight: viewport?.clientHeight ?? null,
      threadViewportScrollTop: viewport?.scrollTop ?? null,
      composer: !!document.querySelector(${JSON.stringify(SELECTORS.composer)}),
      busy: !!document.querySelector('[aria-label*="Stop"]')
    }
  })()`)
)
cdp.close()
