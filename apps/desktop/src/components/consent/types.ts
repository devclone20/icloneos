import type {
  ActionClass,
  AuditRecordView,
  FunctionLevel,
  ModeScope,
  PermissionDoorScope,
  PermissionFunction,
  PermissionMode,
  PermissionStateView,
  SetFunctionLevelResultView,
  SetModeResultView
} from '@/iclone-shared/permissions'

import type { SetupChoice, SetupDecisions, SetupSection } from '../setup/types'

// Renderer view of electron/iclone-consent.ts (main owns consent.json; these are its IPC shapes).
export const CONSENT_CAPABILITY_KEYS = [
  'terminal',
  'fileWriting',
  'webBrowsing',
  'automation',
  'screen',
  'clipboard',
  'installSoftware',
  'scheduledTasks',
  'sendMessages',
  'spendTrade'
] as const

/** Device rows. Keychain is the Mac's real state: recorded and shown, never a switch. */
export const CONSENT_DEVICE_KEYS = ['microphone', 'notifications', 'keychain'] as const

/** Every switch, capabilities first (the order the sheet shows). */
export const CONSENT_PERMISSION_KEYS = [
  'terminal',
  'fileWriting',
  'webBrowsing',
  'automation',
  'screen',
  'clipboard',
  'installSoftware',
  'scheduledTasks',
  'sendMessages',
  'spendTrade',
  'microphone',
  'notifications',
  'keychain'
] as const

/** Policy §9: shown for information only, never a switch. */
export const CONSENT_NEVER_USED = ['camera', 'location', 'contacts'] as const

/** A row the sheet and Settings › Privacy show as a switch. */
export type ConsentSwitchKey = (typeof CONSENT_PERMISSION_KEYS)[number]
/** Plus `files`: the policy's §9 "Files and folders" (reading) row, folded into File writing's line, never a switch. */
export type ConsentPermissionKey = ConsentSwitchKey | 'files'
export type ConsentPermissions = Partial<Record<ConsentPermissionKey, boolean>>
export type ConsentState = 'ok' | 'required' | 'update'

export interface ConsentRecord {
  schema: 1
  policyVersion: string
  policyEffective: string
  acceptedAt: string
  permissions: ConsentPermissions
  permissionsDecidedAt: string | null
  skipped: boolean
  aiProviderConsent: { accepted: boolean; at: string } | null
  /** V3-ON: the Set up step's decisions per section; absent = never decided. */
  setup?: SetupDecisions
}

export interface BundledPolicy {
  version: string
  effective: string
  effectiveLabel: string
  title: string
  url: string
  sha256: string
  short: readonly { lead: string; text: string }[]
  permissionsIntro: string
  // The §9 table is the legal document: it may name a permission this build has no switch for (Local network,
  // U1-08-p2). rows.ts picks rows by the app's own keys, so a listed key never becomes a switch by itself.
  permissions: readonly { key: string; name: string; purpose: string }[]
}

export interface ConsentSnapshot {
  state: ConsentState
  record: ConsentRecord | null
  bundled: BundledPolicy
  keychainEncrypted: boolean
}

export interface PolicyBlock {
  id?: string
  kind: 'heading' | 'item' | 'meta' | 'paragraph' | 'row' | 'title'
  text: string
}

export type ConsentResult = { ok: true; record: ConsentRecord } | { ok: false; error: string }

export interface IcloneConsentBridge {
  get: () => Promise<ConsentSnapshot>
  policyText: () => Promise<PolicyBlock[] | null>
  accept: (input: { aiProvider?: boolean; version: string }) => Promise<ConsentResult>
  setPermissions: (input: { permissions?: ConsentPermissions; skipped?: boolean }) => Promise<ConsentResult>
  setAiProvider: (input: { accepted: boolean }) => Promise<ConsentResult>
  /** V3-ON. Absent on an older main: the Set up step is not offered. */
  setSetup?: (input: { sections: Partial<Record<SetupSection, SetupChoice>> }) => Promise<ConsentResult>
  openPolicy: () => Promise<boolean>
  quit: () => Promise<boolean>
  doorCurrent?: () => Promise<ConsentDoorRequest | null>
  doorAnswer?: (input: { id: string; choice: ConsentDoorChoice | PermissionDoorChoice }) => Promise<boolean>
  requests?: () => Promise<ConsentDoorRecent[]>
  onDoor?: (callback: (request: ConsentDoorRequest | null) => void) => () => void
  /** V3-F (electron/iclone-permissions/ipc.ts). Absent in the web app: no agent runs there. */
  permissions?: IclonePermissionsBridge
}

/** setMode and revoke count only when called synchronously inside the click handler of a `data-perm-mode-confirm`
 *  control: the preload adds the gesture proof main checks. */
export interface IclonePermissionsBridge {
  setMode: (input: { mode: PermissionMode; scope: ModeScope; key?: string | null }) => Promise<SetModeResultView>
  revoke: (id: string) => Promise<boolean>
  setFunctionLevel: (input: { fn: PermissionFunction; level: FunctionLevel }) => Promise<SetFunctionLevelResultView>
  hermesApproval: (input: {
    command: string
    description: string
    sessionId: string | null
  }) => Promise<'deny' | 'once'>
  state: (dir?: string | null) => Promise<PermissionStateView>
  tail: (since: number) => Promise<AuditRecordView[]>
  onChanged: (callback: (seq: unknown) => void) => () => void
}

export type ConsentDoorChoice = 'always' | 'deny' | 'once'
export type PermissionDoorChoice = 'deny' | PermissionDoorScope

/** A V3-F permission ask on the sheet: the class, the literal target, and the scopes this ask may grant. */
export interface ConsentDoorPermission {
  cls: ActionClass
  tool: string
  target: string
  mode: PermissionMode
  project: string | null
  session: string | null
  subagent: string | null
  scopes: readonly PermissionDoorScope[]
}

/** The agent's request on screen (electron/iclone-consent-door.ts). */
export interface ConsentDoorRequest {
  id: string
  key: ConsentSwitchKey
  reason: string
  inft: string
  at: string
  expiresAt: string
  permission?: ConsentDoorPermission
}

export interface ConsentDoorRecent {
  key: ConsentSwitchKey
  reason: string
  inft: string
  answer: 'always' | 'denied' | 'once' | 'timeout'
  at: string
}
