import { useStore } from '@nanostores/react'
import { useInRouterContext, useNavigate } from 'react-router'

import { $inftSwitch, deselectInft, inftSwitchLabel, retryInftSwitch, switchInft } from '@/app/home/inft-switch'
import { $ownership, isDeactivated, ownershipForId } from '@/app/home/ownership'
import { $inftRoster } from '@/app/home/privy-session'
import { $activeInft } from '@/app/home/stage-store'
import type { OpenSessionNavigate } from '@/app/open-session'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { ChevronDown } from '@/lib/icons'
import { cn } from '@/lib/utils'

// Same grammar as the model pill: a shrinkable control that gives width back
// before Send does. Side by side with the model selector — the iNFT you talk
// to is a personality choice, not a model choice.
const PILL = cn(
  'h-(--composer-control-size) min-w-0 max-w-36 shrink gap-1 rounded-md px-2 text-xs font-normal',
  'text-(--ic-text-2) hover:bg-(--ic-fill-hover) hover:text-[color:var(--ic-text-1)]'
)

/**
 * Composer iNFT selector — sits beside the model pill. Lists every iNFT in the
 * collection that carries a soul, plus "Hermes (default)". Selecting one is a
 * lightweight switch (stage GLB + personality + EconomyOS) — never a reload,
 * never a wallet re-login. Selecting in the collection lands here and vice
 * versa, because both read/write the same `$activeInft`.
 */
interface InftPillProps {
  compact?: boolean
  disabled: boolean
}

/** With a router the pick reopens the iNFT's own last chat; a composer
 *  rendered outside one (isolated tests) still switches the persona. */
export function InftPill(props: InftPillProps) {
  return useInRouterContext() ? <RoutedInftPill {...props} /> : <InftPillView {...props} />
}

function RoutedInftPill(props: InftPillProps) {
  const navigate = useNavigate()

  return <InftPillView {...props} navigate={navigate} />
}

function InftPillView({ compact = false, disabled, navigate }: InftPillProps & { navigate?: OpenSessionNavigate }) {
  const cards = useStore($inftRoster)
  const active = useStore($activeInft)
  // The switch is rendered from the one door's state machine: the menu stays
  // usable while a switch runs (a new pick supersedes it) and the reason a
  // persona did not apply stays on the pill until the next switch.
  const state = useStore($inftSwitch)

  const ownership = useStore($ownership)
  const activeOff = isDeactivated(ownershipForId(ownership, active?.id))

  const withSoul = cards.filter(card => card.bootstrap)

  // Nothing to switch to (no iNFT with a soul scanned yet) — hide entirely.
  if (withSoul.length === 0) {
    return null
  }

  const switching = state.phase === 'resolving' || state.phase === 'applying' || state.phase === 'waiting'
  const failed = state.phase === 'failed'
  const tip = state.phase === 'idle' ? 'Switch iNFT' : inftSwitchLabel(state)

  const label = compact ? (
    <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
  ) : (
    <>
      {failed ? <span aria-hidden="true">⚠</span> : null}
      <span className={cn('truncate', switching && 'opacity-70')}>
        {switching
          ? `${state.name}…`
          : activeOff && active
            ? `#${active.id.split(':').pop()} · deactivated`
            : (active?.name ?? 'Hermes')}
      </span>
      <ChevronDown aria-hidden="true" className="size-2.5 shrink-0 opacity-50" />
    </>
  )

  const pillClass = compact
    ? cn(
        'size-(--composer-control-size) shrink-0 justify-center gap-0 rounded-md p-0',
        'text-(--ic-text-2) hover:bg-(--ic-fill-hover) hover:text-[color:var(--ic-text-1)]'
      )
    : PILL

  return (
    <DropdownMenu>
      <Tip label={tip} side="top">
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="Switch iNFT"
            className={pillClass}
            data-switch-phase={state.phase}
            disabled={disabled}
            type="button"
            variant="ghost"
          >
            {label}
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="w-56 p-1" side="top" sideOffset={8}>
        <DropdownMenuLabel className="text-xs">iNFT</DropdownMenuLabel>
        {failed ? (
          <DropdownMenuItem className="text-xs" onSelect={() => void retryInftSwitch()}>
            <span className="truncate">Retry {state.name}</span>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          className={cn('text-xs', !active && 'font-medium')}
          onSelect={() => void deselectInft('pill')}
        >
          Hermes (default)
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {withSoul.map(card => (
          <DropdownMenuItem
            className={cn('text-xs', active?.id === card.id && 'font-medium')}
            key={card.id}
            onSelect={() => void switchInft(card, { origin: 'pill', navigate })}
          >
            <span className="truncate">
              {card.name}
              {isDeactivated(ownershipForId(ownership, card.id)) ? ' · deactivated' : ''}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
