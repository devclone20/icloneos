// V3-T3 — every record kind the Activity list can show says its detail in the reader's words, built from the
// record's own fields; main's English log line (`reason`) never reaches the window. One case per kind (the pt-PT row),
// then the leak check over a fixture with every kind and every producer's log line.
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { arPermissions } from '@/i18n/ar/permissions'
import { enPermissions } from '@/i18n/en/enPermissions'
import { jaPermissions } from '@/i18n/ja/permissions'
import { ptPtPermissions as pt } from '@/i18n/pt-PT/permissions'
import { zhHantPermissions } from '@/i18n/zh-hant/permissions'
import { zhPermissions } from '@/i18n/zh/permissions'
import type { AuditRecordView } from '@/iclone-shared/permissions'

import { auditKindLabel, auditTitle, describeAuditRecord } from './audit-detail'
import { AuditList } from './audit-list'

// Ruling 69 (owner, 2026-10-25, supersedes 61 and 59's two-language reading): the app ships in ENGLISH ONLY, so no
// provider hands out another language. The leak gates below need a non-English catalogue to have anything to say, so
// the pt-PT catalogue is forced into the list instead of being selected as a language. The catalogues stay in the
// tree and must stay valid, which is what keeps G-31 (offering one again) a change to `OFFERED_LOCALES` alone.
vi.mock('@/i18n', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useI18n: () => ({ isSavingLocale: false, locale: 'en', setLocale: vi.fn(), t: { settings: { permissions: pt } } })
}))

let seq = 0

function rec(fields: Partial<AuditRecordView> & { kind: string }): AuditRecordView {
  seq += 1

  return {
    seq_main: seq,
    ts: '2026-10-22T10:00:00.000Z',
    mode: null,
    scope: null,
    class: null,
    action: null,
    agent: null,
    answer: null,
    reason: null,
    ...fields
  }
}

const target = (text: string) => ({ tool: 'terminal', target: text, project_root: null })

/** Each row: the record as a producer writes it, and the pt-PT detail the row must show. */
const ROWS: readonly [string, AuditRecordView, string | undefined][] = [
  // use
  ['use · plugin, with a target', rec({ kind: 'use', src: 'plugin', action: target('npm test') }), 'npm test'],
  ['use · payment settled', rec({ kind: 'use', src: 'payment', class: '$', reason: 'settled' }), 'Pagamento liquidado'],
  [
    'use · payments hard stop turned on',
    rec({ kind: 'use', src: 'payment', reason: 'stop on' }),
    'Paragem total: todos os pagamentos são recusados'
  ],
  [
    'use · a payment setting changed',
    rec({ kind: 'use', src: 'payment', reason: 'setting perTxMicros,payees' }),
    'Uma alteração em Economia › Pagamentos'
  ],
  // refuse
  [
    'refuse · over a cap',
    rec({ kind: 'refuse', src: 'payment', reason: 'per_tx' }),
    'Acima de um limite em Economia › Pagamentos'
  ],
  [
    'refuse · the owner’s malformed allowlist (a settings change, not a payee)',
    rec({ kind: 'refuse', src: 'payment', reason: 'setting allowlist' }),
    'Uma alteração em Economia › Pagamentos'
  ],
  ['refuse · no mandate', rec({ kind: 'refuse', src: 'payment', reason: 'no_mandate' }), 'Sem mandato válido'],
  [
    'refuse · the owner on the sheet',
    rec({ kind: 'refuse', src: 'payment', reason: 'door_denied' }),
    'Recusado por si no pedido de permissão'
  ],
  [
    'refuse · the payments socket',
    rec({ kind: 'refuse', src: 'payment', reason: 'socket busy' }),
    'Recusado pelo serviço de pagamentos'
  ],
  [
    'refuse · the payments ledger',
    rec({ kind: 'refuse', src: 'payment', reason: 'ledger' }),
    'O registo de pagamentos não passa na verificação'
  ],
  [
    'refuse · an unknown payment code',
    rec({ kind: 'refuse', src: 'payment', reason: 'brand_new_code' }),
    'Um pagamento'
  ],
  [
    'refuse · plugin, no target: the log line stays in the log',
    rec({ kind: 'refuse', src: 'plugin', reason: 'mode: the manual permission mode' }),
    undefined
  ],
  // ask
  ['ask · with a target', rec({ kind: 'ask', src: 'plugin', action: target('rm -rf build') }), 'rm -rf build'],
  ['ask · no target', rec({ kind: 'ask', src: 'door', reason: 'Hermes flagged this command as dangerous' }), undefined],
  // answer
  ['answer · denied', rec({ kind: 'answer', src: 'door', answer: 'deny' }), 'Recusado por si'],
  ['answer · for this chat', rec({ kind: 'answer', src: 'door', answer: 'session' }), 'Esta conversa'],
  [
    'answer · too many waiting',
    rec({ kind: 'answer', src: 'door', answer: 'deny', reason: 'too many permission requests are already waiting' }),
    'Já havia demasiados pedidos de permissão em espera'
  ],
  [
    'answer · withdrawn',
    rec({ kind: 'answer', src: 'door', answer: 'deny', reason: 'withdrawn' }),
    'Retirado antes da sua resposta'
  ],
  // timeout
  [
    'timeout · door, with a target',
    rec({ kind: 'timeout', src: 'door', action: target('git push'), reason: 'ask 12 unanswered' }),
    'git push'
  ],
  [
    'timeout · settlement pending',
    rec({ kind: 'timeout', src: 'payment', reason: 'settlement_pending' }),
    'Liquidação ainda pendente'
  ],
  // mode_set
  [
    'mode_set · for a project',
    rec({ kind: 'mode_set', src: 'main', mode: 'automatic', scope: 'project', reason: '/Users/me/site' }),
    'este projeto · /Users/me/site'
  ],
  [
    'mode_set · for a chat: the opaque session id stays out',
    rec({ kind: 'mode_set', src: 'main', mode: 'automatic', scope: 'session', reason: '20261022_101500_abc123' }),
    'esta conversa'
  ],
  [
    'mode_set · everywhere',
    rec({ kind: 'mode_set', src: 'main', mode: 'manual', scope: 'standing' }),
    'em todo o lado'
  ],
  // mode_refused
  [
    'mode_refused · Ignore as the standing default',
    rec({ kind: 'mode_refused', mode: 'ignore', reason: 'Ignore permissions cannot be the standing default.' }),
    'Ignorar permissões não pode ser a predefinição em todo o lado'
  ],
  [
    'mode_refused · not confirmed',
    rec({ kind: 'mode_refused', mode: 'ignore', reason: 'Ignore permissions was not confirmed on the system dialog.' }),
    'Sem confirmação na caixa de diálogo do sistema'
  ],
  [
    'mode_refused · revoke without a gesture',
    rec({ kind: 'mode_refused', gesture: false, reason: 'revoke without a gesture' }),
    'Sem um clique seu'
  ],
  [
    'mode_refused · invalid',
    rec({ kind: 'mode_refused', gesture: true, reason: 'Unknown permission mode or scope.' }),
    'Alteração inválida'
  ],
  // grant / revoke
  ['grant · a class, everywhere', rec({ kind: 'grant', class: 'Wo', scope: 'standing' }), 'em todo o lado'],
  ['grant · a function', rec({ kind: 'grant', fn: 'email', scope: 'session' }), 'E-mail · Perguntar uma vez'],
  ['revoke · a class', rec({ kind: 'revoke', class: 'X', scope: 'project' }), 'este projeto'],
  [
    'revoke · a function, by a level change',
    rec({ kind: 'revoke', fn: 'shopping', reason: 'the function’s level changed' }),
    'Compras · Perguntar uma vez'
  ],
  // gap
  [
    'gap · audit integrity',
    rec({ kind: 'gap', src: 'main', reason: "audit integrity: the chain's head anchor was changed or forged" }),
    pt.audit.chainBroken
  ],
  [
    'gap · records cut',
    rec({ kind: 'gap', src: 'main', reason: 'audit integrity: records 4..9 were cut from the end of the log' }),
    pt.audit.chainBroken
  ],
  [
    'gap · keychain',
    rec({
      kind: 'gap',
      src: 'main',
      reason:
        'the audit key could not be sealed by the system keychain: Manual only, and records cannot be authenticated after a restart'
    }),
    pt.enforcement.degraded
  ],
  [
    'gap · gate never attested',
    rec({
      kind: 'gap',
      src: 'main',
      hermes_pid: 4242,
      reason:
        'the permission gate in Hermes pid 4242 never attested: its tool calls are refused by Hermes and are not individually recorded'
    }),
    'O controlo de permissões no Hermes (pid 4242) nunca chegou a arrancar; as respetivas chamadas de ferramenta são recusadas'
  ],
  [
    'gap · gate never attested, pid unknown (main omits it, so does the row)',
    rec({
      kind: 'gap',
      src: 'main',
      hermes_pid: null,
      reason:
        'the permission gate in Hermes never attested: its tool calls are refused by Hermes and are not individually recorded'
    }),
    'O controlo de permissões no Hermes nunca chegou a arrancar; as respetivas chamadas de ferramenta são recusadas'
  ],
  [
    'gap · gate stopped answering',
    rec({ kind: 'gap', src: 'main', hermes_pid: 51, reason: 'the permission gate in Hermes pid 51 stopped answering' }),
    'O controlo de permissões no Hermes (pid 51) deixou de responder'
  ],
  [
    'gap · unverifiable lines',
    rec({
      kind: 'gap',
      src: 'main',
      reason: '3 lines from Hermes pid 9 could not be verified and were not recorded'
    }),
    '3 linhas do Hermes não puderam ser verificadas e não foram registadas'
  ],
  [
    'gap · one unverifiable line',
    rec({ kind: 'gap', src: 'main', reason: '1 a log line from Hermes could not be verified and were not recorded' }),
    '1 linha do Hermes não pôde ser verificada e não foi registada'
  ],
  [
    'gap · plugin events never arrived',
    rec({ kind: 'gap', src: 'main', reason: 'plugin events 5..7 from pid 9 never arrived' }),
    '3 eventos do controlo de permissões nunca chegaram'
  ],
  [
    'gap · confinement burst',
    rec({
      kind: 'gap',
      src: 'confinement',
      reason: 'confinement: 4 more refusals in one minute, kept in the refusal log only'
    }),
    'Mais 4 recusas de confinamento nesse minuto ficam apenas em Contentores › Recusas'
  ],
  [
    'gap · confinement burst of one',
    rec({
      kind: 'gap',
      src: 'confinement',
      reason: 'confinement: 1 more refusal in one minute, kept in the refusal log only'
    }),
    'Mais 1 recusa de confinamento nesse minuto fica apenas em Contentores › Recusas'
  ],
  ['gap · payment', rec({ kind: 'gap', src: 'payment', reason: 'sign_failed' }), 'O pagamento não foi concluído'],
  [
    'gap · a line no rule knows',
    rec({ kind: 'gap', src: 'main', reason: 'something new went wrong' }),
    'Algo não pôde ser registado'
  ],
  // restart
  ['restart', rec({ kind: 'restart', src: 'main', reason: 'main pid 777' }), undefined],
  // fn_level_set / fn_level_refused
  [
    'fn_level_set',
    rec({ kind: 'fn_level_set', fn: 'email', level: 'manual', prev_level: 'mode', reason: 'lowered' }),
    'E-mail: Seguir o modo → Manual'
  ],
  [
    'fn_level_refused · not confirmed',
    rec({
      kind: 'fn_level_refused',
      fn: 'shell',
      level: 'automatic',
      prev_level: 'mode',
      gesture: true,
      reason: 'The raise was not confirmed on the system dialog.'
    }),
    `Terminal: Seguir o modo → Automático · ${pt.audit.details.notConfirmed}`
  ],
  [
    'fn_level_refused · no click',
    rec({
      kind: 'fn_level_refused',
      fn: 'shell',
      level: 'automatic',
      prev_level: 'mode',
      gesture: false,
      reason: 'A level is raised only from your own click in icloneOS.'
    }),
    `Terminal: Seguir o modo → Automático · ${pt.audit.details.noGesture}`
  ],
  [
    'fn_level_refused · keychain',
    rec({
      kind: 'fn_level_refused',
      fn: 'shell',
      level: 'automatic',
      prev_level: 'mode',
      gesture: true,
      reason: 'The system keychain could not protect the policy: no level can be raised.'
    }),
    `Terminal: Seguir o modo → Automático · ${pt.enforcement.degraded}`
  ],
  [
    'fn_level_refused · changed meanwhile',
    rec({
      kind: 'fn_level_refused',
      fn: 'shell',
      level: 'automatic',
      prev_level: 'mode',
      gesture: true,
      reason: 'The level changed while the dialog was open; nothing was changed.'
    }),
    `Terminal: Seguir o modo → Automático · ${pt.audit.details.raced}`
  ],
  [
    'fn_level_refused · no function',
    rec({ kind: 'fn_level_refused', reason: 'Unknown function or level.' }),
    'Alteração inválida'
  ]
]

const KINDS = [
  'use',
  'refuse',
  'ask',
  'answer',
  'timeout',
  'mode_set',
  'mode_refused',
  'grant',
  'revoke',
  'gap',
  'restart',
  'fn_level_set',
  'fn_level_refused'
]

// Words of main's log lines (and of the payment codes) that are English, not data.
const ENGLISH =
  /\b(the|was|were|not|never|could|from|records?|refused|denied|withdrawn|waiting|settled|settlement|socket|setting|ledger|mandate|stop|lowered|raised|unknown|gate|confinement|integrity|keychain|attested|answering|unanswered|flagged|dangerous|something|wrong)\b|per_tx|no_mandate|door_denied|sign_failed/i

describe('V3-T3 · Activity rows from the record’s own fields (pt-PT)', () => {
  it('the fixture covers every record kind main writes (audit.ts AUDIT_KINDS)', () => {
    expect(new Set(ROWS.map(([, record]) => record.kind))).toEqual(new Set(KINDS))
  })

  for (const [name, record, expected] of ROWS) {
    it(name, () => {
      expect(describeAuditRecord(record, pt)).toBe(expected)
    })
  }

  it('no English leaks: the whole fixture rendered from the pt-PT catalogue holds none of main’s log words', () => {
    const { container } = render(<AuditList records={ROWS.map(([, record]) => record)} />)

    const shown = [...container.querySelectorAll('[data-permission-audit] > *')].map(row => row.textContent ?? '')

    expect(shown.length).toBe(Math.min(ROWS.length, 40))

    for (const text of shown) {
      // The data the agent acted on is allowed (it is the owner's, not main's words).
      const words = text.replace(/npm test|rm -rf build|git push|\/Users\/me\/site|iclone os/g, '')

      expect(words, text).not.toMatch(ENGLISH)
    }
  })

  it('every catalogue says every detail (a locale never falls back to the English log line)', () => {
    for (const copy of [enPermissions, pt, arPermissions, jaPermissions, zhPermissions, zhHantPermissions]) {
      for (const [, record, expected] of ROWS) {
        const detail = describeAuditRecord(record, copy)

        expect(detail === undefined).toBe(expected === undefined)

        if (detail !== undefined && !record.action?.target && record.kind !== 'mode_set') {
          expect(detail).not.toBe(record.reason)
        }
      }
    }
  })
})

const SETTING = 'Uma alteração em Economia › Pagamentos'
const SERVICE = 'Recusado pelo serviço de pagamentos'
const LIMIT = 'Acima de um limite em Economia › Pagamentos'
const PAYEE = 'Destinatário ou site não permitido'
const MANDATE_CHANGE = 'Uma alteração aos mandatos'
const STOPPED = 'Paragem total: todos os pagamentos são recusados'
const UNCERTAIN = 'Resultado desconhecido: verifique o registo de pagamentos'

/**
 * Every reason code `electron/iclone-x402` writes to the permission log (client.ts refuse/gap/timeout/use, limits.ts
 * rules, verb.ts, server.ts, index.ts owner actions, settings-door.ts, ipc.ts socket), with the pt-PT row it must give.
 * Money first: a row the ledger could not take after the signature is never "did not complete".
 */
const PAYMENT_ROWS: readonly [string, string, string][] = [
  // client.ts / verb.ts / index.ts — what happened
  ['use', 'settled', 'Pagamento liquidado'],
  ['use', 'stop on', STOPPED],
  ['use', 'stop on (owner)', STOPPED],
  ['use', 'stop off (owner)', 'Paragem total levantada'],
  ['use', 'setting perTxMicros,payees', SETTING],
  ['use', 'mandate_issue 7c1e2f', 'Mandato emitido'],
  ['use', 'mandate_revoke 7c1e2f', 'Mandato revogado'],
  ['timeout', 'settlement_pending', 'Liquidação ainda pendente'],
  // gaps after or around the signature
  ['gap', 'ledger_write_failed', 'Um pagamento que não ficou no registo de pagamentos'],
  ['gap', 'internal', UNCERTAIN],
  ['gap', 'settlement_unknown', UNCERTAIN],
  ['gap', 'earn_internal', UNCERTAIN],
  ['gap', 'sign_failed', 'O pagamento não foi concluído'],
  ['gap', 'settlement_failed', 'O pagamento não foi concluído'],
  // client.ts refuse + limits.ts rules (RefuseReason)
  ['refuse', 'stop', STOPPED],
  ['refuse', 'ledger', 'O registo de pagamentos não passa na verificação'],
  ['refuse', 'per_tx', LIMIT],
  ['refuse', 'per_day', LIMIT],
  ['refuse', 'per_agent_day', LIMIT],
  ['refuse', 'payee', PAYEE],
  ['refuse', 'origin', PAYEE],
  ['refuse', 'cross_origin_redirect', PAYEE],
  ['refuse', 'no_mandate', 'Sem mandato válido'],
  ['refuse', 'mandate_invalid', 'Sem mandato válido'],
  ['refuse', 'door_denied', 'Recusado por si no pedido de permissão'],
  ['refuse', 'agent', SERVICE],
  ['refuse', 'no_door', SERVICE],
  ['refuse', 'signer_unavailable', SERVICE],
  ['refuse', 'not_x402', SERVICE],
  ['refuse', 'payload', SERVICE],
  ['refuse', 'unsupported_version', SERVICE],
  ['refuse', 'network', SERVICE],
  ['refuse', 'facilitator', SERVICE],
  ['refuse', 'duplicate', SERVICE],
  // verb.ts
  ['refuse', 'usage', SERVICE],
  ['refuse', 'not_ready', SERVICE],
  ['refuse', 'internal', SERVICE],
  // settings-door.ts / index.ts settings
  ['refuse', 'setting gesture', 'Sem um clique seu'],
  ['refuse', 'setting invalid', SETTING],
  ['refuse', 'setting settings_moved', SETTING],
  ['refuse', 'setting allowlist', SETTING],
  ['refuse', 'setting door_denied', 'Recusado por si no pedido de permissão'],
  ['refuse', 'setting ledger', 'O registo de pagamentos não passa na verificação'],
  ['refuse', 'setting no_door', SETTING],
  ['refuse', 'setting unavailable', SETTING],
  // index.ts mandates
  ['refuse', 'mandate_issue gesture', 'Sem um clique seu'],
  ['refuse', 'mandate_issue not_ready', MANDATE_CHANGE],
  ['refuse', 'mandate_issue invalid budget', MANDATE_CHANGE],
  ['refuse', 'mandate_issue door_denied', 'Recusado por si no pedido de permissão'],
  ['refuse', 'mandate_issue settings_moved payees', MANDATE_CHANGE],
  ['refuse', 'mandate_issue ledger', 'O registo de pagamentos não passa na verificação'],
  ['refuse', 'mandate_revoke gesture', 'Sem um clique seu'],
  ['refuse', 'mandate_revoke unknown', MANDATE_CHANGE],
  // index.ts hard stop
  ['refuse', 'stop ledger', 'O registo de pagamentos não passa na verificação'],
  ['refuse', 'stop gesture', 'Sem um clique seu'],
  ['refuse', 'stop door_denied', 'Recusado por si no pedido de permissão'],
  ['refuse', 'stop settings_moved', STOPPED],
  ['refuse', 'stop unavailable', STOPPED],
  // ipc.ts socket / spawn
  ['refuse', 'socket too_large', SERVICE],
  ['refuse', 'socket malformed', SERVICE],
  ['refuse', 'socket token', SERVICE],
  ['refuse', 'socket unprotected_profile', SERVICE],
  ['refuse', 'socket busy', SERVICE],
  ['refuse', 'socket internal', SERVICE],
  ['refuse', 'spawn unprotected_profile', SERVICE],
  // a code a later front adds
  ['refuse', 'brand_new_code', 'Um pagamento'],
  ['gap', 'brand_new_gap', UNCERTAIN]
]

describe('V3-T3 · every payment reason code main writes, as a pt-PT row (critic M1)', () => {
  for (const [kind, reason, expected] of PAYMENT_ROWS) {
    it(`${kind} · ${reason}`, () => {
      expect(describeAuditRecord(rec({ kind, src: 'payment', class: '$', reason }), pt)).toBe(expected)
    })
  }

  it('money: a row the ledger could not take after the signature never reads as a payment that did not happen', () => {
    const unrecorded = describeAuditRecord(rec({ kind: 'gap', src: 'payment', reason: 'ledger_write_failed' }), pt)

    expect(unrecorded).not.toBe(pt.audit.details.payment.failed)
    expect(describeAuditRecord(rec({ kind: 'gap', src: 'payment', reason: 'settlement_unknown' }), pt)).not.toBe(
      pt.audit.details.payment.failed
    )
  })
})

describe('V3-T3 · a kind a later front adds (critic m4)', () => {
  it('reads as a translated generic title in the Activity list, never its raw code', () => {
    expect(auditKindLabel(pt, 'escalate')).toBe('Registo de permissões')
    expect(auditKindLabel(enPermissions, 'escalate')).toBe('Permission record')
    expect(auditKindLabel(pt, 'constructor')).toBe('Registo de permissões')
    expect(auditKindLabel(pt, 'refuse')).toBe('Recusado')

    const { container } = render(
      <AuditList records={[rec({ kind: 'escalate', src: 'main', reason: 'a future kind with English' })]} />
    )

    expect(container.textContent).toContain('Registo de permissões')
    expect(container.textContent).not.toMatch(/escalate|future|English/)
  })
})

describe('V3-T3 · an answer the owner never gave is not titled "Respondeu" (critic n4)', () => {
  it('busy reads Recusado, withdrawn reads Sem resposta, a real answer stays Respondeu', () => {
    const busy = rec({ kind: 'answer', answer: 'deny', reason: 'too many permission requests are already waiting' })
    const withdrawn = rec({ kind: 'answer', answer: 'deny', reason: 'withdrawn' })
    const answered = rec({ kind: 'answer', answer: 'session' })

    expect([auditTitle(pt, busy), auditTitle(pt, withdrawn), auditTitle(pt, answered)]).toEqual([
      'Recusado',
      'Sem resposta',
      'Respondeu'
    ])
  })
})
