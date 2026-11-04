/**
 * The quit's remote serve reap, against real processes on this machine standing in for the remote host: the serve is
 * spawned by the app's own spawn command (setsid/nohup detach, the ownership reservation, the lockfile), with the argv
 * a real install has (`<root>/venv/bin/python <root>/venv/bin/hermes serve …`, reached through a launcher that execs
 * the venv entry), and the stand-in connection runs every command through /bin/sh. So 'killed' can only be reported
 * when the real `kill` reached the real process, and a serve this app did not start (wrong nonce) is never touched.
 */
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { teardownSshState } from './connection-apply'
import {
  buildSpawnCommand,
  disconnect,
  fingerprintToken,
  PROTOCOL_VERSION,
  readLockfile,
  spawnLogPath,
  spawnTokenPath,
  writeLockfile
} from './remote-lifecycle'

const PYTHON = process.env.ICLONE_RUNTIME_PY || '/usr/bin/python3'
// The host's own python3 (the ownership check runs `python3 -c`): the same interpreter unless a run names another.
const HOST_PYTHON = process.env.REAP_HOST_PYTHON || PYTHON

let root = ''
let home = ''
let commands: string[] = []
const spawnedPids: number[] = []

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch {
    return false
  }
}

function argvOf(pid: number): string {
  return spawnSync('/bin/ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
}

/** The stand-in connection: each command runs through /bin/sh as the remote login would; a non-zero exit throws. */
function standInConnection() {
  return {
    exec(command: string): Promise<string> {
      commands.push(command)

      return new Promise((resolve, reject) => {
        const child = spawn('/bin/sh', ['-c', command], {
          cwd: home,
          env: { HOME: home, PATH: `${root}/bin:/usr/bin:/bin`, TMPDIR: `${root}/tmp/`, LC_ALL: 'C' },
          stdio: ['ignore', 'pipe', 'pipe']
        })

        let out = ''
        child.stdout.on('data', chunk => (out += String(chunk)))
        child.stderr.on('data', () => undefined)
        child.on('error', reject)
        child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`remote command exited ${code}`))))
      })
    },
    cancelForward: async () => undefined,
    close: async () => undefined
  }
}

async function waitFor(check: () => boolean, ms = 8_000): Promise<boolean> {
  const until = Date.now() + ms

  while (Date.now() < until) {
    if (check()) {
      return true
    }

    await new Promise(resolve => setTimeout(resolve, 50))
  }

  return check()
}

/** Spawns a serve with the app's own spawn command and publishes the lockfile as connect does; returns its pid. */
async function spawnOwnedServe(ssh: ReturnType<typeof standInConnection>, ownershipId: string, nonce: string) {
  const token = crypto.randomBytes(16).toString('hex')

  const lock = {
    ownershipId,
    spawnNonce: nonce,
    port: 0,
    profile: '',
    hermesPath: '~/.local/bin/hermes',
    hermesHome: '~/.hermes',
    logPath: spawnLogPath(ownershipId, nonce),
    tokenFingerprint: fingerprintToken(token),
    protocolVersion: PROTOCOL_VERSION,
    startedAt: new Date().toISOString()
  }

  const out = await ssh.exec(
    buildSpawnCommand('~/.local/bin/hermes', '', {
      spawnNonce: nonce,
      tokenFilePath: spawnTokenPath(ownershipId, nonce),
      logPath: lock.logPath,
      hermesHome: '~/.hermes',
      ownershipId,
      reservationNonce: nonce,
      lockMetadata: lock
    })
  )

  const pid = parseInt(out.trim().split('\n').at(-1) || '', 10)
  expect(Number.isInteger(pid) && pid > 1).toBe(true)
  spawnedPids.push(pid)
  // The launcher and the venv entry exec in place: the recorded pid becomes the serve itself.
  expect(await waitFor(() => argvOf(pid).includes(`python ${root}/venv/bin/hermes serve --isolated `))).toBe(true)
  await writeLockfile(ssh, ownershipId, { ...lock, pid })

  return pid
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'serve-reap-')))
  home = path.join(root, 'home')
  commands = []

  for (const dir of ['bin', 'tmp', 'venv/bin', 'home/.local/bin', 'home/.hermes']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }

  // A host with python3 on PATH, a venv whose python runs the hermes entry, and the installer's launcher.
  fs.symlinkSync(HOST_PYTHON, path.join(root, 'bin/python3'))
  fs.symlinkSync(PYTHON, path.join(root, 'venv/bin/python'))
  fs.writeFileSync(
    path.join(root, 'venv/bin/hermes'),
    `#!${root}/venv/bin/python\nimport sys, time\nprint("serving", flush=True)\ntime.sleep(300)\n`,
    { mode: 0o700 }
  )
  fs.writeFileSync(path.join(home, '.local/bin/hermes'), `#!/bin/sh\nexec '${root}/venv/bin/hermes' "$@"\n`, {
    mode: 0o700
  })
})

afterEach(() => {
  // Only the pids this file spawned.
  for (const pid of spawnedPids.splice(0)) {
    if (alive(pid)) {
      process.kill(pid, 'SIGKILL')
    }
  }

  fs.rmSync(root, { recursive: true, force: true })
})

describe('the quit reaps the remote serve this app started', () => {
  it('a serve with the real install argv is killed, and the reap says so', async () => {
    const ssh = standInConnection()
    const ownershipId = crypto.randomBytes(16).toString('hex')
    const pid = await spawnOwnedServe(ssh, ownershipId, crypto.randomBytes(8).toString('hex'))

    expect(argvOf(pid).startsWith(`${root}/venv/bin/python ${root}/venv/bin/hermes serve --isolated `)).toBe(true)
    commands = []

    expect(await disconnect(ssh, ownershipId)).toBe('killed')
    expect(commands.some(command => command.startsWith(`kill ${pid} && `))).toBe(true)
    expect(await waitFor(() => !alive(pid), 2_000)).toBe(true)
    expect(await readLockfile(ssh, ownershipId)).toBeNull()
  }, 30_000)

  it('the teardown logs the outcome of the reap it ran', async () => {
    const ssh = standInConnection()
    const ownershipId = crypto.randomBytes(16).toString('hex')
    const pid = await spawnOwnedServe(ssh, ownershipId, crypto.randomBytes(8).toString('hex'))
    const lines: string[] = []

    await teardownSshState({ ssh, ownershipId }, { cleanupRemote: disconnect, log: line => lines.push(line) })

    expect(lines).toEqual(['[ssh] remote serve reap: killed'])
    expect(await waitFor(() => !alive(pid), 2_000)).toBe(true)
  }, 30_000)

  it('a serve whose nonce is not the recorded one is not ours: never signalled, and the reap says why', async () => {
    const ssh = standInConnection()
    const ownershipId = crypto.randomBytes(16).toString('hex')
    const pid = await spawnOwnedServe(ssh, ownershipId, crypto.randomBytes(8).toString('hex'))
    const record = await readLockfile(ssh, ownershipId)

    // Same pid, a different owner nonce: what a serve another install started under this record looks like.
    const otherNonce = crypto.randomBytes(8).toString('hex')

    await writeLockfile(ssh, ownershipId, {
      ...(record as object),
      spawnNonce: otherNonce,
      logPath: spawnLogPath(ownershipId, otherNonce)
    })
    expect((await readLockfile(ssh, ownershipId)) as { spawnNonce?: string }).toMatchObject({ spawnNonce: otherNonce })
    commands = []
    const lines: string[] = []

    await teardownSshState({ ssh, ownershipId }, { cleanupRemote: disconnect, log: line => lines.push(line) })

    expect(lines).toEqual(['[ssh] remote serve reap: not-ours'])
    expect(commands.some(command => /^kill \d+ && /.test(command))).toBe(false)
    expect(alive(pid)).toBe(true)
  }, 30_000)

  it('no record, a skewed record, a failing transport: each is logged, never silent', async () => {
    const ssh = standInConnection()
    const ownershipId = crypto.randomBytes(16).toString('hex')
    const lines: string[] = []
    const log = (line: string) => lines.push(line)

    await teardownSshState({ ssh, ownershipId }, { cleanupRemote: disconnect, log })
    fs.mkdirSync(path.join(home, '.hermes/desktop-ssh', ownershipId), { recursive: true })
    fs.writeFileSync(path.join(home, '.hermes/desktop-ssh', ownershipId, 'backend.lock.json'), '{not json')
    const skewed = await readLockfile(ssh, ownershipId)
    await teardownSshState({ ssh, ownershipId }, { cleanupRemote: disconnect, log })

    const failing = {
      ...ssh,
      exec: async () => {
        throw Object.assign(new Error('connection to /secret/host lost'), { kind: 'transient-transport-error' })
      }
    }

    await teardownSshState({ ssh: failing, ownershipId }, { cleanupRemote: disconnect, log })

    expect(lines[0]).toBe('[ssh] remote serve reap: no-lock')
    expect(lines[1]).toBe(skewed ? '[ssh] remote serve reap: skew' : '[ssh] remote serve reap: no-lock')
    expect(lines[2]).toBe('[ssh] remote serve reap: error (Error, transient-transport-error)')
    expect(lines.join('\n')).not.toContain('/secret/host')
  }, 30_000)
})

describe('the app hands its log to the reap', () => {
  it('teardownSshConnection passes sshRememberLog with the POSIX disconnect', () => {
    const source = fs.readFileSync(path.join(__dirname, 'main/managed-ssh.ts'), 'utf8')
    const call = source.slice(source.indexOf('  await teardownSshState('), source.indexOf('// Loopback reach'))

    expect(call).toContain(': remoteLifecycle.disconnect,\n')
    expect(call).toMatch(/\n\s+log: sshRememberLog\n/)
  })
})
