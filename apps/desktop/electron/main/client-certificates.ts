/**
 * No client certificate ever leaves the app.
 *
 * Since Electron 44, `select-client-certificate` also fires for the main process's own `net` requests (with a null
 * webContents), and an unhandled event answers the server with the first matching client certificate from the OS
 * store. The main process fetches URLs the renderer hands it (link titles, favicons, images, media), so every
 * request, a window's or the main process's, is answered with no certificate. The host that asked is logged once per
 * host, never the URL's path or query; the set of hosts already logged is capped, the oldest forgotten first.
 *
 * A remote gateway behind a proxy that requires a client certificate (mutual TLS) therefore gets none and refuses the
 * connection; mutual TLS is not a supported way to authenticate to a gateway.
 */
import type { Certificate, WebContents } from 'electron'

/** The part of Electron's `app` this module listens to. */
export interface ClientCertificateApp {
  on(
    event: 'select-client-certificate',
    listener: (
      event: { preventDefault: () => void },
      webContents: WebContents | null,
      url: string,
      certificateList: Certificate[],
      callback: (certificate?: Certificate) => void
    ) => void
  ): unknown
}

/** The host of a request URL, for the log line; the whole URL is never written. */
export function requestHost(url: string): string {
  try {
    return new URL(url).host || 'unknown host'
  } catch {
    return 'unknown host'
  }
}

/** The most hosts remembered as already logged; past it the oldest is forgotten (and logged again if it asks again). */
export const REPORTED_HOSTS_MAX = 256

export function refuseClientCertificates(app: ClientCertificateApp, log: (line: string) => void): void {
  const reported = new Set<string>()

  app.on('select-client-certificate', (event, webContents, url, _certificates, callback) => {
    event.preventDefault()
    callback()

    const host = requestHost(url)

    if (reported.has(host)) {
      return
    }

    // A Set iterates in insertion order, so its first entry is the oldest logged host.
    while (reported.size >= REPORTED_HOSTS_MAX) {
      const oldest = reported.values().next().value

      if (oldest === undefined) {
        break
      }

      reported.delete(oldest)
    }

    reported.add(host)
    log(`[tls] ${host} asked for a client certificate (${webContents ? 'window' : 'main process'} request); none sent`)
  })
}
