import './ownership.css'

import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { type JSX, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { APP_INTL_LOCALE } from '@/iclone-shared/app-intl-locale'

import { deleteInftProfile, setPersonaDeactivation } from './inft-profile'
import {
  $ownership,
  applyViews,
  DEACTIVATED_LABEL,
  deactivationCountdown,
  type OwnerChoice,
  type OwnershipView,
  shortAddress
} from './ownership'
import { $activeInft } from './stage-store'

/** The slug whose owner dialog is open — Settings → iNFT reopens it. */
export const $ownershipDialogSlug = atom<string | null>(null)

// "Decide later" closes the question for this app session only (§4.5).
const snoozed = new Set<string>()

const OPTIONS: { choice: OwnerChoice; title: string; body: string; destructive?: boolean }[] = [
  {
    choice: 'delete',
    title: 'Delete everything, no copy',
    body: 'Hermes profile, memory, sessions, ACP setup, notes and snapshots. Never your keychain sign-in.',
    destructive: true
  },
  {
    choice: 'archive-local',
    title: 'Keep a git copy on this Mac, then delete',
    body: '~/iclone-os-archive/<iNFT>/ — README, MANIFEST with the transfer, secrets removed.',
    destructive: true
  },
  {
    choice: 'archive-github',
    title: 'Keep a copy on GitHub, then delete',
    body: 'Same archive, pushed to a private repository with your own GitHub CLI (gh). The app never stores a GitHub token.',
    destructive: true
  },
  {
    choice: 'keep',
    title: "Keep the agent's memory in the app",
    body: 'Nothing is deleted. The iNFT stays Deactivated: read-only, no economy.'
  },
  {
    choice: 'later',
    title: 'Decide later',
    body: 'Same as keeping, until you come back — Settings → iNFT shows the notice.'
  }
]

export function transferLine(view: OwnershipView): string {
  const t = view.transfer

  if (!t) {
    return ''
  }

  const when = new Date(t.timestamp * 1000).toLocaleString(APP_INTL_LOCALE)

  return `Transferred ${when} (block ${t.block.toLocaleString(APP_INTL_LOCALE)}) from ${shortAddress(t.from)} to ${shortAddress(t.to)}.`
}

function personaNotice(view: OwnershipView): string | null {
  return view.state === 'lost' && view.transfer
    ? `transferred at block ${view.transfer.block}, tx ${view.transfer.txHash}`
    : null
}

function OwnershipDialog({ view, onClose }: { view: OwnershipView; onClose: () => void }): JSX.Element {
  const [pick, setPick] = useState<OwnerChoice | null>(view.presale ? 'delete' : null)
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const needsConfirm = pick === 'delete' || pick === 'archive-local' || pick === 'archive-github'
  const token = `#${view.tokenId}`

  const run = async () => {
    const bridge = window.hermesDesktop?.icloneOwnership

    if (!pick || !bridge) {
      return
    }

    setBusy(true)
    setError(null)

    try {
      const res = await bridge.choose(view.slug, pick, confirm)

      if (!res.ok) {
        setError(res.error ?? 'Nothing was changed.')

        return
      }

      if (res.view) {
        applyViews([res.view])
      }

      if (res.deleteHermesProfile) {
        await deleteInftProfile(view.profileSlug).catch(() => undefined)
      }

      if (pick === 'later') {
        snoozed.add(view.slug)
      }

      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog onOpenChange={open => !open && !busy && onClose()} open>
      <DialogContent className="ownership-dialog">
        <DialogHeader>
          <DialogTitle>The iNFT agent {token} is no longer in your crypto wallet.</DialogTitle>
          <DialogDescription>
            {transferLine(view)}{' '}
            {view.transfer && (
              <a className="ownership-link" href={view.transfer.explorerUrl} rel="noreferrer" target="_blank">
                tx {shortAddress(view.transfer.txHash)} · view in explorer
              </a>
            )}
          </DialogDescription>
        </DialogHeader>
        <p className="ownership-dialog__signal">
          <span className="ownership-pill">{DEACTIVATED_LABEL}</span> {deactivationCountdown(view)}
        </p>
        {view.presale && (
          <p className="text-xs text-(--dt-muted-foreground)">
            Prepared to sell on {new Date(view.presale.at).toLocaleDateString(APP_INTL_LOCALE)} — copy at{' '}
            {view.presale.archive}. Recommended: delete what remains.
          </p>
        )}
        <p className="text-sm">Delete everything about the iNFT agent {token}?</p>
        <div className="ownership-dialog__options" role="radiogroup">
          {OPTIONS.map(o => (
            <button
              aria-checked={pick === o.choice}
              className="ownership-option"
              data-picked={pick === o.choice}
              key={o.choice}
              onClick={() => setPick(o.choice)}
              role="radio"
              type="button"
            >
              <span className="text-sm font-medium">{o.title}</span>
              <span className="text-xs text-(--dt-muted-foreground)">{o.body}</span>
            </button>
          ))}
        </div>
        {needsConfirm && (
          <input
            aria-label={`Type ${token} to confirm`}
            className="ownership-confirm"
            onChange={e => setConfirm(e.target.value)}
            placeholder={`Type ${token} to confirm`}
            value={confirm}
          />
        )}
        {error && <p className="text-xs text-(--ic-home-danger-88)">{error}</p>}
        <p className="text-xs text-(--dt-muted-foreground)">
          Problem? Contact the developer only through the{' '}
          <a className="ownership-link" href={view.supportUrl} rel="noreferrer" target="_blank">
            cloneframe.io support form
          </a>
          .
        </p>
        <DialogFooter>
          <Button disabled={busy} onClick={onClose} variant="ghost">
            Not now
          </Button>
          <Button disabled={busy || !pick || (needsConfirm && confirm.trim() !== token)} onClick={() => void run()}>
            {busy ? 'Working…' : 'Confirm'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Mounted once (with the iNFT tab): asks the owner about a proven loss and
 *  keeps every persona's prompt header in step with the guard. */
export function OwnershipDialogHost(): JSX.Element | null {
  const map = useStore($ownership)
  const forced = useStore($ownershipDialogSlug)
  const [dismissed, setDismissed] = useState<string | null>(null)

  useEffect(() => {
    for (const view of Object.values(map)) {
      void setPersonaDeactivation(view.profileSlug, personaNotice(view))
    }
  }, [map])

  const view = useMemo(() => {
    if (forced && map[forced]?.state === 'lost') {
      return map[forced]
    }

    return (
      Object.values(map).find(v => v.state === 'lost' && !v.choice && !snoozed.has(v.slug) && v.slug !== dismissed) ??
      null
    )
  }, [map, forced, dismissed])

  if (!view) {
    return null
  }

  return (
    <OwnershipDialog
      key={view.slug}
      onClose={() => {
        setDismissed(view.slug)
        $ownershipDialogSlug.set(null)
      }}
      view={view}
    />
  )
}

/** The label over the 3D model when the summoned iNFT is deactivated. */
export function StageDeactivatedLabel(): JSX.Element | null {
  const map = useStore($ownership)
  const active = useStore($activeInft)
  const view = active ? Object.values(map).find(v => v.inftId === active.id) : undefined

  return view?.state === 'lost' ? (
    <div className="istage__deactivated" role="status">
      <span className="ownership-pill">{DEACTIVATED_LABEL}</span>
    </div>
  ) : null
}
