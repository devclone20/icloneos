# Pack `runtime` — Agent runtime

The Python runtime under the agent.

| Check | Title | Severity | Fix |
|---|---|---|---|
| `runtime.venv_python` | Runtime interpreter | fail | `runtime.venv_repair` |
| `runtime.venv_home` | Interpreter home in pyvenv.cfg | fail | `runtime.venv_repair` |
| `runtime.tcc_anchor` | Privacy grants anchor | warn | — |

| Fix | Title | Risk | Consent |
|---|---|---|---|
| `runtime.venv_repair` | Repair the runtime interpreter | medium | — |

**What the failures mean.** `venv_python`/`venv_home` fail after an Xcode or Homebrew update moved the interpreter. `runtime.venv_repair` (medium) re-links it; when the venv is the upstream tree it only advises 'Reinstall the runtime from App Atualisation'.

**Trap.** The runtime's own `hermes doctor` lives in the `network` pack: upstream probes every configured provider
with the owner's keys, so it runs only on a live run the owner starts.

Run: `acp doctor run runtime --json`.
