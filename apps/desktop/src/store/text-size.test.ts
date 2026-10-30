import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const KEY = 'iclone.appearance.textSize'

async function load() {
  vi.resetModules()

  return import('./text-size')
}

describe('text size store', () => {
  beforeEach(() => {
    window.localStorage.clear()
    delete document.documentElement.dataset.textSize
  })

  afterEach(() => {
    window.localStorage.clear()
  })

  it('applies the stored size to <html> as soon as it is imported', async () => {
    window.localStorage.setItem(KEY, 'large')
    const { $textSize } = await load()

    expect($textSize.get()).toBe('large')
    expect(document.documentElement.dataset.textSize).toBe('large')
  })

  it('falls back to the default for a missing or foreign value', async () => {
    window.localStorage.setItem(KEY, 'enormous')
    const { $textSize } = await load()

    expect($textSize.get()).toBe('default')
    expect(document.documentElement.dataset.textSize).toBeUndefined()
  })

  it('persists a choice and removes the key and attribute for the default', async () => {
    const { $textSize, setTextSize } = await load()

    setTextSize('small')
    expect(window.localStorage.getItem(KEY)).toBe('small')
    expect(document.documentElement.dataset.textSize).toBe('small')

    setTextSize('default')
    expect(window.localStorage.getItem(KEY)).toBeNull()
    expect($textSize.get()).toBe('default')
    expect(document.documentElement.dataset.textSize).toBeUndefined()
  })

  it('follows a change made in another window', async () => {
    const { $textSize } = await load()

    window.localStorage.setItem(KEY, 'large')
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: 'large' }))
    expect($textSize.get()).toBe('large')
    expect(document.documentElement.dataset.textSize).toBe('large')

    window.localStorage.clear()
    window.dispatchEvent(new StorageEvent('storage', { key: null }))
    expect($textSize.get()).toBe('default')
  })
})
