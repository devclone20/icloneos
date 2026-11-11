import { execFile } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { acpWrapperSource } from '../iclone-acp'
import { parseAgentRequest } from '../iclone-acp-ipc'

import { callingSession, withCallingSession } from './calling-session'

const TOKEN = 'a'.repeat(64)

describe('S6: the session a socket request names', () => {
  it('holds across awaits, and two requests in flight never see each other', async () => {
    const seen = await Promise.all(
      ['one', 'two'].map(id =>
        withCallingSession(id, async () => {
          await new Promise(resolve => setImmediate(resolve))

          return callingSession()
        })
      )
    )

    expect(seen).toEqual(['one', 'two'])
    expect(callingSession()).toBeNull()
  })

  it.each([[undefined], [null], [''], [7], [{}], ['x'.repeat(201)], ['a\nb']])('%j names no session', async value => {
    expect(await withCallingSession(value, async () => callingSession())).toBeNull()
  })

  it('the agent socket keeps the field and still takes a request from an older wrapper with none', () => {
    const line = (extra: object) => JSON.stringify({ v: 1, token: TOKEN, argv: ['consent', 'status'], ...extra })

    expect(parseAgentRequest(line({ session: 'zz-a' }))?.session).toBe('zz-a')
    expect(parseAgentRequest(line({}))?.session).toBeUndefined()
  })

  /** The real client against a socket that keeps the line it was sent and answers exit 0. */
  const lineFrom = async (
    run: (socket: string, dir: string) => string[],
    env: Record<string, string>
  ) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'))
    const socket = path.join(dir, 's')
    let line = ''

    const server = net.createServer(conn => {
      conn.on('data', chunk => {
        line += String(chunk)
        conn.end(`${JSON.stringify({ t: 'x', c: 0 })}\n`)
      })
    })

    await new Promise<void>(resolve => server.listen(socket, resolve))

    try {
      const [file, ...args] = run(socket, dir)

      await new Promise(resolve => {
        execFile(file, args, { env: { PATH: process.env.PATH ?? '', ...env, HERMES_HOME: dir } }, resolve)
      })

      return JSON.parse(line) as Record<string, unknown>
    } finally {
      server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  const acp = (socket: string, dir: string) => {
    const wrapper = path.join(dir, 'acp')

    fs.writeFileSync(path.join(dir, 'token'), TOKEN)
    fs.writeFileSync(wrapper, acpWrapperSource(socket, path.join(dir, 'token')), { mode: 0o755 })

    return [wrapper, 'consent', 'status']
  }

  const pay = (socket: string, dir: string) => {
    const script = path.resolve(__dirname, '../../../../iclone/skills/x402-pay/scripts/x402_pay.py')

    fs.writeFileSync(path.join(dir, 'token'), TOKEN)

    return ['/bin/sh', '-c', `ICLONE_PAY_SOCKET=${socket} ICLONE_PAY_TOKEN_FILE=${dir}/token exec python3 -I ${script} status`]
  }

  it.each([
    ['the acp wrapper', acp],
    ['x402-pay', pay]
  ])('%s names HERMES_SESSION_ID, and nothing when it has none', async (_name, client) => {
    expect((await lineFrom(client, { HERMES_SESSION_ID: 'zz-a' })).session).toBe('zz-a')
    expect((await lineFrom(client, {})).session ?? null).toBeNull()
  })
})
