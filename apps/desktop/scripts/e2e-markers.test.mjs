// v0.0.9 e2e harness (owner condition): the e2e-only handshake and seed never leave apps/desktop/e2e/. The consent
// seed's marker, the ready-claim API and the per-test annotations exist for the Playwright harness alone; any of them
// in app code, a script, the runtime or a plugin would mean a test seam reached what ships. This gate greps every file
// git tracks. The markers are built from parts so this file never carries them whole.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(DESKTOP, '..', '..')
const E2E_DIR = 'apps/desktop/e2e/'
const SELF = 'apps/desktop/scripts/e2e-markers.test.mjs'

const MARKERS = [
  ['iclone-e2e-', 'consent-seed'],
  ['e2e', 'Seed'],
  ['reached', '-ready'],
  ['non-ready', '-by-design'],
  ['claim', 'Booted'],
  ['claim', 'NonReady'],
  ['assertE2e', 'Python'],
  ['ready-', 'state']
].map(parts => parts.join(''))

function tracked() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean)
}

/** Files outside e2e/ (and not this gate) that name a marker: [file, marker][]. */
export function markerLeaks(files, read) {
  const leaks = []

  for (const file of files) {
    if (file.startsWith(E2E_DIR) || file === SELF) {
      continue
    }

    const text = read(file)

    if (text === null) {
      continue
    }

    for (const marker of MARKERS) {
      if (text.includes(marker)) {
        leaks.push([file, marker])
      }
    }
  }

  return leaks
}

const readText = file => {
  try {
    const full = path.join(REPO, file)
    const stat = fs.statSync(full)

    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) {
      return null
    }

    const buf = fs.readFileSync(full)

    return buf.includes(0) ? null : buf.toString('utf8')
  } catch {
    return null
  }
}

describe('e2e-only markers stay inside apps/desktop/e2e/', () => {
  it('the harness itself defines them (the gate is not vacuous)', () => {
    const seed = fs.readFileSync(path.join(DESKTOP, 'e2e', 'consent-seed.ts'), 'utf8')
    const ready = fs.readFileSync(path.join(DESKTOP, 'e2e', 'ready-state.ts'), 'utf8')

    expect(seed).toContain(MARKERS[0])
    expect(ready).toContain(MARKERS[2])
    expect(ready).toContain(MARKERS[4])
  })

  it('no tracked file outside e2e/ names any of them', () => {
    expect(markerLeaks(tracked(), readText)).toEqual([])
  })

  it('a marker planted in app code is caught', () => {
    const planted = { 'apps/desktop/src/main.tsx': `const x = '${MARKERS[0]}'`, 'apps/desktop/e2e/ok.ts': MARKERS[0] }

    expect(markerLeaks(Object.keys(planted), file => planted[file])).toEqual([['apps/desktop/src/main.tsx', MARKERS[0]]])
  })
})

describe('the e2e fail-closed check names the app\'s own gate title', () => {
  it('GATE_TITLE in e2e/readiness.ts equals boot.failure.gateTitle', async () => {
    const { boot } = await import('../src/i18n/en/boot.ts')
    const readiness = fs.readFileSync(path.join(DESKTOP, 'e2e', 'readiness.ts'), 'utf8')

    expect(readiness).toContain(`export const GATE_TITLE = '${boot.failure.gateTitle}'`)
  })
})

describe('the e2e consent seed is the app\'s own accepted record', () => {
  it('the seed passes the app\'s validator, carries the bundled policy version, and reads as "ok" (no dialog)', async () => {
    const consent = await import('../electron/iclone-consent.ts')
    const { BUNDLED_POLICY } = await import('../electron/policy-version.generated.ts')
    const { consentSeed } = await import('../e2e/consent-seed.ts')
    const seed = consentSeed(new Date('2026-11-18T20:00:00.000Z'))

    expect(consent.isConsentRecord(seed)).toBe(true)
    expect(seed.policyVersion).toBe(BUNDLED_POLICY.version)
    expect(seed.policyEffective).toBe(BUNDLED_POLICY.effective)
    expect(consent.consentState(seed)).toBe('ok')
    expect(Object.keys(consent.setupDecisions(seed)).sort()).toEqual([...consent.SETUP_SECTIONS].sort())
  })
})


describe('the e2e ready claim (e2e/ready-state.ts), the logic the Playwright afterEach reads', () => {
  it('booted starts not ready; waitForAppReady marks it; non-ready carries its reason; a bare launch is unclaimed', async () => {
    const ready = await import('../e2e/ready-state.ts')

    ready.setSpecFileSource(() => 'a.spec.ts')
    ready.resetClaims()
    ready.noteLaunch()
    expect(ready.launchWasUnclaimed()).toBe(true)

    ready.claimBooted()
    expect(ready.launchWasUnclaimed()).toBe(false)
    expect(ready.currentClaim()).toEqual({ file: 'a.spec.ts', kind: 'booted', ready: false })
    ready.markReady()
    expect(ready.currentClaim()).toEqual({ file: 'a.spec.ts', kind: 'booted', ready: true })

    // A relaunch (unread-dot-restart) is a new booted claim: it must reach ready again.
    ready.claimBooted()
    expect(ready.currentClaim()).toEqual({ file: 'a.spec.ts', kind: 'booted', ready: false })

    ready.claimNonReady('boot failure by design')
    ready.markReady()
    expect(ready.currentClaim()).toEqual({ file: 'a.spec.ts', kind: 'non-ready', reason: 'boot failure by design' })
    ready.resetClaims()
    expect(ready.currentClaim()).toBeNull()
  })

  // v0.0.9 eng G2-m1: a worker runs many spec files; a claim or a launch from one never answers for the next.
  it('a claim or an unclaimed launch made in another spec file is not seen', async () => {
    const ready = await import('../e2e/ready-state.ts')
    let file = 'a.spec.ts'

    ready.setSpecFileSource(() => file)
    ready.resetClaims()
    ready.claimBooted()
    ready.markReady()
    file = 'b.spec.ts'
    expect(ready.currentClaim()).toBeNull()
    ready.markReady()
    file = 'a.spec.ts'
    expect(ready.currentClaim()).toEqual({ file: 'a.spec.ts', kind: 'booted', ready: true })

    ready.resetClaims()
    ready.noteLaunch()
    file = 'b.spec.ts'
    expect(ready.launchWasUnclaimed()).toBe(false)
    ready.resetClaims()
  })
})

// G-m5: readiness is per test; a booted claim never carries "ready" into the next test.
describe('per-test readiness (G-m5)', () => {
  it('startTest takes a booted claim back to not-ready; a non-ready claim is untouched', async () => {
    const ready = await import('../e2e/ready-state.ts')

    ready.setSpecFileSource(() => 'a.spec.ts')
    ready.resetClaims()
    ready.claimBooted()
    ready.markReady()
    ready.startTest()
    expect(ready.currentClaim()).toEqual({ file: 'a.spec.ts', kind: 'booted', ready: false })

    ready.claimNonReady('onboarding')
    ready.startTest()
    expect(ready.currentClaim()).toEqual({ file: 'a.spec.ts', kind: 'non-ready', reason: 'onboarding' })
    ready.resetClaims()
  })

  // v0.0.9 eng G2-m1: the guard is ONE auto fixture, so it runs for every test in every spec file (module-level
  // hooks were attached to the first file per worker only).
  it('test.ts re-proves readiness at the start of every test, from the live page, in an auto fixture', () => {
    const test = fs.readFileSync(path.join(DESKTOP, 'e2e', 'test.ts'), 'utf8')

    expect(test).toMatch(/readyGuard: \[[\s\S]*?async \(\{\}, use, testInfo\) => \{\s*errorBannersAllowed = false\s*startTest\(\)/)
    expect(test).toContain("judgeReadiness(await readinessFacts(page)) === 'ready'")
    expect(test).toMatch(/\{ auto: true \}/)
    expect(test).not.toMatch(/base\.(beforeEach|afterEach|afterAll)\(/)
  })
})

// v0.0.9 G-M1: the agent refuses a model under 64,000 tokens; the e2e mock provider must clear it.
describe('the e2e mock provider window', () => {
  it('advertises at least 64,000 tokens, and no 4,096 window is left in the fixtures', () => {
    const fixtures = fs.readFileSync(path.join(DESKTOP, 'e2e', 'fixtures.ts'), 'utf8')
    const value = Number(/export const E2E_MOCK_CONTEXT = ([\d_]+)/.exec(fixtures)?.[1].replaceAll('_', ''))

    expect(value).toBeGreaterThanOrEqual(64_000)
    expect(fixtures).not.toMatch(/context_length: 4096/)
    expect(fixtures.match(/context_length: \$\{E2E_MOCK_CONTEXT\}/g)).toHaveLength(2)
  })
})

describe('the end-of-run summary line (G)', () => {
  it('counts booted, reached-ready, unclaimed, non-ready, and the passed-but-never-ready false pass', async () => {
    const { readySummary } = await import('../e2e/ready-reporter.ts')
    const row = (over = {}) => ({ booted: false, ready: false, unclaimed: false, nonReady: false, passed: true, ran: true, ...over })

    expect(
      readySummary([
        row({ booted: true, ready: true }),
        row({ booted: true, ready: true }),
        row({ booted: true, ready: false, passed: false }),
        row({ nonReady: true })
      ])
    ).toBe(
      '[e2e-ready] booted 3, reached-ready 2, unclaimed 0, non-ready-by-design 1, passed-booted-not-ready 0, ran 4, unaccounted 0'
    )
    expect(readySummary([row({ booted: true, passed: true })])).toMatch(/passed-booted-not-ready 1,/)
  })

  // v0.0.9 eng G2-m1: the line accounts for EVERY test that ran; booted + non-ready = ran when nothing is unaccounted.
  it('counts the tests that ran and names those no claim accounts for', async () => {
    const { readySummary } = await import('../e2e/ready-reporter.ts')
    const row = (over = {}) => ({ booted: false, ready: false, unclaimed: false, nonReady: false, passed: true, ran: true, ...over })

    const partial = readySummary([row({ booted: true, ready: true }), row({ nonReady: true }), row(), row({ ran: false })])

    expect(partial).toMatch(/\bran 3\b/)
    expect(partial).toMatch(/\bunaccounted 1$/)

    const whole = readySummary([row({ booted: true, ready: true }), row({ nonReady: true }), row({ ran: false })])

    expect(whole).toMatch(/\bran 2, unaccounted 0$/)
  })

  it('the reporter is registered in the Playwright config', () => {
    const config = fs.readFileSync(path.join(DESKTOP, 'playwright.config.ts'), 'utf8')

    expect(config).toContain("['./e2e/ready-reporter.ts']")
  })
})


// v0.0.9 (owner decision 2, eng delta D-m1): no test run ever reaches the developer's real macOS keychain. safeStorage
// would create and prompt for a real "Safe Storage" item, so EVERY tracked script under apps/desktop and tests/** that
// launches Electron passes Chromium's mock keychain, and no test or e2e file runs the security CLI (one allowed
// confinement probe, by exact file:line).
const MOCK = '--use-mock-keychain'

/** Every tracked JS/TS source under apps/desktop and tests/** (the launch scan's scope), minus this gate. */
export function launchScope(files) {
  return files.filter(
    file => file !== SELF && (file.startsWith('apps/desktop/') || file.startsWith('tests/')) && /\.(?:[cm]?[jt]sx?)$/.test(file)
  )
}

/** Tracked files that are tests or e2e code: all of tests/**, apps/desktop/e2e/**, and *.test.* / *.spec.* files. */
export function testFiles(files) {
  return files.filter(
    file =>
      file !== SELF &&
      /\.(?:[cm]?[jt]sx?|py|sh|ps1)$/.test(file) &&
      (file.startsWith('tests/') ||
        file.startsWith(E2E_DIR) ||
        /(?:^|\/)tests?\//.test(file) ||
        /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) ||
        /(?:^|\/)test_[^/]*\.py$/.test(file))
  )
}

/** The text of the call that starts at `open` (an index of its "("), up to the matching ")". */
function callText(text, open) {
  let depth = 0

  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') {
      depth += 1
    } else if (text[i] === ')') {
      depth -= 1

      if (depth === 0) {
        return text.slice(open, i + 1)
      }
    }
  }

  return text.slice(open)
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length

/** A Playwright launch, at any indent. */
const PLAYWRIGHT_LAUNCH = /_electron\.launch\s*\(/g
/** spawn/execFile/fork (also promisify(execFile)(...)) whose command is the Electron binary: electronBinary(), electronBin, require('electron'). */
const BINARY_LAUNCH =
  /\b(?:spawn|spawnSync|execFile|execFileSync|fork)\)?\s*\(\s*(?:String\(\s*)?(?:electron[A-Za-z]*\s*[(,)]|require\(\s*['"]electron['"]\s*\))/g

/**
 * Electron launches without the mock keychain: [file, line][]. A spawn that runs Electron as plain Node
 * (ELECTRON_RUN_AS_NODE) starts no Chromium and no safeStorage, so it is allowed by that reason even without the
 * flag. isolatedElectronArgs(...) is the install drivers' own argument builder, accepted only while smoke-env.mjs
 * itself adds the flag (checked below).
 */
export function launchesWithoutMockKeychain(files, read) {
  const missing = []

  for (const file of files) {
    const text = read(file)

    if (text === null || text === undefined) {
      continue
    }

    const sites = []

    for (const match of text.matchAll(PLAYWRIGHT_LAUNCH)) {
      sites.push(match.index + match[0].length - 1)
    }

    for (const match of text.matchAll(BINARY_LAUNCH)) {
      sites.push(match.index + match[0].search(/\(\s*(?:String\(\s*)?(?:electron|require)/))
    }

    for (const open of sites) {
      const call = callText(text, open)

      if (call.includes('ELECTRON_RUN_AS_NODE') || call.includes(MOCK) || call.includes('isolatedElectronArgs(')) {
        continue
      }

      missing.push([file, lineOf(text, open)])
    }
  }

  return missing
}

/** Every launch site the scan sees: [file, line][] (the non-vacuity check). */
export function launchSites(files, read) {
  const sites = []

  for (const file of files) {
    const text = read(file)

    if (text === null || text === undefined) {
      continue
    }

    for (const pattern of [PLAYWRIGHT_LAUNCH, BINARY_LAUNCH]) {
      for (const match of text.matchAll(pattern)) {
        sites.push([file, lineOf(text, match.index)])
      }
    }
  }

  return sites
}

const CALL = String.raw`\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|execa|execaSync|fork|run|Popen|check_output|check_call|call|system|getoutput|getstatusoutput|runConfined|runPlain)\)?\s*\(\s*\[?\s*(?:r|f)?`

/**
 * What counts as running the CLI:
 *  - a spawn/exec (JS) or subprocess/os (Python) call whose command, as a string or the first argv element, is the
 *    bare command or the binary by path;
 *  - a command-line string that starts with the binary by path and a subcommand ('/usr/bin/security list-...');
 *  - a shell-script line that runs it, bare or by path.
 * A path named only as data (a stub table that rewrites it, a fake runner comparing argv[0]) runs nothing.
 */
const SECURITY_CLI = [
  new RegExp(String.raw`${CALL}['"\`](?:/usr/bin/)?security(?:['"\`]|\s)`, 'g'),
  /['"`]\/usr\/bin\/security\s+[a-z][a-z-]*/g
]
const SECURITY_SHELL = /^[ \t]*(?:sudo\s+|command\s+|exec\s+)?(?:\/usr\/bin\/)?security\s+[a-z][a-z-]*/gm

/**
 * The one allowed hit, by exact file:line. seatbelt.live.test.ts runs the keychain CLI CONFINED, as a sandbox refusal
 * probe, and asserts exit 126 (refused by name) on the next lines, so a failed confinement turns the test red.
 */
export const SECURITY_CLI_ALLOWED = new Map([
  [
    'apps/desktop/electron/iclone-confinement/seatbelt.live.test.ts:181',
    'confinement refusal probe: runConfined(...) of the keychain CLI must exit 126 (refused by the profile); owner decision 19 Nov'
  ]
])

/** Test or e2e files that run the security CLI: "file:line"[] (deduplicated, in file order). */
export function securityCliCalls(files, read) {
  const calls = new Set()

  for (const file of files) {
    const text = read(file)

    if (text === null || text === undefined) {
      continue
    }

    const patterns = /\.(?:sh|ps1)$/.test(file) ? [...SECURITY_CLI, SECURITY_SHELL] : SECURITY_CLI

    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        calls.add(`${file}:${lineOf(text, match.index + match[0].search(/\S/))}`)
      }
    }
  }

  return [...calls]
}

describe('no test reaches the real keychain', () => {
  const all = tracked()
  const scope = launchScope(all)
  const tests = testFiles(all)

  it('the scans cover apps/desktop and tests/** (not vacuous)', () => {
    expect(scope.some(file => file.startsWith('tests/install/e2e-assets/'))).toBe(true)
    expect(scope.some(file => file.startsWith('apps/desktop/scripts/'))).toBe(true)
    expect(tests.some(file => file.startsWith(E2E_DIR))).toBe(true)
    expect(tests.some(file => file.startsWith('tests/') && file.endsWith('.py'))).toBe(true)
    expect(tests.some(file => file.startsWith('apps/desktop/electron/') && file.endsWith('.test.ts'))).toBe(true)
  })

  it('the launch scan sees every known launch (Playwright, spawnSync of electronBinary, promisify(execFile))', () => {
    const files = new Set(launchSites(scope, readText).map(([file]) => file))

    for (const file of [
      'apps/desktop/e2e/fixtures.ts',
      'apps/desktop/electron/main/gesture-locks-f1s.live.test.ts',
      'apps/desktop/electron/main/home-settings-gesture.live.test.ts',
      'apps/desktop/electron/main/home-settings-ipc.live.test.ts',
      'apps/desktop/electron/iclone-confinement/hardlinks.asar.electron.test.ts',
      'apps/desktop/scripts/dev-mock.mjs',
      'apps/desktop/scripts/perf/lib/launch.mjs',
      'apps/desktop/scripts/run-short-session-hang-repro.mjs',
      'tests/install/e2e-assets/desktop-smoke.ts',
      'tests/install/e2e-assets/drive-update.cjs',
      'tests/install/e2e-assets/launch-from-spec.mjs',
      'tests/install/e2e-assets/mac-bundled-update-driver.mjs'
    ]) {
      expect(files, file).toContain(file)
    }
  })

  it('every Electron launch under apps/desktop and tests/** carries --use-mock-keychain', () => {
    expect(launchesWithoutMockKeychain(scope, readText)).toEqual([])
  })

  it('the install drivers\' isolatedElectronArgs adds the flag itself', () => {
    const smokeEnv = fs.readFileSync(path.join(REPO, 'tests/install/e2e-assets/smoke-env.mjs'), 'utf8')
    const rest = smokeEnv.slice(smokeEnv.indexOf('export function isolatedElectronArgs'))
    const body = rest.slice(0, rest.indexOf('\n}'))

    expect(body).toMatch(new RegExp(String.raw`return \[[^\]]*'${MOCK}', \.\.\.args`))
  })

  it('no test or e2e file runs the security CLI (the one allowed probe, by exact file:line)', () => {
    const calls = securityCliCalls(tests, readText)

    expect(calls.filter(site => !SECURITY_CLI_ALLOWED.has(site))).toEqual([])
    // The allowance is exact: if the probe moves or goes, the gate says so instead of allowing a stale line.
    expect(calls.filter(site => SECURITY_CLI_ALLOWED.has(site))).toEqual([...SECURITY_CLI_ALLOWED.keys()])
  })

  it('the allowed probe asserts exit 126 right after running the CLI confined', () => {
    const lines = fs.readFileSync(path.join(DESKTOP, 'electron/iclone-confinement/seatbelt.live.test.ts'), 'utf8').split('\n')
    const after = lines.slice(180, 186).join('\n')

    expect(lines[180]).toContain("'/usr/bin/" + "security list-keychains'")
    expect(after).toContain('await world.runConfined(command)')
    expect(after).toContain('expect(outcome.code).toBe(126)')
  })

  it('planted offenders turn the gate red (test-only fixture)', () => {
    const planted = {
      'apps/desktop/e2e/a.spec.ts': "await _electron.launch({ args: [root, '--no-sandbox'] })",
      'apps/desktop/e2e/b.spec.ts': `await _electron.launch({ args: [root, '${MOCK}'] })`,
      'apps/desktop/electron/main/x.live.test.ts': "    const child = spawnSync(String(electronBinary()), [mainJs, '--user-data-dir=/u'], {})",
      'apps/desktop/electron/main/w.test.ts': "const { stdout } = await promisify(execFile)(\n  electronBinary(),\n  [entry]\n)",
      'apps/desktop/electron/y.test.ts': "execFile(electronBinary(), [script], { env: { ELECTRON_RUN_AS_NODE: '1' } })",
      'apps/desktop/scripts/v.mjs': "spawn(require('electron'), [root])",
      'apps/desktop/src/c.tsx': '// before every spawn (electron/iclone-display-language.ts)',
      'tests/install/z.mjs': 'const app = await _electron.launch(launch)',
      'tests/a/test_k.py': "subprocess.run(['security', 'find-generic-password', '-s', 'x'])",
      'tests/b.sh': 'security list-keychains -d user\n',
      'apps/desktop/electron/k.test.ts': "execFileSync('/usr/bin/" + "security', ['dump-keychain'])",
      'apps/desktop/electron/l.test.ts': "spawn('security', ['find-identity'])",
      'apps/desktop/electron/n.test.ts': 'execSync(`security find-generic-password -s x`)',
      'apps/desktop/electron/o.test.ts': "const cmd = '/usr/bin/" + "security find-identity -v'",
      'apps/desktop/scripts/m.test.mjs': "world.index('security unlock-keychain')",
      'tests/c/test_fake.py': "if cmd[0] == '/usr/bin/" + "security' and cmd[1] == 'import':",
      'tests/d/test_p.py': "subprocess.check_output(['/usr/bin/" + "security', 'list-keychains'])"
    }
    const read = file => planted[file]
    const files = Object.keys(planted)

    expect(launchesWithoutMockKeychain(files, read)).toEqual([
      ['apps/desktop/e2e/a.spec.ts', 1],
      ['apps/desktop/electron/main/x.live.test.ts', 1],
      ['apps/desktop/electron/main/w.test.ts', 1],
      ['apps/desktop/scripts/v.mjs', 1],
      ['tests/install/z.mjs', 1]
    ])
    expect(securityCliCalls(files, read).filter(site => !SECURITY_CLI_ALLOWED.has(site))).toEqual([
      'tests/a/test_k.py:1',
      'tests/b.sh:1',
      'apps/desktop/electron/k.test.ts:1',
      'apps/desktop/electron/l.test.ts:1',
      'apps/desktop/electron/n.test.ts:1',
      'apps/desktop/electron/o.test.ts:1',
      'tests/d/test_p.py:1'
    ])
  })
})

// v0.0.9 (eng delta D-m2): every e2e N/A is one row of apps/desktop/e2e/NA.tsv (the G gate reads it), and every
// row is a real skipped test: same spec, same title, declared on that line, skipped with an "N/A in v0.0.9" reason
// naming the upstream feature. No silent skip, no stale row.
const NA_MARK = 'N/A in v0.0.9'

/** The N/A skips in e2e/: [spec, line of the test() declaration, title][]. */
export function naSkips(files) {
  const found = []

  for (const [name, text] of files) {
    const lines = text.split('\n')

    lines.forEach((line, index) => {
      // test.skip(true, '<reason>') on one line, or split over the next few lines (prettier wraps long reasons).
      const call = line.includes('test.skip(') ? lines.slice(index, index + 4).join(' ') : ''

      if (!/test\.skip\(\s*true\s*,/.test(call) || !call.includes(NA_MARK)) {
        return
      }

      for (let back = index; back >= 0; back -= 1) {
        const declared = /^\s*test\('([^']+)'/.exec(lines[back])

        if (declared) {
          found.push([name, back + 1, declared[1]])

          return
        }
      }

      found.push([name, 0, ''])
    })
  }

  return found
}

describe('e2e N/A (v0.0.9) is one machine-readable table', () => {
  // NA.tsv plus any NA.<writer>.tsv (parallel writers' tables, same header), read as one table.
  const tables = fs
    .readdirSync(path.join(DESKTOP, 'e2e'))
    .filter(name => /^NA(?:\.[\w-]+)?\.tsv$/.test(name))
    .sort()
    .map(name => fs.readFileSync(path.join(DESKTOP, 'e2e', name), 'utf8').trim().split('\n').map(line => line.split('\t')))
  const header = tables[0]?.[0] ?? []
  const rows = tables.flatMap(([, ...body]) => body)
  const specs = fs
    .readdirSync(path.join(DESKTOP, 'e2e'))
    .filter(name => name.endsWith('.spec.ts'))
    .map(name => [name, fs.readFileSync(path.join(DESKTOP, 'e2e', name), 'utf8')])

  it('the header and every row have the six columns, none empty', () => {
    expect(tables.length).toBeGreaterThan(0)

    for (const [head] of tables) {
      expect(head).toEqual(['spec', 'line', 'test', 'upstream feature', 'why absent', 'evidence'])
    }

    expect(header).toEqual(['spec', 'line', 'test', 'upstream feature', 'why absent', 'evidence'])

    for (const row of rows) {
      expect(row, row.join(' | ')).toHaveLength(6)
      expect(row.every(cell => cell.trim().length > 0), row.join(' | ')).toBe(true)
    }
  })

  it('every N/A skip in e2e/ has its row, and every row is such a skip (same spec, line, title)', () => {
    const skips = naSkips(specs).map(([spec, line, title]) => `${spec}:${line}:${title}`).sort()
    const listed = rows.map(([spec, line, title]) => `${spec}:${line}:${title}`).sort()

    expect(skips.length).toBeGreaterThan(0)
    expect(skips).toEqual(listed)
  })

  it('a planted N/A skip without a row, or a row without a skip, is caught', () => {
    const planted = [
      ['x.spec.ts', "test('a feature', async () => {\n  test.skip(true, 'N/A in v0.0.9: upstream thing')\n})"],
      ['y.spec.ts', "test('wrapped', async () => {\n  test.skip(\n    true,\n    'N/A in v0.0.9: a long upstream reason'\n  )\n})"]
    ]

    expect(naSkips(planted)).toEqual([
      ['x.spec.ts', 1, 'a feature'],
      ['y.spec.ts', 1, 'wrapped']
    ])
  })
})
