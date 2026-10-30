import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { diagnoseInstallFailure } from './install-diagnosis'
import {
  EXPECTED_PACKAGES,
  initialPackages,
  MAX_UNATTRIBUTED_CHARS,
  MAX_UNATTRIBUTED_LINES,
  type PackageLine,
  PACKAGES_STAGE,
  packagesFromLog,
  packagesProgress,
  type PackagesState,
  parseSize,
  PYTHON_ENV_PACKAGE,
  reducePackageLine,
  settlePackages,
  TERMINAL_PACKAGE_STATES,
  unattributedFailures
} from './install-packages'

// The RT re-run first launch (rt8h, 2026-10-22 10:01Z): every python-deps log event verbatim.
const rt8h = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '__fixtures__', 'rt8h-python-deps.json'), 'utf8')
) as { log: { line: string; stage: string; ts: number }[] }

describe('per-package install lines from the runner output (RTB-7, owner override)', () => {
  it('the real RT first-launch log ends with every package of the closure done, in PM order, with sizes', () => {
    const state = packagesFromLog(rt8h.log)

    expect(state.packages.map(line => [line.name, line.state])).toEqual(EXPECTED_PACKAGES.map(name => [name, 'done']))
    const browser = state.packages.find(line => line.name === 'agent-browser')!

    // agent-browser downloads two artifacts (its CLI, then Chromium): both are counted.
    expect(browser.parts).toBe(2)
    expect(browser.totalBytes).toBe(parseSize('162.3 MiB')! + parseSize('31.1 MiB')!)
    expect(browser.finishedAt! - browser.startedAt!).toBeGreaterThanOrEqual(0)
    expect(packagesProgress(state)).toBe(1)
  })

  it('replayed line by line, each package moves waiting → downloading n % → unpacking → done', () => {
    const seen = new Map<string, string[]>()
    let state = initialPackages()

    for (const entry of rt8h.log) {
      state = reducePackageLine(state, entry.line, entry.ts)

      for (const line of state.packages) {
        const states = seen.get(line.name) ?? ['waiting']

        if (states.at(-1) !== line.state) {
          states.push(line.state)
        }

        seen.set(line.name, states)
      }
    }

    expect(seen.get('node')).toEqual(['waiting', 'downloading', 'unpacking', 'done'])
    expect(seen.get('agent-browser')).toEqual([
      'waiting',
      'downloading',
      'unpacking',
      'downloading',
      'unpacking',
      'done'
    ])
    // The venv is a line of its own, installing only after the tools (the installer's early "Installing Python
    // dependencies" preparation line does not start it).
    expect(seen.get('venv')).toEqual(['waiting', 'installing', 'done'])
  })

  it('mid-download the overall progress moves with the active download', () => {
    let state = initialPackages()
    state = reducePackageLine(state, '✓ ffmpeg', 1)
    const before = packagesProgress(state)
    state = reducePackageLine(state, '  node:  50.0%  14.4 MiB / 28.8 MiB', 2)

    expect(state.packages.find(line => line.name === 'node')).toMatchObject({
      done: '14.4 MiB',
      percent: 50,
      state: 'downloading',
      total: '28.8 MiB'
    })
    expect(packagesProgress(state)).toBeGreaterThan(before)
  })

  it('a ✗ that names no row is recorded, never routed to a guessed row; an optional default failure names itself', () => {
    let state = initialPackages()
    state = reducePackageLine(state, '  agent-browser:  12.3%  20.0 MiB / 162.3 MiB', 1)
    const before = state.packages
    state = reducePackageLine(state, '✗ download failed: Could not resolve host: github.com', 2)

    expect(state.packages).toEqual(before)
    expect(state.unattributed).toEqual(['download failed: Could not resolve host: github.com'])
    state = reducePackageLine(
      state,
      '⚠ optional agent-browser was not installed; its tools stay unavailable until …',
      3
    )
    state = reducePackageLine(state, '⚠ optional cua-driver was not installed; its tools stay unavailable until …', 4)

    expect(state.packages.find(line => line.name === 'agent-browser')).toMatchObject({
      error: '⚠ optional agent-browser was not installed; its tools stay unavailable until …',
      optional: true,
      state: 'failed'
    })
    expect(state.packages.find(line => line.name === 'cua-driver')).toMatchObject({ optional: true, state: 'failed' })
  })

  it('a ✗ before any progress line names its own row, not the package downloading beside it (G-01 F1)', () => {
    for (const error of [
      'node: install failed: download failed from https://nodejs.org/dist/node.tar.xz: HTTP Error 404: Not Found — retry',
      'node: install failed: download failed from https://nodejs.org/dist/node.tar.xz: <urlopen error [Errno 61] Connection refused> — retry'
    ]) {
      let state = initialPackages()
      state = reducePackageLine(state, '  ripgrep:  10.0%  2.5 MiB / 25.4 MiB', 1)
      state = reducePackageLine(state, `✗ ${error}`, 2)
      state = reducePackageLine(state, '  ripgrep:  50.0%  12.7 MiB / 25.4 MiB', 3)

      expect(state.packages.find(line => line.name === 'node')).toMatchObject({ error, state: 'failed' })
      expect(state.packages.find(line => line.name === 'ripgrep')).toMatchObject({
        error: null,
        parts: 1,
        percent: 50,
        state: 'downloading',
        totalBytes: parseSize('25.4 MiB')
      })
      expect(state.active).toBe('ripgrep')
    }
  })

  it('a ✗ lands on the row it names whatever printed last; unfinished rows settle stopped (G-01 R2-1, r4)', () => {
    const fail = '✗ node: install failed: unpack failed: Errno 28 No space left on device'
    const unpack = '  node: unpacking'
    const tick = '  ripgrep: 100.0%  25.4 MiB / 25.4 MiB'

    // Both orderings: another package's tick last (the one r2 got wrong), and the unpack line last.
    for (const order of [
      [unpack, tick, fail],
      [tick, unpack, fail]
    ]) {
      const state = order.reduce((acc, line, i) => reducePackageLine(acc, line, i), initialPackages())

      expect(state.packages.find(line => line.name === 'node')).toMatchObject({ error: fail.slice(2), state: 'failed' })
      expect(state.packages.find(line => line.name === 'ripgrep')).toMatchObject({ percent: 100, state: 'downloading' })
      const settled = settlePackages(state, 'failed', 9)

      expect(settled.packages.find(line => line.name === 'node')?.state).toBe('failed')
      expect(settled.packages.find(line => line.name === 'ripgrep')?.state).toBe('stopped')
    }

    // Killed mid-unpack (no ✗ at all): no row has its own ✗, so none is failed; both stop with the stage.
    for (const order of [
      [unpack, tick],
      [tick, unpack]
    ]) {
      const state = order.reduce((acc, line, i) => reducePackageLine(acc, line, i), initialPackages())
      const settled = settlePackages(state, 'killed', 9)

      expect(settled.packages.find(line => line.name === 'node')?.state).toBe('stopped')
      expect(settled.packages.find(line => line.name === 'ripgrep')?.state).toBe('stopped')
    }

    // A download cut short (where the watchdog stops a stalled one) stops; the stage's diagnosis says why.
    const cut = reducePackageLine(initialPackages(), '  node:  40.0%  11.5 MiB / 28.8 MiB', 1)

    expect(settlePackages(cut, 'failed', 2).packages.find(line => line.name === 'node')?.state).toBe('stopped')
  })

  it('a ✗ naming a package that is not a row is recorded, not given to the row printing beside it (G-01 R2-12)', () => {
    let state = initialPackages()
    state = reducePackageLine(state, '  node: unpacking', 1)
    state = reducePackageLine(state, '  ripgrep: 100.0%  25.4 MiB / 25.4 MiB', 2)
    const before = state.packages
    state = reducePackageLine(state, '✗ libatomic: unavailable for this target', 3)

    expect(state.packages).toEqual(before)
    expect(state.unattributed).toEqual(['libatomic: unavailable for this target'])
    const settled = settlePackages(state, 'failed', 4)

    expect(unattributedFailures(settled)).toEqual(['libatomic: unavailable for this target'])
    expect(settled.packages.find(line => line.name === 'node')?.state).toBe('stopped')
    expect(settled.packages.find(line => line.name === 'ripgrep')?.state).toBe('stopped')
  })

  it('the name is matched exactly: a prefix of another name or a name inside the reason never wins (G-01 R2-9)', () => {
    let state = initialPackages(['node', 'node-gyp', 'ripgrep'])
    state = reducePackageLine(state, '  node:  10.0%  2.9 MiB / 28.8 MiB', 1)
    state = reducePackageLine(state, '✗ node-gyp: build failed', 2)
    state = reducePackageLine(state, '✗ ripgrep: download failed from https://mirror.test/node/ripgrep.tar.gz', 3)

    expect(state.packages.map(line => [line.name, line.state, line.error])).toEqual([
      ['node', 'downloading', null],
      ['node-gyp', 'failed', 'node-gyp: build failed'],
      ['ripgrep', 'failed', 'ripgrep: download failed from https://mirror.test/node/ripgrep.tar.gz']
    ])
  })

  it('installer chatter is not a package; an unexpected package is appended', () => {
    let state = initialPackages()

    for (const line of [
      '✓ uv ready (uv 0.12.3)',
      '✓ dependencies installed',
      '✓ bootstrap Python ready; PM prepares'
    ]) {
      state = reducePackageLine(state, line, 1)
    }

    expect(state.packages.every(line => line.state === 'waiting')).toBe(true)
    state = reducePackageLine(state, '  gh:  40.0%  4.0 MiB / 10.0 MiB', 2)
    expect(state.packages.at(-1)).toMatchObject({ name: 'gh', state: 'downloading' })
  })

  it('at the end of the stage, untouched lines were not needed; settle never invents an outcome (r4)', () => {
    let state = initialPackages(['ffmpeg', 'node'])
    state = reducePackageLine(state, '  node: unpacking', 1)

    // Success without node's ✓: reported as stopped, not assumed done.
    expect(settlePackages(state, 'succeeded', 2).packages.map(line => line.state)).toEqual(['not-needed', 'stopped'])
    expect(settlePackages(state, 'failed', 2).packages.map(line => line.state)).toEqual(['stopped', 'stopped'])
    expect(settlePackages(state, 'killed', 2).packages.map(line => line.state)).toEqual(['stopped', 'stopped'])
  })

  it('a succeeded stage never turns a row verifying without its ✓ into done (G-01 critic m1, M5)', () => {
    let state = initialPackages(['ffmpeg', 'node'])
    state = reducePackageLine(state, '  ffmpeg: verifying', 1)
    state = reducePackageLine(state, '✓ ffmpeg', 2)
    state = reducePackageLine(state, '  node: verifying', 3)
    expect(state.packages.map(line => line.state)).toEqual(['done', 'verifying'])

    const settled = settlePackages(state, 'succeeded', 4)

    expect(settled.packages[0]).toEqual(state.packages[0])
    expect(settled.packages[1]).toMatchObject({ finishedAt: 4, name: 'node', percent: null, state: 'stopped' })
  })

  it('every step of a turn is its own named line: verifying, repairing, unpacking (G-01 r4)', () => {
    let state = initialPackages(['node', 'npm'])

    for (const [line, state_] of [
      ['  node:  50.0%  14.4 MiB / 28.8 MiB', 'downloading'],
      ['  node: 100.0%  28.8 MiB / 28.8 MiB', 'downloading'],
      ['  node: verifying', 'verifying'],
      ['  node: repairing', 'downloading'],
      ['  node: 100.0%  1.0 MiB / 1.0 MiB', 'downloading'],
      ['  node: unpacking', 'unpacking'],
      ['  node: verifying', 'verifying'],
      ['✓ node', 'done']
    ] as const) {
      const next = reducePackageLine(state, line, 1)

      expect(next.packages[0].state, line).toBe(state_)
      expect(next.packages[1], line).toEqual(state.packages[1])
      state = next
    }

    // The repair is a part of its own; re-reading the cached archive ("verifying") is not.
    expect(state.packages[0]).toMatchObject({ parts: 2, totalBytes: parseSize('28.8 MiB')! + parseSize('1.0 MiB')! })
  })

  it('killed while a prefetched package is verified: the done venv stays done, nothing is failed (G-01 R3-1)', () => {
    const log = [
      '  node: 100.0%  28.8 MiB / 28.8 MiB',
      '  node: verifying',
      '  node: unpacking',
      '  node: verifying',
      '✓ node',
      '  agent-browser: 100.0%  162.3 MiB / 162.3 MiB',
      '  → Installing Python dependencies…',
      '✓ venv',
      '  agent-browser: verifying'
    ]

    const state = log.reduce((acc, line, i) => reducePackageLine(acc, line, i), initialPackages())

    for (const end of ['failed', 'killed'] as const) {
      const rows = Object.fromEntries(settlePackages(state, end, 99).packages.map(line => [line.name, line.state]))

      expect(rows).toMatchObject({ 'agent-browser': 'stopped', node: 'done', venv: 'done' })
      expect(Object.values(rows)).not.toContain('failed')
    }
  })

  it('the overall bar weighs packages by size (critic minor 3): agent-browser done moves it more than ripgrep done', () => {
    const base = initialPackages(['ripgrep', 'agent-browser'])
    const rg = reducePackageLine(reducePackageLine(base, '  ripgrep: 100.0%  1.7 MiB / 1.7 MiB', 1), '✓ ripgrep', 2)

    const ab = reducePackageLine(
      reducePackageLine(base, '  agent-browser: 100.0%  162.3 MiB / 162.3 MiB', 1),
      '✓ agent-browser',
      2
    )

    expect(packagesProgress(ab, 3)).toBeGreaterThan(packagesProgress(rg, 3) * 5)
  })

  it('a silent step creeps with time instead of jumping', () => {
    let state = initialPackages(['ffmpeg', 'venv'])
    state = reducePackageLine(state, '✓ ffmpeg', 0)
    state = reducePackageLine(state, '  → Installing Python dependencies…', 1_000)
    const early = packagesProgress(state, 2_000)
    const later = packagesProgress(state, 60_000)

    expect(later).toBeGreaterThan(early)
    expect(later).toBeLessThan(1)
  })

  it('a stage that failed before any package opened fails no row; a nameless ✗ stays visible (r4, R3-3)', () => {
    let state = reducePackageLine(initialPackages(), 'Preparing the isolated Hermes runtime…', 1)
    state = reducePackageLine(state, '  ✗ uv sync failed; last 3 lines of output follow', 2)
    const settled = settlePackages(state, 'failed', 3)

    expect(settled.packages.every(line => line.state === 'stopped')).toBe(true)
    expect(unattributedFailures(settled)).toEqual(['uv sync failed; last 3 lines of output follow'])
    // PM's own venv failure names its row: that one is failed by its own line.
    const named = reducePackageLine(state, '✗ venv: tools not on PATH before venv sync: uv', 4)

    expect(settlePackages(named, 'failed', 5).packages.find(line => line.name === 'venv')?.state).toBe('failed')
  })
})

// G-01 R2-1 / R3-6 (lead method, r4): attribution and settle are proven over interleavings, not hand-picked fixtures.
// Each package prints one of the shapes PM really prints (a full turn ✓ or ✗, a ✗ before any line, a ✗ after its
// download, a present package, a repair, two artifacts, an optional default after the closure); the Python environment
// and a nameless ✗ producer run beside them; lines of different packages overlap in any order. After every line, and
// at every cut point under each stage end (succeeded, failed, killed), the properties below must hold.
describe('every interleaving: each line moves only its row, and settle never invents an outcome (G-01 R3-6)', () => {
  interface Event {
    line: string
    /** The row the line names; null for a line that names no row (it must land in `unattributed`). */
    name: null | string
    /** What the named row must read after the line (omitted: only "no other row moved" is checked). */
    expect?: Partial<PackageLine>
    /** A ✗/⚠ of the row itself: the only thing that may leave it failed. */
    fails?: true
  }

  const VARIANTS = ['ok', 'fail', 'failFirst', 'failAfterDownload', 'present', 'repair', 'multi', 'optional'] as const
  type Variant = (typeof VARIANTS)[number]
  const ENDS = ['succeeded', 'failed', 'killed'] as const

  const events = (name: string, others: readonly string[], variant: Variant): Event[] => {
    const reason = `${name}: install failed: fetched from https://mirror.test/${others.join('/')}/archive.zip`

    const tick = (percent: number, done: string, total: string): Event => ({
      expect: { percent, state: 'downloading' },
      line: `  ${name}: ${percent.toFixed(1).padStart(5)}%  ${done} / ${total}`,
      name
    })

    const step = (word: string, state: PackageLine['state']): Event => ({
      expect: { state },
      line: `  ${name}: ${word}`,
      name
    })

    const download = [tick(50, '1.0 MiB', '2.0 MiB'), tick(100, '2.0 MiB', '2.0 MiB')]
    const ok: Event = { expect: { error: null, state: 'done' }, line: `✓ ${name}`, name }
    const fail: Event = { expect: { error: reason, state: 'failed' }, fails: true, line: `✗ ${reason}`, name }
    const turn = [step('verifying', 'verifying'), step('unpacking', 'unpacking'), step('verifying', 'verifying')]

    switch (variant) {
      case 'ok':
        return [...download, ...turn, ok]

      case 'fail':
        return [...download, ...turn, fail]

      case 'failFirst':
        return [fail]

      case 'failAfterDownload':
        return [...download, step('verifying', 'verifying'), fail]

      case 'present':
        return [step('verifying', 'verifying'), ok]

      case 'repair':
        return [
          ...download,
          step('verifying', 'verifying'),
          { expect: { percent: 0, state: 'downloading', total: null }, line: `  ${name}: repairing`, name },
          tick(50, '0.5 MiB', '1.0 MiB'),
          tick(100, '1.0 MiB', '1.0 MiB'),
          ...turn.slice(1),
          ok
        ]

      case 'multi':
        return [
          ...download,
          tick(50, '4.0 MiB', '8.0 MiB'),
          tick(100, '8.0 MiB', '8.0 MiB'),
          step('verifying', 'verifying'),
          step('unpacking 1/2', 'unpacking'),
          step('unpacking 2/2', 'unpacking'),
          step('verifying', 'verifying'),
          ok
        ]

      case 'optional':
        return [
          step('verifying', 'verifying'),
          fail,
          {
            expect: { error: reason, optional: true, state: 'failed' },
            fails: true,
            line: `⚠ optional ${name} was not installed: ${reason}`,
            name
          }
        ]
    }
  }

  // Beside the packages: PM's venv sync (its start line counts only after some row is done) and a nameless ✗.
  const venv: Event[] = [
    { line: '  → Installing Python dependencies…', name: 'venv' },
    { expect: { state: 'done' }, line: '✓ venv', name: 'venv' }
  ]

  const nameless: Event[] = [{ line: '  ✗ uv sync failed; last 3 lines of output follow', name: null }]

  /** Properties (b)–(f) for one cut point: settle under every stage end. */
  const settleWrong = (state: PackagesState, failedBy: ReadonlySet<string>, where: string): null | string => {
    for (const end of ENDS) {
      const settled = settlePackages(state, end, 1e9)

      for (const [i, after] of settled.packages.entries()) {
        const before = state.packages[i]

        if (before.state === 'done' && JSON.stringify(after) !== JSON.stringify(before)) {
          return `${where} settle(${end}) changed the done row ${before.name}` // (b)
        }

        if (after.state === 'done' && before.state !== 'done') {
          return `${where} settle(${end}) made ${after.name} done without its ✓` // (f)
        }

        if (after.state === 'failed' && !failedBy.has(after.name)) {
          return `${where} settle(${end}) failed ${after.name} without its own ✗` // (c)
        }

        if (!TERMINAL_PACKAGE_STATES.has(after.state)) {
          return `${where} settle(${end}) left ${after.name} ${after.state}` // (d)
        }

        if (end !== 'succeeded' && after.state === 'not-needed' && before.state !== 'not-needed') {
          return `${where} settle(${end}) called ${after.name} not needed on a stage that did not succeed`
        }
      }

      if (JSON.stringify(unattributedFailures(settled)) !== JSON.stringify(unattributedFailures(state))) {
        return `${where} settle(${end}) lost an unattributed failure` // (e)
      }
    }

    return null
  }

  /** The first broken property of ``order``, or null. */
  const firstWrong = (names: readonly string[], order: readonly Event[]): null | string => {
    let state = initialPackages(names)
    const failedBy = new Set<string>()
    const cut = settleWrong(state, failedBy, 'before any line')

    if (cut) {
      return cut
    }

    for (const [step, event] of order.entries()) {
      const next = reducePackageLine(state, event.line, step)
      const where = `step ${step} (${event.line})`

      if (event.fails && event.name) {
        failedBy.add(event.name)
      }

      if (next.packages.length !== names.length) {
        return `${where} added a row`
      }

      for (const [i, line] of next.packages.entries()) {
        const before = state.packages[i]

        if (line.name !== event.name) {
          if (JSON.stringify(line) !== JSON.stringify(before)) {
            return `${where} changed ${line.name}` // (a)
          }
        } else if (
          Object.entries(event.expect ?? {}).some(([key, value]) => line[key as keyof PackageLine] !== value)
        ) {
          return `${where} left ${line.name} ${JSON.stringify(line)}`
        }

        if (line.state === 'failed' && !failedBy.has(line.name)) {
          return `${where} failed ${line.name} without its own ✗` // (c), during the stage
        }
      }

      const grew = unattributedFailures(next).length - unattributedFailures(state).length

      if (grew !== (event.name === null ? 1 : 0)) {
        return `${where} ${event.name === null ? 'was not kept as unattributed' : 'touched unattributed'}` // (e)
      }

      state = next
      const wrong = settleWrong(state, failedBy, `after ${where}`)

      if (wrong) {
        return wrong
      }
    }

    return null
  }

  function* interleavings(seqs: readonly Event[][], prefix: Event[] = [], at = seqs.map(() => 0)): Generator<Event[]> {
    let exhausted = true

    for (let k = 0; k < seqs.length; k++) {
      if (at[k] < seqs[k].length) {
        exhausted = false
        prefix.push(seqs[k][at[k]])
        at[k]++
        yield* interleavings(seqs, prefix, at)
        at[k]--
        prefix.pop()
      }
    }

    if (exhausted) {
      yield prefix.slice()
    }
  }

  const sequences = (names: readonly string[], variants: readonly Variant[]) =>
    names.map((name, i) =>
      events(
        name,
        names.filter(other => other !== name),
        variants[i]
      )
    )

  it('N = 2 + a nameless ✗: every order of the short shapes, every cut, every stage end (exhaustive)', () => {
    // "node" prefixes "node-gyp" and every reason names the other package: only an exact name match passes.
    const names = ['node', 'node-gyp']
    const short: readonly Variant[] = ['ok', 'fail', 'failFirst', 'failAfterDownload', 'present', 'optional']
    let orders = 0

    for (const a of short) {
      for (const b of short) {
        for (const order of interleavings([...sequences(names, [a, b]), nameless])) {
          orders++
          const wrong = firstWrong(names, order)

          if (wrong !== null) {
            expect.fail(`${a}/${b}: ${wrong}\n${order.map(event => event.line).join('\n')}`)
          }
        }
      }
    }

    expect(orders).toBeGreaterThan(20_000)
  })

  it('N = 3 + venv + a nameless ✗: 10 000 seeded orders over every shape, every cut, every stage end', () => {
    const names = ['node', 'node-gyp', 'npm', 'venv']
    const seed = Number(process.env.INTERLEAVE_SEED ?? 20261030)
    // mulberry32: a seeded PRNG, so a failing order is reproducible from the printed seed.
    let s = seed >>> 0

    const random = () => {
      s = (s + 0x6d2b79f5) >>> 0
      let t = s
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }

    console.info(`interleaving seed ${seed} (INTERLEAVE_SEED to replay)`)

    for (let run = 0; run < 10_000; run++) {
      const variants = names.slice(0, 3).map(() => VARIANTS[Math.floor(random() * VARIANTS.length)])
      const seqs = [...sequences(names.slice(0, 3), variants), venv, ...(random() < 0.5 ? [nameless] : [])]
      const at = seqs.map(() => 0)
      const order: Event[] = []

      for (;;) {
        const open = seqs.flatMap((seq, k) => (at[k] < seq.length ? [k] : []))

        if (open.length === 0) {
          break
        }

        const k = open[Math.floor(random() * open.length)]
        order.push(seqs[k][at[k]++])
      }

      const wrong = firstWrong(names, order)

      if (wrong !== null) {
        expect.fail(`seed ${seed} run ${run} (${variants.join(', ')}): ${wrong}\n${order.map(e => e.line).join('\n')}`)
      }
    }
  })
})

describe("G-01 r5: the venv sync failure, a re-download after verifying, the nameless lines' bounds", () => {
  // PM's exact output for a failed `uv sync` (tests/pm/test_venv_failure_line.py asserts PM prints this file byte for
  // byte), after the tools PM installs first.
  const venvSyncFailure = [
    '✓ ffmpeg',
    '✓ node',
    '✓ npm',
    '✓ python',
    '✓ ripgrep',
    ...readFileSync(path.join(import.meta.dirname, '__fixtures__', 'venv-sync-failure.txt'), 'utf8')
      .split('\n')
      .filter(Boolean)
  ]

  it('a failed venv sync fails the venv row by its own lines; nothing is left unattributed (R4-1)', () => {
    const state = settlePackages(
      venvSyncFailure.reduce((acc, line) => reducePackageLine(acc, line, 1), initialPackages()),
      'failed',
      2
    )

    expect(state.packages.find(line => line.name === PYTHON_ENV_PACKAGE)).toMatchObject({
      error: expect.stringMatching(/^venv: uv sync exited 1: /),
      state: 'failed'
    })
    expect(unattributedFailures(state)).toEqual([])
    expect(state.packages.filter(line => line.state === 'failed').map(line => line.name)).toEqual([PYTHON_ENV_PACKAGE])
    expect(state.packages.find(line => line.name === 'agent-browser')?.state).toBe('stopped')

    // The diagnosis still classifies it (the build line) and now names the package.
    expect(diagnoseInstallFailure({ error: 'exit code 1', log: venvSyncFailure, stage: PACKAGES_STAGE })).toMatchObject(
      { class: 'resolver', packageName: PYTHON_ENV_PACKAGE }
    )
  })

  it('a re-download of the same archive after verifying is the same part, not a new one (R4-3, FM2)', () => {
    const state = [
      '  node:  50.0%  14.4 MiB / 28.8 MiB',
      '  node: 100.0%  28.8 MiB / 28.8 MiB',
      '  node: verifying',
      '  node:  12.0%  3.5 MiB / 28.8 MiB',
      '  node: 100.0%  28.8 MiB / 28.8 MiB',
      '  node: unpacking',
      '✓ node'
    ].reduce((acc, line) => reducePackageLine(acc, line, 1), initialPackages(['node']))

    expect(state.packages[0]).toMatchObject({ parts: 1, state: 'done', totalBytes: parseSize('28.8 MiB') })
  })

  it('nameless ✗ lines are bounded: 400 characters each, the first 20 kept, the rest counted (R4-4)', () => {
    let state = reducePackageLine(initialPackages(['node']), `✗ ${'x'.repeat(5000)}`, 1)

    for (let index = 1; index < MAX_UNATTRIBUTED_LINES + 7; index++) {
      state = reducePackageLine(state, `  ✗ failure ${index}`, 1)
    }

    const lines = unattributedFailures(state)

    expect(lines).toHaveLength(MAX_UNATTRIBUTED_LINES + 1)
    expect(lines[0]).toHaveLength(MAX_UNATTRIBUTED_CHARS)
    expect(lines[MAX_UNATTRIBUTED_LINES - 1]).toBe(`failure ${MAX_UNATTRIBUTED_LINES - 1}`)
    expect(lines.at(-1)).toBe('+7 more')
    expect(lines.every(line => line.length <= MAX_UNATTRIBUTED_CHARS)).toBe(true)
    expect(state.packages[0].state).toBe('waiting')
  })
})
