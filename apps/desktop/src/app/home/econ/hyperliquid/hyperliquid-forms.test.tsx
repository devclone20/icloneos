import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { buyBrief, BuyForm, fundAmount, fundBrief, FundForm, perpBrief, PerpForm } from './hyperliquid-forms'

describe('Hyperliquid Deposit/Withdraw (U3-p2-01)', () => {
  it('fundBrief carries the real amount and chain, in plain language — no CLI flags, no placeholders', () => {
    for (const brief of [fundBrief('deposit', 25, 'Base'), fundBrief('withdraw', 12.5, 'Arbitrum')]) {
      expect(brief).not.toMatch(/<amount>|`|--[a-z]/)
      expect(brief).not.toContain('acp ')
    }

    expect(fundBrief('deposit', 25, 'Base')).toContain('Deposit 25 USDC from Base into my Hyperliquid account')
    expect(fundBrief('withdraw', 12.5, 'Arbitrum')).toContain('Withdraw 12.5 USDC from my Hyperliquid account')
  })

  it('fundAmount refuses empty, zero, negative, NaN and more than the ceiling', () => {
    expect(fundAmount('', null)).toBeNull()
    expect(fundAmount('0', null)).toBeNull()
    expect(fundAmount('-3', null)).toBeNull()
    expect(fundAmount('abc', null)).toBeNull()
    expect(fundAmount('500', 400)).toBeNull()
    expect(fundAmount(' 25 ', 400)).toBe(25)
  })

  it('the form hands over one brief only on Ask, and Cancel never does', () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()

    render(<FundForm agentName="#6" kind="deposit" max={null} onCancel={onCancel} onSubmit={onSubmit} />)

    const ask = screen.getByRole('button', { name: 'Ask #6' }) as HTMLButtonElement

    expect(ask.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Amount \(USDC\)/), { target: { value: '25' } })
    expect(ask.disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.click(ask)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]?.[0]).toBe(fundBrief('deposit', 25, 'Base'))
  })

  it('a withdrawal is capped at the withdrawable balance', () => {
    const onSubmit = vi.fn()

    render(<FundForm agentName="#6" kind="withdraw" max={400} onCancel={vi.fn()} onSubmit={onSubmit} />)

    fireEvent.change(screen.getByLabelText(/Amount \(USDC\)/), { target: { value: '500' } })
    expect((screen.getByRole('button', { name: 'Ask #6' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/up to \$400\.00/)).toBeTruthy()
  })

  it('UF2B1-c1-03: buyBrief and perpBrief say the real figures in plain language — no CLI, no placeholders', () => {
    const briefs = [buyBrief('TSLA', 25), perpBrief('NVDA', 'short', 2, 5)]

    for (const brief of briefs) {
      expect(brief).not.toMatch(/<[a-z|]+>|`|--[a-z]|acp /)
    }

    expect(briefs[0]).toContain('Buy TSLA on Hyperliquid spot for me with 25 USDC')
    expect(briefs[1]).toContain('Open a short perp on NVDA for me: 2 NVDA at 5x leverage')
  })

  it('BuyForm and PerpForm hand over one brief only on Ask, disabled until the figures are valid', () => {
    const onBuy = vi.fn()
    const onPerp = vi.fn()

    const buy = render(<BuyForm agentName="#6" onCancel={vi.fn()} onSubmit={onBuy} symbol="TSLA" />)

    expect((screen.getByRole('button', { name: 'Ask #6' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '50' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ask #6' }))
    expect(onBuy).toHaveBeenCalledWith(buyBrief('TSLA', 50))
    buy.unmount()

    render(<PerpForm agentName="#6" onCancel={vi.fn()} onSubmit={onPerp} symbol="TSLA" />)

    const ask = screen.getByRole('button', { name: 'Ask #6' }) as HTMLButtonElement

    expect(ask.disabled).toBe(true)
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Size (TSLA)' }), { target: { value: '-1' } })
    expect(ask.disabled).toBe(true)
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Size (TSLA)' }), { target: { value: '1.5' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Leverage' }), { target: { value: '10' } })
    fireEvent.click(ask)
    expect(onPerp).toHaveBeenCalledTimes(1)
    expect(onPerp).toHaveBeenCalledWith(perpBrief('TSLA', 'long', 1.5, 10))
  })
})
