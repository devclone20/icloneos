/**
 * v0.0.9 (owner check, socket writer 2): main's agent socket (perm and acp verbs) and pay socket left userData for the
 * short private socket folder of that userData (launcher-socket.ts). The runtime profile names EXACTLY each socket
 * literal (network-outbound to a path-literal), never the folder nor any temp subpath. Live, under macOS Seatbelt and
 * paired with the same probes unconfined: the confined runtime (and a child it starts) connects to each socket, and
 * can neither list the socket folder nor create a file in it.
 */
import { rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { socketPath } from './launcher-socket'
import { createRuntimeWorld, runtimeAvailable, type RuntimeWorld } from './runtime-live-harness'
import { generateRuntimeProfile } from './runtime-profile'

const PROBE = String.raw`
import errno, json, os, socket, subprocess, sys

def run(p):
    try:
        if p["k"] == "connect":
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(5)
            try:
                s.connect(p["path"])
            finally:
                s.close()
        elif p["k"] == "list":
            os.listdir(p["path"])
        elif p["k"] == "create":
            f = os.path.join(p["path"], "planted.%d" % os.getpid())
            os.close(os.open(f, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
            os.unlink(f)
        return "ok"
    except OSError as e:
        return errno.errorcode.get(e.errno, str(e.errno))

probes = json.loads(sys.argv[1])
answers = {p["id"]: run(p) for p in probes}
if len(sys.argv) > 2:
    print(json.dumps(answers))
else:
    child = subprocess.run([sys.executable, "-s", "-P", sys.argv[0], sys.argv[1], "child"], capture_output=True, text=True, timeout=30)
    print(json.dumps({"self": answers, "child": json.loads(child.stdout.strip().splitlines()[-1])}))
`

type Answers = { self: Record<string, string>; child: Record<string, string> }

describe.runIf(runtimeAvailable())('the private socket folder under the runtime profile (live, macOS Seatbelt)', () => {
  let world: RuntimeWorld
  let folder = ''
  let confined: Answers
  let plain: Answers
  const servers: net.Server[] = []

  const probes = () => [
    { id: 'connect: the agent socket (acp)', k: 'connect', path: world.facts.permSocket },
    { id: 'connect: the pay socket', k: 'connect', path: world.facts.paySocket },
    { id: 'list: the socket folder', k: 'list', path: folder },
    { id: 'create: a file in the socket folder', k: 'create', path: folder }
  ]

  beforeAll(async () => {
    world = createRuntimeWorld({ mainSockets: true })

    const userData = world.paths.userDataDir

    // The world names main's sockets exactly as main does, in one private folder of this userData.
    expect(world.facts.permSocket).toBe(socketPath(userData, 'acp'))
    expect(world.facts.paySocket).toBe(socketPath(userData, 'pay'))
    folder = path.dirname(socketPath(userData, 'acp'))
    expect(path.dirname(socketPath(userData, 'pay'))).toBe(folder)

    for (const file of [world.facts.permSocket!, world.facts.paySocket!]) {
      const server = net.createServer(socket => socket.end())

      servers.push(server)
      await new Promise<void>(resolve => server.listen(file, () => resolve()))
    }

    const probeFile = path.join(world.root, 'project', 'socket-folder-probe.py')

    writeFileSync(probeFile, PROBE)

    const ask = async (confine: boolean): Promise<Answers> => {
      const run = await world.run(confine, [probeFile, JSON.stringify(probes())], { timeoutMs: 60_000 })

      try {
        return JSON.parse(run.out.trim().split('\n').at(-1) ?? '') as Answers
      } catch {
        throw new Error(`probe run failed (exit ${run.code}): ${run.err.slice(-600)}`)
      }
    }

    confined = await ask(true)
    plain = await ask(false)
  }, 300_000)

  afterAll(async () => {
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))))

    if (folder) {
      rmSync(folder, { recursive: true, force: true })
    }

    world?.dispose()
  }, 120_000)

  it('the profile names each socket only as a literal; the folder appears only in a write deny, never an allow', () => {
    const text = generateRuntimeProfile(world.paths).text

    expect(text).toContain('(iclone-sockets \'("LAUNCHER_SOCKET" "PERM_SOCKET" "PAY_SOCKET"))')
    expect(text.split('\n').filter(line => line.includes(folder) && !line.startsWith('(deny file-write*'))).toEqual([])
  })

  for (const where of ['self', 'child'] as const) {
    it(`${where}: connects to the agent and pay sockets; cannot list nor create in their folder (paired, unconfined ok)`, () => {
      const [acp, pay, list, create] = probes().map(probe => probe.id)

      expect({ confined: confined[where], plain: plain[where] }).toEqual({
        confined: { [acp]: 'ok', [pay]: 'ok', [list]: 'EPERM', [create]: 'EPERM' },
        plain: { [acp]: 'ok', [pay]: 'ok', [list]: 'ok', [create]: 'ok' }
      })
    })
  }
})
