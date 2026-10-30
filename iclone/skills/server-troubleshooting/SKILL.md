---
name: server-troubleshooting
description: "Use when a server is slow, full, unreachable or crashing. Read-only triage for disk, memory and OOM kills, CPU, ports, DNS and clock drift, failed units, logins lost after a reboot and service logs, then the fix the owner approves."
version: 1.0.0
author: iCLONE / CLONE FRAME
license: MIT
metadata:
  hermes:
    tags: [iclone-os, server, troubleshooting, linux, systemd, logs]
    related_skills: [server-agent-service, watchdog-keepalive, acp-troubleshooting, diagnostics, systematic-debugging]
---

# Server troubleshooting — read first, fix with a yes

## When to use
- An agent, bot or gateway on a Linux server stopped answering, got slow, or keeps restarting.
- SSH hangs or is refused, the disk is full, or logins vanished after a reboot.

For the app on this Mac use `diagnostics` (`~/.iclone-os/bin/acp doctor run --json`). For acp error codes use `acp-troubleshooting`. All commands below are system tools (`man <tool>` is the truth) and only read.

## Prerequisites
- An SSH alias that works (`ssh-access`). Running even read commands on a server needs `terminal`; every fix is a write: ask through the consent door (`~/.iclone-os/bin/acp consent request terminal --reason "…"`), name the host and the fix, and wait for the owner's yes.

## Quick reference
| Symptom | Read | Usual cause → fix (owner's yes) |
|---|---|---|
| SSH refused / hangs | `ssh -v <alias>` from here | firewall layer, fail2ban ban, sshd down → provider console |
| Disk full | `df -h`, `df -i` | journal, logs, docker images → vacuum, rotate, prune |
| Killed / restarts | `dmesg -T`, `free -h` | OOM → swap, `MemoryMax=`, fewer workers |
| Slow | `uptime`, `ps --sort=-%cpu` | runaway process, swap thrash |
| Port in use | `ss -tlnp` | old instance still running → stop its unit |
| TLS or signed calls fail | `timedatectl` | clock drift → enable NTP |
| Name errors | `resolvectl status`, `getent hosts <domain>` | resolver config |
| Lost login after reboot | acp-troubleshooting E4, E23 | headless keyring (`server-agent-service`) |
| Telegram `409 Conflict` | `hermes gateway list` | two gateways (`hermes-gateway-server`) |

## Procedure
1. Failed units and the logs of the one that matters (this boot, then the previous one):
```sh
systemctl --failed --no-pager && journalctl -u <unit> -n 200 --no-pager  # example
journalctl -u <unit> -b -1 -n 100 --no-pager  # example
```
2. Disk and inodes, then the biggest directories on the root filesystem:
```sh
df -h && df -i && sudo du -xh --max-depth=1 / | sort -h | tail -n 10  # example
journalctl --disk-usage  # example
```
Fix (owner's yes): `sudo journalctl --vacuum-size=200M`, logrotate for app logs, unused images via `docker-for-agents`. Never `rm` data to free space.
3. Memory and OOM kills:
```sh
free -h && swapon --show && sudo dmesg -T | grep -iE 'out of memory|killed process' | tail -n 5  # example
```
4. CPU and the top processes:
```sh
uptime && ps -eo pid,user,%cpu,%mem,etime,comm --sort=-%cpu | head -n 10  # example
```
5. Listening ports and their owners:
```sh
sudo ss -tlnp  # example
```
6. Clock and DNS:
```sh
timedatectl show -p NTPSynchronized && resolvectl status | head -n 20  # example
```
7. From this machine when SSH fails: `ssh -v <alias>` shows where it stops (no route = firewall or server down; `Permission denied` = key; reset = fail2ban). Unban with the owner's yes from the provider console: `sudo fail2ban-client set sshd unbanip <your-ip>`.
8. Write down the cause, the fix and the check, then make the check permanent (`watchdog-keepalive`).

## Pitfalls
- Restarting first destroys the evidence: read the logs, then fix.
- `NRestarts` climbing with a clean log: the unit's start limit or a missing `ReadWritePaths` path (`server-agent-service`).
- Two machines with the same agent identity look like random failures (acp-troubleshooting E14, E17).
- `systemctl status` cuts lines; use `journalctl` with `--no-pager`.

## Never
- Never reboot, kill a process you did not start, delete logs or data, or change a firewall without the owner's yes.
- Never `chmod 777` or turn off the firewall "to test".
- Never paste log lines that contain tokens; redact first.

## Verification
```sh
systemctl --failed --plain --no-legend --no-pager | wc -l; systemctl is-active <unit>  # example
```
Pass = `0` failed units, `<unit>` is `active`, and the original symptom check (for example `df -h /` under 80 %) passes again.
