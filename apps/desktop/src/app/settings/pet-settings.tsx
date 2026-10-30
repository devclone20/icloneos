import { useStore } from '@nanostores/react'
import { useMemo, useState } from 'react'

import { usePet } from '@/components/pet/pet-catalog'
import { PET_CATALOG, PET_LEGIONS, PET_SCALE_MAX, PET_SCALE_MIN, type PetCatalogEntry } from '@/components/pet/pet-ids'
import { PetSprite } from '@/components/pet/pet-sprite'
import { Button } from '@/components/ui/button'
import { SearchField } from '@/components/ui/search-field'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { PawPrint } from '@/lib/icons'
import { selectableCardClass } from '@/lib/selectable-card'
import { cn } from '@/lib/utils'
import { $petId, $petRoam, $petScale, choosePet, removePet, setPetRoam, setPetScale } from '@/store/pet'
import { $petOverlayActive, popInPet, popOutPet } from '@/store/pet-overlay'

import { SectionHeading } from './primitives'
import { SettingRow } from './setting-row'

/** The section's anchor (the Appearance pane's "Pet" link scrolls here). */
const PET_SETTINGS_ELEMENT_ID = 'settings-pet'

/** Scroll the Pet section into view once the Appearance pane has rendered it (a few frames at most). */
export function revealPetSettings(attempts = 20): void {
  const el = document.getElementById(PET_SETTINGS_ELEMENT_ID)

  if (el) {
    el.scrollIntoView({ block: 'start' })

    return
  }

  if (attempts > 0) {
    requestAnimationFrame(() => revealPetSettings(attempts - 1))
  }
}

const SCALES = Array.from({ length: PET_SCALE_MAX - PET_SCALE_MIN + 1 }, (_, i) => PET_SCALE_MIN + i)

/** A search over the library: the number (`#87`, `87`), the id or the legion. */
export function matchesPetQuery(entry: PetCatalogEntry, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/^#/, '')

  return !q || entry.name.slice(1).includes(q) || entry.id.includes(q) || entry.legion.includes(q)
}

/** Where the in-window pet stands (the pop-out opens over it), else the window's bottom-right. */
function inWindowPetRect() {
  const canvas = document.querySelector('[data-pet-host] canvas')
  const r = canvas?.getBoundingClientRect()

  return r && r.width > 0
    ? { height: r.height, width: r.width, x: r.left, y: r.top }
    : { height: 69, width: 43, x: window.innerWidth - 120, y: window.innerHeight - 160 }
}

/**
 * Settings › Machine › Appearance › Pet — the pet LIBRARY (V3-P, owner's rule): the twenty pixel
 * robots by legion, each drawn live at scale 1 with its number and a Choose action. Nothing of the pet exists in
 * the app until one is chosen; choosing brings it in at once, Remove takes it out again. Scale, roam and the
 * pop-out stay disabled, with the reason, until there is a pet.
 */
export function PetSettings() {
  const { t } = useI18n()
  const p = t.settings.appearance.pet
  const selected = useStore($petId)
  const scale = useStore($petScale)
  const roam = useStore($petRoam)
  const overlayActive = useStore($petOverlayActive)
  const [query, setQuery] = useState('')
  const chosen = selected ? PET_CATALOG.find(entry => entry.id === selected) : undefined
  const off = !chosen
  const visible = useMemo(() => PET_CATALOG.filter(entry => matchesPetQuery(entry, query)), [query])

  return (
    <div data-pet-library="" id={PET_SETTINGS_ELEMENT_ID}>
      <SectionHeading
        aside={
          chosen ? (
            <Button
              onClick={() => {
                triggerHaptic('crisp')
                removePet()
              }}
              size="inline"
              variant="text"
            >
              {p.remove}
            </Button>
          ) : undefined
        }
        icon={PawPrint}
        meta={chosen ? chosen.name : p.off}
        title={p.title}
      />
      <p className="mb-2 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
        {p.intro}
      </p>

      <SettingRow
        control={
          <SegmentedControl
            disabled={off}
            onChange={id => {
              triggerHaptic('selection')
              setPetScale(Number(id))
            }}
            options={SCALES.map(n => ({ id: String(n), label: p.scaleValue(n) }))}
            value={String(scale)}
          />
        }
        disabled={off}
        field
        hint={off ? p.needsPet : p.scaleDesc}
        title={p.scaleTitle}
      />

      <SettingRow
        control={
          <Switch
            aria-label={p.roamTitle}
            checked={roam}
            disabled={off}
            onCheckedChange={on => {
              triggerHaptic('selection')
              setPetRoam(on)
            }}
          />
        }
        disabled={off}
        hint={off ? p.needsPet : p.roamDesc}
        title={p.roamTitle}
      />

      <SettingRow
        control={
          <Button
            disabled={off}
            onClick={() => {
              triggerHaptic('crisp')

              if (overlayActive) {
                popInPet()
              } else {
                popOutPet(inWindowPetRect())
              }
            }}
            size="sm"
            variant="outline"
          >
            {overlayActive ? p.popIn : p.popOut}
          </Button>
        }
        disabled={off}
        hint={off ? p.needsPet : p.popOutDesc}
        title={p.popOutTitle}
      />

      <SettingRow
        below={
          <div className="mt-1 grid gap-4">
            {visible.length === 0 && (
              <p className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
                {p.noMatch(query.trim())}
              </p>
            )}
            {PET_LEGIONS.map(legion => {
              const pets = visible.filter(entry => entry.legion === legion)

              return pets.length ? (
                <div data-pet-legion={legion} key={legion}>
                  <div className="mb-1.5 text-[length:var(--conversation-caption-font-size)] font-medium text-(--ui-text-secondary)">
                    {p.legions[legion]}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {pets.map(entry => (
                      <PetTile
                        active={entry.id === selected}
                        chooseLabel={p.choose(entry.name)}
                        entry={entry}
                        key={entry.id}
                        status={entry.id === selected ? p.chosen : p.chooseAction}
                      />
                    ))}
                  </div>
                </div>
              ) : null
            })}
          </div>
        }
        control={
          <SearchField aria-label={p.searchTitle} onChange={setQuery} placeholder={p.searchPlaceholder} value={query} />
        }
        field
        hint={`${p.chooseDesc} ${p.count(PET_CATALOG.length)}`}
        title={p.chooseTitle}
      />
    </div>
  )
}

interface PetTileProps {
  entry: PetCatalogEntry
  active: boolean
  status: string
  chooseLabel: string
}

/** One pet of the library: the robot itself, live at scale 1, its number, and the Choose action. */
function PetTile({ entry, active, status, chooseLabel }: PetTileProps) {
  const pet = usePet(entry.id)

  return (
    <button
      aria-label={chooseLabel}
      aria-pressed={active}
      className={cn('flex w-20 flex-col items-center gap-1 p-1.5', selectableCardClass({ active, prominent: true }))}
      data-pet-choice={entry.id}
      onClick={() => {
        triggerHaptic('crisp')
        choosePet(entry.id)
      }}
      type="button"
    >
      <span className="grid h-[69px] w-[43px] place-items-center">
        {pet && <PetSprite label={entry.name} pet={pet} scale={1} state="idle" />}
      </span>
      <span className="text-[length:var(--conversation-caption-font-size)] font-medium tabular-nums">{entry.name}</span>
      <span
        className={cn(
          'text-[length:var(--conversation-caption-font-size)]',
          active ? 'text-primary' : 'text-(--ui-text-tertiary)'
        )}
      >
        {status}
      </span>
    </button>
  )
}
