// One fixture test per §3.4 rule id (RESUME/contracts/P4_upstream.md). fixtures/lock.json against fixtures/spec.json
// is GREEN with zero findings; each test changes one fact and asserts exactly the rule that fact must raise.
import fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import { type Finding, verify } from './verify'

type Doc = Record<string, any>

// Read from disk, not imported: the composite electron tsconfig only compiles files its include lists.
const load = (name: string): Doc => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

const fresh = (): { lock: Doc; spec: Doc } => ({ lock: load('lock.json'), spec: load('spec.json') })

const target = (spec: Doc, patch: Doc): Doc => ({ ...structuredClone(spec), rev: '2'.repeat(40), ...patch })

const hits = (v: { findings: Finding[] }, rule: string) =>
  v.findings.filter(f => f.rule === rule).map(f => `${f.level} ${f.name}`)

const rules = (v: { findings: Finding[] }) => [...new Set(v.findings.map(f => f.rule))].sort()

describe('fixtures', () => {
  it('the base lock against the base spec is GREEN with no findings', () => {
    const { lock, spec } = fresh()
    const v = verify(lock, [spec])

    expect(v.findings).toEqual([])
    expect(v.level).toBe('GREEN')
    expect(v.perSpec).toEqual([expect.objectContaining({ rev: spec.rev, level: 'GREEN' })])
  })

  it('folds x.respond + the x.request event + server request x into one card', () => {
    const { lock, spec } = fresh()
    delete spec.methods['clarify.respond']
    delete spec.notifications['clarify.request']
    spec.serverRequests.clarify = { params: 'ClarifyRequestPayload', result: 'OkResult' }
    const v = verify(lock, [spec])

    expect(v.cards).toEqual([
      expect.objectContaining({
        root: 'server-requests',
        level: 'RED',
        items: 3,
        names: ['clarify'],
        rules: ['E-GONE', 'M-GONE', 'SR-UNHANDLED']
      })
    ])
  })
})

describe('RED rules', () => {
  it('M-GONE: a locked method the provider no longer serves', () => {
    const { lock, spec } = fresh()
    delete spec.methods['clarify.respond']
    const v = verify(lock, [spec])

    expect(hits(v, 'M-GONE')).toEqual(['RED clarify.respond'])
    expect(rules(v)).toEqual(['M-GONE'])
    expect(v.level).toBe('RED')
  })

  it('M-GUARDED: a guarded legacy method gone where its guard is served is INFO, not RED', () => {
    const { lock, spec } = fresh()
    lock.methods['clarify.respond'].guardedBy = 'client.capabilities'
    delete spec.methods['clarify.respond']
    spec.methods['client.capabilities'] = {}
    lock.methods['client.capabilities'] = { params: {}, resultReads: [] }
    const v = verify(lock, [spec])

    expect(hits(v, 'M-GUARDED')).toEqual(['INFO clarify.respond'])
    expect(rules(v)).toEqual(['M-GUARDED'])
    expect(v.level).not.toBe('RED')
  })

  it('M-GONE still fires for a guarded method on a runtime without the guard', () => {
    const { lock, spec } = fresh()
    lock.methods['clarify.respond'].guardedBy = 'client.capabilities'
    delete spec.methods['clarify.respond']
    delete spec.methods['client.capabilities']
    const v = verify(lock, [spec])

    expect(hits(v, 'M-GONE')).toEqual(['RED clarify.respond'])
    expect(rules(v)).toEqual(['M-GONE'])
  })

  it('P-UNKNOWN: a key we send is absent from a closed params object', () => {
    const { lock, spec } = fresh()
    lock.methods['session.create'].params.title = 'string'
    const v = verify(lock, [spec])

    expect(hits(v, 'P-UNKNOWN')).toEqual(['RED session.create#title'])
    expect(rules(v)).toEqual(['P-UNKNOWN'])
  })

  it('P-UNKNOWN stays silent when the params object allows extra keys', () => {
    const { lock, spec } = fresh()
    lock.methods['session.create'].params.title = 'string'
    delete spec.schemas.SessionCreateParams.additionalProperties
    const v = verify(lock, [spec])

    expect(hits(v, 'P-UNKNOWN')).toEqual([])
  })

  it('P-REQUIRED: the provider requires a param we never send', () => {
    const { lock, spec } = fresh()
    spec.schemas.SessionCreateParams.properties.model = { type: 'string' }
    spec.schemas.SessionCreateParams.required.push('model')
    const v = verify(lock, [spec])

    expect(hits(v, 'P-REQUIRED')).toEqual(['RED session.create#model'])
    expect(rules(v)).toEqual(['P-REQUIRED'])
  })

  it('P-TYPE: a param we send as string is now an integer', () => {
    const { lock, spec } = fresh()
    spec.schemas.SessionCreateParams.properties.cwd = { type: 'integer' }
    const v = verify(lock, [spec])

    expect(hits(v, 'P-TYPE')).toEqual(['RED session.create#cwd'])
    expect(rules(v)).toEqual(['P-TYPE'])
  })

  it('R-READ-GONE is RED when a field we read leaves a closed result', () => {
    const { lock, spec } = fresh()
    const result = spec.schemas.SessionCreateResult
    delete result.properties.info
    result.required = ['session_id']
    const v = verify(lock, [spec])

    expect(hits(v, 'R-READ-GONE')).toEqual(['RED session.create#info.status'])
    expect(rules(v)).toEqual(['R-READ-GONE'])
  })

  it('SR-UNHANDLED: a server request outside handled and declineOk', () => {
    const { lock, spec } = fresh()
    spec.serverRequests.secret = { params: 'SudoRequestParams', result: 'OkResult' }
    const v = verify(lock, [spec])

    expect(hits(v, 'SR-UNHANDLED')).toEqual(['RED secret'])
    expect(rules(v)).toEqual(['SR-UNHANDLED'])
  })

  it('REST-GONE: a route we call is no longer served (path params are positional)', () => {
    const { lock, spec } = fresh()
    spec.rest = ['GET /api/health', 'GET /api/sessions']
    const v = verify(lock, [spec])

    expect(hits(v, 'REST-GONE')).toEqual(['RED GET /api/sessions/{id}'])
    expect(rules(v)).toEqual(['REST-GONE'])
  })

  it('CLI-GONE: a serve flag we pass is gone (--help is never required)', () => {
    const { lock, spec } = fresh()
    spec.cli.serve = ['--host', '--profile']
    const v = verify(lock, [spec])

    expect(hits(v, 'CLI-GONE')).toEqual(['RED --port'])
    expect(rules(v)).toEqual(['CLI-GONE'])
  })

  it('FLAG-GONE: an environment flag we set is no longer read', () => {
    const { lock, spec } = fresh()
    spec.env = ['HERMES_HOME']
    const v = verify(lock, [spec])

    expect(hits(v, 'FLAG-GONE')).toEqual(['RED HERMES_DESKTOP'])
    expect(rules(v)).toEqual(['FLAG-GONE'])
  })

  it('DOWNGRADE: the target lowers SCHEMA_VERSION', () => {
    const { lock, spec } = fresh()
    const v = verify(lock, [spec, target(spec, { stateVersions: { db: 30, config: 50 } })])

    expect(hits(v, 'DOWNGRADE')).toEqual(['RED state'])
    expect(v.level).toBe('RED')
  })

  it('DOWNGRADE: the target is not a descendant of the installed runtime', () => {
    const { lock, spec } = fresh()
    const v = verify(lock, [spec, target(spec, {})], { isDescendant: false })

    expect(hits(v, 'DOWNGRADE')).toEqual(['RED state'])
    expect(v.runtime.isDescendant).toBe(false)
  })

  it('PROBE-UNSAFE: the probe reported an unsafe call', () => {
    const { lock, spec } = fresh()
    const v = verify(lock, [spec], { probe: { unsafe: true } })

    expect(hits(v, 'PROBE-UNSAFE')).toEqual(['RED probe'])
    expect(rules(v)).toEqual(['PROBE-UNSAFE'])
  })
})

describe('AMBER rules', () => {
  it('E-GONE: an event we subscribe to is no longer emitted', () => {
    const { lock, spec } = fresh()
    delete spec.notifications['message.delta']
    const v = verify(lock, [spec])

    expect(hits(v, 'E-GONE')).toEqual(['AMBER message.delta'])
    expect(rules(v)).toEqual(['E-GONE'])
    expect(v.level).toBe('AMBER')
  })

  it('R-READ-OPTIONAL: a top-level field we read is no longer required', () => {
    const { lock, spec } = fresh()
    spec.schemas.SessionCreateResult.required = ['info']
    const v = verify(lock, [spec])

    expect(hits(v, 'R-READ-OPTIONAL')).toEqual(['AMBER session.create#session_id'])
    expect(rules(v)).toEqual(['R-READ-OPTIONAL'])
  })

  it('R-READ-GONE is AMBER when the result allows extras', () => {
    const { lock, spec } = fresh()
    const result = spec.schemas.SessionCreateResult
    delete result.additionalProperties
    delete result.properties.info
    result.required = ['session_id']
    const v = verify(lock, [spec])

    expect(hits(v, 'R-READ-GONE')).toEqual(['AMBER session.create#info.status'])
    expect(v.level).toBe('AMBER')
  })

  it('ENUM-WIDE: a result enum we switch on gains a member at the target', () => {
    const { lock, spec } = fresh()
    const next = target(spec, {})
    next.schemas.SessionStatus.enum = ['idle', 'running', 'archived']
    const v = verify(lock, [spec, next])

    expect(hits(v, 'ENUM-WIDE')).toEqual(['AMBER session.create#info.status'])
    expect(v.findings.find(f => f.rule === 'ENUM-WIDE')?.detail).toBe('archived')
  })

  it('ENUM-WIDE: an event payload enum gains a member at the target', () => {
    const { lock, spec } = fresh()
    const next = target(spec, {})
    next.schemas.ClarifyRequestPayload.properties.kind.enum = ['choice', 'text', 'secret']
    const v = verify(lock, [spec, next])

    expect(hits(v, 'ENUM-WIDE')).toEqual(['AMBER clarify.request#kind'])
    expect(rules(v)).toEqual(['ENUM-WIDE'])
  })

  it('ERR-GONE: a consumed error code is gone; JSON-RPC protocol codes never count', () => {
    const { lock, spec } = fresh()
    spec.errorCodes = [4002]
    const v = verify(lock, [spec])

    expect(hits(v, 'ERR-GONE')).toEqual(['AMBER 4001'])
    expect(rules(v)).toEqual(['ERR-GONE'])
  })

  it('CFG-GONE-WRITTEN: a config key we write is gone; a key we only read is not flagged', () => {
    const { lock, spec } = fresh()
    spec.configKeys = ['display.other']
    const v = verify(lock, [spec])

    expect(hits(v, 'CFG-GONE-WRITTEN')).toEqual(['AMBER approvals.mode'])
    expect(rules(v)).toEqual(['CFG-GONE-WRITTEN'])
  })

  it('DISK-GONE: an on-disk path we rely on is gone', () => {
    const { lock, spec } = fresh()
    spec.disk = ['.update_check']
    const v = verify(lock, [spec])

    expect(hits(v, 'DISK-GONE')).toEqual(['AMBER .hermes-update-in-progress'])
    expect(rules(v)).toEqual(['DISK-GONE'])
  })

  it('SEM-TOUCH: an upstream commit touched the handler file of a locked method', () => {
    const { lock, spec } = fresh()

    const v = verify(lock, [spec], {
      touched: [
        { file: 'tui_gateway/methods_session.py', subjects: ['session: resume by title'] },
        { file: 'tui_gateway/unrelated.py', subjects: ['noise'] }
      ]
    })

    expect(hits(v, 'SEM-TOUCH')).toEqual(['AMBER session.create'])
    expect(v.findings[0].detail).toBe('session: resume by title')
  })

  it('CANARY-FAIL: the sandboxed canary scenario failed', () => {
    const { lock, spec } = fresh()
    const v = verify(lock, [spec], { canary: { ok: false, scenario: 'clarify' } })

    expect(hits(v, 'CANARY-FAIL')).toEqual(['AMBER clarify'])
    expect(rules(v)).toEqual(['CANARY-FAIL'])
  })
})

describe('UNKNOWN rules', () => {
  it('ENGINE-DEP-GONE: openrpc (a typed spec without an OpenRPC document hash)', () => {
    const { lock, spec } = fresh()
    delete spec.openrpcSha256
    const v = verify(lock, [spec])

    expect(hits(v, 'ENGINE-DEP-GONE')).toEqual(['UNKNOWN openrpc'])
    expect(v.level).toBe('UNKNOWN')
  })

  it('ENGINE-DEP-GONE: health (the REST census no longer serves the health route)', () => {
    const { lock, spec } = fresh()
    delete lock.rest['GET /api/health']
    spec.rest = ['GET /api/sessions/{session_id}']
    const v = verify(lock, [spec])

    expect(hits(v, 'ENGINE-DEP-GONE')).toEqual(['UNKNOWN health'])
    expect(rules(v)).toEqual(['ENGINE-DEP-GONE'])
  })

  it('ENGINE-DEP-GONE: schemaVersion (no SCHEMA_VERSION at the provider)', () => {
    const { lock, spec } = fresh()
    spec.stateVersions = { config: 50 }
    const v = verify(lock, [spec])

    expect(hits(v, 'ENGINE-DEP-GONE')).toEqual(['UNKNOWN schemaVersion'])
    expect(v.state.liveDb).toBeNull()
  })

  it('ENGINE-DEP-GONE: configVersion (no _config_version at the provider)', () => {
    const { lock, spec } = fresh()
    spec.stateVersions = { db: 31 }
    const v = verify(lock, [spec])

    expect(hits(v, 'ENGINE-DEP-GONE')).toEqual(['UNKNOWN configVersion'])
    expect(rules(v)).toEqual(['ENGINE-DEP-GONE'])
  })

  it('ENGINE-DEP-GONE: receipt (the update receipt lost a field we read)', () => {
    const { lock, spec } = fresh()
    spec.receipt = ['outcome', 'pre_update.sha', 'post_update.sha']
    const v = verify(lock, [spec])

    expect(hits(v, 'ENGINE-DEP-GONE')).toEqual(['UNKNOWN receipt'])
    expect(rules(v)).toEqual(['ENGINE-DEP-GONE'])
  })

  it('an AST-only provider, a missing lock and a failed fetch are never GREEN', () => {
    const { lock, spec } = fresh()

    expect(hits(verify(lock, [{ ...spec, specTier: 'ast' }]), 'NO-OPENRPC')).toHaveLength(1)
    expect(verify(null, [spec]).level).toBe('UNKNOWN')
    expect(verify(lock, []).level).toBe('UNKNOWN')
  })
})

describe('INFO rules (adoption capabilities, never raise the level)', () => {
  it('M-NEW: the provider serves a method we do not call', () => {
    const { lock, spec } = fresh()
    spec.methods['session.fork'] = { params: 'SessionCreateParams', result: 'SessionCreateResult' }
    const v = verify(lock, [spec])

    expect(hits(v, 'M-NEW')).toEqual(['INFO session.fork'])
    expect(rules(v)).toEqual(['M-NEW'])
    expect(v.level).toBe('GREEN')
  })

  it('SR-NEW: an unknown server request is INFO when the app answers unknown requests', () => {
    const { lock, spec } = fresh()
    lock.serverRequests.answersUnknown = true
    spec.serverRequests.secret = { params: 'SudoRequestParams', result: 'OkResult' }
    const v = verify(lock, [spec])

    expect(hits(v, 'SR-NEW')).toEqual(['INFO secret'])
    expect(rules(v)).toEqual(['SR-NEW'])
  })

  it('E-NEW: the provider emits an event we do not consume', () => {
    const { lock, spec } = fresh()
    spec.notifications['session.forked'] = { payload: 'MessageDeltaPayload' }
    const v = verify(lock, [spec])

    expect(hits(v, 'E-NEW')).toEqual(['INFO session.forked'])
    expect(rules(v)).toEqual(['E-NEW'])
  })

  it('P-OPT-NEW: a new optional param we do not send', () => {
    const { lock, spec } = fresh()
    spec.schemas.SessionCreateParams.properties.model = { type: 'string' }
    const v = verify(lock, [spec])

    expect(hits(v, 'P-OPT-NEW')).toEqual(['INFO session.create#model'])
    expect(rules(v)).toEqual(['P-OPT-NEW'])
  })

  it('R-FIELD-NEW: a new result field we do not read', () => {
    const { lock, spec } = fresh()
    spec.schemas.SessionCreateResult.properties.created_at = { type: 'number' }
    const v = verify(lock, [spec])

    expect(hits(v, 'R-FIELD-NEW')).toEqual(['INFO session.create#created_at'])
    expect(rules(v)).toEqual(['R-FIELD-NEW'])
  })

  it('ONE-WAY: the target raises a state version', () => {
    const { lock, spec } = fresh()
    const v = verify(lock, [spec, target(spec, { stateVersions: { db: 32, config: 50 } })])

    expect(hits(v, 'ONE-WAY')).toEqual(['INFO state'])
    expect(v.state.oneWay).toBe(true)
    expect(v.perSpec.map(p => p.level)).toEqual(['GREEN', 'GREEN'])
  })
})
