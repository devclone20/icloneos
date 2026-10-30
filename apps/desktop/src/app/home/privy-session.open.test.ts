// K143 — the Privy sign-in port is fixed on purpose (the allowlisted origin). When it is held, the login button says
// so in the app's language instead of looking dead; the main process names the reason, never just English text.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const notify = vi.fn()

vi.mock('@/store/notifications', () => ({ notify, notifyError: vi.fn() }))
vi.mock('./inft-switch', () => ({ switchInft: vi.fn(), deselectInft: vi.fn() }))
vi.mock('./inft-profile', () => ({ buildAllProfiles: vi.fn() }))
vi.mock('./inft-scan', () => ({ toInftCards: () => [] }))
vi.mock('./econ/badges', () => ({ clearEconBadges: vi.fn() }))
vi.mock('./econ/prefetch', () => ({ forgetPrefetch: vi.fn() }))
vi.mock('./stage-store', async () => {
  const { atom } = await import('nanostores')

  return { $activeInft: atom(null), HERMES_CHOICE: 'hermes', recallInftChoice: () => null }
})

async function withBridge(open: () => Promise<unknown>) {
  vi.resetModules()
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    iclonePrivy: {
      open,
      logout: vi.fn(() => Promise.resolve({ ok: true })),
      scan: vi.fn(),
      resolveProfile: vi.fn(),
      onSession: () => () => undefined
    }
  }

  return import('./privy-session')
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const PORT_IN_USE = { ok: false, reason: 'port-in-use', port: 47831, error: 'port 47831 is already in use' }

beforeEach(() => notify.mockClear())
// vi.resetModules() gives each test a fresh module graph: the i18n runtime is read from the same graph as privy-session.
afterEach(async () => (await import('@/i18n/runtime')).setRuntimeI18nLocale('en'))

describe('K143: a held sign-in port is said, in the six languages', () => {
  it('port in use: the toast names the port and what to do (never the raw English error)', async () => {
    const { openPrivyLogin } = await withBridge(() => Promise.resolve(PORT_IN_USE))
    openPrivyLogin()
    await flush()

    expect(notify).toHaveBeenCalledTimes(1)
    const toast = notify.mock.calls[0][0]
    expect(toast).toMatchObject({ kind: 'error', title: 'Sign-in could not open' })
    expect(toast.message).toBe(
      'Another copy of iclone os (or another app) is using the sign-in port 47831. Quit it, then try again.'
    )
  })

  it.each([
    ['pt-PT', 'Não foi possível abrir o início de sessão', 'porta de início de sessão 47831'],
    ['zh', '无法打开登录', '登录端口 47831'],
    ['zh-hant', '無法開啟登入', '登入連接埠 47831'],
    ['ja', 'サインインを開けませんでした', 'ポート 47831'],
    ['ar', 'تعذّر فتح تسجيل الدخول', 'منفذ تسجيل الدخول 47831']
  ] as const)('%s: title and port line are translated', async (locale, title, portLine) => {
    const { privyOpenRefusalCopy } = await withBridge(() => Promise.resolve(PORT_IN_USE))
    await (await import('@/i18n/locale-loader')).loadTranslations(locale)
    ;(await import('@/i18n/runtime')).setRuntimeI18nLocale(locale)

    const copy = privyOpenRefusalCopy(PORT_IN_USE as never)
    expect(copy.title).toBe(title)
    expect(copy.message).toContain(portLine)
    // n1: the product is named as the catalogue and Info.plist name it.
    expect(copy.message).toContain('iclone os')
    expect(copy.message).not.toContain('icloneOS')
  })

  it('a missing page, a refusal without a reason (older main) and a rejected IPC each get their own words', async () => {
    const { privyOpenRefusalCopy, openPrivyLogin } = await withBridge(() => Promise.reject(new Error('ipc')))

    expect(privyOpenRefusalCopy({ ok: false, reason: 'unavailable' }).message).toBe(
      'Wallet sign-in is not available in this build.'
    )
    expect(privyOpenRefusalCopy({ ok: false, error: 'raw english' }).message).toBe('Sign-in could not open. Try again.')

    // n2: no port reported means no port in the copy (never a guessed number); a listen failure is the generic line.
    for (const answer of [
      { ok: false, reason: 'port-in-use' as const },
      { ok: false, reason: 'port-in-use' as const, port: 0 },
      { ok: false, reason: 'port-in-use' as const, port: 70000 },
      { ok: false, reason: 'listen-failed' as const }
    ]) {
      expect(privyOpenRefusalCopy(answer).message).toBe('Sign-in could not open. Try again.')
    }

    expect(privyOpenRefusalCopy({ ok: false, reason: 'port-in-use', port: 51234 }).message).toContain('port 51234')

    openPrivyLogin()
    await flush()
    expect(notify.mock.calls[0][0].message).toBe('Sign-in could not open. Try again.')
  })

  it('an opened window says nothing', async () => {
    const { openPrivyLogin } = await withBridge(() => Promise.resolve({ ok: true }))
    openPrivyLogin()
    await flush()
    expect(notify).not.toHaveBeenCalled()
  })
})
