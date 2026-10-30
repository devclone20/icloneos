// The locale parity gate (front V3-T, decision 11): every word the English banks have, pt-PT has — same keys, same
// placeholders, the same singular/plural choices, no empty strings and no English copied outside the allowlist.
//
// Top-up after a merge brings new English keys — one `I18N-PARITY <locale> <kind> <bank>:<path>` line per gap, plus a
// summary line, written to the file named by I18N_PARITY_OUT (and printed with the failure):
//   cd apps/desktop && I18N_PARITY_OUT=/tmp/pt-PT-gaps.txt npx vitest run --project ui src/i18n/parity; cat /tmp/pt-PT-gaps.txt
// Another locale can be audited the same way with I18N_PARITY_LOCALE=<id> (ja, zh, zh-hant, ar); only pt-PT is gated (ruling 59: en + pt-PT are the only shipped locales).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

import { isLocale } from '../languages'
import type { Locale } from '../types'

import { KEPT_IN_ENGLISH, KEPT_IN_ENGLISH_AT, OPEN_GROUPS } from './allowlist'
import { LOCALE_BANKS, NOT_WORD_BANKS } from './banks'
import { compareBank, countLeaves, formatIssue, type ParityIssue, type ParityOptions } from './locale-parity'

const GATED: Locale = 'pt-PT'
const requested = process.env.I18N_PARITY_LOCALE
const LOCALE: Locale = isLocale(requested) ? requested : GATED
const OTHERS: readonly Locale[] = (['zh', 'zh-hant', 'ja', 'ar', 'pt-PT'] as const).filter(other => other !== LOCALE)

function parityIssues(locale: Locale): ParityIssue[] {
  return LOCALE_BANKS.flatMap(bank =>
    compareBank(bank.words('en'), bank.words(locale), {
      allowedPaths: KEPT_IN_ENGLISH_AT,
      allowedValues: KEPT_IN_ENGLISH,
      bank: bank.id,
      openGroups: OPEN_GROUPS,
      others: OTHERS.filter(other => other !== 'pt-PT')
        .map(other => bank.words(other))
        .filter(words => words !== undefined)
    })
  )
}

const SRC = join(process.cwd(), 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)

    if (statSync(path).isDirectory()) {
      return sourceFiles(path)
    }

    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

describe(`gate V3T locale parity — ${LOCALE}`, () => {
  it(`gate V3T.parity: every English key has ${LOCALE} words with the same placeholders and plurals`, () => {
    const issues = parityIssues(LOCALE)
    const english = LOCALE_BANKS.reduce((sum, bank) => sum + countLeaves(bank.words('en')), 0)

    const lines = [
      ...issues.map(issue => formatIssue(LOCALE, issue)),
      `I18N-PARITY-SUMMARY ${LOCALE} banks=${LOCALE_BANKS.length} english_leaves=${english} issues=${issues.length}`
    ]

    if (process.env.I18N_PARITY_OUT) {
      writeFileSync(process.env.I18N_PARITY_OUT, `${lines.join('\n')}\n`)
    }

    if (LOCALE === GATED) {
      expect(issues.map(issue => formatIssue(LOCALE, issue))).toEqual([])
    }
  })

  it('gate V3T.registry: every file that keeps per-locale words is a registered bank', () => {
    const covered = new Set([...LOCALE_BANKS.flatMap(bank => bank.files), ...NOT_WORD_BANKS])

    const banksInSource = sourceFiles(SRC)
      .filter(path => /Record<\s*(Exclude<\s*)?Locale\b|:\s*PluginLocaleBundles\b/.test(readFileSync(path, 'utf8')))
      .map(path => relative(SRC, path))

    expect(banksInSource.filter(path => !covered.has(path))).toEqual([])
    expect([...covered].filter(path => !banksInSource.includes(path))).toEqual([])
  })
})

// Critic m-G1: English copied with another letter case or stray white space is still English. Both evasions stayed
// green before the comparator trimmed and case-folded; the gate script's mutations english_lowercase and
// english_padded prove the same on the real catalogue.
describe('the parity comparator: English in another case or with padding is untranslated (m-G1)', () => {
  const options: ParityOptions = {
    allowedPaths: new Set(),
    allowedValues: new Set(),
    bank: 'probe',
    openGroups: new Set(),
    others: [{ retry: 'Réessayer', again: () => 'Encore' }]
  }

  it.each(['Retry', 'retry', 'Retry ', ' RETRY\n'])('a string %j is named untranslated', value => {
    expect(compareBank({ retry: 'Retry' }, { retry: value }, options)).toEqual([
      { bank: 'probe', detail: 'Retry', kind: 'untranslated', path: 'retry' }
    ])
  })

  it('a sentence function that renders the English words in lower case is named untranslated', () => {
    const issues = compareBank(
      { again: (n: number) => `Try ${n} times` },
      { again: (n: number) => `try ${n} times ` },
      options
    )

    expect(issues.map(issue => `${issue.kind} ${issue.path}`)).toEqual(['untranslated again'])
  })

  it('translated words, and allowlisted terms in any case, stay green', () => {
    expect(compareBank({ retry: 'Retry' }, { retry: 'Tentar novamente' }, options)).toEqual([])
    expect(
      compareBank({ term: 'Kanban' }, { term: 'Kanban ' }, { ...options, allowedValues: new Set(['Kanban']) })
    ).toEqual([])
  })
})
