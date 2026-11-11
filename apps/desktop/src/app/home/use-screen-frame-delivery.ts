/**
 * A finished recording reaches the composer through the path every other image takes (`attachImagePath`), so the chips,
 * the removal and the send are the ones the user already knows. Nothing leaves the Mac here: the frames sit in the
 * message until the user sends it. With no chat open they wait in main, with one line saying so.
 */
import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { getGlobalModelInfo } from '@/api/models'
import { notify } from '@/store/notifications'
import { $screenRecord, screenRecordBridge, timelineDelivered, wireScreenRecord } from '@/store/screen-record'

import { sayRefusal } from './screen-record-tool'
import { $toolsCopy } from './tools-copy'

/** Whether the current model takes images. Only a firm no says so: an unreadable answer stays silent. */
async function warnWhenNoImages(frames: number) {
  const copy = $toolsCopy.get()

  try {
    const info = await getGlobalModelInfo()

    if (!info.model) {
      notify({ id: 'screen-record-model', kind: 'warning', message: copy.screenRecordNoModel(frames) })
    } else if (info.capabilities?.supports_vision === false) {
      notify({ id: 'screen-record-model', kind: 'warning', message: copy.screenRecordNoImages(info.model, frames) })
    }
  } catch {
    // The runtime is not up: it can say so when the message is sent.
  }
}

/** One delivery at a time: the state can repeat `pending` while the frames are on their way. */
let delivering = false

export function useScreenFrameDelivery({
  addText,
  attachImagePath,
  chatOpen,
  enabled
}: {
  addText: (text: string) => void
  attachImagePath: (file: string) => Promise<boolean>
  chatOpen: boolean
  enabled: boolean
}) {
  const status = useStore($screenRecord)

  useEffect(() => {
    if (enabled) {
      wireScreenRecord()
    }
  }, [enabled])

  // A recording that ended by itself with nothing: the reason, not silence.
  useEffect(() => {
    if (!enabled) {
      return
    }

    let last = $screenRecord.get().ended

    return $screenRecord.listen(next => {
      if (next.ended && next.ended !== last) {
        sayRefusal(next.ended)
      }

      last = next.ended
    })
  }, [enabled])

  useEffect(() => {
    if (!enabled || !status.pending) {
      return
    }

    if (!chatOpen) {
      notify({ id: 'screen-record-waiting', kind: 'info', message: $toolsCopy.get().screenRecordWaiting })

      return
    }

    if (delivering) {
      return
    }

    delivering = true

    void (async () => {
      try {
        const result = await screenRecordBridge()?.take()

        if (!result) {
          return
        }

        // Known and in the message before the first chip exists: a chip taken off while the rest attach rewrites this text.
        timelineDelivered(result)
        addText(result.timeline)

        for (const frame of result.frames) {
          await attachImagePath(frame.path)
        }

        void warnWhenNoImages(result.frames.length)
      } finally {
        delivering = false
      }
    })()
  }, [addText, attachImagePath, chatOpen, enabled, status.pending])
}
