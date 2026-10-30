import './home.css'

/**
 * iclone os — the home surface (first view).
 *
 * Full-bleed stage over the shell: the frosted 1111 mosaic (painted by the
 * iclone skins in styles.css) shows through a transparent stage. Center: the
 * lowercase `iclone os` wordmark — it yields to the owner's iNFT once one is
 * opened (Stage wave). Left: the Apple-style Dock. Right: the collections
 * tab. Top-right: the three-skin theme cycle, mirroring cloneframe.io's
 * #themeBtn.
 *
 * The chat surface (and its composer — microphone included, by owner rule)
 * stays mounted beneath and completely untouched; the Dock's Chat button
 * simply navigates there.
 */
import { useStore } from '@nanostores/react'
import { X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { HOME_ROUTE, NEW_CHAT_ROUTE, SETTINGS_ROUTE } from '@/app/routes'
import { homeCards } from '@/app/settings/inft-book/book-model'
import { INFT_BOOK_PANE } from '@/app/settings/inft-book/book-pane'
import { provisionalHomeIds } from '@/app/settings/inft-book/book-seed'
import { $bookChecked, selectionFor } from '@/app/settings/inft-book/book-store'
import { publishDockWindowHost, settingsDockItem, useDockWindows } from '@/app/settings/settings-dock'
import { useI18n } from '@/i18n'
import { slugForInft } from '@/iclone-shared/inft-slug'
import { ESCAPE_PRIORITY, isTopEscapeLayer, pushEscapeLayer } from '@/lib/escape-layers'
import { comboFromEvent, formatCombo, isEditableTarget } from '@/lib/keybinds/combo'
import { persistStringArray, storedStringArray } from '@/lib/storage'
import { setSidebarOpen } from '@/store/layout'

import { $acpConfigMap, refreshAcpConfigMap } from './acp-setup'
import { resetAura } from './aura-prefs'
import { CollectionsPanel, CollectionsTab, type INftCardData } from './collections'
import { LazyContainersWindow, useContainersDockItem } from './containers/containers-dock'
import { Dock, type DockItem, focusDockTile } from './dock'
import { $econBadges } from './econ/badges'
import { prefetchEcon } from './econ/prefetch'
import { ECON_APPS, ECON_ORDER } from './econ/registry'
import type { EconKind } from './econ/types'
import { EconWindow, econWindowId } from './econ/window'
import { sampleImageField } from './field-color'
import { $fieldCeiling, $fieldGlow, resetFieldCeiling, resetFieldGlow } from './field-prefs'
import { $filesIslandOpen } from './files-island'
import { $econPanelCloser, closeMessageWindow, homeEscapeTarget, useMsgSidebarResetOnLeave } from './home-escape'
import { IcMessage } from './iclone-icons'
import { activeInftConfigured } from './inft-profile-configured'
import { $inftSwitch, hideInft, inftSwitchLabel, switchInft } from './inft-switch'
import { ICLONE_STORAGE } from './lib/storage-keys'
import { MessageWindow } from './msg-window'
import { $ownership, isDeactivated, ownershipForId } from './ownership'
import {
  $inftRoster,
  $inftRosterError,
  $inftRosterStatus,
  $privyRestoring,
  $privySession,
  $privySignedOutByUpdate,
  logoutPrivy,
  openPrivyLogin,
  refreshRoster,
  rescan,
  walletPrompt
} from './privy-session'
import { Stage3D } from './stage3d'
import { $activeInft, recallInftChoice } from './stage-store'
import { WalletPanel } from './wallet-panel'
import { $walletPanelOpen, hideWalletPanel } from './wallet-tool'
import type { IcWindowId } from './window'
import { isWindowExpanded, retractWindow } from './window/expanded'

// The dock answers ⌘⇧1…⌘⇧8 in tile order (⌘1–9 belong to profile switching,
// ⌃1–9 to session slots). Formatted once for the tooltips.
const DOCK_CHORDS = Array.from({ length: 8 }, (_, index) => `mod+shift+${index + 1}`)
const DOCK_HINTS = DOCK_CHORDS.map(formatCombo)

// What a signed-out visitor sees in the island: two illustrative cards from
// the collection, neither of them configured (nothing here is theirs yet).
const SAMPLE_CARDS: INftCardData[] = [
  { id: 'i01-sample-1', name: 'icloneOS i01 · #1', collection: 'icloneOS i01', chain: 'Robinhood', configured: false },
  { id: 'i01-sample-2', name: 'icloneOS i01 · #2', collection: 'icloneOS i01', chain: 'Robinhood', configured: false }
]

type HomeMode = 'stage' | 'window'

// walletPrompt (privy-session.ts) decides WHICH line; the words are the catalogue's.
const TAGLINE = {
  connect: 'taglineConnect',
  restoring: 'taglineRestoring',
  restoringWallet: 'taglineRestoringWallet',
  signedOutByUpdate: 'taglineSignedOutByUpdate',
  summon: 'taglineSummon'
} as const

// The owner's drag-reordered card order (id list). Unknown ids (new scans)
// append in scan order; ids that left the wallet simply stop matching.
const CARD_ORDER_KEY = ICLONE_STORAGE.collectionsOrder.key

function readCardOrder(): string[] {
  return storedStringArray(CARD_ORDER_KEY)
}

const isEconKind = (value: string): value is EconKind => (ECON_ORDER as string[]).includes(value)

/** The Message window's IcWindow id (msg-window.tsx). */
const MESSAGE_WINDOW_ID: IcWindowId = 'message'

export function HomeView({ mode, onClose }: { mode: HomeMode; onClose: () => void }) {
  useMsgSidebarResetOnLeave(mode)
  const navigate = useNavigate()
  const i18n = useI18n().t
  const copy = i18n.desktop.home
  const { closeEcon, econ, settingsOpen, toggleEcon } = useDockWindows(isEconKind)
  const [collectionsOpen, setCollectionsOpen] = useState(false)
  const [stageBackdrop, setStageBackdrop] = useState<string | null>(null)
  // A model that will not load used to dismiss the iNFT outright: the stage
  // simply fell back to the wordmark and the owner was never told why. The
  // iNFT stays on stage and says what happened instead.
  const [stageError, setStageError] = useState<null | string>(null)
  const [stageAttempt, setStageAttempt] = useState(0)
  const walletPanelOpen = useStore($walletPanelOpen)
  const session = useStore($privySession)
  const restoring = useStore($privyRestoring)
  const inftRoster = useStore($inftRoster)
  const rosterStatus = useStore($inftRosterStatus)
  const signedOutByUpdate = useStore($privySignedOutByUpdate)
  const walletLine = walletPrompt(session.status, restoring, rosterStatus, recallInftChoice(), signedOutByUpdate)
  const [connectPending, setConnectPending] = useState(false)
  const rosterError = useStore($inftRosterError)
  const activeInft = useStore($activeInft)
  const acpConfigMap = useStore($acpConfigMap)
  const fieldCeiling = useStore($fieldCeiling)
  const fieldGlow = useStore($fieldGlow)

  // Cached CLI statuses drive the collection badges from the first paint.
  useEffect(() => {
    void refreshAcpConfigMap()
  }, [])

  // A different iNFT starts from a clean field until its own scenery
  // reports — and always OPENS at the standard glow, ceiling and aura (owner
  // rule; the Settings sliders tune only the performance currently on stage).
  useEffect(() => {
    setStageBackdrop(null)
    resetFieldCeiling()
    resetFieldGlow()
    resetAura()
    setStageError(null)
    setStageAttempt(0)
  }, [activeInft?.id])

  // The DISPLAYED field: the token's color with its brightness capped
  // (owner rule: "brilhante demais" — a near-white field is glare at full
  // screen). Scaling in LINEAR RGB keeps the exact hue and saturation
  // direction while pinning luminance to a gallery-wall ceiling; darker
  // fields pass through untouched, so the 1111 mid-tones stay exact.
  const field = useMemo(() => {
    if (!stageBackdrop) {
      return null
    }

    const n = parseInt(stageBackdrop.replace('#', ''), 16)

    if (!Number.isFinite(n)) {
      return { display: stageBackdrop, luminance: 0 }
    }

    const toLinear = (value: number) => {
      const c = value / 255

      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }

    const toSrgb = (linear: number) => {
      const c = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055

      return Math.round(Math.min(1, Math.max(0, c)) * 255)
    }

    const lin = [toLinear((n >> 16) & 255), toLinear((n >> 8) & 255), toLinear(n & 255)]
    // Glow scales the field's brightness first (the mini app's falloff
    // multiplier, flattened to a uniform scale on the solid field), then the
    // ceiling pins the peak so a pale field never becomes glare.
    const glowed = lin.map(value => value * fieldGlow)
    const luminance = 0.2126 * glowed[0] + 0.7152 * glowed[1] + 0.0722 * glowed[2]
    const CEILING = fieldCeiling
    const toHex = (values: number[]) => '#' + values.map(value => toSrgb(value).toString(16).padStart(2, '0')).join('')

    if (luminance <= CEILING) {
      return { display: toHex(glowed), luminance }
    }

    const k = CEILING / luminance
    const display = toHex(glowed.map(value => value * k))

    return { display, luminance: CEILING }
  }, [fieldCeiling, fieldGlow, stageBackdrop])

  // Bright-leaning fields flip the chrome to dark ink (owner-reported: a
  // pale ATLAS field washed out the dock, island and titlebar). Keyed to the
  // DISPLAYED luminance; the attribute leaves with the iNFT.
  useEffect(() => {
    const root = document.documentElement

    if (activeInft && field && field.luminance > 0.32) {
      root.dataset.icloneFieldLight = '1'
    } else {
      delete root.dataset.icloneFieldLight
    }

    return () => {
      delete root.dataset.icloneFieldLight
    }
  }, [activeInft, field])

  // The other half of the one-island rule: FILES opens from the titlebar, on
  // every route, so it can land on an already-open collection.
  const filesOpen = useStore($filesIslandOpen)

  useEffect(() => {
    if (filesOpen) {
      setCollectionsOpen(false)
    }
  }, [filesOpen])

  const [cardOrder, setCardOrder] = useState<string[]>(readCardOrder)

  // Settings → iNFT can reset the drag order; the event keeps this live.
  useEffect(() => {
    const onReset = () => setCardOrder([])

    window.addEventListener('iclone:cards-order-reset', onReset)

    return () => window.removeEventListener('iclone:cards-order-reset', onReset)
  }, [])

  const handleReorder = (ids: string[]) => {
    setCardOrder(ids)

    persistStringArray(CARD_ORDER_KEY, ids)
  }

  // The iNFT Book rule: signed in, Home lists only the iNFTs checked in
  // Settings › iNFT Book (a proven-lost one keeps its mandatory signal).
  // Until the wallet's O1 seed exists, the configured ones on the roster stand in for it.
  const bookChecked = useStore($bookChecked)
  const ownership = useStore($ownership)

  const homeRoster = useMemo<INftCardData[]>(() => {
    const selection = selectionFor(bookChecked, session.address)
    const checked = selection ? new Set(selection.ids) : provisionalHomeIds(inftRoster, acpConfigMap, ownership)

    const lost = new Set(
      inftRoster.filter(card => isDeactivated(ownershipForId(ownership, card.id))).map(card => card.id)
    )

    return homeCards(inftRoster, checked, lost)
  }, [acpConfigMap, bookChecked, inftRoster, ownership, session.address])

  // The rendered roster: scanned cards (or the signed-out samples) overlaid
  // with the real per-iNFT Virtuals CLI state, in the owner's chosen order.
  const cards = useMemo<INftCardData[]>(() => {
    const base = session.status === 'in' ? homeRoster : SAMPLE_CARDS

    const overlaid = base.map(card => {
      const status = acpConfigMap[slugForInft(card.id)]

      return status ? { ...card, configured: status.configured } : card
    })

    if (cardOrder.length === 0) {
      return overlaid
    }

    const rank = (card: INftCardData, index: number) => {
      const at = cardOrder.indexOf(card.id)

      return at >= 0 ? at : cardOrder.length + index
    }

    return overlaid
      .map((card, index) => ({ card, key: rank(card, index) }))
      .sort((a, b) => a.key - b.key)
      .map(entry => entry.card)
  }, [acpConfigMap, cardOrder, homeRoster, session.status])

  // O3: an iNFT unchecked while on stage stays there until dismissed, so it is looked up in the whole roster too.
  const activeCard = activeInft
    ? (cards.find(card => card.id === activeInft.id) ?? inftRoster.find(card => card.id === activeInft.id))
    : undefined

  const activeSlug = activeInft ? slugForInft(activeInft.id) : undefined

  const activeConfigured = activeInftConfigured(activeSlug, acpConfigMap, activeCard)
  const badges = useStore($econBadges)
  const activeBadges = activeSlug ? badges[activeSlug] : undefined

  // The dock apps read while the 3D model loads: by the first click their
  // answers are already in memory (see econ/prefetch.ts).
  useEffect(() => {
    if (activeInft && activeSlug && activeConfigured) {
      prefetchEcon(activeInft.id, activeSlug)
    }
  }, [activeConfigured, activeInft, activeSlug])

  // Stage3D re-initializes its whole scene when its callbacks change
  // identity, so both stay stable and read live values through a ref.
  const activeCardRef = useRef<INftCardData | undefined>(undefined)

  activeCardRef.current = activeCard

  const handleStageError = useCallback((message: string) => {
    console.warn('[iclone] stage:', message)
    setStageError(message)
  }, [])

  // The iNFT's field, best source first: scenery baked in the GLB (the 1111
  // dome — already sRGB via three's color management) → metadata
  // background_color → the poster's own border pixels (ATLAS) → house ink.
  const handleBackdropReport = useCallback((color: null | string) => {
    if (color) {
      setStageBackdrop(color)

      return
    }

    const card = activeCardRef.current

    if (card?.backdropColor) {
      setStageBackdrop(card.backdropColor)

      return
    }

    if (card?.imageUrl) {
      const id = card.id

      void sampleImageField(card.imageUrl).then(sampled => {
        if (sampled && activeCardRef.current?.id === id) {
          setStageBackdrop(sampled)
        }
      })
    }
  }, [])

  // Closing a Dock window hands focus back to its tile: the focused Close
  // control unmounts with the window and the browser would drop focus to <body>.
  const closeEconToDock = useCallback(() => {
    const kind = econ

    closeEcon()

    if (kind) {
      focusDockTile(kind)
    }
  }, [closeEcon, econ])

  const closeMessageToDock = useCallback(() => {
    closeMessageWindow(onClose)
    focusDockTile('chat')
  }, [onClose])

  // The window this surface's Escape would close: the econ window over everything, else the Message window.
  const topWindowId = econ ? econWindowId(econ) : mode === 'window' ? MESSAGE_WINDOW_ID : null

  useEffect(() => {
    // A proper escape-layer citizen. The raw listener this replaces fired on
    // EVERY Esc — so closing Settings with Esc ALSO dismissed the summoned
    // iNFT (or the econ/collections panel) beneath it: one key, two closes,
    // and the user's stage reset behind their back.
    const releaseLayer = pushEscapeLayer(ESCAPE_PRIORITY.homeStage)

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !isTopEscapeLayer(ESCAPE_PRIORITY.homeStage)) {
        return
      }

      // The panels close on Esc in EVERY mode — a collections panel opened
      // over the Message window used to require the mouse to leave.
      const closePanel = $econPanelCloser.get()

      const target = homeEscapeTarget({
        collectionsOpen,
        econ: Boolean(econ),
        editable: isEditableTarget(event.target),
        // An expanded window retracts on the first Escape and closes on the next (STAGE tester 1 W-1).
        expanded: topWindowId !== null && isWindowExpanded(topWindowId),
        mode,
        panel: Boolean(closePanel)
      })

      if (!target) {
        return
      }

      event.preventDefault()

      if (target === 'econ-panel') {
        closePanel?.()
      } else if (target === 'retract') {
        if (topWindowId !== null) {
          retractWindow(topWindowId)
        }
      } else if (target === 'econ') {
        closeEconToDock()
      } else if (target === 'collections') {
        setCollectionsOpen(false)
      } else if (target === 'message') {
        closeMessageToDock()
      } else {
        onClose()
      }
    }

    window.addEventListener('keydown', onKey)

    return () => {
      window.removeEventListener('keydown', onKey)
      releaseLayer()
    }
  }, [closeEconToDock, closeMessageToDock, collectionsOpen, econ, mode, onClose, topWindowId])

  // The iNFT island, opened from its tab or from a window's "Summon an iNFT"
  // gate. Opening refreshes the collection silently — never a manual scan —
  // and the right edge holds one island (see home/right-edge.ts).
  const openCollections = useCallback(() => {
    // Opening the island refreshes cheaply (page 1 + the checked set's proofs); the whole wallet is read on
    // sign-in and the iNFT Book's Rescan only — or here again when that sign-in scan failed ("retries on the next open").
    if (session.status === 'in') {
      void ($inftRosterStatus.get() === 'error' ? rescan() : refreshRoster())
    }

    $filesIslandOpen.set(false)
    setCollectionsOpen(true)
  }, [session.status])

  // One Dock window at a time: the econ windows share the Message and Settings
  // windows' frame, so opening one closes the other. Navigating home IS their
  // close (wiring.tsx wires onClose to that), so opening from either goes home
  // first and the econ window lands clean on the stage.
  const openEcon = useCallback(
    (kind: EconKind) => {
      toggleEcon(kind)

      if (mode === 'window' || settingsOpen) {
        navigate(HOME_ROUTE, { replace: true })
      }
    },
    [mode, navigate, settingsOpen, toggleEcon]
  )

  // V3-G: the Containers window, one Dock window at a time like the others.
  const openContainers = useCallback(() => {
    closeEcon()
    navigate(HOME_ROUTE, { replace: true })
  }, [closeEcon, navigate])

  const containersItem = useContainersDockItem(DOCK_HINTS[7], openContainers)

  // Owner rule: NO Home tile. The dock only exists on the home surface, so a
  // button to reach it would point at where you already are. The door that is
  // actually needed — from the full-page routes, which render no dock at all —
  // every route now escapes through its own overlay close (owner rule: no Home button).
  const dockItems = useMemo<DockItem[]>(
    () => [
      {
        id: 'chat',
        label: copy.message,
        hint: DOCK_HINTS[0],
        icon: <IcMessage size={22} />,
        active: mode === 'window',
        onSelect: () => {
          // The Message window opens over the ever-present home; the chat's
          // own sidebar starts collapsed so it reads as one clean window.
          closeEcon()
          setSidebarOpen(false)
          navigate(NEW_CHAT_ROUTE)
        }
      },
      ...ECON_ORDER.map((kind, index) => {
        const app = ECON_APPS[kind]
        const Icon = app.Icon

        return {
          id: kind,
          label: copy.tile[kind],
          hint: DOCK_HINTS[index + 1],
          icon: <Icon size={22} />,
          active: econ === kind,
          badge: activeBadges?.[kind] || undefined,
          onSelect: () => openEcon(kind)
        }
      }),
      {
        // The tile's word comes from the catalogue like the six econ tiles (U4-p2-03-p2b).
        ...settingsDockItem({ active: settingsOpen, hint: DOCK_HINTS[6], onSelect: () => navigate(SETTINGS_ROUTE) }),
        label: i18n.commandCenter.settings
      },
      containersItem
    ],
    [
      activeBadges,
      closeEcon,
      containersItem,
      copy,
      econ,
      i18n.commandCenter.settings,
      mode,
      navigate,
      openEcon,
      settingsOpen
    ]
  )

  // The chords fire anywhere on the home surface except inside a text field
  // (the composer, a search box) — those keep their own keys.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) {
        return
      }

      const at = DOCK_CHORDS.indexOf(comboFromEvent(event) ?? '')

      if (at < 0 || !dockItems[at]) {
        return
      }

      event.preventDefault()
      dockItems[at].onSelect()
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [dockItems])

  return (
    <>
      {/* The BASE layer: mosaic field + the live 3D iNFT, UNDER every frosted
          window (Message, Settings, econ panels). The performance never
          unmounts — thin a window's opacity and the agent is right there. */}
      <div
        className={activeInft ? 'istage-layer istage-layer--live' : 'istage-layer'}
        data-overlay-surface={mode === 'stage' ? true : undefined}
        style={activeInft ? ({ '--istage-live-bg': field?.display ?? '#0b0a10' } as React.CSSProperties) : undefined}
      >
        {activeInft && (
          <div className="ihome__stage ihome__stage--live">
            {stageError ? (
              <div className="istage-fail" role="status">
                <p className="istage-fail__head">{copy.couldNotSummon(activeInft.name.toLowerCase())}</p>
                <p className="istage-fail__why">{stageError}</p>
                <div className="istage-fail__acts">
                  <button
                    className="istage-fail__btn istage-fail__btn--go"
                    onClick={() => {
                      setStageError(null)
                      setStageAttempt(attempt => attempt + 1)
                    }}
                    type="button"
                  >
                    {copy.tryAgain}
                  </button>
                  <button className="istage-fail__btn" onClick={() => void hideInft()} type="button">
                    {copy.leaveStage}
                  </button>
                </div>
              </div>
            ) : (
              // Keyed on the attempt so "Try again" is a clean remount — the
              // scene builds once per mount and has nothing to re-run.
              <Stage3D
                key={`${activeInft.id}:${stageAttempt}`}
                modelUrl={activeInft.modelUrl}
                onBackdrop={handleBackdropReport}
                onError={handleStageError}
              />
            )}
            {mode === 'stage' && <p className="ihome__inft-name">{activeInft.name.toLowerCase()}</p>}
            {mode === 'stage' && (
              <button
                aria-label={copy.dismissInft}
                className="ihome__dismiss"
                onClick={() => void hideInft()}
                type="button"
              >
                <X size={14} strokeWidth={2} />
              </button>
            )}
          </div>
        )}
        {/* The Message window's own surface — header band, chat body and the
            iT gaps in ONE paint, on top of the field and under every window
            layer. See `.iwin-plate` in home.css. */}
        {mode === 'window' && <div aria-hidden className="iwin-plate" />}
      </div>

      <div
        aria-label={copy.region}
        className={mode === 'window' ? 'ihome ihome--window' : 'ihome'}
        ref={publishDockWindowHost}
        role="region"
      >
        {walletPanelOpen && session.status === 'in' && session.address && (
          <WalletPanel
            address={session.address}
            onClose={hideWalletPanel}
            onSignOut={() => {
              hideWalletPanel()
              logoutPrivy()
            }}
          />
        )}

        {mode === 'stage' && !activeInft && (
          <div
            className="ihome__stage"
            /* A window is open over the stage (Settings included): the wordmark and the tagline step back. */
            data-quiet={econ || settingsOpen || collectionsOpen || walletPanelOpen ? '' : undefined}
          >
            <p className="ihome__wordmark">iclone os</p>
            <p className="ihome__tagline">{copy[TAGLINE[walletLine.prompt]]}</p>
            {walletLine.connect && (
              <button
                className="ihome__connect"
                disabled={connectPending}
                onClick={() => {
                  // The click spawns an Electron window — a real wait with zero
                  // acknowledgement. Hold the button in an "opening…" state until
                  // the window has had time to appear (or the attempt clearly
                  // failed), so a slow spawn never reads as a dead button.
                  setConnectPending(true)
                  openPrivyLogin()
                  window.setTimeout(() => setConnectPending(false), 2500)
                }}
                type="button"
              >
                {connectPending ? (
                  copy.openingSignIn
                ) : (
                  <>
                    {copy.connectWallet} <span className="ihome__connect-badge">{copy.recommended}</span>
                  </>
                )}
              </button>
            )}
          </div>
        )}

        {mode === 'window' && <MessageWindow onClose={closeMessageToDock} />}

        <Dock items={dockItems} />
        <LazyContainersWindow blocked={Boolean(econ) || settingsOpen || mode === 'window'} />

        {econ && (
          <EconWindow
            configured={activeConfigured}
            inftId={activeInft?.id}
            inftName={activeInft?.name}
            kind={econ}
            onClose={closeEconToDock}
            onOpenInfts={openCollections}
            slug={activeInft ? slugForInft(activeInft.id) : undefined}
          />
        )}

        <CollectionsTab
          onToggle={() => (collectionsOpen ? setCollectionsOpen(false) : openCollections())}
          open={collectionsOpen}
        />

        <InftSwitchChip />
        {collectionsOpen && (
          <CollectionsPanel
            bookEmpty={
              session.status === 'in' && inftRoster.length > 0
                ? {
                    action: i18n.inftBook.openBook,
                    line: i18n.inftBook.homeEmpty,
                    onOpen: () => {
                      setCollectionsOpen(false)
                      navigate(INFT_BOOK_PANE)
                    },
                    rule: i18n.inftBook.rule
                  }
                : undefined
            }
            cards={cards}
            onClose={() => setCollectionsOpen(false)}
            onReorder={handleReorder}
            onSelect={id => {
              const card = cards.find(item => item.id === id)

              // A soul-only card still switches the persona (the stage dismisses).
              if (card) {
                void switchInft(card, { origin: 'collection', navigate })
              }

              setCollectionsOpen(false)
            }}
            scanError={rosterError}
            scanStatus={rosterStatus}
            signedIn={session.status === 'in'}
          />
        )}
      </div>
    </>
  )
}

/** The switch's state, visible on the home stage too (the collection door
 *  closes its panel on click, so the panel cannot own this line). */
function InftSwitchChip() {
  const state = useStore($inftSwitch)

  if (state.phase === 'idle') {
    return null
  }

  return (
    <div aria-live="polite" className="ihome-switch-chip" data-phase={state.phase} role="status">
      {inftSwitchLabel(state)}
    </div>
  )
}
