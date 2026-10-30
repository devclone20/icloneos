import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { registry } from '@/contrib/registry'

import { FRAME_TOOL_IDS, frameTools, FrameTools } from './frame-tools'

const AREA = 'titleBar.tools.right'

const selected = vi.hoisted(() => [] as string[])

// The home modules publish their live tool state into the registry; here each
// publishes a stub with the same id so the frame's reading of it is what's
// under test, not Privy, the theme store or the backend.
vi.mock('@/app/home/wallet-tool', () => ({
  registerIcloneWalletTool: () =>
    registry.register({
      id: 'iclone-wallet',
      area: 'titleBar.tools.right',
      order: 1,
      data: { id: 'iclone-wallet', label: 'Wallet', icon: 'W', active: false, onSelect: () => selected.push('wallet') }
    })
}))
vi.mock('@/app/home/theme-tool', () => ({
  registerIcloneThemeTool: () =>
    registry.register({
      id: 'iclone-theme-cycle',
      area: 'titleBar.tools.right',
      data: { id: 'iclone-theme-cycle', label: 'Theme', icon: 'T', onSelect: () => selected.push('theme') }
    })
}))
vi.mock('@/app/home/browser-tool', () => ({
  registerIcloneBrowserTool: () =>
    registry.registerMany([
      {
        id: 'iclone-browser-headed',
        area: 'titleBar.tools.right',
        order: 2,
        data: { id: 'iclone-browser-headed', label: 'Browser', icon: 'B', active: true, onSelect: () => undefined }
      },
      {
        id: 'iclone-browser-recording',
        area: 'titleBar.tools.right',
        order: 3,
        data: {
          id: 'iclone-browser-recording',
          label: 'Record',
          icon: 'R',
          busy: true,
          onSelect: () => selected.push('record')
        }
      }
    ])
}))

vi.mock('@/app/home/hud-tool', async () => {
  const { useEffect } = await import('react')

  function useIcloneHudTool() {
    useEffect(
      () =>
        registry.register({
          id: 'iclone-hud',
          area: 'titleBar.tools.right',
          order: 4,
          data: { id: 'iclone-hud', label: 'HUD mode', icon: 'H', active: false, onSelect: () => selected.push('hud') }
        }),
      []
    )
  }

  return { useIcloneHudTool }
})

afterEach(() => {
  cleanup()
  selected.length = 0
})

describe('frameTools', () => {
  const tool = (id: string, extra: object = {}) => ({ id, area: AREA, data: { id, label: id, icon: null, ...extra } })

  it('puts HUD mode at the right end, after the browser pair, as the old titlebar did', () => {
    expect(FRAME_TOOL_IDS.at(-1)).toBe('iclone-hud')
    expect(FRAME_TOOL_IDS.indexOf('iclone-hud')).toBeGreaterThan(FRAME_TOOL_IDS.indexOf('iclone-browser-recording'))
  })

  it('keeps the frame order whatever order the registry holds', () => {
    const ids = frameTools([...FRAME_TOOL_IDS].reverse().map(id => tool(id))).map(t => t.id)

    expect(ids).toEqual([...FRAME_TOOL_IDS])
  })

  it('gives plugin contributions no slot (owner #20)', () => {
    const ids = frameTools([
      tool('plugin-clock'),
      { ...tool('iclone-wallet'), source: 'plugin:clock' },
      tool('iclone-theme-cycle')
    ]).map(t => t.id)

    expect(ids).toEqual(['iclone-theme-cycle'])
  })

  it('drops a hidden tool', () => {
    expect(frameTools([tool('iclone-wallet', { hidden: true })])).toEqual([])
  })
})

describe('FrameTools', () => {
  it('renders wallet, theme, the browser pair, then HUD mode, each icon-only and outside the drag region', async () => {
    await act(async () => {
      render(<FrameTools />)
    })

    const buttons = screen.getAllByRole('button')

    expect(buttons.map(b => b.getAttribute('data-ic-frame-tool'))).toEqual([...FRAME_TOOL_IDS])
    expect(buttons.map(b => b.getAttribute('aria-label'))).toEqual(['Wallet', 'Theme', 'Browser', 'Record', 'HUD mode'])
    expect(screen.getByRole('toolbar').className).toContain('[-webkit-app-region:no-drag]')
  })

  it("calls the module's own handler and mirrors its state", async () => {
    await act(async () => {
      render(<FrameTools />)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Wallet' }))
    fireEvent.click(screen.getByRole('button', { name: 'Theme' }))
    fireEvent.click(screen.getByRole('button', { name: 'HUD mode' }))

    expect(selected).toEqual(['wallet', 'theme', 'hud'])
    expect(screen.getByRole('button', { name: 'Wallet' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'Theme' }).hasAttribute('aria-pressed')).toBe(false)
    expect(screen.getByRole('button', { name: 'Browser' }).getAttribute('aria-pressed')).toBe('true')
    // A toggle in flight is busy, never disabled (U4-p2-06): the control keeps its focus.
    expect(screen.getByRole('button', { name: 'Record' }).getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('button', { name: 'HUD mode' }).getAttribute('aria-pressed')).toBe('false')
  })

  it.each(['inft-scrim', 'iwbal-scrim'])('steps out of sight, clicks and Tab while OUR %s modal is open', async cls => {
    let body!: HTMLElement

    await act(async () => {
      body = render(<FrameTools />).baseElement
    })

    const toolbar = screen.getByRole('toolbar')
    // Deep inside a stage, the way the collections and wallet panels sit inside `.ihome`.
    const stage = body.appendChild(body.ownerDocument.createElement('div'))

    await act(async () => {
      stage.appendChild(body.ownerDocument.createElement('div')).className = cls
    })

    expect(toolbar.hasAttribute('inert')).toBe(true)
    expect(toolbar.getAttribute('aria-hidden')).toBe('true')
    expect(toolbar.className).toContain('pointer-events-none')
    expect(toolbar.className).toContain('opacity-0')
    expect(screen.queryByRole('toolbar')).toBeNull()

    await act(async () => {
      stage.remove()
    })

    expect(toolbar.hasAttribute('inert')).toBe(false)
    expect(toolbar.hasAttribute('aria-hidden')).toBe(false)
    expect(toolbar.className).toContain('pointer-events-auto')
    expect(screen.getByRole('toolbar')).toBe(toolbar)
  })

  it('starts hidden when a modal is already open at mount', async () => {
    await act(async () => {
      render(
        <>
          <div className="inft-scrim" />
          <FrameTools />
        </>
      )
    })

    expect(screen.getByRole('toolbar', { hidden: true }).hasAttribute('inert')).toBe(true)
  })
})

describe('a toggle in flight (U4-p2-06)', () => {
  it('stays enabled and focused, says busy, and ignores the click', () => {
    render(<FrameTools />)

    const record = screen.getByRole('button', { name: 'Record' })

    record.focus()
    expect(record.hasAttribute('disabled')).toBe(false)
    expect(record.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(record)
    expect(selected).not.toContain('record')
    expect(window.document.activeElement).toBe(record)
  })
})
