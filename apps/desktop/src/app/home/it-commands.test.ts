import { beforeEach, describe, expect, it } from 'vitest'

import { runItCommand } from './it-commands'
import { $itClosePrompt, requestCloseItPane } from './it-keys'
import { listPanes } from './it-layout'
import { $itBodySize, $itInstances, $itWorkspaces, setItInstancesForTests } from './it-store'
import { registerTerminalReader } from './it/engine/buffer'
import { $terminals, createTerminal, type TerminalEntry } from './it/engine/terminals'

type Reader = Parameters<typeof registerTerminalReader>[1]

const screen = (id: string, text: string) => registerTerminalReader(id, (() => ({ text })) as unknown as Reader)

const run = async (...argv: string[]) => String(await runItCommand(argv))

function reset(): void {
  const id = createTerminal('/tmp')

  $terminals.set([$terminals.get().find(term => term.id === id) as TerminalEntry])
  setItInstancesForTests([
    {
      activeId: 'ws-c',
      id: 'it-1',
      n: 1,
      named: false,
      open: false,
      title: 'iT',
      workspaces: [
        {
          focusTerminalId: id,
          id: 'ws-c',
          layout: { type: 'leaf', terminalId: id },
          named: true,
          title: 'main',
          unread: false,
          zoomedTerminalId: null
        }
      ]
    }
  ])
}

describe('it — one surface, exact refs', () => {
  beforeEach(() => {
    reset()
  })

  it('has no instance grammar: `it instance …` and -i/--instance are refused, nothing opens', async () => {
    expect(await run('instance', 'new')).not.toMatch(/^it-\d/)
    expect(await run('split', '-i', '2')).toContain('one iT')
    expect(await run('send', '--instance', 'x', 'echo')).toContain('--workspace')
    expect(await run('help')).not.toMatch(/it instance|--instance/)
    expect($itInstances.get()).toHaveLength(1)
    expect(listPanes($itWorkspaces.get()[0].layout)).toHaveLength(1)
  })

  it('help says a spawn env key is renamed to PANE_* and what the program then reads', async () => {
    expect(await run('help')).toMatch(/env keys: PANE_\* \(STEP → PANE_STEP; the program\s+reads \$PANE_STEP\)/)
  })

  it('use/close/rename take a number or the EXACT title — never a fragment', async () => {
    await run('new', 'build')
    await run('new', 'build-old')
    expect(await run('close', 'old')).toContain('no workspace is "old"')
    expect(await run('use', 'bui')).toContain('no workspace is')
    expect(await run('use', 'BUILD')).toBe('active: build')
    expect(await run('close', '3')).toBe('closed build-old')
    expect($itWorkspaces.get().map(item => item.title)).toEqual(['main', 'build'])
  })

  it('a title two tabs share is refused with a hint, never guessed', async () => {
    await run('new', 'logs')
    await run('new', 'logs')
    expect(await run('close', 'logs')).toContain('matches 2 tabs')
    expect($itWorkspaces.get()).toHaveLength(3)
  })

  it('new and rename refuse a title shaped like a ref', async () => {
    expect(await run('new', '2')).toContain('reads as a tab number')
    expect(await run('rename', '1', 'it-4')).toContain('reads as a tab number')
    expect($itWorkspaces.get().map(item => item.title)).toEqual(['main'])
  })

  it('--pane takes an index or an exact id, never a prefix', async () => {
    const id = $itWorkspaces.get()[0].focusTerminalId

    expect(await run('send', '--pane', id.slice(0, 3), 'echo')).toMatch(/^it: /)
  })

  it('send to a pane whose shell never started says how to start it', async () => {
    const answer = await run('send', 'echo', 'hi')

    expect(answer).toContain('no shell yet')
    expect(answer).toContain('it open')
  })
})

describe('it — R5 r6 hardening', () => {
  beforeEach(() => {
    reset()
    $itBodySize.set({ height: 600, width: 1000 })
  })

  const panes = () => listPanes($itWorkspaces.get()[0].layout)

  it('close-pane has the ⌘W busy guard: a busy shell needs --force, and no prompt is left in the rail', async () => {
    await run('split')
    const busy = panes()[1]

    screen(busy, 'python3\n>>> while True: pass')
    expect(await run('close-pane', '2')).toContain('--force')
    expect(panes()).toHaveLength(2)
    expect($itClosePrompt.get()).toBeNull()
    expect(await run('close-pane', '2', '--force')).toMatch(/^closed pane 2/)
    expect(panes()).toEqual([panes()[0]])
  })

  it("close-pane closes an idle shell at once and never iT's last shell", async () => {
    await run('split')
    screen(panes()[1], 'pat@mac ~ %')
    expect(await run('close-pane', '2')).toMatch(/^closed pane 2/)
    expect(await run('close-pane', '1', '--force')).toBe('it: the last pane never closes')
    expect(panes()).toHaveLength(1)
  })

  it('a split that would leave an unusable pane is refused with a reason', async () => {
    $itBodySize.set({ height: 600, width: 600 })
    expect(await run('split', 'right')).toMatch(/^split right/)
    expect(await run('split', 'right')).toContain('too small')
    expect(panes()).toHaveLength(2)

    $itBodySize.set({ height: 120, width: 1000 })
    expect(await run('split', 'down')).toContain('too small')
  })

  it('refuses --instance, --instance=N and -i in any position', async () => {
    for (const argv of [
      ['new', '--instance=2'],
      ['new', 'x', '-i', '2'],
      ['split', 'right', '--instance', '2'],
      ['send', '-i', '2', 'echo'],
      ['send', 'echo', '--instance=2']
    ]) {
      expect(await run(...argv)).toContain('there is one iT')
    }

    expect($itWorkspaces.get()).toHaveLength(1)
    expect(panes()).toHaveLength(1)
  })

  it('shell text may still carry -i (`it send grep -i x` is not an instance flag)', async () => {
    expect(await run('send', 'grep', '-i', 'x')).not.toContain('there is one iT')
  })
})

describe('it — R5 r7', () => {
  beforeEach(() => {
    reset()
    $itBodySize.set({ height: 800, width: 1600 })
  })

  const panes = () => listPanes($itWorkspaces.get()[0].layout)

  it('the pane id `it panes` prints addresses that pane', async () => {
    await run('split')
    await run('split')

    const listed = (await run('panes')).split('\n').map(line => line.trim().replace(/^●\s*/, '').split(/\s+/)[1])

    expect(listed).toEqual(panes())

    for (const [index, id] of listed.entries()) {
      expect(await run('focus-pane', id)).toMatch(new RegExp(`^focused pane ${index + 1} `))
      expect($itWorkspaces.get()[0].focusTerminalId).toBe(id)
    }
  })

  it('a CLI refusal on a busy pane leaves the rail prompt for another pane untouched', async () => {
    await run('split')
    await run('split')
    const [, second, third] = panes()

    screen(second, 'python3\n>>> while True: pass')
    screen(third, 'npm run build\n  45 %')
    requestCloseItPane($itWorkspaces.get()[0].id, second)

    const pending = $itClosePrompt.get()

    expect(pending?.terminalId).toBe(second)
    expect(await run('close-pane', '3')).toContain('--force')
    expect($itClosePrompt.get()).toEqual(pending)
    expect(panes()).toHaveLength(3)
  })

  it('a CLI close keeps another pane’s prompt and drops the prompt of the pane it closed', async () => {
    await run('split')
    await run('split')
    const [, second, third] = panes()

    screen(second, 'python3\n>>> while True: pass')
    screen(third, 'pat@mac ~ %')
    requestCloseItPane($itWorkspaces.get()[0].id, second)
    expect(await run('close-pane', '3')).toMatch(/^closed pane 3/)
    expect($itClosePrompt.get()?.terminalId).toBe(second)
    expect(await run('close-pane', '2', '--force')).toMatch(/^closed pane 2/)
    expect($itClosePrompt.get()).toBeNull()
  })
})

describe('it — the human click and the settings verb', () => {
  const visibleRect = { bottom: 20, height: 20, left: 0, right: 80, toJSON: () => ({}), top: 0, width: 80, x: 0, y: 0 }

  beforeEach(() => {
    document.body.innerHTML = ''
    window.location.hash = ''
  })

  function mountButton(label: string, guarded: boolean) {
    const wrap = document.createElement('div')
    const button = document.createElement('button')
    button.textContent = label
    button.getBoundingClientRect = () => visibleRect

    if (guarded) {
      button.setAttribute('data-it-noclick', '')
    }

    let clicks = 0
    button.addEventListener('click', () => (clicks += 1))
    wrap.append(button)
    document.body.append(wrap)

    return () => clicks
  }

  it('refuses a control marked data-it-noclick and never dispatches its click', async () => {
    const clicks = mountButton('Update', true)

    expect(await run('click', 'Update')).toMatch(/only a person can press/)
    expect(clicks()).toBe(0)
  })

  it('still clicks an ordinary control', async () => {
    const clicks = mountButton('Check for updates', false)

    expect(await run('click', 'check for updates')).toBe('clicked: Check for updates')
    expect(clicks()).toBe(1)
  })

  it('opens Settings › Updates by route only', async () => {
    expect(await run('open', 'settings', 'updates')).toBe('opened: settings › app-atualisation')
    expect(window.location.hash).toBe('#/settings?tab=app-atualisation')
  })

  it('passes a pane id through and refuses anything that is not one', async () => {
    expect(await run('open', 'settings', 'about')).toBe('opened: settings › about')
    expect(window.location.hash).toBe('#/settings?tab=about')
    expect(await run('open', 'settings', '../x')).toMatch(/is not a settings pane/)
    expect(window.location.hash).toBe('#/settings?tab=about')
  })
})

// E3c r2 — the engine moved to ./it/engine/**, so the CLI's read and rename paths are pinned HERE
// against the moved modules: `read-screen` must read the registry it-commands imports (one registry,
// not a second copy behind a shim), and `rename` takes a REF first and only then the title — the
// lab run proved a bare title is read as the ref, which is exactly what the live gate now asserts
// (RESUME/run/gates/L/extra/E3c_20261019_r2_it_routes_keys.mjs, it_cli_rename).
describe('it — read and rename against the moved engine', () => {
  beforeEach(() => {
    reset()
  })

  it('read-screen returns the text registered through ./it/engine/buffer', async () => {
    const id = $itWorkspaces.get()[0].focusTerminalId as string

    screen(id, 'E3C-R2-SCREEN')

    expect(await run('read-screen')).toContain('E3C-R2-SCREEN')
  })

  it('read-screen and capture-pane hide a pane token printed on the screen', async () => {
    const id = $itWorkspaces.get()[0].focusTerminalId as string
    const token = `v1.${'a'.repeat(32)}.${'b'.repeat(64)}`

    screen(id, `$ env\nICLONE_PANE_TOKEN=${token}\n$`)

    for (const verb of ['read-screen', 'capture-pane']) {
      const shown = await run(verb, '--lines', '5')

      expect(shown).toContain('ICLONE_PANE_TOKEN=v1.[pane token hidden]')
      expect(shown).not.toContain(token)
    }

    expect(await run('read-screen')).not.toContain(token)
  })

  it('rename takes the ref first: a bare title is read as the ref, so the title stays', async () => {
    expect(await run('rename', 'main')).toContain('rename needs a title')
    expect($itWorkspaces.get()[0].title).toBe('main')

    expect(await run('rename', '1', 'E3C R2')).toContain('E3C R2')
    expect($itWorkspaces.get()[0].title).toBe('E3C R2')
  })
})
