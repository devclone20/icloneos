import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { McpTestResult } from '@/hermes'
import type { Translations } from '@/i18n'

const getUsageAnalytics = vi.fn()

vi.mock('@/hermes', () => ({ getUsageAnalytics: (...args: unknown[]) => getUsageAnalytics(...args) }))

const {
  capabilitySummary,
  filterStdioSections,
  loadMcpUsage,
  parseServersDoc,
  pretty,
  scanServerBlocks,
  serverEnabled,
  statusLine,
  statusOf,
  statusTone,
  wrapDoc
} = await import('./servers')

const m = {
  capabilitySummary: (tools: number, prompts: number, resources: number) =>
    `${tools} tools, ${prompts} prompts, ${resources} resources`,
  costTokens: (tokens: string) => `~${tokens} tok/call`,
  statusConnecting: 'Connecting…',
  statusError: 'Error',
  statusNeedsAuth: 'Needs authentication',
  statusOff: 'Off',
  usage30d: (uses: string) => `${uses} uses/30d`
} as unknown as Translations['settings']['mcp']

const probe = (over: Partial<McpTestResult>): McpTestResult =>
  ({ ok: true, tools: [], ...over }) as unknown as McpTestResult

describe('parseServersDoc', () => {
  it('reads both wrapper spellings and a bare name→config map', () => {
    const entry = { command: 'npx' }

    expect(parseServersDoc('{"mcpServers":{"a":{"command":"npx"}}}')).toEqual({ a: entry })
    expect(parseServersDoc('{"mcp_servers":{"a":{"command":"npx"}}}')).toEqual({ a: entry })
    expect(parseServersDoc('{"a":{"command":"npx"}}')).toEqual({ a: entry })
  })

  it('normalizes the ecosystem `type` key to Hermes `transport`', () => {
    expect(parseServersDoc('{"mcpServers":{"a":{"url":"http://x","type":"sse"}}}')).toEqual({
      a: { url: 'http://x', transport: 'sse' }
    })
  })

  it('refuses a nameless server, a non-object and broken JSON', () => {
    expect(() => parseServersDoc('{"command":"npx"}')).toThrow(/so it has a name/)
    expect(() => parseServersDoc('[1]')).toThrow(/Expected a JSON object/)
    expect(() => parseServersDoc('null')).toThrow(/Expected a JSON object/)
    expect(() => parseServersDoc('{')).toThrow()
  })

  it('round-trips through wrapDoc', () => {
    expect(parseServersDoc(wrapDoc({ a: { command: 'npx' } }))).toEqual({ a: { command: 'npx' } })
    expect(pretty({ a: 1 })).toBe('{\n  "a": 1\n}')
  })
})

describe('statusOf / statusTone', () => {
  it('reads `enabled: false` as off before anything else', () => {
    expect(serverEnabled({})).toBe(true)
    expect(serverEnabled({ enabled: false })).toBe(false)
    expect(statusOf({ enabled: false }, 'probing')).toBe('off')
  })

  it('separates probing, unknown, ok, needs-auth and error', () => {
    expect(statusOf({}, 'probing')).toBe('probing')
    expect(statusOf({}, undefined)).toBe('unknown')
    expect(statusOf({}, probe({ ok: true }))).toBe('ok')
    expect(statusOf({}, probe({ error: 'HTTP 401 unauthorized', ok: false }))).toBe('needs-auth')
    expect(statusOf({}, probe({ error: 'oauth required', ok: false }))).toBe('needs-auth')
    expect(statusOf({}, probe({ error: 'ECONNREFUSED', ok: false }))).toBe('error')
    expect(statusOf({}, probe({ ok: false }))).toBe('error')
  })

  it('maps every status onto one of our four dot tones', () => {
    expect(statusTone('ok')).toBe('good')
    expect(statusTone('error')).toBe('bad')
    expect(statusTone('needs-auth')).toBe('warn')
    expect(statusTone('probing')).toBe('neutral')
    expect(statusTone('off')).toBe('neutral')
    expect(statusTone('unknown')).toBe('neutral')
  })
})

describe('capabilitySummary / statusLine', () => {
  const ok = probe({
    ok: true,
    prompts: 1,
    resources: 3,
    tools: [
      { description: '', name: 'a' },
      { description: '', name: 'b' }
    ]
  })

  it('counts the raw tools without a server config', () => {
    expect(capabilitySummary(m, ok)).toBe('2 tools, 1 prompts, 3 resources')
  })

  it('counts only the tools the per-tool filter keeps', () => {
    expect(capabilitySummary(m, ok, { tools: { exclude: ['b'] } })).toBe('1 tools, 1 prompts, 3 resources')
    expect(capabilitySummary(m, ok, { tools: { include: ['b'] } })).toBe('1 tools, 1 prompts, 3 resources')
  })

  it('appends the cost overlay and omits each half when unknown', () => {
    expect(capabilitySummary(m, ok, undefined, { tokens: 4200, uses: 3 })).toBe(
      '2 tools, 1 prompts, 3 resources, ~4.2k tok/call, 3 uses/30d'
    )
    expect(capabilitySummary(m, ok, undefined, { tokens: 0, uses: null })).toBe('2 tools, 1 prompts, 3 resources')
    expect(capabilitySummary(m, ok, undefined, { tokens: null, uses: 0 })).toBe(
      '2 tools, 1 prompts, 3 resources, 0 uses/30d'
    )
  })

  it('gives every status its line, and nothing for unknown', () => {
    expect(statusLine(m, 'ok', ok)).toBe('2 tools, 1 prompts, 3 resources')
    expect(statusLine(m, 'probing', 'probing')).toBe('Connecting…')
    expect(statusLine(m, 'needs-auth', undefined)).toBe('Needs authentication')
    expect(statusLine(m, 'error', undefined)).toBe('Error')
    expect(statusLine(m, 'off', undefined)).toBe('Off')
    expect(statusLine(m, 'unknown', undefined)).toBe('')
  })
})

describe('scanServerBlocks', () => {
  it('finds each server key→object range inside the wrapper', () => {
    const text = '{\n  "mcpServers": {\n    "a": { "command": "x" },\n    "b": { "url": "y" }\n  }\n}'
    const blocks = scanServerBlocks(text)

    expect(blocks.map(b => b.name)).toEqual(['a', 'b'])
    expect(text.slice(blocks[0].from, blocks[0].to)).toBe('"a": { "command": "x" }')
    expect(text.slice(blocks[1].from, blocks[1].to)).toBe('"b": { "url": "y" }')
  })

  it('walks a doc with no wrapper, and nested objects', () => {
    const text = '{"a":{"env":{"K":"}"}},"b":{}}'

    expect(scanServerBlocks(text).map(b => b.name)).toEqual(['a', 'b'])
    expect(text.slice(scanServerBlocks(text)[0].to)).toBe(',"b":{}}')
  })

  it('skips a non-object value and survives a half-typed doc', () => {
    expect(scanServerBlocks('{"mcpServers":{"a":1,"b":{}}}').map(b => b.name)).toEqual(['b'])
    expect(scanServerBlocks('{"mcpServers":{"a":{"command":"x"').map(b => b.name)).toEqual(['a'])
    expect(scanServerBlocks('not json')).toEqual([])
    expect(scanServerBlocks('')).toEqual([])
  })

  it('ignores a brace inside an escaped string', () => {
    expect(scanServerBlocks('{"a":{"args":["\\"}"]},"b":{}}').map(b => b.name)).toEqual(['a', 'b'])
  })
})

describe('filterStdioSections', () => {
  const lines = [
    'before',
    "===== [t] starting MCP server 'a' =====",
    'a-1',
    "===== [t] starting MCP server 'b' =====",
    'b-1',
    "  ===== [t] starting MCP server 'a' =====",
    'a-2'
  ]

  it('keeps the marker and the lines of the asked server only', () => {
    expect(filterStdioSections(lines, 'a')).toEqual([
      "===== [t] starting MCP server 'a' =====",
      'a-1',
      "  ===== [t] starting MCP server 'a' =====",
      'a-2'
    ])
    expect(filterStdioSections(lines, 'b')).toEqual(["===== [t] starting MCP server 'b' =====", 'b-1'])
    expect(filterStdioSections(lines, 'c')).toEqual([])
  })
})

describe('loadMcpUsage', () => {
  beforeEach(() => getUsageAnalytics.mockReset())

  it('maps the 30-day analytics into tool→count and caches it', async () => {
    getUsageAnalytics.mockResolvedValue({ tools: [{ count: 2, tool: 'a' }] })

    expect(await loadMcpUsage('scope-1', null)).toEqual({ a: 2 })
    expect(await loadMcpUsage('scope-1', null)).toEqual({ a: 2 })
    expect(getUsageAnalytics).toHaveBeenCalledTimes(1)
    expect(getUsageAnalytics).toHaveBeenCalledWith(30, null)
  })

  it('degrades to null — never an error UI — and caches nothing', async () => {
    getUsageAnalytics.mockRejectedValue(new Error('offline'))

    expect(await loadMcpUsage('scope-2', null)).toBeNull()

    getUsageAnalytics.mockResolvedValue({ tools: [] })

    expect(await loadMcpUsage('scope-2', null)).toEqual({})
    expect(getUsageAnalytics).toHaveBeenCalledTimes(2)
  })
})
