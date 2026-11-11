"""V3-F §2 — the signed policy main writes for this Hermes spawn, and the mode table read from it.

The table is NOT re-implemented here: it arrives in the signed body (electron/iclone-permissions/modes.ts is
the one source). This module only evaluates a cell's footnote against the classifier's facts, exactly as
``decide`` does in TypeScript; tests/test_policy.py holds the two equal on the shared fixture.
V3-F2: the per-function levels (``functions`` in the signed body) override the mode for the functions a call
touches (``functions.py`` maps a call to them); ``decide`` without ``fns`` is V3-F's code path, unchanged.
A missing, unreadable or mis-signed file is not an error to work around: the plugin runs Manual. So is a body OLDER
than one this process already saw or main announced (``gen``, F-5): a replayed policy would bring back a revoked grant.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import threading
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Sequence

MANUAL_TABLE_ROW = {"R": "A", "Wp": "Q", "Wo": "Q", "X": "Q", "N": "Q", "$": "Q", "M": "Q", "S": "Q", "I": "Q", "D": "Q"}

# V3-F2 — the functions and levels (electron/iclone-permissions/functions.ts is the source; tests/fixtures/functions.json
# holds the two equal). Function order breaks ties between equally strict candidates.
FUNCTIONS = ("email", "payments", "trading", "shopping", "acp", "messaging", "shell", "files", "publish")
LEVELS = ("mode", "ignore", "automatic", "askOnce", "askAlways", "manual")
# V3-F2 lead contingency (r5) — one flag, main's `F2_LOOSENING_ENABLED` (iclone-shared/permissions.ts; the fixture holds
# the two equal). False ships Functions as tightening only: a loosening level in the body is read as Follow mode.
F2_LOOSENING_ENABLED = True
LOOSENING_LEVELS = ("ignore", "automatic", "askOnce")


def level_of(raw: Any) -> str:
    """A row's level as the plugin decides it: absent is Follow mode, malformed is Ask always, and — with the
    loosening levels off — a loosening level is Follow mode."""
    level = "mode" if raw is None else (raw if raw in LEVELS else "askAlways")
    return "mode" if not F2_LOOSENING_ENABLED and level in LOOSENING_LEVELS else level


def _level_row(cell: str) -> Dict[str, str]:
    # Reading belongs to no function and is free at every level.
    return {cls: ("A" if cls == "R" else cell) for cls in MANUAL_TABLE_ROW}


LEVEL_CELLS: Dict[str, Dict[str, str]] = {
    "ignore": _level_row("A"),
    "automatic": {"R": "A", "Wp": "A", "Wo": "Q", "X": "A:safe", "N": "A", "$": "A:clean", "M": "A:clean", "S": "Q",
                  "I": "A:unprivileged", "D": "A:project"},
    "askOnce": _level_row("Q"),
    "askAlways": _level_row("Q"),
    "manual": _level_row("R!"),
}
_SEVERITY = {"allow": 0, "ask": 1, "refuse": 2}
# R2-m4: an ask tie goes to the stricter level (functions.ts ASK_TIE): Ask always > Ask once > the mode.
_ASK_TIE = {"ignore": 0, "automatic": 0, "mode": 1, "askOnce": 2, "manual": 3, "askAlways": 4}


@dataclass(frozen=True)
class Verdict:
    outcome: str  # allow | ask | refuse
    rule: str  # floor | ceiling | mode | grant | unsigned
    mode: str
    grant_id: Optional[str] = None
    fn: Optional[str] = None  # V3-F2: the function whose level decided (the strictest candidate)
    level: Optional[str] = None
    floor: Optional[str] = None  # F40: the floor that refused in Ignore, from the line or a part it read


class SignedPolicy:
    """mtime-keyed cache of the verified body. ``body`` is ``None`` when the file is absent, forged or replayed."""

    def __init__(self, path: Optional[str], key: Optional[bytes]):
        self._path = path
        self._key = key
        self._lock = threading.Lock()
        self._stamp: Optional[tuple] = None
        self._body: Optional[Dict[str, Any]] = None
        # The newest generation seen in a verified body or announced by main; anything older is a replay.
        self._min_gen = 0

    def raise_floor(self, gen: Any) -> None:
        """Main's current generation (hello / heartbeat answers): a file older than it is not trusted."""
        if isinstance(gen, int) and not isinstance(gen, bool):
            with self._lock:
                if gen > self._min_gen:
                    self._min_gen = gen
                    self._stamp = None

    def body(self) -> Optional[Dict[str, Any]]:
        if not self._path or not self._key:
            return None
        try:
            st = os.stat(self._path)
        except OSError:
            return None
        stamp = (st.st_mtime_ns, st.st_size, st.st_ino)
        with self._lock:
            if stamp != self._stamp:
                self._stamp = stamp
                body = self._read()
                gen = body.get("gen") if body else None
                if body is None or not isinstance(gen, int) or isinstance(gen, bool) or gen < self._min_gen:
                    self._body = None
                else:
                    self._min_gen = gen
                    self._body = body
            return self._body

    def _read(self) -> Optional[Dict[str, Any]]:
        try:
            with open(self._path, "r", encoding="utf-8") as handle:
                envelope = json.loads(handle.read())
            text = envelope["body"]
            expected = hmac.new(self._key, text.encode("utf-8"), hashlib.sha256).hexdigest()
            if not isinstance(envelope.get("sig"), str) or not hmac.compare_digest(expected, envelope["sig"]):
                return None
            body = json.loads(text)
            return body if isinstance(body, dict) and body.get("v") == 1 else None
        except (OSError, ValueError, KeyError, TypeError):
            return None


def _cell_outcome(cell: str, facts: Mapping[str, bool]) -> str:
    if cell == "A":
        return "allow"
    if cell == "Q":
        return "ask"
    if cell == "A:safe":
        return "allow" if facts.get("dangerous") is False else "ask"
    if cell == "A:clean":  # V3-F2 levels only: a structured call (no shell text) is clean
        return "ask" if facts.get("dangerous") is True else "allow"
    if cell == "A:get":
        return "allow" if facts.get("getOnly") is True else "refuse"
    if cell == "A:project":
        return "allow" if facts.get("inProject") is True else "ask"
    if cell == "A:unprivileged":
        return "allow" if facts.get("privileged") is False else "ask"
    return "refuse"


# F40, L1, the owner's "liberta tudo": in Ignore all the one floor is total destruction, or text too unreadable to check.
# Moving an iNFT, sending keys, the admin password and the agent's own permissions leave the floor in Ignore all only:
# in every other mode they ask, whatever the cell or a grant says, and what is approved runs.
TOTAL_DESTRUCTION = "hardline: total destruction"
# F53: a delete only known when it runs asks outside Ignore, and is refused in Ignore with how to write it.
UNRESOLVED_DELETE_FLOOR = "unresolved delete:"
# G28: system permissions and stopping icloneOS ask too, as the owner ordered for the modes that ask; Ignore runs them.
_ASKING_FLOORS = ("inft:", "secrets:", "sudo:", "policy:", "privilege:", "confinement:", UNRESOLVED_DELETE_FLOOR)
# g28b: G28 moved stopping icloneOS, read or not. A program word it cannot resolve beside a payment binary is not a stop
# and keeps its refusal outside Ignore. Mirror of modes.ts UNREAD_CONFINEMENT_FLOOR.
UNREAD_CONFINEMENT_FLOOR = "confinement: a command this gate cannot read sits beside a payment binary"
# G28: the owner's order. Shutdown, reboot, kill-all and a fork bomb are hardlines outside total destruction: they ask, and
# what is approved runs. Only total destruction refuses in every mode. Mirror of modes.ts floorAsks.
HARDLINE_FLOOR = "hardline:"
# G28: with the Seatbelt off nothing else stands before this read. It asks where the mode asks, and Plan, which only reads
# freely, refuses it: an ask there would hand keys to a mode that promises to change nothing. Mirror of modes.ts.
CREDENTIAL_READ_FLOOR = "secrets: reading a key or credential file with the Seatbelt off"


def is_total_destruction(floor: Optional[str]) -> bool:
    return bool(floor) and str(floor).startswith((TOTAL_DESTRUCTION, "unreadable:"))


def ignore_refuses(floor: Optional[str]) -> bool:
    """F40: the floors Ignore still refuses, for a tool call and for a scheduled job's script alike."""
    return is_total_destruction(floor) or str(floor or "").startswith(UNRESOLVED_DELETE_FLOOR)


def floor_asks(floor: Optional[str]) -> bool:
    if str(floor or "").startswith(UNREAD_CONFINEMENT_FLOOR):
        return False
    return bool(floor) and (str(floor).startswith(_ASKING_FLOORS) or (str(floor).startswith(HARDLINE_FLOOR) and not is_total_destruction(floor)))


def decide_cell(cell: str, facts: Mapping[str, bool], *, cls: str, floor: Optional[str], ceiling: Optional[str], granted: bool) -> tuple:
    """Mirror of modes.ts ``decide``: floor, ceiling OFF, the cell, undecided ceiling, grant."""
    if floor_asks(floor):
        if ceiling == "off" or _cell_outcome(cell, facts) == "refuse":
            return "refuse", "ceiling" if ceiling == "off" else "mode"
        return "ask", "floor"
    if floor:
        return "refuse", "floor"
    if ceiling == "off":
        return "refuse", "ceiling"
    outcome = _cell_outcome(cell, facts)
    if outcome == "allow" and ceiling == "undecided" and cls != "R":
        return ("allow", "grant") if granted else ("ask", "ceiling")
    if outcome == "ask" and granted:
        return "allow", "grant"
    return outcome, "mode"


def _sessions(session_id: Optional[str], lineage: Optional[Sequence[str]]) -> list:
    """The call's session first, then its parents up to the root (§2: delegated and compressed sessions inherit)."""
    chain = [sid for sid in (lineage or []) if isinstance(sid, str) and sid]
    return chain or ([session_id] if session_id else [])


def effective_mode(body: Mapping[str, Any], session_id: Optional[str], project: Optional[str],
                   lineage: Optional[Sequence[str]] = None) -> str:
    sessions = body.get("sessions") or {}
    projects = body.get("projects") or {}
    for sid in _sessions(session_id, lineage):
        if sessions.get(sid):
            return sessions[sid]
    return (project and projects.get(project)) or body.get("standing") or "manual"


def session_has_own_mode(body: Mapping[str, Any], session_id: Optional[str],
                         lineage: Optional[Sequence[str]] = None) -> bool:
    """A mode on the session or a parent: it beats the project and the standing mode, and Settings writes neither it nor them."""
    sessions = body.get("sessions") or {}
    return any(sessions.get(sid) for sid in _sessions(session_id, lineage))


def matching_grant(body: Mapping[str, Any], cls: str, session_id: Optional[str], project: Optional[str],
                   lineage: Optional[Sequence[str]] = None) -> Optional[str]:
    if cls == "$":
        return None
    grants = [g for g in body.get("grants") or [] if isinstance(g, dict) and g.get("cls") == cls]
    chain = _sessions(session_id, lineage)
    for grant in grants:
        if grant.get("scope") == "session" and grant.get("sessionId") in chain:
            return str(grant.get("id"))
    for grant in grants:
        if grant.get("scope") == "project" and project and grant.get("project") == project:
            return str(grant.get("id"))
    for grant in grants:
        if grant.get("scope") == "standing":
            return str(grant.get("id"))
    return None


def matching_fn_grant(body: Mapping[str, Any], fn: str, session_id: Optional[str], project: Optional[str],
                      lineage: Optional[Sequence[str]] = None) -> Optional[str]:
    """V3-F2: a grant the owner gave this FUNCTION on an Ask once sheet (any class, spending included)."""
    grants = [g for g in body.get("fnGrants") or [] if isinstance(g, dict) and g.get("fn") == fn]
    chain = _sessions(session_id, lineage)
    for grant in grants:
        if grant.get("scope") == "session" and grant.get("sessionId") in chain:
            return str(grant.get("id"))
    for grant in grants:
        if grant.get("scope") == "project" and project and grant.get("project") == project:
            return str(grant.get("id"))
    for grant in grants:
        if grant.get("scope") == "standing":
            return str(grant.get("id"))
    return None


def _level_term(body: Mapping[str, Any], fn: str, level: str, mode: str, cls: str, facts: Mapping[str, bool],
                floor: Optional[str], ceiling: Optional[str], class_grant: Optional[str], session_id: Optional[str],
                project: Optional[str], lineage: Optional[Sequence[str]], unread: bool = False,
                switch_off: bool = False) -> Verdict:
    """One user level on one class (the line's or a part's), in V3-F's order: floor, switch OFF, cell, undecided
    switch, grant. Ask always and Manual take no standing grant; the others a grant for the function or the class.
    R4-UNREAD: on an unread call the cell never allows (it asks) and no grant lifts the ask (main's ``levelTerm``).
    R5-D (d): an unread call may touch every function, so it meets every switch — one OFF anywhere refuses it."""
    cell = LEVEL_CELLS[level][cls] if cls in LEVEL_CELLS[level] else "Q"
    if unread and switch_off:
        ceiling = "off"
    if unread and not floor and ceiling != "off" and _cell_outcome(cell, facts) == "allow":
        return Verdict("ask", "function", mode, None, fn, level)
    granted_by = None if unread or level in ("askAlways", "manual") else (
        matching_fn_grant(body, fn, session_id, project, lineage) or class_grant)
    outcome, rule = decide_cell(cell, facts, cls=cls, floor=floor, ceiling=ceiling, granted=granted_by is not None)
    rule = "function" if rule == "mode" else rule
    return Verdict(outcome, rule, mode, granted_by if rule == "grant" else None, fn, level)


def _part_ceiling(body: Mapping[str, Any], part: Any) -> Optional[str]:
    """A part's switch, as the line's is read: its own key, else its class's; a switch the body does not name is
    undecided."""
    key = part.ceiling_key or (body.get("ceilingKey") or {}).get(part.cls)
    return ((body.get("ceilings") or {}).get(key) or "undecided") if key else None


def _ordered(fns: Optional[Sequence[str]]) -> list:
    wanted = set(fns or ())
    return [fn for fn in FUNCTIONS if fn in wanted]


def decide(body: Optional[Mapping[str, Any]], *, cls: str, facts: Mapping[str, bool], floor: Optional[str],
           ceiling_key: Optional[str], session_id: Optional[str], project: Optional[str],
           lineage: Optional[Sequence[str]] = None, fns: Optional[Sequence[str]] = None,
           mode_project: Any = "") -> Verdict:
    """The plugin's local decision. Unsigned ⇒ Manual, and every ask goes to main, which decides again. F50, S5:
    ``mode_project`` is the session's own window project, the only project whose row can set the mode; ``project`` is
    where the call lands and only matches grants. Callers with no session (the launcher's ceiling) leave it out."""
    if body is None:
        outcome, rule = decide_cell(MANUAL_TABLE_ROW.get(cls, "Q"), facts, cls=cls, floor=floor, ceiling=None, granted=False)
        return Verdict(outcome, "floor" if rule == "floor" else "unsigned", "manual")
    mode = effective_mode(body, session_id, project if mode_project == "" else mode_project, lineage)
    # F40 (owner, G-98): in Ignore only a floor decides, on the line or on any part read. No switch, level, grant or
    # unread reading can bring an ask back; main's decideFunctions reads it the same way.
    if mode == "ignore":
        named = next((one for one in (floor, *(part.floor for part in (getattr(fns, "parts", None) or ())))
                      if ignore_refuses(one)), None)
        return Verdict("refuse", "floor", mode, floor=named) if named else Verdict("allow", "mode", mode)
    table = body.get("table") or {}
    cell = "R!" if mode == "plan" and floor == CREDENTIAL_READ_FLOOR else str((table.get(mode) or MANUAL_TABLE_ROW).get(cls, "Q"))
    key = ceiling_key or (body.get("ceilingKey") or {}).get(cls)
    # A switch the body does not name is undecided, never ON.
    ceiling = ((body.get("ceilings") or {}).get(key) or "undecided") if key else None
    grant_id = matching_grant(body, cls, session_id, project, lineage)
    levels = body.get("functions") or {}
    levels = levels if isinstance(levels, Mapping) else {}
    # R4-UNREAD: a call that is not fully read (``functions.Functions.unread``) is decided by every row at a user level
    # — none of them allows it without an ask — whatever functions it names. Reading stays free. R5-D: it keeps
    # everything known — the whole line (b), every part it read (c), every switch it could meet (d), Manual (e).
    unread = bool(getattr(fns, "unread", False)) and cls != "R"
    switch_off = unread and any(value == "off" for value in (body.get("ceilings") or {}).values())
    candidates = _ordered(list(fns or ()) + ([fn for fn in FUNCTIONS if level_of(levels.get(fn)) != "mode"]
                                             if unread else []))
    if not candidates:
        outcome, rule = decide_cell(cell, facts, cls=cls, floor=floor, ceiling=ceiling, granted=grant_id is not None)
        return Verdict(outcome, rule, mode, grant_id if rule == "grant" else None)
    # V3-F2: every candidate function decides with its own level; the strictest wins (an ask tie: the stricter
    # level; other ties: function order). R3-MONO: a row at a user level decides on the whole line AND on every part
    # of it that touches the row (``functions.Part``: the part's own class, facts, floor and switch), the strictest
    # term wins — so the class another part gives the whole line never lowers what a part decides on its own. A row
    # at `mode` is V3-F's decision on the whole line (the shipped default: bit-identical to V3-F) — and, R5-D, V3-F's
    # decision on every part read that touches it. Every part read is a term, unread or not (R5-D (c)).
    parts = tuple(getattr(fns, "parts", None) or ())
    winner: Optional[Verdict] = None
    for fn in candidates:
        level = level_of(levels.get(fn))
        if level == "mode":
            outcome, rule = decide_cell(cell, facts, cls=cls, floor=floor, ceiling=ceiling, granted=grant_id is not None)
            one = Verdict(outcome, rule, mode, grant_id if rule == "grant" else None, fn, level)
            # R5-D: Follow mode decides V3-F on every part read that touches the row too (its class, facts, floor,
            # switch — OFF refuses, undecided asks — and class grant); the strictest term wins
            for part in parts:
                if fn not in part.fns:
                    continue
                part_grant = matching_grant(body, part.cls, session_id, project, lineage)
                p_out, p_rule = decide_cell(str((table.get(mode) or MANUAL_TABLE_ROW).get(part.cls, "Q")),
                                            dict(part.facts), cls=part.cls, floor=part.floor,
                                            ceiling=_part_ceiling(body, part), granted=part_grant is not None)
                if _SEVERITY[p_out] > _SEVERITY[one.outcome]:
                    one = Verdict(p_out, p_rule, mode, part_grant if p_rule == "grant" else None, fn, level)
        else:
            one = _level_term(body, fn, level, mode, cls, facts, floor, ceiling, grant_id, session_id, project, lineage,
                              unread, switch_off)
            for part in parts:
                if fn not in part.fns:
                    continue
                term = _level_term(body, fn, level, mode, part.cls, dict(part.facts), part.floor,
                                   _part_ceiling(body, part),
                                   matching_grant(body, part.cls, session_id, project, lineage), session_id, project,
                                   lineage, unread, switch_off)
                if _SEVERITY[term.outcome] > _SEVERITY[one.outcome]:
                    one = term
        if winner is None or _SEVERITY[one.outcome] > _SEVERITY[winner.outcome] or (
                one.outcome == winner.outcome == "ask" and _ASK_TIE[one.level] > _ASK_TIE[winner.level]):
            winner = one
    return winner  # type: ignore[return-value]
