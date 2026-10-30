import '../home/ownership.css'

import { useStore } from '@nanostores/react'
import { type JSX, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { APP_INTL_LOCALE } from '@/iclone-shared/app-intl-locale'

import { $ownership, applyViews, DEACTIVATED_LABEL, deactivationCountdown, type OwnershipView } from '../home/ownership'
import { $ownershipDialogSlug, transferLine } from '../home/ownership-dialog'

import { type InftPaneCopy, useInftPaneCopy } from './inft-setup-copy'
import { SettingRow } from './setting-row'

type RowCopy = InftPaneCopy['ownershipRow']

function stateLabel(view: OwnershipView, copy: RowCopy): string {
  if (view.state === 'lost') {
    return DEACTIVATED_LABEL
  }

  if (view.pending) {
    return copy.confirming
  }

  return view.state === 'held' ? copy.held : copy.notConfirmed
}

function OwnershipRow({ view }: { view: OwnershipView }): JSX.Element {
  const copy = useInftPaneCopy().ownershipRow
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [checklist, setChecklist] = useState(false)
  const bridge = window.hermesDesktop?.icloneOwnership

  const prepare = async (github: boolean) => {
    if (!bridge) {
      return
    }

    setBusy(true)
    setMessage(null)

    try {
      if (github) {
        const gh = await bridge.ghStatus()

        if (!gh.ok) {
          setMessage(copy.ghSignedOut)

          return
        }
      }

      const res = await bridge.prepareSell(view.slug, github)

      if (res.view) {
        applyViews([res.view])
      }

      if (!res.ok) {
        setMessage(res.error ?? copy.nothingChanged)

        return
      }

      // Design §5 step 2: R6's Detach door cleans the local setup after the copy.
      const detached = await window.hermesDesktop?.icloneAcp?.detach(view.inftId)

      if (!detached?.ok) {
        setMessage(copy.copyNotDetached(res.view?.presale?.archive ?? '', detached?.error ?? copy.setupUnavailable))

        return
      }

      const after = await bridge.presaleDetached(view.slug, detached.removed.length)

      if (after) {
        applyViews([after])
      }

      setChecklist(true)
      setMessage(copy.copyDetached(res.view?.presale?.archive ?? ''))
    } finally {
      setBusy(false)
    }
  }

  const recheck = async () => {
    if (!bridge) {
      return
    }

    setBusy(true)

    try {
      const v = await bridge.recheck(view.slug)

      if (v) {
        applyViews([v])
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-ownership-slug={view.slug}>
      <SettingRow
        below={
          <>
            <div className="mt-1 flex flex-wrap items-center gap-2" data-ownership-actions>
              {view.state === 'lost' ? (
                <Button disabled={busy} onClick={() => void recheck()} size="sm" type="button" variant="outline">
                  {copy.recheck}
                </Button>
              ) : (
                <>
                  <Button disabled={busy} onClick={() => void prepare(false)} size="sm" type="button" variant="outline">
                    {copy.sellHere}
                  </Button>
                  <Button disabled={busy} onClick={() => void prepare(true)} size="sm" type="button" variant="outline">
                    {copy.sellGithub}
                  </Button>
                </>
              )}
              <Button onClick={() => setOpen(o => !o)} size="sm" type="button" variant="outline">
                {open ? copy.hideHistory : copy.showHistory}
              </Button>
            </div>
            {message && (
              <div className="mt-1 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ic-text-2)">
                {message}
              </div>
            )}
            {(checklist || Boolean(view.presale?.detachedAt)) && view.state !== 'lost' && (
              <ul
                className="mt-1 grid list-disc gap-1 pl-5 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ic-text-2)"
                data-presale-checklist
              >
                {[copy.checklist.signer, copy.checklist.deny, copy.checklist.balance].map(item => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
            {open && (
              <ul className="mt-1 grid gap-1 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ic-text-2)">
                {view.verifications.map(v => (
                  <li key={v.source}>
                    {v.source}:{' '}
                    {v.ok
                      ? v.heldByWallet
                        ? copy.yourWallet
                        : copy.heldBy(v.holder ?? copy.anotherWallet)
                      : copy.noAnswer}
                    {v.block !== null ? ` · ${copy.block(String(v.block))}` : ''}
                    {v.txHash ? ` · tx ${v.txHash.slice(0, 10)}…` : ''} · {v.detail}
                  </li>
                ))}
                {view.history
                  .slice()
                  .reverse()
                  .map(h => (
                    <li key={`${h.at}-${h.note}`}>
                      {new Date(h.at).toLocaleString(APP_INTL_LOCALE)} — {h.note}
                    </li>
                  ))}
              </ul>
            )}
          </>
        }
        control={
          // One control at the trailing edge keeps the title column wide; the other actions sit under the hint.
          view.state === 'lost' ? (
            <Button onClick={() => $ownershipDialogSlug.set(view.slug)} size="sm" type="button" variant="outline">
              {view.choice ? copy.change : copy.decide}
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => void recheck()} size="sm" type="button" variant="outline">
              {copy.recheck}
            </Button>
          )
        }
        hint={
          view.state === 'lost' ? (
            <>
              {transferLine(view)} {deactivationCountdown(view)}.{' '}
              {view.transfer && (
                <a className="ownership-link" href={view.transfer.explorerUrl} rel="noreferrer" target="_blank">
                  {copy.viewTransfer}
                </a>
              )}
            </>
          ) : (
            stateLabel(view, copy)
          )
        }
        title={
          <>
            {view.name} · #{view.tokenId}
            {view.state === 'lost' && <span className="ownership-pill ml-2">{DEACTIVATED_LABEL}</span>}
          </>
        }
      />
    </div>
  )
}

/** Settings → iNFT → Ownership: the guard's records, the countdown, the
 *  owner's choice, Prepare to sell and the ownership history. */
export function InftOwnershipSection(): JSX.Element {
  const map = useStore($ownership)
  const views = Object.values(map)
  const copy = useInftPaneCopy().ownershipRow
  const [registry, setRegistry] = useState<null | { contracts: number; origin: string; version: string }>(null)

  useEffect(() => {
    const bridge = window.hermesDesktop?.icloneOwnership

    if (!bridge) {
      return
    }

    void bridge
      .list()
      .then(applyViews)
      .catch(() => undefined)
    void bridge
      .registry()
      .then(r => setRegistry({ contracts: r.contracts, origin: r.origin, version: String(r.version) }))
      .catch(() => undefined)
  }, [])

  return (
    <>
      {views.length === 0 ? (
        <SettingRow hint={copy.emptyHint} title={copy.emptyTitle} />
      ) : (
        views.map(v => <OwnershipRow key={v.slug} view={v} />)
      )}
      {registry && (
        <div className="py-1 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ic-text-2)">
          {copy.registry(registry.version, registry.origin, String(registry.contracts))}
        </div>
      )}
    </>
  )
}
