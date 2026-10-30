/**
 * EconomyOS — Hyperliquid · Deposit, Withdraw, Buy and Open perp.
 *
 * Each form owns its fields and hands ONE plain-language brief to the iNFT
 * (handoff.ts) when the owner presses "Ask <agent>": the real figures and the
 * chain or symbol, no CLI flags, no placeholders — which commands to run is
 * the agent's.
 */
import { memo, useState } from 'react'

import { usd } from '../format'
import { Action, SectionTitle } from '../ui'

const FUND_CHAINS = ['Base', 'Arbitrum'] as const
type FundChain = (typeof FUND_CHAINS)[number]
export type FundKind = 'deposit' | 'withdraw'
export type TradeKind = 'buy' | 'perp'
type PerpSide = 'long' | 'short'

const USDC_PRESETS = ['10', '25', '50', '100'] as const
const LEVERAGES = ['1', '2', '3', '5', '10'] as const

/** The amount the brief will say, or null while the field cannot be asked for. */
export function fundAmount(text: string, max: null | number): null | number {
  const value = Number(text.trim())

  if (!text.trim() || !Number.isFinite(value) || value <= 0 || (max !== null && value > max)) {
    return null
  }

  return value
}

export function fundBrief(kind: FundKind, amount: number, chain: FundChain): string {
  const sum = `${amount} USDC`

  return kind === 'deposit'
    ? `Deposit ${sum} from ${chain} into my Hyperliquid account; show me the route and fees before executing, then report the new withdrawable balance.`
    : `Withdraw ${sum} from my Hyperliquid account to my wallet on ${chain}; show me the plan first and run it only after I confirm.`
}

export function buyBrief(symbol: string, amount: number): string {
  return `Buy ${symbol} on Hyperliquid spot for me with ${amount} USDC; show me the route, the expected size and the fees before executing, run it only after I confirm, then report the fill.`
}

export function perpBrief(symbol: string, side: PerpSide, size: number, leverage: number): string {
  return `Open a ${side} perp on ${symbol} for me: ${size} ${symbol} at ${leverage}x leverage; show me the margin, the liquidation price and the fees first, run it only after I confirm, then protect the position with a stop-loss.`
}

function AmountField({
  id,
  label,
  max,
  onChange,
  presets,
  value
}: {
  id: string
  label: string
  max: null | number
  onChange: (text: string) => void
  presets?: readonly string[]
  value: string
}) {
  return (
    <div className="e-field">
      <label className="e-field__label" htmlFor={id}>
        {label}
      </label>
      <input
        autoFocus
        className="e-input"
        id={id}
        inputMode="decimal"
        max={max ?? undefined}
        min="0"
        onChange={event => onChange(event.target.value)}
        placeholder="0.00"
        step="any"
        type="number"
        value={value}
      />
      {presets ? (
        <div aria-label="Amount presets" className="hl-fund__presets" role="group">
          {presets.map(preset => (
            <button
              aria-pressed={value === preset}
              className={value === preset ? 'e-chip e-chip--on' : 'e-chip'}
              key={preset}
              onClick={() => onChange(preset)}
              type="button"
            >
              {preset}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function Footer({ agentName, disabled, onCancel }: { agentName: string; disabled: boolean; onCancel: () => void }) {
  return (
    <div className="hl-fund__actions">
      <Action kind="quiet" onClick={onCancel}>
        Cancel
      </Action>
      <button className="e-btn e-btn--primary" disabled={disabled} type="submit">
        Ask {agentName}
      </button>
    </div>
  )
}

/** The brief leaves on submit only — the composer sees nothing before Ask. */
function submitting(brief: null | string, onSubmit: (brief: string) => void) {
  return (event: React.FormEvent) => {
    event.preventDefault()

    if (brief !== null) {
      onSubmit(brief)
    }
  }
}

export const FundForm = memo(function FundForm({
  agentName,
  kind,
  max,
  onCancel,
  onSubmit
}: {
  agentName: string
  kind: FundKind
  /** The withdrawable balance for a withdrawal; null when the ceiling is not known here. */
  max: null | number
  onCancel: () => void
  onSubmit: (brief: string) => void
}) {
  const [amount, setAmount] = useState('')
  const [chain, setChain] = useState<FundChain>('Base')
  const value = fundAmount(amount, max)
  const chainId = `hl-fund-${kind}-chain`

  return (
    <form className="hl-fund" onSubmit={submitting(value === null ? null : fundBrief(kind, value, chain), onSubmit)}>
      <SectionTitle>{kind === 'deposit' ? 'Deposit USDC' : 'Withdraw USDC'}</SectionTitle>
      <AmountField
        id={`hl-fund-${kind}-amount`}
        label={`Amount (USDC)${max === null ? '' : ` · up to ${usd(max)}`}`}
        max={max}
        onChange={setAmount}
        presets={USDC_PRESETS}
        value={amount}
      />
      <div className="e-field">
        <label className="e-field__label" htmlFor={chainId}>
          {kind === 'deposit' ? 'From chain' : 'To chain'}
        </label>
        <select
          className="e-select"
          id={chainId}
          onChange={event => setChain(event.target.value as FundChain)}
          value={chain}
        >
          {FUND_CHAINS.map(option => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
      <Footer agentName={agentName} disabled={value === null} onCancel={onCancel} />
    </form>
  )
})

export const BuyForm = memo(function BuyForm({
  agentName,
  onCancel,
  onSubmit,
  symbol
}: {
  agentName: string
  onCancel: () => void
  onSubmit: (brief: string) => void
  symbol: string
}) {
  const [amount, setAmount] = useState('')
  const value = fundAmount(amount, null)

  return (
    <form className="hl-fund" onSubmit={submitting(value === null ? null : buyBrief(symbol, value), onSubmit)}>
      <SectionTitle>Buy {symbol}</SectionTitle>
      <AmountField
        id="hl-buy-amount"
        label="Spend (USDC)"
        max={null}
        onChange={setAmount}
        presets={USDC_PRESETS}
        value={amount}
      />
      <Footer agentName={agentName} disabled={value === null} onCancel={onCancel} />
    </form>
  )
})

export const PerpForm = memo(function PerpForm({
  agentName,
  onCancel,
  onSubmit,
  symbol
}: {
  agentName: string
  onCancel: () => void
  onSubmit: (brief: string) => void
  symbol: string
}) {
  const [side, setSide] = useState<PerpSide>('long')
  const [size, setSize] = useState('')
  const [leverage, setLeverage] = useState<string>('1')
  const value = fundAmount(size, null)
  const brief = value === null ? null : perpBrief(symbol, side, value, Number(leverage))

  return (
    <form className="hl-fund" onSubmit={submitting(brief, onSubmit)}>
      <SectionTitle>Open perp on {symbol}</SectionTitle>
      <div className="e-field">
        <label className="e-field__label" htmlFor="hl-perp-side">
          Side
        </label>
        <select
          className="e-select"
          id="hl-perp-side"
          onChange={event => setSide(event.target.value as PerpSide)}
          value={side}
        >
          <option value="long">Long</option>
          <option value="short">Short</option>
        </select>
      </div>
      <AmountField id="hl-perp-size" label={`Size (${symbol})`} max={null} onChange={setSize} value={size} />
      <div className="e-field">
        <label className="e-field__label" htmlFor="hl-perp-leverage">
          Leverage
        </label>
        <select
          className="e-select"
          id="hl-perp-leverage"
          onChange={event => setLeverage(event.target.value)}
          value={leverage}
        >
          {LEVERAGES.map(option => (
            <option key={option} value={option}>
              {option}×
            </option>
          ))}
        </select>
      </div>
      <Footer agentName={agentName} disabled={brief === null} onCancel={onCancel} />
    </form>
  )
})
