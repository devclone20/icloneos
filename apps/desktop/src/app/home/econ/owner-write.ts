/**
 * F1-S (v0.0.9) — the window's ACP writes that only the owner's own click may send: the ERC-8004 registration
 * (`agent register-erc8004`, signs a transaction) and the Market catalogue writes (`offering create|update|delete`,
 * `resource create`). Main refuses them on `iclone:acp-run` unless this ran first, synchronously inside the click
 * handler of the write's marked control (`data-acp-register-confirm` / `data-acp-market-confirm`), for the SAME argv
 * (electron/gesture-locks-acp.ts). A script's call, a synthetic `el.click()` or the agent driving the page earns no
 * admission, and main audits the refusal.
 */

export type OwnerWriteConfirm = { ok: true } | { ok: false; error: string }

/** Call before any await in the click handler; then run exactly `argv` for `inftId`. */
export function confirmOwnerWrite(inftId: string, argv: string[]): Promise<OwnerWriteConfirm> {
  const confirm = typeof window === 'undefined' ? undefined : window.hermesDesktop?.icloneAcp?.ownerConfirm

  if (!confirm) {
    return Promise.resolve({ ok: false, error: 'unavailable' })
  }

  try {
    return confirm(inftId, argv).then(
      (answer): OwnerWriteConfirm =>
        answer?.ok === true ? { ok: true } : { ok: false, error: answer?.error ?? 'refused' },
      (): OwnerWriteConfirm => ({ ok: false, error: 'transport' })
    )
  } catch {
    return Promise.resolve({ ok: false, error: 'transport' })
  }
}
