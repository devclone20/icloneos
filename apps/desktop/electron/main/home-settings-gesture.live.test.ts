/**
 * M1, through the real preload in a sandboxed renderer and the real gesture lock: a script alone never copies. Only real
 * input on the marked button does. The sender guard is stubbed true here: it has its own tests, and it passes the app's
 * own compromised renderer anyway, which is the case this lock is for.
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

const PAGE = `<!doctype html><button id="go" data-confinement-confirm="" style="position:fixed;left:0;top:0;width:200px;height:200px">go</button>`

const MAIN = `
import { app, BrowserWindow, ipcMain } from 'electron'
import { registerHomeSettingsIpc } from '${path.resolve(__dirname, './home-settings-ipc')}'
import { lastTrustedInputAt, trackTrustedInput } from '${path.resolve(__dirname, './agent-update')}'
import { gestureOf, permissionGestureOk } from '${path.resolve(__dirname, '../iclone-permissions/gesture')}'
const fs = require('node:fs')
const finish = (out, code) => { fs.writeFileSync(process.env.FX_OUT, JSON.stringify(out)); app.exit(code) }
app.setPath('userData', process.env.FX_UD)
ipcMain.on('hermes:translucency:support', e => { e.returnValue = null })
process.on('uncaughtException', e => finish({ uncaught: String(e) }, 2))
registerHomeSettingsIpc({
  copyGuard: () => ({ neverCopied: [process.env.FX_SECRET], runtimeWritable: [] }),
  gestureOk: (event, input) => permissionGestureOk({ payload: gestureOf(input), lastInputAt: lastTrustedInputAt(event.sender), now: Date.now() }),
  hermesHome: process.env.FX_HOME,
  isConfined: () => true,
  isTrustedSender: () => true,
  log: () => undefined,
  primaryProfile: () => null
})
const plain = () => fs.lstatSync(process.env.FX_HOME + '/.env').isFile()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ height: 300, width: 300, x: 0, y: 0, webPreferences: { preload: process.env.FX_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } })
  trackTrustedInput(win.webContents)
  await win.loadFile(process.env.FX_PAGE)
  const js = win.webContents
  await js.executeJavaScript(\`
    window.answers = []
    window.ask = async () => {
      const hs = window.hermesDesktop.homeSettings
      const refusal = await hs.check(null)
      return hs.replaceWithCopy({ file: '.env', profile: null, target: refusal.findings[0].target })
    }
    // The way the panel calls it: synchronously inside the button's handler, the target known already.
    document.getElementById('go').addEventListener('click', () => {
      const answer = window.hermesDesktop.homeSettings.replaceWithCopy({ file: '.env', profile: null, target: window.target })
      window.answers.push(answer)
    })
    window.hermesDesktop.homeSettings.check(null).then(refusal => { window.target = refusal.findings[0].target; window.kind = refusal.findings[0].kind; window.guarded = refusal.findings.find(item => item.file === '.op.env').kind })
  \`)
  await new Promise(r => setTimeout(r, 300))
  const out = { keys: await js.executeJavaScript('Object.keys(window.hermesDesktop.homeSettings)'), guarded: await js.executeJavaScript('window.guarded'), kind: await js.executeJavaScript('window.kind') }
  out.script = await js.executeJavaScript('window.ask()')
  out.plainAfterScript = plain()
  // A script holding a user activation (the renderer's own flag true) and calling from a real handler, with no real input.
  await js.executeJavaScript("document.getElementById('go').click(); Promise.all(window.answers)", true)
  out.synthetic = await js.executeJavaScript('Promise.all(window.answers)')
  out.plainAfterSynthetic = plain()
  js.focus()
  js.sendInputEvent({ type: 'mouseDown', x: 50, y: 50, button: 'left', clickCount: 1 })
  js.sendInputEvent({ type: 'mouseUp', x: 50, y: 50, button: 'left', clickCount: 1 })
  for (let i = 0; i < 40 && !plain(); i += 1) { await new Promise(r => setTimeout(r, 100)) }
  out.real = await js.executeJavaScript('Promise.all(window.answers)')
  out.plainAfterReal = plain()
  finish(out, 0)
}).catch(e => finish({ error: String(e) }, 1))
`

describe.runIf(process.platform === 'darwin' && electronBinary())(
  'Replace with a copy needs the real click (live)',
  { timeout: 120_000 },
  () => {
    let base = ''

    beforeAll(() => {
      base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hsg-')))
    })
    afterAll(() => fs.rmSync(base, { force: true, recursive: true }))

    it('a script alone never copies, a synthetic click never copies, a real click does', async () => {
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
      const home = path.join(base, 'hh')
      const target = path.join(base, 'dotenv')
      const secret = path.join(base, 'fake-secret')
      const out = path.join(base, 'out.json')

      await build({
        ...options,
        absWorkingDir: path.resolve(__dirname, '../..'),
        entryPoints: [path.resolve(__dirname, '../preload.ts')],
        outfile: preloadJs
      })
      await build({ ...options, stdin: { contents: MAIN, resolveDir: __dirname }, outfile: mainJs })
      fs.writeFileSync(page, PAGE)
      fs.mkdirSync(home)
      fs.writeFileSync(target, 'FAKE=1\n')
      fs.symlinkSync(target, path.join(home, '.env'))
      fs.writeFileSync(secret, 'FAKE-SECRET\n')
      fs.symlinkSync(secret, path.join(home, '.op.env'))

      const child = spawnSync(String(electronBinary()), [mainJs, `--user-data-dir=${path.join(base, 'ud')}`], {
        env: {
          ...process.env,
          FX_HOME: home,
          FX_OUT: out,
          FX_PAGE: page,
          FX_PRELOAD: preloadJs,
          FX_SECRET: secret,
          FX_UD: path.join(base, 'ud')
        },
        timeout: 90_000
      })

      if (!fs.existsSync(out)) {
        throw new Error(`no result from Electron, rc=${child.status}: ${String(child.stderr).slice(-400)}`)
      }

      const result = JSON.parse(fs.readFileSync(out, 'utf8'))

      expect(result.error).toBeUndefined()
      expect(result.keys).toEqual(['check', 'replaceWithCopy', 'warnings'])
      expect(result.kind).toBe('link-outside')
      expect(result.guarded).toBe('link-guarded')
      expect(result.script).toMatchObject({ ok: false, reason: 'not-eligible' })
      expect(result.plainAfterScript).toBe(false)
      expect(result.synthetic[0]).toMatchObject({ ok: false, reason: 'not-eligible' })
      expect(result.plainAfterSynthetic).toBe(false)
      expect(result.real.at(-1)).toMatchObject({ ok: true })
      expect(result.plainAfterReal).toBe(true)
      expect(fs.readFileSync(path.join(home, '.env'), 'utf8')).toBe('FAKE=1\n')
    })
  }
)
