import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { BUNDLED_POLICY } from '../../electron/policy-version.generated'

import {
  ABSENT_IN_WEB,
  type ConsentStorage,
  createWebBridge,
  sameOriginUrl,
  unavailable,
  WEB_CONSENT_KEY
} from './bridge'

const location = { host: 'gw.local:8787', origin: 'http://gw.local:8787', protocol: 'http:' }

function fakeFetch(status = 200, body = '{"ok":true}') {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(body, { status }))
}

type AnyBridge = Record<string, any>

describe('createWebBridge', () => {
  afterEach(() => vi.restoreAllMocks())

  it('api() is a same-origin fetch carrying the injected session token', async () => {
    const fetchImpl = fakeFetch()
    const bridge = createWebBridge({ authRequired: false, fetchImpl, location, token: 'tok' }) as AnyBridge
    await expect(bridge.api({ path: '/api/sessions?limit=5', method: 'POST', body: { a: 1 } })).resolves.toEqual({
      ok: true
    })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://gw.local:8787/api/sessions?limit=5')
    expect(init?.headers).toMatchObject({ 'X-Hermes-Session-Token': 'tok', 'Content-Type': 'application/json' })
    expect(init?.credentials).toBe('same-origin')
    expect(init?.body).toBe('{"a":1}')
  })

  it('V3-0: themes marketplace is absent in the web build and no GET /api/themes/marketplace is ever sent', async () => {
    const fetchImpl = fakeFetch()
    const bridge = createWebBridge({ authRequired: false, fetchImpl, location, token: 't' }) as AnyBridge

    expect(ABSENT_IN_WEB).toContain('themes')
    expect(bridge.themes).toBeUndefined()
    // The renderer's own call shape: optional chaining lands on nothing, so no request can be made.
    expect(bridge.themes?.searchMarketplace?.('dracula')).toBeUndefined()
    expect(bridge.themes?.fetchMarketplace?.('dracula.theme')).toBeUndefined()
    expect(fetchImpl.mock.calls.map(([url]) => String(url)).filter(u => u.includes('/api/themes/marketplace'))).toEqual(
      []
    )
    // And the shim's source no longer names the route at all.
    expect(readFileSync(join(__dirname, 'bridge.ts'), 'utf8')).not.toContain("'/api/themes/marketplace")
  })

  it('api() mirrors the desktop IPC contract: status errors, empty body = null, text passthrough', async () => {
    const make = (status: number, body: string) =>
      createWebBridge({ authRequired: false, fetchImpl: fakeFetch(status, body), location, token: 't' }) as AnyBridge

    await expect(make(401, 'nope').api({ path: '/api/x' })).rejects.toThrow('401: nope')
    await expect(make(200, '').api({ path: '/api/x' })).resolves.toBeNull()
    await expect(make(200, 'plain').api({ path: '/api/x' })).resolves.toBe('plain')
  })

  it('the session token never leaves the origin, whatever path a caller passes', async () => {
    const hostile = [
      '//evil.example/x',
      'https://evil.example/x',
      'http://evil.example:80/api/x',
      '\\\\evil.example/x',
      '/\\evil.example/x',
      '/\t/evil.example/x',
      'api/x',
      ''
    ]

    for (const path of hostile) {
      const fetchImpl = fakeFetch()
      const bridge = createWebBridge({ authRequired: false, fetchImpl, location, token: 'TOKEN123' }) as AnyBridge
      await expect(bridge.api({ path })).rejects.toThrow(/origin/)
      expect(fetchImpl).not.toHaveBeenCalled()
    }

    expect(() => sameOriginUrl('/api/a?q=%2F%2Fevil', location.origin)).not.toThrow()
  })

  it('a path can never leave the gateway origin', async () => {
    const fetchImpl = fakeFetch()
    const bridge = createWebBridge({ authRequired: false, fetchImpl, location, token: 't' }) as AnyBridge
    await bridge.api({ path: '/api/a' })
    expect(new URL(fetchImpl.mock.calls[0][0]).origin).toBe(location.origin)
  })

  it('websocket URL: token mode uses ?token=, gated mode mints a ws-ticket', async () => {
    const tokenBridge = createWebBridge({
      authRequired: false,
      fetchImpl: fakeFetch(),
      location,
      token: 'a b'
    }) as AnyBridge

    await expect(tokenBridge.getGatewayWsUrl()).resolves.toBe('ws://gw.local:8787/api/ws?token=a%20b')
    const fetchImpl = fakeFetch(200, '{"ticket":"T1"}')

    const gated = createWebBridge({
      authRequired: true,
      fetchImpl,
      location: { ...location, protocol: 'https:' },
      token: null
    }) as AnyBridge

    await expect(gated.getGatewayWsUrlFor({ connectionId: 'x' })).resolves.toBe('wss://gw.local:8787/api/ws?ticket=T1')
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('POST')
    expect(fetchImpl.mock.calls[0][1]?.headers).not.toHaveProperty('X-Hermes-Session-Token')
  })

  it('reports the single same-origin connection and no saved registry entries', async () => {
    const bridge = createWebBridge({ authRequired: false, fetchImpl: fakeFetch(), location, token: 't' }) as AnyBridge
    await expect(bridge.getConnection()).resolves.toMatchObject({
      baseUrl: location.origin,
      mode: 'remote',
      token: 't'
    })
    await expect(bridge.connections.list()).resolves.toEqual([])
    expect(typeof bridge.connections.onChanged(() => undefined)).toBe('function')
  })

  it('clipboard and openExternal use the browser', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, readText: async () => 'x' }
    })
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const bridge = createWebBridge({ authRequired: false, fetchImpl: fakeFetch(), location, token: 't' }) as AnyBridge
    await bridge.writeClipboard('hi')
    await bridge.openExternal('https://cloneframe.io')
    expect(writeText).toHaveBeenCalledWith('hi')
    expect(open).toHaveBeenCalledWith('https://cloneframe.io', '_blank', 'noopener,noreferrer')
  })

  it('desktop-only features are honest no-ops that never throw', async () => {
    const report = vi.fn()

    const bridge = createWebBridge({
      authRequired: false,
      fetchImpl: fakeFetch(),
      location,
      notAvailable: report,
      token: 't'
    }) as AnyBridge

    await expect(bridge.terminal.start({ cols: 80 })).resolves.toEqual([])
    await expect(bridge.icloneOwnership.list()).resolves.toEqual([])
    expect(bridge.iclonePrivy.onSession(() => undefined)).toBeTypeOf('function')
    expect(bridge.someFutureCall).toBeUndefined()
    expect(report).toHaveBeenCalledWith('someFutureCall')
    await expect(bridge.readFileText('/x')).resolves.toEqual([])
    expect(bridge.onDeepLink(() => undefined)).toBeTypeOf('function')
    expect(report).toHaveBeenCalledWith('terminal.start')
    expect(await Promise.resolve(bridge.hud)).toBe(bridge.hud)
  })

  it('an unavailable call works both as an effect cleanup and as a promise', async () => {
    const result = (unavailable('icloneAcp.watch', () => undefined) as () => any)()
    expect(() => result()).not.toThrow()
    await expect(result).resolves.toEqual([])
    await expect(result.catch(() => 'x')).resolves.toEqual([])
  })

  it('every preload namespace has an explicit web decision', () => {
    const preload = readFileSync(join(__dirname, '../../electron/preload.ts'), 'utf8')
    const shim = readFileSync(join(__dirname, 'bridge.ts'), 'utf8')
    const namespaces = [...preload.matchAll(/^ {2}([A-Za-z]\w*): \{/gm)].map(match => match[1])
    expect(namespaces.length).toBeGreaterThan(20)
    expect(namespaces.filter(ns => !new RegExp(`['"\\s]${ns}['":\\s]`).test(shim))).toEqual([])
  })

  it('optional desktop namespaces are absent, so callers take their own not-in-this-build path', () => {
    const bridge = createWebBridge({
      authRequired: false,
      fetchImpl: fakeFetch(),
      location,
      notAvailable: () => {},
      token: 't'
    }) as AnyBridge

    for (const ns of ABSENT_IN_WEB) {
      expect(bridge[ns]).toBeUndefined()
    }

    expect(bridge.icloneClaudeCode?.status).toBeUndefined()
  })

  it('icloneDoctor is absent in the web app, so Diagnostics shows its honest !bridge state', () => {
    const notAvailable = vi.fn()
    const bridge = createWebBridge({ authRequired: false, fetchImpl: fakeFetch(), location, notAvailable, token: 't' })

    expect(ABSENT_IN_WEB).toContain('icloneDoctor')
    expect((bridge as AnyBridge).icloneDoctor).toBeUndefined()
    expect('icloneDoctor' in bridge).toBe(true)
    expect(notAvailable).not.toHaveBeenCalled()
  })

  it('settings and zoom answer in the shapes the renderer reads', async () => {
    const bridge = createWebBridge({ authRequired: false, fetchImpl: fakeFetch(), location, token: 't' }) as AnyBridge
    await expect(bridge.zoom.get()).resolves.toEqual({ level: 0, percent: 100 })
    await expect(bridge.settings.getDefaultProjectDir()).resolves.toMatchObject({ dir: null })
    await expect(bridge.settings.pickDefaultProjectDir()).resolves.toEqual({ canceled: true, dir: null })
  })
})

describe('icloneConsent in the web app', () => {
  function storage(): ConsentStorage & { items: Map<string, string> } {
    const items = new Map<string, string>()

    return { getItem: key => items.get(key) ?? null, items, setItem: (key, value) => void items.set(key, value) }
  }

  const make = (store: ConsentStorage) =>
    createWebBridge({
      authRequired: false,
      fetchImpl: fakeFetch(),
      location,
      policy: BUNDLED_POLICY,
      storage: store,
      token: 't'
    }) as AnyBridge

  it('a first visit asks for the bundled policy with the desktop snapshot shape', async () => {
    const snap = await make(storage()).icloneConsent.get()
    expect(snap.state).toBe('required')
    expect(snap.record).toBeNull()
    expect(snap.keychainEncrypted).toBe(false)
    expect(snap.bundled.effectiveLabel).toBe(BUNDLED_POLICY.effectiveLabel)
    expect(snap.bundled.permissions.length).toBe(BUNDLED_POLICY.permissions.length)
  })

  it('accepts only the bundled version, persists per origin and keeps switches on re-acceptance', async () => {
    const store = storage()
    const consent = make(store).icloneConsent
    await expect(consent.accept({ version: '0.1' })).resolves.toMatchObject({ ok: false })
    await expect(consent.setPermissions({ permissions: { files: true } })).resolves.toMatchObject({ ok: false })
    await expect(consent.accept({ aiProvider: true, version: BUNDLED_POLICY.version })).resolves.toMatchObject({
      ok: true
    })
    await expect(
      consent.setPermissions({ permissions: { files: true, keychain: true, bogus: true } })
    ).resolves.toMatchObject({
      ok: true,
      record: { permissions: { files: true, keychain: false } }
    })
    const again = await make(store).icloneConsent.get()
    expect(again.state).toBe('ok')
    expect(again.record.aiProviderConsent.accepted).toBe(true)
    store.items.set(WEB_CONSENT_KEY, JSON.stringify({ ...again.record, policyVersion: '0.9' }))
    expect((await make(store).icloneConsent.get()).state).toBe('update')
    store.items.set(WEB_CONSENT_KEY, '{not json')
    expect((await make(store).icloneConsent.get()).state).toBe('required')
  })

  it('works without localStorage (node, privacy modes) and cannot quit a browser tab', async () => {
    const bridge = createWebBridge({ authRequired: false, fetchImpl: fakeFetch(), location, token: 't' }) as AnyBridge
    const snap = await bridge.icloneConsent.get()
    expect(snap).toMatchObject({
      bundled: { effectiveLabel: BUNDLED_POLICY.effectiveLabel, version: BUNDLED_POLICY.version },
      state: 'required'
    })
    expect(snap.bundled.permissions).toEqual([])
    await expect(bridge.icloneConsent.quit()).resolves.toBe(false)
  })
})
