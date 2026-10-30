import {
  type AnimationAction,
  type AnimationMixer,
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera
} from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runContextSafeLoop } from './gpu-lease'
import { recallParsedModel, rememberParsedModel, stageBusyUntil, stageModelCopy } from './stage3d'
import { StageDirector } from './stage-director'

type Parsed = Parameters<typeof rememberParsedModel>[1]

function model(name: string): Parsed {
  const scene = new Group()
  const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial({ opacity: 0.5, transparent: true }))

  scene.name = name
  scene.add(mesh)

  return { animations: [], scene, scenes: [scene] } as unknown as Parsed
}

describe('parsed model cache', () => {
  it('keeps the three most recent models by URL; a recall refreshes recency', () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(model)

    rememberParsedModel('u:a', a)
    rememberParsedModel('u:b', b)
    rememberParsedModel('u:c', c)
    expect(recallParsedModel('u:a')).toBe(a)
    rememberParsedModel('u:d', d)
    expect(recallParsedModel('u:b')).toBeUndefined()
    expect(recallParsedModel('u:a')).toBe(a)
    expect(recallParsedModel('u:c')).toBe(c)
    expect(recallParsedModel('u:d')).toBe(d)
  })

  it('a stage copy owns its nodes and materials and shares the geometry', () => {
    const source = model('src')
    const copy = stageModelCopy(source)
    const [sourceMesh] = source.scene.children as Mesh[]
    const [copyMesh] = copy.scene.children as Mesh[]

    expect(copy.scene).not.toBe(source.scene)
    expect(copy.scenes).toEqual([copy.scene])
    expect(copyMesh).not.toBe(sourceMesh)
    expect(copyMesh.geometry).toBe(sourceMesh.geometry)
    expect(copyMesh.material).not.toBe(sourceMesh.material)
    ;(copyMesh.material as MeshStandardMaterial).opacity = 0.1
    expect((sourceMesh.material as MeshStandardMaterial).opacity).toBe(0.5)
  })
})

describe('StageDirector.moving', () => {
  const rigFor = (actions: AnimationAction[] = []) => ({
    actions,
    camera: new PerspectiveCamera(),
    focus: { x: 0, y: 0, z: 0 },
    frozen: false,
    mixer: { update: vi.fn() } as unknown as AnimationMixer,
    radius: 1,
    reducedMotion: false,
    root: new Group()
  })

  /** Advance the director in 1/60 s steps until its clock passes `seconds`. */
  const playUntil = (director: StageDirector, clock: { t: number }, seconds: number) => {
    while (clock.t < seconds) {
      director.update(1 / 60)
      clock.t += 1 / 60
    }
  }

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('holds for the whole act, from its start to its end, and never while the rig is frozen', () => {
    // Math.random = 0: the first act starts at 5 s and is a full turn of 18 s.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const rig = rigFor()
    const director = new StageDirector(rig)
    const clock = { t: 0 }

    playUntil(director, clock, 4.5)
    expect(director.moving).toBe(false)
    playUntil(director, clock, 5.5)
    expect(director.moving).toBe(true)
    playUntil(director, clock, 22.5)
    expect(director.moving).toBe(true)
    rig.frozen = true
    expect(director.moving).toBe(false)
    rig.frozen = false
    playUntil(director, clock, 23.5)
    expect(director.moving).toBe(false)
  })

  it('holds for the 0.6 s of a clip cross-fade with no act in flight', () => {
    // Math.random = 0.99: a 0.1 s clip-restart act at 10.94 s, then the first cross-fade at 17.92 s.
    vi.spyOn(Math, 'random').mockReturnValue(0.99)

    const action = () =>
      ({
        crossFadeTo: vi.fn(),
        getClip: () => ({ duration: 2 }),
        play: vi.fn(),
        reset: vi.fn(),
        time: 0,
        timeScale: 1
      }) as unknown as AnimationAction

    const director = new StageDirector(rigFor([action(), action()]))
    const clock = { t: 0 }

    playUntil(director, clock, 17.5)
    expect(director.moving).toBe(false)
    playUntil(director, clock, 18.2)
    expect(director.moving).toBe(true)
    playUntil(director, clock, 18.8)
    expect(director.moving).toBe(false)
  })

  it('the frame budget admits every vsync while the director moves', () => {
    const frames = new Map<number, FrameRequestCallback>()
    let handle = 0

    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++handle, callback)

      return handle
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => void frames.delete(id))
    expect(stageBusyUntil(1500, 1000, false)).toBe(1500)
    expect(stageBusyUntil(1500, 1000, true)).toBe(3000)

    let now = 0
    let busyUntil = stageBusyUntil(0, now, true)

    const drawn = vi.fn(() => {
      busyUntil = stageBusyUntil(busyUntil, now, true)
    })

    const stop = runContextSafeLoop(document.createElement('canvas'), drawn, () => undefined, {
      busy: () => now < busyUntil
    })

    for (let i = 0; i < 240; i++) {
      now = (i * 1000) / 120
      const due = [...frames.values()]

      frames.clear()
      due.forEach(callback => callback(now))
    }

    expect(drawn).toHaveBeenCalledTimes(240)
    stop()
  })
})
