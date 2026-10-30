// JSON Schema (draft 2020-12, as pydantic emits it into the runtime's OpenRPC document) evaluated without a dependency.
// verify.ts asks shape questions (which keys, which types, which enum members); validate() is the full assertion path.

export type Schema = boolean | { [keyword: string]: unknown }
export type Schemas = Record<string, Schema>
export type JsonType = 'array' | 'boolean' | 'null' | 'number' | 'object' | 'string'

interface ObjectShape {
  properties: Record<string, Schema>
  required: Set<string>
  // additionalProperties: false on every branch: a key we send that is not listed is rejected.
  closed: boolean
}

const ANNOTATIONS = new Set([
  '$comment',
  '$id',
  '$schema',
  'default',
  'deprecated',
  'description',
  'discriminator',
  'example',
  'examples',
  'format',
  'readOnly',
  'title',
  'writeOnly'
])

const SUPPORTED_KEYWORDS = new Set([
  ...ANNOTATIONS,
  '$defs',
  '$ref',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'contains',
  'definitions',
  'dependentRequired',
  'else',
  'enum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'if',
  'items',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'multipleOf',
  'not',
  'nullable',
  'oneOf',
  'pattern',
  'patternProperties',
  'prefixItems',
  'properties',
  'propertyNames',
  'required',
  'then',
  'type',
  'uniqueItems'
])

type Node = { [keyword: string]: unknown }

const isNode = (s: unknown): s is Node => typeof s === 'object' && s !== null && !Array.isArray(s)
const list = (v: unknown): Schema[] => (Array.isArray(v) ? (v as Schema[]) : [])

function jsonType(value: unknown): JsonType {
  if (value === null) {
    return 'null'
  }

  if (Array.isArray(value)) {
    return 'array'
  }

  const t = typeof value

  return t === 'number' || t === 'bigint' ? 'number' : t === 'boolean' || t === 'string' ? t : 'object'
}

function deref(schema: Schema | undefined, schemas: Schemas, seen: Set<string> = new Set()): Schema {
  if (!isNode(schema) || typeof schema.$ref !== 'string') {
    return schema ?? true
  }

  const name = schema.$ref.slice(schema.$ref.lastIndexOf('/') + 1)

  if (seen.has(name) || !(name in schemas)) {
    return true
  }

  seen.add(name)

  return deref(schemas[name], schemas, seen)
}

function typesOf(s: Node): string[] | null {
  const t = s.type
  const out = typeof t === 'string' ? [t] : Array.isArray(t) ? (t as string[]) : null

  return out && s.nullable === true ? [...out, 'null'] : out
}

export function acceptsType(schema: Schema | undefined, type: JsonType, schemas: Schemas, depth = 0): boolean {
  const s = deref(schema, schemas)

  if (!isNode(s) || depth > 32) {
    return s !== false
  }

  const sub = (x: Schema) => acceptsType(x, type, schemas, depth + 1)

  if (Array.isArray(s.anyOf) && !list(s.anyOf).some(sub)) {
    return false
  }

  if (Array.isArray(s.oneOf) && !list(s.oneOf).some(sub)) {
    return false
  }

  if (Array.isArray(s.allOf) && !list(s.allOf).every(sub)) {
    return false
  }

  if ('const' in s && jsonType(s.const) !== type) {
    return false
  }

  if (Array.isArray(s.enum) && !s.enum.some(v => jsonType(v) === type)) {
    return false
  }

  const types = typesOf(s)

  return !types || types.includes(type) || (type === 'number' && types.includes('integer'))
}

export function objectShape(schema: Schema | undefined, schemas: Schemas, depth = 0): ObjectShape | null {
  const s = deref(schema, schemas)

  if (!isNode(s) || depth > 32) {
    return null
  }

  const parts = [
    ...list(s.allOf).map(x => objectShape(x, schemas, depth + 1)),
    ...(isNode(s.properties) || s.type === 'object' ? [ownShape(s)] : [])
  ].filter((shape): shape is ObjectShape => shape !== null)

  const branches = [...list(s.anyOf), ...list(s.oneOf)]
    .map(x => objectShape(x, schemas, depth + 1))
    .filter((shape): shape is ObjectShape => shape !== null)

  if (branches.length) {
    parts.push(union(branches))
  }

  if (!parts.length) {
    return null
  }

  const merged: ObjectShape = { properties: {}, required: new Set(), closed: false }

  for (const p of parts) {
    Object.assign(merged.properties, p.properties)

    for (const r of p.required) {
      merged.required.add(r)
    }

    merged.closed ||= p.closed
  }

  return merged
}

function ownShape(s: Node): ObjectShape {
  return {
    properties: isNode(s.properties) ? (s.properties as Record<string, Schema>) : {},
    required: new Set(Array.isArray(s.required) ? (s.required as string[]) : []),
    closed: s.additionalProperties === false && !isNode(s.patternProperties)
  }
}

function union(shapes: ObjectShape[]): ObjectShape {
  const out: ObjectShape = { properties: {}, required: new Set(shapes[0].required), closed: true }

  for (const sh of shapes) {
    Object.assign(out.properties, sh.properties)

    for (const r of out.required) {
      if (!sh.required.has(r)) {
        out.required.delete(r)
      }
    }

    out.closed &&= sh.closed
  }

  return out
}

// Schema of a dotted read path (`session.id`, `items[].kind`); undefined when a segment is not declared.
export function schemaAt(schema: Schema | undefined, path: string[], schemas: Schemas): Schema | undefined {
  let cur: Schema | undefined = schema

  for (const seg of path) {
    const arr = seg.endsWith('[]')
    const shape = objectShape(cur, schemas)
    cur = shape?.properties[arr ? seg.slice(0, -2) : seg]

    if (cur === undefined) {
      return undefined
    }

    if (arr) {
      const items = deref(cur, schemas)
      cur = isNode(items) ? (items.items as Schema | undefined) : undefined
    }
  }

  return cur
}

export function enumValues(schema: Schema | undefined, schemas: Schemas, depth = 0): unknown[] | null {
  const s = deref(schema, schemas)

  if (!isNode(s) || depth > 32) {
    return null
  }

  if (Array.isArray(s.enum)) {
    return s.enum
  }

  if ('const' in s) {
    return [s.const]
  }

  const branches = [...list(s.anyOf), ...list(s.oneOf)].map(x => enumValues(x, schemas, depth + 1))
  const values = branches.filter(Boolean).flat()

  return values.length ? [...new Set(values)] : null
}

export function unsupportedKeywords(schema: Schema | undefined, schemas: Schemas): string[] {
  const out = new Set<string>()
  const seen = new Set<unknown>()

  const walk = (x: unknown) => {
    if (Array.isArray(x)) {
      return x.forEach(walk)
    }

    if (!isNode(x) || seen.has(x)) {
      return
    }

    seen.add(x)

    if (typeof x.$ref === 'string') {
      walk(deref(x, schemas))
    }

    for (const [k, v] of Object.entries(x)) {
      if (k.startsWith('x-')) {
        continue
      }

      if (!SUPPORTED_KEYWORDS.has(k)) {
        out.add(k)
      }

      if (k === 'properties' || k === 'patternProperties' || k === '$defs' || k === 'definitions') {
        if (isNode(v)) {
          Object.values(v).forEach(walk)
        }
      } else if (!ANNOTATIONS.has(k) && k !== 'enum' && k !== 'const' && k !== 'required') {
        walk(v)
      }
    }
  }

  walk(schema)

  return [...out].sort()
}

const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// Every violation of `value` against `schema`, as `<json pointer>: <keyword>`; [] when valid.
export function validate(value: unknown, schema: Schema | undefined, schemas: Schemas, at = ''): string[] {
  const s = deref(schema, schemas)

  if (s === true || s === undefined) {
    return []
  }

  if (s === false || !isNode(s)) {
    return [`${at || '/'}: false`]
  }

  const errs: string[] = []
  const fail = (kw: string) => errs.push(`${at || '/'}: ${kw}`)
  const ok = (x: Schema, v: unknown = value) => validate(v, x, schemas, at).length === 0
  const t = jsonType(value)
  const types = typesOf(s)
  const isInt = t === 'number' && Number.isInteger(value)

  if (types && !types.includes(t) && !(isInt && types.includes('integer'))) {
    fail('type')
  }

  if (Array.isArray(s.enum) && !s.enum.some(e => equal(e, value))) {
    fail('enum')
  }

  if ('const' in s && !equal(s.const, value)) {
    fail('const')
  }

  if (Array.isArray(s.allOf) && !list(s.allOf).every(x => ok(x))) {
    fail('allOf')
  }

  if (Array.isArray(s.anyOf) && !list(s.anyOf).some(x => ok(x))) {
    fail('anyOf')
  }

  if (Array.isArray(s.oneOf) && list(s.oneOf).filter(x => ok(x)).length !== 1) {
    fail('oneOf')
  }

  if ('not' in s && ok(s.not as Schema)) {
    fail('not')
  }

  if ('if' in s) {
    const branch = ok(s.if as Schema) ? s.then : s.else

    if (branch !== undefined && !ok(branch as Schema)) {
      fail(ok(s.if as Schema) ? 'then' : 'else')
    }
  }

  if (t === 'number') {
    const n = value as number

    if (typeof s.minimum === 'number' && n < s.minimum) {
      fail('minimum')
    }

    if (typeof s.maximum === 'number' && n > s.maximum) {
      fail('maximum')
    }

    if (typeof s.exclusiveMinimum === 'number' && n <= s.exclusiveMinimum) {
      fail('exclusiveMinimum')
    }

    if (typeof s.exclusiveMaximum === 'number' && n >= s.exclusiveMaximum) {
      fail('exclusiveMaximum')
    }

    if (typeof s.multipleOf === 'number' && !Number.isInteger(n / s.multipleOf)) {
      fail('multipleOf')
    }
  }

  if (t === 'string') {
    const len = [...(value as string)].length

    if (typeof s.minLength === 'number' && len < s.minLength) {
      fail('minLength')
    }

    if (typeof s.maxLength === 'number' && len > s.maxLength) {
      fail('maxLength')
    }

    if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(value as string)) {
      fail('pattern')
    }
  }

  if (t === 'array') {
    const arr = value as unknown[]
    const prefix = list(s.prefixItems)
    prefix.forEach((x, i) => i < arr.length && errs.push(...validate(arr[i], x, schemas, `${at}/${i}`)))

    if (s.items !== undefined) {
      arr
        .slice(prefix.length)
        .forEach((v, i) => errs.push(...validate(v, s.items as Schema, schemas, `${at}/${i + prefix.length}`)))
    }

    if (typeof s.minItems === 'number' && arr.length < s.minItems) {
      fail('minItems')
    }

    if (typeof s.maxItems === 'number' && arr.length > s.maxItems) {
      fail('maxItems')
    }

    if (s.uniqueItems === true && new Set(arr.map(v => JSON.stringify(v))).size !== arr.length) {
      fail('uniqueItems')
    }

    if ('contains' in s && !arr.some(v => ok(s.contains as Schema, v))) {
      fail('contains')
    }
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
    const props = isNode(s.properties) ? (s.properties as Record<string, Schema>) : {}
    const patterns = isNode(s.patternProperties) ? Object.entries(s.patternProperties as Record<string, Schema>) : []

    for (const r of Array.isArray(s.required) ? (s.required as string[]) : []) {
      if (!(r in obj)) {
        fail(`required ${r}`)
      }
    }

    for (const k of keys) {
      const path = `${at}/${k}`
      let matched = k in props

      if (matched) {
        errs.push(...validate(obj[k], props[k], schemas, path))
      }

      for (const [rx, x] of patterns) {
        if (new RegExp(rx, 'u').test(k)) {
          matched = true
          errs.push(...validate(obj[k], x, schemas, path))
        }
      }

      if (!matched && s.additionalProperties !== undefined) {
        errs.push(
          ...validate(obj[k], s.additionalProperties as Schema, schemas, path).map(e => `${e} (additionalProperties)`)
        )
      }

      if ('propertyNames' in s && !ok(s.propertyNames as Schema, k)) {
        fail(`propertyNames ${k}`)
      }
    }

    if (typeof s.minProperties === 'number' && keys.length < s.minProperties) {
      fail('minProperties')
    }

    if (typeof s.maxProperties === 'number' && keys.length > s.maxProperties) {
      fail('maxProperties')
    }

    if (isNode(s.dependentRequired)) {
      for (const [k, deps] of Object.entries(s.dependentRequired as Record<string, string[]>)) {
        if (k in obj) {
          for (const d of deps) {
            if (!(d in obj)) {
              fail(`dependentRequired ${k}->${d}`)
            }
          }
        }
      }
    }
  }

  return errs
}
