// One-shot CDP eval in the renderer: prints the expression's value as JSON.
//
//   node scripts/eval.mjs "document.title"
//   HERMES_DESKTOP_CDP_PORT=9333 node scripts/eval.mjs "document.title"
//
// Needs a renderer with a debugging port: launch `hgui` / `npm run dev` with
// HERMES_DESKTOP_CDP_PORT set (see electron/dev-cdp.ts).
import { CDP, devTargetOrExit } from './lib/cdp.mjs'

const target = await devTargetOrExit({ prefer: '5174' })
const cdp = await CDP.open(target)

try {
  console.log(JSON.stringify(await cdp.eval(process.argv[2] || '1+1'), null, 2))
} catch (error) {
  console.error('EXCEPTION:', error.message)
} finally {
  cdp.close()
}
