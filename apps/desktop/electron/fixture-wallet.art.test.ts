/**
 * v0.0.9 r4 (design r3 MAJOR 2): dev/test-only fixture iNFT art. Six small SVG tiles in apps/desktop/fixtures/inft-art
 * give the built-in fixture iNFTs real-looking art (read from disk as data: URIs, never fetched). They are never shipped:
 * the folder is outside package.json build.files (the same contract K146 pins for public/), nothing under src/ imports it,
 * and a packaged build never applies them. Red on 5470b2b185: withFixtureArt did not exist and every image was ''.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FIXTURE_ART_DIR, resolveFixtureWallet, withFixtureArt } from './fixture-wallet'

const DESKTOP = path.resolve(__dirname, '..')
const ART = path.join(DESKTOP, FIXTURE_ART_DIR)
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

function scratch(files: Record<string, string | Buffer>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-art-'))

  dirs.push(dir)

  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body)
  }

  return dir
}

const decode = (uri: string) => Buffer.from(uri.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8')

type PackConfig = Record<string, unknown> & { mac?: Record<string, unknown>; win?: Record<string, unknown>; linux?: Record<string, unknown> }

/** Which pack entries (root or per platform) name the fixtures folder: extraResources, extraFiles, asarUnpack. */
function packEntriesReachFixtures(build: PackConfig): string[] {
  const hits: string[] = []

  const scopes: [string, Record<string, unknown> | undefined][] = [
    ['', build],
    ['mac.', build.mac],
    ['win.', build.win],
    ['linux.', build.linux]
  ]

  for (const [prefix, scope] of scopes) {
    for (const key of ['extraResources', 'extraFiles', 'asarUnpack']) {
      const entries = scope?.[key]

      if (entries !== undefined && /(^|["/])fixtures(\/|"|$)/m.test(JSON.stringify(entries))) {
        hits.push(`${prefix}${key}`)
      }
    }
  }

  return hits
}

describe('fixture art (dev/test only)', () => {
  it('the bundled tiles: six distinct 4:5 SVGs, one per built-in token, small, nothing that fetches', () => {
    const files = fs.readdirSync(ART).sort()

    expect(files).toEqual([
      '101-aurora.svg',
      '102-basalt.svg',
      '103-cinder.svg',
      '104-delta.svg',
      '105-ember.svg',
      '106-fjord.svg'
    ])

    for (const file of files) {
      const svg = fs.readFileSync(path.join(ART, file), 'utf8')

      expect(svg.length).toBeLessThan(16 * 1024)
      expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 400 500"/)
      // r4b (critic-r4 01-collection-grid): the label sits top-right, clear of the Collection's caption block at the
      // bottom, its state chip and the Book's checkbox at the top-left, and the Book's mark at the bottom-right.
      expect(svg).toMatch(/<text x="376" y="40" text-anchor="end"/)
      // Offline by construction: no external reference, no script, no foreign object.
      expect(svg.replace(' xmlns="http://www.w3.org/2000/svg"', '')).not.toMatch(/https?:|href=|<script|<foreignObject|<image/i)
    }
  })

  it('a dev run: every built-in iNFT gets its own tile as a data:image/svg+xml URI', () => {
    const fixture = withFixtureArt(resolveFixtureWallet('builtin:grid', false), false, ART)!
    const images = fixture.infts.map(inft => inft.image)

    expect(images.every(image => image.startsWith('data:image/svg+xml;base64,'))).toBe(true)
    expect(new Set(images).size).toBe(6)
    expect(decode(images[0])).toBe(fs.readFileSync(path.join(ART, '101-aurora.svg'), 'utf8'))
  })

  it('every builtin scenario with iNFTs gets the art; builtin:reopen keeps its model and soul', () => {
    for (const name of ['grid', 'error', 'retry', 'slow', 'partial', 'balances-slow', 'balances-error', 'reopen']) {
      const fixture = withFixtureArt(resolveFixtureWallet(`builtin:${name}`, false), false, ART)!

      expect(fixture.infts.every(inft => inft.image.startsWith('data:image/svg+xml')), name).toBe(true)
    }

    const reopen = withFixtureArt(resolveFixtureWallet('builtin:reopen', false), false, ART)!

    expect(reopen.infts[0]).toMatchObject({ soul: true, model: expect.stringContaining('fixture.invalid') })
  })

  it('a packaged build: no fixture at all, and the art is never applied even to one passed in', () => {
    const dev = resolveFixtureWallet('builtin:grid', false)!

    expect(withFixtureArt(resolveFixtureWallet('builtin:grid', true), true, ART)).toBeNull()
    expect(withFixtureArt(dev, true, ART)).toBe(dev)
    expect(dev.infts.every(inft => inft.image === '')).toBe(true)
  })

  it('a missing folder, odd names, non-SVG and oversize files are skipped, never an error', () => {
    const dev = resolveFixtureWallet('builtin:grid', false)!

    expect(withFixtureArt(dev, false, path.join(os.tmpdir(), 'no-such-fixture-art'))).toBe(dev)

    const dir = scratch({
      '101-ok.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 5"/>',
      '102-big.svg': `<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(17 * 1024)}</svg>`,
      '103-notsvg.svg': 'GIF89a',
      'evil.svg': '<svg/>',
      '104-Bad Name.svg': '<svg/>'
    })

    const images = withFixtureArt(dev, false, dir)!.infts.map(inft => inft.image)

    expect(images[0]).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(images.slice(1).every(image => image === '')).toBe(true)
  })

  it('a custom fixture keeps its own images; only the built-in contract is dressed', () => {
    const custom = {
      ...resolveFixtureWallet('builtin:grid', false)!,
      infts: [{ chain: 'Base', contract: '0x1111111111111111111111111111111111111111', tokenId: '101', name: 'Mine', image: '' }]
    }

    expect(withFixtureArt(custom, false, ART)!.infts[0].image).toBe('')
  })

  it('never shipped: the folder is outside every packed path, and nothing in src/ imports it', () => {
    const { build } = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'))
    const asset = `${FIXTURE_ART_DIR.split(path.sep).join('/')}/101-aurora.svg`
    const globs: string[] = build.files.filter((entry: unknown) => typeof entry === 'string')

    expect(globs.length).toBeGreaterThan(0)

    // Every packed glob is rooted at a literal top-level entry (dist/**, assets/**, package.json): none is a root
    // wildcard or negation that could reach fixtures/, and none names it.
    for (const glob of globs) {
      const top = glob.split('/')[0]

      expect(top, glob).toMatch(/^[\w.-]+$/)
      expect(asset.startsWith(`${top}/`) || asset === top, glob).toBe(false)
    }

    // No extraResources / asarUnpack / extraFiles entry reaches into fixtures/ — at the root or per platform (r4d,
    // eng r4-m2: mac/win/linux.extraResources were not checked).
    expect(packEntriesReachFixtures(build)).toEqual([])

    // The check is not vacuous: a mutated platform entry turns it red.
    const mutated = structuredClone(build)

    mutated.mac.extraResources = [...(mutated.mac.extraResources ?? []), { from: 'fixtures', to: 'fixtures' }]
    expect(packEntriesReachFixtures(mutated)).toEqual(['mac.extraResources'])
    mutated.linux.extraFiles = ['fixtures/inft-art/**']
    expect(packEntriesReachFixtures(mutated)).toEqual(['mac.extraResources', 'linux.extraFiles'])

    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name)

        return entry.isDirectory() ? walk(full) : /\.(tsx?|css|mjs)$/.test(entry.name) ? [full] : []
      })

    const importers = walk(path.join(DESKTOP, 'src')).filter(file => fs.readFileSync(file, 'utf8').includes('fixtures/inft-art'))

    expect(importers).toEqual([])
  })
})
