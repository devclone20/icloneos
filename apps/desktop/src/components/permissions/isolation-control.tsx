import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { getTerminalBackends, selectTerminalBackend } from '@/hermes'
import type { IsolationSetResultView, IsolationView } from '@/iclone-shared/confinement'
import { cn } from '@/lib/utils'
import { $confinement, $isolationOff, onConfinementChanged, readConfinementOnce } from '@/store/confinement'

/**
 * F41 — the one control and the one warning for isolation (Seatbelt confinement), on main's single state. Containers ›
 * Backends, Settings › Agent › Permissions and Settings › Advanced mount the control; the composer reads the small state
 * ($isolationOff). The window asks and main decides: off takes this click (data-confinement-confirm) and main's native
 * dialog; on takes this click. Nothing here holds the state.
 */
/** The word above the control, wherever it stands. */
export const ISOLATION_TITLE = 'Isolation (the Seatbelt)'

/** The one fact, in one short line: the card's own sentence, and the line on the tabs that read the commands. */
export const OFF_RIGHTS = 'Agent commands run with your full user rights, with no sandbox around them.'

const COMPOSER_WARNING =
  'Isolation is off: commands run with no sandbox. Turn it on in Settings \u203a Agent \u203a Permissions.'

/** What the Advanced list calls the runtime's own names, so "local" says what it means. */
export const TERMINAL_PLACE_LABELS: Record<string, string> = { local: 'This Mac, no sandbox' }

/** The two values that mean nobody asked for another place. */
const NOTHING_ASKED = new Set(['', 'local', 'none', 'iclone_seatbelt'])

const askedElsewhere = (value: unknown): boolean =>
  !NOTHING_ASKED.has(
    String(value ?? '')
      .trim()
      .toLowerCase()
  )

const REFUSED: Record<Extract<IsolationSetResultView, { ok: false }>['reason'], string | null> = {
  busy: 'The last change is still applying.',
  cancelled: null,
  invalid: 'The app did not understand that request, so nothing changed.',
  'no-gesture': 'That did not arrive as your own click, so nothing changed. Click the button again.',
  unsupported: 'Isolation exists on macOS only.'
}

/** One sentence: what changed, and what happened to what was running. */
export function isolationResultLine(result: IsolationSetResultView): null | string {
  if (!result.ok) {
    return REFUSED[result.reason]
  }

  const state = result.on ? 'on' : 'off'

  if (result.restart === 'failed') {
    return `Isolation is ${state}, but the agent did not start again${result.error ? ` (${result.error})` : ''}. Nothing runs under the old state; restart the agent to go on.`
  }

  return result.restart === 'done'
    ? `Isolation is ${state}. The agent restarted ${result.on ? 'inside the sandbox' : 'with no sandbox'}, and what it was doing stopped.`
    : `Isolation is ${state}. It applies the next time the agent starts.`
}

const OFF_LINE = (isolation: IsolationView): string =>
  isolation.persists ? 'It stays off until you turn it on.' : 'It comes back on when you quit the app.'

/** Turning isolation on is one click and has to work: a backend picked while it was off is refused under the sandbox, so
 *  it goes back to the default and the runtime starts again. Reads the runtime's own answer; no answer changes nothing,
 *  and the Advanced row then says what is asked. */
async function dropOtherBackend(): Promise<boolean> {
  const data = await getTerminalBackends()

  if (!askedElsewhere(data.active)) {
    return false
  }

  await selectTerminalBackend('local')
  await window.hermesDesktop?.restartBackend?.()

  return true
}

function Warning({ text }: { text: string }) {
  return (
    <p
      className="border-l-2 border-(--ic-danger) pl-2.5 text-[0.75rem] leading-[1.15rem] font-medium text-(--ic-danger)"
      data-isolation-warning=""
      role="alert"
    >
      {text}
    </p>
  )
}

/** The Containers tabs that read the commands: a state the user chose, so one quiet line, never an alert. */
export function IsolationOffLine() {
  const off = useStore($isolationOff)

  return off ? (
    <p data-isolation-line="" data-isolation-warning="">
      <b>Isolation is off.</b> <span>{OFF_RIGHTS}</span>
    </p>
  ) : null
}

/** The composer's strip: the same fact in one short line, and main's nudge keeps it true while no pane is open. */
export function IsolationComposerNote() {
  const off = useStore($isolationOff)

  useEffect(() => {
    void readConfinementOnce()

    return window.hermesDesktop?.icloneConfinement?.onChanged(onConfinementChanged)
  }, [])

  return off ? <Warning text={COMPOSER_WARNING} /> : null
}

export function IsolationControl() {
  const { state, status } = useStore($confinement)
  const isolation = state?.isolation ?? null
  // The card speaks only for what the last good read verified: a red verdict and this sentence can never stand together.
  const holds = state?.verdict === 'green' && status !== 'error'
  const [line, setLine] = useState<null | string>(null)
  const [applying, setApplying] = useState(false)
  const [restarting, setRestarting] = useState(false)

  if (!isolation?.available) {
    return null
  }

  const toggle = () => {
    // Synchronously inside the click: the preload takes the gesture here.
    const pending = window.hermesDesktop?.icloneConfinement?.setIsolation?.(!isolation.on)

    if (!pending) {
      return
    }

    setApplying(true)
    setLine(null)
    void pending
      .then(async result => {
        setLine(result ? isolationResultLine(result) : null)

        if (result?.ok && result.on && (await dropOtherBackend().catch(() => false))) {
          setLine(
            'Isolation is on. The backend you picked while it was off cannot run inside the sandbox, so it went back to the default and the agent restarted.'
          )
        }
      })
      .catch(() => setLine('The change did not reach the app, so nothing changed.'))
      .finally(() => {
        setApplying(false)
        void readConfinementOnce()
      })
  }

  const restart = () => {
    setRestarting(true)
    void window.hermesDesktop?.restartBackend?.().finally(() => {
      setRestarting(false)
      void readConfinementOnce()
    })
  }

  return (
    <section
      className={cn(
        'grid gap-2.5 rounded-xl border px-3.5 py-3',
        isolation.on ? 'border-(--ui-stroke-secondary)' : 'border-(--ic-danger)/50 bg-(--ic-danger)/5'
      )}
      data-isolation-control={isolation.on ? 'on' : 'off'}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="grid max-w-[64ch] min-w-0 flex-1 gap-0.5">
          <span
            className="text-[0.625rem] font-medium tracking-[0.14em] text-(--ui-text-tertiary) uppercase"
            data-isolation-label=""
          >
            {ISOLATION_TITLE}
          </span>
          <span className="text-[0.9375rem] leading-5 font-medium tracking-tight text-(--ui-text-primary)">
            {!isolation.on
              ? 'Nothing holds your agent\u2019s commands.'
              : holds
                ? 'The kernel holds the agent\u2019s commands in a sandbox, except one you approve.'
                : 'Confinement is not verified.'}
          </span>
          {isolation.on ? (
            <span className="text-[0.75rem] leading-4 text-(--ui-text-tertiary)">
              {holds ? 'Commands write only where their mode allows. ' : ''}Turning this off asks you first and says
              what you lose.
            </span>
          ) : (
            <>
              <span className="text-[0.75rem] leading-4 text-(--ui-text-primary)">{OFF_RIGHTS}</span>
              <span className="text-[0.75rem] leading-4 text-(--ui-text-tertiary)">{OFF_LINE(isolation)}</span>
            </>
          )}
        </div>
        <Button
          data-confinement-confirm=""
          data-isolation-toggle=""
          disabled={applying}
          onClick={toggle}
          size="sm"
          variant={isolation.on ? 'outline' : 'default'}
        >
          {isolation.on ? 'Turn off\u2026' : 'Turn on'}
        </Button>
      </div>
      {isolation.runningDiffers && !applying ? (
        <p className="text-[0.75rem] leading-4 text-(--ic-danger)" data-isolation-running="">
          The agent running now was started with isolation {isolation.on ? 'off' : 'on'}, so this does not hold for it
          until it restarts.{' '}
          <Button disabled={restarting} onClick={restart} size="sm" variant="outline">
            Restart the agent
          </Button>
        </p>
      ) : null}
      {line ? (
        <p className="text-[0.75rem] leading-4 text-(--ui-text-tertiary)" data-isolation-result="" role="status">
          {line}
        </p>
      ) : null}
    </section>
  )
}

/**
 * Settings › Advanced: the one truthful answer to "where do my agent's commands run". On, it is the sandbox and the old
 * list is not offered, because nothing it names would run. Off, the list is the real choice (`field`, the config row).
 * A file that still asks for another place while on is said in words with its one-click way out.
 */
export function WhereCommandsRun({
  field,
  onUseSandbox,
  value
}: {
  field: ReactNode
  onUseSandbox: () => void
  value: unknown
}) {
  const store = useStore($confinement)
  const isolation = store.state?.isolation ?? null

  useEffect(() => {
    void readConfinementOnce()

    return window.hermesDesktop?.icloneConfinement?.onChanged(onConfinementChanged)
  }, [])

  if (store.status === 'loading') {
    return null
  }

  if (!isolation?.available) {
    return <>{field}</>
  }

  return (
    <div className="grid gap-2 py-1.5" data-where-commands-run={isolation.on ? 'sandbox' : 'chosen'}>
      <span className="text-xs font-medium text-(--ui-text-primary)">Where your agent&apos;s commands run</span>
      <IsolationControl />
      {isolation.on ? (
        askedElsewhere(value) ? (
          <p className="text-[0.75rem] leading-4 text-(--ic-danger)" data-where-commands-conflict="">
            Your settings ask for {String(value)}. It cannot run inside the sandbox, so every command is refused until
            this is settled.{' '}
            <Button onClick={onUseSandbox} size="sm" variant="outline">
              Use the sandbox
            </Button>
          </p>
        ) : (
          <p className="text-[0.75rem] leading-4 text-(--ui-text-tertiary)">
            In the Seatbelt sandbox, on this Mac. Docker, SSH and the other places can be picked once isolation is off;
            while it is on they are not used.
          </p>
        )
      ) : (
        field
      )}
    </div>
  )
}
