/**
 * EconomyOS — Market · a listing's requirement and deliverable schemas: the
 * field builder, the three ways to write one, and the checks each passes
 * before it is sent.
 */
import { asRecord, isString, type Json } from '../cli'

import { type SchemaField, type SchemaModel } from './market-data'

const SCHEMA_MAX = 20_000
const FIELD_DESCRIPTION_MAX = 500
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
export type SchemaMode = 'fields' | 'json' | 'text'
export type FieldType = 'array' | 'boolean' | 'number' | 'string'

export const FIELD_TYPES: readonly FieldType[] = ['string', 'number', 'boolean', 'array']

/** One row of the schema builder; `key` is the row's identity in the list. */
export interface BuilderField {
  key: string
  name: string
  type: FieldType
  required: boolean
  description: string
}

/** A schema being written. Each mode keeps its own text, so switching back
 *  and forth never loses what the owner wrote. */
export interface SchemaDraft {
  mode: SchemaMode
  text: string
  fields: BuilderField[]
  json: string
}

export type Checked<T> = { error: string; ok: false } | { ok: true; value: T }

export function ok<T>(value: T): Checked<T> {
  return { ok: true, value }
}

export function fail<T>(error: string): Checked<T> {
  return { ok: false, error }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ── the schema builder ──────────────────────────────────────────────────────

let fieldSeq = 0

export function newField(patch: Partial<Omit<BuilderField, 'key'>> = {}): BuilderField {
  fieldSeq += 1

  return { key: `field-${fieldSeq}`, name: '', type: 'string', required: true, description: '', ...patch }
}

export function emptySchemaDraft(mode: SchemaMode, rows = mode === 'fields' ? 1 : 0): SchemaDraft {
  return { mode, text: '', fields: Array.from({ length: rows }, () => newField()), json: '' }
}

/** A row the owner started: a blank one at the end is not a field yet. */
function isStarted(field: BuilderField): boolean {
  return Boolean(field.name.trim() || field.description.trim())
}

function propertyOf(field: BuilderField): Json {
  const property: Json = field.type === 'array' ? { type: 'array', items: { type: 'string' } } : { type: field.type }
  const description = field.description.trim()

  return description ? { ...property, description } : property
}

/** The builder's rows as the JSON schema ACP validates a buyer's input against. */
export function schemaFromFields(fields: readonly BuilderField[]): Json {
  const named = fields.filter(field => field.name.trim())
  const required = named.filter(field => field.required).map(field => field.name.trim())

  return {
    type: 'object',
    properties: Object.fromEntries(named.map(field => [field.name.trim(), propertyOf(field)])),
    ...(required.length > 0 ? { required } : {})
  }
}

function onlyKeys(record: Json, allowed: readonly string[]): boolean {
  return Object.keys(record).every(key => allowed.includes(key))
}

function builderFieldOf(name: string, spec: unknown, required: boolean): BuilderField | null {
  const record = asRecord(spec)
  const type = FIELD_TYPES.find(item => item === record?.type)

  if (!record || !type || !FIELD_NAME.test(name)) {
    return null
  }

  if (record.description !== undefined && !isString(record.description)) {
    return null
  }

  if (type === 'array') {
    const items = asRecord(record.items)

    if (record.items !== undefined && !(items && onlyKeys(items, ['type']) && items.type === 'string')) {
      return null
    }
  }

  if (!onlyKeys(record, type === 'array' ? ['type', 'description', 'items'] : ['type', 'description'])) {
    return null
  }

  return newField({ name, type, required, description: isString(record.description) ? record.description : '' })
}

/** Builder rows for a schema the builder could have written — flat, one plain
 *  type per field — else null, and the schema opens as JSON instead. */
export function fieldsFromSchema(value: unknown): BuilderField[] | null {
  const root = asRecord(value)

  if (!root || root.type !== 'object' || !onlyKeys(root, ['type', 'properties', 'required'])) {
    return null
  }

  const properties = root.properties === undefined ? {} : asRecord(root.properties)
  const required = root.required === undefined ? [] : root.required

  if (!properties || !Array.isArray(required) || !required.every(isString)) {
    return null
  }

  const fields = Object.entries(properties).map(([name, spec]) => builderFieldOf(name, spec, required.includes(name)))

  return fields.every((field): field is BuilderField => field !== null) ? fields : null
}

function builderTypeOf(field: SchemaField): FieldType {
  if (field.type.startsWith('array')) {
    return 'array'
  }

  if (field.type === 'number' || field.type === 'integer') {
    return 'number'
  }

  return field.type === 'boolean' ? 'boolean' : 'string'
}

/**
 * A saved schema, opened for editing: a flat schema in the builder, any other
 * schema as JSON, prose as text. An empty `source` (a snapshot written before
 * sources were kept) falls back to what the schema model still knows.
 */
export function schemaDraftFrom(source: string, model: SchemaModel, fallback: SchemaMode): SchemaDraft {
  const text = source.trim()
  const parsed = text ? parseJson(text) : undefined
  const record = asRecord(parsed)

  if (record) {
    const fields = fieldsFromSchema(record)
    const json = JSON.stringify(record, null, 2)

    return fields && fields.length > 0
      ? { mode: 'fields', text: '', fields, json }
      : { mode: 'json', text: '', fields: [], json }
  }

  if (text) {
    return { mode: 'text', text: isString(parsed) ? parsed : text, fields: [], json: '' }
  }

  if (model.kind === 'text') {
    return { mode: 'text', text: model.text, fields: [], json: '' }
  }

  if (model.kind === 'fields') {
    const fields = model.fields.map(field =>
      newField({
        name: field.name,
        type: builderTypeOf(field),
        required: field.required,
        description: field.description
      })
    )

    return { mode: 'fields', text: '', fields, json: '' }
  }

  return emptySchemaDraft(fallback)
}

/**
 * Change the editing mode, carrying the schema over when nothing is lost:
 * the builder's rows become the JSON when that JSON held nothing more than
 * rows can say, and JSON the builder can express becomes its rows.
 */
export function switchSchemaMode(draft: SchemaDraft, mode: SchemaMode): SchemaDraft {
  if (mode === draft.mode) {
    return draft
  }

  if (draft.mode === 'fields' && mode === 'json') {
    const started = draft.fields.filter(isStarted)
    const current = draft.json.trim()
    const plain = !current || fieldsFromSchema(parseJson(current)) !== null

    return started.length > 0 && plain
      ? { ...draft, mode, json: JSON.stringify(schemaFromFields(started), null, 2) }
      : { ...draft, mode }
  }

  if (draft.mode === 'json' && mode === 'fields') {
    const fields = fieldsFromSchema(parseJson(draft.json.trim()))

    return fields && fields.length > 0 ? { ...draft, mode, fields } : { ...draft, mode }
  }

  return { ...draft, mode }
}

// ── schema validation ───────────────────────────────────────────────────────

const JSON_TYPES = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string'])

/**
 * The mistakes worth catching before the CLI does. The CLI compiles the
 * schema with Ajv in strict mode and stays the final judge; these are the
 * ones a person makes by hand, said in words instead of an Ajv trace.
 */
export function jsonSchemaProblem(value: unknown, at = 'The schema'): null | string {
  const node = asRecord(value)

  if (!node) {
    return `${at} must be a JSON object — like {"type": "object", "properties": {…}}.`
  }

  if (Object.hasOwn(node, 'example')) {
    return `${at} uses "example" — ACP checks schemas strictly; write "examples": [ … ] instead.`
  }

  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type : [node.type]

    if (types.length === 0 || !types.every(type => isString(type) && JSON_TYPES.has(type))) {
      return `${at} has an unknown "type" — use string, number, integer, boolean, array, object or null.`
    }
  }

  if (node.required !== undefined && !(Array.isArray(node.required) && node.required.every(isString))) {
    return `${at}: "required" must be a list of field names.`
  }

  if (node.enum !== undefined && !(Array.isArray(node.enum) && node.enum.length > 0)) {
    return `${at}: "enum" must be a non-empty list.`
  }

  if (node.properties !== undefined) {
    const properties = asRecord(node.properties)

    if (!properties) {
      return `${at}: "properties" must be an object.`
    }

    for (const [name, spec] of Object.entries(properties)) {
      const problem = typeof spec === 'boolean' ? null : jsonSchemaProblem(spec, `Field “${name}”`)

      if (problem) {
        return problem
      }
    }
  }

  if (node.items !== undefined && typeof node.items !== 'boolean' && !Array.isArray(node.items)) {
    return jsonSchemaProblem(node.items, `${at} → items`)
  }

  return null
}

function withinSchemaCap(text: string): Checked<string> {
  return text.length <= SCHEMA_MAX ? ok(text) : fail(`Keep it under ${SCHEMA_MAX.toLocaleString('en-US')} characters.`)
}

function fieldsValue(fields: readonly BuilderField[], allowEmpty: boolean): Checked<string> {
  const rows = fields.filter(isStarted)

  if (rows.length === 0) {
    return allowEmpty ? ok('{}') : fail('Add at least one field, or describe it in plain text.')
  }

  const names = rows.map(field => field.name.trim())
  const bad = names.find(name => !FIELD_NAME.test(name))

  if (bad !== undefined) {
    return fail(
      bad ? `“${bad}” can’t be a field name — start with a letter, then letters, digits, _ or -.` : 'Name every field.'
    )
  }

  const twice = names.find((name, index) => names.indexOf(name) !== index)

  if (twice) {
    return fail(`Two fields are named “${twice}”.`)
  }

  if (rows.some(field => field.description.trim().length > FIELD_DESCRIPTION_MAX)) {
    return fail(`Keep each field’s description under ${FIELD_DESCRIPTION_MAX} characters.`)
  }

  return withinSchemaCap(JSON.stringify(schemaFromFields(rows)))
}

function jsonValue(text: string, allowEmpty: boolean): Checked<string> {
  const trimmed = text.trim()

  if (!trimmed) {
    return allowEmpty ? ok('{}') : fail('Paste a JSON schema, or switch to fields or plain text.')
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    return fail(`Not valid JSON — ${error instanceof SyntaxError ? error.message : 'check the brackets and quotes'}.`)
  }

  const problem = jsonSchemaProblem(parsed)

  return problem ? fail(problem) : withinSchemaCap(JSON.stringify(parsed))
}

function textValue(text: string, noun: string): Checked<string> {
  const trimmed = text.replace(/\0/g, '').trim()

  if (!trimmed) {
    return fail(`Describe the ${noun}, or switch to fields.`)
  }

  // The CLI reads any JSON object as a schema — prose must not look like one.
  if (asRecord(parseJson(trimmed))) {
    return fail('This is JSON — switch to “JSON schema” so ACP validates it as one.')
  }

  return withinSchemaCap(trimmed)
}

/** A schema draft as the one argv word the CLI takes: compact JSON or text. */
export function schemaValue(draft: SchemaDraft, noun: string, allowEmpty = false): Checked<string> {
  switch (draft.mode) {
    case 'fields':
      return fieldsValue(draft.fields, allowEmpty)

    case 'json':
      return jsonValue(draft.json, allowEmpty)

    default:
      return textValue(draft.text, noun)
  }
}

/** Two schemas (or texts) that say the same — key order is not a change. */
export function sameSchema(a: string, b: string): boolean {
  const left = parseJson(a)
  const right = parseJson(b)

  if (asRecord(left) && asRecord(right)) {
    return canonical(left) === canonical(right)
  }

  return a.trim() === b.trim()
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }

  const record = asRecord(value)

  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`
  }

  return JSON.stringify(value) ?? 'null'
}
