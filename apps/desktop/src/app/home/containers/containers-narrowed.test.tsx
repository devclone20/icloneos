import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $confinement } from '@/store/confinement'

import type * as Window from '../window'

/** fx14: the pane says what a narrowed, stopped or refused run was, in words, and offers the one thing it can do. */
import { allowFolder as askMain } from './containers-allow'
import { ContainersWindow } from './containers-app'
import { CONFINEMENT_COPY } from './containers-copy'
import { failedMeaning } from './containers-data'
import { $containersOpen } from './containers-dock'
import { FIXTURE_NARROWED_REFUSALS, fixtureState, FIXTURE_NARROWED as N } from './containers-fixtures'

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
const ALLOW = L.narrowed?.allow ?? 'Allow this folder'
const state = (runs = Object.values(N)) => fixtureState({ runs, refusals: FIXTURE_NARROWED_REFUSALS, agents: [] })

const allowFolder = vi.fn(async (_folder: string): Promise<{ ok: boolean } | null> => ({ ok: true }))

const bridge = {
  state: vi.fn(async () => state()),
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
  bridge.state.mockImplementation(async () => state())
  allowFolder.mockImplementation(async () => ({ ok: true }))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function open(runs = Object.values(N)) {
  bridge.state.mockImplementation(async () => state(runs))
  render(<ContainersWindow blocked={false} />)
  await screen.findByText('Confined')
}

const row = (id: string) => window.document.querySelector<HTMLElement>(`[data-run="${id}"]`)!

const inspect = (id: string) => {
  fireEvent.click(row(id).querySelector('.e-row')!)

  return screen.getByRole('region', { name: 'Command details' })
}

const rail = (name: string) => fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }))

describe('a narrowed row', () => {
  it.each([
    ['unlisted', N.unlisted, 'unlisted-folder'],
    ['needs an allow', N.needsAllow, 'needs-allow'],
    ['needs the network', N.needsNetwork, 'needs-network']
  ] as const)('%s says its own reason on the row', async (_name, run, key) => {
    await open()

    const note = row(run.id).querySelector(`[data-narrowed="${key}"]`)

    expect(note?.textContent).toContain(L.narrowed.lead[key])
    expect(note?.textContent).toContain(L.narrowed.why[key])
  })

  it('never says the mode did not allow it, right after the user chose Allow', async () => {
    await open()
    inspect(N.needsAllow.id)
    expect(window.document.body.textContent).not.toContain('the permission mode did not allow project writes')
    expect(window.document.body.textContent).toContain(L.why['narrowed-needs-allow'](''))
  })

  it('fx25: a folder through a link: none of the command ran, and the refusals are the attempts to enter', async () => {
    const link = { ...N.unlisted, id: 'link-cwd', cwdLink: true, exitCode: 126, phase: 'failed' as const, refusals: 2 }

    await open([link])

    const text = row(link.id).textContent

    expect(row(link.id).querySelector('[data-narrowed="could-not-enter"]')).not.toBeNull()
    expect(text).toContain('None of the command ran')
    expect(text).toContain('any refusal counted here is the shell trying to enter that folder')
    expect(text).not.toContain('Nothing ran')
    expect(row(link.id).querySelector('.icont__refused')?.textContent).toContain('2')
    expect(row(link.id).querySelector('[data-allow-folder]')).toBeNull()
  })

  it('a run that was not narrowed carries no note', async () => {
    await open()
    expect(row(N.gitPush.id).querySelector('[data-narrowed]')).toBeNull()
  })

  it('twenty commands in one folder give one explanation and one button', async () => {
    await open()
    expect(row(N.unlisted.id).querySelector('[data-allow-folder]')).not.toBeNull()
    expect(row(N.unlistedOlder.id).querySelector('[data-narrowed]')?.getAttribute('data-short')).toBe('true')
    expect(row(N.unlistedOlder.id).querySelector('[data-allow-folder]')).toBeNull()
    expect(screen.getAllByRole('button', { name: ALLOW })).toHaveLength(1)
  })
})

describe('Allow this folder', () => {
  it('shows the folder in full and says what it does', async () => {
    await open()

    const offer = within(row(N.unlisted.id))

    expect(offer.getByText(N.unlisted.projectRoot!).tagName).toBe('CODE')
    expect(offer.getByText(L.narrowed.allowMeans)).toBeTruthy()
  })

  it('is offered only for an unlisted folder', async () => {
    await open([N.needsAllow, N.needsNetwork, N.gitPush])
    expect(screen.queryByRole('button', { name: ALLOW })).toBeNull()
  })

  it('is not offered once a later command in that folder had its writes', async () => {
    const later = { ...N.gitPush, id: 'run-later', projectRoot: N.unlisted.projectRoot, startedAt: N.unlisted.endedAt! }

    await open([N.unlisted, later])
    expect(screen.queryByRole('button', { name: ALLOW })).toBeNull()
  })

  it('calls nothing until clicked, then the bridge once with the row’s folder, from a marked control', async () => {
    await open()
    expect(allowFolder).not.toHaveBeenCalled()

    const button = screen.getByRole('button', { name: ALLOW })

    expect(button.closest('[data-confinement-confirm]')).not.toBeNull()
    fireEvent.click(button)
    // Synchronous up to the bridge: the preload takes the proof of this very click.
    expect(allowFolder).toHaveBeenCalledTimes(1)
    expect(allowFolder).toHaveBeenCalledWith(N.unlisted.projectRoot)
    expect(await screen.findByText(L.narrowed.allowedAsks)).toBeTruthy()
    expect(screen.queryByRole('button', { name: ALLOW })).toBeNull()
  })

  it('clicking the button does not open the run', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: ALLOW }))
    await screen.findByText(L.narrowed.allowedAsks)
    expect(screen.queryByRole('region', { name: 'Command details' })).toBeNull()
  })

  it.each([
    ['refused', async () => ({ ok: false })],
    ['null', async () => null],
    [
      'throws',
      async () => {
        throw new Error('no handler')
      }
    ]
  ])('main %s: says it failed, and the button stays', async (_name, impl) => {
    allowFolder.mockImplementation(impl)
    await open()
    fireEvent.click(screen.getByRole('button', { name: ALLOW }))
    expect((await screen.findByRole('alert')).textContent).toBe(L.narrowed.allowFailed)
    expect(screen.getByRole('button', { name: ALLOW })).toBeTruthy()
  })

  it('no bridge entry yet: says it failed, never that it worked', async () => {
    const { allowFolder: _absent, ...without } = bridge

    Object.assign(window, { hermesDesktop: { icloneConfinement: without } })
    await open()
    fireEvent.click(screen.getByRole('button', { name: ALLOW }))
    expect((await screen.findByRole('alert')).textContent).toBe(L.narrowed.allowFailed)
  })

  it('the inspector offers it too', async () => {
    await open()
    expect(within(inspect(N.unlisted.id)).getByRole('button', { name: ALLOW })).toBeTruthy()
    await waitFor(() => expect(row(N.unlisted.id).querySelector('[data-allow-folder]')).toBeNull())
  })
})

describe('a refusal says its detail on the page', () => {
  const SAID = 'The request asks to write the project and no mode set on this Mac allows project writes.'

  it('has its own words for policy', () => {
    expect(L.refusedCode.policy).toContain('modes')
  })

  it('fx32p: a working folder that is gone says so once, with the path, and never malformed', async () => {
    const detail = 'Its working folder /Users/me/Gone is not there any more, so it was not started. Move the folder back, or give a folder that exists.'
    const row = { ...N.policy, id: 'cwd-gone-row', refusedReason: 'cwd-gone' as const, refusedDetail: detail }

    await open([row])

    const pane = inspect(row.id)

    expect(pane.textContent).toContain(detail)
    expect(pane.textContent).not.toContain(L.refusedCode['cwd-gone'])
    expect(pane.textContent).not.toContain(L.refusedCode['bad-request'])
    expect(pane.querySelector('[data-refused-detail]')).toBeNull()
  })

  it('fx28: a working folder given as a link or another spelling has its own lead, never malformed, with the detail under it', async () => {
    const detail = 'the working folder must be given as the folder itself spells it: /Users/me/Project'
    const row = { ...N.policy, id: 'cwd-row', refusedReason: 'cwd-spelling' as const, refusedDetail: detail }

    await open([row])

    const pane = inspect(row.id)

    expect(L.refusedCode['cwd-spelling']).toBe(
      'Its working folder was given through a link, or with .. or a doubled or trailing slash, so it was not started. Give the folder itself as the working folder.'
    )
    expect(pane.textContent).toContain(L.refusedCode['cwd-spelling'])
    expect(pane.textContent).not.toContain(L.refusedCode['bad-request'])
    expect(pane.querySelector('[data-refused-detail]')?.textContent).toBe(
      'The working folder must be given as the folder itself spells it: /Users/me/Project.'
    )
  })

  it('in the inspector, as text, without the flag names', async () => {
    await open()

    const pane = inspect(N.policy.id)

    expect(pane.textContent).toContain(L.refusedCode.policy)
    expect(pane.querySelector('[data-refused-detail]')?.textContent).toBe(SAID)
    expect(pane.textContent).not.toContain('WRITE_PROJECT')
  })

  it('in the Refusals section, as text', async () => {
    await open()
    rail('Refusals')

    const group = window.document.querySelector(`[data-before-start="${N.policy.id}"]`)

    expect(group?.textContent).toContain(L.refusedCode.policy)
    expect(group?.querySelector('[data-refused-detail]')?.textContent).toBe(SAID)
  })
})

describe('a run the modes stopped', () => {
  it('says so on its row, not failed and not a signal', async () => {
    await open()

    const line = row(N.stoppedByModes.id)

    expect(line.querySelector('[data-stopped-by-modes]')?.textContent).toContain(
      'The run was stopped: the modes changed'
    )
    expect(line.textContent).not.toMatch(/failed|signal/i)
    expect(line.textContent).toContain(L.phaseStoppedByModes)
    expect(line.textContent).not.toContain(L.phase.stopped)
  })

  it('never says the owner pressed Stop', async () => {
    await open()

    const pane = inspect(N.stoppedByModes.id)

    expect(pane.textContent).toContain(L.stoppedByModes)
    expect(pane.textContent).not.toContain(L.phaseMeaning.stopped)
    expect(pane.textContent).not.toContain(L.phase.stopped)
    expect(pane.querySelector('[data-modes-reason]')?.textContent).toContain('no mode set on this Mac allows')
    expect(pane.textContent).not.toContain('WRITE_PROJECT')
  })
})

describe('git config refusals say what to do instead', () => {
  it('a run with one shows both lines, in the inspector and under Refusals', async () => {
    await open()

    const instead = inspect(N.gitPush.id).querySelector('[data-git-instead]')

    expect(instead?.textContent).toContain('git push origin <branch>')
    expect(instead?.textContent).toContain('git -c user.name=')

    rail('Refusals')
    expect(window.document.querySelectorAll('.icont__refusal-group [data-git-instead]')).toHaveLength(1)
  })

  it('a run without one does not', async () => {
    await open()
    expect(inspect(N.needsAllow.id).querySelector('[data-git-instead]')).toBeNull()
  })

  it('the git-config text carries both lines, and no route that was measured not to work', () => {
    const text = L.why['git-config']('')

    expect(text).toContain('git push origin <branch>')
    expect(text).toContain('git -c user.name=')
    expect(text).not.toContain('branch.')
  })
})

describe('the new words', () => {
  it('use no internal names', () => {
    const fresh = [
      L.stoppedByModes,
      ...Object.values(L.narrowed.lead),
      ...Object.values(L.narrowed.why),
      L.narrowed.allow,
      L.narrowed.allowMeans,
      L.narrowed.allowedAsks,
      L.narrowed.allowFailed,
      L.refusedCode.policy,
      L.why['narrowed-unlisted-folder'](''),
      L.why['narrowed-needs-allow'](''),
      L.why['narrowed-needs-network'](''),
      L.why['git-config']('')
    ]

    for (const text of fresh) {
      expect(text).not.toMatch(/\b(lease|ceiling|launcher|WRITE_PROJECT|sandbox-exec|seatbelt)\b/i)
    }
  })
})

describe('fx19: the row says the next step, in main\'s word', () => {
  it.each([
    ['writes', 'allowed'],
    ['plan', 'allowed-plan'],
    ['asks', 'allowed-asks'],
    [undefined, 'allowed-asks']
  ] as const)('main answers next=%s: note %s', async (next, note) => {
    const allow = vi.fn(async () => ({ ok: true, next }))

    ;(window as never as { hermesDesktop: unknown }).hermesDesktop = { icloneConfinement: { allowFolder: allow } }

    expect(await askMain('/p')).toBe(note)
  })

  it('a refusal or a broken bridge never reads as allowed', async () => {
    ;(window as never as { hermesDesktop: unknown }).hermesDesktop = {
      icloneConfinement: { allowFolder: vi.fn(async () => ({ ok: false })) }
    }
    expect(await askMain('/p')).toBe('failed')
    ;(window as never as { hermesDesktop: unknown }).hermesDesktop = {
      icloneConfinement: {
        allowFolder: vi.fn(async () => {
          throw new Error('x')
        })
      }
    }
    expect(await askMain('/p')).toBe('failed')
  })

  it('g18: main answers from the standing mode, not the session\'s, so no note says what this session does', () => {
    expect(L.narrowed.allowedAsks).toBe(
      'Allowed. Your mode decides each write here: where it asks, allow the ask and the write lands; where it does not, the write lands with no ask; in Plan writes stay off.'
    )
    expect(L.narrowed.allowedPlan).toBe('Allowed. In Plan, writes stay off until you choose another mode.')
    expect(L.narrowed.allowed).toBe('Allowed. The agent can write in this folder from its next command, as your mode lets it.')
  })

  it('the Manual note names the ask, the plain one is not used for it', () => {
    expect(L.narrowed.allowedAsks).toMatch(/asks/)
    expect(L.narrowed.allowMeans).toMatch(/asks you first/)
  })
})


describe('fx29 — the row copy', () => {
  it('the unlisted row says what fx27 says in the details, on the real row, and never that the user had not named it', async () => {
    await open()

    const note = row(N.unlisted.id).querySelector('[data-narrowed="unlisted-folder"]')

    expect(note?.textContent).toContain(L.why['narrowed-unlisted-folder'](''))
    expect(note?.textContent).not.toContain('you had not named it')
    expect(L.narrowed.why['unlisted-folder']).toBe(L.why['narrowed-unlisted-folder'](''))
  })

  it('a background row whose live count is an orphan reads the orphan note instead of the background meaning', () => {
    const base = { backgroundEnded: undefined, exitCode: 0, phase: 'background' as const, refusals: 0, signal: null, stoppedByModes: undefined }

    expect(failedMeaning(L, { ...base, orphanLive: true })).toBe(L.orphanLiveMeaning)
    expect(failedMeaning(L, { ...base, orphanLive: true })).toBe("A process whose run record is gone is alive; it may be this command's. Stop ends it.")
    expect(failedMeaning(L, base)).toBe(L.phaseMeaning.background)
    expect(failedMeaning(L, { ...base, phase: 'running' as const, orphanLive: true })).toBe(L.phaseMeaning.running)
  })
})
