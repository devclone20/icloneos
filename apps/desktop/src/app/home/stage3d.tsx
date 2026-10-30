/**
 * The iNFT Stage — reads the token's on-chain GLB and performs it live.
 *
 * The model arrives as bytes from the main process (electron/iclone-model.ts,
 * disk-cached), loads through GLTFLoader.parse, is framed by its own bounds
 * (backdrop domes and helper spheres baked into collection GLBs stay hidden
 * — their material color is extracted and handed up via onBackdrop so the
 * CSS layer paints the token's field edge to edge, one uniform color), lit
 * in the house key/fill/rim, and handed to the StageDirector so it never
 * repeats one motion forever.
 */
import { useEffect, useRef, useState } from 'react'
import {
  ACESFilmicToneMapping,
  AmbientLight,
  AnimationMixer,
  Box3,
  Clock,
  DirectionalLight,
  Group,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer
} from 'three'
import type { Material } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'

import { $aura } from './aura-prefs'
import { reserveGpuContext, runContextSafeLoop } from './gpu-lease'
import { StageDeactivatedLabel } from './ownership-dialog'
import { StageDirector } from './stage-director'
import { $motion, $quality } from './stage-prefs'

// Scenery baked into collection GLBs — the artist's field, not the agent. It
// ships in several families and they are NOT interchangeable:
//   iCLONE_Backdrop / icosphere   the single dome of the first 1111
//   iCLONE_Field_00…81            the 82 concentric flat shells added so
//                                 OpenSea's pan never reveals white
//   env_core* / env_atm* / env_water   the god_mode atmosphere
// Matching only 'backdrop' and 'icosphere' left 82 shells visible on the
// 2222 and the studio experimentals: a flat coloured wall filled the frame
// and the bounds measured the shells, so the character came out tiny.
type ParsedModel = Awaited<ReturnType<GLTFLoader['parseAsync']>>

// The last few parsed models by URL: switching back to a recent iNFT skips the IPC fetch and the parse.
const parsedModels = new Map<string, ParsedModel>()
const PARSED_MODELS_KEPT = 3
// Input keeps the stage at display rate this long (drag inertia, dolly easing); otherwise it idles at 30 fps.
const STAGE_BUSY_MS = 2000

/** The display-rate horizon after a tick: the director's own motion (an act, a clip cross-fade) counts like input. */
export function stageBusyUntil(busyUntil: number, now: number, moving: boolean): number {
  return moving ? Math.max(busyUntil, now + STAGE_BUSY_MS) : busyUntil
}

export function recallParsedModel(url: string): ParsedModel | undefined {
  const gltf = parsedModels.get(url)

  if (gltf) {
    rememberParsedModel(url, gltf)
  }

  return gltf
}

export function rememberParsedModel(url: string, gltf: ParsedModel) {
  parsedModels.delete(url)
  parsedModels.set(url, gltf)

  for (const oldest of parsedModels.keys()) {
    if (parsedModels.size <= PARSED_MODELS_KEPT) {
      break
    }

    parsedModels.delete(oldest)
  }
}

/** The stage's own copy of a cached model: its own nodes, skeleton and materials (the stage writes material opacity
 *  and depth), sharing the read-only geometry, textures and clips. */
export function stageModelCopy(gltf: ParsedModel): ParsedModel {
  const scene = cloneSkinned(gltf.scene) as typeof gltf.scene

  scene.traverse(node => {
    const mesh = node as unknown as { material?: Material | Material[] }

    if (mesh.material) {
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(m => m.clone()) : mesh.material.clone()
    }
  })

  return { ...gltf, scene, scenes: [scene] }
}

const EXCLUDED_RE =
  /(^|_)env(_|\d|$)|backdrop|icosphere|skydome|(^|_)dome(_|\d|$)|(^|_)field(_|\d|$)|atmosphere|vignette|_bg(_|\d|$)/i

function isEnvNode(name: string | undefined, materialName?: string): boolean {
  return EXCLUDED_RE.test(name || '') || EXCLUDED_RE.test(materialName || '')
}

// But "env" is TWO different things, and the split is the whole doctrine
// (ported from the mini app's stage.js): SCENERY is a wall — always hidden,
// repainted as one flat colour. AURA is the artwork — a God Mode piece is an
// avatar frozen in a core of ice (env_core00…, env_atm00…, env_water), a stack
// of nested translucent emissive shells — and it is KEPT, tamed so the stack
// accumulates to the aura preference instead of the solid white it was
// authored to reach. One stray translucent shell is not a core; above this
// opacity it is a surface, not a veil; a wall is never aura.
const AURA_MIN_SHELLS = 4
const AURA_MAX_OPACITY = 0.35
const AURA_WALL_RE = /field|backdrop|dome|icosphere|skydome|vignette/i

interface EnvMaterial {
  name?: string
  emissive?: { r: number; g: number; b: number }
  transparent?: boolean
  opacity?: number
  isMeshBasicMaterial?: boolean
}

function isAuraNode(node: { isMesh?: boolean; name?: string; material?: EnvMaterial | EnvMaterial[] }): boolean {
  if (
    !node.isMesh ||
    !isEnvNode(node.name, node.material && !Array.isArray(node.material) ? node.material.name : undefined)
  ) {
    return false
  }

  const mats = ([] as EnvMaterial[]).concat((node.material || []) as EnvMaterial | EnvMaterial[])

  if (AURA_WALL_RE.test(`${node.name} ${mats.map(m => m?.name ?? '').join(' ')}`)) {
    return false
  }

  for (const m of mats) {
    if (!m) {
      continue
    }

    const emissive = m.emissive && m.emissive.r + m.emissive.g + m.emissive.b > 0

    if (
      m.transparent &&
      m.opacity !== undefined &&
      m.opacity > 0 &&
      m.opacity <= AURA_MAX_OPACITY &&
      (emissive || m.isMeshBasicMaterial)
    ) {
      return true
    }
  }

  return false
}

/** The single factor k with 1 − Π(1 − k·aᵢ) = target. Monotonic in k, so
 *  bisection is exact enough in 40 steps and costs nothing once per load. */
function auraScale(alphas: number[], target: number): number {
  if (!alphas.length || target <= 0) {
    return 0
  }

  const through = (k: number) => alphas.reduce((p, a) => p * (1 - Math.min(0.999, k * a)), 1)

  if (1 - through(1) <= target) {
    return 1
  }

  let lo = 0
  let hi = 1

  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2

    if (1 - through(m) < target) {
      lo = m
    } else {
      hi = m
    }
  }

  return (lo + hi) / 2
}

export function Stage3D({
  modelUrl,
  onBackdrop,
  onError
}: {
  modelUrl: string
  /** The iNFT's own field: the baked scenery's color (CSS hex), or null when
   *  the model ships none — the layer behind decides the fallback. */
  onBackdrop?: (color: string | null) => void
  onError: (message: string) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)

  // Live aura retune — built once per model load (inside run), then called on
  // every $aura change. A slider must never rebuild the scene.
  // The scene installs its live appliers here once it exists; the pref
  // subscriptions below call whatever is installed. One holder object whose
  // fields are swapped — a ref mirrored from an effect is the house anti-pattern.
  const appliersRef = useRef({
    aura: (_target: number) => undefined as void,
    quality: () => undefined as void,
    motion: (_on: boolean) => undefined as void
  })

  useEffect(() => {
    const unsubs = [
      $aura.subscribe(target => appliersRef.current.aura(target)),
      $quality.subscribe(() => appliersRef.current.quality()),
      $motion.subscribe(on => appliersRef.current.motion(on))
    ]

    return () => unsubs.forEach(unsub => unsub())
  }, [])

  useEffect(() => {
    const host = hostRef.current
    const appliers = appliersRef.current

    if (!host) {
      return
    }

    let disposed = false
    let renderer: null | WebGLRenderer = null
    let cleanupResize: (() => void) | null = null
    let cleanupInput: (() => void) | null = null
    let stopLoop: (() => void) | null = null
    // A frozen stage draws only what changed: input, a resize, a pref.
    let dirty = true
    let busyUntil = 0

    const wake = () => {
      dirty = true
      busyUntil = performance.now() + STAGE_BUSY_MS
    }

    let releaseGpu: (() => void) | null = null

    const fetchAndParse = async (bridge: NonNullable<NonNullable<Window['hermesDesktop']>['icloneModel']>) => {
      const result = await bridge.fetch(modelUrl)

      if (disposed) {
        return null
      }

      if (!result.ok || !result.data) {
        onError(result.error ?? 'The model could not be fetched.')

        return null
      }

      const buffer = result.data.buffer.slice(
        result.data.byteOffset,
        result.data.byteOffset + result.data.byteLength
      ) as ArrayBuffer

      const gltf = await new Promise<ParsedModel>((resolve, reject) => {
        new GLTFLoader().parse(buffer, '', resolve, reject)
      }).catch((error: unknown) => {
        onError(error instanceof Error ? error.message : 'The model could not be parsed.')

        return null
      })

      if (gltf) {
        rememberParsedModel(modelUrl, gltf)
      }

      return gltf
    }

    const run = async () => {
      const bridge = window.hermesDesktop?.icloneModel

      if (!bridge) {
        onError('Model bridge unavailable in this window.')

        return
      }

      const parsed = recallParsedModel(modelUrl) ?? (await fetchAndParse(bridge))

      if (!parsed || disposed) {
        return
      }

      const gltf = stageModelCopy(parsed)

      // Scene
      const scene = new Scene()
      const root = new Group()
      const scenery: (typeof gltf.scene)[] = []

      // Dev-only bench flag: keep the baked dome visible to study collection
      // scenery (never set in production).
      const showScenery =
        import.meta.env.DEV && Boolean((window as unknown as { __istageShowScenery?: boolean }).__istageShowScenery)

      const auraNodes: (typeof gltf.scene)[] = []
      const auraShells: { mesh: unknown; m: Material; authored: number }[] = []

      gltf.scene.traverse(node => {
        const materialName = (node as unknown as { material?: { name?: string } }).material?.name

        if (!isEnvNode(node.name, materialName)) {
          return
        }

        // Aura is artwork: keep it and tame it. Scenery is a wall: hide it.
        if (
          isAuraNode(node as unknown as { isMesh?: boolean; name?: string; material?: EnvMaterial | EnvMaterial[] })
        ) {
          auraNodes.push(node as typeof gltf.scene)

          return
        }

        node.visible = showScenery
        scenery.push(node as typeof gltf.scene)
      })

      if (auraNodes.length < AURA_MIN_SHELLS) {
        for (const node of auraNodes) {
          node.visible = false
        }
      } else {
        for (const node of auraNodes) {
          for (const m of ([] as Material[]).concat(
            (node as unknown as { material?: Material | Material[] }).material || []
          )) {
            if (!m || !m.transparent) {
              continue
            }

            auraShells.push({ mesh: node, m, authored: m.opacity })
            m.depthWrite = false // a veil must not occlude what is behind it
          }
        }
      }

      appliers.aura = (target: number) => {
        dirty = true

        if (!auraShells.length) {
          return
        }

        const k = auraScale(
          auraShells.map(x => x.authored),
          Math.max(0, Math.min(0.9, target))
        )

        for (const x of auraShells) {
          x.m.opacity = x.authored * k
          x.m.visible = target > 0
          x.m.needsUpdate = true
        }
      }

      appliers.aura($aura.get())

      root.add(gltf.scene)
      scene.add(root)

      // Bounds of the agent only (scenery hidden above is still in the tree —
      // measure visible meshes by expanding over them manually). A SKINNED
      // mesh measures through its BONES' world positions — the only frame
      // Mixamo exports answer truthfully (bind-space geometry boxes land at
      // the wrong scale/offset; verified live on the 1111 NOIR rig).
      const bounds = new Box3()
      let bonesMeasured = false

      // Pose the rig on the FIRST animation frame before measuring — rest
      // pose and performed pose can sit apart (the 1111 clips move the body),
      // and the camera must frame what actually shows.
      const mixer = new AnimationMixer(gltf.scene)
      const actions = gltf.animations.map(clip => mixer.clipAction(clip))

      if (actions[0]) {
        actions[0].play()
        mixer.update(0)
      }

      // Measure across the WHOLE first clip, not one frame — hover/step
      // animations (ATLAS floats) carry the body outside the t=0 box and the
      // head left the frame (owner-reported). Union of sampled poses.
      const clipDuration = gltf.animations[0]?.duration ?? 0

      const measurePose = () => {
        gltf.scene.updateWorldMatrix(true, true)
        gltf.scene.traverse(node => {
          const mesh = node as unknown as {
            isMesh?: boolean
            isSkinnedMesh?: boolean
            skeleton?: { bones: { matrixWorld: { elements: number[] } }[] }
          }

          if (!mesh.isMesh || !node.visible) {
            return
          }

          // Aura shells are visible artwork, but they are scenery-scale domes:
          // never let them widen the character's frame.
          if (isEnvNode(node.name, (node as unknown as { material?: { name?: string } }).material?.name)) {
            return
          }

          if (mesh.isSkinnedMesh && mesh.skeleton) {
            for (const bone of mesh.skeleton.bones) {
              const e = bone.matrixWorld.elements

              bounds.expandByPoint(new Vector3(e[12], e[13], e[14]))
            }

            bonesMeasured = true

            return
          }

          bounds.expandByObject(node)
        })
      }

      measurePose()

      if (actions[0] && clipDuration > 0) {
        const SAMPLES = 12

        for (let i = 1; i <= SAMPLES; i++) {
          mixer.update(clipDuration / SAMPLES)
          measurePose()
        }

        // Rewind to the top of the clip for the live performance.
        actions[0].reset().play()
        mixer.update(0)
      }

      // Joints sit inside the flesh — pad so heads and feet stay in frame.
      if (bonesMeasured) {
        const pad = Math.max(bounds.getSize(new Vector3()).y, 1e-4)

        bounds.expandByVector(new Vector3(pad * 0.1, pad * 0.12, pad * 0.1))
      }

      // Owner rule: an OPEN iNFT owns the whole screen in ONE uniform color.
      // The baked dome stays hidden — rendering it drew a visible circle
      // against the CSS field ("desagradável") — but its material color IS
      // the token's field, handed up so the layer paints it edge to edge.
      // WHICH scenery colour: the outermost flat shell of the canonical field
      // family (iCLONE_Field_* / Backdrop / dome), never a textured atmosphere
      // sprite and never simply "the first material found" — on a god_mode
      // piece that is env_core's near-white, which washes the whole screen out.
      let backdropColor: null | string = null
      let best: null | { rank: number; radius: number } = null

      for (const node of scenery) {
        node.traverse(child => {
          const mesh = child as unknown as {
            isMesh?: boolean
            name?: string
            geometry?: { boundingSphere?: { radius: number } | null; computeBoundingSphere?: () => void }
            material?: {
              name?: string
              map?: unknown
              isMeshBasicMaterial?: boolean
              color?: { getHexString?: () => string }
            }
          }

          if (!mesh.isMesh || !mesh.material || mesh.material.map) {
            return
          }

          const hex = mesh.material.color?.getHexString?.()

          if (!hex) {
            return
          }

          mesh.geometry?.computeBoundingSphere?.()

          const radius = mesh.geometry?.boundingSphere?.radius ?? 0

          const rank = /field|backdrop|dome/i.test(`${mesh.name ?? ''} ${mesh.material.name ?? ''}`)
            ? 2
            : mesh.material.isMeshBasicMaterial
              ? 1
              : 0

          if (!best || rank > best.rank || (rank === best.rank && radius > best.radius)) {
            best = { rank, radius }
            backdropColor = `#${hex}`
          }
        })
      }

      onBackdrop?.(backdropColor)

      const size = bounds.getSize(new Vector3())
      const center = bounds.getCenter(new Vector3())
      const height = Math.max(size.y, 1e-4)

      // Frame the character where it stands — recentering the scene would
      // drag the baked scenery dome (the 1111 field) off-center with it.
      // The camera focuses the measured center instead; director bobs move
      // the root relative to it, so they read the same.
      const focus = { x: center.x, y: center.y + height * 0.05, z: center.z }
      // 1.9 keeps helmet-topped rigs clear of the window edge while letting
      // the character fill more of the frame (the studio experimentals
      // god-mode rovers read too small at the older 2.35); a narrow window
      // (portrait split) pushes the camera further back still.
      const aspect0 = Math.max(0.4, host.clientWidth / Math.max(host.clientHeight, 1))
      const radius = height * 1.9 * (aspect0 < 0.85 ? 0.85 / aspect0 : 1)

      // Dev-only stage introspection for the E2E harness (framing math).
      if (import.meta.env.DEV) {
        ;(window as unknown as { __istageDebug?: unknown }).__istageDebug = {
          bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
          center: center.toArray(),
          height,
          radius,
          focus,
          scenery: scenery.map(node => node.name)
        }
      }

      const camera = new PerspectiveCamera(34, 1, height / 100, height * 60)

      camera.position.set(Math.sin(0.32) * radius, focus.y + height * 0.12, Math.cos(0.32) * radius)
      camera.lookAt(focus.x, focus.y, focus.z)

      // House light: warm key, cool fill, teal rim — the login-page palette.
      scene.add(new AmbientLight(0xf6f4fa, 0.55))
      const key = new DirectionalLight(0xffeecd, 2.4)

      key.position.set(-1.6, 2.2, 1.8)
      scene.add(key)
      const fill = new DirectionalLight(0xdbe4ff, 0.7)

      fill.position.set(1.8, 0.6, 1.2)
      scene.add(fill)
      const rim = new DirectionalLight(0x8ceee2, 1.6)

      rim.position.set(0.6, 1.4, -2.0)
      scene.add(rim)

      // The stage's context counts against the terminals' WebGL budget, so a
      // busy iT session can never push Chromium into evicting it.
      releaseGpu = reserveGpuContext('stage3d')
      renderer = new WebGLRenderer({ alpha: true, antialias: true })
      renderer.toneMapping = ACESFilmicToneMapping
      host.appendChild(renderer.domElement)

      const qualityCap = () => ($quality.get() === 'max' ? 3 : $quality.get() === 'high' ? 2.5 : 2)

      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, qualityCap()))

      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      const rig = { mixer, actions, root, camera, focus, radius, reducedMotion, frozen: !$motion.get() }
      const director = new StageDirector(rig)

      appliers.motion = (on: boolean) => {
        rig.frozen = !on
        dirty = true
      }

      // Owner's hand: drag to orbit, wheel to dolly — the cloneframe.io feel.
      let dragPointer: number | null = null
      let dragX = 0
      let dragY = 0

      const onPointerDown = (event: PointerEvent) => {
        if (event.button !== 0) {
          return
        }

        wake()
        dragPointer = event.pointerId
        dragX = event.clientX
        dragY = event.clientY
        host.classList.add('istage--dragging')
        host.setPointerCapture?.(event.pointerId)
      }

      const onPointerMove = (event: PointerEvent) => {
        if (dragPointer !== event.pointerId) {
          return
        }

        // Negated dx: dragging RIGHT must turn the model to the right (the
        // natural grab-and-spin read — owner correction).
        wake()
        director.orbitBy((dragX - event.clientX) * 0.005, (event.clientY - dragY) * 0.004)
        dragX = event.clientX
        dragY = event.clientY
      }

      const endDrag = (event: PointerEvent) => {
        if (dragPointer === event.pointerId) {
          dragPointer = null
          host.classList.remove('istage--dragging')
        }
      }

      const onWheel = (event: WheelEvent) => {
        event.preventDefault()
        wake()
        director.dollyBy(-event.deltaY * radius * 0.0011)
      }

      host.addEventListener('pointerdown', onPointerDown)
      host.addEventListener('pointermove', onPointerMove)
      host.addEventListener('pointerup', endDrag)
      host.addEventListener('pointercancel', endDrag)
      host.addEventListener('wheel', onWheel, { passive: false })

      cleanupInput = () => {
        host.removeEventListener('pointerdown', onPointerDown)
        host.removeEventListener('pointermove', onPointerMove)
        host.removeEventListener('pointerup', endDrag)
        host.removeEventListener('pointercancel', endDrag)
        host.removeEventListener('wheel', onWheel)
      }

      const resize = () => {
        if (!renderer) {
          return
        }

        dirty = true
        const { clientWidth, clientHeight } = host

        renderer.setSize(clientWidth, clientHeight, false)
        camera.aspect = clientWidth / Math.max(clientHeight, 1)
        camera.updateProjectionMatrix()
      }

      resize()

      appliers.quality = () => {
        if (!renderer) {
          return
        }

        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, qualityCap()))
        resize()
      }

      const observer = new ResizeObserver(resize)

      observer.observe(host)
      cleanupResize = () => observer.disconnect()

      const clock = new Clock()

      const tick = () => {
        if (disposed || !renderer || (rig.frozen && !dirty && performance.now() >= busyUntil)) {
          return
        }

        dirty = false
        director.update(Math.min(clock.getDelta(), 1 / 20))
        busyUntil = stageBusyUntil(busyUntil, performance.now(), director.moving)
        renderer.render(scene, camera)
      }

      // On restore three has already re-created its GL state (its listener
      // runs first) and re-uploads the scene lazily; a resize and a fresh
      // clock are all the stage itself owes before the loop restarts.
      const onContextRestored = () => {
        if (disposed || !renderer) {
          return
        }

        resize()
        clock.getDelta()
      }

      setLoading(false)
      stopLoop = runContextSafeLoop(renderer.domElement, tick, onContextRestored, {
        busy: () => performance.now() < busyUntil
      })
    }

    run().catch((error: unknown) => {
      // A rejected download or a renderer that will not start used to leave
      // "summoning…" on screen forever; the failure panel is for exactly this.
      if (!disposed) {
        onError(error instanceof Error ? error.message : 'The stage could not start.')
      }
    })

    return () => {
      disposed = true
      stopLoop?.()
      cleanupResize?.()
      cleanupInput?.()

      if (renderer) {
        // dispose() alone keeps the context alive until GC; lose it now so
        // the slot is free the moment the stage unmounts.
        renderer.dispose()
        renderer.forceContextLoss()
        renderer.domElement.remove()
        renderer = null
      }

      releaseGpu?.()
      releaseGpu = null
    }
  }, [modelUrl, onBackdrop, onError])

  return (
    <div className="istage" ref={hostRef}>
      {loading && <div className="istage__loading">summoning…</div>}
      <StageDeactivatedLabel />
    </div>
  )
}
