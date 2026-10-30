/**
 * K-RT3 (V3-RT): the upstream "agent latest" door is closed while the runtime is built from this repository, main
 * refuses it before anything else, and the compat lock no longer lists the chain JSON-RPC client's eth_* names as
 * Hermes methods (UT1 lesson 1: that false positive flagged the release's own pin RED).
 */
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { AGENT_UPDATE_DOOR_OPEN } from '../src/iclone-shared/update-status'

import { agentUpdateDoorOpen } from './agent-update'
import { RUNTIME_LOCK } from './iclone-compat/lock.generated'
import { RUNTIME_PIN } from './runtime-pin.generated'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

describe('K-RT3: the agent-latest door', () => {
  it('is closed: the bundled runtime is this repository build, and the renderer flag agrees', () => {
    expect(RUNTIME_PIN.source).toBe('repo')
    expect(agentUpdateDoorOpen()).toBe(false)
    expect(AGENT_UPDATE_DOOR_OPEN).toBe(false)
    // A repo pin closes it whatever the flag says.
    expect(agentUpdateDoorOpen({ source: 'repo' })).toBe(false)
  })

  it('main refuses the check and the apply first, before any network, file or gesture work', () => {
    const source = read('apps/desktop/electron/main/agent-update.ts')

    for (const fn of ['checkAgentLatestNow', 'applyAgentUpdate']) {
      const body = source.slice(source.indexOf(`export async function ${fn}(`))
      const firstStatement = body.slice(body.indexOf('{') + 1).trimStart()

      expect(firstStatement.startsWith('if (!agentUpdateDoorOpen()) {'), fn).toBe(true)
    }

    expect(source).toContain("error: 'door-closed'")
  })
})

describe('K-RT3: the eth_* false positive (UT1 lesson 1)', () => {
  it('no eth_* JSON-RPC name is a locked Hermes method', () => {
    const methods = Object.keys(RUNTIME_LOCK.methods)
    const lock = JSON.parse(read('iclone/contract/runtime.lock.json')) as { methods: Record<string, unknown> }

    expect(methods.filter(name => /^eth_/.test(name))).toEqual([])
    expect(Object.keys(lock.methods).filter(name => /^eth_/.test(name))).toEqual([])
  })

  it('the ownership proof and wallet JSON-RPC clients are excluded as sinks by name, each with its reason', () => {
    const allow = JSON.parse(read('iclone/contract/extract-allow.json')) as {
      sinks: { file: string; fn: string; reason: string }[]
    }

    expect(allow.sinks.map(sink => `${sink.file}#${sink.fn}`).sort()).toEqual([
      'electron/iclone-ownership-proof.ts#all',
      'electron/iclone-ownership-proof.ts#first',
      'electron/iclone-ownership-proof.ts#raw',
      'electron/iclone-privy.ts#rpcCall'
    ])
    expect(allow.sinks.every(sink => /JSON-RPC client .* never speaks to the runtime/.test(sink.reason))).toBe(true)
  })

  it('the pin verdict is the one the extractor computed for the pinned commit (never a hand-typed one)', () => {
    const lock = JSON.parse(read('iclone/contract/runtime.lock.json')) as {
      verifiedAgainst: { result: string; rev: string }
    }

    expect(lock.verifiedAgainst.rev).toBe(RUNTIME_PIN.sha)
    expect(RUNTIME_PIN.verified).toBe(lock.verifiedAgainst.result)
    expect(lock.verifiedAgainst.result).not.toMatch(/^red:/)
  })
})
