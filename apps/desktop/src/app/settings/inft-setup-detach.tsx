import './inft-setup.css'

/**
 * iclone os — Settings → iNFT → EconomyOS → "Detach agent".
 *
 * Forgets one iNFT's LOCAL agent setup so the token can be sold clean. The
 * Virtuals agent itself is bound to the owner wallet, not to the token, and
 * the CLI has no "delete agent" — so this panel says exactly what stays and
 * links the Virtuals pages where the owner neutralises it by hand.
 */
import { useStore } from '@nanostores/react'
import { ExternalLink } from 'lucide-react'
import { type JSX, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { profileSlugFor, slugForInft } from '@/iclone-shared/inft-slug'

import { $acpConfigMap, detachInftAcp, type InftDetachResult, runAcp } from '../home/acp-setup'
import { invalidateAcp } from '../home/econ/cli'
import { deleteInftProfile } from '../home/inft-profile'
import { openExternal } from '../home/lib/external'
import { $inftRoster } from '../home/privy-session'

import { cardHeld, lateHold, recordLateAnswer } from './inft-setup-card-flight'
import { cardErrorInfo, IDLE_SIGNUP } from './inft-setup-card-signup'
import { type InftPaneCopy, useInftPaneCopy } from './inft-setup-copy'
import { SettingRow } from './setting-row'

const VIRTUALS = 'https://app.virtuals.io/acp'

/** The dashboard pages the CLI cannot act on for the owner. */
export function virtualsChecklist(
  agentId: string | undefined,
  labels: InftPaneCopy['detachPanel']['checklist']
): { label: string; url: string }[] {
  const agent = agentId && /^[A-Za-z0-9_-]{1,80}$/.test(agentId) ? `${VIRTUALS}/agents/${agentId}` : undefined

  return [
    ...(agent
      ? [
          {
            label: labels.signer,
            url: `${agent}?tab=wallet&subTab=signers`
          },
          { label: labels.agent, url: agent }
        ]
      : []),
    { label: labels.policies, url: `${VIRTUALS}/wallet-policies` }
  ]
}

/** `chain:contract:tokenId` → `#tokenId`, as the card shows it. */
export function confirmTokenFor(inftId: string): string {
  return `#${inftId.split(':').pop() ?? inftId}`
}

/** The row label: the card's name, plus `#tokenId` unless the name already is or ends with it. */
export function detachLabel(name: string, inftId: string): string {
  const token = confirmTokenFor(inftId)
  const trimmed = name.trim()

  return !trimmed ? token : trimmed === token || trimmed.endsWith(` ${token}`) ? trimmed : `${trimmed} ${token}`
}

function DetachPanel({ id, name, onClose }: { id: string; name: string; onClose: () => void }): JSX.Element {
  const copy = useInftPaneCopy().detachPanel
  const configMap = useStore($acpConfigMap)
  const slug = slugForInft(id)
  const [agentId] = useState(() => configMap[slug]?.agentId)
  const [typed, setTyped] = useState('')
  const [alsoProfile, setAlsoProfile] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string>()
  const [result, setResult] = useState<InftDetachResult>()
  const token = confirmTokenFor(id)
  const matches = typed.trim() === token

  const wipeProfile = async () => {
    setBusy(true)

    // The wizard's one card hold covers this call too: no card call while the service is holding the account.
    if (await cardHeld(id)) {
      setBusy(false)
      setNote(copy.held)

      return
    }

    const run = await runAcp(id, ['card', 'profile', 'reset', '--json'])
    const hold = lateHold(cardErrorInfo(run), Date.now())

    if (hold) {
      void recordLateAnswer(id, hold, IDLE_SIGNUP)
    }

    setBusy(false)
    setNote(run.ok ? copy.wiped : copy.wipeFailed(run.error ?? run.stderr))
  }

  const detach = async () => {
    if (!matches || busy) {
      return
    }

    setBusy(true)
    const done = await detachInftAcp(id)

    if (done.ok) {
      invalidateAcp(slug)

      if (alsoProfile) {
        const [, contract = '', tokenId = ''] = id.split(':')

        await deleteInftProfile(profileSlugFor(contract, tokenId)).catch(() => undefined)
      }
    }

    setBusy(false)
    setResult(done)
  }

  return (
    <section aria-label={copy.dialogLabel(name)} className="iws__step" role="dialog">
      <header className="iws__step-head">
        <h3>{copy.dialogLabel(detachLabel(name, id))}</h3>
      </header>
      <div className="iws__step-body">
        <p className="iws__note">{copy.removes}</p>
        <p className="iws__note">{copy.kept}</p>
        <div className="iws__row">
          {virtualsChecklist(agentId, copy.checklist).map(item => (
            <Tip key={item.url} label={item.url}>
              <button className="iws__btn" onClick={() => openExternal(item.url)} type="button">
                <ExternalLink size={12} strokeWidth={1.8} /> {item.label}
              </button>
            </Tip>
          ))}
        </div>
        {!result?.ok && (
          <>
            <div className="iws__row">
              <button className="iws__btn" disabled={busy} onClick={() => void wipeProfile()} type="button">
                {copy.wipe}
              </button>
              <label className="iws__note">
                <input checked={alsoProfile} onChange={e => setAlsoProfile(e.target.checked)} type="checkbox" />{' '}
                {copy.alsoProfile}
              </label>
            </div>
            <div className="iws__row">
              <input
                aria-label={copy.confirmLabel}
                className="iws__input"
                onChange={e => setTyped(e.target.value)}
                placeholder={copy.confirmPlaceholder(token)}
                value={typed}
              />
              <button
                className="iws__btn iws__btn--primary"
                disabled={!matches || busy}
                onClick={() => void detach()}
                type="button"
              >
                {copy.detach}
              </button>
              <button className="iws__btn" onClick={onClose} type="button">
                {copy.cancel}
              </button>
            </div>
          </>
        )}
        {note && <p className="iws__note">{note}</p>}
        {result?.ok && <p className="iws__note">{copy.detached(String(result.removed.length))}</p>}
        {result && !result.ok && <p className="iws__error">{result.error}</p>}
      </div>
    </section>
  )
}

export function DetachAgentSection(): JSX.Element | null {
  const roster = useStore($inftRoster)
  const configMap = useStore($acpConfigMap)
  const copy = useInftPaneCopy().detachPanel
  const [open, setOpen] = useState<string | null>(null)
  const attached = roster.filter(card => configMap[slugForInft(card.id)] || card.id === open)

  if (attached.length === 0) {
    return null
  }

  return (
    <>
      {attached.map(card =>
        open === card.id ? (
          <div className="iws" key={card.id}>
            <DetachPanel id={card.id} name={card.name} onClose={() => setOpen(null)} />
          </div>
        ) : (
          <SettingRow
            control={
              <Button onClick={() => setOpen(card.id)} size="sm" type="button" variant="outline">
                {copy.open}
              </Button>
            }
            hint={copy.rowHint}
            key={card.id}
            title={copy.rowTitle(detachLabel(card.name, card.id))}
          />
        )
      )}
    </>
  )
}
