import { beforeEach, describe, expect, it } from 'vitest'

import type { UsageStats } from '@/types/hermes'

import { $usageSnapshots, rememberUsage, usageSnapshotFor } from './usage-snapshot'

const usage = (total: number): UsageStats => ({
  calls: 1,
  context_max: 1_000_000,
  context_used: total,
  input: total,
  output: 0,
  total
})

describe('usage snapshot per stored session (U2-p2-08)', () => {
  beforeEach(() => {
    localStorage.clear()
    $usageSnapshots.set({})
  })

  it('remembers the last usage by stored id and serves it when no runtime is live', () => {
    expect(usageSnapshotFor('s1')).toBeNull()
    rememberUsage('s1', usage(50_900))
    expect(usageSnapshotFor('s1')?.context_used).toBe(50_900)
    expect(usageSnapshotFor(null)).toBeNull()
  })

  it('survives in localStorage for the next launch', () => {
    rememberUsage('s2', usage(7))
    expect(JSON.parse(localStorage.getItem('iclone.context.usage') ?? '{}').s2.total).toBe(7)
  })
})
