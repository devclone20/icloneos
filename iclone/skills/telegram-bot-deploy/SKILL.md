---
name: telegram-bot-deploy
description: "Use when deploying a Telegram bot to a server or webhook. Polling or webhook, HTTPS reverse proxy with secret_token, fast 200 and idempotent handlers, setWebhook/getWebhookInfo, the bot's systemd unit and a local end-to-end test."
version: 1.0.0
author: iCLONE / CLONE FRAME
license: MIT
metadata:
  hermes:
    tags: [iclone-os, telegram, bot, webhook, systemd, deploy]
    related_skills: [telegram-bot-build, telegram-bot-troubleshooting, vps-provision, server-agent-service, consent]
---

# Telegram bot — deploy it so it stays up and answers once

## When to use

A bot built with `telegram-bot-build` must run 24/7 on a Linux server, or move from polling to a webhook. For the server itself (user, ssh, firewall) see `vps-provision` and `server-agent-service`.

## Prerequisites

- A Linux host with systemd, a non-root user for the bot, and the bot's `.env` (mode 0600) copied there.
- Webhook only: a DNS name `<domain>` pointing at the host and ports 80/443 open. Telegram delivers only to ports 443, 80, 88 or 8443.
- Every step below changes a server → first `~/.iclone-os/bin/acp consent request terminal --reason "Deploy <bot> on <host> as <bot>.service"`, state host, unit and domain, and wait for the owner's yes.
- Truth for each tool: `systemctl --help`, `caddy --help`, `curl --help`; Bot API: https://core.telegram.org/bots/api#setwebhook

## Quick reference

| Choice | Pick it when |
|---|---|
| Long polling | default: one process, zero inbound ports, no TLS |
| Webhook | you already serve HTTPS, or need many instances behind one URL |

Polling and a webhook never run together: `getUpdates` answers `409 Conflict` while a webhook is set.

## Procedure

1. **systemd unit** `/etc/systemd/system/<bot>.service`:

   ```ini
   [Unit]
   Description=<bot> Telegram bot
   After=network-online.target
   Wants=network-online.target
   [Service]
   User=<bot-user>
   WorkingDirectory=/opt/<bot>
   EnvironmentFile=/opt/<bot>/.env
   ExecStart=/usr/bin/python3 /opt/<bot>/bot.py
   Restart=on-failure
   RestartSec=5
   NoNewPrivileges=yes
   ProtectSystem=strict
   ProtectHome=yes
   PrivateTmp=yes
   ReadWritePaths=/opt/<bot>/data
   [Install]
   WantedBy=multi-user.target
   ```

   Secrets come from `EnvironmentFile`, never `ExecStart` arguments (argv shows in `ps`). With `ProtectSystem=strict` every folder the bot writes must be in `ReadWritePaths`, or it fails with `EROFS`; a missing `ReadWritePaths` folder stops the start with `status=226/NAMESPACE`.

2. **Start it.** Create the data folder before the first start; `enable --now` does not restart a running unit, so after every change run line 2:

   ```sh
   sudo install -d -o <bot-user> -m 700 /opt/<bot>/data  # example
   sudo systemctl daemon-reload && sudo systemctl enable <bot>.service && sudo systemctl restart <bot>.service  # example
   ```

3. **Webhook only — reverse proxy.** The bot listens on `127.0.0.1:<port>`; Caddy terminates TLS. Caddyfile:

   ```text
   <domain> {
       reverse_proxy /<hook-path> 127.0.0.1:<port>
   }
   ```

   `<hook-path>` is random; the handler returns `401` unless the header `X-Telegram-Bot-Api-Secret-Token` equals `WEBHOOK_SECRET` (1–256 chars of `A-Z a-z 0-9 _ -`). Add it to the bot's `EnvironmentFile` once (copy, append, swap: nothing else changes, nothing on argv), then restart (step 2):

   ```sh
   f=/opt/<bot>/.env; sudo install -m 600 -o <bot-user> "$f" "$f.new" && printf '\nWEBHOOK_SECRET=%s\n' "$(openssl rand -hex 32)" | sudo tee -a "$f.new" >/dev/null && sudo mv "$f.new" "$f"  # example
   ```

4. **Webhook only — the handler contract.** Answer `200` at once and do the work after (queue it). Telegram retries any non-2xx answer or a timeout, so a slow handler runs the same update twice — paid work included. Keep the last few thousand `update_id`s and skip repeats. grammY's `webhookCallback` aborts at 10 s by default; stay far below it.

5. **Webhook only — register it** as `<bot-user>` with `/opt/<bot>/.env` loaded and the `tg` helper from `telegram-bot-build` (secrets stay off argv). Lines 1–2 open that shell:

   ```sh
   sudo -u <bot-user> bash  # example
   set -a; . /opt/<bot>/.env; set +a; tg() { m=$1; shift; printf 'url = "https://api.telegram.org/bot%s/%s"\n' "$TELEGRAM_BOT_TOKEN" "$m" | curl -sS -K - "$@"; }  # example
   F=$(mktemp); printf %s "$WEBHOOK_SECRET" > "$F"; tg setWebhook --data-urlencode "url=https://<domain>/<hook-path>" --data-urlencode "secret_token@$F" --data-urlencode 'allowed_updates=["message","callback_query"]'; rm -f "$F"  # example
   ```

   Queued updates are kept and delivered. Back to polling: `tg deleteWebhook` (keeps the queue too).

6. **End-to-end test**, same shell — inject an update as Telegram would (the reply goes to `<chat-id>`: use the owner's chat):

   ```sh
   H=$(mktemp); U=$(date +%s); printf 'X-Telegram-Bot-Api-Secret-Token: %s\n' "$WEBHOOK_SECRET" > "$H"; curl -sS -o /dev/null -w '%{http_code}\n' -H @"$H" -H 'Content-Type: application/json' -d '{"update_id":'"$U"',"message":{"message_id":1,"date":0,"chat":{"id":<chat-id>,"type":"private"},"from":{"id":<chat-id>,"is_bot":false,"first_name":"test"},"text":"/status"}}' http://127.0.0.1:<port>/<hook-path>; rm -f "$H"  # example
   ```

   Each run uses a new `update_id` (the handler skips repeats). Expect `200` and a reply in the chat; the same call without the header must print `401`.

## Pitfalls

- Two owners of one process (systemd plus a framework's own installer, or two hosts polling one token) = `409` and lost updates.
- `Restart=always` with a bad token loops forever; `on-failure` plus a readable journal is enough.
- `bot.catch` (grammY) only covers `bot.start()` polling; behind a webhook errors reach your web framework.

## Never

- Never put `<bot-token>` or the webhook secret in the unit file, a URL you share, or a commit.
- Never deploy, restart or change DNS without the owner's yes.

## Verification

`systemctl is-active <bot>.service` prints `active`; webhook: `tg getWebhookInfo` shows your `url`, `pending_update_count` near 0 and no `last_error_message`.
