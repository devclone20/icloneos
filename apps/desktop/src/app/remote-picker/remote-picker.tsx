/**
 * REMOTE FOLDER PICKER — ours.
 *
 * A directory pick in remote mode cannot open a native dialog: the folders the
 * user means live on the gateway (SSH or remote backend), not on this Mac. So
 * this component registers itself as the renderer's picker
 * (`setDesktopFsRemotePicker`) and browses the gateway over the same
 * `readDesktopDir` seam the rest of the app reads files through.
 *
 * It is mounted once, app-wide (contrib/wiring.tsx). Without it
 * `selectDesktopPaths({ directories: true })` has nothing to call and reports
 * the pick as unavailable — ⌘O (pickProjectFolder) and the home files island
 * ("Pin a folder as a new tree") both depend on this registration.
 *
 * Frame and material are ours: IcDialog on our --ic-* tokens, no upstream
 * dialog or component library. Only the path arithmetic (./nav) is reused from
 * the upstream-derived component this replaces.
 */
import './remote-picker.css'

import { useEffect, useMemo, useState } from 'react'

import { IcButton, IcDialog, IcDialogDescription, IcDialogTitle, IcSpinner } from '@/components/onboarding/ic-system'
import { useI18n } from '@/i18n'
import { errorMessage } from '@/iclone-shared/errors'
import { readDesktopDir, setDesktopFsRemotePicker } from '@/lib/desktop-fs'
import { displayPath } from '@/lib/display-path'
import { ArrowUp, FolderOpen } from '@/lib/icons'

import { cleanPath, crumbsFor, folderRows, parentDir, type PickerFolder } from './nav'

interface PendingPick {
  resolve: (paths: string[]) => void
  title: string
}

export function RemoteFolderPicker() {
  const { t } = useI18n()
  const copy = t.rightSidebar
  const [pending, setPending] = useState<null | PendingPick>(null)
  const [path, setPath] = useState('/')
  const [folders, setFolders] = useState<PickerFolder[]>([])
  const [error, setError] = useState<null | string>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setDesktopFsRemotePicker({
      selectPaths: options =>
        new Promise<string[]>(resolve => {
          setPath(cleanPath(options?.defaultPath || '/'))
          setPending({ resolve, title: options?.title || copy.remotePickerTitle })
        })
    })

    return () => setDesktopFsRemotePicker(null)
  }, [copy.remotePickerTitle])

  useEffect(() => {
    if (!pending) {
      return
    }

    let active = true

    setLoading(true)
    setError(null)

    void readDesktopDir(path)
      .then(result => {
        if (!active) {
          return
        }

        if (result.error) {
          setError(result.error)
          setFolders([])

          return
        }

        setFolders(folderRows(result.entries))
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(errorMessage(cause))
          setFolders([])
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })

    return () => {
      active = false
    }
  }, [path, pending])

  const crumbs = useMemo(() => crumbsFor(path), [path])

  // An empty array IS the cancel: the seam reads it as "the user chose
  // nothing", which is a different answer from "there is no picker".
  const close = (paths: string[] = []) => {
    pending?.resolve(paths)
    setPending(null)
    setFolders([])
    setError(null)
  }

  return (
    <IcDialog
      className="irpick"
      closeLabel={t.common.cancel}
      onOpenChange={open => {
        if (!open) {
          close()
        }
      }}
      open={Boolean(pending)}
    >
      <div className="irpick__body">
        <header className="irpick__head">
          <IcDialogTitle className="irpick__title">{pending?.title || copy.remotePickerTitle}</IcDialogTitle>
          <IcDialogDescription className="irpick__hint">{copy.remotePickerDescription}</IcDialogDescription>
        </header>

        <nav aria-label={copy.remotePickerTitle} className="irpick__crumbs">
          {crumbs.map((crumb, index) => (
            <button
              className="irpick__crumb"
              data-current={index === crumbs.length - 1 ? '' : undefined}
              key={crumb.path}
              onClick={() => setPath(crumb.path)}
              type="button"
            >
              {crumb.label}
            </button>
          ))}
        </nav>

        <div className="irpick__list">
          <button
            className="irpick__row"
            disabled={path === '/'}
            onClick={() => setPath(parentDir(path))}
            type="button"
          >
            <ArrowUp aria-hidden className="irpick__row-icon" />
            <span className="irpick__row-name">..</span>
          </button>

          {loading ? (
            <p className="irpick__note">
              <IcSpinner className="irpick__spinner" />
              {copy.loadingFiles}
            </p>
          ) : error ? (
            <p className="irpick__note irpick__note--error">{copy.unreadableBody(error)}</p>
          ) : folders.length === 0 ? (
            <p className="irpick__note">{copy.emptyBody}</p>
          ) : (
            folders.map(folder => (
              <button className="irpick__row" key={folder.path} onClick={() => setPath(folder.path)} type="button">
                <FolderOpen aria-hidden className="irpick__row-icon" />
                <span className="irpick__row-name">{folder.name}</span>
              </button>
            ))
          )}
        </div>

        <footer className="irpick__foot">
          <span className="irpick__path">{displayPath(path)}</span>
          <span className="irpick__actions">
            <IcButton onClick={() => close()} size="sm" variant="ghost">
              {t.common.cancel}
            </IcButton>
            <IcButton onClick={() => close([path])} size="sm">
              {copy.remotePickerSelect}
            </IcButton>
          </span>
        </footer>
      </div>
    </IcDialog>
  )
}
