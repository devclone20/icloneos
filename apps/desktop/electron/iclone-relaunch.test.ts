/**
 * V3-FX r4: "Restart now" — app.relaunch() is called exactly when the quit goes through, never after a cancelled
 * quit ("Keep Running"), and main wires both ends (the IPC's relaunch and the dialog's Keep Running).
 */
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { createRelaunchOnQuit } from './iclone-relaunch'

function fakeApp() {
  const listeners: (() => void)[] = []

  return {
    relaunch: vi.fn(),
    quit: vi.fn(),
    on: vi.fn((_event: 'will-quit', listener: () => void) => listeners.push(listener)),
    willQuit: () => listeners.forEach(listener => listener())
  }
}

describe('r4: relaunch on quit', () => {
  it('request quits, and the relaunch happens when the quit goes through', () => {
    const app = fakeApp()
    const relaunch = createRelaunchOnQuit(app)

    relaunch.request()
    expect(app.quit).toHaveBeenCalledTimes(1)
    expect(app.relaunch).not.toHaveBeenCalled()
    app.willQuit()
    expect(app.relaunch).toHaveBeenCalledTimes(1)
  })

  it('a cancelled quit ("Keep Running") disarms it: a later ordinary quit does not restart', () => {
    const app = fakeApp()
    const relaunch = createRelaunchOnQuit(app)

    relaunch.request()
    relaunch.disarm()
    app.willQuit()
    expect(app.relaunch).not.toHaveBeenCalled()
  })

  it('an ordinary quit never relaunches', () => {
    const app = fakeApp()

    createRelaunchOnQuit(app)
    app.willQuit()
    expect(app.relaunch).not.toHaveBeenCalled()
  })

  it('main wires it: the keychain restart requests it; "Keep Running" disarms it', () => {
    const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')

    expect(main).toContain('const relaunchOnQuit = createRelaunchOnQuit(app)')
    expect(main).toContain('relaunch: () => relaunchOnQuit.request()')
    expect(main).toMatch(/if \(response === 1\) \{[\s\S]{0,120}\} else \{[\s\S]{0,120}relaunchOnQuit\.disarm\(\)/)
    expect(main).not.toMatch(/app\.relaunch\(\)\n\s+app\.quit\(\)/)
  })
})
