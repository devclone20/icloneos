import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { RUNTIME_PIN } from './runtime-pin.generated'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// The generator is plain JS without a declaration file; a non-literal specifier keeps tsc from
// resolving it, and this interface is the contract the test relies on.
interface RuntimePinGenerator {
  renderRuntimePin: (pin: unknown) => string
}

const PIN_GENERATOR = pathToFileURL(path.join(ROOT, 'iclone/contract/gen-types.mjs')).href

const loadPinGenerator = (): Promise<RuntimePinGenerator> => import(PIN_GENERATOR)

describe('the bundled runtime pin (R1.pin.split)', () => {
  it('runtime-pin.generated.ts is exactly what gen-types.mjs renders from iclone/RUNTIME_PIN.json', async () => {
    const { renderRuntimePin } = await loadPinGenerator()
    expect(renderRuntimePin(read('iclone/RUNTIME_PIN.json'))).toBe(
      read('apps/desktop/electron/runtime-pin.generated.ts')
    )
  })

  it('pins the rev the contract lock is verified against, not the source import base', () => {
    const json = JSON.parse(read('iclone/RUNTIME_PIN.json'))
    const lock = JSON.parse(read('iclone/contract/runtime.lock.json'))

    const base = read('iclone/UPSTREAM_BASE')
      .split('\n')
      .find(line => /^[0-9a-f]{40}\s*$/.test(line))
      ?.trim()

    expect(RUNTIME_PIN.sha).toBe(json.sha)
    expect(RUNTIME_PIN.sha).toBe(lock.verifiedAgainst.rev)
    expect(RUNTIME_PIN.tarballSha256).toBe(json.tarball_sha256)
    // V3-RT: the runtime is built from this repository (K153); the upstream it tracks is 1ac3f97 (V3-UP), whose
    // installer it ships unchanged.
    expect(RUNTIME_PIN.source).toBe('repo')
    expect(RUNTIME_PIN.upstream).toBe('1ac3f97fbe0958aa2743c0c26202b20b3b4e760e')
    expect(RUNTIME_PIN.manifestSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(RUNTIME_PIN.files).toBe(json.files)
    expect(RUNTIME_PIN.installShSha256).toBe('14b4c89518cf0e4e71841708dd5d8a28f1f494d22cd20e12f4d5eeb29c7d2fdb')
    expect(base).toBe('10b388300a63d83857fac3ca4f8b05b64e01bc50')
    expect(base).not.toBe(RUNTIME_PIN.sha)
  })

  it('the generator refuses a malformed pin', async () => {
    const { renderRuntimePin } = await loadPinGenerator()
    const good = JSON.parse(read('iclone/RUNTIME_PIN.json'))
    expect(() => renderRuntimePin({ ...good, sha: 'main' })).toThrow(/bad sha/)
    expect(() => renderRuntimePin({ ...good, install_sh_sha256: undefined })).toThrow(/install_sh_sha256/)
    expect(() => renderRuntimePin({ ...good, min_app: 'next' })).toThrow(/min_app/)
    expect(() => renderRuntimePin({ ...good, manifest_sha256: 'x' })).toThrow(/manifest_sha256/)
    expect(() => renderRuntimePin({ ...good, upstream: undefined })).toThrow(/upstream/)
  })
})
