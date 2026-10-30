import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, test } from 'vitest'

import {
  APP_VERSION,
  assertReport,
  expectedRegistry,
  gateTargets,
  isTied,
  judge,
  judgeTarget,
  lockNodes,
  render,
  runAudit,
  shippedNodes,
  SUB_LOCKS,
  untilVersion,
  WAIVED
} from './audit-gate.mjs'
import { ICLONE_RUNTIME_PATHS } from './runtime-artifact.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GATE = path.join(HERE, 'audit-gate.mjs')
const LOCK = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', '..', 'package-lock.json'), 'utf8'))
// `npm audit --json` (full: Electron is a devDependency) of this lockfile, 2026-10-28, after G-42.
const TODAY_FILE = path.join(HERE, 'audit-gate.fixtures', 'npm-audit-2026-10-28.json')
const TODAY = JSON.parse(fs.readFileSync(TODAY_FILE, 'utf8'))
const NODES = shippedNodes(LOCK)
const REPO = path.join(HERE, '..', '..', '..')
const FIXTURES = path.join(HERE, 'audit-gate.fixtures')
// `npm audit --json --package-lock-only` of each sub-lock, 2026-10-30: after the v0.0.4 bump, and of the lock before it.
const SUB_FIXTURE = {
  'scripts/whatsapp-bridge': 'whatsapp-bridge',
  'plugins/platforms/photon/sidecar': 'photon-sidecar'
}
const subReport = (dir, when = '') =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, `npm-audit-${SUB_FIXTURE[dir]}${when}-2026-10-30.json`), 'utf8'))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-gate-'))

afterAll(() => fs.rmSync(scratch, { force: true, recursive: true }))

/** The lock node of a shipped package (by name), so the tests follow wherever npm hoisted it. */
function shippedNode(name) {
  const node = [...NODES.keys()].find(key => key.endsWith(`node_modules/${name}`))

  assert.ok(node, `${name} is not in the shipped set`)

  return node
}

/** Today's report plus one advisory on `name` at `node`. */
function withAdvisory(name, node, severity, ghsa = 'GHSA-2222-3333-4444') {
  const report = structuredClone(TODAY)
  const entry = report.vulnerabilities[name] ?? {
    name,
    severity,
    isDirect: false,
    via: [],
    effects: [],
    range: '*',
    nodes: [node]
  }

  entry.via.push({
    source: 9_000_001,
    name,
    dependency: name,
    title: `test advisory on ${name}`,
    url: `https://github.com/advisories/${ghsa}`,
    severity,
    range: '*'
  })
  report.vulnerabilities[name] = entry

  return report
}

function runGate(report) {
  const file = path.join(scratch, `report-${Math.random().toString(36).slice(2)}.json`)

  fs.writeFileSync(file, JSON.stringify(report))

  return spawnSync(process.execPath, [GATE, '--report', file], { encoding: 'utf8' })
}

describe('audit gate (G-42): no critical or high advisory in what the app ships', () => {
  test('the shipped set is the notices closure, Electron included (npm audit --omit=dev cannot see it)', () => {
    const ids = new Set(NODES.values())

    assert.ok([...ids].some(id => id.startsWith('electron@')))
    assert.ok([...ids].some(id => id.startsWith('simple-git@')))
    assert.ok(![...ids].some(id => id.startsWith('vite@')))
  })

  test("today's report is green: nothing failing, the Electron highs waived by id, the build tools not judged", () => {
    const verdict = judge(TODAY, LOCK)

    assert.deepEqual(verdict.failing, [])
    assert.deepEqual(verdict.stale, [])
    assert.deepEqual(
      verdict.waived.map(w => `${w.id} ${w.advisory}`).sort(),
      Object.keys(WAIVED['electron@40.10.2'].advisories)
        .map(id => `electron@40.10.2 ${id}`)
        .sort()
    )
    assert.ok(verdict.outside.includes('vite'))

    const run = runGate(TODAY)

    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /\[audit-gate\] GREEN: \d+ shipped packages; critical\/high on them: 0 failing, 6 waived/)
  })

  test('one high advisory on a shipped package is red, and the gate names it', () => {
    const node = shippedNode('dompurify')
    const verdict = judge(withAdvisory('dompurify', node, 'high'), LOCK)

    assert.equal(verdict.failing.length, 1)
    assert.equal(verdict.failing[0].advisory, 'GHSA-2222-3333-4444')
    assert.match(verdict.failing[0].id, /^dompurify@/)

    const run = runGate(withAdvisory('dompurify', node, 'high'))

    assert.equal(run.status, 1)
    assert.match(run.stdout, /^FAIL dompurify@\S+ high GHSA-2222-3333-4444 /m)
    assert.match(run.stdout, /\[audit-gate\] RED/)
  })

  test('a critical one is red too', () => {
    const verdict = judge(withAdvisory('simple-git', shippedNode('simple-git'), 'critical'), LOCK)

    assert.deepEqual(
      verdict.failing.map(f => f.severity),
      ['critical']
    )
  })

  test('a moderate or low advisory on a shipped package does not fail', () => {
    const node = shippedNode('dompurify')

    assert.deepEqual(judge(withAdvisory('dompurify', node, 'moderate'), LOCK).failing, [])
    assert.deepEqual(judge(withAdvisory('dompurify', node, 'low'), LOCK).failing, [])
  })

  test('a critical advisory on a package that does not ship is reported, not judged', () => {
    const verdict = judge(withAdvisory('vite', 'node_modules/vite', 'critical'), LOCK)

    assert.deepEqual(verdict.failing, [])
    assert.ok(verdict.outside.includes('vite'))
  })

  test('a waiver names advisories, not packages: a new Electron high is red', () => {
    const verdict = judge(withAdvisory('electron', shippedNode('electron'), 'high', 'GHSA-5555-6666-7777'), LOCK)

    assert.deepEqual(
      verdict.failing.map(f => f.advisory),
      ['GHSA-5555-6666-7777']
    )
  })

  test('a waiver that matches no finding is red (stale: the list only shrinks to what is still true)', () => {
    const waived = {
      ...WAIVED,
      'dompurify@3.4.17': {
        until: 'test (v9.9.9)',
        reason: 'test',
        advisories: { 'GHSA-8888-9999-cccc': 'never published' }
      }
    }

    const verdict = judge(TODAY, LOCK, waived)

    assert.deepEqual(verdict.stale, [{ id: 'dompurify@3.4.17', advisory: 'GHSA-8888-9999-cccc' }])
    assert.equal(render(verdict, waived).code, 1)
  })

  // v0.0.4 review S5: a waiver is a declared debt only while it names what removes it.
  test('every waiver is tied to what removes it: the Electron one until G-44 (v0.0.5)', () => {
    for (const [id, entry] of Object.entries(WAIVED)) {
      assert.ok(isTied(entry), id)
    }

    assert.equal(WAIVED['electron@40.10.2'].until, 'G-44 (v0.0.5)')
  })

  test('a waiver without `until` is refused: it waives nothing, its findings fail, the gate is red', () => {
    const untiedEntry = { ...WAIVED['electron@40.10.2'] }

    delete untiedEntry.until

    for (const entry of [
      untiedEntry,
      { ...untiedEntry, until: '' },
      { ...untiedEntry, until: '   ' },
      { ...untiedEntry, until: 'G-44' },
      { ...untiedEntry, until: 'G-44 (v0.0.5 or v0.0.6)' }
    ]) {
      const waived = { 'electron@40.10.2': entry }
      const verdict = judge(TODAY, LOCK, waived)
      const { lines, code } = render(verdict, waived)

      assert.deepEqual(verdict.untied, ['electron@40.10.2'])
      assert.deepEqual(verdict.waived, [])
      assert.deepEqual(verdict.stale, [])
      assert.deepEqual(
        [...new Set(verdict.failing.map(f => f.advisory))].sort(),
        Object.keys(untiedEntry.advisories).sort()
      )
      assert.equal(code, 1)
      assert.ok(
        lines.includes(
          `UNTIED waiver electron@40.10.2: names no versioned \`until\` (what removes it, e.g. "G-44 (v0.0.5)"); refused`
        )
      )
      assert.match(lines.at(-1), /\[audit-gate\] RED: .* 1 untied waiver\(s\)/)
    }
  })

  // v0.0.4 review R2-4: `until` is enforced, not only present. The app version is the desktop workspace's own.
  test('the release version is the desktop package.json version, and the Electron waiver drops at v0.0.5', () => {
    const desktop = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))

    assert.equal(APP_VERSION, desktop.version)
    assert.deepEqual(untilVersion(WAIVED['electron@40.10.2'].until), [0, 0, 5])
  })

  test('before its `until` version a waiver applies: v0.0.4 is green with the Electron highs waived', () => {
    for (const version of ['0.0.3', '0.0.4']) {
      const verdict = judge(TODAY, LOCK, WAIVED, version)

      assert.deepEqual(verdict.expired, [], version)
      assert.deepEqual(verdict.failing, [], version)
      assert.equal(verdict.waived.length, Object.keys(WAIVED['electron@40.10.2'].advisories).length, version)
      assert.equal(render(verdict).code, 0, version)
    }
  })

  test('from its `until` version on a waiver is EXPIRED: v0.0.5 (and later) is red and its findings fail', () => {
    for (const version of ['0.0.5', '0.0.6', '0.1.0', '1.0.0']) {
      const verdict = judge(TODAY, LOCK, WAIVED, version)
      const { lines, code } = render(verdict)

      assert.deepEqual(verdict.expired, [{ id: 'electron@40.10.2', until: 'G-44 (v0.0.5)' }], version)
      assert.deepEqual(verdict.waived, [], version)
      assert.deepEqual(verdict.stale, [], version)
      assert.deepEqual(
        [...new Set(verdict.failing.map(f => f.advisory))].sort(),
        Object.keys(WAIVED['electron@40.10.2'].advisories).sort(),
        version
      )
      assert.equal(code, 1, version)
      assert.ok(
        lines.includes(`EXPIRED waiver electron@40.10.2: until G-44 (v0.0.5), and this is v${version}; refused`)
      )
      assert.match(lines.at(-1), /\[audit-gate\] RED: .* 1 expired waiver\(s\)/)
    }
  })

  test('an app version that is not x.y.z cannot be judged', () => {
    assert.throws(() => judge(TODAY, LOCK, WAIVED, '0.0.5-beta'), /cannot judge: the app version "0.0.5-beta"/)
  })

  test('anything but an npm audit report (an npm error, an empty file) cannot be judged: exit 2', () => {
    const run = runGate({ message: 'request to the registry failed' })

    assert.equal(run.status, 2)
    assert.match(run.stderr, /cannot judge: request to the registry failed/)
  })
})

// GATES.md part 2a: npm's offline mode and its empty error summary. Measured with npm 11.19: offline=true in the
// environment makes `npm audit --json` print a valid, empty report with exit 0 and no request; an unreachable
// registry gives { message: '<reason>', error: { summary: '', detail: '' } }.
describe('audit gate (G-42, GATES 2a): the registry must have answered', () => {
  const ANSWERED = 'npm http fetch POST 200 https://registry.npmjs.org/-/npm/v1/security/advisories/bulk 311ms\n'
  const EMPTY = { ...structuredClone(TODAY), vulnerabilities: {} }
  const UNREACHABLE = {
    message:
      'request to http://127.0.0.1:9/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 127.0.0.1:9',
    error: { summary: '', detail: '' }
  }

  // A stand-in for npm on PATH that behaves as npm 11 does: offline=true in the environment wins unless the command
  // line says --offline=false; FAKE_NPM picks what the registry does.
  const bin = path.join(scratch, 'bin')
  const fakeNpm = path.join(bin, 'npm')

  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(
    fakeNpm,
    `#!${process.execPath}
const fs = require('node:fs')
const argv = process.argv.slice(2)
const offline = process.env.npm_config_offline === 'true' && !argv.includes('--offline=false')
const subs = ${JSON.stringify(SUB_FIXTURE)}
const sub = Object.keys(subs).find(dir => process.cwd().endsWith(dir))
const today = fs.readFileSync(
  sub && argv.includes('--package-lock-only')
    ? ${JSON.stringify(FIXTURES)} + '/npm-audit-' + subs[sub] + '-2026-10-30.json'
    : ${JSON.stringify(TODAY_FILE)},
  'utf8'
)
if (offline) {
  process.stdout.write(${JSON.stringify(JSON.stringify(EMPTY))})
} else if (process.env.FAKE_NPM === 'mirror') {
  process.stderr.write('npm http fetch POST 200 https://mirror.example.invalid/-/npm/v1/security/advisories/bulk 9ms\\n')
  process.stdout.write(${JSON.stringify(JSON.stringify(EMPTY))})
} else if (process.env.FAKE_NPM === 'unreachable') {
  process.stderr.write('npm warn audit request failed\\n')
  process.stdout.write(${JSON.stringify(JSON.stringify(UNREACHABLE))})
  process.exitCode = 1
} else {
  if (argv.includes('--loglevel=http')) process.stderr.write(${JSON.stringify(ANSWERED)})
  process.stdout.write(today)
  process.exitCode = 1
}
`,
    { mode: 0o755 }
  )

  const runOnline = env =>
    spawnSync(process.execPath, [GATE], {
      encoding: 'utf8',
      env: { ...process.env, ...env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
    })

  test('offline=true in the environment does not stop the request: the gate forces --offline=false', () => {
    const run = runOnline({ npm_config_offline: 'true' })

    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.match(
      run.stdout,
      /^registry: https:\/\/registry\.npmjs\.org\/-\/npm\/v1\/security\/advisories\/bulk answered 200$/m
    )
    assert.match(run.stdout, /\[audit-gate\] GREEN: .* 6 waived/)
  })

  test("a valid report with no sign of the registry in npm's http log cannot be judged, even a clean one", () => {
    const spawn = () => ({ status: 0, stdout: JSON.stringify(EMPTY), stderr: '' })

    assert.throws(
      () => runAudit(scratch, spawn),
      /^Error: cannot judge: no evidence the registry answered the audit .*npm wrote a report without asking the registry/
    )
    assert.equal(
      runAudit(scratch, () => ({ status: 1, stdout: JSON.stringify(TODAY), stderr: ANSWERED })).endpoint,
      'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk'
    )
  })

  test('an unreachable registry is "cannot judge" with npm\'s reason, not an empty one', () => {
    assert.throws(
      () => assertReport(UNREACHABLE),
      /^Error: cannot judge: request to .* connect ECONNREFUSED 127\.0\.0\.1:9$/
    )

    const run = runOnline({ FAKE_NPM: 'unreachable' })

    assert.equal(run.status, 2)
    assert.match(run.stderr, /cannot judge: no evidence the registry answered the audit .*: request to .* ECONNREFUSED/)
  })

  // Review R1-A minor 6: the proof must come from the expected registry. A mirror that answers 200 with an empty
  // list would make the gate green once the Electron waivers leave.
  test('an audit answered by any other registry is refused, even with a 200', () => {
    const mirror = 'npm http fetch POST 200 https://mirror.example.invalid/-/npm/v1/security/advisories/bulk 9ms\n'
    const args = []
    const spawn = (_cmd, argv) => (args.push(...argv), { status: 0, stdout: JSON.stringify(EMPTY), stderr: mirror })

    assert.throws(
      () => runAudit(scratch, spawn),
      /cannot judge: the audit was answered by https:\/\/mirror\.example\.invalid\/\S+, not by the expected registry https:\/\/registry\.npmjs\.org\//
    )
    assert.ok(args.includes('--registry=https://registry.npmjs.org/'), args.join(' '))

    const run = runOnline({ FAKE_NPM: 'mirror' })

    assert.equal(run.status, 2, run.stdout + run.stderr)
    assert.match(run.stderr, /answered by https:\/\/mirror\.example\.invalid\//)
  })

  test("a registry the project's .npmrc pins is the expected one, and npmjs is then refused", () => {
    const project = fs.mkdtempSync(path.join(scratch, 'pinned-'))

    fs.writeFileSync(path.join(project, '.npmrc'), '# pinned\nregistry = https://npm.example.invalid/custom\n')
    assert.equal(expectedRegistry(project), 'https://npm.example.invalid/custom/')
    assert.equal(expectedRegistry(scratch), 'https://registry.npmjs.org/')

    const answered = url => () => ({
      status: 1,
      stdout: JSON.stringify(TODAY),
      stderr: `npm http fetch POST 200 ${url} 5ms\n`
    })

    assert.equal(
      runAudit(project, answered('https://npm.example.invalid/custom/-/npm/v1/security/advisories/bulk')).endpoint,
      'https://npm.example.invalid/custom/-/npm/v1/security/advisories/bulk'
    )
    assert.throws(
      () => runAudit(project, answered('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk')),
      /not by the expected registry https:\/\/npm\.example\.invalid\/custom\//
    )
  })
})

// v0.0.4 review F8: the gate needs the registry, so it runs on the release path, not on every dev build.
describe('audit gate (G-42, review F8): the release runs it, dev builds do not', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).scripts

  test('npm run release:mac runs the gate first (its prerelease:mac hook), against the network', () => {
    assert.equal(scripts['audit:gate'], 'node scripts/audit-gate.mjs')
    assert.equal(scripts['prerelease:mac'], 'npm run audit:gate')
    assert.equal(scripts['release:mac'], 'node scripts/release-mac.mjs')
    // npm skips pre-hooks under ignore-scripts=true: the project .npmrc must not set it.
    assert.doesNotMatch(
      fs.readFileSync(path.join(HERE, '..', '..', '..', '.npmrc'), 'utf8'),
      /^\s*ignore-scripts\s*=\s*true/m
    )
  })

  test('dev builds stay offline: no audit in dev, start, prebuild, build or pack', () => {
    for (const name of ['dev', 'start', 'prebuild', 'build', 'pack']) {
      assert.doesNotMatch(scripts[name], /audit/, name)
    }
  })
})

describe("audit gate (G-45, v0.0.4 review M2): the runtime's other npm locks", () => {
  // What each lock shipped before the v0.0.4 bump, and the advisories that made it red (GHSA-f596-whhp-79r4 on the
  // same grpc-js is low: the bump fixes it, the gate never judged it).
  const BEFORE = {
    'scripts/whatsapp-bridge': { versions: { sharp: '0.35.4' }, advisories: ['sharp@0.35.4 GHSA-wq5f-xc86-pv6w'] },
    'plugins/platforms/photon/sidecar': {
      versions: { '@grpc/grpc-js': '1.14.4', zod: '4.5.4' },
      advisories: ['@grpc/grpc-js@1.14.4 GHSA-m9gg-hp2v-232j', 'zod@4.5.4 GHSA-mrhx-c7xc-m3w5']
    }
  }
  const FIXED = {
    'scripts/whatsapp-bridge': ['sharp@0.35.5'],
    'plugins/platforms/photon/sidecar': ['@grpc/grpc-js@1.14.5', 'zod@4.6.6']
  }
  const subLock = dir => JSON.parse(fs.readFileSync(path.join(REPO, dir, 'package-lock.json'), 'utf8'))
  const judgeSub = (dir, report, lock = subLock(dir), waived = SUB_LOCKS[dir]) =>
    judge(report, lock, waived, APP_VERSION, lockNodes)

  test('the gate judges every npm lock the runtime ships: the repo lock, then each deps lock of the runtime', () => {
    const runtimeLocks = Object.entries(ICLONE_RUNTIME_PATHS)
      .filter(([file, kind]) => kind === 'deps' && file.endsWith('/package-lock.json'))
      .map(([file]) => path.posix.dirname(file))
      .sort()

    assert.deepEqual(Object.keys(SUB_LOCKS).sort(), runtimeLocks)
    assert.deepEqual(
      gateTargets(REPO).map(t => t.label),
      [null, ...Object.keys(SUB_LOCKS)]
    )
  })

  for (const dir of Object.keys(SUB_LOCKS)) {
    test(`${dir}: its lock ships the fixed releases, and today's audit of it is green with no waiver`, () => {
      const ids = new Set(lockNodes(subLock(dir)).values())

      for (const id of FIXED[dir]) {
        assert.ok(ids.has(id), `${id} is not in ${dir}/package-lock.json`)
      }

      const verdict = judgeSub(dir, subReport(dir))

      assert.deepEqual(Object.keys(SUB_LOCKS[dir]), [])
      assert.deepEqual([verdict.failing, verdict.stale, verdict.untied, verdict.expired], [[], [], [], []])
      assert.equal(render(verdict, SUB_LOCKS[dir]).code, 0)
    })

    test(`${dir}: the lock as it was before the v0.0.4 bump is red, and the gate names each advisory`, () => {
      const lock = structuredClone(subLock(dir))

      for (const [name, version] of Object.entries(BEFORE[dir].versions)) {
        lock.packages[`node_modules/${name}`].version = version
      }

      const verdict = judgeSub(dir, subReport(dir, '-before-bump'), lock)

      assert.deepEqual(verdict.failing.map(f => `${f.id} ${f.advisory}`).sort(), BEFORE[dir].advisories)
      assert.equal(render(verdict, SUB_LOCKS[dir]).code, 1)
    })
  }

  test('a sub-lock waiver follows the same rules: one that matches no finding is stale, and red', () => {
    const dir = 'scripts/whatsapp-bridge'
    const waived = { 'sharp@0.35.5': { until: 'G-45 (v0.0.5)', advisories: { 'GHSA-wq5f-xc86-pv6w': 'test' } } }
    const verdict = judgeSub(dir, subReport(dir), subLock(dir), waived)

    assert.deepEqual(verdict.stale, [{ id: 'sharp@0.35.5', advisory: 'GHSA-wq5f-xc86-pv6w' }])
    assert.equal(render(verdict, waived).code, 1)
  })

  test('a dev-only package of a sub-lock does not ship: lockNodes leaves it out', () => {
    const lock = {
      packages: {
        '': { name: 'x' },
        'node_modules/a': { version: '1.0.0' },
        'node_modules/b': { version: '2.0.0', dev: true }
      }
    }

    assert.deepEqual([...lockNodes(lock)], [['node_modules/a', 'a@1.0.0']])
  })

  test("a sub-lock is audited from its lock, in its folder, against the repo's registry", () => {
    const calls = []
    const target = gateTargets(REPO).find(t => t.label === 'scripts/whatsapp-bridge')
    const spawn = (cmd, argv, options) => {
      calls.push({ cmd, argv, cwd: options.cwd })

      return {
        status: 1,
        stdout: JSON.stringify(subReport('scripts/whatsapp-bridge')),
        stderr: 'npm http fetch POST 200 https://registry.npmjs.org/-/npm/v1/security/advisories/bulk 90ms\n'
      }
    }

    const { lines, code } = judgeTarget(target, { spawn, registry: 'https://registry.npmjs.org/' })

    assert.equal(code, 0, lines.join('\n'))
    assert.equal(lines[0], '[audit-gate] lock scripts/whatsapp-bridge:')
    assert.deepEqual(calls, [
      {
        cmd: 'npm',
        argv: [
          'audit',
          '--json',
          '--offline=false',
          '--loglevel=http',
          '--package-lock-only',
          '--registry=https://registry.npmjs.org/'
        ],
        cwd: path.join(REPO, 'scripts/whatsapp-bridge')
      }
    ])
  })

  test('online, the gate judges every lock and is red when any one is', () => {
    const red = gateTargets(REPO).find(t => t.label === 'plugins/platforms/photon/sidecar')
    const spawn = () => ({
      status: 1,
      stdout: JSON.stringify(subReport('plugins/platforms/photon/sidecar', '-before-bump')),
      stderr: 'npm http fetch POST 200 https://registry.npmjs.org/-/npm/v1/security/advisories/bulk 90ms\n'
    })
    const { lines, code } = judgeTarget(red, { spawn, registry: 'https://registry.npmjs.org/' })

    assert.equal(code, 1)
    assert.ok(
      lines.some(line => /^FAIL zod@4\.6\.6 high GHSA-mrhx-c7xc-m3w5 /.test(line)),
      lines.join('\n')
    )
  })
})
