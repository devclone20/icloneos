/**
 * The dock windows' code, once it is here, rendered without Suspense.
 *
 * A `lazy` component suspends on its first render even when its module has
 * already loaded (the promise settles a microtask later), and React then
 * holds the Suspense fallback for its reveal throttle (~300 ms). The first
 * open after a reload painted its snapshot rows at 317 ms in the lab. A window
 * whose code has arrived renders the module's component directly instead, so
 * the snapshot is on screen in the first commit.
 */
import { type ComponentType, memo } from 'react'

import type { EconAppProps } from './types'

export interface WindowCode {
  App: ComponentType<EconAppProps>
  preload?: () => Promise<unknown>
}

const loaded = new Map<string, ComponentType<EconAppProps>>()

function moduleComponent(module: unknown): ComponentType<EconAppProps> | null {
  const component = (module as null | { default?: unknown })?.default

  return typeof component === 'function' || (typeof component === 'object' && component !== null)
    ? (component as ComponentType<EconAppProps>)
    : null
}

/** Remember the window's component once its code resolves (a failed fetch is
 *  forgotten, so a later call tries again). */
export function trackWindowCode(key: string, code: WindowCode): Promise<void> {
  if (loaded.has(key) || typeof code.preload !== 'function') {
    return Promise.resolve()
  }

  return code.preload().then(
    module => {
      const component = moduleComponent(module)

      if (component && !loaded.has(key)) {
        loaded.set(key, memo(component))
      }
    },
    () => undefined
  )
}

/** What a window mounts: the loaded component, or the lazy one until then. */
export function windowComponent(key: string, code: WindowCode): ComponentType<EconAppProps> {
  return loaded.get(key) ?? code.App
}

/** Tests: every window is lazy again. */
export function resetWindowCode(): void {
  loaded.clear()
}
