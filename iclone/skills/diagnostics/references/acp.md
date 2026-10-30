# Pack `acp` — Agent commerce (ACP)

The `acp` command, the iNFT registry and the private key files.

| Check | Title | Severity | Fix |
|---|---|---|---|
| `acp.wrapper` | acp command | fail | `acp.rewrite_wrapper` |
| `acp.registry` | iNFT registry | fail | `acp.rerender_registry` |
| `acp.private_files` | Private key and registry modes | fail | `acp.chmod_private` |

| Fix | Title | Risk | Consent |
|---|---|---|---|
| `acp.rewrite_wrapper` | Reinstall the acp command | low | — |
| `acp.rerender_registry` | Rebuild the iNFT registry | low | — |
| `acp.chmod_private` | Make private files owner-only | low | — |

**What the failures mean.** `wrapper` fails when ~/.iclone-os/bin/acp is stale or not 0755 → `acp.rewrite_wrapper` (low). `registry` fails when inft.tsv and the per-iNFT setups disagree → `acp.rerender_registry` (low). `private_files` → `acp.chmod_private` (low).

**Trap.** If `acp` itself cannot reach the app, restart icloneOS first — the door needs the app running.

Run: `acp doctor run acp --json`.
