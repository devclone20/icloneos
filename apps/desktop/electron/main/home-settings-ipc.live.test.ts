/**
 * The real path a refusal takes: real Electron, real ipcRenderer and ipcMain, the real handlers. The preload's three channels are pinned below. The rejected invoke arrives prefixed and
 * bare (why nothing keys on its words), while the refusal arrives as data and the copy works from the renderer.
 */
import { execFileSync, spawnSync } from 'node:child_process'
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

const MAIN = `
import { app, BrowserWindow, ipcMain } from 'electron'
import { homeSettingsRefusal } from '${path.resolve(__dirname, '../home-settings-files')}'
import { registerHomeSettingsIpc } from '${path.resolve(__dirname, './home-settings-ipc')}'

const hermesHome = process.env.FX_HOME
const check = { doing: 'start', linksOutsideRefused: true, root: hermesHome }

app.setPath('userData', process.env.FX_USER_DATA)
ipcMain.handle('hermes:connection', async () => { throw new Error(homeSettingsRefusal(hermesHome, check)) })
registerHomeSettingsIpc({ copyGuard: () => ({ neverCopied: [], runtimeWritable: [] }), gestureOk: () => process.env.FX_TRUST === '1', hermesHome, isConfined: () => true, isTrustedSender: () => process.env.FX_TRUST === '1', log: () => undefined, primaryProfile: () => null })

const PAGE = \`(async () => {
  const { ipcRenderer } = require('electron')
  const d = {
    getConnection: profile => ipcRenderer.invoke('hermes:connection', profile),
    homeSettings: {
      check: (profile, doing) => ipcRenderer.invoke('hermes:home-settings:check', profile, doing),
      replaceWithCopy: payload => ipcRenderer.invoke('hermes:home-settings:replace-with-copy', payload)
    }
  }
  const rejected = await d.getConnection(null).then(() => '', e => ({ message: e.message, code: e.code }))
  const refusal = await d.homeSettings.check(null)
  const traversal = await d.homeSettings.check('../..')
  const traversalCopy = await d.homeSettings.replaceWithCopy({ file: '.env', profile: '../..', target: process.env.FX_TARGET })
  const unasked = process.env.FX_TRUST === '1' ? null : await d.homeSettings.replaceWithCopy({ file: '.env', profile: null, target: process.env.FX_TARGET })
  const extra = await d.homeSettings.replaceWithCopy({ file: '.env', profile: null, target: refusal && refusal.findings[0].target, path: '/etc/hosts' })
  const unnamed = await d.homeSettings.replaceWithCopy({ file: 'id_rsa', profile: null, target: '/x' })
  const copied = refusal ? await d.homeSettings.replaceWithCopy({ file: '.env', profile: null, target: refusal.findings[0].target }) : null
  return { rejected, refusal, traversal, traversalCopy, unasked, extra, unnamed, copied }
})()\`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false } })
  // A navigation is refused under the test's throwaway profile (ERR_FAILED); the blank document still has a renderer and ipcRenderer.
  await win.loadURL('about:blank').catch(() => undefined)
  const out = await win.webContents.executeJavaScript(PAGE)
  require('node:fs').writeFileSync(process.env.FX_OUT, JSON.stringify(out))
  app.exit(0)
}).catch(error => { require('node:fs').writeFileSync(process.env.FX_OUT, JSON.stringify({ error: String(error) })); app.exit(1) })
`

describe.skipIf(process.platform !== 'darwin' || !electronBinary())('the refusal over real IPC (live)', { timeout: 120_000 }, () => {
  let base = ''
  let mainJs = ''

  beforeAll(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hsi-')))
    mainJs = path.join(base, 'main.cjs')

    const options = {
      bundle: true,
      external: ['electron'] as string[],
      format: 'cjs' as const,
      logLevel: 'silent' as const,
      platform: 'node' as const
    }

    await build({ ...options, stdin: { contents: MAIN, resolveDir: __dirname }, outfile: mainJs })
  })
  afterAll(() => fs.rmSync(base, { force: true, recursive: true }))

  const run = (name: string, trust: '0' | '1') => {
    const home = path.join(base, name, 'hh')
    const out = path.join(base, name, 'out.json')
    const target = path.join(base, name, 'dotenv')

    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(target, 'A=1\n', { mode: 0o644 })
    fs.symlinkSync(target, path.join(home, '.env'))
    // Where the profile name '../..' would land if main ever let it through: a refusable link, so an answer proves the escape.
    fs.symlinkSync(target, path.join(base, name, '.env'))

    const child = spawnSync(String(electronBinary()), [mainJs, `--user-data-dir=${path.join(base, name, 'ud')}`], {
      env: { ...process.env, FX_HOME: home, FX_OUT: out, FX_TARGET: target, FX_TRUST: trust, FX_USER_DATA: path.join(base, name, 'ud') },
      timeout: 90_000
    })

    if (!fs.existsSync(out)) {
      throw new Error(`no result from Electron, rc=${child.status}: ${String(child.stderr).slice(-400)}`)
    }

    return { home, result: JSON.parse(fs.readFileSync(out, 'utf8')), target }
  }

  it('the rejection is prefixed and bare; the refusal is data; only a known file at the shown target is copied', () => {
    const { home, result, target } = run('trusted', '1')

    expect(result.error).toBeUndefined()
    expect(result.rejected.message.startsWith("Error invoking remote method 'hermes:connection': Error: Your .env")).toBe(true)
    expect(result.rejected.code).toBeUndefined()
    expect(result.refusal.code).toBe('home-settings-refused')
    expect(result.refusal.findings[0]).toMatchObject({ file: '.env', kind: 'link-outside', target })
    expect(result.traversal).toBeNull()
    expect(result.traversalCopy).toMatchObject({ ok: false, reason: 'not-eligible' })
    expect(fs.lstatSync(path.join(path.dirname(home), '.env')).isSymbolicLink()).toBe(true)
    expect(result.extra).toMatchObject({ ok: false, reason: 'not-eligible' })
    expect(result.unnamed).toMatchObject({ ok: false, reason: 'not-eligible' })
    expect(result.copied).toEqual({ ok: true, refusal: null })

    const after = fs.lstatSync(path.join(home, '.env'))

    expect(after.isFile()).toBe(true)
    expect(after.mode & 0o777).toBe(0o600)
    expect(execFileSync('/bin/cat', [target], { encoding: 'utf8' })).toBe('A=1\n')
  })

  it('the preload exposes exactly these channels', () => {
    const preload = fs.readFileSync(path.resolve(__dirname, '../preload.ts'), 'utf8')

    for (const channel of ['check', 'replace-with-copy', 'warnings']) {
      expect(preload).toContain(`'hermes:home-settings:${channel}'`)
    }
  })

  it('an untrusted sender gets nothing and copies nothing', () => {
    const { home, result } = run('untrusted', '0')

    expect(result.refusal).toBeNull()
    expect(result.unasked).toMatchObject({ ok: false, reason: 'not-eligible' })
    expect(result.unnamed).toMatchObject({ ok: false, reason: 'not-eligible' })
    expect(fs.lstatSync(path.join(home, '.env')).isSymbolicLink()).toBe(true)
  })
})
