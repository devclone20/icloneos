import { describe, expect, it } from 'vitest'

import { swRoute } from './sw-policy'
import { serviceWorkerSource, webManifest } from './sw-source'

describe('icloneOS Web service worker policy', () => {
  it.each([
    '/api/sessions',
    '/api/ws',
    '/api/auth/ws-ticket',
    '/api',
    '/ws',
    '/login',
    '/auth/callback',
    '/logout',
    '/oauth/x'
  ])('never caches %s', path => {
    expect(swRoute(path, 'GET', 'cors')).toBe('network-only')
    expect(swRoute(path, 'GET', 'navigate')).toBe('network-only')
  })

  it('only content-hashed assets are cacheable; navigations always hit the network first', () => {
    expect(swRoute('/assets/index-abc123.js', 'GET', 'cors')).toBe('asset')
    expect(swRoute('/assets/index-abc123.js', 'POST', 'cors')).toBe('network-only')
    expect(swRoute('/', 'GET', 'navigate')).toBe('navigate')
    expect(swRoute('/index.html', 'GET', 'no-cors')).toBe('network-only')
    expect(swRoute('/apiary/x.js', 'GET', 'cors')).toBe('network-only')
  })

  it('sw.js embeds the tested policy and never stores a non-asset response', () => {
    const source = serviceWorkerSource('icloneos-web-test')
    expect(source).toContain(swRoute.toString())
    expect(source).not.toMatch(/addAll/)
    const puts = source.split('\n').filter(line => line.includes('cache.put'))
    expect(puts).toHaveLength(1)
    expect(source.indexOf("route === 'asset'")).toBeLessThan(source.indexOf('cache.put'))
  })

  it('the manifest is installable: standalone, start_url, a 512 icon', () => {
    const manifest = webManifest('1.1.0')
    expect(manifest).toMatchObject({
      name: 'icloneOS Web',
      display: 'standalone',
      start_url: '/',
      scope: '/',
      version: '1.1.0'
    })
    expect(manifest.icons.some(icon => icon.sizes === '512x512')).toBe(true)
  })
})
