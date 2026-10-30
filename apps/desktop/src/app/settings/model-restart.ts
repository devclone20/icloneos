// The backend refuses the model picker with `503 Restart required: …` when its
// checkout changed under the running process (gateway/code_skew.py). The detail
// is written for a server admin (systemctl, `hermes dashboard --port`); in the
// app the backend is ours to restart, so the page offers that instead.
const RESTART_REQUIRED = /(?:^|\D)503\D[\s\S]*\brestart required\b/i

export function isRestartRequiredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''

  return RESTART_REQUIRED.test(message)
}
