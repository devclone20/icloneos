#!/usr/bin/env python3
"""x402-pay — the agent's payment client in iclone os (V3-J, contract 1.3).

It talks ONLY to the app's pay socket, with the token of THIS Hermes spawn. It holds no key and signs nothing: the
app's main process checks the owner's caps, allowlists and mandate, asks the owner on the permission sheet, signs
with the pocket key, and answers one JSON line. The token is read from the 0600 file whose path the app put in
ICLONE_PAY_TOKEN_FILE; it is never printed, logged or passed on. Each request names the profile folder this agent
runs in (the identity of its HERMES_HOME): the app refuses a token minted for another profile's folder.

  x402_pay.py fetch <url> [--mandate <jti>] [--max <usdc>]   fetch a resource; pay it if it answers 402 (x402 v2)
  x402_pay.py send <payee> <usdc> [--mandate <jti>]          send USDC to a payee on the owner's allowlist
  x402_pay.py status                                         caps, today's spend, your mandates and what is left
  x402_pay.py stop                                           pull the hard stop: every payment is refused until
                                                             the owner clears it

Without --mandate, fetch and send use your one usable mandate when there is exactly one.
stdout: the app's answer, one JSON line. Exit: 0 paid / passthrough / status / stopped, 1 refused / failed / pending,
3 payments not available, 64 usage.
"""
import json
import os
import re
import socket
import stat
import sys

PROTOCOL = 1
TOKEN_RE = re.compile(r"^[0-9a-f]{64}$")
MANDATE_RE = re.compile(r"^[0-9a-f]{32}$")
# The owner's permission sheet waits up to two minutes; the network after it, a little more.
WAIT_SECONDS = 180
ANSWER_MAX = 8 * 1024 * 1024
USAGE = __doc__[__doc__.index("  x402_pay.py fetch"):].rstrip()
NOT_AVAILABLE = 3
EX_USAGE = 64


def fail(code, kind, reason, detail):
    print(json.dumps({"kind": kind, "reason": reason, "detail": detail}))
    return code


def token_of(path):
    """The spawn's token from its 0600 file; None when it is missing, unreadable or not a token."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            text = handle.read(256).strip()
    except OSError:
        return None
    return text if TOKEN_RE.match(text) else None


def home_id():
    """`st_dev:st_ino` of the profile folder this agent runs in (its HERMES_HOME, links followed), or None."""
    home = os.environ.get("HERMES_HOME", "").strip() or os.path.join(os.path.expanduser("~"), ".hermes")
    try:
        st = os.stat(home)
    except (OSError, ValueError):
        return None
    return f"{st.st_dev}:{st.st_ino}" if stat.S_ISDIR(st.st_mode) else None


def ask(argv):
    """One request on the pay socket → (exit code, stdout text, stderr text)."""
    path = os.environ.get("ICLONE_PAY_SOCKET", "")
    token_file = os.environ.get("ICLONE_PAY_TOKEN_FILE", "")
    if not path or not token_file:
        return NOT_AVAILABLE, json.dumps({"kind": "refused", "reason": "not_ready",
                                          "detail": "no pay socket in this session (payments run inside iclone os)"}) + "\n", ""
    token = token_of(token_file)
    if token is None:
        return NOT_AVAILABLE, json.dumps({"kind": "refused", "reason": "not_ready",
                                          "detail": "this session's pay token is missing or expired"}) + "\n", ""
    home = home_id()
    if home is None:
        return NOT_AVAILABLE, json.dumps({"kind": "refused", "reason": "not_ready",
                                          "detail": "this session's profile folder cannot be read"}) + "\n", ""
    line = json.dumps({"v": PROTOCOL, "token": token, "home": home, "argv": argv}) + "\n"
    del token
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(WAIT_SECONDS)
            conn.connect(path)
            conn.sendall(line.encode("utf-8"))
            chunks, size = [], 0
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                size += len(chunk)
                if size > ANSWER_MAX:
                    break
                chunks.append(chunk)
    except (OSError, socket.timeout) as error:
        return NOT_AVAILABLE, json.dumps({"kind": "refused", "reason": "not_ready",
                                          "detail": f"pay socket: {type(error).__name__}"}) + "\n", ""
    out, err, code = [], [], None
    for raw in b"".join(chunks).decode("utf-8", "replace").splitlines():
        try:
            frame = json.loads(raw)
        except ValueError:
            continue
        if frame.get("t") == "o":
            out.append(str(frame.get("d", "")))
        elif frame.get("t") == "e":
            err.append(str(frame.get("d", "")))
        elif frame.get("t") == "x":
            code = frame.get("c")
    if not isinstance(code, int):
        return 1, "".join(out) or json.dumps({"kind": "failed", "reason": "internal",
                                               "detail": "the pay socket closed without an answer"}) + "\n", "".join(err)
    return code, "".join(out), "".join(err)


def flags(args, allowed):
    """`--name value` pairs, each at most once; None on anything else."""
    parsed = {}
    if len(args) % 2:
        return None
    for name, value in zip(args[::2], args[1::2]):
        if name not in allowed or name in parsed or value.startswith("--"):
            return None
        parsed[name] = value
    return parsed


def only_mandate():
    """Your one usable mandate's id, or None (none, several, or status unavailable): the app decides either way."""
    code, out, _ = ask(["status"])
    if code != 0:
        return None
    try:
        usable = [m.get("jti") for m in json.loads(out).get("mandates", []) if m.get("usable") is True]
    except (ValueError, AttributeError):
        return None
    return usable[0] if len(usable) == 1 and isinstance(usable[0], str) and MANDATE_RE.match(usable[0]) else None


def main(argv):
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(USAGE)
        return 0 if argv else EX_USAGE
    verb, rest = argv[0], argv[1:]
    if verb in ("status", "stop"):
        if rest:
            return fail(EX_USAGE, "refused", "usage", f"{verb} takes no arguments")
        request = [verb]
    elif verb == "fetch":
        if not rest or rest[0].startswith("--"):
            return fail(EX_USAGE, "refused", "usage", "fetch <url> [--mandate <jti>] [--max <usdc>]")
        options = flags(rest[1:], ("--mandate", "--max"))
        if options is None:
            return fail(EX_USAGE, "refused", "usage", "fetch <url> [--mandate <jti>] [--max <usdc>]")
        options.setdefault("--mandate", only_mandate())
        request = ["pay", rest[0]] + [part for name, value in options.items() if value for part in (name, value)]
    elif verb == "send":
        if len(rest) < 2 or rest[0].startswith("--") or rest[1].startswith("--"):
            return fail(EX_USAGE, "refused", "usage", "send <payee> <usdc> [--mandate <jti>]")
        options = flags(rest[2:], ("--mandate",))
        if options is None:
            return fail(EX_USAGE, "refused", "usage", "send <payee> <usdc> [--mandate <jti>]")
        options.setdefault("--mandate", only_mandate())
        request = ["send", rest[0], rest[1]] + (["--mandate", options["--mandate"]] if options["--mandate"] else [])
    else:
        return fail(EX_USAGE, "refused", "usage", "fetch | send | status | stop")
    code, out, err = ask(request)
    sys.stdout.write(out)
    if err:
        sys.stderr.write(err)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
