import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesModule from '@/hermes'
import { getSession } from '@/hermes'
import { type ChatMessage, preserveLocalAssistantErrors } from '@/lib/chat-messages'
import { $activeGatewayProfile, $profiles } from '@/store/profile'
import { $cronSessions, $messagingSessions, $sessions } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

import { resolveSessionProfile, resolveStoredSession } from './utils'

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<typeof HermesModule>()),
  getSession: vi.fn()
}))

const mockGetSession = vi.mocked(getSession)

const session = (over: Partial<SessionInfo>): SessionInfo => over as SessionInfo

const profiles = (...names: string[]) => names.map(name => ({ name }) as never)

describe('resolveStoredSession profile ownership', () => {
  beforeEach(() => {
    $cronSessions.set([])
    $messagingSessions.set([])
    $sessions.set([])
    $profiles.set(profiles('default', 'meta'))
    $activeGatewayProfile.set('meta')
    mockGetSession.mockReset()
  })

  afterEach(() => {
    $cronSessions.set([])
    $messagingSessions.set([])
    $sessions.set([])
    $profiles.set([])
    $activeGatewayProfile.set('default')
  })

  it('returns a cached row that carries an owning profile', async () => {
    $sessions.set([session({ id: 's1', profile: 'default' })])

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('default')
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it.each([
    ['cron', $cronSessions],
    ['messaging', $messagingSessions]
  ])('resolves a %s sidebar row without duplicating it into regular sessions', async (_source, store) => {
    store.set([session({ id: 's1', profile: 'default' })])

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('default')
    expect(mockGetSession).not.toHaveBeenCalled()
    expect($sessions.get()).toEqual([])
  })

  it('treats a profile-less cache hit as unresolved when multiple profiles exist', async () => {
    $sessions.set([session({ id: 's1' })])
    mockGetSession.mockRejectedValueOnce(new Error('404: Session not found'))
    mockGetSession.mockResolvedValueOnce(session({ id: 's1', profile: 'default' }))

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('default')
    // rung 2 (active profile) then rung 3 (stamped cross-profile probe)
    expect(mockGetSession).toHaveBeenNthCalledWith(1, 's1', 'meta')
    expect(mockGetSession).toHaveBeenNthCalledWith(2, 's1', 'default')
  })

  it('scopes the first by-id lookup so a miss does not skip the active profile', async () => {
    $activeGatewayProfile.set('brain')
    $profiles.set(profiles('default', 'brain'))
    mockGetSession.mockImplementation(async (id, profile) => {
      if (profile === 'brain') {
        return session({ id, profile: 'brain' })
      }

      throw new Error('404: Session not found')
    })

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('brain')
    expect(mockGetSession).toHaveBeenCalledWith('s1', 'brain')
    expect(mockGetSession).not.toHaveBeenCalledWith('s1')
    expect(mockGetSession).not.toHaveBeenCalledWith('s1', 'default')
  })

  it('accepts a profile-less cache hit for single-profile users', async () => {
    $profiles.set(profiles('default'))
    $sessions.set([session({ id: 's1' })])

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.id).toBe('s1')
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it('stamps the active profile on a bare by-id hit from an older backend', async () => {
    mockGetSession.mockResolvedValueOnce(session({ id: 's1' }))

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('meta')
    expect(mockGetSession).toHaveBeenCalledWith('s1', 'meta')
    // the upserted cache row is owned too, so the next hit short-circuits
    expect($sessions.get().find(s => s.id === 's1')?.profile).toBe('meta')
  })

  it('probed desktop profile overrides a remote backend answering as its own "default"', async () => {
    // Per-profile remote override: Electron strips the desktop alias before
    // forwarding, so the standalone backend stamps its backend-local root.
    mockGetSession.mockRejectedValueOnce(new Error('404: Session not found'))
    mockGetSession.mockResolvedValueOnce(session({ id: 's1', profile: 'default' }))
    $activeGatewayProfile.set('default')
    $profiles.set(profiles('default', 'meta'))

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('meta')
    expect($sessions.get().find(s => s.id === 's1')?.profile).toBe('meta')
  })

  it('stamps the probed profile on a scoped hit from an older backend that omits it', async () => {
    mockGetSession.mockRejectedValueOnce(new Error('404: Session not found'))
    mockGetSession.mockResolvedValueOnce(session({ id: 's1' }))

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('default')
    // the cached row is owned too — no unowned row is ever re-cached
    expect($sessions.get().find(s => s.id === 's1')?.profile).toBe('default')
  })

  it('never probes an iNFT profile (a soul store, not a backend) in the cross-profile search', async () => {
    mockGetSession.mockRejectedValue(new Error('404: Session not found'))
    $activeGatewayProfile.set('default')
    $profiles.set(profiles('default', 'inft-4dfb27-6', 'meta', 'inft-4dfb27-7'))

    expect(await resolveStoredSession('s1')).toBeUndefined()
    expect(mockGetSession.mock.calls.map(call => call[1])).toEqual(['default', 'meta'])
  })

  it('resolveSessionProfile routes a default-profile session from a non-default gateway', async () => {
    mockGetSession.mockRejectedValueOnce(new Error('404: Session not found'))
    mockGetSession.mockResolvedValueOnce(session({ id: 's1', profile: 'default' }))

    await expect(resolveSessionProfile('s1')).resolves.toBe('default')
  })
})

// v0.0.9 e2e b2: the single-session answer (GET /api/sessions/{id}) has no list-only fields such as `preview`.
// Upserting it must merge over the list row it replaces, never drop what the answer does not carry.
describe('resolveStoredSession keeps list-only fields on upsert', () => {
  beforeEach(() => {
    $cronSessions.set([])
    $messagingSessions.set([])
    $profiles.set(profiles('default', 'meta'))
    $activeGatewayProfile.set('meta')
    mockGetSession.mockReset()
    // A profile-less row with more than one profile is unresolved, so the by-id answer is fetched and upserted.
    $sessions.set([session({ id: 's1', pinned: true, preview: 'first ask, as the list shows it', title: 'old title' })])
  })

  afterEach(() => {
    $sessions.set([])
    $profiles.set([])
    $activeGatewayProfile.set('default')
  })

  it("keeps the row's preview when the resolved session carries none", async () => {
    mockGetSession.mockResolvedValueOnce(session({ id: 's1', profile: 'meta', title: 'kept title' }))

    await resolveStoredSession('s1')

    expect($sessions.get()).toHaveLength(1)
    const row = $sessions.get()[0]
    expect(row.preview).toBe('first ask, as the list shows it')
    expect(row.pinned).toBe(true)
    // What the answer does carry still wins.
    expect(row.title).toBe('kept title')
    expect(row.profile).toBe('meta')
  })

  it('takes an explicit new preview from the resolved session', async () => {
    mockGetSession.mockResolvedValueOnce(session({ id: 's1', preview: 'fresh preview', profile: 'meta' }))

    await resolveStoredSession('s1')

    expect($sessions.get()).toHaveLength(1)
    expect($sessions.get()[0].preview).toBe('fresh preview')
  })
})

// v0.0.9 G 868394f2dd: b2's upsert merge (the row keeps its list preview) and r4's localNotice (the desktop's own
// system line survives a transcript refresh) landed together. Both must hold through one reload-shaped sequence:
// the by-id upsert, then a transcript refresh from the stored rows.
describe('a refresh after an upsert keeps both the row preview and a local notice', () => {
  beforeEach(() => {
    $cronSessions.set([])
    $messagingSessions.set([])
    $profiles.set(profiles('default', 'meta'))
    $activeGatewayProfile.set('meta')
    mockGetSession.mockReset()
    $sessions.set([session({ id: 's1', preview: 'first ask, as the list shows it', title: 'old title' })])
  })

  afterEach(() => {
    $sessions.set([])
    $profiles.set([])
    $activeGatewayProfile.set('default')
  })

  it('keeps the preview on the upserted row and the notice in the refreshed transcript', async () => {
    mockGetSession.mockResolvedValueOnce(session({ id: 's1', profile: 'meta', title: 'kept title' }))

    await resolveStoredSession('s1')

    const user: ChatMessage = { id: 'stored-user', parts: [{ text: 'ask', type: 'text' }], role: 'user' }
    const reply: ChatMessage = { id: 'stored-reply', parts: [{ text: 'Hello.', type: 'text' }], role: 'assistant' }

    const notice: ChatMessage = {
      id: 'system-1',
      localNotice: true,
      parts: [{ text: '/compress · error: session busy', type: 'text' }],
      role: 'system'
    }

    const refreshed = preserveLocalAssistantErrors([user, reply], [user, reply, notice])

    expect($sessions.get()).toHaveLength(1)
    expect($sessions.get()[0]).toMatchObject({ preview: 'first ask, as the list shows it', title: 'kept title' })
    expect(refreshed.map(message => message.id)).toEqual(['stored-user', 'stored-reply', 'system-1'])
  })
})
