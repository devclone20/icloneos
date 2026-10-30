import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stubResizeObserver } from '@/test/jsdom'

import { envVar } from './test-utils'

const getEnvVars = vi.fn()

stubResizeObserver()

const deleteEnvVar = vi.fn()
const getGlobalModelOptions = vi.fn()

vi.mock('@/hermes', () => ({
  deleteEnvVar: (key: string, profile?: string) => deleteEnvVar(key, profile),
  getGlobalModelOptions: (_request?: unknown, profile?: string) => getGlobalModelOptions(_request, profile),
  getEnvVars: (profile?: null | string) => getEnvVars(profile),
  revealEnvVar: vi.fn(),
  setApiRequestProfile: () => undefined,
  setEnvVar: vi.fn()
}))

beforeEach(() => {
  getEnvVars.mockResolvedValue({})
  getGlobalModelOptions.mockResolvedValue({ providers: [] })
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn()
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function renderKeysSettings(view: 'settings' | 'tools', route = '/settings') {
  const { KeysSettings } = await import('./keys-settings')

  await act(async () => {
    render(
      <MemoryRouter initialEntries={[route]}>
        <KeysSettings view={view} />
      </MemoryRouter>
    )
  })
}

function DeepLinkButton({ target }: { target: string }) {
  const navigate = useNavigate()

  return (
    <button onClick={() => navigate(`/settings?tab=keys&key=${target}`)} type="button">
      Open key
    </button>
  )
}

describe('KeysSettings', () => {
  it('fetches env vars for the active profile (undefined, never null) when unscoped', async () => {
    // #90549 class: getEnvVars(null) targets the primary profile's env store,
    // so a non-default profile's Keys page would read (and edit) the wrong
    // profile. Unscoped must send undefined so the active profile applies.
    await renderKeysSettings('tools')

    await waitFor(() => expect(getEnvVars).toHaveBeenCalledWith(undefined))
  })

  it('lists tools and excludes settings / channel-managed credentials', async () => {
    getEnvVars.mockResolvedValue({
      BRAVE_SEARCH_API_KEY: envVar('tool', { description: 'Search the web with Brave.' }),
      FIRECRAWL_API_KEY: envVar('tool', { description: 'Crawl and extract websites.' }),
      GATEWAY_PROXY: envVar('setting', { description: 'Gateway reverse proxy.' }),
      TELEGRAM_BOT_TOKEN: envVar('messaging', {
        channel_managed: true,
        description: 'Telegram bot token.'
      })
    })

    await renderKeysSettings('tools')

    expect(screen.getByText('Search the web with Brave')).toBeTruthy()
    expect(screen.getByText('Search and read websites with Firecrawl')).toBeTruthy()
    expect(screen.queryByText('Gateway proxy')).toBeNull()
    expect(screen.queryByText('TELEGRAM BOT')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('every credential is THE settings row: a sentence-case title, its purpose below, the field trailing', async () => {
    getEnvVars.mockResolvedValue({
      BRAVE_SEARCH_API_KEY: envVar('tool', { description: 'Search the web with Brave.' }),
      BROWSERBASE_PROJECT_ID: envVar('tool', { description: 'The project your browser sessions run in.' })
    })

    await renderKeysSettings('tools')

    const rows = [...window.document.querySelectorAll('[data-setting-row]')]
    expect(rows).toHaveLength(2)
    expect(screen.getByText('Tell Browserbase which project to use')).toBeTruthy()
    const row = screen.getByText('Search the web with Brave').closest('[data-setting-row]') as HTMLElement
    // the hint is the catalogue's own words, never the backend's description
    expect(row.textContent).toContain('The free plan covers about 2,000 searches a month.')
    expect(row.textContent).not.toContain('Search the web with Brave.')
    const field = row.querySelector('[data-credential-key="BRAVE_SEARCH_API_KEY"]') as HTMLElement
    // the text column first, the field in the trailing column
    expect(row.firstElementChild?.lastElementChild?.contains(field)).toBe(true)
    expect(field.querySelector('input')).toBeTruthy()
    expect(window.document.body.textContent).not.toMatch(/BRAVE SEARCH|BROWSERBASE PROJECT/)
  })

  it('the empty key field asks for the key in its own words, never by repeating the sentence title', async () => {
    getEnvVars.mockResolvedValue({
      BRAVE_SEARCH_API_KEY: envVar('tool', { description: 'Search the web with Brave.' }),
      FIRECRAWL_API_URL: envVar('tool', { description: 'Your own Firecrawl server.', is_password: false })
    })

    await renderKeysSettings('tools')

    const key = window.document.querySelector('[data-credential-key="BRAVE_SEARCH_API_KEY"] input') as HTMLInputElement
    expect(key.placeholder).toBe('Paste your key here')
    expect(key.placeholder).not.toContain('Search the web with Brave')
    const url = window.document.querySelector('[data-credential-key="FIRECRAWL_API_URL"] input') as HTMLInputElement
    expect(url.placeholder).toBe('https://…')
  })

  it('lists settings rows and excludes tools / channel-managed credentials', async () => {
    getEnvVars.mockResolvedValue({
      API_SERVER_TOKEN: envVar('setting', { description: 'Protect the local API server.' }),
      GATEWAY_PROXY: envVar('messaging', { description: 'Gateway reverse proxy address.' }),
      TELEGRAM_BOT_TOKEN: envVar('messaging', {
        channel_managed: true,
        description: 'Telegram bot token.'
      }),
      BRAVE_SEARCH_API_KEY: envVar('tool', { description: 'Search the web with Brave.' })
    })

    await renderKeysSettings('settings')

    expect(screen.getByText('API server token')).toBeTruthy()
    expect(screen.getByText('Gateway proxy')).toBeTruthy()
    expect(screen.queryByText('TELEGRAM BOT')).toBeNull()
    expect(screen.queryByText('Search the web with Brave')).toBeNull()
  })

  it('expands and highlights a deep-linked credential card', async () => {
    getEnvVars.mockResolvedValue({
      BRAVE_SEARCH_API_KEY: envVar('tool', { description: 'Search the web with Brave.' }),
      FIRECRAWL_API_KEY: envVar('tool', { description: 'Crawl and extract websites.' })
    })

    const { KeysSettings } = await import('./keys-settings')

    render(
      <MemoryRouter initialEntries={['/settings?tab=keys']}>
        <KeysSettings view="tools" />
        <DeepLinkButton target="FIRECRAWL_API_KEY" />
      </MemoryRouter>
    )

    expect(await screen.findByText('Search the web with Brave')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open key' }))

    await waitFor(() => {
      const target = globalThis.document.getElementById('credential-key-FIRECRAWL_API_KEY')
      expect(target?.classList).toContain('setting-field-highlight')
    })
    expect(screen.getByText('Lets your agent search the web and read whole pages.')).toBeTruthy()
  })
})

describe('KeysSettings removal at rest', () => {
  afterEach(async () => {
    const { $confirmRequest } = await import('@/store/confirm')
    $confirmRequest.set(null)
  })

  it('removes a set key from the collapsed card through the kebab and the uniform confirm', async () => {
    window.localStorage.clear()
    deleteEnvVar.mockResolvedValue({ ok: true })
    getEnvVars.mockResolvedValue({
      BRAVE_SEARCH_API_KEY: envVar('tool', {
        description: 'Search the web with Brave.',
        is_set: true,
        redacted_value: 'BSA…9f'
      })
    })
    const { KeysSettings } = await import('./keys-settings')
    const { ConfirmHost } = await import('@/components/confirm-host')

    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/settings']}>
          <KeysSettings view="tools" />
          <ConfirmHost />
        </MemoryRouter>
      )
    })

    // At rest: no click on the card, the kebab is already there.
    const trigger = await screen.findByRole('button', { name: 'Actions for BRAVE_SEARCH_API_KEY' })
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }))

    const dialog = await screen.findByRole('dialog', { name: 'Remove BRAVE_SEARCH_API_KEY?' })
    expect(deleteEnvVar).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    })

    await waitFor(() => expect(deleteEnvVar).toHaveBeenCalledWith('BRAVE_SEARCH_API_KEY', undefined))
    const { readCredentialAudit } = await import('@/lib/credential-audit')
    expect(readCredentialAudit()[0]).toMatchObject({ id: 'BRAVE_SEARCH_API_KEY', kind: 'api_key', result: 'removed' })
    expect(JSON.stringify(readCredentialAudit())).not.toContain('BSA')
  })

  it('links an env key to the active provider through EnvVarInfo.provider (runtime shape: no key_env/auth_type)', async () => {
    window.localStorage.clear()
    deleteEnvVar.mockResolvedValue({ ok: true })
    getEnvVars.mockResolvedValue({
      ANTHROPIC_API_KEY: envVar('provider', {
        is_set: true,
        provider: 'anthropic',
        provider_label: 'Anthropic',
        redacted_value: 'sk-…aa'
      })
    })
    // The lab's real current row: authenticated, no key_env, no auth_type.
    getGlobalModelOptions.mockResolvedValue({
      provider: 'anthropic',
      providers: [{ authenticated: true, is_current: true, models: ['claude'], name: 'Anthropic', slug: 'anthropic' }]
    })

    const { useEnvCredentials } = await import('./env-credentials')
    const { ConfirmHost } = await import('@/components/confirm-host')
    const { $credentialRemoved, credentialRemovedFor } = await import('./credential-removal')
    $credentialRemoved.set({})

    function Harness() {
      const { rowProps, vars } = useEnvCredentials()
      const location = useLocation()

      return (
        <>
          <output data-testid="location">{`${location.pathname}${location.search}`}</output>
          {vars && (
            <button onClick={() => rowProps.onClear('ANTHROPIC_API_KEY')} type="button">
              Remove key
            </button>
          )}
        </>
      )
    }

    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/settings?tab=providers']}>
          <Harness />
          <ConfirmHost />
        </MemoryRouter>
      )
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Remove key' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove ANTHROPIC_API_KEY?' })
    expect(dialog.textContent).toContain('This is your current model provider')

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    })

    await waitFor(() => expect(deleteEnvVar).toHaveBeenCalledWith('ANTHROPIC_API_KEY', undefined))
    expect(credentialRemovedFor($credentialRemoved.get())?.provider).toBe('anthropic')
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/settings?tab=config:model'))
    $credentialRemoved.set({})
  })
})
