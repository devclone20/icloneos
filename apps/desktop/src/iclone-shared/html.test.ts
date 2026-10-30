import { describe, expect, it } from 'vitest'

import { escapeHtml } from './html'

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters, ampersand first', () => {
    expect(escapeHtml(`<a href="x" title='y'>&amp;</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#039;y&#039;&gt;&amp;amp;&lt;/a&gt;'
    )
  })

  it('leaves safe text untouched', () => {
    expect(escapeHtml('plain text — ünïcode 🚀')).toBe('plain text — ünïcode 🚀')
    expect(escapeHtml('')).toBe('')
  })

  it('accepts non-strings: nullish reads as empty, the rest as text', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
    expect(escapeHtml(0)).toBe('0')
    expect(escapeHtml({ toString: () => '<b>' })).toBe('&lt;b&gt;')
  })

  it('neutralises script and attribute break-outs', () => {
    const out = escapeHtml(`"><script>alert(1)</script><img src=x onerror='a'>`)

    expect(out).not.toMatch(/[<>"']/)
  })
})
