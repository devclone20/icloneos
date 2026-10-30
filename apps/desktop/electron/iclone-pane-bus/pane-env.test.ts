/**
 * The app itself started from a tmux shell (`npm run dev` in tmux): its env
 * carries TMUX/TMUX_PANE. A normal pane must still hold a working bus, so the
 * inherited TMUX never reaches it; driven through prepare(), paneProcessEnv()
 * and the real `it bus` shell fragment over a real Unix socket.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type http from 'node:http'
import path from 'node:path'

import { afterAll, beforeAll, expect, test, vi } from 'vitest'

import { createPaneBroker, type PaneBroker } from './broker'
import { BUS_CLI_FRAGMENT } from './cli'
import { createBusServer, createPaneHooks, listenOnSocket } from './ipc'
import { paneProcessEnv } from './pane-env'

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: vi.fn(() => '/tmp') },
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

const APP_IN_TMUX = { TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%3' }

let home = ''
let socket = ''
let cli = ''
let server: http.Server
let broker: PaneBroker

beforeAll(async () => {
  home = mkdtempSync(path.join('/tmp', 'v3d-env-'))
  socket = path.join(home, 'bus', 'bus.sock')
  cli = path.join(home, 'it')
  writeFileSync(cli, `#!/bin/sh\n${BUS_CLI_FRAGMENT}\nexit 1\n`, { mode: 0o700 })
  broker = createPaneBroker()
  server = createBusServer(broker)
  await listenOnSocket(server, socket)
})

afterAll(async () => {
  await new Promise(resolve => server.close(resolve))
  rmSync(home, { force: true, recursive: true })
})

function itBus(env: NodeJS.ProcessEnv, ...argv: string[]): Promise<{ out: string; err: string }> {
  return new Promise(resolve => {
    execFile('/bin/sh', [cli, 'bus', ...argv], { env }, (_error, stdout, stderr) =>
      resolve({ out: String(stdout).trim(), err: String(stderr).trim() })
    )
  })
}

test('an app run inside tmux: a normal pane has no inherited TMUX and its bus works', async () => {
  const hooks = createPaneHooks({ bus: broker, socketPath: () => socket, registryFile: () => null, log: () => {} })
  const pane = hooks.prepare({ id: 'pane-n', name: 'normal' }, { remote: false, scope: 'local', host: null })
  const env = paneProcessEnv({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...APP_IN_TMUX }, pane)

  expect(env.TMUX).toBeUndefined()
  expect(env.TMUX_PANE).toBeUndefined()
  expect(env.ICLONE_PANE_TOKEN).toMatch(/^v1\./)
  expect(await itBus(env, 'whoami')).toEqual({ out: 'normal', err: '' })

  // A tmux the pane starts itself sets TMUX again, and that shell is refused, as before.
  expect((await itBus({ ...env, TMUX: '/tmp/tmux-501/mine,9,0' }, 'whoami')).err).toContain('no bus inside tmux')
})

test('a tmux pane drops the inherited TMUX too (a tmux client refuses to nest)', () => {
  const hooks = createPaneHooks({ bus: broker, socketPath: () => socket, registryFile: () => null, log: () => {} })

  const pane = hooks.prepare(
    { id: 'pane-t', name: 't', tmux: { slug: 't' } },
    { remote: false, scope: 'local', host: null }
  )

  const env = paneProcessEnv({ PATH: '/usr/bin', ...APP_IN_TMUX }, pane)

  expect(env.TMUX).toBeUndefined()
  expect(env.TMUX_PANE).toBeUndefined()
})
