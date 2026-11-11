/**
 * The AI record button's words, in English. `zh` types every key of its own, so it spreads this block rather than leave
 * a hole; pt-PT has its own words (the parity gate); the other locales fall back through defineLocale.
 */
export const aiRecordCopy = {
  screenRecordIdle: 'AI record: record the screen. Screenshots of what changes go into your next message.',
  screenRecordActive: 'AI record is recording the screen. Click to stop and attach the frames.',
  screenRecordWorking: 'AI record is starting…',
  screenRecordFirstUse:
    'This captures the whole screen, including any secrets on it. The frames go to the model only when you send them.',
  screenRecordConsentOff: 'Screen recording is off in Settings › Privacy.',
  screenRecordOpenPrivacy: 'Open Privacy',
  screenRecordOpenSetup: 'Open Setup',
  screenRecordNoGrant: 'macOS has not allowed icloneOS to record the screen. Allow it from the Setup row.',
  screenRecordRestart:
    'macOS has allowed Screen recording, and applies it only when the app starts again. Restart icloneOS, then record.',
  screenRecordRestricted: 'A profile on this Mac does not allow screen recording.',
  screenRecordBlank:
    'The screen came back blank, so nothing was recorded. Check Screen recording in Setup; macOS may need the app restarted.',
  screenRecordFailed: 'The screen could not be captured, so the recording stopped.',
  screenRecordWaiting: 'Your screen frames are kept. They attach when you open a chat.',
  screenRecordNoImages: (model: string, frames: number) =>
    `${model} takes no images, so it may not see these ${frames} frames. They stay attached; pick a model that takes images before you send.`,
  screenRecordNoModel: (frames: number) =>
    `No model is set up yet, so these ${frames} frames have nowhere to go. They stay attached.`,
} satisfies Record<string, unknown>
