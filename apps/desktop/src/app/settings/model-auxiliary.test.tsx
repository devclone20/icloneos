import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AuxiliaryModelsSection } from './model-auxiliary'

const props = () => ({
  applyAuxiliaryDraft: vi.fn(async () => {}),
  applying: false,
  auxDraft: { model: '', provider: '' },
  auxDraftProviderModels: [],
  auxiliary: null,
  auxiliaryTaskLabel: (task: string) => task,
  beginAuxiliaryEdit: vi.fn(),
  editingAuxTask: null,
  hasMainModel: true,
  persistentStaleAux: [],
  providerOptions: [],
  providersLoaded: true,
  resetAuxiliaryModels: vi.fn(async () => {}),
  setAuxDraft: vi.fn(),
  setAuxiliaryToMain: vi.fn(async () => {}),
  setEditingAuxTask: vi.fn(),
  switchStaleAux: []
})

describe('AuxiliaryModelsSection anatomy', () => {
  it('puts the section on THE row: one sentence, the hint under it, the reset at the trailing edge', () => {
    const p = props()
    render(<AuxiliaryModelsSection {...p} />)
    const title = screen.getByText('Put cheaper models on the small jobs, so the main one is kept for the real work')
    const row = title.closest('[data-setting-row]')
    expect(row).toBeTruthy()
    expect(row?.textContent).toContain('Helper tasks run on the main model by default.')
    const reset = screen.getByRole('button', { name: 'Reset all to main' })
    expect(row?.contains(reset)).toBe(true)
    fireEvent.click(reset)
    expect(p.resetAuxiliaryModels).toHaveBeenCalledOnce()
  })

  it('renders every helper task as a row with its assignment as the detail', () => {
    const { container } = render(<AuxiliaryModelsSection {...props()} />)
    const vision = screen.getByText('Which model reads images').closest('[data-setting-row]')
    expect(vision?.textContent).toContain('Same as the main model')
    expect(vision?.querySelectorAll('button')).toHaveLength(2)
    expect(container.querySelectorAll('[data-setting-row]').length).toBeGreaterThanOrEqual(9)
  })
})
