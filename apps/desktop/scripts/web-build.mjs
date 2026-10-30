#!/usr/bin/env node
// Build icloneOS Web (vite.web.config.ts, --mode web) into dist-web/, check the PWA contract, stamp the build commit
// (BUILD_COMMIT.txt) and write SHA256SUMS.txt. `--dev` builds an unstamped dist-web that make-distribution refuses.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertClean, scanTree } from './artifact-hygiene.mjs'
import { COMMIT_RE, listFiles, WEB_COMMIT_FILE } from './make-distribution.mjs'
import { sha256SumsText } from './release-mac.mjs'
import { isMain } from './utils.mjs'

const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const WEB_DIST = join(DESKTOP_DIR, 'dist-web')

const REPO_ROOT = resolve(DESKTOP_DIR, '..', '..')

function defaultGit(args) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })

  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr ?? '').trim().slice(0, 200)}`)
  }

  return result.stdout
}

/** The commit dist-web is built from (GITHUB_SHA in CI, else HEAD). Refuses a tree that differs from it, like
 *  release-mac.mjs, except dist-web itself (the build's own output). */
export function webBuildCommit({ env = process.env, git = defaultGit } = {}) {
  const head = git(['rev-parse', 'HEAD']).trim()
  const commit = env.GITHUB_SHA || head

  if (!COMMIT_RE.test(commit)) {
    throw new Error(`no build commit (GITHUB_SHA or HEAD is ${JSON.stringify(commit).slice(0, 60)})`)
  }

  if (commit !== head) {
    throw new Error(`GITHUB_SHA ${commit} is not the checked-out HEAD ${head}`)
  }

  const dirty = git(['status', '--porcelain', '--', '.', ':(exclude)apps/desktop/dist-web']).trim()

  if (dirty) {
    const count = dirty.split('\n').length

    throw new Error(
      `the tree has ${count} uncommitted change(s): commit them, or build with --dev (unstamped; make-distribution refuses it)`
    )
  }

  return commit
}

/** .env* files Vite reads from apps/desktop that are not committed: ignored ones never show in a plain `git status`. */
export function viteEnvFiles({ git = defaultGit } = {}) {
  return git(['status', '--porcelain', '--ignored', '--untracked-files=all', '--', 'apps/desktop/.env*'])
    .split('\n')
    .filter(Boolean)
    .map(line => line.slice(3))
}

export function refuseViteEnvFiles(deps) {
  const files = viteEnvFiles(deps)

  if (files.length > 0) {
    throw new Error(`Vite would read ${files.join(', ')} into the web build; move them out of apps/desktop first`)
  }
}

export function writeWebCommit(dir, commit) {
  writeFileSync(join(dir, WEB_COMMIT_FILE), `${commit}\n`)
}

/** Problems with a built web dist; [] means it is a shippable PWA. */
export function checkWebDist(dir) {
  const problems = []
  const read = name => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : null)
  const index = read('index.html')
  const sw = read('sw.js')
  const manifest = read('manifest.webmanifest')

  if (!index || !index.includes('rel="manifest" href="/manifest.webmanifest"')) {
    problems.push('index.html does not link manifest.webmanifest')
  }

  if (index && index.includes('/src/')) {
    problems.push('index.html still references /src/ (shim not bundled)')
  }

  if (!sw || !/function swRoute\(/.test(sw) || !/['"]\/api['"]/.test(sw)) {
    problems.push('sw.js is missing or lacks the network-only policy')
  }

  if (sw && /\.(add|addAll|put)\(\s*[^)]*['"]\/api/.test(sw)) {
    problems.push('sw.js caches /api')
  }

  try {
    const parsed = JSON.parse(manifest ?? '')

    if (parsed.display !== 'standalone' || !parsed.icons?.some(icon => icon.sizes === '512x512') || !parsed.start_url) {
      problems.push('manifest.webmanifest is not installable (display/icons/start_url)')
    }
  } catch {
    problems.push('manifest.webmanifest is missing or not JSON')
  }

  for (const name of ['icon-512.png', 'offline.html']) {
    if (!existsSync(join(dir, name))) {
      problems.push(`missing ${name}`)
    }
  }

  return problems
}

export function writeWebSums(dir) {
  const entries = listFiles(dir)
    .filter(name => name !== 'SHA256SUMS.txt')
    .map(name => ({
      name,
      sha256: createHash('sha256')
        .update(readFileSync(join(dir, name)))
        .digest('hex')
    }))

  writeFileSync(join(dir, 'SHA256SUMS.txt'), sha256SumsText(entries))

  return entries.length
}

function main(argv) {
  const unknown = argv.filter(arg => arg !== '--dev')

  if (unknown.length > 0) {
    throw new Error(`unknown argument: ${unknown[0]}`)
  }

  const dev = argv.includes('--dev')
  refuseViteEnvFiles()
  const commit = dev ? null : webBuildCommit()

  const build = spawnSync('npx', ['--no-install', 'vite', 'build', '--config', 'vite.web.config.ts', '--mode', 'web'], {
    cwd: DESKTOP_DIR,
    stdio: 'inherit'
  })

  if (build.status !== 0) {
    return build.status ?? 1
  }

  const problems = checkWebDist(WEB_DIST)

  if (problems.length > 0) {
    throw new Error(problems.join('; '))
  }

  assertClean(scanTree(WEB_DIST), 'dist-web')

  rmSync(join(WEB_DIST, WEB_COMMIT_FILE), { force: true })

  if (commit) {
    // The tree may have moved while Vite ran (other writers share it): stamp only a commit that held start to end.
    const after = webBuildCommit()

    if (after !== commit) {
      throw new Error(`HEAD moved from ${commit} to ${after} during the build`)
    }

    writeWebCommit(WEB_DIST, commit)
  }

  console.log(
    `[web-build] ${WEB_DIST}: ${writeWebSums(WEB_DIST)} files hashed, ${commit ? `commit ${commit}` : 'dev build (unstamped)'}`
  )

  return 0
}

if (isMain(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (error) {
    console.error(`[web-build] ${error.message}`)
    process.exit(1)
  }
}
