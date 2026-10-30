#!/usr/bin/env python3
"""Provider spec of the Hermes runtime at one revision (RESUME/contracts/P4_upstream.md decision 6, spec@1).

  python3 -B iclone/contract/served.py --runtime <checkout> --out <spec.json> [--lock <runtime.lock.json>]
  python3 -B iclone/contract/served.py --repo <app repo> --rev <rev> --out <spec.json> [--lock <runtime.lock.json>]

--runtime reads the checkout's HEAD from FILES only (.git/HEAD, refs, packed-refs, the working tree): no git process
ever touches the runtime, which is a blob:none promisor clone. --repo reads any other revision from the APP repo's
`upstream` objects through git() below (GIT_NO_LAZY_FETCH=1, GIT_OPTIONAL_LOCKS=0; never status/fetch).
Tier T1 is the OpenRPC document; T2 is an AST pass (stdlib ast, runtime code is never imported) used alone for
pre-contract revisions and as the T2-subset-of-T1 drift check. --lock prunes `schemas` to what the lock references.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import multiprocessing
import os
import re
import subprocess
import sys
import tarfile
import warnings
from concurrent.futures import ProcessPoolExecutor
from urllib.parse import urlsplit

OPENRPC = "apps/shared/src/gateway-contract.openrpc.json"
STATE_DB = "hermes_state_common.py"
STATE_CFG = "hermes_cli/config_defaults.py"
PARALLEL_MIN_FILES = 64
NAME_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$")
METHOD_FUNCS = {"method", "register_method", "_register_method", "rpc_method"}
EMIT_FUNCS = {"_emit", "emit", "_enqueue", "emit_event", "send_event"}
MARKERS = ("method(", "emit", "_enqueue", "APIRouter", "add_argument(", "DEFAULT_CONFIG", "CODE")
SKIP = {"node_modules", "venv", "tests", "__pycache__", "site-packages", "apps", "website", "docs", "skills", "optional-skills",
        "evals", "environments", "assets", "docker", "contributors", "scripts", "hermes_agent.egg-info"}


# ---------------------------------------------------------------- sources

def skipped(rel: str) -> bool:
    parts = rel.split("/")
    return parts[-1].startswith("test_") or any(p in SKIP or p.startswith(".") for p in parts[:-1])


GIT_ENV_DROP = ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
                "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CEILING_DIRECTORIES", "GIT_CONFIG_PARAMETERS",
                "GIT_CONFIG_COUNT")
PROMISOR_RE = re.compile(r"^\s*(promisor\s*=\s*(true|yes|on|1)\b|partialclone(filter)?\s*=)", re.I | re.M)


def git_env() -> dict:
    env = {k: v for k, v in os.environ.items()
           if k not in GIT_ENV_DROP and not k.startswith(("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"))}
    return {**env, "GIT_NO_LAZY_FETCH": "1", "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"}


def git(repo: str, *args: str, binary: bool = False, stdin: bytes | None = None):
    r = subprocess.run(["git", "-C", repo, *args], input=stdin, capture_output=True, env=git_env())
    if r.returncode != 0:
        return None
    return r.stdout if binary else r.stdout.decode("utf-8", "replace")


def _git_dir(start: str) -> str | None:
    """The git dir git itself would discover from `start` (worktree `.git` files and bare dirs included)."""
    d = os.path.realpath(start)
    while True:
        dot = os.path.join(d, ".git")
        if os.path.isdir(dot):
            return dot
        if os.path.isfile(dot):
            with open(dot, encoding="utf-8", errors="replace") as fh:
                m = re.match(r"gitdir:\s*(.+)", fh.read().strip())
            return os.path.realpath(os.path.join(d, m.group(1))) if m else None
        if os.path.isfile(os.path.join(d, "HEAD")) and os.path.isdir(os.path.join(d, "objects")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def _config_texts(roots: list) -> list:
    """Every config file git would read for the repo, `[include]` and `[includeIf]` targets followed recursively.

    Every includeIf condition counts as met (fail closed): the guard must see a promisor setting before git runs."""
    out, seen, todo = [], set(), [os.path.realpath(p) for p in roots]
    while todo and len(seen) < 64:
        cfg = todo.pop(0)
        if cfg in seen:
            continue
        seen.add(cfg)
        try:
            with open(cfg, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            continue
        out.append((cfg, text))
        section = ""
        for line in text.splitlines():
            line = line.split("#", 1)[0].split(";", 1)[0].strip()
            m = re.match(r"\[\s*([A-Za-z0-9.-]+)", line)
            if m:
                section = m.group(1).lower()
                line = line[line.index("]") + 1:].strip() if "]" in line else ""
            kv = re.match(r"path\s*=\s*(.+)", line, re.I)
            if section in ("include", "includeif") and kv:
                target = os.path.expanduser(kv.group(1).strip().strip('"'))
                todo.append(os.path.realpath(os.path.join(os.path.dirname(cfg), target)))
    return out


def guard_repo(repo: str) -> None:
    """Decision 7: --repo never runs git on the runtime clone or on any promisor (lazy-fetching) checkout."""
    real = os.path.realpath(repo)
    homes = {os.path.expanduser("~")}
    try:
        import pwd
        homes.add(pwd.getpwuid(os.getuid()).pw_dir)
    except (ImportError, KeyError):
        pass
    for h in homes:
        hermes = os.path.realpath(os.path.join(h, ".hermes"))
        if real == hermes or real.startswith(hermes + os.sep):
            raise SystemExit(f"served.py: refusing --repo under the runtime home {hermes}; use --runtime (files only)")
    gd = _git_dir(real)
    if gd is None:
        raise SystemExit(f"served.py: --repo {repo} is not a git checkout")
    common = gd
    cd = os.path.join(gd, "commondir")
    if os.path.isfile(cd):
        with open(cd, encoding="utf-8", errors="replace") as fh:
            common = os.path.realpath(os.path.join(gd, fh.read().strip()))
    for cfg, text in _config_texts([os.path.join(gd, "config"), os.path.join(common, "config"),
                                    os.path.join(gd, "config.worktree")]):
        if PROMISOR_RE.search(text):
            raise SystemExit(f"served.py: refusing --repo on a promisor checkout ({cfg}): it would lazy-fetch blobs")
    packs = os.path.join(common, "objects", "pack")
    if os.path.isdir(packs) and any(f.endswith(".promisor") for f in os.listdir(packs)):
        raise SystemExit(f"served.py: refusing --repo on a promisor checkout ({packs}/*.promisor)")


class TreeSource:
    """HEAD of a runtime checkout, read as files."""

    def __init__(self, root: str):
        self.root = root
        gd = os.path.join(root, ".git")
        head = self._read_text(os.path.join(gd, "HEAD")).strip()
        self.rev = head
        refs = self._refs(gd)
        if head.startswith("ref: "):
            self.rev = refs.get(head[5:], "")
        tags = sorted(n[len("refs/tags/"):] for n, s in refs.items() if n.startswith("refs/tags/") and s == self.rev)
        self.describe = tags[-1] if tags else f"g{self.rev[:12]}"

    @staticmethod
    def _read_text(p: str) -> str:
        try:
            with open(p, encoding="utf-8") as fh:
                return fh.read()
        except OSError:
            return ""

    def _refs(self, gd: str) -> dict:
        refs = {}
        for line in self._read_text(os.path.join(gd, "packed-refs")).splitlines():
            parts = line.split()
            if len(parts) == 2 and not line.startswith(("#", "^")):
                refs[parts[1]] = parts[0]
        for base in ("refs/heads", "refs/tags"):
            for dp, _, fns in os.walk(os.path.join(gd, base)):
                for fn in fns:
                    p = os.path.join(dp, fn)
                    refs[os.path.relpath(p, gd).replace(os.sep, "/")] = self._read_text(p).strip()
        return refs

    def read(self, rel: str) -> bytes | None:
        try:
            with open(os.path.join(self.root, rel), "rb") as fh:
                return fh.read()
        except OSError:
            return None

    def listdir(self, rel: str) -> list:
        base = os.path.join(self.root, rel)
        return sorted(d for d in os.listdir(base) if os.path.isdir(os.path.join(base, d))) if os.path.isdir(base) else []

    def python_files(self) -> dict:
        out = {}
        for dp, dns, fns in os.walk(self.root):
            dns[:] = [d for d in dns if d not in SKIP and not d.startswith(".")]
            for fn in fns:
                if fn.endswith(".py") and not fn.startswith("test_"):
                    p = os.path.join(dp, fn)
                    try:
                        with open(p, encoding="utf-8", errors="replace") as fh:
                            text = fh.read()
                    except OSError:
                        continue
                    if any(m in text for m in MARKERS):
                        out[os.path.relpath(p, self.root).replace(os.sep, "/")] = text
        return out


class RepoSource:
    """Any revision of the APP repo's upstream objects (full objects, never the runtime clone)."""

    def __init__(self, repo: str, rev: str):
        guard_repo(repo)
        self.repo = repo
        sha = git(repo, "rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}")
        if not sha:
            raise SystemExit(f"served.py: unknown revision {rev}")
        self.rev = sha.strip()
        self.describe = (git(repo, "describe", "--tags", "--always", self.rev) or self.rev[:12]).strip()

    def archive(self, dest: str) -> int:
        """Decision 13: the canary's sandbox tree, streamed from `git archive` (never a checkout); returns the file count."""
        p = subprocess.Popen(["git", "-C", self.repo, "archive", "--format=tar", self.rev], stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, env=git_env())
        n = 0
        with tarfile.open(fileobj=p.stdout, mode="r|") as tf:
            for member in tf:
                tf.extract(member, dest, filter="data")
                n += member.isfile()
        if p.wait() != 0:
            raise SystemExit(f"served.py: git archive failed at {self.rev}")
        return n

    def read(self, rel: str) -> bytes | None:
        return git(self.repo, "show", f"{self.rev}:{rel}", binary=True)

    def listdir(self, rel: str) -> list:
        listing = git(self.repo, "ls-tree", "-d", "--name-only", self.rev, rel.rstrip("/") + "/") or ""
        return sorted(ln.rsplit("/", 1)[-1] for ln in listing.splitlines() if ln.strip())

    def python_files(self) -> dict:
        pat = "|".join(re.escape(m) for m in MARKERS)
        listing = git(self.repo, "grep", "-l", "-E", pat, self.rev, "--", "*.py")
        if listing is None:
            raise SystemExit(f"served.py: git grep failed at {self.rev}")
        names = [ln.split(":", 1)[1] for ln in listing.splitlines() if ":" in ln]
        names = [n for n in names if not skipped(n)]
        if not names:
            return {}
        batch = "".join(f"{self.rev}:{n}\n" for n in names).encode()
        raw = git(self.repo, "cat-file", "--batch", binary=True, stdin=batch)
        if raw is None:
            raise SystemExit(f"served.py: git cat-file failed at {self.rev}")
        out, i = {}, 0
        for n in names:
            nl = raw.index(b"\n", i)
            header = raw[i:nl].split()
            if len(header) < 3 or header[1] != b"blob":
                i = nl + 1
                continue
            size = int(header[2])
            out[n] = raw[nl + 1:nl + 1 + size].decode("utf-8", "replace")
            i = nl + 1 + size + 1
        return out


# ---------------------------------------------------------------- T2: AST pass

def _func_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return ""


def _str_values(node: ast.AST, env: dict) -> list[str] | None:
    """Literal strings a name expression can take: constants, f-strings over loop variables, module constants."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    if isinstance(node, ast.Name) and node.id in env:
        return env[node.id]
    if isinstance(node, ast.JoinedStr):
        outs = [""]
        for part in node.values:
            if isinstance(part, ast.Constant):
                outs = [o + str(part.value) for o in outs]
            elif isinstance(part, ast.FormattedValue):
                vals = _str_values(part.value, env)
                if vals is None:
                    return None
                outs = [o + v for o in outs for v in vals]
        return outs
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        a, b = _str_values(node.left, env), _str_values(node.right, env)
        return None if a is None or b is None else [x + y for x in a for y in b]
    return None


def _literal_seq(node: ast.AST, env: dict) -> list[str] | None:
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        vals = [_str_values(e, env) for e in node.elts]
        return None if any(v is None for v in vals) else [x for v in vals for x in v]
    if isinstance(node, ast.Name) and node.id in env:
        return env[node.id]
    if isinstance(node, ast.Dict):
        vals = [_str_values(k, env) for k in node.keys if k is not None]
        return None if any(v is None for v in vals) else [x for v in vals for x in v]
    return None


def ast_pass(files: dict) -> dict:
    """Per-file scans merged in path order (the first file that registers a method is its handler file)."""
    methods, events, low, handler = set(), set(), [], {}
    codes, rest, cli, cfg = set(), set(), set(), set()
    items = sorted(files.items())
    workers = min(os.cpu_count() or 1, 8)
    if workers > 1 and len(items) >= PARALLEL_MIN_FILES:
        # Parsing ~700 modules is CPU-bound; spawn workers keep the P4a.speed budget (<= 2 s) without a cache.
        chunks = [items[i::workers] for i in range(workers)]
        with ProcessPoolExecutor(workers, mp_context=multiprocessing.get_context("spawn")) as pool:
            found = dict(kv for part in pool.map(_scan_chunk, chunks) for kv in part)
    else:
        found = dict(_scan_chunk(items))
    for rel, _ in items:
        f = found.get(rel)
        if f is None:
            continue
        methods |= f["methods"]
        events |= f["events"]
        low += f["low"]
        for v in f["handled"]:
            handler.setdefault(v, rel)
        codes |= f["codes"]
        rest |= f["rest"]
        cli |= f["cli"]
        cfg |= f["cfg"]
    return {"methods": methods, "events": events, "lowConfidence": sorted(low), "handlerFiles": handler,
            "errorCodes": codes, "rest": rest, "cli": cli, "configKeys": cfg}


def _scan_chunk(items: list) -> list:
    return [(rel, f) for rel, text in items if (f := _scan_file(rel, text)) is not None]


def _scan_file(rel: str, text: str) -> dict | None:
    methods, events, low, handled = set(), set(), [], []
    codes, rest, cli, cfg = set(), set(), set(), set()
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            tree = ast.parse(text)
    except SyntaxError:
        return None
    module_env: dict = {}
    for st in tree.body:
        if isinstance(st, ast.Assign) and len(st.targets) == 1 and isinstance(st.targets[0], ast.Name):
            seq = _literal_seq(st.value, module_env)
            name = st.targets[0].id
            if seq is not None:
                module_env[name] = seq
            elif isinstance(st.value, ast.Constant) and isinstance(st.value.value, int) and "CODE" in name.upper():
                if 1000 <= abs(st.value.value) <= 32768:
                    codes.add(st.value.value)
            if name == "DEFAULT_CONFIG" and isinstance(st.value, ast.Dict):
                _config_keys(st.value, "", cfg)
    prefixes = {}

    def visit(node: ast.AST, env: dict) -> None:
        if isinstance(node, (ast.For, ast.comprehension)):
            it, tgt = node.iter, node.target
            if (isinstance(it, ast.Call) and isinstance(it.func, ast.Attribute) and not it.args
                    and it.func.attr in ("items", "keys")):
                if it.func.attr == "items" and isinstance(tgt, ast.Tuple) and tgt.elts:
                    tgt = tgt.elts[0]  # `for key, value in TABLE.items()` binds the dict keys
                it = it.func.value
            seq = _literal_seq(it, env)
            if seq is not None and isinstance(tgt, ast.Name):
                env = {**env, tgt.id: seq}
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
            if _func_name(node.value.func) == "APIRouter":
                for kw in node.value.keywords:
                    if kw.arg == "prefix" and isinstance(kw.value, ast.Constant):
                        for t in node.targets:
                            if isinstance(t, ast.Name):
                                prefixes[t.id] = kw.value.value
        # Flags consumed before argparse runs (`if arg in {"--profile", "-p"}` over sys.argv) are inherited by every
        # subcommand without an add_argument call.
        if (isinstance(node, ast.Compare) and rel.startswith("hermes_cli/") and len(node.ops) == 1
                and isinstance(node.ops[0], ast.In) and isinstance(node.comparators[0], ast.Set)):
            flags = [e.value for e in node.comparators[0].elts if isinstance(e, ast.Constant)]
            if flags and len(flags) == len(node.comparators[0].elts) and all(isinstance(f, str) and f.startswith("-")
                                                                            for f in flags):
                cli.update(f for f in flags if f.startswith("--"))
        if isinstance(node, ast.Call):
            fn = _func_name(node.func)
            arg0 = node.args[0] if node.args else None
            if fn in METHOD_FUNCS and arg0 is not None:
                vals = _str_values(arg0, env)
                if vals is None:
                    low.append(f"{rel}:{node.lineno}")
                for v in vals or []:
                    if NAME_RE.match(v) or v.isidentifier():
                        methods.add(v)
                        handled.append(v)
            elif fn in EMIT_FUNCS and arg0 is not None:
                for v in _str_values(arg0, env) or []:
                    if NAME_RE.match(v):
                        events.add(v)
            elif fn in ("get", "post", "put", "delete", "patch", "websocket") and isinstance(node.func, ast.Attribute):
                vals = _str_values(arg0, env) if arg0 is not None else None
                owner = node.func.value.id if isinstance(node.func.value, ast.Name) else ""
                for v in vals or []:
                    route = prefixes.get(owner, "") + v
                    if route.startswith("/api/"):
                        # A websocket route is reached by an HTTP GET upgrade.
                        verb = "GET" if fn == "websocket" else fn.upper()
                        rest.add(f"{verb} {re.sub(r'{[^}]*}', '{}', route)}")
            elif fn in ("add_api_route", "add_api_websocket_route") and isinstance(node.func, ast.Attribute) and arg0:
                if isinstance(arg0, ast.JoinedStr):  # f"/api/plugins/{name}/{{path:path}}": a mount per plugin
                    vals = ["".join(v.value if isinstance(v, ast.Constant) else "{}" for v in arg0.values)]
                else:
                    vals = _str_values(arg0, env) or []
                verbs = ["GET"]
                for kw in node.keywords:
                    if kw.arg == "methods" and isinstance(kw.value, (ast.List, ast.Tuple)):
                        verbs = [e.value.upper() for e in kw.value.elts
                                 if isinstance(e, ast.Constant) and isinstance(e.value, str)] or verbs
                for v in vals:
                    if v.startswith("/api/"):
                        rest.update(f"{verb} {re.sub(r'{[^}]*}', '{}', v)}" for verb in verbs)
            elif fn == "add_argument" and arg0 is not None and rel.startswith("hermes_cli/"):
                for v in _str_values(arg0, env) or []:
                    if v.startswith("--"):
                        cli.add(v)
        for child in ast.iter_child_nodes(node):
            visit(child, env)

    visit(tree, module_env)
    return {"methods": methods, "events": events, "low": low, "handled": handled, "codes": codes, "rest": rest,
            "cli": cli, "cfg": cfg}


def _config_keys(d: ast.Dict, prefix: str, out: set) -> None:
    for k, v in zip(d.keys, d.values):
        if isinstance(k, ast.Constant) and isinstance(k.value, str):
            key = prefix + k.value
            if isinstance(v, ast.Dict) and v.keys:
                _config_keys(v, key + ".", out)
            else:
                out.add(key)


# ---------------------------------------------------------------- T1 + assembly

def ref_name(schema) -> str | dict:
    if isinstance(schema, dict) and isinstance(schema.get("$ref"), str):
        return schema["$ref"].rsplit("/", 1)[-1]
    return schema if schema is not None else {}


def refs_in(obj, out: set) -> None:
    if isinstance(obj, dict):
        r = obj.get("$ref")
        if isinstance(r, str):
            out.add(r.rsplit("/", 1)[-1])
        for v in obj.values():
            refs_in(v, out)
    elif isinstance(obj, list):
        for v in obj:
            refs_in(v, out)


def closure(schemas: dict, roots: set) -> dict:
    seen, todo = set(), list(roots)
    while todo:
        n = todo.pop()
        if n in seen or n not in schemas:
            continue
        seen.add(n)
        nxt: set = set()
        refs_in(schemas[n], nxt)
        todo.extend(nxt - seen)
    return {k: schemas[k] for k in sorted(seen)}


def state_versions(src) -> dict:
    db = (src.read(STATE_DB) or b"").decode("utf-8", "replace")
    cfg = (src.read(STATE_CFG) or b"").decode("utf-8", "replace")
    m1 = re.search(r"^SCHEMA_VERSION\s*(?::\s*int\s*)?=\s*(\d+)", db, re.M)
    m2 = re.search(r"[\"']_config_version[\"']\s*:\s*(\d+)", cfg)
    return {"db": int(m1.group(1)) if m1 else None, "config": int(m2.group(1)) if m2 else None}


# ---------------------------------------------------------------- effort routes (contracts/G_effort_compact_usage.md §2 G1)
# The levels each (provider, model) route sends VERBATIM. Values are read from the runtime's literals (AST); the few
# selectors the runtime writes as code are declared here once and pinned by the sha256 of the function that holds
# them, so `gen-types --check` turns any runtime edit into a stale spec instead of a silently wrong menu.
EFFORT_FILE = "agent/reasoning_effort.py"
ANTHROPIC_FILE = "agent/anthropic_adapter.py"
GEMINI_FILE = "agent/transports/chat_completions.py"
PLUGINS_DIR = "plugins/model-providers"
XAI_ROUTE_FILE = "agent/codex_responses_adapter.py"
XAI_CLAMP_FILE = "agent/transports/codex.py"
XAI_FAMILY_FILE = "agent/model_metadata.py"
TOKENHUB_HOST_FILE = "agent/chat_completion_helpers.py"
AUTH_FILE = "hermes_cli/auth.py"
PROVIDERS_FILE = "hermes_cli/providers.py"
EFFORT_SET_RE = re.compile(r"^[A-Z0-9_]+_EFFORTS$")
OVERRIDES_RE = re.compile(r"^[A-Z0-9_]+_OVERRIDES$")
# Plugins whose routes are built by their own function above (per-model gates the generic pass cannot see).
DEDICATED_PLUGINS = ("anthropic", "gemini", "deepseek", "opencode-zen", "openrouter")
# plugin -> (module token constant, set when the model holds a token, set otherwise)
PLUGIN_SELECTORS = {"zai": ("_GLM_5_3_TOKENS", "GLM53_EFFORTS", "GLM52_EFFORTS")}
GEMINI_CASES = ({"strip": "google/", "prefix": "gemini-3", "any": ["flash"], "levels": ["low", "medium", "high"]},
                {"strip": "google/", "prefix": "gemini-3", "any": ["pro"], "levels": ["low", "high"]})


def _literal(node):
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "frozenset" and len(node.args) == 1:
        return sorted(ast.literal_eval(node.args[0]))
    value = ast.literal_eval(node)
    return sorted(value) if isinstance(value, (set, frozenset)) else list(value) if isinstance(value, tuple) else value


def _module_literals(tree) -> dict:
    out = {}
    for node in tree.body:
        if isinstance(node, ast.AnnAssign):
            target, value = node.target, node.value
        elif isinstance(node, ast.Assign) and len(node.targets) == 1:
            target, value = node.targets[0], node.value
        else:
            continue
        if isinstance(target, ast.Name) and value is not None:
            try:
                out[target.id] = _literal(value)
            except (ValueError, TypeError, SyntaxError):
                pass
    return out


def _parse(src, rel: str):
    raw = src.read(rel)
    if not raw:
        raise SystemExit(f"served.py: effort routes: {rel} is missing at {src.describe}")
    text = raw.decode("utf-8", "replace")
    return text, ast.parse(text)


def _function(text: str, tree, name: str, rel: str, needs: tuple = (), refs: tuple = (), cls: str = "") -> tuple:
    """(node, "rel:[cls.]name", sha256) of one runtime function; `refs` match names and attributes (`re_.X`)."""
    scope = next((n for n in ast.walk(tree) if isinstance(n, ast.ClassDef) and n.name == cls), None) if cls else tree
    label = f"{cls}.{name}" if cls else name
    node = scope and next((n for n in ast.walk(scope) if isinstance(n, ast.FunctionDef) and n.name == name), None)
    if node is None:
        raise SystemExit(f"served.py: effort routes: {rel}:{label} is gone; update served.py")
    strings = {n.value for n in ast.walk(node) if isinstance(n, ast.Constant) and isinstance(n.value, str)}
    names = {n.id if isinstance(n, ast.Name) else n.attr for n in ast.walk(node) if isinstance(n, (ast.Name, ast.Attribute))}
    missing = [s for s in needs if s not in strings] + [r for r in refs if r not in names]
    if missing:
        raise SystemExit(f"served.py: effort routes: {rel}:{label} no longer holds {missing}; update served.py")
    return node, f"{rel}:{label}", hashlib.sha256((ast.get_source_segment(text, node) or "").encode()).hexdigest()


def _profile_calls(tree) -> list:
    """(constructor name, [provider name, *aliases]) per registration call (keywords, or `_factory("name", (aliases))`)."""
    out = []
    for n in ast.walk(tree):
        if not isinstance(n, ast.Call):
            continue
        kw = {k.arg: k.value for k in n.keywords if k.arg}
        if "aliases" in kw or "env_vars" in kw:
            name, aliases = kw.get("name"), kw.get("aliases")
        elif isinstance(n.func, ast.Name) and n.func.id.startswith("_") and len(n.args) >= 2:
            name, aliases = n.args[0], n.args[1]
        else:
            continue
        if not (isinstance(name, ast.Constant) and isinstance(name.value, str)):
            continue
        extra = aliases.elts if isinstance(aliases, ast.Tuple) else []
        ctor = n.func.id if isinstance(n.func, ast.Name) else ""
        out.append((ctor, [name.value, *(a.value for a in extra if isinstance(a, ast.Constant) and isinstance(a.value, str))]))
    return out


def _plugin_profile(tree) -> list:
    """Provider name + aliases of every profile the plugin registers."""
    return list(dict.fromkeys(name for _, names in _profile_calls(tree) for name in names))


def _profile_names(tree, rel: str, cls: str) -> list:
    """Provider name + aliases of the ONE profile built by `cls` (a plugin may register several)."""
    hits = [names for ctor, names in _profile_calls(tree) if ctor == cls]
    if len(hits) != 1:
        raise SystemExit(f"served.py: effort routes: {rel}: {len(hits)} {cls} registrations; update served.py")
    return hits[0]


def _function_using(tree, rel: str, *refs: str) -> str:
    """Name of the one function that references every name in *refs* (the runtime keeps no stable name for it)."""
    hits = [n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)
            and set(refs) <= {m.id for m in ast.walk(n) if isinstance(m, ast.Name)}]
    if len(hits) != 1:
        raise SystemExit(f"served.py: effort routes: {rel}: {len(hits)} functions use {list(refs)}; update served.py")
    return hits[0]


def _xai_route(src, sets: dict, pins: dict) -> dict:
    """xAI Responses clamp (codex transport): Grok 4.6 family vs older Grok, chosen by `is_grok_46_family`."""
    c_text, c_tree = _parse(src, XAI_CLAMP_FILE)
    _, clamp_src, h = _function(c_text, c_tree, "_resolve_reasoning", XAI_CLAMP_FILE, ("is_xai_responses",),
                                ("XAI_GROK46_EFFORTS", "XAI_LEGACY_EFFORTS", "is_grok_46_family"))
    pins[clamp_src] = h
    m_text, m_tree = _parse(src, XAI_FAMILY_FILE)
    _, s, h = _function(m_text, m_tree, "is_grok_46_family", XAI_FAMILY_FILE, ("grok-4.6", "grok-4.6-", "_", "-", "/"))
    pins[s] = h
    r_text, r_tree = _parse(src, XAI_ROUTE_FILE)
    fn, s, h = _function(r_text, r_tree, "classify_responses_route", XAI_ROUTE_FILE, ("xai",))
    pins[s] = h
    flagged = next((sorted(e.value for e in n.comparators[0].elts) for n in ast.walk(fn) if isinstance(n, ast.Compare)
                    and isinstance(n.ops[0], ast.In) and isinstance(n.comparators[0], ast.Set)
                    and any(isinstance(e, ast.Constant) and e.value == "xai" for e in n.comparators[0].elts)), None)
    if not flagged:
        raise SystemExit(f"served.py: effort routes: {XAI_ROUTE_FILE}:classify_responses_route lost its xai provider set")
    _, p_tree = _parse(src, f"{PLUGINS_DIR}/xai/__init__.py")
    # `bare`: the model's last path segment, lowercased, `_` -> `-` (exactly `is_grok_46_family`'s normalisation).
    return {"providers": list(dict.fromkeys([*flagged, *_plugin_profile(p_tree)])), "source": clamp_src, "cases": [
        {"bare": True, "exact": ["grok-4.6"], "set": "XAI_GROK46_EFFORTS", "levels": sets["XAI_GROK46_EFFORTS"]},
        {"bare": True, "prefix": "grok-4.6-", "set": "XAI_GROK46_EFFORTS", "levels": sets["XAI_GROK46_EFFORTS"]},
        {"set": "XAI_LEGACY_EFFORTS", "levels": sets["XAI_LEGACY_EFFORTS"]}]}


def _tokenhub_route(src, sets: dict, pins: dict) -> dict:
    """TokenHub is chosen by base-URL host (any provider), not by provider name: `hosts` match exact-or-subdomain."""
    t_text, t_tree = _parse(src, GEMINI_FILE)
    _, s, h = _function(t_text, t_tree, "build_kwargs", GEMINI_FILE, ("is_tokenhub",), ("TOKENHUB_EFFORTS",))
    pins[s] = h
    k_text, k_tree = _parse(src, TOKENHUB_HOST_FILE)
    hosts = sorted({k.value.args[1].value for k in ast.walk(k_tree) if isinstance(k, ast.keyword) and k.arg == "is_tokenhub"
                    and isinstance(k.value, ast.Call) and len(k.value.args) == 2
                    and isinstance(k.value.args[1], ast.Constant) and isinstance(k.value.args[1].value, str)})
    if not hosts:
        raise SystemExit(f"served.py: effort routes: {TOKENHUB_HOST_FILE} lost the is_tokenhub host")
    return {"providers": [], "hosts": hosts, "source": s,
            "cases": [{"set": "TOKENHUB_EFFORTS", "levels": sets["TOKENHUB_EFFORTS"]}]}


def _on_hosts(url, hosts) -> bool:
    """`base_url_host_matches`: the URL's host is one of *hosts* or a subdomain of one."""
    host = (urlsplit(url).hostname or "").lower() if isinstance(url, str) else ""
    return bool(host) and any(host == h or host.endswith(f".{h}") for h in hosts)


def _builtin_host_routes(src, routes: list, pins: dict) -> list:
    """A providers-less host route's cases keyed by every built-in slug (+ aliases) whose registry base URL is on its
    host: built-in `model.options` rows carry no api_url and the runtime sends to the slug's registry URL. A row that
    names a base URL off `registryHosts` (an env override) is off the route. Pinned by the registry tuple's sha256."""
    text, tree = _parse(src, AUTH_FILE)
    node = next((n for n in tree.body if isinstance(n, (ast.Assign, ast.AnnAssign)) and isinstance(n.value, ast.Tuple)
                 and any(getattr(t, "id", "") == "_REGISTRY_ROWS" for t in getattr(n, "targets", [getattr(n, "target", None)]))),
                None)
    aliases = _module_literals(tree).get("_PROVIDER_ALIASES")
    groups = _module_literals(_parse(src, PROVIDERS_FILE)[1]).get("_ALIAS_GROUPS")
    if node is None or not isinstance(aliases, dict) or not isinstance(groups, dict):
        raise SystemExit(f"served.py: effort routes: {AUTH_FILE}:_REGISTRY_ROWS/_PROVIDER_ALIASES or "
                         f"{PROVIDERS_FILE}:_ALIAS_GROUPS is gone; update served.py")
    source = f"{AUTH_FILE}:_REGISTRY_ROWS"
    pins[source] = hashlib.sha256((ast.get_source_segment(text, node) or "").encode()).hexdigest()
    rows = [[e.value if isinstance(e, ast.Constant) else None for e in r.elts] for r in node.value.elts
            if isinstance(r, ast.Tuple)]
    keyed = {name for r in routes if not r.get("hosts") for name in r["providers"]}
    out = []
    for route in (r for r in routes if r.get("hosts") and not r["providers"]):
        hits = [row for row in rows if len(row) > 2 and isinstance(row[0], str) and _on_hosts(row[2], route["hosts"])]
        if not hits:
            raise SystemExit(f"served.py: effort routes: no {AUTH_FILE} registry base URL is on {route['hosts']} "
                             f"({route['source']}); update served.py")
        for row in hits:
            if len(row) > 5 and row[5] != "chat_completions":
                raise SystemExit(f"served.py: effort routes: {AUTH_FILE}: {row[0]} picks api_mode {row[5]!r}, not "
                                 f"{route['source']}'s transport; update served.py")
            names = list(dict.fromkeys([row[0], *(a for a, c in aliases.items() if c == row[0]), *groups.get(row[0], ())]))
            if keyed & set(names):
                raise SystemExit(f"served.py: effort routes: {sorted(keyed & set(names))} already have a provider route "
                                 f"and sit on {route['hosts']}; update served.py")
            out.append({"providers": names, "registryHosts": route["hosts"], "source": source,
                        "cases": [dict(c) for c in route["cases"]]})
    return out


def _set_case(base: str, sets: dict, lit: dict, overrides: bool = True) -> dict:
    """`<base>_EFFORTS` as a case, with the `<base>_OVERRIDES` map `clamp_effort` consults when the plugin passes it."""
    levels = sets[f"{base}_EFFORTS"]
    mapped = {k: v for k, v in (lit.get(f"{base}_OVERRIDES") or {}).items() if v in levels} if overrides else {}
    return {"set": f"{base}_EFFORTS", "levels": levels, **({"overrides": mapped} if mapped else {})}


def _deepseek_route(src, sets: dict, lit: dict, pins: dict) -> dict:
    """DeepSeek sends an effort only on versioned v4+ ids and `_THINKING_CAPABLE_IDS` (whole id, lowercased)."""
    rel = f"{PLUGINS_DIR}/deepseek/__init__.py"
    text, tree = _parse(src, rel)
    _, s, h = _function(text, tree, "build_api_kwargs_extras", rel, ("deepseek-v", "deepseek-v3"),
                        ("_THINKING_CAPABLE_IDS", "DEEPSEEK_V4_EFFORTS", "DEEPSEEK_V4_OVERRIDES"), cls="DeepSeekProfile")
    pins[s] = h
    v4 = _set_case("DEEPSEEK_V4", sets, lit)
    return {"providers": _profile_names(tree, rel, "DeepSeekProfile"), "source": s, "cases": [
        {"prefix": "deepseek-v3", "levels": []}, {"prefix": "deepseek-v", **v4},
        {"exact": _module_literals(tree)["_THINKING_CAPABLE_IDS"], **v4}, {"levels": []}]}


def _opencode_routes(src, sets: dict, lit: dict, pins: dict) -> list:
    """OpenCode Zen and Go: one route per profile, each mirroring its `build_api_kwargs_extras` model gates.
    `segment` = the runtime's `_flat_model_name` (last path segment, lowercased)."""
    rel = f"{PLUGINS_DIR}/opencode-zen/__init__.py"
    text, tree = _parse(src, rel)
    _, s, h = _function(text, tree, "_flat_model_name", rel, ("/",))
    pins[s] = h
    glm_fn, s, h = _function(text, tree, "_is_glm_5_2_model", rel, (), ("_flat_model_name",))
    pins[s] = h
    glm = next((sorted(e.value for e in n.elts) for n in ast.walk(glm_fn) if isinstance(n, ast.Tuple) and n.elts
                and all(isinstance(e, ast.Constant) and isinstance(e.value, str) for e in n.elts)), None)
    if not glm:
        raise SystemExit(f"served.py: effort routes: {rel}:_is_glm_5_2_model lost its token tuple")
    _, s, h = _function(text, tree, "_is_deepseek_thinking_model", rel, ("deepseek-v", "deepseek-v3"),
                        ("_flat_model_name", "_THINKING_CAPABLE_IDS"))
    pins[s] = h
    _, go_src, h = _function(text, tree, "build_api_kwargs_extras", rel, ("kimi-k2", "high"),
                             ("_is_glm_5_2_model", "_is_deepseek_thinking_model", "GLM52_EFFORTS", "GLM52_OVERRIDES",
                              "KIMI_K2_EFFORTS", "DEEPSEEK_V4_EFFORTS", "DEEPSEEK_V4_OVERRIDES"), cls="OpenCodeGoProfile")
    pins[go_src] = h
    _, zen_src, h = _function(text, tree, "build_api_kwargs_extras", rel, (), ("ox_alpha_reasoning_extras",),
                              cls="OpenCodeZenProfile")
    pins[zen_src] = h
    e_text, e_tree = _parse(src, EFFORT_FILE)
    _, s, h = _function(e_text, e_tree, "ox_alpha_reasoning_extras", EFFORT_FILE, ("x-preview-f-free", "/"),
                        ("OX_ALPHA_EFFORTS", "OX_ALPHA_OVERRIDES"))
    pins[s] = h
    v4 = _set_case("DEEPSEEK_V4", sets, lit)
    thinking_ids = _module_literals(tree)["_THINKING_CAPABLE_IDS"]
    return [
        {"providers": _profile_names(tree, rel, "OpenCodeZenProfile"), "source": zen_src, "cases": [
            {"segment": True, "exact": ["x-preview-f-free"], **_set_case("OX_ALPHA", sets, lit)}, {"levels": []}]},
        {"providers": _profile_names(tree, rel, "OpenCodeGoProfile"), "source": go_src, "cases": [
            {"segment": True, "any": glm, **_set_case("GLM52", sets, lit)},
            {"segment": True, "prefix": "kimi-k2", **_set_case("KIMI_K2", sets, lit, overrides=False)},
            {"segment": True, "prefix": "deepseek-v3", "levels": []},
            {"segment": True, "prefix": "deepseek-v", **v4},
            {"segment": True, "exact": thinking_ids, **v4},
            {"levels": []}]}]


def _openrouter_route(src, sets: dict, pins: dict) -> dict:
    """OpenRouter: Claude models that mandate reasoning get the effort as-is (`verbosity`); every other model is
    lowered to OpenRouter's catalog `supported_efforts`, known only at runtime, so those cases carry `catalog`."""
    rel = f"{PLUGINS_DIR}/openrouter/__init__.py"
    text, tree = _parse(src, rel)
    _, s, h = _function(text, tree, "_clamp_reasoning_to_catalog", rel, ("supported_efforts",),
                        ("clamp_reasoning_effort_to_supported",), cls="OpenRouterProfile")
    pins[s] = h
    _, m_src, h = _function(text, tree, "_anthropic_reasoning_is_mandatory", rel, ("anthropic/", "claude"),
                            ("_ANTHROPIC_REASONING_OPTIONAL_SUBSTRINGS",))
    pins[m_src] = h
    _, x_src, h = _function(text, tree, "build_api_kwargs_extras", rel, ("verbosity",),
                            ("_anthropic_reasoning_is_mandatory", "_clamp_reasoning_to_catalog"), cls="OpenRouterProfile")
    pins[x_src] = h
    optional = _module_literals(tree)["_ANTHROPIC_REASONING_OPTIONAL_SUBSTRINGS"]
    wide = sets["OPENAI_COMPAT_WIRE_EFFORTS"]
    return {"providers": _profile_names(tree, rel, "OpenRouterProfile"), "source": x_src, "cases": [
        {"prefix": "anthropic/", "without": optional, "levels": wide},
        {"any": ["claude"], "without": optional, "levels": wide},
        {"catalog": "openrouter", "levels": wide}]}


def _custom_host_route(src, pins: dict) -> dict:
    """The custom profile's host branches that send a non-ladder literal (Groq: `"default"` for every graded level)."""
    rel = f"{PLUGINS_DIR}/custom/__init__.py"
    text, tree = _parse(src, rel)
    fn, s, h = _function(text, tree, "build_api_kwargs_extras", rel, ("default",), ("base_url_host_matches",),
                         cls="CustomProfile")
    pins[s] = h
    hosts = sorted({c.args[1].value for n in ast.walk(fn) if isinstance(n, ast.If)
                    and any(isinstance(a, ast.Assign) and isinstance(a.value, ast.Constant) and a.value.value == "default"
                            for a in n.body)
                    for c in ast.walk(n.test) if isinstance(c, ast.Call) and getattr(c.func, "id", "") == "base_url_host_matches"
                    and len(c.args) == 2 and isinstance(c.args[1], ast.Constant) and isinstance(c.args[1].value, str)})
    if not hosts:
        raise SystemExit(f"served.py: effort routes: {rel}:CustomProfile.build_api_kwargs_extras lost its host branch")
    return {"providers": _profile_names(tree, rel, "CustomProfile"), "hosts": hosts, "source": s, "cases": [{"levels": []}]}


OWN_PLUGINS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hermes-plugins")


def _own_plugin_routes() -> list:
    """Our provider plugins (iclone/hermes-plugins): one whose code never reads the reasoning config sends no effort
    (e.g. claude-code-cli drives the `claude` CLI, whose argv carries no effort). Pinned by the sha256 of its files."""
    routes = []
    for plugin in sorted(os.listdir(OWN_PLUGINS_DIR)) if os.path.isdir(OWN_PLUGINS_DIR) else []:
        folder = os.path.join(OWN_PLUGINS_DIR, plugin)
        files = sorted(f for f in os.listdir(folder) if f.endswith(".py")) if os.path.isdir(folder) else []
        texts = {f: open(os.path.join(folder, f), encoding="utf-8").read() for f in files}
        if "register_provider" not in texts.get("__init__.py", ""):
            continue
        lit = {k: v for t in texts.values() for k, v in _module_literals(ast.parse(t)).items()}
        names = [lit.get(v.id) if isinstance(v, ast.Name) else getattr(v, "value", None)
                 for n in ast.walk(ast.parse(texts["__init__.py"])) if isinstance(n, ast.Dict)
                 for k, v in zip(n.keys, n.values) if isinstance(k, ast.Constant) and k.value == "name"]
        if len(names) != 1 or not isinstance(names[0], str):
            raise SystemExit(f"served.py: effort routes: iclone/hermes-plugins/{plugin}: provider name not found")
        if any(re.search(r"reasoning_config|reasoning_effort|\beffort\b", t) for t in texts.values()):
            raise SystemExit(f"served.py: effort routes: iclone/hermes-plugins/{plugin} reads the effort; declare its levels")
        digest = hashlib.sha256("".join(texts[f] for f in files).encode()).hexdigest()
        routes.append({"providers": names, "source": f"iclone/hermes-plugins/{plugin}", "sha256": digest,
                       "cases": [{"levels": []}]})
    return routes


def effort_routes(src) -> dict:
    text, tree = _parse(src, EFFORT_FILE)
    lit = _module_literals(tree)
    sets = {k: v for k, v in sorted(lit.items()) if EFFORT_SET_RE.match(k) and isinstance(v, list)}
    ladder = lit.get("EFFORT_LADDER")
    if not ladder or "OPENAI_COMPAT_WIRE_EFFORTS" not in sets:
        raise SystemExit(f"served.py: effort routes: {EFFORT_FILE} lost EFFORT_LADDER/OPENAI_COMPAT_WIRE_EFFORTS")
    codex_fn, codex_src, codex_sha = _function(text, tree, "codex_supported_efforts", EFFORT_FILE)
    gpt56 = sorted(n.left.value for n in ast.walk(codex_fn) if isinstance(n, ast.Compare)
                   and isinstance(n.left, ast.Constant) and isinstance(n.left.value, str))
    pins = {src_: sha for _, src_, sha in (
        (codex_fn, codex_src, codex_sha),
        _function(text, tree, "route_supported_efforts", EFFORT_FILE, ("openai-codex", "codex_app_server", "max", "ultra")),
        _function(text, tree, "clamp_effort", EFFORT_FILE),
    )}
    entry = {"default": "OPENAI_COMPAT_WIRE_EFFORTS", "codex": {
        "provider": "openai-codex", "ultraApiMode": "codex_app_server",
        "astraIds": lit["ASTRA_MODEL_IDS"], "noDisablePrefixes": lit["NO_DISABLE_TIER_PREFIXES"],
        "gpt56Substrings": gpt56, "gpt6Prefixes": lit["GPT6_TIER_PREFIXES"], "daybreakIds": lit["DAYBREAK_MODEL_IDS"],
        "astra": "CODEX_ASTRA_EFFORTS", "gpt56": "CODEX_GPT56_EFFORTS", "legacy": "CODEX_LEGACY_EFFORTS"}}
    routes = []

    a_text, a_tree = _parse(src, ANTHROPIC_FILE)
    a_lit = _module_literals(a_tree)
    amap = a_lit["ADAPTIVE_EFFORT_MAP"]
    verbatim = [lvl for lvl in ladder if amap.get(lvl) == lvl]
    # `overrides` = requested -> sent where the route does NOT use the nearest-weaker clamp: the adaptive map, and
    # the adapter's xhigh -> max on models without xhigh (the wire echo shows only the entry clamp, never these).
    adaptive = {lvl: amap[lvl] for lvl in ladder if lvl in amap and amap[lvl] != lvl}
    for fn in ("_supports_xhigh_effort", "_supports_adaptive_thinking", "_is_claude_model"):
        _, s, h = _function(a_text, a_tree, fn, ANTHROPIC_FILE, ("claude",) if fn == "_is_claude_model" else ())
        pins[s] = h
    _, s, h = _function(a_text, a_tree, _function_using(a_tree, ANTHROPIC_FILE, "ADAPTIVE_EFFORT_MAP", "_supports_xhigh_effort"),
                        ANTHROPIC_FILE, ("xhigh", "max"))
    pins[s] = h
    a_text_p, a_tree_p = _parse(src, f"{PLUGINS_DIR}/anthropic/__init__.py")
    routes.append({"providers": _plugin_profile(a_tree_p), "source": ANTHROPIC_FILE, "cases": [
        {"any": a_lit["_LEGACY_MANUAL_THINKING_CLAUDE_SUBSTRINGS"], "levels": []},
        {"without": ["claude"], "levels": []},
        {"any": a_lit["_NO_XHIGH_CLAUDE_SUBSTRINGS"], "levels": [lvl for lvl in verbatim if lvl != "xhigh"],
         "overrides": {**adaptive, "xhigh": "max"}},
        {"levels": verbatim, "overrides": adaptive}]})

    routes.append(_xai_route(src, sets, pins))
    routes.append(_tokenhub_route(src, sets, pins))
    routes.append(_custom_host_route(src, pins))
    routes.append(_deepseek_route(src, sets, lit, pins))
    routes.extend(_opencode_routes(src, sets, lit, pins))
    routes.append(_openrouter_route(src, sets, pins))
    routes.extend(_own_plugin_routes())

    g_text, g_tree = _parse(src, GEMINI_FILE)
    _, s, h = _function(g_text, g_tree, "_build_gemini_thinking_config", GEMINI_FILE,
                        ("gemini-3", "flash", "pro", "low", "medium", "high"))
    pins[s] = h
    _, gp_tree = _parse(src, f"{PLUGINS_DIR}/gemini/__init__.py")
    routes.append({"providers": _plugin_profile(gp_tree), "source": s,
                   "cases": [*(dict(c) for c in GEMINI_CASES), {"levels": []}]})

    for plugin in src.listdir(PLUGINS_DIR):
        rel = f"{PLUGINS_DIR}/{plugin}/__init__.py"
        raw = src.read(rel)
        if plugin in DEDICATED_PLUGINS or not raw:
            continue
        p_text = raw.decode("utf-8", "replace")
        p_tree = ast.parse(p_text)
        used = sorted({n.attr if isinstance(n, ast.Attribute) else n.id for n in ast.walk(p_tree)
                       if isinstance(n, (ast.Attribute, ast.Name))
                       and EFFORT_SET_RE.match(n.attr if isinstance(n, ast.Attribute) else n.id)})
        # A `supported_reasoning_efforts` override that returns anything but a module set reads a live catalog
        # the transport clamps to (e.g. Ramp Router's cache): its levels are then an upper bound, never a promise.
        declared = next((n for n in ast.walk(p_tree) if isinstance(n, ast.FunctionDef)
                         and n.name == "supported_reasoning_efforts"), None)
        catalog = bool(declared) and not all(
            isinstance(r.value, (ast.Name, ast.Attribute)) and EFFORT_SET_RE.match(getattr(r.value, "id", "") or r.value.attr)
            for r in ast.walk(declared) if isinstance(r, ast.Return))
        if catalog:
            owner = next((c.name for c in ast.walk(p_tree) if isinstance(c, ast.ClassDef) and declared in c.body), "")
            _, s, h = _function(p_text, p_tree, "supported_reasoning_efforts", rel, cls=owner)
            pins[s] = h
        if not used and not catalog:
            continue
        unknown = [u for u in used if u not in sets]
        if unknown:
            raise SystemExit(f"served.py: effort routes: {rel} uses {unknown}, not in {EFFORT_FILE}")
        used = used or [entry["default"]]
        selector = PLUGIN_SELECTORS.get(plugin)
        if selector and set(selector[1:]) == set(used):
            tokens = _module_literals(p_tree)[selector[0]]
            cases = [{"any": tokens, "set": selector[1], "levels": sets[selector[1]]},
                     {"set": selector[2], "levels": sets[selector[2]]}]
        elif len(used) == 1:
            cases = [{"set": used[0], "levels": sets[used[0]]}]
        else:
            # Several sets chosen by code no selector declares: only the levels every one of them sends verbatim.
            cases = [{"set": "&".join(used), "levels": [lvl for lvl in ladder if all(lvl in sets[u] for u in used)]}]
        # A declared vendor map (`<SET>_OVERRIDES`, consulted by `clamp_effort` before nearest-weaker) the plugin passes.
        passed = {n.attr if isinstance(n, ast.Attribute) else n.id for n in ast.walk(p_tree)
                  if isinstance(n, (ast.Attribute, ast.Name))
                  and OVERRIDES_RE.match(n.attr if isinstance(n, ast.Attribute) else n.id)}
        for case in cases:
            name = case["set"].replace("_EFFORTS", "_OVERRIDES")
            if name in passed and isinstance(lit.get(name), dict):
                case["overrides"] = {k: v for k, v in lit[name].items() if v in case["levels"]}
            if catalog:
                case["catalog"] = (_plugin_profile(p_tree) or [plugin])[0]
        routes.append({"providers": _plugin_profile(p_tree) or [plugin], "source": rel,
                       "sha256": hashlib.sha256(raw).hexdigest(), "cases": cases})
    routes.extend(_builtin_host_routes(src, routes, pins))
    return {"ladder": ladder, "sets": sets, "entry": entry, "routes": routes, "pins": dict(sorted(pins.items()))}


def build(src, lock: dict | None) -> dict:
    raw = src.read(OPENRPC)
    t2 = ast_pass(src.python_files())
    spec = {"spec": 1, "rev": src.rev, "describe": src.describe, "openrpcSha256": None, "specTier": "ast"}
    if raw:
        doc = json.loads(raw)
        spec["openrpcSha256"] = hashlib.sha256(raw).hexdigest()
        entry = lambda m: {"params": ref_name((m.get("params") or [{}])[0].get("schema")),  # noqa: E731
                           "result": ref_name((m.get("result") or {}).get("schema"))}
        methods = {m["name"]: {**entry(m), "handlerFile": t2["handlerFiles"].get(m["name"])} for m in doc["methods"]}
        srs = {m["name"]: entry(m) for m in doc.get("x-server-requests", [])}
        notes = {m["name"]: {"payload": ref_name((m.get("params") or [{}])[0].get("schema"))}
                 for m in doc.get("x-notifications", [])}
        schemas = (doc.get("components") or {}).get("schemas") or {}
        drift = sorted(n for n in t2["methods"] if NAME_RE.match(n) and n not in methods)
        spec["specTier"] = "openrpc+drift" if drift else "openrpc"
        spec["drift"] = drift
    else:
        methods = {n: {"params": "opaque", "result": "opaque", "handlerFile": t2["handlerFiles"].get(n)}
                   for n in sorted(t2["methods"])}
        srs = {}
        notes = {n: {"payload": "opaque"} for n in sorted(t2["events"])}
        schemas = {}
        spec["lowConfidence"] = t2["lowConfidence"]
    if lock is not None:
        roots = set()
        for group, names in ((methods, lock.get("methods") or {}), (notes, lock.get("events") or {})):
            for n in names:
                refs_in({"$ref": "#/" + str(group.get(n, {}).get("params") or "")}, roots)
                for v in (group.get(n) or {}).values():
                    if isinstance(v, str):
                        roots.add(v)
        for v in srs.values():
            roots |= {x for x in v.values() if isinstance(x, str)}
        schemas = closure(schemas, roots)
    spec.update({
        "methods": dict(sorted(methods.items())),
        "serverRequests": dict(sorted(srs.items())),
        "notifications": dict(sorted(notes.items())),
        "schemas": schemas,
        "stateVersions": state_versions(src),
        "handlerFiles": dict(sorted((k, v) for k, v in t2["handlerFiles"].items() if k in methods)),
        "rest": sorted(t2["rest"]),
        "cli": {"serve": sorted(t2["cli"])},
        "configKeys": sorted(t2["configKeys"]),
        "errorCodes": sorted(t2["errorCodes"]),
        "effortRoutes": effort_routes(src),
    })
    return spec


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--runtime")
    ap.add_argument("--repo")
    ap.add_argument("--rev")
    ap.add_argument("--lock")
    ap.add_argument("--out", required=True)
    ap.add_argument("--archive", help="with --repo: also extract the tree at --rev into this new directory")
    a = ap.parse_args()
    if bool(a.runtime) == bool(a.repo and a.rev):
        ap.error("pass exactly one of --runtime <checkout> or --repo <repo> --rev <rev>")
    src = TreeSource(os.path.abspath(a.runtime)) if a.runtime else RepoSource(os.path.abspath(a.repo), a.rev)
    if a.archive:
        if not isinstance(src, RepoSource):
            ap.error("--archive needs --repo <repo> --rev <rev>")
        os.makedirs(a.archive)
        print(f"archive: {src.rev[:12]} files={src.archive(a.archive)} -> {a.archive}")
    lock = json.load(open(a.lock)) if a.lock else None
    spec = build(src, lock)
    if not spec["methods"]:
        print(f"served.py: {spec['describe']} ({spec['specTier']}) yields 0 methods: refusing to write a blank spec",
              file=sys.stderr)
        return 3
    tmp = a.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(spec, fh, indent=1, sort_keys=False)
        fh.write("\n")
    os.replace(tmp, a.out)
    print(f"served: {spec['describe']} {spec['specTier']} methods={len(spec['methods'])} "
          f"sr={len(spec['serverRequests'])} notifications={len(spec['notifications'])} "
          f"schemas={len(spec['schemas'])} state={spec['stateVersions']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
