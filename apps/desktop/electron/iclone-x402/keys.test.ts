import fs from 'node:fs'
import path from 'node:path'

import { verifyTypedData } from 'viem'
import { afterEach, describe, expect, it } from 'vitest'

import { fakeSealer, tmpProfile } from './harness.test-helpers'
import { loadAgentKey, loadOwnerMandateKey, loadSealedSecret, POCKET_MISSING } from './keys'
import { createLedger } from './ledger'
import { normalizeSettings } from './limits'
import { authorizationMessage, createPocketSigner, domainFor, TRANSFER_WITH_AUTHORIZATION_TYPES } from './signer'
import { changeSettings, isStopped, paymentPaths, readSettings, setStop, writeSettings } from './store'
import { NETWORK_INFO, type PaymentRequirements } from './types'

const dirs: string[] = []

const fresh = () => {
  const dir = tmpProfile()

  dirs.push(dir)

  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('sealed secrets (V3-F’s KeySealer, reused)', () => {
  it('no sealer ⇒ unavailable with the Keychain reason, nothing minted, nothing on disk', () => {
    const dir = fresh()
    let minted = 0

    const out = loadSealedSecret(path.join(dir, 'k', 'x.sealed'), null, () => {
      minted += 1

      return 'secret'
    })

    expect(out).toEqual({
      status: 'unavailable',
      secret: null,
      reason: 'OS sealing unavailable (Keychain setting off)'
    })
    expect(minted).toBe(0)
    expect(fs.existsSync(path.join(dir, 'k'))).toBe(false)
  })

  it('creates once (0600, the plain text absent from the file), then reads back sealed', () => {
    const dir = fresh()
    const file = path.join(dir, 'k', 'x.sealed')
    const sealer = fakeSealer()
    const first = loadSealedSecret(file, sealer, () => 'deadbeefcafe')
    const second = loadSealedSecret(file, sealer, () => 'never')

    expect(first).toEqual({ status: 'created', secret: 'deadbeefcafe', reason: null })
    expect(second).toEqual({ status: 'sealed', secret: 'deadbeefcafe', reason: null })
    expect(fs.readFileSync(file, 'utf8')).not.toContain('deadbeefcafe')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.join(dir, 'k')).mode & 0o777).toBe(0o700)
  })

  it('a sealed file the sealer cannot open is left alone: unavailable, not overwritten', () => {
    const dir = fresh()
    const file = path.join(dir, 'k', 'x.sealed')

    loadSealedSecret(file, fakeSealer(), () => 'one')
    fs.writeFileSync(file, 'garbage\n')

    expect(loadSealedSecret(file, fakeSealer(), () => 'two')).toMatchObject({ status: 'unavailable', secret: null })
    expect(fs.readFileSync(file, 'utf8')).toBe('garbage\n')
  })
})

describe('P-256 mandate keys', () => {
  it('the owner key and each agent key are stable across loads and distinct from each other', () => {
    const dir = fresh()
    const sealer = fakeSealer()
    const owner = loadOwnerMandateKey(path.join(dir, 'k'), sealer)
    const again = loadOwnerMandateKey(path.join(dir, 'k'), sealer)
    const agent = loadAgentKey(path.join(dir, 'k'), sealer, 'inft-7')
    const other = loadAgentKey(path.join(dir, 'k'), sealer, 'inft-8')

    expect(owner.status).toBe('created')
    expect(again.status).toBe('sealed')
    expect(again.jwk).toEqual(owner.jwk)
    expect(owner.jwk).toMatchObject({ kty: 'EC', crv: 'P-256' })
    expect(agent.jwk).not.toEqual(owner.jwk)
    expect(agent.jwk).not.toEqual(other.jwk)
    expect(fs.readdirSync(path.join(dir, 'k')).sort()).toEqual([
      'agent-inft-7.sealed',
      'agent-inft-8.sealed',
      'owner-mandate.sealed'
    ])
  })

  it('a slug that could name another file is refused', () => {
    const dir = fresh()

    for (const slug of ['../owner-mandate', 'A', 'x/y', '', 'a'.repeat(65)]) {
      expect(loadAgentKey(path.join(dir, 'k'), fakeSealer(), slug)).toMatchObject({ status: 'unavailable', jwk: null })
    }

    expect(fs.existsSync(path.join(dir, 'k'))).toBe(false)
  })
})

describe('the pocket signer', () => {
  const requirements: PaymentRequirements = {
    scheme: 'exact',
    network: 'eip155:84532',
    amount: '1000000',
    asset: NETWORK_INFO['eip155:84532'].usdc,
    payTo: '0x1111111111111111111111111111111111111111',
    maxTimeoutSeconds: 60,
    extra: { name: 'USDC', version: '2' }
  }

  const tokenDomain = () => {
    const domain = domainFor('eip155:84532', requirements)

    if (!domain) {
      throw new Error('no domain')
    }

    return domain
  }

  it('the EIP-712 domain comes from extra.name / extra.version only: missing or empty ⇒ null (fail closed, the SDK throws); never a table guess', () => {
    const { extra: _dropped, ...bare } = requirements
    const mainnet = { ...bare, network: 'eip155:8453', asset: NETWORK_INFO['eip155:8453'].usdc }

    expect(domainFor('eip155:84532', bare)).toBeNull()
    expect(domainFor('eip155:8453', mainnet)).toBeNull()
    expect(domainFor('eip155:84532', { ...bare, extra: { name: 'USDC' } })).toBeNull()
    expect(domainFor('eip155:84532', { ...bare, extra: { version: '2' } })).toBeNull()
    expect(domainFor('eip155:84532', { ...bare, extra: { name: '', version: '2' } })).toBeNull()
    expect(domainFor('eip155:84532', { ...bare, extra: { name: 'USDC', version: 2 } })).toBeNull()
    expect(domainFor('eip155:8453', { ...mainnet, extra: { name: 'USD Coin', version: '2' } })).toEqual({
      name: 'USD Coin',
      version: '2',
      chainId: 8453,
      verifyingContract: NETWORK_INFO['eip155:8453'].usdc
    })
    // What the earn server puts on the wire: the contracts' own name() — mainnet USDC is "USD Coin", Sepolia "USDC".
    expect(NETWORK_INFO['eip155:8453'].eip712).toEqual({ name: 'USD Coin', version: '2' })
    expect(NETWORK_INFO['eip155:84532'].eip712).toEqual({ name: 'USDC', version: '2' })
  })

  it('no sealer ⇒ unavailable, no address, signing rejects', async () => {
    const signer = createPocketSigner(path.join(fresh(), 'k'), null)

    expect(signer).toMatchObject({
      status: 'unavailable',
      address: null,
      reason: 'OS sealing unavailable (Keychain setting off)'
    })
    await expect(
      signer.signAuthorization(
        {
          from: requirements.payTo,
          to: requirements.payTo,
          value: '1',
          validAfter: '0',
          validBefore: '1',
          nonce: `0x${'0'.repeat(64)}`
        },
        tokenDomain()
      )
    ).rejects.toThrow(/unavailable/)
  })

  it('mints a throwaway key once, keeps the same address across loads, and the hex never sits in the file', () => {
    const dir = path.join(fresh(), 'k')
    const sealer = fakeSealer()
    const a = createPocketSigner(dir, sealer)
    const b = createPocketSigner(dir, sealer)

    expect(a.status).toBe('created')
    expect(b.status).toBe('sealed')
    expect(a.address).toMatch(/^0x[0-9a-f]{40}$/)
    expect(b.address).toBe(a.address)
    expect(fs.readFileSync(path.join(dir, 'pocket.sealed'), 'utf8')).not.toMatch(/0x[0-9a-f]{64}/)
  })

  it('signs an EIP-3009 TransferWithAuthorization that verifies against the pocket address with the token domain', async () => {
    const signer = createPocketSigner(path.join(fresh(), 'k'), fakeSealer())

    const auth = {
      from: signer.address as string,
      to: requirements.payTo,
      value: '1000000',
      validAfter: '0',
      validBefore: String(Math.floor(Date.now() / 1000) + 60),
      nonce: `0x${'ab'.repeat(32)}`
    }

    const domain = tokenDomain()
    const signature = await signer.signAuthorization(auth, domain)

    expect(domain).toEqual({ name: 'USDC', version: '2', chainId: 84532, verifyingContract: requirements.asset })
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/)
    await expect(
      verifyTypedData({
        address: auth.from as `0x${string}`,
        domain,
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: authorizationMessage(auth),
        signature
      })
    ).resolves.toBe(true)
    await expect(
      verifyTypedData({
        address: auth.from as `0x${string}`,
        domain: { ...domain, chainId: 8453 },
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: authorizationMessage(auth),
        signature
      })
    ).resolves.toBe(false)
  })
})

describe('the payments store', () => {
  it('settings: a missing file is the defaults; a write normalizes and the next read sees it', () => {
    const paths = paymentPaths(fresh())

    expect(readSettings(paths)).toEqual(normalizeSettings({}))

    const written = writeSettings(paths, { perTxMicros: 500_000, payees: ['*'], stop: 'yes' })

    expect(written).toMatchObject({ perTxMicros: 500_000, payees: [], stop: false })
    expect(readSettings(paths)).toEqual(written)
    expect(fs.statSync(paths.settings).mode & 0o777).toBe(0o600)
    expect(fs.statSync(paths.root).mode & 0o777).toBe(0o700)
  })

  it('settings: a hand-mangled file reads as the defaults, never as wider', () => {
    const paths = paymentPaths(fresh())

    fs.mkdirSync(paths.root, { recursive: true })
    fs.writeFileSync(paths.settings, '{"perTxMicros": 1e18, "payees": "*"')
    expect(readSettings(paths)).toEqual(normalizeSettings({}))
    fs.writeFileSync(paths.settings, '{"perDayMicros": null, "origins": ["*"]}')
    expect(readSettings(paths)).toMatchObject({ perDayMicros: 5_000_000, origins: [] })
  })

  it('STOP: set, seen, cleared; a directory named STOP does not count', () => {
    const paths = paymentPaths(fresh())
    const ledger = createLedger({ file: paths.ledger })

    expect(isStopped(paths)).toBe(false)
    setStop(paths, true, ledger)
    expect(isStopped(paths)).toBe(true)
    expect(fs.readFileSync(paths.stop, 'utf8')).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    setStop(paths, false, ledger)
    expect(isStopped(paths)).toBe(false)
    fs.mkdirSync(paths.stop)
    expect(isStopped(paths)).toBe(false)
  })

  it('m6 changeSettings writes a setting row per change, each axis old → new; a widening is not applied when the ledger cannot record it, a lowering always is', () => {
    const paths = paymentPaths(fresh())
    const ledger = createLedger({ file: paths.ledger })
    const PAYEE = '0x1111111111111111111111111111111111111111'

    const raised = changeSettings(paths, ledger, readSettings(paths), {
      ...readSettings(paths),
      perDayMicros: 9_000_000,
      payees: [PAYEE]
    })

    expect(raised).toMatchObject({ ok: true, diff: { widens: true } })
    expect(readSettings(paths).perDayMicros).toBe(9_000_000)
    expect(ledger.read().records.map(row => [row.kind, row.note])).toEqual([
      ['setting', 'perDayMicros 5000000→9000000 (widens); payees +1 -0 (widens)']
    ])

    expect(changeSettings(paths, ledger, readSettings(paths), readSettings(paths))).toMatchObject({
      ok: true,
      diff: { changes: [] }
    })
    expect(ledger.read().records).toHaveLength(1)

    // A broken ledger: the widening is refused and the file unchanged; the lowering goes through.
    fs.writeFileSync(paths.ledger, fs.readFileSync(paths.ledger, 'utf8').replace('setting', 'settinG'))
    expect(
      changeSettings(paths, ledger, readSettings(paths), { ...readSettings(paths), perTxMicros: 2_000_000 })
    ).toMatchObject({
      ok: false
    })
    expect(readSettings(paths).perTxMicros).toBe(1_000_000)
    expect(
      changeSettings(paths, ledger, readSettings(paths), { ...readSettings(paths), perTxMicros: 100_000 })
    ).toMatchObject({ ok: true })
    expect(readSettings(paths).perTxMicros).toBe(100_000)
  })

  it('m6 setStop writes stop rows; releasing the stop needs the row first (a broken ledger keeps the stop)', () => {
    const paths = paymentPaths(fresh())
    const ledger = createLedger({ file: paths.ledger })

    expect(setStop(paths, true, ledger)).toBe(true)
    expect(setStop(paths, false, ledger)).toBe(true)
    expect(isStopped(paths)).toBe(false)
    expect(ledger.read().records.map(row => [row.kind, row.note])).toEqual([
      ['stop', 'on'],
      ['stop', 'off']
    ])

    expect(setStop(paths, true, ledger)).toBe(true)
    fs.writeFileSync(paths.ledger, fs.readFileSync(paths.ledger, 'utf8').replace('"on"', '"On"'))
    expect(setStop(paths, false, ledger)).toBe(false)
    expect(isStopped(paths)).toBe(true)
  })
})

describe('K98 follow-up: the pocket is never re-keyed silently', () => {
  /** A payments root whose pocket existed: `keys/pocket.sealed` made, then state written beside it. */
  const paidProfile = () => {
    const paths = paymentPaths(fresh())
    const sealer = fakeSealer()
    const first = createPocketSigner(paths.keys, sealer)

    expect(first.status).toBe('created')

    return { paths, sealer, address: first.address }
  }

  it('K98-P: pocket.sealed removed after money moved (a signed row) ⇒ unavailable with the reason, nothing minted, signing refused', async () => {
    const { paths, sealer } = paidProfile()
    const ledger = createLedger({ file: paths.ledger })

    expect(ledger.append({ kind: 'signed', agent: 'agent-a', micros: 100_000, rule: null })).toBeTruthy()
    fs.rmSync(path.join(paths.keys, 'pocket.sealed'))

    const again = createPocketSigner(paths.keys, sealer)

    expect(again).toMatchObject({ status: 'unavailable', reason: POCKET_MISSING, address: null })
    expect(fs.existsSync(path.join(paths.keys, 'pocket.sealed'))).toBe(false)
    await expect(again.signAuthorization({} as never, {} as never)).rejects.toThrow(/unavailable/)
  })

  it('K98-P: a mandate on file is payment state too (no ledger needed)', () => {
    const { paths, sealer } = paidProfile()

    fs.mkdirSync(paths.mandates, { recursive: true })
    fs.writeFileSync(path.join(paths.mandates, `${'ab'.repeat(16)}.sdjwt`), 'x', { mode: 0o600 })
    fs.rmSync(path.join(paths.keys, 'pocket.sealed'))

    expect(createPocketSigner(paths.keys, sealer)).toMatchObject({ status: 'unavailable', reason: POCKET_MISSING })
    expect(fs.existsSync(path.join(paths.keys, 'pocket.sealed'))).toBe(false)
  })

  it.each(['mandate_issue', 'mandate_use', 'mandate_revoke'] as const)(
    'K98-P: m-r2-3 a %s ledger row alone (mandate files gone, pocket removed) ⇒ unavailable, nothing minted',
    kind => {
      const { paths, sealer } = paidProfile()
      const ledger = createLedger({ file: paths.ledger })
      const jti = 'cd'.repeat(16)

      expect(
        ledger.append(
          kind === 'mandate_revoke'
            ? { kind, mandate: jti }
            : { kind, agent: 'agent-a', mandate: jti, micros: kind === 'mandate_use' ? 10_000 : 2_000_000 }
        )
      ).toBeTruthy()
      // The mandates folder is there and empty: only the ledger's rows say a pocket existed.
      fs.mkdirSync(paths.mandates, { recursive: true })
      expect(fs.readdirSync(paths.mandates)).toEqual([])
      fs.rmSync(path.join(paths.keys, 'pocket.sealed'))

      expect(createPocketSigner(paths.keys, sealer)).toMatchObject({
        status: 'unavailable',
        reason: POCKET_MISSING,
        address: null
      })
      expect(fs.existsSync(path.join(paths.keys, 'pocket.sealed'))).toBe(false)
    }
  )

  it('K98-P: control — settings and stop rows alone (caps set before the Keychain was on) still let the first pocket be made', () => {
    const paths = paymentPaths(fresh())
    const ledger = createLedger({ file: paths.ledger })

    expect(
      changeSettings(paths, ledger, readSettings(paths), { ...readSettings(paths), perTxMicros: 500_000 }).ok
    ).toBe(true)
    expect(setStop(paths, true, ledger)).toBe(true)
    expect(createPocketSigner(paths.keys, fakeSealer()).status).toBe('created')
  })

  it('K98-P: control — an existing pocket with payment state reads back sealed, same address', () => {
    const { paths, sealer, address } = paidProfile()

    createLedger({ file: paths.ledger }).append({ kind: 'settled', agent: 'agent-a', micros: 100_000, rule: null })
    expect(createPocketSigner(paths.keys, sealer)).toMatchObject({ status: 'sealed', address })
  })
})
