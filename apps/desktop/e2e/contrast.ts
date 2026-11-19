/**
 * v0.0.9 G design (GF-M2, GF-7): the contrast of a text element as the owner sees it, computed in the live page: its
 * ink, times every ancestor's opacity, over the backgrounds stacked under it (down to the skin's --ic-surface). Skins
 * are switched as the owner switches them, with the Theme button (the presets write the ink as inline variables), and
 * the element is measured in both modes.
 */
import { expect, type Locator, type Page } from '@playwright/test'

export interface ContrastRow {
  /** The ancestors that fade the element (tag, data-slot or first class, opacity), for the failure message. */
  dimmedBy: string[]
  ink: string
  mode: string
  opacity: number
  ratio: number
  skin: string
}

export function measureContrast(target: Locator): Promise<ContrastRow> {
  return target.evaluate(node => {
    const root = document.documentElement
    // UI lens gap (c): any computed colour (hex, rgb, color(srgb), oklab, oklch, color-mix) through the canvas, which
    // hands back plain sRGB bytes, so no format can turn a ratio into NaN.
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!

    const parse = (value: string): number[] => {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = '#000'
      ctx.fillStyle = value.trim() || 'transparent'
      ctx.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data

      return [r, g, b, a / 255]
    }

    const over = (top: number[], under: number[]) =>
      [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat(1)

    const lum = ([r, g, b]: number[]) =>
      [r, g, b]
        .map(n => n / 255)
        .map(n => (n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4))
        .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0)

    const chain: { bg: number[]; opacity: number; name: string }[] = []

    for (let el: Element | null = node; el; el = el.parentElement) {
      const style = getComputedStyle(el)
      const name = el.getAttribute('data-slot') ?? el.classList[0] ?? ''

      chain.push({ bg: parse(style.backgroundColor), name: `${el.tagName.toLowerCase()}${name ? `[${name}]` : ''}`, opacity: Number(style.opacity) })
    }

    chain.reverse() // root first
    const dimmedBy = chain.filter(link => link.opacity < 1).map(link => `${link.name} ${link.opacity}`)

    // UI lens gap (a): an ancestor's opacity fades its own background as well as everything inside it.
    const stack = (base: number[]) => {
      let under = base
      let cumulative = 1

      for (const link of chain) {
        cumulative *= link.opacity

        if (link.bg[3] > 0) {
          under = over([link.bg[0], link.bg[1], link.bg[2], link.bg[3] * cumulative], under)
        }
      }

      return { cumulative, under }
    }

    const ink = getComputedStyle(node).color
    const c = parse(ink)
    const surface = parse(getComputedStyle(root).getPropertyValue('--ic-surface'))
    // UI lens gap (b): layers behind the chat that are not its ancestors (the stage, a pane image) are not in the DOM
    // chain. When the stack is not opaque on its own, also measure over a mid-grey stage and keep the worse.
    const bases = [surface, [128, 128, 128, 1]]
    let worst = Infinity
    let opacity = 1

    for (const base of bases) {
      const { cumulative, under } = stack(base)
      opacity = cumulative
      const shown = over([c[0], c[1], c[2], c[3] * cumulative], under)
      const [hi, lo] = [lum(shown), lum(under)].sort((x, y) => y - x)
      worst = Math.min(worst, (hi + 0.05) / (lo + 0.05))

      if (stack([0, 0, 0, 1]).under.join() === stack([255, 255, 255, 1]).under.join()) {
        break // the stack is opaque: the base never shows through
      }
    }

    return { dimmedBy, ink, mode: root.dataset.hermesMode ?? '', opacity, ratio: worst, skin: root.dataset.hermesTheme ?? '' }
  })
}

/**
 * The owner reads the pane they are in: a chat surface that is not the focused session recedes on purpose
 * ([data-chat-unfocused], styles.css), which is not the state an AA check is about. Put the target's pane in focus the
 * way the owner does (its composer), and wait until it no longer recedes.
 */
async function focusOwnPane(target: Locator): Promise<void> {
  const surface = target.locator('xpath=ancestor::*[@data-chat-surface][1]')

  if ((await surface.count()) === 0) {
    return
  }

  // Parallel runs share one screen: the window the owner looks at is the front one.
  await target.page().bringToFront()
  await expect(surface).not.toHaveAttribute('data-chat-unfocused', /.*/)
  // The surface eases back over 75ms (styles.css); measure only once it rests at full opacity.
  await expect.poll(() => surface.evaluate(el => getComputedStyle(el).opacity)).toBe('1')
}

/** A row may still be fading in (its enter animation, a rehydrated message): measure it at rest, never mid-flight. */
async function settle(target: Locator): Promise<void> {
  await expect
    .poll(() =>
      target.evaluate(node => {
        for (let el: Element | null = node; el; el = el.parentElement) {
          // A finite fade still running (an enter animation); an infinite one is ambient (a pulse) and never ends.
          if (
            el
              .getAnimations()
              .some(animation => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity)
          ) {
            return false
          }
        }

        return true
      })
    )
    .toBe(true)
}

/** Measure `target` in the current skin, then cycle the Theme button until both a dark and a light mode were seen. */
export async function contrastInBothModes(page: Page, target: Locator): Promise<ContrastRow[]> {
  await focusOwnPane(target)
  await settle(target)
  const rows = [await measureContrast(target)]
  const theme = page.getByRole('button', { name: /^Theme/ })

  for (let i = 0; i < 3 && new Set(rows.map(row => row.mode)).size < 2; i += 1) {
    await theme.click()
    await page.waitForTimeout(150)
    await focusOwnPane(target)
    await settle(target)
    rows.push(await measureContrast(target))
  }

  return rows
}
