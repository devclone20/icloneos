# Pack `permissions` — Permissions and consent

The consent record and macOS privacy grants.

| Check | Title | Severity | Fix |
|---|---|---|---|
| `permissions.consent_file` | Consent record | fail | `permissions.quarantine_consent` |
| `permissions.media` | Microphone and screen access | warn | `permissions.open_privacy` |
| `permissions.accessibility` | Accessibility access | warn | `permissions.reset_accessibility` |

| Fix | Title | Risk | Consent |
|---|---|---|---|
| `permissions.quarantine_consent` | Move the unreadable consent record aside | medium | — |
| `permissions.open_privacy` | Open Privacy & Security | low | — |
| `permissions.reset_accessibility` | Reset the Accessibility permission | high | automation |

**What the failures mean.** `consent_file` fails when consent.json is unreadable → `permissions.quarantine_consent` (medium): the app asks again at the next launch. `media` → `permissions.open_privacy` opens the pane of the denied item (Microphone or Screen Recording). `accessibility` checks CuaDriver's trust (computer use clicks as `com.trycua.driver`, never as icloneOS; skipped when computer use is not set up) → `permissions.reset_accessibility` (high, needs the automation permission) resets CuaDriver's entry.

**Trap.** macOS grants follow the app's signature: a local-signed build loses them on every rebuild.

Run: `acp doctor run permissions --json`.
