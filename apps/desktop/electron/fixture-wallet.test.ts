// v0.0.9 r3 (lead order 5): the fixture wallet seam — offline Collection / wallet states for captures, dev/test only.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { afterAll, describe, expect, it } from 'vitest'

import {
  FIXTURE_MODEL_URL,
  FIXTURE_WALLET_ENV,
  fixtureModelGlb,
  fixtureProfile,
  fixtureScanResult,
  fixtureSession,
  fixtureSwitchLogLine,
  parseFixtureWallet,
  resolveFixtureWallet
} from './fixture-wallet'
import { CODE_PATH_ENV, resolveCodePathEnv, sealChildEnv } from './packaged-env'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-wallet-'))
const ADDRESS = '0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631'

afterAll(() => fs.rmSync(dir, { force: true, recursive: true }))

describe('a packaged build never fakes a wallet', () => {
  it('the switch is a code-path variable: packaged reads undefined, and children never inherit it', () => {
    const env = { [FIXTURE_WALLET_ENV]: 'builtin:grid' }

    expect(CODE_PATH_ENV).toContain(FIXTURE_WALLET_ENV)
    expect(resolveCodePathEnv(FIXTURE_WALLET_ENV, env, true)).toBeUndefined()
    expect(resolveCodePathEnv(FIXTURE_WALLET_ENV, env, false)).toBe('builtin:grid')

    const child: Record<string, string | undefined> = { ...env }

    sealChildEnv(child, true, {})
    expect(child[FIXTURE_WALLET_ENV]).toBeUndefined()
  })

  it('and the resolver checks isPackaged again (two locks)', () => {
    expect(resolveFixtureWallet('builtin:grid', true)).toBeNull()
    expect(resolveFixtureWallet('builtin:grid', false)?.scan).toBe('grid')
  })
})

describe('the built-in fixtures reach every Collection state', () => {
  it.each([
    ['builtin:grid', 'grid', 6],
    ['builtin:empty', 'empty', 0],
    ['builtin:error', 'error', 6],
    ['builtin:retry', 'error-then-grid', 6],
    ['builtin:slow', 'grid', 6],
    ['builtin:partial', 'grid', 6],
    ['builtin:balances-slow', 'grid', 6],
    ['builtin:balances-error', 'grid', 6],
    ['builtin:reopen', 'grid', 6]
  ] as const)('%s', (value, scan, count) => {
    const fixture = resolveFixtureWallet(value, false)!

    expect(fixture.scan).toBe(scan)
    expect(fixture.infts).toHaveLength(count)
    expect(fixture.infts.every(inft => inft.image === '')).toBe(true) // nothing to fetch
  })

  it('slow holds the loading skeleton; retry fails once then answers the grid', () => {
    expect(resolveFixtureWallet('builtin:slow', false)!.scanDelayMs).toBeGreaterThanOrEqual(5_000)

    const retry = resolveFixtureWallet('builtin:retry', false)!

    expect(fixtureScanResult(retry, 0)).toMatchObject({ ok: false, agents: [] })
    expect(fixtureScanResult(retry, 1)).toMatchObject({ ok: true, complete: true })
    expect(fixtureScanResult(retry, 1).agents).toHaveLength(6)
    expect(fixtureScanResult(resolveFixtureWallet('builtin:error', false)!, 5).ok).toBe(false)
    expect(fixtureScanResult(resolveFixtureWallet('builtin:empty', false)!, 0)).toMatchObject({ ok: true, agents: [] })
  })

  it('an unknown builtin, a relative path or a missing file is no fixture', () => {
    expect(resolveFixtureWallet('builtin:nope', false)).toBeNull()
    expect(resolveFixtureWallet('fixture.json', false)).toBeNull()
    expect(resolveFixtureWallet(path.join(dir, 'missing.json'), false)).toBeNull()
    expect(resolveFixtureWallet(undefined, false)).toBeNull()
  })

  it('the session payload: signed in to the fixture address, or out', () => {
    const fixture = resolveFixtureWallet('builtin:grid', false)!

    expect(fixtureSession(fixture, true)).toMatchObject({ status: 'in', address: fixture.address })
    expect(fixtureSession(fixture, false)).toEqual({ status: 'out', address: null, userId: null, label: null })
  })
})

describe('a custom fixture file', () => {
  it('is validated field by field', () => {
    const file = path.join(dir, 'mine.json')

    fs.writeFileSync(
      file,
      JSON.stringify({
        address: ADDRESS,
        scan: 'grid',
        scanDelayMs: 0,
        infts: [{ chain: 'Base', contract: ADDRESS, tokenId: '7', name: 'Seven' }],
        balances: { base: '1.5' }
      })
    )

    expect(resolveFixtureWallet(file, false)).toMatchObject({ address: ADDRESS, balances: { base: '1.5' } })
  })

  it.each([
    ['a bad address', { address: '0x12' }],
    ['an unknown scan', { address: ADDRESS, scan: 'sometimes' }],
    ['a delay past 30 s', { address: ADDRESS, scanDelayMs: 60_000 }],
    ['an image URL (it would fetch)', { address: ADDRESS, infts: [{ chain: 'Base', contract: ADDRESS, tokenId: '1', name: 'x', image: 'https://e.x/a.png' }] }],
    ['a non-decimal balance', { address: ADDRESS, balances: { base: '1e9' } }],
    ['a model URL that is not the built-in one (it would fetch)', { address: ADDRESS, infts: [{ chain: 'Base', contract: ADDRESS, tokenId: '1', name: 'x', model: 'https://e.x/a.glb' }] }],
    ['a soul that is not a boolean', { address: ADDRESS, infts: [{ chain: 'Base', contract: ADDRESS, tokenId: '1', name: 'x', soul: 'yes' }] }],
    ['too many iNFTs', { address: ADDRESS, infts: Array.from({ length: 65 }, (_, i) => ({ chain: 'Base', contract: ADDRESS, tokenId: String(i), name: 'x' })) }]
  ])('refuses %s', (_why, raw) => {
    expect(parseFixtureWallet(raw)).toBeNull()
  })
})

describe('r3b (MR3-1): builtin:reopen feeds the real agent path, offline', () => {
  const reopen = () => resolveFixtureWallet('builtin:reopen', false)!

  it('the first iNFT carries the built-in model and a fixture soul; the others stay plain (captures unchanged)', () => {
    const agents = fixtureScanResult(reopen(), 0).agents

    expect(agents[0]).toMatchObject({ name: 'iCLONE Aurora', model: FIXTURE_MODEL_URL, isAgentNft: true })
    expect(agents[0]!.bootstrap).toMatchObject({ protocol: 'iclone-fixture', genesis: '', repo: '' })
    expect(agents.slice(1).every(agent => agent.model === '' && agent.bootstrap === null)).toBe(true)
    // builtin:grid is unchanged: no model, no soul.
    expect(fixtureScanResult(resolveFixtureWallet('builtin:grid', false)!, 0).agents.every(a => !a.model && !a.bootstrap)).toBe(
      true
    )
    expect(resolveFixtureWallet('builtin:reopen', true)).toBeNull()
  })

  it('the model URL can never be fetched (an .invalid host) and is the only one a fixture may name', () => {
    expect(new URL(FIXTURE_MODEL_URL).hostname.endsWith('.invalid')).toBe(true)
    expect(
      parseFixtureWallet({
        address: ADDRESS,
        infts: [{ chain: 'Base', contract: ADDRESS, tokenId: '1', name: 'x', model: FIXTURE_MODEL_URL, soul: true }]
      })?.infts[0]
    ).toMatchObject({ model: FIXTURE_MODEL_URL, soul: true })
  })

  it('the built-in model is a small valid GLB that the stage\'s own loader parses into one mesh', async () => {
    const glb = fixtureModelGlb()

    expect(glb.subarray(0, 4).toString('latin1')).toBe('glTF')
    expect(glb.readUInt32LE(8)).toBe(glb.length)
    expect(glb.length).toBeLessThan(4096)

    const buffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer

    const gltf = await new Promise<{ scene: { traverse: (fn: (node: { isMesh?: boolean }) => void) => void } }>(
      (resolve, reject) => new GLTFLoader().parse(buffer, '', resolve as never, reject)
    )

    let meshes = 0

    gltf.scene.traverse(node => {
      meshes += node.isMesh ? 1 : 0
    })
    expect(meshes).toBe(1)
  })

  it('the soul iNFT resolves its profile offline; any other item is left to the real resolver', () => {
    const fixture = reopen()
    const aurora = fixture.infts[0]!

    expect(fixtureProfile(fixture, { contract: aurora.contract.toUpperCase().replace('0X', '0x'), tokenId: aurora.tokenId }, 's')).toMatchObject({
      slug: 's',
      name: 'iCLONE Aurora',
      source: 'genesis',
      soulMd: expect.stringContaining('# iCLONE Aurora')
    })
    expect(fixtureProfile(fixture, { contract: aurora.contract, tokenId: fixture.infts[1]!.tokenId }, 's')).toBeNull()
    expect(fixtureProfile(fixture, { contract: ADDRESS, tokenId: aurora.tokenId }, 's')).toBeNull()
  })

  it('the reopen loop marker: only an iNFT switch "done" line, only while a fixture is active', () => {
    const fixture = reopen()

    expect(fixtureSwitchLogLine(fixture, '[inft-switch] inft-000000-101 done 2412 reopened')).toBe(
      '[fixture] inft connected inft-000000-101 (2412 ms, reopened)'
    )
    expect(fixtureSwitchLogLine(fixture, '[inft-switch] inft-000000-101 done 12')).toBe(
      '[fixture] inft connected inft-000000-101 (12 ms)'
    )
    expect(fixtureSwitchLogLine(null, '[inft-switch] inft-000000-101 done 12')).toBeNull()
    expect(fixtureSwitchLogLine(fixture, '[inft-switch] hermes done 12 session')).toBeNull() // plain Hermes is not an iNFT
    expect(fixtureSwitchLogLine(fixture, '[inft-switch] inft-000000-101 failed 12 boom')).toBeNull()
    expect(fixtureSwitchLogLine(fixture, 'x [inft-switch] inft-000000-101 done 12')).toBeNull()
    expect(fixtureSwitchLogLine(fixture, 42)).toBeNull()
  })
})
