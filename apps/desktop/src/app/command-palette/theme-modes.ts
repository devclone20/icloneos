/** The Light/Dark/System rows, and which of the two a theme can paint. */

import { type IconComponent, Monitor, Moon, Sun } from '@/lib/icons'
import { luminance } from '@/themes/color'
import type { ThemeMode } from '@/themes/context'
import { isUserTheme, resolveTheme } from '@/themes/user-themes'

export const THEME_MODES: ReadonlyArray<{ icon: IconComponent; mode: ThemeMode }> = [
  { icon: Sun, mode: 'light' },
  { icon: Moon, mode: 'dark' },
  { icon: Monitor, mode: 'system' }
]

// Which Light/Dark groups a theme belongs in. Built-ins render in both modes
// (the engine synthesises the missing side). Imported VS Code themes only carry
// the variant(s) the extension shipped — a single dark theme like Dracula lives
// under Dark only, while a GitHub/Solarized family (light + dark) lives in both.
export function themeSupportsMode(name: string, target: 'light' | 'dark'): boolean {
  if (!isUserTheme(name)) {
    return true
  }

  const resolved = resolveTheme(name)

  if (!resolved) {
    return true
  }

  const background =
    target === 'dark' ? (resolved.darkColors ?? resolved.colors).background : resolved.colors.background

  return target === 'dark' ? luminance(background) <= 0.5 : luminance(background) > 0.5
}
