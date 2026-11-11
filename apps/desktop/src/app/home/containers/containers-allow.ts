/**
 * "Allow this folder": the owner's click on a narrowed run, the one way the pane lists a folder. The bridge entry goes to
 * `hermes:confinement:allow-folder`; the preload attaches the proof of the click, so call this synchronously inside the
 * click handler of a control carrying data-confinement-confirm. A missing bridge or a refusal reads as not allowed: the
 * pane never says a folder is writable unless main said so.
 */
import type { IcloneConfinementBridge } from '@/store/confinement'

/** Main answers from the standing or project mode, not the session's, so each note says what depends on the mode rather
 *  than what this session will do. `allowed`: standing allows writes. `allowed-asks`: standing is Manual. `allowed-plan`: Plan. */
export type FolderNote = 'allowed' | 'allowed-asks' | 'allowed-plan' | 'failed'
export type FolderNotes = Readonly<Record<string, FolderNote>>

export async function allowFolder(folder: string): Promise<FolderNote> {
  try {
    const bridge = window.hermesDesktop?.icloneConfinement as IcloneConfinementBridge | undefined
    const result = await bridge?.allowFolder?.(folder)

    if (result?.ok !== true) {
      return 'failed'
    }

    // Main's word on the next step. Without one the row must not promise a write: the mode may still ask.
    return result.next === 'writes' ? 'allowed' : result.next === 'plan' ? 'allowed-plan' : 'allowed-asks'
  } catch {
    return 'failed'
  }
}
