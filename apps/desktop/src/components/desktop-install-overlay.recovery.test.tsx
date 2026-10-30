// @vitest-environment jsdom
// RTB-6 / RTB-7: the install overlay shows every package as its own line, and every failure class ends in a plain
// diagnosis, ONE fix the app can do, or "Skip for now" — never in a dead card.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DesktopBootstrapEvent, DesktopBootstrapState } from '@/global'
import { translateNow } from '@/i18n'
import { $agentRuntimeSkipped, $installOverlayOwnsFailure } from '@/store/agent-runtime'
import { $desktopBoot } from '@/store/boot'

import { DesktopInstallOverlay } from './desktop-install-overlay'

const rt8h = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '../iclone-shared/__fixtures__/rt8h-python-deps.json'), 'utf8')
) as { log: { line: string; stage: string; ts: number }[] }

const STAGES = ['prerequisites', 'repository', 'venv', 'python-deps', 'config', 'complete'].map(name => ({ name }))

function idle(): DesktopBootstrapState {
  return {
    active: false,
    completedAt: null,
    error: null,
    log: [],
    manifest: null,
    setupChoice: null,
    stages: {},
    startedAt: null,
    unsupportedPlatform: null
  }
}

async function mount() {
  const listeners = new Set<(event: DesktopBootstrapEvent) => void>()

  const desktop = {
    agentRuntime: {
      installAgain: vi.fn().mockResolvedValue({ ok: true }),
      onChange: vi.fn(() => () => undefined),
      openFix: vi.fn().mockResolvedValue({ ok: true }),
      skip: vi.fn().mockResolvedValue({ ok: true }),
      status: vi.fn()
    },
    getBootstrapState: vi.fn().mockResolvedValue(idle()),
    onBootstrapEvent: vi.fn((listener: (event: DesktopBootstrapEvent) => void) => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    }),
    repairBootstrap: vi.fn().mockResolvedValue({ ok: true }),
    resetBootstrap: vi.fn().mockResolvedValue({ ok: true })
  }

  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: desktop })
  const reload = vi.fn()
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } })
  render(<DesktopInstallOverlay />)
  // Let the mount snapshot land before the live events (as main's snapshot precedes its later events).
  await act(async () => {})

  const emit = (event: DesktopBootstrapEvent) =>
    act(() => {
      for (const listener of listeners) {
        listener(event)
      }
    })

  return { desktop, emit, reload }
}

const pkg = (name: string) => window.document.querySelector(`[data-package="${name}"]`)

async function failWith(
  emit: Awaited<ReturnType<typeof mount>>['emit'],
  stage: string,
  lines: string[],
  error: string
) {
  await emit({ type: 'manifest', protocolVersion: 1, stages: STAGES })
  await emit({ type: 'stage', name: stage, state: 'running' })

  for (const line of lines) {
    await emit({ type: 'log', stage, line })
  }

  await emit({ type: 'stage', name: stage, state: 'failed', error })
  await emit({ type: 'failed', stage, error: `Hermes bootstrap failed at stage '${stage}': ${error}` })
}

afterEach(() => {
  cleanup()
  $installOverlayOwnsFailure.set(false)
  $agentRuntimeSkipped.set(false)
})

describe('per-package lines (RTB-7, owner override: the user sees everything being installed)', () => {
  it('replays the real first-launch output: one line per package, each ending done', async () => {
    const { emit } = await mount()
    await emit({ type: 'manifest', protocolVersion: 1, stages: STAGES })
    await emit({ type: 'stage', name: 'python-deps', state: 'running' })

    expect(pkg('agent-browser')?.getAttribute('data-state')).toBe('waiting')

    for (const entry of rt8h.log.slice(0, 60)) {
      await emit({ type: 'log', stage: 'python-deps', line: entry.line })
    }

    // Mid-run: earlier packages done, the current one shows its own progress.
    expect(pkg('ffmpeg')?.getAttribute('data-state')).toBe('done')

    for (const entry of rt8h.log.slice(60)) {
      await emit({ type: 'log', stage: 'python-deps', line: entry.line })
    }

    await emit({ type: 'stage', name: 'python-deps', state: 'succeeded', durationMs: 29_688 })

    for (const name of ['ffmpeg', 'node', 'npm', 'python', 'ripgrep', 'venv', 'agent-browser', 'cua-driver']) {
      expect(pkg(name)?.getAttribute('data-state'), name).toBe('done')
    }
  })

  it('a download in progress shows its percent and sizes', async () => {
    const { emit } = await mount()
    await emit({ type: 'manifest', protocolVersion: 1, stages: STAGES })
    await emit({ type: 'stage', name: 'python-deps', state: 'running' })
    await emit({ type: 'log', stage: 'python-deps', line: '  agent-browser:  78.3%  127.2 MiB / 162.3 MiB' })

    expect(pkg('agent-browser')?.getAttribute('data-state')).toBe('downloading')
    expect(pkg('agent-browser')?.textContent).toContain('78.3 % · 127.2 MiB / 162.3 MiB')
  })
})

describe('every failure class: diagnosis, one fix, or skip (RTB-6)', () => {
  const classes: [string, string, string[], string, string][] = [
    ['network', 'python-deps', ['error: Could not resolve host: files.pythonhosted.org'], 'exit code 1', 'retry'],
    ['integrity', 'repository', [], 'sha256 mismatch for the runtime tarball', 'repair'],
    [
      'disk',
      'python-deps',
      ['OSError: [Errno 28] No space left on device (needs 1.2 GiB)'],
      'exit code 1',
      'open-storage-settings'
    ],
    ['permission', 'venv', [], "EACCES: permission denied, mkdir '/x'", 'reveal-folder'],
    ['resolver', 'python-deps', ['  × Failed to build `pyaudio==0.2.14`'], 'exit code 1', 'repair'],
    ['interpreter', 'venv', ['bash: python3.14: command not found'], 'exit code 127', 'repair'],
    ['killed', 'python-deps', [], 'install.sh --stage python-deps produced no JSON result frame (exit=137)', 'retry'],
    [
      'stalled',
      'python-deps',
      [],
      '[iclone-install-watchdog] no progress (output, CPU or bytes written) for 120 s',
      'retry'
    ],
    ['slow', 'python-deps', [], '[iclone-install-watchdog] ceiling 900 s reached', 'retry'],
    ['unknown', 'config', ['something odd'], 'exit code 3', 'repair']
  ]

  it.each(classes)(
    '%s: plain words, the fix button, skip; the raw error only under Show details',
    async (cls, stage, lines, error, fix) => {
      const { emit } = await mount()
      await failWith(emit, stage, lines, error)

      const block = window.document.querySelector('[data-diagnosis]')
      expect(block?.getAttribute('data-diagnosis')).toBe(cls)
      expect(block?.textContent).toContain(translateNow(`install.recovery.diagnosis.${cls}` as never))
      expect(window.document.querySelector('[data-action="skip"]')).not.toBeNull()
      expect(window.document.querySelector(`[data-action="${fix}"]`)).not.toBeNull()
      // Diagnosis first: the raw error is not on screen until the user opens the details.
      expect(window.document.body.textContent).not.toContain(error)
      fireEvent.click(screen.getByText(translateNow('install.recovery.showDetails')))
      expect(window.document.body.textContent).toContain(error)
      // The install overlay owns this failure; the post-install card stays down.
      expect($installOverlayOwnsFailure.get()).toBe(true)
    }
  )

  it('Retry resumes: main clears the latch, then the renderer reloads (no silent loop)', async () => {
    const { desktop, emit, reload } = await mount()
    await failWith(emit, 'python-deps', ['Could not resolve host: pypi.org'], 'exit code 1')
    fireEvent.click(window.document.querySelector('[data-action="retry"]')!)
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(desktop.resetBootstrap).toHaveBeenCalledTimes(1)
    expect(desktop.repairBootstrap).not.toHaveBeenCalled()
  })

  it('Repair forces a fresh install', async () => {
    const { desktop, emit, reload } = await mount()
    await failWith(emit, 'repository', [], 'sha256 mismatch')
    fireEvent.click(window.document.querySelector('[data-action="repair"]')!)
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(desktop.repairBootstrap).toHaveBeenCalledTimes(1)
  })

  it('Free disk space opens Storage settings, names the amount, then becomes Retry now', async () => {
    const { desktop, emit } = await mount()
    await failWith(emit, 'python-deps', ['No space left on device: needs 1.5 GiB'], 'exit code 1')
    const button = window.document.querySelector('[data-action="open-storage-settings"]')!
    expect(button.textContent).toMatch(/1\.(5|6) GB|1\.5 GiB/)
    fireEvent.click(button)
    await waitFor(() => expect(window.document.querySelector('[data-action="retry"]')).not.toBeNull())
    expect(desktop.agentRuntime.openFix).toHaveBeenCalledWith('open-storage-settings')
    expect(window.document.querySelector('[data-action="retry"]')?.textContent).toBe(
      translateNow('install.recovery.retryNow')
    )
  })

  it('Skip for now records the skip, ends the boot without the agent, and the overlay goes away', async () => {
    const { desktop, emit } = await mount()
    await failWith(emit, 'python-deps', ['Could not resolve host: pypi.org'], 'exit code 1')
    fireEvent.click(window.document.querySelector('[data-action="skip"]')!)
    await waitFor(() => expect(window.document.querySelector('[data-diagnosis]')).toBeNull())
    expect(desktop.agentRuntime.skip).toHaveBeenCalledTimes(1)
    expect($agentRuntimeSkipped.get()).toBe(true)
    expect($installOverlayOwnsFailure.get()).toBe(false)
    expect($desktopBoot.get()).toMatchObject({ error: null, phase: 'renderer.skipped', running: false, visible: false })
  })

  it('a package that failed inside the stage is named', async () => {
    const { emit } = await mount()
    await failWith(
      emit,
      'python-deps',
      ['  cua-driver:  18.9%  12.0 MiB / 63.6 MiB', '✗ cua-driver: download failed: Connection reset by peer'],
      'exit code 1'
    )

    expect(window.document.querySelector('[data-diagnosis]')?.textContent).toContain(
      translateNow('install.recovery.failedIn', 'cua-driver')
    )
    expect(pkg('cua-driver')?.getAttribute('data-state')).toBe('failed')
  })

  it('plain macOS copy (critic minor 2): no Windows text, no Windows path, no "venv", plain stage names', async () => {
    const { emit } = await mount()
    // G-01 r4: the Python environment row is failed by its own ✗ (PM names it), never by a fallback.
    await failWith(
      emit,
      'python-deps',
      ['✓ ffmpeg', '  → Installing Python dependencies…', '✗ venv: tools not on PATH before venv sync: uv'],
      'exit code 1'
    )
    const text = window.document.body.textContent ?? ''

    expect(text).not.toMatch(/Windows|LOCALAPPDATA/)
    expect(text).not.toMatch(/\bvenv\b|Python deps\b/)
    expect(text).toContain(translateNow('install.recovery.stageNames.python-deps' as never))
    expect(text).toContain(
      translateNow('install.recovery.failedIn', translateNow('install.recovery.pythonEnvironment'))
    )
    // An unexplained failure's one fix is Repair, so the header names Repair (r2c).
    expect(text).toContain(translateNow('install.recovery.failedDescRepair'))
  })

  it('G-01 r4: a ✗ that names no package is shown in the failure card; unfinished rows read Stopped', async () => {
    const { emit } = await mount()
    await failWith(
      emit,
      'python-deps',
      ['✓ ffmpeg', '  node: verifying', '  ✗ uv sync failed; last 3 lines of output follow'],
      'exit code 1'
    )

    expect(window.document.querySelector('[data-unattributed]')?.textContent).toBe(
      translateNow('install.recovery.unattributed', 'uv sync failed; last 3 lines of output follow')
    )
    expect(pkg('ffmpeg')?.getAttribute('data-state')).toBe('done')
    expect(pkg('node')?.getAttribute('data-state')).toBe('stopped')
    expect(pkg('node')?.textContent).toContain(translateNow('install.recovery.packageStates.stopped'))
    expect(window.document.querySelector('[data-package][data-state="failed"]')).toBeNull()
  })

  it('G-01 r5: a failed venv sync names the Python environment and leaves no nameless line', async () => {
    const { emit } = await mount()

    const fixture = readFileSync(
      path.join(import.meta.dirname, '..', 'iclone-shared', '__fixtures__', 'venv-sync-failure.txt'),
      'utf8'
    )

    await failWith(
      emit,
      'python-deps',
      ['✓ ffmpeg', '✓ ripgrep', ...fixture.split('\n').filter(Boolean)],
      'exit code 1'
    )

    expect(pkg('venv')?.getAttribute('data-state')).toBe('failed')
    expect(window.document.querySelector('[data-diagnosis]')?.textContent).toContain(
      translateNow('install.recovery.failedIn', translateNow('install.recovery.pythonEnvironment'))
    )
    expect(window.document.querySelector('[data-unattributed]')).toBeNull()
  })

  it('G-01 r5: a repair reads Repairing until its first size is known, then its percent and sizes', async () => {
    const { emit } = await mount()
    await emit({ type: 'manifest', protocolVersion: 1, stages: STAGES })
    await emit({ type: 'stage', name: 'python-deps', state: 'running' })
    await emit({ type: 'log', stage: 'python-deps', line: '  node: repairing' })

    expect(pkg('node')?.getAttribute('data-state')).toBe('downloading')
    expect(pkg('node')?.textContent).toContain(translateNow('install.recovery.packageStates.repairing'))
    expect(pkg('node')?.textContent).not.toContain('%')

    await emit({ type: 'log', stage: 'python-deps', line: '  node:  12.0%  3.5 MiB / 28.8 MiB' })

    expect(pkg('node')?.textContent).toContain('12.0 % · 3.5 MiB / 28.8 MiB')
  })

  it("main's stage-alive heartbeats change nothing on screen", async () => {
    const { emit } = await mount()
    await emit({ type: 'manifest', protocolVersion: 1, stages: STAGES })
    await emit({ type: 'stage', name: 'python-deps', state: 'running' })
    const before = window.document.body.textContent
    await emit({ type: 'stage-alive', stage: 'python-deps', idleMs: 30_000 })
    expect(window.document.body.textContent).toBe(before)
  })

  it('r2b: the button says the same words as the text ("Try again"), and installer reasons sit under Show details', async () => {
    const { emit } = await mount()
    const reason = 'source tarball install: git and the Command Line Tools are not needed'
    await failWith(emit, 'python-deps', ['Could not resolve host: pypi.org'], 'exit code 1')
    await emit({
      type: 'stage',
      name: 'prerequisites',
      state: 'skipped',
      json: { ok: true, reason, skipped: true, stage: 'prerequisites' }
    })

    expect(window.document.body.textContent).not.toContain(reason)
    expect(window.document.querySelector('[data-action="retry"]')?.textContent).toBe(
      translateNow('install.recovery.fixRetry')
    )
    expect(translateNow('install.recovery.failedDesc')).toContain(translateNow('install.recovery.fixRetry'))
    fireEvent.click(screen.getByText(translateNow('install.recovery.showDetails')))
    expect(window.document.body.textContent).toContain(reason)
  })

  it('r2c (minor A): a repair-class failure says Repair in its header, a retry-class failure says Try again', async () => {
    const { emit } = await mount()
    await failWith(emit, 'repository', [], 'sha256 mismatch for the runtime tarball')
    const text = window.document.body.textContent ?? ''

    expect(window.document.querySelector('[data-action="repair"]')).not.toBeNull()
    expect(text).toContain(translateNow('install.recovery.failedDescRepair'))
    expect(text).not.toContain(translateNow('install.recovery.failedDesc'))
  })

  it('r2c: a retry-class failure has the Try again header and no Windows text', async () => {
    const { emit } = await mount()
    await failWith(emit, 'python-deps', ['error: Could not resolve host: files.pythonhosted.org'], 'exit code 1')
    const text = window.document.body.textContent ?? ''

    expect(text).toContain(translateNow('install.recovery.failedDesc'))
    expect(text).not.toMatch(/Windows|LOCALAPPDATA/)
  })
})
