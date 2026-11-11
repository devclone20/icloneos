// @vitest-environment jsdom
/** CF4 (B2-n4, round-1 B-n5): a hard-link group of 538 files lists three, and "Show all" lists every one main sent.
 *  B6-n2: the list is windowed, so "every one" is proven by scrolling to it, not by counting mounted rows. */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HardlinkGroupFiles } from './containers-app'

afterEach(cleanup)

const rows = (container: HTMLElement) =>
  container.querySelectorAll<HTMLElement>('[data-hardlink-files] [role="listitem"]')

const list = (container: HTMLElement) => container.querySelector('[data-hardlink-files]') as HTMLElement

/** jsdom has no layout: the offset is set on the element and the scroll event carries it to the window. */
const scrollTo = (container: HTMLElement, top: number) => {
  const viewport = list(container)

  Object.defineProperty(viewport, 'scrollTop', { configurable: true, value: top })
  act(() => void fireEvent.scroll(viewport))
}

const scrollToEnd = (container: HTMLElement) => scrollTo(container, Number.MAX_SAFE_INTEGER)
const lastRow = (container: HTMLElement) => [...rows(container)].at(-1) as HTMLElement

describe('B2-n4: the files of a large hard-link group', () => {
  it('lists three, then all 538 on Show all, and three again on Show fewer', () => {
    const paths = Array.from({ length: 538 }, (_, index) => `/p/v0.0.6/work/chain/f${index}`)
    const { container } = render(<HardlinkGroupFiles count={538} paths={paths} />)
    const toggle = () => container.querySelector('[data-hardlink-show-all]') as HTMLButtonElement

    expect(rows(container)).toHaveLength(3)
    expect(toggle().textContent).toBe('Show all 538')
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    act(() => void fireEvent.click(toggle()))
    expect(rows(container).length).toBeLessThan(40)
    expect(rows(container)[0].getAttribute('aria-setsize')).toBe('538')
    scrollToEnd(container)
    expect(lastRow(container).getAttribute('aria-posinset')).toBe('538')
    expect(lastRow(container).textContent).toBe('/p/v0.0.6/work/chain/f537')
    expect(toggle().textContent).toBe('Show fewer')
    act(() => void fireEvent.click(toggle()))
    expect([...rows(container)].map(row => row.textContent)).toEqual(paths.slice(0, 3))
  })

  it('CF5 B3-n2: a group of 2 500 (main sends 1 000) pages the rest in, so every file is reachable', async () => {
    const all = Array.from({ length: 2_500 }, (_, index) => `/p/big/f${index}`)

    const hardlinkPaths = vi.fn(async (input: { offset: number }) => ({
      ok: true as const,
      count: all.length,
      offset: input.offset,
      paths: all.slice(input.offset, input.offset + 1_000)
    }))

    Object.assign(window, { hermesDesktop: { icloneConfinement: { hardlinkPaths } } })

    const source = { root: '/p', dir: '/p/big', digest: 'd1' }
    const { container } = render(<HardlinkGroupFiles count={2_500} paths={all.slice(0, 1_000)} source={source} />)
    const more = () => container.querySelector('[data-hardlink-show-more]') as HTMLButtonElement | null

    expect(more()).toBeNull()
    act(() => void fireEvent.click(container.querySelector('[data-hardlink-show-all]') as HTMLElement))
    scrollToEnd(container)
    expect(lastRow(container).getAttribute('aria-posinset')).toBe('1000')
    expect(more()?.textContent).toBe('Show 1,000 more')
    await act(async () => void fireEvent.click(more() as HTMLElement))
    scrollToEnd(container)
    expect(lastRow(container).getAttribute('aria-posinset')).toBe('2000')
    expect(more()?.textContent).toBe('Show 500 more')
    await act(async () => void fireEvent.click(more() as HTMLElement))
    scrollToEnd(container)
    expect(lastRow(container).getAttribute('aria-posinset')).toBe('2500')
    expect(more()).toBeNull()
    expect(hardlinkPaths.mock.calls.map(([input]) => input)).toEqual([
      { ...source, offset: 1_000 },
      { ...source, offset: 2_000 }
    ])
    expect(lastRow(container).textContent).toBe('/p/big/f2499')
    expect(rows(container)[0].getAttribute('aria-setsize')).toBe('2500')
  })

  it('B6-n2: a group of 20 000 mounts a window of rows, scrolls to the right ones and keeps the set size', () => {
    const paths = Array.from({ length: 20_000 }, (_, index) => `/p/huge/f${index}`)
    const { container } = render(<HardlinkGroupFiles count={20_000} paths={paths} />)

    act(() => void fireEvent.click(container.querySelector('[data-hardlink-show-all]') as HTMLElement))

    const viewport = list(container)
    const sizer = viewport.firstElementChild as HTMLElement

    expect(viewport.getAttribute('role')).toBe('list')
    expect(viewport.tabIndex).toBe(0)
    expect(sizer.style.height).toBe(`${20_000 * 38}px`)
    expect(rows(container).length).toBeGreaterThan(0)
    expect(rows(container).length).toBeLessThanOrEqual(100)
    expect(rows(container)[0].textContent).toBe('/p/huge/f0')
    expect(rows(container)[0].getAttribute('aria-posinset')).toBe('1')

    for (const row of rows(container)) {
      expect(row.getAttribute('aria-setsize')).toBe('20000')
    }

    scrollTo(container, 10_000 * 38)
    expect(rows(container).length).toBeLessThanOrEqual(100)

    const shown = [...rows(container)].map(row => row.textContent)

    expect(shown).toContain('/p/huge/f10000')
    expect(shown).toContain('/p/huge/f10009')
    expect(shown).not.toContain('/p/huge/f0')

    const at10000 = [...rows(container)].find(row => row.textContent === '/p/huge/f10000') as HTMLElement

    expect(at10000.getAttribute('aria-posinset')).toBe('10001')
    expect(at10000.style.top).toBe(`${10_000 * 38}px`)

    scrollToEnd(container)
    expect(rows(container).length).toBeLessThanOrEqual(100)
    expect(lastRow(container).textContent).toBe('/p/huge/f19999')
    expect(lastRow(container).getAttribute('aria-posinset')).toBe('20000')
  })

  it('B6-n2: Show fewer after a deep scroll lists the first three again, not an empty window', () => {
    const paths = Array.from({ length: 20_000 }, (_, index) => `/p/huge/f${index}`)
    const { container } = render(<HardlinkGroupFiles count={20_000} paths={paths} />)
    const toggle = () => container.querySelector('[data-hardlink-show-all]') as HTMLElement

    act(() => void fireEvent.click(toggle()))
    scrollToEnd(container)
    act(() => void fireEvent.click(toggle()))
    expect([...rows(container)].map(row => row.textContent)).toEqual(paths.slice(0, 3))
    expect(list(container).tabIndex).toBe(-1)
  })

  it('a group of three or fewer has no toggle', () => {
    const { container } = render(<HardlinkGroupFiles count={2} paths={['/p/a', '/p/b']} />)

    expect(rows(container)).toHaveLength(2)
    expect(container.querySelector('[data-hardlink-show-all]')).toBeNull()
  })
})
