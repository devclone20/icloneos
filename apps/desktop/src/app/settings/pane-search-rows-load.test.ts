/**
 * K124 (critic r2 m3, second half): the palette's lazy pane-registry load. One import is shared by every open; a failed
 * chunk import is not cached forever (the next open retries) and never escapes as an unhandled rejection.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { settingsPaneSearchRows } from './panes'
import { loadPaneSearchRows, resetPaneSearchRowsForTests } from './use-settings-search'

type Rows = typeof settingsPaneSearchRows

const rows = (() => []) as unknown as Rows

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
