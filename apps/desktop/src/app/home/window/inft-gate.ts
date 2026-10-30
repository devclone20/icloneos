import type { Translations } from '@/i18n'
/**
 * The gate a window that belongs to an iNFT shows instead of its app: what is
 * missing — a session, an iNFT on stage, its setup, the live engine — and the
 * one action that fixes it. Pure: the window passes its state and its actions,
 * so every branch is decided (and tested) in one place.
 */
import { desktop as en } from '@/i18n/en/desktop'

interface WindowGate {
  title: string
  hint: string
  action?: { label: string; onClick: () => void }
}

interface InftGateState {
  /** The app's display name, Title Case (the registry's `label`), never its lowercase window title. */
  label: string
  inftName?: string
  /** An iNFT is on stage and has a profile slug. */
  hasInft: boolean
  signedIn: boolean
  /** A remembered session is being restored (privy-session.ts): not signed out yet. */
  restoring: boolean
  configured: boolean
  liveEnabled: boolean
}

/** The gate's words (i18n `desktop.home.gate`); the English table is the default so the pure function stays callable without a provider. */
type InftGateCopy = Translations['desktop']['home']['gate']

interface InftGateActions {
  connectWallet: () => void
  /** Opens the iNFT island — the "Summon an iNFT" gate's one action. */
  openInfts: () => void
  openSetup: () => void
  openLiveSettings: () => void
}

export function inftGate(
  state: InftGateState,
  actions: InftGateActions,
  copy: InftGateCopy = en.home.gate
): WindowGate | null {
  const { label } = state

  if (!state.signedIn) {
    if (state.restoring) {
      return { title: copy.signingIn, hint: copy.signingInHint(label) }
    }

    const connect = { label: copy.connectWallet, onClick: actions.connectWallet }

    return state.hasInft
      ? {
          title: copy.signedOut,
          hint: copy.signedOutHint(label),
          action: connect
        }
      : {
          title: copy.connectTitle,
          hint: copy.connectHint(label),
          action: connect
        }
  }

  if (!state.hasInft) {
    return {
      title: copy.summonTitle,
      hint: copy.summonHint(label),
      action: { label: copy.openInfts, onClick: actions.openInfts }
    }
  }

  if (!state.configured) {
    return {
      title: copy.setupTitle,
      hint: copy.setupHint(state.inftName ?? copy.thisInft),
      action: { label: copy.openSetup, onClick: actions.openSetup }
    }
  }

  if (!state.liveEnabled) {
    return {
      title: copy.liveOffTitle,
      hint: copy.liveOffHint,
      action: { label: copy.openSettings, onClick: actions.openLiveSettings }
    }
  }

  return null
}
