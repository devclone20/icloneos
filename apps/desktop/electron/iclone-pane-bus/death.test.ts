/**
 * G3 at the PTY seam: a shell killed from outside (`kill -9`) reaches the bus
 * as `dead` through node-pty's exit, the same callback terminal-ipc wires.
 */
import nodePty from 'node-pty'
import { expect, test } from 'vitest'

import { createPaneBroker } from './broker'

const TRIALS = 20

test(`G3: kill -9 from outside marks the pane dead within 3 s, ${TRIALS}/${TRIALS}`, async () => {
  const broker = createPaneBroker()
  const latencies: number[] = []

  for (let trial = 0; trial < TRIALS; trial += 1) {
    const paneId = `pane-${trial}`

    broker.register({ paneId, name: `p${trial}` })

    const pty = nodePty.spawn('/bin/sh', ['-c', 'sleep 60'], { cols: 80, rows: 24 })

    const gone = new Promise<void>(resolve =>
      pty.onExit(({ exitCode, signal }) => {
        broker.exited(paneId, { code: exitCode, signal: signal || null })
        resolve()
      })
    )

    broker.attachPid(paneId, pty.pid)
    const killedAt = performance.now()

    process.kill(pty.pid, 'SIGKILL')
    await gone
    latencies.push(performance.now() - killedAt)

    expect(broker.snapshot().find(pane => pane.paneId === paneId)?.state).toBe('dead')
  }

  console.info(`[V3D G3] trials=${TRIALS} max=${Math.max(...latencies).toFixed(1)}ms`)
  expect(latencies.filter(ms => ms <= 3000)).toHaveLength(TRIALS)
}, 60_000)
