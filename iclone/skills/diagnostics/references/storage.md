# Pack `storage` — Local data

Local records: iNFT ownership, file modes, disk space, crash reports.

| Check | Title | Severity | Fix |
|---|---|---|---|
| `storage.ownership` | iNFT ownership records | fail | `storage.restore_ownership` |
| `storage.private_modes` | Private file modes | fail | `storage.chmod_private` |
| `storage.disk` | Free disk space | warn | — |
| `storage.crash_dumps` | Crash reports | warn | — |

| Fix | Title | Risk | Consent |
|---|---|---|---|
| `storage.restore_ownership` | Restore ownership records from the mirror | low | — |
| `storage.chmod_private` | Make local records owner-only | low | — |

**What the failures mean.** `ownership` fails on a damaged record; when its mirror is valid `storage.restore_ownership` (low) restores it and keeps the damaged copy as .corrupt-<time>. Without a mirror, tell the owner — never recreate a record.

**Trap.** Disk below 2 GiB warns, below 500 MiB fails: ask the owner what to delete; never delete for them.

Run: `acp doctor run storage --json`.
