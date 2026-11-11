/**
 * G15: a network grant is the internet, and loopback stays shut on every route. `::ffff:0.0.0.0` passes
 * `(deny network-outbound (remote ip "localhost:*"))` and reaches every loopback listener, so TCP over IPv6 is refused.
 * Measured, and held here because it is not what one would guess: `(remote ip6 "*:*")` as a deny next to the localhost deny
 * refuses IPv4 too, on the real profile: the whole grant stops working. Paired control: the same probe unconfined connects.
 * A widening's localhost lines still open localhost, on purpose, not the mapped route.
 */
import dgram from 'node:dgram'
import { writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ActivityClass } from '../../src/iclone-shared/confinement'

import { createLiveWorld, type LiveWorld } from './live-harness'

const ROUTES = ['::ffff:0.0.0.0', '::ffff:127.0.0.1', '0.0.0.0', '127.0.0.1', '::1', '::']

const PROBE = `
import json, socket, sys
out = {}
for port in sys.argv[1:]:
    for host in ${JSON.stringify(ROUTES)}:
        family = socket.AF_INET6 if ":" in host else socket.AF_INET
        s = socket.socket(family, socket.SOCK_STREAM)
        s.settimeout(2)
        try:
            s.connect((host, int(port)))
            s.recv(1)
            out[f"tcp {host} {port}"] = "open"
        except OSError as e:
            out[f"tcp {host} {port}"] = e.errno
        s.close()
        s = socket.socket(family, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        try:
            s.sendto(b"x", (host, int(port)))
            s.recv(8)
            out[f"udp {host} {port}"] = "open"
        except OSError as e:
            out[f"udp {host} {port}"] = e.errno
        s.close()
print("ANSWER" + json.dumps(out))
`

const INTERNET = `
import json, socket
out = {}
for key, family, where in (("ipv4", socket.AF_INET, ("1.1.1.1", 443)), ("ipv6", socket.AF_INET6, ("2606:4700:4700::1111", 443))):
    s = socket.socket(family, socket.SOCK_STREAM)
    s.settimeout(6)
    try:
        s.connect(where)
        out[key] = "open"
    except OSError as e:
        out[key] = e.errno
    s.close()
try:
    c = socket.create_connection(("one.one.one.one", 443), timeout=8)
    out["name"] = "open " + ("ipv6" if ":" in c.getpeername()[0] else "ipv4")
    c.close()
except OSError as e:
    out["name"] = str(e)
print("ANSWER" + json.dumps(out))
`

const EPERM = 1
const answer = (text: string) => JSON.parse(text.slice(text.indexOf('ANSWER{') + 6).split('\n')[0]) as Record<string, number | string>
const WIDENING = '(allow network-bind network-inbound (local ip "localhost:*"))\n(allow network-outbound (remote ip "localhost:*"))\n'

describe.skipIf(process.platform !== 'darwin')('loopback under a network grant (live, macOS Seatbelt)', () => {
  let world: LiveWorld
  let probe = ''
  let internet = ''
  let ports = ''
  const servers: net.Server[] = []
  const sockets: dgram.Socket[] = []

  const listen = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const server = net.createServer(socket => {
        socket.on('error', () => undefined)
        socket.end('y')
      })

      servers.push(server)
      server.once('error', reject)
      server.listen({ port: 0, host, ipv6Only: false }, () => resolve((server.address() as net.AddressInfo).port))
    })

  const echo = (port: number, host: string) =>
    new Promise<void>((resolve, reject) => {
      const socket = dgram.createSocket({ type: host.includes(':') ? 'udp6' : 'udp4', ipv6Only: false })

      sockets.push(socket)
      socket.once('error', reject)
      socket.on('message', (_message, from) => socket.send('y', from.port, from.address))
      socket.bind(port, host, () => resolve())
    })

  beforeAll(async () => {
    world = createLiveWorld()
    probe = path.join(world.project, 'loopback-probe.py')
    internet = path.join(world.project, 'internet-probe.py')
    writeFileSync(probe, PROBE)
    writeFileSync(internet, INTERNET)

    const found = [await listen('::'), await listen('127.0.0.1'), await listen('0.0.0.0')]

    await echo(found[0], '::')
    await echo(found[1], '127.0.0.1')
    await echo(found[2], '0.0.0.0')
    ports = found.join(' ')
  })

  afterAll(() => {
    servers.forEach(server => server.close())
    sockets.forEach(socket => socket.close())
    world.dispose()
  })

  it('the probe reaches the listeners without the profile (paired control)', async () => {
    const found = answer((await world.runPlain(`/usr/bin/python3 -I '${probe}' ${ports}`)).out)
    const dual = ports.split(' ')[0]

    for (const host of ROUTES) {
      expect([host, found[`tcp ${host} ${dual}`]]).toEqual([host, 'open'])
    }

    expect(found[`udp 127.0.0.1 ${dual}`]).toBe('open')
  })

  const runs: [ActivityClass, boolean][] = [
    ['research', true],
    ['project', true],
    ['build', true],
    ['research', false],
    ['project', false],
    ['build', false],
    ['offline', false],
    ['media', false]
  ]

  it.each(runs)('%s with network %s: no route, TCP or UDP, reaches a loopback listener', async (cls, network) => {
    const outcome = await world.runConfined(`/usr/bin/python3 -I '${probe}' ${ports}`, {
      cls,
      network,
      outputDir: cls === 'media' ? world.outside : null
    })

    const found = answer(outcome.out)

    expect(Object.keys(found).length).toBe(ROUTES.length * 3 * 2)

    for (const key of Object.keys(found)) {
      expect([key, found[key]]).not.toEqual([key, 'open'])

      if (key.startsWith('tcp ')) {
        expect([key, found[key]]).toEqual([key, EPERM])
      }
    }
  })

  it.each(['research', 'project', 'build'] as ActivityClass[])('%s with network: the internet answers over IPv4, a name falls back to it, IPv6 TCP is refused at once', async cls => {
    const plain = answer((await world.runPlain(`/usr/bin/python3 -I '${internet}'`)).out)

    if (plain.ipv4 !== 'open') {
      return // no internet on this machine: nothing to compare against
    }

    const found = answer((await world.runConfined(`/usr/bin/python3 -I '${internet}'`, { cls, network: true })).out)

    expect(found.ipv4).toBe('open')
    expect(found.ipv6).toBe(EPERM)
    expect(found.name).toBe('open ipv4')
  })

  it('widened for localhost: localhost opens as asked, the mapped route stays shut', async () => {
    const originals = world.profiles.map(profile => profile.text)

    world.profiles.forEach((profile, index) => {
      profile.text = originals[index].replace('; never, whatever the class', `${WIDENING}; never, whatever the class`)
    })

    try {
      const found = answer((await world.runConfined(`/usr/bin/python3 -I '${probe}' ${ports}`, { cls: 'project', network: true })).out)
      const dual = ports.split(' ')[0]

      expect(found[`tcp 127.0.0.1 ${dual}`]).toBe('open')
      expect(found[`tcp ::1 ${dual}`]).toBe('open')
      expect(found[`tcp ::ffff:0.0.0.0 ${dual}`]).toBe(EPERM)
    } finally {
      world.profiles.forEach((profile, index) => {
        profile.text = originals[index]
      })
    }
  })
})
