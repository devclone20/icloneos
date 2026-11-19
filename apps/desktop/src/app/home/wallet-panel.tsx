import './wallet-panel.css'

import { useStore } from '@nanostores/react'
import { Check, ChevronRight, Copy, Info, RefreshCw } from 'lucide-react'
import type { CSSProperties, JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { IcAlert, IcConfirmDialog, IcPageButton } from '@/components/ic/ic-page'
import { Tip } from '@/components/ui/tooltip'
import { f5Wallet as copy } from '@/i18n/en/v009-f5'
import { notify } from '@/store/notifications'

import { IcloneHeadMark } from './iclone-head'
import { shortAddress } from './lib/format'
import {
  $walletBalances,
  type ChainBalanceRow,
  closeWalletPanel,
  formatBalance,
  nextAgeTickMs,
  openWalletPanel,
  partitionBalanceRows,
  refreshWalletBalances
} from './wallet-balances'

/**
 * iCLONE OS — the personal wallet popover, opened from the wallet titlebar tool (wallet-tool.tsx; icon only —
 * owner rule). v0.0.9 F5 contract (P0_DESIGN_SPECS.md "F5 · Carteira pessoal"):
 *
 *   - an opaque 360 px plate anchored under the wallet icon; focus is held inside while it is open, Esc and a
 *     click outside close it, and focus goes back to the wallet icon;
 *   - identity: the iCLONE head glyph, "Wallet", the address in mono (`0x12ab…9f3c`, the whole one in a Tip) and a
 *     real Copy button that says "Copied" or "Couldn't copy"; the account type only when the session knows it;
 *   - one flat list of networks: funded first, unavailable ones with their cause, zero-balance ones folded under
 *     "N networks with no balance"; "Updated N s ago · Refresh" (the 90 s loop stays);
 *   - "Sign out of wallet" asks first (IcConfirmDialog), then runs the existing logout, says "Signed out" and
 *     hands focus to the wallet icon.
 *
 * No fiat, no network switch, no send (lead decision D5). It owns its own Esc/outside-click close, so
 * home-view.tsx's stage keydown handler needs nothing for it.
 */

export type WalletAccountType = 'embedded' | 'external'

interface WalletPanelProps {
  /** Only when the session already knows it — the panel never asks for a new fact to fill this line. */
  accountType?: WalletAccountType
  address: string
  onClose: () => void
  /** The existing sign-out flow (home-view: hide the panel + logoutPrivy). Runs only after the confirm; resolves with
   *  main's answer so "Signed out" is said only when the saved session was really erased. */
  onSignOut?: SignOutRun
}

type CopyState = 'copied' | 'failed' | 'idle'

const SKELETON_ROW_COUNT = 4
const COPY_RESET_MS = { copied: 1_400, failed: 2_400 } as const
/** The titlebar wallet tool (shell/frame-tools.tsx stamps every tool button with its id). */
const WALLET_TOOL_SELECTOR = '[data-ic-frame-tool="iclone-wallet"]'
const ANCHOR_GAP_PX = 8
const VIEWPORT_MARGIN_PX = 12
const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

/** The wallet icon, or null when the titlebar is not in this window. */
function walletTool(): HTMLElement | null {
  return document.querySelector<HTMLElement>(WALLET_TOOL_SELECTOR)
}

const FOCUS_RETURN_FRAMES = 12

/** Hands focus back to the wallet icon. The titlebar tools are `inert` while our scrim is in the DOM
 *  (shell/frame-tools.tsx), and they wake a frame or two after it leaves — so try now, then on the next frames
 *  until the icon takes it. Focus the user put somewhere else in the meantime is never taken. */
export function returnFocusToWalletTool(frames = FOCUS_RETURN_FRAMES): void {
  const free = () => !document.activeElement || document.activeElement === document.body

  const attempt = (left: number) => {
    if (!free()) {
      return
    }

    walletTool()?.focus({ preventScroll: true })

    if (document.activeElement !== walletTool() && left > 0) {
      requestAnimationFrame(() => attempt(left - 1))
    }
  }

  attempt(frames)
}

/** Copies through the async clipboard; resolves false (never throws) when access is denied or absent. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) {
      return false
    }

    await navigator.clipboard.writeText(text)

    return true
  } catch {
    return false
  }
}

function ChainRow({ row }: { row: ChainBalanceRow }): JSX.Element {
  if (!row.ok) {
    const cause = copy.unavailableCause(row.chain, row.error)

    return (
      <li className="iwbal__row" data-state="unavailable">
        <span aria-hidden="true" className="iwbal__dot iwbal__dot--err" />
        <span className="iwbal__chain">{row.chain}</span>
        <span className="iwbal__unavailable">
          {copy.unavailable}
          <Tip label={cause}>
            <span aria-label={cause} className="iwbal__cause" role="img" tabIndex={0}>
              <Info aria-hidden="true" size={12} strokeWidth={1.8} />
            </span>
          </Tip>
        </span>
      </li>
    )
  }

  return (
    <li className="iwbal__row">
      <span aria-hidden="true" className="iwbal__dot" />
      <span className="iwbal__chain">{row.chain}</span>
      <span className="iwbal__balance">
        {formatBalance(row.balance)} <span className="iwbal__symbol">{row.symbol}</span>
      </span>
    </li>
  )
}

/** Seconds since `fetchedAt`, re-read only when the words it feeds can change (no 1 s re-render for an hour). */
function useSecondsSince(fetchedAt: null | number): null | number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (fetchedAt === null) {
      return
    }

    let timer = 0

    const tick = () => {
      const current = Date.now()

      setNow(current)
      timer = window.setTimeout(tick, nextAgeTickMs(Math.max(0, current - fetchedAt)))
    }

    tick()

    return () => window.clearTimeout(timer)
  }, [fetchedAt])

  return fetchedAt === null ? null : Math.max(0, Math.round((now - fetchedAt) / 1_000))
}

export interface SignOutAnswer {
  ok: boolean
  error?: string
}

/** The sign-out to run: main's answer (or nothing, for a caller with nothing to wait for). */
type SignOutResult = PromiseLike<SignOutAnswer> | SignOutAnswer | void
type SignOutRun = () => SignOutResult

/** Runs one sign-out and says how it ended (v0.0.9 critic m1): success only on main's `ok`; a failed erase is an error
 *  with the cause and a "Try again" that runs the same sign-out again. A caller that answers nothing keeps the old
 *  contract (no answer = nothing to wait for). Exported for the test. */
export async function reportSignOut(run: SignOutRun): Promise<SignOutAnswer> {
  let answer: SignOutAnswer

  try {
    answer = (await run()) ?? { ok: true }
  } catch (error) {
    answer = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  if (answer.ok) {
    notify({ kind: 'success', message: copy.signedOut })
  } else {
    notify({
      action: { label: copy.signOutRetry, onClick: () => void reportSignOut(run) },
      detail: answer.error,
      id: 'wallet-sign-out-failed',
      kind: 'error',
      message: copy.signOutFailedMessage,
      nextStep: copy.signOutFailedNext,
      title: copy.signOutFailedTitle
    })
  }

  return answer
}

export function WalletPanel({ accountType, address, onClose, onSignOut }: WalletPanelProps): JSX.Element {
  const state = useStore($walletBalances)
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const [zeroOpen, setZeroOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [anchor, setAnchor] = useState<CSSProperties | undefined>(undefined)
  const panelRef = useRef<HTMLDivElement>(null)
  const copyRef = useRef<HTMLButtonElement>(null)
  const seconds = useSecondsSince(state.fetchedAt)

  useEffect(() => {
    openWalletPanel(address)

    return () => closeWalletPanel()
  }, [address])

  // Anchored on the wallet icon: right-aligned with it, just under it. Without the titlebar (a test, a
  // secondary window) the stylesheet's resting place under the right button cluster stands.
  useLayoutEffect(() => {
    const rect = walletTool()?.getBoundingClientRect()

    if (!rect || rect.width === 0) {
      return
    }

    setAnchor({
      right: Math.max(VIEWPORT_MARGIN_PX, window.innerWidth - rect.right),
      top: rect.bottom + ANCHOR_GAP_PX
    })
  }, [])

  // Focus enters on Copy (the first thing a keyboard user can do) and goes back to the wallet icon when the
  // popover leaves with focus inside it — Esc, outside click, sign-out. Focus the user moved elsewhere stays.
  useEffect(() => {
    copyRef.current?.focus({ preventScroll: true })

    return () => returnFocusToWalletTool()
  }, [])

  // Esc closes the popover — but while the sign-out question is up, Esc belongs to it (IcDialog answers first,
  // in the capture phase); one cancel gesture does one thing.
  const confirmOpenRef = useRef(confirmOpen)

  confirmOpenRef.current = confirmOpen

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || confirmOpenRef.current) {
        return
      }

      onClose()
    }

    window.addEventListener('keydown', onKeyDown)

    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  useEffect(() => {
    if (copyState === 'idle') {
      return
    }

    const timer = window.setTimeout(() => setCopyState('idle'), COPY_RESET_MS[copyState])

    return () => window.clearTimeout(timer)
  }, [copyState])

  const handleCopy = useCallback(() => {
    void writeClipboard(address).then(ok => setCopyState(ok ? 'copied' : 'failed'))
  }, [address])

  // Tab and Shift+Tab cycle inside the plate while it is open (the dialog keeps its own cycle when it is up).
  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || confirmOpenRef.current) {
      return
    }

    const nodes = [...(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]

    if (nodes.length === 0) {
      return
    }

    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    const active = document.activeElement

    if (event.shiftKey && (active === first || !panelRef.current?.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !panelRef.current?.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }, [])

  const confirmSignOut = useCallback(async () => {
    if (onSignOut) {
      await reportSignOut(onSignOut)
    }
  }, [onSignOut])

  const loading = state.rows.length === 0 && (state.status === 'loading' || state.status === 'idle')
  const failed = state.status === 'error'
  const { funded, unavailable, zero } = partitionBalanceRows(state.rows)

  const accountLine =
    accountType === 'embedded' ? copy.accountEmbedded : accountType === 'external' ? copy.accountExternal : null

  return (
    <>
      <div aria-hidden="true" className="iwbal-scrim" onMouseDown={onClose} />

      <div
        aria-label={copy.dialogLabel}
        aria-modal="true"
        className="iwbal"
        onKeyDown={handleKeyDown}
        ref={panelRef}
        role="dialog"
        style={anchor}
      >
        <header className="iwbal__id">
          <IcloneHeadMark className="iwbal__mark" />
          <div className="iwbal__who">
            <span className="iwbal__title">{copy.title}</span>
            <Tip label={address}>
              <span className="iwbal__addr" data-testid="wallet-address">
                {shortAddress(address)}
              </span>
            </Tip>
            {accountLine ? <span className="iwbal__kind">{accountLine}</span> : null}
          </div>
          <button
            aria-label={copy.copyAddress}
            className="iwbal__copy"
            data-state={copyState}
            onClick={handleCopy}
            ref={copyRef}
            type="button"
          >
            {copyState === 'copied' ? (
              <Check aria-hidden="true" size={12} strokeWidth={2} />
            ) : (
              <Copy aria-hidden="true" size={12} strokeWidth={1.8} />
            )}
            <span>{copyState === 'copied' ? copy.copied : copyState === 'failed' ? copy.copyFailed : copy.copy}</span>
          </button>
        </header>

        {/* The copy verdict, said to assistive tech as well as shown on the button. */}
        <span aria-live="polite" className="iwbal__sr" role="status">
          {copyState === 'copied' ? copy.copied : copyState === 'failed' ? copy.copyFailed : ''}
        </span>

        {/* v0.0.9 r4 (design r3 N6): ONE Retry, inside the alert that names the cause; the footer's Refresh steps
            aside while it shows, so the error offers its action once. */}
        {failed ? (
          <div className="iwbal__alert">
            <IcAlert action={{ label: copy.retry, onClick: () => void refreshWalletBalances() }} title={copy.failed}>
              {state.error ?? copy.failedCause}
            </IcAlert>
          </div>
        ) : null}

        <ul aria-busy={loading || undefined} aria-label={copy.networks} className="iwbal__rows">
          {loading
            ? Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
                <li aria-hidden="true" className="iwbal__skeleton" key={i} />
              ))
            : null}

          {funded.map(row => (
            <ChainRow key={row.key} row={row} />
          ))}
          {unavailable.map(row => (
            <ChainRow key={row.key} row={row} />
          ))}

          {zero.length > 0 ? (
            <li className="iwbal__fold-row">
              <button
                aria-expanded={zeroOpen}
                className="iwbal__fold"
                onClick={() => setZeroOpen(open => !open)}
                type="button"
              >
                <span>{copy.zeroNetworks(zero.length)}</span>
                <ChevronRight aria-hidden="true" className="iwbal__chevron" size={12} strokeWidth={2} />
              </button>
            </li>
          ) : null}
          {zeroOpen ? zero.map(row => <ChainRow key={row.key} row={row} />) : null}
        </ul>

        {seconds !== null || !failed ? (
        <footer className="iwbal__foot">
          {seconds !== null ? <span className="iwbal__updated">{copy.updated(seconds)}</span> : null}
          {seconds !== null && !failed ? (
            <span aria-hidden="true" className="iwbal__sep">
              ·
            </span>
          ) : null}
          {failed ? null : (
            <button
            className="iwbal__refresh"
            data-busy={state.status === 'loading' || undefined}
            disabled={state.status === 'loading'}
            onClick={() => void refreshWalletBalances()}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={11} strokeWidth={2} />
            {copy.refresh}
          </button>
          )}
        </footer>
        ) : null}

        {onSignOut ? (
          <div className="iwbal__signout">
            <IcPageButton onClick={() => setConfirmOpen(true)} tone="danger">
              {copy.signOut}
            </IcPageButton>
          </div>
        ) : null}

        {/* Inside the plate on purpose: it shares the wallet's layer (above the scrim), and the plate carries no
            transform or filter at rest, so the dialog's fixed overlay still spans the viewport. */}
        <IcConfirmDialog
          busyLabel={copy.confirmBusy}
          cancelLabel={copy.confirmCancel}
          confirmLabel={copy.confirmAction}
          description={copy.confirmBody}
          doneLabel={copy.confirmDone}
          errorFallback={copy.confirmError}
          onClose={() => setConfirmOpen(false)}
          onConfirm={confirmSignOut}
          open={confirmOpen}
          title={copy.confirmTitle}
          tone="danger"
        />
      </div>
    </>
  )
}
