import { describe, expect, it, vi } from 'vitest'

import {
  attachFixtureSwitchTap,
  attachRendererConsoleCapture,
  formatRendererBoundaryReport,
  formatRendererConsoleLine
} from './renderer-log'

describe('formatRendererConsoleLine', () => {
  it('formats the canonical Electron 36+ details shape at error level', () => {
    const line = formatRendererConsoleLine('hud', {
      level: 3,
      message: 'Minified React error #310',
      sourceUrl: 'file:///app/index.js',
      lineNumber: 13
    })

    expect(line).toBe('[renderer console:hud] Minified React error #310 (file:///app/index.js:13)')
  })

  it('formats the deprecated positional shape at error level', () => {
    const line = formatRendererConsoleLine('main', 3, 'boom', 7, 'file:///app/vendor.js')

    expect(line).toBe('[renderer console:main] boom (file:///app/vendor.js:7)')
  })

  it('drops non-error levels in both shapes', () => {
    expect(formatRendererConsoleLine('main', { level: 1, message: 'x', sourceUrl: 's', lineNumber: 1 })).toBeNull()
    expect(formatRendererConsoleLine('main', 2, 'warn', 1, 's')).toBeNull()
  })
})

describe('attachRendererConsoleCapture', () => {
  it('logs error-level messages and skips the rest', () => {
    const log = vi.fn()
    let handler: ((...args: unknown[]) => void) | undefined

    const win = {
      webContents: {
        on: (_event: string, listener: (...args: unknown[]) => void) => {
          handler = listener
        }
      }
    }

    attachRendererConsoleCapture(win, 'quick-entry', log)

    handler?.({}, { level: 3, message: 'crash', sourceUrl: 'src', lineNumber: 2 })
    handler?.({}, { level: 0, message: 'debug', sourceUrl: 'src', lineNumber: 3 })

    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('[renderer console:quick-entry] crash (src:2)')
  })
})

describe('formatRendererBoundaryReport', () => {
  it('carries window label, boundary label, message, and component stack', () => {
    const report = formatRendererBoundaryReport(
      'main',
      'root',
      'Minified React error #310',
      '\n    at Gde (index.js:13)\n    at C_ (index.js:13)'
    )

    expect(report).toContain('[renderer crash:main] [error-boundary:root] Minified React error #310')
    expect(report).toContain('at Gde (index.js:13)')
  })

  it('survives a malformed payload and clamps oversized fields', () => {
    const report = formatRendererBoundaryReport(undefined, null, 'x'.repeat(10_000), 'y'.repeat(10_000))

    expect(report).toContain('[renderer crash:unknown] [error-boundary:unknown]')
    expect(report.length).toBeLessThan(7_000)
  })

  it('omits the stack block when there is no component stack', () => {
    const report = formatRendererBoundaryReport('main', 'root', 'boom', '')

    expect(report).toBe('[renderer crash:main] [error-boundary:root] boom')
    expect(report).not.toContain('\n')
  })
})

// v0.0.9 r4 (eng r3b-m3): the dev-only reopen-loop tap is never attached in a production window.
describe('attachFixtureSwitchTap', () => {
  const fakeWin = () => {
    const listeners: Array<(...args: unknown[]) => void> = []
    const on = vi.fn((_event: 'console-message', listener: (...args: unknown[]) => void) => listeners.push(listener))

    return { win: { webContents: { on } }, on, listeners }
  }

  it('attaches nothing in a packaged build, even if a fixture were somehow set', async () => {
    const { resolveFixtureWallet } = await import('./fixture-wallet')
    const devFixture = resolveFixtureWallet('builtin:reopen', false)
    const { win, on } = fakeWin()

    expect(devFixture).not.toBeNull()
    expect(attachFixtureSwitchTap(win, { fixture: devFixture, isPackaged: true }, vi.fn())).toBe(false)
    expect(on).not.toHaveBeenCalled()
  })

  it('attaches nothing in the production path: packaged resolves no fixture', async () => {
    const { resolveFixtureWallet } = await import('./fixture-wallet')
    const { win, on } = fakeWin()

    const fixture = resolveFixtureWallet('builtin:reopen', true)

    expect(attachFixtureSwitchTap(win, { fixture, isPackaged: true }, vi.fn())).toBe(false)
    expect(attachFixtureSwitchTap(win, { fixture: null, isPackaged: false }, vi.fn())).toBe(false)
    expect(on).not.toHaveBeenCalled()
  })

  it('in a dev fixture run copies only the switch "done" line into the log', async () => {
    const { resolveFixtureWallet } = await import('./fixture-wallet')
    const { win, on, listeners } = fakeWin()
    const log = vi.fn()

    expect(attachFixtureSwitchTap(win, { fixture: resolveFixtureWallet('builtin:reopen', false), isPackaged: false }, log)).toBe(true)
    expect(on).toHaveBeenCalledTimes(1)
    listeners[0]({}, { level: 1, message: '[inft-switch] inft-000000-101 done 42 persona', sourceUrl: '', lineNumber: 0 })
    listeners[0]({}, { level: 1, message: 'unrelated', sourceUrl: '', lineNumber: 0 })
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('[fixture] inft connected inft-000000-101 (42 ms, persona)')
  })

  it('main-window wires the gated tap, never the raw every-message tap', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const src = fs.readFileSync(path.join(__dirname, 'main', 'main-window.ts'), 'utf8')

    expect(src).not.toMatch(/attachRendererConsoleTap\s*\(/)
    expect(src).toMatch(/attachFixtureSwitchTap\(\s*windowsState\.mainWindow,\s*\{\s*fixture: activeFixtureWallet\(\), isPackaged: app\.isPackaged === true \}/)
  })
})
