import { act, cleanup, render } from '@testing-library/react'
import { createElement, lazy, Suspense } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { resetWindowCode, trackWindowCode, type WindowCode, windowComponent } from './snapshot-paint'
import type { EconAppProps } from './types'

const PROPS = { expanded: false, identity: null, inftId: 'robinhood:0xabc:7', refreshKey: 0, slug: 'robinhood-0xabc-7' }

function Rows({ slug }: EconAppProps) {
  return createElement('p', { 'data-mail-id': 'm1' }, `rows for ${slug}`)
}

/** registry.tsx's shape: one shared loader behind `lazy` and `preload`. */
function code(load: () => Promise<unknown>): WindowCode {
  let pending: null | Promise<unknown> = null
  const once = () => (pending ??= load())

  return { App: lazy(once as () => Promise<{ default: typeof Rows }>), preload: once }
}

function mount(App: WindowCode['App']) {
  return render(
    createElement(
      Suspense,
      { fallback: createElement('p', { 'data-testid': 'skeleton' }) },
      createElement(App, PROPS as unknown as EconAppProps)
    )
  )
}

afterEach(() => {
  cleanup()
  resetWindowCode()
})

describe('dock windows paint their snapshot in the first commit — R3d r3', () => {
  it('a window whose code has loaded renders with no Suspense fallback', async () => {
    const email = code(async () => ({ default: Rows }))

    await trackWindowCode('email', email)
    const view = mount(windowComponent('email', email))

    expect(view.queryByTestId('skeleton')).toBeNull()
    expect(view.container.querySelector('[data-mail-id]')?.textContent).toBe('rows for robinhood-0xabc-7')
  })

  it('the lazy component suspends once even when its module is already here (the 317 ms paint)', async () => {
    const email = code(async () => ({ default: Rows }))

    await email.preload?.()
    const view = mount(email.App)

    expect(view.queryByTestId('skeleton')).not.toBeNull()
    await act(async () => undefined)
  })

  it('stays lazy until the code arrives, and a failed fetch is tried again', async () => {
    let fail = true
    let pending: null | Promise<unknown> = null

    const flaky: WindowCode = {
      App: Rows,
      preload: () =>
        (pending ??= (fail ? Promise.reject(new Error('dev reload')) : Promise.resolve({ default: Rows })).catch(
          (error: unknown) => {
            pending = null

            throw error
          }
        ))
    }

    await trackWindowCode('wallet', flaky)
    expect(windowComponent('wallet', flaky)).toBe(Rows)
    fail = false
    await trackWindowCode('wallet', flaky)
    expect(windowComponent('wallet', flaky)).not.toBe(Rows)
    expect(windowComponent('bank', { App: Rows })).toBe(Rows)
    await trackWindowCode('bank', { App: Rows })
    expect(windowComponent('bank', { App: Rows })).toBe(Rows)
  })
})
