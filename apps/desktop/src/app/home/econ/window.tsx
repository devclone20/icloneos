import './econ.css'

/**
 * EconomyOS window — a full window over the ever-present home, opened from the
 * Dock. It opens on the one fixed window rect (the iNFT backdrop's frame, the
 * Message window's too) with the same controls (close · expand/retract ·
 * opacity); no window resizes with the mouse.
 *
 * The window decides whether an app renders at all — no iNFT on stage, setup
 * needed, live engine off (window/inft-gate.ts) — so the apps themselves only ever see a configured
 * iNFT. It also owns the header every app shares: the app's title, the agent's
 * identity chip, the refresh state, and the refresh button.
 */
import { useStore } from '@nanostores/react'
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'

import { SETTINGS_ROUTE } from '@/app/routes'
import { useI18n } from '@/i18n'

import { $acpConfigMap, type InftAcpStatus } from '../acp-setup'
import { $privyRestoring, $privySession, openPrivyLogin } from '../privy-session'
import { IcWindow, type IcWindowId, inftGate, useWindowExpanded } from '../window'

import { loadAgentIdentity, useAgentIdentity } from './agent'
import { shortAddress } from './format'
import { EconWindowContext } from './handoff'
import { type EconStatus, hasError, raiseEconApp, statusText, useEconStatus } from './live'
import { $liveEconEnabled, $liveEconIntervalSecs } from './prefs'
import { ECON_APPS } from './registry'
import { trackWindowCode, windowComponent } from './snapshot-paint'
import type { EconKind } from './types'
import { Action, Avatar, RefreshAction, SkeletonRows } from './ui'

const WINDOW_ID: Record<EconKind, IcWindowId> = {
  acp: 'acp-market',
  bank: 'bank-card',
  email: 'email',
  hyperliquid: 'hyperliquid',
  wallet: 'wallet'
}

/** The IcWindow id an econ kind opens in (home-view's Escape router retracts it by this id). */
export function econWindowId(kind: EconKind): IcWindowId {
  return WINDOW_ID[kind]
}

/**
 * The configured latch — module-level, keyed by slug, so it outlives the
 * window (a `useRef` would die with it). Once a slug has rendered its app, a
 * transient `configured=false` (a partial roster scan, a signed-out roster
 * swap) never unmounts it again. Only the service saying so releases it: a
 * fresh probe of that slug, newer than the latch, that reads `configured:
 * false` (a detach, a disconnect) — or a sign-out, which gates the window
 * outright. Value = epoch ms the slug was last seen configured.
 */
const configuredLatch = new Map<string, number>()

export function resolveConfigured(
  slug: string | undefined,
  configured: boolean,
  probe: InftAcpStatus | undefined,
  signedIn: boolean,
  now: number = Date.now()
): boolean {
  if (!slug) {
    return false
  }

  if (!signedIn) {
    configuredLatch.delete(slug)

    return false
  }

  const latchedAt = configuredLatch.get(slug)
  const released = probe !== undefined && !probe.stale && !probe.configured && probe.checkedAt > (latchedAt ?? 0)

  if (configured && !released) {
    configuredLatch.set(slug, now)

    return true
  }

  if (released) {
    configuredLatch.delete(slug)

    return false
  }

  return latchedAt !== undefined
}

/** Tests only: forget every latch. */
export function resetConfiguredLatch(): void {
  configuredLatch.clear()
}

interface EconWindowProps {
  configured: boolean
  inftId?: string
  inftName?: string
  kind: EconKind
  onClose: () => void
  /** Opens the iNFT island — the action of the "Summon an iNFT" gate. Required: the gate shipped without it once (U1-04). */
  onOpenInfts: () => void
  slug?: string
}

// Every window's code, remembered as it lands (the dock already fetches it at
// idle): the first click after a reload then mounts it without Suspense.
if (import.meta.env.MODE !== 'test') {
  const track = () =>
    (Object.keys(ECON_APPS) as EconKind[]).forEach(kind => void trackWindowCode(kind, ECON_APPS[kind]))

  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(track, { timeout: 300 })
  } else {
    window.setTimeout(track, 0)
  }
}

export function EconWindow({ configured: given, inftId, inftName, kind, onClose, onOpenInfts, slug }: EconWindowProps) {
  const app = ECON_APPS[kind]
  // Chosen once per kind: a module landing mid-mount must not swap the
  // component under the open window (that would remount the app).
  const [picked, setPicked] = useState(() => ({ kind, App: windowComponent(kind, app) }))

  if (picked.kind !== kind) {
    setPicked({ kind, App: windowComponent(kind, app) })
  }

  const navigate = useNavigate()
  const copy = useI18n().t.desktop.home
  // Another kind in this chassis is another window: it opens as Settings says (window/expanded.ts).
  const { expanded, toggle: toggleExpanded } = useWindowExpanded(WINDOW_ID[kind])
  const [refreshKey, setRefreshKey] = useState(0)
  const enabled = useStore($liveEconEnabled)
  const intervalSecs = useStore($liveEconIntervalSecs)
  const signedIn = useStore($privySession).status === 'in'
  const restoring = useStore($privyRestoring)
  const probe = useStore($acpConfigMap)[slug ?? '']
  const configured = resolveConfigured(slug, given, probe, signedIn)
  const identity = useAgentIdentity(inftId, slug, configured)
  const status = useEconStatus(kind, slug)

  // A press or a focus inside this window brings it to the front: it takes
  // the focused refresh rhythm (live.ts), the windows behind it the open one.
  useEffect(() => {
    const onRaise = (event: Event) => {
      const id = WINDOW_ID[kind]

      if (
        event.target instanceof Element &&
        event.target.closest(`[data-ic-window="${id}"], [data-ic-window-body="${id}"]`)
      ) {
        raiseEconApp(kind)
      }
    }

    document.addEventListener('pointerdown', onRaise, true)
    document.addEventListener('focusin', onRaise, true)

    return () => {
      document.removeEventListener('pointerdown', onRaise, true)
      document.removeEventListener('focusin', onRaise, true)
    }
  }, [kind])
  const live = enabled && configured && Boolean(inftId && slug)

  const refresh = useCallback(() => {
    // The app's own reads go first (that is what the click is for); the
    // identity, which never changes under the owner, refreshes behind them.
    setRefreshKey(key => key + 1)

    if (inftId && slug) {
      void loadAgentIdentity(inftId, slug, true)
    }
  }, [inftId, slug])

  const handle = useMemo(
    () => ({ close: onClose, agentName: identity?.name || inftName || copy.myAgent }),
    [copy.myAgent, identity?.name, inftName, onClose]
  )

  const title = app.title
  const Icon = app.Icon

  const gate = inftGate(
    {
      configured,
      hasInft: Boolean(inftId && slug),
      inftName,
      label: copy.tile[kind],
      liveEnabled: enabled,
      restoring,
      signedIn
    },
    {
      connectWallet: openPrivyLogin,
      openInfts: onOpenInfts,
      openLiveSettings: () => navigate(`${SETTINGS_ROUTE}?tab=inft`),
      openSetup: () => navigate(`${SETTINGS_ROUTE}?tab=economyos`)
    },
    copy.gate
  )

  const App = picked.App
  const statusLine = statusText(status, kind, intervalSecs * 1000)

  return (
    <EconWindowContext.Provider value={handle}>
      <IcWindow
        expanded={expanded}
        head={
          <>
            <h2>{title}</h2>
            {identity ? (
              <span className="iecon__identity" title={identity.description}>
                <Avatar name={identity.name} size={22} src={identity.imageUrl} />
                <b>{identity.name}</b>
                <span>{shortAddress(identity.walletAddress)}</span>
                <span aria-label={copy.agentOnline} className="iecon__identity-state" />
              </span>
            ) : inftName ? (
              <span className="iecon__identity">
                <span className="iecon__identity-state iecon__identity-state--off" />
                <b>{inftName.toLowerCase()}</b>
                <span>{configured ? copy.readingAgent : copy.setupNeeded}</span>
              </span>
            ) : null}
            {live ? (
              <span
                className={hasError(status) ? 'iecon__status iecon__status--error' : 'iecon__status'}
                data-status={statusPhase(status)}
              >
                <span
                  aria-hidden="true"
                  className={
                    status.refreshing && status.silent
                      ? 'iecon__status-dot iecon__status-dot--live'
                      : 'iecon__status-dot'
                  }
                />
                {/* The status box caps and ellipsizes the line (econ.css); a raw error has no length limit. */}
                <span className="iecon__status-text" title={hasError(status) ? statusLine : undefined}>
                  {statusLine}
                </span>
                <RefreshAction onClick={refresh} spinning={status.refreshing && !status.silent} />
              </span>
            ) : null}
          </>
        }
        id={WINDOW_ID[kind]}
        kind={kind}
        label={copy.windowLabel(title)}
        labels={{
          close: copy.closeWindow(title),
          expand: copy.expandWindow(title),
          retract: copy.retractWindow(title),
          opacity: copy.windowOpacity(title)
        }}
        onClose={onClose}
        onToggleExpanded={toggleExpanded}
        placement="self"
      >
        {gate ? (
          <div className="iecon__gate">
            <div>
              <div className="e-empty__icon">
                <Icon size={28} />
              </div>
              <p className="iecon__gate-title">{gate.title}</p>
              <p className="iecon__gate-hint">{gate.hint}</p>
              {gate.action ? (
                <Action kind="primary" onClick={gate.action.onClick}>
                  {gate.action.label}
                </Action>
              ) : null}
            </div>
          </div>
        ) : (
          <Suspense fallback={<SkeletonRows rows={7} />}>
            {/* Keyed by iNFT: a switch remounts the app, so one token's
                balances never linger on screen while another's load. */}
            <App
              expanded={expanded}
              identity={identity}
              inftId={inftId!}
              key={slug}
              refreshKey={refreshKey}
              slug={slug!}
            />
          </Suspense>
        )}
      </IcWindow>
    </EconWindowContext.Provider>
  )
}

function statusPhase(status: EconStatus): string {
  if (hasError(status)) {
    return 'error'
  }

  if (status.refreshing) {
    return status.silent ? 'silent' : 'refreshing'
  }

  return 'idle'
}
