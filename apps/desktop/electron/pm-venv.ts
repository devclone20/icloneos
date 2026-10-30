import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * V3-RT (found by the RT-4 live install): from the 1ac3f97 runtime on, install.sh's python-deps stage hands the
 * dependency environment to PM, which builds it OUTSIDE the tree — `<HERMES_HOME>/installs/<install key>/environments/
 * <generation>/venv`, recorded in that install's `facts.json` (pm/environments.py: install_key = sha256 of the resolved
 * root, first 16 hex; `_recorded_venv` reads `packages.venv.environment`) — and no in-tree `venv` exists. The committed
 * environment of `root`, when PM recorded one that is really there; null otherwise (an older in-tree install).
 */
export function pmCommittedVenv(root: string, hermesHome: string): null | string {
  try {
    const canonical = fs.realpathSync(root)
    const key = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16)

    const facts = JSON.parse(fs.readFileSync(path.join(hermesHome, 'installs', key, 'facts.json'), 'utf8')) as {
      packages?: { venv?: { environment?: unknown } }
    }

    const env = facts?.packages?.venv?.environment

    return typeof env === 'string' &&
      path.isAbsolute(env) &&
      fs.existsSync(path.join(env, 'pyvenv.cfg')) &&
      fs.existsSync(path.join(env, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'))
      ? env
      : null
  } catch {
    return null
  }
}
