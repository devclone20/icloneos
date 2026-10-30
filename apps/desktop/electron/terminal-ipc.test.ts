import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import { resolveTerminalConnection, resolveTerminalConnectionForSender } from './connection-apply'
import {
  closeSpawnFd,
  type DarwinPtyHandles,
  reclaimDarwinSpawnFds,
  type SpawnFd,
  spawnFdSnapshot,
  type SpawnFdSystem,
  watchTerminalOwner
} from './terminal-ipc'

vi.mock('electron', () => ({ app: {}, ipcMain: {} }))
vi.mock('node-pty', () => ({ default: { spawn: vi.fn() } }))

const ssh = {
  host: 'registry-box.test',
  user: 'hermes'
}

test('terminal start preserves the selected SSH target and scope', async () => {
  const target = {
    ssh,
    scope: 'connection:registry-ssh:profile:worker'
  }

  const resolved = await resolveTerminalConnection(
    () => target,
    async () => {
      throw new Error('backend fallback must not run for an active SSH target')
    }
  )

  assert.equal(resolved, target)
  assert.equal(resolved?.ssh, ssh)
  assert.equal(resolved?.scope, 'connection:registry-ssh:profile:worker')
})

test('terminal start does not invent SSH when canonical routing selects local or remote HTTP', async () => {
  let backendChecks = 0

  const resolved = await resolveTerminalConnection(
    () => null,
    async () => {
      backendChecks += 1
    }
  )

  assert.equal(resolved, null)
  assert.equal(backendChecks, 0)
})

test('terminal start re-reads the SSH target after backend startup', async () => {
  const target = {
    ssh,
    scope: 'connection:registry-ssh'
  }

  let ready = false

  const resolved = await resolveTerminalConnection(
    () => (ready ? target : 'pending'),
    async () => {
      ready = true
    }
  )

  assert.equal(resolved, target)
  assert.equal(resolved?.scope, 'connection:registry-ssh')
})

test('keeps terminal routing isolated by renderer sender id', async () => {
  const targets = new Map([
    [11, { ssh, scope: 'conn:source-b::worker' }],
    [22, null]
  ])

  const getTarget = (webContentsId: number) => targets.get(webContentsId) ?? null
  const ensureBackend = async (_webContentsId: number) => undefined

  const windowB = await resolveTerminalConnectionForSender(11, getTarget, ensureBackend)
  const windowC = await resolveTerminalConnectionForSender(22, getTarget, ensureBackend)

  assert.equal(windowB?.scope, 'conn:source-b::worker')
  assert.equal(windowC, null)
})

// ---------- node-pty 1.1.0 darwin fd reclaim, over a fake fd table ----------

interface FakeFd {
  ino: number
  kind: 'chr' | 'fifo'
  rdev: number
}

const makedev = (major: number, minor: number) => ((major << 24) | minor) >>> 0
const PTMX = 15
const TTY = 16
const chr = (rdev: number, ino = rdev & 0xffff) => ({ ino, kind: 'chr', rdev }) as FakeFd
const pipe = (ino: number) => ({ ino, kind: 'fifo', rdev: 0 }) as FakeFd
const kqueue = (): FakeFd => ({ ino: 0, kind: 'fifo', rdev: 0 })
const DEV_NULL = chr(makedev(3, 2), 311)

function fakeFds(initial: Record<number, FakeFd>, ptsRdev: null | number) {
  const fds = new Map(Object.entries(initial).map(([fd, entry]) => [Number(fd), entry]))
  const closed: number[] = []

  const lowestFree = () => {
    let fd = 0

    while (fds.has(fd)) {
      fd++
    }

    return fd
  }

  const sys: SpawnFdSystem = {
    close: fd => {
      closed.push(fd)
      fds.delete(fd)
    },
    fstat: fd => {
      const entry = fds.get(fd)

      if (!entry) {
        throw Object.assign(new Error(`EBADF: ${fd}`), { code: 'EBADF' })
      }

      return {
        ino: entry.ino,
        isCharacterDevice: () => entry.kind === 'chr',
        isFIFO: () => entry.kind === 'fifo',
        rdev: entry.rdev
      }
    },
    // readdir lists its own directory fd (the lowest free number) and closes it before returning.
    list: () => [...fds.keys(), lowestFree()].map(String),
    stat: () => {
      if (ptsRdev === null) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }

      return { rdev: ptsRdev }
    }
  }

  // node-pty's spawn: each new fd takes the lowest free number, as open(2) does.
  const spawn = (...entries: FakeFd[]) =>
    entries.map(entry => {
      const fd = lowestFree()

      fds.set(fd, entry)

      return fd
    })

  return { closed, fds, spawn, sys }
}

const STDIO = { 0: DEV_NULL, 1: pipe(101), 2: pipe(102) }

const pty = (fd: number, minor: number): DarwinPtyHandles => ({
  fd,
  ptsName: `/dev/ttys${String(minor).padStart(3, '0')}`
})

test('fd reclaim closes the spare ptmx and the slave copy and keeps the master', () => {
  const t = fakeFds(STDIO, makedev(TTY, 7))
  const before = spawnFdSnapshot(t.sys)

  const [spare, master, slave, exitQueue] = t.spawn(
    chr(makedev(PTMX, 6)),
    chr(makedev(PTMX, 7)),
    chr(makedev(TTY, 7)),
    kqueue()
  )

  const exitFds = reclaimDarwinSpawnFds(before, pty(master, 7), t.sys)

  assert.deepEqual(
    t.closed.sort((a, b) => a - b),
    [spare, slave]
  )
  assert.ok(t.fds.has(master))
  assert.deepEqual(
    exitFds.map(entry => entry.fd),
    [exitQueue]
  )
})

test('fd reclaim compares identity, so a ptmx on the listing directory fd number counts as new', () => {
  const t = fakeFds(STDIO, makedev(TTY, 8))
  const listed = t.sys.list()
  const before = spawnFdSnapshot(t.sys)

  assert.ok(before)
  // The listing's own directory fd (3) is listed but already closed: not in the snapshot.
  assert.ok(listed.includes('3'))
  assert.equal(before.has(3), false)

  const [spare, master, slave] = t.spawn(chr(makedev(PTMX, 2)), chr(makedev(PTMX, 8)), chr(makedev(TTY, 8)), kqueue())

  assert.equal(spare, 3)
  reclaimDarwinSpawnFds(before, pty(master, 8), t.sys)

  assert.deepEqual(
    t.closed.sort((a, b) => a - b),
    [spare, slave]
  )

  // A number the snapshot holds with another identity is new too: here fd 3 closed in the window
  // and the slave copy took it, which a diff by number alone would miss.
  const u = fakeFds({ ...STDIO, 3: chr(makedev(TTY, 1)) }, makedev(TTY, 2))
  const uBefore = spawnFdSnapshot(u.sys)

  u.fds.delete(3)

  const [slaveCopy, uMaster] = u.spawn(chr(makedev(TTY, 2)), chr(makedev(PTMX, 2)))

  assert.equal(slaveCopy, 3)
  reclaimDarwinSpawnFds(uBefore, pty(uMaster, 2), u.sys)
  assert.deepEqual(u.closed, [slaveCopy])
})

test('fd reclaim returns exactly one new kqueue and leaves two new kqueues open', () => {
  const one = fakeFds(STDIO, makedev(TTY, 4))
  const oneBefore = spawnFdSnapshot(one.sys)

  const [, oneMaster, , oneQueue] = one.spawn(
    chr(makedev(PTMX, 3)),
    chr(makedev(PTMX, 4)),
    chr(makedev(TTY, 4)),
    kqueue()
  )

  const exitFds = reclaimDarwinSpawnFds(oneBefore, pty(oneMaster, 4), one.sys)

  assert.deepEqual(
    exitFds.map(entry => entry.fd),
    [oneQueue]
  )
  assert.ok(one.fds.has(oneQueue))
  exitFds.forEach(entry => closeSpawnFd(entry, one.sys))
  assert.equal(one.fds.has(oneQueue), false)

  const two = fakeFds(STDIO, makedev(TTY, 5))
  const twoBefore = spawnFdSnapshot(two.sys)

  const [, twoMaster, , queueA, queueB] = two.spawn(
    chr(makedev(PTMX, 4)),
    chr(makedev(PTMX, 5)),
    chr(makedev(TTY, 5)),
    kqueue(),
    kqueue()
  )

  assert.deepEqual(reclaimDarwinSpawnFds(twoBefore, pty(twoMaster, 5), two.sys), [])
  assert.ok(two.fds.has(queueA) && two.fds.has(queueB))
})

test('fd reclaim never closes /dev/null, a foreign tty, a pipe, or another session ptmx and kqueue', () => {
  const t = fakeFds({ ...STDIO, 3: chr(makedev(PTMX, 1)), 4: kqueue() }, makedev(TTY, 6))
  const before = spawnFdSnapshot(t.sys)

  const [devNull, foreignTty, foreignPipe, spare, master, slave, exitQueue] = t.spawn(
    DEV_NULL,
    chr(makedev(TTY, 9)),
    pipe(707),
    chr(makedev(PTMX, 5)),
    chr(makedev(PTMX, 6)),
    chr(makedev(TTY, 6)),
    kqueue()
  )

  reclaimDarwinSpawnFds(before, pty(master, 6), t.sys)

  assert.deepEqual(
    t.closed.sort((a, b) => a - b),
    [spare, slave]
  )

  for (const fd of [3, 4, devNull, foreignTty, foreignPipe, master, exitQueue]) {
    assert.ok(t.fds.has(fd), `fd ${fd} must stay open`)
  }
})

test('fd reclaim closes an exit kqueue only while its fd still holds that kqueue', () => {
  const t = fakeFds(STDIO, makedev(TTY, 3))
  const queue: SpawnFd = { fd: 9, ino: 0, kqueue: true, rdev: 0 }

  t.fds.set(9, pipe(909))
  closeSpawnFd(queue, t.sys)
  assert.deepEqual(t.closed, [])

  // No master or no snapshot: nothing is reclaimed.
  assert.deepEqual(reclaimDarwinSpawnFds(null, pty(5, 3), t.sys), [])
  assert.deepEqual(reclaimDarwinSpawnFds(spawnFdSnapshot(t.sys), { ptsName: '/dev/ttys003' }, t.sys), [])
  assert.deepEqual(t.closed, [])
})

test('a reloaded, navigated or crashed renderer releases its PTYs; same-document and subframe navigations do not', () => {
  const listeners = new Map<string, ((...args: any[]) => void)[]>()

  const owner = {
    id: 7,
    on: (event: string, fn: (...args: any[]) => void) => listeners.set(event, [...(listeners.get(event) ?? []), fn]),
    once: (event: string, fn: (...args: any[]) => void) => listeners.set(event, [...(listeners.get(event) ?? []), fn])
  }

  const emit = (event: string, ...args: any[]) => (listeners.get(event) ?? []).forEach(fn => fn(...args))
  const released: number[] = []
  const watched = new Set<number>()

  watchTerminalOwner(owner, id => released.push(id), watched)
  watchTerminalOwner(owner, id => released.push(id), watched)
  assert.equal(listeners.get('did-start-navigation')?.length, 1, 'one watch per owner, however many panes it spawns')

  emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
  emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
  assert.deepEqual(released, [])

  emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  emit('did-start-navigation', {}, 'app://x', false, true)
  emit('render-process-gone', {}, { reason: 'crashed' })
  assert.deepEqual(released, [7, 7, 7])

  emit('destroyed')
  assert.deepEqual(released, [7, 7, 7, 7])
  assert.equal(watched.has(7), false)
})
