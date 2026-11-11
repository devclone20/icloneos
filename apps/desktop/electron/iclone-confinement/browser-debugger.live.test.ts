/**
 * G14: Chromium's debugger, the door's browser, runs outside the Seatbelt and reads any file it is told to. A confined
 * process that reaches its port reads what the profile denies. Before this wall a class with the network reached it at
 * ::ffff:0.0.0.0, past the loopback deny, and the runtime reached it at 127.0.0.1. Paired control: the same probe
 * unconfined connects, so a refusal is the profile's doing.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ActivityClass } from '../../src/iclone-shared/confinement'

import { createLiveWorld, type LiveWorld } from './live-harness'
import { createRuntimeWorld, RUNTIME_ROOT, runtimeAvailable, type RuntimeWorld } from './runtime-live-harness'
import { DEBUGGER_PORTS } from './sbpl'

const PORTS = [1719, 1720, 1723, 4045, 5060, 5061, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080]
const FIRST = PORTS[0]
const LAST = PORTS[PORTS.length - 1]
const SQUAT = PORTS[5]
const ROUTES = ['127.0.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', '::ffff:0.0.0.0']

const PROBE = `
import json, socket, sys
out = {}
for port in (int(sys.argv[1]), int(sys.argv[2])):
    for host in ${JSON.stringify(ROUTES)}:
        s = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(2)
        try:
            s.connect((host, port))
            out[f"connect {host} {port}"] = "connected"
        except OSError as e:
            out[f"connect {host} {port}"] = e.errno
        finally:
            s.close()
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind(("127.0.0.1", int(sys.argv[3])))
    out["bind"] = "bound"
except OSError as e:
    out["bind"] = e.errno
s.close()
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(2)
try:
    s.connect(("127.0.0.1", int(sys.argv[4])))
    other = "connected"
except OSError as e:
    other = e.errno
s.close()
print("OTHER=" + str(other))
print("ANSWER" + json.dumps(out))
`

const EPERM = 1
const answer = (text: string) => JSON.parse(text.slice(text.indexOf('ANSWER{') + 6).split('\n')[0]) as Record<string, number | string>

describe.skipIf(process.platform !== 'darwin' || !runtimeAvailable())('the browser debugger (live, macOS Seatbelt)', () => {
  let world: LiveWorld
  let runtime: RuntimeWorld
  let script: string
  const servers: net.Server[] = []
  const otherServer = net.createServer(socket => socket.end())
  let args = ''
  let other = 0

  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      const server = net.createServer(socket => socket.end())

      servers.push(server)
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => resolve())
    })

  const refused = (found: Record<string, number | string>) => {
    for (const key of Object.keys(found)) {
      expect([key, found[key]]).toEqual([key, EPERM])
    }
  }

  beforeAll(async () => {
    world = createLiveWorld()
    runtime = createRuntimeWorld()
    script = path.join(world.project, 'debugger-probe.py')
    writeFileSync(script, PROBE)
    await listen(FIRST)
    await listen(LAST)
    await new Promise<void>(resolve => otherServer.listen(0, '127.0.0.1', () => resolve()))
    other = (otherServer.address() as net.AddressInfo).port
    args = `${FIRST} ${LAST} ${SQUAT} ${other}`
  })

  afterAll(() => {
    servers.forEach(server => server.close())
    otherServer.close()
    world.dispose()
    runtime.dispose()
  })

  it('the probe reaches a listener without the profile (paired control)', async () => {
    const found = answer((await world.runPlain(`/usr/bin/python3 -I '${script}' ${args}`)).out)

    expect(found[`connect 127.0.0.1 ${FIRST}`]).toBe('connected')
    expect(found[`connect ::ffff:0.0.0.0 ${LAST}`]).toBe('connected')
  })

  const runs: [ActivityClass, boolean][] = [
    ['research', true],
    ['research', false],
    ['project', true],
    ['project', false],
    ['build', true],
    ['build', false],
    ['offline', false],
    ['media', false]
  ]

  it.each(runs)('%s with network %s: every route to the debugger ports and binding one is refused', async (cls, network) => {
    const outcome = await world.runConfined(`/usr/bin/python3 -I '${script}' ${args}`, {
      cls,
      network,
      outputDir: cls === 'media' ? world.outside : null
    })

    refused(answer(outcome.out))
  })

  it.each([
    ['project', true],
    ['research', false],
    ['offline', false]
  ] as [ActivityClass, boolean][])('%s with network %s, widened for the browser: its localhost lines stop short of the debugger ports', async (cls, network) => {
    const lines = '(allow network-bind network-inbound (local ip "localhost:*"))\n(allow network-outbound (remote ip "localhost:*"))\n'
    const originals = world.profiles.map(profile => profile.text)

    world.profiles.forEach((profile, index) => {
      profile.text = originals[index].replace('; never, whatever the class', `${lines}; never, whatever the class`)
    })

    try {
      refused(answer((await world.runConfined(`/usr/bin/python3 -I '${script}' ${args}`, { cls, network })).out))
    } finally {
      world.profiles.forEach((profile, index) => {
        profile.text = originals[index]
      })
    }
  })

  it('the runtime profile: every route refused, and another local server still reached', async () => {
    const probe = path.join(runtime.root, 'project', 'debugger-probe.py')

    writeFileSync(probe, PROBE)

    const outcome = await runtime.run(true, [probe, String(FIRST), String(LAST), String(SQUAT), String(other)], { timeoutMs: 30_000 })

    refused(answer(outcome.out + outcome.err))
    expect(outcome.out).toContain('OTHER=connected')
  })

  it('the door and both profiles name the same ports', () => {
    const door = readFileSync(path.join(RUNTIME_ROOT, 'plugins/iclone-confinement/browser_door.py'), 'utf8')

    expect(door).toContain(`DEBUG_PORTS = (${PORTS.join(', ')})`)
    expect([...DEBUGGER_PORTS]).toEqual(PORTS)
    expect(runtime.profile.text).toContain(`"*:${FIRST}"`)
    expect(world.profiles.every(profile => profile.text.includes(`"*:${LAST}"`))).toBe(true)
  })
})
