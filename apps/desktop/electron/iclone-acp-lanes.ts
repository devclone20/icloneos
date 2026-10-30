/**
 * iclone os — the per-iNFT CLI lanes: which `acp` call may run beside which.
 *
 * A write (and any command not known to be read-only) runs alone: parallel
 * CLI processes that change one config dir corrupt it. Reads share the lane,
 * at most `maxReads` at a time. Background reads (main's own probes) have
 * their own `maxBackground` slots and never take a read slot, so an owner's
 * read never waits behind a probe. A waiting exclusive call stops new reads
 * and probes from starting (a stream of reads never starves a write); calls
 * queued ahead of it still run first. Pure — no Electron, no CLI.
 */

/** `read`: renderer-requested, read-only. `background`: main's own read-only
 *  probes. `exclusive`: a write, or a command not proven read-only. */
export type AcpCallClass = 'background' | 'exclusive' | 'read'

interface AcpLanes {
  run<T>(slug: string, cls: AcpCallClass, task: () => Promise<T>): Promise<T>
  /** Calls running or queued for one iNFT. */
  size(slug: string): number
}

interface Waiter {
  cls: AcpCallClass
  start: () => void
}

interface Lane {
  read: number
  background: number
  exclusive: number
  queue: Waiter[]
}

const MAX_READS = 2
const MAX_BACKGROUND = 1
const QUEUE_CAP = 32

const running = (lane: Lane): number => lane.read + lane.background + lane.exclusive

export function createAcpLanes({
  maxReads = MAX_READS,
  maxBackground = MAX_BACKGROUND,
  cap = QUEUE_CAP
} = {}): AcpLanes {
  const lanes = new Map<string, Lane>()
  const limit: Record<AcpCallClass, number> = { background: maxBackground, exclusive: 1, read: maxReads }

  const nextIndex = (lane: Lane): number => {
    if (lane.exclusive > 0) {
      return -1
    }

    const barrier = lane.queue.findIndex(waiter => waiter.cls === 'exclusive')

    if (barrier === 0) {
      return running(lane) === 0 ? 0 : -1
    }

    const ahead = barrier < 0 ? lane.queue : lane.queue.slice(0, barrier)

    return ahead.findIndex(waiter => lane[waiter.cls] < limit[waiter.cls])
  }

  const pump = (slug: string, lane: Lane): void => {
    for (let index = nextIndex(lane); index >= 0; index = nextIndex(lane)) {
      const [waiter] = lane.queue.splice(index, 1)

      waiter.start()
    }

    if (running(lane) === 0 && lane.queue.length === 0 && lanes.get(slug) === lane) {
      lanes.delete(slug)
    }
  }

  const sizeOf = (lane: Lane | undefined): number => (lane ? running(lane) + lane.queue.length : 0)

  return {
    run<T>(slug: string, cls: AcpCallClass, task: () => Promise<T>): Promise<T> {
      let lane = lanes.get(slug)

      if (!lane) {
        lane = { read: 0, background: 0, exclusive: 0, queue: [] }
        lanes.set(slug, lane)
      }

      const owner = lane

      if (sizeOf(owner) >= cap) {
        return Promise.reject(new Error('too many CLI calls queued for this iNFT'))
      }

      return new Promise<T>((resolve, reject) => {
        const start = () => {
          owner[cls] += 1

          void Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              owner[cls] -= 1
              pump(slug, owner)
            })
        }

        owner.queue.push({ cls, start })
        pump(slug, owner)
      })
    },
    size: slug => sizeOf(lanes.get(slug))
  }
}
