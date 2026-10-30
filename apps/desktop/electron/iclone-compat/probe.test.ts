import fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import { namedKeys, PROBE_KEY, type ProbeFrame, probePlan, runProbe } from './probe'

type RecordedError = NonNullable<ProbeFrame['error']> & { message: string }

// Frames the real runtime returned, recorded verbatim (see the fixture's `recorded`).
const real = JSON.parse(fs.readFileSync(new URL('./fixtures/runtime-4000.json', import.meta.url), 'utf8')) as {
  probeKey: RecordedError
  renamedKey: RecordedError
}

const closed = (props: string[]) => ({
  type: 'object',
  additionalProperties: false,
  properties: Object.fromEntries(props.map(p => [p, { type: 'string' }]))
})

const spec = {
  methods: {
    'a.served': { params: 'AParams' },
    'b.served': { params: closed(['text']) },
    'c.open': { params: { type: 'object', properties: { x: { type: 'string' } } } }
  },
  schemas: { AParams: closed(['session_id', 'text']) }
}

const lock = {
  methods: {
    'a.served': { params: { session_id: 'string', 'text?': 'string' } },
    'b.served': { params: { text: 'string' } },
    'c.open': { params: { x: 'string' } },
    'z.absent': { params: { q: 'string' } }
  }
}

function fakeRuntime(answer: (method: string, params: Record<string, unknown>) => ProbeFrame) {
  const frames: { method: string; params: Record<string, unknown> }[] = []

  return {
    frames,
    call: async (method: string, params: Record<string, unknown>) => {
      frames.push({ method, params })

      return answer(method, params)
    }
  }
}

const rejectsProbeKey = (): ProbeFrame => ({
  error: { code: 4000, message: `Additional properties are not allowed ('${PROBE_KEY}' was unexpected)` }
})

describe('iclone-compat probe', () => {
  it('sends every sent key as null with the probe key last, after capabilities without server requests', async () => {
    const rt = fakeRuntime(rejectsProbeKey)
    const caps: unknown[] = []
    const r = await runProbe({ lock, spec, call: rt.call, capabilities: async c => caps.push(c) })

    expect(caps).toEqual([{ server_requests: false }])
    expect(rt.frames.map(f => f.method)).toEqual(['a.served', 'b.served'])
    expect(Object.keys(rt.frames[0].params)).toEqual(['session_id', 'text', PROBE_KEY])
    expect(rt.frames[0].params).toEqual({ session_id: null, text: null, [PROBE_KEY]: 1 })
    expect(r).toMatchObject({ ok: 2, gone: 0, renamed: 0, skipped: 2, unsafe: false, frames: 2 })
  })

  it('P4a.probe.safety: an executing fake (result frame) marks the run unsafe and stops sending', async () => {
    const rt = fakeRuntime(() => ({ result: { ran: true } }))
    const r = await runProbe({ lock, spec, call: rt.call })

    expect(r.unsafe).toBe(true)
    expect(r.reason).toBe('result-frame')
    expect(r.abortedAt).toBe('a.served')
    expect(rt.frames).toHaveLength(1)
  })

  it('P4a.probe.safety: any error code other than -32601 or 4000 aborts the run', async () => {
    const rt = fakeRuntime(() => ({ error: { code: -32000, message: 'handler failed' } }))
    const r = await runProbe({ lock, spec, call: rt.call })

    expect(r).toMatchObject({ unsafe: true, reason: 'error-code -32000', frames: 1, ok: 0 })
  })

  it('P4a.probe.safety: a method absent from T1 or with open params gets 0 frames', async () => {
    const rt = fakeRuntime(rejectsProbeKey)
    await runProbe({ lock, spec, call: rt.call })
    const plan = probePlan(lock, spec)

    expect(rt.frames.filter(f => f.method === 'z.absent' || f.method === 'c.open')).toHaveLength(0)
    expect(plan.skipped).toEqual([
      { method: 'c.open', reason: 'params-not-closed' },
      { method: 'z.absent', reason: 'absent-from-t1' }
    ])
    expect(probePlan(lock, { methods: {}, schemas: {} }).send).toEqual([])
  })

  it('P4a.probe.safety: 4000 naming another key is a rename; -32601 is gone', async () => {
    const rt = fakeRuntime(method =>
      method === 'a.served'
        ? { error: { code: 4000, message: 'invalid params', data: [{ loc: ['session_key'], msg: 'field required' }] } }
        : { error: { code: -32601, message: 'Method not found' } }
    )

    const r = await runProbe({ lock, spec, call: rt.call })

    expect(r.unsafe).toBe(false)
    expect(r.names.renamed).toEqual([{ method: 'a.served', key: 'session_key' }])
    expect(r.names.gone).toEqual(['b.served'])
    expect(r).toMatchObject({ ok: 0, renamed: 1, gone: 1 })
  })

  it('P4a.x.r5.probe_real: the real runtime names the extra key unquoted, and the probe reads it', async () => {
    expect(namedKeys(real.probeKey)).toContain(PROBE_KEY)
    expect(namedKeys(real.renamedKey)[0]).toBe('turn_author')

    const rt = fakeRuntime(method =>
      method === 'a.served'
        ? { error: real.renamedKey }
        : { error: { ...real.probeKey, message: real.probeKey.message.replace('approval.pending', method) } }
    )

    const r = await runProbe({ lock, spec, call: rt.call })

    expect(r).toMatchObject({ unsafe: false, reason: null, ok: 1, renamed: 1, gone: 0 })
    expect(r.names.renamed).toEqual([{ method: 'a.served', key: 'turn_author' }])
  })
})
