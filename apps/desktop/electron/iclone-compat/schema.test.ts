import fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  acceptsType,
  enumValues,
  objectShape,
  type Schema,
  schemaAt,
  type Schemas,
  unsupportedKeywords,
  validate
} from './schema'

// Read from disk, not imported: the composite electron tsconfig only compiles files its include lists.
const readJson = (rel: string) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'))
const schemas = readJson('./fixtures/spec.json').schemas as Schemas
const named = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` })

// The provider spec the lock was verified against (served.py output, committed next to the lock).
const committedSpec = new URL('../../../../iclone/contract/runtime.spec.json', import.meta.url)

describe('P4a.schema', () => {
  it('P4a.schema: every keyword of the committed provider spec is supported', () => {
    const spec = readJson(committedSpec.href) as { schemas: Schemas }
    const names = Object.keys(spec.schemas)

    const unsupported = names.flatMap(n => unsupportedKeywords(spec.schemas[n], spec.schemas).map(k => `${n}: ${k}`))

    expect(names.length).toBeGreaterThan(100)
    expect(unsupported).toEqual([])
  })

  it('P4a.schema: validate accepts conforming values and names every violation', () => {
    expect(validate({ cwd: '/srv', profile: null }, named('SessionCreateParams'), schemas)).toEqual([])
    expect(validate({ cwd: 3 }, named('SessionCreateParams'), schemas)).not.toEqual([])
    expect(validate({ profile: 'p' }, named('SessionCreateParams'), schemas)).not.toEqual([])
    expect(validate({ cwd: '/srv', extra: 1 }, named('SessionCreateParams'), schemas)).not.toEqual([])

    const ok = { session_id: 's1', info: { status: 'idle', turns: [1, 2] } }

    expect(validate(ok, named('SessionCreateResult'), schemas)).toEqual([])
    expect(validate({ ...ok, info: { status: 'archived' } }, named('SessionCreateResult'), schemas)).not.toEqual([])
    expect(
      validate({ ...ok, info: { status: 'idle', turns: ['x'] } }, named('SessionCreateResult'), schemas)
    ).not.toEqual([])
  })

  it('P4a.schema: shape questions answer through $ref and anyOf', () => {
    const shape = objectShape(named('SessionCreateParams'), schemas)

    expect(shape?.closed).toBe(true)
    expect([...(shape?.required ?? [])]).toEqual(['cwd'])
    expect(Object.keys(shape?.properties ?? {}).sort()).toEqual(['cwd', 'profile'])
    expect(acceptsType(shape?.properties.profile, 'string', schemas)).toBe(true)
    expect(acceptsType(shape?.properties.profile, 'null', schemas)).toBe(true)
    expect(acceptsType(shape?.properties.cwd, 'number', schemas)).toBe(false)

    const status = schemaAt(named('SessionCreateResult'), ['info', 'status'], schemas)

    expect(enumValues(status, schemas)).toEqual(['idle', 'running'])
    expect(objectShape(named('SessionInfo'), schemas)?.closed).toBe(false)
  })

  it('P4a.schema: an unknown keyword is reported, annotations are not', () => {
    expect(unsupportedKeywords({ type: 'string', title: 'T', description: 'd', default: '' }, {})).toEqual([])
    expect(unsupportedKeywords({ type: 'object', unevaluatedProperties: false }, {})).toEqual(['unevaluatedProperties'])
  })
})
