// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfirmHost } from '@/components/confirm-host'
import { $settingsRequestProfile } from '@/store/settings-scope'
import type { MessagingPlatformInfo } from '@/types/hermes'

import { draftKey, ENV_DRAFTS_KEY } from './env-draft'

const getMessagingPlatforms = vi.fn()
const updateMessagingPlatform = vi.fn()
const getPairing = vi.fn()
const approvePairing = vi.fn()
const revokePairing = vi.fn()
const openExternalLink = vi.fn()

vi.mock('@/hermes', () => ({
  approvePairing: (platformId: string, requestId: string, profile?: null | string) =>
    approvePairing(platformId, requestId, profile),
  getMessagingPlatforms: (profile?: null | string) => getMessagingPlatforms(profile),
  getPairing: (profile?: null | string) => getPairing(profile),
  getProfiles: vi.fn(async () => ({ profiles: [] })),
  revokePairing: (platformId: string, userId: string, profile?: null | string) =>
    revokePairing(platformId, userId, profile),
  setApiRequestProfile: vi.fn(),
  updateMessagingPlatform: (id: string, body: unknown, profile?: null | string) =>
    updateMessagingPlatform(id, body, profile)
}))

// Keep store/profile's side-effecting imports inert (pulled in via the shared
// settings scope store) — same seam as store/profile.test.ts.
vi.mock('@/store/gateway', () => ({
  $gateway: { get: () => null, subscribe: () => () => {} },
  ensureGatewayForAgent: vi.fn(async () => undefined),
  ensureGatewayForProfile: vi.fn(async () => undefined),
  openGatewayForProfile: vi.fn(async () => undefined)
}))
vi.mock('@/lib/query-client', () => ({ invalidateProfileScopedQueries: vi.fn() }))
vi.mock('@/store/starmap', () => ({ resetStarmapGraph: vi.fn() }))

vi.mock('@/lib/external-link', () => ({
  openExternalLink: (href: string) => openExternalLink(href)
}))

vi.mock('@/store/notifications', () => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

vi.mock('@/store/system-actions', () => ({
  runGatewayRestart: vi.fn()
}))

function platform(patch: Partial<MessagingPlatformInfo> = {}): MessagingPlatformInfo {
  return {
    configured: false,
    description: 'A platform.',
    docs_url: '',
    enabled: false,
    env_vars: [],
    gateway_running: true,
    id: 'teams',
    name: 'Microsoft Teams',
    state: 'disabled',
    ...patch
  }
}

beforeEach(() => {
  updateMessagingPlatform.mockResolvedValue({ ok: true, platform: 'teams' })
  getPairing.mockResolvedValue({ approved: [], pending: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function renderMessaging() {
  const { MessagingView } = await import('./index')
  let result: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <MemoryRouter>
        <MessagingView />
      </MemoryRouter>
    )
  })

  return result!
}

describe('MessagingView profile scope', () => {
  it('follows the active profile instead of targeting primary when there is no override', async () => {
    const { $settingsScopeOverride } = await import('@/store/settings-scope')

    $settingsScopeOverride.set(null)
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform()] })

    await renderMessaging()

    await waitFor(() => expect(getMessagingPlatforms).toHaveBeenCalledWith(undefined))
    expect(getPairing).toHaveBeenCalledWith(undefined)
  })
})

describe('MessagingView setup-guide link', () => {
  it('hides the setup-guide button for a plugin platform with no docs URL', async () => {
    // Teams (and other plugin platforms) ship an empty docs_url. Rendering an
    // anchor with href="" let Electron resolve it to the app's own packaged
    // index.html and fail with an OS "file not found" dialog. The button must
    // simply not appear when there is no guide to open.
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform({ docs_url: '' })] })

    await renderMessaging()

    expect((await screen.findAllByText('Microsoft Teams')).length).toBeGreaterThan(0)
    expect(screen.queryByText('Open setup guide')).toBeNull()
  })

  it('stacks the detail sections in one column that never shrinks, headed by plain sentences', async () => {
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform({ docs_url: '' })] })

    await renderMessaging()

    const label = await screen.findByText('Get your sign-in details')
    const column = label.closest('[data-messaging-detail]') as HTMLElement
    // At large text a shrinking section painted its note over the next one (I-A r1 critic, M3).
    expect(column.className).toContain('shrink-0')
    expect(column.className).toContain('normal-case')
    expect(screen.getByText('What it needs to connect')).toBeTruthy()
    expect(window.document.body.textContent).not.toMatch(/gateway/i)
  })

  it('opens a real docs URL through the validated external opener', async () => {
    const docsUrl = 'https://hermes-agent.nousresearch.com/docs/user-guide/messaging/teams'
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform({ docs_url: docsUrl })] })

    await renderMessaging()

    const link = await screen.findByText('Open setup guide')
    await act(async () => {
      fireEvent.click(link)
    })

    await waitFor(() => expect(openExternalLink).toHaveBeenCalledWith(docsUrl))
  })
})

describe('MessagingView pairing', () => {
  const pendingUser = {
    age_minutes: 3,
    platform: 'teams',
    request_id: 'a1b2c3d4e5f60718',
    user_id: '7712345',
    user_name: 'Bee'
  }

  it('approves the listed request by its request id, never by a code', async () => {
    // The whole point of the request-id grant path: the UI can only ever send
    // the server-side row id, because the one-time code is never returned by
    // the API. Posting anything derived from the code could not be approved.
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform()] })
    getPairing.mockResolvedValue({ approved: [], pending: [pendingUser] })
    approvePairing.mockResolvedValue({ ok: true, user: { user_id: '7712345', user_name: 'Bee' } })

    await renderMessaging()

    const approve = await screen.findByRole('button', { name: 'Approve' })
    await act(async () => {
      fireEvent.click(approve)
    })

    await waitFor(() => expect(approvePairing).toHaveBeenCalledWith('teams', 'a1b2c3d4e5f60718', undefined))
  })

  it('restores the pending row when approval fails', async () => {
    // Optimistic removal must not silently swallow the request: a failed
    // approve has to leave the operator something to retry.
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform()] })
    getPairing.mockResolvedValue({ approved: [], pending: [pendingUser] })
    approvePairing.mockRejectedValue(new Error('500 boom'))

    await renderMessaging()

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    })

    expect(await screen.findByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.getByText('Bee')).toBeTruthy()
  })

  it('shows no pairing affordance when nobody is waiting', async () => {
    // Approvals are rare; an always-present empty state would be permanent
    // chrome on a page that is otherwise about credentials.
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform()] })
    getPairing.mockResolvedValue({ approved: [], pending: [] })

    await renderMessaging()

    expect((await screen.findAllByText('Microsoft Teams')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByText(/Pending requests/)).toBeNull()
  })

  it('still renders platforms when the pairing endpoint fails', async () => {
    // An older backend without the endpoint must not blank the page.
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform()] })
    getPairing.mockRejectedValue(new Error('404 not found'))

    await renderMessaging()

    expect((await screen.findAllByText('Microsoft Teams')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  it('refetches pending rows on pairing.changed, not on platforms.changed', async () => {
    // The two signals are not interchangeable: platforms.changed tracks
    // connect/disconnect health via gateway_state.json, which a new pairing
    // request never moves. Riding it would leave someone invisible in the
    // pending list until an unrelated reconnect happened to fire.
    const { $changeEventsAvailable, $pairingChangeTick, $platformsChangeTick } = await import('@/store/live-sync')

    getMessagingPlatforms.mockResolvedValue({ platforms: [platform()] })
    getPairing.mockResolvedValue({ approved: [], pending: [] })

    await renderMessaging()
    await act(async () => {
      $changeEventsAvailable.set(true)
    })
    getPairing.mockClear()

    // Someone DMs the bot: the store moves, the watcher ticks pairing.changed.
    getPairing.mockResolvedValue({ approved: [], pending: [pendingUser] })
    await act(async () => {
      $pairingChangeTick.set($pairingChangeTick.get() + 1)
    })

    await waitFor(() => expect(getPairing).toHaveBeenCalled())
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeTruthy()

    // A platform health tick alone must not be what fetches pairing.
    getPairing.mockClear()
    await act(async () => {
      $platformsChangeTick.set($platformsChangeTick.get() + 1)
    })
    expect(getPairing).not.toHaveBeenCalled()
  })
})

describe('MessagingView bot token removal', () => {
  const token = {
    advanced: false,
    description: 'Bot token',
    is_password: true,
    is_set: true,
    key: 'TEAMS_BOT_TOKEN',
    prompt: 'Token',
    redacted_value: 'abcd…wxyz',
    required: true,
    url: null
  }

  async function renderWithConfirm() {
    const { MessagingView } = await import('./index')
    await act(async () => {
      render(
        <MemoryRouter>
          <MessagingView />
          <ConfirmHost />
        </MemoryRouter>
      )
    })
  }

  beforeEach(() => {
    window.localStorage.clear()
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform({ env_vars: [token] })] })
  })

  afterEach(async () => {
    const { $confirmRequest } = await import('@/store/confirm')
    $confirmRequest.set(null)
  })

  it('asks before clearing a set bot token, then clears it and audits the key name only', async () => {
    await renderWithConfirm()

    fireEvent.click(await screen.findByRole('button', { name: 'Clear TEAMS_BOT_TOKEN' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove TEAMS_BOT_TOKEN?' })
    expect(updateMessagingPlatform).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    })

    await waitFor(() => expect(updateMessagingPlatform).toHaveBeenCalled())
    expect(updateMessagingPlatform.mock.calls[0].slice(0, 2)).toEqual(['teams', { clear_env: ['TEAMS_BOT_TOKEN'] }])

    const { readCredentialAudit } = await import('@/lib/credential-audit')
    const audit = readCredentialAudit()
    expect(audit[0]).toMatchObject({
      id: 'TEAMS_BOT_TOKEN',
      kind: 'bot_token',
      result: 'removed',
      surface: 'messaging'
    })
    expect(JSON.stringify(audit)).not.toContain('abcd')
  })

  it('leaves the token untouched when the confirm is dismissed', async () => {
    await renderWithConfirm()

    fireEvent.click(await screen.findByRole('button', { name: 'Clear TEAMS_BOT_TOKEN' }))
    const dialog = await screen.findByRole('dialog')

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    })

    expect(updateMessagingPlatform).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Clear TEAMS_BOT_TOKEN' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('MessagingView copy that has to be true', () => {
  const secret = {
    advanced: false,
    description: 'Bot token',
    is_password: true,
    is_set: false,
    key: 'TEAMS_CLIENT_SECRET',
    prompt: 'Token',
    redacted_value: null,
    required: true,
    url: null
  }

  const plain = {
    ...secret,
    description: 'Who may DM',
    is_password: false,
    key: 'TEAMS_ALLOWED_USERS',
    prompt: 'People allowed to talk to it'
  }

  beforeEach(() => {
    window.localStorage.clear()
  })

  // What a reload gives the page back: the stored draft for one platform. The
  // page reads this at mount, and ONLY these slots may raise the notice below
  // (critic r3, E3d2-M1).
  const seedDraft = (fields: Record<string, string>, platformId = 'teams') =>
    window.localStorage.setItem(
      ENV_DRAFTS_KEY,
      JSON.stringify({ [draftKey($settingsRequestProfile.get(), platformId)]: { at: Date.now(), fields } })
    )

  // What a reload gives back to the user who typed ONLY the token: the slot,
  // with no values at all — just the dropped key's NAME (critic r4, E3d2-M3).
  const seedSecretOnlyDraft = (droppedSecrets: string[], platformId = 'teams') =>
    window.localStorage.setItem(
      ENV_DRAFTS_KEY,
      JSON.stringify({
        [draftKey($settingsRequestProfile.get(), platformId)]: { at: Date.now(), droppedSecrets, fields: {} }
      })
    )

  it('says nothing matched, instead of telling the user to try what they just typed', async () => {
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform()] })

    await renderMessaging()

    const search = await screen.findByPlaceholderText('Search messaging...')
    await act(async () => {
      fireEvent.change(search, { target: { value: 'zzz-no-such-platform' } })
    })

    expect(await screen.findByText('No platform matches “zzz-no-such-platform”')).toBeTruthy()
    // `common.tryHint` renders "Try <the query>", which is the opposite of
    // what happened (critic r2, E3d2-T3).
    expect(screen.queryByText(/^Try /)).toBeNull()
  })

  it('names the empty field by its own label, never the env id, when a draft came back without the secret', async () => {
    seedDraft({ TEAMS_ALLOWED_USERS: 'pat' })
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform({ env_vars: [secret, plain] })] })

    await renderMessaging()

    const notice = await screen.findByText(/Not set/)

    expect(notice.textContent).toContain('Client secret')
    expect(notice.textContent).not.toContain('TEAMS_CLIENT_SECRET')
    expect(notice.textContent).not.toContain('Unsaved changes')
    // It appears on its own after a reload, so it has to be announced.
    expect(notice.getAttribute('aria-live')).toBe('polite')
    // ...and what the draft DID keep really came back.
    expect((await screen.findByLabelText<HTMLInputElement>('Choose who may talk to your agent')).value).toBe('pat')
  })

  it('stays quiet for a first-time user who types into a fresh form and has lost nothing', async () => {
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform({ env_vars: [secret, plain] })] })

    await renderMessaging()

    await act(async () => {
      fireEvent.change(await screen.findByLabelText('Choose who may talk to your agent'), { target: { value: 'pat' } })
    })

    // No draft came back, so nothing was dropped: "the user typed something"
    // is not the question (critic r3, E3d2-M1).
    expect(screen.queryByText(/Not set/)).toBeNull()
  })

  it('a draft where ONLY the token was typed comes back as a notice, not as silence', async () => {
    seedSecretOnlyDraft(['TEAMS_CLIENT_SECRET'])
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform({ env_vars: [secret, plain] })] })

    await renderMessaging()

    const notice = await screen.findByText(/Not set/)

    // The commonest real loss: paste the bot token, reload, and the page used
    // to say nothing because no row was kept at all (critic r4, E3d2-M3).
    expect(notice.textContent).toContain('Not kept in the draft')
    expect(notice.textContent).toContain('Client secret')
    // A marker row restores no values, so the rest of the form stays empty.
    expect((await screen.findByLabelText<HTMLInputElement>('Choose who may talk to your agent')).value).toBe('')
  })

  it('tells the user when a retyped token the backend already holds was the field that got dropped', async () => {
    seedDraft({ TEAMS_ALLOWED_USERS: 'pat' })
    getMessagingPlatforms.mockResolvedValue({
      platforms: [platform({ env_vars: [{ ...secret, is_set: true, redacted_value: 'abcd…' }, plain] })]
    })

    await renderMessaging()

    const notice = await screen.findByText(/Replace current value/)

    expect(notice.textContent).toContain('Client secret')
    expect(notice.textContent).not.toContain('TEAMS_CLIENT_SECRET')
    // The field on screen is empty: the retyped value is gone, the saved one
    // still stands — that is exactly what the line has to say.
    expect((await screen.findByLabelText<HTMLInputElement>('Paste the client secret of your Teams app')).value).toBe('')
  })

  it('drops the notice once the secret is typed, because then it has a value on screen', async () => {
    seedDraft({ TEAMS_ALLOWED_USERS: 'pat' })
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform({ env_vars: [secret, plain] })] })

    await renderMessaging()

    await screen.findByText(/Not set/)

    await act(async () => {
      fireEvent.change(await screen.findByLabelText('Paste the client secret of your Teams app'), {
        target: { value: 'typed-now' }
      })
    })

    expect(screen.queryByText(/Not set/)).toBeNull()
  })
})

describe('MessagingView states the target names', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('fails inline with a retry that refetches, instead of a toast over a spinner', async () => {
    getMessagingPlatforms.mockRejectedValue(new Error('gateway unreachable'))

    await renderMessaging()

    expect(await screen.findByText('Messaging platforms failed to load')).toBeTruthy()
    expect(screen.getByText('gateway unreachable')).toBeTruthy()

    const before = getMessagingPlatforms.mock.calls.length

    getMessagingPlatforms.mockResolvedValue({ platforms: [platform()] })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })

    expect(getMessagingPlatforms.mock.calls.length).toBeGreaterThan(before)
    // The rail (with its search box) only exists in the ready branch.
    expect(await screen.findByPlaceholderText('Search messaging...')).toBeTruthy()
    expect(screen.queryByText('Messaging platforms failed to load')).toBeNull()
  })

  it('reads an empty list as empty, without asserting a cause it cannot know', async () => {
    getMessagingPlatforms.mockResolvedValue({ platforms: [] })

    await renderMessaging()

    expect(await screen.findByText('No messaging platforms found')).toBeTruthy()
    // The page cannot know WHY the list is empty (critic r3, E3d2-M2).
    expect(screen.queryByText('Messaging service stopped')).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })
})
