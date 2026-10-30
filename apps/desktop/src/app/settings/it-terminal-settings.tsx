/**
 * iT Terminal — settings pane: how iT connects to this computer, its default
 * working directory, and the agent's own terminal (bash) tool status.
 */
import { useState } from 'react'

import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'

import { SettingRow } from './setting-row'

const CWD_KEY = 'iclone.it.cwd'

function readCwd(): string {
  try {
    return window.localStorage.getItem(CWD_KEY) ?? ''
  } catch {
    return ''
  }
}

export function ItTerminalSettings() {
  const { t } = useI18n()
  const copy = t.settings.itTerminal
  const [cwd, setCwd] = useState(readCwd)

  const saveCwd = (value: string) => {
    setCwd(value)

    try {
      if (value.trim()) {
        window.localStorage.setItem(CWD_KEY, value.trim())
      } else {
        window.localStorage.removeItem(CWD_KEY)
      }
    } catch {
      // Preference only.
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <SettingRow hint={copy.connectsHint} title={copy.connectsTitle} />
      <SettingRow hint={copy.usingHint} title={copy.usingTitle} />
      <SettingRow
        control={
          <Input
            aria-label={copy.cwdTitle}
            onChange={event => saveCwd(event.target.value)}
            placeholder="~"
            spellCheck={false}
            value={cwd}
          />
        }
        field
        hint={copy.cwdHint}
        title={copy.cwdTitle}
      />
      <SettingRow hint={copy.commandHint} title={copy.commandTitle} />
      <SettingRow hint={copy.agentHint} title={copy.agentTitle} />
    </div>
  )
}
