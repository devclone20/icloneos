/**
 * Remote folder picker — the path arithmetic, kept pure so the gate can prove
 * it without a DOM. Paths here belong to the GATEWAY's filesystem (POSIX,
 * rooted at `/`), never to this machine, so nothing in this module may reach
 * for Node, Electron or `window`.
 */
import type { HermesReadDirEntry } from '@/global'
import { pathLeaf } from '@/lib/display-path'

interface PickerCrumb {
  label: string
  path: string
}

export interface PickerFolder {
  name: string
  path: string
}

// `/srv/work/` and `/srv/work` are the same folder; `/` keeps its slash.
export function cleanPath(path: string): string {
  return path.replace(/\/+$/, '') || '/'
}

export function parentDir(path: string): string {
  const value = cleanPath(path)

  if (value === '/') {
    return '/'
  }

  return value.slice(0, value.lastIndexOf('/')) || '/'
}

export function crumbsFor(path: string): PickerCrumb[] {
  const crumbs: PickerCrumb[] = [{ label: '/', path: '/' }]
  let walked = ''

  for (const part of cleanPath(path).split('/').filter(Boolean)) {
    walked += `/${part}`
    crumbs.push({ label: part, path: walked })
  }

  return crumbs
}

// Only directories are navigable targets; a folder's name comes from its own
// path, because a gateway listing may report a name the path disagrees with.
export function folderRows(entries: HermesReadDirEntry[] | undefined): PickerFolder[] {
  return (entries ?? [])
    .filter(entry => entry.isDirectory)
    .map(entry => ({ name: pathLeaf(entry.path) || entry.name || entry.path, path: entry.path }))
}
