import { beforeEach, describe, expect, it, vi } from 'vitest'

import { readCredentialAudit } from '@/lib/credential-audit'

const confirmMock = vi.hoisted(() => vi.fn())
const notifyMock = vi.hoisted(() => vi.fn())
const notifyErrorMock = vi.hoisted(() => vi.fn())

vi.mock('@/store/confirm', () => ({ confirm: confirmMock }))
vi.mock('@/store/notifications', () => ({ notify: notifyMock, notifyError: notifyErrorMock }))

import {
  $credentialRemoved,
  afterRemoval,
  clearCredentialRemoved,
  credentialRemovedFor,
  envKeyForMemorySecret,
  envKeyForProvider,
  findActiveProviderFor,
  httpStatusOf,
  isNotFoundError,
  joinLabels,
  markCredentialRemoved,
  oauthProviderForSlug,
  providerCredentials,
  removalConfirmCopy,
  type RemovalDeps,
  removeCredential,
  runRemoval,
  safeDocsUrl,
  slugMatchesOAuthId
} from './credential-removal'

function deps(overrides: Partial<RemovalDeps> = {}): RemovalDeps {
  return {
    deleteCustomEndpoint: vi.fn().mockResolvedValue({ endpoints: [] }),
    deleteEnvVar: vi.fn().mockResolvedValue({ ok: true }),
    disconnectOAuthProvider: vi.fn().mockResolvedValue({ ok: true, provider: 'x' }),
    ...overrides
  }
}

describe('credential removal flow', () => {
  beforeEach(() => {
    window.localStorage.clear()
    confirmMock.mockReset()
    notifyMock.mockReset()
    notifyErrorMock.mockReset()
    $credentialRemoved.set({})
  })

  it('uses one destructive confirm shape per secret kind', async () => {
    confirmMock.mockResolvedValue(true)
    const d = deps()

    await runRemoval({ id: 'OPENAI_API_KEY', kind: 'api_key', label: 'OPENAI_API_KEY', surface: 'keys' }, { deps: d })

    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({ confirmLabel: 'Remove', destructive: true, title: 'Remove OPENAI_API_KEY?' })
    )
    expect(d.deleteEnvVar).toHaveBeenCalledWith('OPENAI_API_KEY', undefined)
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }))
    expect(readCredentialAudit()[0]).toMatchObject({ id: 'OPENAI_API_KEY', kind: 'api_key', result: 'removed' })
  })

  it('does nothing when the confirm is dismissed', async () => {
    confirmMock.mockResolvedValue(false)
    const d = deps()
    const onBusy = vi.fn()

    const result = await runRemoval(
      { id: 'nous', kind: 'oauth', label: 'Nous', surface: 'accounts' },
      { deps: d, onBusy }
    )

    expect(result).toBeNull()
    expect(d.disconnectOAuthProvider).not.toHaveBeenCalled()
    expect(onBusy).not.toHaveBeenCalled()
    expect(readCredentialAudit()).toEqual([])
  })

  it('treats DELETE /api/env 404 as already removed (idempotent success + audit)', async () => {
    const d = deps({ deleteEnvVar: vi.fn().mockRejectedValue(new Error('404: Not Found')) })

    const result = await removeCredential({ id: 'K', kind: 'api_key', label: 'K', surface: 'keys' }, d)

    expect(result).toEqual({ ok: true, result: 'already_removed' })
    expect(isNotFoundError({ status: 404 })).toBe(true)
    expect(isNotFoundError(new Error('500: boom'))).toBe(false)
  })

  it('reads 404/409 only from the status, never from a "404" elsewhere in the message', async () => {
    // What the renderer really receives: ipcRenderer drops `statusCode`.
    expect(httpStatusOf(new Error("Error invoking remote method 'hermes:api': Error: 404: Not Found"))).toBe(404)
    expect(httpStatusOf({ statusCode: 409 })).toBe(409)
    expect(isNotFoundError(new Error('500: model gpt-404 is not available'))).toBe(false)
    expect(isNotFoundError(new Error('Upstream said 404 for https://x/404'))).toBe(false)

    const d = deps({ deleteEnvVar: vi.fn().mockRejectedValue(new Error('500: key 404 not writable')) })
    const result = await removeCredential({ id: 'K', kind: 'api_key', label: 'K', surface: 'keys' }, d)

    expect(result.ok).toBe(false)

    const oauth = deps({ disconnectOAuthProvider: vi.fn().mockRejectedValue(new Error('500: retry after 409 ms')) })

    expect((await removeCredential({ id: 'x', kind: 'oauth', label: 'X', surface: 'accounts' }, oauth)).ok).toBe(false)
  })

  it('only treats http(s) docs URLs as openable', () => {
    expect(safeDocsUrl(' https://console.anthropic.com/settings/keys ')).toBe(
      'https://console.anthropic.com/settings/keys'
    )
    expect(safeDocsUrl('javascript:alert(1)')).toBeUndefined()
    expect(safeDocsUrl('file:///etc/passwd')).toBeUndefined()
    expect(safeDocsUrl(null)).toBeUndefined()
  })

  it('treats an OAuth 409 (nothing stored) as already removed', async () => {
    const d = deps({ disconnectOAuthProvider: vi.fn().mockRejectedValue(new Error('409: nothing to remove')) })

    expect(await removeCredential({ id: 'nous', kind: 'oauth', label: 'Nous', surface: 'accounts' }, d)).toEqual({
      ok: true,
      result: 'already_removed'
    })
  })

  it('surfaces other failures and audits them as failed', async () => {
    confirmMock.mockResolvedValue(true)
    const error = new Error('403: managed scope')
    const d = deps({ deleteEnvVar: vi.fn().mockRejectedValue(error) })

    const result = await runRemoval({ id: 'K', kind: 'api_key', label: 'K', surface: 'keys' }, { deps: d })

    expect(result).toEqual({ error, ok: false })
    expect(notifyErrorMock).toHaveBeenCalledWith(error, 'Could not remove K')
    expect(readCredentialAudit()[0].result).toBe('failed')
  })

  it('flags the active provider so the Model page asks to choose one', async () => {
    confirmMock.mockResolvedValue(true)

    await runRemoval(
      {
        id: 'OPENAI_API_KEY',
        isActiveProvider: true,
        kind: 'api_key',
        label: 'OPENAI_API_KEY',
        providerSlug: 'openai',
        surface: 'keys'
      },
      { deps: deps() }
    )

    expect(credentialRemovedFor($credentialRemoved.get())?.provider).toBe('openai')
    expect(confirmMock.mock.calls[0][0].description).toContain('current model provider')
  })

  it('keeps the removed-credential flag per profile and clears only that profile', async () => {
    confirmMock.mockResolvedValue(true)

    await runRemoval(
      {
        id: 'ANTHROPIC_API_KEY',
        isActiveProvider: true,
        kind: 'api_key',
        label: 'ANTHROPIC_API_KEY',
        profile: 'inft-7',
        providerSlug: 'anthropic',
        surface: 'keys'
      },
      { deps: deps() }
    )

    markCredentialRemoved('openai')

    expect(credentialRemovedFor($credentialRemoved.get(), 'inft-7')?.provider).toBe('anthropic')
    expect(credentialRemovedFor($credentialRemoved.get(), 'other')).toBeNull()

    clearCredentialRemoved('inft-7')

    expect(credentialRemovedFor($credentialRemoved.get(), 'inft-7')).toBeNull()
    expect(credentialRemovedFor($credentialRemoved.get())?.provider).toBe('openai')
  })

  it('offers "Revoke at provider" only for a web docs URL', async () => {
    confirmMock.mockResolvedValue(true)
    const base = { id: 'nous', kind: 'oauth' as const, label: 'Nous Portal', surface: 'accounts' as const }

    await runRemoval({ ...base, docsUrl: 'https://portal.nousresearch.com' }, { deps: deps() })
    expect(notifyMock.mock.calls[0][0].action?.label).toBe('Revoke at provider')

    await runRemoval({ ...base, docsUrl: 'javascript:alert(1)' }, { deps: deps() })
    expect(notifyMock.mock.calls[1][0].action).toBeUndefined()
  })

  it('signs out without a confirm, still audited', async () => {
    const perform = vi.fn().mockResolvedValue(undefined)

    const result = await runRemoval({ id: 'host', kind: 'gateway_session', label: 'host', perform, surface: 'gateway' })

    expect(confirmMock).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, result: 'signed_out' })
    expect(readCredentialAudit()[0].result).toBe('signed_out')
  })

  it('external providers with a command run it (terminal_started); without one show the runtime hint', async () => {
    confirmMock.mockResolvedValue(true)
    const perform = vi.fn().mockResolvedValue(undefined)

    const result = await runRemoval({
      command: 'security delete-generic-password',
      id: 'claude-code',
      kind: 'external',
      label: 'Claude Code',
      perform,
      surface: 'accounts'
    })

    expect(result).toEqual({ ok: true, result: 'terminal_started' })
    expect(confirmMock.mock.calls[0][0].confirmLabel).toBe('Run in terminal')

    const hint = removalConfirmCopy({
      hint: 'Managed by that provider CLI; remove it there.',
      id: 'qwen-oauth',
      kind: 'external',
      label: 'Qwen'
    } as never)

    expect(hint.description).toContain('Managed by that provider CLI')
  })

  it('maps model slugs to OAuth catalog ids without assuming equality', () => {
    expect(slugMatchesOAuthId('openai_codex', 'openai-codex')).toBe(true)
    expect(slugMatchesOAuthId('codex', 'openai-codex')).toBe(true)
    expect(slugMatchesOAuthId('openai', 'openai-codex')).toBe(false)
    expect(oauthProviderForSlug('xai_oauth', [{ id: 'xai-oauth' } as never])?.id).toBe('xai-oauth')
  })

  it('finds the current provider backing a credential (best effort)', async () => {
    const load = vi.fn().mockResolvedValue({
      providers: [{ is_current: true, key_env: 'OPENAI_API_KEY', name: 'OpenAI', slug: 'openai' }]
    })

    expect((await findActiveProviderFor({ keyEnv: 'OPENAI_API_KEY' }, undefined, load))?.slug).toBe('openai')

    // The runtime's real authenticated current row: no key_env, no auth_type.
    const runtime = vi.fn().mockResolvedValue({
      provider: 'anthropic',
      providers: [{ authenticated: true, is_current: true, name: 'Anthropic', slug: 'anthropic' }]
    })

    expect(
      (await findActiveProviderFor({ keyEnv: 'ANTHROPIC_API_KEY', provider: 'anthropic' }, 'p1', runtime))?.slug
    ).toBe('anthropic')
    expect(runtime).toHaveBeenCalledWith(undefined, 'p1')
    expect(await findActiveProviderFor({ keyEnv: 'OPENAI_API_KEY', provider: 'openai' }, undefined, runtime)).toBe(
      undefined
    )
    expect(await findActiveProviderFor({ keyEnv: 'OTHER' }, undefined, load)).toBeUndefined()
    expect(await findActiveProviderFor({ keyEnv: 'X' }, undefined, vi.fn().mockRejectedValue(new Error('x')))).toBe(
      undefined
    )
  })

  it('finds the env key of an authenticated provider through GET /api/env provider grouping', () => {
    const row = { authenticated: true, is_current: true, name: 'Anthropic', slug: 'anthropic' }

    const vars = {
      ANTHROPIC_BASE_URL: { is_password: false, is_set: true, provider: 'anthropic' },
      ANTHROPIC_TOKEN: { is_password: true, is_set: true, provider: 'anthropic' },
      ANTHROPIC_API_KEY: { is_password: true, is_set: true, provider: 'anthropic' },
      OPENAI_API_KEY: { is_password: true, is_set: true, provider: 'openai' }
    } as never

    expect(envKeyForProvider(row, vars)).toBe('ANTHROPIC_API_KEY')
    expect(envKeyForProvider({ ...row, slug: 'gemini' }, vars)).toBeUndefined()
    expect(envKeyForProvider(row, null)).toBeUndefined()
  })

  it('derives a memory secret env key from GET /api/env, or reports none', () => {
    const vars = {
      HINDSIGHT_API_KEY: { is_password: true, is_set: true },
      HINDSIGHT_API_URL: { is_password: false, is_set: true },
      HONCHO_API_KEY: { is_password: true, is_set: false }
    } as never

    expect(envKeyForMemorySecret('hindsight', { key: 'api_key' }, vars)).toBe('HINDSIGHT_API_KEY')
    expect(envKeyForMemorySecret('hindsight', { key: 'apiKey' }, vars)).toBe('HINDSIGHT_API_KEY')
    // Set in honcho.json, not in ~/.hermes/.env → nothing to delete here.
    expect(envKeyForMemorySecret('honcho', { key: 'apiKey' }, vars)).toBeUndefined()
    expect(envKeyForMemorySecret('honcho', { env_key: 'HONCHO_API_KEY', key: 'apiKey' }, vars)).toBeUndefined()
  })

  it('uses the env var a memory plugin declares, never a guess beside it', () => {
    const vars = {
      BRV_API_KEY: { is_password: true, is_set: true },
      HINDSIGHT_API_KEY: { is_password: true, is_set: true },
      HINDSIGHT_LLM_API_KEY: { is_password: true, is_set: false }
    } as never

    expect(envKeyForMemorySecret('byterover', { key: 'api_key' }, vars)).toBe('BRV_API_KEY')
    expect(envKeyForMemorySecret('ByteRover', { key: 'apiKey' }, vars)).toBe('BRV_API_KEY')
    // Declared but unset: not the provider's other set secret.
    expect(envKeyForMemorySecret('hindsight', { key: 'llm_api_key' }, vars)).toBeUndefined()
    expect(envKeyForMemorySecret('byterover', { key: 'api_key' }, null)).toBeUndefined()
  })

  it('lists every credential behind a provider: env secrets, then app sign-ins, then managed ones', () => {
    const row = { authenticated: true, is_current: true, name: 'Anthropic', slug: 'anthropic' }

    const vars = {
      ANTHROPIC_API_KEY: { is_password: true, is_set: true, provider: 'anthropic' },
      ANTHROPIC_TOKEN: { is_password: true, is_set: true, provider: 'anthropic' }
    } as never

    const oauth = (id: string, name: string, extra: object) =>
      ({ cli_command: '', docs_url: '', id, name, status: { logged_in: true }, ...extra }) as never

    const catalog = [
      oauth('anthropic', 'Anthropic (Claude Pro/Max)', { disconnectable: false, flow: 'pkce' }),
      oauth('claude-code', 'Claude Code', { flow: 'external' }),
      oauth('nous', 'Nous Portal', { flow: 'device_code' }),
      // The lab's real shape: this catalog row is signed in BY the env key itself.
      {
        ...(oauth('anthropic', 'Anthropic API Key', { disconnectable: false, flow: 'pkce' }) as object),
        status: { logged_in: true, source: 'env_var', source_label: 'ANTHROPIC_API_KEY' }
      } as never,
      { ...(oauth('qwen-oauth', 'Qwen', { flow: 'pkce' }) as object), status: { logged_in: false } } as never
    ]

    expect(providerCredentials(row, vars, catalog).map(c => `${c.kind}:${c.label}`)).toEqual([
      'api_key:ANTHROPIC_API_KEY',
      'api_key:ANTHROPIC_TOKEN',
      'manage:Anthropic (Claude Pro/Max)',
      'manage:Claude Code'
    ])
    expect(providerCredentials({ ...row, key_env: 'ANTHROPIC_API_KEY' }, null, []).map(c => c.label)).toEqual([
      'ANTHROPIC_API_KEY'
    ])
    expect(joinLabels(['A', 'B', 'C'])).toBe('A, B and C')
  })

  it('names what remains in the confirm and the notice, and never flags "choose a provider" while something remains', () => {
    const target = {
      id: 'ANTHROPIC_API_KEY',
      isActiveProvider: true,
      kind: 'api_key' as const,
      label: 'ANTHROPIC_API_KEY',
      providerLabel: 'Anthropic',
      providerSlug: 'anthropic',
      remaining: ['Anthropic (Claude Pro/Max)', 'Claude Code'],
      surface: 'model' as const
    }

    const { description } = removalConfirmCopy(target)
    expect(description).toContain('Anthropic is also signed in through Anthropic (Claude Pro/Max) and Claude Code')
    expect(description).not.toContain('current model provider')

    $credentialRemoved.set({})
    afterRemoval(target, { ok: true, result: 'removed' })
    expect(credentialRemovedFor($credentialRemoved.get())).toBeNull()
    expect(notifyMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message:
          'ANTHROPIC_API_KEY was removed from this Mac. Anthropic is still signed in through Anthropic (Claude Pro/Max) and Claude Code.'
      })
    )

    afterRemoval({ ...target, remaining: [] }, { ok: true, result: 'removed' })
    expect(credentialRemovedFor($credentialRemoved.get())?.provider).toBe('anthropic')
    $credentialRemoved.set({})
  })
})
