/**
 * V3-F §2 — the derived policy main hands to the Hermes plugin. Each Hermes spawn gets its own key, derived from the
 * sealed master (keys.ts) by a fresh nonce; the nonce is the key's public id and the key reaches the child only on an
 * inherited pipe (never env or argv, critic F-2). Each spawn reads its own `policy/<keyId>.json`. The file carries the
 * body as the exact string that was signed, so TypeScript and Python never have to agree on a canonical JSON.
 *
 * Every published body carries `gen`, strictly increasing across publishes and restarts (F-5): the plugin refuses a
 * body older than one it saw or than the generation main reports on every answer, so a replayed file cannot bring
 * back a revoked grant or an older mode. Bad, missing or replayed ⇒ the plugin runs Manual.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

import { writeFileAtomicSync } from '../lib/atomic-write'

import type { FunctionLevels } from './functions'
import type { PermissionKeys } from './keys'
import { type ActionClass, type Ceiling, DEFAULT_CEILING_KEY, MODE_TABLE, type PermissionMode } from './modes'
import type { FunctionGrant, Grant, ModeRecord } from './store'

const POLICY_DIR = 'policy'
const GEN_FILE = 'policy-gen'
/** Live Hermes spawns main signs a policy for; the oldest is retired beyond this (its key still verifies replays). */
const LIVE_KEYS_MAX = 16

interface PolicyBody {
  v: 1
  gen: number
  issuedAt: string
  standing: PermissionMode
  projects: Record<string, PermissionMode>
  sessions: Record<string, PermissionMode>
  table: typeof MODE_TABLE
  ceilings: Record<string, Ceiling>
  ceilingKey: Readonly<Record<ActionClass, string | null>>
  grants: Pick<Grant, 'cls' | 'id' | 'project' | 'scope' | 'sessionId'>[]
  /** Never-acceptable writes (§1 floors 2 + 7): the policy, the audit, the gate's code, Hermes' approval config. */
  protectedPaths: string[]
  /** Never-acceptable reads for egress (§1 floor 4). Globs: `*` within one path segment. */
  secretPaths: string[]
  /** Floor 7: processes the agent may not stop (main; the plugin adds its own Hermes). */
  guardPids: number[]
  /** Floor 8: iNFT contracts whose tokens and approvals only the owner moves. Lower-case 0x addresses. */
  inftContracts: string[]
  /** V3-F2: every function's level (all nine, always) and the grants given to a function. */
  functions: FunctionLevels
  fnGrants: Pick<FunctionGrant, 'fn' | 'id' | 'project' | 'scope' | 'sessionId'>[]
}

interface SignedPolicy {
  v: 1
  keyId: string
  body: string
  sig: string
}

/** Main's own check of a message the plugin signed with its spawn key (socket events, §4). */
export function verifyMac(key: Buffer, text: string, mac: unknown): boolean {
  if (typeof mac !== 'string' || !/^[0-9a-f]{64}$/.test(mac)) {
    return false
  }

  const expected = createHmac('sha256', key).update(text).digest()

  return timingSafeEqual(expected, Buffer.from(mac, 'hex'))
}

export function buildPolicyBody(input: {
  mode: ModeRecord
  grants: readonly Grant[]
  ceilings: Record<string, Ceiling>
  protectedPaths: string[]
  secretPaths: string[]
  guardPids: number[]
  inftContracts: string[]
  functions: FunctionLevels
  fnGrants: readonly FunctionGrant[]
  now: Date
}): Omit<PolicyBody, 'gen'> {
  return {
    v: 1,
    issuedAt: input.now.toISOString(),
    standing: input.mode.standing,
    projects: input.mode.projects,
    sessions: input.mode.sessions,
    table: MODE_TABLE,
    ceilings: input.ceilings,
    ceilingKey: DEFAULT_CEILING_KEY,
    grants: input.grants.map(({ cls, id, project, scope, sessionId }) => ({ cls, id, project, scope, sessionId })),
    protectedPaths: input.protectedPaths,
    secretPaths: input.secretPaths,
    guardPids: input.guardPids,
    inftContracts: input.inftContracts.map(address => address.toLowerCase()),
    functions: input.functions,
    fnGrants: input.fnGrants.map(({ fn, id, project, scope, sessionId }) => ({ fn, id, project, scope, sessionId }))
  }
}

export interface MintedSpawnKey {
  key: Buffer
  keyId: string
  file: string
}

/** Live spawn keys are kept in memory; every key, live or retired, is re-derivable from the master by its id. */
export function createPolicySigner(dir: string, keys: PermissionKeys, now: () => number = Date.now) {
  const policyDir = path.join(dir, POLICY_DIR)
  const genFile = path.join(dir, GEN_FILE)
  const live = new Map<string, Buffer>()
  let lastBody: Omit<PolicyBody, 'gen'> | null = null

  const readGen = (): number => {
    try {
      const value = Number.parseInt(readFileSync(genFile, 'utf8').trim(), 10)

      return Number.isSafeInteger(value) && value > 0 ? value : 0
    } catch {
      return 0
    }
  }

  let gen = readGen()

  const nextGen = (): number => {
    // Strictly increasing: past the persisted value, past the last one in memory, and never behind the clock.
    gen = Math.max(gen + 1, readGen() + 1, now())
    writeFileAtomicSync(genFile, `${gen}\n`, { mode: 0o600, dirMode: 0o700 })

    return gen
  }

  const writeFor = (keyId: string, key: Buffer, body: PolicyBody) => {
    const text = JSON.stringify(body)
    const signed: SignedPolicy = { v: 1, keyId, body: text, sig: createHmac('sha256', key).update(text).digest('hex') }

    writeFileAtomicSync(path.join(policyDir, `${keyId}.json`), `${JSON.stringify(signed)}\n`, {
      mode: 0o600,
      dirMode: 0o700
    })
  }

  const retire = (keyId: string) => {
    live.delete(keyId)
    rmSync(path.join(policyDir, `${keyId}.json`), { force: true })
  }

  return {
    /** A fresh key for one spawn. The caller hands it to that child on its key pipe and nowhere else. */
    mint(): MintedSpawnKey {
      const keyId = keys.newSpawnNonce()
      const key = keys.spawnKey(keyId) as Buffer

      live.set(keyId, key)

      while (live.size > LIVE_KEYS_MAX) {
        retire(live.keys().next().value as string)
      }

      if (lastBody) {
        writeFor(keyId, key, { ...lastBody, gen })
      }

      return { key, keyId, file: path.join(policyDir, `${keyId}.json`) }
    },
    /** A live spawn's key: asks, hello and heartbeats are accepted only from these. */
    keyFor: (keyId: unknown): Buffer | null => (typeof keyId === 'string' ? (live.get(keyId) ?? null) : null),
    /** Any spawn's key, live or retired (a dead process's write-ahead log replays under it). */
    anyKey: (keyId: unknown): Buffer | null => keys.spawnKey(keyId),
    isLive: (keyId: string): boolean => live.has(keyId),
    /** The spawn exited: its policy file goes, its key stays derivable for replays only. */
    retire,
    currentGen: (): number => gen,
    /** Re-signs every live spawn's file under a new generation; files of keys main no longer holds are removed. */
    publish(body: Omit<PolicyBody, 'gen'>): number {
      lastBody = body

      const published = nextGen()

      for (const [keyId, key] of live) {
        writeFor(keyId, key, { ...body, gen: published })
      }

      try {
        for (const name of readdirSync(policyDir)) {
          if (name.endsWith('.json') && !live.has(name.slice(0, -'.json'.length))) {
            rmSync(path.join(policyDir, name), { force: true })
          }
        }
      } catch {
        // nothing published yet
      }

      return published
    }
  }
}

export type PolicySigner = ReturnType<typeof createPolicySigner>
