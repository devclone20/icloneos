import { readFileSync } from 'node:fs'
import path from 'node:path'

import { beforeAll, expect, test, vi } from 'vitest'

import { $itSurfaceOpen, focusItPane, setItInstancesForTests } from '../../it-store'

import { $paneStates, initPaneAttention, reportPaneSignal } from './attention'

const bus = {
  snapshot: vi.fn(async () => []),
  signal: vi.fn(async () => true),
  clear: vi.fn(async () => true),
  plan: vi.fn(),
  probe: vi.fn(),
  tmuxList: vi.fn(),
  tmuxEnd: vi.fn(),
  onChange: vi.fn((callback: (pane: unknown) => void) => {
    emit = callback

    return () => undefined
  })
}

let emit: (pane: unknown) => void = () => undefined

const summary = (paneId: string) => ({
  paneId,
  name: paneId,
  group: null,
  role: null,
  spawnId: null,
  state: 'running',
  pid: 1,
  unread: 0,
  signal: null,
  result: null,
  exit: null
})

beforeAll(() => {
  Object.assign(window, { hermesDesktop: { ...window.hermesDesktop, paneBus: bus } })
  setItInstancesForTests([
    {
      activeId: 'ws',
      id: 'it-1',
      n: 1,
      named: false,
      open: true,
      title: 'iT',
      workspaces: [
        {
          focusTerminalId: 'p1',
          id: 'ws',
          layout: {
            type: 'split',
            id: 'n1',
            dir: 'h',
            ratio: 0.5,
            a: { type: 'leaf', terminalId: 'p1' },
            b: { type: 'leaf', terminalId: 'p2' }
          },
          named: true,
          title: 'ws',
          unread: false,
          zoomedTerminalId: null
        }
      ]
    }
  ])
  $itSurfaceOpen.set(true)
  initPaneAttention()
  emit(summary('p1'))
  emit(summary('p2'))
})

test('G5: a bell in an unfocused pane rings it, the sibling is untouched, focus clears it', () => {
  const started = performance.now()

  reportPaneSignal('p2', '', 'bell')

  expect($paneStates.get().p2.state).toBe('needs-input')
  expect(performance.now() - started).toBeLessThan(300)
  expect($paneStates.get().p1.state).toBe('running')
  expect(bus.signal).toHaveBeenCalledWith('p2', '', 'bell')

  const focused = performance.now()

  focusItPane('ws', 'p2')

  expect($paneStates.get().p2.state).toBe('running')
  expect($paneStates.get().p2.signal?.source).toBe('bell')
  expect(performance.now() - focused).toBeLessThan(100)
  expect(bus.clear).toHaveBeenCalledWith('p2')
})

test('the pane being looked at does not ring itself', () => {
  reportPaneSignal('p2', 'done', 'osc9')

  expect($paneStates.get().p2.state).toBe('running')
})

test('a bus `attention` from main paints the same way', () => {
  emit({ ...summary('p1'), state: 'needs-input', signal: { text: 'review me', at: Date.now(), source: 'attention' } })

  expect($paneStates.get().p1.state).toBe('needs-input')
})

test('the ring is steady: no animation and no new keyframes in it-terminal.css', () => {
  const css = readFileSync(path.resolve(__dirname, '../../it-terminal.css'), 'utf8')

  const rule = css.slice(
    css.indexOf('.itwin__pane--attention::after'),
    css.indexOf('}', css.indexOf('.itwin__pane--attention::after'))
  )

  expect(rule).not.toMatch(/animation|transition/)
  expect(css.match(/@keyframes/g) ?? []).toHaveLength(0)
  expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
})
