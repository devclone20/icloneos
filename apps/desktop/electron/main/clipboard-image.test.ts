import { describe, expect, it, vi } from 'vitest'

import { type ClipboardItemLike, readClipboardImagePng } from './clipboard-image'

function item(entries: Record<string, Uint8Array>): ClipboardItemLike {
  return {
    types: Object.keys(entries),
    getType: async type => {
      const bytes = entries[type]

      if (!bytes) {
        throw new Error(`no ${type}`)
      }

      return new Blob([bytes as Uint8Array<ArrayBuffer>], { type })
    }
  }
}

const PNG_IN = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
// An image type the clipboard exposes as itself (TIFF and DIB arrive as image/png since Electron 44).
const SVG_IN = Uint8Array.from([0x3c, 0x73, 0x76, 0x67, 9])
const PNG_OUT = Buffer.from('re-encoded png')

describe('readClipboardImagePng (Electron 44 async clipboard)', () => {
  it('no image on the clipboard: null, and nothing is decoded', async () => {
    const decode = vi.fn(() => PNG_OUT)

    await expect(readClipboardImagePng({ read: async () => [] }, decode)).resolves.toBeNull()
    await expect(
      readClipboardImagePng({ read: async () => [item({ 'text/plain': Uint8Array.from([104, 105]) })] }, decode)
    ).resolves.toBeNull()
    expect(decode).not.toHaveBeenCalled()
  })

  it('an image present: its bytes are decoded and the PNG re-encoding is returned', async () => {
    const decode = vi.fn((_bytes: Buffer) => PNG_OUT)
    const clipboard = { read: async () => [item({ 'text/plain': Uint8Array.from([1]), 'image/png': PNG_IN })] }

    await expect(readClipboardImagePng(clipboard, decode)).resolves.toBe(PNG_OUT)
    expect(decode).toHaveBeenCalledTimes(1)
    expect([...(decode.mock.calls[0]?.[0] ?? [])]).toEqual([...PNG_IN])
  })

  it('prefers image/png; another image type (image/svg+xml) is the fallback', async () => {
    const decode = vi.fn((_bytes: Buffer) => PNG_OUT)

    await readClipboardImagePng({ read: async () => [item({ 'image/svg+xml': SVG_IN, 'image/png': PNG_IN })] }, decode)
    expect([...(decode.mock.calls[0]?.[0] ?? [])]).toEqual([...PNG_IN])

    decode.mockClear()
    await expect(
      readClipboardImagePng({ read: async () => [item({ 'image/svg+xml': SVG_IN })] }, decode)
    ).resolves.toBe(PNG_OUT)
    expect([...(decode.mock.calls[0]?.[0] ?? [])]).toEqual([...SVG_IN])
  })

  it('bytes that decode to no image, or an empty blob, count as no image', async () => {
    await expect(
      readClipboardImagePng({ read: async () => [item({ 'image/png': PNG_IN })] }, () => null)
    ).resolves.toBeNull()

    const decode = vi.fn(() => PNG_OUT)

    await expect(
      readClipboardImagePng({ read: async () => [item({ 'image/png': new Uint8Array() })] }, decode)
    ).resolves.toBeNull()
    expect(decode).not.toHaveBeenCalled()
  })

  it('never rejects: a failing read() or getType() resolves to null', async () => {
    const decode = vi.fn(() => PNG_OUT)

    await expect(
      readClipboardImagePng({ read: () => Promise.reject(new Error('clipboard unavailable')) }, decode)
    ).resolves.toBeNull()

    const withdrawn: ClipboardItemLike = {
      types: ['image/png'],
      getType: () => Promise.reject(new Error('gone'))
    }

    await expect(readClipboardImagePng({ read: async () => [withdrawn] }, decode)).resolves.toBeNull()
    expect(decode).not.toHaveBeenCalled()
  })

  it('a withdrawn first item does not hide an image in the next one', async () => {
    const withdrawn: ClipboardItemLike = { types: ['image/png'], getType: () => Promise.reject(new Error('gone')) }

    await expect(
      readClipboardImagePng({ read: async () => [withdrawn, item({ 'image/png': PNG_IN })] }, () => PNG_OUT)
    ).resolves.toBe(PNG_OUT)
  })
})
