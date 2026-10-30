import './wallet-panel.css'

import { useStore } from '@nanostores/react'
import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Tip } from '@/components/ui/tooltip'

import { shortAddress } from './lib/format'
import { $walletBalances, type ChainBalanceRow, closeWalletPanel, openWalletPanel } from './wallet-balances'

/**
 * iCLONE OS — the frosted balances popover opened from the wallet titlebar
 * tool (wallet-tool.tsx; icon-only, no name — owner rule). Self-contained by
 * design: it owns its own Esc/outside-click close (a transparent full-screen
 * scrim, the same click-away idiom `SessionSwitcher` uses) so home-view.tsx's
 * shared stage-mode keydown handler — out of this feature's file ownership —
 * needs no change to support it.
 *
 * Anchored under the titlebar's right button cluster: `top:46px; right:14px`
 * clears it comfortably. Those coordinates match `.iwin-controls` in
 * home.css, but the two never render at once — this panel only shows in
 * STAGE mode (wallet signed in), where `.iwin-controls` (window mode's
 * traffic-light cluster) isn't in the DOM at all.
 */

interface WalletPanelProps {
  address: string
  onClose: () => void
  /** Optional sign-out hook — rendered as a quiet footer action. */
  onSignOut?: () => void
}

const SKELETON_ROW_COUNT = 7
const COPIED_RESET_MS = 1_400

function formatBalance(balance: string): string {
  const value = Number(balance)

  return Number.isFinite(value) ? value.toFixed(4) : '0.0000'
}

function ChainRow({ row }: { row: ChainBalanceRow }) {
  return (
    <div className="iwbal__row">
      <span aria-hidden className={row.ok ? 'iwbal__dot' : 'iwbal__dot iwbal__dot--err'} />
      <span className="iwbal__chain">{row.chain}</span>

      {row.ok ? (
        <span className="iwbal__balance">
          {formatBalance(row.balance)} <b className="iwbal__symbol">{row.symbol}</b>
        </span>
      ) : (
        <span className="iwbal__row-error" title={row.error ?? 'unavailable'}>
          unavailable
        </span>
      )}
    </div>
  )
}

export function WalletPanel({ address, onClose, onSignOut }: WalletPanelProps) {
  const state = useStore($walletBalances)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    openWalletPanel(address)

    return () => closeWalletPanel()
  }, [address])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }

      onClose()
    }

    window.addEventListener('keydown', onKeyDown)

    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  useEffect(() => {
    if (!copied) {
      return
    }

    const timer = setTimeout(() => setCopied(false), COPIED_RESET_MS)

    return () => clearTimeout(timer)
  }, [copied])

  const handleCopyAddress = () => {
    navigator.clipboard
      .writeText(address)
      .then(() => setCopied(true))
      .catch(() => {
        // Clipboard access denied/unavailable — copying is a convenience,
        // not something the panel depends on, so this fails silently.
      })
  }

  const showSkeleton = state.status === 'loading' && state.rows.length === 0
  const showEmpty = !showSkeleton && state.rows.length === 0

  return (
    <>
      <div className="iwbal-scrim" onMouseDown={onClose} />

      <div aria-label="wallet balances" className="iwbal" role="dialog">
        <header className="iwbal__head">
          <span className="iwbal__title">wallet</span>

          <Tip label={address}>
            <button className="iwbal__addr" onClick={handleCopyAddress} type="button">
              <span>{shortAddress(address)}</span>
              {copied ? (
                <Check aria-hidden size={11} strokeWidth={2} />
              ) : (
                <Copy aria-hidden size={11} strokeWidth={1.8} />
              )}
            </button>
          </Tip>
        </header>

        <div className="iwbal__rows">
          {showSkeleton &&
            Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => <div className="iwbal__skeleton" key={i} />)}

          {!showSkeleton && state.rows.map(row => <ChainRow key={row.key} row={row} />)}

          {showEmpty && <p className="iwbal__empty">{state.error ?? 'No balances yet.'}</p>}
        </div>

        <p className="iwbal__foot">balances refresh every 90s · public RPCs</p>
        {onSignOut && (
          <button className="iwbal__signout" onClick={onSignOut} type="button">
            sign out
          </button>
        )}
      </div>
    </>
  )
}
