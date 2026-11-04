/**
 * The quit's remote serve reap goes through the open control master, before the forward is cancelled and the master
 * closed. A real SshConnection (mux, as on macOS) runs every step; its spawnFn records each ssh argv and answers as the
 * remote host would, so no ssh runs. Locks:
 *  - every reap exec carries `-o ControlPath=<this connection's socket>`;
 *  - the reap's kill runs before `-O cancel`, and `-O cancel` before `-O exit`;
 *  - a host whose `ps` cannot run (the ownership script gets an OSError) gives the named outcome
 *    'ownership-unverifiable': nothing is signalled, the lockfile is kept, and it is not called a transport error.
 */
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { teardownSshState } from './connection-apply'
import {
  disconnect,
  fingerprintToken,
  LOCKFILE_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  spawnLogPath
} from './remote-lifecycle'
import { SshConnection } from './ssh-connection'

const OWNERSHIP_ID = crypto.randomBytes(16).toString('hex')
const NONCE = crypto.randomBytes(8).toString('hex')
const LOCAL_PORT = 65222
const REMOTE_PORT = 65221

type Answer = (remoteCommand: string) => { code: number; stdout: string }

let dir = ''
let spawns: string[][] = []

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-order-'))
  spawns = []
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function lockRecord(pid: number) {
  return JSON.stringify({
    schemaVersion: LOCKFILE_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    ownershipId: OWNERSHIP_ID,
    spawnNonce: NONCE,
    pid,
    port: REMOTE_PORT,
    profile: '',
    hermesPath: '~/.local/bin/hermes',
    hermesHome: '~/.hermes',
    logPath: spawnLogPath(OWNERSHIP_ID, NONCE),
    tokenFingerprint: fingerprintToken(crypto.randomBytes(16).toString('hex')),
    startedAt: new Date().toISOString()
  })
}

/** The remote host for a live, owned serve; `ownership` answers the python3 ownership check. */
function host(pid: number, ownership: Answer): Answer {
  return command => {
    if (command.includes('backend.lock.json') && command.includes('cat ')) {
      return { code: 0, stdout: lockRecord(pid) }
    }

    if (command.startsWith(`kill -0 ${pid} `)) {
      return { code: 0, stdout: 'ALIVE\n' }
    }

    if (command.startsWith('python3 -c ')) {
      return ownership(command)
    }

    return { code: 0, stdout: '' }
  }
}

/** A real mux SshConnection whose ssh children are stand-ins answered by `answer`; the master counts as open. */
function connection(answer: Answer) {
  const spawnFn = (file: string, args: string[]) => {
    expect(file).toBe('ssh')
    spawns.push(args)

    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => true
    })

    const control = args[0] === '-O'
    const { code, stdout } = control ? { code: 0, stdout: '' } : answer(args[args.length - 1])

    setImmediate(() => {
      if (stdout) {
        child.stdout.emit('data', stdout)
      }

      child.emit('close', code)
    })

    return child
  }

  const ssh = new SshConnection({ host: 'shimhost.test', user: 'shim' }, { mux: true, controlDir: dir, spawnFn })
  ssh._opened = true

  return ssh
}

async function quitTeardown(ssh: SshConnection) {
  const lines: string[] = []
  await teardownSshState(
    { ssh, ownershipId: OWNERSHIP_ID, localPort: LOCAL_PORT, remotePort: REMOTE_PORT },
    { cleanupRemote: disconnect, log: line => lines.push(line) }
  )

  return lines
}

const remoteCommand = (args: string[]) => (args[0] === '-O' ? '' : args[args.length - 1])
const indexOf = (match: (args: string[]) => boolean) => spawns.findIndex(match)
const isKill = (pid: number) => (args: string[]) => remoteCommand(args).startsWith(`kill ${pid} && `)
const isControl = (op: string) => (args: string[]) => args[0] === '-O' && args[1] === op

function expectEverySpawnOnTheMaster(ssh: SshConnection) {
  expect(ssh.controlPath).toMatch(/\.sock$/)

  for (const args of spawns) {
    const at = args.indexOf(`ControlPath=${ssh.controlPath}`)
    expect(at, `no ControlPath in: ${args.join(' ')}`).toBeGreaterThan(0)
    expect(args[at - 1]).toBe('-o')
  }
}

describe('quit reap through the open control master', () => {
  it('kills the owned serve over the master, then cancels the forward, then closes the master', async () => {
    const pid = 4242
    const ssh = connection(host(pid, () => ({ code: 0, stdout: 'OWNED\n' })))

    expect(await quitTeardown(ssh)).toEqual(['[ssh] remote serve reap: killed'])

    const kill = indexOf(isKill(pid))
    const cancel = indexOf(isControl('cancel'))
    const exit = indexOf(isControl('exit'))
    expect(kill).toBeGreaterThanOrEqual(0)
    expect(cancel).toBeGreaterThan(kill)
    expect(exit).toBeGreaterThan(cancel)
    expect(exit).toBe(spawns.length - 1)
    // Every remote exec of the reap (lock read, liveness, ownership, kill, cleanup) comes before the cancel.
    expect(spawns.slice(cancel + 1).every(args => args[0] === '-O')).toBe(true)
    expect(spawns[cancel]).toContain(`127.0.0.1:${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}`)
    expectEverySpawnOnTheMaster(ssh)
  })

  it("a host that answers UNVERIFIABLE gives 'ownership-unverifiable': no kill, lockfile kept, master still closed", async () => {
    const pid = 4243
    const ssh = connection(host(pid, () => ({ code: 0, stdout: 'UNVERIFIABLE\n' })))

    expect(await quitTeardown(ssh)).toEqual(['[ssh] remote serve reap: error (Error, ownership-unverifiable)'])
    expect(spawns.some(args => /(^|[;&] *)kill (-9 )?\d/.test(remoteCommand(args)))).toBe(false)
    expect(spawns.some(args => remoteCommand(args).startsWith('rm -f'))).toBe(false)
    expect(indexOf(isControl('exit'))).toBeGreaterThan(indexOf(isControl('cancel')))
    expectEverySpawnOnTheMaster(ssh)
  })

  // The product's own ownership script, run by a real python3 on a host with no usable ps (this pid is alive; macOS
  // has no /proc, so the script must fall back to ps). Only macOS lacks /proc.
  it.skipIf(process.platform !== 'darwin')(
    'the real ownership script turns an OSError from ps into UNVERIFIABLE, not a transport error',
    async () => {
      const python = spawnSync('/usr/bin/python3', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' })
      expect(python.status).toBe(0)
      const bin = path.join(dir, 'bin')
      fs.mkdirSync(bin)
      fs.symlinkSync(python.stdout.trim(), path.join(bin, 'python3'))

      let ran = ''

      const ownership: Answer = command => {
        const result = spawnSync('/bin/sh', ['-c', command], {
          encoding: 'utf8',
          env: { HOME: dir, PATH: bin, LC_ALL: 'C' }
        })

        ran = `${result.status}:${result.stdout.trim()}`

        return { code: result.status ?? 1, stdout: result.stdout }
      }

      const pid = process.pid
      const ssh = connection(host(pid, ownership))

      expect(await quitTeardown(ssh)).toEqual(['[ssh] remote serve reap: error (Error, ownership-unverifiable)'])
      expect(ran).toBe('0:UNVERIFIABLE')
      expect(spawns.some(args => remoteCommand(args).startsWith(`kill ${pid} `))).toBe(false)
      expectEverySpawnOnTheMaster(ssh)
    }
  )
})
