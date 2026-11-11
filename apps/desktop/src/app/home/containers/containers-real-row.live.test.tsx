/**
 * fx16: the Containers pane against rows the real launcher wrote. The pane's other tests use hand-written rows; here
 * each row comes from launcher.py through the real parser and fold in runs.ts, so a change to the launcher's row shape,
 * or to the parser, shows up as a pane that says the wrong thing.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { $confinement } from '@/store/confinement'

import { foldAllRuns, parseRunLine, readRunEvents, type RunEvent } from '../../../../electron/iclone-confinement/runs'
import { allowableFolder } from '../../../../electron/iclone-permissions/ipc'
import type * as Window from '../window'

import { ContainersWindow } from './containers-app'
import { CONFINEMENT_COPY } from './containers-copy'
import { $containersOpen } from './containers-dock'
import { fixtureState } from './containers-fixtures'

vi.mock('../window', async importOriginal => ({
  ...(await importOriginal<typeof Window>()),
  IcWindow: ({ children, head, id }: { children: React.ReactNode; head: React.ReactNode; id: string }) => (
    <div data-ic-window={id}>
      <header>{head}</header>
      {children}
    </div>
  )
}))

const L = CONFINEMENT_COPY.en.ledger

// Rows the real launcher wrote: the Python test world (tests/plugins/test_iclone_launcher.py World) starts the real
// `Launcher` with its real validator and journal on a socket, behind the real stub, with a stand-in for sandbox-exec.
// The rows are the launcher's own; only the kernel is absent.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..')

const DRIVER = String.raw`
import json, subprocess, sys, time
sys.path.insert(0, sys.argv[1])
from tests.plugins.test_iclone_launcher import World, _flags
w = World()
w.start()
def wait_rows(count):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline and len(w.journal()) < count:
        time.sleep(0.02)
    assert len(w.journal()) >= count, w.journal()
def run(marker, **flags):
    before = len(w.journal())
    subprocess.run(w.stub(w.argv(["/bin/sh", "-c", ": " + marker], params=_flags(w, **flags))),
                   capture_output=True, timeout=30)
    return before
w.policy("acceptEdits", listed=[])
wait_rows(run("real-unlisted", write="1", net="0") + 2)
w.policy("manual")
wait_rows(run("real-needs-allow", write="1", net="0") + 2)
# fx25: the two states a read after a cd to a sibling can be in, Manual both. Unlisted (proof7), and listed for as long
# as an allowed write_file ask named the folder, with no pass that lifts project writes (proof8).
w.policy("manual", listed=[])
wait_rows(run("real-after-cd-unlisted", write="1", net="0") + 2)
w.policy("manual", listed=[str(w.proj)], asked=[str(w.proj)])
wait_rows(run("real-after-cd-asked", write="1", net="0") + 2)
w.policy("acceptEdits")
wait_rows(run("real-needs-network", write="0", net="1") + 2)
w.policy("manual")
wait_rows(run("real-two-flags", write="1", net="1") + 2)
w.policy("plan")
run("real-refused", write="1", net="0")
deadline = time.monotonic() + 15
while time.monotonic() < deadline and not w.refused():
    time.sleep(0.02)
assert w.refused()
# Automatic, then Manual: the watch stops a live run that holds project writes by the mode alone.
w.policy("automatic")
started = len(w.journal())
beat = w.root / "beat"
proc = subprocess.Popen(w.stub(w.argv(["/bin/sh", "-c", ": real-stopped; echo x > '%s'; sleep 30" % beat],
                                      params=_flags(w, write="1", net="0"))),
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
deadline = time.monotonic() + 15
while time.monotonic() < deadline and not beat.exists():
    time.sleep(0.02)
assert beat.exists()
w.policy("manual")
proc.wait(timeout=20)
deadline = time.monotonic() + 15
while time.monotonic() < deadline and not any(r["ev"] == "end" for r in w.journal()[started:]):
    time.sleep(0.02)
w.launcher.stop()
w.launcher = None
print(json.dumps({"root": str(w.root), "ledger": str(w.ledger), "project": str(w.proj), "home": str(w.home)}))
`

interface RealLauncherRows {
  root: string
  ledger: string
  project: string
  home: string
  dispose: () => void
}

/** Runs the driver once and leaves the ledger on disk until `dispose`. Throws if the repo's venv has no Python. */
function realLauncherRows(): RealLauncherRows {
  const python = path.join(REPO, 'venv', 'bin', 'python')

  if (!existsSync(python)) {
    throw new Error(`real launcher rows need the repo's venv: ${python}`)
  }

  const out = execFileSync(python, ['-B', '-c', DRIVER, REPO], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    timeout: 90_000
  })

  const facts = JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as Omit<RealLauncherRows, 'dispose'>

  return { ...facts, dispose: () => rmSync(facts.root, { recursive: true, force: true }) }
}

let rows: RealLauncherRows
let events: RunEvent[]

beforeAll(() => {
  rows = realLauncherRows()
  events = readRunEvents({
    ledgerDir: rows.ledger,
    refusedDir: path.join(rows.root, 'no-runtime-refusals'),
    stopsFile: path.join(rows.root, 'no-stops.jsonl')
  })
}, 120_000)

afterAll(() => rows?.dispose())

const views = () =>
  foldAllRuns({ nowMs: Date.now(), events, rows: [], verified: true, refusals: new Map() })

const view = (marker: string) => {
  const found = views().find(run => run.command.includes(marker))

  if (!found) {
    throw new Error(`no view for ${marker}: ${views().map(run => run.command).join(' | ')}`)
  }

  return found
}

const allowFolder = vi.fn(async (_folder: string): Promise<{ ok: boolean } | null> => ({ ok: true }))

const bridge = {
  state: vi.fn(),
  kill: vi.fn(),
  explain: vi.fn(async () => []),
  ackHardlink: vi.fn(),
  stopRun: vi.fn(),
  allowFolder,
  onChanged: vi.fn(() => () => undefined)
}

beforeEach(() => {
  Object.assign(window, { hermesDesktop: { ...(window.hermesDesktop ?? {}), icloneConfinement: bridge } })
  $confinement.set({ status: 'loading', state: null, error: null })
  $containersOpen.set(true)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function open(marker: string) {
  const run = view(marker)

  bridge.state.mockImplementation(async () => fixtureState({ runs: [run], refusals: [], agents: [] }))
  render(<ContainersWindow blocked={false} />)
  await screen.findByText('Confined')

  return { run, row: window.document.querySelector<HTMLElement>(`[data-run="${run.id}"]`)! }
}

describe('the rows as launcher.py writes them', () => {
  it('have the fields the pane contract names, spelled as the launcher spells them', () => {
    const lines = readFileSync(path.join(rows.ledger, 'runs.jsonl'), 'utf8').trim().split('\n')
    const narrowed = lines.map(line => JSON.parse(line) as Record<string, unknown>).filter(row => row.narrowed)

    expect(narrowed.map(row => row.narrowed)).toEqual([true, true, true, true, true, true])
    expect(narrowed.map(row => row.narrowed_why)).toEqual([
      'unlisted-folder',
      'needs-allow',
      'unlisted-folder',
      'needs-allow',
      'needs-network',
      'needs-allow'
    ])
    expect(narrowed.every(row => row.project === rows.project)).toBe(true)

    for (const line of lines) {
      expect(parseRunLine(line, 'launcher'), line).not.toBeNull()
    }
  })
})

describe('the pane reads them true', () => {
  it('unlisted: read-only, for its own reason, and the button offers the folder main will accept', async () => {
    const { run, row } = await open('real-unlisted')

    expect(run).toMatchObject({ narrowed: true, narrowedWhy: 'unlisted-folder', writeProject: false })
    expect(run.projectRoot).toBe(rows.project)

    const note = row.querySelector('[data-narrowed="unlisted-folder"]')

    expect(note?.textContent).toContain(L.narrowed.lead['unlisted-folder'])
    expect(note?.textContent).toContain(L.narrowed.why['unlisted-folder'])
    expect(row.querySelector('[data-allow-folder]')?.getAttribute('data-allow-folder')).toBe(rows.project)
    // The folder the launcher names passes the real handler's own check, spelled exactly as the row spells it.
    expect(allowableFolder(run.projectRoot, { home: rows.home, userDataDir: path.join(rows.root, 'ud') })).toEqual({
      ok: true,
      real: rows.project
    })

    fireEvent.click(screen.getByRole('button', { name: L.narrowed.allow }))
    expect(allowFolder).toHaveBeenCalledWith(rows.project)
    await waitFor(() => expect(row.textContent).toContain(L.narrowed.allowedAsks))
  })

  it('needs an allow: read-only, and no button (a click in the pane is not how Manual allows)', async () => {
    const { run, row } = await open('real-needs-allow')

    expect(run).toMatchObject({ narrowed: true, narrowedWhy: 'needs-allow', writeProject: false })
    expect(row.querySelector('[data-narrowed="needs-allow"]')?.textContent).toContain(L.narrowed.why['needs-allow'])
    expect(row.querySelector('[data-allow-folder]')).toBeNull()
  })

  it('fx25: Manual, a folder nobody listed: the read after a cd offers it, as proof7 saw', async () => {
    const { run, row } = await open('real-after-cd-unlisted')

    expect(run).toMatchObject({ narrowed: true, narrowedWhy: 'unlisted-folder' })
    expect(row.querySelector('[data-allow-folder]')?.getAttribute('data-allow-folder')).toBe(rows.project)
  })

  it('fx25: Manual, a folder an allowed ask listed: needs-allow, no button, and the words say the next ask', async () => {
    const { run, row } = await open('real-after-cd-asked')

    expect(run).toMatchObject({ narrowed: true, narrowedWhy: 'needs-allow' })
    expect(row.querySelector('[data-allow-folder]')).toBeNull()
    expect(row.textContent).toContain('Allow the next ask')
    expect(row.textContent).not.toContain(L.narrowed.allow)
  })

  it('needs the network: says the network, and never says read-only', async () => {
    const { run, row } = await open('real-needs-network')

    expect(run).toMatchObject({ narrowed: true, narrowedWhy: 'needs-network', network: false })

    const note = row.querySelector('[data-narrowed="needs-network"]')

    expect(note?.textContent).toContain(L.narrowed.lead['needs-network'])
    expect(note?.textContent).not.toContain('read-only')
  })

  it('two flags taken: the row names the first reason, and says nothing false about the second', async () => {
    const { run, row } = await open('real-two-flags')

    expect(run).toMatchObject({ narrowed: true, narrowedWhy: 'needs-allow', writeProject: false, network: false })

    const note = row.querySelector('[data-narrowed="needs-allow"]')!

    expect(note.textContent).toContain(L.narrowed.lead['needs-allow'])
    expect(note.textContent?.toLowerCase()).not.toContain('network')

    // The details say both, each as it was.
    fireEvent.click(row.querySelector('.e-row')!)

    const details = screen.getByRole('region', { name: 'Command details' })

    const fact = (label: string) =>
      [...details.querySelectorAll('dt')].find(dt => dt.textContent === label)?.nextElementSibling?.textContent

    expect(fact(L.facts.network)).toBe(L.facts.notGranted)
    expect(details.textContent).toContain(L.facts.readOnly)
  })

  it('a policy refusal: never started, in words, with the flag name removed from what the user reads', async () => {
    const run = views().find(candidate => candidate.refusedReason === 'policy' && !candidate.rootPid)

    expect(run, JSON.stringify(views().map(candidate => candidate.refusedReason))).toBeDefined()
    expect(run?.refusedDetail).toContain('WRITE_PROJECT=1')

    bridge.state.mockImplementation(async () => fixtureState({ runs: [run!], refusals: [], agents: [] }))
    render(<ContainersWindow blocked={false} />)
    await screen.findByText('Confined')
    fireEvent.click(screen.getByRole('button', { name: /^Refusals/ }))

    const group = window.document.querySelector(`[data-before-start="${run!.id}"]`)

    expect(group?.textContent).toContain(L.refusedCode.policy)
    expect(group?.querySelector('[data-refused-detail]')?.textContent).toContain('no mode')
    expect(group?.textContent).not.toContain('WRITE_PROJECT')
  })

  it('stopped by the watch: folds onto its own run and says the modes stopped it, not failed and not you', async () => {
    const { run, row } = await open('real-stopped')

    expect(run).toMatchObject({ phase: 'stopped', stoppedByModes: true })
    expect(row.textContent).toContain(L.phaseStoppedByModes)
    expect(row.textContent).not.toContain('Stopped by you')
    expect(row.textContent).not.toContain('signal 9')
  })
})
