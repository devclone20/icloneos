import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { releaseTypingFocus } from '@/components/ui/keyboard-first'
import { useI18n } from '@/i18n'
import { ChevronDown } from '@/lib/icons'
import { modelOptionsQueryKey, requestModelOptions } from '@/lib/model-options'
import { queryClient } from '@/lib/query-client'
import { reasoningEffortLabel } from '@/lib/reasoning-effort'
import {
  effortDots,
  effortWireState,
  type RouteCapabilities,
  routeDefaultEffort,
  routeEffortCatalog,
  routeEffortLevels,
  type RouteOptions,
  routeSentLevel,
  RUNTIME_EFFORT_ROUTES
} from '@/lib/reasoning-levels'
import { normalize } from '@/lib/text'
import { cn } from '@/lib/utils'
import { $gateway } from '@/store/gateway'
import { selectModelEffort } from '@/store/model-presets'
import { $activeGatewayProfile } from '@/store/profile'
import { $defaultReasoningEffort, $reasoningEffortWire } from '@/store/session'
import type { ModelOptionProvider, ModelPricing } from '@/types/hermes'

import { EFFORT_MENU_COPY as COPY } from './effort-menu.copy'

const LADDER = RUNTIME_EFFORT_ROUTES?.ladder ?? []

const request = <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
  const gateway = $gateway.get()

  return gateway ? gateway.request<T>(method, params) : Promise.reject(new Error('Gateway is not connected'))
}

// `api_mode` is not on the row type yet (request to L5/P4c); the route reads it once the runtime sends it.
type RouteRow = ModelOptionProvider & { api_mode?: string }

const providerRow = (providers: RouteRow[] | undefined, provider: string) =>
  providers?.find(p => p.slug === provider || p.name === provider || p.aliases?.includes(provider))

interface RouteEffort {
  caps: RouteCapabilities | null
  /** Display name of a provider catalog that may still lower the level ('' = the levels are what is sent). */
  catalog?: string
  levels: string[]
  /** The route as the runtime resolves it (capabilities, base URL, API mode); every route helper takes it. */
  options: RouteOptions
  pricing: ModelPricing | null
  /** The catalog answered: `caps` is what the runtime knows, not "not loaded yet". */
  ready: boolean
}

/**
 * The effort levels the current route sends verbatim (runtime table) plus the
 * model's capabilities and price from the `model.options` catalog. The catalog
 * shares the model menu's query key, so it is one request per (profile,
 * session), and levels are offered only once it has answered: a model the
 * runtime says has no reasoning never shows a level, not even for a moment.
 */
export function useRouteEffort(provider: string, model: string): RouteEffort {
  const view = useSessionView()
  const sessionId = useStore(view.$runtimeId)
  const profile = useStore($activeGatewayProfile)
  const gateway = useStore($gateway)

  const catalog = useQuery(
    {
      enabled: Boolean(gateway),
      queryKey: modelOptionsQueryKey(profile, sessionId),
      queryFn: () => requestModelOptions({ gateway: gateway ?? undefined, profile, sessionId })
    },
    queryClient
  )

  const row = providerRow(catalog.data?.providers, provider)
  const caps = row?.capabilities?.[model] ?? null
  const options: RouteOptions = { apiMode: row?.api_mode || undefined, baseUrl: row?.api_url || undefined, caps }
  const lowering = catalog.isSuccess ? routeEffortCatalog(provider, model, options) : ''

  return {
    caps,
    catalog: lowering ? row?.name || lowering : '',
    levels: catalog.isSuccess ? routeEffortLevels(provider, model, options) : [],
    options,
    pricing: row?.pricing?.[model] ?? null,
    ready: catalog.isSuccess
  }
}

const levelName = (level: string, names: Record<string, string>): string => names[level] ?? reasoningEffortLabel(level)

function Dots({ level }: { level: string }) {
  const filled = effortDots(level, LADDER)

  return (
    <span aria-hidden="true" className="ml-auto flex items-center gap-0.5" data-testid="effort-dots">
      {[1, 2, 3, 4, 5].map(i => (
        <span
          className={cn('size-1 rounded-full', i <= filled ? 'bg-(--ic-text-ramp-80)' : 'bg-(--ic-border-subtle)')}
          key={i}
        />
      ))}
    </span>
  )
}

/**
 * Composer Effort popover: exactly the levels the active route sends verbatim
 * (never a hard-coded list), the model's output price as the runtime formats
 * it, a "sends X" note when the runtime echoes a different wire level, and the
 * Thinking switch when the route can turn reasoning off. The pick persists per
 * model (`model-presets`) and is written to the live session with `config.set`.
 */
export function EffortMenu({
  disabled,
  model,
  onOpenChange,
  provider,
  route
}: {
  disabled: boolean
  model: string
  onOpenChange?: (open: boolean) => void
  provider: string
  route: RouteEffort
}) {
  const { t } = useI18n()
  const names = t.shell.modelOptions as unknown as Record<string, string>
  const view = useSessionView()
  const requested = normalize(useStore(view.$reasoningEffort))
  const sessionId = useStore(view.$runtimeId)
  const defaultEffort = normalize(useStore($defaultReasoningEffort))
  const wire = useStore($reasoningEffortWire)
  const [open, setOpen] = useState(false)
  const { caps, levels, pricing } = route
  const effective = requested || defaultEffort || routeDefaultEffort(levels, LADDER)
  const thinkingOn = effective !== 'none'
  const listed = levels.includes(effective)
  const wireState = view.kind === 'primary' ? effortWireState(effective, wire) : 'unknown'
  // A catalog-lowered route (OpenRouter) may send less than any listed level:
  // no checkmark claims the pick is what goes out, a note says so instead.
  const mayLower = thinkingOn && listed && wireState !== 'clamped' ? (route.catalog ?? '') : ''

  // The wire echo is the entry clamp; the table carries what the transport
  // then sends (e.g. xhigh -> max on Claude without xhigh). A clamped echo of
  // a listed level means the table is behind the runtime: that row is marked.
  const sends = thinkingOn
    ? routeSentLevel(provider, model, wireState === 'clamped' ? normalize(wire) : effective, route.options) ||
      (wireState === 'clamped' ? normalize(wire) : '')
    : ''

  const canDisable = caps?.can_disable_reasoning !== false
  const label = thinkingOn ? levelName(effective, names) : COPY.off

  const choose = (effort: string) => {
    if (effort === effective) {
      return
    }

    void selectModelEffort(
      { effort, model, previous: requested, provider },
      { failMessage: t.shell.modelOptions.updateFailed, primary: view.kind === 'primary', request, sessionId }
    )
  }

  const setMenuOpen = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)

    if (!next) {
      releaseTypingFocus()
    }
  }

  return (
    <DropdownMenu onOpenChange={setMenuOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={COPY.trigger(label)}
          className={cn(
            'h-(--composer-control-size) shrink-0 gap-1 rounded-md px-1.5 text-xs font-normal',
            'text-(--ic-text-2) hover:bg-(--ic-fill-hover) hover:text-[color:var(--ic-text-1)]',
            thinkingOn && !listed && 'text-(--ic-warning)'
          )}
          data-testid="effort-trigger"
          disabled={disabled}
          type="button"
          variant="ghost"
        >
          <span className="truncate">{label}</span>
          <ChevronDown aria-hidden="true" className="size-2.5 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-58 p-1" data-testid="effort-menu" side="top" sideOffset={8}>
        <div className="flex h-8 items-center gap-2 px-2 text-[0.6875rem] text-(--ic-text-2)">
          <span className="font-medium tracking-wide uppercase">{COPY.title}</span>
          {pricing?.output ? (
            <span className="ml-auto tabular-nums" data-testid="effort-price" title={COPY.costHint}>
              {COPY.outputPrice(pricing.output)}
            </span>
          ) : null}
        </div>
        <DropdownMenuRadioGroup onValueChange={choose} value={thinkingOn && listed && !mayLower ? effective : ''}>
          {levels.map(level => (
            <DropdownMenuRadioItem
              className={cn('h-8 gap-2 px-2', level === effective && wireState === 'clamped' && 'text-(--ic-warning)')}
              data-effort={level}
              data-requested={mayLower && level === effective ? 'true' : undefined}
              data-unsupported={level === effective && wireState === 'clamped' ? 'true' : undefined}
              key={level}
              value={level}
            >
              <span className="min-w-0 truncate">{levelName(level, names)}</span>
              <Dots level={level} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {thinkingOn && (!listed || wireState === 'clamped') ? (
          <p className="px-2 py-1.5 text-[0.6875rem] text-(--ic-warning)" data-testid="effort-wire-note" role="note">
            {sends && sends !== effective ? COPY.sends(levelName(sends, names)) : COPY.notOnRoute(label)}
          </p>
        ) : null}
        {mayLower ? (
          <p
            className="px-2 py-1.5 text-[0.6875rem] text-(--ic-text-ramp-80)"
            data-testid="effort-catalog-note"
            role="note"
          >
            {COPY.catalogMayLower(mayLower, levelName(effective, names))}
          </p>
        ) : null}
        {canDisable ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={thinkingOn}
              className="h-8"
              onCheckedChange={on => choose(on ? routeDefaultEffort(levels, LADDER) : 'none')}
              onSelect={event => event.preventDefault()}
            >
              {COPY.thinking}
            </DropdownMenuCheckboxItem>
          </>
        ) : null}
        <p className="px-2 pt-1 pb-1.5 text-[0.6875rem] leading-snug text-(--ic-text-2)">{COPY.costHint}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
