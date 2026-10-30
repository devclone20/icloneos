// The live probe (contract decision 12) validates only. Each locked method that T1 closes with
// `additionalProperties:false` gets `{<sentKeys>: null, __iclone_probe: 1}` (probe key last), so a served method rejects
// the frame in validation before any handler runs. A method absent from T1 or with open params is never sent, because
// the runtime executes a handler without validation when no contract exists. Any result frame, or any error other than
// -32601 / 4000, aborts the run as unsafe.
import type { Schema, Schemas } from './schema'
import { objectShape } from './schema'

export const PROBE_KEY = '__iclone_probe'
/** @public used by iclone/contract/canary/run.mjs */
export const METHOD_NOT_FOUND = -32601
/** @public used by iclone/contract/canary/run.mjs */
export const INVALID_PARAMS = 4000

export interface ProbeFrame {
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

export type ProbeCall = (method: string, params: Record<string, unknown>) => Promise<ProbeFrame>

interface ProbeLock {
  methods?: Record<string, { params?: Record<string, string> | string; guardedBy?: string; requires?: string }>
}

export interface ProbeSpec {
  methods?: Record<string, { params?: Schema | string } | undefined>
  schemas?: Schemas
}

interface ProbePlanItem {
  method: string
  params: Record<string, unknown>
}

export interface ProbeReport {
  ok: number
  gone: number
  renamed: number
  skipped: number
  unsafe: boolean
  frames: number
  ms: number
  abortedAt: string | null
  reason: string | null
  names: { gone: string[]; renamed: { method: string; key: string }[]; skipped: { method: string; reason: string }[] }
}

/** @public used by iclone/contract/canary/run.mjs */
export function sentKeys(params: Record<string, string> | string | undefined): string[] {
  if (!params || typeof params !== 'object') {
    return []
  }

  return Object.keys(params)
    .map(k => k.replace(/\?$/, ''))
    .filter(k => k !== PROBE_KEY)
}

export function probePlan(
  lock: ProbeLock,
  spec: ProbeSpec
): { send: ProbePlanItem[]; skipped: ProbeReport['names']['skipped'] } {
  const send: ProbePlanItem[] = []
  const skipped: ProbeReport['names']['skipped'] = []
  const schemas = spec.schemas ?? {}

  for (const method of Object.keys(lock.methods ?? {}).sort()) {
    const served = spec.methods?.[method]
    const { guardedBy, requires } = lock.methods?.[method] ?? {}

    // A dual path (contract P4c D2): the app never calls the legacy branch where its guard is served, nor the new
    // branch where its capability is absent — probing either would report a method the app does not use as gone.
    if (guardedBy && spec.methods?.[guardedBy]) {
      skipped.push({ method, reason: 'guarded-legacy' })

      continue
    }

    if (requires && !spec.methods?.[requires]) {
      skipped.push({ method, reason: 'gated-new-path' })

      continue
    }

    if (!served) {
      skipped.push({ method, reason: 'absent-from-t1' })

      continue
    }

    const schema = typeof served.params === 'string' ? schemas[served.params] : served.params

    if (!objectShape(schema, schemas)?.closed) {
      skipped.push({ method, reason: 'params-not-closed' })

      continue
    }

    const params: Record<string, unknown> = {}

    for (const key of sentKeys(lock.methods?.[method]?.params)) {
      params[key] = null
    }

    params[PROBE_KEY] = 1
    send.push({ method, params })
  }

  return { send, skipped }
}

// Keys a 4000 rejection names: structured `data` (pydantic `loc`, `field`, `key`) first, then the runtime's own unquoted
// form (`invalid params for <method>: <loc>: <msg>`, loc dot-joined, its first part is the key sent), then quoted words.
const RUNTIME_4000 = /\binvalid params for [^\s:]+: ([A-Za-z_][\w.-]*): /

export function namedKeys(error: ProbeFrame['error']): string[] {
  const keys = new Set<string>()

  const visit = (node: unknown, depth: number) => {
    if (depth > 4 || node === null || typeof node !== 'object') {
      return
    }

    if (Array.isArray(node)) {
      node.forEach(n => visit(n, depth + 1))

      return
    }

    const rec = node as Record<string, unknown>

    for (const field of ['loc', 'field', 'key', 'param', 'path']) {
      const v = rec[field]
      const list = Array.isArray(v) ? v : [v]
      list.filter((x): x is string => typeof x === 'string').forEach(x => keys.add(x))
    }

    Object.values(rec).forEach(v => visit(v, depth + 1))
  }

  visit(error?.data, 0)

  const loc = RUNTIME_4000.exec(String(error?.message ?? ''))?.[1]

  if (loc) {
    keys.add(loc)
    keys.add(loc.split('.')[0])
  }

  for (const m of String(error?.message ?? '').matchAll(/['"`]([A-Za-z_][\w.-]*)['"`]/g)) {
    keys.add(m[1])
  }

  return [...keys]
}

export async function runProbe(opts: {
  lock: ProbeLock
  spec: ProbeSpec
  call: ProbeCall
  // The probe's own connection never accepts server requests; the glue passes the `client.capabilities` call here.
  capabilities?: (caps: { server_requests: false }) => Promise<unknown>
  now?: () => number
}): Promise<ProbeReport> {
  const now = opts.now ?? (() => performance.now())
  const t0 = now()
  const { send, skipped } = probePlan(opts.lock, opts.spec)

  const report: ProbeReport = {
    ok: 0,
    gone: 0,
    renamed: 0,
    skipped: skipped.length,
    unsafe: false,
    frames: 0,
    ms: 0,
    abortedAt: null,
    reason: null,
    names: { gone: [], renamed: [], skipped }
  }

  const abort = (method: string, reason: string) => {
    report.unsafe = true
    report.abortedAt = method
    report.reason = reason
  }

  await opts.capabilities?.({ server_requests: false })

  for (const item of send) {
    report.frames += 1
    let frame: ProbeFrame

    try {
      frame = await opts.call(item.method, item.params)
    } catch (error) {
      abort(item.method, `transport: ${error instanceof Error ? error.message : String(error)}`)

      break
    }

    if (!frame.error) {
      abort(item.method, 'result-frame')

      break
    }

    if (frame.error.code === METHOD_NOT_FOUND) {
      report.gone += 1
      report.names.gone.push(item.method)

      continue
    }

    if (frame.error.code !== INVALID_PARAMS) {
      abort(item.method, `error-code ${String(frame.error.code)}`)

      break
    }

    const keys = namedKeys(frame.error)

    if (keys.includes(PROBE_KEY)) {
      report.ok += 1
    } else if (keys.length > 0) {
      report.renamed += 1
      report.names.renamed.push({ method: item.method, key: keys[0] })
    } else {
      abort(item.method, '4000-names-no-key')

      break
    }
  }

  report.ms = Math.round((now() - t0) * 100) / 100

  return report
}
