/** The market data module's `schemas` section — its public names are re-exported by ../market-data.ts. */
import { asArray, asRecord, bool, isString, type Json, str } from '../../cli'

import { displayValue, finiteOrNull, records } from './primitives'
import type { SchemaField, SchemaModel } from './types'

// ── requirements / deliverable schemas ─────────────────────────────────────

const TYPE_WORDS = new Map([
  ['string', 'text'],
  ['number', 'number'],
  ['integer', 'whole number'],
  ['boolean', 'yes / no'],
  ['object', 'object'],
  ['array', 'list'],
  ['null', 'empty']
])

const FORMAT_WORDS = new Map([
  ['uri', 'URL'],
  ['url', 'URL'],
  ['email', 'email'],
  ['date-time', 'date & time'],
  ['date', 'date'],
  ['time', 'time'],
  ['uuid', 'UUID']
])

function typeList(spec: Json): string[] {
  const raw = spec.type

  return (Array.isArray(raw) ? raw : [raw]).filter(isString)
}

function typeOf(spec: Json): string {
  const types = typeList(spec)

  if (types.length === 0) {
    return asArray(spec.enum).length > 0 ? 'enum' : ''
  }

  return types
    .map(type => (type === 'array' ? `array<${typeOf(asRecord(spec.items) ?? {}) || 'any'}>` : type))
    .join(' | ')
}

function labelOf(spec: Json): string {
  if (asArray(spec.enum).length > 0) {
    return 'choice'
  }

  const format = FORMAT_WORDS.get(str(spec, 'format'))

  if (format) {
    return format
  }

  const types = typeList(spec).filter(type => type !== 'null')

  if (types.length === 0) {
    return 'any value'
  }

  return types
    .map(type =>
      type === 'array'
        ? `list of ${labelOf(asRecord(spec.items) ?? {}).replace(/^any value$/, 'values')}`
        : (TYPE_WORDS.get(type) ?? type)
    )
    .join(' or ')
}

function constraintsOf(spec: Json): string[] {
  const facts: Array<[string, (value: number) => string]> = [
    ['minimum', value => `min ${value}`],
    ['maximum', value => `max ${value}`],
    ['minLength', value => `at least ${value} characters`],
    ['maxLength', value => `up to ${value} characters`],
    ['minItems', value => `at least ${value} items`],
    ['maxItems', value => `up to ${value} items`]
  ]

  return facts.flatMap(([key, say]) => {
    const value = finiteOrNull(spec[key])

    return value == null ? [] : [say(value)]
  })
}

function exampleOf(spec: Json): string {
  const example = asArray(spec.examples)[0] ?? spec.example

  return example === undefined ? '' : displayValue(example)
}

const BLANK_FIELD: Omit<SchemaField, 'name' | 'required'> = {
  type: '',
  label: 'text',
  description: '',
  enumValues: [],
  example: '',
  hasDefault: false,
  defaultValue: undefined,
  constraints: []
}

function fieldOf(name: string, spec: unknown, required: boolean): SchemaField {
  if (typeof spec === 'string') {
    const word = TYPE_WORDS.get(spec)

    return word
      ? { ...BLANK_FIELD, name, required, type: spec, label: word }
      : { ...BLANK_FIELD, name, required, type: 'string', description: spec }
  }

  const record = asRecord(spec) ?? {}
  const hasDefault = Object.hasOwn(record, 'default')

  return {
    name,
    required: required || record.required === true,
    type: typeOf(record),
    label: labelOf(record),
    description: str(record, 'description') || str(record, 'title'),
    enumValues: asArray(record.enum).map(displayValue),
    example: exampleOf(record),
    hasDefault,
    defaultValue: hasDefault ? record.default : undefined,
    constraints: constraintsOf(record)
  }
}

export function fieldsModel(fields: SchemaField[]): SchemaModel {
  return fields.length > 0 ? { kind: 'fields', fields } : { kind: 'none' }
}

function objectModel(record: Json): SchemaModel {
  const properties = asRecord(record.properties)

  if (properties) {
    const required = new Set(asArray(record.required).filter(isString))

    return fieldsModel(Object.entries(properties).map(([name, spec]) => fieldOf(name, spec, required.has(name))))
  }

  // A bare schema (`{ type: "string", description }`) asks for one free value.
  if (typeList(record).length > 0) {
    const text = str(record, 'description') || str(record, 'title')

    return text ? { kind: 'text', text } : { kind: 'none' }
  }

  // A loose map (`{ ticker: "string", notes: { type: "string" } }`): every key
  // is something the provider asked for.
  return fieldsModel(Object.entries(record).map(([name, spec]) => fieldOf(name, spec, true)))
}

/** Tool-style parameter lists: `[{ name, type, description, required }]`. */
function listModel(items: Json[]): SchemaModel {
  return fieldsModel(
    items.filter(item => str(item, 'name')).map(item => fieldOf(str(item, 'name'), item, bool(item, 'required')))
  )
}

/** An offering's `requirements` / `deliverable` — a JSON schema object, the
 *  same schema as a JSON string, or plain prose — as one model the UI renders
 *  as a form preview. */
export function schemaModel(value: unknown): SchemaModel {
  if (typeof value === 'string') {
    const text = value.trim()

    if (!text) {
      return { kind: 'none' }
    }

    if (/^[[{"]/.test(text)) {
      try {
        const parsed: unknown = JSON.parse(text)

        if (typeof parsed !== 'string') {
          return schemaModel(parsed)
        }

        return parsed.trim() ? { kind: 'text', text: parsed.trim() } : { kind: 'none' }
      } catch {
        // Prose that happens to start with a bracket.
      }
    }

    return { kind: 'text', text }
  }

  if (Array.isArray(value)) {
    return listModel(records(value))
  }

  const record = asRecord(value)

  return record ? objectModel(record) : { kind: 'none' }
}

/** What the preview's empty input shows: the default, an example, or the type. */
export function fieldPlaceholder(field: SchemaField): string {
  const head = field.hasDefault
    ? `default: ${displayValue(field.defaultValue)}`
    : field.example
      ? `e.g. ${field.example}`
      : field.label

  return [head, ...field.constraints].join(' · ')
}
