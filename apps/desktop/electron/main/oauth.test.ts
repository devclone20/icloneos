import { describe, expect, it, vi } from 'vitest'

import { clearOauthSession } from './oauth'

const jar = vi.hoisted(() => ({
  cookies: [] as Array<{ domain?: string; name: string; path?: string; secure?: boolean }>,
  get: vi.fn(),
  remove: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    commandLine: { appendSwitch: () => undefined },
    getAppPath: () => '/nonexistent-app',
    getPath: () => '/nonexistent-user-data',
    isPackaged: false,
    isReady: () => true
  },
  BrowserWindow: { getAllWindows: () => [] },
  session: { fromPartition: () => ({ cookies: { get: jar.get, remove: jar.remove } }) }
}))

// A failed registry read falls back to the shared OAuth partition (the session mocked above).
vi.mock('./connection-config', () => ({
  headersForRemoteRequest: () => ({}),
  readDesktopConnectionConfig: () => null,
  readDesktopConnectionsRegistry: () => {
    throw new Error('no registry in this test')
  }
}))

describe('clearOauthSession', () => {
  it('skips a cookie without a domain and still removes every addressable cookie', async () => {
    jar.cookies = [
      { name: 'no-domain' },
      { domain: '.gw.test', name: 'sid', path: '/app', secure: true },
      { domain: 'gw.test', name: 'plain', secure: false }
    ]
    jar.get.mockImplementation(async () => jar.cookies)
    jar.remove.mockImplementation(async () => undefined)

    await clearOauthSession('https://gw.test')

    expect(jar.get).toHaveBeenCalledWith({ url: 'https://gw.test' })
    expect(jar.remove.mock.calls).toEqual([
      ['https://gw.test/app', 'sid'],
      ['http://gw.test/', 'plain']
    ])
  })
})
