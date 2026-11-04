/**
 * Since Electron 44 an unhandled `select-client-certificate` answers a server with the first matching client
 * certificate, for a window's request and for the main process's own `net` fetches alike. The handler answers every
 * request with none and logs the host once.
 */
import type { Certificate, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import {
  type ClientCertificateApp,
  refuseClientCertificates,
  REPORTED_HOSTS_MAX,
  requestHost
} from './client-certificates'

type Listener = Parameters<ClientCertificateApp['on']>[1]

function fakeApp() {
  let listener: Listener | undefined

  const app: ClientCertificateApp = {
    on: (_event, fn) => {
      listener = fn
    }
  }

  const certificate = { subjectName: 'alice', fingerprint: 'sha256/aa' } as Certificate

  const ask = (webContents: WebContents | null, url: string) => {
    const event = { preventDefault: vi.fn() }
    const callback = vi.fn((_certificate?: Certificate) => undefined)

    listener?.(event, webContents, url, [certificate], callback)

    return { callback, event }
  }

  return { app, ask, registered: () => Boolean(listener) }
}

describe('client certificates are never sent', () => {
  it('registers the handler on the app', () => {
    const { app, registered } = fakeApp()

    refuseClientCertificates(app, () => {})

    expect(registered()).toBe(true)
  })

  it('answers a window request with no certificate and prevents the default pick', () => {
    const { app, ask } = fakeApp()
    refuseClientCertificates(app, () => {})

    const { callback, event } = ask({} as WebContents, 'https://example.test/secret/path?token=1')

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0]).toEqual([])
  })

  it('answers a main-process request (webContents null) with no certificate too', () => {
    const { app, ask } = fakeApp()
    refuseClientCertificates(app, () => {})

    const { callback, event } = ask(null, 'https://cdn.example.test/image.png')

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0]).toEqual([])
  })

  it('logs each host once, never the path or query', () => {
    const lines: string[] = []
    const { app, ask } = fakeApp()
    refuseClientCertificates(app, line => lines.push(line))

    ask(null, 'https://example.test/secret/path?token=1')
    ask({} as WebContents, 'https://example.test/other?token=2')
    ask(null, 'https://cdn.example.test:8443/image.png')

    expect(lines).toEqual([
      '[tls] example.test asked for a client certificate (main process request); none sent',
      '[tls] cdn.example.test:8443 asked for a client certificate (main process request); none sent'
    ])
    expect(lines.join('\n')).not.toMatch(/secret|token|image\.png/)
  })

  it('remembers at most REPORTED_HOSTS_MAX hosts: the oldest is forgotten first, the newest stays logged', () => {
    const lines: string[] = []
    const { app, ask } = fakeApp()
    refuseClientCertificates(app, line => lines.push(line))

    const hosts = Array.from({ length: REPORTED_HOSTS_MAX + 1 }, (_, index) => `h${index}.example.test`)

    for (const host of hosts) {
      ask(null, `https://${host}/`)
    }

    expect(lines).toHaveLength(REPORTED_HOSTS_MAX + 1)

    // The newest is still remembered; the oldest was forgotten to make room, so it is logged again.
    ask(null, `https://${hosts.at(-1)}/`)
    expect(lines).toHaveLength(REPORTED_HOSTS_MAX + 1)
    ask(null, `https://${hosts[0]}/`)
    expect(lines).toHaveLength(REPORTED_HOSTS_MAX + 2)
  })

  it('requestHost never throws on a malformed URL', () => {
    expect(requestHost('not a url')).toBe('unknown host')
    expect(requestHost('https://example.test/x')).toBe('example.test')
  })
})
