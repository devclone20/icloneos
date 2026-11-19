// v0.0.9 F5 — the personal wallet popover (P0_DESIGN_SPECS.md "F5 · Carteira pessoal"): a real Copy that says
// whether it worked, the flat network list with the zero-balance fold and per-network causes, freshness + Refresh,
// and a sign-out that asks first (Cancel signs nothing out), then toasts and hands focus to the wallet icon.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

import { f5Wallet as copy } from '@/i18n/en/v009-f5'

import { type ChainBalanceRow, closeWalletPanel, partitionBalanceRows, resetWalletBalances } from './wallet-balances'
import { WalletPanel } from './wallet-panel'

const toast = vi.hoisted(() => ({ notify: vi.fn() }))

vi.mock('@/store/notifications', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notify: toast.notify
}))

const ADDRESS = '0x12ab34cd56ef7890a1b2c3d4e5f60718293a9f3c'

const ROWS: ChainBalanceRow[] = [
  { key: 'robinhood', chain: 'Robinhood', symbol: 'ETH', balance: '0', ok: true },
  { key: 'solana', chain: 'Solana', symbol: 'SOL', balance: '0', ok: false, error: 'RPC timed out after 8 s' },
  { key: 'ethereum', chain: 'Ethereum', symbol: 'ETH', balance: '0.011726', ok: true },
  { key: 'base', chain: 'Base', symbol: 'ETH', balance: '0.0', ok: true },
  { key: 'polygon', chain: 'Polygon', symbol: 'POL', balance: '12.5', ok: true }
]

type Fetch = (address: string, solAddress?: string) => Promise<unknown>

let fetchBalances: Mock<Fetch>

function installBridge(impl: Fetch) {
  fetchBalances = vi.fn<Fetch>(impl)
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = { icloneBalances: { fetch: fetchBalances } }
}

async function renderPanel(props: Partial<Parameters<typeof WalletPanel>[0]> = {}) {
  const onClose = props.onClose ?? vi.fn()
  const onSignOut = props.onSignOut ?? vi.fn()
  let view!: ReturnType<typeof render>

  await act(async () => {
    view = render(<WalletPanel address={ADDRESS} onClose={onClose} onSignOut={onSignOut} {...props} />)
  })

  return { ...view, onClose, onSignOut }
}

beforeEach(() => {
  toast.notify.mockReset()
  resetWalletBalances()
  installBridge(async () => ({ ok: true, rows: ROWS, fetchedAt: Date.now() - 12_000 }))
})

afterEach(() => {
  cleanup()
  closeWalletPanel()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
  window.document.querySelectorAll('[data-ic-frame-tool]').forEach(node => node.remove())
})

describe('identity and Copy', () => {
  it('shows "Wallet" and the address as 0x12ab…9f3c in mono, with the whole address one hover away', async () => {
    await renderPanel()

    expect(screen.getByRole('dialog', { name: copy.dialogLabel })).toBeTruthy()
    expect(screen.getByText(copy.title)).toBeTruthy()
    expect(screen.getByTestId('wallet-address').textContent).toBe('0x12ab…9f3c')
  })

  it('Copy is a button and says Copied when the clipboard takes it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await renderPanel()

    const button = screen.getByRole('button', { name: copy.copyAddress })

    await act(async () => void fireEvent.click(button))
    expect(writeText).toHaveBeenCalledWith(ADDRESS)
    expect(button.textContent).toContain(copy.copied)
    expect(screen.getByRole('status').textContent).toBe(copy.copied)
  })

  it("says Couldn't copy when the clipboard refuses — never silent", async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }
    })
    await renderPanel()

    const button = screen.getByRole('button', { name: copy.copyAddress })

    await act(async () => void fireEvent.click(button))
    expect(button.textContent).toContain(copy.copyFailed)
  })

  it("says Couldn't copy when there is no clipboard at all", async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    await renderPanel()

    const button = screen.getByRole('button', { name: copy.copyAddress })

    await act(async () => void fireEvent.click(button))
    expect(button.textContent).toContain(copy.copyFailed)
  })

  it('names the account type only when the session knows it', async () => {
    const { unmount } = await renderPanel()

    expect(screen.queryByText(copy.accountEmbedded)).toBeNull()
    expect(screen.queryByText(copy.accountExternal)).toBeNull()
    unmount()

    await renderPanel({ accountType: 'embedded' })
    expect(screen.getByText(copy.accountEmbedded)).toBeTruthy()
  })
})

describe('networks and balances', () => {
  it('orders funded first, then unavailable, and folds the zero ones', () => {
    const { funded, unavailable, zero } = partitionBalanceRows(ROWS)

    expect(funded.map(row => row.key)).toEqual(['ethereum', 'polygon'])
    expect(unavailable.map(row => row.key)).toEqual(['solana'])
    expect(zero.map(row => row.key)).toEqual(['robinhood', 'base'])
  })

  it('collapses the zero-balance networks under "N networks with no balance" until asked', async () => {
    await renderPanel()

    expect(screen.getByText('Ethereum')).toBeTruthy()
    expect(screen.getByText('Polygon')).toBeTruthy()
    expect(screen.queryByText('Robinhood')).toBeNull()
    expect(screen.queryByText('Base')).toBeNull()

    const fold = screen.getByRole('button', { name: copy.zeroNetworks(2) })

    expect(fold.textContent).toContain('2 networks with no balance')
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(fold)
    expect(fold.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Robinhood')).toBeTruthy()
    expect(screen.getByText('Base')).toBeTruthy()
  })

  it('a network that failed says Unavailable, with its cause one hover (or Tab) away', async () => {
    await renderPanel()

    expect(screen.getByText(copy.unavailable)).toBeTruthy()
    expect(screen.getByRole('img', { name: copy.unavailableCause('Solana', 'RPC timed out after 8 s') })).toBeTruthy()
  })

  it('balances read in tabular figures; no fiat, no network switch, no send', async () => {
    const { container } = await renderPanel()

    expect(container.ownerDocument.querySelector('.iwbal')?.textContent).toContain('0.0117')
    expect(screen.queryByRole('button', { name: /send|switch|usd|\$/i })).toBeNull()
  })

  it('says how fresh the numbers are, and Refresh fetches now', async () => {
    await renderPanel()

    expect(screen.getByText(copy.updated(12))).toBeTruthy()
    expect(fetchBalances).toHaveBeenCalledTimes(1)
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: copy.refresh })))
    expect(fetchBalances).toHaveBeenCalledTimes(2)
  })

  it('loading: four skeleton rows, busy', async () => {
    installBridge(() => new Promise(() => undefined))

    const { container } = await renderPanel()

    expect(container.ownerDocument.querySelectorAll('.iwbal__skeleton')).toHaveLength(4)
    expect(screen.getByRole('list', { name: copy.networks }).getAttribute('aria-busy')).toBe('true')
  })

  it('total error: an inline alert with the cause and a Retry that fetches again', async () => {
    installBridge(async () => {
      throw new Error('Every RPC refused the request.')
    })
    await renderPanel()

    expect(screen.getByRole('alert').textContent).toContain('Every RPC refused the request.')
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: copy.retry })))
    expect(fetchBalances).toHaveBeenCalledTimes(2)
  })
})

describe('sign out asks first', () => {
  it('opens IcConfirmDialog with the stated words; Cancel signs nothing out', async () => {
    const { onSignOut } = await renderPanel()

    fireEvent.click(screen.getByRole('button', { name: copy.signOut }))

    const dialog = screen.getByRole('dialog', { name: copy.confirmTitle })

    expect(dialog.textContent).toContain(
      'Your iNFTs stay yours; the app forgets this session until you sign in again.'
    )
    expect(onSignOut).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: copy.confirmCancel }))
    expect(screen.queryByRole('dialog', { name: copy.confirmTitle })).toBeNull()
    expect(onSignOut).not.toHaveBeenCalled()
    expect(toast.notify).not.toHaveBeenCalled()
  })

  it('Esc while the question is up closes the question, not the wallet', async () => {
    const { onClose, onSignOut } = await renderPanel()

    fireEvent.click(screen.getByRole('button', { name: copy.signOut }))
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: copy.confirmTitle })).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(onSignOut).not.toHaveBeenCalled()
  })

  it('Sign out runs the existing logout once and toasts "Signed out"', async () => {
    const { onSignOut } = await renderPanel()

    fireEvent.click(screen.getByRole('button', { name: copy.signOut }))
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: copy.confirmAction })))

    expect(onSignOut).toHaveBeenCalledTimes(1)
    expect(toast.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success', message: copy.signedOut }))
  })

  it('a failed erase in main is never toasted as "Signed out": it is an error with the cause and Try again (critic m1)', async () => {
    const onSignOut = vi
      .fn<() => Promise<{ ok: boolean; error?: string }>>()
      .mockResolvedValueOnce({ ok: false, error: 'clearStorageData failed' })
      .mockResolvedValueOnce({ ok: true })

    await renderPanel({ onSignOut })

    fireEvent.click(screen.getByRole('button', { name: copy.signOut }))
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: copy.confirmAction })))

    expect(onSignOut).toHaveBeenCalledTimes(1)
    expect(toast.notify).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }))
    expect(toast.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: 'clearStorageData failed',
        kind: 'error',
        message: copy.signOutFailedMessage,
        title: copy.signOutFailedTitle
      })
    )

    const failure = toast.notify.mock.calls.at(-1)?.[0] as { action: { label: string; onClick: () => void } }

    expect(failure.action.label).toBe(copy.signOutRetry)
    await act(async () => {
      failure.action.onClick()
      await Promise.resolve()
    })
    expect(onSignOut).toHaveBeenCalledTimes(2)
    expect(toast.notify).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'success', message: copy.signedOut }))
  })

  it('"Signed out" waits for main\'s answer: nothing is toasted while the erase is still running (critic m1)', async () => {
    let answer!: (value: { ok: boolean }) => void
    const onSignOut = vi.fn(() => new Promise<{ ok: boolean }>(resolve => (answer = resolve)))

    await renderPanel({ onSignOut })

    fireEvent.click(screen.getByRole('button', { name: copy.signOut }))
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: copy.confirmAction })))
    expect(toast.notify).not.toHaveBeenCalled()

    await act(async () => answer({ ok: true }))
    expect(toast.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success', message: copy.signedOut }))
  })

  it('without the confirm, the old one-click footer link is gone', async () => {
    await renderPanel()

    expect(screen.queryByRole('button', { name: 'sign out' })).toBeNull()
  })
})

describe('focus', () => {
  it('Esc closes, and focus goes back to the wallet icon', async () => {
    const tool = window.document.body.appendChild(window.document.createElement('button'))

    tool.dataset.icFrameTool = 'iclone-wallet'

    const { onClose, unmount } = await renderPanel()

    expect(window.document.activeElement).toBe(screen.getByRole('button', { name: copy.copyAddress }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    unmount()
    expect(window.document.activeElement).toBe(tool)
  })

  it('Tab stays inside the popover while it is open', async () => {
    await renderPanel()

    const dialog = screen.getByRole('dialog', { name: copy.dialogLabel })

    const focusables = [
      ...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')
    ]

    const last = focusables[focusables.length - 1]

    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(window.document.activeElement).toBe(focusables[0])

    fireEvent.keyDown(focusables[0], { key: 'Tab', shiftKey: true })
    expect(window.document.activeElement).toBe(last)
  })
})
