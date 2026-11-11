// The teardown registry, by behaviour: quitting (appTeardown.run, what will-quit and every forced exit call) stops the
// v0.0.7 long-lived resources the structural gate lists: the FSEvents canary stream and a pending barrier's retry
// timer, every hard-link guard's per-root stream and background-scan timer, and the audit log's periodic re-verify.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createHardlinkGuard } from './iclone-confinement/hardlinks'
import { createFsEventsSource, type FsEventsSource } from './iclone-confinement/hardlinks-fsevents'
import { liveWalkWorkers } from './iclone-confinement/hardlinks-walker'
import type { FsEventsHandle, IcloneFsevents } from './iclone-confinement/iclone-fsevents'
import { createAuditLog } from './iclone-permissions/audit'
import { appTeardown } from './teardown-registry'

const made: string[] = []

const tempDir = (prefix: string) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))

  made.push(dir)

  return dir
}

afterEach(() => {
  vi.useRealTimers()
  made.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }))
})

/** A stand-in for the addon: records each stream it starts and each stop (synchronously, as quit needs); it never
 *  delivers an event, so a barrier stays pending until something stops its stream. */
function fakeAddon() {
  const live = new Set<string>()
  const started: string[] = []
  const handles = new Map<FsEventsHandle, string>()

  const addon: IcloneFsevents = {
    currentEventId: () => '1',
    start(paths) {
      const watched = typeof paths === 'string' ? paths : paths[0]
      const handle = {} as FsEventsHandle

      live.add(watched)
      started.push(watched)
      handles.set(handle, watched)

      return handle
    },
    flush: async () => undefined,
    latestEventId: () => '1',
    stop(handle) {
      live.delete(handles.get(handle) ?? '')
    },
    activeCount: () => live.size,
    volume: async () => ({ fstypename: 'apfs', local: true })
  }

  return { live, started, addon }
}

describe('quit stops the v0.0.7 streams and timers (appTeardown.run)', () => {
  it('the canary stream, a pending barrier and its flush nudge, the guard streams, refresh timers, the audit timer', async () => {
    const canary = fakeAddon()
    const source = createFsEventsSource(canary.addon, { tmpdir: () => tempDir('td-canary-') }) as FsEventsSource

    // A guard over its own fake source: the barrier answers at once, the stream is recorded.
    const rootStreams = fakeAddon()

    const guardSource: FsEventsSource = {
      watch: async watched => {
        const handle = rootStreams.addon.start(watched, () => undefined)

        return { stop: () => rootStreams.addon.stop(handle), barrier: async () => ({ id: 1, ms: 1 }) }
      },
      trustedVolume: async () => true,
      close: () => undefined
    }

    const root = tempDir('td-root-')

    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
    fs.writeFileSync(path.join(root, 'a', 'b', 'f'), 'x')

    const userData = tempDir('td-ud-')

    const guard = createHardlinkGuard({
      ackFile: path.join(userData, 'confinement', 'acks.json'),
      fsEvents: guardSource,
      fsEventsChoice: 'always'
    })

    // Only timers are faked: the walk, statfs and the canary's mkdtemp stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })

    await guard.prewarm(root)
    expect(rootStreams.live).toEqual(new Set([root]))

    const watched = await source.watch(tempDir('td-watched-'), () => undefined, () => undefined)
    const pending = watched.barrier().then(
      () => 'answered',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    )

    // The barrier's flush nudge is armed once its canary file is written.
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2), { timeout: 5_000 })

    const log = createAuditLog({ dir: tempDir('td-audit-'), key: Buffer.alloc(32, 9), kid: 'kid1', durable: false })

    // The barrier's flush nudge, the guard's background scan, the audit log's periodic pass.
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(3)

    const ran = appTeardown.run()

    expect(ran).toEqual(expect.arrayContaining(['fsevents canary streams', 'hardlink guards', 'permission audit timers']))
    expect(ran.filter(name => name.endsWith('(failed)'))).toEqual([])
    expect(await pending).toBe('the fsevents source was closed')
    expect(canary.live).toEqual(new Set())
    expect(rootStreams.live).toEqual(new Set())
    expect(vi.getTimerCount()).toBe(0)

    // Closed is final: the source starts no canary again, and the guard schedules no background scan.
    await expect(source.watch(tempDir('td-again-'), () => undefined, () => undefined)).rejects.toThrow('closed')
    expect(canary.started).toHaveLength(1)
    // A closed guard fails closed and walks nothing (TRI-2): close aborts its walks (CF1) and drops its trees (CF7),
    // so a check after quit has no answer and its start is refused (checkBeforeStart 'error', I3). This line used to
    // expect { ok: true }, written before CF1/CF7 merged, when close kept the cached scan: a pass after quit is the
    // wrong contract, and no worker may start once the guard is closed.
    await expect(guard.check(root, 'build')).rejects.toThrow('the walk was stopped')
    expect(liveWalkWorkers()).toBe(0)
    expect(rootStreams.live).toEqual(new Set())
    expect(rootStreams.started).toEqual([root])
    expect(vi.getTimerCount()).toBe(0)

    log.close()
  })
})
