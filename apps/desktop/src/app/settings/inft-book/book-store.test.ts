import { beforeEach, describe, expect, it, vi } from 'vitest'

const KEY = 'iclone.inftBook.checked.v1'
const A = '0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631'
const B = '0x3d9f35e08c41a80155353862f883f2b70119809f'

async function fresh() {
  vi.resetModules()

  return import('./book-store')
}

function storedKeys(): string[] {
  return Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i) ?? '')
}

function snapshot(): Record<string, null | string> {
  return Object.fromEntries(storedKeys().map(key => [key, window.localStorage.getItem(key)]))
}

beforeEach(() => window.localStorage.clear())

describe('Book selection persistence', () => {
  it('a toggle survives a reload, per wallet, under one key', async () => {
    let store = await fresh()

    store.toggleBook(A, 'x')
    store.toggleBook(A, 'y')
    store.toggleBook(B, 'z')
    store = await fresh()

    expect([...store.checkedSet(A)]).toEqual(['x', 'y'])
    expect([...store.checkedSet(B)]).toEqual(['z'])
    expect(storedKeys()).toEqual([KEY])
  })

  it('an account switch reads the other wallet only (address case does not matter)', async () => {
    const store = await fresh()

    store.toggleBook(A, 'x')
    expect(store.checkedSet(B).size).toBe(0)
    expect(store.checkedSet(A.toUpperCase().replace('0X', '0x')).has('x')).toBe(true)
  })

  it('a toggle changes exactly one localStorage key (G3)', async () => {
    window.localStorage.setItem('iclone.collections.order', '["x"]')
    window.localStorage.setItem('iclone.stage.lastInft', 'x')

    const store = await fresh()
    const before = snapshot()

    store.toggleBook(A, 'x')

    const after = snapshot()
    const changed = Object.keys({ ...before, ...after }).filter(key => before[key] !== after[key])

    expect(changed).toEqual([KEY])
  })

  it('the upgrade seed is written once and says how many it kept; the first change clears the note', async () => {
    const store = await fresh()

    store.seedOnce(A, ['x', 'y'])
    store.seedOnce(A, ['other'])
    expect(store.selectionFor(store.$bookChecked.get(), A)).toEqual({ ids: ['x', 'y'], kept: 2 })
    store.toggleBook(A, 'z')
    expect(store.selectionFor(store.$bookChecked.get(), A)).toEqual({ ids: ['x', 'y', 'z'], kept: null })
  })

  it('prune drops exactly the missing ids, and nothing when all are present', async () => {
    const store = await fresh()

    store.checkShown(A, [{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    store.pruneBook(A, new Set(['a', 'b', 'c']))
    expect([...store.checkedSet(A)]).toEqual(['a', 'b', 'c'])
    store.pruneBook(A, new Set(['a', 'c']))
    expect([...store.checkedSet(A)]).toEqual(['a', 'c'])
  })

  it('a corrupt or foreign stored value reads as nothing chosen', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ 'not-an-address': { ids: ['x'] }, [A]: { ids: 'x' } }))

    const store = await fresh()

    expect(store.$bookChecked.get()).toEqual({})
  })
})
