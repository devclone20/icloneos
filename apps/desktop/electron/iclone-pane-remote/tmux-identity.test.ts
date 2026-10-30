/**
 * M1 (critic r1): a tmux server freezes the environment of the client that
 * starts it, so a bus token handed to the first tmux pane reached every later
 * session's shell. The app's real start path — prepare() then paneProcessEnv()
 * — is driven here against a REAL tmux server on a throwaway `-L` label, with
 * a real bus on a Unix socket and the real `it bus` shell fragment.
 *
 * The base environment deliberately carries pane #1's live token (an app
 * started from inside a pane, or a polluted server), the worst case.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

import { createPaneBroker, type PaneBroker } from '../iclone-pane-bus/broker'
import { BUS_CLI_FRAGMENT } from '../iclone-pane-bus/cli'
import { createBusServer, createPaneHooks, listenOnSocket, type TerminalPaneHooks } from '../iclone-pane-bus/ipc'
import { paneProcessEnv, type PreparedPane } from '../iclone-pane-bus/pane-env'

import { TMUX_SOCKET_LABEL } from './tmux-cmd'

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: vi.fn(() => '/tmp') },
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find(existsSync)
const LABEL = `iclone-v3d-id-${process.pid}`
const LOCAL = { remote: false, scope: 'local', host: null }

let home = ''
let socket = ''
let cli = ''
let server: http.Server
let broker: PaneBroker
let hooks: TerminalPaneHooks
let paneOneToken = ''

const tmux = (...args: string[]): string => execFileSync(TMUX ?? 'tmux', ['-L', LABEL, ...args], { encoding: 'utf8' })

// The app's argv, on the test label instead of the app's own.
const onTestLabel = (args: string[]) => args.map(arg => (arg === TMUX_SOCKET_LABEL ? LABEL : arg))

// The app reduced to a node process holding a node-pty master.
const HOLDER = `
const pty = require('node-pty')
const [file, ...args] = JSON.parse(process.argv[1])
pty.spawn(file, args, { cols: 80, rows: 24, env: JSON.parse(process.argv[2]) })
setInterval(() => {}, 1 << 30)
`

function baseEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TERM: 'xterm-256color',
    // A plain shell, no owner dotfiles: what the shell sees is what tmux gave it.
    SHELL: '/bin/sh',
    // Worst case: the client starting tmux carries pane #1's live identity.
    ICLONE_PANE_ID: 'pane-one',
    ICLONE_PANE_NAME: 'one',
    ICLONE_PANE_TOKEN: paneOneToken,
    ICLONE_PANE_SOCK: socket
  }
}

function startClient(pane: PreparedPane) {
  if (!pane.tmux) {
    throw new Error('not a tmux pane')
  }

  const env = paneProcessEnv(baseEnv(), pane)

  return spawn(
    process.execPath,
    ['-e', HOLDER, JSON.stringify([TMUX, ...onTestLabel(pane.tmux.localArgs)]), JSON.stringify(env)],
    { cwd: path.resolve(__dirname, '..', '..'), stdio: 'ignore' }
  )
}

/** What the shell in `session` holds and what `it bus` tells it, read from inside that shell. */
async function insideShell(session: string, tag: string): Promise<{ token: string; bus: string }> {
  const tokenFile = path.join(home, `${tag}.token`)
  const busFile = path.join(home, `${tag}.bus`)

  tmux(
    'send-keys',
    '-t',
    `=${session}:`,
    `printf '%s' "\${ICLONE_PANE_TOKEN:-none}" > ${tokenFile}; sh ${cli} bus send --to one "as one" > ${busFile} 2>&1`,
    'Enter'
  )
  await vi.waitFor(() => expect(existsSync(busFile) && readFileSync(busFile, 'utf8').length > 0).toBe(true), {
    timeout: 8000,
    interval: 50
  })

  return { token: readFileSync(tokenFile, 'utf8'), bus: readFileSync(busFile, 'utf8') }
}

async function waitForSession(session: string): Promise<void> {
  await vi.waitFor(() => expect(tmux('list-sessions', '-F', '#{session_name}')).toContain(session), {
    timeout: 8000,
    interval: 100
  })
  // The login shell has drawn its prompt (it reads keys from then on).
  await vi.waitFor(() => expect(tmux('capture-pane', '-p', '-t', `=${session}:`).trim()).not.toBe(''), {
    timeout: 8000,
    interval: 100
  })
}

beforeAll(async () => {
  home = mkdtempSync(path.join('/tmp', 'v3d-id-'))
  socket = path.join(home, 'bus', 'bus.sock')
  cli = path.join(home, 'it')
  writeFileSync(cli, `#!/bin/sh\n${BUS_CLI_FRAGMENT}\necho "not a bus call" >&2\nexit 1\n`, { mode: 0o700 })

  broker = createPaneBroker()
  server = createBusServer(broker)
  await listenOnSocket(server, socket)
  hooks = createPaneHooks({ bus: broker, socketPath: () => socket, registryFile: () => null, log: () => {} })

  const one = hooks.prepare({ id: 'pane-one', name: 'one' }, LOCAL)

  paneOneToken = one?.identity?.ICLONE_PANE_TOKEN ?? ''
})

function killServer(): void {
  try {
    tmux('kill-server')
  } catch {
    // No server left.
  }
}

afterAll(async () => {
  killServer()
  // tmux leaves its socket file behind; this label is ours alone.
  rmSync(path.join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${os.userInfo().uid}`, LABEL), { force: true })

  await new Promise(resolve => server.close(resolve))
  // The killed sessions' shells may still be flushing a file.
  rmSync(home, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 })
})

describe.skipIf(!TMUX)('M1: no bus identity crosses tmux', () => {
  test('pane #1 (plain) holds a live token; tmux panes get none, so a second session cannot send as #1', async () => {
    expect(paneOneToken).toMatch(/^v1\./)
    expect(broker.authenticate(paneOneToken)).toBe('pane-one')

    const a = hooks.prepare({ id: 'pane-tmux-a', name: 'ta', tmux: { slug: 'a' } }, LOCAL)
    const b = hooks.prepare({ id: 'pane-tmux-b', name: 'tb', tmux: { slug: 'b' } }, LOCAL)

    expect(a?.identity).toBeNull()
    expect(b?.identity).toBeNull()

    const clientA = a ? startClient(a) : null
    const clientB = b ? startClient(b) : null

    try {
      await waitForSession(a?.tmux?.session ?? '')
      await waitForSession(b?.tmux?.session ?? '')

      // The tmux server itself holds no bus variable, globally or in either session.
      expect(tmux('show-environment', '-g')).not.toMatch(/ICLONE_PANE_/)
      expect(tmux('show-environment', '-t', `=${b?.tmux?.session}`)).not.toMatch(/ICLONE_PANE_/)

      const seenA = await insideShell(a?.tmux?.session ?? '', 'a')
      const seenB = await insideShell(b?.tmux?.session ?? '', 'b')

      expect(seenA.token).toBe('none')
      expect(seenB.token).toBe('none')
      expect(seenB.bus).toContain('no bus inside tmux')

      // Nothing was sent as anyone; pane one's inbox is empty.
      expect(broker.stats()).toMatchObject({ sent: 0, forged: 0 })
      expect(broker.snapshot().find(pane => pane.paneId === 'pane-one')?.unread).toBe(0)

      // The tmux panes are known (state, attention) but hold no bus: messages to them are refused, not queued.
      expect(broker.snapshot().find(pane => pane.paneId === 'pane-tmux-a')).toMatchObject({ bus: false })
      expect((await broker.run('pane-one', ['send', '--to', 'ta', 'hi'])).text).toContain('no bus in this release')
    } finally {
      clientA?.kill('SIGKILL')
      clientB?.kill('SIGKILL')
    }
  }, 40_000)

  test('a re-attach after the client died reports "no bus inside tmux", never a revoked or borrowed token', async () => {
    const first = hooks.prepare({ id: 'pane-tmux-r', name: 'tr', tmux: { slug: 'r' } }, LOCAL)
    const session = first?.tmux?.session ?? ''
    const clientOne = first ? startClient(first) : null

    await waitForSession(session)
    clientOne?.kill('SIGKILL')
    hooks.exited('pane-tmux-r', { code: null, signal: 'SIGKILL' })

    const again = hooks.prepare({ id: 'pane-tmux-r2', name: 'tr2', tmux: { attach: session } }, LOCAL)

    expect(again?.tmux?.session).toBe(session)
    expect(again?.identity).toBeNull()

    const clientTwo = again ? startClient(again) : null

    try {
      await vi.waitFor(() => expect(tmux('list-sessions', '-F', '#{session_attached}')).toContain('1'), {
        timeout: 8000,
        interval: 100
      })

      const seen = await insideShell(session, 'r')

      expect(seen.token).toBe('none')
      expect(seen.bus).toContain('no bus inside tmux')
      expect(broker.stats().sent).toBe(0)
    } finally {
      clientTwo?.kill('SIGKILL')
    }
  }, 40_000)
})

describe.skipIf(!TMUX)('R1 (critic r2): the app owns the -L iclone server environment', () => {
  test('a normal pane starts the server first with its token; the next app tmux pane holds none', async () => {
    killServer()

    // Pane one, by hand: `tmux -L iclone new -d` from a shell that holds its token, with a
    // tmux.conf that widened update-environment to the token. tmux freezes that env as global.
    execFileSync(
      TMUX ?? 'tmux',
      [
        '-L',
        LABEL,
        'new-session',
        '-d',
        '-s',
        'by-hand',
        ';',
        'set-option',
        '-g',
        'update-environment',
        'ICLONE_PANE_TOKEN ICLONE_PANE_SOCK'
      ],
      { env: baseEnv() }
    )
    expect(tmux('show-environment', '-g')).toContain(`ICLONE_PANE_TOKEN=${paneOneToken}`)

    const app = hooks.prepare({ id: 'pane-tmux-s', name: 'ts', tmux: { slug: 's' } }, LOCAL)
    const client = app ? startClient(app) : null

    try {
      await waitForSession(app?.tmux?.session ?? '')

      expect(tmux('show-environment', '-g')).not.toMatch(/ICLONE_PANE_/)
      expect(tmux('show-options', '-g', 'update-environment')).not.toMatch(/ICLONE_PANE_/)

      const seen = await insideShell(app?.tmux?.session ?? '', 's')

      expect(seen.token).toBe('none')
      expect(broker.stats().sent).toBe(0)
    } finally {
      client?.kill('SIGKILL')
    }
  }, 40_000)
})
