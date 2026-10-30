---
name: server-agent-service
description: "Use when running an agent 24/7 as a systemd service. Unit template with a non-root user, a 0600 env file, restart policy and sandboxing, the enable-plus-restart rule, journalctl, ghost and orphan units, and headless keyring notes."
version: 1.0.0
author: iCLONE / CLONE FRAME
license: MIT
metadata:
  hermes:
    tags: [iclone-os, server, systemd, service, agent, linux]
    related_skills: [watchdog-keepalive, hermes-gateway-server, server-troubleshooting, acp-troubleshooting, consent]
---

# Server agent service — one systemd unit per agent

## When to use
- An agent, bot or provider must run on a Linux server around the clock and come back after a crash or a reboot.
- A unit exists but runs as root, keeps old code after a deploy, or leaves processes behind.

For the Hermes gateway itself see `hermes-gateway-server`; for ACP providers on a server read `acp-troubleshooting` "Deploying headless" first (signer, tokens, cutover). `man systemd.service` and `man systemd.exec` are the truth.

## Prerequisites
- A hardened server (`vps-provision`), the code in `/opt/<agent>`, its runtime (venv, node) installed and the full import chain tested.
- Writing a unit or restarting a service is a write: ask through the consent door (`~/.iclone-os/bin/acp consent request terminal --reason "…"`), name the unit and the host, and wait for the owner's yes.

## Quick reference
| Item | Default |
|---|---|
| User | dedicated non-root `<agent>` user, no login shell |
| Secrets | `/etc/<agent>/<agent>.env`, root-owned, 0600 (systemd reads it before dropping privileges) |
| Restart | `Restart=on-failure`, `RestartSec=10`, start limit 5 per 5 min |
| Stop | `KillMode=mixed`, `TimeoutStopSec=30` |
| Sandbox | `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `NoNewPrivileges=yes`, writable paths listed |

## Procedure
1. Service user and secrets file (the owner fills the values with `sudo -e /etc/<agent>/<agent>.env`; you never echo a secret):
```sh
sudo useradd --system --create-home --home-dir /var/lib/<agent> --shell /usr/sbin/nologin <agent>  # example
sudo install -d -m 700 /etc/<agent> && sudo install -m 600 /dev/null /etc/<agent>/<agent>.env  # example
```
2. Write the unit to a local file `<agent>.service` (fileWriting):
```ini
# example unit
[Unit]
Description=<agent> agent
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=<agent>
Group=<agent>
WorkingDirectory=/opt/<agent>
EnvironmentFile=/etc/<agent>/<agent>.env
ExecStart=/opt/<agent>/venv/bin/python -m <module>
Restart=on-failure
RestartSec=10
KillMode=mixed
TimeoutStopSec=30
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
StateDirectory=<agent>
ReadWritePaths=/var/lib/<agent>

[Install]
WantedBy=multi-user.target
```
3. Install, check and start it:
```sh
sudo install -m 644 <agent>.service /etc/systemd/system/ && sudo systemd-analyze verify /etc/systemd/system/<agent>.service  # example
sudo systemctl daemon-reload && sudo systemctl enable <agent> && sudo systemctl restart <agent>  # example
```
4. Read the logs:
```sh
journalctl -u <agent> -n 200 --no-pager  # example
```
5. After every deploy: `sudo systemctl restart <agent>` — `enable --now` does NOT restart a unit that is already running, so it keeps the old code.
6. Retire a unit (destructive, owner's yes):
```sh
sudo systemctl disable --now <agent> && sudo rm /etc/systemd/system/<agent>.service && sudo systemctl daemon-reload && sudo systemctl reset-failed  # example
```

## Pitfalls
- `Read-only file system` (EROFS) or "could not reach my model" under `ProtectSystem=strict`: a path the agent writes (for example its Hermes home) is missing from `ReadWritePaths`; with `ProtectHome=yes`, a home under `/home` is invisible — use `ProtectHome=read-only` plus that path.
- Ghost units listed as `not-found` after a file was removed: `systemctl reset-failed` (acp-troubleshooting E15).
- A child survives `systemctl stop`: the program escapes its cgroup (`su`, `setsid`); see acp-troubleshooting E18 and keep `KillMode=mixed`.
- Headless acp client logins die after a reboot: no unlocked keyring. Follow acp-troubleshooting E4 and E23 (login session, foreground), or give that user the file keyring backend (`~/.config/keyring/keyring.config.json` = `{"defaultBackend":"file"}`) and back that file up (`backups-restore`).
- Two servers running the same agent identity break each other (acp-troubleshooting E14, E17).

## Never
- Never run an agent as root, and never with secrets in `Environment=` lines or `ExecStart` arguments (visible in `systemctl show` and `/proc`).
- Never use `nohup`, `setsid` or `screen` as the service manager.
- Never `pkill` by pattern; stop the unit.

## Verification
```sh
systemctl is-active <agent> && systemctl show -p User,Restart,NRestarts <agent>  # example
```
Pass = `active`, `User=<agent>` (not root), `Restart=on-failure`, and `NRestarts` not climbing over ten minutes.
