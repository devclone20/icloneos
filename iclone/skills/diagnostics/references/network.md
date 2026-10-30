# Pack `network` — Network (live probes)

Live probes: online state, DNS, clock offset, connection quality, and the runtime's own `hermes doctor`
(it calls every configured provider with the owner's keys).

| Check | Title | Severity | Fix |
|---|---|---|---|
| `network.online` | Online | warn | — |
| `network.dns` | Name resolution | warn | — |
| `network.time` | Clock offset | warn | — |
| `network.quality` | Connection quality | warn | — |
| `network.hermes_doctor` | Hermes self-check (contacts your providers) | warn | — |

| Fix | Title | Risk | Consent |
|---|---|---|---|
| — | no automatic fix | | |

**What the failures mean.** Skipped unless the owner turned live probes on. A clock off by more than 30 s breaks sign-in and ACP signatures.

**Trap.** Each live run contacts the internet once; do not repeat it. `hermes_doctor` rows are advice, not an
outage; never run `hermes doctor --fix` or `--live` yourself.

Run: `acp doctor run network --json`.
