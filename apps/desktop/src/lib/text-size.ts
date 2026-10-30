/**
 * Text size (Settings → Appearance): one root multiplier, `--ic-text-scale`,
 * applied to every absolute font-size/line-height at build time by
 * `vite/postcss-text-scale.ts`. Separate from the UI scale (window zoom):
 * text grows, the windows and their frames keep their size.
 */

import type { Locale } from '@/i18n/types'

export type TextSize = 'default' | 'large' | 'small'

export const TEXT_SIZES: readonly TextSize[] = ['small', 'default', 'large']

/** Small is 85 %, not ½: with the stylesheet floor (postcss-text-scale) a 13px body lands at 11px and a caption never under 10px. */
export const TEXT_SCALE: Readonly<Record<TextSize, number>> = { default: 1, large: 2, small: 0.85 }

interface TextSizeWords {
  description: string
  labels: Record<TextSize, string>
  title: string
}

/** The text-size row's words in every locale (the scale values above are what the labels name). */
export const TEXT_SIZE_WORDS: Readonly<Record<Locale, TextSizeWords>> = {
  ar: {
    description: 'يكبّر النص أو يصغّره في التطبيق كله؛ وتبقى النوافذ بحجمها.',
    labels: { default: 'افتراضي', large: 'كبير 2×', small: 'صغير 85 ٪' },
    title: 'حجم النص'
  },
  en: {
    description: 'Makes text larger or smaller across the app; windows keep their size.',
    labels: { default: 'Default', large: 'Large 2×', small: 'Small 85 %' },
    title: 'Text size'
  },
  ja: {
    description: '文字の大きさをアプリ全体で変えます。ウィンドウの大きさは変わりません。',
    labels: { default: '標準', large: '大 2×', small: '小 85 %' },
    title: '文字サイズ'
  },
  'pt-PT': {
    description: 'Aumenta ou reduz o texto em toda a aplicação; as janelas mantêm o tamanho.',
    labels: { default: 'Predefinido', large: 'Grande 2×', small: 'Pequeno 85 %' },
    title: 'Tamanho do texto'
  },
  zh: {
    description: '在整个应用中放大或缩小文字；窗口大小保持不变。',
    labels: { default: '默认', large: '大 2×', small: '小 85 %' },
    title: '文字大小'
  },
  'zh-hant': {
    description: '在整個應用程式中放大或縮小文字；視窗大小維持不變。',
    labels: { default: '預設', large: '大 2×', small: '小 85 %' },
    title: '文字大小'
  }
}

/** English, for the settings search index. */
export const TEXT_SIZE_COPY = TEXT_SIZE_WORDS.en

export function parseTextSize(raw: unknown): TextSize {
  return raw === 'small' || raw === 'large' ? raw : 'default'
}

/**
 * An inline `fontSize` (React style or CSS-in-JS theme) that follows the text
 * size like the stylesheet does. A number is px; a rem length stays rem, since
 * the root size follows `--dt-base-size` and px would drift from it.
 */
export function scaledFontPx(size: number | `${number}rem`): string {
  if (typeof size === 'number') {
    // The stylesheet's floor (postcss-text-scale FONT_SIZE_FLOOR_PX), by hand.
    return `max(min(${size}px, 10px), calc(${size}px * var(--ic-text-scale, 1)))`
  }

  return `calc(${size} * var(--ic-text-scale, 1))`
}
