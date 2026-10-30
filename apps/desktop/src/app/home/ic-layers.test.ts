import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CROSS_SCOPE_EXCEPTIONS, IC_LAYERS, ladderComment, layersCss, UPSTREAM_LAYERS } from './ic-layers'

const HOME = resolve(process.cwd(), 'src/app/home')
const read = (file: string) => readFileSync(resolve(HOME, file), 'utf8')
const { global, ihome, local } = IC_LAYERS

describe('the layer registry', () => {
  it('renders ic-layers.css exactly (regenerate the file from layersCss() after editing the ladder)', () => {
    expect(read('ic-layers.css')).toBe(layersCss())
  })

  it('carries the generated ladder comment in home.css', () => {
    expect(read('home.css')).toContain(ladderComment())
  })

  it('gives every rung a unique number inside its scope', () => {
    for (const scope of Object.values(IC_LAYERS)) {
      const values = Object.values(scope)
      expect(new Set(values).size).toBe(values.length)
    }
  })

  it('orders the global rungs under the upstream overlay views and modals', () => {
    const order = [global.stage, global.chat, global.shells, global.home, global.files]
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(Math.max(...order)).toBeLessThan(UPSTREAM_LAYERS.overlay)
    expect(UPSTREAM_LAYERS.overlay).toBeLessThan(UPSTREAM_LAYERS.modalBackdrop)
  })

  it('keeps the in-.ihome ladder: window < chrome < econ < dock < controls < every modal scrim < its panel', () => {
    const order = [ihome.frame, ihome.itwin, ihome.chrome, ihome.econ, ihome.dock, ihome.controls]
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(new Set(order).size).toBe(order.length)

    for (const [scrim, panel] of [
      [ihome.inftScrim, ihome.inftPanel],
      [ihome.walletScrim, ihome.walletPanel]
    ]) {
      expect(scrim).toBeGreaterThan(ihome.controls)
      expect(panel).toBeGreaterThan(scrim)
    }
  })

  it('lifts the iNFT collections tab over the dock and its windows, still under the window controls', () => {
    expect(ihome.inftTab).toBeGreaterThan(Math.max(ihome.dock, ihome.econ, ihome.chrome, ihome.itwin))
    expect(ihome.inftTab).toBeLessThan(ihome.controls)
  })

  it('keeps the local scale small and strictly increasing', () => {
    const values = Object.values(local)
    expect(values).toEqual([1, 2, 3, 4, 5])
    expect(Math.max(...values)).toBeLessThan(Math.min(...Object.values(ihome)))
  })

  it('names the Files-over-modal case as the single cross-scope exception', () => {
    expect(CROSS_SCOPE_EXCEPTIONS).toHaveLength(1)
    expect(CROSS_SCOPE_EXCEPTIONS[0].above).toBe('global.files')
    // The exception is real: the island is global and the modals live inside .ihome (global.home).
    expect(global.files).toBeGreaterThan(global.home)
  })

  it('leaves no raw z-index in our CSS outside the registry', () => {
    const files = [
      'home.css',
      'it-terminal.css',
      'collections.css',
      'wallet-panel.css',
      'dock.css',
      'files-island.css',
      'econ/econ.css',
      'econ/email/email.css'
    ]

    for (const file of files) {
      const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '')
      expect(css.match(/z-index:(?!\s*var\(--ic-z-)[^;]*/g) ?? [], file).toEqual([])
    }
  })
})
