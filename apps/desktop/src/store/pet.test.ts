import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  $petActivity,
  $petAtRest,
  $petEnabled,
  $petId,
  $petLiveActivity,
  $petMotion,
  $petRoam,
  $petScale,
  $petState,
  choosePet,
  derivePetState,
  flashPetActivity,
  nextPetScaleFromWheel,
  PET_STORAGE_KEYS,
  removePet,
  resetPetActivity,
  setPetActivity,
  setPetRoam,
  setPetScale
} from './pet'
import { setBusy } from './session'

afterEach(() => {
  $petActivity.set({})
  $petMotion.set(null)
  setBusy(false)
  window.localStorage.clear()
  vi.useRealTimers()
})

describe('derivePetState (restored)', () => {
  it('rests at idle by default and waits when awaiting input', () => {
    expect(derivePetState({})).toBe('idle')
    expect(derivePetState({ awaitingInput: true })).toBe('waiting')
  })

  it('runs when busy or a tool is executing', () => {
    expect(derivePetState({ busy: true })).toBe('run')
    expect(derivePetState({ toolRunning: true })).toBe('run')
  })

  it('reviews while reasoning (below tool, above bare busy)', () => {
    expect(derivePetState({ reasoning: true })).toBe('review')
    expect(derivePetState({ reasoning: true, busy: true })).toBe('review')
    expect(derivePetState({ reasoning: true, toolRunning: true })).toBe('run')
  })

  it('waits above the in-flight signals; a finish beat still wins', () => {
    expect(derivePetState({ awaitingInput: true, toolRunning: true, busy: true })).toBe('waiting')
    expect(derivePetState({ justCompleted: true, awaitingInput: true })).toBe('wave')
  })

  it('honours the chain: error > celebrate > complete > tool', () => {
    expect(derivePetState({ error: true, celebrate: true, busy: true })).toBe('failed')
    expect(derivePetState({ celebrate: true, justCompleted: true, toolRunning: true })).toBe('jump')
    expect(derivePetState({ justCompleted: true, toolRunning: true })).toBe('wave')
  })
})

describe('the live state', () => {
  it('ignores stale steady flags once the turn is over', () => {
    setPetActivity({ reasoning: true, toolRunning: true })
    expect($petState.get()).toBe('idle')
    setBusy(true)
    expect($petState.get()).toBe('run')
    setPetActivity({ toolRunning: false })
    expect($petState.get()).toBe('review')
    resetPetActivity()
    expect($petState.get()).toBe('run')
  })

  it('a flash beat clears its siblings and decays (with a pet chosen; without one there is no beat)', () => {
    vi.useFakeTimers()
    flashPetActivity({ error: true })
    expect($petState.get()).toBe('idle')
    choosePet('n2')
    flashPetActivity({ error: true })
    expect($petState.get()).toBe('failed')
    flashPetActivity({ celebrate: true }, 2200)
    expect($petActivity.get().error).toBe(false)
    expect($petState.get()).toBe('jump')
    vi.advanceTimersByTime(2200)
    expect($petState.get()).toBe('idle')
  })

  it('the roam pose shows only at rest; activity always wins', () => {
    $petMotion.set('run')
    expect($petAtRest.get()).toBe(true)
    expect($petState.get()).toBe('run')
    setBusy(true)
    setPetActivity({ reasoning: true })
    expect($petAtRest.get()).toBe(false)
    expect($petState.get()).toBe('review')
    setBusy(false)
    expect($petState.get()).toBe('run')
  })

  it('carries awaitingInput from the stream into the live activity', () => {
    setPetActivity({ awaitingInput: true })
    expect($petLiveActivity.get().awaitingInput).toBe(true)
    expect($petState.get()).toBe('waiting')
  })
})

describe('the choice, persisted under hermes.desktop.pet.v3.*', () => {
  it('no pet by default; choosing one persists .v3.selected and shows it; remove returns to none', () => {
    removePet()
    expect($petId.get()).toBeNull()
    expect($petEnabled.get()).toBe(false)
    expect(choosePet('n445')).toBe(true)
    expect($petId.get()).toBe('n445')
    expect($petEnabled.get()).toBe(true)
    expect(window.localStorage.getItem(PET_STORAGE_KEYS.selected)).toBe('n445')
    expect(choosePet('boba')).toBe(false)
    expect($petId.get()).toBe('n445')
    removePet()
    expect($petId.get()).toBeNull()
    expect(window.localStorage.getItem(PET_STORAGE_KEYS.selected)).toBeNull()
  })

  it('a fresh profile has no pet; the selection survives a reload; a stale id falls back to no pet', async () => {
    window.localStorage.clear()
    vi.resetModules()
    expect((await import('./pet')).$petId.get()).toBeNull()

    window.localStorage.setItem(PET_STORAGE_KEYS.selected, 'n1405')
    vi.resetModules()
    expect((await import('./pet')).$petId.get()).toBe('n1405')

    window.localStorage.setItem(PET_STORAGE_KEYS.selected, 'n9999')
    vi.resetModules()
    const reloaded = await import('./pet')
    expect(reloaded.$petId.get()).toBeNull()
    expect(reloaded.$petEnabled.get()).toBe(false)
    expect(window.localStorage.getItem(PET_STORAGE_KEYS.selected)).toBeNull()
  })

  it('the scale is a whole number 1–3; the wheel steps one scale a notch', () => {
    expect(setPetScale(2.4)).toBe(2)
    expect($petScale.get()).toBe(2)
    expect(window.localStorage.getItem(PET_STORAGE_KEYS.scale)).toBe('2')
    expect(setPetScale(8)).toBe(3)
    expect(nextPetScaleFromWheel(3, -100)).toBe(3)
    expect(nextPetScaleFromWheel(3, 100)).toBe(2)
    expect(nextPetScaleFromWheel(1, 100)).toBe(1)
    expect(nextPetScaleFromWheel(1, -1)).toBe(2)
  })

  it('roam on/off persists', () => {
    setPetRoam(true)
    expect($petRoam.get()).toBe(true)
    expect(window.localStorage.getItem(PET_STORAGE_KEYS.roam)).toBe('true')
  })

  it('every key is a v3 key (never the retired .v1/.v2 names)', () => {
    for (const key of Object.values(PET_STORAGE_KEYS)) {
      expect(key.startsWith('hermes.desktop.pet.v3.')).toBe(true)
    }
  })
})
