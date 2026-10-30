import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  EXPECTED_PACKAGES,
  initialPackages,
  packagesFromLog,
  packagesProgress,
  parseSize,
  reducePackageLine,
  settlePackages
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

  it('a bare ✗ lands on the package being installed; an optional default failure names itself', () => {
    let state = initialPackages()
    state = reducePackageLine(state, '  agent-browser:  12.3%  20.0 MiB / 162.3 MiB', 1)
    state = reducePackageLine(state, '✗ download failed: Could not resolve host: github.com', 2)
    state = reducePackageLine(
      state,
      '⚠ optional agent-browser was not installed; its tools stay unavailable until …',
      3
    )
    state = reducePackageLine(state, '⚠ optional cua-driver was not installed; its tools stay unavailable until …', 4)

    expect(state.packages.find(line => line.name === 'agent-browser')).toMatchObject({
      error: 'download failed: Could not resolve host: github.com',
      optional: true,
      state: 'failed'
    })
    expect(state.packages.find(line => line.name === 'cua-driver')).toMatchObject({ optional: true, state: 'failed' })
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

  it('at the end of the stage, untouched lines were not needed; an open line fails with the stage', () => {
    let state = initialPackages(['ffmpeg', 'node'])
    state = reducePackageLine(state, '  node: unpacking', 1)

    expect(settlePackages(state, 'succeeded', 2).packages.map(line => line.state)).toEqual(['not-needed', 'done'])
    expect(settlePackages(state, 'failed', 2).packages.map(line => line.state)).toEqual(['waiting', 'failed'])
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

  it('a stage that failed before any package opened marks the Python environment line failed (critic minor 5)', () => {
    const state = reducePackageLine(initialPackages(), 'Preparing the isolated Hermes runtime…', 1)

    expect(settlePackages(state, 'failed', 2).packages.find(line => line.name === 'venv')?.state).toBe('failed')
  })
})
