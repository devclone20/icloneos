/**
 * V3-FX M1: the Keychain setting takes effect live. The switch's sealers are built only while the setting is on, are
 * rebuilt after every toggle, and every subscriber hears each real change once — both ways.
 */
import { describe, expect, it, vi } from 'vitest'

import { createKeychainSwitch } from './iclone-live-sealing'

describe('M1: the live keychain switch', () => {
  it('off: nothing is built (no keychain touch) and the reason names the setting; on: built once; off again: gone', () => {
    let on = false
    const build = vi.fn(() => ({ id: build.mock.calls.length }))
    const keychain = createKeychainSwitch(() => on)
    const sealing = keychain.sealer(build)

    expect(sealing.current()).toBeNull()
    expect(sealing.noSealReason()).toBe('keychain-off')
    expect(build).not.toHaveBeenCalled()

    on = true
    keychain.changed()
    expect(sealing.current()).toEqual({ id: 1 })
    expect(sealing.current()).toEqual({ id: 1 })
    expect(build).toHaveBeenCalledTimes(1)
    expect(sealing.noSealReason()).toBe('unsealable')

    on = false
    keychain.changed()
    expect(sealing.current()).toBeNull()
    on = true
    keychain.changed()
    expect(sealing.current()).toEqual({ id: 2 })
  })

  it('a period nobody read in between still gets a fresh sealer: on → off → on rebuilds (the keychain may differ)', () => {
    let on = true
    let builds = 0
    const keychain = createKeychainSwitch(() => on)
    const sealing = keychain.sealer(() => ({ id: ++builds }))

    expect(sealing.current()).toEqual({ id: 1 })
    on = false
    keychain.changed()
    on = true
    keychain.changed()
    expect(sealing.current()).toEqual({ id: 2 })
  })

  it('subscribers hear every real change once, in both directions, and a failing one does not stop the others', () => {
    let on = false
    const keychain = createKeychainSwitch(() => on)
    const heard: boolean[] = []

    keychain.subscribe(() => {
      throw new Error('boom')
    })
    keychain.subscribe(next => heard.push(next))

    keychain.changed()
    on = true
    keychain.changed()
    keychain.changed()
    on = false
    keychain.changed()
    expect(heard).toEqual([true, false])
  })

  it('a subscriber reading the sealer during the change already sees the rebuilt one', () => {
    let on = false
    const keychain = createKeychainSwitch(() => on)
    const sealing = keychain.sealer(() => 'sealer')
    const seen: (string | null)[] = []

    keychain.subscribe(() => seen.push(sealing.current()))
    on = true
    keychain.changed()
    on = false
    keychain.changed()
    expect(seen).toEqual(['sealer', null])
  })
})

describe('M1: wiring — the toggle reaches every subscriber', () => {
  it('every policy write tells the switch; the switch reseals payments and re-checks the ACP tools', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')
    const secrets = fs.readFileSync(path.join(__dirname, 'main', 'secrets.ts'), 'utf8')
    const setter = secrets.slice(secrets.indexOf('export function setSecretStoragePolicy'))

    expect(setter.slice(0, setter.indexOf('\n}\n'))).toMatch(
      /for \(const listener of \[\.\.\._policyWriteListeners\]\)/
    )
    expect(main).toContain('onSecretStoragePolicyWrite(() => keychain.changed())')
    expect(main).toMatch(
      /keychain\.subscribe\(\(\) => \{\n {4}payments\.reseal\(paymentsSealing\.current\(\)\)\n {4}refreshAcpToolsSealing\(\)/
    )
    expect(main).toContain('sealer: () => acpToolsSealing.current()')
    expect(main).toContain('noSealReason: () => acpToolsSealing.noSealReason()')
  })

  it('r3 (critic k2): initIcloneAcp hands the installer live getters, never a value read once at start', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const acp = fs.readFileSync(path.join(__dirname, 'iclone-acp.ts'), 'utf8')
    const call = acp.slice(acp.indexOf('tools = createAcpTools({'), acp.indexOf('void tools.refresh()'))

    expect(call).toMatch(
      /get sealer\(\) \{\n\s+return typeof sealer === 'function' \? sealer\(\) : \(sealer \?\? null\)\n\s+\}/
    )
    expect(call).toMatch(
      /get noSealReason\(\) \{\n\s+return typeof noSeal === 'function' \? noSeal\(\) : noSeal\n\s+\}/
    )
    expect(call).not.toMatch(/\bsealer: /)
    expect(call).not.toMatch(/\bnoSealReason: /)
    expect(acp).toMatch(/export function refreshAcpToolsSealing\(\): void \{\n\s+void tools\?\.refresh\(\)/)
  })
})
