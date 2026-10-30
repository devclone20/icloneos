/**
 * EconomyOS — Market search: the owner's words, read over what the
 * marketplace answered.
 *
 * `acp browse` is a semantic search: it ranks, but it never says why a card
 * is there, and it never looks inside offerings the way a buyer does. This
 * module reads the same answer locally — every typed word, found case- and
 * accent-blind in an agent's name, tag, cluster, description, offerings and
 * resources — so a card can show what matched, typed intent can surface over
 * a broad ranking, and a search the service could not answer still finds
 * what is already on screen.
 *
 * Pure: no React, no CLI. An agent's folded text is built once per answer
 * (keyed on the agent object, which the CLI cache keeps stable), so a new
 * query costs one scan of pre-folded strings.
 */
import { type BrowseParams, type MarketAgent, type MarketOffering, type OnlineFilter, presenceOf } from './market-data'

// ── folding + tokens ────────────────────────────────────────────────────────

const MARKS = /\p{M}+/gu
const WORD_CHAR = /[\p{L}\p{N}]/u
const WORDS = /[\p{L}\p{N}]+/gu
const MAX_TOKENS = 12

// Words that carry no intent in a marketplace of agents. Dropped only when
// the query has others: "agent" alone still searches for "agent".
const STOPWORDS = new Set([
  'a',
  'agent',
  'agents',
  'ai',
  'an',
  'and',
  'any',
  'for',
  'from',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'that',
  'the',
  'to',
  'with'
])

/** Case- and accent-blind text: "Café Réseau" → "cafe reseau". The final
 *  sigma is folded too, so a whole string and its characters agree. */
export function fold(text: string): string {
  return text.normalize('NFKD').replace(MARKS, '').toLowerCase().replace(/ς/g, 'σ')
}

/** A plural's stem, so "signals" finds "signal" and "images" "image" — only
 *  for longer words, where the trailing s is a plural and not the word. */
function stem(word: string): string {
  return word.length >= 5 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word
}

/** The query as distinct folded words, stopwords dropped unless nothing else
 *  is left. One-letter words match everything and are ignored. */
export function tokenize(query: string): string[] {
  const words = (fold(query).match(WORDS) ?? []).filter(word => word.length >= 2 || /^\d$/.test(word))
  const meaningful = words.filter(word => !STOPWORDS.has(word))
  const chosen = (meaningful.length > 0 ? meaningful : words).map(stem)

  return [...new Set(chosen)].slice(0, MAX_TOKENS)
}

// ── matching one token in one text ──────────────────────────────────────────

const WORD_START = 1
const WHOLE_WORD = 1.25
const INSIDE_WORD = 0.4
// Short fragments inside a word are noise ("ai" in "email").
const INSIDE_MIN = 4

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char)
}

/** How well `token` appears in folded `text`: a whole word, a word's start,
 *  inside a longer word, or not at all (0). */
export function matchStrength(text: string, token: string): number {
  let best = 0
  let from = 0

  while (from <= text.length - token.length) {
    const at = text.indexOf(token, from)

    if (at < 0) {
      break
    }

    const starts = !isWordChar(text[at - 1])

    if (starts) {
      if (!isWordChar(text[at + token.length])) {
        return WHOLE_WORD
      }

      best = Math.max(best, WORD_START)
    } else if (token.length >= INSIDE_MIN) {
      best = Math.max(best, INSIDE_WORD)
    }

    from = at + 1
  }

  return best
}

// ── the per-agent index ─────────────────────────────────────────────────────

interface OfferingIndex {
  offering: MarketOffering
  name: string
  description: string
}

interface AgentIndex {
  name: string
  tag: string
  cluster: string
  description: string
  offerings: OfferingIndex[]
  resources: string[]
}

const indexes = new WeakMap<MarketAgent, AgentIndex>()

function indexOf(agent: MarketAgent): AgentIndex {
  let index = indexes.get(agent)

  if (!index) {
    index = {
      name: fold(agent.name),
      tag: fold(agent.tag),
      cluster: fold(agent.cluster),
      description: fold(agent.description),
      offerings: agent.offerings.map(offering => ({
        offering,
        name: fold(offering.name),
        description: fold(offering.description)
      })),
      resources: agent.resources.map(resource => fold(resource.name))
    }
    indexes.set(agent, index)
  }

  return index
}

// What a word is worth where it is found: the name is the listing's own
// claim, an offering's name is a thing a buyer can hire, a description is prose.
const WEIGHTS = {
  name: 8,
  tag: 5,
  offeringName: 5,
  cluster: 4,
  resourceName: 3,
  description: 2,
  offeringDescription: 1.5
}

/** 3 — every word is in a title (the name, tag, cluster, an offering or a
 *  resource name); 2 — every word is somewhere; 1 — some words; 0 — none
 *  (the service matched by meaning, not by these words). */
type MatchTier = 0 | 1 | 2 | 3

export interface AgentMatch {
  tier: MatchTier
  score: number
  /** How many of the query's words were found anywhere in the agent. */
  matched: number
  /** Offerings that hold at least one word, best first. */
  offerings: MarketOffering[]
}

function offeringScore(entry: OfferingIndex, tokens: readonly string[]): { score: number; words: number } {
  let score = 0
  let words = 0

  for (const token of tokens) {
    const value = Math.max(
      WEIGHTS.offeringName * matchStrength(entry.name, token),
      WEIGHTS.offeringDescription * matchStrength(entry.description, token)
    )

    if (value > 0) {
      score += value
      words += 1
    }
  }

  return { score, words }
}

/** Where the query's words are in one agent, and how strongly. */
export function matchAgent(agent: MarketAgent, tokens: readonly string[]): AgentMatch {
  const index = indexOf(agent)
  const scored = index.offerings.map((entry, order) => ({ entry, order, ...offeringScore(entry, tokens) }))
  let score = 0
  let matched = 0
  let titled = 0

  for (const token of tokens) {
    const title = Math.max(
      WEIGHTS.name * matchStrength(index.name, token),
      WEIGHTS.tag * matchStrength(index.tag, token),
      WEIGHTS.cluster * matchStrength(index.cluster, token),
      ...index.offerings.map(entry => WEIGHTS.offeringName * matchStrength(entry.name, token)),
      ...index.resources.map(name => WEIGHTS.resourceName * matchStrength(name, token))
    )

    const prose = Math.max(
      WEIGHTS.description * matchStrength(index.description, token),
      ...index.offerings.map(entry => WEIGHTS.offeringDescription * matchStrength(entry.description, token))
    )

    const best = Math.max(title, prose)

    if (best > 0) {
      score += best
      matched += 1
    }

    if (title > 0) {
      titled += 1
    }
  }

  const all = tokens.length > 0 && matched === tokens.length
  const tier: MatchTier = all && titled === tokens.length ? 3 : all ? 2 : matched > 0 ? 1 : 0

  const offerings = scored
    .filter(item => item.words > 0)
    .sort((a, b) => b.words - a.words || b.score - a.score || a.order - b.order)
    .map(item => item.entry.offering)

  return { tier, score, matched, offerings }
}

// ── ranking ─────────────────────────────────────────────────────────────────

export interface RankedAgent {
  agent: MarketAgent
  /** null on the featured feed — nothing was typed. */
  match: AgentMatch | null
}

/** Re-ranking is only honest when the owner asked for relevance: an explicit
 *  sort (most jobs, newest) is kept exactly as the service answered it. */
export function shouldRerank(params: Pick<BrowseParams, 'mode' | 'sortBy'>): boolean {
  return params.sortBy === '' && params.mode !== 'recency'
}

/**
 * The service's answer, ranked by (how fully the typed words match, the
 * service's own order): an agent whose name or offering holds every word
 * rises above one the service matched by meaning alone, and within a tier
 * the service's ranking stands untouched.
 */
export function rankAgents(agents: readonly MarketAgent[], tokens: readonly string[], rerank: boolean): RankedAgent[] {
  if (tokens.length === 0) {
    return agents.map(agent => ({ agent, match: null }))
  }

  const ranked = agents.map(agent => ({ agent, match: matchAgent(agent, tokens) }))

  // Array#sort is stable: equal tiers keep the service's order.
  return rerank ? ranked.sort((a, b) => b.match.tier - a.match.tier) : ranked
}

interface LocalFilters {
  online: OnlineFilter
  chainId: null | number
}

/**
 * The fallback when the service found nothing for a typed search: the agents
 * already loaded (the featured feed) that hold the words, best first, under
 * the same online and chain filters the owner set.
 */
export function localMatches(
  pool: readonly MarketAgent[],
  tokens: readonly string[],
  filters: LocalFilters,
  now: number
): RankedAgent[] {
  if (tokens.length === 0) {
    return []
  }

  return pool
    .filter(agent => filters.chainId == null || agent.chainIds.includes(filters.chainId))
    .filter(agent => filters.online === 'all' || presenceOf(agent, now).online === (filters.online === 'online'))
    .map((agent, order) => ({ agent, order, match: matchAgent(agent, tokens) }))
    .filter(item => item.match.matched > 0)
    .sort((a, b) => b.match.tier - a.match.tier || b.match.score - a.match.score || a.order - b.order)
    .map(({ agent, match }) => ({ agent, match }))
}

export interface MatchCount {
  agents: number
  offerings: number
}

/** "N agents · M offerings": with a query, only the offerings that match. */
export function countMatches(ranked: readonly RankedAgent[]): MatchCount {
  return {
    agents: ranked.length,
    offerings: ranked.reduce(
      (sum, item) => sum + (item.match ? item.match.offerings.length : item.agent.offerings.length),
      0
    )
  }
}

// ── highlighting ────────────────────────────────────────────────────────────

interface Segment {
  text: string
  hit: boolean
}

/** Folded text with, for every folded unit, the original range it came from
 *  — folding changes lengths ("é" is two units after NFKD, one after). */
function foldMapped(text: string): { folded: string; starts: number[]; ends: number[] } {
  let folded = ''
  const starts: number[] = []
  const ends: number[] = []
  let offset = 0

  for (const char of text) {
    const end = offset + char.length
    // Most listing text is ASCII: lower-casing is all its folding needs.
    const piece = char.charCodeAt(0) < 128 ? char.toLowerCase() : fold(char)

    if (piece) {
      for (let unit = 0; unit < piece.length; unit++) {
        starts.push(offset)
        ends.push(end)
      }

      folded += piece
    } else if (ends.length > 0) {
      // A lone combining mark belongs to the letter before it.
      ends[ends.length - 1] = end
    }

    offset = end
  }

  return { folded, starts, ends }
}

function hitRanges(folded: string, tokens: readonly string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = []

  for (const token of tokens) {
    let from = 0

    while (from <= folded.length - token.length) {
      const at = folded.indexOf(token, from)

      if (at < 0) {
        break
      }

      if (!isWordChar(folded[at - 1])) {
        // A word's start marks the whole word: "trad" lights up "trading".
        let end = at + token.length

        while (isWordChar(folded[end])) {
          end += 1
        }

        ranges.push([at, end])
      } else if (token.length >= INSIDE_MIN) {
        ranges.push([at, at + token.length])
      }

      from = at + 1
    }
  }

  return ranges.sort((a, b) => a[0] - b[0])
}

/** `text` cut into plain and matched runs, in the original characters — the
 *  view wraps the matched ones in `<mark>`, never in raw HTML. */
export function highlight(text: string, tokens: readonly string[]): Segment[] {
  if (!text || tokens.length === 0) {
    return text ? [{ text, hit: false }] : []
  }

  const { folded, starts, ends } = foldMapped(text)
  const merged: Array<[number, number]> = []

  for (const [from, to] of hitRanges(folded, tokens)) {
    const start = starts[from]
    const end = ends[to - 1]
    const last = merged[merged.length - 1]

    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end)
    } else {
      merged.push([start, end])
    }
  }

  const segments: Segment[] = []
  let cursor = 0

  for (const [start, end] of merged) {
    if (start > cursor) {
      segments.push({ text: text.slice(cursor, start), hit: false })
    }

    segments.push({ text: text.slice(start, end), hit: true })
    cursor = end
  }

  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), hit: false })
  }

  return segments
}

// How far into a description the first match may sit before the card starts
// the text near it instead — past this, a 3-line clamp would hide it.
const EXCERPT_LEAD = 140
const EXCERPT_CONTEXT = 48

/** A description that starts near its first match when the match would
 *  otherwise sit below the card's clamp. */
export function excerpt(text: string, tokens: readonly string[]): string {
  if (tokens.length === 0 || text.length <= EXCERPT_LEAD) {
    return text
  }

  let first = -1
  let offset = 0

  for (const segment of highlight(text, tokens)) {
    if (segment.hit) {
      first = offset

      break
    }

    offset += segment.text.length
  }

  if (first <= EXCERPT_LEAD) {
    return text
  }

  const space = text.lastIndexOf(' ', first - EXCERPT_CONTEXT)
  const start = space > 0 ? space + 1 : first - EXCERPT_CONTEXT

  return `…${text.slice(start)}`
}

// ── discovery ───────────────────────────────────────────────────────────────

interface Category {
  label: string
  /** The search a chip runs — phrased the way providers describe the work. */
  query: string
}

export const CATEGORIES: readonly Category[] = [
  { label: 'Trading', query: 'trading signals' },
  { label: 'Research', query: 'research report' },
  { label: 'Code', query: 'code generation' },
  { label: 'Images & media', query: 'image video generation' },
  { label: 'Data & APIs', query: 'data api' },
  { label: 'Email & OTP', query: 'email otp' },
  { label: 'Social', query: 'social media posts' },
  { label: 'Automation', query: 'automation workflow' },
  { label: 'Security', query: 'security audit' }
]

/** The chip whose search is on screen, if any. */
export function activeCategory(query: string): Category | null {
  const wanted = query.trim().toLowerCase()

  return CATEGORIES.find(category => category.query === wanted) ?? null
}
