import './page-frame.css'

import { type ComponentType, type ReactNode, useRef } from 'react'

import { X } from '@/lib/icons'

import { OVERLAY_SURFACE_MARKER, useOverlaySurface } from '../overlays/use-overlay-surface'

/**
 * OUR page frame — the one window shape every E3d3 page wears (cron, agents,
 * and the Command Center pane). It is built on `--ic-*` tokens and our own
 * markup only: no upstream card, no titlebar import, no `--ui-*` reference.
 *
 * `frame`, the same vocabulary `IcPage` uses, deliberately:
 * - 'card' (the default) — the page floats over the home stage and owns the
 *   scrim, the ✕ and Esc. What it keeps from the old overlay is pure
 *   behaviour, not visuals: `useOverlaySurface` (focus in, Tab trapped, focus
 *   returned, Esc at the overlay priority) and the surface marker that tells
 *   the composer's type-to-focus it is covered.
 * - 'bare' (front K5) — a shell already drew the card: the Command Center
 *   lives inside the Settings body now, which owns Esc, the ✕ and the surface
 *   marker, so a second card, a second close control and a second focus trap
 *   would all be wrong. The head, the section rail and the main column are
 *   identical; only the window around them is gone.
 *
 * Layout: head (title · hint · tools) + optional rail of sections + main. The
 * frame never resizes (E4) and never traps the user: in 'card', Esc, the ✕ and
 * a press that starts AND ends on the scrim all close it.
 */

export interface PageFrameSection<T extends string> {
  icon?: ComponentType<{ size?: number | string }>
  id: T
  label: string
}

interface PageFrameContentProps<T extends string> {
  children: ReactNode
  /** Secondary line under the title; one sentence, never a paragraph. */
  hint?: string
  onSelectSection?: (id: T) => void
  section?: T
  sections?: readonly PageFrameSection<T>[]
  title: string
  /** Search field, segmented control, refresh — page chrome, right of the title. */
  tools?: ReactNode
}

// A card MUST carry its close affordances and a bare page must not: the union
// is what makes `<PageFrame frame="bare" onClose={…}>` a type error instead of
// a second ✕ nobody notices in review.
type PageFrameProps<T extends string> =
  | (PageFrameContentProps<T> & { closeLabel?: never; frame: 'bare'; onClose?: never })
  | (PageFrameContentProps<T> & { closeLabel: string; frame?: 'card'; onClose: () => void })

function PageFrameContent<T extends string>({
  children,
  hint,
  onSelectSection,
  section,
  sections,
  title,
  tools
}: PageFrameContentProps<T>) {
  return (
    <>
      <header className="icpage__head">
        <div className="icpage__ident">
          <h2 className="icpage__title">{title}</h2>
          {hint ? <p className="icpage__hint">{hint}</p> : null}
        </div>
        {tools ? <div className="icpage__tools">{tools}</div> : null}
      </header>

      <div className="icpage__body">
        {sections && sections.length > 0 ? (
          <nav aria-label={title} className="icpage__rail">
            {sections.map(item => {
              const Icon = item.icon

              return (
                <button
                  aria-current={item.id === section ? 'page' : undefined}
                  className="icpage__railitem"
                  key={item.id}
                  onClick={() => onSelectSection?.(item.id)}
                  type="button"
                >
                  {Icon ? <Icon size={15} /> : null}
                  {item.label}
                </button>
              )
            })}
          </nav>
        ) : null}

        <div className="icpage__main">{children}</div>
      </div>
    </>
  )
}

function CardPageFrame<T extends string>({
  closeLabel,
  onClose,
  ...content
}: PageFrameContentProps<T> & { closeLabel: string; onClose: () => void }) {
  const frameRef = useOverlaySurface<HTMLDivElement>(onClose)

  // A scrim click only dismisses when the press ALSO began on the scrim:
  // Chrome fires `click` on the common ancestor of press and release, so a
  // selection dragged out of the frame would otherwise close the page.
  const pressOnScrim = useRef(false)

  return (
    <div
      className="icpage"
      {...OVERLAY_SURFACE_MARKER}
      onClick={event => {
        const started = pressOnScrim.current
        pressOnScrim.current = false

        if (started && event.target === event.currentTarget) {
          onClose()
        }
      }}
      onPointerDown={event => {
        pressOnScrim.current = event.target === event.currentTarget
      }}
      role="presentation"
    >
      {/* Marks the plate as a RAISED surface for the window glass: while the
          field behind it thins to show the stage, this plate stays opaque. */}
      <div className="icpage__frame" data-glass-raised="" ref={frameRef} tabIndex={-1}>
        <div className="icpage__drag" />

        <div className="icpage__controls">
          <button aria-label={closeLabel} className="icpage__close" onClick={onClose} type="button">
            <X size={14} />
          </button>
        </div>

        <PageFrameContent {...(content as PageFrameContentProps<T>)} />
      </div>
    </div>
  )
}

export function PageFrame<T extends string>(props: PageFrameProps<T>) {
  if (props.frame === 'bare') {
    return (
      <div className="icpage-embed" data-ic-page-embed="">
        <PageFrameContent
          hint={props.hint}
          onSelectSection={props.onSelectSection}
          section={props.section}
          sections={props.sections}
          title={props.title}
          tools={props.tools}
        >
          {props.children}
        </PageFrameContent>
      </div>
    )
  }

  return <CardPageFrame {...props} />
}
