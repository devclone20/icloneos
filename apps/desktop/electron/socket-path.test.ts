/**
 * v0.0.9 pass 4 (rt's capture: the launcher socket under a long e2e userData was 139 bytes and never bound, so the
 * agent silently lost `terminal`). Every socket family checks its path before it listens and fails LOUDLY, naming the
 * socket and what to do. Red before: the launcher and the pane bus had no check (the bind failed in silence); acp and
 * pay threw a bare "socket path is longer than 103 bytes" with no socket name and no remedy.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { startAcpSocketServer } from './iclone-acp-ipc'
import { listenOnSocket } from './iclone-pane-bus/ipc'
import { startPaySocketServer } from './iclone-x402/ipc'
import { assertSocketPathFits, MAX_SOCKET_PATH_BYTES, SocketPathTooLongError } from './socket-path'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

/** A folder whose socket paths are over the limit (the e2e sandbox's userData/run). */
function longDir(): string {
  const root = mkdtempSync('/tmp/sp-')
  const dir = path.join(root, 'x'.repeat(90), 'run')

  roots.push(root)
  mkdirSync(dir, { mode: 0o700, recursive: true })

  return dir
}

describe('assertSocketPathFits', () => {
  it('passes a path that fits and refuses one over the limit, naming the socket, the path and what to do', () => {
    expect(() => assertSocketPathFits(`/tmp/${'a'.repeat(MAX_SOCKET_PATH_BYTES - 5)}`, 'X')).not.toThrow()

    const file = `/tmp/${'a'.repeat(MAX_SOCKET_PATH_BYTES)}.sock`

    expect(() => assertSocketPathFits(file, 'The payment socket (pay.sock)')).toThrow(SocketPathTooLongError)
    expect(() => assertSocketPathFits(file, 'The payment socket (pay.sock)')).toThrow(
      /The payment socket \(pay\.sock\) cannot start: its socket path is \d+ bytes, over the 103-byte limit .*shorter path/
    )
  })
})

describe('each socket family refuses an over-long path loudly, before it binds', () => {
  it('acp (permission and agent)', async () => {
    const dir = longDir()

    await expect(
      startAcpSocketServer({ dir, socket: path.join(dir, 'acp.sock') } as unknown as Parameters<
        typeof startAcpSocketServer
      >[0])
    ).rejects.toThrow(/permission and agent socket \(acp\.sock\) cannot start/)
  })

  it('pay', async () => {
    const dir = longDir()

    await expect(
      startPaySocketServer({ dir, socket: path.join(dir, 'pay.sock') } as unknown as Parameters<
        typeof startPaySocketServer
      >[0])
    ).rejects.toThrow(/payment socket \(pay\.sock\) cannot start/)
  })

  it('pane bus', async () => {
    const server = http.createServer()

    await expect(listenOnSocket(server, path.join(longDir(), 'bus-12345.sock'))).rejects.toThrow(
      /pane bus socket cannot start/
    )
    expect(server.listening).toBe(false)
  })
})
