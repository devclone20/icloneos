/**
 * iclone os — per-step notes of one iNFT's wizard (`notes` kv file in main:
 * atomic, validated, redacted on write — the renderer shows what was stored).
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { asRecord } from '@/iclone-shared/guards'

import { inftKvDelete, inftKvGet, inftKvSet } from '../home/acp-setup'

type StepNotes = Record<string, { text: string; updatedAt: number }>

const NOTE_MAX_CHARS = 8 * 1024

function notesFrom(value: unknown): StepNotes {
  const out: StepNotes = {}

  for (const [key, entry] of Object.entries(asRecord(value) ?? {})) {
    const note = asRecord(entry)

    if (typeof note?.text === 'string' && typeof note.updatedAt === 'number') {
      out[key] = { text: note.text, updatedAt: note.updatedAt }
    }
  }

  return out
}

export interface StepNotesApi {
  notes: StepNotes
  /** The last save had a secret-looking value masked before it was stored. */
  masked: boolean
  error?: string
  saveNote: (key: string, text: string) => Promise<void>
  deleteNote: (key: string) => Promise<void>
}

export function useStepNotes(inftId: string | null): StepNotesApi {
  const [notes, setNotes] = useState<StepNotes>({})
  const [masked, setMasked] = useState(false)
  const [error, setError] = useState<string>()
  const current = useRef<StepNotes>({})

  const remember = useCallback((next: StepNotes) => {
    current.current = next
    setNotes(next)
  }, [])

  useEffect(() => {
    let live = true

    remember({})
    setMasked(false)
    setError(undefined)

    if (inftId) {
      void inftKvGet(inftId, 'notes').then(result => {
        if (live && result.ok) {
          remember(notesFrom(result.value))
        }
      })
    }

    return () => {
      live = false
    }
  }, [inftId, remember])

  const store = useCallback(
    async (next: StepNotes) => {
      if (!inftId) {
        return
      }

      const result = Object.keys(next).length
        ? await inftKvSet(inftId, 'notes', next)
        : await inftKvDelete(inftId, 'notes')

      if (!result.ok) {
        setError(result.error)

        return
      }

      current.current = result.value ? notesFrom(result.value) : {}
      setNotes(current.current)
      setMasked(Boolean(result.masked))
      setError(undefined)
    },
    [inftId]
  )

  const saveNote = useCallback(
    (key: string, text: string) => {
      const clean = text.trim().slice(0, NOTE_MAX_CHARS)

      if (!clean) {
        const { [key]: _gone, ...rest } = current.current

        return store(rest)
      }

      return store({ ...current.current, [key]: { text: clean, updatedAt: Date.now() } })
    },
    [store]
  )

  const deleteNote = useCallback(
    (key: string) => {
      const { [key]: _gone, ...rest } = current.current

      return store(rest)
    },
    [store]
  )

  return { notes, masked, error, saveNote, deleteNote }
}
