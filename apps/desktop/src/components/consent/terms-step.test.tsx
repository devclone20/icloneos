import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fakeConsentBridge } from '@/components/consent/fixtures'
import { TermsStep } from '@/components/consent/terms-step'
import { enConsent } from '@/i18n/en'

afterEach(cleanup)

async function policy() {
  return (await fakeConsentBridge(null).bridge.get()).bundled
}

// U1-p2-01: at 1220×779 the accept box sat 66 px under the fold of the policy's scroll box and Continue did nothing.
describe('TermsStep acceptance (U1-p2-01)', () => {
  it('keeps the AI disclosure and the accept box outside the scroll box; only the policy scrolls', async () => {
    const bundled = await policy()

    const { container } = render(
      <TermsStep busy={false} error={null} onContinue={vi.fn()} policy={bundled} update={false} />
    )

    const box = container.querySelector('[data-consent-scroll-box]')!
    const accept = container.querySelector('#consent-accept')!

    expect(box.textContent).toContain(bundled.short[0].lead)
    expect(box.contains(accept)).toBe(false)
    expect(box.contains(container.querySelector('[data-consent-ai-disclosure]'))).toBe(false)
    expect(container.querySelector('[data-consent-scroll-cue]')).toBeTruthy()
  })

  // U3-02 + U1-p2-01: an inactive Continue says why, is still reachable, and sends the focus to the accept box.
  it('explains the inactive Continue, focuses the accept box on press, and proceeds once accepted', async () => {
    const onContinue = vi.fn()

    const { container } = render(
      <TermsStep busy={false} error={null} onContinue={onContinue} policy={await policy()} update={false} />
    )

    const proceed = container.querySelector<HTMLButtonElement>('[data-consent-continue]')!
    const hint = container.querySelector(`[id="${proceed.getAttribute('aria-describedby')}"]`)

    expect(proceed.disabled).toBe(false)
    expect(proceed.getAttribute('aria-disabled')).toBe('true')
    expect(hint?.textContent).toBe(enConsent.sheet.acceptHint)

    fireEvent.click(proceed)

    expect(onContinue).not.toHaveBeenCalled()
    expect(window.document.activeElement).toBe(screen.getByRole('checkbox'))

    fireEvent.click(screen.getByRole('checkbox'))

    expect(proceed.hasAttribute('aria-disabled')).toBe(false)
    expect(proceed.hasAttribute('aria-describedby')).toBe(false)
    expect(container.querySelector('[data-consent-hint]')).toBeNull()
    fireEvent.click(proceed)
    expect(onContinue).toHaveBeenCalledWith(true)
  })
})

describe('TermsStep offline reader', () => {
  it('toggles the bundled text and reports it through aria-expanded', async () => {
    render(<TermsStep busy={false} error={null} onContinue={vi.fn()} policy={await policy()} update={false} />)
    const toggle = screen.getByRole('button', { name: enConsent.sheet.readOffline })

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.textContent).toBe(enConsent.sheet.hideOffline)
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toBe(enConsent.sheet.readOffline)
  })
})

// UF2C-c1-03 (U1-12-p2): the acceptance names the document by the title it bears, never a UI re-spelling of it.
describe('TermsStep names the policy by its title (U1-12-p2)', () => {
  it('puts the bundled title in the eyebrow and in the accept sentence', async () => {
    const bundled = await policy()

    const { container } = render(
      <TermsStep busy={false} error={null} onContinue={vi.fn()} policy={bundled} update={false} />
    )

    const label = container.querySelector('#consent-accept-label')?.textContent

    expect(bundled.title).toMatch(/Policies & Privacy/)
    expect(label).toContain(bundled.title)
    expect(label).toBe(enConsent.sheet.accept(bundled.title, bundled.version))
    expect(container.textContent).toContain(
      enConsent.sheet.eyebrow(bundled.title, bundled.version, bundled.effectiveLabel)
    )
  })
})
