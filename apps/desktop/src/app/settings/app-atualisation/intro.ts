import type { IcloneUpdatePolicyInfo } from '@/types/iclone-updates'

/**
 * The pane's opening sentence under curated policy (also the fail-closed reading of an unknown policy). The developer
 * sentence names `hermes update`, a door a curated build never opens, so it stays behind the policy conditional.
 */
function curatedIntro(info: IcloneUpdatePolicyInfo | null): string {
  const sha = info?.pin.sha ?? ''

  const pin = sha
    ? `pinned at ${sha.slice(0, 7)}${info?.pin.date ? ` (${info.pin.date})` : ''}`
    : 'pinned by this release'

  return (
    `Two trees update this app. The Hermes runtime beneath it ships with the app, ${pin} — Track A; iclone os never ` +
    'contacts Nous Research on its own, and a new runtime arrives only with a new iclone os release. The iclone os ' +
    'source never merges upstream: the Inbox ranks upstream commits, and what you adopt is re-implemented here — Track B.'
  )
}

const pinned = (info: IcloneUpdatePolicyInfo | null) => {
  const sha = info?.pin.sha ?? ''

  return sha ? `pinned at ${sha.slice(0, 7)}${info?.pin.date ? ` (${info.pin.date})` : ''}` : 'pinned by this release'
}

/**
 * The developer sentence. Developer policy only adds the explicit upstream compare; the runtime itself still moves
 * only to a release's pin (a bare `hermes update` would move the checkout to Nous main).
 */
function developerIntro(info: IcloneUpdatePolicyInfo | null): string {
  return (
    `Two trees update this app. The Hermes runtime beneath it ships with each iclone os release, ` +
    `${pinned(info)} — Track A; releases never contact Nous Research on their own. Developer policy on this Mac ` +
    'adds one explicit door: Compare with upstream, the first step of the monthly curated update. The iclone os ' +
    'source never merges upstream: the Inbox ranks upstream commits, and what you adopt is re-implemented here — Track B.'
  )
}

export const updatesIntro = (info: IcloneUpdatePolicyInfo | null) =>
  info?.policy === 'developer' ? developerIntro(info) : curatedIntro(info)

/** App Atualisation's "How it updates" row under developer policy. */
export function developerHowItUpdates(info: IcloneUpdatePolicyInfo | null): string {
  return (
    `Releases ship the runtime ${pinned(info)} and never contact Nous Research on their own. On this ` +
    'Mac the developer compare is an explicit click (one git fetch); a candidate is verified in a throwaway ' +
    'checkout, pinned in RUNTIME_PIN.json and shipped with the next monthly release — the runtime here is never ' +
    'moved to upstream main.'
  )
}
