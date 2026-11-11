import { describe, expect, it } from 'vitest'

import {
  createScreenRecorder,
  FRAME_CHANGED_FRACTION,
  frameChange,
  isBlankFrame,
  leastImportantFrame,
  SCREEN_RECORD_MAX_FRAMES,
  SCREEN_RECORD_MAX_MS,
  SCREEN_RECORD_TICK_MS,
  type ScreenCapture,
  type ScreenGrant,
  type ScreenRecordStatus,
  screenTimeline
} from './screen-record'

const W = 64
const H = 40

/** A screen: a dark ground with a menu bar, and `dirty` pixels lit from the top left. */
function shot(dirty = 0, shade = 200): ScreenCapture {
  const bytes = new Uint8Array(W * H * 4).fill(20)

  for (let i = 0; i < W * 4; i += 1) {
    bytes[i] = 120
  }

  for (let i = 0; i < dirty; i += 1) {
    const at = (W * 2 + i) * 4

    bytes[at] = shade
    bytes[at + 1] = shade
    bytes[at + 2] = shade
  }

  return { fingerprint: { bytes, height: H, width: W }, png: () => Buffer.from(`png${dirty}.${shade}`) }
}

const black = (): ScreenCapture => ({
  fingerprint: { bytes: new Uint8Array(W * H * 4), height: H, width: W },
  png: () => Buffer.from('black')
})

function rig(options: { consent?: boolean; grant?: ScreenGrant; next?: () => null | ScreenCapture | Promise<ScreenCapture> } = {}) {
  const box = {
    clock: 1_000_000,
    consent: options.consent ?? true,
    grant: options.grant ?? ('granted' as ScreenGrant),
    next: options.next ?? (() => shot()),
    files: new Set<string>(),
    folders: new Set<string>(),
    removedFolders: [] as string[],
    timers: new Map<number, () => void>(),
    seq: 0,
    changes: [] as ScreenRecordStatus[],
    captures: 0
  }

  const recorder = createScreenRecorder({
    capture: async () => {
      box.captures += 1

      return box.next()
    },
    makeFolder: async () => {
      const folder = `/frames/rec${box.folders.size + 1}`

      box.folders.add(folder)

      return folder
    },
    now: () => box.clock,
    onChange: status => box.changes.push(status),
    removeFile: async file => {
      box.files.delete(file)
    },
    removeFolder: folder => {
      box.folders.delete(folder)
      box.removedFolders.push(folder)

      for (const file of [...box.files]) {
        if (file.startsWith(`${folder}/`)) {
          box.files.delete(file)
        }
      }
    },
    screenConsent: () => box.consent,
    screenGrant: async () => box.grant,
    schedule: (run, ms) => {
      expect(ms).toBe(SCREEN_RECORD_TICK_MS)
      box.seq += 1
      box.timers.set(box.seq, run)

      return box.seq
    },
    cancel: handle => {
      box.timers.delete(handle as number)
    },
    writeFrame: async (folder, tMs) => {
      const file = `${folder}/t${tMs}.png`

      box.files.add(file)

      return file
    }
  })

  /** Advance one tick and let its capture land. */
  const tick = async (ms = SCREEN_RECORD_TICK_MS) => {
    box.clock += ms
    const timers = [...box.timers.entries()]

    box.timers.clear()

    for (const [, run] of timers) {
      run()
    }

    for (let i = 0; i < 12; i += 1) {
      await Promise.resolve()
    }
  }

  return { box, recorder, tick }
}

describe('frame dedupe', () => {
  it('a screen that did not change adds no frame; one that changed does', async () => {
    const { box, recorder, tick } = rig()

    expect((await recorder.start()).ok).toBe(true)
    await tick()
    await tick()
    expect(recorder.status().framesKept).toBe(1)
    box.next = () => shot(40)
    await tick()
    expect(recorder.status().framesKept).toBe(2)
    await tick()
    expect(recorder.status().framesKept).toBe(2)
    const result = await recorder.stop()

    expect(result?.frames.map(f => f.tMs)).toEqual([0, 3000])
  })

  it('counts a change by pixels that moved, not by compositor noise', () => {
    const a = shot().fingerprint
    const noise = { ...a, bytes: Uint8Array.from(a.bytes, v => v + 3) }

    expect(frameChange(a, noise)).toBe(0)
    expect(frameChange(a, shot(40).fingerprint)).toBeGreaterThan(FRAME_CHANGED_FRACTION)
    expect(frameChange(a, { bytes: new Uint8Array(4), height: 1, width: 1 })).toBe(1)
  })
})

describe('caps', () => {
  it('holds the frame cap, and the kept frames cover the whole span, not only the start', async () => {
    let n = 0

    const { box, recorder, tick } = rig({
      next: () => {
        n += 1

        return shot(40 + (n % 2) * 40, n % 2 ? 200 : 90)
      }
    })

    await recorder.start()

    for (let i = 0; i < 200; i += 1) {
      await tick()
    }

    expect(recorder.status().framesKept).toBe(SCREEN_RECORD_MAX_FRAMES)
    expect(box.files.size).toBe(SCREEN_RECORD_MAX_FRAMES)
    const result = await recorder.stop()
    const times = result!.frames.map(f => f.tMs)

    expect(times[0]).toBe(0)
    expect(times.at(-1)).toBe(200_000)
    expect(Math.max(...times.slice(1).map((t, i) => t - times[i]))).toBeLessThan(30_000)
    expect(result!.timeline).toContain(`${SCREEN_RECORD_MAX_FRAMES} frames were kept across the whole span`)
  })

  it('gives up the frame that says least, never the first or last, and keeps a large change', () => {
    const frames = [
      { change: 1, path: 'a', tMs: 0 },
      { change: 0.9, path: 'b', tMs: 1000 },
      { change: 0.001, path: 'c', tMs: 2000 },
      { change: 0.01, path: 'd', tMs: 3000 }
    ]

    expect(leastImportantFrame(frames)).toBe(2)
    expect(leastImportantFrame(frames.slice(0, 2))).toBe(-1)
  })

  it('stops by itself at the length limit, ready to attach, with nothing left running', async () => {
    let n = 0
    const { box, recorder, tick } = rig({ next: () => shot(40 + (++n % 3) * 30) })

    await recorder.start()
    await tick(SCREEN_RECORD_MAX_MS)
    expect(recorder.status().recording).toBe(false)
    expect(box.timers.size).toBe(0)
    expect(recorder.status().pending).toBe(true)
    expect(recorder.takeResult()?.timeline).toContain('5 minute limit')
  })
})

describe('stop on quit and window close', () => {
  it('quit cancels the timer and removes a recording no one has seen', async () => {
    const { box, recorder, tick } = rig()

    await recorder.start()
    await tick()
    recorder.shutdown()
    expect(box.timers.size).toBe(0)
    expect(box.files.size).toBe(0)
    expect(box.folders.size).toBe(0)
    expect(recorder.status().recording).toBe(false)
    expect((await recorder.start()).ok).toBe(false)
  })

  it('quit removes frames that were finished but never taken, and leaves taken ones alone', async () => {
    const one = rig()

    await one.recorder.start()
    await one.recorder.stop()
    one.recorder.shutdown()
    expect(one.box.files.size).toBe(0)

    const two = rig()

    await two.recorder.start()
    await two.recorder.stop()
    two.recorder.takeResult()
    two.recorder.shutdown()
    expect(two.box.files.size).toBe(1)
  })

  it('a stop during a capture waits for it, and no timer or file comes after', async () => {
    let release: (c: ScreenCapture) => void = () => undefined
    const { box, recorder, tick } = rig()

    await recorder.start()
    box.next = () => new Promise<ScreenCapture>(resolve => (release = resolve))
    await tick()
    const stopping = recorder.stop()

    release(shot(40))
    const result = await stopping

    expect(result?.frames.length).toBe(2)
    expect(box.timers.size).toBe(0)
    await tick()
    expect(box.files.size).toBe(2)
  })

  it('two clicks on start make one recording', async () => {
    const { box, recorder } = rig()

    await recorder.start()
    await recorder.start()
    expect(box.folders.size).toBe(1)
    expect(box.timers.size).toBe(1)
  })
})

describe('consent off', () => {
  it('refuses before any capture, and the reason names the switch', async () => {
    const { box, recorder } = rig({ consent: false })

    expect(await recorder.start()).toEqual({ ok: false, reason: 'consent' })
    expect(box.captures).toBe(0)
    expect(box.folders.size).toBe(0)
  })

  it('switching it off while recording ends the recording at the next tick', async () => {
    const { box, recorder, tick } = rig()

    await recorder.start()
    box.consent = false
    const before = box.captures

    await tick()
    expect(recorder.status().recording).toBe(false)
    expect(box.captures).toBe(before)
    expect(box.timers.size).toBe(0)
  })
})

describe('grant missing', () => {
  it.each(['needs-grant', 'needs-restart', 'restricted'] as const)('%s refuses before any capture', async grant => {
    const { box, recorder } = rig({ grant })

    expect(await recorder.start()).toEqual({ ok: false, reason: grant })
    expect(box.captures).toBe(0)
  })
})

describe('blank frames', () => {
  it('a black first frame is said, never passed off as a recording', async () => {
    const { box, recorder } = rig({ next: black })

    expect(await recorder.start()).toEqual({ ok: false, reason: 'blank' })
    expect(box.folders.size).toBe(0)
    expect(box.files.size).toBe(0)
  })

  it('no frame at all from the capturer is blank too', async () => {
    const { recorder } = rig({ next: () => null })

    expect(await recorder.start()).toEqual({ ok: false, reason: 'blank' })
  })

  it('knows blank: one colour or nothing, not a real screen', () => {
    expect(isBlankFrame(black().fingerprint)).toBe(true)
    expect(isBlankFrame({ bytes: new Uint8Array(0), height: 0, width: 0 })).toBe(true)
    expect(isBlankFrame({ bytes: new Uint8Array(W * H * 4).fill(255), height: H, width: W })).toBe(true)
    expect(isBlankFrame(shot().fingerprint)).toBe(false)
  })

  it('a blank capture mid-way is left out and counted in the timeline', async () => {
    const { box, recorder, tick } = rig()

    await recorder.start()
    box.next = black
    await tick()
    box.next = () => shot(40)
    await tick()
    const result = await recorder.stop()

    expect(result?.frames.map(f => f.tMs)).toEqual([0, 2000])
    expect(result?.blankDropped).toBe(1)
    expect(result?.timeline).toContain('1 blank capture was left out')
  })

  it('captures that keep failing end the recording with the reason, not silently', async () => {
    const { box, recorder, tick } = rig()

    await recorder.start()

    box.next = () => {
      throw new Error('gone')
    }

    await tick()
    await tick()
    expect(recorder.status().recording).toBe(true)
    await tick()
    expect(recorder.status().recording).toBe(false)
    expect(box.timers.size).toBe(0)
  })
})

describe('attachments and timeline', () => {
  it('hands the frames over once, in order, each with its time', async () => {
    const { box, recorder, tick } = rig()

    await recorder.start()
    box.next = () => shot(40)
    await tick(3000)
    await recorder.stop()
    expect(recorder.status().pending).toBe(true)
    const result = recorder.takeResult()

    expect(result?.frames).toEqual([
      { path: '/frames/rec1/t0.png', tMs: 0 },
      { path: '/frames/rec1/t3000.png', tMs: 3000 }
    ])
    expect(recorder.takeResult()).toBeNull()
    expect(recorder.status().pending).toBe(false)
  })

  it('says only frame times, never what a frame shows', () => {
    const text = screenTimeline({
      blankDropped: 0,
      durationMs: 12_400,
      frames: [{ tMs: 0 }, { tMs: 3100 }, { tMs: 11_900 }],
      hitTimeLimit: false,
      thinnedFrom: 3
    })

    expect(text).toBe(
      'Screen recording, 12 s of the whole screen, 3 frames attached in this order, each taken when the screen changed. Frame times: 1 t+0 s, 2 t+3 s, 3 t+12 s.'
    )
  })

  it('removes a frame the user took off the message, and nothing outside its folder', async () => {
    const { box, recorder } = rig()

    await recorder.start()
    await recorder.stop()
    const ours = (file: string) => file.startsWith('/frames/')

    box.files.add('/etc/passwd')
    await recorder.discardFrame('/etc/passwd', ours)
    expect(box.files.has('/etc/passwd')).toBe(true)
    await recorder.discardFrame('/frames/rec1/t0.png', ours)
    expect(box.files.has('/frames/rec1/t0.png')).toBe(false)
  })

  it('a new recording while frames wait does not lose track of the state', async () => {
    const { box, recorder } = rig()

    await recorder.start()
    await recorder.stop()
    const started = await recorder.start()

    expect(started.ok).toBe(true)
    expect(box.changes.at(-1)?.recording).toBe(true)
  })
})
