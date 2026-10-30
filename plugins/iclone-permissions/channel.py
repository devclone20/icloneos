"""V3-F §4 — the plugin's line to main: the app's agent socket, every message HMAC-signed with this spawn's key, every
answer from main HMAC-signed back (a socket that cannot sign is not main).

One ordered worker carries every message that has a sequence number — decisions made locally (``event``), asks
(``ask``, registration only), the attestation (``hello``), the heartbeat (``beat``) and the goodbye (``bye``) — so
main sees this process's ``src_seq`` in order and a hole is always a hole (main writes a ``gap`` record for it).

Nothing is lost on the way (critic F-11/F-12, the soak's 818 missing decisions):

* every event is appended to a write-ahead log ``$HERMES_HOME/iclone-perm-spool/<pid>-<keyId>.jsonl`` BEFORE the
  hook returns, signed exactly as it will be sent, and leaves it only after main acknowledged it with a signed answer;
* the log is held under an exclusive ``flock`` for the life of the process; a later process that can take the lock
  knows the writer is gone and replays its lines inside a ``replay`` message signed with its own key (main checks the
  inner signature with the key it derives for the dead process) — so a ``kill -9`` of Hermes or of main loses nothing;
* main de-duplicates by ``(pid, key, src_seq)``, so a line sent twice is recorded once.

While main is unreachable the channel is unhealthy and the plugin refuses everything but reading (§4, F-9).
An ask's owner wait is a separate ``await`` call with no sequence number, so a 20-second wait never holds the line.
"""

from __future__ import annotations

import fcntl
import glob
import hashlib
import hmac
import itertools
import json
import logging
import os
import queue
import socket
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

_CONNECT_TIMEOUT = 2.0
_SEND_TIMEOUT = 5.0
BEAT_SECONDS = 5.0
_RETRY_SECONDS = 0.5
_REGISTER_WAIT = 5.0
_UNSIGNED = "unsigned"
_CONTROL_VERBS = frozenset({"hello", "beat", "bye"})


class MainAnswer:
    """A reply that main signed for this exact request (``ok``) — or why there is none."""

    __slots__ = ("code", "body", "error")

    def __init__(self, code: int = -1, body: Optional[Dict[str, Any]] = None, error: Optional[str] = None):
        self.code = code
        self.body = body or {}
        self.error = error

    @property
    def ok(self) -> bool:
        return self.error is None


class _Pending:
    """A sequenced message waiting for the worker; ``done`` fires with main's answer for asks and hello."""

    __slots__ = ("verb", "seq", "text", "mac", "wal", "done", "answer")

    def __init__(self, verb: str, seq: int, text: str, mac: str, wal: bool):
        self.verb = verb
        self.seq = seq
        self.text = text
        self.mac = mac
        self.wal = wal
        self.done = threading.Event()
        self.answer: Optional[MainAnswer] = None


class Channel:
    def __init__(self, sock_path: Optional[str], token_file: Optional[str], key: Optional[bytes], key_id: str,
                 spool_dir: Optional[str], *, on_gen: Optional[Callable[[Any], None]] = None,
                 beat_seconds: float = BEAT_SECONDS):
        self._sock_path = sock_path
        self._token_file = token_file
        self._key = key
        self._key_id = key_id
        self._spool_dir = spool_dir
        self._on_gen = on_gen
        self._beat_seconds = beat_seconds
        self._pid = os.getpid()
        self._seq = itertools.count(1)
        self._last_seq = 0
        self._seq_lock = threading.Lock()
        self._queue: "queue.Queue[_Pending]" = queue.Queue()
        self._order_lock = threading.Lock()
        self._wal_lock = threading.Lock()
        self._wal_fd: Optional[int] = None
        self._wal_unacked = 0
        self._healthy = False
        self._closed = False
        self._worker: Optional[threading.Thread] = None
        self._open_wal()

    # ---- state --------------------------------------------------------------------------------------------------
    @property
    def usable(self) -> bool:
        return bool(self._sock_path and self._token_file and self._key)

    @property
    def healthy(self) -> bool:
        """Main answered (signed) the last message this process sent. False until the hello is acknowledged."""
        return self._healthy and self.usable

    @property
    def wal_path(self) -> Optional[str]:
        if not self._spool_dir:
            return None
        return os.path.join(self._spool_dir, f"{self._pid}-{self._key_id or 'nokey'}.jsonl")

    def next_seq(self) -> int:
        with self._seq_lock:
            self._last_seq = next(self._seq)
            return self._last_seq

    def sign(self, verb: str, text: str) -> str:
        return hmac.new(self._key or b"", f"{verb}\n{text}".encode("utf-8"), hashlib.sha256).hexdigest()

    # ---- the write-ahead log --------------------------------------------------------------------------------------
    def _open_wal(self) -> None:
        path = self.wal_path
        if not path or not self._key:
            return
        try:
            os.makedirs(self._spool_dir or "", mode=0o700, exist_ok=True)
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_APPEND, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self._wal_fd = fd
        except OSError as exc:
            logger.warning("iclone-permissions: no write-ahead log (%s); events wait in memory", exc)

    def _wal_append(self, item: _Pending) -> None:
        if self._wal_fd is None:
            return
        line = json.dumps({"keyId": self._key_id, "verb": item.verb, "payload": item.text, "mac": item.mac},
                          separators=(",", ":")) + "\n"
        with self._wal_lock:
            os.write(self._wal_fd, line.encode("utf-8"))
            self._wal_unacked += 1

    def _wal_ack(self) -> None:
        if self._wal_fd is None:
            return
        with self._wal_lock:
            self._wal_unacked = max(0, self._wal_unacked - 1)
            if self._wal_unacked == 0 and self._queue.empty():
                os.ftruncate(self._wal_fd, 0)

    # ---- one request ---------------------------------------------------------------------------------------------
    def _request(self, verb: str, text: str, mac: str, timeout: float, key_id: Optional[str] = None) -> MainAnswer:
        """One request on a fresh connection. ``ok`` only when main signed the answer for this very request."""
        try:
            with open(self._token_file or "", "r", encoding="utf-8") as handle:
                token = handle.read().strip()
        except OSError as exc:
            return MainAnswer(error=f"token: {exc}")
        line = json.dumps({"v": 1, "token": token, "inft": os.environ.get("ICLONE_INFT") or None,
                           "argv": ["perm", verb, key_id or self._key_id, text, mac]})
        conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.settimeout(_CONNECT_TIMEOUT)
        out = ""
        try:
            conn.connect(self._sock_path or "")
            conn.sendall((line + "\n").encode("utf-8"))
            conn.settimeout(timeout)
            for raw in conn.makefile("rb"):
                frame = json.loads(raw)
                if frame.get("t") == "o":
                    out += str(frame.get("d", ""))
                elif frame.get("t") == "x":
                    break
        except socket.timeout:
            return MainAnswer(error="timeout")
        except (OSError, ValueError) as exc:
            return MainAnswer(error=f"transport: {type(exc).__name__}")
        finally:
            conn.close()
        return self._verify(out, mac)

    def _verify(self, out: str, request_mac: str) -> MainAnswer:
        try:
            envelope = json.loads(out) if out.strip() else {}
            inner = envelope.get("r")
            sig = envelope.get("sig")
            if not isinstance(inner, str) or not isinstance(sig, str):
                return MainAnswer(error=_UNSIGNED)
            expected = hmac.new(self._key or b"", f"resp\n{request_mac}\n{inner}".encode("utf-8"), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(expected, sig):
                return MainAnswer(error=_UNSIGNED)
            body = json.loads(inner)
            if not isinstance(body, dict) or not isinstance(body.get("code"), int):
                return MainAnswer(error=_UNSIGNED)
        except (ValueError, AttributeError):
            return MainAnswer(error=_UNSIGNED)
        if "gen" in body and self._on_gen:
            self._on_gen(body.get("gen"))
        return MainAnswer(code=int(body["code"]), body=body)

    # ---- sequenced messages ---------------------------------------------------------------------------------------
    def _message(self, verb: str, payload: Dict[str, Any], seq: Optional[int] = None) -> _Pending:
        """``event``/``ask`` take the next src_seq. ``hello``/``beat``/``bye`` take none: they carry ``hi``, the last
        seq allocated so far — sent in order behind everything before it, so main knows what must have arrived."""
        if verb in _CONTROL_VERBS:
            with self._seq_lock:
                hi = self._last_seq
            text = json.dumps(dict(payload, hi=hi, pid=self._pid, keyId=self._key_id), separators=(",", ":"))
            return _Pending(verb, 0, text, self.sign(verb, text), wal=False)
        seq = self.next_seq() if seq is None else seq
        text = json.dumps(dict(payload, seq=seq, pid=self._pid, keyId=self._key_id), separators=(",", ":"))
        return _Pending(verb, seq, text, self.sign(verb, text), wal=verb == "event")

    def _send_in_order(self, verb: str, payload: Dict[str, Any], seq: Optional[int] = None) -> _Pending:
        """Allocate the seq, log it ahead and queue it as ONE step: two threads can never enter the line swapped
        (soak r2: seq 630 queued before 629 made main write a gap and drop the late 629 as a duplicate)."""
        with self._order_lock:
            return self._enqueue(self._message(verb, payload, seq))

    def _enqueue(self, item: _Pending) -> _Pending:
        if item.wal:
            try:
                self._wal_append(item)
            except OSError as exc:
                logger.warning("iclone-permissions: write-ahead log append failed: %s", exc)
        self._queue.put(item)
        self._start_worker()
        return item

    def emit(self, payload: Dict[str, Any], seq: Optional[int] = None) -> int:
        """A decision the plugin made (allow/refuse): logged before return, delivered in order. Returns its seq."""
        return self._send_in_order("event", payload, seq).seq

    def hello(self, payload: Dict[str, Any], wait: float = _REGISTER_WAIT) -> MainAnswer:
        """The attestation: this process loaded the gate with this key. Healthy only after main signs back."""
        item = self._send_in_order("hello", payload)
        if not item.done.wait(wait):
            return MainAnswer(error="timeout")
        return item.answer or MainAnswer(error="no answer")

    def register_ask(self, payload: Dict[str, Any]) -> Tuple[MainAnswer, int]:
        """Puts an ask in order with every event before it. Main answers at once: decided, or pending + ``askId``.
        When it cannot be delivered, the same seq is recorded as a refusal so main never sees a hole."""
        item = self._send_in_order("ask", payload)
        if not item.done.wait(_REGISTER_WAIT) or item.answer is None or not item.answer.ok:
            answer = item.answer or MainAnswer(error="timeout")
            return answer, item.seq
        return item.answer, item.seq

    def await_answer(self, ask_id: str, wait: float) -> MainAnswer:
        """The owner's answer to a pending ask; no sequence number, its own connection, bounded by ``wait``."""
        text = json.dumps({"askId": ask_id, "pid": self._pid, "keyId": self._key_id}, separators=(",", ":"))
        return self._request("await", text, self.sign("await", text), max(0.1, wait))

    def flush(self, timeout: float = 1.0) -> bool:
        """Wait (bounded) until every queued message was handled."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._queue.unfinished_tasks == 0:
                return True
            time.sleep(0.01)
        return self._queue.unfinished_tasks == 0

    def close(self, timeout: float = 2.0) -> None:
        """At exit: a goodbye in order after everything else, then stop. Undelivered events stay in the log."""
        if self._closed:
            return
        if self.usable:
            self._send_in_order("bye", {})
            self.flush(timeout)
        self._closed = True

    # ---- the worker -----------------------------------------------------------------------------------------------
    def _start_worker(self) -> None:
        if self._worker is None or not self._worker.is_alive():
            self._worker = threading.Thread(target=self._run, name="iclone-perm-channel", daemon=True)
            self._worker.start()

    def _run(self) -> None:
        replayed = False
        while not self._closed:
            try:
                item = self._queue.get(timeout=self._beat_seconds)
            except queue.Empty:
                # Idle: a heartbeat while main answers; a fresh attestation once it stopped answering.
                if self.usable:
                    self._deliver(self._message("beat" if self._healthy else "hello", {"plugin": "re-attest"}))
                continue
            try:
                self._deliver(item)
                if not replayed and self._healthy:
                    replayed = True
                    self.replay_orphans()
            finally:
                self._queue.task_done()

    @staticmethod
    def _accepted(item: _Pending, answer: MainAnswer) -> bool:
        """Main signed an answer that takes this message: 0 for events and attestation; 0/1 (decided) for asks.
        An event main calls malformed (64) is dropped from the log: main records the hole as a gap."""
        if not answer.ok:
            return False
        if item.verb == "event":
            return answer.code in (0, 64)
        if item.verb in _CONTROL_VERBS:
            return answer.code == 0
        return answer.code in (0, 1)

    def _deliver(self, item: _Pending) -> None:
        """Send until main takes it. Events retry forever (they are in the log); others give up after one try."""
        while True:
            answer = (self._request(item.verb, item.text, item.mac, _SEND_TIMEOUT)
                      if self.usable else MainAnswer(error="no key or no socket"))
            if self._accepted(item, answer):
                self._healthy = True
                item.answer = answer
                item.done.set()
                if item.wal:
                    self._wal_ack()
                return
            if answer.ok and item.verb in _CONTROL_VERBS:
                answer = MainAnswer(error=f"main refused {item.verb} ({answer.code})")
            self._healthy = False
            if not item.wal or self._closed:
                item.answer = answer
                item.done.set()
                if item.verb == "ask":
                    # Never a hole in src_seq: the undelivered ask becomes this seq's refusal, logged and delivered
                    # next, before anything queued after it.
                    refusal = self._undelivered_ask_refusal(item)
                    if refusal is not None:
                        self._deliver(refusal)
                return
            time.sleep(_RETRY_SECONDS)

    def _undelivered_ask_refusal(self, item: _Pending) -> Optional[_Pending]:
        try:
            original = json.loads(item.text)
        except ValueError:
            return None
        payload = {k: v for k, v in original.items() if k not in ("seq", "pid", "keyId")}
        payload.update(outcome="refuse", reason="icloneOS was not reachable, so the ask was refused (fail closed)")
        refusal = self._message("event", payload, seq=item.seq)
        try:
            self._wal_append(refusal)
        except OSError:
            pass
        return refusal

    # ---- orphans: logs of Hermes processes that are gone -------------------------------------------------------
    def replay_orphans(self) -> int:
        """Replays every log whose writer is gone (its flock is free). Returns the lines main accepted."""
        if not self._spool_dir or not self.usable:
            return 0
        accepted = 0
        for path in sorted(glob.glob(os.path.join(self._spool_dir, "*.jsonl"))):
            if path == self.wal_path:
                continue
            accepted += self._replay_one(path)
        legacy = os.path.join(os.path.dirname(self._spool_dir), "iclone-perm-spool.jsonl")
        if os.path.exists(legacy):
            self._report_unverifiable(legacy, "a round-1 unsigned spool", self._count_lines(legacy))
        return accepted

    @staticmethod
    def _count_lines(path: str) -> int:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                return sum(1 for line in handle if line.strip())
        except OSError:
            return 0

    def _replay_one(self, path: str) -> int:
        try:
            fd = os.open(path, os.O_RDWR)
        except OSError:
            return 0
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                return 0  # its writer is alive
            with os.fdopen(os.dup(fd), "r", encoding="utf-8", errors="replace") as handle:
                lines: List[str] = [line for line in handle if line.strip()]
            accepted, unverifiable = 0, 0
            for line in lines:
                text = line.strip()
                mac = self.sign("replay", text)
                answer = self._request("replay", text, mac, _SEND_TIMEOUT)
                if not answer.ok:
                    return accepted  # main went away: keep the file for the next try
                if answer.code == 0:
                    accepted += 1
                else:
                    unverifiable += 1
            os.unlink(path)
            if unverifiable:
                logger.warning("iclone-permissions: %d orphan lines in %s were not accepted by main", unverifiable, path)
            return accepted
        finally:
            os.close(fd)

    def _report_unverifiable(self, path: str, what: str, lines: int) -> None:
        if lines:
            text = json.dumps({"what": what, "lines": lines, "pid": self._pid, "keyId": self._key_id},
                              separators=(",", ":"))
            if not self._request("gapnote", text, self.sign("gapnote", text), _SEND_TIMEOUT).ok:
                return
        try:
            os.unlink(path)
        except OSError:
            pass
