/**
 * M2 (critic r1): tmux over ssh runs a command on whatever host the connection
 * points at, and it was never proven on a lab host. It is off: a tmux pane on
 * ANY ssh connection is refused in main before any process, any bus record or
 * any registry line exists. No host label is exempt (critic r2, M2-r): through
 * `~/.ssh/config` a loopback name can be an alias, a forwarded port or a
 * ProxyJump to a remote machine. Driven through the real
 * `hermes:terminal:start` handler with node-pty mocked — no host is contacted.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import nodePty from 'node-pty'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createPaneBroker, type PaneBroker } from '../iclone-pane-bus/broker'
import { createPaneHooks } from '../iclone-pane-bus/ipc'
import { TMUX_REMOTE_OFF } from '../iclone-pane-bus/pane-env'
import { registerTerminalIpc } from '../terminal-ipc'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: vi.fn(() => os.tmpdir()), getVersion: () => '0.0.0-test' },
  ipcMain: {
    on: vi.fn(),
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)
  }
}))

vi.mock('node-pty', () => ({
  default: {
    spawn: vi.fn(() => ({ pid: 4242, onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), kill: vi.fn() }))
  }
}))

let dir = ''
let registry = ''
let broker: PaneBroker
const log = vi.fn()

type SshTarget = null | { scope: string; ssh: { host: string; user: string } }

function startOn(host: string, remoteTmuxEnabled = false, pane: object = { id: 'pane-r', tmux: { slug: 'r' } }) {
  return startWith({ scope: `ssh:${host}`, ssh: { host, user: 'owner' } }, pane, remoteTmuxEnabled)
}

function startWith(sshTarget: SshTarget, pane: object, remoteTmuxEnabled = false) {
  handlers.clear()
  registerTerminalIpc({
    isWindows: false,
    findOnPath: () => '/opt/homebrew/bin/tmux',
    rememberLog: () => {},
    activeSshTerminalTarget: () => sshTarget,
    ensureBackend: vi.fn(async () => undefined),
    getSshConnectionState: () => ({ remotePlatform: 'Linux' }),
    isTrustedSender: () => true,
    paneHooks: createPaneHooks({
      bus: broker,
      socketPath: () => '/tmp/never.sock',
      registryFile: () => registry,
      log,
      remoteTmuxEnabled
    })
  })

  const event = { sender: { id: 7, isDestroyed: () => false, send: vi.fn(), once: vi.fn(), on: vi.fn() } }

  return Promise.resolve(handlers.get('hermes:terminal:start')?.(event, { cols: 80, rows: 24, pane }))
}

const startPlainOn = (host: string) => startOn(host, false, { id: 'pane-p' })

const sshArgv = () => vi.mocked(nodePty.spawn).mock.calls.map(([file, args]) => [file, ...(args as string[])].join(' '))

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'v3d-m2-'))
  registry = path.join(dir, 'pane-remote.json')
  broker = createPaneBroker()
  vi.mocked(nodePty.spawn).mockClear()
  log.mockClear()
})

afterEach(() => rmSync(dir, { force: true, recursive: true }))

describe('M2: remote tmux is off by default', () => {
  test.each([
    ['a public address', '203.0.113.7'],
    ['a public name', 'vps.example.com'],
    ['a look-alike name', 'localhost.evil.example'],
    ['localhost', 'localhost'],
    ['IPv4 loopback (a forwarded port to a VPS)', '127.0.0.1'],
    ['IPv6 loopback', '::1'],
    ['bracketed IPv6 loopback', '[::1]'],
    ['an ssh config alias', 'lab-box'],
    ['a ProxyJump-shaped host', 'bastion.example.com,10.0.0.5']
  ])('a tmux pane on %s (%s) is refused: no process, no bus record, no registry line', async (_label, host) => {
    await expect(startOn(host)).rejects.toThrow(TMUX_REMOTE_OFF)

    expect(nodePty.spawn).not.toHaveBeenCalled()
    expect(broker.snapshot()).toEqual([])
    expect(() => readFileSync(registry, 'utf8')).toThrow()
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ verb: 'tmux-remote-refused' }))
  })

  test('a plain (non-tmux) pane over ssh still starts', async () => {
    await startPlainOn('localhost')

    expect(nodePty.spawn).toHaveBeenCalledTimes(1)
  })

  test('the flag, when a lab proof turns it on, lets a remote host through, and no ICLONE_PANE_* rides ssh', async () => {
    await startOn('203.0.113.7', true)

    expect(sshArgv()[0]).toContain('new-session -A -s')

    const env = vi.mocked(nodePty.spawn).mock.calls[0]?.[2]?.env ?? {}

    expect(Object.keys(env).filter(key => key.startsWith('ICLONE_PANE_'))).toEqual([])
  })
})

/**
 * S-1 (critic r3): a profile-routed ssh scope is the raw profile name, and a
 * Hermes profile may be named `local`. The guards read the connection kind,
 * never the scope string.
 */
describe('S-1: an ssh connection whose scope is the string "local"', () => {
  const SSH_NAMED_LOCAL: SshTarget = { scope: 'local', ssh: { host: 'vps.example.com', user: 'owner' } }

  const paneKeys = () =>
    Object.keys(vi.mocked(nodePty.spawn).mock.calls[0]?.[2]?.env ?? {}).filter(key => key.startsWith('ICLONE_PANE_'))

  test('a tmux pane is refused: no process, no bus record, no registry line', async () => {
    await expect(startWith(SSH_NAMED_LOCAL, { id: 'pane-l', tmux: { slug: 'l' } })).rejects.toThrow(TMUX_REMOTE_OFF)

    expect(nodePty.spawn).not.toHaveBeenCalled()
    expect(broker.snapshot()).toEqual([])
    expect(() => readFileSync(registry, 'utf8')).toThrow()
  })

  test('a plain pane starts over ssh with no bus token in the ssh process env', async () => {
    await startWith(SSH_NAMED_LOCAL, { id: 'pane-lp', name: 'lp' })

    expect(vi.mocked(nodePty.spawn).mock.calls[0]?.[0]).toBe('ssh')
    expect(paneKeys()).toEqual([])
  })

  test('control: a real local pane is on the bus, and a real local tmux pane runs local tmux', async () => {
    await startWith(null, { id: 'pane-loc', name: 'loc' })

    expect(paneKeys()).toEqual(expect.arrayContaining(['ICLONE_PANE_ID', 'ICLONE_PANE_TOKEN', 'ICLONE_PANE_SOCK']))

    vi.mocked(nodePty.spawn).mockClear()
    await startWith(null, { id: 'pane-loct', tmux: { slug: 'lt' } })

    expect(vi.mocked(nodePty.spawn).mock.calls[0]?.[0]).toBe('/opt/homebrew/bin/tmux')
    expect(paneKeys()).toEqual([])
  })
})
