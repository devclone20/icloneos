import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { $consent, loadConsent } from '@/components/consent/store'
import { useSetupCopy } from '@/components/setup/copy'
import { SetupPackageRows, SetupSystemRows } from '@/components/setup/rows'
import { openSetupAgain, relevantSetupSections, setupDecisionsOf } from '@/components/setup/store'
import type { SetupSection } from '@/components/setup/types'
import { Button } from '@/components/ui/button'
import { codiconIcon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { Package } from '@/lib/icons'

import { ListRow, Pill, SectionHeading, SettingsContent } from './primitives'

const SystemIcon = codiconIcon('shield')
const AgentIcon = codiconIcon('layers')
const HINT = 'mb-2 text-[0.8125rem] text-(--ui-text-tertiary)'

/**
 * V3-ON (ON-3) — Settings › Machine › Set up: every item of the first-launch Set up step, with the SAME rows (packages,
 * system permissions) and a door to the same levels matrix (Agent › Permissions). A section never decided or skipped
 * reads a quiet "Not set up" beside its heading; no badge elsewhere, no toast, nothing that asks on its own.
 */
export function SetupSettings({ navigate }: { navigate: (route: string) => void }) {
  const copy = useSetupCopy()
  const nav = useI18n().t.settings.nav
  const { snapshot } = useStore($consent)

  useEffect(() => {
    void loadConsent()
  }, [])

  const decisions = setupDecisionsOf(snapshot?.record)
  // r2 minor 2: a section that does not exist on this install (Packages before RT-B is wired, System off macOS) is
  // not shown and is never "Not set up".
  const relevant = relevantSetupSections()

  const notSetUp = (section: SetupSection) =>
    decisions[section]?.state === 'done' ? undefined : (
      <span data-setup-not-set-up={section}>
        <Pill>{copy.settings.notSetUp}</Pill>
      </span>
    )

  return (
    <SettingsContent>
      <div className="grid gap-6 pt-2" data-setup-settings="">
        <section>
          <p className={HINT}>{copy.settings.lead}</p>
          <Button
            data-setup-again=""
            disabled={!snapshot?.record}
            onClick={() => {
              triggerHaptic('selection')
              openSetupAgain()
            }}
            size="sm"
            variant="outline"
          >
            {copy.settings.again}
          </Button>
        </section>
        {relevant.packages ? (
          <section data-setup-settings-section="packages">
            <SectionHeading aside={notSetUp('packages')} icon={Package} title={copy.sections.packages.title} />
            <p className={HINT}>{copy.sections.packages.hint}</p>
            <SetupPackageRows />
          </section>
        ) : null}
        {relevant.system ? (
          <section data-setup-settings-section="system">
            <SectionHeading aside={notSetUp('system')} icon={SystemIcon} title={copy.sections.system.title} />
            <p className={HINT}>{copy.sections.system.hint}</p>
            <SetupSystemRows />
          </section>
        ) : null}
        <section data-setup-settings-section="agent">
          <SectionHeading aside={notSetUp('agent')} icon={AgentIcon} title={copy.sections.agent.title} />
          <ListRow
            action={
              <Button
                data-setup-open-permissions=""
                onClick={() => navigate('/settings?tab=permissions')}
                size="sm"
                variant="outline"
              >
                {copy.settings.openPermissions}
              </Button>
            }
            description={copy.settings.agentLine}
            title={nav.permissions}
          />
        </section>
      </div>
    </SettingsContent>
  )
}
