/**
 * The self-tests for the ACP CLI. Staging runs the staged tree under this
 * Node through the launcher (`selfTestAcp`); the packaged verification asks
 * the SHIPPED app to test itself (`--iclone-selftest=all`, judged by
 * `judgePackagedSelftest`) — the fused app has no RunAsNode, so its binary can
 * no longer be driven as Node from outside. The main process mirrors the
 * chain-list proof at first use (electron/iclone-acp.ts `ensureRuntime`).
 *
 * `--version` is NOT a proof: commander answers a global option before it
 * parses commands, so the argv bug this guards against printed the right
 * version while every command failed. `chain list --json` is a proof: the
 * subcommand must parse, the module graph must load and JSON must come out —
 * and it is static (no network, no sign-in), so it passes offline and on a
 * machine that never configured an agent.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const LAUNCHER = 'launch.cjs'
export const CLI_PACKAGE = ['runtime', 'node_modules', '@virtuals-protocol', 'acp-cli']

/** The files inside an `acp-cli` dir (staged under build/, shipped under Resources/). */
export function acpLayout(root) {
  return {
    launcher: path.join(root, LAUNCHER),
    entry: path.join(root, ...CLI_PACKAGE, 'dist', 'bin', 'acp.js'),
    pkg: path.join(root, ...CLI_PACKAGE, 'package.json'),
    nodeModules: path.join(root, 'runtime', 'node_modules')
  }
}

function firstLine(text) {
  return (text ?? '').trim().split('\n')[0]?.trim().slice(0, 240) || ''
}

/** The first JSON object in a stream that may carry human lines before it
 *  (dotenv tips contain braces of their own, so every `{` is tried). */
function firstJsonObject(text) {
  for (let at = text.indexOf('{'); at >= 0; at = text.indexOf('{', at + 1)) {
    try {
      return JSON.parse(text.slice(at))
    } catch {
      // try the next brace
    }
  }

  return undefined
}

/** Pure: judge one `chain list --json` run. */
export function judgeChainList({ status, stdout, stderr }) {
  if (status !== 0) {
    return { ok: false, error: `exit ${status}: ${firstLine(stderr) || firstLine(stdout) || 'no output'}` }
  }

  const parsed = firstJsonObject(stdout ?? '')

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: `stdout was not JSON: ${firstLine(stdout) || 'empty'}` }
  }

  if (!Array.isArray(parsed.chains) || parsed.chains.length === 0) {
    return { ok: false, error: 'the answer lists no chains' }
  }

  return { ok: true, chains: parsed.chains.length }
}

/**
 * Run `<node> launch.cjs acp.js chain list --json` the way the app's utility
 * process does — a bare environment, a throwaway ACP_CONFIG_DIR, dotenv
 * pointed at nothing — and judge the answer.
 */
export function selfTestAcp({ exec = process.execPath, root, expectVersion, timeoutMs = 60_000 }) {
  const layout = acpLayout(root)

  for (const [name, file] of Object.entries({ launcher: layout.launcher, entry: layout.entry, package: layout.pkg })) {
    if (!existsSync(file)) {
      return { ok: false, error: `${name} missing: ${file}` }
    }
  }

  const staged = JSON.parse(readFileSync(layout.pkg, 'utf8')).version

  if (expectVersion && staged !== expectVersion) {
    return { ok: false, error: `staged CLI is ${staged}, expected ${expectVersion}` }
  }

  const configDir = mkdtempSync(path.join(os.tmpdir(), 'iclone-acp-selftest-'))

  try {
    const env = {
      HOME: os.homedir(),
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
      TMPDIR: os.tmpdir(),
      ACP_CONFIG_DIR: configDir,
      DOTENV_CONFIG_PATH: path.join(configDir, 'no-dotenv'),
      DOTENV_CONFIG_QUIET: 'true',
      NODE_PATH: layout.nodeModules
    }

    const result = spawnSync(exec, [layout.launcher, layout.entry, 'chain', 'list', '--json'], {
      cwd: configDir,
      env,
      encoding: 'utf8',
      timeout: timeoutMs
    })

    if (result.error) {
      return { ok: false, error: result.error.message }
    }

    const verdict = judgeChainList(result)

    return verdict.ok ? { ...verdict, version: staged } : verdict
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
}

/** Pure: judge the JSON line `<app> --iclone-selftest=all` prints. */
export function judgePackagedSelftest({ status, stdout, stderr }, expectVersion) {
  const line = (stdout ?? '')
    .split('\n')
    .reverse()
    .find(text => text.startsWith('{"selftest"'))
  let report

  try {
    report = line ? JSON.parse(line) : undefined
  } catch {
    report = undefined
  }

  if (!report) {
    // dyld refuses the app's own framework before any app code runs: library
    // validation under the hardened runtime needs a Team ID, which ad-hoc lacks.
    const reason = /code signature in .* not valid for use in process/.test(stderr ?? '')
      ? 'dyld library validation refused the bundle (ad-hoc signature + hardened runtime has no Team ID) — run this on the Developer ID build or on an ad-hoc build without the hardened runtime'
      : firstLine(stderr) || firstLine(stdout) || 'no output'

    return { ok: false, error: `exit ${status}, no self-test report: ${reason}` }
  }

  const failed = ['acp', 'pty'].find(part => !report[part]?.ok)

  if (failed) {
    return { ok: false, error: `${failed}: ${report[failed]?.error ?? 'not run'}` }
  }

  // REL-6 (ruling 26): the app bundles no CLI. Its acp check proves the bundle carries none and that the pin it
  // installs from at first use is the one this build was made with.
  if (report.acp.bundled !== false) {
    return { ok: false, error: 'acp: the app reports a bundled ACP CLI (REL-6: it must ship only the pin)' }
  }

  if (expectVersion && report.acp.version !== expectVersion) {
    return { ok: false, error: `the pinned CLI is ${report.acp.version}, expected ${expectVersion}` }
  }

  if (status !== 0 || report.ok !== true) {
    return { ok: false, error: `exit ${status} with a passing report` }
  }

  return { ok: true, version: report.acp.version, lockSha256: report.acp.lockSha256 }
}
