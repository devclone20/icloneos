/**
 * The text that travels with a recording's frames. Main writes it when a recording ends, and the renderer writes it again
 * when the user takes a frame off the message, so the words always match the frames the model gets.
 */
export const SCREEN_RECORD_MAX_MS = 5 * 60_000

const seconds = (ms: number) => Math.round(ms / 1000)

/** Only what is known: when each frame was taken, never what it shows. */
export function screenTimeline(result: {
  blankDropped: number
  durationMs: number
  frames: readonly { tMs: number }[]
  hitTimeLimit: boolean
  removedFrames?: number
  thinnedFrom: number
}): string {
  const { frames, removedFrames = 0 } = result
  const kept = frames.length + removedFrames
  const times = frames.map((frame, index) => `${index + 1} t+${seconds(frame.tMs)} s`).join(', ')

  const lines = [
    `Screen recording, ${seconds(result.durationMs)} s of the whole screen, ${frames.length} ${frames.length === 1 ? 'frame' : 'frames'} attached in this order, each taken when the screen changed. Frame times: ${times}.`
  ]

  if (result.thinnedFrom > kept) {
    lines.push(
      `The screen changed ${result.thinnedFrom} times; ${kept} ${kept === 1 ? 'frame was' : 'frames were'} kept across the whole span.`
    )
  }

  if (removedFrames > 0) {
    lines.push(`${removedFrames} ${removedFrames === 1 ? 'frame was' : 'frames were'} taken off by the user.`)
  }

  if (result.hitTimeLimit) {
    lines.push(`It stopped at the ${seconds(SCREEN_RECORD_MAX_MS) / 60} minute limit.`)
  }

  if (result.blankDropped > 0) {
    lines.push(`${result.blankDropped} blank ${result.blankDropped === 1 ? 'capture was' : 'captures were'} left out.`)
  }

  return lines.join(' ')
}
