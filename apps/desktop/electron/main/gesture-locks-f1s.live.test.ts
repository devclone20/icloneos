/**
 * F1-S (v0.0.9) — end to end, through the REAL preload in a sandboxed renderer, Chromium's own trusted input and
 * main's real gesture rule (permissionGestureOk over trackTrustedInput): the four owner-click controls of F1-S open
 * ONLY on a real click (`webContents.sendInputEvent`, which reaches the page as trusted input), never on a script's
 * direct call nor on a synthetic `el.click()` from inside the page.
 *
 *   1. ACP tools Install / Repair  (`data-acp-tools-confirm`)   → `iclone:acp-tools:install`
 *   2. ERC-8004 registration       (`data-acp-register-confirm`) → `iclone:acp-owner-confirm` + `iclone:acp-run`
 *   3. Market offering create      (`data-acp-market-confirm`)   → `iclone:acp-owner-confirm` + `iclone:acp-run`
 *   4. Billing Buy credits         (`data-billing-charge-confirm`) → `iclone:billing:authorize-charge`
 *
 * The main handlers are the real lock modules (gesture-locks-acp.ts, gesture-locks-billing.ts) with an in-memory
 * audit; nothing is installed, signed or charged. Opt-in (ICLONE_F1S_LIVE=1, macOS, Electron present): it launches
 * Electron, so it is not part of the default run. The PACKAGED-app version of the same gate — the shipped bundle, the
 * real Settings panes, the audit chain on disk — is the `it.todo` list at the end, for the packaged-app harness.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

const electronBinary = (): null | string => {
  try {
    return String(require('electron'))
  } catch {
    return null
  }
}

// Four marked controls, 100 px apart, each calling its bridge synchronously in its own click handler (as the app does).
const PAGE = `<!doctype html>
<button id="tools" data-acp-tools-confirm="" style="position:fixed;left:0;top:0;width:90px;height:90px">tools</button>
<button id="register" data-acp-register-confirm="" style="position:fixed;left:100px;top:0;width:90px;height:90px">register</button>
<button id="create" data-acp-market-confirm="" style="position:fixed;left:200px;top:0;width:90px;height:90px">create</button>
<button id="buy" data-billing-charge-confirm="" style="position:fixed;left:300px;top:0;width:90px;height:90px">buy</button>`

const MAIN = `
import { app, BrowserWindow, ipcMain } from 'electron'
import { lastTrustedInputAt, trackTrustedInput } from '${path.resolve(__dirname, './agent-update')}'
import { gestureOf, permissionGestureOk } from '${path.resolve(__dirname, '../iclone-permissions/gesture')}'
import { createAcpOwnerWrites } from '${path.resolve(__dirname, '../gesture-locks-acp')}'
import { registerBillingChargeLock } from '${path.resolve(__dirname, '../gesture-locks-billing')}'
const fs = require('node:fs')
const finish = (out, code) => { fs.writeFileSync(process.env.FX_OUT, JSON.stringify(out)); app.exit(code) }
app.setPath('userData', process.env.FX_UD)
ipcMain.on('hermes:translucency:support', e => { e.returnValue = null })
ipcMain.on('hermes:hud:windowing', e => { e.returnValue = null })
process.on('uncaughtException', e => finish({ uncaught: String(e) }, 2))
const gestureOk = (event, input) =>
  permissionGestureOk({ payload: gestureOf(input), lastInputAt: lastTrustedInputAt(event.sender), now: Date.now() })
const audits = []
const audit = entry => { audits.push(entry); return { id: audits.length } }
// 1. the tools installer's verdict (iclone-acp-tools/ipc.ts requestInstall gets exactly this boolean).
ipcMain.handle('iclone:acp-tools:install', (event, input) => {
  const ok = gestureOk(event, input)
  audits.push({ kind: ok ? 'use' : 'refuse', gesture: ok, reason: 'acp-tools.install' })
  return { ok, error: ok ? undefined : 'gesture' }
})
// 2 + 3. the owner-locked ACP writes, exactly as initIcloneAcp wires them (the CLI itself is not run).
const writes = createAcpOwnerWrites({ gestureOk, audit })
ipcMain.handle('iclone:acp-owner-confirm', (event, input) => writes.confirm(event, input))
ipcMain.handle('iclone:acp-run', (event, inftId, argv) => {
  const refused = writes.admit(event, inftId, argv)
  return refused ? { ok: false, error: refused } : { ok: true, admitted: argv.slice(0, 2).join(' ') }
})
// 4. Buy credits.
registerBillingChargeLock({ ipcMain, isTrustedSender: () => true, gestureOk, audit })
app.whenReady().then(async () => {
  const win = new BrowserWindow({ height: 200, width: 420, x: 0, y: 0, webPreferences: { preload: process.env.FX_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } })
  trackTrustedInput(win.webContents)
  await win.loadFile(process.env.FX_PAGE)
  const js = win.webContents
  await js.executeJavaScript(\`
    const REGISTER = ['agent', 'register-erc8004', '--agent-id', 'a1', '--chain-id', '8453', '--json']
    const CREATE = ['offering', 'create', '--name', 'Token report', '--description', 'A digest.', '--price-type', 'fixed',
      '--price-value', '0.5', '--sla-minutes', '30', '--requirements', 'The ticker.', '--deliverable', 'A report.',
      '--required-funds', '--no-hidden', '--json']
    const d = window.hermesDesktop
    const write = argv => {
      const confirming = d.icloneAcp.ownerConfirm('inft-1', argv)
      return confirming.then(() => d.icloneAcp.run('inft-1', argv))
    }
    window.calls = {
      tools: () => d.icloneAcpTools.install(),
      register: () => write(REGISTER),
      create: () => write(CREATE),
      buy: () => d.billingCharge.authorize('25', 'key-0000-0001')
    }
    window.answers = { tools: [], register: [], create: [], buy: [] }
    for (const id of Object.keys(window.calls)) {
      document.getElementById(id).addEventListener('click', () => { window.answers[id].push(window.calls[id]()) })
    }
  \`)
  await new Promise(r => setTimeout(r, 300))
  const ids = ['tools', 'register', 'create', 'buy']
  const settle = id => js.executeJavaScript('Promise.all(window.answers.' + id + ')')
  const out = { script: {}, synthetic: {}, real: {} }
  // (a) A script calls the bridge directly: no click at all.
  for (const id of ids) { out.script[id] = await js.executeJavaScript('window.calls.' + id + '()') }
  // (b) A script holding the renderer's own activation clicks the marked control: el.click() is not trusted input.
  for (const id of ids) {
    await js.executeJavaScript("document.getElementById('" + id + "').click()", true)
    out.synthetic[id] = (await settle(id)).at(-1)
  }
  // (c) The owner's real click: input the browser process delivered (counted by trackTrustedInput).
  js.focus()
  for (const [index, id] of ids.entries()) {
    const x = 45 + index * 100
    js.sendInputEvent({ type: 'mouseDown', x, y: 45, button: 'left', clickCount: 1 })
    js.sendInputEvent({ type: 'mouseUp', x, y: 45, button: 'left', clickCount: 1 })
    await new Promise(r => setTimeout(r, 200))
    out.real[id] = (await settle(id)).at(-1)
  }
  out.audits = audits
  finish(out, 0)
}).catch(e => finish({ error: String(e) }, 1))
`

describe.runIf(process.platform === 'darwin' && electronBinary() && process.env.ICLONE_F1S_LIVE === '1')(
  'F1-S: the four owner-click controls open only on a real click (live)',
  { timeout: 120_000 },
  () => {
    let base = ''

    beforeAll(() => {
      base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'f1s-')))
    })
    afterAll(() => fs.rmSync(base, { force: true, recursive: true }))

    it('script: refused · synthetic el.click(): refused · sendInputEvent: admitted, audited gesture:true', async () => {
      const options = {
        bundle: true,
        external: ['electron'] as string[],
        format: 'cjs' as const,
        logLevel: 'silent' as const,
        platform: 'node' as const
      }

      const mainJs = path.join(base, 'main.cjs')
      const preloadJs = path.join(base, 'preload.cjs')
      const page = path.join(base, 'page.html')
      const out = path.join(base, 'out.json')

      await build({
        ...options,
        absWorkingDir: path.resolve(__dirname, '../..'),
        entryPoints: [path.resolve(__dirname, '../preload.ts')],
        outfile: preloadJs
      })
      await build({ ...options, stdin: { contents: MAIN, resolveDir: __dirname }, outfile: mainJs })
      fs.writeFileSync(page, PAGE)

      const child = spawnSync(String(electronBinary()), [mainJs, `--user-data-dir=${path.join(base, 'ud')}`, '--use-mock-keychain'], {
        env: { ...process.env, FX_OUT: out, FX_PAGE: page, FX_PRELOAD: preloadJs, FX_UD: path.join(base, 'ud') },
        timeout: 90_000
      })

      if (!fs.existsSync(out)) {
        throw new Error(`no result from Electron, rc=${child.status}: ${String(child.stderr).slice(-400)}`)
      }

      const result = JSON.parse(fs.readFileSync(out, 'utf8'))

      expect(result.error).toBeUndefined()
      expect(result.uncaught).toBeUndefined()

      for (const id of ['tools', 'register', 'create', 'buy']) {
        expect(result.script[id]?.ok, `script ${id}`).toBe(false)
        expect(result.synthetic[id]?.ok, `synthetic ${id}`).toBe(false)
        expect(result.real[id]?.ok, `real ${id}`).toBe(true)
      }

      expect(result.real.register.admitted).toBe('agent register-erc8004')
      expect(result.real.create.admitted).toBe('offering create')
      expect(result.real.buy.ownerConfirm).toMatch(/^[0-9a-f]{64}$/)

      const gestures = (result.audits as { kind: string; gesture: boolean }[]).map(entry => `${entry.kind}:${entry.gesture}`)

      // Every refusal is audited gesture:false; each real click exactly one use · gesture:true.
      expect(gestures.filter(entry => entry === 'use:true')).toHaveLength(4)
      expect(gestures.filter(entry => entry.endsWith(':true') && !entry.startsWith('use'))).toEqual([])
      expect(gestures).toContain('refuse:false')
    })
  }
)

// The packaged-app gate (PLANO_V009 §0, P0_ECONOMYOS_CONTROLS §F1-S): the same four clicks in the SHIPPED bundle, on
// the real panes, with the real V3-F audit chain. Each: launch the packaged app on a throwaway HOME/userData, open the
// pane, find the marked control's box (executeJavaScript getBoundingClientRect), webContents.sendInputEvent a
// mouseDown/mouseUp at its centre, then read the effect and the audit; and the negative: the same call from
// executeJavaScript (script) and `el.click()` (synthetic) leaves no effect and audits `refuse · gesture:false`.
describe('F1-S packaged-app harness (spec)', () => {
  it.todo(
    'ACP tools Install / Repair (Settings › Economy › ACP tools, data-acp-tools-confirm): real click → acp-cli tree verified ' +
      'under userData/acp-cli, audit src install · use · gesture:true; script / el.click() → state stays absent, refuse · gesture:false'
  )
  it.todo(
    'EconomyOS step 5 Register identity (data-acp-register-confirm): real click → one `agent register-erc8004` spawn ' +
      '(fake ICLONE_ACP_BIN logs it), audit use · gesture:true; script / el.click() → no spawn, [acp-write:gesture], gesture:false'
  )
  it.todo(
    'ACP Market › My offerings › Create offering (data-acp-market-confirm): real click → one `offering create` spawn ' +
      'with the form argv, audit use · gesture:true; script / el.click() → no spawn, the pane shows the owner-click line'
  )
  it.todo(
    'Settings › Billing › Buy credits (data-billing-charge-confirm): real click → iclone:billing:authorize-charge answers ' +
      'a confirm and the gateway receives billing.charge with owner_confirm; script / el.click() → no billing.charge frame ' +
      '(gateway stub), refuse · gesture:false'
  )
})
