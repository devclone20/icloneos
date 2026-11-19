/**
 * v0.0.9 r3b (eng r3 MR3-1, the F2 headline): twenty app reopens with the fixture wallet `builtin:reopen`, each one
 * through the REAL renderer wiring — privy-session's boot (status → applySession → rescan → autoSummon), the one switch
 * door (inft-switch: the restore that waits for the agent, its reconnect wiring), inft-profile's soul and personality
 * writes, the stage store and acp-setup's acp-run call — against main's REAL decisions: the fixture's own scan, soul and
 * model answers (electron/fixture-wallet.ts) and the session-scoped notes plus the acp-run rule that admit or refuse an
 * iNFT (electron/inft-known-ids.ts, `acpRunInftRefusal`).
 *
 * Each reopen is a new renderer (fresh modules) and a new main (a fresh notes set) over the same backend (the profiles
 * and config persist) and the same window storage (the remembered stage choice). The agent comes up AFTER the scan, as
 * on a real launch. Every second reopen the gateway socket is also replaced mid-request ("connection closed"), so the
 * switch has to wait it out through the reconnect wiring. Every cycle must end connected: the model on stage (the
 * stage and its "Open in new window" menu render from it), the persona applied, acp-run admitted, and the harness marker
 * `[fixture] inft connected inft-000000-101` produced from the real switch log line.
 *
 * Red on bf42e8eb02: builtin:grid had no model (nothing summoned: no stage), no soul (no persona: plain Hermes), and its
 * ids were never noted (acp-run refused "unknown iNFT"); there was no builtin:reopen at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  FIXTURE_MODEL_URL,
  fixtureProfile,
  fixtureScanResult,
  fixtureSession,
  fixtureSwitchLogLine,
  type FixtureWallet,
  resolveFixtureWallet
} from '../../../electron/fixture-wallet'
import { acpRunInftRefusal, createSessionScopedInftIds } from '../../../electron/inft-known-ids'

const backend = vi.hoisted(() => ({
  profiles: new Map<string, string>(),
  personalities: new Map<string, string>(),
  configWrites: 0
}))

vi.mock('@/api/profiles', () => ({
  createProfile: async ({ name }: { name: string }) => {
    if (backend.profiles.has(name)) {
      throw new Error(`profile ${name} already exists`)
    }

    backend.profiles.set(name, '')
  },
  deleteProfile: async (name: string) => void backend.profiles.delete(name),
  getProfileSoul: async (name: string) => {
    if (!backend.profiles.has(name)) {
      throw new Error('HTTP 404: no such profile')
    }

    return { content: backend.profiles.get(name) }
  },
  updateProfileSoul: async (name: string, soul: string) => void backend.profiles.set(name, soul)
}))

vi.mock('@/api/config', () => ({
  getHermesConfigRecord: async () => ({}),
  saveHermesConfig: async (patch: { agent?: { personalities?: Record<string, { system_prompt: string }> } }) => {
    backend.configWrites += 1

    for (const [slug, value] of Object.entries(patch.agent?.personalities ?? {})) {
      backend.personalities.set(slug, value.system_prompt)
    }
  }
}))

vi.mock('@/store/profile', async importOriginal => ({
  ...(await importOriginal<object>()),
  refreshProfiles: async () => undefined
}))

vi.mock('@/app/open-session', () => ({ openSession: vi.fn() }))
vi.mock('./econ/badges', () => ({ clearEconBadges: vi.fn() }))
vi.mock('./econ/prefetch', () => ({ forgetPrefetch: vi.fn() }))
vi.mock('./ownership', async () => {
  const { atom } = await import('nanostores')

  return {
    $ownership: atom({}),
    observeOwnership: () => Promise.resolve(),
    ownershipForId: () => null,
    startOwnershipSync: vi.fn(),
    withDeactivatedCards: <T>(cards: T[]) => cards
  }
})

const AURORA_ID = 'base:0x000000000000000000000000000000000000c10e:101'
const AURORA_SLUG = 'inft-000000-101'
const REOPENS = 20

/** One app launch: a new main (its notes) and a new renderer (fresh modules) over the same backend and storage. */
async function reopen(fixture: FixtureWallet, cycle: number) {
  vi.resetModules()

  const notes = createSessionScopedInftIds() // main's notes die with the process
  const noHome = () => false // a home made in an earlier launch would admit it on its own; prove the scan does
  const acpRuns: Array<{ argv: unknown; inftId: string; refused: null | string }> = []
  const switchLines: string[] = []

  vi.spyOn(console, 'info').mockImplementation((line: unknown) => {
    if (typeof line === 'string' && line.startsWith('[inft-switch]')) {
      switchLines.push(line)
    }
  })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)

  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    iclonePrivy: {
      open: vi.fn(),
      logout: vi.fn(() => Promise.resolve({ ok: true })),
      onSession: () => () => undefined,
      // main's STATUS handler for a fixture run: it announces the session to the notes, then answers.
      status: async () => {
        const payload = fixtureSession(fixture, true)

        notes.session(payload.address)

        return payload
      },
      // main's SCAN handler for a fixture run: the fixture answer, noted like a real scan.
      scan: async (address: string) => {
        const token = notes.begin(address)
        const result = fixtureScanResult(fixture, 0)

        notes.noteScan(token, result.agents)

        return result
      },
      scanTick: async () => ({ ok: true, skipped: true, arrivals: [], owners: {} }),
      resolveProfile: async (item: { contract: string; tokenId: string }) =>
        fixtureProfile(fixture, item, `inft-${item.contract.replace(/^0x/, '').slice(0, 6)}-${item.tokenId}`)
    },
    icloneAcp: {
      // main's acp-run door: the unknown-iNFT rule before anything runs.
      run: async (inftId: string, argv: unknown) => {
        const refused = acpRunInftRefusal(inftId, notes.has, noHome)

        acpRuns.push({ argv, inftId, refused })

        return refused
          ? { ok: false, code: null, stdout: '', stderr: '', error: refused }
          : { ok: true, code: 0, stdout: '{}', stderr: '', error: undefined }
      },
      setStage: async () => undefined,
      configMap: async () => ({})
    }
  }

  const { $gateway } = await import('@/store/gateway')
  const { $gatewayState } = await import('@/store/session')

  // The agent is still starting when the window boots (the restore must wait for it, never race it).
  $gatewayState.set('connecting')

  const { $inftSwitch } = await import('./inft-switch')
  const { $activeInft } = await import('./stage-store')
  const { runAcp } = await import('./acp-setup')
  const applied: string[] = []
  let dropNext = cycle % 2 === 1

  await import('./privy-session') // its boot: status → applySession → rescan → autoSummon → switchInft('restore')

  // The scan lands and the model is on stage BEFORE the agent is up.
  await vi.waitFor(() => expect($activeInft.get()?.id).toBe(AURORA_ID))
  expect($inftSwitch.get().phase).toBe('waiting')

  // The agent comes up.
  $gateway.set({
    request: async (method: string, params: Record<string, unknown>) => {
      if (method !== 'config.set') {
        return {}
      }

      if (dropNext) {
        // The socket is replaced mid-request: the switch waits for the gateway through the reconnect wiring.
        dropNext = false
        setTimeout(() => {
          $gatewayState.set('connecting')
          setTimeout(() => $gatewayState.set('open'), 5)
        }, 5)

        throw new Error('Hermes gateway connection closed')
      }

      applied.push(String(params.value))

      return {}
    }
  } as never)
  $gatewayState.set('open')

  await vi.waitFor(() => expect($inftSwitch.get().phase).toBe('done'), { timeout: 5_000 })

  // The agent path for the iNFT now on the home: acp-setup's real call through main's door.
  const acp = await runAcp($activeInft.get()!.id, ['whoami', '--json'])

  return { acp, acpRuns, active: $activeInft.get(), applied, switchLines, state: $inftSwitch.get() }
}

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('MR3-1: the reopen-with-iNFT path is provable before release (dev/test fixture builtin:reopen)', () => {
  it(`${REOPENS} reopens: each one connects the iNFT by itself — model on stage, persona applied, acp-run admitted`, async () => {
    const fixture = resolveFixtureWallet('builtin:reopen', false)!
    const markers: string[] = []

    window.localStorage.clear()
    backend.profiles.clear()
    backend.personalities.clear()
    // The owner's one earlier choice, as the app itself stores it: Aurora checked for Home in the iNFT Book and summoned
    // once (the dev loop primes a throwaway profile the same way: v009-r3b-fix-done.md).
    window.localStorage.setItem(
      'iclone.inftBook.checked.v1',
      JSON.stringify({ [fixture.address.toLowerCase()]: { ids: [AURORA_ID], kept: null } })
    )
    window.localStorage.setItem('iclone.stage.lastInft', AURORA_ID)

    for (let cycle = 0; cycle < REOPENS; cycle += 1) {
      const run = await reopen(fixture, cycle)

      // The stage: the fixture model is summoned (Stage3D and the "Open in new window" menu render from this).
      expect(run.active).toEqual({ id: AURORA_ID, name: 'iCLONE Aurora', modelUrl: FIXTURE_MODEL_URL })
      // The persona: the iNFT's own, applied on the agent that came up (after a replaced socket on odd cycles).
      expect(run.state).toMatchObject({ phase: 'done', slug: AURORA_SLUG })
      expect(run.applied).toEqual([AURORA_SLUG])
      expect(backend.personalities.get(AURORA_SLUG)).toContain('# iCLONE Aurora')
      // The agent path: main's acp-run door admits the iNFT this launch's own scan returned.
      expect(run.acp.ok).toBe(true)
      expect(run.acpRuns).toEqual([{ argv: ['whoami', '--json'], inftId: AURORA_ID, refused: null }])
      // The marker the dev reopen loop counts, made by main's real formatter from the real switch line.
      const marker = run.switchLines.map(line => fixtureSwitchLogLine(fixture, line)).find(Boolean)

      expect(marker).toMatch(/^\[fixture\] inft connected inft-000000-101 \(\d+ ms/)
      markers.push(marker!)
    }

    expect(markers).toHaveLength(REOPENS)
    // Built once (first launch), then read back from the backend on every later reopen: never rebuilt over.
    expect(backend.profiles.get(AURORA_SLUG)).toContain('# iCLONE Aurora')
  }, 120_000)

  it('the same launch with builtin:grid (no model, no soul) connects nothing: that is why grid cannot prove F2', async () => {
    const grid = resolveFixtureWallet('builtin:grid', false)!

    expect(fixtureScanResult(grid, 0).agents.some(agent => agent.model || agent.bootstrap)).toBe(false)
    expect(fixtureProfile(grid, { contract: '0x000000000000000000000000000000000000c10e', tokenId: '101' }, 's')).toBeNull()
  })
})
