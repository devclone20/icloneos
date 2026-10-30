import { describe, expect, it, vi } from 'vitest'

import { externalLinkTarget, installExternalLinkRouter, type RoutedClickLike } from './external-link-router'

// X1b (review M2): with every window request denied, a link the user clicks reaches the system browser only through
// this router, installed by the preload in the app's own document. It must open a REAL click on a link that asks for
// a new window, and nothing a script dispatches.

const DOC = 'file:///Applications/App.app/Contents/Resources/app/dist/index.html?win=main#/chat'

function anchor(href: string, target = '') {
  const element = { href, target }

  return { closest: (selector: string) => (selector === 'a[href]' ? element : null) }
}

const plain = { closest: () => null }

function click(over: Partial<RoutedClickLike> = {}): RoutedClickLike {
  return {
    button: 0,
    ctrlKey: false,
    defaultPrevented: false,
    isTrusted: true,
    metaKey: false,
    shiftKey: false,
    target: anchor('https://docs.example.test/page', '_blank'),
    type: 'click',
    ...over
  }
}

describe('externalLinkTarget', () => {
  it('a real click on a target=_blank link opens it', () => {
    expect(externalLinkTarget(click(), DOC)).toBe('https://docs.example.test/page')
  })

  it.each([
    ['⌘-click', { metaKey: true }],
    ['Ctrl-click', { ctrlKey: true }],
    ['⇧-click', { shiftKey: true }],
    ['middle click', { button: 1, type: 'auxclick' }]
  ])('a real %s on a same-window link opens it', (_label, over) => {
    expect(externalLinkTarget(click({ target: anchor('https://docs.example.test/page'), ...over }), DOC)).toBe(
      'https://docs.example.test/page'
    )
  })

  it.each([
    ['mailto:', 'mailto:someone@example.test'],
    ['file:', 'file:///tmp/report.pdf']
  ])('a real click on a %s link is routed (the main side validates it)', (_label, href) => {
    expect(externalLinkTarget(click({ target: anchor(href, '_blank') }), DOC)).toBe(href)
  })

  it.each([
    ['https:', 'https://docs.example.test/same', ''],
    ['https: (_self)', 'https://docs.example.test/same', '_self'],
    ['file: (_self)', 'file:///tmp/page.html', '_self'],
    ['file: (_top)', 'file:///tmp/page.html', '_top']
  ])(
    'X1c: a real plain click on a same-window %s link is routed (main cancels the navigation)',
    (_label, href, target) => {
      expect(externalLinkTarget(click({ target: anchor(href, target) }), DOC)).toBe(href)
    }
  )

  it('a click a script dispatched (isTrusted false) opens nothing', () => {
    expect(externalLinkTarget(click({ isTrusted: false }), DOC)).toBeNull()
    expect(externalLinkTarget(click({ isTrusted: false, metaKey: true }), DOC)).toBeNull()
    expect(externalLinkTarget(click({ button: 1, isTrusted: false, type: 'auxclick' }), DOC)).toBeNull()
  })

  it.each([
    ['a link to the app document itself (a #/route)', click({ target: anchor(`${DOC.split('#')[0]}#/settings`) })],
    [
      'a link to the app index with another query',
      click({ target: anchor(DOC.replace('win=main', 'win=hud'), '_blank') })
    ],
    ['a plain click on a link that targets a named frame', click({ target: anchor('https://x.test/', 'preview') })],
    ['a click that is not on a link', click({ target: plain })],
    ['a target with no closest()', click({ target: null })],
    ['a right click', click({ button: 2, type: 'auxclick' })],
    ['a javascript: link', click({ target: anchor('javascript:alert(1)', '_blank') })],
    ['a custom scheme', click({ target: anchor('hermes://open', '_blank') })],
    ['an unparsable href', click({ target: anchor('', '_blank') })]
  ])('%s opens nothing', (_label, event) => {
    expect(externalLinkTarget(event, DOC)).toBeNull()
  })
})

describe('installExternalLinkRouter', () => {
  function install() {
    const listeners = new Map<string, (event: RoutedClickLike) => void>()

    const target = {
      addEventListener: vi.fn((type: string, listener: (event: RoutedClickLike) => void) =>
        listeners.set(type, listener)
      )
    }

    const open = vi.fn()
    const queued: Array<() => void> = []

    installExternalLinkRouter(
      target,
      open,
      () => DOC,
      run => queued.push(run)
    )

    return { listeners, open, flush: () => queued.splice(0).forEach(run => run()), target }
  }

  it('listens for click and auxclick in the capture phase', () => {
    const { target } = install()

    expect(target.addEventListener).toHaveBeenCalledWith('click', expect.any(Function), true)
    expect(target.addEventListener).toHaveBeenCalledWith('auxclick', expect.any(Function), true)
  })

  it('opens a real click once the dispatch is over', () => {
    const { flush, listeners, open } = install()

    listeners.get('click')?.(click())
    expect(open).not.toHaveBeenCalled()
    flush()
    expect(open).toHaveBeenCalledExactlyOnceWith('https://docs.example.test/page')
  })

  it('stands aside when a component opened the link itself (preventDefault during the dispatch)', () => {
    const { flush, listeners, open } = install()
    const event = click()

    listeners.get('click')?.(event)
    event.defaultPrevented = true
    flush()
    expect(open).not.toHaveBeenCalled()
  })

  it('never opens a synthetic click', () => {
    const { flush, listeners, open } = install()

    listeners.get('click')?.(click({ isTrusted: false }))
    listeners.get('auxclick')?.(click({ button: 1, isTrusted: false, type: 'auxclick' }))
    flush()
    expect(open).not.toHaveBeenCalled()
  })
})
