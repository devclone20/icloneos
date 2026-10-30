import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const RENDERER_INDEX = path.join(__dirname, '..', 'index.html')
const PRIVY_PAGE = path.join(__dirname, '..', '..', '..', 'iclone', 'privy', 'privy.html')

function readPolicy(html: string): Map<string, string[]> {
  const metas = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/g)]

  expect(metas).toHaveLength(1)

  return new Map(
    metas[0][1]
      .split(';')
      .map(part => part.trim().split(/\s+/))
      .filter(tokens => tokens[0])
      .map(([name, ...sources]) => [name, sources])
  )
}

function expectBaseline(policy: Map<string, string[]>) {
  for (const [name, sources] of policy) {
    expect(sources, name).not.toContain("'unsafe-eval'")
    expect(sources, name).not.toContain('*')
  }

  expect(policy.get('default-src')).toEqual(["'self'"])
  expect(policy.get('object-src')).toEqual(["'none'"])
  expect(policy.get('base-uri')).toEqual(["'none'"])
  expect(policy.get('form-action')).toEqual(["'none'"])
}

describe('renderer CSP (index.html)', () => {
  const html = fs.readFileSync(RENDERER_INDEX, 'utf8')
  const policy = readPolicy(html)

  it('keeps the baseline: no eval, no plugins, no base or form hijack', () => {
    expectBaseline(policy)
  })

  it('is declared before the first script, so it covers the boot script and the bundle', () => {
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script'))
  })

  it('carries no hash or nonce: either would silently disable the unsafe-inline that srcdoc previews inherit', () => {
    const scripts = policy.get('script-src') ?? []

    expect(scripts).toContain("'unsafe-inline'")
    expect(scripts.filter(source => /^'(sha\d+|nonce)-/.test(source))).toEqual([])
  })

  it('loads scripts only from itself and the named CDNs (never a scheme-wide source)', () => {
    const remote = (policy.get('script-src') ?? []).filter(source => /^[a-z-]+:/.test(source))

    expect(remote.every(source => source === 'blob:' || /^https:\/\/[a-z0-9.-]+$/.test(source))).toBe(true)
  })

  it('frames only the embed providers the app renders, plus the skills hub', () => {
    expect(policy.get('frame-src')).toEqual(
      expect.arrayContaining([
        'https://www.youtube-nocookie.com',
        'https://open.spotify.com',
        'https://hermes-agent.nousresearch.com'
      ])
    )
    expect(policy.get('frame-src')).not.toContain('https:')
  })

  it('reaches the media protocol the main process registers', () => {
    expect(policy.get('img-src')).toContain('hermes-media:')
    expect(policy.get('media-src')).toContain('hermes-media:')
  })
})

describe('Privy page CSP (privy.html)', () => {
  const html = fs.readFileSync(PRIVY_PAGE, 'utf8')
  const policy = readPolicy(html)

  it('keeps the baseline', () => {
    expectBaseline(policy)
  })

  it('allows no inline script except the pinned bootstrap', () => {
    const scripts = policy.get('script-src') ?? []
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1])

    expect(scripts).not.toContain("'unsafe-inline'")
    expect(inline).toHaveLength(1)

    const digest = crypto.createHash('sha256').update(inline[0]).digest('base64')

    expect(scripts).toContain(`'sha256-${digest}'`)
  })

  it('connects and frames only Privy and WalletConnect/Reown origins', () => {
    for (const directive of ['connect-src', 'frame-src', 'child-src']) {
      const sources = (policy.get(directive) ?? []).filter(source => source !== "'self'")

      expect(sources.length, directive).toBeGreaterThan(0)
      expect(
        sources.every(source => /^(https|wss):\/\/[a-z0-9*.-]+$/.test(source)),
        directive
      ).toBe(true)
    }

    expect(policy.get('connect-src')).toContain('https://auth.privy.io')
    expect(policy.get('frame-src')).toContain('https://auth.privy.io')
  })
})
