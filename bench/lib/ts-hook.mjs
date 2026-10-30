// Loader hook shared by the bench child processes: lets Node's type stripping load the app's real `.ts` sources
// (extensionless relative specifiers resolve to `.ts`, `.tsx` or `/index.ts`) and replaces `electron` with an inert stub.
// Import it first, as a side effect: `import '../lib/ts-hook.mjs'`; the app modules are then loaded with dynamic
// `import()`, because static imports are linked before any hook can run.
import { registerHooks } from 'node:module'

const ELECTRON_STUB = `data:text/javascript,${encodeURIComponent(
  "const noop=()=>{};export const app={getPath:()=>'',on:noop,isPackaged:false};" +
    'export const ipcMain={handle:noop,on:noop,removeHandler:noop};export const safeStorage={};' +
    'export class BrowserWindow{};export default {app,ipcMain}'
)}`
registerHooks({
  resolve(spec, context, next) {
    if (spec === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    try {
      return next(spec, context)
    } catch (error) {
      if (!spec.startsWith('.')) throw error
      for (const ext of ['.ts', '.tsx', '/index.ts']) {
        try {
          return next(spec + ext, context)
        } catch {
          // not this extension; try the next one
        }
      }
      throw error
    }
  }
})
