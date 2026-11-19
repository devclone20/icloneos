/**
 * v0.0.9 pass 4: a pool backend's runtime check never touches the primary's boot progress, not even transiently, and
 * the primary still reports its own steps (runtime-progress.ts).
 */
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ writes: [] as unknown[] }))

vi.mock('./boot-progress', () => ({
  advanceBootProgress: vi.fn(async (...args: unknown[]) => void h.writes.push(['advance', ...args])),
  updateBootProgress: vi.fn((update: unknown) => void h.writes.push(['update', update]))
}))

const { runtimeProgress } = await import('./runtime-progress')

describe('runtimeProgress', () => {
  it('a pool backend: no write at all (a ready primary never leaves ready, no running-then-ready flicker)', async () => {
    h.writes.length = 0
    const progress = runtimeProgress(false)

    await progress.advance('runtime.external', 'Using Hermes', 32)
    progress.update({ phase: 'runtime.ready', running: true })

    expect(h.writes).toEqual([])
  })

  it('the primary: its steps reach the boot progress', async () => {
    h.writes.length = 0
    const progress = runtimeProgress(true)

    await progress.advance('runtime.external', 'Using Hermes', 32)
    progress.update({ phase: 'runtime.ready', running: true })

    expect(h.writes).toEqual([
      ['advance', 'runtime.external', 'Using Hermes', 32],
      ['update', { phase: 'runtime.ready', running: true }]
    ])
  })
})
