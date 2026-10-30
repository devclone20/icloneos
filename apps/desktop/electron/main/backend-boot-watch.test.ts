import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { BOOT_HEARTBEAT_INTERVAL_MS, watchBackendBoot } from './backend-boot-watch'

function child() {
  return Object.assign(new EventEmitter(), {
    exitCode: null as null | number,
    killed: false,
    stderr: new EventEmitter(),
    stdout: new EventEmitter()
  })
}

describe('watchBackendBoot (RTB-2)', () => {
  it('publishes the dependencies step once on the first install line, then heartbeats at most every 5 s', () => {
    let t = 0
    const published: string[] = []
    const proc = child()

    const watch = watchBackendBoot(proc, {
      now: () => t,
      publishDependenciesStep: () => published.push(`step@${t}`),
      publishHeartbeat: () => published.push(`beat@${t}`)
    })

    proc.stderr.emit('data', 'INFO: importing\n')
    expect(published).toEqual([])
    expect(watch.installing()).toBe(false)

    proc.stderr.emit('data', 'hermes: completing source-update dependencies...\n')
    expect(published).toEqual(['step@0'])

    for (t = 1_000; t <= 12_000; t += 1_000) {
      proc.stdout.emit('data', `line ${t}\n`)
    }

    expect(published).toEqual([
      'step@0',
      `beat@${BOOT_HEARTBEAT_INTERVAL_MS}`,
      `beat@${2 * BOOT_HEARTBEAT_INTERVAL_MS}`
    ])
    expect(watch.installing()).toBe(true)
  })

  it('classifies every line (\\r progress rewrites and split chunks included) for the readiness deadlines', () => {
    const proc = child()
    const kinds: string[] = []
    const watch = watchBackendBoot(proc, { publishDependenciesStep: () => {}, publishHeartbeat: () => {} })
    watch.source.subscribe(kind => kinds.push(kind))

    proc.stdout.emit('data', '  node:  13.9%  4.0 MiB / 28.8 MiB\r  node:  28.5%  8.2')
    proc.stdout.emit('data', ' MiB / 28.8 MiB\rHERMES_BACKEND_READY port=1\n')
    expect(kinds).toEqual(['install', 'install', 'output'])
  })

  it('stop() detaches from the streams and reports the child as no longer watched', () => {
    const proc = child()
    const kinds: string[] = []
    const watch = watchBackendBoot(proc, { publishDependenciesStep: () => {}, publishHeartbeat: () => {} })
    watch.source.subscribe(kind => kinds.push(kind))
    expect(watch.source.isAlive?.()).toBe(true)

    watch.stop()
    proc.stdout.emit('data', 'Resolved 3 packages\n')
    expect(kinds).toEqual([])
    expect(proc.stdout.listenerCount('data')).toBe(0)
    expect(proc.stderr.listenerCount('data')).toBe(0)
    expect(watch.source.isAlive?.()).toBe(false)
  })

  it('a child that exited is not alive', () => {
    const proc = child()
    const watch = watchBackendBoot(proc, { publishDependenciesStep: () => {}, publishHeartbeat: () => {} })
    proc.exitCode = 1
    expect(watch.source.isAlive?.()).toBe(false)
  })
})

describe('start-hermes feeds the watched child output to both deadlines (RTB-2 call site)', () => {
  const source = readFileSync(path.join(import.meta.dirname, 'start-hermes.ts'), 'utf8')

  it('watches the primary child from the spawn and publishes the dependencies step and heartbeats', () => {
    expect(source).toContain('const bootWatch = watchBackendBoot(hermesProcess, {')
    expect(source).toMatch(
      /publishDependenciesStep: \(\) =>\s+updateBootProgress\(\{[\s\S]*?phase: BOOT_PHASE_DEPENDENCIES/
    )
    expect(source).toContain('publishHeartbeat: () => updateBootProgress({ running: true })')
  })

  it('r2 (critic M2): a verdict while the agent is still starting goes to the install overlay, and the budget ends at ready', () => {
    expect(source).toMatch(
      /if \(message\.includes\(INSTALL_WATCHDOG_TAG\)\) \{\s+broadcastBootstrapEvent\(\{ type: 'failed', stage: 'start', error: message \}\)/
    )
    expect(source).toMatch(/markAgentRuntimeRunning\(\)\s+endInstallBudget\(\)/)
  })

  it('the port announcement and the readiness probe both slide on it, and it is stopped on every exit', () => {
    expect(source).toContain('activity: bootWatch.source,')
    expect(source).toMatch(/waitForHermes\(baseUrl, token, undefined, undefined, undefined, bootWatch\.source\)/)
    expect(source.match(/bootWatch\.stop\(\)/g)?.length).toBeGreaterThanOrEqual(3)
  })
})

describe('a silent dependency sync is alive while its tree burns CPU (ruling 42 r2)', () => {
  it('after the first install line, CPU progress is a sign of life and a heartbeat; no CPU, no sign', async () => {
    vi.useFakeTimers()

    try {
      const proc = Object.assign(child(), { pid: 4242 })
      let ms = 0
      let burning = true
      const beats: number[] = []
      const kinds: string[] = []

      const watch = watchBackendBoot(proc, {
        publishDependenciesStep: () => undefined,
        publishHeartbeat: () => beats.push(Date.now()),
        sampleCpu: async () => new Map([[4242, burning ? (ms += 100) : ms]])
      })

      watch.source.subscribe(kind => kinds.push(kind))
      proc.stderr.emit('data', '  → Installing Python dependencies…\n')
      await vi.advanceTimersByTimeAsync(30_000)
      const signs = kinds.filter(kind => kind === 'output').length

      expect(signs).toBeGreaterThanOrEqual(5)
      expect(beats.length).toBeGreaterThanOrEqual(5)
      burning = false
      await vi.advanceTimersByTimeAsync(30_000)
      expect(kinds.filter(kind => kind === 'output').length).toBe(signs)
      watch.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
