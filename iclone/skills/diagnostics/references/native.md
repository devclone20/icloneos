# Pack `native` — App install

The installed app: signature, notarization, location, native modules.

| Check | Title | Severity | Fix |
|---|---|---|---|
| `native.codesign` | Signature and notarization | fail | `native.install_release` |
| `native.location` | Install location | warn | — |
| `native.abi` | Native module ABI | fail | `native.install_release` |
| `native.spawn_helper` | Terminal helper mode | fail | `native.chmod_spawn_helper` |
| `native.rosetta` | Runs natively | warn | — |
| `native.renderer_cache` | Renderer cache size | warn | `native.clear_cache` |

| Fix | Title | Risk | Consent |
|---|---|---|---|
| `native.install_release` | Install the notarized release | low | — |
| `native.chmod_spawn_helper` | Make the terminal helper executable | low | — |
| `native.clear_cache` | Clear the renderer cache | low | — |

**What the failures mean.** `codesign` fails when the installed copy is not the notarized Developer ID release (team HJSLQL98D8), e.g. a local-signed developer build in /Applications. The fix is informational: install the notarized release.

**Trap.** `abi` mismatch = the native terminal module was built for another Electron; only a reinstall fixes it.

Run: `acp doctor run native --json`.
