import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

// Read from disk: the ui project stubs CSS imports to ''.
const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const wakeCss = stripComments(read('./wake-indicator.css'))
const tokensCss = stripComments(read('../home/ic-tokens.css'))

describe('wake-indicator.css reads tokens only (U3-09-p2, AD8)', () => {
  it('has no raw colour literal', () => {
    expect(wakeCss.match(/(?<![\w-])(?:rgba?|hsla?|oklch|hsb)\(/gi) ?? []).toEqual([])
    expect(wakeCss.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([])
  })

  it('every ic token it reads is declared in ic-tokens.css', () => {
    const used = [...new Set([...wakeCss.matchAll(/var\((--ic-[\w-]+)/g)].map(m => m[1]))]
    expect(used.length).toBeGreaterThanOrEqual(6)
    const undeclared = used.filter(token => !tokensCss.includes(`${token}:`))
    expect(undeclared).toEqual([])
  })

  it('imports the token file, since home.css (which imports the ic tokens) is not loaded in its window', () => {
    expect(wakeCss).toMatch(/^@import '\.\.\/home\/ic-tokens\.css';/m)
  })

  // UF2D-C1-03: the comment and this suite once claimed the window "loads no other stylesheet"; main.tsx imports
  // styles.css into every window, and only home.css is absent here. Pin what is true so the words cannot drift again.
  it('states the stylesheet facts: styles.css is global, home.css is absent here, and no one claims otherwise', () => {
    expect(read('../../main.tsx')).toMatch(/^import '\.\/styles\.css'/m)
    expect(read('./wake-indicator.css')).not.toMatch(/no other stylesheet/i)

    // UF2D-C3-02: enumerate the window's modules from the directory, so a new wake module importing home.css fails
    // here without a hand-list edit. The ui project's import.meta.url is not a file URL; vitest runs with cwd = apps/desktop.
    const wakeFiles = readdirSync(path.join(process.cwd(), 'src/app/wake-indicator')).filter(
      name => /\.(?:tsx?|css)$/.test(name) && !/\.test\./.test(name)
    )

    expect(wakeFiles).toEqual(
      expect.arrayContaining(['wake-indicator-app.tsx', 'wake-indicator-root.tsx', 'wake-indicator.css'])
    )

    expect(wakeFiles.filter(name => /['"][^'"]*\bhome\.css['"]/.test(stripComments(read(`./${name}`))))).toEqual([])
  })

  it('the wake tokens have a light-skin recipe', () => {
    const light = /:root\[data-hermes-theme='iclone-light'\] \{([^}]*--ic-wake-fill[^}]*)\}/.exec(tokensCss)?.[1] ?? ''

    for (const token of ['fill', 'edge', 'glow', 'halo']) {
      expect(light, token).toContain(`--ic-wake-${token}:`)
    }
  })
})
