export type SwRoute = 'asset' | 'navigate' | 'network-only'

/**
 * How the icloneOS Web service worker treats a same-origin request. Only
 * content-hashed `/assets/*` files are ever cached; gateway answers (`/api`,
 * websockets, sign-in) and the token-injected index.html always go to the
 * network. Self-contained on purpose: vite.web.config.ts embeds its source in
 * sw.js, so the tested function is the shipped one.
 */
export function swRoute(pathname: string, method: string, mode: string): SwRoute {
  const networkOnly = ['/api', '/ws', '/login', '/logout', '/auth', '/oauth']

  if (method !== 'GET' || networkOnly.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return 'network-only'
  }

  if (mode === 'navigate') {
    return 'navigate'
  }

  return pathname.startsWith('/assets/') ? 'asset' : 'network-only'
}
