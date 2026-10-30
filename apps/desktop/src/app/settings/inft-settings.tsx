/**
 * iNFT — collection & stage settings (owner rule: "put the iNFT in settings,
 * with the collection settings inside it, and the button that controls the
 * iNFT's brightness on screen — from very bright down to the darkest
 * possible; by default it opens at the standard brightness").
 *
 * The stage controls — Render (quality, motion) and Stage (field glow, field
 * ceiling, God Mode aura). Every summon opens at the standard; the sliders
 * tune the performance currently on stage.
 */
import { useStore } from '@nanostores/react'
import { type JSX, useCallback, useEffect, useRef, useState } from 'react'

import { getProfileSoul, updateProfileSoul } from '@/api/profiles'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { errorMessage } from '@/iclone-shared/errors'
import { profileSlugFor } from '@/iclone-shared/inft-slug'
import { Activity, Box, Brain, KeyRound, LayoutDashboard, Sun } from '@/lib/icons'
import { writeKey } from '@/lib/storage'
import { $profiles, refreshProfiles } from '@/store/profile'

import { $aura, AURA_MAX, AURA_MIN, AURA_STANDARD, resetAura, setAura } from '../home/aura-prefs'
import type { INftCardData } from '../home/collections'
import {
  $liveEconEnabled,
  $liveEconIntervalSecs,
  LIVE_INTERVAL_MAX,
  LIVE_INTERVAL_MIN,
  setLiveEconEnabled,
  setLiveEconIntervalSecs
} from '../home/econ/prefs'
import {
  $fieldCeiling,
  $fieldGlow,
  FIELD_CEILING_MAX,
  FIELD_CEILING_MIN,
  FIELD_CEILING_STANDARD,
  FIELD_GLOW_MAX,
  FIELD_GLOW_MIN,
  FIELD_GLOW_STANDARD,
  resetFieldCeiling,
  resetFieldGlow,
  setFieldCeiling,
  setFieldGlow
} from '../home/field-prefs'
import { deleteInftProfile, sourceFromCard, syncProfileSoul } from '../home/inft-profile'
import { deselectInft, switchInft } from '../home/inft-switch'
import { ICLONE_STORAGE } from '../home/lib/storage-keys'
import { $inftRoster } from '../home/privy-session'
import { $motion, $quality, setMotion, setQuality, type StageQuality } from '../home/stage-prefs'
import { $activeInft } from '../home/stage-store'

import { type AcpSignInHandle, type AcpSignInState, startAcpSignIn } from './inft-acp-signin'
import { InftOwnershipSection } from './inft-ownership-section'
import { type InftPaneCopy, useInftPaneCopy } from './inft-setup-copy'
import { DetachAgentSection } from './inft-setup-detach'
import { SectionHeading, SettingsContent } from './primitives'
import { SettingRow } from './setting-row'

const QUALITIES: StageQuality[] = ['auto', 'high', 'max']
const SIGNED_IN_SHOWN_MS = 3_000
const SIGNED_IN_FADE_MS = 700

const inFlight = (phase: AcpSignInState['phase'] | undefined) => phase === 'starting' || phase === 'waiting'

/** One ACP sign-in per row at a time; `done` shows "Signed in" briefly, then
 *  fades back to the normal row. Unmounting cancels a sign-in still waiting. */
function useAcpSignIn(inftId: string) {
  const [state, setState] = useState<AcpSignInState | null>(null)
  const [fading, setFading] = useState(false)
  const handle = useRef<AcpSignInHandle | null>(null)

  useEffect(() => () => handle.current?.cancel(), [])

  useEffect(() => {
    if (state?.phase === 'cancelled') {
      setState(null)

      return
    }

    if (state?.phase !== 'done') {
      setFading(false)

      return
    }

    const fade = window.setTimeout(() => setFading(true), SIGNED_IN_SHOWN_MS)
    const clear = window.setTimeout(() => setState(null), SIGNED_IN_SHOWN_MS + SIGNED_IN_FADE_MS)

    return () => {
      window.clearTimeout(fade)
      window.clearTimeout(clear)
    }
  }, [state?.phase])

  const start = useCallback(() => {
    if (inFlight(handle.current?.state.phase)) {
      return
    }

    const next = startAcpSignIn(inftId)

    handle.current = next
    setState(next.state)
    next.subscribe(latest => {
      if (handle.current === next) {
        setState(latest)
      }
    })
  }, [inftId])

  return {
    state,
    fading,
    busy: inFlight(state?.phase),
    start,
    openLink: () => handle.current?.openLink(),
    cancel: () => handle.current?.cancel()
  }
}

/** One iNFT → one Hermes profile holding its soul. Build it from the chain,
 *  select it (the persona switch), edit the soul, delete it. Only tokens that
 *  carry an `agent_bootstrap` block can have one — plain NFTs are skipped. */
function ProfileRow({
  card,
  copy,
  exists,
  onChanged
}: {
  card: INftCardData
  copy: InftPaneCopy
  exists: boolean
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [soulDraft, setSoulDraft] = useState('')
  const [loadingSoul, setLoadingSoul] = useState(false)
  const signIn = useAcpSignIn(card.id)

  if (!card.bootstrap) {
    return null
  }

  const source = sourceFromCard(card.id, card.name, card.bootstrap)
  const slug = profileSlugFor(source.contract, source.tokenId)

  if (!source.contract || !source.tokenId) {
    return null
  }

  const shortContract = `${source.contract.slice(0, 6)}…${source.contract.slice(-4)}`
  const openseaUrl = `https://opensea.io/assets/${card.chain.toLowerCase()}/${source.contract}/${source.tokenId}`

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)

    try {
      await fn()
      onChanged()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const openEditor = async () => {
    setEditing(true)
    setLoadingSoul(true)

    try {
      const soul = await getProfileSoul(slug)

      setSoulDraft(soul.content ?? '')
    } catch (err) {
      // Never leave an empty editor open over a real soul: Save would have
      // written the empty draft over SOUL.md.
      setEditing(false)
      setError(errorMessage(err))
    } finally {
      setLoadingSoul(false)
    }
  }

  // Selecting must surface a friendly reason when the persona can't apply —
  // the stage still summons, so the user is never left with a silent failure.
  const doSelect = async () => {
    setBusy(true)
    setError(null)

    try {
      const result = await switchInft(card, { origin: 'settings' })

      if (!result.personaApplied && result.error) {
        setError(result.error)
      }

      onChanged()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const meta = (
    <>
      {card.collection} · {card.chain} · {copy.card.contract} <span className="font-mono">{shortContract}</span> ·{' '}
      <a className="underline underline-offset-2" href={openseaUrl} rel="noreferrer" target="_blank">
        OpenSea
      </a>
    </>
  )

  return (
    <SettingRow
      below={
        <>
          <div className="mt-0.5 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ic-text-2)">
            {exists ? copy.card.ready : copy.card.missing}
          </div>
          {signIn.state?.phase === 'waiting' && (
            <div className="mt-1 text-[length:var(--conversation-caption-font-size)] text-(--ic-text-2)">
              {copy.card.waiting}
            </div>
          )}
          {signIn.state?.phase === 'done' && (
            <span
              className={`mt-1 inline-block rounded-full border border-(--ic-border-subtle) px-2 py-0.5 text-[length:var(--conversation-caption-font-size)] text-(--ic-text-2) transition-opacity duration-700 ${signIn.fading ? 'opacity-0' : 'opacity-100'}`}
            >
              {copy.card.signedIn} ✓
            </span>
          )}
          {editing && (
            <div className="mt-2">
              {loadingSoul ? (
                <div className="text-[length:var(--conversation-caption-font-size)] text-(--ic-text-2)">
                  {copy.card.loadingSoul}
                </div>
              ) : (
                <>
                  <Textarea
                    aria-label={copy.card.soulLabel}
                    className="h-40 font-mono text-xs"
                    onChange={event => setSoulDraft(event.target.value)}
                    spellCheck={false}
                    value={soulDraft}
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <Button
                      disabled={busy || !soulDraft.trim()}
                      onClick={() =>
                        void run(async () => {
                          await updateProfileSoul(slug, soulDraft)
                          await syncProfileSoul(slug, soulDraft)
                          setEditing(false)
                        })
                      }
                      size="sm"
                      type="button"
                    >
                      {copy.card.saveSoul}
                    </Button>
                    <Button onClick={() => setEditing(false)} size="sm" type="button" variant="outline">
                      {copy.card.cancel}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      }
      busy={busy}
      control={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {signIn.state?.phase === 'waiting' ? (
            <>
              <Button onClick={signIn.openLink} size="sm" type="button" variant="outline">
                {copy.card.openLink}
              </Button>
              <Button onClick={signIn.cancel} size="sm" type="button" variant="outline">
                {copy.card.cancel}
              </Button>
            </>
          ) : (
            <Button disabled={busy || signIn.busy} onClick={signIn.start} size="sm" type="button" variant="outline">
              {signIn.busy ? copy.card.signingIn : copy.card.signIn}
            </Button>
          )}
          <Button
            disabled={busy || signIn.busy}
            onClick={() => void doSelect()}
            size="sm"
            type="button"
            variant="outline"
          >
            {busy ? copy.card.selecting : copy.card.select}
          </Button>
          {exists && (
            <>
              <Button disabled={busy} onClick={() => void openEditor()} size="sm" type="button" variant="outline">
                {copy.card.editSoul}
              </Button>
              <Button
                disabled={busy}
                onClick={() => void run(() => deleteInftProfile(slug))}
                size="sm"
                type="button"
                variant="outline"
              >
                {copy.card.remove}
              </Button>
            </>
          )}
        </div>
      }
      error={error ?? (signIn.state?.phase === 'error' ? signIn.state.error : undefined)}
      hint={meta}
      title={
        <>
          {card.name} <span className="font-mono text-(--ic-text-2)">#{source.tokenId}</span>
        </>
      }
    />
  )
}

function InftProfilesList({ copy }: { copy: InftPaneCopy }): JSX.Element {
  const cards = useStore($inftRoster)
  const profiles = useStore($profiles)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    void refreshProfiles().finally(() => setLoaded(true))
  }, [])

  const names = new Set(profiles.map(p => p.name))
  const buildable = cards.filter(card => card.bootstrap)

  if (buildable.length === 0) {
    return <SettingRow hint={loaded ? copy.profiles.empty : copy.profiles.loading} title={copy.profiles.title} />
  }

  return (
    <>
      <SettingRow hint={copy.profiles.hint} title={copy.profiles.title} />
      {buildable.map(card => (
        <ProfileRow
          card={card}
          copy={copy}
          exists={names.has(profileSlugFor(...(card.id.split(':').slice(1) as [string, string])))}
          key={card.id}
          onChanged={() => void refreshProfiles()}
        />
      ))}
    </>
  )
}

/** A section heading inside the pane: a plain sentence, never a feature name. */
function SwitchControl({
  checked,
  label,
  onChange
}: {
  checked: boolean
  label: string
  onChange: (on: boolean) => void
}) {
  return <Switch aria-label={label} checked={checked} onCheckedChange={onChange} />
}

function RangeControl({
  label,
  max,
  min,
  onChange,
  step,
  value
}: {
  label: string
  max: number
  min: number
  onChange: (value: number) => void
  step: number
  value: number
}) {
  return (
    <input
      aria-label={label}
      className="w-44 accent-(--dt-midground)"
      max={max}
      min={min}
      onChange={event => onChange(Number(event.target.value))}
      step={step}
      type="range"
      value={value}
    />
  )
}

export function InftSettings(): JSX.Element {
  const copy = useInftPaneCopy()
  const ceiling = useStore($fieldCeiling)
  const glow = useStore($fieldGlow)
  const aura = useStore($aura)
  const quality = useStore($quality)
  const motion = useStore($motion)
  const activeInft = useStore($activeInft)
  const liveEconEnabled = useStore($liveEconEnabled)
  const liveEconInterval = useStore($liveEconIntervalSecs)
  const atStandard = glow === FIELD_GLOW_STANDARD && ceiling === FIELD_CEILING_STANDARD && aura === AURA_STANDARD

  return (
    <SettingsContent>
      <SettingRow hint={copy.intro.hint} title={copy.intro.title} />

      <SectionHeading icon={Box} title={copy.sections.render} />
      <SettingRow
        control={
          <SegmentedControl
            label={copy.quality.title}
            onChange={setQuality}
            options={QUALITIES.map(id => ({ id, label: copy.quality.options[id] }))}
            semantics="radio"
            value={quality}
          />
        }
        hint={copy.quality.hint}
        title={copy.quality.title}
      />
      <SettingRow
        control={<SwitchControl checked={motion} label={copy.motion.title} onChange={setMotion} />}
        hint={copy.motion.hint}
        title={copy.motion.title}
      />

      <SectionHeading icon={Sun} title={copy.sections.stage} />
      <SettingRow
        control={
          <RangeControl
            label={copy.glow.title}
            max={FIELD_GLOW_MAX}
            min={FIELD_GLOW_MIN}
            onChange={setFieldGlow}
            step={0.05}
            value={glow}
          />
        }
        hint={copy.glow.hint}
        title={copy.glow.title}
      />
      <SettingRow
        control={
          <RangeControl
            label={copy.ceiling.title}
            max={FIELD_CEILING_MAX}
            min={FIELD_CEILING_MIN}
            onChange={setFieldCeiling}
            step={0.01}
            value={ceiling}
          />
        }
        hint={copy.ceiling.hint}
        title={copy.ceiling.title}
      />
      <SettingRow
        control={
          <RangeControl
            label={copy.aura.title}
            max={AURA_MAX}
            min={AURA_MIN}
            onChange={setAura}
            step={0.01}
            value={aura}
          />
        }
        hint={copy.aura.hint}
        title={copy.aura.title}
      />
      <SettingRow
        control={
          <Button
            disabled={atStandard}
            onClick={() => {
              resetFieldGlow()
              resetFieldCeiling()
              resetAura()
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {copy.reset.action}
          </Button>
        }
        hint={atStandard ? copy.reset.atStandard : copy.reset.tuned}
        title={copy.reset.title}
      />

      <SectionHeading icon={Brain} title={copy.sections.profile} />
      {activeInft && (
        <SettingRow
          control={
            <Button onClick={() => void deselectInft('settings')} size="sm" type="button" variant="outline">
              {copy.active.action}
            </Button>
          }
          hint={copy.active.hint}
          title={copy.active.title(activeInft.name)}
        />
      )}
      <InftProfilesList copy={copy} />

      <SectionHeading icon={Activity} title={copy.sections.economy} />
      <SettingRow
        control={<SwitchControl checked={liveEconEnabled} label={copy.live.title} onChange={setLiveEconEnabled} />}
        hint={copy.live.hint}
        title={copy.live.title}
      />
      <SettingRow
        control={
          <RangeControl
            label={copy.interval.title}
            max={LIVE_INTERVAL_MAX}
            min={LIVE_INTERVAL_MIN}
            onChange={setLiveEconIntervalSecs}
            step={5}
            value={liveEconInterval}
          />
        }
        hint={copy.interval.hint(liveEconInterval)}
        title={copy.interval.title}
      />

      <SectionHeading icon={KeyRound} title={copy.sections.ownership} />
      <SettingRow hint={copy.detach.hint} title={copy.detach.title} />
      <DetachAgentSection />
      <SettingRow hint={copy.ownership.hint} title={copy.ownership.title} />
      <InftOwnershipSection />

      <SectionHeading icon={LayoutDashboard} title={copy.sections.collection} />
      <SettingRow hint={copy.autoRefresh.hint} title={copy.autoRefresh.title} />
      <SettingRow
        control={
          <Button
            onClick={() => {
              writeKey(ICLONE_STORAGE.collectionsOrder.key, null)

              window.dispatchEvent(new Event('iclone:cards-order-reset'))
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {copy.order.action}
          </Button>
        }
        hint={copy.order.hint}
        title={copy.order.title}
      />
      <SettingRow hint={copy.cards.hint} title={copy.cards.title} />
    </SettingsContent>
  )
}
