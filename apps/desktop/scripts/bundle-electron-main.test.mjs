// K141 — the Electron bundles never name a path of the build machine, even when node_modules is a symlink into
// another checkout (the lab worktree layout that leaked the owner's home 409× in the trial build).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'vitest'

import { bundleElectron, bundleOptions, buildPlaces, leakedBuildPaths, rendererLeaks } from './bundle-electron-main.mjs'

/**
 * A fake machine: `home/Desktop/VAULT/lab/app` is the main checkout (the real node_modules, one CJS dependency) and
 * `home/Developer/wt/app` a worktree whose node_modules (root and apps/desktop) are symlinks into it.
 */
function symlinkedWorktree({ entry = "import dep from 'leaky-dep'\nexport const v = dep()\n" } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'k141-home-')))
  const main = path.join(home, 'Desktop', 'VAULT', 'lab', 'app')
  const dep = path.join(main, 'node_modules', 'leaky-dep')
  fs.mkdirSync(dep, { recursive: true })
  fs.writeFileSync(path.join(dep, 'package.json'), '{"name":"leaky-dep","main":"index.js"}')
  fs.writeFileSync(path.join(dep, 'index.js'), 'module.exports = function () { return 42 }\n')
  fs.mkdirSync(path.join(main, 'apps', 'desktop', 'node_modules'), { recursive: true })

  const repo = path.join(home, 'Developer', 'wt', 'app')
  const root = path.join(repo, 'apps', 'desktop')
  fs.mkdirSync(path.join(root, 'electron'), { recursive: true })
  fs.symlinkSync(path.join(main, 'node_modules'), path.join(repo, 'node_modules'))
  fs.symlinkSync(path.join(main, 'apps', 'desktop', 'node_modules'), path.join(root, 'node_modules'))
  fs.writeFileSync(path.join(root, 'electron', 'main.ts'), entry)
  fs.writeFileSync(path.join(root, 'electron', 'preload.ts'), "import dep from 'leaky-dep'\nconsole.log(dep())\n")

  return { home, main, root }
}

const quiet = { log: () => {}, logLevel: 'silent' }

describe('K141: no build-machine path in the Electron bundles', () => {
  test('a worktree with symlinked node_modules bundles with tree-relative module names only', async () => {
    const { home, root } = symlinkedWorktree()
    await bundleElectron({ root, home, ...quiet })

    for (const file of ['electron-main.mjs', 'electron-preload.js']) {
      const text = fs.readFileSync(path.join(root, 'dist', file), 'utf8')

      assert.equal(text.split(home).length - 1, 0, `${file}: names the home folder`)
      assert.equal(text.split(path.join('Desktop', 'VAULT', 'lab')).length - 1, 0, `${file}: names the main checkout`)
      assert.match(text, /node_modules\/leaky-dep\/index\.js/, `${file}: the module keeps its tree-relative name`)
    }
  })

  test('the build refuses a bundle that still names a machine place (absolute or by its home-relative tail)', async () => {
    const { home, root } = symlinkedWorktree({
      entry: `export const where = ${JSON.stringify(path.join('Desktop', 'VAULT', 'lab', 'app', 'x'))}\n`
    })

    await assert.rejects(bundleElectron({ root, home, ...quiet }), /names a path of the build machine .*K141/)
    // m3: the refused bundle never reaches dist/, and no temp file is left beside it.
    assert.equal(fs.existsSync(path.join(root, 'dist', 'electron-main.mjs')), false)
    assert.deepEqual(fs.readdirSync(path.join(root, 'dist')), [])
  })

  test('a refused rebuild removes the previous bundle instead of leaving dist/ looking built', async () => {
    const { home, root } = symlinkedWorktree()
    await bundleElectron({ root, home, ...quiet })
    assert.ok(fs.existsSync(path.join(root, 'dist', 'electron-preload.js')))

    fs.writeFileSync(
      path.join(root, 'electron', 'preload.ts'),
      `console.log(${JSON.stringify(path.join(home, 'x'))})\n`
    )
    await assert.rejects(bundleElectron({ root, home, ...quiet }), /K141/)
    // Both bundles are checked before either is written, and neither old one is left: the clean main goes too.
    assert.equal(fs.existsSync(path.join(root, 'dist', 'electron-preload.js')), false)
    assert.equal(fs.existsSync(path.join(root, 'dist', 'electron-main.mjs')), false)
    assert.deepEqual(
      fs.readdirSync(path.join(root, 'dist')).filter(f => f.endsWith('.tmp')),
      []
    )
  })

  test('the home folder itself is a place: a bundle naming any path under it is refused', async () => {
    const { home, root } = symlinkedWorktree()
    const outside = path.join(home, '.config', 'tool', 'settings.json') // under home, outside the tree and node_modules
    fs.writeFileSync(path.join(root, 'electron', 'main.ts'), `export const cfg = ${JSON.stringify(outside)}\n`)

    assert.ok(buildPlaces(root, home).includes(home))
    await assert.rejects(bundleElectron({ root, home, ...quiet }), /K141/)
  })

  test('a refused preload means no main either: nothing is written until both bundles are clean', async () => {
    const { home, root } = symlinkedWorktree()
    fs.writeFileSync(
      path.join(root, 'electron', 'preload.ts'),
      `console.log(${JSON.stringify(path.join(home, 'x'))})\n`
    )

    await assert.rejects(bundleElectron({ root, home, ...quiet }), /electron-preload\.js: names a path .*K141/)
    assert.deepEqual(fs.readdirSync(path.join(root, 'dist')), [])
  })

  test('leakedBuildPaths: absolute place, its home-relative tail, and nothing for a clean relative name', () => {
    const home = '/Users/someone'
    const places = ['/Users/someone/Desktop/VAULT/lab/app', home]

    assert.deepEqual(leakedBuildPaths('// ../../node_modules/x/index.js', places, home), [])
    assert.deepEqual(leakedBuildPaths('"../../../../Desktop/VAULT/lab/app/node_modules/x"', places, home), [
      { place: '/Users/someone/Desktop/VAULT/lab/app', count: 1 }
    ])
    assert.deepEqual(leakedBuildPaths('at /Users/someone/x', places, home), [{ place: home, count: 1 }])
  })

  test('buildPlaces names the real place of a symlinked node_modules; both bundles preserve symlinks', () => {
    const { home, main, root } = symlinkedWorktree()

    assert.ok(buildPlaces(root, home).includes(main))
    const options = bundleOptions({ root })
    assert.equal(options.main.preserveSymlinks, true)
    assert.equal(options.preload.preserveSymlinks, true)
    assert.equal(options.main.absWorkingDir, root)
  })
})

describe('K141 r2 (m4): the Vite renderer output is checked like the Electron bundles', () => {
  /** A renderer as vite leaves it in dist/ (index.html + hashed assets), with `extra` files written under dist/. */
  function renderer(root, extra = {}) {
    const files = {
      'index.html': '<!doctype html><script type="module" src="./assets/index-abc.js"></script>',
      'assets/index-abc.js': 'import("./chunk-1.js");export const x=1',
      'assets/chunk-1.js': 'export const y="../../node_modules/x/index.js"',
      ...extra
    }

    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, 'dist', rel)), { recursive: true })
      fs.writeFileSync(path.join(root, 'dist', rel), text)
    }
  }

  test('a clean renderer passes and stays built', async () => {
    const { home, root } = symlinkedWorktree()
    renderer(root)

    await bundleElectron({ root, home, ...quiet })
    assert.ok(fs.existsSync(path.join(root, 'dist', 'index.html')))
    assert.ok(fs.existsSync(path.join(root, 'dist', 'electron-main.mjs')))
    assert.deepEqual(rendererLeaks({ root, home }), [])
  })

  test('a renderer chunk, stylesheet or source map naming a machine place refuses the build and un-builds dist/', async () => {
    for (const [rel, text] of [
      ['assets/chunk-2.js', (home, main) => `const p=${JSON.stringify(path.join(main, 'src', 'a.ts'))}`],
      ['assets/index.css', home => `/* ${home}/x */ body{}`],
      ['assets/index-abc.js.map', home => `{"sources":["${home}/Developer/wt/app/src/a.ts"]}`],
      ['nested/deep/page.html', () => `<a href="file://${path.join('Desktop', 'VAULT', 'lab', 'app')}">`]
    ]) {
      const { home, main, root } = symlinkedWorktree()
      renderer(root, { [rel]: text(home, main) })

      await assert.rejects(
        bundleElectron({ root, home, ...quiet }),
        /\(renderer\): names a path of the build machine \(1 file\(s\), \d+ occurrence\(s\)\) — K141/,
        rel
      )
      assert.equal(fs.existsSync(path.join(root, 'dist', 'index.html')), false, rel)
      assert.equal(fs.existsSync(path.join(root, 'dist', 'electron-main.mjs')), false, rel)
      // K141 r3 (m3): the leaking file itself is gone too; the clean renderer files stay for the next build.
      assert.equal(fs.existsSync(path.join(root, 'dist', rel)), false, rel)
      assert.deepEqual(rendererLeaks({ root, home }), [], rel)
      assert.ok(fs.existsSync(path.join(root, 'dist', 'assets', 'chunk-1.js')), rel)
    }
  })

  test('a refusal names the refused output relative to the app folder, never by the machine path (n4)', async () => {
    const { home, root } = symlinkedWorktree()
    renderer(root, { 'assets/leak.js': `"${home}"` })

    const error = await bundleElectron({ root, home, ...quiet }).catch(e => e)

    assert.match(String(error.message), /^dist\/ \(renderer\): /)
    assert.ok(!String(error.message).includes(home))
    assert.ok(!String(error.message).includes(root))
  })

  test('images and the Electron bundles are not renderer text; a dev bundle skips the renderer check', async () => {
    const { home, root } = symlinkedWorktree()
    renderer(root, { 'icon.png': `PNG ${home}` })
    assert.deepEqual(rendererLeaks({ root, home }), [])

    renderer(root, { 'assets/leak.js': `"${home}"` })
    await bundleElectron({ root, home, ...quiet, isDev: true })
    assert.ok(fs.existsSync(path.join(root, 'dist', 'index.html')))
  })
})
