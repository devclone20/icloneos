// Contract decision 7: when the app repo cannot resolve the install target (an installed app has no repo; a dev repo
// may not have fetched the tip yet), main reads the few files a T1 spec needs at that FULL sha from one constant,
// allowlisted prefix. No redirects, no credentials, a size cap and a timeout; any doubt is null (UNKNOWN).
export const RAW_PREFIX = 'https://raw.githubusercontent.com/NousResearch/hermes-agent/'
const RAW_MAX_BYTES = 2 * 1024 * 1024
const RAW_TIMEOUT_MS = 10_000

const FULL_SHA = /^[0-9a-f]{40}$/
const REPO_PATH = /^[\w-]+(?:\.[\w-]+)*(?:\/[\w-]+(?:\.[\w-]+)*)*$/

export type RawFetch = (url: string, init: RequestInit) => Promise<Response>

interface RawFetchOptions {
  fetch?: RawFetch
  timeoutMs?: number
  maxBytes?: number
}

function rawUrl(sha: string, rel: string): string | null {
  return FULL_SHA.test(sha) && REPO_PATH.test(rel) ? `${RAW_PREFIX}${sha}/${rel}` : null
}

// The decoded body is capped too: a compressed response cannot expand past `maxBytes`.
async function readCapped(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array | null> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0

  for (;;) {
    const { done, value } = await reader.read()

    if (done) {
      break
    }

    size += value.byteLength

    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined)

      return null
    }

    chunks.push(value)
  }

  const out = new Uint8Array(size)
  let at = 0

  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }

  return out
}

export async function fetchUpstreamFile(sha: string, rel: string, opts: RawFetchOptions = {}): Promise<string | null> {
  const url = rawUrl(sha, rel)
  const fetchImpl: RawFetch | undefined = opts.fetch ?? globalThis.fetch?.bind(globalThis)

  if (!url || !fetchImpl) {
    return null
  }

  const maxBytes = opts.maxBytes ?? RAW_MAX_BYTES

  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(opts.timeoutMs ?? RAW_TIMEOUT_MS)
    })

    const declared = Number(res.headers.get('content-length') ?? 0)
    const offHost = res.redirected || (res.url !== '' && res.url !== url)

    if (res.status !== 200 || offHost || declared > maxBytes || !res.body) {
      await res.body?.cancel().catch(() => undefined)

      return null
    }

    const bytes = await readCapped(res.body, maxBytes)

    return bytes ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : null
  } catch {
    return null
  }
}
