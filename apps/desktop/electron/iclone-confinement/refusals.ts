/**
 * V3-G R2 — Seatbelt refusals. A denial is not an exit code: the kernel reports it to the unified log as
 * `Sandbox: <proc>(<pid>) deny(1) <operation> <target>`. Measured on macOS 27.0.1: `log stream --style ndjson
 * --predicate 'sender == "Sandbox"'` delivers each one within about a second, and repeats of the same denial are
 * folded into "N duplicate report" lines, so a count of refusals is a lower bound.
 *
 * Every deny rule main generates carries `(with message "iclone-confined:<class>")`, which the kernel appends to the
 * log line: that tag, not a pid lookup, says the denial is ours, so a `cat` that is already gone is still counted.
 * The log carries every app's sandbox; only tagged denials are kept (a foreign one is dropped as it is parsed, before
 * any `ps` fold: K97), appended to
 * `userData/confinement/refusals/<UTC day>.jsonl` (0600). They join V3-F's audit chain as `src:"confinement"` once
 * V3-F exposes an append for it; until then this file is their record.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { RefusalView } from '../../src/iclone-shared/confinement'
import { redactSecrets } from '../../src/iclone-shared/redact'

const DENY_RE = /^Sandbox: (.+?)\((\d+)\) deny\(\d+\) (\S+)(?: (.*))?$/
const TAG_RE = /^iclone-confined:([a-z]+)$/
const FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/

interface SandboxDenial {
  /** The activity class from our profile's tag; null = another sandbox's denial. */
  cls: string | null
  process: string
  pid: number
  operation: string
  target: string
}

export function parseSandboxMessage(message: string): SandboxDenial | null {
  const [first = '', ...rest] = message.trim().split('\n')
  const match = DENY_RE.exec(first.trim())

  if (!match) {
    return null
  }

  const tag = rest.map(line => TAG_RE.exec(line.trim())?.[1]).find(Boolean) ?? null

  return { cls: tag, process: match[1], pid: Number(match[2]), operation: match[3], target: (match[4] ?? '').trim() }
}

/** `2026-10-21 10:14:10.235910+0100` (log's own format) → ISO 8601; anything else → now. */
export function logTimestamp(text: string, now: () => Date = () => new Date()): string {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2})(\d{2})$/.exec(text.trim())

  if (!match) {
    return now().toISOString()
  }

  const date = new Date(`${match[1]}T${match[2]}${(match[3] ?? '').slice(0, 4)}${match[4]}:${match[5]}`)

  return Number.isNaN(date.getTime()) ? now().toISOString() : date.toISOString()
}

export function createRefusalLog(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

  return {
    append(refusal: RefusalView): void {
      const file = path.join(dir, `${refusal.ts.slice(0, 10)}.jsonl`)
      const line = `${JSON.stringify({ ...refusal, target: redactSecrets(refusal.target).slice(0, 1_000) })}\n`

      fs.appendFileSync(file, line, { mode: 0o600 })
    },
    /** The newest `limit` refusals, newest first. */
    recent(limit = 100): RefusalView[] {
      const out: RefusalView[] = []
      let files: string[] = []

      try {
        files = fs
          .readdirSync(dir)
          .filter(name => FILE_RE.test(name))
          .sort()
      } catch {
        return out
      }

      for (let f = files.length - 1; f >= 0 && out.length < limit; f -= 1) {
        let lines: string[] = []

        try {
          lines = fs.readFileSync(path.join(dir, files[f]), 'utf8').split('\n').filter(Boolean)
        } catch {
          continue
        }

        for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
          try {
            out.push(JSON.parse(lines[i]) as RefusalView)
          } catch {
            // a torn last line is skipped
          }
        }
      }

      return out
    },
    dir
  }
}

type RefusalLog = ReturnType<typeof createRefusalLog>

interface StreamDeps {
  log: RefusalLog
  /** Session of each pid confined right now (a fresh `ps` fold per batch); a pid already gone keeps no session. */
  confined: () => Promise<Map<number, string | null>>
  onRefusal?: (refusal: RefusalView) => void
  /** K97: the stream starts when a confined run starts, so the kernel may have refused something in the moment before
   *  it connected. That many seconds of the log are read once (`log show --last`), and a denial read twice counts
   *  once. 0 or absent: no look-back. */
  backfillSeconds?: number
  /** Test seams. */
  spawnLog?: () => ChildProcess
  spawnShow?: (seconds: number) => ChildProcess
}

const BATCH_MS = 100
const PREDICATE = 'sender == "Sandbox"'
/** A denial seen by both the look-back and the stream is folded while this many keys are remembered. */
const DEDUP_MAX = 2_000
const DEDUP_FOR_MS = 30_000

export function startRefusalStream(deps: StreamDeps): { stop: () => void } {
  const children: ChildProcess[] = []
  let pending: { ts: string; denial: SandboxDenial }[] = []
  let timer: NodeJS.Timeout | null = null
  let seen: Set<string> | null = null
  let forget: NodeJS.Timeout | null = null

  const flush = async () => {
    timer = null

    const batch = pending

    pending = []

    // Only tagged denials reach the batch, so an empty one means nothing of ours: no `ps` fold (K97).
    if (batch.length === 0) {
      return
    }

    const confined = await deps.confined().catch(() => new Map<number, string | null>())

    for (const { ts, denial } of batch) {
      const refusal: RefusalView = {
        ts,
        pid: denial.pid,
        process: denial.process,
        operation: denial.operation,
        target: denial.target,
        sessionId: confined.get(denial.pid) ?? null
      }

      deps.log.append(refusal)
      deps.onRefusal?.(refusal)
    }
  }

  const take = (line: string) => {
    if (!line.startsWith('{')) {
      return
    }

    let event: { eventMessage?: unknown; timestamp?: unknown }

    try {
      event = JSON.parse(line) as typeof event
    } catch {
      return // not an event line
    }

    const denial = typeof event.eventMessage === 'string' ? parseSandboxMessage(event.eventMessage) : null

    // K97: another sandbox's denial is dropped here, before it can schedule a batch or a `ps` fold.
    if (!denial?.cls) {
      return
    }

    if (seen) {
      const key = `${String(event.timestamp ?? '')}\0${String(event.eventMessage)}`

      if (seen.has(key)) {
        return
      }

      if (seen.size < DEDUP_MAX) {
        seen.add(key)
      }
    }

    pending.push({ ts: logTimestamp(String(event.timestamp ?? '')), denial })

    if (!timer) {
      timer = setTimeout(() => void flush(), BATCH_MS)
    }
  }

  const read = (child: ChildProcess) => {
    let buffer = ''

    children.push(child)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk

      const lines = buffer.split('\n')

      buffer = lines.pop() ?? ''
      lines.forEach(take)
    })
    child.stdout?.on('end', () => {
      if (buffer) {
        take(buffer)
        buffer = ''
      }
    })
  }

  const backfill = Math.max(0, Math.floor(deps.backfillSeconds ?? 0))

  if (backfill > 0) {
    seen = new Set()
    forget = setTimeout(() => {
      seen = null
    }, DEDUP_FOR_MS)
    forget.unref?.()
  }

  read(
    deps.spawnLog?.() ??
      spawn('/usr/bin/log', ['stream', '--style', 'ndjson', '--predicate', PREDICATE], {
        stdio: ['ignore', 'pipe', 'ignore']
      })
  )

  if (backfill > 0) {
    read(
      deps.spawnShow?.(backfill) ??
        spawn('/usr/bin/log', ['show', '--style', 'ndjson', '--last', `${backfill}s`, '--predicate', PREDICATE], {
          stdio: ['ignore', 'pipe', 'ignore']
        })
    )
  }

  return {
    stop() {
      if (timer) {
        clearTimeout(timer)
      }

      if (forget) {
        clearTimeout(forget)
      }

      for (const child of children) {
        child.kill('SIGTERM')
      }
    }
  }
}
