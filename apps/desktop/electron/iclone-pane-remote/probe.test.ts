import { expect, test } from 'vitest'

import { createPaneProbe, parseListeners, type RunFile } from './probe'

const PS = ['  1     0', ' 100     1', ' 200   100', ' 300   200', ' 400     1'].join('\n')
const LSOF = ['p300', 'f12', 'n*:5174', 'f13', 'n127.0.0.1:9229', 'p400', 'n[::1]:8080'].join('\n')

test('lsof field output becomes pid → ports', () => {
  expect([...(parseListeners(LSOF).get(300) ?? [])]).toEqual([5174, 9229])
  expect([...(parseListeners(LSOF).get(400) ?? [])]).toEqual([8080])
})

test('ports are filtered to the pane process tree; one ps + one lsof per round; branch cached by cwd', async () => {
  const calls: string[] = []

  const run: RunFile = async (file, args) => {
    calls.push(file)

    if (file === 'ps') {
      return PS
    }

    if (file === 'lsof') {
      return LSOF
    }

    return args.includes('/repo') ? 'feature/x\n' : ''
  }

  const probe = createPaneProbe(run, () => 1_000)

  const facts = await probe([
    { paneId: 'a', pid: 100, cwd: '/repo' },
    { paneId: 'b', pid: 400, cwd: '/tmp' },
    { paneId: 'c', pid: null, cwd: '/repo' }
  ])

  expect(facts).toEqual([
    { paneId: 'a', branch: 'feature/x', ports: [5174, 9229] },
    { paneId: 'b', branch: null, ports: [8080] },
    { paneId: 'c', branch: 'feature/x', ports: [] }
  ])
  expect(calls.filter(file => file === 'ps')).toHaveLength(1)
  expect(calls.filter(file => file === 'lsof')).toHaveLength(1)
  expect(calls.filter(file => file === 'git').length).toBeLessThanOrEqual(3)

  await probe([{ paneId: 'a', pid: null, cwd: '/repo' }])
  expect(calls.filter(file => file === 'git').length).toBeLessThanOrEqual(3)
})
