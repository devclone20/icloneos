#!/usr/bin/env node
// bundle-electron-main.mjs — bundles electron/main.ts and electron/preload.ts
// into self-contained js files in dist/ so the packaged app doesn't need
// node_modules/ or tsx at runtime.
//
// Output:
//   dist/electron-main.mjs    (MJS bundle — entry point for packaged app)
//   dist/electron-preload.js (CJS bundle — loaded via BrowserWindow preload)
//   dist/hardlinks-walk-worker.cjs (CJS bundle — the F7 guard's full-scan worker thread, v0.0.7 CF1: main reads it
//                             and starts it as a worker_threads script, electron/iclone-confinement/hardlinks-walker.ts)
//
// `electron`, `node-pty` and `get-windows` are external (provided by
// the runtime / staged separately via stage-native-deps). The F7 guard's FSEvents addon is
// loaded by path at runtime (dist/native/iclone_fsevents.node), so the bundle never sees it.
//
// K141: the bundles must never carry a path of the build machine. esbuild
// names every module in a `// <path>` comment and in its __commonJS/__esm key,
// relative to the working directory but computed from the module's REAL path:
// with node_modules symlinked into a worktree (the lab layout), those paths
// climbed out of the tree into the owner's home. `preserveSymlinks` keeps every
// module at the path it was reached by (inside the tree; the module set is
// the same: 667 = 667 measured), and the build refuses an output that still
// names the home, the tree or the real place of node_modules.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isMain } from './utils.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const DESKTOP_ROOT = resolve(here, '..')

const EXTERNAL = ['electron', 'node-pty', 'get-windows', 'fs']

/** The esbuild options of both bundles (exported for the test that builds a symlinked fixture with them). */
export function bundleOptions({ root = DESKTOP_ROOT, isDev = false, logLevel = 'info' } = {}) {
  const distDir = resolve(root, 'dist')
  // Production bundles bake packaged=true so unpackaged `electron .` still
  // behaves like a packaged build. Dev bundles (`--dev`) leave the env alone
  // so HERMES_DESKTOP_DEV_SERVER / source-tree resolution keep working.
  const define = isDev ? {} : { 'process.env.HERMES_DESKTOP_IS_PACKAGED': JSON.stringify(true) }
  const common = {
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    target: 'node20',
    external: EXTERNAL,
    define,
    preserveSymlinks: true,
    logLevel
  }

  return {
    main: {
      ...common,
      entryPoints: [resolve(root, 'electron/main.ts')],
      format: 'esm',
      outfile: resolve(distDir, 'electron-main.mjs'),
      banner: {
        // v0.0.7 rehearsal 2026-11-11: the banner's import must not take a name a source module can import too. With
        // `import { createRequire } from 'node:module'` in iclone-fsevents.ts, the bundle declared it twice and the
        // packed app threw a SyntaxError before its first line ran. A private name: no source import can collide.
        js: "import { createRequire as __icloneBannerCreateRequire } from 'module'; const require = __icloneBannerCreateRequire(import.meta.url);"
      }
    },
    preload: {
      ...common,
      entryPoints: [resolve(root, 'electron/preload.ts')],
      format: 'cjs',
      outfile: resolve(distDir, 'electron-preload.js')
    },
    // CF1: imports only `node:` modules; evaluated as a worker's script, so CommonJS with no banner.
    walkWorker: {
      ...common,
      entryPoints: [resolve(root, 'electron/iclone-confinement/hardlinks-walk.ts')],
      format: 'cjs',
      outfile: resolve(distDir, 'hardlinks-walk-worker.cjs')
    }
  }
}

function realOrSelf(p) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * The machine places a bundle must not name: the home folder, the tree and the real places of the tree and of every
 * node_modules it reads through (a symlinked node_modules lives somewhere else on the machine). Absolute forms only;
 * the tree-relative form ("../../node_modules/x") is what a clean bundle carries.
 */
export function buildPlaces(root = DESKTOP_ROOT, home = homedir()) {
  const repo = resolve(root, '..', '..')
  const places = [home, root, repo, realOrSelf(root), realOrSelf(repo)]

  for (const nm of [resolve(root, 'node_modules'), resolve(repo, 'node_modules')]) {
    const real = realOrSelf(nm)

    // The folder that holds a symlinked node_modules: its tail is the machine layout that leaked (K141).
    if (real !== nm) {
      places.push(dirname(real))
    }
  }

  // Shortest-first would hide a longer one; report each distinct place once, longest first.
  return [...new Set(places.filter(p => p && p !== sep))].sort((a, b) => b.length - a.length)
}

/**
 * Where `text` names a machine place: each place is matched as written and by its home-relative tail (the form a
 * relative `../../../Desktop/…` path takes once it climbs out of the tree). Returns `[{ place, count }]`.
 */
export function leakedBuildPaths(text, places, home = homedir()) {
  const leaks = []

  for (const place of places) {
    const forms = new Set([place])

    if (place !== home && place.startsWith(home + sep)) {
      forms.add(place.slice(home.length + 1))
    }

    let count = 0

    for (const form of forms) {
      count += text.split(form).length - 1
    }

    if (count) {
      leaks.push({ place, count })
    }
  }

  return leaks
}

/** Every bundle this script writes (each checked in memory for build-machine paths before it reaches dist/). */
export const BUNDLES = ['main', 'preload', 'walkWorker']

/** The renderer files the leak check reads: the text vite emits (binaries such as images and fonts carry no path). */
const RENDERER_TEXT = /\.(?:[cm]?js|css|html?|json|svg|map|txt|webmanifest|xml)$/i
/** dist/ entries that are not the renderer: the two Electron bundles (checked in memory) and staged native deps. */
const NOT_RENDERER = new Set(['electron-main.mjs', 'electron-preload.js', 'hardlinks-walk-worker.cjs', 'node_modules'])

/**
 * K141 r2 (m4): where the Vite renderer output in `dist/` names a machine place (same places, same forms as the
 * Electron bundles). Returns `[{ file, count }]`, file relative to dist/.
 */
export function rendererLeaks({ root = DESKTOP_ROOT, home = homedir(), places = buildPlaces(root, home) } = {}) {
  const dist = resolve(root, 'dist')
  const leaks = []

  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)

      if (dir === dist && NOT_RENDERER.has(entry.name)) {
        continue
      }

      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && RENDERER_TEXT.test(entry.name)) {
        const count = leakedBuildPaths(readFileSync(full, 'utf8'), places, home).reduce((n, l) => n + l.count, 0)

        if (count) {
          leaks.push({ file: relative(dist, full), count })
        }
      }
    }
  }

  if (existsSync(dist)) {
    walk(dist)
  }

  return leaks
}

/** True when `node --check` accepts the text as the module kind its file name says (.mjs ESM, .cjs/.js CommonJS). */
export function bundleParses(text, fileName) {
  const ext = fileName.endsWith('.mjs') ? '.mjs' : '.cjs'
  const dir = mkdtempSync(join(tmpdir(), 'bundle-check-'))
  const file = join(dir, `bundle${ext}`)

  try {
    writeFileSync(file, text)

    return (
      spawnSync(process.execPath, ['--check', file], { stdio: 'ignore', env: { PATH: process.env.PATH ?? '' } })
        .status === 0
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function bundleElectron({
  root = DESKTOP_ROOT,
  isDev = false,
  home = homedir(),
  log = console.log,
  logLevel = 'info',
  renderer = !isDev
} = {}) {
  mkdirSync(resolve(root, 'dist'), { recursive: true })
  const options = bundleOptions({ root, isDev, logLevel })
  const places = buildPlaces(root, home)
  const outfiles = BUNDLES.map(which => options[which].outfile)
  const refuse = (what, places, occurrences) => {
    // Neither bundle is left behind: a failed build must not leave dist/ looking built (a later builder run would pack
    // it). Counts only: the places themselves are the machine layout this check keeps out of logs.
    for (const out of outfiles) {
      rmSync(out, { force: true })
    }

    // n4: the refused file is named relative to the app folder (the log never carries the build machine's path).
    throw new Error(`${what}: names a path of the build machine (${places}, ${occurrences} occurrence(s)) — K141`)
  }

  // m4: the renderer vite already wrote to dist/ (`vite build` runs first). A leak there removes dist/index.html too,
  // so assert-dist-built and every packaging path refuse the tree, and (K141 r3, m3) every leaking renderer file: no
  // file naming the build machine stays on disk for a later step to pick up.
  if (renderer && existsSync(resolve(root, 'dist', 'index.html'))) {
    const leaks = rendererLeaks({ root, home, places })

    if (leaks.length) {
      rmSync(resolve(root, 'dist', 'index.html'), { force: true })

      for (const leak of leaks) {
        rmSync(resolve(root, 'dist', leak.file), { force: true })
      }

      refuse(
        'dist/ (renderer)',
        `${leaks.length} file(s)`,
        leaks.reduce((n, l) => n + l.count, 0)
      )
    }
  }

  // Every bundle is built in memory and checked BEFORE any reaches dist/ (a refused bundle is never on disk), then
  // each is written to a temp name beside it and renamed into place.
  const built = []

  for (const which of BUNDLES) {
    const { outputFiles } = await build({ ...options[which], write: false })

    for (const file of outputFiles) {
      const leaks = leakedBuildPaths(file.text, places, home)

      if (leaks.length) {
        refuse(
          relative(root, options[which].outfile),
          `${leaks.length} place(s)`,
          leaks.reduce((n, l) => n + l.count, 0)
        )
      }
    }

    // A bundle the runtime cannot even parse is refused here, not found by the packed app (it shows Electron's error box
    // and never boots). `node --check` reports early errors such as a duplicate declaration, and runs nothing.
    for (const file of outputFiles) {
      if (/\.(mjs|cjs|js)$/.test(file.path) && !bundleParses(file.text, file.path)) {
        for (const out of outfiles) {
          rmSync(out, { force: true })
        }

        throw new Error(`${relative(root, file.path)}: the bundle does not parse (node --check)`)
      }
    }

    built.push({ out: options[which].outfile, outputFiles })
  }

  for (const { out, outputFiles } of built) {
    for (const file of outputFiles) {
      const temp = `${file.path}.${process.pid}.tmp`
      writeFileSync(temp, file.contents)
      renameSync(temp, file.path)
    }

    log(`bundled ${out}${isDev ? ' (dev)' : ''}`)
  }
}

if (isMain(import.meta.url)) {
  await bundleElectron({ isDev: process.argv.includes('--dev') })
}
