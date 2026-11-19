/**
 * v0.0.9 pass 4 (rt's capture, v009-rt-done.md §5–6): the launcher socket under a long userData overflowed sun_path,
 * the socket never existed, and the agent silently lost `terminal`. Owner spec: a short per-user folder, never
 * trusted (lstat, no symlink, our uid, mode 0700), and a loud refusal instead of a silent missing tool. The old path
 * (userData/confinement/run/launcher.sock) fails the first case by construction.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  MAX_SOCKET_PATH_BYTES,
  prepareSocket,
  type SocketEntry,
  SocketFolderError,
  type SocketFs,
  socketPath
} from './launcher-socket'

const uid = typeof process.getuid === 'function' ? process.getuid() : 0

const LONG_USER_DATA = path.join(
  '/private/tmp/v009-run/e2e-sandbox-with-a-deliberately-long-name-0123456789abcdef',
  'userData',
  'Application Support',
  'icloneOS'
)

const roots: string[] = []

const scratch = () => {
  // A short root of our own (the test's TMPDIR may itself be long).
  const root = fs.mkdtempSync(path.join('/tmp', 'lsk-'))
  roots.push(root)

  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

describe('the launcher socket path', () => {
  it('a long userData still yields a socket path that fits sun_path, outside userData', () => {
    // The old place, userData/confinement/run/launcher.sock.
    const old = path.join(LONG_USER_DATA, 'confinement', 'run', 'launcher.sock')
    const file = socketPath(LONG_USER_DATA, 'launcher')

    expect(Buffer.byteLength(old)).toBeGreaterThan(MAX_SOCKET_PATH_BYTES)
    expect(Buffer.byteLength(file)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES)
    expect(file.startsWith(LONG_USER_DATA)).toBe(false)
  })

  it('the per-user temp dir first, /tmp/<uid>-<hash> only when that is still too long; deterministic per userData', () => {
    const perUser = socketPath('/u/a', 'launcher', { tmpdir: '/private/var/folders/xy/abc/T', uid: 501 })

    expect(perUser).toMatch(/^\/private\/var\/folders\/xy\/abc\/T\/ic-[0-9a-f]{10}\/launcher\.sock$/)
    expect(socketPath('/u/a', 'launcher', { tmpdir: '/private/var/folders/xy/abc/T', uid: 501 })).toBe(perUser)
    expect(socketPath('/u/b', 'launcher', { tmpdir: '/private/var/folders/xy/abc/T', uid: 501 })).not.toBe(perUser)

    const fallback = socketPath('/u/a', 'launcher', { tmpdir: `/private/var/${'x'.repeat(120)}`, uid: 501 })

    expect(fallback).toMatch(/^\/tmp\/501-[0-9a-f]{10}\/launcher\.sock$/)
  })
})

describe('the socket families', () => {
  it('each allowed name gets its own socket in the one private folder; a name off the list is refused', () => {
    const place = { tmpdir: '/private/var/folders/xy/abc/T', uid: 501 }
    const files = (['launcher', 'perm', 'pay', 'acp', 'pane'] as const).map(name => socketPath('/u/a', name, place))

    expect(new Set(files.map(file => path.dirname(file))).size).toBe(1)
    expect(files.map(file => path.basename(file))).toEqual(['launcher.sock', 'perm.sock', 'pay.sock', 'acp.sock', 'pane.sock'])
    expect(() => socketPath('/u/a', '../../etc/x' as never, place)).toThrow(SocketFolderError)
    expect(() => socketPath('/u/a', 'other' as never, place)).toThrow(/No socket named "other"/)
  })
})

describe('preparing the socket folder', () => {
  it('refuses a socket whose name is off the allow-list (prepareSocket checks it too, not only socketPath)', () => {
    const dir = path.join(scratch(), 'ic-names')

    expect(() => prepareSocket(path.join(dir, 'other.sock'), uid)).toThrow(/No socket named "other\.sock"/)
    expect(() => prepareSocket(path.join(dir, 'launcher.sock.json'), uid)).toThrow(SocketFolderError)
    expect(fs.existsSync(dir)).toBe(false)
    expect(() => prepareSocket(path.join(dir, 'pay.sock'), uid)).not.toThrow()
  })

  it('creates a missing folder 0700 and accepts it', () => {
    const file = path.join(scratch(), 'ic-ok', 'launcher.sock')

    prepareSocket(file, uid)

    expect(fs.lstatSync(path.dirname(file)).mode & 0o777).toBe(0o700)
  })

  it('a folder with the wrong mode is refused, never chmodded', () => {
    const dir = path.join(scratch(), 'ic-open')
    fs.mkdirSync(dir, { mode: 0o755 })
    fs.chmodSync(dir, 0o755)

    expect(() => prepareSocket(path.join(dir, 'launcher.sock'), uid)).toThrow(SocketFolderError)
    expect(fs.lstatSync(dir).mode & 0o777).toBe(0o755)
  })

  it('a folder owned by another uid is refused', () => {
    const dir = path.join(scratch(), 'ic-theirs')
    fs.mkdirSync(dir, { mode: 0o700 })

    expect(() => prepareSocket(path.join(dir, 'launcher.sock'), uid + 1)).toThrow(/another user/)

    // The refusal carries how to recover as data: remove that folder (named), or point TMPDIR at a private short folder.
    let caught: unknown = null

    try {
      prepareSocket(path.join(dir, 'launcher.sock'), uid + 1)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(SocketFolderError)
    expect((caught as SocketFolderError).remedy).toEqual({ removeFolder: dir, env: 'TMPDIR' })
    expect((caught as SocketFolderError).message).toContain(`rm -rf '${dir}'`)
  })

  it('a symlinked folder is refused, never followed', () => {
    const root = scratch()
    const real = path.join(root, 'real')
    fs.mkdirSync(real, { mode: 0o700 })
    fs.symlinkSync(real, path.join(root, 'ic-link'))

    expect(() => prepareSocket(path.join(root, 'ic-link', 'launcher.sock'), uid)).toThrow(/symbolic link/)
  })

  it('a path over the limit is a loud error, never a silent missing tool', () => {
    expect(() => prepareSocket(`/tmp/${'x'.repeat(120)}/launcher.sock`, uid)).toThrow(/over the 103-byte limit/)
  })

  it('our own stale socket is unlinked, and only it', () => {
    const unlinked: string[] = []

    const entry = (kind: 'dir' | 'sock', owner = uid): SocketEntry => ({
      isDirectory: () => kind === 'dir',
      isSymbolicLink: () => false,
      isSocket: () => kind === 'sock',
      mode: kind === 'dir' ? 0o40700 : 0o140600,
      uid: owner
    })

    const io: SocketFs = {
      lstatSync: (p: string) => entry(p.endsWith('.sock') ? 'sock' : 'dir'),
      mkdirSync: () => {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      },
      unlinkSync: (p: string) => void unlinked.push(p)
    }

    prepareSocket('/tmp/ic-x/launcher.sock', uid, io)
    expect(unlinked).toEqual(['/tmp/ic-x/launcher.sock'])

    const theirs: SocketFs = { ...io, lstatSync: (p: string) => (p.endsWith('.sock') ? entry('sock', uid + 1) : entry('dir')) }

    expect(() => prepareSocket('/tmp/ic-x/launcher.sock', uid, theirs)).toThrow(SocketFolderError)
  })

  it('a stale socket file of ours is removed; a foreign file in its place is refused', () => {
    const dir = path.join(scratch(), 'ic-stale')
    const file = path.join(dir, 'launcher.sock')
    fs.mkdirSync(dir, { mode: 0o700 })
    fs.writeFileSync(file, 'not a socket')

    expect(() => prepareSocket(file, uid)).toThrow(SocketFolderError)
    expect(fs.existsSync(file)).toBe(true)
  })
})

it('the default base is the canonical per-user temp dir', () => {
  const file = socketPath('/u/x', 'launcher')

  expect(file.startsWith(`${fs.realpathSync(os.tmpdir())}/ic-`) || file.startsWith(`/tmp/${uid}-`)).toBe(true)
})
