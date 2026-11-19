// v0.0.9 e2e harness (owner requirement, negative proof): the icloneOS readiness rule (e2e/readiness.ts) says NOT
// ready while any known blocker is on screen — the permission-gate card, the consent dialog, the connecting/boot
// overlay, any other aria-modal dialog — and ready ONLY on the plain home with main's backend up. The DOM half runs on
// real markup patterns of those surfaces (jsdom); each case fails if the rule is loosened.
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

const GATE = 'The permission gate is not in place'
const HOME = 'iclone os home'
const UP = { phase: 'backend.ready', error: null }

const { collectDomFacts, judgeReadiness, TERMINAL_VERDICTS } = await import('../e2e/readiness.ts')

const homeMarkup = `<div role="region" aria-label="${HOME}"><nav aria-label="Dock"><button>Message</button></nav></div>`

// The surfaces as the app renders them (boot-failure-overlay.tsx, consent/index.tsx, gateway-connecting-overlay.tsx).
const BLOCKERS = {
  gate: `<div data-glass-opaque=""><div role="dialog" aria-modal="true" aria-labelledby="t"><h2 id="t">${GATE}</h2></div></div>`,
  consent: `<div data-glass-opaque=""><div role="dialog" aria-modal="true" data-consent-step="terms"><h2>Before you begin</h2></div></div>`,
  connecting: `<div data-boot-void="" data-glass-opaque="" role="status" aria-busy="true"></div>`,
  modal: `<div role="dialog" aria-modal="true"><h2>The agent couldn't start</h2></div>`
}

function facts(body, boot = UP) {
  const { window } = new JSDOM(`<!doctype html><body>${body}</body>`)

  return { ...collectDomFacts(window.document, GATE, HOME), boot }
}

describe('the icloneOS readiness rule', () => {
  it('is ready on the plain home with the backend up — and only then', () => {
    expect(judgeReadiness(facts(homeMarkup))).toBe('ready')
  })

  it.each(Object.entries(BLOCKERS))('is NOT ready while the %s blocker is up, even over the home', (name, markup) => {
    expect(judgeReadiness(facts(homeMarkup + markup))).toBe(name)
  })

  it('the gate card, the consent sheet and a backend error are terminal (fail at once); the others are waited out', () => {
    expect([...TERMINAL_VERDICTS].sort()).toEqual(['backend-error', 'consent', 'gate'])
  })

  it('is NOT ready without the home region, or with the backend not (yet) up, or failed', () => {
    expect(judgeReadiness(facts('<main>other</main>'))).toBe('no-home')
    expect(judgeReadiness(facts(homeMarkup, { phase: 'backend.starting', error: null }))).toBe('backend-not-ready')
    expect(judgeReadiness(facts(homeMarkup, null))).toBe('backend-not-ready')
    expect(judgeReadiness(facts(homeMarkup, { phase: 'backend.error', error: 'exit 1' }))).toBe('backend-error')
    expect(judgeReadiness(facts(homeMarkup, { phase: 'backend.ready', error: 'late failure' }))).toBe('backend-error')
  })

  it('a hidden blocker does not count (it left the screen), a shown one does', () => {
    expect(judgeReadiness(facts(homeMarkup + `<div hidden>${BLOCKERS.modal}</div>`))).toBe('ready')
    expect(judgeReadiness(facts(homeMarkup + `<div style="display:none">${BLOCKERS.gate}</div>`))).toBe('ready')
    expect(judgeReadiness(facts(homeMarkup + BLOCKERS.modal))).toBe('modal')
  })

  it('a hidden home is no home', () => {
    expect(judgeReadiness(facts(`<div aria-hidden="true">${homeMarkup}</div>`))).toBe('no-home')
  })

  it('the rule\'s copy is the app\'s own (the gate title, the home region label)', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { boot } = await import('../src/i18n/en/boot.ts')
    const { desktop } = await import('../src/i18n/en/desktop.ts')
    const readiness = fs.readFileSync(path.join(import.meta.dirname, '..', 'e2e', 'readiness.ts'), 'utf8')

    expect(boot.failure.gateTitle).toBe(GATE)
    expect(desktop.home.region).toBe(HOME)
    // The Message pane's conversation list copy the real-session helpers drive (e2e/fixtures.ts MESSAGE_LIST).
    expect([desktop.home.conversations, desktop.home.showConversations, desktop.home.newConversation]).toEqual([
      'Conversations',
      'Show conversations',
      'New conversation'
    ])
    expect(readiness).toContain(`export const HOME_REGION_LABEL = '${HOME}'`)
    expect(readiness).toContain(`export const GATE_TITLE = '${GATE}'`)
  })
})
