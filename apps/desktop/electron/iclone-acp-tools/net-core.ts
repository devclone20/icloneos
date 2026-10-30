/**
 * REL-6 — the installer's one network call, without Electron (net.ts wires `net.fetch`; tests pass a fake): a GET of a
 * registry tarball. Only https://registry.npmjs.org/ (the pin already refuses any other URL; this refuses it again),
 * no redirect followed (asked as `redirect: 'error'`, and a response that says it was redirected, or answers for
 * another URL, is refused anyway), no cache, a size cap on the header and on the body as it streams.
 *
 * TIMEOUTS (critic m6, r2 m3). A tarball that sends nothing for `idleMs` is STALLED. Its total budget is
 * `totalMs` or the time its size takes at `minBytesPerSecond` (20 KB/s), whichever is longer — the size declared by
 * the registry, else what has arrived so far — so a slow but moving line (the CLI's ~15 MB tarball at 40 KB/s) is
 * not cut, and one slower than the floor TIMES OUT. Either aborts the request and fails the install with its own
 * reason; the owner's Cancel aborts at any moment through `signal`.
 */
import { ACP_REGISTRY } from '../../src/iclone-shared/acp-pin'

import { AcpToolsError } from './errors'

/** The CLI's own tarball, with three signer binaries, is the largest (~15 MB compressed). */
export const MAX_TARBALL = 64 * 1024 * 1024
export const IDLE_MS = 30_000
export const TOTAL_MS = 180_000
/** The slowest average rate an install waits out, once `totalMs` has passed (20 KB/s). */
export const MIN_BYTES_PER_SECOND = 20 * 1024

export interface FetchResponseLike {
  status: number
  redirected?: boolean
  url?: string
  headers: { get(name: string): string | null }
  body: ReadableStream<Uint8Array> | null
}

export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; redirect: 'error'; cache: 'no-store'; headers: Record<string, string> }
) => Promise<FetchResponseLike>

export interface RegistryFetchOptions {
  fetch: FetchLike
  idleMs?: number
  totalMs?: number
  minBytesPerSecond?: number
  maxBytes?: number
}

const nameOf = (url: string) =>
  url
    .slice(ACP_REGISTRY.length)
    .split('/-/')[1]
    ?.replace(/\.tgz$/, '') ?? 'tarball'

export function createRegistryFetch(options: RegistryFetchOptions) {
  const idleMs = options.idleMs ?? IDLE_MS
  const totalMs = options.totalMs ?? TOTAL_MS
  const maxBytes = options.maxBytes ?? MAX_TARBALL
  const minRate = options.minBytesPerSecond ?? MIN_BYTES_PER_SECOND

  return async function registryFetch(url: string, signal: AbortSignal): Promise<Buffer> {
    if (!url.startsWith(ACP_REGISTRY) || url.includes('..') || url.includes('?') || url.includes('#')) {
      throw new AcpToolsError('download-refused', nameOf(url), 'only registry.npmjs.org tarballs are fetched')
    }

    const subject = nameOf(url)
    const controller = new AbortController()
    let why: 'stalled' | 'timeout' | null = null
    let idle: ReturnType<typeof setTimeout> | null = null

    const stop = (reason: 'stalled' | 'timeout') => {
      why ??= reason
      controller.abort()
    }

    const onCancel = () => controller.abort()
    const started = Date.now()
    let declared = 0
    let received = 0
    let total: ReturnType<typeof setTimeout> | null = null

    // The deadline moves with the size: max(totalMs, size at the floor rate). Checked when it falls due.
    const budget = () => Math.max(totalMs, (Math.max(declared, received) / minRate) * 1000)

    const armTotal = () => {
      total = setTimeout(
        () => {
          const left = started + budget() - Date.now()

          if (left > 0) {
            armTotal()
          } else {
            stop('timeout')
          }
        },
        Math.max(1, started + budget() - Date.now())
      )
    }

    armTotal()

    const arm = () => {
      if (idle) {
        clearTimeout(idle)
      }

      idle = setTimeout(() => stop('stalled'), idleMs)
    }

    signal.addEventListener('abort', onCancel, { once: true })

    if (signal.aborted) {
      controller.abort()
    }

    arm()

    const failed = (error: unknown): never => {
      if (signal.aborted) {
        throw new Error('cancelled')
      }

      if (why === 'stalled') {
        throw new AcpToolsError('download-stalled', subject)
      }

      if (why === 'timeout') {
        throw new AcpToolsError('download-timeout', subject)
      }

      if (error instanceof AcpToolsError) {
        throw error
      }

      throw new AcpToolsError('download-failed', subject, error instanceof Error ? error.message : String(error))
    }

    try {
      const response = await options
        .fetch(url, {
          signal: controller.signal,
          redirect: 'error',
          cache: 'no-store',
          headers: { accept: 'application/octet-stream' }
        })
        .catch(failed)

      if (response.redirected === true || (response.url && response.url !== url)) {
        throw new AcpToolsError('download-refused', subject, 'the registry answered for another URL')
      }

      if (response.status !== 200) {
        throw new AcpToolsError('download-failed', subject, `HTTP ${response.status}`)
      }

      declared = Number(response.headers.get('content-length') ?? 0) || 0

      if (declared > maxBytes) {
        throw new AcpToolsError('download-too-large', subject)
      }

      if (!response.body) {
        throw new AcpToolsError('download-failed', subject, 'no body')
      }

      const reader = response.body.getReader()
      const chunks: Buffer[] = []
      let size = 0

      arm()

      for (;;) {
        const { done, value } = await reader.read().catch(failed)

        if (done) {
          break
        }

        arm()
        size += value.byteLength
        received = size

        if (size > maxBytes) {
          void reader.cancel().catch(() => undefined)

          throw new AcpToolsError('download-too-large', subject)
        }

        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
      }

      if (controller.signal.aborted) {
        failed(new Error('aborted'))
      }

      return Buffer.concat(chunks, size)
    } catch (error) {
      return failed(error)
    } finally {
      if (total) {
        clearTimeout(total)
      }

      if (idle) {
        clearTimeout(idle)
      }

      signal.removeEventListener('abort', onCancel)
    }
  }
}
