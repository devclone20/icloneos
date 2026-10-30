import { describe, expect, it } from 'vitest'

import { type MarketAgent, shapeAgents } from './market-data'
import {
  activeCategory,
  CATEGORIES,
  countMatches,
  excerpt,
  fold,
  highlight,
  localMatches,
  matchAgent,
  matchStrength,
  rankAgents,
  shouldRerank,
  tokenize
} from './market-search'

const NOW = Date.parse('2026-09-27T12:00:00.000Z')
const ONLINE = '2999-12-31T00:00:00.000Z'
const LONG_AGO = '2026-01-01T00:00:00.000Z'

interface Raw {
  id: string
  name: string
  description?: string
  cluster?: string
  tag?: string
  lastActiveAt?: string
  chains?: Array<{ chainId: number }>
  offerings?: Array<{ id: string; name: string; description?: string; priceValue?: number; slaMinutes?: number }>
  resources?: Array<{ id: string; name: string; url?: string; params?: object }>
}

function agents(...raw: Raw[]): MarketAgent[] {
  return shapeAgents(
    {
      data: raw.map(item => ({
        lastActiveAt: ONLINE,
        chains: [{ chainId: 8453 }],
        resources: [],
        ...item,
        offerings: (item.offerings ?? []).map(offering => ({ priceType: 'fixed', priceValue: 1, ...offering }))
      }))
    },
    NOW
  )
}

function names(list: Array<{ agent: MarketAgent }>): string[] {
  return list.map(item => item.agent.name)
}

describe('tokenize', () => {
  it('folds case and accents, and splits on anything that is not a letter or digit', () => {
    expect(fold('Café RÉSEAU Ñandú')).toBe('cafe reseau nandu')
    expect(tokenize('  Café-RÉSEAU / (Ñandú)!  ')).toEqual(['cafe', 'reseau', 'nandu'])
  })

  it('drops stopwords when other words are left, and keeps them when not', () => {
    expect(tokenize('a trading agent for the memes')).toEqual(['trading', 'meme'])
    expect(tokenize('agent')).toEqual(['agent'])
    expect(tokenize('the AI')).toEqual(['the', 'ai'])
  })

  it('stems long plurals only, dedupes, and ignores one-letter words', () => {
    expect(tokenize('signals Signal news class x 7')).toEqual(['signal', 'news', 'class', '7'])
    expect(tokenize('')).toEqual([])
    expect(tokenize(Array.from({ length: 30 }, (_, index) => `word${index}`).join(' '))).toHaveLength(12)
  })
})

describe('matching', () => {
  it('scores a whole word over a word start over the inside of a word', () => {
    expect(matchStrength('trading desk', 'trading')).toBe(1.25)
    expect(matchStrength('trading desk', 'trad')).toBe(1)
    expect(matchStrength('autotrading desk', 'trading')).toBe(0.4)
    // Short fragments inside a word are noise ("ai" in "email").
    expect(matchStrength('email sender', 'ai')).toBe(0)
    expect(matchStrength('research', 'audit')).toBe(0)
  })

  it('tiers an agent by where its words are, and lists the offerings that hold them', () => {
    const [titled, prose, partial, none] = agents(
      {
        id: '1',
        name: 'Alpha',
        offerings: [
          { id: 'o1', name: 'Token audit' },
          { id: 'o2', name: 'Smart contract security audit', description: 'Full review' },
          { id: 'o3', name: 'Memes' }
        ]
      },
      { id: '2', name: 'Beta', description: 'We run a security audit on any contract.' },
      { id: '3', name: 'Gamma security desk' },
      { id: '4', name: 'Delta', description: 'Image generation.' }
    )

    const tokens = tokenize('security audit')
    const first = matchAgent(titled, tokens)

    expect(first.tier).toBe(3)
    // Both words beat one word; the order of the listing breaks ties.
    expect(first.offerings.map(offering => offering.id)).toEqual(['o2', 'o1'])
    expect(matchAgent(prose, tokens)).toMatchObject({ tier: 2, matched: 2, offerings: [] })
    expect(matchAgent(partial, tokens)).toMatchObject({ tier: 1, matched: 1 })
    expect(matchAgent(none, tokens)).toMatchObject({ tier: 0, matched: 0, score: 0 })
  })

  it('reads resource names, tags and clusters as titles', () => {
    const [agent] = agents({
      id: '1',
      name: 'Feeds',
      tag: 'oracle',
      cluster: 'defi',
      resources: [{ id: 'r1', name: 'Price feed', url: 'https://api.example.com/price', params: {} }]
    })

    expect(matchAgent(agent, tokenize('price oracle defi')).tier).toBe(3)
  })
})

describe('ranking', () => {
  const list = agents(
    { id: '1', name: 'Broad match', description: 'General purpose helper.' },
    { id: '2', name: 'Other', description: 'Mentions trading once.' },
    { id: '3', name: 'Trading signals desk' },
    { id: '4', name: 'Signals only' },
    { id: '5', name: 'Trading signals pro' }
  )

  it('lifts every-word title matches, keeping the service order inside each tier', () => {
    const ranked = rankAgents(list, tokenize('trading signals'), true)

    expect(names(ranked)).toEqual([
      'Trading signals desk',
      'Trading signals pro',
      'Other',
      'Signals only',
      'Broad match'
    ])
  })

  it('keeps the service order when the owner chose a sort, or nothing was typed', () => {
    expect(names(rankAgents(list, tokenize('trading signals'), false))).toEqual(list.map(agent => agent.name))
    expect(rankAgents(list, [], true).every(item => item.match === null)).toBe(true)
    expect(shouldRerank({ mode: 'mixed', sortBy: '' })).toBe(true)
    expect(shouldRerank({ mode: 'relevance', sortBy: '' })).toBe(true)
    expect(shouldRerank({ mode: 'recency', sortBy: '' })).toBe(false)
    expect(shouldRerank({ mode: 'mixed', sortBy: 'successRate' })).toBe(false)
  })

  it('counts agents and — with a query — only the offerings that match', () => {
    const [agent] = agents({
      id: '1',
      name: 'Otto',
      offerings: [
        { id: 'a', name: 'News report' },
        { id: 'b', name: 'Meme pack' },
        { id: 'c', name: 'Daily news' }
      ]
    })

    expect(countMatches(rankAgents([agent], tokenize('news'), true))).toEqual({ agents: 1, offerings: 2 })
    expect(countMatches(rankAgents([agent], [], true))).toEqual({ agents: 1, offerings: 3 })
  })
})

describe('the local fallback', () => {
  const pool = agents(
    { id: '1', name: 'Crypto desk', description: 'News on tokens.', chains: [{ chainId: 8453 }] },
    { id: '2', name: 'Sol news', chains: [{ chainId: 501 }] },
    { id: '3', name: 'Sleeping news bot', lastActiveAt: LONG_AGO },
    { id: '4', name: 'Unrelated' }
  )

  it('finds the words in what is already loaded, best first', () => {
    expect(names(localMatches(pool, tokenize('news'), { online: 'all', chainId: null }, NOW))).toEqual([
      'Sol news',
      'Sleeping news bot',
      'Crypto desk'
    ])
  })

  it('honours the online and chain filters the owner set', () => {
    expect(names(localMatches(pool, tokenize('news'), { online: 'online', chainId: 8453 }, NOW))).toEqual([
      'Crypto desk'
    ])
    expect(names(localMatches(pool, tokenize('news'), { online: 'offline', chainId: null }, NOW))).toEqual([
      'Sleeping news bot'
    ])
    expect(localMatches(pool, [], { online: 'all', chainId: null }, NOW)).toEqual([])
  })
})

describe('highlight', () => {
  const hits = (text: string, query: string) =>
    highlight(text, tokenize(query))
      .filter(segment => segment.hit)
      .map(segment => segment.text)

  it('marks the original characters, accents and case included', () => {
    expect(highlight('Café Réseau', tokenize('cafe'))).toEqual([
      { text: 'Café', hit: true },
      { text: ' Réseau', hit: false }
    ])
    // A decomposed accent stays inside the mark with its letter.
    expect(hits('Café bar', 'cafe')).toEqual(['Café'])
  })

  it('lights up a whole word from its start, and long fragments inside words', () => {
    expect(hits('Trading signals for traders', 'trad')).toEqual(['Trading', 'traders'])
    expect(hits('Autotrading desk', 'trading')).toEqual(['trading'])
    expect(hits('email sender', 'ai')).toEqual([])
  })

  it('merges overlapping matches and keeps markup-looking text as text', () => {
    expect(hits('smartcontract', 'smart smartcontract')).toEqual(['smartcontract'])
    expect(highlight('<b>news</b>', tokenize('news'))).toEqual([
      { text: '<b>', hit: false },
      { text: 'news', hit: true },
      { text: '</b>', hit: false }
    ])
    expect(highlight('', ['news'])).toEqual([])
    expect(highlight('plain', [])).toEqual([{ text: 'plain', hit: false }])
  })

  it('starts a long description near its first match, and leaves a short one alone', () => {
    const long = `${'Background context about the desk. '.repeat(8)}We publish daily memes for traders.`
    const cut = excerpt(long, tokenize('memes'))

    expect(cut.startsWith('…')).toBe(true)
    expect(cut).toContain('memes')
    expect(cut.length).toBeLessThan(long.length)
    expect(excerpt('Short and sweet memes.', tokenize('memes'))).toBe('Short and sweet memes.')
    expect(excerpt(long, [])).toBe(long)
  })
})

describe('categories', () => {
  it('are nine, each a search the tokenizer keeps whole', () => {
    expect(CATEGORIES.map(category => category.label)).toEqual([
      'Trading',
      'Research',
      'Code',
      'Images & media',
      'Data & APIs',
      'Email & OTP',
      'Social',
      'Automation',
      'Security'
    ])
    expect(CATEGORIES.every(category => tokenize(category.query).length > 0)).toBe(true)
  })

  it('knows which chip is the search on screen', () => {
    expect(activeCategory('Security Audit ')?.label).toBe('Security')
    expect(activeCategory('audit')).toBeNull()
  })
})
