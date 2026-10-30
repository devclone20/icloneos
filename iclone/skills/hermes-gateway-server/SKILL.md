---
name: hermes-gateway-server
description: "Use when running the Hermes gateway on a server. One owner of the process, setup, install as a service, status, the 0600 .env with the bot token and allowlist, long polling without inbound ports, one gateway per host, and upgrades with a backup."
version: 1.0.0
author: iCLONE / CLONE FRAME
license: MIT
platforms: [macos, linux]
metadata:
  hermes:
    tags: [iclone-os, hermes, gateway, server, telegram, service]
    related_skills: [server-agent-service, backups-restore, app-atualisation, diagnostics, hermes-agent]
---

# Hermes gateway on a server — one process, one owner

## When to use
- The owner wants their agent reachable on Telegram (or another messaging platform) while this Mac sleeps.
- The gateway on a server is down, duplicated, or answering people it should not.

The gateway is `hermes gateway`. `hermes serve` is a different thing: the JSON-RPC backend the desktop app talks to. Install Hermes on the server as upstream documents it (`hermes-agent`); there `hermes gateway --help` is the truth, not the bundled copy.

## Prerequisites
- A hardened server (`vps-provision`) and a non-root `<user>` that owns the Hermes home.
- The bot token from the platform (for Telegram: BotFather) and the numeric user ids allowed to talk to the agent.
- Install, start, restart, uninstall and import are writes: ask through the consent door (`~/.iclone-os/bin/acp consent request terminal --reason "…"`), name the host and the action, and wait for the owner's yes.

## Quick reference
| Command | What it does |
|---|---|
| `hermes gateway setup` | configure messaging platforms (interactive) |
| `hermes gateway run` | foreground; `--replace` takes over a running instance |
| `hermes gateway install` | systemd/launchd service; `--system --run-as-user <user>` boots without a login |
| `hermes gateway start` / `stop` / `restart` | control the installed service (`sudo` + `--system` for a system install) |
| `hermes gateway status` | state; `--deep` for checks, `--system` for the system unit |
| `hermes gateway list` | every profile and its gateway |
| `hermes gateway migrate` | converge onto ONE host gateway; `--dry-run` previews |
| `hermes backup` / `hermes import <zip>` | zip of the Hermes home / restore it |

## Procedure
1. As `<user>` on the server, configure the platform. The owner types the token at the prompt; it is stored in the Hermes home `.env` (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS` for Telegram). Then lock the file:
```sh
hermes gateway setup && chmod 600 ~/.hermes/.env  # example
```
2. Pick ONE owner of the process and stick to it:
   - Hermes-managed (simplest):
```sh
sudo "$(command -v hermes)" gateway install --system --run-as-user <user> --start-now  # example
```
   - Or your own unit (`server-agent-service`) with `ExecStart=<path-to-hermes> gateway run`, `Restart=on-failure`, the Hermes home in `ReadWritePaths` and, for a home under `/home`, `ProtectHome=read-only`.
3. Check it:
```sh
sudo "$(command -v hermes)" gateway status --deep --system  # example
```
4. After any `.env` or config change, restart through the same owner (`--system` for a system install; your own unit: `sudo systemctl restart <unit>`):
```sh
sudo "$(command -v hermes)" gateway restart --system  # example
```
5. One gateway per host: the default profile's gateway serves every profile. If `hermes gateway list` shows a gateway for a named profile, preview the convergence (`sudo` for a system install):
```sh
hermes gateway migrate --dry-run  # example
```
   Under `✗ Blockers` nothing changes until fixed: two profiles hold the same bot token (one token, one profile), a named profile enables a platform that binds its own port (set `platforms.<platform>.enabled: false` there), or a profile's config does not load. Migrate stops and uninstalls each secondary gateway, with no rollback, and without a TTY (your shell) it applies with NO prompt — never run it bare. Only `--dry-run` before the owner's yes through the consent door, `-y` after it; then check `hermes gateway list` again:
```sh
hermes gateway migrate -y  # example
```
   `install` refuses a named profile the multiplexer serves; never `--force` it without the owner's yes.
6. Before an upgrade, back up; upgrade as `app-atualisation` and `hermes-agent` describe; restore only with the owner's yes:
```sh
hermes backup -o <backup-dir>/hermes-before-upgrade.zip && chmod 600 <backup-dir>/hermes-before-upgrade.zip  # example
```
7. Change settings with `hermes config set <key> <value>`, never by hand-editing `config.yaml`.

## Pitfalls
- Two owners (an `install`ed service AND a hand-written unit, a per-profile gateway, or a server AND a laptop on one token): Telegram returns `409 Conflict`. Stop one; `hermes gateway list` and `systemctl list-units '*hermes*'` show both.
- Long polling needs no inbound port; do not open one for the gateway. Webhooks belong to the bot-deploy skills.
- A blank `TELEGRAM_ALLOWED_USERS` means strangers can ask for access through DM pairing. Set the owner's ids, approve nobody else without the owner's yes, and never set `GATEWAY_ALLOW_ALL_USERS`.
- Group chats: the bot needs privacy mode off or admin rights to see messages.
- `Read-only file system` under a sandboxed unit: the Hermes home is not in `ReadWritePaths`; for a home under `/home` also set `ProtectHome=read-only` (`ProtectHome=yes` hides it).

## Never
- Never print, paste or commit the `.env`; refer to keys by name only.
- Never run the gateway as root or start a second copy "to test".
- Never `hermes gateway uninstall`, `migrate` (without `--dry-run`) or `hermes import --force` without the owner's yes.

## Verification
```sh
sudo "$(command -v hermes)" gateway status --system; systemctl is-active <unit>  # example
```
Pass = the gateway reports running and the unit is `active`; the owner's `/start` from an allowed account gets a reply; a non-listed account gets none. With a blank allowlist the first DM returns a pairing code instead: `hermes pairing list` shows it; approve only the owner's own request (`hermes pairing approve telegram <code>`) with their yes.
