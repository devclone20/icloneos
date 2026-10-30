/**
 * EconomyOS — the five Dock apps, in Dock order.
 *
 * Each app is code-split: the home surface pays for none of them until its
 * window opens — and sits behind `memo`, so the window's own re-renders (a
 * status tick, a header change) stop at the boundary: an app re-renders for
 * its props (identity, refreshKey, expanded) and its own state only. The `title` is the window's heading and what the `it` CLI
 * reports as `econ panel:` — keep it lowercase and stable.
 */
import { type ComponentType, lazy, memo } from 'react'

import { IcCard, IcEmail, IcHyperliquid, IcMarket, IcWallet } from '../iclone-icons'

import type { EconAppProps, EconKind } from './types'

type IconComponent = ComponentType<{ className?: string; size?: number }>

interface EconAppMeta {
  /** The app's data module — exports an optional `prefetch(inftId, slug)`. */
  data?: () => Promise<unknown>
  /** Window heading, lowercase. */
  title: string
  /** Dock tooltip / aria-label. */
  label: string
  /** The dock tone class suffix (`ic-tone--<tone>`). */
  tone: string
  Icon: IconComponent
  App: ComponentType<EconAppProps>
  /** Fetch the window's code ahead of the click (the same module `App` loads). */
  preload: () => Promise<unknown>
}

type AppModule = Promise<{ default: ComponentType<EconAppProps> }>

/** One loader per window, shared by `lazy` and `preload`: the module is fetched
 *  once, so a preloaded window renders on its first click with no fallback. */
function windowOf(load: () => AppModule): Pick<EconAppMeta, 'App' | 'preload'> {
  let pending: AppModule | null = null

  // A failed fetch (a dev reload mid-request) is forgotten, so the click retries.
  const once = () =>
    (pending ??= load().catch((error: unknown) => {
      pending = null

      throw error
    }))

  return { App: memo(lazy(once)), preload: once }
}

export const ECON_ORDER: EconKind[] = ['email', 'wallet', 'bank', 'hyperliquid', 'acp']

export const ECON_APPS: Record<EconKind, EconAppMeta> = {
  email: {
    title: 'email',
    label: 'Email',
    tone: 'email',
    Icon: IcEmail,
    ...windowOf(() => import('./email/email-app')),
    data: () => import('./email/email-data')
  },
  wallet: {
    title: 'wallet',
    label: 'Wallet',
    tone: 'wallet',
    Icon: IcWallet,
    ...windowOf(() => import('./wallet/wallet-app')),
    data: () => import('./wallet/wallet-data')
  },
  bank: {
    title: 'bank card',
    label: 'Bank Card',
    tone: 'card',
    Icon: IcCard,
    ...windowOf(() => import('./bank/bank-app')),
    data: () => import('./bank/bank-data')
  },
  hyperliquid: {
    title: 'hyperliquid',
    label: 'Hyperliquid',
    tone: 'hyperliquid',
    Icon: IcHyperliquid,
    ...windowOf(() => import('./hyperliquid/hyperliquid-app')),
    data: () => import('./hyperliquid/hyperliquid-data')
  },
  acp: {
    title: 'acp market',
    label: 'ACP Market',
    tone: 'market',
    Icon: IcMarket,
    ...windowOf(() => import('./market/market-app')),
    data: () => import('./market/market-data')
  }
}
