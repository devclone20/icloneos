// Real processes (critic minor 7, M3): a stage spawned exactly as the installer spawns it, watched by the real
// watchdog with SHORT timings (the production constants are pinned in bootstrap-watchdog.test.ts), sampled by /bin/ps.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { createStageWatchdog, spawnInstallerStage, STAGE_KILL_GRACE_MS } from './bootstrap-runner'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtb-stage-'))
afterAll(() => fs.rmSync(dir, { force: true, recursive: true }))

function script(name: string, body: string) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`)

  return file
}

const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0)

    return true
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const TIMING = { heartbeatMs: 500, sampleMs: 250, stallMs: 1_500 }

async function runWatched(file: string) {
  let pid = 0
  const events: string[] = []
  const watchdog = createStageWatchdog(ev => events.push(ev.type), undefined, 'test', {}, TIMING)
  const startedAt = Date.now()

  const result = await spawnInstallerStage(file, [], {
    abortSignal: watchdog.signal,
    emit: watchdog.emit,
    onChild: child => {
      pid = child ?? 0
      watchdog.attach(child)
    },
    stageName: 'test'
  })

  watchdog.stop()

  return { elapsed: Date.now() - startedAt, events, pid, reason: watchdog.reason(), result }
}

describe('a real installer stage under the real watchdog', () => {
  it('a silent stage whose grandchild ignores SIGTERM: stuck verdict at once, the whole group gone after the grace', async () => {
    const file = script('hang.sh', `trap '' TERM\n( trap '' TERM; exec sleep 60 ) &\necho started\nsleep 60`)
    const run = await runWatched(file)

    expect(run.reason).toMatch(/no progress \(output, CPU or bytes written\)/)
    // Reported when the watchdog decided, not when the grandchild (holding the pipes, ignoring SIGTERM) exits.
    expect(run.elapsed).toBeLessThan(4_000)
    expect(run.result.killed).toBe(true)
    expect(groupAlive(run.pid)).toBe(true)
    await sleep(STAGE_KILL_GRACE_MS + 1_000)
    expect(groupAlive(run.pid)).toBe(false)
  }, 20_000)

  it('a stage that works silently (CPU, no output) is not stopped; it finishes on its own', async () => {
    const file = script('busy.sh', `node -e 'const t=Date.now(); while (Date.now()-t < 4000) {}'\necho done`)
    const run = await runWatched(file)

    expect(run.reason).toBeNull()
    expect(run.result.killed).toBe(false)
    expect(run.result.code).toBe(0)
    expect(run.events).toContain('stage-alive')
  }, 20_000)

  it('the same busy stage SIGSTOPped mid-run is judged stuck after the stall window', async () => {
    const file = script('stopme.sh', `node -e 'const t=Date.now(); while (Date.now()-t < 20000) {}'\necho done`)
    let pid = 0
    const watchdog = createStageWatchdog(() => undefined, undefined, 'test', {}, TIMING)

    const running = spawnInstallerStage(file, [], {
      abortSignal: watchdog.signal,
      emit: watchdog.emit,
      onChild: child => {
        pid = child ?? 0
        watchdog.attach(child)
      },
      stageName: 'test'
    })

    await sleep(2_500)
    expect(watchdog.signal.aborted).toBe(false)
    const stoppedAt = Date.now()
    process.kill(-pid, 'SIGSTOP')
    const result = await running
    const detectedAfter = Date.now() - stoppedAt
    watchdog.stop()

    // The group may already be gone (the stop killed it): resuming nothing is fine.
    try {
      process.kill(-pid, 'SIGCONT')
    } catch (error) {
      // Only a group that is already gone is fine (critic r2c5 L1); anything else fails the test.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error
      }
    }

    expect(result.killed).toBe(true)
    expect(watchdog.reason()).toMatch(/no progress/)
    expect(detectedAfter).toBeGreaterThanOrEqual(TIMING.stallMs - TIMING.sampleMs)
    expect(detectedAfter).toBeLessThan(TIMING.stallMs + 2_000)
  }, 30_000)
})
