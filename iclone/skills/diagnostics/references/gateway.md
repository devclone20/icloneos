# Pack `gateway` — Gateway and sessions

The Hermes server the app talks to, its port and the sessions database.

| Check | Title | Severity | Fix |
|---|---|---|---|
| `gateway.updates_check` | Runtime update check is off | fail | `gateway.updates_check_off` |
| `gateway.port` | Gateway port owner | fail | `gateway.free_port` |
| `gateway.health` | Gateway health | warn | — |
| `gateway.state_db` | Sessions database integrity | fail | `gateway.restore_state_db` |
| `gateway.wal_orphan` | Sessions journal files | warn | `gateway.quarantine_wal` |

| Fix | Title | Risk | Consent |
|---|---|---|---|
| `gateway.updates_check_off` | Turn the runtime update check off | medium | — |
| `gateway.free_port` | Stop the stale gateway process | medium | — |
| `gateway.restore_state_db` | Restore sessions from the newest backup | high | — |
| `gateway.quarantine_wal` | Move the orphan journal aside | low | — |

**What the failures mean.** `updates_check` fails while `updates.check` is unset in config.yaml: icloneOS ships the runtime, so the runtime must not check upstream itself. `gateway.updates_check_off` (medium) writes it through the runtime CLI after a backup. `port` fails only for a stale gateway of OURS; a foreign program on the port is reported, never stopped.

**Trap.** `restore_state_db` is high risk: it moves the damaged state.db aside and restores the newest pre-update backup — the owner decides.

Run: `acp doctor run gateway --json`.
