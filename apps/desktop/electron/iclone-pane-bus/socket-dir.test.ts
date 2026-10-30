/** L-1 / L-5: the bus socket only in a private directory of ours; sockets of dead runs are swept. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { listenOnSocket, sweepStaleSockets } from './ipc'

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

  await expect(listenOnSocket(server, path.join(dir, 'bus', 'bus.sock'))).rejects.toThrow('not a private directory')
  expect(existsSync(path.join(elsewhere, 'bus.sock'))).toBe(false)
  expect(server.listening).toBe(false)
})

test('a file where the socket dir should be is a refusal, not a throw out of init', async () => {
  writeFileSync(path.join(dir, 'bus'), '')

  await expect(listenOnSocket(http.createServer(), path.join(dir, 'bus', 'bus.sock'))).rejects.toThrow()
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
