/**
 * MCP — the server row and the small controls it is made of (E3 decision #8).
 * Moved out of the 1 862-line `mcp-tab.tsx` unchanged except for the design:
 * the avatar, the status dot, the switch and the icon actions are ours now.
 */

import { RotateCw, Trash2 } from 'lucide-react'
import type { CSSProperties } from 'react'

import { useI18n } from '@/i18n'
import { brandFor } from '@/lib/mcp-brands'
import { cn } from '@/lib/utils'

import { IcDot, IcSwitch } from '../../profiles/ic-page'
import { prettyName } from '../../settings/helpers'

import { aimHint } from './hint'
import { type ServerStatus, statusTone } from './servers'

// ---------------------------------------------------------------------------
// Avatars + list rows
// ---------------------------------------------------------------------------

// OUR identity chip (E3 decision #8): the curated brand glyph on a tint of
// its own colour, on our `.icpg__avatar` element and our tokens — never the
// upstream `AvatarChip`. Identity ladder: curated brand glyph
// (`lib/mcp-brands`) → letter monogram. Nothing here reaches the network for a
// mark: a configured MCP URL can be a private host.
export function McpAvatar({ className, name, status }: { className?: string; name: string; status: ServerStatus }) {
  const brand = brandFor(name)
  const Icon = brand?.Icon

  return (
    <span className={className ? `icsk__avatar ${className}` : 'icsk__avatar'}>
      <span
        aria-hidden="true"
        className="icpg__avatar"
        style={
          {
            '--icpg-brand': brand?.monochrome ? 'var(--ic-text-1)' : (brand?.color ?? 'var(--ic-text-3)')
          } as CSSProperties
        }
      >
        {Icon ? (
          <Icon height={14} width={14} />
        ) : (
          <span className="icpg__avatar-mono">{(name.trim()[0] ?? '?').toUpperCase()}</span>
        )}
      </span>
      <span className="icsk__avatar-dot">
        <IcDot tone={statusTone(status)} />
      </span>
    </span>
  )
}

// The enable toggle, shared by the row and the config header. It reflects the
// configured `enabled` flag ONLY — full-strength when on, dimmed when off — so
// "is this on?" reads instantly from config, never gated on a probe that can
// take seconds (stdio servers spawn `npx`). Whether it's actually *connected*
// is the status dot's job, not the switch's.
export function ServerSwitch({
  className,
  disabled,
  enabled,
  name,
  onToggle
}: {
  className?: string
  disabled: boolean
  enabled: boolean
  name: string
  onToggle: (checked: boolean) => void
}) {
  // IcSwitch is the one switch (LEAD_ic_primitives_one_home) and takes no
  // className, so the dimming and the caller's offset live on a page-local
  // wrapper instead of on the control.
  return (
    <span className={cn('icsk__srv-switch', className)} data-ic-off={enabled ? undefined : ''}>
      <IcSwitch checked={enabled} disabled={disabled} label={name} onChange={onToggle} />
    </span>
  )
}

// Refresh + delete, identical beside every toggle (rows and config header).
export function ServerIconActions({
  className,
  onProbe,
  onRemove,
  probing,
  saving
}: {
  className?: string
  onProbe: () => void
  onRemove: () => void
  probing: boolean
  saving: boolean
}) {
  const { t } = useI18n()
  const m = t.settings.mcp

  // No Ic* tooltip exists yet (lead request, r2 + r3 + r4 handoffs). `title` is
  // forbidden (DESIGN.md), so `aria-label` is the single source of the name and
  // `.icsk__iconbtn` draws it on hover/focus from that same attribute. These
  // rows live inside the list's own scroller, so `aimHint` picks the side with
  // room before the bubble shows (see ./hint).
  return (
    <span className={cn('flex items-center gap-0.5', className)}>
      <button
        aria-label={m.reload}
        className="icsk__iconbtn"
        disabled={probing}
        onClick={onProbe}
        onFocus={aimHint}
        onPointerEnter={aimHint}
        type="button"
      >
        <RotateCw aria-hidden="true" className={probing ? 'icsk__spin' : undefined} size={13} />
      </button>
      <button
        aria-label={m.remove}
        className="icsk__iconbtn icsk__iconbtn--danger"
        disabled={saving}
        onClick={onRemove}
        onFocus={aimHint}
        onPointerEnter={aimHint}
        type="button"
      >
        <Trash2 aria-hidden="true" size={13} />
      </button>
    </span>
  )
}

export function McpRow({
  active,
  busy,
  enabled,
  name,
  onProbe,
  onRemove,
  onSelect,
  onToggle,
  status,
  statusText,
  unused
}: {
  active: boolean
  busy: boolean
  enabled: boolean
  name: string
  onProbe: () => void
  onRemove: () => void
  onSelect: () => void
  onToggle: (checked: boolean) => void
  status: ServerStatus
  statusText: string
  unused?: boolean
}) {
  const { t } = useI18n()
  const m = t.settings.mcp

  return (
    <div
      className={cn(
        'group/row flex h-11 w-full shrink-0 items-center gap-2 icsk__mcprow',
        active ? 'icsk__mcprow--active' : undefined
      )}
      id={`mcp-server-${name}`}
    >
      <button
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        onClick={onSelect}
        type="button"
      >
        <McpAvatar name={name} status={status} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={cn('icsk__srv-name min-w-0 truncate', !enabled && 'icsk__srv-name--off')}>
              {prettyName(name)}
            </span>
            {/* Subtle "paying for schemas, not using them" hint — a muted pill,
                never a dialog. Shown only when the overlay KNOWS both halves:
                nonzero schema cost and zero 30-day uses. */}
            {unused && <span className="icsk__chip icsk__chip--hint">{m.unusedPill}</span>}
          </span>
          <span className="icsk__srv-status block truncate">{statusText}</span>
        </span>
      </button>
      <ServerIconActions
        className="opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100"
        onProbe={onProbe}
        onRemove={onRemove}
        probing={status === 'probing'}
        saving={busy}
      />
      <ServerSwitch disabled={busy} enabled={enabled} name={name} onToggle={onToggle} />
    </div>
  )
}
