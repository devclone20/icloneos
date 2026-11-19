// v0.0.9 r3 (lead order): the faint ink (--ic-text-3 and its aliases) never sits on an interactive element.
// Red on fb85ac6be6: 18 sites (quiet buttons, icon buttons, tabs, crumbs, Reset/Clear, a link, a close button).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { checkFaintInk, faintSet, informativeSubject, interactiveSubject } from './ic-faint-ink.mjs'

let dir

function tree(files) {
  dir = mkdtempSync(join(tmpdir(), 'faint-'))

  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }

  return dir
}

afterEach(() => {
  if (dir) {
    rmSync(dir, { force: true, recursive: true })
    dir = undefined
  }
})

describe('faint-ink gate', () => {
  it('the renderer tree holds it: no interactive element wears the faint ink', () => {
    const { faint, violations } = checkFaintInk()

    expect(faint.has('e-faint')).toBe(true)
    expect(violations).toEqual([])
  })

  it('finds aliases transitively', () => {
    const set = faintSet([':root{--a: var(--ic-text-3); --b: var(--a); --c: var(--ic-text-2)}'])

    expect([...set].sort()).toEqual(['a', 'b', 'ic-text-3'])
  })

  it('fails a quiet button, a tab, an icon button and a class used on a <button> in JSX', () => {
    const root = tree({
      'a.css': [
        '.x{--x-faint: var(--ic-text-3)}',
        '.icpg__btn--quiet{color: var(--ic-text-3)}',
        '.foo__tab{color: var(--x-faint)}',
        '.bar__go{color: var(--ic-text-3)}',
        '.seg > button{color: var(--ic-text-3)}'
      ].join('\n'),
      'b.tsx': 'export const B = () => <button className="bar__go" type="button">Go</button>\n'
    })
    const { violations } = checkFaintInk(root)

    expect(violations.join('\n')).toMatch(/icpg__btn--quiet/)
    expect(violations.join('\n')).toMatch(/foo__tab/)
    expect(violations.join('\n')).toMatch(/bar__go .*sits on an interactive element/)
    expect(violations.join('\n')).toMatch(/seg > button/)
  })

  it('fails a Tailwind faint utility on a JSX control, passes it under disabled: and on static text', () => {
    const root = tree({
      'a.css': '',
      'c.tsx': [
        'export const C = () => (<>',
        '  <a className="text-(--ic-text-3) underline" href="#">Docs</a>',
        '  <button className="disabled:text-(--ic-text-3) text-(--ic-text-1)" type="button">Ok</button>',
        '  <p className="text-(--ic-text-3)">meta</p>',
        '</>)'
      ].join('\n')
    })
    const { violations } = checkFaintInk(root)

    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatch(/c\.tsx:2 <a> wears text-\(--ic-text-3\)/)
  })

  it('exempts disabled states, placeholders and pseudo-element separators', () => {
    const none = new Map()

    expect(interactiveSubject('.x__btn:disabled', none)).toBeNull()
    expect(interactiveSubject(".m__item[aria-disabled='true']", none)).toBeNull()
    expect(interactiveSubject('.x__field::placeholder', none)).toBeNull()
    expect(interactiveSubject('.x__tab::before', none)).toBeNull()
    expect(interactiveSubject('.x__meta', none)).toBeNull()
    expect(interactiveSubject('.x__btn', none)).toMatch(/names a control/)
  })

  // v0.0.9 r4 (design r3 N7): informative text holds AA too. Red on 5470b2b185 (no such rule; 19 sites, e.g. the
  // Settings page subtitle .icpg__subtitle and the Book's "Wallet 0x…" .icpg__dim).
  it('fails the informative text roles: subtitle, dim, hint, status', () => {
    const root = tree({
      'a.css': [
        '.x{--x-faint: var(--ic-text-3)}',
        '.icpg__subtitle{color: var(--ic-text-3)}',
        '.icpg__dim{color: var(--x-faint)}',
        '.icui-hint{color: var(--ic-text-3)}',
        '.mk-input__hint{color: var(--ic-text-3)}',
        '.icsk__srv-status{color: var(--ic-text-3)}',
        '.ok__subtitle{color: var(--ic-text-2-aa)}'
      ].join('\n')
    })
    const text = checkFaintInk(root).violations.join('\n')

    for (const cls of ['icpg__subtitle', 'icpg__dim', 'icui-hint', 'mk-input__hint', 'icsk__srv-status']) {
      expect(text).toMatch(new RegExp(`\\.${cls} is informative text`))
    }

    expect(text).not.toMatch(/ok__subtitle/)
  })

  it('keeps decorative separators, placeholders, disabled hints and incidental meta exempt', () => {
    expect(informativeSubject('.x__hint::before')).toBeNull()
    expect(informativeSubject('.x__field::placeholder')).toBeNull()
    expect(informativeSubject('.x__hint:disabled')).toBeNull()
    expect(informativeSubject('.x__sep')).toBeNull()
    expect(informativeSubject('.x__meta')).toBeNull()
    expect(informativeSubject('.x__status')).toMatch(/informative/)
  })
})
