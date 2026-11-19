/**
 * v0.0.9 Q (tests-perf 4): Repair and Undo in Settings › Diagnostics move files, so main runs them only for a click on
 * the control the preload's owner-click lock recognises (`data-repair-kit-confirm`). No test rendered this pane, so a
 * refactor dropping the attribute stayed green while every real Repair / Undo was refused `gesture:false`. The selector
 * is read from preload.ts itself.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { f3Kit } from '@/i18n/en/v009-f3'

import { REPAIR_KIT_CONFIRM_ATTR } from '../../../electron/repair-kit/types'

import { RepairKitSection } from './diagnostics-settings-repair-kit'

const preload = readFileSync(resolve(__dirname, '../../../electron/preload.ts'), 'utf8')
const selector = preload.match(/closest\('(\[data-repair-kit-confirm\])'\)/)?.[1]

beforeEach(() => {
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {
    icloneRepairKit: {
      apply: vi.fn(async () => null),
      history: vi.fn(async () => [
        { classId: 'stale-install-record', createdAt: '2026-11-14T10:00:00Z', id: 'm1', undoable: true, undoneAt: null }
      ]),
      scan: vi.fn(async () => [{ classId: 'stale-install-record', facts: ['~/.hermes/installs/abc'], status: 'found' }]),
      undo: vi.fn(async () => null)
    }
  }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('Diagnostics › Repair kit owner-click markers', () => {
  it('the preload lock and the pane agree on the marker', () => {
    expect(selector).toBe(`[${REPAIR_KIT_CONFIRM_ATTR}]`)
  })

  it('Repair and Undo carry it; Preview (a dry run) and Check do not', async () => {
    await act(async () => {
      render(<RepairKitSection />)
    })
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: f3Kit.check })))

    expect(screen.getByRole('button', { name: f3Kit.repair }).matches(selector!)).toBe(true)
    expect(screen.getByRole('button', { name: f3Kit.undo }).matches(selector!)).toBe(true)
    expect(screen.getByRole('button', { name: f3Kit.preview }).matches(selector!)).toBe(false)
    expect(screen.getByRole('button', { name: f3Kit.check }).matches(selector!)).toBe(false)
  })
})
