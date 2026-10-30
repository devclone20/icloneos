// Runs under `node --test` (the P7 gate) and under vitest's electron project.
import assert from 'node:assert/strict'

import {
  inspectBundle,
  installPlan,
  isDeveloperIdSigned,
  LOCAL_IDENTITY,
  needsLegacyPkcs12,
  opensslRequestArgs,
  pkcs12Args,
  requirementIsStable
} from './macos-signing.mjs'

const { describe, it } = process.env.VITEST ? await import('vitest') : await import('node:test')

describe('macos-signing — the stable local identity', () => {
  it('asks openssl for a self-signed code-signing leaf, ten years, no CA', () => {
    const args = opensslRequestArgs({ keyPath: '/w/key.pem', certPath: '/w/cert.pem' })

    assert.deepEqual(args.slice(0, 2), ['req', '-x509'])
    assert.ok(args.includes('-nodes'))
    assert.equal(args[args.indexOf('-subj') + 1], `/CN=${LOCAL_IDENTITY}/O=iCLONE`)
    assert.deepEqual(
      args.filter(arg => arg.startsWith('extendedKeyUsage=')),
      ['extendedKeyUsage=critical,codeSigning']
    )
    assert.deepEqual(
      args.filter(arg => arg.startsWith('basicConstraints=')),
      ['basicConstraints=critical,CA:FALSE']
    )
    assert.equal(args[args.indexOf('-days') + 1], '3650')
  })

  it('exports PKCS#12 in the legacy ciphers macOS imports, only under OpenSSL 3', () => {
    assert.equal(needsLegacyPkcs12('OpenSSL 3.6.3 9 Jun 2026'), true)
    assert.equal(needsLegacyPkcs12('LibreSSL 3.3.6'), false)
    assert.equal(needsLegacyPkcs12(undefined), false)

    const legacy = pkcs12Args({ keyPath: 'k', certPath: 'c', p12Path: 'p', password: 'pw', legacy: true })
    const modern = pkcs12Args({ keyPath: 'k', certPath: 'c', p12Path: 'p', password: 'pw', legacy: false })

    assert.ok(legacy.includes('-legacy'))
    assert.ok(!modern.includes('-legacy'))
    assert.equal(legacy[legacy.indexOf('-passout') + 1], 'pass:pw')
    assert.equal(legacy[legacy.indexOf('-name') + 1], LOCAL_IDENTITY)
  })

  it('recognises a certificate-anchored requirement and rejects an ad-hoc hash', () => {
    assert.equal(
      requirementIsStable(
        'identifier "io.cloneframe.icloneos" and certificate root = H"0123456789abcdef0123456789abcdef01234567"'
      ),
      true
    )
    assert.equal(requirementIsStable('cdhash H"f739e149990050ea5326f2ce371a1fa2f9f61048"'), false)
    assert.equal(requirementIsStable(''), false)
  })
})

describe('macos-signing — install:mac never re-signs a Developer ID bundle (decision 14)', () => {
  const devId =
    'Executable=/x\nAuthority=Developer ID Application: Owner Name (ABCDE12345)\nAuthority=Developer ID Certification Authority\n'
  const local = `Authority=${LOCAL_IDENTITY}\n`

  it('recognises only a Developer ID Application leaf', () => {
    assert.equal(isDeveloperIdSigned(devId), true)
    assert.equal(isDeveloperIdSigned(local), false)
    assert.equal(isDeveloperIdSigned('Authority=Apple Development: Owner Name (ABCDE12345)\n'), false)
    assert.equal(isDeveloperIdSigned('Signature=adhoc\n'), false)
  })

  it('copies + verifies a stapled Developer ID bundle, refuses an unstapled one, signs a local build as before', () => {
    assert.deepEqual(installPlan({ codesignDetails: devId, stapled: true }), { action: 'copy-verify' })
    assert.equal(installPlan({ codesignDetails: devId, stapled: false }).action, 'refuse')
    assert.deepEqual(installPlan({ codesignDetails: local, stapled: false }), { action: 'sign-local' })
    assert.deepEqual(installPlan({ codesignDetails: 'code object is not signed at all', stapled: false }), {
      action: 'sign-local'
    })
  })

  it('asks the stapler only about a Developer ID bundle', () => {
    const calls = []
    const fake = stdout => (command, args) => {
      calls.push(`${command} ${args[0]}`)

      return command === 'codesign' ? { status: 0, stdout: '', stderr: stdout } : { status: 0, stdout: '', stderr: '' }
    }

    assert.deepEqual(inspectBundle('/b.app', fake(local)), { codesignDetails: `\n${local}`, stapled: false })
    assert.deepEqual(calls, ['codesign -dvv'])
    assert.equal(inspectBundle('/b.app', fake(devId)).stapled, true)
    assert.deepEqual(calls.slice(1), ['codesign -dvv', 'xcrun stapler'])
  })
})
