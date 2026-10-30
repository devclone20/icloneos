/**
 * The Stage Director — keeps the iNFT ALIVE.
 *
 * Owner rule: the model must not loop one single motion forever. The director
 * layers three kinds of life on top of whatever the GLB ships:
 *
 *   1. CLIP PROGRAM — every embedded animation clip joins a shuffled rotation
 *      with 0.6s crossfades; single-clip models get playback-speed drift
 *      (0.85–1.2×) per segment so even one clip never repeats identically.
 *   2. ACTS — every 9–18s one procedural act plays on the model root or the
 *      camera rig, never the same act twice in a row: slow full turn, lean
 *      sway, bob, camera orbit, portrait dolly-in, clip restart at a random
 *      offset.
 *   3. BREATH — a constant, sub-perceptual scale/rock so stillness never
 *      reads as frozen.
 *
 * Everything is time-based (no per-frame allocations) and honors
 * prefers-reduced-motion by collapsing to a slow continuous turn only.
 */
import type { AnimationAction, AnimationMixer, Group, PerspectiveCamera } from 'three'

interface DirectorRig {
  mixer: AnimationMixer
  actions: AnimationAction[]
  /** The model root the director may rotate/translate. */
  root: Group
  camera: PerspectiveCamera
  /** Camera orbit basis — azimuth around this point at this radius/height. */
  focus: { x: number; y: number; z: number }
  radius: number
  reducedMotion: boolean
  /** True when the owner switched motion off — freeze the figure, keep the
   *  camera. Mutable: the stage flips it live without rebuilding the scene. */
  frozen?: boolean
}

type ActName = 'bob' | 'clip-restart' | 'orbit' | 'portrait' | 'sway' | 'turn'

const ACTS: ActName[] = ['turn', 'sway', 'bob', 'orbit', 'portrait', 'clip-restart']

/** Clip cross-fade length, in seconds. */
const CLIP_FADE_S = 0.6

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

interface ActState {
  name: ActName
  start: number
  duration: number
  /** Act-specific magnitudes frozen at act start. */
  a: number
  b: number
}

export class StageDirector {
  private rig: DirectorRig
  private clipIndex = 0
  private nextClipAt = 0
  private nextActAt = 0
  private act: ActState | null = null
  private lastAct: ActName | null = null
  private baseAzimuth: number
  private baseElevation: number
  private azimuthOffset = 0
  private dollyOffset = 0
  private yaw = 0
  private time = 0
  // Owner's hand on the camera (drag to orbit, wheel to dolly — like the
  // cloneframe.io stage). Offsets compose over the acts; recent input also
  // pauses new CAMERA acts so the director never fights the mouse.
  private userAzimuth = 0
  private userElevation = 0
  private userDolly = 0
  private lastUserAt = -Infinity
  // Director time at which the clip cross-fade in flight settles.
  private fadeUntil = -Infinity

  constructor(rig: DirectorRig) {
    this.rig = rig
    this.baseAzimuth = Math.atan2(rig.camera.position.x - rig.focus.x, rig.camera.position.z - rig.focus.z)
    this.baseElevation = Math.asin(
      Math.max(-1, Math.min(1, (rig.camera.position.y - rig.focus.y) / Math.max(rig.radius, 1e-4)))
    )

    const first = rig.actions[0]

    if (first) {
      first.play()
    }

    this.nextClipAt = 10 + Math.random() * 8
    this.nextActAt = 5 + Math.random() * 6
  }

  /** Advance the whole performance. `dt` in seconds. */
  update(dt: number) {
    const { rig } = this

    if (rig.frozen) {
      // Motion switched off: the figure holds its pose, but the owner's own
      // hand on the camera still works. No time advance, so the acts resume
      // where they left off when motion comes back.
      this.applyCamera()

      return
    }

    this.time += dt

    if (rig.reducedMotion) {
      // Quiet mode: one slow continuous turn, nothing else — but the owner's
      // own hand on the camera still works. The mixer crawls instead of
      // playing: updating it at full speed BEFORE this branch meant a GLB
      // with an embedded dance clip performed at 1× under
      // prefers-reduced-motion — the largest motion in the app ignoring the
      // one setting that asks for stillness. A trickle keeps the pose alive
      // without the choreography.
      rig.mixer.update(dt * 0.12)
      this.yaw += dt * 0.12
      rig.root.rotation.y = this.yaw
      this.applyCamera()

      return
    }

    rig.mixer.update(dt)
    this.updateClipProgram()
    this.updateActs(dt)
    this.updateBreath()
    this.applyCamera()
  }

  /**
   * True while the director itself moves the figure or the camera: an act from its start to its end, or a clip
   * cross-fade until it settles. A frozen rig never moves. The stage draws at display rate while this holds.
   */
  get moving(): boolean {
    return !this.rig.frozen && (this.act !== null || this.time < this.fadeUntil)
  }

  /** Drag input, in radians: +dx orbits right, +dy looks from higher up.
   *  Elevation runs nearly pole to pole (±87°) so the owner can inspect
   *  every angle — including the creator's signature on the sole. */
  orbitBy(dx: number, dy: number) {
    this.userAzimuth += dx
    this.userElevation = Math.max(-1.5, Math.min(1.5, this.userElevation + dy))
    this.lastUserAt = this.time
  }

  /** Wheel input: positive zooms in. Clamped so the model can't be lost. */
  dollyBy(delta: number) {
    const { radius } = this.rig

    this.userDolly = Math.max(-radius * 0.8, Math.min(radius * 0.5, this.userDolly + delta))
    this.lastUserAt = this.time
  }

  private userIsDriving(): boolean {
    return this.time - this.lastUserAt < 8
  }

  private updateClipProgram() {
    const { actions } = this.rig

    if (this.time < this.nextClipAt) {
      return
    }

    if (actions.length > 1) {
      const next = (this.clipIndex + 1 + Math.floor(Math.random() * (actions.length - 1))) % actions.length
      const from = actions[this.clipIndex]
      const to = actions[next]

      to.reset()
      to.play()
      from.crossFadeTo(to, CLIP_FADE_S, true)
      this.fadeUntil = this.time + CLIP_FADE_S
      this.clipIndex = next
    } else if (actions[0]) {
      // Single clip: drift the playback speed so the loop never feels metric.
      actions[0].timeScale = 0.85 + Math.random() * 0.35
    }

    this.nextClipAt = this.time + 10 + Math.random() * 9
  }

  private updateActs(dt: number) {
    if (!this.act) {
      if (this.time >= this.nextActAt) {
        this.startAct()
      }

      return
    }

    const { act } = this
    const t = Math.min(1, (this.time - act.start) / act.duration)
    const eased = easeInOut(t)
    const { root } = this.rig

    switch (act.name) {
      case 'turn':
        root.rotation.y = this.yaw + eased * act.a

        break

      case 'sway':
        root.rotation.z = Math.sin(eased * Math.PI * act.b) * act.a
        root.rotation.x = Math.sin(eased * Math.PI * act.b * 0.5) * act.a * 0.4

        break

      case 'bob':
        root.position.y = Math.sin(eased * Math.PI * act.b) * act.a

        break

      case 'orbit':
        this.azimuthOffset = Math.sin(eased * Math.PI) * act.a

        break

      case 'portrait':
        this.dollyOffset = Math.sin(eased * Math.PI) * act.a

        break

      case 'clip-restart':
        // One-shot at act start — nothing continuous.
        break
    }

    if (t >= 1) {
      if (act.name === 'turn') {
        this.yaw += act.a
        root.rotation.y = this.yaw
      }

      if (act.name === 'sway') {
        root.rotation.z = 0
        root.rotation.x = 0
      }

      if (act.name === 'bob') {
        root.position.y = 0
      }

      this.act = null
      this.nextActAt = this.time + 9 + Math.random() * 9
    }

    void dt
  }

  private startAct() {
    // While the owner drives the camera, only MODEL acts join the rotation —
    // the director's own orbit/dolly would yank the view out of their hands.
    const cameraActs: ActName[] = ['orbit', 'portrait']
    const pool = ACTS.filter(name => name !== this.lastAct && !(this.userIsDriving() && cameraActs.includes(name)))
    const name = pool[Math.floor(Math.random() * pool.length)]
    const act: ActState = { name, start: this.time, duration: 4, a: 0, b: 0 }

    switch (name) {
      case 'turn':
        // A slow, tasteful showcase turn — never a spin (owner rule).
        act.duration = 18 + Math.random() * 8
        act.a = (Math.random() < 0.5 ? 1 : -1) * Math.PI * 2

        break

      case 'sway':
        act.duration = 4.5
        act.a = 0.05 + Math.random() * 0.04
        act.b = 2

        break

      case 'bob':
        act.duration = 3.5
        act.a = this.rig.radius * 0.02
        act.b = 2

        break

      case 'orbit':
        act.duration = 7 + Math.random() * 3
        act.a = (Math.random() < 0.5 ? 1 : -1) * (0.35 + Math.random() * 0.25)

        break

      case 'portrait':
        act.duration = 6
        // Capped so the closest portrait distance still fits the whole body
        // (0.78·radius ≈ 1.8× height at the 2.35 base) — the close-up leans
        // in without ever cropping the head (owner-reported on ATLAS).
        act.a = this.rig.radius * (0.14 + Math.random() * 0.08)

        break
      case 'clip-restart': {
        act.duration = 0.1
        const action = this.rig.actions[this.clipIndex]

        if (action) {
          const clipDuration = action.getClip().duration

          action.time = Math.random() * clipDuration
        }

        break
      }
    }

    this.act = act
    this.lastAct = name
  }

  private updateBreath() {
    const scale = 1 + Math.sin(this.time * 0.9) * 0.004
    const { root } = this.rig

    root.scale.setScalar(scale)
  }

  private applyCamera() {
    const { camera, focus, radius } = this.rig
    const azimuth = this.baseAzimuth + this.azimuthOffset + this.userAzimuth
    const elevation = Math.max(-1.52, Math.min(1.52, this.baseElevation + this.userElevation))
    const distance = Math.max(radius * 0.4, radius - this.dollyOffset - this.userDolly)
    const horizontal = Math.cos(elevation) * distance

    camera.position.x = focus.x + Math.sin(azimuth) * horizontal
    camera.position.z = focus.z + Math.cos(azimuth) * horizontal
    camera.position.y = focus.y + Math.sin(elevation) * distance
    camera.lookAt(focus.x, focus.y, focus.z)
  }
}
