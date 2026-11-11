import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * V3-RT (found by the RT-4 live install): from the 1ac3f97 runtime on, install.sh's python-deps stage hands the
 * dependency environment to PM, which builds it OUTSIDE the tree — `<HERMES_HOME>/installs/<install key>/environments/
 * <generation>/venv`, recorded in that install's `facts.json` (pm/environments.py: install_key = sha256 of the resolved
 * root, first 16 hex; `_recorded_venv` reads `packages.venv.environment`) — and no in-tree `venv` exists. The committed
 * environment of `root`, when PM recorded one that is really there; null otherwise (an older in-tree install).
 *
 * As PM itself rules (pm/environments.py `_recorded_venv`), a record naming a venv anywhere but under this install's
 * own `environments/` folder is no record: `facts.json` selects among PM's generations, it never points elsewhere.
 * So a rewritten record cannot make the app run an interpreter from another folder.
 */
export function pmCommittedVenv(root: string, hermesHome: string): null | string {
  try {
    const canonical = fs.realpathSync(root)
    const key = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16)
    const install = path.join(hermesHome, 'installs', key)

    const facts = JSON.parse(fs.readFileSync(path.join(install, 'facts.json'), 'utf8')) as {
      packages?: { venv?: { environment?: unknown } }
    }

    const env = facts?.packages?.venv?.environment

    if (typeof env !== 'string' || !path.isAbsolute(env)) {
      return null
    }

    const generations = fs.realpathSync(path.join(install, 'environments'))
    const real = fs.realpathSync(env)

    return real.startsWith(`${generations}${path.sep}`) &&
      fs.existsSync(path.join(env, 'pyvenv.cfg')) &&
      fs.existsSync(path.join(env, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'))
      ? env
      : null
  } catch {
    return null
  }
}
