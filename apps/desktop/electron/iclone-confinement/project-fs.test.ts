/**
 * v0.0.8 FX-ASAR — the confinement code judges project paths with Electron's `original-fs` when it runs in Electron
 * (where `node:fs` serves `*.asar` files as archives), with `node:fs` under plain Node. The real-Electron proof is
 * hardlinks.asar.electron.test.ts; this file pins the selection and that the walker routes its calls through it.
 */
import * as nodeFs from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as nodeFsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { projectFs, selectProjectFs } from './project-fs'

/** A stand-in for `original-fs`: node's own functions, so it behaves, but a distinct object the test can recognise. */
const fakeOriginalFs = () => ({ ...nodeFs, promises: { ...nodeFsPromises } })

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('FX-ASAR: the file system confinement uses on project paths', () => {
  it('selects original-fs when the runtime provides it, and asks for nothing else', () => {
    const original = fakeOriginalFs()
    const asked: string[] = []

    const selected = selectProjectFs(id => {
      asked.push(id)

      return id === 'original-fs' ? original : undefined
    })

    expect(asked).toEqual(['original-fs'])
    expect(selected.sync).toBe(original)
    expect(selected.promises).toBe(original.promises)
  })

  it('falls back to node:fs when there is no original-fs (plain Node) or it is not a file system', () => {
    for (const answer of [undefined, null, {}, { lstatSync: () => null }, { ...nodeFs, promises: {} }]) {
      const selected = selectProjectFs(() => answer)

      expect(selected.sync.lstatSync).toBe(nodeFs.lstatSync)
      expect(selected.promises.lstat).toBe(nodeFsPromises.lstat)
    }

    expect(selectProjectFs(undefined).sync.readdirSync).toBe(nodeFs.readdirSync)
  })

  it('under plain Node (this suite) the module-level choice is node:fs: there is no original-fs to take', () => {
    expect(process.getBuiltinModule('original-fs')).toBeUndefined()
    expect(projectFs.sync.lstatSync).toBe(nodeFs.lstatSync)
    expect(projectFs.promises.readdir).toBe(nodeFsPromises.readdir)
  })

  it('in Electron the walker module takes original-fs at import and walks through it, sync and async', async () => {
    const original = fakeOriginalFs()
    const lstatSync = vi.spyOn(original, 'lstatSync')
    const readdirSync = vi.spyOn(original, 'readdirSync')
    const lstat = vi.spyOn(original.promises, 'lstat')
    const readdir = vi.spyOn(original.promises, 'readdir')
    const realGetBuiltin = process.getBuiltinModule.bind(process)

    const getBuiltin = vi
      .spyOn(process, 'getBuiltinModule')
      .mockImplementation(((id: string) => (id === 'original-fs' ? original : realGetBuiltin(id))) as never)

    vi.resetModules()

    const walk = await import('./hardlinks-walk')
    const reexported = await import('./project-fs')

    getBuiltin.mockRestore()

    expect(walk.projectFs.sync).toBe(original)
    expect(reexported.projectFs).toBe(walk.projectFs)

    const top = mkdtempSync(path.join(os.tmpdir(), 'fx-asar-unit-'))

    try {
      mkdirSync(path.join(top, 'a'))
      writeFileSync(path.join(top, 'a', 'f.asar'), 'not an archive')

      expect(walk.walkTreeSync(top).size).toBe(2)
      expect(lstatSync).toHaveBeenCalled()
      expect(readdirSync).toHaveBeenCalled()

      expect((await walk.walkTree(top, null)).records.size).toBe(2)
      expect(lstat).toHaveBeenCalled()
      expect(readdir).toHaveBeenCalled()
    } finally {
      rmSync(top, { recursive: true, force: true })
    }
  })
})
