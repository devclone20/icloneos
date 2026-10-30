import { useStore } from '@nanostores/react'
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'
import { notify } from '@/store/notifications'

import { SetupStep } from '../setup/setup-step'
import {
  $setupReentry,
  allDecided,
  probeSetupAvailability,
  relevantSetupSections,
  sectionsToShow,
  setupBridge,
  setupDecisionsOf
} from '../setup/store'
import type { SetupChoice, SetupSection } from '../setup/types'

import { useConsentCopy } from './copy'
import { ConsentDoorSheet } from './door-sheet'
import { PermissionsStep } from './permissions-step'
import { $consent, applyConsentResult, consentBridge, displayedPermissions, loadConsent } from './store'
import { ConsentStepBadge, TermsStep } from './terms-step'
import type { ConsentPermissionKey, ConsentPermissions, ConsentSnapshot } from './types'

type Step = 'permissions' | 'setup' | 'terms'

const EXIT_MS = 520
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * V3-ON: the Set up sections this run shows, or [] — no probe at all once every section is decided (the common launch
 * pays nothing), and none without the Set up bridge (web build, an older main).
 */
async function setupSectionsFor(snapshot: ConsentSnapshot, reentry: boolean): Promise<SetupSection[]> {
  const decisions = setupDecisionsOf(snapshot.record)
  const relevant = relevantSetupSections()

  if (!setupBridge() || !consentBridge()?.setSetup || (!reentry && allDecided(decisions, relevant))) {
    return []
  }

  // r2 minor 2: bounded (2 s) — a slow or failing check opens the workspace instead of masking it.
  return sectionsToShow(decisions, await probeSetupAvailability(relevant), reentry)
}

function initialPermissions(snapshot: ConsentSnapshot): ConsentPermissions {
  // Keychain always shows the real encryption state (Settings › Gateway is its single source).
  return { ...snapshot.record?.permissions, keychain: snapshot.keychainEncrypted }
}

/**
 * First-launch Terms & Privacy sheet, above the provider onboarding and below the install overlay. Shown only
 * when main says the bundled policy was never accepted (`required`: both steps) or an older version was
 * (`update`: step 1 only, saved switches kept). Nothing on it asks macOS for anything.
 */
function FirstLaunchSheet() {
  const bank = useConsentCopy()
  const { snapshot, status } = useStore($consent)
  const reentry = useStore($setupReentry)
  const [steps, setSteps] = useState<Step[] | null>(null)
  const [setupSections, setSetupSections] = useState<SetupSection[]>([])
  // r2 M2: the last Set up save failed — the step offers Try again and Continue to the app (never a trap).
  const [setupFailed, setSetupFailed] = useState<Partial<Record<SetupSection, SetupChoice>> | null>(null)
  const [index, setIndex] = useState(0)
  const [values, setValues] = useState<ConsentPermissions>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [entered, setEntered] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [done, setDone] = useState(false)
  // The surface is chosen when a re-entry opens the sheet, never read live: finish() clears the re-entry flag on the
  // tick the exit fade starts, so a live read turned the last 520 ms of a Settings re-entry black.
  const [overApp, setOverApp] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void loadConsent()
  }, [])

  useEffect(() => {
    if (steps || !snapshot) {
      return
    }

    let live = true

    const base: Step[] =
      snapshot.state === 'required' ? ['terms', 'permissions'] : snapshot.state === 'update' ? ['terms'] : []

    // V3-ON: the Set up step follows the consent steps (or stands alone for an upgrader who never saw it).
    void setupSectionsFor(snapshot, false).then(sections => {
      if (!live) {
        return
      }

      setSetupSections(sections)
      setSteps(sections.length > 0 ? [...base, 'setup'] : base)
      setValues(initialPermissions(snapshot))
    })

    return () => {
      live = false
    }
  }, [snapshot, steps])

  // "Set up again" (Settings › Machine › Set up): the Set up step once more, every available section.
  useEffect(() => {
    if (!reentry || !snapshot?.record) {
      return
    }

    let live = true

    void setupSectionsFor(snapshot, true).then(sections => {
      if (!live) {
        return
      }

      if (sections.length === 0) {
        $setupReentry.set(false)

        return
      }

      setSetupSections(sections)
      setOverApp(true)
      setSteps(['setup'])
      setIndex(0)
      setLeaving(false)
      setDone(false)
    })

    return () => {
      live = false
    }
    // Only a new request re-opens it; the snapshot it reads is the one at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reentry])

  const step = steps?.[index]

  useEffect(() => {
    if (!step) {
      return
    }

    setEntered(false)
    const frame = requestAnimationFrame(() => setEntered(true))

    // Long content (APG dialog pattern): terms opens on the dialog itself, never on the accept box below the fold of
    // its scroll box, and no focus may scroll the policy's opening lines out of view.
    const target =
      step === 'terms'
        ? dialogRef.current
        : (dialogRef.current?.querySelector<HTMLElement>('[role="switch"]') ??
          dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE))

    target?.focus({ preventScroll: true })

    return () => cancelAnimationFrame(frame)
  }, [step])

  // Escape never dismisses the sheet; it is not a dialog you can wave away.
  useEffect(() => {
    if (!step || leaving) {
      return
    }

    const swallow = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }

    document.addEventListener('keydown', swallow, true)

    return () => document.removeEventListener('keydown', swallow, true)
  }, [leaving, step])

  const finish = useCallback(() => {
    setLeaving(true)
    $setupReentry.set(false)
    window.setTimeout(() => {
      setDone(true)
      setOverApp(false)
    }, EXIT_MS)
  }, [])

  const run = useCallback(
    async (work: () => Promise<string | null>, next: () => void) => {
      setBusy(true)
      setError(null)

      try {
        const failure = await work()

        if (failure) {
          setError(bank.sheet.saveFailed)
        } else {
          next()
        }
      } catch {
        setError(bank.sheet.saveFailed)
      } finally {
        setBusy(false)
      }
    },
    [bank]
  )

  const trapTab = (event: KeyboardEvent<HTMLDivElement>) => {
    const dialog = dialogRef.current

    if (event.key !== 'Tab' || !dialog) {
      return
    }

    const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const [edge, wrapTo] = event.shiftKey ? [items[0], items.at(-1)] : [items.at(-1), items[0]]

    // From the dialog itself (where the terms step opens) either direction enters its controls, never the app behind.
    if (wrapTo && (document.activeElement === edge || document.activeElement === dialog)) {
      event.preventDefault()
      wrapTo.focus()
    }
  }

  if (status === 'unavailable' || done || (status === 'ready' && !snapshot) || steps?.length === 0) {
    return null
  }

  // At launch the sheet (and its loading mask) sits ABOVE the black boot and onboarding screens and is the first
  // screen of a fresh install, so it stands on the boot's own void (pure black, the owner's entry-page rule): the
  // surface fill made the launch black → night → black. A re-entry from a working app keeps the surface to the end.
  const surface = cn(
    'fixed inset-0 z-(--z-consent) flex items-center justify-center p-6 transition-opacity duration-[520ms] ease-out',
    overApp ? 'bg-(--ui-chat-surface-background)' : 'ic-sys-void'
  )

  if (!snapshot || !steps || !step) {
    // Masks the provider onboarding for the one IPC round trip, so it never flashes before the sheet.
    return <div aria-hidden="true" className={surface} data-consent-step="loading" data-glass-opaque="" />
  }

  const bridge = consentBridge()
  const policy = snapshot.bundled

  // V3-ON: one write for the whole step; the sheet leaves the moment main has it (nothing waits on an install or macOS).
  const saveSetup = (sections: Partial<Record<SetupSection, SetupChoice>>) => {
    const save = bridge?.setSetup

    if (!save) {
      // No way to record: the app opens all the same (the step is optional).
      finish()

      return
    }

    setBusy(true)
    setError(null)
    void save({ sections })
      .then(
        result => applyConsentResult(result),
        () => 'failed'
      )
      .then(failure => {
        setBusy(false)

        if (failure) {
          // Nothing was recorded: the sections stay undecided and are offered again only from Settings › Machine.
          setSetupFailed(sections)
        } else {
          finish()
        }
      })
  }

  // The next step, or the end of the sheet.
  const advance = () => (index + 1 < (steps?.length ?? 0) ? setIndex(index + 1) : finish())

  return (
    <div
      className={cn(surface, leaving ? 'pointer-events-none opacity-0' : 'opacity-100')}
      // Masks the whole app until the policy is accepted — must stay filled under window glass.
      data-glass-opaque=""
    >
      <div
        aria-labelledby="consent-title"
        aria-modal="true"
        className={cn(
          'relative w-full max-w-[45rem] overflow-hidden rounded-xl outline-hidden border border-(--stroke-nous) bg-(--ui-chat-bubble-background) shadow-nous transition-all duration-500 ease-out',
          entered && !leaving
            ? 'translate-y-0 scale-100 opacity-100 blur-0'
            : '-translate-y-1 scale-[0.985] opacity-0 blur-[2px]'
        )}
        data-consent-step={step}
        onKeyDown={trapTab}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        {/* FX-5: the step badge is laid out in each step's header row, beside the language switcher (ConsentHeader in
            terms-step.tsx) — on every step, Set up included; never absolutely over the switcher. */}
        <ConsentStepBadge value={steps.length > 1 ? bank.sheet.step(index + 1, steps.length) : null}>
          {step === 'setup' ? (
            <SetupStep
              busy={busy}
              error={error}
              failed={setupFailed ? { onContinue: finish, onRetry: () => saveSetup(setupFailed) } : undefined}
              onDone={choices => saveSetup(choices)}
              onSkipAll={choices => saveSetup(choices)}
              sections={setupSections}
            />
          ) : step === 'terms' ? (
            <TermsStep
              busy={busy}
              error={error}
              onContinue={accepted => {
                if (!accepted || !bridge) {
                  return
                }

                void run(
                  // The one required box includes the AI-provider disclosure, so accepting always records it.
                  async () =>
                    applyConsentResult(await bridge.accept({ aiProvider: true, version: policy.version }), 'ok'),
                  advance
                )
              }}
              policy={policy}
              update={snapshot.state === 'update'}
            />
          ) : (
            <PermissionsStep
              busy={busy}
              error={error}
              onAllowAll={() => {
                // Turns every switch ON on screen only. Nothing is recorded until the user confirms with Continue.
                setValues(displayedPermissions(key => (key === 'keychain' ? snapshot.keychainEncrypted : true)))

                if (!snapshot.keychainEncrypted) {
                  notify({
                    durationMs: 8_000,
                    kind: 'info',
                    message: bank.sheet.allowAllKeychain,
                    title: bank.sheet.allowAllKeychainTitle
                  })
                }
              }}
              onChange={(key: ConsentPermissionKey, on: boolean) => {
                if (key !== 'keychain') {
                  setValues(current => ({ ...current, [key]: on }))
                }
              }}
              onSave={() => {
                if (!bridge) {
                  return
                }

                // Every row as shown: one displayed OFF is saved OFF, Keychain as its real state.
                const permissions = displayedPermissions(key =>
                  key === 'keychain' ? snapshot.keychainEncrypted : values[key] === true
                )

                void run(async () => applyConsentResult(await bridge.setPermissions({ permissions })), advance)
              }}
              onSkip={() =>
                bridge &&
                void run(async () => applyConsentResult(await bridge.setPermissions({ skipped: true })), advance)
              }
              policy={policy}
              values={values}
            />
          )}
        </ConsentStepBadge>
      </div>
    </div>
  )
}

/** The first-launch sheet and, once the policy is accepted, the agent's permission requests (one at a time). */
export function ConsentSheet() {
  return (
    <>
      <FirstLaunchSheet />
      <ConsentDoorSheet />
    </>
  )
}
