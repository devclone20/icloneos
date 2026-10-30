import { useI18n } from '@/i18n'

import { IcActionLabel, type IcActionState, IcAlert, IcPageButton } from './ic-page'

interface ProfileDialogFooterProps {
  busy: boolean
  error: null | string
  labels: { busy: string; done: string; idle: string }
  onClose: () => void
  status: IcActionState
  submitDisabled: boolean
}

/** The create/rename dialogs' error line, Cancel and status-aware submit. */
export function ProfileDialogFooter({
  busy,
  error,
  labels,
  onClose,
  status,
  submitDisabled
}: ProfileDialogFooterProps) {
  const { t } = useI18n()

  return (
    <>
      {error ? <IcAlert>{error}</IcAlert> : null}

      <div className="icdlg__foot">
        <IcPageButton disabled={busy} onClick={onClose} tone="quiet">
          {t.common.cancel}
        </IcPageButton>
        <IcPageButton disabled={submitDisabled} tone="accent" type="submit">
          <IcActionLabel busy={labels.busy} done={labels.done} idle={labels.idle} state={status} />
        </IcPageButton>
      </div>
    </>
  )
}
