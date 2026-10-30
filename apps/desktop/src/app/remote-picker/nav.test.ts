import { describe, expect, it } from 'vitest'

import { cleanPath, crumbsFor, folderRows, parentDir } from './nav'

describe('remote picker paths', () => {
  it('normalises trailing slashes and keeps the root', () => {
    expect(cleanPath('/srv/work/')).toBe('/srv/work')
    expect(cleanPath('/srv/work///')).toBe('/srv/work')
    expect(cleanPath('/')).toBe('/')
    expect(cleanPath('')).toBe('/')
  })

  it('walks up to the root and stops there', () => {
    expect(parentDir('/srv/work/repo')).toBe('/srv/work')
    expect(parentDir('/srv/work/')).toBe('/srv')
    expect(parentDir('/srv')).toBe('/')
    expect(parentDir('/')).toBe('/')
  })

  it('builds crumbs from the root down to the folder', () => {
    expect(crumbsFor('/srv/work/repo')).toEqual([
      { label: '/', path: '/' },
      { label: 'srv', path: '/srv' },
      { label: 'work', path: '/srv/work' },
      { label: 'repo', path: '/srv/work/repo' }
    ])
    expect(crumbsFor('/')).toEqual([{ label: '/', path: '/' }])
  })

  it('keeps only directories and names them from their own path', () => {
    expect(
      folderRows([
        { isDirectory: true, name: 'stale-name', path: '/srv/work/repo' },
        { isDirectory: false, name: 'notes.md', path: '/srv/work/notes.md' }
      ] as never)
    ).toEqual([{ name: 'repo', path: '/srv/work/repo' }])
  })

  it('survives a listing without entries', () => {
    expect(folderRows(undefined)).toEqual([])
  })
})
