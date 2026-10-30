import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Button } from './button'

// Read from disk: the ui project stubs CSS imports to ''.
const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')
const buttonSource = read('./button.tsx')
const stylesCss = read('../../styles.css')
const tokensCss = read('../../app/home/ic-tokens.css')
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** The size keys of the cva config, read from the source so a new size cannot escape the check. */
function sizeKeys(): string[] {
  const block = /size: \{([\s\S]*?)\n {6}\}/.exec(buttonSource)?.[1]

  if (!block) {
    throw new Error('size variants block not found in button.tsx')
  }

  return [...block.matchAll(/^\s*'?([\w-]+)'?:/gm)].map(m => m[1])
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)

    if (statSync(p).isDirectory()) {
      walk(p, out)
    } else if (/\.(css|ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p)
    }
  }

  return out
}

describe('Button radius (U3-08-p2)', () => {
  it('every size shares the one control radius token; no literal radius remains', () => {
    const sizes = sizeKeys()
    expect(sizes.length).toBeGreaterThanOrEqual(10)

    for (const size of sizes) {
      const { container, unmount } = render(<Button size={size as never}>x</Button>)
      const className = container.firstElementChild?.className ?? ''
      expect(className, size).toContain('rounded-(--ic-radius-control)')
      expect(className, size).not.toMatch(/rounded-\[/)
      unmount()
    }

    expect(buttonSource).not.toMatch(/rounded-\[/)
  })

  it('the control radius token is a step of the ic radius scale', () => {
    expect(stripComments(tokensCss)).toMatch(/--ic-radius-control: var\(--ic-radius-xs\);/)
  })

  it('every @font-face registered in styles.css has a consumer outside it', () => {
    const families = [...stylesCss.matchAll(/@font-face \{[^}]*font-family: '([^']+)'/g)].map(m => m[1])
    expect(families.length).toBeGreaterThan(0)
    const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
    const sources = walk(srcRoot).filter(p => !p.endsWith('/styles.css'))

    for (const family of new Set(families)) {
      const consumers = sources.filter(p => readFileSync(p, 'utf8').includes(`'${family}'`))
      expect(consumers.length, family).toBeGreaterThan(0)
    }
  })
})

describe('focus-visible contract in styles.css (U3-01-p2)', () => {
  const flat = stripComments(stylesCss)

  it('no global rule kills the outline or the Tailwind ring on :focus-visible', () => {
    expect(flat).not.toMatch(/\*:focus(-visible)?[^{]*\{[^}]*outline:\s*none/)
    expect(flat).not.toMatch(/--tw-ring-shadow:\s*0 0 #0000\s*!important/)
    expect(flat).not.toMatch(/--tw-ring-offset-shadow:[^;]*!important/)
  })

  it('one layered token ring covers every control; pointer focus draws nothing', () => {
    const bases = [...flat.matchAll(/@layer base \{([\s\S]*?)\n\}/g)].map(m => m[1])

    const ring = bases.find(b =>
      /:focus-visible \{\s*outline: 2px solid var\(--ic-accent\);\s*outline-offset: 2px;\s*\}/.test(b)
    )

    expect(ring, 'a @layer base block with the token outline').toBeDefined()
    expect(ring).toMatch(/:focus:not\(:focus-visible\) \{\s*outline: none;\s*\}/)
  })

  it('the Button keeps its own Tailwind ring, which the base rule now lets through', () => {
    const { container } = render(<Button>x</Button>)
    const className = container.firstElementChild?.className ?? ''
    expect(className).toContain('focus-visible:ring-[0.1875rem]')
    expect(className).toContain('outline-none')
  })
})
