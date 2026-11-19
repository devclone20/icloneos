/**
 * K124 (critic r2 m3, second half): the palette's lazy pane-registry load. One import is shared by every open; a failed
 * chunk import is not cached forever (the next open retries) and never escapes as an unhandled rejection.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { settingsPaneSearchRows } from './panes'
import { loadPaneSearchRows, resetPaneSearchRowsForTests } from './use-settings-search'

type Rows = typeof settingsPaneSearchRows

const rows = (() => []) as unknown as Rows

// r5: the real registry is every Settings pane; its first import transforms them all (4.1 s alone, past the 15 s test
// timeout under full-suite load in the r5 run). That transform is warmed here with its own budget, so the case below
// times only what it tests — the palette's default import resolving the registry — with its assertion unchanged.
beforeAll(async () => {
  await import('./panes')
}, 120_000)

afterEach(() => {
  resetPaneSearchRowsForTests()
  vi.restoreAllMocks()
})

describe('loadPaneSearchRows', () => {
  it('imports the registry once and hands every caller the same rows', async () => {
    const importPanes = vi.fn(async () => ({ settingsPaneSearchRows: rows }))

    await expect(loadPaneSearchRows(importPanes)).resolves.toBe(rows)
    await expect(loadPaneSearchRows(importPanes)).resolves.toBe(rows)
    expect(importPanes).toHaveBeenCalledTimes(1)
  })

  it('resolves null on a failed import, and the next call retries instead of replaying the failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const importPanes = vi
      .fn<() => Promise<{ settingsPaneSearchRows: Rows }>>()
      .mockRejectedValueOnce(new Error('chunk gone'))
      .mockResolvedValueOnce({ settingsPaneSearchRows: rows })

    await expect(loadPaneSearchRows(importPanes)).resolves.toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)

    await expect(loadPaneSearchRows(importPanes)).resolves.toBe(rows)
    expect(importPanes).toHaveBeenCalledTimes(2)
  })

  it('loads the real registry through the default import', async () => {
    const loaded = await loadPaneSearchRows()

    expect(typeof loaded).toBe('function')
  })
})
