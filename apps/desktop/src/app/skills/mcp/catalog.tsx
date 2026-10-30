/**
 * MCP — the curated catalog view (E3 decision #8). Lifted out of
 * `mcp-tab.tsx`; the install lane is unchanged, the chrome is ours.
 */
import { useState } from 'react'

import { getActionStatus, installMcpCatalogEntry, type McpCatalogEntry, type ProfileScope } from '@/hermes'
import { useI18n } from '@/i18n'
import { sleep } from '@/iclone-shared/async'
import { notify, notifyError } from '@/store/notifications'

import { IcPageButton, IcPagePill, IcPageState } from '../../profiles/ic-page'
import { prettyName } from '../../settings/helpers'

import { McpAvatar } from './row'

// Cadence for polling a background (git-bootstrap) catalog install to completion.
const CATALOG_INSTALL_POLL_MS = 1500

// Small attribute chip (transport / auth / needs-build) — the page's own chip,
// matching the catalog's flat row treatment.
function CatalogTag({ children }: { children: string }) {
  return <span className="icsk__chip">{children}</span>
}

// The Nous-approved MCP catalog: one-click installs of curated servers, with an
// inline prompt for any required credentials (never shows stored values). On
// install the parent refetches config + catalog and reloads live sessions.
export function McpCatalog({
  entries,
  loading,
  onInstalled,
  profile
}: {
  entries: McpCatalogEntry[]
  loading: boolean
  onInstalled: () => void
  profile?: ProfileScope
}) {
  const { t } = useI18n()
  const m = t.settings.mcp
  const [installing, setInstalling] = useState<null | string>(null)
  const [envDrafts, setEnvDrafts] = useState<Record<string, Record<string, string>>>({})
  const [envOpenFor, setEnvOpenFor] = useState<null | string>(null)

  const install = async (entry: McpCatalogEntry) => {
    const required = entry.required_env.filter(env => env.required)
    const draft = envDrafts[entry.name] ?? {}

    // Reveal the credential prompt first; only error once it's shown and unfilled.
    if (required.some(env => !draft[env.name]?.trim())) {
      if (envOpenFor !== entry.name) {
        setEnvOpenFor(entry.name)

        return
      }

      notify({ kind: 'error', title: m.catalogEnvPrompt(entry.name), message: m.catalogEnvRequired })

      return
    }

    setInstalling(entry.name)

    try {
      const res = await installMcpCatalogEntry(entry.name, draft, profile ?? undefined)

      // Git-backed entries clone in the background — keep the row busy and poll
      // the action to completion before refetching / re-enabling, so a re-click
      // can't spawn a second install over the first's tracked process. A non-zero
      // exit is a real failure — surface it instead of a false success.
      if (res.background && res.action) {
        for (;;) {
          const status = await getActionStatus(res.action, 1, profile ?? undefined)

          if (!status.running) {
            if (status.exit_code !== 0) {
              throw new Error(m.catalogInstallFailed(entry.name))
            }

            break
          }

          await sleep(CATALOG_INSTALL_POLL_MS)
        }
      }

      notify({ kind: 'success', title: m.catalogInstallStarted(entry.name), message: '' })
      setEnvOpenFor(null)
      onInstalled()
    } catch (err) {
      notifyError(err, m.catalogInstallFailed(entry.name))
    } finally {
      setInstalling(null)
    }
  }

  if (loading) {
    return <IcPageState kind="loading" title={m.catalogLoading} />
  }

  if (entries.length === 0) {
    return <IcPageState description={m.catalogEmpty} kind="empty" title={m.tabCatalog} />
  }

  return (
    <div className="flex flex-col">
      {entries.map(entry => {
        const draft = envDrafts[entry.name] ?? {}

        return (
          <div className="rounded-md px-2 py-2" key={entry.name}>
            <div className="flex items-start gap-2">
              {/* 2px nudge so the start-aligned avatar sits where McpRow's
                  center-aligned one does — no jump when flipping Servers⇄Catalog. */}
              <McpAvatar
                className="mt-0.5"
                name={entry.name}
                status={entry.installed ? (entry.enabled ? 'ok' : 'off') : 'unknown'}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="icsk__srv-name truncate">{prettyName(entry.name)}</span>
                  <CatalogTag>{entry.transport}</CatalogTag>
                  {entry.auth_type === 'oauth' && <CatalogTag>OAuth</CatalogTag>}
                  {entry.auth_type === 'api_key' && <CatalogTag>API key</CatalogTag>}
                  {entry.needs_install && !entry.installed && <CatalogTag>{m.catalogNeedsInstall}</CatalogTag>}
                  {entry.installed && (
                    <IcPagePill tone="good">{entry.enabled ? m.catalogEnabled : m.catalogInstalled}</IcPagePill>
                  )}
                </div>
                <p className="icsk__cat-desc mt-0.5 line-clamp-2">{entry.description}</p>
                {envOpenFor === entry.name && entry.required_env.length > 0 && (
                  <div className="mt-2 grid gap-2">
                    {entry.required_env.map(env => (
                      <label className="grid gap-1" key={env.name}>
                        <span className="icsk__envlabel">
                          {env.prompt || env.name}
                          {env.required ? ' *' : ''}
                        </span>
                        <input
                          className="icsk__field"
                          onChange={event =>
                            setEnvDrafts(prev => ({
                              ...prev,
                              [entry.name]: { ...prev[entry.name], [env.name]: event.currentTarget.value }
                            }))
                          }
                          type="password"
                          value={draft[env.name] ?? ''}
                        />
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <div className="icsk__cat-action">
                <IcPageButton
                  disabled={entry.installed || installing !== null}
                  onClick={() => void install(entry)}
                  tone="quiet"
                >
                  {installing === entry.name
                    ? m.catalogInstalling
                    : entry.installed
                      ? m.catalogInstalled
                      : m.catalogInstall}
                </IcPageButton>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
