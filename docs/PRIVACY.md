# Privacy

iclone os runs your agent on your own Mac. This page says what the app keeps on the Mac, and what leaves it,
when and why. It describes the app's behaviour; the binding policy is the one the app shows on first launch
(*Before you begin*), also at [cloneframe.io/privacy](https://cloneframe.io/privacy).

## No telemetry

The desktop app contains no analytics, usage tracking or crash-report upload. Crash details are written to a
local log only. The bundled agent runtime's third-party telemetry is off, and there is no switch that turns it on:
before the runtime starts, and for every process it starts afterwards, the app writes each vendor's own opt-out into
the environment and removes the collectors' addresses from it. Those values overwrite whatever was there, so setting
one of them yourself does not switch telemetry back on.

## What stays on your Mac

| Where | What |
|---|---|
| `~/.hermes/` | The agent: its settings (`config.yaml`), your API keys (`.env`), conversations and history, memory, skills, logs (`logs/`), and the runtime itself |
| `~/Library/Application Support/iclone os/` | The app: your consent and permission choices, the permission log, payment settings and mandates, ACP work records, saved connection details |
| macOS Keychain | Only with the Keychain setting on (off by default): the permission log's key, payment keys, the Virtuals signing key and sign-in tokens, the ACP tools' manifest key, the key of the saved hard-link allowances, and saved passwords. While it is off the app seals nothing, stays in Manual, and payments and the ACP tools are off |

Saved connection secrets (remote gateway tokens, access headers, sign-in tokens) are stored as plain text in the
app folder by default, readable only by your user account. **Settings › Machine › Gateways › Keep saved
passwords in the system keychain** encrypts them with the Keychain instead.

## What leaves your Mac

Nothing is sent to us. The app talks to other services only as listed here.

**On its own**

- **Update check.** At start, every six hours and on wake, the app reads the release feed on GitHub. It sends
  nothing about you; an update downloads only when you click.
- **Your wallet session.** If you signed in with your wallet, the app refreshes that session with Privy at start.
  If you never signed in, it does not contact Privy.
- **iNFT ownership.** If you hold iNFTs in the app, it re-checks their ownership on public blockchain endpoints
  shortly after start and then every hour.

**When you set it up or use it**

- **First launch.** The agent runtime installs from a copy inside the app. The installer then downloads its
  Python toolchain and packages (from GitHub, the Python package index and the runtime's mirror), each checked
  against pinned hashes. GitHub is contacted for the runtime itself only if the copy in the app is missing or
  damaged.
- **Your model provider.** When you connect a provider, your messages, files, persona, memory and tool results —
  including screen captures, if you allow them — go directly from your Mac to that provider, under its terms. A
  local endpoint (Ollama, llama.cpp, vLLM) keeps them on your machine.
- **Wallet sign-in.** Sign-in runs through Privy, by e-mail or wallet, in a window the app serves on
  `127.0.0.1`.
- **Your iNFTs and balances.** The iNFT Book and the stage read your wallet's tokens from public block explorers
  (Blockscout) and public RPC endpoints, and token metadata and 3D models from IPFS, Arweave or Irys gateways.
  The Wallet app reads balances from public RPC endpoints. These services see your public wallet address.
- **Integrations you add.** Messaging platforms (Telegram, Slack, Discord), MCP servers, e-mail, AgentCard, ACP
  and Hyperliquid accounts are contacted only after you configure them. The ACP command-line tool is downloaded
  from the npm registry the first time you use it.
- **Payments.** A payment you approve goes to the payee and its payment service under the mandate you signed.
- **Links in a chat.** To show a link's title and icon, the app may fetch them from that website.
- **Agent runtime updates.** In this version the agent runtime updates only with the app: it is built into each
  release, and the app does not check the upstream Hermes Agent repository for a newer runtime.

## Your controls

- **Settings › Profile › Privacy** — switches for terminal, files, web browsing, automation, screen, clipboard,
  installs, scheduled tasks, messages, spending and trading, microphone and notifications. A switch that is off
  refuses that kind of action in every mode.
- **Settings › Agent › Permissions** — the mode, a level for each kind of action, and every grant you made, each
  one revocable.
- **Background tasks › Permission log** — every ask, answer, grant and use, in a hash-chained record.

## Removing your data

Uninstalling removes the app only. To remove your data too, delete `~/.hermes`,
`~/Library/Application Support/iclone os`, and the caches and preferences macOS keeps for the app under `~/Library`. Your iNFTs are tokens in your wallet; the app never holds them.
