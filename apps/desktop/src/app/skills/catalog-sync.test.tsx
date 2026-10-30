// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SkillInfo } from '@/types/hermes'

import type { SkillCatalog } from '../settings/skills-settings-model'

import { useSkillCatalogSync } from './catalog-sync'

/**
 * The catalog Re-sync, the counts + last-sync line and the standing
 * off-warning moved here from `Settings → Skills` with front K2, so the three
 * behaviours the retired pane's own suite proved are proven again here — on
 * the hook, which is where they live now.
 */
const entry = (name: string) => ({
  name,
  version: '1.0.0',
  description: 'Use when the task matches. More.',
  whenToOpen: 'Use when the task matches.',
  tags: [],
  relatedSkills: []
})

const CATALOG: SkillCatalog = {
  schema: 1,
  category: 'iclone',
  count: 2,
  skills: [entry('economyos'), entry('consent')]
}

const INSTALLED: SkillInfo[] = [
  { name: 'economyos', category: 'iclone', description: 'x', enabled: true, provenance: 'agent' },
  { name: 'consent', category: 'iclone', description: 'x', enabled: true, provenance: 'agent' },
  { name: 'github-pr', category: 'github', description: 'Open pull requests.', enabled: true, provenance: 'bundled' }
]

const bridge = { catalog: vi.fn(), last: vi.fn(), sync: vi.fn() }
const restartBackend = vi.fn()
const onSynced = vi.fn()

function Harness({ installed }: { installed: SkillInfo[] }) {
  const sync = useSkillCatalogSync(installed, onSynced)

  return (
    <div>
      <div data-testid="subtitle">{sync.subtitle}</div>
      <div data-testid="actions">{sync.actions}</div>
    </div>
  )
}

beforeEach(() => {
  bridge.catalog.mockResolvedValue(CATALOG)
  bridge.last.mockResolvedValue({ syncedAt: Date.now() - 5 * 60_000 })
  bridge.sync.mockResolvedValue({
    ok: true,
    written: ['/h/skills/iclone/DESCRIPTION.md'],
    errors: [],
    syncedAt: Date.now()
  })
  restartBackend.mockResolvedValue({ ok: true })
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { icloneSkills: bridge, restartBackend }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

describe('Capabilities → skill catalog sync', () => {
  it('states the group counts and the age of the last sync', async () => {
    render(<Harness installed={INSTALLED} />)

    await waitFor(() => expect(screen.getByText(/2 icloneOS · 1 upstream · 0 learned · 0 hub/)).toBeTruthy())
    expect(screen.getByText(/Last sync 5 min ago/)).toBeTruthy()
  })

  it('Re-sync calls the IPC, reports what it wrote and offers the backend restart', async () => {
    render(<Harness installed={INSTALLED} />)

    await waitFor(() => expect(bridge.catalog).toHaveBeenCalled())
    fireEvent.click(screen.getByText('Re-sync'))

    await waitFor(() => expect(screen.getByText('Restart agent')).toBeTruthy())
    expect(bridge.sync).toHaveBeenCalledTimes(1)
    expect(onSynced).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/1 file updated/)).toBeTruthy()

    fireEvent.click(screen.getByText('Restart agent'))
    await waitFor(() => expect(screen.getByText(/Agent restarted with the new skills/)).toBeTruthy())
    expect(restartBackend).toHaveBeenCalledTimes(1)
  })

  it('an unchanged Re-sync does not offer a restart', async () => {
    bridge.sync.mockResolvedValue({ ok: true, written: [], errors: [], syncedAt: Date.now() })
    render(<Harness installed={INSTALLED} />)

    await waitFor(() => expect(bridge.catalog).toHaveBeenCalled())
    fireEvent.click(screen.getByText('Re-sync'))

    await waitFor(() => expect(screen.getByText(/already holds this version/)).toBeTruthy())
    expect(screen.queryByText('Restart agent')).toBeNull()
  })

  it('warns standing when a runtime-named skill is off, not only as it is turned off', async () => {
    render(<Harness installed={INSTALLED.map(s => (s.name === 'consent' ? { ...s, enabled: false } : s))} />)

    await waitFor(() => expect(screen.getByText(/rely on .*off or missing: consent/)).toBeTruthy())

    // The retired pane painted this warning and named it for assistive tech;
    // both survived the move (the tone as an attribute `skills-page.css`
    // paints, the sentence as the live region's label).
    const standing = screen.getByRole('status')
    expect(standing.hasAttribute('data-ic-sync-warning')).toBe(true)
    expect(standing.getAttribute('aria-label')).toMatch(/off or missing: consent/)
  })

  it('marks a failed Re-sync with the warn tone the stylesheet paints', async () => {
    bridge.sync.mockRejectedValue(new Error('disk full'))
    render(<Harness installed={INSTALLED} />)

    await waitFor(() => expect(bridge.catalog).toHaveBeenCalled())
    fireEvent.click(screen.getByText('Re-sync'))

    await waitFor(() => expect(screen.getByText(/Sync failed: disk full/)).toBeTruthy())
    expect(screen.getByTestId('subtitle').querySelector("[data-ic-sync-notice='warn']")).toBeTruthy()
  })

  it('offers nothing at all when the desktop bridge is absent', () => {
    delete (window as { hermesDesktop?: unknown }).hermesDesktop
    render(<Harness installed={INSTALLED} />)

    expect(screen.getByTestId('actions').textContent).toBe('')
    expect(screen.getByTestId('subtitle').textContent).toBe('')
  })
})

// V3-B — a ported skill this machine cannot run is named in the subtitle with what it lacks, standing.
describe('Capabilities → ported skills that need something (V3-B)', () => {
  it('names the skill and what it lacks, with the warning tone; says nothing when every port runs here', async () => {
    bridge.catalog.mockResolvedValue({
      ...CATALOG,
      count: 3,
      skills: [
        ...CATALOG.skills,
        {
          ...entry('ridervoice'),
          port: {
            version: '1.0.0',
            portedAt: '2026-10-21T10:00:00.000Z',
            requires: { os: ['macos'], bins: ['ffmpeg'], mcp: [], paths: ['$RIDERVOICE_HOME'] },
            touches: ['X'],
            needs: [
              { kind: 'bin', name: 'ffmpeg' },
              { kind: 'path', name: '$RIDERVOICE_HOME' }
            ]
          }
        }
      ]
    })
    render(<Harness installed={INSTALLED} />)

    await waitFor(() => expect(screen.getByText(/ridervoice \(ffmpeg, \$RIDERVOICE_HOME\)/)).toBeTruthy())
    const line = screen.getByText(/1 skill from your library needs something this machine lacks/)
    expect(line.getAttribute('data-ic-sync-warning')).toBe('')
    expect(line.getAttribute('data-ic-sync-needs')).toBe('')
    expect(line.getAttribute('role')).toBe('status')
  })

  it('shows no needs line when nothing is missing', async () => {
    render(<Harness installed={INSTALLED} />)

    await waitFor(() => expect(screen.getByText(/2 icloneOS/)).toBeTruthy())
    expect(screen.queryByText(/from your library/)).toBeNull()
    expect(screen.queryByText(/invalid manifest/)).toBeNull()
  })

  it('F8: a bundled skill with an invalid manifest.json is named on the page line and on its own row note', async () => {
    bridge.catalog.mockResolvedValue({
      ...CATALOG,
      count: 3,
      skills: [...CATALOG.skills, { ...entry('badport'), manifestProblem: 'schema 2 ≠ 1' }]
    })

    let notes: ReadonlyMap<string, string> = new Map()

    function NotesHarness() {
      const sync = useSkillCatalogSync(INSTALLED, onSynced)
      notes = sync.rowNotes

      return <div data-testid="subtitle">{sync.subtitle}</div>
    }

    render(<NotesHarness />)

    await waitFor(() => expect(screen.getByText(/badport \(schema 2 ≠ 1\)/)).toBeTruthy())
    const line = screen.getByText(/1 skill carries an invalid manifest\.json/)
    expect(line.getAttribute('data-ic-sync-manifest')).toBe('')
    expect(line.getAttribute('data-ic-sync-warning')).toBe('')
    expect(line.getAttribute('role')).toBe('status')
    expect(notes.get('badport')).toBe('manifest.json invalid — schema 2 ≠ 1')
    expect(notes.get('economyos')).toBeUndefined()
  })
})
