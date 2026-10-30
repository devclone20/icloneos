// Planted-marker fixtures (hit) and placeholders (no hit) through the real scan, on a packed-like tree. The owner's
// own literals never appear here: fixture tokens stand in for them through compileMarkers().
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { deflateRawSync, gzipSync } from 'node:zlib'
import { describe, test } from 'vitest'

import { BIP39_ENGLISH } from './artifact-hygiene-bip39.mjs'
import {
  blankCodeSignature,
  compileMarkers,
  decodeEscapes,
  foldSplits,
  isGenericFolderName,
  LAYOUT_FOLDERS,
  looksLikeSeedPhrase,
  machineCheckouts,
  machineLayoutChildren,
  machineLayoutNames,
  machineLayoutShapes,
  scanArtifact,
  scanBuffer,
  scanDistribution,
  scanTree
} from './artifact-hygiene.mjs'
import { ALLOW, BIP39_LENGTHS, MARKERS_FILE, PUBLIC_PHRASES, SHAPES, serviceJwt } from './artifact-hygiene-markers.mjs'
import { loadPrivateMarkers } from './private-markers.mjs'

// Ruling 48: a test never reads the owner's private markers file, whatever the shell exports.
delete process.env.ICLONE_PRIVATE_MARKERS

const require = createRequire(import.meta.url)
const SCRIPT = path.join(import.meta.dirname, 'artifact-hygiene.mjs')
const digest = text => createHash('sha256').update(text).digest('hex')
const OWNER = 'zqfixture'
const WALLET = `0x${'ab12'.repeat(10)}`
const MARKER_INPUT = {
  privateTokens: [
    { id: 'owner.user-name', len: OWNER.length, prefix: true, sha256: digest(OWNER) },
    { id: 'owner.wallet-1', len: WALLET.length, prefix: false, sha256: digest(WALLET) }
  ]
}
const MARKERS = compileMarkers(MARKER_INPUT)
// Assembled at run time so no key-shaped literal sits in the repo.
const FAKE = {
  anthropic: ['sk', 'ant', 'api03', 'Q'.repeat(24)].join('-'),
  openai: `sk-${'Z9'.repeat(20)}`,
  github: `ghp_${'R7'.repeat(18)}`
}
// A made-up phrase with a valid BIP-39 checksum, not in PUBLIC_PHRASES: it stands for a leaked one.
const PHRASE = 'zoo wagon abandon kitten river ladder ozone mango velvet bridge cactus able'
// @scure/bip39's README example: public, allowed only inside node_modules.
const PUBLIC_PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const ids = (text, markers = MARKERS) => scanBuffer(Buffer.from(text), new Map(), markers).sort()

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-test-'))
}

function write(root, rel, body) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), body)
}

// Writes an asar (the pickle header and the file bytes @electron/asar reads) in one synchronous write, so the whole
// fixture is on disk when the scan opens it. asar's own createPackage* is not used: it resolves on the read side's
// 'end' and returns out.end() without awaiting the write stream (@electron/asar 3.4.1 lib/disk.js,
// writeFileListToStream), so under full-suite load the last sorted file was still in the stream's buffer when the
// scan read the archive and its two owner.user-name hits vanished (K46). `entries` maps a path to its bytes; an
// entry marked unpacked is listed in the header only, as electron-builder lists app.asar.unpacked files. The
// production reader then proves it lists every path, and the file is as long as its header promises.
function packAsar(dest, entries) {
  const asar = require('@electron/asar')
  const root = { files: {} }
  const chunks = []
  const paths = new Set()
  let offset = 0

  for (const [name, entry] of Object.entries(entries)) {
    const parts = name.split('/')
    let node = root

    for (const [depth, dir] of parts.slice(0, -1).entries()) {
      node.files[dir] ??= { files: {} }
      node = node.files[dir]
      paths.add(parts.slice(0, depth + 1).join('/'))
    }

    paths.add(name)

    if (entry.unpacked) {
      node.files[parts.at(-1)] = { size: entry.data.length, unpacked: true }
      continue
    }

    const body = Buffer.from(entry.data ?? entry)
    node.files[parts.at(-1)] = { size: body.length, offset: String(offset) }
    chunks.push(body)
    offset += body.length
  }

  const json = Buffer.from(JSON.stringify(root))
  const padded = Math.ceil(json.length / 4) * 4
  const header = Buffer.alloc(8 + padded)
  header.writeUInt32LE(4 + padded, 0)
  header.writeUInt32LE(json.length, 4)
  json.copy(header, 8)
  const size = Buffer.alloc(8)
  size.writeUInt32LE(4, 0)
  size.writeUInt32LE(header.length, 4)
  fs.writeFileSync(dest, Buffer.concat([size, header, ...chunks]))

  // The reader caches a header per path for the life of the process: read the archive just written, not the last one.
  asar.uncache(dest)
  const listed = asar.listPackage(dest, { isPack: false }).map(entry => path.relative('/', entry))
  assert.deepEqual(listed.sort(), [...paths].sort(), 'the production reader lists every path of the fixture')
  assert.equal(fs.statSync(dest).size, 16 + padded + offset, 'the archive on disk is as long as its header promises')
}

describe('artifact-hygiene markers', () => {
  test('every planted marker hits', () => {
    assert.deepEqual(ids(`const home = "/Users/${OWNER}4826051/Desktop"`), ['owner.user-name'])
    assert.deepEqual(ids(`mail ${OWNER}20@example.test`), ['owner.user-name'])
    assert.deepEqual(ids(`to: "${WALLET.toUpperCase().replace('0X', '0x')}"`), ['owner.wallet-1'])
    assert.deepEqual(ids(`k="${FAKE.anthropic}"`), ['key.anthropic'])
    assert.deepEqual(ids(`k="${FAKE.openai}"`), ['key.openai'])
    assert.deepEqual(ids(`k="${FAKE.github}"`), ['key.github'])
    assert.deepEqual(ids('profile inft-4dfb27-0042'), ['usage.inft-slug'])
    assert.deepEqual(ids('log at RESUME/run.nosync/logs/x'), ['lab.run-nosync'])
    assert.deepEqual(ids('HERMES_HOME=/tmp/devdata2/home'), ['lab.devdata'])
    assert.deepEqual(ids('security unlock-keychain iclone-release.keychain-db'), ['lab.release-keychain'])
    assert.deepEqual(ids(`seed = "${PHRASE}"`), ['secret.bip39-phrase'])
  })

  test('placeholders, prose, sorted keyword lists and look-alikes do not hit', () => {
    const clean = [
      'Paste your key (sk-ant-...) here',
      'ANTHROPIC_API_KEY=sk-ant-api03-<your key>',
      'OPENAI_API_KEY=sk-... or sk-proj-xxxx',
      'GITHUB_TOKEN=ghp_xxxxxxxx',
      `wallet ${WALLET.slice(0, 40)}`,
      'zqfixtur is not the owner',
      '"call catch check clear getcall getreply halt raise receive reply send trigger"',
      'Your agent runs on your own machine and keeps its memory in a folder you choose today',
      'task-runner devdatabase inft-4dfb28-x'
    ]

    for (const text of clean) {
      assert.deepEqual(ids(text), [], text)
    }

    assert.equal(looksLikeSeedPhrase(PHRASE.split(' ').slice(0, 11)), false)
    assert.equal(looksLikeSeedPhrase(PHRASE.split(' ')), true)
    // Every word listed but the checksum is wrong / a word is not in the list / the words are in wordlist order.
    assert.equal(looksLikeSeedPhrase(PHRASE.replace(/able$/, 'about').split(' ')), false)
    assert.equal(looksLikeSeedPhrase(PHRASE.replace(/^zoo/, 'zebedeus').split(' ')), false)
    assert.equal(
      looksLikeSeedPhrase(
        'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ')
      ),
      false
    )
  })

  test('ruling 48: no owner marker is committed; without the private file a scan that is not a release loads none', () => {
    const none = compileMarkers({ ...loadPrivateMarkers({ env: {} }), privateTokens: [], privateIds: [] })

    assert.equal(none.byDigest.size, 0)
    assert.deepEqual(loadPrivateMarkers({ env: {} }), { tokens: [], ids: [], names: [], source: null })
    assert.deepEqual(scanBuffer(Buffer.from(`/Users/${OWNER}/x`), new Map(), none), [], 'fixture markers only')
    assert.throws(() => compileMarkers({ release: true, privateTokens: undefined }), /fails closed/)
  })

  test('a Mach-O code signature is blanked; the same bytes outside it still hit', () => {
    const mach = Buffer.alloc(256)
    mach.writeUInt32LE(0xfeedfacf, 0)
    mach.writeUInt32LE(1, 16)
    mach.writeUInt32LE(0x1d, 32)
    mach.writeUInt32LE(16, 36)
    mach.writeUInt32LE(128, 40)
    mach.writeUInt32LE(64, 44)
    mach.write(`CN=${OWNER} Developer ID`, 140, 'latin1')

    assert.deepEqual(scanBuffer(mach, new Map(), MARKERS), [])
    assert.equal(
      blankCodeSignature(Buffer.from(mach))
        .subarray(128, 192)
        .every(b => b === 0),
      true
    )

    mach.write(`/Users/${OWNER}/build`, 64, 'latin1')
    assert.deepEqual(scanBuffer(mach, new Map(), MARKERS), ['owner.user-name'])

    const fat = Buffer.alloc(8 + 20 + 256)
    fat.writeUInt32BE(0xcafebabe, 0)
    fat.writeUInt32BE(1, 4)
    fat.writeUInt32BE(28, 16)
    fat.writeUInt32BE(256, 20)
    Buffer.from(mach).copy(fat, 28)
    fat.fill(0, 28 + 64, 28 + 128)
    assert.deepEqual(scanBuffer(fat, new Map(), MARKERS), [])
  })
})

describe('artifact-hygiene on a packed-like tree', () => {
  test('finds markers inside app.asar, app.asar.unpacked and loose files; skips the marker list itself', () => {
    const root = tmp()

    try {
      const res = path.join(root, 'linux-unpacked', 'resources')
      const native = Buffer.from(`\0\0${WALLET}\0`, 'latin1')
      fs.mkdirSync(res, { recursive: true })
      packAsar(path.join(res, 'app.asar'), {
        'dist/main.js': 'console.log("hello")\n',
        'dist/assets/settings.js': `const k = "${FAKE.anthropic}"\n`,
        'node_modules/pty/lib/index.js': `// built in /Users/${OWNER}/work\n`,
        'node_modules/pty/build/pty.node': { data: native, unpacked: true }
      })
      write(res, 'app.asar.unpacked/node_modules/pty/build/pty.node', native)
      write(res, 'hermes-skill/README.md', 'Paste sk-ant-... into Settings\n')
      // A byte-identical copy of the real marker list is the one file skipped (it matches its own regex sources).
      write(res, `legal/${MARKERS_FILE}`, fs.readFileSync(path.join(import.meta.dirname, MARKERS_FILE)))

      const hits = scanTree(path.join(root, 'linux-unpacked'), { markers: MARKERS })
      const found = hits.map(hit => `${hit.file}:${hit.id}`).sort()

      assert.deepEqual(found, [
        'resources/app.asar.unpacked/node_modules/pty/build/pty.node:owner.wallet-1',
        'resources/app.asar/dist/assets/settings.js:key.anthropic',
        'resources/app.asar/node_modules/pty/lib/index.js:owner.user-name',
        'resources/app.asar:key.anthropic',
        'resources/app.asar:owner.user-name'
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('a clean tree scans clean; a missing tree is a hit, not a pass', () => {
    const root = tmp()

    try {
      write(root, 'index.html', '<title>icloneOS</title>')
      write(root, 'assets/app.js', 'const placeholder = "sk-ant-..."')
      assert.deepEqual(scanTree(root, { markers: MARKERS }), [])
      assert.deepEqual(
        scanTree(path.join(root, 'nope')).map(hit => hit.id),
        ['scan.missing']
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('a DMG is mounted read-only, scanned and detached; a failed attach is a hit', () => {
    const root = tmp()

    try {
      const dmg = path.join(root, '01-macOS-DMG', 'iclone-os.dmg')
      write(root, '01-macOS-DMG/iclone-os.dmg', 'not really a dmg')
      write(root, '02-Chrome-App/sw.js', `const t = "${FAKE.github}"`)
      const calls = []
      const run = (cmd, args) => {
        calls.push([cmd, args[0]])

        if (args[0] === 'attach') {
          const mount = args[args.indexOf('-mountpoint') + 1]
          write(mount, 'iclone os.app/Contents/Resources/runtime.json', `{"by":"${OWNER}"}`)
        }

        return { status: 0, stdout: '', stderr: '' }
      }

      const hits = scanDistribution(root, { run, markers: MARKERS }).map(hit => `${hit.file}:${hit.id}`)

      assert.deepEqual(hits.sort(), [
        '01-macOS-DMG/iclone-os.dmg/iclone os.app/Contents/Resources/runtime.json:owner.user-name',
        '02-Chrome-App/sw.js:key.github'
      ])
      assert.deepEqual(calls, [
        ['hdiutil', 'attach'],
        ['hdiutil', 'detach']
      ])

      const failed = scanArtifact(dmg, { run: () => ({ status: 1, stdout: '', stderr: 'no mount' }) })
      assert.match(failed[0].id, /^scan\.unpack-failed/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('the CLI exits 1 on a hit and 0 on a clean tree', () => {
    const root = tmp()

    try {
      write(root, 'clean/index.html', '<p>sk-ant-...</p>')
      write(root, 'dirty/config.json', `{"token":"${FAKE.github}"}`)
      const clean = spawnSync(process.execPath, [SCRIPT, path.join(root, 'clean')], { encoding: 'utf8' })
      const dirty = spawnSync(process.execPath, [SCRIPT, path.join(root, 'dirty')], { encoding: 'utf8' })

      assert.equal(clean.status, 0, clean.stderr)
      assert.equal(dirty.status, 1)
      assert.match(dirty.stderr, /config\.json: key\.github/)
      assert.ok(!dirty.stderr.includes(FAKE.github), 'a hit names the marker, never the secret')
      assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

// Minimal zip writer (local headers + central directory) so the scan's own reader is tested without a zip tool.
function zip(entries) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const { name, data, method = 8 } of entries) {
    const body = method === 8 ? deflateRawSync(data) : data
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, Buffer.from(name), body)
    centrals.push(central, Buffer.from(name))
    offset += 30 + name.length + body.length
  }

  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, directory, end])
}

function tar(entries) {
  const blocks = []

  for (const { name, data } of entries) {
    const header = Buffer.alloc(512)
    header.write(name, 0)
    header.write(data.length.toString(8).padStart(11, '0'), 124)
    header.write('ustar', 257)
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }

  return Buffer.concat([...blocks, Buffer.alloc(1024)])
}

describe('artifact-hygiene hostile encodings and containers', () => {
  const leak = `home=/Users/${OWNER}/Library`
  const scan = buf => scanBuffer(buf, new Map(), MARKERS)

  test('UTF-16 text (LE and BE, either byte parity) is decoded', () => {
    const be = Buffer.from(leak, 'utf16le').swap16()
    assert.deepEqual(scan(Buffer.from(leak, 'utf16le')), ['owner.user-name'])
    assert.deepEqual(scan(be), ['owner.user-name'])
    assert.deepEqual(scan(Buffer.concat([Buffer.from([0x7f]), Buffer.from(leak, 'utf16le')])), ['owner.user-name'])
    assert.deepEqual(scan(Buffer.from('plain words only', 'utf16le')), [])
  })

  test('gzip, tar, zip and an archive nested in an archive are opened member by member', () => {
    const inner = tar([{ data: Buffer.from(leak), name: 'pkg/config.txt' }])
    assert.deepEqual(scan(gzipSync(Buffer.from(leak))), ['owner.user-name'])
    assert.deepEqual(scan(inner), ['owner.user-name'])
    assert.deepEqual(scan(gzipSync(inner)), ['owner.user-name'])
    assert.deepEqual(scan(zip([{ data: Buffer.from(leak), name: 'a.txt' }])), ['owner.user-name'])
    assert.deepEqual(scan(zip([{ data: Buffer.from(leak), method: 0, name: 'a.txt' }])), ['owner.user-name'])
    assert.deepEqual(scan(zip([{ data: gzipSync(inner), name: 'deep.tgz' }])), ['owner.user-name'])
    assert.deepEqual(scan(tar([{ data: Buffer.from('x'), name: `Users/${OWNER}/x` }])), ['owner.user-name'])
    assert.deepEqual(scan(gzipSync(tar([{ data: Buffer.from('clean'), name: 'a' }]))), [])
  })

  test('formats the scan cannot open, a corrupt archive and a too-deep nesting are hits, never a pass', () => {
    const xz = Buffer.concat([Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), Buffer.alloc(64)])
    assert.deepEqual(scan(xz), ['scan.opaque-archive (xz)'])
    assert.match(
      scan(Buffer.concat([gzipSync(Buffer.from(leak)).subarray(0, 20), Buffer.alloc(8)]))[0],
      /^scan\.archive-unreadable/
    )
    let nested = Buffer.from('clean')
    for (let i = 0; i < 6; i += 1) {
      nested = gzipSync(nested)
    }
    assert.deepEqual(scan(nested), ['scan.archive-depth'])
  })

  test('a pinned archive is allowed by provenance and logged; the same name with other bytes is scanned', () => {
    const pinned = gzipSync(tar([{ data: Buffer.from(leak), name: 'upstream/tests/fixture.txt' }]))
    const markers = compileMarkers({
      privateTokens: [{ id: 'owner.user-name', len: OWNER.length, prefix: true, sha256: digest(OWNER) }],
      provenance: [{ label: 'hermes-agent fixture (RUNTIME_PIN.json)', sha256: digest(pinned) }]
    })
    const root = tmp()
    const log = []
    write(root, 'resources/hermes-runtime/hermes-agent-x.tar.gz', pinned)
    assert.deepEqual(scanTree(root, { log: line => log.push(line), markers }), [])
    assert.deepEqual(log, [
      '[artifact-hygiene] allowed by provenance: resources/hermes-runtime/hermes-agent-x.tar.gz = hermes-agent fixture (RUNTIME_PIN.json)'
    ])
    write(
      root,
      'resources/hermes-runtime/hermes-agent-x.tar.gz',
      gzipSync(tar([{ data: Buffer.from(leak), name: 'b' }]))
    )
    assert.deepEqual(
      scanTree(root, { log: () => {}, markers }).map(hit => hit.id),
      ['owner.user-name']
    )
    assert.deepEqual(compileMarkers({ provenance: [] }).provenance.size, 0)
    assert.equal(compileMarkers().provenance.size, 1, 'the default markers carry the RUNTIME_PIN tarball sha256')
  })

  test('a wallet without 0x, zero-padded inside an ABI word or calldata, is a hit', () => {
    const body = WALLET.slice(2)
    assert.deepEqual(scan(Buffer.from(`topic 000000000000000000000000${body}`)), ['owner.wallet-1'])
    assert.deepEqual(scan(Buffer.from(`data 0xa9059cbb000000000000000000000000${body.toUpperCase()}00ff`)), [
      'owner.wallet-1'
    ])
    assert.deepEqual(scan(Buffer.from(`almost ${body.slice(0, 39)}0`)), [])
  })

  test('a seed phrase as a JSON array, one word per line, in Title Case or inside prose is a hit', () => {
    const words = PHRASE.split(' ')
    for (const text of [
      JSON.stringify({ mnemonic: words }),
      JSON.stringify(words, null, 2),
      `${words.join('\n')}\n`,
      `${words.join('\r\n')}\r\n`,
      `"${words.map(w => w[0].toUpperCase() + w.slice(1)).join(' ')}"`,
      `// restore with ${PHRASE} and keep it`
    ]) {
      assert.deepEqual(scan(Buffer.from(text)), ['secret.bip39-phrase'], text.slice(0, 60))
    }
  })

  test('the reviewed public phrases and the ALLOW rules are digests and path-scoped id rules only', () => {
    assert.ok(PUBLIC_PHRASES.length >= 1)
    for (const phrase of PUBLIC_PHRASES) {
      assert.match(phrase, /^[0-9a-f]{64}$/)
    }
    for (const rule of ALLOW) {
      assert.ok(
        rule.path instanceof RegExp && /^(owner\.first-name|secret\.bip39-public-example)$/.test(rule.id),
        rule.id
      )
    }
    assert.deepEqual(scan(Buffer.from(`m = "${PUBLIC_PHRASE}"`)), ['secret.bip39-public-example'])
    const root = tmp()
    write(root, 'acp-cli/runtime/node_modules/@scure/bip39/index.js', `// ${PUBLIC_PHRASE}`)
    write(root, 'app/main.js', `const m = "${PUBLIC_PHRASE}"`)
    assert.deepEqual(scanTree(root, { log: () => {}, markers: compileMarkers({ ...MARKER_INPUT, allow: ALLOW }) }), [
      { file: 'app/main.js', id: 'secret.bip39-public-example' }
    ])
    assert.ok(!ALLOW.some(rule => /inft|usage|wallet|user-name|alias/.test(rule.id)), 'usage markers are never allowed')
  })
})

// The marker module is one instance per process, imported by the release scripts, make-distribution and their
// tests alike: nothing a caller does to a table or to a compiled set may change another caller's scan.
describe('artifact-hygiene K46: no state shared between importers', () => {
  test('the exported tables are frozen, rows included: a write throws instead of changing every scan', () => {
    for (const table of [SHAPES, PUBLIC_PHRASES, ALLOW, BIP39_LENGTHS, BIP39_ENGLISH]) {
      assert.ok(Object.isFrozen(table))
      assert.throws(() => table.push('x'), TypeError)
      assert.throws(() => table.splice(0, 1), TypeError)
    }

    for (const row of [...SHAPES, ...ALLOW]) {
      assert.ok(Object.isFrozen(row), row.id)
    }

    assert.throws(() => {
      SHAPES[0].re = /x/g
    }, TypeError)
  })

  test('every compiled set is its own: emptying one leaves the default scan and the tables untouched', () => {
    const own = compileMarkers()
    const other = compileMarkers()

    assert.notEqual(own.byDigest, other.byDigest)
    assert.notEqual(own.shapes[0].re, other.shapes[0].re)
    assert.ok(
      own.shapes
        .slice(0, SHAPES.length)
        .every((shape, i) => shape.re !== SHAPES[i].re && shape.re.source === SHAPES[i].re.source)
    )

    own.shapes.length = 0
    own.byDigest.clear()
    own.exactLens.clear()
    own.prefixLens.length = 0
    own.allow.length = 0
    own.provenance.clear()

    assert.deepEqual(scanBuffer(Buffer.from(`k="${FAKE.anthropic}"`)), ['key.anthropic'])
    assert.deepEqual(scanBuffer(Buffer.from(`k="${FAKE.anthropic}"`), new Map(), other), ['key.anthropic'])
    assert.deepEqual(ids(`/Users/${OWNER}/x`), ['owner.user-name'])
    assert.equal(SHAPES.length, other.shapes.filter(shape => shape.id !== 'owner.layout').length)
    assert.ok(ALLOW.length > 0 && compileMarkers().allow.length === ALLOW.length)
  })

  test('a scan leaves the exported shape regexes where they were: lastIndex 0 on every one', () => {
    const text = `${FAKE.anthropic} ${FAKE.openai} ${FAKE.github} did:privy:cm0fixture0abcdefghijklmn`

    assert.deepEqual(scanBuffer(Buffer.from(text)).sort(), [
      'id.privy-did',
      'key.anthropic',
      'key.github',
      'key.openai'
    ])
    assert.deepEqual(ids(text).sort(), ['id.privy-did', 'key.anthropic', 'key.github', 'key.openai'])
    assert.deepEqual(
      SHAPES.map(shape => shape.re.lastIndex),
      SHAPES.map(() => 0)
    )
  })

  test('an archive rebuilt at the same path is read from disk, not from the reader cache of the first scan', () => {
    const root = tmp()

    try {
      const archive = path.join(root, 'app.asar')
      packAsar(archive, { 'a/one.txt': 'nothing inside\n' })
      assert.deepEqual(scanTree(root, { markers: MARKERS }), [])
      packAsar(archive, { 'b/two.txt': `home=/Users/${OWNER}\n`, 'b/three.txt': 'x'.repeat(100) })
      assert.deepEqual(
        scanTree(root, { markers: MARKERS })
          .map(hit => `${hit.file}:${hit.id}`)
          .sort(),
        ['app.asar/b/two.txt:owner.user-name', 'app.asar:owner.user-name']
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('artifact-hygiene r6: escapes, numbered phrases, names, links, id classes, squashfs', () => {
  const owner = ['owner.user-name']
  const wallet = ['owner.wallet-1']

  test('a marker behind an escape, a percent-encoding or a character reference is a hit', () => {
    assert.equal(decodeEscapes('a\\nb%2Fc\\u002Fd\\x2Fe&#47;f&#x2F;g%252Fh'), 'a\nb/c/d/e/f/g/h')
    for (const text of [
      `const by = "built\\n${OWNER}4826051"`,
      `const by = "built\\t${OWNER}"`,
      `file:%2FUsers%2F${OWNER}4826051%2Fapp`,
      `file:%252FUsers%252F${OWNER}%252Fapp`,
      `{"p":"\\u002FUsers\\u002F${OWNER}\\u002Fx"}`,
      `"\\x2FUsers\\x2F${OWNER}\\x2Fx"`,
      `<a href="&#47;Users&#47;${OWNER}">`
    ]) {
      assert.deepEqual(ids(text), owner, text)
    }
    assert.deepEqual(ids(`"owner:\\n${WALLET}"`), wallet)
    assert.deepEqual(ids(`"to%3A${WALLET}"`), wallet)
    assert.deepEqual(ids('const nl = "\\n" + "%20" + "\\u0041lpha"'), [], 'escapes alone are not hits')
  })

  test('a seed phrase written as a numbered list or a JSON string with escaped line breaks is a hit', () => {
    const words = PHRASE.split(' ')
    for (const text of [
      words.map((w, i) => `${i + 1}. ${w}`).join('\n'),
      words.map((w, i) => `${i + 1}) ${w}`).join(' '),
      JSON.stringify({ mnemonic: words.join('\n') }),
      `"${words.join('\\r\\n')}"`
    ]) {
      assert.deepEqual(ids(text), ['secret.bip39-phrase'], text.slice(0, 50))
    }
    const prose = Array.from({ length: 12 }, (_, i) => `${i + 1}. step`).join('\n')
    assert.deepEqual(ids(prose), [])
  })

  test('file and directory names and symlink targets are scanned; links are never followed', () => {
    const root = tmp()
    try {
      write(root, `Resources/${OWNER}-notes.txt`, 'nothing inside\n')
      write(root, `Resources/cache%2F${OWNER}/a.txt`, 'nothing inside\n')
      fs.mkdirSync(path.join(root, 'Resources', 'links'), { recursive: true })
      fs.symlinkSync(`/Users/${OWNER}/Library/x`, path.join(root, 'Resources', 'links', 'home'))
      fs.symlinkSync('../Resources', path.join(root, 'Resources', 'links', 'relative'))
      const found = scanTree(root, { markers: MARKERS, log: () => {} }).map(hit => `${hit.file}:${hit.id}`)
      assert.deepEqual(found.sort(), [
        `Resources/cache%2F${OWNER}/a.txt:owner.user-name`,
        `Resources/cache%2F${OWNER}:owner.user-name`,
        'Resources/links/home -> link:owner.user-name',
        `Resources/${OWNER}-notes.txt:owner.user-name`
      ])
      assert.deepEqual(scanTree(root, { markers: MARKERS }).length, 4, 'the scanned root path itself is the caller’s')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('only a byte-identical copy of the marker list is skipped, never a file that borrows its name', () => {
    const root = tmp()
    try {
      write(root, `a/${MARKERS_FILE}`, fs.readFileSync(path.join(import.meta.dirname, MARKERS_FILE)))
      write(root, `b/${MARKERS_FILE}`, `export const home = "/Users/${OWNER}"\n`)
      packAsar(path.join(root, 'app.asar'), {
        [`legal/${MARKERS_FILE}`]: `export const home = "/Users/${OWNER}"\n`,
        [`docs/${OWNER}.md`]: 'x\n'
      })
      const found = scanTree(root, { markers: MARKERS }).map(hit => `${hit.file}:${hit.id}`)
      assert.deepEqual(found.sort(), [
        'app.asar/docs/zqfixture.md:owner.user-name',
        `app.asar/legal/${MARKERS_FILE}:owner.user-name`,
        'app.asar:owner.user-name',
        `b/${MARKERS_FILE}:owner.user-name`
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('the distribution folder scan also reads artifact names', () => {
    const root = tmp()
    try {
      write(root, `03-Linux-Ubuntu/${OWNER}-build.txt`, 'clean\n')
      assert.deepEqual(scanDistribution(root, { markers: MARKERS }), [
        { file: `03-Linux-Ubuntu/${OWNER}-build.txt`, id: 'owner.user-name' }
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('Privy DIDs, Virtuals and AgentCard keys/tokens and service JWTs hit; placeholders and public ids do not', () => {
    const real = text => scanBuffer(Buffer.from(text)).sort()
    const jwt = payload =>
      [
        'eyJhbGciOiJFUzI1NiJ9',
        Buffer.from(JSON.stringify(payload)).toString('base64url'),
        'c2lnbmF0dXJlLWZpeHR1cmUtMDE'
      ].join('.')
    const hex32 = '0123456789abcdef'.repeat(2)
    assert.deepEqual(real('user did:privy:cm0fixture0abcdefghijklmn ok'), ['id.privy-did'])
    assert.deepEqual(real(`GAME_KEY=${['apt', hex32].join('-')}`), ['key.virtuals-game'])
    assert.deepEqual(real('VIRTUALS_API_KEY=Zk3q9vX2mL0pR7tY4wQ1nB8c'), ['key.virtuals-assigned'])
    assert.deepEqual(real('{"acpSessionToken": "s3ss10n-fixture-0000aaaa"}'), ['key.virtuals-assigned'])
    assert.deepEqual(real('AGENTCARD_API_TOKEN: "ac9fixture7token3value42"'), ['key.agentcard-assigned'])
    assert.deepEqual(real(`Authorization: Bearer ${jwt({ iss: 'privy.io', aud: 'app-fixture' })}`), [
      'token.service-jwt'
    ])
    assert.deepEqual(real(`t=${jwt({ iss: 'https://api.agentcard.ai' })}`), ['token.service-jwt'])
    for (const quiet of [
      'did:privy:... (the user DID)',
      'VIRTUALS_API_KEY=your-virtuals-api-key-here',
      'AGENTCARD_TOKEN=<paste-your-agentcard-token>',
      'const privyAppId = "cm0appfixture00000000000"',
      `t=${jwt({ iss: 'https://example.com', aud: 'demo' })}`,
      'apt-get install -y curl'
    ]) {
      assert.deepEqual(real(quiet), [], quiet)
    }
    assert.equal(serviceJwt('eyJ.not-base64.x'), false)
    assert.ok(SHAPES.some(s => s.id === 'id.privy-did') && SHAPES.some(s => /virtuals/.test(s.id)))
    assert.ok(SHAPES.some(s => /agentcard/.test(s.id)))
  })

  test('owner agent ids hit as ERC-8004 agent numbers in context and as Virtuals UUIDs, by digest only', () => {
    const uuid = '019e0000-aaaa-7bbb-8ccc-0123456789ab'
    const markers = compileMarkers({
      ...MARKER_INPUT,
      privateIds: [
        { id: 'owner.agent-id-erc8004-1', kind: 'agent-number', sha256: digest('48213') },
        { id: 'owner.agent-id-virtuals-1', kind: 'uuid', sha256: digest(uuid) }
      ]
    })
    for (const text of [
      '"agentId": 48213',
      'agent #48213',
      'agent_id=48213',
      'scan/agents/base/48213',
      'ERC-8004 id 48213'
    ]) {
      assert.deepEqual(ids(text, markers), ['owner.agent-id-erc8004-1'], text)
    }
    for (const quiet of ['port 48213', 'agentId: 482130', 'tokenId 4821']) {
      assert.deepEqual(ids(quiet, markers), [], quiet)
    }
    assert.deepEqual(ids(`acp/agents/${uuid.toUpperCase()}`, markers), ['owner.agent-id-virtuals-1'])
    assert.deepEqual(ids('019e0000-aaaa-7bbb-8ccc-0123456789ac', markers), [])
  })

  test('a squashfs image or an AppImage is an opaque hit unless its sha256 is a proved provenance', () => {
    const elf = ({ appImage = false, squash = true } = {}) => {
      const buf = Buffer.alloc(256)
      buf.writeUInt32BE(0x7f454c46, 0)
      buf[4] = 2
      buf[5] = 1
      if (appImage) {
        buf.write('AI', 8, 'latin1')
        buf[10] = 2
      }
      buf.writeBigUInt64LE(64n, 0x28)
      buf.writeUInt16LE(64, 0x3a)
      buf.writeUInt16LE(1, 0x3c)
      if (squash) {
        buf.write('hsqs', 128, 'latin1')
      }
      return buf
    }
    const raw = Buffer.concat([Buffer.from('hsqs', 'latin1'), Buffer.alloc(124)])
    for (const buf of [raw, elf(), elf({ appImage: true, squash: false })]) {
      assert.deepEqual(scanBuffer(buf, new Map(), MARKERS), ['scan.opaque-archive (squashfs)'])
    }
    assert.deepEqual(scanBuffer(elf({ squash: false }), new Map(), MARKERS), [], 'a plain ELF is scanned as bytes')
    const image = elf({ appImage: true })
    const proved = compileMarkers({
      ...MARKER_INPUT,
      provenance: [{ label: 'built from linux-unpacked', sha256: digest(image) }]
    })
    const ctx = { depth: 0, provenance: [] }
    assert.deepEqual(scanBuffer(image, new Map(), proved, ctx), [])
    assert.deepEqual(ctx.provenance, ['built from linux-unpacked'])
  })
})

describe('artifact-hygiene r7: base64 payloads, more escapes, more seed separators, cost bound', () => {
  const owner = ['owner.user-name']
  const home = `/Users/${OWNER}4826051/Desktop/app/src/x.ts`
  const b64 = text => Buffer.from(text).toString('base64')

  test('a marker or a seed phrase inside base64, base64url, data: URLs and inline source maps is a hit', () => {
    for (const text of [
      `//# sourceMappingURL=data:application/json;charset=utf-8;base64,${b64(JSON.stringify({ sources: [home] }))}`,
      `.a{background:url(data:text/plain;base64,${b64(`by ${home}`)})}`,
      JSON.stringify({ blob: b64(`owner home ${home} end`) }),
      `t=${Buffer.from(`x ${home} y`).toString('base64url')}&u=1`,
      `"${b64(JSON.stringify({ p: '\\u002FUsers\\u002F' + OWNER }))}"`
    ]) {
      assert.deepEqual(ids(text), owner, text.slice(0, 60))
    }
    assert.deepEqual(ids(`m="${b64(PHRASE)}"`), ['secret.bip39-phrase'])
    assert.deepEqual(ids(`w:${b64(`to ${WALLET}`)}`), ['owner.wallet-1'])
  })

  test('base64 of harmless text and long identifiers are not hits', () => {
    assert.deepEqual(ids(`data:application/json;base64,${b64(JSON.stringify({ sources: ['src/app.ts'] }))}`), [])
    assert.deepEqual(ids('const someVeryLongIdentifierNameHere_withSuffix = createElementForTheRenderer()'), [])
    assert.deepEqual(ids(`icon=${b64('\x89PNG\r\n\x1a\n' + '\x00'.repeat(64))}`), [])
  })

  test('octal, ES6 code point and named character references are decoded', () => {
    assert.equal(decodeEscapes('a\\057b\\u{2F}c&sol;d&period;e&foo;f\\u{110000}'), 'a/b/c/d.e&foo;f\\u{110000}')
    for (const text of [
      `"\\057Users\\057${OWNER}4826051\\057x"`,
      `"\\u{2F}Users\\u{2F}${OWNER}\\u{2F}x"`,
      `&sol;Users&sol;${OWNER}4826051&sol;x`
    ]) {
      assert.deepEqual(ids(text), owner, text)
    }
    assert.deepEqual(ids('&amp; &lt;b&gt; \\101lpha &nosuch;'), [])
  })

  test("a seed phrase joined by '-', '|' or ';' is a hit; hyphenated prose is not", () => {
    for (const sep of ['-', '|', ';', ' - ', ' | ', '; ']) {
      assert.deepEqual(ids(PHRASE.split(' ').join(sep)), ['secret.bip39-phrase'], JSON.stringify(sep))
    }
    const words = PHRASE.split(' ')
    const rows = [0, 4, 8].map(i => words.slice(i, i + 4).join(' ')).join('\n')
    assert.deepEqual(ids(rows), ['secret.bip39-phrase'], 'rows of words: any whitespace is one separator')
    assert.deepEqual(ids('state-of-the-art well-known end-to-end run-time read-only built-in ready-made'), [])
    // Identifier lists (CSS properties, grammar alternations) mix '-' with '|' or ',': never one phrase.
    const pairs = words.map((w, i) => (i % 2 ? `-${w}` : i ? `|${w}` : w)).join('')
    assert.deepEqual(ids(pairs), [], pairs)
    assert.deepEqual(ids(words.map((w, i) => `\`${w}-${words[(i + 1) % 12]}\``).join(',')), [])
  })

  test('2 MB hostile inputs stay under 1.5 s each with the real markers', () => {
    const size = 2 * 1024 * 1024
    const fill = unit => unit.repeat(Math.ceil(size / unit.length)).slice(0, size)
    const hostile = {
      'one base64 run': fill('Ab0+/_-z'),
      'short base64 runs': fill(`${'A'.repeat(24)} `),
      'base64 of a word run': b64(fill('abcdefgh ')),
      'one list word repeated': fill('abandon '),
      'dash-joined words': fill('abc-'),
      'escapes and entities': fill('&sol;&foo;\\057\\u{2F}%2F')
    }
    const real = compileMarkers()
    for (const [name, text] of Object.entries(hostile)) {
      const started = performance.now()
      scanBuffer(Buffer.from(text), new Map(), real)
      const ms = performance.now() - started
      assert.ok(ms < 1500, `${name}: ${Math.round(ms)} ms`)
    }
  }, 30_000)
})

describe('artifact-hygiene r8: grouped and grid seed phrases, bounded runs', () => {
  const words = PHRASE.split(' ')
  const groups = (n, sep) => words.reduce((out, w, i) => out + (i === 0 ? '' : i % n === 0 ? sep : ' ') + w, '')
  const b64 = text => Buffer.from(text).toString('base64')

  test('a seed phrase written in groups or in a CSV grid is a hit', () => {
    for (const text of [
      groups(3, ', '),
      groups(4, ', '),
      groups(4, '; '),
      groups(4, ' | '),
      groups(4, ' - '),
      `${words.slice(0, 6).join(',')}\n${words.slice(6).join(',')}`,
      [0, 4, 8].map(i => words.slice(i, i + 4).join(',')).join('\n'),
      [0, 4, 8].map(i => words.slice(i, i + 4).join(', ')).join(',\r\n'),
      `key: ${groups(4, ', ')}; next: 1`
    ]) {
      assert.deepEqual(ids(text), ['secret.bip39-phrase'], JSON.stringify(text))
    }
  })

  test('identifier lists that mix two punctuation kinds are never one phrase, with or without spaces', () => {
    for (const [a, b] of [
      ['-', ', '],
      ['-', ','],
      [' - ', ' | '],
      ['; ', ' | '],
      ['|', '-'],
      ['`-`', '`,`']
    ]) {
      const text = words.reduce((out, w, i) => out + (i === 0 ? '' : i % 2 ? a : b) + w, '')
      assert.deepEqual(ids(text), [], text)
    }
    // Pairs written "top-left, left-top": each pair holds '-', each join holds ','.
    assert.deepEqual(ids(words.map((w, i) => `${w}-${words[(i + 1) % 12]}`).join(', ')), [])
    // Two punctuation kinds in one run: the phrase starts after the last separator of the old kind.
    assert.deepEqual(ids(`top-left ${groups(4, ', ')}`), ['secret.bip39-phrase'])
    assert.deepEqual(ids(`${words.join(' ')}abc`), [], 'a word glued to letters is not a list word')
    assert.deepEqual(ids(`${words.join(' ')}${'q'.repeat(70)}`), [])
  })

  test('8 MB single runs (base64 and alphanumeric) never throw and finish in 3 s each', () => {
    const size = 8 * 1024 * 1024
    const noise = Buffer.alloc((size / 4) * 3)
    for (let i = 0; i < noise.length; i += 1) {
      noise[i] = (i * 2654435761) >>> 24
    }
    const alphabet = 'ghijklmnopqrstuvwxyzGHIJKLMNOPQRSTUVWXYZ0123456789abcdefABCDEF'
    const alnum = Buffer.alloc(size)
    for (let i = 0; i < size; i += 1) {
      alnum[i] = alphabet.charCodeAt(((i * 2654435761) >>> 7) % alphabet.length)
    }
    const real = compileMarkers()
    for (const [name, buf] of [
      ['base64 run', Buffer.from(noise.toString('base64'))],
      ['alphanumeric run', alnum],
      ['letter run', Buffer.alloc(size, 'q')],
      ['key prefix and a long tail', Buffer.from(`sk-ant-${'a'.repeat(size)}`)],
      ['jwt prefix and a long tail', Buffer.from(`eyJ${'A'.repeat(size)}`)]
    ]) {
      const started = performance.now()
      const hits = scanBuffer(buf, new Map(), real)
      const ms = performance.now() - started
      assert.ok(ms < 3000, `${name}: ${Math.round(ms)} ms`)
      assert.deepEqual(hits, name.startsWith('key') ? ['key.anthropic'] : [], name)
    }
  }, 60_000)

  test('markers across the piece boundaries of a long run are still found', () => {
    const home = `/Users/${OWNER}4826051/Desktop/app`
    // The base64 piece boundary (65536 chars = 49152 bytes) falls inside the home path.
    assert.deepEqual(ids(`"${b64('a'.repeat(49140) + home)}"`), ['owner.user-name'])
    // A wallet across the first 4096-char token piece of a long hex run.
    assert.deepEqual(ids(`${'0'.repeat(4076)}${WALLET.slice(2)}${'0'.repeat(100)}`), ['owner.wallet-1'])
    assert.deepEqual(ids(`${'0'.repeat(12000)}${WALLET.slice(2)}`), ['owner.wallet-1'])
  })
})

describe("K140 r2/r3: the owner's folder layout, read from the scanning machine at scan time", () => {
  /**
   * A fake home. Desktop: a generic project folder (WORKSHOP) holding the checkout two levels down, a two-word folder,
   * a delivery folder, a dot folder, a short one and a file. Developer: a worktree root. Beside the checkout: the
   * control plane's snapshots folder and a Finder copy; beside its parent: an ordinal project and a generic folder.
   */
  function fakeHome() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-home-'))
    const checkout = path.join(home, 'Desktop', 'WORKSHOP', 'Quartz', '000 - Main Line', 'app')
    for (const dir of [
      'Desktop/WORKSHOP/Quartz/000 - Main Line/app',
      'Desktop/WORKSHOP/Quartz/000 - Main Line/RUN_snapshots',
      'Desktop/WORKSHOP/Quartz/000 - Main Line/app 2',
      'Desktop/WORKSHOP/Quartz/000 - Main Line/docs',
      'Desktop/WORKSHOP/Quartz/001 - QUARTZ HARBOR',
      'Desktop/WORKSHOP/Quartz/MEDIA',
      'Desktop/WORKSHOP/VIDEO & ART',
      'Desktop/Lab Notes',
      'Desktop/ready_9',
      'Desktop/.hidden',
      'Desktop/ab',
      'Developer/proj-wt',
      'Developer/zqos-release-x',
      'Developer/v1.2.3'
    ]) {
      fs.mkdirSync(path.join(home, dir), { recursive: true })
    }
    fs.writeFileSync(path.join(home, 'Desktop', 'notes.txt'), 'x')
    return { home, checkouts: [checkout] }
  }

  const scanWith = (layout, text) =>
    scanBuffer(Buffer.from(text), new Map(), compileMarkers({ ...MARKER_INPUT, layout: machineLayoutShapes(layout) }))

  test('the names: home, Desktop and Developer folders, every level from the Desktop down to the checkout; no generic', () => {
    const layout = fakeHome()

    assert.deepEqual(
      machineLayoutNames(layout),
      [
        '000 - Main Line',
        '001 - QUARTZ HARBOR',
        'Lab Notes',
        'RUN_snapshots',
        'VIDEO & ART',
        path.basename(layout.home),
        'proj-wt',
        'ready_9',
        'zqos-release-x'
      ].sort()
    )
    assert.deepEqual(machineLayoutChildren(layout), {
      Desktop: ['Lab Notes', 'WORKSHOP', 'ready_9'],
      Developer: ['proj-wt', 'v1.2.3', 'zqos-release-x']
    })
    // Without its checkouts only the home and its two layout folders are read.
    assert.ok(!machineLayoutNames({ home: layout.home, checkouts: [] }).includes('001 - QUARTZ HARBOR'))
  })

  test('generic names: one word in any case, a Finder copy, a version, the product name plus generic words', () => {
    for (const name of [
      'HOME',
      'MEDIA',
      'docs',
      'MacMiniPRO',
      'icloneOS',
      'app 2',
      'v9.0.0.1',
      '2026-10',
      'iclone-os-nightly',
      'icloneos-preview',
      'iclone os'
    ]) {
      assert.equal(isGenericFolderName(name), true, name)
    }
    for (const name of [
      'ready_7',
      'iclone-xy',
      'Lab Notes',
      '001 - X Y',
      'icloneos-abc-public',
      'VIDEO & ART',
      'app_2'
    ]) {
      assert.equal(isGenericFolderName(name), false, name)
    }
  })

  test('a layout name is a hit at any depth and in any spelling: case, joiner, escapes, join(), concatenation, zero-width', () => {
    const layout = fakeHome()

    for (const text of [
      'E="$HOME/Desktop/WORKSHOP/engine"',
      'see `~/Desktop/WORKSHOP/`',
      'C:\\Users\\x\\Desktop\\WORKSHOP',
      '~/Library/Mobile Documents/com~apple~CloudDocs/Desktop/WORKSHOP/MEDIA',
      'git -C ~/Developer/proj-wt status',
      'cd ~/Desktop/Lab\\ Notes && ls',
      'file:///x/Desktop/Lab%20Notes/a',
      'root: x/y/001 - QUARTZ HARBOR/ENGINES',
      'Proven on Quartz Harbor (2026)',
      'quartz-harbor-block.js',
      'QuartzHarbor_{scene}',
      'QUARTZ_HARBOR',
      'join(PROJECT_DIR, "WORKSHOP", "VIDEO & ART", "pages")',
      'os.path.join(ROOT, "RUN_snapshots")',
      'Desktop.join("Lab Notes")',
      'the lab notes folder',
      'p = "VIDEO & " + "ART"',
      'p = "read" +\n  "y_9"',
      'ready\u200b_9',
      'Lab\u00adNotes',
      'ready%5F9/a',
      '"ready\\u005f9"',
      'READY_9',
      'ready-9',
      `/x/${path.basename(layout.home)}/y`
    ]) {
      assert.deepEqual(scanWith(layout, text), ['owner.layout'], text)
    }
  })

  test('other names, partial segments, generic words alone, dot folders, short names and files are not', () => {
    const layout = fakeHome()

    for (const text of [
      '~/Desktop/WORKSHOPS/x',
      '~/Desktop/my-WORKSHOP',
      'the WORKSHOP and its MEDIA',
      '~/Desktop/.hidden/x',
      '~/Desktop/ab/x',
      '~/Desktop/notes.txt',
      '~/Desktop/<your project folder>',
      'MyDesktop/WORKSHOP',
      '~/Developer/other',
      'ready_90 xready_9 ready9 ready_9x',
      'Quartz alone, a harbor, Main',
      'import { app as app2 } from "electron"',
      'v1.2.3 docs/app'
    ]) {
      assert.deepEqual(scanWith(layout, text), [], text)
    }
  })

  test('the checkouts behind a worktree and a release clone are found through git (a local remote included)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-git-'))
    const main = path.join(root, 'main')
    const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
    fs.mkdirSync(main)
    git(main, 'init', '-q')
    git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x')
    git(main, 'worktree', 'add', '-q', path.join(root, 'wt'))
    spawnSync('git', ['clone', '-q', main, path.join(root, 'clone')])
    const real = p => fs.realpathSync(p)

    assert.deepEqual(machineCheckouts(path.join(root, 'wt')).map(real), [real(main)])
    assert.deepEqual(
      machineCheckouts(path.join(root, 'clone')).map(real).sort(),
      [real(path.join(root, 'clone')), real(main)].sort()
    )
    assert.deepEqual(machineCheckouts(fs.mkdtempSync(path.join(os.tmpdir(), 'layout-nogit-'))), [])
  })

  test('foldSplits drops zero-width characters and soft hyphens (code points and UTF-8 bytes) and joins concatenated literals', () => {
    assert.equal(foldSplits('a\u200bb\u00adc\ufeffd'), 'abcd')
    assert.equal(foldSplits(Buffer.from('a\u200bb', 'utf8').toString('latin1')), 'ab')
    assert.equal(foldSplits('x = "ab" + "cd" +\n  \'ef\''), 'x = "abcdef\'')
  })

  test('a machine without those folders gets no layout shape (CI); the folders read are Desktop and Developer', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-home-'))
    // The home's own name is a layout name when it is not generic; a generic one (CI's `runner`) gives none.
    assert.deepEqual(machineLayoutShapes({ home: path.join(empty, 'runner'), checkouts: [] }), [])
    assert.deepEqual([...LAYOUT_FOLDERS], ['Desktop', 'Developer'])
    assert.deepEqual(
      machineLayoutShapes(fakeHome()).map(shape => shape.id),
      ['owner.layout']
    )
  })

  test('the layout is never written in the repo: the scanner, its markers and the port hold no layout name of this machine', () => {
    const names = machineLayoutNames()
    const sources = ['artifact-hygiene.mjs', 'artifact-hygiene-markers.mjs', 'artifact-hygiene.test.mjs'].map(file =>
      fs.readFileSync(path.join(import.meta.dirname, file), 'utf8')
    )
    const leaked = names.filter(name => sources.some(text => text.includes(name)))

    assert.equal(leaked.length, 0, `${leaked.length} layout name(s) written in the scanner`)
    assert.ok(machineLayoutShapes().length <= 1)
  })
})
