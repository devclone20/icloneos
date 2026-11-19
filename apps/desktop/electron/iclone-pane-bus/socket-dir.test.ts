/** L-1 / L-5: the bus socket only in a private directory of ours; sockets of dead runs are swept. v0.0.9: the bus
 *  socket is the 'pane' socket of the short private socket folder of this userData (launcher-socket.ts). */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { MAX_SOCKET_PATH_BYTES, SocketFolderError, socketPath } from '../iclone-confinement/launcher-socket'

import { listenOnSocket, paneBusSocketFile, sweepStaleSockets } from './ipc'

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: vi.fn(() => '/tmp') },
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(path.join('/tmp', 'v3d-sd-'))
})

afterEach(() => rmSync(dir, { force: true, recursive: true }))

test('a planted symlink where the socket dir should be is refused; nothing is bound in its target', async () => {
  const elsewhere = path.join(dir, 'elsewhere')

  mkdirSync(elsewhere)
  symlinkSync(elsewhere, path.join(dir, 'bus'))

  const server = http.createServer()

  await expect(listenOnSocket(server, path.join(dir, 'bus', 'pane.sock'))).rejects.toThrow(/refuses the socket folder .*symbolic link/)
  expect(existsSync(path.join(elsewhere, 'pane.sock'))).toBe(false)
  expect(server.listening).toBe(false)
})

test('a file where the socket dir should be is a refusal, not a throw out of init', async () => {
  writeFileSync(path.join(dir, 'bus'), '')

  await expect(listenOnSocket(http.createServer(), path.join(dir, 'bus', 'pane.sock'))).rejects.toThrow()
})

test('sockets of runs whose pid is gone are swept; a live pid and other files stay', () => {
  const bus = path.join(dir, 'bus')

  mkdirSync(bus)

  const dead = 2 ** 22 + 12_345

  for (const name of [`bus-${dead}.sock`, `bus-${process.pid}.sock`, `bus-${process.ppid}.sock`, 'notes.txt']) {
    writeFileSync(path.join(bus, name), '')
  }

  expect(sweepStaleSockets(bus)).toBe(1)
  expect(existsSync(path.join(bus, `bus-${dead}.sock`))).toBe(false)
  expect(existsSync(path.join(bus, `bus-${process.ppid}.sock`))).toBe(true)
  expect(existsSync(path.join(bus, 'notes.txt'))).toBe(true)
})

test('v0.0.9: the bus socket is the short private pane socket of this userData, never under it; a client reaches it', async () => {
  const userData = path.join(dir, 'a-deliberately-long-userData-folder-name-0123456789abcdef', 'Application Support', 'icloneOS')
  const file = paneBusSocketFile(userData)

  expect(file).toBe(socketPath(userData, 'pane'))
  expect(path.basename(file)).toBe('pane.sock')
  expect(file.startsWith(`${userData}${path.sep}`)).toBe(false)
  expect(file.startsWith(path.join(os.homedir(), '.iclone-os'))).toBe(false)
  expect(Buffer.byteLength(file)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES)

  const folder = path.dirname(file)
  const tmp = realpathSync(os.tmpdir())

  expect(
    (path.dirname(folder) === tmp && /^ic-[0-9a-f]{10}$/.test(path.basename(folder))) || /^\/tmp\/\d+-[0-9a-f]{10}$/.test(folder)
  ).toBe(true)

  const server = http.createServer((_req, res) => res.end('pong'))

  try {
    await listenOnSocket(server, file)
    expect(lstatSync(folder).mode & 0o777).toBe(0o700)
    expect(lstatSync(file).mode & 0o777).toBe(0o600)

    const body = await new Promise<string>((resolve, reject) => {
      http
        .get({ socketPath: file, path: '/' }, res => {
          let data = ''

          res.on('data', chunk => (data += String(chunk)))
          res.on('end', () => resolve(data))
        })
        .on('error', reject)
    })

    expect(body).toBe('pong')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(folder, { force: true, recursive: true })
  }
})

test('v0.0.9: a socket folder that is not exactly 0700 is refused (never chmodded), before anything binds', async () => {
  const bus = path.join(dir, 'bus')

  mkdirSync(bus)
  chmodSync(bus, 0o755)

  const server = http.createServer()

  await expect(listenOnSocket(server, path.join(bus, 'pane.sock'))).rejects.toThrow(SocketFolderError)
  expect(lstatSync(bus).mode & 0o777).toBe(0o755)
  expect(server.listening).toBe(false)
})

test('v0.0.9: a file that is not our socket where the socket goes is refused, never removed', async () => {
  const bus = path.join(dir, 'bus')

  mkdirSync(bus, { mode: 0o700 })
  writeFileSync(path.join(bus, 'pane.sock'), 'keep')

  await expect(listenOnSocket(http.createServer(), path.join(bus, 'pane.sock'))).rejects.toThrow(SocketFolderError)
  expect(readFileSync(path.join(bus, 'pane.sock'), 'utf8')).toBe('keep')
})
