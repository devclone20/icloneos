/**
 * The update policy (PLAN R front R1): who may move the Hermes runtime beneath iclone os, and when.
 *
 * - `curated` (every packaged build): the runtime is the one this release bundles (RUNTIME_PIN). No automatic contact
 *   with the upstream repository, no "update available" from upstream, every install/repair/alignment pinned by sha.
 * - `developer` (`pnpm dev`, or a packaged build on the developer's own Mac after a typed ack in About): the same
 *   silence, plus an explicit "Compare with upstream" click and the raw `hermes update` door behind the compat gate.
 *
 * - `agent-latest` (U1, every policy): the user's own "Update" click in Settings › Updates › Agent moves the runtime to
 *   the tip of NousResearch/hermes-agent `main`, after a one-click read-only check. The pin stays the verified FLOOR
 *   ("verified with this release"), never a ceiling; nothing reaches upstream unless the user clicks.
 *
 * Electron-free: main resolves it once, the renderer reads it over IPC, enforcement stays in main.
 */
import fs from 'node:fs'

import { RUNTIME_PIN } from './runtime-pin.generated'

export type UpdatePolicy = 'curated' | 'developer'

/** Which door an apply goes through: the policy's own, or the user-run agent update. */
type UpdateDoor = 'agent-latest' | 'curated-pin' | 'developer'

/** The door an apply request takes. `agent-latest` is open under every policy; everything else follows the policy. */
export function resolveUpdateDoor(policy: UpdatePolicy, requested?: unknown): UpdateDoor {
  if (requested === 'agent-latest') {
    return 'agent-latest'
  }

  return policy === 'curated' ? 'curated-pin' : 'developer'
}

export const UPDATE_POLICY_LOG_TAG = '[iclone-update-policy]'
export const UPDATE_POLICY_OVERRIDE_FILE = 'update-policy.json'
/** The exact text the owner types in About to run a packaged build under the developer policy. */
export const DEVELOPER_POLICY_ACK = 'I am the developer of this Mac'

interface UpdatePolicyOverride {
  at: string
  by: string
  policy: 'developer'
}

export interface RuntimePinInfo {
  date: string
  installShSha256: string
  minApp: string
  sha: string
  /** V3-RT: `repo` = the runtime is built from icloneOS's own repository and exists only inside the app bundle. */
  source?: string
  tarballSha256: string
  verified: string
}

export const BUNDLED_RUNTIME_PIN: RuntimePinInfo = RUNTIME_PIN

/** Reads `userData/update-policy.json`; anything but a well-formed developer override is no override (fail closed). */
export function readUpdatePolicyOverride(file: string, read = (p: string) => fs.readFileSync(p, 'utf8')) {
  try {
    const value = JSON.parse(read(file)) as Partial<UpdatePolicyOverride>

    if (value?.policy === 'developer' && typeof value.by === 'string' && value.by && typeof value.at === 'string') {
      return { at: value.at, by: value.by, policy: 'developer' } as UpdatePolicyOverride
    }
  } catch {
    // missing or unreadable: the default applies
  }

  return null
}

export function resolveUpdatePolicy(input: {
  env: NodeJS.ProcessEnv
  isPackaged: boolean
  override?: null | UpdatePolicyOverride
}): UpdatePolicy {
  if (input.isPackaged) {
    return input.override?.policy === 'developer' ? 'developer' : 'curated'
  }

  return input.env.ICLONE_UPDATE_POLICY === 'curated' ? 'curated' : 'developer'
}

export function describeUpdatePolicy(policy: UpdatePolicy, override: null | UpdatePolicyOverride) {
  return override && policy === 'developer'
    ? `${UPDATE_POLICY_LOG_TAG} ${policy} (override by ${override.by} at ${override.at})`
    : `${UPDATE_POLICY_LOG_TAG} ${policy}`
}

/** Writes the operator override; refuses anything but the exact typed acknowledgement. */
export function writeUpdatePolicyOverride(
  file: string,
  input: { ack: unknown; by: unknown; now?: () => Date },
  write = (p: string, text: string) => fs.writeFileSync(p, text, { mode: 0o600 })
): { error?: string; ok: boolean; override?: UpdatePolicyOverride } {
  if (input.ack !== DEVELOPER_POLICY_ACK) {
    return { ok: false, error: 'ack-mismatch' }
  }

  const by = typeof input.by === 'string' && input.by.trim() ? input.by.trim().slice(0, 80) : 'owner'

  const override: UpdatePolicyOverride = {
    policy: 'developer',
    by,
    at: (input.now ?? (() => new Date()))().toISOString()
  }

  write(file, `${JSON.stringify(override)}\n`)

  return { ok: true, override }
}

interface RuntimePinStatus {
  aligned: boolean | null
  behind: 0
  commits: []
  currentSha: null | string
  fetchedAt: number
  pinDate: string
  pinned: true
  pinSha: string
  policy: UpdatePolicy
  supported: true
  updateAvailable: false
}

/** The local-only update status: the runtime HEAD (or source marker) against the bundled pin. No network. */
export function runtimePinStatus(input: {
  head: null | string
  now?: () => number
  pin?: RuntimePinInfo
  policy: UpdatePolicy
}): RuntimePinStatus {
  const pin = input.pin ?? BUNDLED_RUNTIME_PIN
  const head = input.head && /^[0-9a-f]{7,40}$/i.test(input.head) ? input.head.toLowerCase() : null

  return {
    supported: true,
    policy: input.policy,
    pinned: true,
    aligned: head ? pin.sha.startsWith(head) || head.startsWith(pin.sha) : null,
    currentSha: head,
    pinSha: pin.sha,
    pinDate: pin.date,
    updateAvailable: false,
    behind: 0,
    commits: [],
    fetchedAt: (input.now ?? Date.now)()
  }
}

/** The explicit developer compare; under curated it never reaches the network. */
export async function compareWithUpstreamGuarded<T>(policy: UpdatePolicy, compare: () => Promise<T>) {
  if (policy === 'curated') {
    return { supported: false, reason: 'curated-only', message: 'This build only uses the runtime it ships.' }
  }

  return compare()
}
