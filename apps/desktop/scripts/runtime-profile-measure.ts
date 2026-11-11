/**
 * Measures the Hermes runtime's boot under its Seatbelt profile: runs each phase confined in a throwaway world, prints
 * every kernel denial the profile caused (operation, target), then times the cold `--help` and the backend boot with
 * and without the profile (median of N). Never touches the real Hermes home, the keychain or the installed app.
 *
 *   npx tsx scripts/runtime-profile-measure.ts            # denials per phase
 *   npx tsx scripts/runtime-profile-measure.ts --time 5   # plus timings
 *   npx tsx scripts/runtime-profile-measure.ts --hermes-home-in-userdata   # HERMES_HOME inside userData
 */
import { existsSync } from 'node:fs'
import path from 'node:path'

import { collectDenials, createRuntimeWorld, expectedDenial, runtimeAvailable } from '../electron/iclone-confinement/runtime-live-harness'

if (!runtimeAvailable()) {
  console.error('needs macOS, /usr/bin/sandbox-exec and the runtime venv')
  process.exit(2)
}

// --hermes-home-in-userdata: HERMES_HOME at `<userData>/hermes-home`, as a fresh-install run puts it.
const world = createRuntimeWorld({ hermesHome: process.argv.includes('--hermes-home-in-userdata') ? 'userData' : 'beside' })
const timeIndex = process.argv.indexOf('--time')
const rounds = timeIndex > 0 ? Number(process.argv[timeIndex + 1] ?? 5) : 0
const readyFile = path.join(world.readyDir, 'ready.json')
const SERVE = ['-m', 'hermes_cli.main', 'serve', '--host', '127.0.0.1', '--port', '0']

const phases: { name: string; args: string[]; env?: Record<string, string>; until?: () => boolean }[] = [
  { name: 'a1 interpreter + import hermes_bootstrap', args: ['-c', 'import hermes_bootstrap; print("ok")'] },
  { name: 'a2 hermes --help', args: ['-m', 'hermes_cli.main', '--help'] },
  {
    name: 'b  serve until ready file',
    args: SERVE,
    env: { HERMES_DESKTOP_READY_FILE: readyFile },
    until: () => existsSync(readyFile)
  },
  {
    name: 'c  interpreter child',
    args: [
      '-c',
      'import os, subprocess, sys; r = subprocess.run([sys.executable, "-s", "-P", "-c", "import hermes_bootstrap; print(42)"], env=os.environ, capture_output=True, text=True); print(r.returncode, r.stdout.strip(), r.stderr[-300:])'
    ]
  }
]

try {
  for (const phase of phases) {
    const { result, denials } = await collectDenials(() =>
      world.run(true, phase.args, { env: phase.env, until: phase.until, timeoutMs: 90_000 })
    )

    const ready = phase.until ? phase.until() : null
    const seen = new Map<string, number>()
    const expected = new Map<string, number>()

    for (const denial of denials) {
      const why = expectedDenial(denial, world)
      const key = why ? why : `${denial.operation} ${denial.target}`
      const into = why ? expected : seen

      into.set(key, (into.get(key) ?? 0) + 1)
    }

    console.log(`\n== ${phase.name}: exit ${result.code} ${result.signal ?? ''} ${Math.round(result.ms)} ms${ready === null ? '' : ` ready=${ready}`}`)
    console.log(`   stdout: ${result.out.trim().split('\n').slice(-2).join(' | ').slice(0, 300)}`)

    if (result.code !== 0 && !ready) {
      console.log(`   stderr: ${result.err.trim().split('\n').slice(-6).join('\n           ')}`)
    }

    for (const [why, count] of expected) {
      console.log(`   expected (${count}): ${why}`)
    }

    console.log(`   UNEXPECTED denials: ${seen.size}`)

    for (const [key, count] of seen) {
      console.log(`   - ${key}${count > 1 ? ` (x${count})` : ''}`)
    }

  }

  if (rounds > 0) {
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

    for (const confined of [false, true]) {
      const help: number[] = []
      const boot: number[] = []

      for (let i = 0; i < rounds; i += 1) {
        help.push((await world.run(confined, ['-m', 'hermes_cli.main', '--help'])).ms)

        const file = path.join(world.readyDir, `t-${confined}-${i}.json`)

        const run = await world.run(confined, SERVE, {
          env: { HERMES_DESKTOP_READY_FILE: file },
          until: () => existsSync(file),
          timeoutMs: 90_000
        })

        boot.push(existsSync(file) ? run.ms : Number.NaN)
      }

      console.log(
        `\n${confined ? 'confined' : 'plain   '}  --help median ${Math.round(median(help))} ms [${help.map(Math.round).join(', ')}]  serve-ready median ${Math.round(median(boot))} ms [${boot.map(Math.round).join(', ')}]`
      )
    }
  }
} finally {
  world.dispose()
}
