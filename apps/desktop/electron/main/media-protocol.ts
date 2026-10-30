// The media:// protocol handler.
import { pathToFileURL } from 'node:url'

import { net as electronNet, protocol } from 'electron'

import { backendScopeKey } from '../connection-registry'
import { resolveReadableFileForIpc } from '../hardening'
import { createMediaProtocolHandler, MEDIA_PROTOCOL } from '../media-protocol'

import { ensureBackend, ensureRegistryBackend } from './backend-routing'
import { backendDialClaims } from './backend-state'
import { ensureNativeAccessToken, getOauthSessionForUrl } from './oauth'

export function registerMediaProtocol() {
  const handler = createMediaProtocolHandler({
    ensureRemoteBearer: baseUrl => ensureNativeAccessToken(baseUrl).catch(() => null),
    fetchLocal: (resolvedPath, headers, method) =>
      electronNet.fetch(pathToFileURL(resolvedPath).toString(), {
        bypassCustomProtocolHandlers: true,
        credentials: 'omit',
        headers,
        method
      }),
    fetchRemote: (url, headers, method) =>
      electronNet.fetch(url, {
        bypassCustomProtocolHandlers: true,
        credentials: 'omit',
        headers,
        method
      }),
    fetchRemoteWithCookies: (url, headers, method) => {
      const oauthSession = getOauthSessionForUrl(url)

      if (!oauthSession) {
        throw new Error('OAuth session partition is unavailable.')
      }

      return oauthSession.fetch(url, {
        bypassCustomProtocolHandlers: true,
        credentials: 'include',
        headers,
        method
      })
    },
    resolveLocalFile: async filePath => {
      const { resolvedPath } = await resolveReadableFileForIpc(filePath, { purpose: 'Media stream' })

      return resolvedPath
    },
    // Claim-guarded (#90812): a media stream load can race a renderer's own
    // reconnect dial for the same (connectionId, profile) scope; coalescing
    // here avoids bootstrapping a second SSH tunnel / remote dashboard.
    resolveRemoteConnection: ({ connectionId, profile }) =>
      backendDialClaims.run(backendScopeKey(connectionId, profile), () =>
        connectionId ? ensureRegistryBackend(connectionId, profile) : ensureBackend(profile)
      )
  })

  protocol.handle(MEDIA_PROTOCOL, handler)
}
