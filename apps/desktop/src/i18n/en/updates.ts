import type { Translations } from '../types'

export const updates: Translations['updates'] = {
  stages: {
    idle: 'Getting ready…',
    prepare: 'Getting ready…',
    fetch: 'Downloading…',
    pull: 'Almost there…',
    pydeps: 'Finishing up…',
    update: 'Updating iclone os…',
    rebuild: 'Rebuilding the desktop app…',
    restart: 'Restarting iclone os…',
    done: 'Update complete',
    manual: 'Update from your terminal',
    guiSkew: 'Update the desktop app',
    error: 'Update paused'
  },
  checking: 'Looking for updates…',
  checkFailedTitle: 'Couldn’t check for updates',
  tryAgain: 'Try again',
  notAvailableTitle: 'Update not available',
  unsupportedMessage: 'This version of iclone os can’t update itself from inside the app.',
  connectionRetry: 'Check your connection and try again.',
  latestBody: 'You’re running the latest version.',
  latestBodyBackend: 'The backend is running the latest version.',
  allSetTitle: 'You’re all set',
  availableTitle: 'New update available',
  availableBody: 'A new version of iclone os is ready to install.',
  availableTitleBackend: 'Backend update available',
  availableBodyBackend: 'A newer version of the connected agent backend is ready to install.',
  availableBodyNoChangelog: 'A newer version is ready. Release notes aren’t available for this install type.',
  updateNow: 'Update now',
  maybeLater: 'Maybe later',
  moreChanges: count => `+ ${count} more change${count === 1 ? '' : 's'} included.`,
  manualTitle: 'Update from your terminal',
  manualBody: 'You installed the agent from the command line, so updates run there too. Paste this into your terminal:',
  manualPickedUp: 'The agent will pick up the new version next time you launch it.',
  guiSkewTitle: 'Update the desktop app',
  guiSkewBody:
    'The backend was updated, but this desktop app package wasn’t changed. Update or reinstall the iclone os desktop app (your AppImage / .deb / .rpm) to match.',
  copy: 'Copy',
  copied: 'Copied',
  done: 'Done',
  applyingBody:
    'The updater takes over in its own window and reopens iclone os automatically when it’s done. Please don’t reopen iclone os yourself while it’s updating.',
  applyingBodyBackend:
    'The remote backend is applying the update and will restart. iclone os reconnects automatically when it’s back.',
  applyingClose: 'This window will close while the update runs, then iclone os reopens on its own.',
  errorTitle: 'Update didn’t finish',
  errorBody: 'No worries — nothing was lost. You can try again now.',
  blockerTitle: 'Close local previews to update iclone os?',
  blockerBody:
    'iclone os needs to stop these local previews before updating. This will not modify or delete your files.',
  foreignBlockerTitle: 'Close other processes to update iclone os',
  foreignBlockerBody:
    'iclone os can’t safely close these processes automatically. Close the app, terminal, or service that owns each one, then try the update again.',
  mixedBlockerBody:
    'iclone os can close the local previews listed below. Other processes must be closed manually before the update can continue.',
  closePreviewsAndUpdate: 'Close previews and update',
  closePreviewsAndCheckAgain: 'Close previews and check again',
  localPreview: 'Local preview',
  portLabel: port => `Port ${port}`,
  pidLabel: pid => `PID ${pid}`,
  technicalDetails: 'Technical details',
  notNow: 'Not now',
  clientAlsoBehindTitle: 'Desktop app is behind',
  clientAlsoBehindMessage:
    'The backend is up to date, but this desktop app is still on an older version. Update it to pick up the latest fixes.',
  clientAlsoBehindAction: 'Update desktop app',
  everythingDispatched: 'Update dispatched',
  everythingSkipped: 'Skipped',
  everythingRowFailed: 'Update failed',
  everythingFanoutFailedTitle: 'Couldn’t update other instances',
  applyStatus: {
    preparing: 'Updating backend…',
    pulling: 'Backend updating…',
    restarting: 'Backend restarting to load the update…',
    notAvailable: 'Update not available for this backend.',
    failed: 'Backend update failed.',
    noReturn: 'Backend didn’t come back online. The update may not have completed — check the backend host.'
  }
}
