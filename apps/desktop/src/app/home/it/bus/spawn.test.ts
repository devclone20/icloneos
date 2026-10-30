import { beforeEach, expect, test } from 'vitest'

import { listPanes } from '../../it-layout'
import { $itBodySize, $itWorkspaces, setItInstancesForTests } from '../../it-store'
import { $terminals, createTerminal, type TerminalEntry } from '../engine/terminals'

import { paneStartOptions } from './pane-meta'
import { layOutSpawn, spawnedPanes } from './spawn'

beforeEach(() => {
  const id = createTerminal('/tmp')

  $terminals.set($terminals.get().filter((term): term is TerminalEntry => term.id === id))
  setItInstancesForTests([
    {
      activeId: 'ws-base',
      id: 'it-1',
      n: 1,
      named: false,
      open: false,
      title: 'iT',
      workspaces: [
        {
          focusTerminalId: id,
          id: 'ws-base',
          layout: { type: 'leaf', terminalId: id },
          named: true,
          title: 'base',
          unread: false,
          zoomedTerminalId: null
        }
      ]
    }
  ])
})

const panes = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    name: `w${i}`,
    cwd: '/tmp',
    role: 'builder',
    group: 'crew',
    cmd: `echo ${i}`
  }))

test('eight panes tile into one workspace on a large body, each carrying its spec', () => {
  $itBodySize.set({ width: 1600, height: 1000 })

  const { spawnId, placed } = layOutSpawn(panes(8), 'tiled')
  const crew = $itWorkspaces.get().find(workspace => workspace.title === 'crew')

  expect(placed).toHaveLength(8)
  expect(crew && listPanes(crew.layout)).toHaveLength(8)
  expect(spawnedPanes(spawnId).map(pane => pane.name)).toEqual(placed.map(pane => pane.name))
  expect(paneStartOptions(placed[2].terminalId)).toMatchObject({
    name: 'w2',
    group: 'crew',
    role: 'builder',
    cmd: 'echo 2'
  })
  // The command runs once: a restarted shell is a plain shell.
  expect(paneStartOptions(placed[2].terminalId).cmd).toBeUndefined()
})

test('what does not fit overflows into new workspaces instead of slivers', () => {
  $itBodySize.set({ width: 400, height: 260 })

  const { placed } = layOutSpawn(panes(8), 'tiled')

  expect(placed).toHaveLength(8)
  expect(new Set(placed.map(pane => pane.workspaceTitle)).size).toBeGreaterThanOrEqual(1)
  expect($itWorkspaces.get().filter(workspace => workspace.title === 'crew').length).toBeGreaterThan(1)
})

test('tabs layout gives each pane its own workspace', () => {
  const { placed } = layOutSpawn(panes(3), 'tabs')

  expect(new Set(placed.map(pane => pane.terminalId)).size).toBe(3)
  expect($itWorkspaces.get()).toHaveLength(4)
})
