import { describe, expect, it } from 'vitest'

import { validateArgv } from '../../../../../electron/iclone-acp'

import { type OwnOffering, schemaModel, shapeOwnOffering } from './market-data'
import {
  checkOffering,
  checkResource,
  draftFromOffering,
  emptyOfferingDraft,
  emptyResourceDraft,
  httpsUrlArg,
  offeringCreateArgv,
  offeringDeleteArgv,
  type OfferingDraft,
  offeringLimitProblem,
  offeringUpdateArgv,
  offeringValuesOf,
  priceInputOf,
  priceValueArg,
  resourceCreateArgv,
  slaArg
} from './market-editor'
import {
  emptySchemaDraft,
  fieldsFromSchema,
  jsonSchemaProblem,
  newField,
  sameSchema,
  schemaDraftFrom,
  schemaFromFields,
  schemaValue,
  switchSchemaMode
} from './market-schema'

const REQUIREMENTS = {
  type: 'object',
  properties: {
    ticker: { type: 'string', description: 'Token ticker' },
    days: { type: 'number' }
  },
  required: ['ticker']
}

function saved(patch: Record<string, unknown> = {}): OwnOffering {
  return shapeOwnOffering({
    id: 'off-1',
    agentId: '1042',
    name: 'Crypto news report',
    description: 'A daily digest.',
    requirements: REQUIREMENTS,
    deliverable: 'A markdown report',
    slaMinutes: 30,
    priceType: 'fixed',
    priceValue: 0.01,
    requiredFunds: false,
    isHidden: false,
    subscriptions: [{ id: 'sub-1', name: 'Pro', price: 50, duration: 2_592_000 }],
    ...patch
  })
}

function filled(patch: Partial<OfferingDraft> = {}): OfferingDraft {
  return {
    ...emptyOfferingDraft(),
    name: '  Token   report ',
    description: 'A daily digest of one token.\nWith sources.',
    price: '0.5',
    slaMinutes: '30',
    requirements: {
      ...emptySchemaDraft('fields', 0),
      fields: [newField({ name: 'ticker', description: 'Token ticker' }), newField()]
    },
    deliverable: { ...emptySchemaDraft('text'), text: 'A markdown report' },
    ...patch
  }
}

describe('the schema builder', () => {
  it('writes a JSON schema from its rows — blanks ignored, lists of text, required only when set', () => {
    expect(
      schemaFromFields([
        newField({ name: 'ticker', description: ' Token ticker ' }),
        newField({ name: 'tags', type: 'array', required: false }),
        newField({ name: 'live', type: 'boolean', required: false }),
        newField()
      ])
    ).toEqual({
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Token ticker' },
        tags: { type: 'array', items: { type: 'string' } },
        live: { type: 'boolean' }
      },
      required: ['ticker']
    })
    expect(schemaFromFields([])).toEqual({ type: 'object', properties: {} })
  })

  it('reads back only the schemas it could have written', () => {
    const rows = fieldsFromSchema(REQUIREMENTS)

    expect(rows?.map(({ name, type, required, description }) => ({ name, type, required, description }))).toEqual([
      { name: 'ticker', type: 'string', required: true, description: 'Token ticker' },
      { name: 'days', type: 'number', required: false, description: '' }
    ])
    expect(fieldsFromSchema(schemaFromFields(rows ?? []))).toHaveLength(2)

    for (const richer of [
      { type: 'object', properties: { n: { type: 'integer' } } },
      { type: 'object', properties: { tf: { type: 'string', enum: ['1h'] } } },
      { type: 'object', properties: { o: { type: 'object', properties: {} } } },
      { type: 'object', properties: {}, additionalProperties: false },
      { type: 'array' },
      'text'
    ]) {
      expect(fieldsFromSchema(richer)).toBeNull()
    }
  })

  it('opens a saved schema in the right mode, and falls back to the model when the source is lost', () => {
    expect(schemaDraftFrom(JSON.stringify(REQUIREMENTS), schemaModel(REQUIREMENTS), 'fields').mode).toBe('fields')

    const rich = { type: 'object', properties: { tf: { type: 'string', enum: ['1h', '4h'] } } }

    expect(schemaDraftFrom(JSON.stringify(rich), schemaModel(rich), 'fields')).toMatchObject({
      mode: 'json',
      json: JSON.stringify(rich, null, 2)
    })
    expect(schemaDraftFrom('A markdown report', schemaModel('A markdown report'), 'text')).toMatchObject({
      mode: 'text',
      text: 'A markdown report'
    })

    const lost = schemaDraftFrom('', schemaModel(REQUIREMENTS), 'text')

    expect(lost.mode).toBe('fields')
    expect(lost.fields.map(field => field.name)).toEqual(['ticker', 'days'])
  })

  it('carries a schema across modes only when nothing is lost', () => {
    const rows = { ...emptySchemaDraft('fields', 0), fields: [newField({ name: 'ticker' })] }
    const asJson = switchSchemaMode(rows, 'json')

    expect(JSON.parse(asJson.json)).toEqual({
      type: 'object',
      properties: { ticker: { type: 'string' } },
      required: ['ticker']
    })

    const edited = { ...asJson, json: JSON.stringify({ ...REQUIREMENTS }) }

    expect(switchSchemaMode(edited, 'fields').fields.map(field => field.name)).toEqual(['ticker', 'days'])

    // JSON the builder cannot express is never overwritten by the rows.
    const rich = { ...asJson, json: '{"type":"object","properties":{"n":{"type":"integer"}}}' }
    const back = switchSchemaMode(switchSchemaMode(rich, 'fields'), 'json')

    expect(back.json).toBe(rich.json)
  })
})

describe('schema values', () => {
  it('sends text as text, and refuses prose that is really JSON', () => {
    const text = (value: string) => schemaValue({ ...emptySchemaDraft('text'), text: value }, 'requirements')

    expect(text('  The ticker, please. ')).toEqual({ ok: true, value: 'The ticker, please.' })
    expect(text('   ')).toMatchObject({ ok: false })
    expect(text('{"type":"object"}')).toMatchObject({ ok: false, error: expect.stringContaining('JSON schema') })
  })

  it('names what is wrong with the rows', () => {
    const rows = (...fields: ReturnType<typeof newField>[]) =>
      schemaValue({ ...emptySchemaDraft('fields', 0), fields }, 'requirements')

    expect(rows()).toMatchObject({ ok: false })
    expect(rows(newField({ description: 'no name' }))).toMatchObject({ ok: false, error: 'Name every field.' })
    expect(rows(newField({ name: '2fast' }))).toMatchObject({ ok: false, error: expect.stringContaining('2fast') })
    expect(rows(newField({ name: 'a' }), newField({ name: 'a' }))).toMatchObject({
      ok: false,
      error: 'Two fields are named “a”.'
    })
    expect(rows(newField({ name: 'ticker' }))).toEqual({
      ok: true,
      value: '{"type":"object","properties":{"ticker":{"type":"string"}},"required":["ticker"]}'
    })
    // Params may take nothing at all.
    expect(schemaValue(emptySchemaDraft('fields', 0), 'params', true)).toEqual({ ok: true, value: '{}' })
  })

  it('checks raw JSON the way a person gets it wrong, and sends it compact', () => {
    const json = (value: string) => schemaValue({ ...emptySchemaDraft('json'), json: value }, 'requirements')

    expect(json('{"type": "object",}')).toMatchObject({ ok: false, error: expect.stringContaining('Not valid JSON') })
    expect(json('[1, 2]')).toMatchObject({ ok: false, error: expect.stringContaining('must be a JSON object') })
    expect(json('{"type": "text"}')).toMatchObject({ ok: false, error: expect.stringContaining('unknown "type"') })
    expect(json('{"properties": {"t": {"type": "string", "example": "BTC"}}}')).toMatchObject({
      ok: false,
      error: expect.stringContaining('"examples"')
    })
    expect(json('{"required": "ticker"}')).toMatchObject({ ok: false })
    expect(json('{\n  "type": "object",\n  "properties": {}\n}')).toEqual({
      ok: true,
      value: '{"type":"object","properties":{}}'
    })
    expect(jsonSchemaProblem({ type: ['string', 'null'], enum: ['a', null] })).toBeNull()
    expect(jsonSchemaProblem({ items: { type: 'nope' } })).toContain('items')
  })

  it('treats key order as no change', () => {
    expect(sameSchema('{"a":1,"b":{"c":2}}', '{"b":{"c":2},"a":1}')).toBe(true)
    expect(sameSchema('{"a":1}', '{"a":2}')).toBe(false)
    expect(sameSchema(' prose ', 'prose')).toBe(true)
  })
})

describe('prices and SLAs', () => {
  it('takes USDC above 0 in the bridge’s decimal shape', () => {
    expect(priceValueArg('fixed', ' 0.5 ')).toEqual({ ok: true, value: '0.5' })
    expect(priceValueArg('fixed', '0')).toMatchObject({ ok: false })
    expect(priceValueArg('fixed', '-1')).toMatchObject({ ok: false })
    expect(priceValueArg('fixed', '0,5')).toMatchObject({ ok: false })
    expect(priceValueArg('fixed', '0.0000001')).toMatchObject({ ok: false })
    expect(priceValueArg('fixed', '')).toMatchObject({ ok: false })
  })

  it('sends a share as the whole percent the service lists (20 = 20 %), and back', () => {
    expect(priceValueArg('percentage', '5')).toEqual({ ok: true, value: '5' })
    expect(priceValueArg('percentage', '12.5')).toEqual({ ok: true, value: '12.5' })
    expect(priceValueArg('percentage', '0.0001')).toEqual({ ok: true, value: '0.0001' })
    expect(priceValueArg('percentage', '100')).toEqual({ ok: true, value: '100' })
    expect(priceValueArg('percentage', '101')).toMatchObject({ ok: false })
    expect(priceValueArg('percentage', '0')).toMatchObject({ ok: false })
    expect(priceInputOf({ priceType: 'percentage', priceValue: 12.5 })).toBe('12.5')
    expect(priceInputOf({ priceType: 'percentage', priceValue: 20 })).toBe('20')
    expect(priceInputOf({ priceType: 'fixed', priceValue: 0.01 })).toBe('0.01')
    expect(priceInputOf({ priceType: 'fixed', priceValue: null })).toBe('')
  })

  it('holds the SLA between 5 minutes and a year', () => {
    expect(slaArg('5')).toEqual({ ok: true, value: '5' })
    expect(slaArg('4')).toMatchObject({ ok: false })
    expect(slaArg('525600')).toEqual({ ok: true, value: '525600' })
    expect(slaArg('525601')).toMatchObject({ ok: false })
    expect(slaArg('1.5')).toMatchObject({ ok: false })
  })
})

describe('offering writes — the exact argv the bridge admits', () => {
  it('creates with every flag the CLI would otherwise prompt for', () => {
    const { values, errors } = checkOffering(filled({ requiredFunds: true, subscriptionIds: ['sub-1', 'sub-2'] }))

    expect(errors).toEqual({})

    const argv = offeringCreateArgv(values!)

    expect(argv).toEqual([
      'offering',
      'create',
      '--name',
      'Token report',
      '--description',
      'A daily digest of one token.\nWith sources.',
      '--price-type',
      'fixed',
      '--price-value',
      '0.5',
      '--sla-minutes',
      '30',
      '--requirements',
      '{"type":"object","properties":{"ticker":{"type":"string","description":"Token ticker"}},"required":["ticker"]}',
      '--deliverable',
      'A markdown report',
      '--required-funds',
      '--no-hidden',
      '--subscription-ids',
      'sub-1,sub-2',
      '--json'
    ])
    expect(validateArgv(argv)).toEqual(argv)
    expect(validateArgv(offeringCreateArgv({ ...values!, subscriptionIds: [], hidden: true }))).not.toBeNull()
  })

  it('names every field a draft is missing, and sends nothing', () => {
    const { values, errors } = checkOffering(emptyOfferingDraft())

    expect(values).toBeNull()
    expect(Object.keys(errors).sort()).toEqual(['deliverable', 'description', 'name', 'price', 'requirements'])
  })

  it('refuses the 41st offering before any CLI runs', () => {
    expect(offeringLimitProblem(39)).toBeNull()
    expect(offeringLimitProblem(40)).toContain('40 offerings per agent')
    expect(offeringLimitProblem(null)).toContain('still being read')
  })

  it('updates only what changed — nothing when nothing did', () => {
    const offering = saved()
    const before = offeringValuesOf(offering)
    const draft = draftFromOffering(offering)

    expect(draft).toMatchObject({ price: '0.01', slaMinutes: '30', subscriptionIds: ['sub-1'] })
    expect(draft.requirements.mode).toBe('fields')
    expect(offeringUpdateArgv('off-1', checkOffering(draft).values!, before)).toEqual({ ok: true, value: null })

    const argv = offeringUpdateArgv('off-1', checkOffering({ ...draft, price: '0.02', hidden: true }).values!, before)

    expect(argv).toEqual({
      ok: true,
      value: ['offering', 'update', '--offering-id', 'off-1', '--price-value', '0.02', '--hidden', '--json']
    })
    expect(validateArgv(argv.ok ? argv.value : null)).not.toBeNull()
  })

  it('sends the price type and value together, and a changed schema whole', () => {
    const offering = saved()
    const draft = draftFromOffering(offering)

    const next = checkOffering({
      ...draft,
      priceType: 'percentage',
      price: '5',
      requirements: { ...draft.requirements, fields: [...draft.requirements.fields, newField({ name: 'notes' })] }
    }).values!

    const update = offeringUpdateArgv('off-1', next, offeringValuesOf(offering))
    const argv = update.ok ? update.value : null

    expect(argv).toEqual([
      'offering',
      'update',
      '--offering-id',
      'off-1',
      '--price-type',
      'percentage',
      '--price-value',
      '5',
      '--requirements',
      next.requirements,
      '--json'
    ])
    expect(validateArgv(argv)).toEqual(argv)
  })

  it('refuses what the bridge cannot carry: clearing every package, an id it would not admit', () => {
    const offering = saved()
    const values = checkOffering({ ...draftFromOffering(offering), subscriptionIds: [] }).values!

    expect(offeringUpdateArgv('off-1', values, offeringValuesOf(offering))).toMatchObject({ ok: false })
    expect(offeringUpdateArgv('a b', values, values)).toMatchObject({ ok: false })
  })

  it('deletes with --force — the confirmation happened in the app', () => {
    const argv = offeringDeleteArgv('off-1')

    expect(argv).toEqual(['offering', 'delete', '--offering-id', 'off-1', '--force', '--json'])
    expect(validateArgv(argv)).toEqual(argv)
    expect(offeringDeleteArgv('off 1; rm -rf ~')).toBeNull()
    expect(offeringDeleteArgv('')).toBeNull()
  })
})

describe('resource writes', () => {
  it('takes https only, with no credentials and no spaces', () => {
    expect(httpsUrlArg(' https://api.example.com/v1/price?symbol=BTC ')).toEqual({
      ok: true,
      value: 'https://api.example.com/v1/price?symbol=BTC'
    })

    for (const bad of [
      '',
      'http://api.example.com',
      'HTTPS://api.example.com',
      'https://user:pass@api.example.com',
      'https://api.example.com/a b',
      'javascript:alert(1)',
      `https://example.com/${'x'.repeat(500)}`
    ]) {
      expect(httpsUrlArg(bad)).toMatchObject({ ok: false })
    }
  })

  it('creates with every flag the CLI would otherwise prompt for — params {} when none', () => {
    const { values, errors } = checkResource({
      ...emptyResourceDraft(),
      name: 'Price feed',
      description: 'Live prices.',
      url: 'https://api.example.com/price'
    })

    expect(errors).toEqual({})

    const argv = resourceCreateArgv(values!)

    expect(argv).toEqual([
      'resource',
      'create',
      '--name',
      'Price feed',
      '--description',
      'Live prices.',
      '--url',
      'https://api.example.com/price',
      '--params',
      '{}',
      '--no-hidden',
      '--json'
    ])
    expect(validateArgv(argv)).toEqual(argv)
    expect(checkResource({ ...emptyResourceDraft(), params: emptySchemaDraft('text') }).errors.params).toContain(
      'JSON schema'
    )
  })
})
