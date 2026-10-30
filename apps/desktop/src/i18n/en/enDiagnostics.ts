export const enDiagnostics = {
  title: 'Diagnostics',
  intro: 'Checks this Mac, the agent runtime and your local data. Everything runs on this device; nothing is sent.',
  runAll: 'Run all',
  running: 'Checking…',
  notRun: 'Not run yet',
  lastRun: (age: string, duration: string) => `Last run ${age} · ${duration}`,
  allClear: (age: string) => `Everything checks out · ${age}`,
  summary: (fail: number, warn: number) =>
    [fail ? `${fail} to fix` : '', warn ? `${warn} to review` : ''].filter(Boolean).join(' · ') ||
    'Everything checks out',
  progress: (pack: string, done: number, total: number) => `Checking ${pack} · ${done} of ${total}`,
  state: { pass: 'OK', warn: 'Review', fail: 'Fix', skip: 'Skipped' } as Record<
    'fail' | 'pass' | 'skip' | 'warn',
    string
  >,
  preview: 'Preview',
  previewTitle: 'What this fix will do',
  previewEmpty: 'Nothing to do — this check already passes.',
  applied: (dir: string | null) => (dir ? `Done. A backup is in ${dir}.` : 'Done.'),
  needsConsent: (key: string) => `This fix needs the ${key} permission. Turn it on in Settings › Privacy first.`,
  openPrivacy: 'Open Privacy',
  needsYou: 'Needs your approval',
  copyReport: 'Copy report',
  copied: 'Copied',
  sendDiagnostics: 'Save diagnostics',
  openLogs: 'Open logs folder',
  live: 'Run live probes',
  liveHint: 'Off by default. When on, the network checks contact the internet once per run.',
  unavailable: 'Diagnostics are available in the desktop app.',
  justNow: 'just now',
  minAgo: (n: number) => `${n} min ago`,
  hoursAgo: (n: number) => `${n} h ago`,
  daysAgo: (n: number) => `${n} d ago`
}
