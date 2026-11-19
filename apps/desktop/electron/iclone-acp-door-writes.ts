/**
 * v0.0.9 — lead decision on the agent's own `acp` door (17 Nov, revised): the agent may still run
 * `agent register-erc8004` (signs an on-chain transaction) and the offering / resource catalogue writes, but each one
 * is decided by the owner's PER-FUNCTION choice for the `acp` function (Settings › Agent › Permissions › Functions),
 * never by the global mode:
 *
 *   acp row at Follow mode (the shipped default) · Ask once · Ask always  →  ask the owner for THIS call (once only)
 *   acp row at Automatic · Ignore (the owner chose to allow the function) →  allowed, audited as the row's choice
 *   acp row at Manual                                                    →  refused
 *
 * Follow mode does NOT follow the mode here: a global Automatic / Ignore / Accept edits alone never lets one of these
 * writes through without the owner's click. Only the owner's own level for `acp` does (that level is itself a raise
 * the owner confirms on the system dialog, functions.ts `isRaise`). The ask is the sheet every permission ask uses; it
 * is answered only by the owner's trusted click (`iclone:consent:door-answer` checks the gesture), and an answer that
 * never comes (timeout, busy, withdrawn) is a refusal. The authority not up, or an audit that cannot record = refused.
 *
 * The window's own path (Register button, Market forms) keeps F1-S's owner-click lock (gesture-locks-acp.ts); this
 * module is only the agent door (iclone-acp-ipc.ts).
 */
import type { FunctionLevel, PermissionMode } from '../src/iclone-shared/permissions'

import type { ConsentPermissionKey } from './iclone-consent'
import type { DoorPermission, PermissionDoorAnswer } from './iclone-consent-door'

/**
 * Which owner-locked write an agent argv is: one the iNFT's wallet SIGNS (`acp-register`: the ERC-8004 registration
 * and the other signing commands below), or a catalogue write (`acp-market`).
 */
export type AcpDoorWriteKind = 'acp-market' | 'acp-register'

/**
 * v0.0.9 Q (security m3, lead decision 3): read from the bundled CLI (acp-cli 1.0.38, dist/bin/acp.js), these sign or
 * pay with the iNFT's wallet, so they take the same per-function level (default ask) as `agent register-erc8004`:
 * - `agent tokenize`: `tokenizeOnEvm` sends `sendApprove` (VIRTUAL approve calldata) and `sendPreLaunch` (the launch
 *   transaction, with an optional pre-buy) — signs and pays;
 * - `wallet sign-typed-data`: signs EIP-712 data with the active wallet (a permit can authorise spending);
 * - `wallet sign-message`: signs a message with the active wallet (a sign-in proof of the wallet).
 * Read and left to the door's other rules: `agent migrate` (`agentApi.migrateAgent` on the server, then the add-signer
 * flow, which the owner must approve in the browser: nothing is signed or paid locally).
 */
const SIGNING_WRITES = new Set(['agent register-erc8004', 'agent tokenize', 'wallet sign-typed-data', 'wallet sign-message'])

/** v0.0.9 Q (m3): subscriptions are the same Market catalogue (`agentApi.createSubscription` …) as offerings. */
const CATALOGUE_ROOTS = new Set(['offering', 'resource', 'subscription'])
const CATALOGUE_WRITES = new Set(['create', 'update', 'delete'])

/** Pure: is this (already allowlisted) agent argv one of the owner-locked writes? `--help` alone is a read. */
export function acpDoorWriteOf(argv: readonly string[]): AcpDoorWriteKind | null {
  const [root, sub] = argv

  if (argv.length === 2 && (sub === '--help' || sub === '-h')) {
    return null
  }

  if (root !== undefined && sub !== undefined && SIGNING_WRITES.has(`${root} ${sub}`)) {
    return 'acp-register'
  }

  return root !== undefined && sub !== undefined && CATALOGUE_ROOTS.has(root) && CATALOGUE_WRITES.has(sub)
    ? 'acp-market'
    : null
}

/** One audit entry for a door write decision (iclone-permissions/ipc.ts `recordAcpWrite`); null = not recorded. */
export interface AcpDoorWriteAuditEntry {
  kind: 'refuse' | 'use'
  reason: string
  /** True only when the owner answered the sheet (a trusted click). */
  gesture: boolean
  command: string
  lock: AcpDoorWriteKind
}

export interface AcpDoorWriteDeps {
  /** The owner's level for the `acp` function; null when the permission authority is not up (fail closed). */
  level(): FunctionLevel | null
  /** Main's reading of the calling session's mode — for the sheet's words only, never part of the decision. */
  mode(sessionId: string | null): PermissionMode | null
  /** One ask on the app's permission sheet (iclone-consent-door.ts `askOnActiveDoor`). */
  ask(
    slug: string,
    permission: DoorPermission,
    key: ConsentPermissionKey,
    reason: string,
    signal?: AbortSignal
  ): Promise<PermissionDoorAnswer>
  audit(entry: AcpDoorWriteAuditEntry): unknown
}

export type AcpDoorWriteVerdict = { admitted: true } | { admitted: false; error: string }

export const ACP_DOOR_WRITE_REFUSED = {
  starting: '[acp-door-write:starting] icloneOS permissions are not up yet, so no on-chain or catalogue write runs',
  manual: '[acp-door-write:manual] your acp level is Manual: the agent does not run this write',
  denied: '[acp-door-write:denied] the owner did not allow this write',
  audit: '[acp-door-write:audit] the audit is not available, so nothing that needs the owner runs'
} as const

/** Levels at which the owner chose to let the `acp` function run without an ask. */
const OWNER_ALLOWS: ReadonlySet<FunctionLevel> = new Set<FunctionLevel>(['automatic', 'ignore'])

/** Words the sheet shows for each write (the agent's reason is never trusted for this). */
const SHEET_REASON: Readonly<Record<AcpDoorWriteKind, string>> = {
  'acp-register': 'The agent wants to register this iNFT on ERC-8004 (signs an on-chain transaction)',
  'acp-market': 'The agent wants to change this iNFT’s Market catalogue (offerings, resources or subscriptions)'
}

/** The signing commands other than the registration name what they sign. */
const SIGNING_REASON: Readonly<Record<string, string>> = {
  'agent tokenize': 'The agent wants to tokenize this iNFT (signs on-chain transactions and may spend VIRTUAL)',
  'wallet sign-typed-data': 'The agent wants this iNFT’s wallet to sign typed data (EIP-712: it can authorise spending)',
  'wallet sign-message': 'The agent wants this iNFT’s wallet to sign a message'
}

/**
 * Decide one agent-door argv. Null = not an owner-locked write (the door's other rules decide it). Otherwise the
 * verdict: admitted only by the owner's level for `acp` or by the owner's click on the sheet for this very call.
 */
export async function admitAcpDoorWrite(
  deps: AcpDoorWriteDeps,
  request: { slug: string; session: string | null; argv: readonly string[] },
  signal?: AbortSignal
): Promise<AcpDoorWriteVerdict | null> {
  const lock = acpDoorWriteOf(request.argv)

  if (!lock) {
    return null
  }

  const command = request.argv.slice(0, 2).join(' ')

  const settle = (kind: 'refuse' | 'use', reason: string, gesture: boolean, error: string): AcpDoorWriteVerdict => {
    let recorded: unknown = null

    try {
      recorded = deps.audit({ kind, reason, gesture, command, lock })
    } catch {
      recorded = null
    }

    if (recorded === null || recorded === undefined) {
      return { admitted: false, error: ACP_DOOR_WRITE_REFUSED.audit }
    }

    return kind === 'use' ? { admitted: true } : { admitted: false, error }
  }

  const level = deps.level()

  if (level === null) {
    // Nothing to record into either: the authority (and its audit) is not up.
    return { admitted: false, error: ACP_DOOR_WRITE_REFUSED.starting }
  }

  if (level === 'manual') {
    return settle('refuse', 'door: acp is set to manual', false, ACP_DOOR_WRITE_REFUSED.manual)
  }

  if (OWNER_ALLOWS.has(level)) {
    return settle('use', `door: acp is set to ${level} (the owner's own choice)`, false, '')
  }

  // Follow mode, Ask once, Ask always: ask for this one call. The sheet never hears Ignore (the door would answer an
  // Ignore ask by itself, iclone-consent-door.ts F40): whatever the global mode, this ask reaches the owner.
  const inForce = deps.mode(request.session)
  const sheetMode: PermissionMode = inForce === null || inForce === 'ignore' ? 'manual' : inForce
  const cls = lock === 'acp-register' ? '$' : 'N'

  let answer: PermissionDoorAnswer

  try {
    answer = await deps.ask(
      request.slug,
      {
        cls,
        tool: `acp ${command}`,
        target: request.argv.join(' ').slice(0, 500),
        mode: sheetMode,
        project: null,
        session: request.session,
        subagent: null,
        scopes: ['once']
      },
      lock === 'acp-register' ? 'spendTrade' : 'webBrowsing',
      SIGNING_REASON[command] ?? SHEET_REASON[lock],
      signal
    )
  } catch {
    answer = { outcome: 'withdrawn', shown: false }
  }

  return answer.outcome === 'once'
    ? settle('use', `door: the owner allowed this ${command} once`, true, '')
    : settle('refuse', `door: ${command} not allowed (${answer.outcome})`, false, ACP_DOOR_WRITE_REFUSED.denied)
}
