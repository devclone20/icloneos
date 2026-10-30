import fs from 'node:fs'
import path from 'node:path'

import { type IpcPathFs, resolveDirectoryForIpc } from './hardening'
import { resolveLocalReadPath } from './wsl-path-bridge'

const FS_READDIR_STAT_CONCURRENCY = 16

// Always-hidden noise (covers non-git projects too; gitignore catches many of
// these, but the project tree should keep the same hygiene without one).
const FS_READDIR_HIDDEN = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'dist',
  'node_modules',
  'target',
  'venv'
])

/** The parts of a `fs.Dirent` the listing reads; injected fakes may omit the type probes. */
interface DirentLike {
  name: string
  isDirectory?(): boolean
  isFile?(): boolean
  isSymbolicLink?(): boolean
}

/** The `fs` surface a directory read uses (tests inject a fake). */
interface ReadDirFs extends IpcPathFs {
  promises: IpcPathFs['promises'] & {
    readdir(dir: string, options: { withFileTypes: true }): Promise<DirentLike[]>
  }
}

interface ReadDirEntry {
  name: string
  path: string
  isDirectory: boolean
}

function direntIsDirectory(dirent: DirentLike) {
  return typeof dirent.isDirectory === 'function' && dirent.isDirectory()
}

function direntIsFile(dirent: DirentLike) {
  return typeof dirent.isFile === 'function' && dirent.isFile()
}

function direntIsSymbolicLink(dirent: DirentLike) {
  return typeof dirent.isSymbolicLink === 'function' && dirent.isSymbolicLink()
}

function shouldStatDirent(dirent: DirentLike) {
  if (direntIsDirectory(dirent)) {
    return false
  }

  return direntIsSymbolicLink(dirent) || !direntIsFile(dirent)
}

async function entryForDirent(dirent: DirentLike, resolved: string, fsImpl: ReadDirFs): Promise<ReadDirEntry> {
  const fullPath = path.join(resolved, dirent.name)
  let isDirectory = direntIsDirectory(dirent)

  if (!isDirectory && shouldStatDirent(dirent)) {
    try {
      isDirectory = (await fsImpl.promises.stat(fullPath)).isDirectory()
    } catch {
      isDirectory = false
    }
  }

  return { name: dirent.name, path: fullPath, isDirectory }
}

async function mapWithStatConcurrency<T, R>(items: readonly T[], mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(items[index])
    }
  }

  const workerCount = Math.min(FS_READDIR_STAT_CONCURRENCY, items.length)
  const workers = Array.from({ length: workerCount }, () => runWorker())
  await Promise.all(workers)

  return results
}

async function readDirForIpc(
  dirPath: unknown,
  options: { fs?: ReadDirFs } = {}
): Promise<{ entries: ReadDirEntry[]; error?: string }> {
  const fsImpl: ReadDirFs = options.fs || fs
  let resolved: string

  // On a Windows host with a WSL backend, a WSL/POSIX cwd (`/home/...`,
  // `/mnt/c/...`) isn't readable as-is; bridge it to a UNC/drive form first.
  const readPath = resolveLocalReadPath(String(dirPath ?? ''))

  try {
    ;({ resolvedPath: resolved } = await resolveDirectoryForIpc(readPath, {
      fs: fsImpl,
      purpose: 'Directory read'
    }))
  } catch (error) {
    return { entries: [], error: (error as NodeJS.ErrnoException | null)?.code || 'read-error' }
  }

  try {
    const dirents = await fsImpl.promises.readdir(resolved, { withFileTypes: true })
    const visibleDirents = dirents.filter(dirent => !FS_READDIR_HIDDEN.has(dirent.name))
    const entries = await mapWithStatConcurrency(visibleDirents, dirent => entryForDirent(dirent, resolved, fsImpl))

    entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))

    return { entries }
  } catch (error) {
    return { entries: [], error: (error as NodeJS.ErrnoException | null)?.code || 'read-error' }
  }
}

export { readDirForIpc }
