import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { renameInPlaceForIpc } from './fs-ipc'
import { resolveRequestedPathForIpc } from './hardening'

vi.mock('electron', () => ({ app: {}, ipcMain: {}, safeStorage: {}, shell: {} }))

describe('renameInPlaceForIpc', () => {
  let dir: string
  const expandUserPath = (value: string) => value

  const rename = (target: unknown, name: unknown, resolve = resolveRequestedPathForIpc) =>
    renameInPlaceForIpc(target, name, { expandUserPath, resolveRequestedPathForIpc: resolve })

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-ipc-rename-'))
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('renames inside the same directory', async () => {
    await expect(rename(path.join(dir, 'a.txt'), 'b.txt')).resolves.toEqual({ path: path.join(dir, 'b.txt') })
    expect(fs.existsSync(path.join(dir, 'b.txt'))).toBe(true)
  })

  it('passes the SOURCE through the IPC path hardening, like writeText', async () => {
    const resolve = vi.fn(resolveRequestedPathForIpc)

    await rename(path.join(dir, 'a.txt'), 'b.txt', resolve)
    expect(resolve).toHaveBeenNthCalledWith(1, path.join(dir, 'a.txt'), { purpose: 'Rename' })
    expect(resolve).toHaveBeenNthCalledWith(2, path.join(dir, 'b.txt'), { purpose: 'Rename' })
  })

  it('refuses a source the hardening rejects', async () => {
    await expect(rename(`${dir}/a.txt\0`, 'b.txt')).rejects.toThrow(/invalid/)
    await expect(rename('//?/C:/x', 'b.txt')).rejects.toThrow(/device paths/)
  })

  it('refuses sensitive sources and destinations', async () => {
    fs.mkdirSync(path.join(dir, '.ssh'))
    fs.writeFileSync(path.join(dir, '.ssh', 'config'), 'x')

    await expect(rename(path.join(dir, '.ssh', 'config'), 'config.bak')).rejects.toThrow(/sensitive/)
    await expect(rename(path.join(dir, 'a.txt'), '.env')).rejects.toThrow(/sensitive/)
    expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(true)
  })

  it.each(['', '.', '..', 'x/y', 'x\\y', 'x\0y'])('refuses the new name %j', async name => {
    await expect(rename(path.join(dir, 'a.txt'), name)).rejects.toThrow('Invalid rename')
  })

  it('refuses a collision', async () => {
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b')
    await expect(rename(path.join(dir, 'a.txt'), 'b.txt')).rejects.toThrow('"b.txt" already exists')
  })
})
