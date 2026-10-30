import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, test } from 'vitest'

import { PUBLIC_PHRASES } from './artifact-hygiene-markers.mjs'
import { compileMarkers, scanBuffer } from './artifact-hygiene.mjs'
import {
  ciSecretJson,
  DERIVED_IDS,
  leadingLetters,
  keyWords,
  loadPrivateMarkers,
  machineMarkerRows,
  nameRows,
  MIN_FILE_ROWS,
  parsePrivateMarkers,
  PRIVATE_MARKERS_ENV
} from './private-markers.mjs'

// Ruling 48: a test never reads the owner's private markers file, whatever the shell exports.
delete process.env.ICLONE_PRIVATE_MARKERS

const sha = text => createHash('sha256').update(text).digest('hex')
// Synthetic identity (never the owner's): a home folder, a login, a global git e-mail and name.
const HOME = '/Users/quillmoth42'
const USER = 'quillmoth42'
const GIT = { 'user.email': 'lanternfox7@example.test', 'user.name': 'Corvina Example' }
const run = (_cmd, args) => GIT[args[2]] ?? ''
const machine = () => machineMarkerRows({ home: HOME, user: USER, run })
const WALLET = `0x${'cd34'.repeat(10)}`
const temps = []

function markersFile(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-'))
  const file = path.join(dir, 'markers.json')

  temps.push(dir)
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))

  return file
}

const FILE_BODY = {
  version: 1,
  derive: true,
  tokens: [{ id: 'owner.wallet-1', len: WALLET.length, prefix: false, sha256: sha(WALLET) }],
  ids: [{ id: 'owner.agent-id-virtuals-1', kind: 'uuid', sha256: sha('019e0000-aaaa-7bbb-8ccc-0123456789ab') }],
  // r5e (X1): a synthetic series name and delivery-folder word (never the owner's).
  names: [
    { kind: 'series', sha256: sha('lark harbor') },
    { kind: 'delivery', sha256: sha('drop') },
    // r5f (X2): the owner identity setting, as a synthetic name.
    { kind: 'identity', sha256: sha('corvina example') }
  ]
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('ruling 48: the owner markers are read at scan time, never committed', () => {
  test('the machine states three identity rows from the home folder, the login and the global git identity', () => {
    const rows = machine()

    assert.deepEqual(
      rows.map(row => row.id),
      ['owner.user-name', 'owner.alias', 'owner.first-name']
    )
    assert.deepEqual(
      rows.map(row => row.sha256),
      [sha('quillmoth'), sha('lanternfox'), sha('corvina')]
    )
    assert.deepEqual(
      rows.map(row => [row.prefix, row.len]),
      [
        [true, leadingLetters(USER).length],
        [true, 10],
        [true, 7]
      ]
    )
    // Too short to be a marker (fewer than 4 letters) states nothing.
    assert.deepEqual(machineMarkerRows({ home: '/Users/ab1', user: 'ab1', run: () => '' }), [])
  })

  test('a release scan fails closed: no env, a missing file, a malformed file, an incomplete machine', () => {
    assert.throws(() => loadPrivateMarkers({ env: {}, release: true }), /fails closed: .*is not set/)
    assert.throws(
      () => loadPrivateMarkers({ env: { [PRIVATE_MARKERS_ENV]: '/nonexistent/x.json' }, release: true }),
      /fails closed: .*names a missing file/
    )
    assert.throws(
      () => loadPrivateMarkers({ env: { [PRIVATE_MARKERS_ENV]: markersFile('{nope') }, release: true }),
      /fails closed: the private markers file is not JSON/
    )
    assert.throws(
      () =>
        loadPrivateMarkers({
          env: { [PRIVATE_MARKERS_ENV]: markersFile({ ...FILE_BODY, tokens: [{ id: 'x', len: 1, sha256: 'z' }] }) },
          release: true
        }),
      /fails closed: .*token row 0 is malformed/
    )
    // Each field is checked on its own: a bad id alone, a bad length alone, a bad digest alone.
    for (const bad of [
      { id: 'wallet-1', len: 42, sha256: sha(WALLET) },
      { id: 'owner.wallet-1', len: 0, sha256: sha(WALLET) },
      { id: 'owner.wallet-1', len: 42, sha256: 'z'.repeat(64) },
      { id: 'owner.wallet-1', len: 42, prefix: 'yes', sha256: sha(WALLET) }
    ]) {
      assert.throws(
        () => parsePrivateMarkers(JSON.stringify({ ...FILE_BODY, tokens: [bad] })),
        /token row 0 is malformed/
      )
    }
    for (const bad of [
      { id: 'agent', kind: 'uuid', sha256: sha('x') },
      { id: 'owner.agent-1', kind: 'name', sha256: sha('x') },
      { id: 'owner.agent-1', kind: 'uuid', sha256: 'x' }
    ]) {
      assert.throws(() => parsePrivateMarkers(JSON.stringify({ ...FILE_BODY, ids: [bad] })), /id row 0 is malformed/)
    }
    const partial = () => machine().filter(row => row.id !== 'owner.alias')

    assert.throws(
      () =>
        loadPrivateMarkers({ env: { [PRIVATE_MARKERS_ENV]: markersFile(FILE_BODY) }, release: true, machine: partial }),
      /fails closed: this machine cannot state owner\.alias/
    )
    // A file that derives nothing must carry the identity rows itself.
    assert.throws(
      () =>
        loadPrivateMarkers({
          env: { [PRIVATE_MARKERS_ENV]: markersFile({ ...FILE_BODY, derive: false }) },
          release: true,
          machine
        }),
      /fails closed: the private markers lack owner\.user-name, owner\.alias, owner\.first-name/
    )
    // The message never carries the path or a value.
    try {
      loadPrivateMarkers({ env: { [PRIVATE_MARKERS_ENV]: '/nonexistent/secret-place.json' }, release: true })
    } catch (error) {
      assert.ok(!error.message.includes('secret-place'))
    }
  })

  test('a release scan with the file and the machine loads both; the markers hit what they name', () => {
    const loaded = loadPrivateMarkers({
      env: { [PRIVATE_MARKERS_ENV]: markersFile(FILE_BODY) },
      release: true,
      machine
    })

    assert.equal(loaded.source, 'file+machine')
    assert.deepEqual(
      loaded.tokens.map(row => row.id),
      [...DERIVED_IDS, 'owner.wallet-1']
    )
    assert.ok(Object.isFrozen(loaded.tokens) && loaded.tokens.every(row => Object.isFrozen(row)))
    const markers = compileMarkers({ privateTokens: loaded.tokens, privateIds: loaded.ids, layout: [] })
    const ids = text => [...new Set(scanBuffer(Buffer.from(text), new Map(), markers))].sort()

    assert.deepEqual(ids(`/Users/${USER}/Desktop`), ['owner.user-name'])
    assert.deepEqual(ids('mail lanternfox7@example.test'), ['owner.alias'])
    assert.deepEqual(ids(`pay ${WALLET}`), ['owner.wallet-1'])
    assert.deepEqual(ids('a corvina-shaped word: corvinas'), ['owner.first-name'])
  })

  test('compileMarkers in release mode loads the file named by the environment and scans with it', () => {
    const json = JSON.parse(ciSecretJson({ env: { [PRIVATE_MARKERS_ENV]: markersFile(FILE_BODY) }, machine }))

    process.env[PRIVATE_MARKERS_ENV] = markersFile(json)
    try {
      const markers = compileMarkers({ release: true, layout: [] })

      assert.equal(markers.privateSource, 'file')
      // r5e X1: the names come with the loaded markers.
      assert.ok(markers.ownerNames.series.has(sha('lark harbor')) && markers.ownerNames.delivery.has(sha('drop')))
      assert.deepEqual(scanBuffer(Buffer.from(`/Users/${USER}/x`), new Map(), markers), ['owner.user-name'])
      assert.deepEqual(scanBuffer(Buffer.from(`pay ${WALLET}`), new Map(), markers), ['owner.wallet-1'])
    } finally {
      delete process.env[PRIVATE_MARKERS_ENV]
    }
  })

  test('the CI secret is self-contained: derive false, the machine rows written as digests', () => {
    const json = JSON.parse(ciSecretJson({ env: { [PRIVATE_MARKERS_ENV]: markersFile(FILE_BODY) }, machine }))

    assert.equal(json.derive, false)
    const file = markersFile(json)
    const onRunner = loadPrivateMarkers({ env: { [PRIVATE_MARKERS_ENV]: file }, release: true, machine: () => [] })

    assert.equal(onRunner.source, 'file')
    assert.deepEqual(onRunner.tokens.map(row => row.id).sort(), [...DERIVED_IDS, 'owner.wallet-1'].sort())
    assert.deepEqual(parsePrivateMarkers(JSON.stringify(json)).ids, json.ids)
  })

  test('a scan that is not a release runs without the file and says so; the CLI in release mode exits 2', () => {
    assert.deepEqual(loadPrivateMarkers({ env: {} }), { tokens: [], ids: [], names: [], source: null })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-cli-'))

    temps.push(dir)
    fs.writeFileSync(path.join(dir, 'a.txt'), 'clean\n')
    const env = { ...process.env }

    delete env[PRIVATE_MARKERS_ENV]
    const script = path.join(import.meta.dirname, 'artifact-hygiene.mjs')
    const release = spawnSync(process.execPath, [script, '--release', dir], { env, encoding: 'utf8' })

    assert.equal(release.status, 2)
    assert.match(release.stderr, /the release scan fails closed/)
    const plain = spawnSync(process.execPath, [script, dir], { env, encoding: 'utf8' })

    assert.equal(plain.status, 0)
    assert.match(plain.stderr, /owner-identity markers are not checked/)
  })
})

describe('r5c: the critic rows m1, m2, m4', () => {
  test('a home folder named apart from the login gives two user-name rows; a value that starts with digits gives none', () => {
    const rows = machineMarkerRows({ home: '/Users/quillmoth42', user: 'tarnwick', run })
    const users = rows.filter(row => row.id === 'owner.user-name')

    assert.deepEqual(
      users.map(row => row.sha256),
      [sha('quillmoth'), sha('tarnwick')]
    )
    assert.equal(rows.length, 4)
    assert.equal(leadingLetters('42quillmoth'), '')
    assert.deepEqual(machineMarkerRows({ home: '/Users/42quillmoth', user: '7tarnwick', run: () => '' }), [])
  })

  test('a token row without prefix is exact; a malformed file throws outside a release too', () => {
    const exact = parsePrivateMarkers(
      JSON.stringify({ ...FILE_BODY, tokens: [{ id: 'owner.wallet-1', len: WALLET.length, sha256: sha(WALLET) }] })
    )

    assert.equal(exact.tokens[0].prefix, false)
    assert.throws(
      () => loadPrivateMarkers({ env: { [PRIVATE_MARKERS_ENV]: markersFile('{nope') } }),
      /the private markers file is not JSON/
    )
  })

  test('m1: a valid but hollow file fails a release closed; the message gives counts only', () => {
    const identityOnly = JSON.parse(ciSecretJson({ env: { [PRIVATE_MARKERS_ENV]: markersFile(FILE_BODY) }, machine }))

    identityOnly.tokens = identityOnly.tokens.filter(row => DERIVED_IDS.includes(row.id))
    identityOnly.ids = []
    for (const body of [
      { version: 1, derive: true, tokens: [], ids: [] },
      { ...FILE_BODY, ids: [] },
      { ...FILE_BODY, tokens: [] },
      identityOnly
    ]) {
      assert.throws(
        () => loadPrivateMarkers({ env: { [PRIVATE_MARKERS_ENV]: markersFile(body) }, release: true, machine }),
        /fails closed: the private markers file holds \d+ token row\(s\) beyond identity and \d+ id row\(s\); a release expects at least 1 and 1/
      )
    }
    assert.equal(MIN_FILE_ROWS.tokens, 1)
    assert.equal(MIN_FILE_ROWS.ids, 1)
  })

  test('r5d n2: identity rows and one id row, with no token row of the file own, fail a release closed', () => {
    const identity = JSON.parse(ciSecretJson({ env: { [PRIVATE_MARKERS_ENV]: markersFile(FILE_BODY) }, machine }))
    const body = { ...identity, tokens: identity.tokens.filter(row => DERIVED_IDS.includes(row.id)) }

    assert.equal(body.tokens.length, DERIVED_IDS.length)
    assert.equal(body.ids.length, 1)
    for (const derive of [false, true]) {
      assert.throws(
        () =>
          loadPrivateMarkers({
            env: { [PRIVATE_MARKERS_ENV]: markersFile({ ...body, derive }) },
            release: true,
            machine
          }),
        /fails closed: the private markers file holds 0 token row\(s\) beyond identity and 1 id row\(s\)/
      )
    }
  })

  test('r5d n3: a FIFO in place of the file fails closed at once, without a read, a hang or its path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-fifo-'))
    const fifo = path.join(dir, 'markers.json')

    temps.push(dir)
    execFileSync('mkfifo', [fifo])
    // In a child with a deadline: a read of a FIFO without a writer blocks the whole process, so the proof that it is
    // never read must not be able to hang this worker.
    const loader = path.join(import.meta.dirname, 'private-markers.mjs')

    for (const release of [true, false]) {
      const script = `import { loadPrivateMarkers } from ${JSON.stringify(loader)}
try { loadPrivateMarkers({ release: ${release}, machine: () => [] }); console.log('loaded') } catch (e) { console.log(e.message) }`
      const started = Date.now()
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, [PRIVATE_MARKERS_ENV]: fifo },
        encoding: 'utf8',
        timeout: 5000
      })

      assert.equal(child.signal, null, 'the loader returned before its deadline')
      assert.ok(Date.now() - started < 5000)
      assert.match(child.stdout, /the private markers file cannot be read/)
      assert.ok(!child.stdout.includes(dir))
    }
    const env = { ...process.env, [PRIVATE_MARKERS_ENV]: fifo }
    const out = spawnSync(
      process.execPath,
      [path.join(import.meta.dirname, 'artifact-hygiene.mjs'), '--release', dir],
      {
        env,
        encoding: 'utf8',
        timeout: 10_000
      }
    )

    assert.equal(out.status, 2)
    assert.match(out.stderr, /fails closed: the private markers file cannot be read/)
    assert.ok(!out.stderr.includes(dir))
  })

  test('m2: an unreadable file or a folder fails closed without naming its path', () => {
    const file = markersFile(FILE_BODY)
    const folder = path.dirname(file)

    fs.chmodSync(file, 0o000)
    try {
      for (const target of [file, folder]) {
        for (const release of [true, false]) {
          assert.throws(
            () => loadPrivateMarkers({ env: { [PRIVATE_MARKERS_ENV]: target }, release, machine }),
            error => {
              assert.match(error.message, /the private markers file cannot be read/)
              assert.ok(!error.message.includes(folder) && !error.message.includes('pm-'), 'no path in the message')

              return true
            }
          )
        }
      }
    } finally {
      fs.chmodSync(file, 0o600)
    }
  })
})

describe('r5e X1: the owner series and delivery names ride in the private file', () => {
  test('names are validated, loaded, carried into the CI secret, and a release needs at least one', () => {
    const loaded = loadPrivateMarkers({
      env: { [PRIVATE_MARKERS_ENV]: markersFile(FILE_BODY) },
      release: true,
      machine
    })

    assert.deepEqual(loaded.names, FILE_BODY.names)
    assert.ok(Object.isFrozen(loaded.names))
    assert.deepEqual(
      JSON.parse(ciSecretJson({ env: { [PRIVATE_MARKERS_ENV]: markersFile(FILE_BODY) }, machine })).names,
      FILE_BODY.names
    )
    for (const bad of [
      { kind: 'film', sha256: sha('x') },
      { kind: 'series', sha256: 'x' }
    ]) {
      assert.throws(
        () => parsePrivateMarkers(JSON.stringify({ ...FILE_BODY, names: [bad] })),
        /name row 0 is malformed/
      )
    }
    assert.throws(() => parsePrivateMarkers(JSON.stringify({ ...FILE_BODY, names: {} })), /names is not a list/)
    assert.throws(
      () =>
        loadPrivateMarkers({
          env: { [PRIVATE_MARKERS_ENV]: markersFile({ ...FILE_BODY, names: [] }) },
          release: true,
          machine
        }),
      /fails closed: the private markers file holds 0 name row\(s\); a release expects at least 1/
    )
    // Outside a release a file without names still loads (nothing to look for).
    assert.deepEqual(
      loadPrivateMarkers({ env: { [PRIVATE_MARKERS_ENV]: markersFile({ ...FILE_BODY, names: undefined }) }, machine })
        .names,
      []
    )
    assert.equal(MIN_FILE_ROWS.names, 1)
  })
})

describe('r5f: name rows (short forms, glued) and the owner identity floor', () => {
  test('keyWords reads a name as the text matcher does; nameRows gives a series its leading runs, spaced and glued', () => {
    assert.deepEqual(keyWords('Lark-Harbor_Kiln v2'), ['lark', 'harbor', 'kiln', 'v', '2'])
    assert.deepEqual(keyWords('LarkHARBOR Café'), ['lark', 'harbor', 'cafe'])
    const digests = rows => rows.map(row => row.sha256).sort()

    assert.deepEqual(
      digests(nameRows('series', 'Lark Harbor Kiln')),
      ['lark harbor', 'larkharbor', 'lark harbor kiln', 'larkharborkiln'].map(sha).sort()
    )
    assert.deepEqual(digests(nameRows('series', 'Kilnhouse')), [sha('kilnhouse')])
    assert.deepEqual(digests(nameRows('delivery', 'Drop')), [sha('drop')])
    assert.deepEqual(
      digests(nameRows('identity', 'Corvina Example')),
      [sha('corvina example'), sha('corvinaexample')].sort()
    )
    assert.ok(nameRows('series', 'Lark Harbor').every(row => row.kind === 'series' && Object.isFrozen(row)))
    assert.throws(() => nameRows('film', 'x'), /unknown name kind/)
  })

  test('X2: a release without identity rows (the owner identity setting) fails closed; outside a release it loads', () => {
    const body = { ...FILE_BODY, names: FILE_BODY.names.filter(row => row.kind !== 'identity') }

    assert.throws(
      () => loadPrivateMarkers({ env: { [PRIVATE_MARKERS_ENV]: markersFile(body) }, release: true, machine }),
      /fails closed: the private markers file holds 0 identity row\(s\): the owner identity is not set/
    )
    assert.equal(loadPrivateMarkers({ env: { [PRIVATE_MARKERS_ENV]: markersFile(body) }, machine }).names.length, 2)
    assert.equal(MIN_FILE_ROWS.identity, 1)
  })

  test('name-rows reads the names from an environment variable and prints digests only', () => {
    const out = spawnSync(
      process.execPath,
      [path.join(import.meta.dirname, 'private-markers.mjs'), 'name-rows', 'series', '--env', 'R5F_NAMES'],
      { env: { ...process.env, R5F_NAMES: 'Lark Harbor Kiln, Kilnhouse' }, encoding: 'utf8' }
    )

    assert.equal(out.status, 0)
    assert.ok(!/lark|kiln/i.test(out.stdout))
    assert.deepEqual(
      JSON.parse(out.stdout)
        .map(row => row.sha256)
        .sort(),
      ['lark harbor', 'larkharbor', 'lark harbor kiln', 'larkharborkiln', 'kilnhouse'].map(sha).sort()
    )
  })
})

describe('ruling 48: every release path scans in release mode', () => {
  test('release-mac scans with --release; the Linux workflow feeds the secret before its release scan', () => {
    const mac = fs.readFileSync(path.join(import.meta.dirname, 'release-mac.mjs'), 'utf8')

    assert.equal((mac.match(/'scripts\/artifact-hygiene\.mjs',\s*'--release',\s*appPath\s*\]/g) ?? []).length, 2)
    const workflow = fs.readFileSync(
      path.resolve(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'release-linux.yml'),
      'utf8'
    )
    const secret = workflow.indexOf('${{ secrets.ICLONE_PRIVATE_MARKERS_JSON }}')
    const exported = workflow.indexOf('ICLONE_PRIVATE_MARKERS=$RUNNER_TEMP/private-markers.json" >> "$GITHUB_ENV"')
    const scan = workflow.indexOf('run: node apps/desktop/scripts/release-linux.mjs --arch "$ARCH"')

    assert.ok(secret > 0 && exported > secret && scan > exported)
  })
})

// r5c m5 / r5d n1: one tree-wide guard for the realistic accident shapes (deliberate evasion is out of scope). Text is
// folded first (a digest split across concatenated literals, a line continuation or a joined array of pieces is one
// digest again; any case). Red: an owner.* id within 300 characters of a digest (a JS or JSON row, nested or not, a
// YAML row, a markdown table row, a Python dict(...)); a digest used as a key with a value (`'<hex>': 'plan'`, a YAML
// `<hex>: plan`); an object with a digest and a label/place-like key; a binding whose name has a label, place, private,
// owner or layout word, in any case (`LABELS`, `privateLabels`, `place_digests`), whose own value holds a digest.
const HEX = '[0-9a-fA-F]{64}'
const HEX_RE = new RegExp(`(?<![0-9a-fA-F])${HEX}(?![0-9a-fA-F])`)
const HEX_ALL = new RegExp(HEX_RE.source, 'g')
const TABLE_WORD_RE = /^(?:labels?|places?|private|owner|layout|names)$/
// A label/place key counts only when its value is a list or a two-word lowercase string (a name), never a product label
// such as a release asset's `label: 'macOS arm64 DMG'` or a count (`places: 3`).
const LABEL_KEY_RE =
  /(?:^|[\s,{(])['"]?(?:labels?|words|places?|folders?|projects?|series|layout|private)['"]?\s*[:=]/gi
const LABEL_VALUE_RE = /^\s*(?:\[|['"`][a-z]+[ _-][a-z]+['"`])/
// r5f m5: a one-word label (`'Harbor'`) is a name too, unless the object is a release asset (file, size, name, url).
const ONE_WORD_LABEL_RE = /^\s*['"`][A-Za-z][\w-]*['"`]/
const RELEASE_ASSET_KEY_RE = /(?:^|[\s,{])['"]?(?:file|size|name|url|content_type|browser_download_url)\b/
// r5f M2: a names row of the private file (a series, delivery or identity digest).
const NAMES_ROW_RE = /\bkind['"]?\s*[:=]\s*['"]?(?:series|delivery|identity)\b/i
// r5e m2: a quoted YAML digest key with a bare value (`"<hex>": plan`) too.
const DIGEST_KEY_RE = new RegExp(
  `['"\`]${HEX}['"\`]\\s*:\\s*['"\`\\[]|^\\s*['"]?${HEX}['"]?\\s*:\\s*[A-Za-z'"\\[]`,
  'm'
)
// The value of a binding ends at a blank line, the next key or binding, or a semicolon.
// r5e m1: also at the next declaration (prettier, no semicolons: `const owner = …` then `const sha = …`).
const VALUE_END_RE =
  /\n\s*\n|\n\s*[A-Za-z_$][\w$]*\s*[:=](?!=)|\n\s*(?:export\s+)?(?:const|let|var|function|class)\b|,\s*[A-Za-z_$][\w$]*\s*:(?!=)|;/
// A wallet test vector (`privateKey = '0x<64 hex>'`) is one key, not a table of private names.
const KEY_VECTOR_RE = new RegExp(`^\\s*['"\`]0x${HEX}['"\`]\\s*,?\\s*$`)

function foldDigests(text) {
  return text
    .replace(/\\\r?\n/g, '')
    .replace(/(['"`])\s*\+\s*(['"`])/g, '')
    .replace(
      /\[((?:\s*(['"`])[0-9a-fA-F]+\2\s*,)+\s*(['"`])[0-9a-fA-F]+\3\s*,?\s*)\]\s*\.join\(\s*(['"`])\4\s*\)/g,
      (_match, inner) => `'${inner.replace(/[^0-9a-fA-F]/g, '')}'`
    )
}

function bracketed(text, start) {
  const open = text.slice(start).match(/^\s*(?:(?:Object\.freeze|new\s+(?:Map|Set))\(\s*)?([[{])/)

  if (!open) {
    return null
  }

  let depth = 0

  for (let i = start + open[0].length - 1; i < Math.min(text.length, start + 4000); i += 1) {
    if (text[i] === '[' || text[i] === '{') {
      depth += 1
    } else if (text[i] === ']' || text[i] === '}') {
      depth -= 1

      if (depth === 0) {
        return text.slice(start, i + 1)
      }
    }
  }

  return text.slice(start, start + 4000)
}

function digestTableFindings(text) {
  const folded = foldDigests(text)
  const found = new Set()

  if (!HEX_RE.test(folded)) {
    return []
  }

  for (const match of folded.matchAll(HEX_ALL)) {
    const near = folded.slice(Math.max(0, match.index - 300), match.index + 364)

    // r5e m1: `repo.owner.login` is a member chain, not an owner id.
    if (/(?<![A-Za-z0-9_.])owner\.[a-z0-9]/i.test(near)) {
      found.add('owner-row')
    }

    if (NAMES_ROW_RE.test(near)) {
      found.add('names-row')
    }
  }

  if (DIGEST_KEY_RE.test(folded)) {
    found.add('digest-to-label')
  }

  for (const [object] of folded.matchAll(/\{[^{}]*\}/g)) {
    if (
      HEX_RE.test(object) &&
      [...object.matchAll(LABEL_KEY_RE)].some(key => {
        const value = object.slice(key.index + key[0].length)

        return LABEL_VALUE_RE.test(value) || (ONE_WORD_LABEL_RE.test(value) && !RELEASE_ASSET_KEY_RE.test(object))
      })
    ) {
      found.add('label-row')
    }
  }

  for (const binding of folded.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=|:)(?!=)/g)) {
    const words = binding[1]
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[\s_$]+/)

    if (!words.some(word => TABLE_WORD_RE.test(word))) {
      continue
    }

    const start = binding.index + binding[0].length
    // r5f m5: an object or array value runs to its closing bracket (its keys on their own lines are inside it).
    const value = bracketed(folded, start) ?? folded.slice(start, start + 400).split(VALUE_END_RE)[0]

    if (words.join(' ') === 'private key' && KEY_VECTOR_RE.test(value.split('\n')[0])) {
      continue
    }

    if (HEX_RE.test(value)) {
      found.add('named-table')
      break
    }
  }

  return [...found]
}

describe('ruling 48 guard: no digest table of private markers anywhere in the tree', () => {
  // Built at run time: no 64-hex literal sits in this file, so the tree scan reads it like any other.
  const W = 'a1b2c3d4'.repeat(8)

  test("the critic's probes C19–C22 and the r4 shapes are red; checksums and pins are not", () => {
    for (const [text, kind] of [
      [`const T = { '${W}': ['plan', 'full'] }`, 'digest-to-label'],
      [`export const X = [{ id: 'owner.alias', len: 12, prefix: true, sha256: '${W.toUpperCase()}' }]`, 'owner-row'],
      [`{ id: 'owner.alias', len: 12, sha256: '${W.slice(0, 30)}' +\n  '${W.slice(30)}' }`, 'owner-row'],
      [`{ id: 'owner.alias', sha256: ['${W.slice(0, 20)}', '${W.slice(20)}'].join('') }`, 'owner-row'],
      [`{ id: 'owner.alias', sha256: "${W.slice(0, 32)}\\\n${W.slice(32)}" }`, 'owner-row'],
      [`const LABELS = Object.freeze([\n  '${W}'\n])`, 'named-table'],
      [`rows.push({ words: ['quartz', 'harbor'], sha256: '${W}' })`, 'label-row'],
      [`const PLACE_DIGESTS = new Map([['${W}', 'X']])`, 'named-table'],
      // r5d n1: the critic's six realistic accident shapes.
      [`export const R = [{ id: 'owner.alias', meta: { v: 1 }, sha256: '${W}' }]`, 'owner-row'],
      [`const T = { '${W}': 'plan' }`, 'digest-to-label'],
      [`- id: owner.alias\n  len: 12\n  sha256: ${W}\n`, 'owner-row'],
      [`| id | len | sha256 |\n|---|---|---|\n| owner.alias | 12 | ${W} |\n`, 'owner-row'],
      [`const privateLabels = ['${W}']`, 'named-table'],
      [`ROWS = [dict(id="owner.alias", length=12, sha256="${W}")]`, 'owner-row'],
      [`${W}: plan\n`, 'digest-to-label'],
      [`export const placeDigests = new Set([\n  '${W}',\n])`, 'named-table'],
      // r5e m2: a quoted YAML digest key with a bare value.
      [`"${W}": plan\n`, 'digest-to-label'],
      // r5e m1: the narrowed rules still see a label list, a two-word name and a non-vector private table.
      [`const asset = { labels: ['quartz', 'harbor'], sha256: '${W}' }`, 'label-row'],
      [`{ label: 'quartz harbor', sha256: '${W}' }`, 'label-row'],
      [`const privateKeys = ['${W}', '${W}']`, 'named-table'],
      // r5f M2: the names rows of the private file, in the four likely accidents (synthetic digest).
      [`"names": [\n    {\n      "kind": "series",\n      "sha256": "${W}"\n    }\n  ]`, 'names-row'],
      [`const NAMES = [{ kind: 'series', sha256: '${W}' }]`, 'names-row'],
      [`names:\n  - kind: delivery\n    sha256: ${W}\n`, 'names-row'],
      [`const fixtureNames = [{ kind: 'delivery', sha256: '${W}' }]`, 'names-row'],
      [`const NAMES = ['${W}']`, 'named-table'],
      // r5f m5: a one-word label, and an object value whose keys sit on their own lines.
      [`{ label: 'Harbor', sha256: '${W}' }`, 'label-row'],
      [`const ownerDigests = {\n  alias: '${W}'\n}`, 'named-table']
    ]) {
      assert.ok(digestTableFindings(text).includes(kind), `${kind}: ${text.slice(0, 40)}`)
    }
    for (const fine of [
      `{ "version": "1.2.3", "integrity": "sha256-x", "sha256": "${W}" }`,
      `tarball_sha256: '${W}'`,
      `const PUBLIC = ['${W}']`,
      // A label binding whose own value is no digest, beside one that is (the next key ends the value).
      `const meta = { effectiveLabel: '22 October', title: 'x',\n  sha256: '${W}' }`,
      `const x = { randomPrivateKey: f, lift_x: g, h: '${W}' }`,
      // owner as part of another word is not an owner id.
      `track("scw_sub_account.add_owner.started"); const s = '${W}'`,
      // r5e m1: the repo's own shapes. Separate declarations without semicolons (G1, G2, G3, G8).
      `const owner = 'devclone20'\nconst repo = 'icloneos'\nconst expectedSha = '${W}'`,
      `const label = 'v1'\nlet isPrivate = false\nconst sha = '${W}'`,
      `export const ownerName: string = 'x'\n\nexport function pin() {\n  return '${W}'\n}`,
      // a member chain (F11, G5).
      `if (repo.owner.login === 'x') verify('${W}')`,
      `const who = context.repo.owner.toLowerCase(); const s = '${W}'`,
      // flat release-asset objects (F6, G4, F18).
      `{ label: 'macOS arm64 DMG', file, sha256: '${W}' }`,
      `{ name: 'a.dmg', label: 'macOS DMG', size: 10, digest: 'sha256:${W}' }`,
      `{ places: 3, sha256: '${W}' }`,
      // wallet test vectors (F9, F10).
      `const privateKey = '0x${W}'`,
      `accounts: [{ privateKey: '0x${W}', balance: '1' }]`
    ]) {
      assert.deepEqual(digestTableFindings(fine), [], fine)
    }
  })

  test('no tracked file holds a digest table; the markers module holds only its public-phrase digests', () => {
    const root = path.resolve(import.meta.dirname, '..', '..', '..')
    const files = execFileSync('git', ['-C', root, 'ls-files', '-z'], { maxBuffer: 1 << 28 })
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
    const found = files.filter(rel => {
      let bytes

      try {
        bytes = fs.readFileSync(path.join(root, rel))
      } catch {
        return false
      }

      return (
        bytes.length <= 8 * 1024 * 1024 && !bytes.includes(0) && digestTableFindings(bytes.toString('utf8')).length > 0
      )
    })

    assert.deepEqual(found, [])
    const markers = foldDigests(fs.readFileSync(path.join(import.meta.dirname, 'artifact-hygiene-markers.mjs'), 'utf8'))
    const digests = [...markers.matchAll(new RegExp(`(?<![0-9a-fA-F])${HEX}(?![0-9a-fA-F])`, 'g'))].map(m => m[0])

    assert.deepEqual(digests.sort(), [...PUBLIC_PHRASES].sort())
  }, 120_000)
})
