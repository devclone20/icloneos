/**
 * EconomyOS — Wallet · the three forms: Top up, Send, Compute top-up.
 *
 * Each owns its fields, so a keystroke re-renders the form and nothing else
 * — not the rail, not the stats, not a single asset row. Submitting hands one
 * ready brief to the iNFT (handoff.ts); the apps never move value themselves.
 */
import { memo, useCallback, useMemo, useState } from 'react'

import type { AcpFailure } from '../cli'
import { tokenAmount, usd } from '../format'
import { Action, Empty, SectionTitle } from '../ui'

import { chainsForFamily } from './receive-data'
import {
  addressFamily,
  amountEcho,
  computeTopUpBrief,
  isPlausibleAddress,
  isTopUpMethod,
  plainAmount,
  sendBrief,
  sendProblem,
  tokenDisambiguator,
  topUpBrief,
  type TopUpMethod
} from './wallet-briefs'
import type { WalletChain, WalletToken } from './wallet-data'

const TOP_UP_PRESETS = ['10', '25', '50', '100'] as const
const COMPUTE_PRESETS = ['10', '20', '50'] as const
const BASE: WalletChain = { id: 8453, name: 'Base', family: 'evm' }

function Presets({
  label,
  onPick,
  value,
  values
}: {
  label: string
  onPick: (value: string) => void
  value: string
  values: readonly string[]
}) {
  return (
    <div aria-label={label} className="wallet-presets" role="group">
      {values.map(preset => (
        <button
          aria-pressed={value === preset}
          className={value === preset ? 'wallet-preset wallet-preset--on' : 'wallet-preset'}
          key={preset}
          onClick={() => onPick(preset)}
          type="button"
        >
          ${preset}
        </button>
      ))}
    </div>
  )
}

// ── top up ──────────────────────────────────────────────────────────────────

export const TopUpForm = memo(function TopUpForm({
  agentName,
  chains,
  chainsError,
  onRetryChains,
  onSubmit
}: {
  agentName: string
  chains: readonly WalletChain[]
  /** The chain list could not be read — the form falls back to Base and says so. */
  chainsError: AcpFailure | null
  onRetryChains: () => void
  onSubmit: (brief: string) => void
}) {
  const [method, setMethod] = useState<TopUpMethod>('coinbase')
  const [chainId, setChainId] = useState(String(BASE.id))
  const [amount, setAmount] = useState('25')

  const listedEvm = useMemo(() => chainsForFamily(chains, 'evm').filter(chain => chain.id > 0), [chains])
  const evmChains = listedEvm.length > 0 ? listedEvm : [BASE]

  // The list may land after a choice was made; never submit a chain it lacks.
  const chainValue = evmChains.some(chain => String(chain.id) === chainId) ? chainId : String(evmChains[0].id)
  const brief = topUpBrief({ amount, chainId: Number(chainValue), method })
  const echo = amountEcho(amount, usd)

  const submit = useCallback(() => {
    if (brief) {
      onSubmit(brief)
    }
  }, [brief, onSubmit])

  return (
    <>
      <SectionTitle>Top up wallet</SectionTitle>
      <div className="e-pad wallet-form">
        <div className="wallet-form__row">
          <div className="e-field">
            <label className="e-field__label" htmlFor="wallet-topup-method">
              Method
            </label>
            <select
              className="e-select"
              id="wallet-topup-method"
              onChange={event => setMethod(isTopUpMethod(event.target.value) ? event.target.value : 'coinbase')}
              value={method}
            >
              <option value="coinbase">Coinbase</option>
              <option value="card">Card</option>
            </select>
          </div>
          <div className="e-field">
            <label className="e-field__label" htmlFor="wallet-topup-chain">
              Chain
            </label>
            <select
              className="e-select"
              id="wallet-topup-chain"
              onChange={event => setChainId(event.target.value)}
              value={chainValue}
            >
              {evmChains.map(chain => (
                <option key={chain.id} value={String(chain.id)}>
                  {chain.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {chainsError && listedEvm.length === 0 ? (
          <p className="wallet-form__hint" role="status">
            Chain list unavailable — Base assumed.{' '}
            <Action kind="quiet" onClick={onRetryChains}>
              Try again
            </Action>
          </p>
        ) : null}
        <div className="e-field">
          <label className="e-field__label" htmlFor="wallet-topup-amount">
            Amount (USD)
          </label>
          <input
            className="e-input"
            id="wallet-topup-amount"
            inputMode="decimal"
            onChange={event => setAmount(event.target.value)}
            placeholder="25"
            value={amount}
          />
          <Presets label="Quick amounts" onPick={setAmount} value={amount} values={TOP_UP_PRESETS} />
        </div>
        {amount.trim() && !brief ? (
          <p className="wallet-form__hint wallet-form__hint--error">Enter an amount above zero.</p>
        ) : echo ? (
          <p className="wallet-form__hint">= {echo}</p>
        ) : null}
        <Action disabled={!brief} kind="primary" onClick={submit}>
          Ask {agentName} to top up
        </Action>
        <p className="wallet-form__hint">
          Opens a payment flow the owner completes — the iNFT never holds card details.
        </p>
      </div>
    </>
  )
})

// ── send ────────────────────────────────────────────────────────────────────

/** Tickers held more than once (case-insensitively) — those options carry
 *  their contract so a real and a look-alike token never read the same. */
function duplicatedSymbols(tokens: readonly WalletToken[]): Set<string> {
  const seen = new Set<string>()
  const duplicated = new Set<string>()

  for (const token of tokens) {
    const symbol = token.symbol.toUpperCase()

    if (seen.has(symbol)) {
      duplicated.add(symbol)
    }

    seen.add(symbol)
  }

  return duplicated
}

export const SendForm = memo(function SendForm({
  agentName,
  onSubmit,
  onTopUp,
  tokens
}: {
  agentName: string
  onSubmit: (brief: string) => void
  onTopUp: () => void
  /** Anything with a spendable balance, on every chain. */
  tokens: readonly WalletToken[]
}) {
  const [tokenKey, setTokenKey] = useState('')
  const [amount, setAmount] = useState('')
  const [address, setAddress] = useState('')

  const duplicated = useMemo(() => duplicatedSymbols(tokens), [tokens])
  const token = tokens.find(candidate => candidate.key === tokenKey) ?? null
  const draft = { address, amount, token }
  const problem = sendProblem(draft)
  const brief = problem === null ? sendBrief(draft) : null
  const family = token ? addressFamily(token.network) : 'evm'

  const amountHint =
    token && amount.trim()
      ? problem === 'amount'
        ? 'Enter an amount above zero.'
        : problem === 'exceeds'
          ? `Only ${tokenAmount(token.amount)} ${token.symbol} available.`
          : null
      : null

  const echo = token && !amountHint ? amountEcho(amount, value => `${tokenAmount(value)} ${token.symbol}`) : null

  const addressHint =
    address.trim() && !isPlausibleAddress(address, family)
      ? family === 'solana'
        ? 'A Solana address is 32–44 base58 characters.'
        : 'An EVM address is 0x followed by 40 hex characters.'
      : null

  const submit = useCallback(() => {
    if (brief) {
      onSubmit(brief)
    }
  }, [brief, onSubmit])

  const useMax = useCallback(() => {
    if (token) {
      setAmount(plainAmount(token.amount))
    }
  }, [token])

  if (tokens.length === 0) {
    return (
      <>
        <SectionTitle>Send</SectionTitle>
        <Empty
          action={
            <Action kind="primary" onClick={onTopUp}>
              Top up
            </Action>
          }
          hint="Nothing to send yet — fund the wallet first."
          title="No funded tokens"
        />
      </>
    )
  }

  return (
    <>
      <SectionTitle>Send</SectionTitle>
      <div className="e-pad wallet-form">
        <div className="e-field">
          <label className="e-field__label" htmlFor="wallet-send-token">
            Token
          </label>
          <select
            className="e-select"
            id="wallet-send-token"
            onChange={event => setTokenKey(event.target.value)}
            value={tokenKey}
          >
            <option value="">Select a token</option>
            {tokens.map(candidate => (
              <option key={candidate.key} value={candidate.key}>
                {candidate.symbol}
                {duplicated.has(candidate.symbol.toUpperCase()) ? ` (${tokenDisambiguator(candidate)})` : ''} ·{' '}
                {candidate.chainLabel} · {tokenAmount(candidate.amount)}
              </option>
            ))}
          </select>
        </div>
        <div className="e-field">
          <div className="wallet-form__labels">
            <label className="e-field__label" htmlFor="wallet-send-amount">
              Amount
            </label>
            {token ? (
              <Action kind="quiet" onClick={useMax}>
                Max · {tokenAmount(token.amount)}
              </Action>
            ) : null}
          </div>
          <input
            aria-invalid={amountHint ? true : undefined}
            className="e-input"
            id="wallet-send-amount"
            inputMode="decimal"
            onChange={event => setAmount(event.target.value)}
            placeholder="0.00"
            value={amount}
          />
          {amountHint ? (
            <p className="wallet-form__hint wallet-form__hint--error">{amountHint}</p>
          ) : echo ? (
            <p className="wallet-form__hint">= {echo}</p>
          ) : null}
        </div>
        <div className="e-field">
          <label className="e-field__label" htmlFor="wallet-send-address">
            Recipient address
          </label>
          <input
            aria-invalid={addressHint ? true : undefined}
            className="e-input"
            id="wallet-send-address"
            onChange={event => setAddress(event.target.value)}
            placeholder={family === 'solana' ? 'Solana address' : '0x…'}
            spellCheck={false}
            value={address}
          />
          {addressHint ? <p className="wallet-form__hint wallet-form__hint--error">{addressHint}</p> : null}
        </div>
        <Action disabled={!brief} kind="primary" onClick={submit}>
          Ask {agentName} to send
        </Action>
        <p className="wallet-form__hint">
          {agentName} dry-runs the transfer under the signer policy and reports back before anything moves.
        </p>
      </div>
    </>
  )
})

// ── compute top-up ──────────────────────────────────────────────────────────

export const ComputeTopUpForm = memo(function ComputeTopUpForm({ onSubmit }: { onSubmit: (brief: string) => void }) {
  const [amount, setAmount] = useState('20')
  const brief = computeTopUpBrief(amount)
  const echo = amountEcho(amount, usd)

  const submit = useCallback(() => {
    if (brief) {
      onSubmit(brief)
    }
  }, [brief, onSubmit])

  return (
    <div className="wallet-compute__form">
      <div className="e-field">
        <label className="e-field__label" htmlFor="wallet-compute-topup-amount">
          Amount (USD)
        </label>
        <input
          className="e-input"
          id="wallet-compute-topup-amount"
          inputMode="decimal"
          onChange={event => setAmount(event.target.value)}
          placeholder="20"
          value={amount}
        />
        {echo ? <p className="wallet-form__hint">= {echo}</p> : null}
      </div>
      <Presets label="Quick amounts" onPick={setAmount} value={amount} values={COMPUTE_PRESETS} />
      <Action disabled={!brief} kind="primary" onClick={submit}>
        Top up compute
      </Action>
    </div>
  )
})
