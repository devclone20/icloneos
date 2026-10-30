import { vi } from 'vitest'

import { BUNDLED_POLICY } from '../../../electron/policy-version.generated'

import type {
  ConsentDoorRecent,
  ConsentDoorRequest,
  ConsentRecord,
  ConsentSnapshot,
  IcloneConsentBridge
} from './types'

/**
 * The policy the app ships, as main sends it (ruling §3: the artefact is the record, never a copy of it). Its §9 table
 * still lists Local network, a key this build has no switch for (U1-08-p2): the renderer must drop it, so the fixture
 * carries it.
 */
export const bundledPolicy: ConsentSnapshot['bundled'] = BUNDLED_POLICY
const BUNDLED = bundledPolicy

export const accepted = (over: Partial<ConsentRecord> = {}): ConsentRecord => ({
  schema: 1,
  policyVersion: BUNDLED_POLICY.version,
  policyEffective: BUNDLED_POLICY.effective,
  acceptedAt: '2026-10-17T10:00:00.000Z',
  permissions: {},
  permissionsDecidedAt: null,
  skipped: false,
  aiProviderConsent: null,
  ...over
})

/** A fake main process: keeps one record and answers like electron/iclone-consent.ts. */
export function fakeConsentBridge(initial: ConsentRecord | null, keychainEncrypted = false) {
  let record = initial
  const requestMicrophoneAccess = vi.fn(async () => true)
  const doorListeners = new Set<(request: ConsentDoorRequest | null) => void>()
  let door: ConsentDoorRequest | null = null
  let recent: ConsentDoorRecent[] = []

  const bridge: IcloneConsentBridge = {
    get: vi.fn(async (): Promise<ConsentSnapshot> => ({
      state: !record ? 'required' : record.policyVersion < BUNDLED.version ? 'update' : 'ok',
      record,
      bundled: BUNDLED,
      keychainEncrypted
    })),
    policyText: vi.fn(async () => [{ kind: 'heading' as const, id: 'pp-who', text: '1. Who we are' }]),
    accept: vi.fn(async ({ version }) => {
      record = accepted({
        ...(record ?? {}),
        policyVersion: version,
        aiProviderConsent: { accepted: true, at: 'now' }
      })

      return { ok: true as const, record }
    }),
    setPermissions: vi.fn(async ({ permissions, skipped }) => {
      record = accepted({
        ...(record ?? {}),
        permissions: skipped ? {} : (permissions ?? {}),
        permissionsDecidedAt: skipped ? null : '2026-10-17T10:00:00.000Z',
        skipped: skipped === true
      })

      return { ok: true as const, record }
    }),
    setAiProvider: vi.fn(async ({ accepted: on }) => {
      record = accepted({ ...(record ?? {}), aiProviderConsent: { accepted: on, at: 'now' } })

      return { ok: true as const, record }
    }),
    openPolicy: vi.fn(async () => true),
    quit: vi.fn(async () => true),
    doorCurrent: vi.fn(async () => door),
    doorAnswer: vi.fn(async ({ id, choice }) => {
      if (!door || door.id !== id) {
        return false
      }

      recent = [
        { ...door, answer: choice === 'deny' ? ('denied' as const) : choice, at: '2026-10-17T10:05:00.000Z' },
        ...recent
      ]
      showDoor(null)

      return true
    }),
    requests: vi.fn(async () => recent),
    onDoor: vi.fn(callback => {
      doorListeners.add(callback)

      return () => doorListeners.delete(callback)
    })
  }

  // Main's broadcast of the request on screen.
  function showDoor(request: ConsentDoorRequest | null) {
    door = request
    doorListeners.forEach(listener => listener(request))
  }

  Object.assign(window, {
    hermesDesktop: {
      ...(window.hermesDesktop ?? {}),
      getSecretStorageEncryption: async () => ({ on: keychainEncrypted }),
      icloneConsent: bridge,
      requestMicrophoneAccess
    }
  })

  return { bridge, requestMicrophoneAccess, record: () => record, showDoor }
}
