import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: { on: vi.fn() }
}))

let home = ''

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'iclone-it-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  vi.resetModules()
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(home, { force: true, recursive: true })
})

async function init(port?: number) {
  const { initIcloneIt } = await import('./iclone-it')
  initIcloneIt({ getMainWindow: () => null, port })
}

const stateFile = () => path.join(home, '.iclone-os', 'it.json')
const mode = (file: string) => statSync(file).mode & 0o777

function post(port: number, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ headers, host: '127.0.0.1', method: 'POST', path: '/cmd', port }, res => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })

    req.on('error', reject)
    req.end('{"argv":[]}')
  })
}

test('a taken port is logged, never thrown into main, and leaves no it.json behind', async () => {
  const blocker = net.createServer()
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve))
  const taken = (blocker.address() as net.AddressInfo).port
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

  try {
    await init(taken)
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())

    const [message, error] = warn.mock.calls[0] ?? []
    expect(message).toBe('[iclone] it control server failed:')
    expect((error as NodeJS.ErrnoException).code).toBe('EADDRINUSE')
    expect(() => statSync(stateFile())).toThrow()
  } finally {
    await new Promise(resolve => blocker.close(resolve))
  }
})

test('it.json holds the endpoint as compact JSON, 0600 in a 0700 dir; the CLI is 0755', async () => {
  await init()
  await vi.waitFor(() => expect(statSync(path.join(home, '.iclone-os', 'bin', 'it')).isFile()).toBe(true))

  const bytes = readFileSync(stateFile(), 'utf8')
  const state = JSON.parse(bytes) as { pid: number; port: number; token: string }

  expect(bytes).toBe(JSON.stringify({ port: state.port, token: state.token, pid: process.pid }))
  expect(state.token).toMatch(/^[0-9a-f]{48}$/)
  expect(mode(stateFile())).toBe(0o600)
  expect(mode(path.dirname(stateFile()))).toBe(0o700)
  expect(mode(path.join(home, '.iclone-os', 'bin', 'it'))).toBe(0o755)
  expect(readFileSync(path.join(home, '.iclone-os', 'bin', 'it'), 'utf8')).toMatch(/^#!\/bin\/sh/)

  expect(await post(state.port)).toBe(401)
  expect(await post(state.port, { authorization: `Bearer ${'0'.repeat(48)}` })).toBe(401)

  const { app } = await import('electron')
  const onQuit = vi.mocked(app.on).mock.calls.find(([name]) => (name as string) === 'will-quit')?.[1] as () => void
  onQuit()
  expect(() => statSync(stateFile())).toThrow()
})
