/**
 * iclone os — the `it` CLI control plane (clean-room recreation of the CLONE
 * FRAME HUB's iT command surface; behavior only, never its code).
 *
 * A loopback HTTP server on an EPHEMERAL port + bearer token, both written
 * to ~/.iclone-os/it.json (0600). The installed CLI (~/.iclone-os/bin/it —
 * pure POSIX sh + curl, no runtime deps, works from ANY terminal on the
 * machine) POSTs its argv here; the request is forwarded to the renderer
 * (it-commands.ts) which drives the real iT tabs/views and answers with
 * plain text.
 *
 * Hardening: 127.0.0.1 bind only, constant-time bearer check, 8KB body cap,
 * 5s renderer timeout, state file created 0600 in a 0700 dir, and the token
 * travels to curl on stdin (`-H @-`) — never on the command line, where any
 * local user could read it with `ps`. Main never runs a shell here; but the
 * commands DO reach live PTYs through the renderer (`it exec`/`it send`), so
 * the token is a shell as the owner and is guarded like one.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { app, type BrowserWindow, ipcMain } from 'electron'

import { BUS_CLI_FRAGMENT } from './iclone-pane-bus/cli'
import { writeFileAtomicSync } from './lib/atomic-write'

const REPLY_TIMEOUT_MS = 5_000
const BODY_CAP = 8 * 1024

const CMD_CHANNEL = 'iclone:it-cmd'
const REPLY_CHANNEL = 'iclone:it-reply'

interface InitOptions {
  getMainWindow: () => BrowserWindow | null
  /** Loopback port; 0 (the default) lets the OS pick a free one. */
  port?: number
}

function stateDir(): string {
  return path.join(os.homedir(), '.iclone-os')
}

// The CLI: resolves the control endpoint from it.json and relays argv.
// POSIX sh + curl only — no node/python dependency on the host.
const CLI_SOURCE = `#!/bin/sh
# it — the iclone os terminal command (installed by the running app).
# Encode argv as JSON, one element at a time. The previous version printed the
# whole vector newline-separated and treated every LINE as an element, so any
# argument CONTAINING a newline was silently split into several — a heredoc
# sent through \`it exec\` arrived as one flat line and hung the shell at its
# continuation prompt. Escape per argument instead, and carry real newlines as
# \\n; tabs as \\t.
esc() {
  # BSD sed does not understand \\t on the left-hand side, so tabs are handled
  # in awk, which does.
  printf '%s' "$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' \\
    | awk 'BEGIN{ORS=""} {gsub(/\t/,"\\\\t"); if(NR>1) printf "\\\\n"; print}'
}
${BUS_CLI_FRAGMENT}STATE="$HOME/.iclone-os/it.json"
if [ ! -f "$STATE" ]; then
  echo "it: iclone os is not running (no $STATE)" >&2
  exit 1
fi
PORT=$(sed -n 's/.*"port":[ ]*\\([0-9]*\\).*/\\1/p' "$STATE")
TOKEN=$(sed -n 's/.*"token":[ ]*"\\([^"]*\\)".*/\\1/p' "$STATE")
if [ -z "$PORT" ] || [ -z "$TOKEN" ]; then
  echo "it: control file is malformed" >&2
  exit 1
fi
# \`it spawn --spec <file>\`: the app reads the spec, so a relative path is
# resolved here, against the caller's directory.
[ "$1" = "spawn" ] && set -- "$@" --base "$PWD"
BODY='['
IT_FIRST=1
for IT_ARG in "$@"; do
  [ "$IT_FIRST" -eq 1 ] || BODY="$BODY,"
  IT_FIRST=0
  BODY="$BODY\\"$(esc "$IT_ARG")\\""
done
BODY="$BODY]"
[ $# -eq 0 ] && BODY='["help"]'
# The bearer goes in on stdin: a token in argv is visible to every local
# process for the life of the request.
RESP=$(printf 'Authorization: Bearer %s\\n' "$TOKEN" | curl -sS -m 8 -X POST "http://127.0.0.1:$PORT/cmd" \\
  -H @- -H "Content-Type: application/json" \\
  --data "{\\"argv\\":$BODY}" 2>&1) || { echo "it: cannot reach iclone os ($RESP)" >&2; exit 1; }
printf '%s\\n' "$RESP"
`

let initialized = false
let server: http.Server | null = null
let seq = 0
const pending = new Map<number, { resolve: (out: string) => void; timer: NodeJS.Timeout }>()

function handleCommand(getMainWindow: () => BrowserWindow | null, argv: string[]): Promise<string> {
  const win = getMainWindow()

  if (!win || win.isDestroyed()) {
    return Promise.resolve('it: the iclone os window is not available')
  }

  const id = ++seq

  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve('it: the app did not answer (is the home loaded?)')
    }, REPLY_TIMEOUT_MS)

    pending.set(id, { resolve, timer })
    win.webContents.send(CMD_CHANNEL, { id, argv })
  })
}

export function initIcloneIt({ getMainWindow, port: requestedPort = 0 }: InitOptions) {
  if (initialized) {
    return
  }

  initialized = true

  ipcMain.on(REPLY_CHANNEL, (_event, payload: { id: number; output: string }) => {
    const entry = pending.get(Number(payload?.id))

    if (entry) {
      pending.delete(Number(payload.id))
      clearTimeout(entry.timer)
      entry.resolve(String(payload?.output ?? ''))
    }
  })

  const token = randomBytes(24).toString('hex')

  server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/cmd') {
      res.writeHead(404).end()

      return
    }

    const expected = Buffer.from(`Bearer ${token}`)
    const given = Buffer.from(String(req.headers.authorization ?? ''))

    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      res.writeHead(401).end()

      return
    }

    let body = ''

    req.on('data', chunk => {
      body += chunk

      if (body.length > BODY_CAP) {
        req.destroy()
      }
    })
    req.on('end', () => {
      let argv: string[] = []

      try {
        const parsed = JSON.parse(body) as { argv?: unknown }

        argv = Array.isArray(parsed.argv) ? parsed.argv.map(String).slice(0, 32) : []
      } catch {
        res.writeHead(400).end('it: bad request')

        return
      }

      void handleCommand(getMainWindow, argv).then(output => {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(output)
      })
    })
  })

  // A failed listen (EADDRINUSE, EACCES under a sandbox) or an accept error (EMFILE) only costs the
  // CLI: without a listener Node throws it as an uncaught exception in main.
  server.on('error', error => {
    console.warn('[iclone] it control server failed:', error)
  })

  server.listen(requestedPort, '127.0.0.1', () => {
    const address = server?.address()
    const port = address && typeof address === 'object' ? address.port : 0

    try {
      const dir = stateDir()
      const bin = path.join(dir, 'bin')

      mkdirSync(dir, { recursive: true, mode: 0o700 })
      chmodSync(dir, 0o700)
      mkdirSync(bin, { recursive: true })

      // Private from its first byte (never umask-default, then chmod'ed), and a CLI reading it
      // mid-write sees the old file or the new one, never half of either.
      writeFileAtomicSync(path.join(dir, 'it.json'), JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 })
      writeFileAtomicSync(path.join(bin, 'it'), CLI_SOURCE, { mode: 0o755 })
    } catch (error) {
      console.warn('[iclone] it CLI install failed:', error)
    }
  })

  app.on('will-quit', () => {
    try {
      rmSync(path.join(stateDir(), 'it.json'), { force: true })
    } catch {
      // Best effort — a stale file just makes the CLI report unreachable.
    }

    server?.close()
  })
}
