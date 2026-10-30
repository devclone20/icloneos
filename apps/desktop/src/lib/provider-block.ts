import { atom } from 'nanostores'

import type { ErrorSurface } from './error-surface'

/**
 * The persistent "your provider is refusing this turn" state behind the chat
 * banner. It is driven by the runtime's structured `error_surface` (see
 * error-surface.ts); the error text is only ever TESTED for an HTTP 401/403,
 * never shown — it can carry the provider's raw JSON (and with it a key
 * fragment). A block is scoped to the provider+model that failed and clears
 * only when that same pair completes cleanly.
 */
export type ProviderBlock =
  { kind: 'auth' | 'model'; provider: string; model: string } | { kind: 'reconnecting'; provider: ''; model: '' }

export const $providerBlock = atom<ProviderBlock | null>(null)

const AUTH_CODES = new Set(['auth', 'auth_permanent'])

// The runtime files a rejected credential under the generic client-error
// reason (layer 'provider', code non_retryable_client_error), so the status
// it reports is the only signal left that the key itself was refused.
const AUTH_STATUS_RE =
  /\b(?:HTTP|status(?: code)?|error code)[\s:=]*(?:401|403)\b|\binvalid[\s_-]*(?:x-)?api[\s_-]*key\b|\bauthentication_error\b/i

const STATUS_LAYERS = new Set(['endpoint', 'provider'])

/** True when a failed turn's error line reports a 401/403 from the provider. */
export function isAuthRejection(errorText: null | string | undefined): boolean {
  return Boolean(errorText && AUTH_STATUS_RE.test(errorText))
}

/** The block a failed turn implies, or null for every other layer. */
export function providerBlockFromSurface(
  surface: ErrorSurface | null | undefined,
  errorText?: null | string
): ProviderBlock | null {
  if (!surface) {
    return isAuthRejection(errorText) ? { kind: 'auth', provider: '', model: '' } : null
  }

  const scope = { provider: surface.provider ?? '', model: surface.model ?? '' }

  if (surface.layer === 'auth' || AUTH_CODES.has(surface.code)) {
    return { kind: 'auth', ...scope }
  }

  if (STATUS_LAYERS.has(surface.layer) && surface.code !== 'model_not_found' && isAuthRejection(errorText)) {
    return { kind: 'auth', ...scope }
  }

  if (surface.code === 'model_not_found') {
    return { kind: 'model', ...scope }
  }

  return null
}

/** Raise the banner for a failed turn (no-op when the surface is not a provider block). */
export function noteTurnFailure(surface: ErrorSurface | null | undefined, errorText?: null | string): void {
  const block = providerBlockFromSurface(surface, errorText)

  if (block) {
    $providerBlock.set(block)
  }
}

/** A clean completion clears the banner only when it ran on the blocked pair;
 *  a success on another provider/model says nothing about the blocked one. */
export function noteTurnSuccess(provider: string, model: string): void {
  const block = $providerBlock.get()

  if (!block) {
    return
  }

  if (block.kind === 'reconnecting') {
    $providerBlock.set(null)

    return
  }

  const sameProvider = !block.provider || !provider || block.provider === provider
  const sameModel = !block.model || !model || block.model === model

  if (sameProvider && sameModel) {
    $providerBlock.set(null)
  }
}

/** A session-scoped call failed twice (resume then retry) — the runtime lost it. */
export function noteSessionLost(): void {
  if (!$providerBlock.get()) {
    $providerBlock.set({ kind: 'reconnecting', provider: '', model: '' })
  }
}

export function dismissProviderBlock(): void {
  $providerBlock.set(null)
}

/** One line of copy per block; names only the provider/model, never any text from the provider. */
export function providerBlockMessage(block: ProviderBlock): string {
  const provider = block.provider ? titleCase(block.provider) : ''

  switch (block.kind) {
    case 'auth':
      return provider
        ? `The configured ${provider} key is not a valid ${provider} key. Replies stay off until it is replaced.`
        : 'The configured provider key is not valid. Replies stay off until it is replaced.'

    case 'model':
      return `${block.model || 'This model'} is not available on ${block.provider || 'this provider'}.`

    default:
      return 'Hermes lost this conversation — open it again to reconnect.'
  }
}

export function providerBlockCta(block: ProviderBlock): string | null {
  if (block.kind === 'auth') {
    return 'Open Settings → Providers'
  }

  return block.kind === 'model' ? 'Change model' : null
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
