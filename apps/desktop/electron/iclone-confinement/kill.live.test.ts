/**
 * V3-G F1 — Kill really kills, live against `/usr/bin/sandbox-exec`: a run is everything the kernel holds in its
 * sandbox token, so a daemon that double-forked and called `setsid` (ppid 1, its own session, no marker) is listed and
 * stopped with its run; a fork bomb is frozen then killed; a process ignoring SIGTERM dies by SIGKILL; and the pane's
 * count is the number of processes that are really alive.
 */
import { existsSync } from 'node:fs'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createSeatbeltBackend } from './backend-seatbelt'
import { createLiveWorld, type LiveWorld, MEMBER_PYTHON } from './live-harness'
import { SANDBOX_EXEC } from './probe'
import { type PsRow, readPs, type Snapshot } from './state'

const LIVE = process.platform === 'darwin' && existsSync(SANDBOX_EXEC) && Boolean(MEMBER_PYTHON)

let world: LiveWorld

beforeAll(() => {
  world = createLiveWorld()
})

// A failed test must not leave its daemons behind: stop every run this world started, then remove it.
afterAll(async () => {
  if (LIVE && world) {
    for (const root of new Set(world.backend.list(await world.scan()).map(item => item.root))) {
      await world.backend.kill(root)
    }
  }

  world?.dispose()
})

/** Only processes of this world's runs (a stale daemon of an earlier run elsewhere is never picked). */
const own = (snapshot: Snapshot, title: string) =>
  snapshot.rows.find(row => row.run !== undefined && row.command.startsWith(title))

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitFor(check: () => Promise<boolean>, ms: number): Promise<void> {
  const until = Date.now() + ms

  while (Date.now() < until) {
    if (await check()) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 50))
  }

  throw new Error(`condition not met within ${ms} ms`)
}

function start(script: string, sessionId: string): number {
  const result = world.backend.spawn({
    cls: 'project',
    argv: ['/bin/bash', '-c', script],
    cwd: world.project,
    env: { PATH: '/usr/bin:/bin' },
    projectRoot: world.project,
    network: false,
    writeProject: true,
    sessionId
  })

  if (!result.ok) {
    throw new Error(result.error)
  }

  return result.pid
}

const runOf = async (root: number) => world.backend.list(await world.scan()).filter(item => item.root === root)

// fork → setsid → fork, then the first child exits: the daemon is reparented to launchd in its own session and group,
// with an argv that carries no marker. Perl is a real binary (no xcrun shim), in every profile's system reads.
const DAEMON = `/usr/bin/perl -MPOSIX -e 'exit if fork; POSIX::setsid(); exit if fork; $0 = "v3g-daemon"; sleep 60'`

describe.runIf(LIVE)('F1 — Kill stops every process the kernel holds in the run, not just the tree', () => {
  it('a double-forked setsid daemon is listed with its run and dead after Kill', async () => {
    const root = start(`${DAEMON}; /bin/sleep 60`, 'v3g-f1-daemon')
    let daemon: PsRow | undefined

    await waitFor(async () => {
      const snapshot = await world.scan()

      daemon = own(snapshot, 'v3g-daemon')

      return Boolean(daemon?.ppid === 1 && world.backend.list(snapshot).some(item => item.pid === daemon?.pid))
    }, 3_000)

    expect(daemon?.ppid).toBe(1)
    expect(daemon?.pgid).not.toBe(root)
    expect((await runOf(root)).map(item => item.pid)).toContain(daemon?.pid)

    const result = await world.backend.kill(root)

    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.killed).toContain(daemon?.pid)
    expect(alive(daemon?.pid ?? 0)).toBe(false)
    expect((await readPs()).some(row => row.pid === daemon?.pid)).toBe(false)
  })

  it('Kill on the daemon itself stops its whole run, the marked root included', async () => {
    const root = start(`${DAEMON}; /bin/sleep 60`, 'v3g-f1-orphan')
    let daemonPid = 0

    await waitFor(async () => {
      daemonPid = own(await world.scan(), 'v3g-daemon')?.pid ?? 0

      return daemonPid > 0
    }, 3_000)

    expect(await world.backend.kill(daemonPid)).toMatchObject({ ok: true })
    expect(alive(daemonPid)).toBe(false)
    // The root is main's own child: dead, and reaped by Node a moment later.
    await waitFor(async () => !alive(root), 1_000)
  })

  it('a fork bomb capped at 31 shells (+31 sleeps) is frozen and killed: 0 survivors', async () => {
    const root = start(
      'b(){ if [ $1 -gt 0 ]; then b $(($1-1)) & b $(($1-1)) & fi; /bin/sleep 60; }; b 4',
      'v3g-f1-bomb'
    )

    await waitFor(async () => (await runOf(root)).length >= 40, 5_000)

    const before = (await runOf(root)).map(item => item.pid)
    const result = await world.backend.kill(root)

    expect(result).toMatchObject({ ok: true })
    expect(before.filter(alive)).toEqual([])
    expect(await runOf(root)).toEqual([])
  })

  it('a process that ignores SIGTERM dies by SIGKILL after the grace period', async () => {
    const root = start(
      `trap '' TERM; /usr/bin/perl -e '$SIG{TERM} = "IGNORE"; $0 = "v3g-stubborn"; sleep 60'`,
      'v3g-f1-term'
    )

    let stubborn = 0

    await waitFor(async () => {
      stubborn = own(await world.scan(), 'v3g-stubborn')?.pid ?? 0

      return stubborn > 0
    }, 3_000)

    process.kill(stubborn, 'SIGTERM')
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(alive(stubborn), 'the control: SIGTERM alone does not stop it').toBe(true)

    const started = Date.now()
    const result = await world.backend.kill(root)

    expect(result).toMatchObject({ ok: true })
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_400)
    expect(alive(stubborn)).toBe(false)
  })

  it('the pane count is the number of run processes really alive, before and after Kill', async () => {
    const root = start(`${DAEMON}; /bin/sleep 60 & /bin/sleep 60 & wait`, 'v3g-f1-count')

    await waitFor(async () => (await runOf(root)).length >= 4, 3_000)

    const listed = (await runOf(root)).map(item => item.pid)

    expect(listed.every(alive)).toBe(true)
    expect(listed.length).toBe((await world.scan()).rows.filter(row => listed.includes(row.pid)).length)

    expect(await world.backend.kill(root)).toMatchObject({ ok: true })
    expect(await runOf(root)).toEqual([])
    expect(listed.filter(alive)).toEqual([])
  })
})

describe('F1 — Kill reports honestly when it cannot prove 0 survivors', () => {
  // Pids far above macOS's limit (99 999): signalling them reaches nothing.
  const ghost = (pid: number, run: string | null): PsRow => ({
    pid,
    ppid: 1,
    pgid: pid,
    elapsedSec: 5,
    command: 'stubborn',
    run
  })

  const backendWith = (scan: () => Promise<Snapshot>) =>
    createSeatbeltBackend({
      paths: world.paths,
      profiles: () => world.profiles,
      scan,
      hardlinks: world.hardlinks
    })

  const RUN = `project+${'c'.repeat(12)}+s+${'d'.repeat(32)}`

  it('members that outlive every SIGKILL round are named: "could not stop N"', async () => {
    const rows = [ghost(900_001, RUN), ghost(900_002, RUN)]
    const result = await backendWith(async () => ({ rows, verified: true })).kill(900_001)

    expect(result).toMatchObject({ ok: false, reason: 'survivors', survivors: [900_001, 900_002] })
    expect(!result.ok && result.error).toMatch(/could not stop 2/)
  }, 20_000)

  it('without the kernel answer, an emptied tree is not reported as a clean kill', async () => {
    const marked = { ...ghost(900_003, null), command: `/bin/bash -c x ${'iclone-confined:project:cccccccccccc:-'}` }
    let calls = 0

    const result = await backendWith(async () => {
      calls += 1

      return { rows: calls === 1 ? [marked] : [], verified: false }
    }).kill(900_003)

    expect(result).toMatchObject({ ok: false, reason: 'unverified' })
  })
})
