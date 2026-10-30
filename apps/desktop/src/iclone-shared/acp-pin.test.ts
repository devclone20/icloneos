import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  ACP_CLI_NAME,
  installsFile,
  parsePin,
  PinError,
  registryUrl,
  resolveFrom,
  rowRunsOn,
  runtimeClosure
} from './acp-pin'

const LOCK_DIR = path.join(__dirname, '..', '..', 'acp-cli-lock')
const PKG = readFileSync(path.join(LOCK_DIR, 'package.json'), 'utf8')
const LOCK = readFileSync(path.join(LOCK_DIR, 'package-lock.json'), 'utf8')
const SHA = `sha512-${'A'.repeat(86)}==`

type Rows = Record<string, Record<string, unknown>>

function pinOf(rows: Rows, version = '1.0.0') {
  const packages = {
    '': { name: 'stage', version: '0.0.0', dependencies: { [ACP_CLI_NAME]: version } },
    [`node_modules/${ACP_CLI_NAME}`]: {
      version,
      resolved: registryUrl(ACP_CLI_NAME, version),
      integrity: SHA,
      dependencies: Object.fromEntries(
        Object.keys(rows)
          .filter(key => !key.slice('node_modules/'.length).includes('node_modules/'))
          .map(key => [key.slice('node_modules/'.length), '*'])
      )
    },
    ...rows
  }

  return {
    pkg: JSON.stringify({ dependencies: { [ACP_CLI_NAME]: version } }),
    lock: JSON.stringify({ lockfileVersion: 3, packages })
  }
}

const row = (name: string, version = '1.0.0', extra: Record<string, unknown> = {}) => ({
  version,
  resolved: registryUrl(name, version),
  integrity: SHA,
  license: 'MIT',
  ...extra
})

describe('parsePin — the committed pin', () => {
  it('reads the committed lockfile: one CLI version everywhere, every row a registry tarball with sha512', () => {
    const pin = parsePin(PKG, LOCK)

    expect(pin.cliVersion).toBe('1.0.38')
    expect(pin.rows.size).toBeGreaterThan(400)
  })

  it('on darwin-arm64 the closure is exactly the 346 package dirs REL-4 staged with npm ci + prune', () => {
    const rows = runtimeClosure(parsePin(PKG, LOCK), { platform: 'darwin', arch: 'arm64' })

    expect(rows).toHaveLength(346)
    expect(rows.some(r => r.name === 'tsup' || r.name === 'typescript' || r.name.startsWith('@types/'))).toBe(false)
    expect(rows.some(r => r.name === '@napi-rs/keyring-darwin-arm64')).toBe(true)
    expect(rows.some(r => r.name === '@napi-rs/keyring-linux-x64-gnu')).toBe(false)
  })
})

describe('parsePin — refusals', () => {
  it.each([
    ['another host', row('a', '1.0.0', { resolved: 'https://evil.example/a/-/a-1.0.0.tgz' }), /does not resolve/],
    ['another package', row('a', '1.0.0', { resolved: registryUrl('b', '1.0.0') }), /does not resolve/],
    ['a sha1 integrity', row('a', '1.0.0', { integrity: 'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=' }), /sha512/],
    ['no integrity', row('a', '1.0.0', { integrity: undefined }), /sha512/],
    ['a range version', row('a', '^1.0.0'), /exact version/],
    ['a link', { link: true, resolved: '../a' }, /link/],
    ['an alias', row('a', '1.0.0', { name: 'b' }), /alias/]
  ])('refuses %s', (_name, raw, problem) => {
    const { pkg, lock } = pinOf({ 'node_modules/a': raw as Record<string, unknown> })

    expect(() => parsePin(pkg, lock)).toThrow(problem)
  })

  it('refuses a key that is not a plain node_modules path', () => {
    for (const key of ['node_modules/../x', '/abs/node_modules/a', 'node_modules/a/../../b', 'lib/a']) {
      const { pkg, lock } = pinOf({ [key]: row('a') })

      expect(() => parsePin(pkg, lock)).toThrow(PinError)
    }
  })

  it('refuses a CLI version that differs between package.json and the lockfile', () => {
    const { lock } = pinOf({})

    expect(() => parsePin(JSON.stringify({ dependencies: { [ACP_CLI_NAME]: '9.9.9' } }), lock)).toThrow(/alike/)
  })
})

describe('runtimeClosure and resolveFrom — Node lookup over lockfile keys', () => {
  it('resolves nested first, then each ancestor, then the top', () => {
    const { pkg, lock } = pinOf({
      'node_modules/a': row('a', '1.0.0', { dependencies: { c: '*' } }),
      'node_modules/a/node_modules/c': row('c', '2.0.0'),
      'node_modules/c': row('c', '1.0.0')
    })

    const pin = parsePin(pkg, lock)

    expect(resolveFrom(pin.rows, 'node_modules/a', 'c')).toBe('node_modules/a/node_modules/c')
    expect(resolveFrom(pin.rows, `node_modules/${ACP_CLI_NAME}`, 'c')).toBe('node_modules/c')
    expect(resolveFrom(pin.rows, 'node_modules/a', 'missing')).toBeNull()
  })

  it('leaves out other platforms’ optional rows and refuses a required one', () => {
    const optional = pinOf({ 'node_modules/n': row('n', '1.0.0', { optional: true, os: ['linux'], cpu: ['x64'] }) })

    expect(runtimeClosure(parsePin(optional.pkg, optional.lock), { platform: 'darwin', arch: 'arm64' })).toHaveLength(1)

    const required = pinOf({ 'node_modules/n': row('n', '1.0.0', { os: ['linux'] }) })

    expect(() => runtimeClosure(parsePin(required.pkg, required.lock), { platform: 'darwin', arch: 'arm64' })).toThrow(
      /does not run on darwin-arm64/
    )
  })

  it('reads npm’s negated os/cpu lists', () => {
    const { pkg, lock } = pinOf({ 'node_modules/n': row('n', '1.0.0', { os: ['!win32'] }) })
    const n = parsePin(pkg, lock).rows.get('node_modules/n')!

    expect(rowRunsOn(n, { platform: 'darwin', arch: 'arm64' })).toBe(true)
    expect(rowRunsOn(n, { platform: 'win32', arch: 'x64' })).toBe(false)
  })
})

describe('installsFile — the same prune the shipped tree had', () => {
  const mac = { platform: 'darwin', arch: 'arm64' }
  const cli = { name: ACP_CLI_NAME }
  const dep = { name: 'ws' }

  it('keeps code, licences and the CLI’s own data; drops docs, maps, types, tests and other platforms', () => {
    expect(installsFile(dep, 'lib/index.js', mac)).toBe(true)
    expect(installsFile(dep, 'LICENSE', mac)).toBe(true)
    expect(installsFile(dep, 'docs/LICENSE.md', mac)).toBe(false)
    expect(installsFile(dep, 'README.md', mac)).toBe(false)
    expect(installsFile(dep, 'lib/index.js.map', mac)).toBe(false)
    expect(installsFile(dep, 'lib/index.d.ts', mac)).toBe(false)
    expect(installsFile(dep, 'test/a.js', mac)).toBe(false)
    expect(installsFile(dep, '.npmignore', mac)).toBe(false)
    expect(installsFile(dep, 'prebuilds/darwin-x64+arm64/x.node', mac)).toBe(true)
    expect(installsFile(dep, 'prebuilds/linux-x64/x.node', mac)).toBe(false)
    expect(installsFile(cli, 'SKILL.md', mac)).toBe(true)
    expect(installsFile(cli, 'docs/a.md', mac)).toBe(true)
    expect(installsFile(cli, 'bin/acp-cli-signer-macos', mac)).toBe(true)
    expect(installsFile(cli, 'bin/acp-cli-signer-linux', mac)).toBe(false)
    expect(installsFile(cli, 'bin/acp-cli-signer-linux', { platform: 'linux', arch: 'x64' })).toBe(true)
  })
})
