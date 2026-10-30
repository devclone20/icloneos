#!/usr/bin/env python3
"""bgjob.py — long machine work in the background, 0 tokens while it runs.
  bgjob.py start <name> -- <cmd...>   detach (own session/process group), log -> CONTROL/local.nosync/jobs/<name>.log
  bgjob.py wait  <name> [--max S]     block up to S s (default 540); prints <= 8 lines:
                                      `JOB <name> <state> rc=.. secs=.. log=..` + RESULT_JSON line if the job printed one,
                                      else the last <= 6 log lines.  exit 0 ok · 1 job failed · 124 still running · 2 unknown
  bgjob.py status                     one line per registered job (running/done/failed/killed/dead)
  bgjob.py kill  <name>               SIGTERM (then SIGKILL after 10 s) to the job's own process group — only for jobs
                                      this tool registered, verified by the supervisor's command line; never anything else.
Records: CONTROL/local.nosync/jobs/<name>.json (meta, written once by `start`) and <name>.state.json (supervisor)."""
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
JOBS = Path(os.environ.get("BGJOB_DIR") or ROOT / "CONTROL" / "local.nosync" / "jobs").resolve()
NAME_RX = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def die(msg, code=2):
    print(f"bgjob: {msg}", file=sys.stderr)
    sys.exit(code)


def wjson(p, obj):
    tmp = p.with_name(f".{p.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(obj, indent=1))
    os.replace(tmp, p)


def rjson(p):
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return None


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def proc_cmd(pid):
    try:
        return subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True,
                              timeout=5).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def supervisor_ours(meta, name):
    pid = meta.get("pid")
    return bool(pid) and alive(pid) and f"bgjob.py _run {name} " in proc_cmd(pid) + " "


def paths(name):
    if not NAME_RX.match(name):
        die(f"bad job name {name!r} (allowed: [A-Za-z0-9._-], <= 64)")
    return JOBS / f"{name}.json", JOBS / f"{name}.state.json", JOBS / f"{name}.log"


def state_of(name):
    mp, sp, lp = paths(name)
    meta = rjson(mp)
    if not isinstance(meta, dict):
        return None, None, "unknown"
    st = rjson(sp)
    st = st if isinstance(st, dict) else {}  # half-written / foreign state file -> treat as no state
    if "rc" in st:
        if st.get("killed"):
            s = "killed"
        else:
            s = "done" if st["rc"] == 0 else "failed"
    elif supervisor_ours(meta, name):
        s = "running"
    else:
        s = "dead"  # supervisor gone without recording an exit (reboot / SIGKILL)
    return meta, st, s


def cmd_start(name, cmd):
    if not cmd:
        die("usage: bgjob.py start <name> -- <cmd...>")
    JOBS.mkdir(parents=True, exist_ok=True)
    mp, sp, lp = paths(name)
    meta, st, s = state_of(name)
    if s == "running":
        die(f"job {name} is already running (pid {meta['pid']})", 3)
    for p in (sp, lp):
        if p.exists():
            p.unlink()
    sup = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "_run", name, "--"] + cmd,
                           cwd=os.getcwd(), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
    meta = {"name": name, "pid": sup.pid, "pgid": sup.pid, "cmd": cmd, "cwd": os.getcwd(), "log": str(lp),
            "started": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "t0": time.time(), "by": "bgjob.py"}
    wjson(mp, meta)
    print(f"JOB {name} started pid={sup.pid} log={lp}")


def cmd_run(name, cmd):
    """Supervisor (session leader): runs cmd in its own process group, records rc."""
    mp, sp, lp = paths(name)
    killed = {"v": False}

    def on_term(signum, frame):
        killed["v"] = True  # the child is in our process group and gets the same signal; keep waiting for it
    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGHUP, on_term)
    t0 = time.time()
    with open(lp, "ab", buffering=0) as log:
        try:
            child = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        except OSError as e:
            log.write(f"bgjob: cannot start {cmd!r}: {e}\n".encode())
            wjson(sp, {"rc": 127, "secs": 0, "ended": time.strftime("%Y-%m-%dT%H:%M:%S%z")})
            return
        wjson(sp, {"child_pid": child.pid})
        rc = child.wait()
    wjson(sp, {"child_pid": child.pid, "rc": rc, "killed": killed["v"] or rc < 0,
               "secs": round(time.time() - t0, 1), "ended": time.strftime("%Y-%m-%dT%H:%M:%S%z")})


def tail_lines(p, n):
    try:
        with open(p, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 256 * 1024))
            data = f.read().decode("utf-8", "replace")
    except OSError:
        return [], None
    lines = [ln.rstrip("\r") for ln in data.split("\n")]
    res = next((ln for ln in reversed(lines) if ln.startswith("RESULT_JSON")), None)
    lines = [ln for ln in lines if ln.strip()]
    return [ln[:200] for ln in lines[-n:]], res


def head_line(name, meta, st, s):
    secs = st.get("secs") if "secs" in (st or {}) else round(time.time() - meta.get("t0", time.time()))
    rc = st.get("rc", "-") if st else "-"
    return f"JOB {name} {s} rc={rc} secs={secs} log={meta.get('log')}"


def cmd_wait(name, maxs):
    meta, st, s = state_of(name)
    if meta is None:
        die(f"unknown job {name}")
    t_end = time.time() + maxs
    while s == "running" and time.time() < t_end:
        time.sleep(min(2.0, max(0.05, t_end - time.time())))
        meta, st, s = state_of(name)
    print(head_line(name, meta, st, s))
    lines, res = tail_lines(meta["log"], 6 if s != "running" else 3)
    if res and s != "running":
        print(res[:4000])
    else:
        for ln in lines:
            print("  " + ln)
    if s == "running":
        print(f"  (still running; bgjob.py wait {name} --max {maxs:g})")
        sys.exit(124)
    sys.exit(0 if s == "done" else 1)


def cmd_status():
    JOBS.mkdir(parents=True, exist_ok=True)
    names = sorted(p.name[:-5] for p in JOBS.glob("*.json") if not p.name.endswith(".state.json"))
    if not names:
        print("no jobs")
    for n in names:
        meta, st, s = state_of(n)
        if meta:
            print(head_line(n, meta, st, s).replace(f" log={meta.get('log')}", "") + f" cmd={' '.join(meta['cmd'])[:80]}")


def cmd_kill(name):
    meta, st, s = state_of(name)
    if meta is None:
        die(f"unknown job {name} (bgjob only kills jobs it registered)")
    pgid = meta["pgid"]
    if s == "running":
        target = pgid
    else:
        # supervisor gone: kill the recorded child's group only if it is still ours (same pgid, same command)
        cp = (st or {}).get("child_pid")
        target = None
        if cp and alive(cp) and "rc" not in (st or {}):
            try:
                if os.getpgid(cp) == pgid and os.path.basename(meta["cmd"][0]) in proc_cmd(cp):
                    target = pgid
            except ProcessLookupError:
                pass
        if target is None:
            print(f"JOB {name} {s} (nothing to kill)")
            return
    try:
        os.killpg(target, signal.SIGTERM)
    except ProcessLookupError:
        pass
    t_end = time.time() + 10
    while time.time() < t_end:
        try:
            os.killpg(target, 0)
        except ProcessLookupError:
            break
        time.sleep(0.25)
    else:
        try:
            os.killpg(target, signal.SIGKILL)
        except ProcessLookupError:
            pass
    time.sleep(0.3)
    meta, st, s = state_of(name)
    print(head_line(name, meta, st, s))


def main():
    a = sys.argv[1:]
    if not a:
        die(__doc__, 64)
    op = a[0]
    if op == "start":
        if len(a) < 2:
            die("usage: bgjob.py start <name> -- <cmd...>", 64)
        rest = a[2:]
        cmd_start(a[1], rest[1:] if rest and rest[0] == "--" else rest)
    elif op == "_run":
        rest = a[2:]
        cmd_run(a[1], rest[1:] if rest and rest[0] == "--" else rest)
    elif op == "wait":
        if len(a) < 2:
            die("usage: bgjob.py wait <name> [--max S]", 64)
        maxs = 540.0
        if "--max" in a:
            maxs = float(a[a.index("--max") + 1])
        cmd_wait(a[1], maxs)
    elif op == "status":
        cmd_status()
    elif op == "kill":
        if len(a) < 2:
            die("usage: bgjob.py kill <name>", 64)
        cmd_kill(a[1])
    else:
        die(f"unknown op {op}\n{__doc__}", 64)


if __name__ == "__main__":
    main()
