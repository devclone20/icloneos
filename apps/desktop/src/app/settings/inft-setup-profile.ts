/**
 * iclone os — the wizard's optional profile step: build, activate or delete
 * the Hermes profile that carries this iNFT's persona.
 */
import { useCallback, useEffect, useMemo } from 'react'

import { errorMessage } from '@/iclone-shared/errors'
import { profileSlugFor } from '@/iclone-shared/inft-slug'
import { refreshProfiles } from '@/store/profile'
import type { ProfileInfo } from '@/types/hermes'

import type { INftCardData } from '../home/collections'
import { buildInftProfile, deleteInftProfile, sourceFromCard } from '../home/inft-profile'
import { switchInft } from '../home/inft-switch'

import type { SetStep } from './inft-setup-runner'

interface ProfileStepParams {
  selected: INftCardData | null
  profiles: readonly ProfileInfo[]
  setStep: SetStep
}

interface ProfileStep {
  profileSlug: string
  profileExists: boolean
  buildProfileStep: () => Promise<void>
  activateProfileStep: () => Promise<void>
  deleteProfileStep: () => Promise<void>
}

export function useProfileStep({ profiles, selected, setStep }: ProfileStepParams): ProfileStep {
  useEffect(() => {
    refreshProfiles().catch(() => undefined)
  }, [])

  const profileSource = useMemo(
    () => (selected ? sourceFromCard(selected.id, selected.name, selected.bootstrap ?? null) : null),
    [selected]
  )

  const profileSlug = profileSource ? profileSlugFor(profileSource.contract, profileSource.tokenId) : ''
  const profileExists = profileSlug ? profiles.some(p => p.name === profileSlug) : false

  const setProfileStep = useCallback((patch: Parameters<SetStep>[1]) => setStep('profile', patch), [setStep])

  const buildProfileStep = useCallback(async () => {
    if (!profileSource) {
      return
    }

    setProfileStep({ running: true, error: undefined })

    try {
      await buildInftProfile(profileSource)
      await refreshProfiles()
      setProfileStep({ running: false, note: `profile ${profileSlug} built ✓` })
    } catch (err) {
      setProfileStep({ running: false, error: errorMessage(err) })
    }
  }, [profileSource, profileSlug, setProfileStep])

  const activateProfileStep = useCallback(async () => {
    if (!selected) {
      return
    }

    setProfileStep({ running: true, error: undefined })

    try {
      const result = await switchInft(selected, { origin: 'wizard' })

      setProfileStep({
        running: false,
        note: result.personaApplied ? `${selected.name} selected ✓` : (result.error ?? `${selected.name} on stage`)
      })
    } catch (err) {
      setProfileStep({ running: false, error: errorMessage(err) })
    }
  }, [selected, setProfileStep])

  const deleteProfileStep = useCallback(async () => {
    if (!profileSlug) {
      return
    }

    setProfileStep({ running: true, error: undefined })

    try {
      await deleteInftProfile(profileSlug)
      setProfileStep({ running: false, note: `profile ${profileSlug} deleted` })
    } catch (err) {
      setProfileStep({ running: false, error: errorMessage(err) })
    }
  }, [profileSlug, setProfileStep])

  return { profileSlug, profileExists, buildProfileStep, activateProfileStep, deleteProfileStep }
}
