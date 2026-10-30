/**
 * The consent door: an agent that needs a capability the user left OFF or undecided asks through the app instead of
 * failing — `acp consent request <key> --reason "<why>"` on the agent socket (iclone-acp-ipc authenticates it like
 * every acp call: session token + iNFT). Main shows one small sheet at a time; the answer is Allow once (this app run,
 * this iNFT, until the user changes that switch), Allow always (written to consent.json) or Deny. No answer within two
 * minutes is a Deny.
 */
import path from 'node:path'

import type { ActionClass, PermissionDoorScope, PermissionMode } from '../src/iclone-shared/permissions'

import { readJsonValidated } from './iclone-acp-store'
import {
  CONSENT_PERMISSION_KEYS,
  type ConsentPermissionKey,
  type ConsentSenderGuard,
  type ConsentStore,
  guardedHandler,
  isIso,
  onConsentPermissionsChanged
} from './iclone-consent'
import { writeFileAtomicSync } from './lib/atomic-write'

export const CONSENT_REQUESTS_FILE = 'consent-requests.json'
const DOOR_TIMEOUT_MS = 120_000
const REASON_MAX_CHARS = 280
const RECENT_MAX = 20

/** Keychain is the real encryption state (Settings › Gateway), never a grant an agent can ask for. */
export const REQUESTABLE_KEYS: readonly ConsentPermissionKey[] = CONSENT_PERMISSION_KEYS.filter(
  key => key !== 'keychain'
)

type DoorChoice = 'always' | 'deny' | 'once'
type DoorScope = 'always' | 'denied' | 'once'
interface DoorAnswer {
  allowed: boolean
  key: ConsentPermissionKey
  scope: DoorScope
  reason?: string
}

/** A V3-F permission ask riding the same sheet (§3): who, what, the literal target, and the scopes it may grant. */
export interface DoorPermission {
  cls: ActionClass
  tool: string
  target: string
  mode: PermissionMode
  project: string | null
  session: string | null
  subagent: string | null
  scopes: readonly PermissionDoorScope[]
}

type PermissionDoorChoice = 'deny' | PermissionDoorScope
export type PermissionDoorOutcome = PermissionDoorChoice | 'busy' | 'timeout' | 'withdrawn'

/** What the sheet shows: the request at the front of the queue. */
export interface DoorRequest {
  id: string
  key: ConsentPermissionKey
  reason: string
  inft: string
  at: string
  expiresAt: string
  permission?: DoorPermission
}

interface DoorRecent {
  key: ConsentPermissionKey
  reason: string
  inft: string
  answer: 'always' | 'denied' | 'once' | 'timeout'
  at: string
}

const USAGE =
  'usage: acp consent request <key> --reason "<what the task needs it for>" | acp consent status [<key>]\n' +
  `keys: ${REQUESTABLE_KEYS.join(', ')}`

const isPermissionChoice = (value: unknown): value is PermissionDoorChoice =>
  ['deny', 'once', 'project', 'session', 'standing'].includes(value as string)

const isKey = (value: unknown): value is ConsentPermissionKey =>
  typeof value === 'string' && (REQUESTABLE_KEYS as readonly string[]).includes(value)

/**
 * Format characters (bidi overrides and isolates, zero-width, BOM) are dropped so the text cannot be visually reordered;
 * control characters and runs of whitespace collapse to one space: the reason is shown verbatim, on one line.
 */
export function cleanReason(value: string): string {
  return value
    .replace(/\p{Cf}+/gu, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REASON_MAX_CHARS)
}

type DoorCommand =
  | { kind: 'request'; key: ConsentPermissionKey; reason: string }
  | { kind: 'status'; key: ConsentPermissionKey | null }
  | { kind: 'error'; error: string }

/** Pure: the argv after `consent` → a command. */
export function parseDoorArgv(argv: readonly unknown[]): DoorCommand {
  const args = argv.filter((arg): arg is string => typeof arg === 'string')

  if (args.length !== argv.length) {
    return { kind: 'error', error: USAGE }
  }

  const [verb, key, ...rest] = args

  if (verb === 'status' && rest.length === 0) {
    if (key === undefined) {
      return { kind: 'status', key: null }
    }

    if (isKey(key)) {
      return { kind: 'status', key }
    }
  }

  if (verb !== 'request' || !isKey(key)) {
    return { kind: 'error', error: USAGE }
  }

  let reason = ''

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]

    if (arg === '--reason' && i + 1 < rest.length) {
      reason = rest[(i += 1)]
    } else if (arg.startsWith('--reason=')) {
      reason = arg.slice('--reason='.length)
    } else if (arg !== '--json') {
      return { kind: 'error', error: USAGE }
    }
  }

  reason = cleanReason(reason)

  return reason ? { kind: 'request', key, reason } : { kind: 'error', error: `a reason is required\n${USAGE}` }
}

function isRecent(value: unknown): value is DoorRecent {
  const item = value as Record<string, unknown> | null

  return (
    !!item &&
    typeof item === 'object' &&
    isKey(item.key) &&
    typeof item.reason === 'string' &&
    item.reason.length <= REASON_MAX_CHARS &&
    typeof item.inft === 'string' &&
    item.inft.length <= 200 &&
    ['always', 'denied', 'once', 'timeout'].includes(item.answer as string) &&
    isIso(item.at)
  )
}

const isRecentFile = (value: unknown): value is { schema: 1; requests: DoorRecent[] } =>
  !!value &&
  typeof value === 'object' &&
  (value as Record<string, unknown>).schema === 1 &&
  Array.isArray((value as Record<string, unknown>).requests) &&
  ((value as Record<string, unknown>).requests as unknown[]).every(isRecent)

interface Waiter {
  resolve: (answer: DoorAnswer) => void
  signal?: AbortSignal
  onAbort: () => void
}

interface Pending {
  request: DoorRequest
  /** Every agent call waiting on this (iNFT, key): one sheet, one answer for all. */
  waiters: Set<Waiter>
  /** Starts the two-minute clock; called when the request reaches the screen. */
  arm: () => void
  settle: (choice: DoorChoice | PermissionDoorChoice | 'timeout') => void
}

/** Distinct keys one iNFT may have waiting at once; the rest are refused (exit 1), never queued. */
export const PENDING_PER_INFT_MAX = 3
/** Sheets waiting across every iNFT. */
const PENDING_TOTAL_MAX = 24

interface DoorDeps {
  store: Pick<ConsentStore, 'allowAlways' | 'read'>
  /** Called with the request now on screen (null = no sheet). */
  show: (request: DoorRequest | null) => void
  userDataDir: string
  now?: () => Date
  timeoutMs?: number
}

const refused = (key: ConsentPermissionKey, reason: string): DoorAnswer => ({
  allowed: false,
  key,
  scope: 'denied',
  reason
})

export function createConsentDoor(deps: DoorDeps) {
  const now = deps.now ?? (() => new Date())
  const timeoutMs = deps.timeoutMs ?? DOOR_TIMEOUT_MS
  const file = path.join(deps.userDataDir, CONSENT_REQUESTS_FILE)
  const queue: Pending[] = []
  // Allow once and Deny hold for the rest of this app run (per iNFT + key) until the user changes that switch in Privacy.
  const once = new Set<string>()
  const denied = new Set<string>()
  let recent: DoorRecent[] | null = null
  let serial = 0

  const loadRecent = (): DoorRecent[] => (recent ??= readJsonValidated(file, isRecentFile)?.requests ?? [])

  const remember = (item: DoorRecent) => {
    recent = [item, ...loadRecent()].slice(0, RECENT_MAX)

    try {
      writeFileAtomicSync(file, `${JSON.stringify({ schema: 1, requests: recent }, null, 2)}\n`, { mode: 0o600 })
    } catch {
      // The history is a convenience; the answer itself has already been given.
    }
  }

  const front = () => queue[0]?.request ?? null
  const id = (slug: string, key: ConsentPermissionKey) => `${slug}:${key}`

  const state = (slug: string, key: ConsentPermissionKey): 'ask' | 'off' | 'on' | 'once' => {
    const on = deps.store.read()?.permissions[key]

    return on === true ? 'on' : once.has(id(slug, key)) ? 'once' : on === false ? 'off' : 'ask'
  }

  const wait = (entry: Pending, resolve: (answer: DoorAnswer) => void, signal?: AbortSignal) => {
    const waiter: Waiter = {
      resolve,
      signal,
      onAbort() {
        // This caller went away; the sheet stays for the others and is withdrawn with the last one.
        entry.waiters.delete(waiter)
        resolve(refused(entry.request.key, 'the request was withdrawn'))

        if (entry.waiters.size === 0) {
          entry.settle('timeout')
        }
      }
    }

    entry.waiters.add(waiter)
    signal?.addEventListener('abort', waiter.onAbort, { once: true })
  }

  return {
    /** The agent's call: resolves when the user answers, the timeout passes or the agent goes away. */
    request(slug: string, key: ConsentPermissionKey, reason: string, signal?: AbortSignal): Promise<DoorAnswer> {
      if (!deps.store.read()) {
        return Promise.resolve(refused(key, 'the policy has not been accepted yet'))
      }

      if (signal?.aborted) {
        return Promise.resolve(refused(key, 'the request was withdrawn'))
      }

      const current = state(slug, key)

      if (current === 'on' || current === 'once') {
        return Promise.resolve({ allowed: true, key, scope: current === 'on' ? 'always' : 'once' })
      }

      if (denied.has(id(slug, key))) {
        return Promise.resolve(
          refused(key, 'the user denied it earlier in this app run (Settings › Privacy changes it)')
        )
      }

      const same = queue.find(entry => entry.request.inft === slug && entry.request.key === key)

      if (same) {
        return new Promise(resolve => wait(same, resolve, signal))
      }

      if (
        queue.length >= PENDING_TOTAL_MAX ||
        queue.filter(entry => entry.request.inft === slug).length >= PENDING_PER_INFT_MAX
      ) {
        return Promise.resolve(refused(key, 'too many permission requests are already waiting'))
      }

      return new Promise(resolve => {
        const at = now()

        const request: DoorRequest = {
          id: `door-${(serial += 1)}-${at.getTime()}`,
          key,
          reason,
          inft: slug,
          at: at.toISOString(),
          expiresAt: new Date(at.getTime() + timeoutMs).toISOString()
        }

        let timer: ReturnType<typeof setTimeout> | null = null

        const entry: Pending = {
          request,
          waiters: new Set(),
          // The clock runs from when the sheet is on screen, so a queued request is never denied unseen.
          arm() {
            timer = setTimeout(() => entry.settle('timeout'), timeoutMs)
          },
          settle(given) {
            const index = queue.indexOf(entry)

            if (index < 0) {
              return
            }

            let choice: DoorChoice | 'timeout' =
              given === 'always' || given === 'once' || given === 'timeout' ? given : 'deny'

            const wasFront = index === 0

            queue.splice(index, 1)

            if (timer) {
              clearTimeout(timer)
            }

            if (choice === 'always') {
              const saved = deps.store.allowAlways(key)

              if (!saved.ok) {
                choice = 'once'
              }
            }

            if (choice === 'once') {
              once.add(id(slug, key))
            } else if (choice === 'deny') {
              denied.add(id(slug, key))
            }

            remember({
              key,
              reason,
              inft: slug,
              answer: choice === 'deny' ? 'denied' : choice,
              at: now().toISOString()
            })

            const answer: DoorAnswer =
              choice === 'always' || choice === 'once'
                ? { allowed: true, key, scope: choice }
                : choice === 'timeout'
                  ? refused(key, 'no answer in time')
                  : { allowed: false, key, scope: 'denied' }

            for (const waiter of entry.waiters) {
              waiter.signal?.removeEventListener('abort', waiter.onAbort)
              waiter.resolve(answer)
            }

            entry.waiters.clear()

            if (wasFront) {
              startFront()
            }
          }
        }

        queue.push(entry)
        wait(entry, resolve, signal)

        if (queue.length === 1) {
          startFront()
        }
      })
    },
    /**
     * V3-F: a permission ask from the Hermes plugin (through main's authority) on the same one-at-a-time sheet. Never
     * deduplicated and never remembered per key: every ask is its own call, answered once, with its own scope.
     */
    askPermission(
      slug: string,
      permission: DoorPermission,
      key: ConsentPermissionKey,
      reason: string,
      signal?: AbortSignal
    ): Promise<PermissionDoorOutcome> {
      if (signal?.aborted) {
        return Promise.resolve('withdrawn')
      }

      if (
        queue.length >= PENDING_TOTAL_MAX ||
        queue.filter(entry => entry.request.inft === slug).length >= PENDING_PER_INFT_MAX
      ) {
        return Promise.resolve('busy')
      }

      return new Promise(resolve => {
        const at = now()
        let timer: ReturnType<typeof setTimeout> | null = null

        const entry: Pending = {
          request: {
            id: `perm-${(serial += 1)}-${at.getTime()}`,
            key,
            reason,
            inft: slug,
            at: at.toISOString(),
            expiresAt: new Date(at.getTime() + timeoutMs).toISOString(),
            permission
          },
          waiters: new Set(),
          arm() {
            timer = setTimeout(() => entry.settle('timeout'), timeoutMs)
          },
          settle(choice) {
            const index = queue.indexOf(entry)

            if (index < 0) {
              return
            }

            queue.splice(index, 1)

            if (timer) {
              clearTimeout(timer)
            }

            signal?.removeEventListener('abort', onAbort)
            resolve(choice === 'timeout' || isPermissionChoice(choice) ? choice : 'deny')

            if (index === 0) {
              startFront()
            }
          }
        }

        const onAbort = () => {
          const index = queue.indexOf(entry)

          if (index >= 0) {
            queue.splice(index, 1)

            if (timer) {
              clearTimeout(timer)
            }

            resolve('withdrawn')

            if (index === 0) {
              startFront()
            }
          }
        }

        signal?.addEventListener('abort', onAbort, { once: true })
        queue.push(entry)

        if (queue.length === 1) {
          startFront()
        }
      })
    },
    /** The sheet's answer; only the request on screen can be answered, and only with a choice its kind offers. */
    answer(id: unknown, choice: unknown): boolean {
      const head = queue[0]

      if (!head || head.request.id !== id) {
        return false
      }

      const permission = head.request.permission

      const valid = permission
        ? choice === 'deny' || permission.scopes.includes(choice as PermissionDoorScope)
        : ['always', 'deny', 'once'].includes(choice as string)

      if (!valid) {
        return false
      }

      head.settle(choice as DoorChoice | PermissionDoorChoice)

      return true
    },
    /**
     * The user changed these switches: their later choice outranks every answer given at the door in this run, so the
     * Deny and the Allow once for those keys (every iNFT) are dropped and the stored switch decides again.
     */
    clearDenied(keys: readonly ConsentPermissionKey[]): void {
      const changed = (entry: string) => keys.some(key => entry.endsWith(`:${key}`))

      for (const entry of [...denied]) {
        if (changed(entry)) {
          denied.delete(entry)
        }
      }

      for (const entry of [...once]) {
        if (changed(entry)) {
          once.delete(entry)
        }
      }
    },
    current: front,
    pendingCount: () => queue.length,
    recent: () => loadRecent(),
    status(slug: string, key: ConsentPermissionKey | null) {
      const keys = key ? [key] : REQUESTABLE_KEYS

      return Object.fromEntries(keys.map(k => [k, state(slug, k)]))
    }
  }

  function startFront() {
    const head = queue[0]

    if (head) {
      head.request = { ...head.request, expiresAt: new Date(now().getTime() + timeoutMs).toISOString() }
      head.arm()
    }

    deps.show(front())
  }
}

export type ConsentDoor = ReturnType<typeof createConsentDoor>

let activeDoor: ConsentDoor | null = null

/**
 * The `consent` verb of the agent socket (already authenticated: token + resolved iNFT). Never reaches the Virtuals
 * CLI. Exit 0 = allowed, 1 = denied, 64 = usage; stdout is one JSON line.
 */
export async function consentDoorCommand(
  slug: string,
  argv: readonly unknown[],
  signal?: AbortSignal
): Promise<{ code: number; stdout: string; stderr?: string }> {
  const command = parseDoorArgv(argv)

  if (command.kind === 'error') {
    return { code: 64, stdout: '', stderr: `acp: ${command.error}\n` }
  }

  if (!activeDoor) {
    return {
      code: 1,
      stdout: `${JSON.stringify({ allowed: false, scope: 'denied', reason: 'icloneOS is starting' })}\n`
    }
  }

  if (command.kind === 'status') {
    return { code: 0, stdout: `${JSON.stringify({ inft: slug, permissions: activeDoor.status(slug, command.key) })}\n` }
  }

  const answer = await activeDoor.request(slug, command.key, command.reason, signal)

  return { code: answer.allowed ? 0 : 1, stdout: `${JSON.stringify(answer)}\n` }
}

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
}

interface RegisterDoorDeps {
  ipcMain: IpcMainLike
  /** The P7 seam (createAppSenderGuard): only the app's own renderer may read or answer the sheet. */
  isTrustedSender: ConsentSenderGuard
  store: Pick<ConsentStore, 'allowAlways' | 'read'>
  /** Sends the request on screen (or null) to the app windows. */
  broadcast: (request: DoorRequest | null) => void
  userDataDir: string
  /** V3-F §3: an answer counts only on a trusted gesture on the sheet's own buttons (gesture.ts). */
  gestureOk?: (event: unknown, input: unknown) => boolean
}

let stopClearingDenied: (() => void) | null = null

export function registerConsentDoor(deps: RegisterDoorDeps): ConsentDoor {
  const door = createConsentDoor({ store: deps.store, show: deps.broadcast, userDataDir: deps.userDataDir })
  const ipcMain = guardedHandler(deps.ipcMain, deps.isTrustedSender)

  activeDoor = door
  stopClearingDenied?.()
  stopClearingDenied = onConsentPermissionsChanged(keys => door.clearDenied(keys))
  ipcMain.handle('iclone:consent:door-current', () => door.current())
  ipcMain.handle('iclone:consent:door-answer', (event, input) => {
    if (deps.gestureOk && !deps.gestureOk(event, input)) {
      return false
    }

    return door.answer((input as Record<string, unknown> | null)?.id, (input as Record<string, unknown> | null)?.choice)
  })
  ipcMain.handle('iclone:consent:requests', () => door.recent())

  return door
}

/** Test seam. */
export function resetConsentDoorForTests(door: ConsentDoor | null = null): void {
  activeDoor = door
}
