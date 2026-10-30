import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { fakeAcp, type FakeJob, offerJob } from './fake-cli'
import { createLedger, type Ledger } from './ledger'
import { DEFAULT_POLICY, type WorkPolicy } from './policy'
import { createWatchdog, gatedWrite, type WorkActor, type WorkAuditEntry } from './watchdog'

const SLUG = 'robinhood-1'

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3i-watchdog-'))
})

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function setup(
  jobs: FakeJob[],
  opts: { actor?: 'fake' | 'none'; spendTrade?: boolean; policy?: Partial<WorkPolicy>; ledgerDir?: string } = {}
) {
  const acp = fakeAcp(jobs)
  const ledgers = new Map<string, Ledger>()
  const audit: WorkAuditEntry[] = []
  const root = opts.ledgerDir ?? dir

  const ledger = (slug: string) => {
    let found = ledgers.get(slug)

    if (!found) {
      found = createLedger({ file: path.join(root, slug, 'ledger.jsonl') })
      ledgers.set(slug, found)
    }

    return found
  }

  const actor: WorkActor | null = opts.actor === 'none' ? null : acp.actor

  const watchdog = createWatchdog({
    read: acp.read,
    actor,
    ledger,
    policy: () => ({ ...DEFAULT_POLICY, ...opts.policy }),
    spendTradeOn: () => opts.spendTrade ?? false,
    audit: (_slug, entry) => audit.push(entry),
    onChange: () => undefined
  })

  return { acp, watchdog, ledger: () => ledger(SLUG), audit }
}

const kinds = (ledger: Ledger) => ledger.read().records.map(record => record.kind)

describe('L1 (the default): the owner approves each job', () => {
  it('starts at L1 with L2 off', async () => {
    const { watchdog } = setup([offerJob('1')])

    await watchdog.poll(SLUG)
    expect(watchdog.view(SLUG)).toMatchObject({ level: 'L1', effective: 'L1', downgrade: null })
  })

  it('an in-policy offer waits in the inbox and nothing is quoted by itself', async () => {
    const { acp, watchdog } = setup([offerJob('1')])

    await watchdog.poll(SLUG)
    expect(watchdog.view(SLUG).offers).toMatchObject([{ jobId: '1', standing: 'pending', rule: null }])
    expect(acp.writes).toEqual([])
  })

  it('approve with the owner gesture quotes the offer at its price through the earn-only door', async () => {
    const { acp, watchdog, ledger, audit } = setup([offerJob('1')])

    await watchdog.poll(SLUG)
    expect(await watchdog.approve(SLUG, '1', true)).toEqual({ ok: true })
    expect(acp.writes).toEqual([['provider', 'set-budget', '--job-id', '1', '--amount', '5', '--chain-id', '8453']])
    expect(kinds(ledger())).toEqual(['offer', 'approve', 'quote'])
    expect(audit.map(entry => `${entry.verb}:${entry.allowed}`)).toEqual(['approve:true', 'quote:true'])
  })

  it('approve without a gesture is refused and recorded', async () => {
    const { acp, watchdog, audit } = setup([offerJob('1')])

    await watchdog.poll(SLUG)
    expect(await watchdog.approve(SLUG, '1', false)).toEqual({ ok: false, error: 'gesture' })
    expect(acp.writes).toEqual([])
    expect(audit).toMatchObject([{ verb: 'approve', allowed: false }])
  })

  it('with writes off (round 1) an approval is recorded and the quote held, never sent', async () => {
    const { acp, watchdog, ledger } = setup([offerJob('1')], { actor: 'none' })

    await watchdog.poll(SLUG)
    expect(await watchdog.approve(SLUG, '1', true)).toEqual({ ok: true })
    expect(acp.writes).toEqual([])
    expect(kinds(ledger())).toEqual(['offer', 'approve', 'quote-held'])
    expect(watchdog.view(SLUG)).toMatchObject({ writes: 'off', offers: [{ standing: 'approved' }] })
  })

  it('the owner cannot approve past a policy rule', async () => {
    const { acp, watchdog } = setup([offerJob('1', { budget: '10' })])

    await watchdog.poll(SLUG)
    expect(await watchdog.approve(SLUG, '1', true)).toEqual({ ok: false, error: 'policy', rule: 'price-floor' })
    expect(acp.writes).toEqual([])
  })

  it('approve of a job that is not an open offer for this iNFT is invalid', async () => {
    const { watchdog } = setup([offerJob('1', { providerAddress: '0x0000000000000000000000000000000000000001' })])

    await watchdog.poll(SLUG)
    expect(await watchdog.approve(SLUG, '1', true)).toMatchObject({ ok: false, error: 'invalid' })
    expect(watchdog.view(SLUG).offers).toEqual([])
  })
})

describe('decline is honoured', () => {
  it('a declined offer is never quoted: not by approve, not by L2, not after a restart', async () => {
    const { acp, watchdog, ledger } = setup([offerJob('1')], { spendTrade: true })

    await watchdog.poll(SLUG)
    expect(watchdog.decline(SLUG, '1', true)).toEqual({ ok: true })
    expect(await watchdog.approve(SLUG, '1', true)).toMatchObject({ ok: false, error: 'state' })

    watchdog.setLevel(SLUG, 'L2', true)
    await watchdog.poll(SLUG)

    // A fresh watchdog over the same ledger: main restarted.
    const again = setup([offerJob('1')], { spendTrade: true, ledgerDir: dir })

    await again.watchdog.poll(SLUG)
    expect(acp.writes).toEqual([])
    expect(again.acp.writes).toEqual([])
    expect(again.watchdog.view(SLUG).offers).toMatchObject([{ jobId: '1', standing: 'declined' }])
    expect(kinds(ledger()).filter(kind => kind === 'decline')).toHaveLength(1)
  })

  it('decline needs the gesture too, and is idempotent', async () => {
    const { watchdog, ledger } = setup([offerJob('1')])

    await watchdog.poll(SLUG)
    expect(watchdog.decline(SLUG, '1', false)).toEqual({ ok: false, error: 'gesture' })
    expect(watchdog.decline(SLUG, '1', true)).toEqual({ ok: true })
    expect(watchdog.decline(SLUG, '1', true)).toEqual({ ok: true })
    expect(kinds(ledger()).filter(kind => kind === 'decline')).toHaveLength(1)
  })
})

describe('L0 observe', () => {
  it('sees and records offers but takes no decision', async () => {
    const { acp, watchdog, ledger } = setup([offerJob('1'), offerJob('2')])

    expect(watchdog.setLevel(SLUG, 'L0', true)).toEqual({ ok: true })
    await watchdog.poll(SLUG)
    expect(kinds(ledger())).toEqual(['level', 'offer', 'offer'])
    expect(await watchdog.approve(SLUG, '1', true)).toMatchObject({ ok: false, error: 'state' })
    expect(acp.writes).toEqual([])
    expect(watchdog.view(SLUG).offers.map(offer => offer.standing)).toEqual(['pending', 'pending'])
  })
})

describe('L2: built, off, and only the owner can turn it on', () => {
  it('cannot be set without a gesture', async () => {
    const { watchdog, ledger, audit } = setup([offerJob('1')], { spendTrade: true })

    expect(watchdog.setLevel(SLUG, 'L2', false)).toEqual({ ok: false, error: 'gesture' })
    expect(watchdog.view(SLUG).level).toBe('L1')
    expect(kinds(ledger())).toEqual([])
    expect(audit).toMatchObject([{ verb: 'level', allowed: false }])
  })

  it('a forged level record without the gesture flag does not count', async () => {
    const { watchdog, ledger } = setup([offerJob('1')], { spendTrade: true })

    ledger().append({ kind: 'level', level: 'L2', gesture: false })
    expect(watchdog.view(SLUG).level).toBe('L1')
  })

  it('with the gesture and Spend/trade on, quotes in-policy offers by itself and refuses the rest', async () => {
    const { acp, watchdog } = setup(
      [offerJob('1'), offerJob('2', { budget: '1' }), offerJob('3', { fundRequest: '2' })],
      {
        spendTrade: true
      }
    )

    expect(watchdog.setLevel(SLUG, 'L2', true)).toEqual({ ok: true })
    await watchdog.poll(SLUG)
    expect(acp.writes.map(argv => argv[3])).toEqual(['1'])
    expect(watchdog.view(SLUG).offers.find(offer => offer.jobId === '3')).toMatchObject({
      standing: 'refused',
      rule: 'spend'
    })
  })

  it('Spend/trade off folds L2 to observe-only, and the view says why (I5)', async () => {
    const { acp, watchdog } = setup([offerJob('1')], { spendTrade: false })

    watchdog.setLevel(SLUG, 'L2', true)
    await watchdog.poll(SLUG)
    expect(watchdog.view(SLUG)).toMatchObject({ level: 'L2', effective: 'L0', downgrade: 'spend-trade-off' })
    expect(await watchdog.approve(SLUG, '1', true)).toMatchObject({ ok: false, error: 'state' })
    expect(acp.writes).toEqual([])
  })

  it('a broken ledger folds every level to L0', async () => {
    const { watchdog, ledger } = setup([offerJob('1')], { spendTrade: true })

    watchdog.setLevel(SLUG, 'L2', true)
    fs.appendFileSync(ledger().file, 'tampered\n')
    expect(watchdog.view(SLUG)).toMatchObject({ effective: 'L0', downgrade: 'chain-broken', chain: { ok: false } })
  })

  it('a paused (draining) watchdog takes no new work at L2', async () => {
    const { acp, watchdog } = setup([offerJob('1')], { spendTrade: true })

    watchdog.setLevel(SLUG, 'L2', true)
    watchdog.pause(SLUG, true)
    await watchdog.poll(SLUG)
    expect(acp.writes).toEqual([])
    expect(await watchdog.approve(SLUG, '1', true)).toMatchObject({ ok: false, error: 'state' })
  })
})

describe('I4 policy refusal from the job list', () => {
  it('12 offers outside the policy: 12 refused with the rule named, 0 accepted, at L2 too', async () => {
    const other = '0x1111111111111111111111111111111111111111'

    const jobs = [
      offerJob('1', { budget: '999999' }),
      offerJob('2', { budget: null }),
      offerJob('3', { offeringName: 'trading' }),
      offerJob('4', { offeringName: 'memes' }),
      offerJob('5', { clientAddress: other }),
      offerJob('6', { clientAddress: '' }),
      offerJob('7', { clientAddress: '0x2222222222222222222222222222222222222222' }),
      offerJob('8', { paymentToken: 'VIRTUAL' }),
      offerJob('9', { requirement: 'x'.repeat(20_000) }),
      offerJob('10', { fundRequest: { amount: '3' } }),
      offerJob('11', { transferAmount: '1' }),
      offerJob('12', { chainId: 1 })
    ]

    const { acp, watchdog } = setup(jobs, {
      spendTrade: true,
      policy: {
        deniedClasses: ['trading'],
        allowedClasses: ['research', 'trading'],
        requesterAllow: ['0x00000000000000000000000000000000000000bb', other],
        requesterDeny: [other]
      }
    })

    watchdog.setLevel(SLUG, 'L2', true)
    await watchdog.poll(SLUG)

    const offers = watchdog.view(SLUG).offers

    expect(offers).toHaveLength(12)
    expect(offers.every(offer => offer.standing === 'refused' && offer.rule !== null)).toBe(true)
    expect(Object.fromEntries(offers.map(offer => [offer.jobId, offer.rule]))).toEqual({
      '1': 'price-floor',
      '2': 'price-floor',
      '3': 'class',
      '4': 'class',
      '5': 'requester-denied',
      '6': 'requester-unknown',
      '7': 'requester-unknown',
      '8': 'token',
      '9': 'oversize',
      '10': 'spend',
      '11': 'spend',
      '12': 'chain'
    })
    expect(acp.writes).toEqual([])
  })

  it('the open-job cap counts engaged jobs', async () => {
    const { watchdog } = setup(
      [offerJob('1'), offerJob('2', { status: 'funded' }), offerJob('3', { status: 'budget_set' })],
      { policy: { maxOpenJobs: 2 } }
    )

    await watchdog.poll(SLUG)
    expect(watchdog.view(SLUG).offers).toMatchObject([{ jobId: '1', standing: 'refused', rule: 'open-cap' }])
  })
})

describe('I5: zero spend paths', () => {
  const spends = [
    ['client', 'fund', '--job-id', '1'],
    ['client', 'create-job', '--provider', '0xabc'],
    ['client', 'create-custom-job', '--provider', '0xabc'],
    ['provider', 'set-budget-with-fund-request', '--job-id', '1', '--amount', '1', '--chain-id', '8453'],
    ['wallet', 'send-transaction', '--to', '0xabc'],
    ['wallet', 'topup'],
    ['trade', '--swap', 'x'],
    ['provider', 'submit', '--job-id', '1', '--deliverable', 'x', '--transfer-amount', '9']
  ]

  it('every value-moving argv is refused before the actor: 0 reach the stub', async () => {
    const { acp, ledger, audit } = setup([])
    const ledgerFor = () => ledger()

    for (const argv of spends) {
      expect(
        await gatedWrite(
          { actor: acp.actor, audit: (_s, entry) => audit.push(entry), ledger: ledgerFor },
          SLUG,
          argv,
          '1'
        )
      ).toBe('refused')
    }

    expect(acp.writes).toEqual([])
    expect(acp.valueMovingWrites()).toBe(0)
    expect(kinds(ledger()).every(kind => kind === 'spend-refused')).toBe(true)
    expect(audit.every(entry => entry.verb === 'spend-refused' && !entry.allowed)).toBe(true)
    expect(
      ledger()
        .read()
        .records.every(record => record.micros === 0)
    ).toBe(true)
  })

  it('negative control: the stub does count a value-moving argv handed to it directly', async () => {
    const { acp } = setup([])

    await acp.actor.run(SLUG, spends[0])
    expect(acp.valueMovingWrites()).toBe(1)
  })
})

describe('I3 traceability and I6 the honest stop', () => {
  it('a full lifecycle traces offer -> job -> budget -> delivered -> paid, and totals equal the rows', async () => {
    const { acp, watchdog } = setup([offerJob('1'), offerJob('2', { budget: '2500001' })])

    await watchdog.poll(SLUG)
    await watchdog.approve(SLUG, '1', true)
    await watchdog.approve(SLUG, '2', true)
    acp.setStatus('1', 'funded')
    acp.setStatus('1', 'submitted')
    acp.close('1', 'completed')
    acp.setStatus('2', 'funded')
    await watchdog.poll(SLUG)

    const view = watchdog.view(SLUG)
    const paid = view.rows.find(row => row.jobId === '1')

    expect(paid).toMatchObject({ group: 'payments', status: 'completed' })
    expect(paid?.trace.offer).not.toBeNull()
    expect(paid?.trace).toMatchObject({
      job: '1',
      budgetMicros: 5_000_000,
      deliverable: 'completed',
      paymentMicros: 5_000_000
    })
    expect(view.rows.find(row => row.jobId === '2')).toMatchObject({
      group: 'in-flight',
      trace: { paymentMicros: null }
    })
    expect(view.totals.earnedMicros).toBe(view.rows.reduce((sum, row) => sum + (row.trace.paymentMicros ?? 0), 0))
    expect(view.totals).toMatchObject({ earnedMicros: 5_000_000, spentMicros: 0, escrowMicros: 2_500_001 })
  })

  it('a hop the records do not prove is a gap, never filled in', async () => {
    const { acp, watchdog } = setup([offerJob('1')], { actor: 'none' })

    await watchdog.poll(SLUG)
    await watchdog.approve(SLUG, '1', true)
    acp.close('1', 'expired')
    await watchdog.poll(SLUG)
    expect(watchdog.view(SLUG).rows).toMatchObject([
      { jobId: '1', group: 'history', trace: { budgetMicros: null, deliverable: null, paymentMicros: null } }
    ])
  })

  it('earnings are recorded once per job, however many reads see it', async () => {
    const { acp, watchdog, ledger } = setup([offerJob('1')])

    await watchdog.poll(SLUG)
    await watchdog.approve(SLUG, '1', true)
    acp.setStatus('1', 'completed')
    await watchdog.poll(SLUG)
    await watchdog.poll(SLUG)
    expect(kinds(ledger()).filter(kind => kind === 'earn')).toHaveLength(1)
  })

  it('stop with 2 jobs open reports exactly those 2 and the escrow on them', async () => {
    const { watchdog } = setup([
      offerJob('1', { status: 'funded', budget: '3000000' }),
      offerJob('2', { status: 'submitted' }),
      offerJob('3', { status: 'completed' })
    ])

    await watchdog.poll(SLUG)
    expect(watchdog.stopReport(SLUG)).toEqual({
      ok: true,
      open: [
        { jobId: '1', status: 'funded' },
        { jobId: '2', status: 'submitted' }
      ],
      escrowMicros: 3_000_000
    })
  })

  it('a failed read keeps the last answer and says why', async () => {
    const { acp, watchdog } = setup([offerJob('1')])

    await watchdog.poll(SLUG)
    acp.state.failReads = true
    await watchdog.poll(SLUG)
    expect(watchdog.view(SLUG)).toMatchObject({ readError: 'network down', offers: [{ jobId: '1' }] })
  })

  it('only read verbs are ever sent to the read door', async () => {
    const { acp, watchdog } = setup([offerJob('1')])

    await watchdog.poll(SLUG)
    await watchdog.approve(SLUG, '1', true)
    acp.close('1', 'completed')
    await watchdog.poll(SLUG)
    expect(new Set(acp.reads.map(argv => argv.slice(0, 2).join(' ')))).toEqual(
      new Set(['agent whoami', 'job list', 'job history'])
    )
  })
})
