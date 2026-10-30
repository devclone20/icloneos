/**
 * FILES — the right-edge island file explorer (owner rule: "the right sidebar
 * must open an island… show everything inside the machine… open new trees…
 * see the content, edit, write and save").
 *
 * The whole machine, not the workspace: roots start at ~ / ~/Desktop / /,
 * and "+" pins any folder (native picker) as a new tree. Directories expand
 * lazily in place; clicking a file slides its content over the tree —
 * text opens in the app's own CodeMirror `CodeEditor` (⌘S saves through the
 * hardened write IPC), images preview, other binaries show their facts.
 * All plumbing is the existing `desktop-fs` layer — nothing new touches
 * disk from here.
 */
import './files-island.css'

import { useStore } from '@nanostores/react'
import { ChevronDown, ChevronRight, FilePen, FolderPlus, RefreshCw, X } from 'lucide-react'
import { atom } from 'nanostores'
import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { CodeEditor } from '@/components/chat/code-editor'
import type { HermesReadDirEntry } from '@/global'
import {
  readDesktopDir,
  readDesktopFileDataUrl,
  readDesktopFileText,
  selectDesktopPaths,
  writeDesktopFileText
} from '@/lib/desktop-fs'
import { ESCAPE_PRIORITY, isTopEscapeLayer, pushEscapeLayer } from '@/lib/escape-layers'
import { persistStringArray, storedStringArray } from '@/lib/storage'
import { cn } from '@/lib/utils'

import { ICLONE_STORAGE } from './lib/storage-keys'
import { claimRightEdge } from './right-edge'

export const $filesIslandOpen = atom(false)

export function toggleFilesIsland(): void {
  $filesIslandOpen.set(!$filesIslandOpen.get())
}

const DEFAULT_ROOTS = ['~', '~/Desktop', '/'] as const
const ROOTS_KEY = ICLONE_STORAGE.filesRoots.key

function readPinnedRoots(): string[] {
  return storedStringArray(ROOTS_KEY)
}

function rootLabel(path: string): string {
  if (path === '~') {
    return 'home'
  }

  if (path === '/') {
    return 'machine'
  }

  return path.split('/').filter(Boolean).pop() ?? path
}

type DirState = { entries?: HermesReadDirEntry[]; error?: string; loading?: boolean }

interface OpenFile {
  path: string
  text: string
  binary: boolean
  truncated: boolean
  /** Read failed: shown as a notice, never mounted in the editor — loading an
   *  error string as editable text put it one ⌘S away from overwriting the
   *  real file on disk. */
  readError?: string
  mimeType?: string
  byteSize?: number
  imageUrl?: string
}

export function FilesIsland(): JSX.Element | null {
  const open = useStore($filesIslandOpen)

  return open ? <FilesIslandPanel /> : null
}

function FilesIslandPanel(): JSX.Element {
  // Esc parity: the island could only be closed by its ✕. Registered as the
  // same low rung the home stage uses — an open Settings still wins the key.
  useEffect(() => {
    const release = pushEscapeLayer(ESCAPE_PRIORITY.homeStage)

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !isTopEscapeLayer(ESCAPE_PRIORITY.homeStage)) {
        return
      }

      event.preventDefault()
      $filesIslandOpen.set(false)
    }

    window.addEventListener('keydown', onKey)

    return () => {
      window.removeEventListener('keydown', onKey)
      release()
    }
  }, [])

  const [pinned, setPinned] = useState<string[]>(readPinnedRoots)
  const [root, setRoot] = useState<string>(DEFAULT_ROOTS[0])
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [file, setFile] = useState<OpenFile | null>(null)
  const [saveState, setSaveState] = useState<'error' | 'idle' | 'saved' | 'saving'>('idle')
  const editorValueRef = useRef('')

  // Own the right edge while open — matches `.ifiles`' own width rule.
  useEffect(() => claimRightEdge('files', 'min(30rem, calc(100vw - 96px))'), [])

  const loadDir = useCallback(async (path: string) => {
    setDirs(current => ({ ...current, [path]: { ...current[path], loading: true } }))

    const result = await readDesktopDir(path).catch(error => ({
      entries: [],
      error: error instanceof Error ? error.message : 'Could not read this folder.'
    }))

    setDirs(current => ({ ...current, [path]: { entries: result.entries, error: result.error, loading: false } }))
  }, [])

  useEffect(() => {
    void loadDir(root)
  }, [loadDir, root])

  const toggleDir = (path: string) => {
    const next = !expanded[path]

    setExpanded(current => ({ ...current, [path]: next }))

    if (next && !dirs[path]?.entries) {
      void loadDir(path)
    }
  }

  const openFile = async (path: string) => {
    setSaveState('idle')

    const result = await readDesktopFileText(path).catch(error => ({
      binary: false,
      path,
      text: '',
      truncated: false,
      mimeType: undefined,
      byteSize: undefined,
      error: error instanceof Error ? error.message : 'Could not read this file.'
    }))

    const failed = 'error' in result && result.error

    const next: OpenFile = {
      path,
      text: failed ? '' : result.text,
      readError: failed ? result.error : undefined,
      binary: Boolean(result.binary),
      truncated: Boolean(result.truncated),
      mimeType: result.mimeType ?? undefined,
      byteSize: result.byteSize ?? undefined
    }

    editorValueRef.current = next.text

    if (next.binary && next.mimeType?.startsWith('image/')) {
      next.imageUrl = await readDesktopFileDataUrl(path).catch(() => undefined)
    }

    setFile(next)
  }

  const save = async () => {
    if (!file || file.binary || file.truncated || file.readError) {
      return
    }

    setSaveState('saving')

    try {
      await writeDesktopFileText(file.path, editorValueRef.current)
      setSaveState('saved')
      window.setTimeout(() => setSaveState(current => (current === 'saved' ? 'idle' : current)), 1600)
    } catch {
      setSaveState('error')
    }
  }

  const pinNewRoot = async () => {
    const picked = await selectDesktopPaths({ directories: true, title: 'Pin a folder as a new tree' }).catch(() => [])
    const dir = picked?.[0]

    if (!dir) {
      return
    }

    setPinned(current => {
      const next = current.includes(dir) ? current : [...current, dir]

      persistStringArray(ROOTS_KEY, next)

      return next
    })
    setRoot(dir)
  }

  const unpinRoot = (path: string) => {
    setPinned(current => {
      const next = current.filter(entry => entry !== path)

      persistStringArray(ROOTS_KEY, next)

      return next
    })

    if (root === path) {
      setRoot(DEFAULT_ROOTS[0])
    }
  }

  const renderDir = (path: string, depth: number): JSX.Element | null => {
    const state = dirs[path]

    if (!state) {
      return null
    }

    if (state.error) {
      return (
        <p className="ifiles__error" style={{ paddingLeft: 14 + depth * 14 }}>
          {state.error}
        </p>
      )
    }

    return (
      <>
        {(state.entries ?? []).map(entry =>
          entry.isDirectory ? (
            <div key={entry.path}>
              <button
                className="ifiles__row"
                onClick={() => toggleDir(entry.path)}
                style={{ paddingLeft: 10 + depth * 14 }}
                type="button"
              >
                {expanded[entry.path] ? (
                  <ChevronDown size={12} strokeWidth={2} />
                ) : (
                  <ChevronRight size={12} strokeWidth={2} />
                )}
                <span className="ifiles__name ifiles__name--dir">{entry.name}</span>
              </button>
              {expanded[entry.path] && renderDir(entry.path, depth + 1)}
            </div>
          ) : (
            <button
              className="ifiles__row"
              key={entry.path}
              onClick={() => void openFile(entry.path)}
              style={{ paddingLeft: 24 + depth * 14 }}
              type="button"
            >
              <span className="ifiles__name">{entry.name}</span>
            </button>
          )
        )}
        {state.entries?.length === 0 && !state.loading && (
          <p className="ifiles__empty" style={{ paddingLeft: 14 + depth * 14 }}>
            empty
          </p>
        )}
      </>
    )
  }

  const roots = [...DEFAULT_ROOTS, ...pinned]
  const dirty = file && !file.binary && editorValueRef.current !== file.text

  return (
    <aside aria-label="Files island" className="ifiles">
      <header className="ifiles__head">
        <span className="ifiles__title">files</span>
        <div className="ifiles__head-actions">
          <button aria-label="Refresh" className="ifiles__icon-btn" onClick={() => void loadDir(root)} type="button">
            <RefreshCw size={13} strokeWidth={2} />
          </button>
          <button
            aria-label="Close files"
            className="ifiles__icon-btn"
            onClick={() => $filesIslandOpen.set(false)}
            type="button"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>
      </header>

      <nav aria-label="File trees" className="ifiles__roots">
        {roots.map(path => (
          <span className={cn('ifiles__root', root === path && 'ifiles__root--on')} key={path}>
            <button
              className="ifiles__root-btn"
              onClick={() => {
                setRoot(path)
                setFile(null)
              }}
              type="button"
            >
              {rootLabel(path)}
            </button>
            {pinned.includes(path) && (
              <button
                aria-label={`Unpin ${rootLabel(path)}`}
                className="ifiles__root-x"
                onClick={() => unpinRoot(path)}
                type="button"
              >
                <X size={10} strokeWidth={2} />
              </button>
            )}
          </span>
        ))}
        <button
          aria-label="Pin a folder as a new tree"
          className="ifiles__root ifiles__root-add"
          onClick={() => void pinNewRoot()}
          type="button"
        >
          <FolderPlus size={13} strokeWidth={2} />
        </button>
      </nav>

      {!file && (
        <div className="ifiles__tree">
          {dirs[root]?.loading && !dirs[root]?.entries && <p className="ifiles__empty">reading…</p>}
          {renderDir(root, 0)}
        </div>
      )}

      {file && (
        <div className="ifiles__file">
          <div className="ifiles__file-head">
            <FilePen size={13} strokeWidth={2} />
            <span className="ifiles__file-name" title={file.path}>
              {file.path.split('/').pop()}
            </span>
            {typeof file.byteSize === 'number' && (
              <span className="ifiles__file-size">{Math.max(1, Math.round(file.byteSize / 1024))} KB</span>
            )}
            {file.readError && (
              <p className="ifiles__notice">⚠ {file.readError} — editing is disabled for this file.</p>
            )}
            {!file.binary && !file.truncated && !file.readError && (
              <button
                className="ifiles__save"
                disabled={saveState === 'saving'}
                onClick={() => void save()}
                type="button"
              >
                {saveState === 'saving'
                  ? 'saving…'
                  : saveState === 'saved'
                    ? 'saved ✓'
                    : saveState === 'error'
                      ? 'retry save'
                      : dirty
                        ? 'save'
                        : 'save'}
              </button>
            )}
            <button aria-label="Close file" className="ifiles__icon-btn" onClick={() => setFile(null)} type="button">
              <X size={13} strokeWidth={2} />
            </button>
          </div>
          {file.truncated && (
            <p className="ifiles__notice">
              Preview truncated (large file) — editing is disabled so the tail is never lost.
            </p>
          )}
          {file.binary ? (
            file.imageUrl ? (
              <div className="ifiles__image">
                <img alt={file.path} src={file.imageUrl} />
              </div>
            ) : (
              <p className="ifiles__notice">Binary file{file.mimeType ? ` · ${file.mimeType}` : ''} — no text view.</p>
            )
          ) : (
            <div className="ifiles__editor">
              <CodeEditor
                disabled={file.truncated || saveState === 'saving'}
                filePath={file.path}
                initialValue={file.text}
                key={file.path}
                onCancel={() => setFile(null)}
                onChange={value => {
                  editorValueRef.current = value
                }}
                onSave={() => void save()}
              />
            </div>
          )}
        </div>
      )}
    </aside>
  )
}
