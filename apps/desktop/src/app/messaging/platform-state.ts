/**
 * Messaging — the pure reads both columns share: how a platform's state is
 * named and toned, which of its env vars are secrets, and how a pairing user is
 * keyed and labelled. No DOM, no store, no i18n beyond the strings handed in.
 */

import { type MessagingPlatformInfo, type PairingUser } from '@/hermes'
import { type Translations } from '@/i18n'

import { type IcTone } from '../profiles/ic-page'

export const stateLabel = (state: null | string | undefined, m: Translations['messaging']) =>
  state ? m.states[state] || state.replace(/_/g, ' ') : m.unknown

export function stateTone({ enabled, state }: MessagingPlatformInfo): IcTone {
  if (!enabled) {
    return 'neutral'
  }

  if (state === 'connected') {
    return 'good'
  }

  if (state === 'fatal' || state === 'startup_failed') {
    return 'bad'
  }

  return 'warn'
}

/** Stable row identity: a user id is only unique within its platform. */
export const pairingKey = (user: PairingUser) => `${user.platform}:${user.user_id}`

export const pairingLabel = (user: PairingUser) => user.user_name || user.user_id

/** The keys whose value is a credential: never persisted to disk. */
export const secretKeysOf = (platform: MessagingPlatformInfo) =>
  new Set(platform.env_vars.filter(field => field.is_password).map(field => field.key))
