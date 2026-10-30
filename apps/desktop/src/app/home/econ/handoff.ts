/**
 * EconomyOS — the hand-off to the iNFT itself.
 *
 * The Dock apps READ. Anything that moves value — a swap, a perp, hiring an
 * agent, sending funds — is the iNFT's own job, done by the Hermes agent with
 * the owner in the loop and the signer policy in force. So every "do this"
 * button in an app drops a precise, ready-to-send brief into the Message
 * composer and focuses it. It never submits: the owner reads and presses Enter.
 */
import { createContext, useCallback, useContext } from 'react'
import { useNavigate } from 'react-router'

import { NEW_CHAT_ROUTE, SETTINGS_ROUTE } from '@/app/routes'
import { setSidebarOpen } from '@/store/layout'

import { requestComposerFocus, requestComposerInsert } from '../../chat/composer/focus'

interface EconWindowHandle {
  /** Close this Dock window (the app is about to hand over to Message/Settings). */
  close: () => void
  agentName: string
}

export const EconWindowContext = createContext<EconWindowHandle>({ close: () => undefined, agentName: 'my agent' })

/** `ask('hire Otto AI for a crypto news report, budget $0.01')` — the brief
 *  lands in the composer, prefixed with who is being asked and where from. */
export function useAskInft(): (brief: string) => void {
  const navigate = useNavigate()
  const { agentName, close } = useContext(EconWindowContext)

  return useCallback(
    (brief: string) => {
      close()
      setSidebarOpen(false)
      navigate(NEW_CHAT_ROUTE)
      requestComposerInsert(`${agentName}, from your EconomyOS in iclone os: ${brief.trim()}`, {
        mode: 'block',
        target: 'main'
      })
      requestComposerFocus('main')
    },
    [agentName, close, navigate]
  )
}

/** Where "Open Setup" lands: this iNFT's setup, with one step brought into view. */
export interface SetupTarget {
  inftId: string
  step?: 'signin'
}

/** Settings → iNFT → Setup, for the states an app cannot fix by itself
 *  (sign-in, card signup, payment method). A target opens that iNFT's setup
 *  at its step; without one the page keeps its own selection. */
export function useOpenSetup(): (target?: SetupTarget) => void {
  const navigate = useNavigate()
  const { close } = useContext(EconWindowContext)

  return useCallback(
    (target?: SetupTarget) => {
      close()
      let route = `${SETTINGS_ROUTE}?tab=economyos`

      // Apps also wire this straight to onClick, so a click event can arrive here: only a real target deep-links.
      if (typeof target?.inftId === 'string') {
        route += `&inft=${encodeURIComponent(target.inftId)}`

        if (target.step) {
          route += `&step=${target.step}`
        }
      }

      navigate(route)
    },
    [close, navigate]
  )
}
