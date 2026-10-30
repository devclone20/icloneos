/**
 * EconomyOS — the small parts every Dock app is built from, so five apps read
 * as one product: the three-zone layout, rail items, stats, rows, pills,
 * notes, skeletons, the agent avatar, money and addresses.
 *
 * Styles live in econ.css under the `.e-` prefix. Nothing here fetches.
 */
import { Check, Copy, ExternalLink, RefreshCw } from 'lucide-react'
import {
  type ButtonHTMLAttributes,
  cloneElement,
  isValidElement,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState
} from 'react'

import { Tip } from '@/components/ui/tooltip'

import { openExternal } from '../lib/external'

import { shortAddress, usd } from './format'

// ── layout ──────────────────────────────────────────────────────────────────

/** rail (folders/sections) · main (list/table) · aside (detail, optional). */
export function AppFrame({
  aside,
  children,
  className,
  rail
}: {
  aside?: ReactNode
  children: ReactNode
  className?: string
  rail?: ReactNode
}) {
  return (
    <div
      className={['e-app', rail ? 'e-app--rail' : '', aside ? 'e-app--aside' : '', className ?? ''].join(' ').trim()}
    >
      {rail ? <nav className="e-rail">{rail}</nav> : null}
      <section className="e-main">{children}</section>
      {aside ? <aside className="e-aside">{aside}</aside> : null}
    </div>
  )
}

export function RailSection({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <div className="e-rail__section">
      {title ? <p className="e-rail__title">{title}</p> : null}
      {children}
    </div>
  )
}

export function RailItem({
  active,
  count,
  icon,
  label,
  onClick,
  tone
}: {
  active?: boolean
  count?: number | string
  icon?: ReactNode
  label: string
  onClick: () => void
  tone?: 'up' | 'down' | 'warn'
}) {
  return (
    <button
      aria-current={active ? 'true' : undefined}
      className={active ? 'e-rail__item e-rail__item--on' : 'e-rail__item'}
      onClick={onClick}
      type="button"
    >
      {icon ? <span className="e-rail__icon">{icon}</span> : null}
      <span className="e-rail__label">{label}</span>
      {count != null && count !== 0 && count !== '' ? (
        <span className={tone ? `e-rail__count e-rail__count--${tone}` : 'e-rail__count'}>{count}</span>
      ) : null}
    </button>
  )
}

/** The strip above a list: search on the left, actions on the right. */
export function Toolbar({ children, end }: { children?: ReactNode; end?: ReactNode }) {
  return (
    <div className="e-toolbar">
      <div className="e-toolbar__start">{children}</div>
      {end ? <div className="e-toolbar__end">{end}</div> : null}
    </div>
  )
}

export function SearchBox({
  autoFocus,
  onChange,
  onSubmit,
  placeholder,
  value
}: {
  autoFocus?: boolean
  onChange: (value: string) => void
  onSubmit?: () => void
  placeholder: string
  value: string
}) {
  return (
    <input
      aria-label={placeholder}
      autoFocus={autoFocus}
      className="e-search"
      onChange={event => onChange(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Enter' && onSubmit) {
          event.preventDefault()
          onSubmit()
        }
      }}
      placeholder={placeholder}
      spellCheck={false}
      type="search"
      value={value}
    />
  )
}

export function Tabs<T extends string>({
  items,
  onChange,
  value
}: {
  items: Array<{ id: T; label: string; count?: number | string }>
  onChange: (id: T) => void
  value: T
}) {
  return (
    <div className="e-tabs" role="tablist">
      {items.map(item => (
        <button
          aria-selected={item.id === value}
          className={item.id === value ? 'e-tab e-tab--on' : 'e-tab'}
          key={item.id}
          onClick={() => onChange(item.id)}
          role="tab"
          type="button"
        >
          {item.label}
          {item.count != null && item.count !== 0 ? <span className="e-tab__count">{item.count}</span> : null}
        </button>
      ))}
    </div>
  )
}

// ── buttons ─────────────────────────────────────────────────────────────────

/**
 * `<Tip>` for a button that can be disabled. A `disabled` button fires no
 * pointer events and leaves the Tab order, so the reason it is disabled —
 * usually said only by its tip — could never be reached. While disabled the
 * button is rendered `aria-disabled` instead (the stylesheets dim either form),
 * its click is swallowed, and it stays the tip's trigger: the same DOM node
 * across the toggle, still focusable, still named.
 */
export function ButtonTip({
  children,
  disabled,
  label,
  tabbable = true
}: {
  children: ReactNode
  disabled?: boolean
  label?: ReactNode
  /** False keeps the disabled button out of the Tab order (a row checkbox). */
  tabbable?: boolean
}) {
  if (!disabled || !label || !isValidElement<ButtonHTMLAttributes<HTMLButtonElement>>(children)) {
    return <Tip label={label}>{children}</Tip>
  }

  return (
    <Tip label={label}>
      {cloneElement(children, {
        'aria-disabled': true,
        disabled: undefined,
        onClick: swallowClick,
        tabIndex: tabbable ? children.props.tabIndex : -1
      })}
    </Tip>
  )
}

function swallowClick(event: MouseEvent<HTMLButtonElement>): void {
  event.preventDefault()
}

export function Action({
  children,
  disabled,
  kind = 'default',
  onClick,
  title
}: {
  children: ReactNode
  disabled?: boolean
  kind?: 'default' | 'primary' | 'quiet'
  onClick: () => void
  title?: string
}) {
  return (
    <ButtonTip disabled={disabled} label={title}>
      <button className={`e-btn e-btn--${kind}`} disabled={disabled} onClick={onClick} type="button">
        {children}
      </button>
    </ButtonTip>
  )
}

export function IconAction({
  children,
  label,
  onClick,
  spinning
}: {
  children: ReactNode
  label: string
  onClick: () => void
  spinning?: boolean
}) {
  return (
    <Tip label={label}>
      <button
        aria-label={label}
        className={spinning ? 'e-ibtn e-ibtn--spin' : 'e-ibtn'}
        onClick={onClick}
        type="button"
      >
        {children}
      </button>
    </Tip>
  )
}

export function RefreshAction({ onClick, spinning }: { onClick: () => void; spinning: boolean }) {
  return (
    <IconAction label="Refresh" onClick={onClick} spinning={spinning}>
      <RefreshCw size={13} strokeWidth={1.8} />
    </IconAction>
  )
}

// ── figures ─────────────────────────────────────────────────────────────────

export function Stat({
  hero,
  label,
  sub,
  tone,
  value
}: {
  hero?: boolean
  label: string
  sub?: ReactNode
  tone?: 'down' | 'up' | 'warn'
  value: ReactNode
}) {
  return (
    <div className={hero ? 'e-stat e-stat--hero' : 'e-stat'}>
      <p className="e-stat__label">{label}</p>
      <p className={tone ? `e-stat__value e-stat__value--${tone}` : 'e-stat__value'}>{value}</p>
      {sub ? <p className="e-stat__sub">{sub}</p> : null}
    </div>
  )
}

export function StatRow({ children }: { children: ReactNode }) {
  return <div className="e-stats">{children}</div>
}

/** A dollar figure — quiet when zero, so an empty wallet does not shout. */
export function Money({ value }: { value: null | number | string | undefined }) {
  const amount = typeof value === 'string' ? Number(value) : value
  const zero = amount == null || !Number.isFinite(amount) || amount === 0

  return <span className={zero ? 'e-money e-money--zero' : 'e-money'}>{usd(value)}</span>
}

/** A signed change — green up, red down, like every trading surface. */
export function Signed({ text, value }: { text: string; value: number }) {
  const tone = value > 0 ? 'up' : value < 0 ? 'down' : ''

  return <span className={tone ? `e-signed e-signed--${tone}` : 'e-signed'}>{text}</span>
}

export function Pill({ children, tone }: { children: ReactNode; tone?: 'down' | 'muted' | 'tone' | 'up' | 'warn' }) {
  return <span className={tone ? `e-pill e-pill--${tone}` : 'e-pill'}>{children}</span>
}

// ── rows ────────────────────────────────────────────────────────────────────

export function Rows({ children }: { children: ReactNode }) {
  return <div className="e-rows">{children}</div>
}

export function Row({
  active,
  children,
  onClick,
  unread
}: {
  active?: boolean
  children: ReactNode
  onClick?: () => void
  unread?: boolean
}) {
  const className = ['e-row', active ? 'e-row--on' : '', unread ? 'e-row--unread' : '', onClick ? 'e-row--click' : '']
    .join(' ')
    .trim()

  if (onClick) {
    return (
      <button aria-current={active ? 'true' : undefined} className={className} onClick={onClick} type="button">
        {children}
      </button>
    )
  }

  return <div className={className}>{children}</div>
}

export function Cell({
  align,
  children,
  grow,
  mono,
  muted,
  width
}: {
  align?: 'end'
  children: ReactNode
  grow?: boolean
  mono?: boolean
  muted?: boolean
  width?: number
}) {
  const className = [
    'e-cell',
    grow ? 'e-cell--grow' : '',
    mono ? 'e-cell--mono' : '',
    muted ? 'e-cell--muted' : '',
    align ? `e-cell--${align}` : ''
  ]
    .join(' ')
    .trim()

  return (
    <span className={className} style={width ? { flexBasis: `${width}px` } : undefined}>
      {children}
    </span>
  )
}

export function SectionTitle({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div className="e-section">
      <h3 className="e-section__title">{children}</h3>
      {end ? <div className="e-section__end">{end}</div> : null}
    </div>
  )
}

// ── states ──────────────────────────────────────────────────────────────────

export function Empty({
  action,
  hint,
  icon,
  title
}: {
  action?: ReactNode
  hint?: string
  icon?: ReactNode
  title: string
}) {
  return (
    <div className="e-empty" role="status">
      {icon ? <div className="e-empty__icon">{icon}</div> : null}
      <p className="e-empty__title">{title}</p>
      {hint ? <p className="e-empty__hint">{hint}</p> : null}
      {action ? <div className="e-empty__action">{action}</div> : null}
    </div>
  )
}

export function Note({ children, kind = 'info' }: { children: ReactNode; kind?: 'error' | 'info' | 'warn' }) {
  return (
    <p className={`e-note e-note--${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      {children}
    </p>
  )
}

export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-busy="true" className="e-skeleton">
      {Array.from({ length: rows }, (_, index) => (
        <div className="e-skeleton__row" key={index} style={{ animationDelay: `${index * 60}ms` }} />
      ))}
    </div>
  )
}

export function SkeletonStats({ count = 3 }: { count?: number }) {
  return (
    <div aria-busy="true" className="e-stats">
      {Array.from({ length: count }, (_, index) => (
        <div className="e-stat e-stat--skeleton" key={index} />
      ))}
    </div>
  )
}

// ── identity + addresses ────────────────────────────────────────────────────

export function Avatar({ name, size = 28, src }: { name: string; size?: number; src?: string }) {
  const [broken, setBroken] = useState(false)

  if (src && !broken) {
    // Two dozen remote avatars per market page: decode off the main thread,
    // and only when they scroll into view.
    return (
      <img
        alt=""
        className="e-avatar"
        decoding="async"
        height={size}
        loading="lazy"
        onError={() => setBroken(true)}
        src={src}
        width={size}
      />
    )
  }

  const initials =
    name
      .replace(/[^a-z0-9#]/gi, '')
      .slice(0, 2)
      .toUpperCase() || '·'

  return (
    <span
      aria-hidden="true"
      className="e-avatar e-avatar--text"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {initials}
    </span>
  )
}

function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) {
      return
    }

    const timer = window.setTimeout(() => setCopied(false), 1400)

    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = useCallback((text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch(() => undefined)
  }, [])

  return [copied, copy]
}

/** A mono address with copy, and an explorer link when there is one. */
export function AddressChip({ address, href, label }: { address: string; href?: string; label?: string }) {
  const [copied, copy] = useCopied()

  return (
    <span className="e-addr">
      {label ? <span className="e-addr__label">{label}</span> : null}
      <Tip label={address}>
        <button className="e-addr__value" onClick={() => copy(address)} type="button">
          <span>{shortAddress(address)}</span>
          {copied ? <Check size={11} strokeWidth={2.2} /> : <Copy size={11} strokeWidth={1.8} />}
        </button>
      </Tip>
      {href ? (
        <Tip label={href}>
          <button
            aria-label="Open in explorer"
            className="e-addr__link"
            onClick={() => openExternal(href)}
            type="button"
          >
            <ExternalLink size={11} strokeWidth={1.8} />
          </button>
        </Tip>
      ) : null}
    </span>
  )
}

export function CopyText({ text }: { text: string }) {
  const [copied, copy] = useCopied()

  return (
    <Tip label="Copy">
      <button aria-label={copied ? 'Copied' : 'Copy'} className="e-ibtn" onClick={() => copy(text)} type="button">
        {copied ? <Check size={12} strokeWidth={2.2} /> : <Copy size={12} strokeWidth={1.8} />}
      </button>
    </Tip>
  )
}

export function Link({ children, href }: { children: ReactNode; href: string }) {
  return (
    <Tip label={href}>
      <button className="e-link" onClick={() => openExternal(href)} type="button">
        {children}
        <ExternalLink size={10} strokeWidth={1.8} />
      </button>
    </Tip>
  )
}
