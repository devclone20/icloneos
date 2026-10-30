import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type * as Nanostores from 'nanostores'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { deleteProfile, updateProfileSoul } from '@/hermes'
import { en } from '@/i18n/en'
import { retireLocalProfileGateways } from '@/store/gateway'
import { refreshProfiles, selectProfile, setActiveProfile } from '@/store/profile'
import type { ProfileInfo } from '@/types/hermes'

import { SOUL_DRAFTS_KEY } from './soul-draft'

import { ProfilesView } from './index'

// These tests pin the invariant this whole area exists to hold: the Manage
// Profiles page and the sidebar rail share ONE set of profile dialogs, so both
// "New Profile" entry points render the same modal (SOUL.md included), and
// deleting the profile the gateway is on re-homes to default instead of
// stranding it on a dead backend. The drift that motivated the fix got in
// precisely because nothing rendered this view.

afterEach(() => {
  cleanup()
  globalThis.localStorage.clear()
})

// Real i18n (useI18n falls back to English with no provider), so labels are the
// actual strings — no brittle key snapshot to maintain here.

vi.mock('@/hermes', () => ({
  createProfile: vi.fn(async () => ({ name: 'x', ok: true, path: '/x' })),
  deleteProfile: vi.fn(async () => ({ ok: true, path: '/x' })),
  getProfileSoul: vi.fn(async () => ({ content: '', exists: true })),
  renameProfile: vi.fn(async () => ({ name: 'x', ok: true, path: '/x' })),
  updateProfileSoul: vi.fn(async () => ({ ok: true }))
}))

vi.mock('@/store/notifications', () => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

vi.mock('@/store/gateway', () => ({
  retireLocalProfileGateways: vi.fn()
}))

const { $activeGatewayProfile: activeGateway, $profileColors } = vi.hoisted(() => {
  const { atom } = require('nanostores') as typeof Nanostores

  return {
    $activeGatewayProfile: atom<string>('default'),
    $profileColors: atom<Record<string, string>>({})
  }
})

vi.mock('@/store/profile', () => ({
  $activeGatewayProfile: activeGateway,
  $profileColors,
  normalizeProfileKey: (name: null | string | undefined) => (name ?? '').trim() || 'default',
  profileLabel: (profile: { display_name?: string; name: string }) =>
    (profile.display_name ?? '').trim() || profile.name,
  refreshProfiles: vi.fn(async () => [] as ProfileInfo[]),
  selectProfile: vi.fn(),
  setActiveProfile: vi.fn()
}))

// The one non-default profile these tests act on. Its name doubles as the row's
// accessible name, so the delete helper queries by it rather than a literal.
const NAMED_PROFILE = 'work'

function makeProfile(name: string, isDefault = false): ProfileInfo {
  return {
    has_env: false,
    is_default: isDefault,
    model: null,
    name,
    path: `/home/user/.hermes/profiles/${name}`,
    provider: null,
    skill_count: 0
  }
}

// Radix's trigger opens on the pointerdown/up pair, not the synthetic click
// alone — fire the full sequence a real click produces.
function realClick(el: HTMLElement) {
  fireEvent.pointerDown(el, { button: 0, pointerType: 'mouse' })
  fireEvent.pointerUp(el, { button: 0, pointerType: 'mouse' })
  fireEvent.click(el)
}

// ProfilesView loads its list in a mount effect (refreshProfiles → setProfiles),
// so the first paint is the loader and the rows commit a microtask later. Flush
// that inside act() so the rows exist before anything queries them, and so the
// mount setState isn't left unwrapped.
async function renderProfilesView() {
  await act(async () => {
    render(<ProfilesView />)
  })
}

// Our row carries its own rename/delete buttons (no kebab): each is labelled
// "<verb> <profile>", so one query reaches exactly one control. The confirm
// click starts an async chain (deleteProfile, the onDeleted refresh, the
// re-home writes), so settle it inside act() to flush those updates
// deterministically instead of leaking them past the assertions.
async function deleteTheNamedProfile() {
  fireEvent.click(await screen.findByRole('button', { name: `Delete ${NAMED_PROFILE}` }))
  const confirm = await screen.findByRole('button', { name: 'Delete' })
  await act(async () => {
    fireEvent.click(confirm)
  })
}

describe('ProfilesView', () => {
  it('opens the shared create dialog with the SOUL.md field (parity with the rail)', async () => {
    vi.mocked(refreshProfiles).mockResolvedValue([])

    await renderProfilesView()

    realClick(await screen.findByRole('button', { name: 'New profile' }))

    const soul = await screen.findByLabelText(/Character/i)

    expect(soul.tagName).toBe('TEXTAREA')
    expect(soul.getAttribute('id')).toBe('new-profile-soul')
  })

  it('re-homes to default when the active profile is deleted', async () => {
    const deleteProfileMock = vi.mocked(deleteProfile)
    const retireLocalProfileGatewaysMock = vi.mocked(retireLocalProfileGateways)

    deleteProfileMock.mockClear()
    retireLocalProfileGatewaysMock.mockClear()
    vi.mocked(refreshProfiles).mockResolvedValue([makeProfile('default', true), makeProfile(NAMED_PROFILE)])
    activeGateway.set(NAMED_PROFILE)

    await renderProfilesView()
    await deleteTheNamedProfile()

    await waitFor(() => expect(deleteProfile).toHaveBeenCalledWith(NAMED_PROFILE))
    expect(retireLocalProfileGateways).toHaveBeenCalledWith(NAMED_PROFILE)
    expect(retireLocalProfileGatewaysMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteProfileMock.mock.invocationCallOrder[0]
    )
    await waitFor(() => expect(selectProfile).toHaveBeenCalledWith('default'))
    expect(setActiveProfile).toHaveBeenCalledWith('default')
  })

  it('leaves the active profile alone when a different profile is deleted', async () => {
    vi.mocked(selectProfile).mockClear()
    vi.mocked(setActiveProfile).mockClear()
    vi.mocked(refreshProfiles).mockResolvedValue([makeProfile('default', true), makeProfile(NAMED_PROFILE)])
    activeGateway.set('default')

    await renderProfilesView()
    await deleteTheNamedProfile()

    await waitFor(() => expect(deleteProfile).toHaveBeenCalledWith(NAMED_PROFILE))
    // The dialog closes once the delete settles; a non-active delete must not re-home.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull())
    expect(selectProfile).not.toHaveBeenCalled()
    expect(setActiveProfile).not.toHaveBeenCalled()
  })
  it('a list that fails to load is an error with a way out, not an endless spinner', async () => {
    vi.mocked(refreshProfiles).mockRejectedValueOnce(new Error('gateway down'))

    await renderProfilesView()

    const alert = await screen.findByRole('alert')

    expect(alert.textContent).toContain('gateway down')

    vi.mocked(refreshProfiles).mockResolvedValue([makeProfile('default', true)])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })

    expect(screen.queryByRole('alert')).toBeNull()
    expect(await screen.findByRole('button', { name: 'default' })).toBeTruthy()
  })

  it('the search field narrows the rail to the matching profiles', async () => {
    vi.mocked(refreshProfiles).mockResolvedValue([makeProfile('default', true), makeProfile(NAMED_PROFILE)])

    await renderProfilesView()

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: NAMED_PROFILE } })

    expect(screen.getByRole('button', { name: NAMED_PROFILE })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^default/ })).toBeNull()
  })

  it('keeps what was typed into SOUL.md across a reload of the page', async () => {
    vi.mocked(refreshProfiles).mockResolvedValue([makeProfile('default', true)])

    await renderProfilesView()

    const editor = await screen.findByLabelText('Character')

    fireEvent.change(editor, { target: { value: 'you are mine' } })

    expect((await screen.findByRole<HTMLButtonElement>('button', { name: 'Save the character' })).disabled).toBe(false)

    // The reload: this mount is gone, state with it, and the next one must come
    // back with the user's text instead of the empty file.
    cleanup()
    await renderProfilesView()

    const reloaded = await screen.findByLabelText('Character')

    expect((reloaded as HTMLTextAreaElement).value).toBe('you are mine')
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save the character' }).disabled).toBe(false)
  })

  // The page has exactly ONE home: the Profiles topic inside Settings (front
  // K3). The Settings shell draws the card and owns Esc and the ✕, so a second
  // frame and a second close control would be two windows deep — and the page's
  // own ✕ would close nothing a user asked to close. There is no prop left to
  // put it back in a floating card: that is what keeps the surface INSIDE
  // Settings rather than reachable by leaving it.
  it('draws no card and no close control of its own, in its only mode', async () => {
    vi.mocked(refreshProfiles).mockResolvedValue([makeProfile('default', true)])

    await renderProfilesView()

    const page = await screen.findByRole('region', { name: 'Profiles' })

    expect(page.className).toBe('icpg')
    expect(page.closest('.icpg-overlay')).toBeNull()
    expect(screen.queryByRole('button', { name: en.profiles.close })).toBeNull()
    expect(ProfilesView).toHaveLength(0)
  })

  it('a saved SOUL.md leaves no draft behind', async () => {
    vi.mocked(refreshProfiles).mockResolvedValue([makeProfile('default', true)])

    await renderProfilesView()

    fireEvent.change(await screen.findByLabelText('Character'), { target: { value: 'saved text' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save the character' }))
    })

    expect(vi.mocked(updateProfileSoul)).toHaveBeenCalledWith('default', 'saved text')
    expect(globalThis.localStorage.getItem(SOUL_DRAFTS_KEY)).toBeNull()
    expect(screen.queryByText('Unsaved changes')).toBeNull()
  })
})
