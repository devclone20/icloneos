/**
 * iCLONE OS — the economy gate of a deactivated iNFT (R9 §3.1). One pure check
 * that BOTH acp doors run before any child starts: the renderer's `runAcp`
 * (iclone-acp.ts) and the agent's own socket (iclone-acp-ipc.ts). It imports
 * no electron, so the socket server and its tests load it as they are.
 *
 * While an iNFT is `lost`, only read-only commands pass, plus the door's own
 * Virtuals rename — built by `doorRenameArgv` from the record, the same
 * function the door uses, and matched exactly.
 */
import { isSafeSlug } from './iclone-acp-store'
import { type OwnershipRecord, readRecord } from './iclone-ownership-store'

let gateRoot: string | null = null

/** The `userData` root the doors read `inft/<slug>/ownership.json` from (set once at startup). */
export function setOwnershipGateRoot(root: string | null): void {
  gateRoot = root
}

/** The door's Virtuals rename — the one `agent update` a deactivated iNFT may run. */
export function deactivatedAgentName(tokenId: string): string {
  return `[iNFT Deactivated] #${tokenId}`
}

export function deactivatedAgentDescription(tokenId: string, when: string, txHash: string | undefined): string {
  return `This agent no longer holds iNFT #${tokenId} (transferred ${when}, tx ${txHash ?? 'unknown'}).`
}

/** The transfer's day (UTC) as the door writes it into the description. */
function transferDay(record: OwnershipRecord): string {
  return record.transfer ? new Date(record.transfer.timestamp * 1000).toISOString().slice(0, 10) : 'unknown date'
}

/** The door's rename argv (without `--inft <slug>`), from the record alone. */
export function doorRenameArgv(record: OwnershipRecord): string[] {
  const n = record.inft.tokenId

  return [
    'agent',
    'update',
    '--name',
    deactivatedAgentName(n),
    '--description',
    deactivatedAgentDescription(n, transferDay(record), record.transfer?.txHash),
    '--json'
  ]
}

/** True when this iNFT's loss is proven (state `lost`) — for the economy gate. */
export function isInftDeactivated(slug: string, root: string | null = gateRoot): boolean {
  return root !== null && isSafeSlug(slug) && readRecord(root, slug, Date.now())?.state === 'lost'
}

/** Read-only acp commands a deactivated iNFT may still run. */
const READ_ONLY_ACP = new Set([
  'agent whoami',
  'agent list',
  'agent signer-status',
  'agent signer-policy',
  'wallet address',
  'wallet balance',
  'wallet sol address',
  'wallet sol balance',
  'email whoami',
  'email inbox',
  'email thread',
  'email search',
  'card whoami',
  'card list',
  'card get',
  'trade hl-status',
  'trade hl-orders',
  'trade stock-list',
  'offering list',
  'resource list',
  'subscription list',
  'job list',
  'job history',
  'chain list',
  'compute status'
])

/** Exactly the door's argv: `agent update`, then `--name` and `--description`
 *  once each with the door's values (`--flag value` or `--flag=value`), and an
 *  optional bare `--json`. Any other token — a positional, another flag, a
 *  value after `--json` — makes it an ordinary, refused `agent update`. */
function isDoorRename(rest: string[], record: OwnershipRecord): boolean {
  const door = doorRenameArgv(record)

  const want = new Map([
    ['--name', door[3]],
    ['--description', door[5]]
  ])

  if (rest[0] !== 'agent' || rest[1] !== 'update') {
    return false
  }

  const seen = new Map<string, string>()

  for (let i = 2; i < rest.length; i += 1) {
    const a = rest[i]

    if (a === '--json') {
      if (seen.has(a)) {
        return false
      }

      seen.set(a, '')

      continue
    }

    const eq = a.indexOf('=')
    const flag = eq > 0 ? a.slice(0, eq) : a

    if (!want.has(flag) || seen.has(flag)) {
      return false
    }

    if (eq > 0) {
      seen.set(flag, a.slice(eq + 1))
    } else if (i + 1 < rest.length) {
      seen.set(flag, rest[i + 1])
      i += 1
    } else {
      return false
    }
  }

  return [...want].every(([flag, value]) => seen.get(flag) === value)
}

/** The economy gate: a refusal message for any command that is not read-only
 *  when the iNFT is deactivated, else null. The door's rename reaches it too —
 *  the door runs `~/.iclone-os/bin/acp`, the socket client. */
export function economyRefusal(slug: string, argv: string[], root: string | null = gateRoot): string | null {
  const record = root !== null && isSafeSlug(slug) ? readRecord(root, slug, Date.now()) : null

  if (record?.state !== 'lost') {
    return null
  }

  // The door passes `--inft <slug>` first; the bridge may already have dropped it.
  const rest = argv[0] === '--inft' ? argv.slice(2) : argv
  // Only the leading words name the command: a word after a flag may be its value.
  const lead = rest.findIndex(a => a.startsWith('-'))
  const words = lead === -1 ? rest : rest.slice(0, lead)
  const two = words.slice(0, 2).join(' ')
  const three = words.slice(0, 3).join(' ')

  if (rest[0] === 'agent' && rest[1] === 'update') {
    return isDoorRename(rest, record)
      ? null
      : 'iNFT Deactivated — the agent keeps the name "' +
          deactivatedAgentName(record.inft.tokenId) +
          '"; agent updates are refused. See Settings → iNFT → Ownership.'
  }

  return READ_ONLY_ACP.has(three) || READ_ONLY_ACP.has(two)
    ? null
    : 'iNFT Deactivated — this iNFT left the wallet; economy commands are refused. See Settings → iNFT → Ownership.'
}
