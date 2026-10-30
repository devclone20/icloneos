/**
 * REL-6 (ruling 26) — the ACP tools (the Virtuals ACP CLI the app installs at first use from npm), as main reports
 * them to the window. Main owns every transition (electron/iclone-acp-tools/); the window only shows the state and
 * asks for an install or a cancel on the owner's own click.
 *
 * Main never sends a sentence: every refusal and failure is a REASON CODE (each one a key in the six locales,
 * i18n/<locale>/acpTools.ts) plus, when it helps, a `subject` that is data, never language (a package name and
 * version, a path inside the installed tree). The window composes the words.
 */

/** Why the tools cannot run, or why an install did not finish. */
export const ACP_TOOLS_REASONS = [
  // the build and the OS
  'pin-invalid',
  'launcher-missing',
  'installer-down',
  'unsealable',
  // FX-2: no seal because the owner's Keychain setting is off (the fix is theirs to make, and the pane names it)
  'keychain-off',
  'key-unopenable',
  'record-unwritable',
  // the installed tree
  'manifest-missing',
  'manifest-malformed',
  'manifest-digest',
  'manifest-signature',
  'other-pin',
  'not-recorded',
  'tree-unreadable',
  'not-plain',
  'extra-file',
  'missing-file',
  'file-changed',
  'mode-changed',
  'moved',
  'system-acp',
  // an install
  'download-failed',
  'download-stalled',
  'download-timeout',
  'download-too-large',
  'download-refused',
  'integrity',
  'tar-unsafe',
  'nested-modules',
  'licence-file-missing',
  'signer-missing',
  'addons-missing',
  'addons-mismatch',
  'addon-swap',
  'new-tree-unverified',
  'disk',
  'internal'
] as const

export type AcpToolsReason = (typeof ACP_TOOLS_REASONS)[number]

export const isAcpToolsReason = (value: unknown): value is AcpToolsReason =>
  (ACP_TOOLS_REASONS as readonly unknown[]).includes(value)

/** A reason and its data. `subject` is never shown on its own: the locale's frame places it. */
export interface AcpToolsProblemInfo {
  reason: AcpToolsReason
  subject?: string
}

interface ViewBase {
  /** The last install's failure, kept for the panel until the next attempt. */
  lastError?: AcpToolsProblemInfo
}

export type AcpToolsView = ViewBase &
  (
    | { state: 'checking'; cliVersion: string | null }
    /** Not installed for this build's pin. `stale`: a tree for an older pin exists (an app update moved the pin). */
    | { state: 'absent'; cliVersion: string; stale: boolean }
    | {
        state: 'installing'
        cliVersion: string
        phase: 'download' | 'verify'
        done: number
        total: number
        bytes: number
      }
    /** Verified against its manifest, whose MAC the OS-sealed key verified (there is no unsealed install). */
    | { state: 'installed'; cliVersion: string; packages: number; installedAt: string }
    /** A tree is there but does not verify (changed, partial, another pin, a signature that fails, no key). */
    | ({ state: 'unverified'; cliVersion: string } & AcpToolsProblemInfo)
    /** This build or this session cannot install (its pin is missing or refused, the OS cannot seal a key). */
    | ({ state: 'unavailable'; cliVersion: string | null } & AcpToolsProblemInfo)
  )

export type AcpToolsState = AcpToolsView['state']

export type AcpToolsInstallResult =
  | { ok: true; view: AcpToolsView }
  | { ok: false; error: 'gesture' | 'busy' | 'audit' | 'cancelled' }
  | ({ ok: false; error: 'failed' } & AcpToolsProblemInfo)

const STATES: readonly AcpToolsState[] = ['checking', 'absent', 'installing', 'installed', 'unverified', 'unavailable']

/** The window's guard on what crosses IPC. */
export function isAcpToolsView(value: unknown): value is AcpToolsView {
  return (
    typeof value === 'object' &&
    value !== null &&
    (STATES as readonly unknown[]).includes((value as { state?: unknown }).state)
  )
}

/** Ready to run: the only state in which any ACP path may spawn. */
export const acpToolsReady = (view: AcpToolsView | null | undefined): boolean => view?.state === 'installed'

/**
 * Every ACP path main refuses while the tools are not ready answers with this machine prefix first (then an English
 * sentence, for the log only): `[acp-tools:<state>:<reason>]`. The window classifies on the prefix, never on words.
 */
export const ACP_TOOLS_REFUSAL = /\[acp-tools:(absent|installing|unverified|unavailable)(?::([a-z-]+))?\]/

export function acpToolsRefusal(message: string | null | undefined): { state: string; reason: string | null } | null {
  const match = ACP_TOOLS_REFUSAL.exec(message ?? '')

  return match ? { state: match[1] as string, reason: match[2] ?? null } : null
}
