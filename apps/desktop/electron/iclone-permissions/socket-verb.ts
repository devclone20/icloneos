/**
 * V3-F §4 — the `perm` verb of the agent socket (iclone-acp-ipc authenticates the session token first). Only the
 * Hermes plugin can use it: every message carries an HMAC with the spawn key main derived for that Hermes process,
 * which never reaches its environment, argv or terminal children. Every answer is HMAC'd back with the same key and
 * bound to the request's MAC, so a socket that is not main cannot answer for it.
 *
 * There is no `set`, no `grant`, no `revoke` — the mode and the grants change only from the user's own gesture
 * (ipc.ts). Verbs:
 *   hello · beat · bye   attestation, heartbeat, goodbye (`hi` = the last src_seq the process allocated)
 *   event · ask          a decision made locally / a Q to decide again (both sequenced, recorded once)
 *   await                the owner's answer to a pending ask (no sequence)
 *   replay               a line of a dead process's write-ahead log, wrapped and signed by a live process
 *   gapnote              a live process reports log lines no key can verify (main writes the `gap`)
 * Exit 0 = allowed/recorded, 1 = refused, 64 = usage, 3 = not signed by a Hermes process this icloneOS started.
 */
import { createHmac } from 'node:crypto'

import type { PermissionAuthority } from './authority'
import { parsePluginCall } from './authority'
import { isPermissionFunction } from './functions'
import { isPermissionMode } from './modes'
import { type PolicySigner, verifyMac } from './policy-file'

const PERM_VERBS = ['ask', 'await', 'beat', 'bye', 'event', 'gapnote', 'hello', 'replay'] as const

type PermVerbName = (typeof PERM_VERBS)[number]

interface VerbResult {
  code: number
  stdout: string
  stderr?: string
}

const USAGE = 'usage: perm <verb> <keyId> <payload-json> <hmac> — the iclone-permissions Hermes plugin only'
const PAYLOAD_MAX = 64 * 1024

const usage = (): VerbResult => ({ code: 64, stdout: '', stderr: `acp: ${USAGE}\n` })

const unsigned = (reason: string): VerbResult => ({
  code: 3,
  stdout: `${JSON.stringify({ error: reason })}\n`
})

const isVerb = (value: unknown): value is PermVerbName =>
  typeof value === 'string' && (PERM_VERBS as readonly string[]).includes(value)

const int = (value: unknown): number => (Number.isSafeInteger(value) ? (value as number) : 0)

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)

    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

interface PermDeps {
  authority: PermissionAuthority | null
  signer: PolicySigner | null
}

export async function permVerb(
  deps: PermDeps,
  slug: string | null,
  argv: readonly unknown[],
  listener?: AbortSignal
): Promise<VerbResult> {
  const [verb, keyId, payload, mac, ...rest] = argv

  if (!isVerb(verb) || typeof keyId !== 'string' || typeof payload !== 'string' || rest.length > 0) {
    return usage()
  }

  if (payload.length > PAYLOAD_MAX) {
    return usage()
  }

  if (!deps.authority || !deps.signer) {
    return unsigned('icloneOS is starting')
  }

  const { authority, signer } = deps
  const key = signer.keyFor(keyId)

  if (!key || !verifyMac(key, `${verb}\n${payload}`, mac)) {
    return unsigned('not signed by a Hermes process this icloneOS started')
  }

  const answer = (code: number, value: object): VerbResult => {
    const r = JSON.stringify({ ...value, code, gen: authority.currentGen() })

    const sig = createHmac('sha256', key)
      .update(`resp\n${String(mac)}\n${r}`)
      .digest('hex')

    return { code, stdout: `${JSON.stringify({ r, sig })}\n` }
  }

  const raw = parseObject(payload)

  // A replay wraps ANOTHER process's line (its own keyId); everything else must name the key that signed it.
  if (!raw || (verb !== 'replay' && raw.keyId !== undefined && raw.keyId !== keyId)) {
    return answer(64, { error: USAGE })
  }

  const pid = int(raw.pid)
  const spawn = authority.spawnState(keyId)

  // The key was handed to ONE process: a message naming another pid is not that process speaking.
  if (verb !== 'replay' && spawn?.pid != null && pid !== spawn.pid) {
    return answer(1, { allowed: false, reason: 'this key belongs to another process' })
  }

  if (verb !== 'hello') {
    authority.seen(keyId, pid)
  }

  switch (verb) {
    case 'hello':
      return authority.hello(keyId, pid, int(raw.hi))
        ? answer(0, { attested: true })
        : answer(1, { attested: false, reason: 'no spawn of this icloneOS holds this key' })

    case 'beat':
      return answer(authority.beat(keyId, pid, int(raw.hi)) ? 0 : 1, {})

    case 'bye':
      authority.bye(keyId, pid, int(raw.hi))

      return answer(0, {})

    case 'gapnote':
      authority.noteUnverifiable(pid, keyId, String(raw.what ?? 'lines').slice(0, 120), int(raw.lines))

      return answer(0, {})

    case 'await':
      return answer(0, await authority.awaitAsk(raw.askId, listener))

    case 'replay':
      return answer(replayLine(authority, signer, raw) ? 0 : 1, {})

    case 'event':
      return recordEvent(authority, raw, keyId) ? answer(0, { recorded: true }) : answer(64, { error: USAGE })
    case 'ask': {
      const call = parsePluginCall(raw)

      if (!call) {
        return answer(64, { error: USAGE })
      }

      const started = authority.ask({ ...call, keyId }, slug ?? call.agent.inft ?? 'agent')

      return answer(started.state === 'decided' && !started.allowed ? 1 : 0, started)
    }
  }
}

/** A locally decided `event` (allow/refuse). False only for a malformed one. */
function recordEvent(authority: PermissionAuthority, raw: Record<string, unknown>, keyId: string): boolean {
  const call = parsePluginCall(raw)

  if (!call || !isPermissionMode(raw.mode) || (raw.outcome !== 'allow' && raw.outcome !== 'refuse')) {
    return false
  }

  authority.recordDecision({
    ...call,
    keyId,
    mode: raw.mode,
    outcome: raw.outcome,
    grantId: typeof raw.grantId === 'string' ? raw.grantId.slice(0, 200) : null,
    fn: isPermissionFunction(raw.fn) ? raw.fn : null
  })

  return true
}

/** One line of a dead process's write-ahead log: verified with THAT process's key, then recorded once. */
function replayLine(authority: PermissionAuthority, signer: PolicySigner, line: Record<string, unknown>): boolean {
  const innerKeyId = line.keyId
  const innerPayload = line.payload
  const innerKey = signer.anyKey(innerKeyId)

  if (
    line.verb !== 'event' ||
    typeof innerKeyId !== 'string' ||
    typeof innerPayload !== 'string' ||
    !innerKey ||
    !verifyMac(innerKey, `event\n${innerPayload}`, line.mac)
  ) {
    const parsed = typeof innerPayload === 'string' ? parseObject(innerPayload) : null

    authority.noteUnverifiable(int(parsed?.pid), typeof innerKeyId === 'string' ? innerKeyId : null, 'a log line', 1)

    return false
  }

  const inner = parseObject(innerPayload)

  if (!inner || inner.keyId !== innerKeyId) {
    authority.noteUnverifiable(int(inner?.pid), innerKeyId, 'a log line', 1)

    return false
  }

  return recordEvent(authority, inner, innerKeyId)
}
