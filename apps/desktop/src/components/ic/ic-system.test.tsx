import { readFileSync } from 'node:fs'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stubResizeObserver } from '@/test/jsdom'

import {
  IcButton,
  IcCopyButton,
  IcDialog,
  IcDialogTitle,
  IcInput,
  IcLog,
  IcProgress,
  IcSpinner,
  IcSurfaceState,
  IcTip
} from './ic-system'

afterEach(cleanup)

describe('IcButton', () => {
  it('keeps the upstream variant and size names as data attributes on our class', () => {
    render(
      <IcButton onClick={() => undefined} size="xs" variant="text">
        Retry
      </IcButton>
    )
    const button = screen.getByRole('button', { name: 'Retry' })

    expect(button.className).toMatch(/\bic-btn\b/)
    expect(button.dataset.variant).toBe('text')
    expect(button.dataset.size).toBe('xs')
  })

  it('defaults to the primary variant and forwards clicks and disabled', () => {
    const onClick = vi.fn()
    const { rerender } = render(<IcButton onClick={onClick}>Go</IcButton>)
    const button = screen.getByRole('button', { name: 'Go' })

    expect(button.dataset.variant).toBe('default')
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)

    rerender(
      <IcButton disabled onClick={onClick}>
        Go
      </IcButton>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders its child element with asChild', () => {
    render(
      <IcButton asChild variant="text">
        <a href="https://example.test/docs">Docs</a>
      </IcButton>
    )
    const link = screen.getByRole('link', { name: 'Docs' })

    expect(link.className).toMatch(/\bic-btn\b/)
    expect(link.dataset.variant).toBe('text')
  })
})

describe('IcProgress', () => {
  it('clamps the fraction into the aria value and the fill width', () => {
    const { container, rerender } = render(<IcProgress aria-label="Installing" value={1.7} />)
    const bar = screen.getByRole('progressbar', { name: 'Installing' })

    expect(bar.getAttribute('aria-valuenow')).toBe('100')
    expect((container.querySelector('.ic-progress__fill') as HTMLElement).style.width).toBe('100%')

    rerender(<IcProgress aria-label="Installing" value={-0.2} />)
    expect(bar.getAttribute('aria-valuenow')).toBe('0')

    rerender(<IcProgress aria-label="Installing" value={0.426} />)
    expect(bar.getAttribute('aria-valuenow')).toBe('43')
  })

  it('drops the value when indeterminate and marks the danger tone', () => {
    render(<IcProgress aria-label="Starting" destructive indeterminate size="lg" />)
    const bar = screen.getByRole('progressbar', { name: 'Starting' })

    expect(bar.hasAttribute('aria-valuenow')).toBe(false)
    expect(bar.hasAttribute('data-indeterminate')).toBe(true)
    expect(bar.dataset.tone).toBe('danger')
    expect(bar.dataset.size).toBe('lg')
  })
})

describe('IcInput, IcLog, IcSurfaceState', () => {
  it('forwards the input ref', () => {
    const ref = createRef<HTMLInputElement>()
    render(<IcInput aria-label="Key" ref={ref} />)

    expect(ref.current).toBe(screen.getByRole('textbox', { name: 'Key' }))
    expect(ref.current?.className).toMatch(/\bic-field\b/)
  })

  it('keeps log text selectable', () => {
    render(<IcLog>line one</IcLog>)

    expect(screen.getByText('line one').dataset.selectableText).toBe('true')
  })

  it('renders string copy as a heading and paragraph, then the actions', () => {
    render(
      <IcSurfaceState description="It stopped." title="Something went wrong">
        <IcButton>Retry</IcButton>
      </IcSurfaceState>
    )

    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeTruthy()
    expect(screen.getByText('It stopped.').tagName).toBe('P')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })
})

describe('IcDialog', () => {
  it('closes through its close button and can hide it', () => {
    const onOpenChange = vi.fn()

    const { rerender } = render(
      <IcDialog closeLabel="Close" onOpenChange={onOpenChange} open>
        <IcDialogTitle>Updates</IcDialogTitle>
      </IcDialog>
    )

    expect(screen.getByRole('dialog', { name: 'Updates' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)

    rerender(
      <IcDialog closeLabel="Close" onOpenChange={onOpenChange} open showCloseButton={false}>
        <IcDialogTitle>Updates</IcDialogTitle>
      </IcDialog>
    )
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })
})

// Mirrors the critic's DOM probe: an upstream colour utility or theme variable on any node of a rendered subtree.
const UPSTREAM_DOM =
  /(^|\s)(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke)-(?:background|foreground|muted(?:-foreground)?|card|popover|primary(?:-foreground)?|destructive|accent|border|input|secondary)(?:\/\S+)?(?=\s|$)|--(?:ui|dt|theme|chrome)-|stroke-nous|shadow-nous/

function upstreamClassesIn(root: Element) {
  return [root, ...root.querySelectorAll('*')]
    .map(node => node.getAttribute('class') ?? '')
    .filter(className => UPSTREAM_DOM.test(className))
}

describe('IcSpinner', () => {
  it('paints the loader in our accent instead of the upstream primary', () => {
    const { container } = render(<IcSpinner className="size-6" label="Loading" type="fourier-flow" />)
    const spinner = screen.getByRole('status', { name: 'Loading' })

    expect(spinner.dataset.slot).toBe('ic-spinner')
    expect(spinner.className).toMatch(/text-\(--ic-accent\)/)
    expect(spinner.className).toMatch(/\bsize-6\b/)
    expect(upstreamClassesIn(container)).toEqual([])
  })

  it('lets the call site name a colour role', () => {
    render(<IcSpinner className="text-(--ic-text-3)" label="Loading" />)
    const spinner = screen.getByRole('status', { name: 'Loading' })

    expect(spinner.className).toMatch(/text-\(--ic-text-3\)/)
    expect(spinner.className).not.toMatch(/text-\(--ic-accent\)|text-primary/)
  })
})

/** Hovers a tip trigger the way the critic's probe does and returns the portaled chip once Radix has opened it. */
async function openTip(trigger: HTMLElement) {
  fireEvent.pointerMove(trigger, { pointerType: 'mouse' })

  return waitFor(() => {
    const content = window.document.querySelector<HTMLElement>('[data-slot=tooltip-content]')

    expect(content).not.toBeNull()

    return content as HTMLElement
  })
}

describe('IcTip', () => {
  beforeEach(stubResizeObserver)
  afterEach(() => vi.unstubAllGlobals())

  it('opens a chip on our roles, portaled over the modal layer', async () => {
    render(
      <IcTip delayDuration={0} label="Previous match">
        <button type="button">Up</button>
      </IcTip>
    )

    const trigger = screen.getByRole('button', { name: 'Up' })

    expect(trigger.dataset.slot).toBe('tooltip-trigger')

    const content = await openTip(trigger)
    const chip = content.firstElementChild as HTMLElement

    expect(content.className).toMatch(/z-\(--z-over-modal\)/)
    expect(chip.className).toMatch(/bg-\(--ic-surface\)/)
    expect(chip.className).toMatch(/text-\(--ic-text-1\)/)
    expect(chip.textContent).toBe('Previous match')
    expect(upstreamClassesIn(content)).toEqual([])
  })

  it('renders the child untouched when there is no label', () => {
    render(
      <IcTip label="">
        <button type="button">Bare</button>
      </IcTip>
    )

    expect(screen.getByRole('button', { name: 'Bare' }).dataset.slot).toBeUndefined()
  })
})

describe('IcCopyButton', () => {
  beforeEach(stubResizeObserver)
  afterEach(() => vi.unstubAllGlobals())

  function stubClipboard(writeText: ReturnType<typeof vi.fn>) {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  }

  it('renders the inline copy control on our roles and still writes the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)

    const { container } = render(
      <IcCopyButton label="Copy detail" text="ECONNREFUSED">
        Copy detail
      </IcCopyButton>
    )

    const button = screen.getByRole('button', { name: 'Copy detail' })

    expect(button.className).toMatch(/hover:bg-\(--ic-fill-hover\)/)
    expect(button.dataset.slot).toBe('tooltip-trigger')
    expect(upstreamClassesIn(container)).toEqual([])
    fireEvent.click(button)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ECONNREFUSED'))
  })

  it('shows the copied feedback in the label, the name and the tip, then returns to idle', async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined))

    render(
      <IcCopyButton label="Copy detail" text="ECONNREFUSED">
        Copy detail
      </IcCopyButton>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy detail' }))

    const copied = await screen.findByRole('button', { name: 'Copied' })

    expect(copied.textContent).toBe('Copied')
    expect((await openTip(copied)).firstElementChild?.textContent).toBe('Copied')

    // The feedback window (1.5 s) runs on the real clock: Radix's open timers and the reset timer share it.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy detail' }).textContent).toBe('Copy detail'), {
      timeout: 2_500
    })
  })

  it('shows the failed feedback with the caller message when the write rejects', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')))

    render(<IcCopyButton errorMessage="Could not copy the detail" label="Copy detail" text="ECONNREFUSED" />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy detail' }))

    const failed = await screen.findByRole('button', { name: 'Could not copy the detail' })

    expect(failed.textContent).toBe('Failed')
  })

  it('writes nothing while disabled or when the payload resolves empty', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)

    render(
      <>
        <IcCopyButton disabled label="Disabled copy" text="ECONNREFUSED" />
        <IcCopyButton label="Empty copy" text={() => Promise.resolve('')} />
      </>
    )

    const disabled = screen.getByRole('button', { name: 'Disabled copy' })

    expect(disabled.hasAttribute('disabled')).toBe(true)
    fireEvent.click(disabled)
    fireEvent.click(screen.getByRole('button', { name: 'Empty copy' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Empty copy' }).textContent).toBe('Empty copy'))
    expect(writeText).not.toHaveBeenCalled()
  })
})

// The surfaces this front re-based read only our roles: no upstream theme variable and no upstream colour
// utility may come back in their source.
const SURFACES = [
  '../boot-failure-overlay.tsx',
  '../gateway-connecting-overlay.tsx',
  '../desktop-install-overlay.tsx',
  '../error-boundary.tsx',
  '../notifications.tsx',
  '../find-bar.tsx',
  '../remote-display-banner.tsx',
  '../onboarding/flow.tsx',
  '../onboarding/glyph.tsx',
  '../onboarding/index.tsx',
  '../onboarding/providers.tsx',
  './ic-system.tsx',
  './ic-system.css',
  '../../app/updates-overlay.tsx',
  '../../app/updates-overlay.compat-chip.tsx'
]

const UPSTREAM_VAR = /--(?:dt|theme|ui|sidebar|chrome|conversation)-[a-z0-9-]+|--stroke-nous|shadow-nous/g

const UPSTREAM_CLASS =
  /(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke|outline|divide|from|via|to|shadow|placeholder|caret|decoration)-(?:background|foreground|muted(?:-foreground)?|card(?:-foreground)?|popover(?:-foreground)?|primary(?:-foreground)?|secondary(?:-foreground)?|accent(?:-foreground)?|destructive|border|input|ring|warning|success|(?:white|black)|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})(?![\w-])/g

const UPSTREAM_PRIMITIVE =
  /from '@\/components\/ui\/(?:button|alert|error-state|input|log-view|progress)'|\bDialogContent\b/g

// Tip, Loader and CopyButton paint upstream colours (Tip's chip is bg-foreground). ic-system.tsx alone imports the
// tooltip and loader modules (the focus rule, the spinner inside IcSpinner); every other surface renders IcSpinner,
// IcCopyButton and IcTip. The canonical `writeClipboardText` stays importable from copy-button everywhere.
const UPSTREAM_WRAPPED_IMPORT =
  /from '@\/components\/ui\/(?:tooltip|loader)'|\bCopyButton\b[\s\S]{0,160}?from '@\/components\/ui\/copy-button'/g

const UPSTREAM_RENDER = /<(?:Loader|CopyButton|Tip)\b(?!\d)/g

// A variable path keeps Vite from rewriting `new URL(literal, import.meta.url)` into an asset URL.
function surfaceSource(file: string) {
  return readFileSync(new URL(file, import.meta.url), 'utf8')
}

describe('system surfaces read only our design', () => {
  it.each(SURFACES)('%s has no upstream token, colour utility or styled primitive', file => {
    const source = surfaceSource(file)

    expect(source.match(UPSTREAM_VAR) ?? []).toEqual([])
    expect(source.match(UPSTREAM_CLASS) ?? []).toEqual([])
    expect(source.match(UPSTREAM_PRIMITIVE) ?? []).toEqual([])
  })

  it.each(SURFACES.filter(file => file !== './ic-system.tsx'))(
    '%s renders no upstream Loader, CopyButton or Tip and imports none of their modules',
    file => {
      const source = surfaceSource(file)

      expect(source.match(UPSTREAM_WRAPPED_IMPORT) ?? []).toEqual([])
      expect(source.match(UPSTREAM_RENDER) ?? []).toEqual([])
    }
  )

  it('ic-system.tsx renders no upstream CopyButton or Tip (it only takes their logic)', () => {
    const source = surfaceSource('./ic-system.tsx')

    expect(source.match(/<(?:CopyButton|Tip)\b(?!\d)/g) ?? []).toEqual([])
  })
})
