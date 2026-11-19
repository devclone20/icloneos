/**
 * v0.0.9 r4 (design r3 N6): the wallet error offers its action once. Red on 5470b2b185: a ghost Retry floated beside
 * the alert while the footer's Refresh did the same in stronger ink, the alert read "Balance fetch failed." with no
 * cause, and the blocks started on three different left edges.
 */
import fs from 'node:fs'
import path from 'node:path'

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

import { f5Wallet as copy } from '@/i18n/en/v009-f5'

import { type ChainBalanceRow, closeWalletPanel, resetWalletBalances } from './wallet-balances'
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

describe('wallet total error (design r3 N6)', () => {
  it('one Retry, inside the alert; no footer Refresh while the error shows', async () => {
    installBridge(async () => ({ ok: false }))
    await renderPanel()

    const alert = screen.getByRole('alert')

    expect(screen.getAllByRole('button', { name: copy.retry })).toHaveLength(1)
    expect(within(alert).getByRole('button', { name: copy.retry })).toBeTruthy()
    // The footer's Refresh steps aside (r4d: the alert's action is the same verb, Refresh).
    expect(document.querySelector('.iwbal__refresh')).toBeNull()
    expect(copy.retry).toBe(copy.refresh)

    await act(async () => void fireEvent.click(within(alert).getByRole('button', { name: copy.retry })))
    expect(fetchBalances).toHaveBeenCalledTimes(2)
  })

  it('names the cause in the owner\'s words when none came back', async () => {
    installBridge(async () => ({ ok: false }))
    await renderPanel()

    const alert = screen.getByRole('alert')

    expect(alert.textContent).toContain(copy.failed)
    expect(alert.textContent).toContain(copy.failedCause)
    expect(alert.textContent).not.toContain('Balance fetch failed')
  })

  it('a cause that did come back is kept', async () => {
    installBridge(async () => {
      throw new Error('Every RPC refused the request.')
    })
    await renderPanel()

    expect(screen.getByRole('alert').textContent).toContain('Every RPC refused the request.')
  })

  it('Refresh is back once the balances read', async () => {
    await renderPanel()

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: copy.refresh })).toBeTruthy()
  })

  it('every block starts on the one 16px row inset', () => {
    const css = fs.readFileSync(path.join(__dirname, 'wallet-panel.css'), 'utf8')

    const rule = (selector: string) => {
      const at = css.indexOf(`${selector} {`)

      expect(at, selector).toBeGreaterThanOrEqual(0)

      return css.slice(at, css.indexOf('}', at))
    }

    expect(rule('.iwbal')).toMatch(/--iwbal-inset:\s*16px/)

    for (const selector of ['.iwbal__id', '.iwbal__alert', '.iwbal__foot', '.iwbal__signout']) {
      expect(rule(selector), selector).toMatch(/padding:\s*\S+ var\(--iwbal-inset\)/)
    }

    // The dots: the list's inline padding plus the row's 8px lands on the inset.
    expect(rule('.iwbal__rows')).toMatch(/padding:\s*8px calc\(var\(--iwbal-inset\) - 8px\)/)
    expect(rule('.iwbal__row')).toMatch(/padding:\s*0 8px/)
    expect(rule('.iwbal__alert')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\);/)
  })
})
