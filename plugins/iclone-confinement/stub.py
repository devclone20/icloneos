"""The stub: Hermes' child for one confined command while the runtime itself runs under a profile.

``<python> -I -S stub.py <launcher socket> -- <sandbox-exec argv…>`` hands the argv, the cwd, the environment and its
own fds 0/1/2 to the launcher (launcher.py), which validates and starts the command in a session of its own. The stub
then lets go of the pipes (so they reach EOF when the real command ends), forwards TERM/INT/HUP/QUIT, and ends exactly
as the command did: the same exit code, or the same signal re-raised, so ``Popen`` sees what it would have seen.
Refused or launcher unreachable: one line on stderr and exit 126. The launcher gone mid-run: exit 125.
"""

import json
import os
import signal
import socket
import struct
import sys

FORWARDED = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGQUIT)
UNREACHABLE = "the launcher is not answering"
# fx20 (lens5 M1): the launcher may scan a folder for up to SCAN_BUDGET_S (launcher.py, 30 s) before it answers, so
# waiting less would tell the agent "not answering" while it is working. Connecting and sending stay at 10 s.
REPLY_TIMEOUT_S = 60.0


def _refuse(reason):
    try:
        os.write(2, f"Refused by icloneOS confinement: {reason}\n".encode("utf-8", "replace"))
    except OSError:
        pass
    os._exit(126)


def _recv_msg(sock, buffered):
    while True:
        if len(buffered) >= 4:
            size = struct.unpack(">I", bytes(buffered[:4]))[0]
            if size > 1 << 16:
                raise EOFError
            if len(buffered) >= 4 + size:
                body = bytes(buffered[4:4 + size])
                del buffered[:4 + size]
                return json.loads(body.decode("utf-8"))
        chunk = sock.recv(65536)
        if not chunk:
            raise EOFError
        buffered.extend(chunk)


def main(argv):
    if len(argv) < 4 or argv[2] != "--":
        _refuse("the stub was started without a launcher socket and a command")
    path, command = argv[1], argv[3:]
    # fx18 (F1): the folder the command runs in is the request's, said by the runtime in ICLONE_RUN_CWD and popped here
    # (never forwarded): this stub runs under the runtime profile, which may not getcwd() in a folder main did not
    # open, though the launcher (not confined) starts the command there and the command's own sandbox reads it.
    env = dict(os.environ)
    cwd = env.pop("ICLONE_RUN_CWD", "")
    if not cwd:
        try:
            cwd = os.getcwd()
        except OSError:
            _refuse("the runtime cannot tell which folder the command runs in")
    data = json.dumps({"v": 1, "argv": command, "cwd": cwd, "env": env}).encode("utf-8")
    frame = struct.pack(">I", len(data)) + data
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(10.0)
        sock.connect(path)
        sent = socket.send_fds(sock, [frame], [0, 1, 2])
        if sent < len(frame):
            sock.sendall(frame[sent:])
        sock.settimeout(REPLY_TIMEOUT_S)
        buffered = bytearray()
        reply = _recv_msg(sock, buffered)
    except (OSError, EOFError, ValueError):
        _refuse(UNREACHABLE)
    if not isinstance(reply, dict) or reply.get("ok") is not True:
        reason = reply.get("error") if isinstance(reply, dict) else None
        _refuse(str(reason or "the launcher refused the command"))
    # The command holds the real pipes now; ours go, so the reader sees EOF when the command (not the stub) ends.
    null = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(null, fd)
    if null > 2:
        os.close(null)

    def forward(sig, _frame):
        body = json.dumps({"signal": int(sig)}).encode("utf-8")
        try:
            sock.sendall(struct.pack(">I", len(body)) + body)
        except OSError:
            pass

    for sig in FORWARDED:
        signal.signal(sig, forward)
    sock.settimeout(None)
    try:
        while True:
            msg = _recv_msg(sock, buffered)
            if isinstance(msg, dict) and "exit" in msg:
                break
    except (OSError, EOFError, ValueError):
        os._exit(125)
    sig = msg.get("signal")
    if isinstance(sig, int) and 0 < sig < 64:
        for each in FORWARDED:
            signal.signal(each, signal.SIG_DFL)
        try:
            signal.signal(sig, signal.SIG_DFL)
        except (OSError, ValueError):  # SIGKILL and SIGSTOP have no handler to reset
            pass
        os.kill(os.getpid(), sig)
        os._exit(128 + sig)
    code = msg.get("exit")
    os._exit(code if isinstance(code, int) and 0 <= code <= 255 else 125)


if __name__ == "__main__":
    main(sys.argv)
