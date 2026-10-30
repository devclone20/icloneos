import { describe, expect, it } from 'vitest'

import {
  cleanPreview,
  decodeEntities,
  displayUrl,
  htmlToText,
  parseBody,
  quoteDepth,
  splitLinks,
  stripSignature,
  trimUrl
} from './email-text'

describe('cleanPreview', () => {
  it('collapses CRLF and blank lines into one line', () => {
    expect(cleanPreview('Hello\r\n\r\nWorld\rAgain')).toBe('Hello World Again')
  })

  it('drops quoted lines and everything from the reply attribution on', () => {
    expect(cleanPreview('New words\n> old words\nmore new')).toBe('New words more new')
    expect(cleanPreview('Yes.\nOn Tue, Sep 23, 2026, Ann <a@b.co>\nwrote:\nold')).toBe('Yes.')
    expect(cleanPreview('Sure thing On Mon, Sep 22 Jane wrote: > deck?')).toBe('Sure thing')
    expect(cleanPreview('Top\n-----Original Message-----\nFrom: x')).toBe('Top')
  })

  it('reduces URLs to host + path and keeps the punctuation after them', () => {
    expect(cleanPreview('Sign in: https://agentcard.ai/auth/verify?token=abc.')).toBe(
      'Sign in: agentcard.ai/auth/verify….'
    )
  })

  it('strips invisible preheader padding and caps the length on a code-point boundary', () => {
    expect(cleanPreview('Hi\u200b\u034f\u00ad there')).toBe('Hi there')

    const long = cleanPreview('😀'.repeat(400), 20)

    expect(Array.from(long)).toHaveLength(20)
    expect(long.endsWith('…')).toBe(true)
    expect(long).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })
})

describe('links', () => {
  it('splits text around URLs and trims sentence punctuation', () => {
    expect(splitLinks('Open https://a.io/x, then (see https://en.wikipedia.org/wiki/Foo_(bar)).')).toEqual([
      { kind: 'text', value: 'Open ' },
      { kind: 'url', value: 'https://a.io/x' },
      { kind: 'text', value: ', then (see ' },
      { kind: 'url', value: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
      { kind: 'text', value: ').' }
    ])
  })

  it('never produces a link for other schemes', () => {
    expect(splitLinks('javascript:alert(1) file:///etc/passwd').every(piece => piece.kind === 'text')).toBe(true)
  })

  it('labels URLs briefly', () => {
    expect(displayUrl('https://www.example.com/')).toBe('example.com')
    expect(displayUrl('https://example.com/?q=1')).toBe('example.com/…')
    expect(displayUrl(`https://example.com/${'a'.repeat(200)}`)).toHaveLength(44)
    expect(trimUrl('https://a.io/b)')).toBe('https://a.io/b')
  })
})

describe('htmlToText', () => {
  it('keeps the words, drops markup, scripts, styles and comments', () => {
    const html =
      '<html><head><title>T</title><style>p{color:red}</style></head><body><!-- a > b --><p>Hello&nbsp;<b>there</b> &amp; welcome</p><p>Line<br>two</p><ul><li>one</li><li>two</li></ul><script>alert(1)</script></body></html>'

    expect(htmlToText(html)).toBe('Hello there & welcome\n\nLine\ntwo\n\n• one\n• two')
  })

  it('decodes numeric entities and ignores impossible code points', () => {
    expect(decodeEntities('&#8364; &#x1F600; &#1114112; &bogus;')).toBe('€ 😀  &bogus;')
  })
})

describe('body parsing', () => {
  it('reads quote depth with or without spaces between markers', () => {
    expect(quoteDepth('> > hi')).toEqual({ depth: 2, content: 'hi' })
    expect(quoteDepth('>>hi')).toEqual({ depth: 2, content: 'hi' })
    expect(quoteDepth('a > b')).toEqual({ depth: 0, content: 'a > b' })
  })

  it('strips a short signature, never a long tail', () => {
    expect(stripSignature(['Body', '--', 'Jane', 'CEO'])).toEqual(['Body'])

    const long = ['Body', '--', ...Array.from({ length: 20 }, (_, index) => `line ${index}`)]

    expect(stripSignature(long)).toEqual(long)
  })

  it('folds an Outlook-style history block and drops device footers', () => {
    const body = parseBody(
      'Works for me.\n\nSent from my iPhone\n\nFrom: Jane <j@x.io>\nSent: Monday\nTo: me\nSubject: Plan\n\nOld text'
    )

    expect(body.blocks).toEqual([{ depth: 0, text: 'Works for me.' }])
    expect(body.quoted[0].text.startsWith('From: Jane')).toBe(true)
    expect(parseBody('Short.\n\nSent from my iPhone').blocks).toEqual([{ depth: 0, text: 'Short.' }])
  })

  it('keeps at most one blank line between paragraphs', () => {
    expect(parseBody('a\n\n\n\n\nb').blocks).toEqual([{ depth: 0, text: 'a\n\nb' }])
  })
})

describe('hostile input stays linear', () => {
  const budgetMs = 1500

  function timed(run: () => unknown): number {
    const start = performance.now()

    run()

    return performance.now() - start
  }

  it('long URLs, blank-line floods and entity walls do not backtrack', () => {
    const url = `https://x.io/${'.'.repeat(60_000)}a`
    const blanks = `a${'\n'.repeat(80_000)}b`
    const spaces = `<p>${'&nbsp;'.repeat(40_000)}x</p>`
    const scripts = '<script>'.repeat(20_000)

    expect(timed(() => cleanPreview(url))).toBeLessThan(budgetMs)
    expect(timed(() => splitLinks(url))).toBeLessThan(budgetMs)
    expect(timed(() => parseBody(blanks))).toBeLessThan(budgetMs)
    expect(timed(() => htmlToText(spaces))).toBeLessThan(budgetMs)
    expect(timed(() => htmlToText(scripts))).toBeLessThan(budgetMs)
    expect(timed(() => parseBody(`${'> '.repeat(30_000)}x`))).toBeLessThan(budgetMs)
  })
})
