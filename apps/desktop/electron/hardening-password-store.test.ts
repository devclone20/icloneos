import { describe, expect, it } from 'vitest'

import { enableBasicPasswordStoreEncryption } from './hardening'
import { applyLinuxPasswordStoreDefault, detectLinuxPasswordStore } from './hardening-password-store'

describe('detectLinuxPasswordStore', () => {
  it.each([
    [{ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }, 'gnome-libsecret'],
    [{ XDG_CURRENT_DESKTOP: 'X-Cinnamon' }, 'gnome-libsecret'],
    [{ XDG_CURRENT_DESKTOP: 'Hyprland' }, 'gnome-libsecret'],
    [{}, 'gnome-libsecret'],
    [{ XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '6' }, 'kwallet6'],
    [{ XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '5' }, 'kwallet5'],
    [{ XDG_CURRENT_DESKTOP: 'KDE' }, 'kwallet'],
    [{ DESKTOP_SESSION: 'plasmawayland', KDE_SESSION_VERSION: '6' }, 'kwallet6']
  ])('%j → %s', (env, expected) => {
    expect(detectLinuxPasswordStore(env as NodeJS.ProcessEnv)).toBe(expected)
  })

  it('never auto-selects the plain-text basic store', () => {
    for (const desktop of ['', 'GNOME', 'KDE', 'sway', 'i3', 'XFCE', 'LXQt']) {
      expect(detectLinuxPasswordStore({ XDG_CURRENT_DESKTOP: desktop })).not.toBe('basic')
    }
  })
})

describe('applyLinuxPasswordStoreDefault', () => {
  it('fills the env on Linux when the launcher did not', () => {
    const env: NodeJS.ProcessEnv = { XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '6' }
    expect(applyLinuxPasswordStoreDefault({ env, platform: 'linux', argv: [] })).toBe('kwallet6')
    expect(env.HERMES_DESKTOP_PASSWORD_STORE).toBe('kwallet6')
  })

  it('keeps an explicit launcher value, including basic', () => {
    const env: NodeJS.ProcessEnv = { HERMES_DESKTOP_PASSWORD_STORE: 'basic', XDG_CURRENT_DESKTOP: 'GNOME' }
    expect(applyLinuxPasswordStoreDefault({ env, platform: 'linux', argv: [] })).toBeNull()
    expect(env.HERMES_DESKTOP_PASSWORD_STORE).toBe('basic')
  })

  it('treats a blank value as unset', () => {
    const env: NodeJS.ProcessEnv = { HERMES_DESKTOP_PASSWORD_STORE: '  ', XDG_CURRENT_DESKTOP: 'GNOME' }
    expect(applyLinuxPasswordStoreDefault({ env, platform: 'linux', argv: [] })).toBe('gnome-libsecret')
  })

  it('leaves a --password-store argument to Chromium', () => {
    for (const argv of [['--password-store=basic'], ['--password-store', 'kwallet5']]) {
      const env: NodeJS.ProcessEnv = { XDG_CURRENT_DESKTOP: 'GNOME' }
      expect(applyLinuxPasswordStoreDefault({ env, platform: 'linux', argv })).toBeNull()
      expect(env.HERMES_DESKTOP_PASSWORD_STORE).toBeUndefined()
    }
  })

  it('is a no-op off Linux', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const env: NodeJS.ProcessEnv = { XDG_CURRENT_DESKTOP: 'GNOME' }
      expect(applyLinuxPasswordStoreDefault({ env, platform, argv: [] })).toBeNull()
      expect(env).toEqual({ XDG_CURRENT_DESKTOP: 'GNOME' })
    }
  })

  it('an auto-detected store never enables plain-text encryption', () => {
    const env: NodeJS.ProcessEnv = { XDG_CURRENT_DESKTOP: 'sway' }
    const store = applyLinuxPasswordStoreDefault({ env, platform: 'linux', argv: [] })
    let flipped = false
    const safeStorageApi = { setUsePlainTextEncryption: () => (flipped = true) }

    expect(enableBasicPasswordStoreEncryption({ platform: 'linux', passwordStoreSwitch: store, safeStorageApi })).toBe(
      false
    )
    expect(flipped).toBe(false)
  })
})
