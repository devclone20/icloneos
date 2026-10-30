// Ruling 69 / review r2 (R2-M5): main sets a non-English display.language to English in EVERY local profile's config,
// not only the profile the window had open — the edit itself, the pass over the profiles, and its wiring at launch.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { englishDisplayLanguageEverywhere, withEnglishDisplayLanguage } from './iclone-display-language'
import { makeWired, type Wired } from './iclone-x402/wired.test-helpers'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
})

function tempHome(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-lang-'))

  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }))

  return base
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, { mode: 0o600 })
}

const read = (file: string) => fs.readFileSync(file, 'utf8')

describe('withEnglishDisplayLanguage: the one value, nothing else', () => {
  it('rewrites another language to en and keeps every other byte', () => {
    expect(
      withEnglishDisplayLanguage('model: x\ndisplay:\n  skin: slate\n  language: pt-PT\nterminal:\n  cwd: /a\n')
    ).toEqual({
      text: 'model: x\ndisplay:\n  skin: slate\n  language: en\nterminal:\n  cwd: /a\n',
      from: 'pt-PT'
    })
    expect(withEnglishDisplayLanguage("display:\n    language: 'pt'   # set by 0.0.2\n")).toEqual({
      text: 'display:\n    language: en   # set by 0.0.2\n',
      from: 'pt'
    })
  })

  it('leaves English, an English alias, an empty value, no display block and a deeper language key as they are', () => {
    for (const text of [
      'display:\n  language: en\n',
      'display:\n  language: EN-US\n',
      'display:\n  language: en_GB\n',
      'display:\n  language:\n',
      'display:\n  language: null\n',
      'model: x\n',
      'display:\n  tts:\n    language: pt-PT\n  skin: slate\n',
      'voice:\n  language: pt-PT\n'
    ]) {
      expect(withEnglishDisplayLanguage(text)).toEqual({ text, from: null })
    }
  })

  it('a flow-style display block is not guessed at: it is reported and left', () => {
    expect(withEnglishDisplayLanguage('display: {language: pt-PT}\n')).toEqual({
      skip: 'config.yaml display block not understood (flow style)'
    })
  })
})

describe('englishDisplayLanguageEverywhere: every local profile, never outside the Hermes home', () => {
  it('rewrites the root and each profile that is not English; a profile linked outside the home is never written', () => {
    const base = tempHome()
    const home = path.join(base, 'hermes')
    const outside = path.join(base, 'elsewhere', 'away')

    write(path.join(home, 'config.yaml'), 'display:\n  language: en\n')
    write(path.join(home, 'profiles', 'work', 'config.yaml'), 'model: w\ndisplay:\n  language: pt-PT\n')
    write(path.join(home, 'profiles', 'play', 'config.yaml'), 'display:\n  language: "pt"\n')
    write(path.join(outside, 'config.yaml'), 'display:\n  language: pt-PT\n')
    fs.symlinkSync(outside, path.join(home, 'profiles', 'away'))

    const passes = englishDisplayLanguageEverywhere(home)

    expect(read(path.join(home, 'profiles', 'work', 'config.yaml'))).toBe('model: w\ndisplay:\n  language: en\n')
    expect(read(path.join(home, 'profiles', 'play', 'config.yaml'))).toBe('display:\n  language: en\n')
    expect(read(path.join(home, 'config.yaml'))).toBe('display:\n  language: en\n')
    expect(read(path.join(outside, 'config.yaml'))).toBe('display:\n  language: pt-PT\n')
    expect(passes.map(pass => [pass.slug, pass.rewrote])).toEqual([
      ['default', null],
      ['play', 'pt'],
      ['work', 'pt-PT']
    ])
    expect(fs.statSync(path.join(home, 'profiles', 'work', 'config.yaml')).mode & 0o777).toBe(0o600)
  })
})

describe('R2-M5: main runs the pass at launch, for a profile the window never opened', () => {
  it('registerPayments with HERMES_HOME: a non-active profile saved in pt-PT reads en right after launch', async () => {
    const home = tempHome()

    write(path.join(home, 'config.yaml'), 'model:\n  default: x\n')
    write(path.join(home, 'profiles', 'inft-7', 'config.yaml'), 'display:\n  language: pt-PT\n')

    const world: Wired = await makeWired({ hermesHome: home })

    cleanups.unshift(() => world.close())

    expect(read(path.join(home, 'profiles', 'inft-7', 'config.yaml'))).toMatch(/^display:\n {2}language: en\n/)
  })

  // Review r3 (R3-m1): every root config in the tests above was already English or had no display block, so a pass
  // that listed the root and never wrote it stayed green.
  it('registerPayments with HERMES_HOME: the ROOT config saved in pt-PT reads en right after launch', async () => {
    const home = tempHome()

    write(path.join(home, 'config.yaml'), 'model:\n  default: x\ndisplay:\n  language: pt-PT\n')

    const world: Wired = await makeWired({ hermesHome: home })

    cleanups.unshift(() => world.close())

    expect(read(path.join(home, 'config.yaml'))).toMatch(/^model:\n {2}default: x\ndisplay:\n {2}language: en\n/)
  })
})
