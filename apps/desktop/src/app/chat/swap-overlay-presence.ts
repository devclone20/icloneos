import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { $activeInftName, $inftSwitch, inftWakeName } from '@/app/home/inft-switch'
import { $gateway } from '@/store/gateway'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'

// The overlay's `duration-150` fade-out plus a frame of slack.
export const SWAP_OVERLAY_FADE_MS = 200

interface SwapOverlayPresence {
  mounted: boolean
  profile: string | null
}

const HIDDEN: SwapOverlayPresence = { mounted: false, profile: null }

// Mount window for ChatSwapOverlay. The overlay keeps its last label through
// the fade-out, so left mounted it held "Waking up <profile>…" (or a blank
// "Waking up …" before the first swap) in the DOM after the swap had settled —
// readable to anything scanning page text next to an answer that had already
// arrived. It now mounts only around a swap: first at opacity 0 and named two
// frames later, so its own fade-in still runs, then unmounts once the fade-out
// has finished.
//
// What it names: every iNFT rides on the Hermes profile 'default', so a wake
// of that profile is labelled with the iNFT's name, never 'default'. And a
// target that is already the live AND connected profile is no wake at all (a
// session open hydrating its transcript after an iNFT switch): it never mounts
// the overlay, though an overlay already up for a real swap stays through that
// hydration. The live profile with no gateway is a real reconnect: it shows.
export function swapOverlayLabel(target: string, inftName: null | string): string {
  return normalizeProfileKey(target) === 'default' && inftName?.trim() ? inftName : target
}

export function useSwapOverlayPresence(
  target: string | null,
  fadeMs: number = SWAP_OVERLAY_FADE_MS
): SwapOverlayPresence {
  const activeProfile = useStore($activeGatewayProfile)
  // Subscribed so the label follows a switch; the name itself is read below.
  useStore($inftSwitch)
  useStore($activeInftName)
  const named = target?.trim() ? swapOverlayLabel(target, inftWakeName()) : null
  const connected = useStore($gateway) !== null
  const live = target?.trim() ? connected && normalizeProfileKey(target) === normalizeProfileKey(activeProfile) : false
  const [presence, setPresence] = useState<SwapOverlayPresence>(HIDDEN)
  const wanted = named && !(live && !presence.mounted) ? named : null

  useEffect(() => {
    if (wanted) {
      setPresence(prev => (prev.mounted ? { mounted: true, profile: wanted } : { mounted: true, profile: null }))

      let inner = 0

      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setPresence({ mounted: true, profile: wanted }))
      })

      return () => {
        cancelAnimationFrame(outer)
        cancelAnimationFrame(inner)
      }
    }

    // Named → fade out with the label held. Never named (the swap settled
    // inside the two frames) → nothing was visible: unmount now.
    setPresence(prev => (prev.profile ? { mounted: true, profile: null } : HIDDEN))

    const timer = window.setTimeout(() => setPresence(prev => (prev.mounted && !prev.profile ? HIDDEN : prev)), fadeMs)

    return () => window.clearTimeout(timer)
  }, [wanted, fadeMs])

  return presence
}
