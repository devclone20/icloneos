/**
 * The tmux local session test (G4 on localhost, the lab host of round 1).
 * `script` gives tmux a real pty the way node-pty does in the app; SIGKILL on
 * it is the app dying. Every session lives on a throwaway `-L` label, so the
 * owner's tmux server is never touched, and is killed in afterAll.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, test, vi } from 'vitest'

import { localTmuxAttachArgs, parseTmuxList, remoteTmuxCommand, TMUX_SOCKET_LABEL, tmuxSessionFor } from './tmux-cmd'

const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find(existsSync)
const LABEL = `iclone-v3d-test-${process.pid}`

// The app's argv, on a test label instead of the app's own.
const testArgs = (args: string[]) => args.map(arg => (arg === TMUX_SOCKET_LABEL ? LABEL : arg))

function tmux(...args: string[]): string {
  return execFileSync(TMUX ?? 'tmux', ['-L', LABEL, ...args], { encoding: 'utf8' })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch {
    return false
  }
}

// The app, reduced to what matters here: a node process holding a node-pty
// master. `kill -9` on it is the app dying; the pty closes with it.
const HOLDER = `
const pty = require('node-pty')
const [file, ...args] = JSON.parse(process.argv[1])
pty.spawn(file, args, { cols: 80, rows: 24, env: JSON.parse(process.argv[2]) })
setInterval(() => {}, 1 << 30)
`

const cleanEnv = () =>
  Object.fromEntries(
    Object.entries({ ...process.env, TERM: 'xterm-256color' }).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[0] !== 'TMUX' && entry[0] !== 'TMUX_PANE'
    )
  )

function holdPty(file: string, args: string[]) {
  return spawn(process.execPath, ['-e', HOLDER, JSON.stringify([file, ...args]), JSON.stringify(cleanEnv())], {
    cwd: path.resolve(__dirname, '..', '..'),
    stdio: 'ignore'
  })
}

/** A client attached through a pty, the way a pane holds it. */
const attachClient = (session: string) => holdPty(TMUX ?? 'tmux', testArgs(localTmuxAttachArgs(session)))

afterAll(() => {
  try {
    tmux('kill-server')
  } catch {
    // No server left.
  }

  rmSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.() ?? 0}`, LABEL), { force: true })
})

describe('session names', () => {
  test('a name with shell syntax is refused before any command is built', () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'v3d-inject-'))
    const marker = path.join(scratch, 'x')

    try {
      expect(() => localTmuxAttachArgs(`a;touch ${marker}`)).toThrow()
      expect(() => remoteTmuxCommand(`a;touch ${marker}`)).toThrow()
      expect(() => remoteTmuxCommand("a'b")).toThrow()
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(scratch, { force: true, recursive: true })
    }
  })

  test('generated names are valid and capped at 48', () => {
    expect(tmuxSessionFor('Build Bot!', 'A1B2-C3D4-E5F6')).toBe('iclone-build-bot-a1b2c3d4')
    expect(tmuxSessionFor('x'.repeat(80), 'abcdef0123').length).toBeLessThanOrEqual(48)
  })

  test('the remote command single-quotes the session and never reads tmux.conf', () => {
    const command = remoteTmuxCommand('iclone-it-abc')

    expect(command).toContain("new-session -A -s 'iclone-it-abc'")
    expect(command).toContain("'-f' '/dev/null'")
    expect(command).toContain('command -v tmux')
  })

  test('the listing parser keeps only well-formed rows', () => {
    expect(parseTmuxList('iclone-a\t1700000000\t0\nbad row\n')).toEqual([
      { name: 'iclone-a', createdAt: 1_700_000_000_000, attached: 0 }
    ])
  })
})

describe.skipIf(!TMUX)('G4 local: a tmux pane survives the app by PID; a plain pane does not', () => {
  test('sleep 3600 keeps its pid across kill -9 of the client and a re-attach', async () => {
    const session = tmuxSessionFor('g4', `${process.pid}abcdef`)
    const first = attachClient(session)

    await vi.waitFor(() => expect(tmux('list-sessions', '-F', '#{session_name}')).toContain(session), {
      timeout: 5000,
      interval: 100
    })

    tmux('send-keys', '-t', `=${session}:`, 'exec sleep 3600', 'Enter')

    const pidOf = () => Number(tmux('list-panes', '-t', `=${session}:`, '-F', '#{pane_pid}').trim())

    await vi.waitFor(
      () => expect(execFileSync('ps', ['-o', 'comm=', '-p', String(pidOf())], { encoding: 'utf8' })).toMatch(/sleep/),
      { timeout: 5000, interval: 100 }
    )

    const pid = pidOf()
    const before = tmux('list-sessions', '-F', '#{session_name}').trim().split('\n').length

    first.kill('SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 500))

    expect(alive(pid)).toBe(true)
    expect(tmux('list-sessions', '-F', '#{session_name}').trim().split('\n')).toHaveLength(before)

    const started = performance.now()
    const second = attachClient(session)

    await vi.waitFor(() => expect(tmux('list-sessions', '-F', '#{session_attached}').trim()).toBe('1'), {
      timeout: 10_000,
      interval: 100
    })

    expect(performance.now() - started).toBeLessThan(10_000)
    expect(pidOf()).toBe(pid)
    expect(alive(pid)).toBe(true)

    second.kill('SIGKILL')
    tmux('kill-session', '-t', `=${session}`)
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000, interval: 100 })
  }, 30_000)

  test('negative control: the same drill on a plain pty kills the process', async () => {
    const marker = `v3d-negative-${process.pid}`
    const plain = holdPty('/bin/sh', ['-c', `exec -a ${marker} sleep 3600`])

    const pidOfSleep = () => {
      try {
        return Number(execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim().split('\n')[0])
      } catch {
        return 0
      }
    }

    await vi.waitFor(() => expect(pidOfSleep()).toBeGreaterThan(0), { timeout: 5000, interval: 100 })

    const pid = pidOfSleep()

    plain.kill('SIGKILL')
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000, interval: 100 })
  }, 15_000)
})
