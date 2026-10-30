/**
 * Settings › iNFT Book (front V3-H): every iNFT the wallet holds, as small
 * cards with a checkbox each — and the rule, said at the top: Home shows only
 * what is checked here.
 *
 * Lazy (panes.tsx): opening Settings never loads this file. State lives in
 * book-store.ts; the paged scan in book-scan.ts; the grid is virtualised in
 * book-grid.tsx; images go through thumb-cache.ts.
 */
import '@/app/home/collections.css'
import './inft-book.css'

import { useStore } from '@nanostores/react'
import { type JSX, useCallback, useEffect, useId, useMemo, useState } from 'react'

import { $acpConfigMap } from '@/app/home/acp-setup'
import type { INftCardData } from '@/app/home/collections'
import { shortAddress } from '@/app/home/lib/format'
import { $privySession, openPrivyLogin, rescan as rescanHome } from '@/app/home/privy-session'
import { IcSearchInput, IcSegmented } from '@/components/ic/controls'
import { IcNote, IcSkeleton } from '@/components/ic/feedback'
import { IcSelect } from '@/components/ic/field'
import { IcConfirmDialog, IcPage, IcPageButton, IcPageState } from '@/components/ic/ic-page'
import { useI18n } from '@/i18n'
import { slugForInft } from '@/iclone-shared/inft-slug'

import { BookGrid } from './book-grid'
import {
  BOOK_SCAN_CEILING,
  type BookFilter,
  type BookStateFilter,
  CHECK_ALL_CONFIRM_ABOVE,
  facet,
  filterBook,
  newlyChecked,
  NO_FILTER,
  sortBook
} from './book-model'
import { retryBookScan, startBookScan } from './book-scan'
import { refreshSetupState } from './book-seed'
import {
  $bookChecked,
  $bookItems,
  $bookScan,
  checkShown,
  dismissKept,
  selectionFor,
  toggleBook,
  uncheckShown
} from './book-store'

const NOTHING_CHECKED: ReadonlySet<string> = new Set()

export function InftBookView(): JSX.Element {
  const copy = useI18n().t.inftBook
  const session = useStore($privySession)
  const items = useStore($bookItems)
  const scan = useStore($bookScan)
  const selections = useStore($bookChecked)
  const acpConfigMap = useStore($acpConfigMap)
  const address = session.status === 'in' ? (session.address?.toLowerCase() ?? null) : null
  const selection = selectionFor(selections, address)
  const checked = useMemo(() => new Set(selection?.ids ?? []), [selection])
  const [filter, setFilter] = useState<BookFilter>(NO_FILTER)
  // K72: what the owner was asked about, frozen at the ask — pages merging behind the dialog never widen it.
  const [confirming, setConfirming] = useState<null | { count: number; cards: readonly INftCardData[] }>(null)
  const collectionId = useId()
  const chainId = useId()

  // Opening the Book reads the wallet when nothing for THIS wallet is loaded yet.
  useEffect(() => {
    const state = $bookScan.get()

    if (address && (state.address !== address || state.status === 'idle')) {
      void startBookScan()
    }
  }, [address])

  // The status marks read the same cached Virtuals CLI state as Home's ECONOMYOS / SETUP NEEDED chip.
  useEffect(() => {
    if (address) {
      void refreshSetupState()
    }
  }, [address])

  const sorted = useMemo(() => sortBook([...items.values()]), [items])
  // With no checked/unchecked filter, toggling a card must not rebuild the list.
  const stateSet = filter.state === 'all' ? NOTHING_CHECKED : checked
  const shown = useMemo(() => filterBook(sorted, filter, stateSet), [sorted, filter, stateSet])
  const collections = useMemo(() => facet(sorted, card => card.collection), [sorted])
  const chains = useMemo(() => facet(sorted, card => card.chain), [sorted])

  const configured = useMemo(
    () => new Set(sorted.filter(card => acpConfigMap[slugForInft(card.id)]?.configured === true).map(card => card.id)),
    [sorted, acpConfigMap]
  )

  const onHome = useMemo(() => sorted.reduce((n, card) => (checked.has(card.id) ? n + 1 : n), 0), [sorted, checked])

  const onToggle = useCallback(
    (id: string) => {
      if (address) {
        toggleBook(address, id)
      }
    },
    [address]
  )

  const requestCheckShown = () => {
    const adding = newlyChecked(selection?.ids ?? [], shown)

    if (adding > CHECK_ALL_CONFIRM_ABOVE) {
      setConfirming({ count: adding, cards: shown })
    } else if (address) {
      checkShown(address, shown)
    }
  }

  const rescan = (
    <IcPageButton
      disabled={!address || scan.status === 'scanning'}
      onClick={() => {
        // Rescan is one of the two moments the Home roster reads the whole wallet too (sign-in is the other).
        void startBookScan()
        void rescanHome()
      }}
    >
      {copy.rescan}
    </IcPageButton>
  )

  const stateOptions: readonly { id: BookStateFilter; label: string }[] = [
    { id: 'all', label: copy.stateAll },
    { id: 'checked', label: copy.stateChecked },
    { id: 'unchecked', label: copy.stateUnchecked }
  ]

  return (
    <IcPage actions={rescan} frame="bare" subtitle={copy.rule} title={copy.navLabel}>
      {!address ? (
        <IcPageState
          action={
            <IcPageButton onClick={openPrivyLogin} tone="accent">
              {copy.signIn}
            </IcPageButton>
          }
          kind="empty"
          title={copy.noWallet}
        />
      ) : items.size === 0 && scan.status === 'scanning' ? (
        <div className="inft-book">
          <IcSkeleton label={copy.scanning(0)} rows={4} />
        </div>
      ) : items.size === 0 && scan.status === 'partial' ? (
        <IcPageState
          action={
            <IcPageButton onClick={() => void retryBookScan()} tone="accent">
              {copy.retry}
            </IcPageButton>
          }
          kind="error"
          title={copy.scanFailed}
        />
      ) : items.size === 0 ? (
        <IcPageState kind="empty" title={copy.none} />
      ) : (
        <div className="inft-book" data-inft-book="">
          <div className="inft-book__bar">
            <span className="icpg__dim">{copy.wallet(shortAddress(address))}</span>
            <span data-book-count="">{copy.count(sorted.length, onHome)}</span>
            <div className="inft-book__bar-end">
              <IcPageButton onClick={requestCheckShown} tone="quiet">
                {copy.checkShown}
              </IcPageButton>
              <IcPageButton onClick={() => uncheckShown(address, shown)} tone="quiet">
                {copy.uncheckShown}
              </IcPageButton>
            </div>
          </div>
          <div className="inft-book__bar">
            <IcSearchInput
              onChange={query => setFilter(current => ({ ...current, query }))}
              placeholder={copy.search}
              value={filter.query}
            />
            <label className="icpg__sr" htmlFor={collectionId}>
              {copy.filterCollection}
            </label>
            <IcSelect
              id={collectionId}
              onChange={collection => setFilter(current => ({ ...current, collection }))}
              options={[
                { label: copy.allCollections, value: '' },
                ...collections.map(value => ({ label: value, value }))
              ]}
              value={filter.collection}
            />
            <label className="icpg__sr" htmlFor={chainId}>
              {copy.filterChain}
            </label>
            <IcSelect
              id={chainId}
              onChange={chain => setFilter(current => ({ ...current, chain }))}
              options={[{ label: copy.allChains, value: '' }, ...chains.map(value => ({ label: value, value }))]}
              value={filter.chain}
            />
            <IcSegmented
              onChange={state => setFilter(current => ({ ...current, state }))}
              options={stateOptions}
              value={filter.state}
            />
          </div>
          {selection?.kept !== null && selection?.kept !== undefined ? (
            <div className="inft-book__status">
              <IcNote>{copy.kept(selection.kept)}</IcNote>
              <IcPageButton onClick={() => dismissKept(address)} tone="quiet">
                {copy.dismiss}
              </IcPageButton>
            </div>
          ) : null}
          {scan.status === 'scanning' ? (
            <div aria-live="polite" className="inft-book__status" role="status">
              <IcNote>{copy.scanning(items.size)}</IcNote>
            </div>
          ) : scan.status === 'capped' ? (
            <div className="inft-book__status" role="status">
              <IcNote>{copy.capped(BOOK_SCAN_CEILING)}</IcNote>
            </div>
          ) : scan.status === 'partial' ? (
            <div className="inft-book__status">
              <IcNote tone="danger">{copy.partial(items.size)}</IcNote>
              <IcPageButton onClick={() => void retryBookScan()} tone="accent">
                {copy.retry}
              </IcPageButton>
            </div>
          ) : null}
          {shown.length === 0 ? (
            <IcPageState kind="empty" title={copy.noMatch} />
          ) : (
            <BookGrid
              cards={shown}
              checked={checked}
              configured={configured}
              label={copy.navLabel}
              onToggle={onToggle}
              setUp={copy.setUp}
              setupNeeded={copy.setupNeeded}
              showOnHome={copy.showOnHome}
            />
          )}
        </div>
      )}
      <IcConfirmDialog
        busyLabel={copy.confirmBusy}
        cancelLabel={copy.cancel}
        confirmLabel={copy.confirmAction}
        description={copy.confirmBody}
        doneLabel={copy.confirmDone}
        errorFallback={copy.confirmError}
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          if (address && confirming) {
            checkShown(address, confirming.cards)
          }
        }}
        open={confirming !== null}
        title={copy.confirmTitle(confirming?.count ?? 0)}
      />
    </IcPage>
  )
}
