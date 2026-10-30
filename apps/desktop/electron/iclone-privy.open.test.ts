// K143 — the main side of a refused sign-in: a structured reason the renderer can translate, the fixed port kept.
import { describe, expect, it, vi } from 'vitest'

import { listenRefusalReason, PRIVY_PORT, privyOpenRefusal } from './iclone-privy'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/nonexistent', isPackaged: false, once: vi.fn() },
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  session: { fromPartition: () => ({ setPermissionRequestHandler: vi.fn(), clearStorageData: vi.fn() }) }
}))

describe('K143: privy open refusals', () => {
  it('the port stays fixed (the Privy-allowlisted origin) and a held port is a named reason with the port', () => {
    expect(PRIVY_PORT).toBe(47831)
    expect(privyOpenRefusal('port-in-use')).toEqual({
      ok: false,
      reason: 'port-in-use',
      port: 47831,
      error: 'The sign-in page could not start: port 47831 is already in use on this Mac.'
    })
  })

  it('a build without the page is its own reason', () => {
    expect(privyOpenRefusal('unavailable')).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  it('n2: only a held port (EADDRINUSE) is "in use"; any other listen error is a plain failure without a port', () => {
    expect(listenRefusalReason('EADDRINUSE')).toBe('port-in-use')

    for (const code of ['EACCES', 'EADDRNOTAVAIL', 'EPERM', null, undefined]) {
      expect(listenRefusalReason(code)).toBe('listen-failed')
    }

    const failed = privyOpenRefusal('listen-failed')
    expect(failed).toMatchObject({ ok: false, reason: 'listen-failed' })
    expect(failed).not.toHaveProperty('port')
  })

  it('n2 wiring: the open handler maps the recorded listen error, never a fixed "port in use"', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('./iclone-privy.ts', import.meta.url), 'utf8')

    expect(source).not.toMatch(/return privyOpenRefusal\('port-in-use'\)/)
    expect(source.match(/privyOpenRefusal\(listenRefusalReason\(lastListenErrorCode\)\)/g)).toHaveLength(2)
    expect(source).toMatch(/lastListenErrorCode = \(err as NodeJS\.ErrnoException\)\.code \?\? null/)
  })
})
