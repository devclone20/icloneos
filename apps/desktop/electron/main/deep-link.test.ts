// K144 — only the installed macOS release app claims iclone://; a lab, trial, mounted or non-release copy never
// re-points LaunchServices.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

const mockedHome = { value: '/Users/someone' }

vi.mock('electron', () => ({
  app: { getPath: () => mockedHome.value, isPackaged: true, setAsDefaultProtocolClient: vi.fn() },
  ipcMain: { handle: vi.fn() }
}))
vi.mock('./env', () => ({ DEV_SERVER: '' }))
vi.mock('./log', () => ({ rememberLog: vi.fn() }))

const { protocolClaimDecision, readBundleUrlSchemes, registerDeepLinkProtocol } = await import('./deep-link')
const { app } = await import('electron')

const HOME = '/Users/someone'
const exe = (bundle: string) => `${bundle}/Contents/MacOS/icloneOS`

const RELEASE_SCHEMES = () => ['iclone']

const decide = (execPath: string, extra: Partial<Parameters<typeof protocolClaimDecision>[0]> = {}): boolean =>
  protocolClaimDecision({
    execPath,
    home: HOME,
    platform: 'darwin',
    scheme: 'iclone',
    bundleSchemes: RELEASE_SCHEMES,
    ...extra
  }).register

/** A minimal electron-builder style Info.plist, with or without the iclone URL type. */
const infoPlist = (bundleId: string, schemes: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleIdentifier</key>
    <string>${bundleId}</string>${
      schemes.length
        ? `
    <key>CFBundleURLTypes</key>
    <array>
      <dict>
        <key>CFBundleTypeRole</key>
        <string>Editor</string>
        <key>CFBundleURLName</key>
        <string>iclone os Protocol</string>
        <key>CFBundleURLSchemes</key>
        <array>
${schemes.map(s => `          <string>${s}</string>`).join('\n')}
        </array>
      </dict>
    </array>`
        : ''
    }
  </dict>
</plist>
`

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'k144-'))
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }))

function bundleAt(bundle: string, plist: string | null) {
  fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true })

  if (plist !== null) {
    fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), plist)
  }

  return bundle
}

describe('K144: who claims iclone://', () => {
  it('the installed app in /Applications or ~/Applications claims it', () => {
    expect(decide(exe('/Applications/icloneOS.app'))).toBe(true)
    expect(decide(exe('/Users/someone/Applications/icloneOS.app'))).toBe(true)
    expect(decide(exe('/Users/someone/Applications/icloneOS.app'), { home: '/Users/someone/' })).toBe(true)
  })

  it('a lab, trial, build-folder, DMG or translocated copy never does', () => {
    for (const bundle of [
      '/Users/someone/Code/sample-wt/branch-a/apps/desktop/release/mac-arm64/icloneOS.app',
      '/private/tmp/scratch/trial/icloneOS.app',
      '/Volumes/icloneOS 0.0.3/icloneOS.app',
      '/private/var/folders/x/T/AppTranslocation/ABC/d/icloneOS.app',
      '/Users/someone/Downloads/icloneOS.app',
      '/Applications/lab/icloneOS.app',
      '/Users/other/Applications/icloneOS.app'
    ]) {
      expect(decide(exe(bundle)), bundle).toBe(false)
    }
  })

  it('not an .app bundle (a bare Electron binary) does not claim the packaged scheme', () => {
    expect(decide('/usr/local/bin/electron')).toBe(false)
  })

  it('an installed copy whose Info.plist does not declare iclone (a non-release pack) does not claim it', () => {
    expect(decide(exe('/Applications/icloneOS.app'), { bundleSchemes: () => [] })).toBe(false)
    expect(decide(exe('/Applications/icloneOS.app'), { bundleSchemes: () => null })).toBe(false)
    expect(decide(exe('/Applications/icloneOS.app'), { bundleSchemes: () => ['hermes'] })).toBe(false)
  })

  it('dev schemes and other platforms keep their registration', () => {
    expect(decide('/somewhere/electron', { scheme: 'hermes-dev' })).toBe(true)
    expect(decide('C:\\\\Program Files\\\\icloneOS\\\\icloneOS.exe', { platform: 'win32' })).toBe(true)
    expect(decide('/opt/icloneOS/icloneos', { platform: 'linux' })).toBe(true)
  })
})

describe('K144 wiring: registerDeepLinkProtocol asks the decision first', () => {
  const real = { execPath: process.execPath, platform: process.platform }

  const runAs = (execPath: string, home = '/Users/someone') => {
    mockedHome.value = home
    Object.defineProperty(process, 'execPath', { value: execPath, configurable: true })
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

    try {
      vi.mocked(app.setAsDefaultProtocolClient).mockClear()
      registerDeepLinkProtocol()

      return vi.mocked(app.setAsDefaultProtocolClient).mock.calls
    } finally {
      Object.defineProperty(process, 'execPath', { value: real.execPath, configurable: true })
      Object.defineProperty(process, 'platform', { value: real.platform, configurable: true })
    }
  }

  it('a trial copy never calls setAsDefaultProtocolClient; the installed release app does, once, for iclone', () => {
    const home = path.join(tmpRoot, 'home')

    const release = bundleAt(
      path.join(home, 'Applications', 'icloneOS.app'),
      infoPlist('io.cloneframe.icloneos', ['iclone'])
    )

    expect(runAs(exe('/private/tmp/trial/icloneOS.app'), home)).toEqual([])
    expect(runAs(exe(release), home)).toEqual([['iclone']])
  })

  it('a non-release pack installed in ~/Applications (install:mac) reads its own Info.plist and does not claim', () => {
    const home = path.join(tmpRoot, 'home-dev')
    const dev = bundleAt(path.join(home, 'Applications', 'icloneOS.app'), infoPlist('io.cloneframe.icloneos.dev', []))
    const unreadable = bundleAt(path.join(tmpRoot, 'home-x', 'Applications', 'icloneOS.app'), null)

    expect(runAs(exe(dev), home)).toEqual([])
    expect(runAs(exe(unreadable), path.join(tmpRoot, 'home-x'))).toEqual([])
  })
})

describe('K144: readBundleUrlSchemes', () => {
  it('reads every CFBundleURLSchemes string of an XML Info.plist; none, missing or binary are told apart', () => {
    const plist = (name: string, body: string | null) => bundleAt(path.join(tmpRoot, 'read', `${name}.app`), body)

    expect(readBundleUrlSchemes(plist('release', infoPlist('io.cloneframe.icloneos', ['iclone'])))).toEqual(['iclone'])
    expect(readBundleUrlSchemes(plist('two', infoPlist('x', ['iclone', 'hermes'])))).toEqual(['iclone', 'hermes'])
    expect(readBundleUrlSchemes(plist('dev', infoPlist('io.cloneframe.icloneos.dev', [])))).toEqual([])
    expect(readBundleUrlSchemes(plist('missing', null))).toBeNull()
    expect(readBundleUrlSchemes(plist('binary', 'bplist00\u0000'))).toBeNull()
  })
})
