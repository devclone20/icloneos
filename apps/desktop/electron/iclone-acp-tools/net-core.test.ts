// REL-6 — the installer's network rules without Electron (critic C11/C12 survivors and m6): registry host only, no
// redirect followed, size caps, stall and total timeouts, the owner's cancel.
import { describe, expect, it } from 'vitest'

import { AcpToolsError } from './errors'
import { createRegistryFetch, type FetchLike, type FetchResponseLike } from './net-core'

const URL_OK = 'https://registry.npmjs.org/dep-a/-/dep-a-2.0.0.tgz'

function respond(chunks: (Uint8Array | 'hang')[], init: Partial<FetchResponseLike> = {}): FetchResponseLike {
  let i = 0

  return {
    status: 200,
    url: URL_OK,
    redirected: false,
    headers: { get: () => null },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks[i++]

        if (next === 'hang') {
          // Never answers: the connection is open and silent.
          return new Promise<void>(() => undefined)
        }

        if (next === undefined) {
          controller.close()
        } else {
          controller.enqueue(next)
        }

        return undefined
      }
    }),
    ...init
  }
}

/** A fetch whose body honours the abort signal like a real one (the stream errors when aborted). */
function fake(make: () => FetchResponseLike): { fetch: FetchLike; calls: Parameters<FetchLike>[] } {
  const calls: Parameters<FetchLike>[] = []

  return {
    calls,
    fetch: async (url, init) => {
      calls.push([url, init])

      const response = make()
      const body = response.body

      if (!body) {
        return response
      }

      const reader = body.getReader()

      return {
        ...response,
        body: new ReadableStream<Uint8Array>({
          async pull(controller) {
            const aborted = new Promise<never>((_, reject) =>
              init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
            )

            try {
              const { done, value } = await Promise.race([reader.read(), aborted])

              if (done) {
                controller.close()
              } else {
                controller.enqueue(value)
              }
            } catch (error) {
              controller.error(error)
            }
          }
        })
      }
    }
  }
}

const reasonOf = async (promise: Promise<unknown>) => {
  try {
    await promise

    return 'resolved'
  } catch (error) {
    return error instanceof AcpToolsError ? `${error.reason}:${error.subject ?? ''}` : (error as Error).message
  }
}

describe('net-core registryFetch', () => {
  it('fetches a registry tarball, asks for no redirect and no cache', async () => {
    const f = fake(() => respond([new Uint8Array([1, 2]), new Uint8Array([3])]))
    const body = await createRegistryFetch({ fetch: f.fetch })(URL_OK, new AbortController().signal)

    expect([...body]).toEqual([1, 2, 3])
    expect(f.calls[0]?.[1]).toMatchObject({ redirect: 'error', cache: 'no-store' })
  })

  it('refuses any other host before a request is made (C12)', async () => {
    const f = fake(() => respond([]))
    const get = createRegistryFetch({ fetch: f.fetch })

    for (const url of [
      'https://evil.example/dep-a/-/dep-a-2.0.0.tgz',
      'http://registry.npmjs.org/dep-a/-/dep-a-2.0.0.tgz',
      'https://registry.npmjs.org.evil.example/dep-a/-/dep-a-2.0.0.tgz',
      'https://registry.npmjs.org/dep-a/-/../../x.tgz'
    ]) {
      expect(await reasonOf(get(url, new AbortController().signal))).toMatch(/^download-refused:/)
    }

    expect(f.calls).toHaveLength(0)
  })

  it('refuses an answer that was redirected or is for another URL (C11)', async () => {
    const get = (init: Partial<FetchResponseLike>) =>
      createRegistryFetch({ fetch: fake(() => respond([new Uint8Array([1])], init)).fetch })(
        URL_OK,
        new AbortController().signal
      )

    expect(await reasonOf(get({ redirected: true }))).toBe('download-refused:dep-a-2.0.0')
    expect(await reasonOf(get({ url: 'https://evil.example/x.tgz' }))).toBe('download-refused:dep-a-2.0.0')
    expect(await reasonOf(get({ status: 302 }))).toBe('download-failed:dep-a-2.0.0')
  })

  it('caps the size on the header and while it streams', async () => {
    const big = createRegistryFetch({
      maxBytes: 4,
      fetch: fake(() => respond([new Uint8Array(3)], { headers: { get: () => '99' } })).fetch
    })

    expect(await reasonOf(big(URL_OK, new AbortController().signal))).toBe('download-too-large:dep-a-2.0.0')

    const streamed = createRegistryFetch({
      maxBytes: 4,
      fetch: fake(() => respond([new Uint8Array(3), new Uint8Array(3)])).fetch
    })

    expect(await reasonOf(streamed(URL_OK, new AbortController().signal))).toBe('download-too-large:dep-a-2.0.0')
  })

  it('a body that stops sending is STALLED after the idle time (m6)', async () => {
    const get = createRegistryFetch({
      idleMs: 60,
      totalMs: 10_000,
      fetch: fake(() => respond([new Uint8Array([1]), 'hang'])).fetch
    })

    const started = Date.now()

    expect(await reasonOf(get(URL_OK, new AbortController().signal))).toBe('download-stalled:dep-a-2.0.0')
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('a steady body longer than the idle time is NOT stalled: every chunk re-arms the idle timer (critic r2 D3)', async () => {
    let n = 0

    const steady = (): FetchResponseLike => ({
      ...respond([]),
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, 30))

          if (n++ < 10) {
            controller.enqueue(new Uint8Array([n]))
          } else {
            controller.close()
          }
        }
      })
    })

    const get = createRegistryFetch({ idleMs: 100, totalMs: 10_000, fetch: fake(steady).fetch })

    expect((await get(URL_OK, new AbortController().signal)).length).toBe(10)
  })

  it('a body that trickles past the total time TIMES OUT (m6)', async () => {
    let n = 0

    const trickle = (): FetchResponseLike => ({
      ...respond([]),
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, 20))
          controller.enqueue(new Uint8Array([n++ % 255]))
        }
      })
    })

    const get = createRegistryFetch({ idleMs: 1_000, totalMs: 150, fetch: fake(trickle).fetch })

    expect(await reasonOf(get(URL_OK, new AbortController().signal))).toBe('download-timeout:dep-a-2.0.0')
  })

  it('a slow but moving download gets a budget from its size at the 20 KB/s floor (critic r2 m3)', async () => {
    let n = 0

    // 4,000 bytes declared at a 20,000 B/s floor: 200 ms budget, more than the 100 ms total. 10 × 400 B in ~150 ms.
    const slow = (): FetchResponseLike => ({
      ...respond([]),
      headers: { get: (name: string) => (name === 'content-length' ? '4000' : null) },
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, 15))

          if (n++ < 10) {
            controller.enqueue(new Uint8Array(400))
          } else {
            controller.close()
          }
        }
      })
    })

    const get = createRegistryFetch({ idleMs: 1_000, totalMs: 100, minBytesPerSecond: 20_000, fetch: fake(slow).fetch })

    expect((await get(URL_OK, new AbortController().signal)).length).toBe(4000)

    // Below the floor (400 B every 60 ms ≈ 6.7 KB/s against 20 KB/s): it still times out.
    n = 0

    const slower = (): FetchResponseLike => ({
      ...slow(),
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, 60))
          controller.enqueue(new Uint8Array(400))
        }
      })
    })

    const late = createRegistryFetch({
      idleMs: 1_000,
      totalMs: 100,
      minBytesPerSecond: 20_000,
      fetch: fake(slower).fetch
    })

    expect(await reasonOf(late(URL_OK, new AbortController().signal))).toBe('download-timeout:dep-a-2.0.0')
  })

  it('no declared size: the budget grows with the bytes received, so a moving body is not cut at the fixed total (critic r3 F2)', async () => {
    let n = 0

    // No content-length (the lockfile records no size either): 10 × 1,000 B every 15 ms ≈ 66 KB/s, past a 100 ms total.
    const undeclared = (): FetchResponseLike => ({
      ...respond([]),
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, 15))

          if (n++ < 10) {
            controller.enqueue(new Uint8Array(1000))
          } else {
            controller.close()
          }
        }
      })
    })

    const get = createRegistryFetch({
      idleMs: 1_000,
      totalMs: 100,
      minBytesPerSecond: 20_000,
      fetch: fake(undeclared).fetch
    })

    expect((await get(URL_OK, new AbortController().signal)).length).toBe(10_000)
  })

  it('the owner’s cancel aborts a stalled download at once', async () => {
    const get = createRegistryFetch({
      idleMs: 10_000,
      totalMs: 10_000,
      fetch: fake(() => respond(['hang'])).fetch
    })

    const controller = new AbortController()
    const pending = reasonOf(get(URL_OK, controller.signal))

    setTimeout(() => controller.abort(), 30)
    expect(await pending).toBe('cancelled')
  })
})
