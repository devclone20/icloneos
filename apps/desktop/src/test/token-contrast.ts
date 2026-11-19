/**
 * Contrast of the iclone skins, computed from the tokens the skins really declare (ic-tokens.css, the skin foreground
 * in themes/presets.ts and styles.css's ink), never from a number copied into a test. Shared by the contrast gates
 * (notification-contrast.test.ts, split-preview-contrast.test.ts).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { icloneDarkTheme, icloneLightTheme, icloneNaturalTheme } from '@/themes/presets'

export type Rgba = [number, number, number, number]

export const read = (file: string) =>
  readFileSync(path.join(process.cwd(), 'src', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

const TOKENS_CSS = read('app/home/ic-tokens.css')
const STYLES_CSS = read('styles.css')
const LIGHT_SELECTOR = ":root[data-hermes-theme='iclone-light']"

export function declarations(selector: string): Map<string, string> {
  const found = new Map<string, string>()

  for (let at = TOKENS_CSS.indexOf(`${selector} {`); at !== -1; at = TOKENS_CSS.indexOf(`${selector} {`, at + 1)) {
    const body = TOKENS_CSS.slice(at + selector.length + 2, TOKENS_CSS.indexOf('}', at))

    for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
      found.set(match[1], match[2].replace(/\s+/g, ' ').trim())
    }
  }

  return found
}

function splitArguments(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0

  for (let index = 0; index < text.length; index += 1) {
    depth += text[index] === '(' ? 1 : text[index] === ')' ? -1 : 0

    if (text[index] === ',' && depth === 0) {
      parts.push(text.slice(start, index).trim())
      start = index + 1
    }
  }

  return [...parts, text.slice(start).trim()]
}

function fail(message: string): never {
  throw new Error(message)
}

export function resolver(tokens: Map<string, string>) {
  const color = (value: string): Rgba => {
    const reference = /^var\((--[\w-]+)(?:,.*)?\)$/.exec(value)

    if (reference) {
      return color(tokens.get(reference[1]) ?? fail(`${reference[1]} is not declared`))
    }

    if (value === 'transparent') {
      return [0, 0, 0, 0]
    }

    if (value.startsWith('#')) {
      const hex = value.slice(1)

      return [0, 2, 4].map(at => parseInt(hex.slice(at, at + 2), 16) / 255).concat(1) as Rgba
    }

    const mix = /^color-mix\(in srgb, (.*)\)$/.exec(value)

    if (!mix) {
      return fail(`cannot read ${value}`)
    }

    const [first, second] = splitArguments(mix[1])
    const at = first.lastIndexOf(' ')
    const amountText = first.slice(at + 1)
    const amountToken = /^var\((--[\w-]+)\)$/.exec(amountText)
    const amount = parseFloat(amountToken ? (tokens.get(amountToken[1]) ?? '') : amountText) / 100
    const a = color(first.slice(0, at))
    const b = color(second)
    const alpha = a[3] * amount + b[3] * (1 - amount)
    const channel = (index: number) => (a[index] * a[3] * amount + b[index] * b[3] * (1 - amount)) / (alpha || 1)

    return [channel(0), channel(1), channel(2), alpha]
  }

  return color
}

export const over = (top: Rgba, under: Rgba): Rgba => {
  const blend = (index: number) => top[index] * top[3] + under[index] * (1 - top[3])

  return [blend(0), blend(1), blend(2), 1]
}

export function luminance([r, g, b]: Rgba): number {
  const linear = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)

  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

export function ratio(a: Rgba, b: Rgba): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)

  return (high + 0.05) / (low + 0.05)
}

/** --ic-ink is --dt-foreground, which styles.css derives from the skin's foreground, translucent. */
const inkDeclaration = () => /--ui-text-primary:\s*([^;]+);/.exec(STYLES_CSS)?.[1] ?? fail('no --ui-text-primary')

export function skinColors(
  foreground: string,
  skin: 'dark' | 'light',
  extra: ReadonlyArray<readonly [string, string]> = []
) {
  const tokens = new Map([
    ...declarations(':root'),
    ...(skin === 'light' ? declarations(LIGHT_SELECTOR) : []),
    ['--ui-base', foreground],
    ['--ic-ink', inkDeclaration().replace(/\s+/g, ' ').trim()],
    ...extra
  ])

  return resolver(tokens)
}

export const SKINS = [
  ['iclone-natural', icloneNaturalTheme.colors.foreground, 'dark' as const],
  ['iclone-dark', icloneDarkTheme.colors.foreground, 'dark' as const],
  ['iclone-light', icloneLightTheme.colors.foreground, 'light' as const]
] as const
