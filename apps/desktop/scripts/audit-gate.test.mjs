import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, test } from 'vitest'

import {
  ACP_LOCKS,
  ACP_NODE_NPM_ADVISORY,
  chainAdvisories,
  isNpmSyntheticVia,
  isSyntheticAdvisory,
  advisoryId,
  APP_LOCKS,
  APP_VERSION,
  assertReport,
  assertReportScope,
  AUDIT_ARGS,
  expectedRegistry,
  gateTargets,
  isTied,
  judge,
  judgeTarget,
  lockNodes,
  omittedClasses,
  render,
  runAudit,
  shippedNodes,
  stampAudited,
  SUB_LOCKS,
  untilVersion,
  WAIVED
} from './audit-gate.mjs'
import { ICLONE_RUNTIME_PATHS } from './runtime-artifact.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GATE = path.join(HERE, 'audit-gate.mjs')
const LOCK = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', '..', 'package-lock.json'), 'utf8'))
// `npm audit --json --package-lock-only` at the repo root (full: Electron is a devDependency) of this lockfile,
// 2026-11-01, after the move to Electron 44.10.1. No path in it is absolute.
const TODAY_FILE = path.join(HERE, 'audit-gate.fixtures', 'npm-audit-2026-11-01.json')
const TODAY = JSON.parse(fs.readFileSync(TODAY_FILE, 'utf8'))
// The same report for the lockfile of 2026-10-28, which still shipped Electron 40.10.2.
const BEFORE_ELECTRON_44 = JSON.parse(
  fs.readFileSync(path.join(HERE, 'audit-gate.fixtures', 'npm-audit-2026-10-28.json'), 'utf8')
)
// The six Electron highs that the Electron 40.10.2 waiver named and that Electron 44.10.1 no longer has.
const ELECTRON_40_HIGHS = Object.freeze([
  'GHSA-9f4c-93c8-jc8g',
  'GHSA-9qh4-3jw8-366w',
  'GHSA-gr2m-v5gq-v685',
  'GHSA-hq2x-r82h-9wj4',
  'GHSA-j84w-jfhq-vhvj',
  'GHSA-jr5w-w6x2-84p9'
])
const NODES = shippedNodes(LOCK)
const REPO = path.join(HERE, '..', '..', '..')
const FIXTURES = path.join(HERE, 'audit-gate.fixtures')
// `npm audit --json --package-lock-only` of each sub-lock, 2026-10-30: after the v0.0.4 bump, and of the lock before it.
const SUB_FIXTURE = {
  'scripts/whatsapp-bridge': 'whatsapp-bridge',
  'plugins/platforms/photon/sidecar': 'photon-sidecar'
}
// `npm audit --json --package-lock-only` of each APP_LOCKS lock (the Privy sign-in page), 2026-11-03, by the gate's runAudit.
const APP_FIXTURE = { 'iclone/privy/login-island': 'npm-audit-privy-login-island-2026-11-03.json' }
// `npm audit --json --package-lock-only` of the ACP_LOCKS lock (the optional ACP CLI), 2026-11-04, by the gate's runAudit.
const ACP_FIXTURE = { 'apps/desktop/acp-cli-lock': 'npm-audit-acp-cli-lock-2026-11-04.json' }
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

/** Today's report (or `base`) plus one advisory on `name` at `node`. */
function withAdvisory(name, node, severity, ghsa = 'GHSA-2222-3333-4444', base = TODAY) {
  const report = structuredClone(base)
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

/*
 * The waiver machinery (untied, stale, expired, tied) is tested on a synthetic waiver: since Electron 44 the real list
 * is empty. SAMPLE_REPORT is today's report plus two highs on a shipped package; SAMPLE_WAIVED waives exactly those two,
 * until v0.2.0. Same shape as a real waiver, so the checks keep the strength they had on the Electron one.
 */
const SAMPLE_NODE = shippedNode('dompurify')
const SAMPLE_ID = NODES.get(SAMPLE_NODE)
const SAMPLE_ADVISORIES = Object.freeze({
  'GHSA-cccc-ffff-gggg': 'synthetic high one',
  'GHSA-hhhh-jjjj-mmmm': 'synthetic high two'
})
const SAMPLE_UNTIL = 'sample removal (v0.2.0)'
const SAMPLE_REPORT = Object.keys(SAMPLE_ADVISORIES).reduce(
  (report, ghsa) => withAdvisory('dompurify', SAMPLE_NODE, 'high', ghsa, report),
  TODAY
)
const SAMPLE_WAIVED = Object.freeze({
  [SAMPLE_ID]: {
    until: SAMPLE_UNTIL,
    severity: 'high',
    reason: 'synthetic waiver for the tests',
    advisories: SAMPLE_ADVISORIES
  }
})

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

  // Before Electron 44 this test expected the six Electron 40.10.2 highs waived by id; Electron 44.10.1 has none, so
  // today's report is green with nothing waived, and with no waiver list at all.
  test("today's report is green with no waiver: nothing failing, nothing waived, the build tools not judged", () => {
    for (const waived of [WAIVED, {}]) {
      const verdict = judge(TODAY, LOCK, waived)

      assert.deepEqual(verdict.failing, [])
      assert.deepEqual(verdict.stale, [])
      assert.deepEqual(verdict.waived, [])
      assert.ok(verdict.outside.includes('vite'))
    }

    const run = runGate(TODAY)

    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /\[audit-gate\] GREEN: \d+ shipped packages; critical\/high on them: 0 failing, 0 waived/)
  })

  test('no waiver names Electron: Electron 44.10.1 ships, and today it has no advisory at all', () => {
    assert.deepEqual(
      Object.keys(WAIVED).filter(id => id.startsWith('electron@')),
      []
    )
    assert.ok([...NODES.values()].includes('electron@44.10.1'))
    assert.equal(TODAY.vulnerabilities.electron, undefined)
  })

  test('the Electron 40.10.2 highs were real: the lockfile of 2026-10-28 had all six on Electron', () => {
    const before = BEFORE_ELECTRON_44.vulnerabilities.electron.via
      .filter(via => typeof via === 'object' && via.severity === 'high')
      .map(via => advisoryId(via))

    assert.deepEqual([...new Set(before)].sort(), [...ELECTRON_40_HIGHS])
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

  test('a new Electron high is red', () => {
    const verdict = judge(withAdvisory('electron', shippedNode('electron'), 'high', 'GHSA-5555-6666-7777'), LOCK)

    assert.deepEqual(
      verdict.failing.map(f => f.advisory),
      ['GHSA-5555-6666-7777']
    )
  })

  test('a waiver names advisories, not packages: a new high on a waived package is red', () => {
    const report = withAdvisory('dompurify', SAMPLE_NODE, 'high', 'GHSA-5555-6666-7777', SAMPLE_REPORT)
    const verdict = judge(report, LOCK, SAMPLE_WAIVED, '0.0.4')

    assert.deepEqual(
      verdict.failing.map(f => `${f.id} ${f.advisory}`),
      [`${SAMPLE_ID} GHSA-5555-6666-7777`]
    )
    assert.deepEqual(
      verdict.waived.map(w => `${w.id} ${w.advisory}`).sort(),
      Object.keys(SAMPLE_ADVISORIES).map(id => `${SAMPLE_ID} ${id}`)
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
  test('every waiver is tied to what removes it (and so is the synthetic one, until v0.2.0)', () => {
    for (const [id, entry] of Object.entries(WAIVED)) {
      assert.ok(isTied(entry), id)
    }

    assert.ok(isTied(SAMPLE_WAIVED[SAMPLE_ID]))
    assert.equal(SAMPLE_WAIVED[SAMPLE_ID].until, SAMPLE_UNTIL)
  })

  test('a waiver without `until` is refused: it waives nothing, its findings fail, the gate is red', () => {
    const untiedEntry = { ...SAMPLE_WAIVED[SAMPLE_ID] }

    delete untiedEntry.until

    for (const entry of [
      untiedEntry,
      { ...untiedEntry, until: '' },
      { ...untiedEntry, until: '   ' },
      { ...untiedEntry, until: 'sample removal' },
      { ...untiedEntry, until: 'sample removal (v0.2.0 or v0.3.0)' }
    ]) {
      const waived = { [SAMPLE_ID]: entry }
      const verdict = judge(SAMPLE_REPORT, LOCK, waived)
      const { lines, code } = render(verdict, waived)

      assert.deepEqual(verdict.untied, [SAMPLE_ID])
      assert.deepEqual(verdict.waived, [])
      assert.deepEqual(verdict.stale, [])
      assert.deepEqual(
        [...new Set(verdict.failing.map(f => f.advisory))].sort(),
        Object.keys(untiedEntry.advisories).sort()
      )
      assert.equal(code, 1)
      assert.ok(
        lines.includes(
          `UNTIED waiver ${SAMPLE_ID}: names no versioned \`until\` (what removes it, e.g. "fixed by the next Electron (v0.0.5)"); refused`
        )
      )
      assert.match(lines.at(-1), /\[audit-gate\] RED: .* 1 untied waiver\(s\)/)
    }
  })

  // v0.0.4 review R2-4: `until` is enforced, not only present. The app version is the desktop workspace's own.
  test('the release version is the desktop package.json version, and a waiver drops at its `until` version', () => {
    const desktop = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))

    assert.equal(APP_VERSION, desktop.version)
    assert.deepEqual(untilVersion(SAMPLE_UNTIL), [0, 2, 0])
  })

  test('before its `until` version a waiver applies: v0.1.9 and earlier are green with its highs waived', () => {
    for (const version of ['0.0.3', '0.0.4', '0.1.9']) {
      const verdict = judge(SAMPLE_REPORT, LOCK, SAMPLE_WAIVED, version)

      assert.deepEqual(verdict.expired, [], version)
      assert.deepEqual(verdict.failing, [], version)
      assert.equal(verdict.waived.length, Object.keys(SAMPLE_ADVISORIES).length, version)
      assert.equal(render(verdict, SAMPLE_WAIVED).code, 0, version)
    }
  })

  test('from its `until` version on a waiver is EXPIRED: v0.2.0 (and later) is red and its findings fail', () => {
    for (const version of ['0.2.0', '0.2.1', '0.3.0', '1.0.0']) {
      const verdict = judge(SAMPLE_REPORT, LOCK, SAMPLE_WAIVED, version)
      const { lines, code } = render(verdict, SAMPLE_WAIVED)

      assert.deepEqual(verdict.expired, [{ id: SAMPLE_ID, until: SAMPLE_UNTIL }], version)
      assert.deepEqual(verdict.waived, [], version)
      assert.deepEqual(verdict.stale, [], version)
      assert.deepEqual(
        [...new Set(verdict.failing.map(f => f.advisory))].sort(),
        Object.keys(SAMPLE_ADVISORIES).sort(),
        version
      )
      assert.equal(code, 1, version)
      assert.ok(lines.includes(`EXPIRED waiver ${SAMPLE_ID}: until ${SAMPLE_UNTIL}, and this is v${version}; refused`))
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
const apps = ${JSON.stringify({ ...APP_FIXTURE, ...ACP_FIXTURE })}
const sub = Object.keys(subs).find(dir => process.cwd().endsWith(dir))
const app = Object.keys(apps).find(dir => process.cwd().endsWith(dir))
const today = fs.readFileSync(
  sub && argv.includes('--package-lock-only')
    ? ${JSON.stringify(FIXTURES)} + '/npm-audit-' + subs[sub] + '-2026-10-30.json'
    : app && argv.includes('--package-lock-only')
      ? ${JSON.stringify(FIXTURES)} + '/' + apps[app]
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
    // Was "6 waived" while the Electron 40.10.2 waiver existed; the repo list is empty since Electron 44.
    assert.match(run.stdout, /\[audit-gate\] GREEN: .* 0 failing, 0 waived/)
    // The Privy sign-in lock is judged too: green with its 4 waived findings (owner decision 2026-11-03/04).
    assert.match(
      run.stdout,
      /\[audit-gate\] lock iclone\/privy\/login-island:\n.*answered 200\n(?:WAIVED .*\n| {2}.*\n)*\[audit-gate\] GREEN: .* 0 failing, 4 waived, 0 stale/
    )
    // And the optional ACP CLI's lock: green with its 2 waived findings (owner decision 2026-11-03/04).
    assert.match(
      run.stdout,
      /\[audit-gate\] lock apps\/desktop\/acp-cli-lock:\n.*answered 200\n(?:WAIVED .*\n| {2}.*\n)*\[audit-gate\] GREEN: .* 0 failing, 2 waived, 0 stale/
    )
    assert.doesNotMatch(run.stdout, /RED/)
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
    // music-metadata and qs fix moderate advisories (the gate judges high and critical); pinned here so a lock
    // refresh cannot quietly take them back.
    'scripts/whatsapp-bridge': ['sharp@0.35.5', 'music-metadata@11.16.0', 'qs@6.16.1'],
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
      [null, ...Object.keys(SUB_LOCKS), ...Object.keys(APP_LOCKS), ...Object.keys(ACP_LOCKS)]
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
    const waived = {
      'sharp@0.35.5': { until: 'test (v9.9.9)', severity: 'high', advisories: { 'GHSA-wq5f-xc86-pv6w': 'test' } }
    }
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
          '--include=dev',
          '--include=optional',
          '--include=peer',
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

describe('audit gate (G-42, v0.0.5): the Privy sign-in lock ships in the app and is judged, with explicit waivers', () => {
  const DIR = 'iclone/privy/login-island'
  // `npm audit --json --package-lock-only` of iclone/privy/login-island/package-lock.json, 2026-11-03, run by the
  // gate's runAudit (stamped; the registry answered 200).
  const REPORT = JSON.parse(fs.readFileSync(path.join(FIXTURES, APP_FIXTURE[DIR]), 'utf8'))
  const LOCK_IN = JSON.parse(fs.readFileSync(path.join(REPO, DIR, 'package-lock.json'), 'utf8'))
  const WAIVERS = APP_LOCKS[DIR]
  const ACCEPTED = [
    'decode-uri-component@0.2.2 GHSA-qr28-fpjm-wq7f',
    'zod@3.22.4 GHSA-mrhx-c7xc-m3w5',
    'zod@3.22.4 GHSA-mrhx-c7xc-m3w5',
    'zod@3.25.76 GHSA-mrhx-c7xc-m3w5'
  ]
  const judgeIn = (waived = WAIVERS, version = APP_VERSION) => judge(REPORT, LOCK_IN, waived, version, lockNodes)
  const ids = list => list.map(f => `${f.id} ${f.advisory}`).sort()

  test('the sign-in lock is one of the gate targets, judged by its own lock and waivers, from the lock', () => {
    const target = gateTargets(REPO).find(t => t.label === DIR)

    assert.ok(target, 'iclone/privy/login-island is not judged')
    assert.equal(target.dir, path.join(REPO, DIR))
    assert.equal(target.waived, WAIVERS)
    assert.equal(target.nodesOf, lockNodes)
    assert.deepEqual(target.extra, ['--package-lock-only'])
    assert.equal(Object.keys(SUB_LOCKS).includes(DIR), false)
  })

  test('with the waivers it is green: exactly the zod and decode-uri-component highs are waived, nothing else', () => {
    const verdict = judgeIn()

    assert.deepEqual([verdict.failing, verdict.stale, verdict.untied, verdict.expired], [[], [], [], []])
    assert.deepEqual(ids(verdict.waived), ACCEPTED)
    assert.deepEqual(Object.keys(WAIVERS).sort(), ['decode-uri-component@0.2.2', 'zod@3.22.4', 'zod@3.25.76'])

    const { lines, code } = render(verdict, WAIVERS)

    assert.equal(code, 0, lines.join('\n'))
    assert.match(lines.at(-1), /GREEN: .* 0 failing, 4 waived, 0 stale/)
    assert.ok(
      lines.some(line => /^WAIVED zod@3\.25\.76 until v0\.0\.8/.test(line)),
      lines.join('\n')
    )
  })

  test('without the waivers it is red, and the gate names each finding', () => {
    const verdict = judgeIn({})
    const { lines, code } = render(verdict, {})

    assert.deepEqual(ids(verdict.failing), ACCEPTED)
    assert.equal(code, 1)
    assert.ok(
      lines.some(line => /^FAIL zod@3\.25\.76 high GHSA-mrhx-c7xc-m3w5 /.test(line)),
      lines.join('\n')
    )
    assert.ok(
      lines.some(line => /^FAIL decode-uri-component@0\.2\.2 high GHSA-qr28-fpjm-wq7f /.test(line)),
      lines.join('\n')
    )
  })

  test('without only the zod@3.25.76 entry, that finding is red', () => {
    const rest = Object.fromEntries(Object.entries(WAIVERS).filter(([id]) => id !== 'zod@3.25.76'))
    const verdict = judgeIn(rest)

    assert.deepEqual(ids(verdict.failing), ['zod@3.25.76 GHSA-mrhx-c7xc-m3w5'])
    assert.equal(render(verdict, rest).code, 1)
  })

  test('each waiver stores the severity it accepted: high', () => {
    for (const [id, entry] of Object.entries(WAIVERS)) {
      assert.equal(entry.severity, 'high', id)
    }
  })

  test('a waived advisory re-rated critical is refused: red, and the line names the waiver, the advisory and both ratings', () => {
    const rerated = { ...WAIVERS, 'zod@3.25.76': { ...WAIVERS['zod@3.25.76'], severity: 'critical' } }
    const verdict = judgeIn(rerated)
    const { lines, code } = render(verdict, rerated)

    assert.deepEqual(verdict.mismatched, [
      { id: 'zod@3.25.76', advisory: 'GHSA-mrhx-c7xc-m3w5', accepted: 'critical', severity: 'high' }
    ])
    assert.ok(!verdict.waived.some(w => w.id === 'zod@3.25.76'), 'not waived at another rating')
    assert.deepEqual(verdict.stale, [])
    assert.equal(code, 1)
    assert.ok(
      lines.some(line =>
        /^SEVERITY waiver zod@3\.25\.76 GHSA-mrhx-c7xc-m3w5: accepted at critical, the report rates it high; refused/.test(
          line
        )
      ),
      lines.join('\n')
    )
    assert.match(lines.at(-1), /RED: .* 1 severity mismatch\(es\)/)
  })

  test('a waiver that records no severity is refused the same way (accepted at none)', () => {
    const bare = Object.fromEntries(
      Object.entries(WAIVERS['decode-uri-component@0.2.2']).filter(([key]) => key !== 'severity')
    )
    const waivers = { ...WAIVERS, 'decode-uri-component@0.2.2': bare }
    const verdict = judgeIn(waivers)

    assert.deepEqual(
      verdict.mismatched.map(m => `${m.id} ${m.accepted} ${m.severity}`),
      ['decode-uri-component@0.2.2 none high']
    )
    assert.equal(render(verdict, waivers).code, 1)
  })

  test('each waiver names its advisory, the reason, the worst case, the owner decision and its date', () => {
    const expected = {
      'zod@3.25.76': 'GHSA-mrhx-c7xc-m3w5',
      'zod@3.22.4': 'GHSA-mrhx-c7xc-m3w5',
      'decode-uri-component@0.2.2': 'GHSA-qr28-fpjm-wq7f'
    }

    for (const [id, ghsa] of Object.entries(expected)) {
      const entry = WAIVERS[id]

      assert.deepEqual(Object.keys(entry.advisories), [ghsa], id)
      assert.ok(entry.reason.includes(ghsa), id)

      for (const text of [
        'no compatible fix',
        'DoS of the sign-in window only',
        'no data or code is exposed',
        'accepted by the owner 2026-11-03/04',
        're-decided 2026-11-05 for v0.0.6 by the security review; removed when a compatible fix exists',
        're-reviewed 2026-11-10 for v0.0.7: still no compatible fix'
      ]) {
        assert.ok(entry.reason.includes(text), `${id}: ${text}`)
      }

      assert.ok(entry.until.includes('re-decided each release; removed when a compatible fix exists (backlog'), id)
      assert.deepEqual(untilVersion(entry.until), [0, 0, 8], id)
    }

    for (const consumer of ['@privy-io/api-base', '@coinbase/cdp-sdk', 'x402', '@reown/appkit-wallet']) {
      assert.ok(WAIVERS['zod@3.25.76'].reason.includes(consumer), consumer)
    }

    for (const text of [
      '@wagmi/connectors',
      '@walletconnect/utils',
      'query-string 7',
      'semver-major @privy-io/react-auth'
    ]) {
      assert.ok(WAIVERS['decode-uri-component@0.2.2'].reason.includes(text), text)
    }
  })

  test('at v0.0.7 every waiver still applies, and the gate is green: the re-decision of this release', () => {
    const verdict = judgeIn(WAIVERS, '0.0.7')

    assert.deepEqual([verdict.failing, verdict.stale, verdict.untied, verdict.expired], [[], [], [], []])
    assert.deepEqual(ids(verdict.waived), ACCEPTED)
    assert.equal(render(verdict, WAIVERS).code, 0)
  })

  test('each sign-in waiver says what the shipped bundle holds of it', () => {
    assert.ok(WAIVERS['zod@3.25.76'].reason.includes('this copy is in privy-login.js'))
    assert.ok(WAIVERS['zod@3.22.4'].reason.includes('in the lock but not in privy-login.js'))
    assert.ok(WAIVERS['decode-uri-component@0.2.2'].reason.includes('neither package is in privy-login.js'))
  })

  test('at v0.0.8 every waiver has EXPIRED, and the gate is red', () => {
    const verdict = judgeIn(WAIVERS, '0.0.8')
    const { lines, code } = render(verdict, WAIVERS)

    assert.deepEqual(verdict.expired.map(e => e.id).sort(), Object.keys(WAIVERS).sort())
    assert.deepEqual(ids(verdict.failing), ACCEPTED)
    assert.equal(code, 1)
    assert.ok(
      lines.some(line => /^EXPIRED waiver zod@3\.25\.76: until v0\.0\.8/.test(line)),
      lines.join('\n')
    )
  })
})

describe('audit gate: a report says what npm audited, and an --omit=dev report is refused', () => {
  const unstamped = { ...structuredClone(TODAY) }
  delete unstamped.audited
  const ANSWERED = 'npm http fetch POST 200 https://registry.npmjs.org/-/npm/v1/security/advisories/bulk 311ms\n'

  test('npm audit --json --package-lock-only produced the fixtures: they say so', () => {
    assert.deepEqual(TODAY.audited, { args: ['audit', '--json', '--package-lock-only'] })
  })

  test('a report without the audited.args stamp cannot be judged', () => {
    assert.throws(
      () => judge(unstamped, LOCK),
      error => /cannot judge: the report does not say how npm audited it \(no "audited.args"\)/.test(error.message)
    )
    assert.throws(() => assertReportScope(unstamped, LOCK, NODES), /--save <file>/)
  })

  test('a report audited with --omit=dev never saw electron (shipped, a devDependency): refused by name', () => {
    for (const args of [
      ['audit', '--json', '--omit=dev'],
      ['audit', '--json', '--omit', 'dev'],
      ['audit', '--json', '--omit=optional,dev']
    ]) {
      assert.throws(
        () => judge(stampAudited(TODAY, args), LOCK),
        error =>
          /cannot judge: the report was audited with --omit=.*dev.*, which leaves out \d+ shipped package\(s\) \(.*electron@44\.10\.1/.test(
            error.message
          ) && / run npm audit --json without --omit$/.test(error.message),
        args.join(' ')
      )
    }
  })

  test('--omit=peer leaves out no shipped package of this lock, so it is judged', () => {
    assert.equal(
      [...NODES.keys()].some(node => LOCK.packages[node]?.peer),
      false
    )
    assert.doesNotThrow(() => judge(stampAudited(TODAY, ['audit', '--json', '--omit=peer']), LOCK))
  })

  test('omittedClasses reads every spelling', () => {
    assert.deepEqual(
      [...omittedClasses(['audit', '--omit=dev', '--omit', 'optional', '--omit=peer,dev'])],
      ['dev', 'optional', 'peer']
    )
    assert.deepEqual([...omittedClasses(AUDIT_ARGS)], [])
  })

  test('runAudit stamps the report with the arguments it ran, --include for every class among them', () => {
    const { report } = runAudit(scratch, () => ({ status: 1, stdout: JSON.stringify(unstamped), stderr: ANSWERED }))

    assert.deepEqual(report.audited.args, [...AUDIT_ARGS, `--registry=${expectedRegistry(scratch)}`])
    assert.ok(
      ['--include=dev', '--include=optional', '--include=peer'].every(flag => report.audited.args.includes(flag))
    )
    assert.deepEqual(judge(report, LOCK).failing, [])
  })

  test('the command line: an --omit=dev report exits 2 with the reason; an unstamped one too', () => {
    const omitted = runGate(stampAudited(TODAY, ['audit', '--json', '--omit=dev']))

    assert.equal(omitted.status, 2, omitted.stdout + omitted.stderr)
    assert.match(omitted.stderr, /\[audit-gate\] cannot judge: the report was audited with --omit=dev/)
    assert.doesNotMatch(omitted.stdout, /GREEN/)

    const bare = runGate(unstamped)

    assert.equal(bare.status, 2, bare.stdout + bare.stderr)
    assert.match(bare.stderr, /no "audited\.args"/)
  })
})

describe('audit gate (G-42, v0.0.5): the optional ACP CLI lock is judged, with two explicit waivers', () => {
  const DIR = 'apps/desktop/acp-cli-lock'
  // `npm audit --json --package-lock-only` of apps/desktop/acp-cli-lock/package-lock.json, 2026-11-04, run by the
  // gate's runAudit (stamped; the registry answered 200).
  const REPORT = JSON.parse(fs.readFileSync(path.join(FIXTURES, ACP_FIXTURE[DIR]), 'utf8'))
  const LOCK_IN = JSON.parse(fs.readFileSync(path.join(REPO, DIR, 'package-lock.json'), 'utf8'))
  const WAIVERS = ACP_LOCKS[DIR]
  const ZOD = 'zod@3.25.76'
  const ACP_NODE = '@virtuals-protocol/acp-node@0.3.0-beta-subscription.2'
  const ACCEPTED = [`${ACP_NODE} ${ACP_NODE_NPM_ADVISORY}`, `${ZOD} GHSA-mrhx-c7xc-m3w5`]
  const judgeIn = (waived = WAIVERS, version = APP_VERSION, report = REPORT) =>
    judge(report, LOCK_IN, waived, version, lockNodes)
  const ids = list => list.map(f => `${f.id} ${f.advisory}`).sort()
  const without = id => Object.fromEntries(Object.entries(WAIVERS).filter(([key]) => key !== id))

  test('the ACP CLI lock is one of the gate targets, judged by its own lock and waivers, from the lock', () => {
    const target = gateTargets(REPO).find(t => t.label === DIR)

    assert.ok(target, 'apps/desktop/acp-cli-lock is not judged')
    assert.equal(target.dir, path.join(REPO, DIR))
    assert.equal(target.waived, WAIVERS)
    assert.equal(target.nodesOf, lockNodes)
    assert.deepEqual(target.extra, ['--package-lock-only'])
    assert.equal(Object.keys({ ...SUB_LOCKS, ...APP_LOCKS }).includes(DIR), false)
  })

  test('with the waivers it is green: exactly the zod high and its acp-node meta-advisory are waived', () => {
    const verdict = judgeIn()

    assert.deepEqual(
      [verdict.failing, verdict.stale, verdict.untied, verdict.expired, verdict.mismatched],
      [[], [], [], [], []]
    )
    assert.deepEqual(ids(verdict.waived), ACCEPTED)
    assert.deepEqual(Object.keys(WAIVERS).sort(), [ACP_NODE, ZOD])

    const { lines, code } = render(verdict, WAIVERS)

    assert.equal(code, 0, lines.join('\n'))
    assert.match(lines.at(-1), /GREEN: .* 0 failing, 2 waived, 0 stale/)
  })

  test('without the waivers it is red, and the gate names both findings', () => {
    const verdict = judgeIn({})

    assert.deepEqual(ids(verdict.failing), ACCEPTED)
    assert.equal(render(verdict, {}).code, 1)
  })

  for (const id of [ZOD, ACP_NODE]) {
    test(`without only the ${id} entry, that finding is red (mutant)`, () => {
      const rest = without(id)
      const verdict = judgeIn(rest)

      assert.deepEqual(
        ids(verdict.failing),
        ACCEPTED.filter(line => line.startsWith(`${id} `))
      )
      assert.equal(render(verdict, rest).code, 1)
    })
  }

  test("the acp-node waiver matches npm's id exactly: a different id is not waived, and the entry goes stale (red)", () => {
    const report = structuredClone(REPORT)
    const via = report.vulnerabilities['@virtuals-protocol/acp-node'].via.find(v => typeof v === 'object')

    via.source = `${via.source}x`
    const verdict = judgeIn(WAIVERS, APP_VERSION, report)
    const { lines, code } = render(verdict, WAIVERS)

    assert.deepEqual(ids(verdict.failing), [`${ACP_NODE} ${ACP_NODE_NPM_ADVISORY}x`])
    assert.deepEqual(verdict.stale, [{ id: ACP_NODE, advisory: ACP_NODE_NPM_ADVISORY }])
    assert.equal(code, 1)
    assert.ok(
      lines.some(line => line.startsWith(`STALE waiver ${ACP_NODE} `)),
      lines.join('\n')
    )
  })

  test('a waiver whose advisory id changed is stale and the real finding fails (fail-safe)', () => {
    const changed = {
      ...WAIVERS,
      [ZOD]: { ...WAIVERS[ZOD], advisories: { 'GHSA-xxxx-xxxx-xxxx': 'changed' } }
    }
    const verdict = judgeIn(changed)

    assert.deepEqual(ids(verdict.failing), [`${ZOD} GHSA-mrhx-c7xc-m3w5`])
    assert.deepEqual(verdict.stale, [{ id: ZOD, advisory: 'GHSA-xxxx-xxxx-xxxx' }])
    assert.equal(render(verdict, changed).code, 1)
  })

  test('a severity mismatch is refused: red', () => {
    for (const id of [ZOD, ACP_NODE]) {
      const rerated = { ...WAIVERS, [id]: { ...WAIVERS[id], severity: 'critical' } }
      const verdict = judgeIn(rerated)

      assert.deepEqual(
        verdict.mismatched.map(m => `${m.id} ${m.accepted} ${m.severity}`),
        [`${id} critical high`]
      )
      assert.equal(render(verdict, rerated).code, 1, id)
    }
  })

  test('each waiver stores high, names its advisory, the reason, the worst case, the owner decision and its date', () => {
    const expected = { [ZOD]: 'GHSA-mrhx-c7xc-m3w5', [ACP_NODE]: ACP_NODE_NPM_ADVISORY }

    for (const [id, advisory] of Object.entries(expected)) {
      const entry = WAIVERS[id]

      assert.equal(entry.severity, 'high', id)
      assert.deepEqual(Object.keys(entry.advisories), [advisory], id)

      for (const text of [
        'no compatible fix',
        'GHSA-mrhx-c7xc-m3w5',
        'only the optional ACP CLI',
        'runs out of memory or stalls',
        'no data or code is exposed',
        'accepted by the owner 2026-11-03/04',
        're-decided 2026-11-05 for v0.0.6 by the security review; removed when a compatible fix exists',
        're-reviewed 2026-11-10 for v0.0.7: still no compatible fix'
      ]) {
        assert.ok(entry.reason.includes(text), `${id}: ${text}`)
      }

      assert.ok(entry.until.includes('re-decided each release; removed when a compatible fix exists'), id)
      assert.ok(entry.until.includes('backlog: move the ACP CLI to acp-node-v2'), id)
      assert.ok(entry.until.includes('still needs zod 3 through @account-kit/infra'), id)
      assert.deepEqual(untilVersion(entry.until), [0, 0, 8], id)
    }

    for (const text of ['@account-kit/infra', '@aa-sdk/core', 'acp-node-v2']) {
      assert.ok(WAIVERS[ACP_NODE].reason.includes(text), text)
    }
  })

  test('at v0.0.7 both waivers still apply, and the gate is green: the re-decision of this release', () => {
    const verdict = judgeIn(WAIVERS, '0.0.7')

    assert.deepEqual([verdict.failing, verdict.stale, verdict.untied, verdict.expired], [[], [], [], []])
    assert.deepEqual(ids(verdict.waived), ACCEPTED)
    assert.equal(render(verdict, WAIVERS).code, 0)
  })

  test('at v0.0.8 both waivers have EXPIRED, and the gate is red', () => {
    const verdict = judgeIn(WAIVERS, '0.0.8')
    const { lines, code } = render(verdict, WAIVERS)

    assert.deepEqual(verdict.expired.map(e => e.id).sort(), Object.keys(WAIVERS).sort())
    assert.deepEqual(ids(verdict.failing), ACCEPTED)
    assert.equal(code, 1)
    assert.ok(
      lines.some(line => /^EXPIRED waiver zod@3\.25\.76: until v0\.0\.8/.test(line)),
      lines.join('\n')
    )
  })
})

describe('audit gate (v0.0.5): the ACP lock waives a RE-KEYED npm synthetic id only through already-waived GHSAs', () => {
  // npm builds acp-node's synthetic id from whichever vulnerable dependency it resolves first (@aa-sdk/core or
  // @account-kit/infra, both only through zod): the same lock gives one of two ids from run to run. The re-keyed
  // fixture is a real run of the same lock on 2026-11-04 (v005/work/v005rel-acpgate/today/REKEY_CHECK.md).
  const DIR = 'apps/desktop/acp-cli-lock'
  const OLD = JSON.parse(fs.readFileSync(path.join(FIXTURES, ACP_FIXTURE[DIR]), 'utf8'))
  const NEW = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'npm-audit-acp-cli-lock-2026-11-04-rekeyed.json'), 'utf8'))
  const LOCK_IN = JSON.parse(fs.readFileSync(path.join(REPO, DIR, 'package-lock.json'), 'utf8'))
  const WAIVERS = ACP_LOCKS[DIR]
  const ACP_NODE = '@virtuals-protocol/acp-node@0.3.0-beta-subscription.2'
  const synth = report => report.vulnerabilities['@virtuals-protocol/acp-node'].via.find(v => typeof v === 'object')
  const judgeAcp = (report, waived = WAIVERS, matchSynthetic = true) =>
    judge(report, LOCK_IN, waived, APP_VERSION, lockNodes, { matchSynthetic })
  const ids = list => list.map(f => `${f.id} ${f.advisory}`).sort()

  test('the re-keyed fixture really carries a different synthetic id on the same name@version', () => {
    assert.notEqual(synth(NEW).source, synth(OLD).source)
    assert.equal(`npm-${synth(OLD).source}`, ACP_NODE_NPM_ADVISORY)
    assert.equal(synth(NEW).severity, 'high')
  })

  test('only the ACP lock judges with matchSynthetic; every other target keeps exact matching', () => {
    for (const target of gateTargets(REPO)) {
      assert.equal(target.matchSynthetic === true, target.label === DIR, String(target.label))
    }
  })

  test('(a) the old id: green, 2 waived, 0 stale', () => {
    const verdict = judgeAcp(OLD)

    assert.deepEqual([verdict.failing, verdict.stale, verdict.mismatched], [[], [], []])
    assert.equal(verdict.waived.length, 2)
    assert.equal(render(verdict, WAIVERS).code, 0)
  })

  test('(b) the re-keyed id: green, 2 waived, 0 stale (the synthetic waiver is used, not STALE)', () => {
    const verdict = judgeAcp(NEW)
    const { lines, code } = render(verdict, WAIVERS)

    assert.deepEqual([verdict.failing, verdict.stale, verdict.mismatched], [[], [], []], lines.join('\n'))
    assert.equal(verdict.waived.length, 2)
    assert.ok(verdict.waived.some(w => w.id === ACP_NODE && /re-keyed/.test(w.reason)))
    assert.equal(code, 0, lines.join('\n'))
  })

  test('without matchSynthetic the re-keyed id fails and the waiver is STALE (the exact rule elsewhere is unchanged)', () => {
    const verdict = judgeAcp(NEW, WAIVERS, false)

    assert.deepEqual(ids(verdict.failing), [`${ACP_NODE} npm-${synth(NEW).source}`])
    assert.deepEqual(verdict.stale, [{ id: ACP_NODE, advisory: ACP_NODE_NPM_ADVISORY }])
    assert.equal(render(verdict, WAIVERS).code, 1)
  })

  test('(c) a re-keyed synthetic finding with a different severity is red', () => {
    const report = structuredClone(NEW)

    synth(report).severity = 'critical'
    const verdict = judgeAcp(report)

    assert.deepEqual(ids(verdict.failing), [`${ACP_NODE} npm-${synth(report).source}`])
    assert.equal(render(verdict, WAIVERS).code, 1)
  })

  test('(d) a chain reaching an UNWAIVED high GHSA is red: the synthetic finding is not waived', () => {
    const report = structuredClone(NEW)

    report.vulnerabilities['@aa-sdk/core'].via.push({
      source: 999999,
      name: '@aa-sdk/core',
      title: 'a new upstream advisory',
      url: 'https://github.com/advisories/GHSA-2222-3333-4444',
      severity: 'high',
      range: '*'
    })
    const verdict = judgeAcp(report)

    assert.ok(ids(verdict.failing).includes(`${ACP_NODE} npm-${synth(report).source}`), ids(verdict.failing).join('\n'))
    assert.equal(render(verdict, WAIVERS).code, 1)
  })

  test('(d2) a chain that cannot be followed (a named package missing from the report) is red', () => {
    const report = structuredClone(NEW)

    report.vulnerabilities['@virtuals-protocol/acp-node'].via.push('not-in-the-report')
    const verdict = judgeAcp(report)

    assert.ok(ids(verdict.failing).includes(`${ACP_NODE} npm-${synth(report).source}`))
  })

  test('(d3) a chain that reaches NO high GHSA at all (only a low advisory) is red: nothing ties it to a waiver', () => {
    const report = structuredClone(NEW)
    const via = report.vulnerabilities['@virtuals-protocol/acp-node'].via

    report.vulnerabilities['@virtuals-protocol/acp-node'].via = ['elliptic', ...via.filter(v => typeof v === 'object')]
    assert.equal(chainAdvisories(report, '@virtuals-protocol/acp-node').size, 0)
    const verdict = judgeAcp(report)

    assert.ok(ids(verdict.failing).includes(`${ACP_NODE} npm-${synth(report).source}`), ids(verdict.failing).join('\n'))
  })

  test('(e) a synthetic id on ANOTHER package@version is red (no waiver of its own)', () => {
    const report = structuredClone(NEW)
    const core = report.vulnerabilities['@aa-sdk/core']

    core.via.push({
      source: 'zzz-synthetic',
      name: '@aa-sdk/core',
      title: 'Depends on vulnerable versions of zod',
      url: null,
      severity: 'high',
      range: '*'
    })
    const verdict = judgeAcp(report)
    const id = lockNodes(LOCK_IN).get(core.nodes[0])

    assert.ok(ids(verdict.failing).includes(`${id} npm-zzz-synthetic`), ids(verdict.failing).join('\n'))
    assert.equal(render(verdict, WAIVERS).code, 1)
  })

  test('(f) a really stale synthetic waiver is still STALE: the package has no finding at all', () => {
    const report = structuredClone(NEW)

    delete report.vulnerabilities['@virtuals-protocol/acp-node']
    const verdict = judgeAcp(report)

    assert.deepEqual(verdict.stale, [{ id: ACP_NODE, advisory: ACP_NODE_NPM_ADVISORY }])
    assert.equal(render(verdict, WAIVERS).code, 1)
  })

  test('(f2) a synthetic waiver for a package@version with no finding is STALE, re-key or not', () => {
    const extra = {
      ...WAIVERS,
      'left-pad@1.0.0': { ...WAIVERS[ACP_NODE], advisories: { 'npm-abc': 'not present' } }
    }
    const verdict = judgeAcp(NEW, extra)

    assert.ok(verdict.stale.some(s => s.id === 'left-pad@1.0.0'))
    assert.equal(render(verdict, extra).code, 1)
  })

  test('(g) the zod GHSA waiver itself is still exact: removing it makes zod AND the re-keyed acp-node red', () => {
    const rest = Object.fromEntries(Object.entries(WAIVERS).filter(([id]) => id !== 'zod@3.25.76'))
    const verdict = judgeAcp(NEW, rest)

    assert.ok(ids(verdict.failing).includes('zod@3.25.76 GHSA-mrhx-c7xc-m3w5'))
    assert.ok(ids(verdict.failing).includes(`${ACP_NODE} npm-${synth(NEW).source}`))
  })
})

describe("audit gate (v0.0.5, lens r2): the synthetic match accepts ONLY npm's own synthetic shape", () => {
  const DIR = 'apps/desktop/acp-cli-lock'
  const NEW = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'npm-audit-acp-cli-lock-2026-11-04-rekeyed.json'), 'utf8'))
  const LOCK_IN = JSON.parse(fs.readFileSync(path.join(REPO, DIR, 'package-lock.json'), 'utf8'))
  const WAIVERS = ACP_LOCKS[DIR]
  const ACP_NODE = '@virtuals-protocol/acp-node@0.3.0-beta-subscription.2'
  const NAME = '@virtuals-protocol/acp-node'
  const synth = report => report.vulnerabilities[NAME].via.find(v => typeof v === 'object')
  const judgeAcp = (report, waived = WAIVERS) =>
    judge(report, LOCK_IN, waived, APP_VERSION, lockNodes, { matchSynthetic: true })
  const ids = list => list.map(f => `${f.id} ${f.advisory}`).sort()
  const realNoGhsa = name => ({
    source: 1234567,
    name,
    title: 'a real npm advisory without a GHSA',
    url: null,
    severity: 'high',
    range: '*'
  })

  test("npm's own entry has the synthetic shape; a real advisory (integer source) never does", () => {
    assert.equal(isNpmSyntheticVia(synth(NEW)), true)
    assert.equal(isNpmSyntheticVia(realNoGhsa(NAME)), false)
    assert.equal(isNpmSyntheticVia({ ...synth(NEW), url: 'https://github.com/advisories/GHSA-2222-3333-4444' }), false)
    assert.equal(isNpmSyntheticVia({ ...synth(NEW), title: 'Prototype pollution' }), false)
    assert.equal(isSyntheticAdvisory('npm-1234567'), false)
    assert.equal(isSyntheticAdvisory('npm-OPmtdP9I5g2b'), true)
  })

  test('(M-1a) a REAL high advisory without a GHSA on acp-node itself is red, never waived as "re-keyed"', () => {
    const report = structuredClone(NEW)

    report.vulnerabilities[NAME].via.push(realNoGhsa(NAME))
    const verdict = judgeAcp(report)

    assert.ok(ids(verdict.failing).includes(`${ACP_NODE} npm-1234567`), ids(verdict.failing).join('\n'))
    assert.equal(render(verdict, WAIVERS).code, 1)
  })

  test('(M-1b) a REAL high non-GHSA advisory down the chain refuses the synthetic match: red', () => {
    const report = structuredClone(NEW)

    report.vulnerabilities['@aa-sdk/core'].via.push(realNoGhsa('@aa-sdk/core'))
    assert.equal(chainAdvisories(report, NAME), null)
    const verdict = judgeAcp(report)

    assert.ok(ids(verdict.failing).includes(`${ACP_NODE} npm-${synth(report).source}`), ids(verdict.failing).join('\n'))
  })

  test("a real advisory (integer source) with npm's synthetic TITLE is still not synthetic: red", () => {
    const report = structuredClone(NEW)

    // REPLACE npm's own entry (so the one-per-waiver limit cannot be what refuses it): only the shape decides.
    report.vulnerabilities[NAME].via = [
      ...report.vulnerabilities[NAME].via.filter(v => typeof v === 'string'),
      { ...realNoGhsa(NAME), title: `Depends on vulnerable versions of zod` }
    ]
    const verdict = judgeAcp(report)

    assert.ok(ids(verdict.failing).includes(`${ACP_NODE} npm-1234567`), ids(verdict.failing).join('\n'))
  })

  test('an absent __proto__ in the chain is unfollowable (own keys only): refused', () => {
    const report = structuredClone(NEW)

    report.vulnerabilities[NAME].via.push('__proto__')
    assert.equal(chainAdvisories(report, NAME), null)
    assert.ok(ids(judgeAcp(report).failing).includes(`${ACP_NODE} npm-${synth(report).source}`))
  })

  test('a chain naming a prototype key (constructor) is unfollowable: refused', () => {
    const report = structuredClone(NEW)

    report.vulnerabilities[NAME].via.push('constructor')
    assert.equal(chainAdvisories(report, NAME), null)
    assert.ok(ids(judgeAcp(report).failing).includes(`${ACP_NODE} npm-${synth(report).source}`))
  })

  test('a cycle in the chain ends, and the chain is still judged (a cycle through the waived zod GHSA is green)', () => {
    const report = structuredClone(NEW)

    report.vulnerabilities['@aa-sdk/core'].via.push(NAME)
    const chain = chainAdvisories(report, NAME)

    assert.deepEqual([...chain], ['GHSA-mrhx-c7xc-m3w5'])
    assert.deepEqual(judgeAcp(report).failing, [])
  })

  test('one synthetic waiver ties at most ONE synthetic finding: a second synthetic entry on acp-node is red', () => {
    const report = structuredClone(NEW)

    report.vulnerabilities[NAME].via.push({ ...synth(report), source: 'another-hash' })
    const verdict = judgeAcp(report)

    assert.deepEqual(
      ids(verdict.failing).filter(line => line.startsWith(ACP_NODE)).length,
      1,
      ids(verdict.failing).join('\n')
    )
    assert.equal(render(verdict, WAIVERS).code, 1)
  })

  test('the matched reason says the chain rule is high/critical through waived GHSAs', () => {
    const accepted = judgeAcp(NEW).waived.find(w => w.id === ACP_NODE)

    assert.match(accepted.reason, /every high\/critical advisory in its chain is a GHSA waived in this lock/)
  })
})
