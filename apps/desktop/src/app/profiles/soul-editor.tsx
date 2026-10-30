/**
 * The SOUL.md editor — OURS (E3 decision #8): our field, our type, our states.
 *
 * The one behaviour this file exists to guarantee: what the user typed survives
 * a reload. Every keystroke lands in `soul-draft.ts` as well as in state, the
 * draft is read back before the file is shown, saving clears it, and typing the
 * file's own content back removes it. A load failure is an inline error with a
 * retry, never a toast over an empty box.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { getProfileSoul, updateProfileSoul } from '@/hermes'
import { useI18n } from '@/i18n'
import { AlertTriangle } from '@/lib/icons'
import { notify } from '@/store/notifications'

import { IcPageButton, IcPageSection, IcPageState } from './ic-page'
import { clearSoulDraft, readSoulDraft, writeSoulDraft } from './soul-draft'

type Load = { kind: 'error'; message: string } | { kind: 'loading' } | { kind: 'ready' }

export function SoulEditor({ profileName }: { profileName: string }) {
  const { t } = useI18n()
  const p = t.profiles
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [text, setText] = useState('')
  const [saved, setSaved] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<null | string>(null)
  const [attempt, setAttempt] = useState(0)
  // Which profile the in-flight request belongs to: switching rows while a
  // fetch is open must not paint the old profile's file into the new one.
  const wanted = useRef(profileName)

  // eslint-disable-next-line no-restricted-syntax -- request token (which profile the open fetch is for), not a mirrored atom
  useEffect(() => {
    wanted.current = profileName
    setLoad({ kind: 'loading' })
    setSaveError(null)

    void (async () => {
      try {
        const soul = await getProfileSoul(profileName)

        if (wanted.current !== profileName) {
          return
        }

        // The draft wins over the file: it is the newer version of the user's
        // intent. `base` is recorded against the file as it is NOW, so the
        // dirty flag stays honest even if the file changed under the draft.
        const draft = readSoulDraft(profileName)

        setSaved(soul.content)
        setText(draft ? draft.text : soul.content)
        setLoad({ kind: 'ready' })
      } catch (err) {
        if (wanted.current === profileName) {
          setLoad({ kind: 'error', message: err instanceof Error ? err.message : p.failedLoadSoul })
        }
      }
    })()
  }, [attempt, p, profileName])

  const onType = useCallback(
    (value: string) => {
      setText(value)
      writeSoulDraft(profileName, value, saved)
    },
    [profileName, saved]
  )

  const dirty = text !== saved

  const save = useCallback(async () => {
    setSaving(true)
    setSaveError(null)

    try {
      await updateProfileSoul(profileName, text)
      setSaved(text)
      clearSoulDraft(profileName)
      notify({ kind: 'success', title: p.soulSaved, message: profileName })
    } catch (err) {
      // The draft stays: a failed save is exactly when losing the text hurts.
      setSaveError(err instanceof Error ? err.message : p.failedSaveSoul)
    } finally {
      setSaving(false)
    }
  }, [p, profileName, text])

  return (
    <IcPageSection
      aside={dirty ? <span className="icpg__dim">{p.unsavedChanges}</span> : null}
      label={p.soulLabel}
      note={p.soulDesc}
    >
      {load.kind === 'loading' ? (
        <IcPageState kind="loading" title={p.loadingSoul} />
      ) : load.kind === 'error' ? (
        <IcPageState
          action={
            <IcPageButton onClick={() => setAttempt(n => n + 1)} tone="accent">
              {t.common.retry}
            </IcPageButton>
          }
          description={load.message}
          kind="error"
          title={p.failedLoadSoul}
        />
      ) : (
        <>
          <textarea
            aria-label={p.soulLabel}
            className="icpg__textarea"
            data-ic-soul=""
            onChange={event => onType(event.target.value)}
            spellCheck={false}
            value={text}
          />
          {saveError ? (
            <p className="icpg__alert" role="alert">
              <AlertTriangle aria-hidden="true" size={14} />
              <span>{saveError}</span>
            </p>
          ) : null}
          <div className="icpg__foot">
            <IcPageButton disabled={!dirty || saving} onClick={() => void save()} tone="accent">
              {saving ? p.saving : p.saveSoul}
            </IcPageButton>
          </div>
        </>
      )}
    </IcPageSection>
  )
}
