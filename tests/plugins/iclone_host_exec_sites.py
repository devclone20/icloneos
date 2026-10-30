"""V3-UP r4 (ruling 50) — every place the shipped runtime can start another program, found by PRIMITIVE.

r3 scanned the tool layer and one hop of wrappers; critic r3 N3 found cron job scripts, the MCP catalog install,
plugin/skill installs and lazy package installs outside that horizon. r4 changes the method: the RULE is enforced at
runtime (``tools/environments/host_lane.py``: an audit hook in every confined process refuses each process creation
that is not (a) the environment's own shell or (c) an app-fixed program at a listed site), and this inventory documents
it. It scans EVERY module of the shipped runtime (all of the tree but the directories V3-RT does not ship) for every
reference to a process-starting primitive (``subprocess.*``, ``os.system/popen/exec*/spawn*/posix_spawn*/fork*``,
``asyncio.create_subprocess_*``, ``pty``, ``ptyprocess``/``winpty``/``pexpect``/``anyio``/``webbrowser``, the MCP
SDK's stdio client, playwright), through any alias, in call position or handed on as a callable; type annotations,
``isinstance`` and ``except`` types are not spawns. Each site is keyed ``<file>::<qualified function>::<call>#<n>``.

Decisions live in ``plugins/iclone-confinement/tests/fixtures/host_exec_sites.json``; the ``c`` rows are also the
runtime allowlist ``plugins/iclone-confinement/spawn_sites.json``. ``python -m tests.plugins.iclone_host_exec_sites
<tree> --write`` refreshes lines, keeps decisions, gives a new site its default (a in the environment backends, b
elsewhere — which is what the guard does to it anyway) and rewrites the allowlist.
"""

from __future__ import annotations

import ast
import json
import sys
import warnings
from pathlib import Path

FIXTURE_REL = "plugins/iclone-confinement/tests/fixtures/host_exec_sites.json"
ALLOWLIST_REL = "plugins/iclone-confinement/spawn_sites.json"
ALLOWLIST_NOTE = ("V3-UP r5, rulings 50 + 56: the sites the spawn guard lets start a program in a confined process — "
                  "fixed: an app-fixed program, only as the sandbox-exec argv confine_program sealed (inside the "
                  "agent's Seatbelt); hermes: this runtime's own interpreter, confined. Generated from "
                  "tests/fixtures/host_exec_sites.json, never edited by hand")
SCAN_ROOTS = ("tools", "agent", "plugins")  # r3's tool layer (kept for the wrapper scan below)
# r4 (ruling 50): the inventory is by PRIMITIVE over the whole shipped runtime — every .py the runtime artifact
# carries (V3-RT excludes these top-level directories; nothing else is skipped).
SHIPPED_EXCLUDE = frozenset({"apps", "iclone", "packages", "packaging", ".github", "docs", "website", "tests",
                             "tests-js", "evals", "node_modules", "web", "ui-tui", "venv", ".venv", "nix", "docker",
                             "__pycache__"})

EXEC_CALLS = {
    "subprocess": {"run", "Popen", "call", "check_call", "check_output", "getoutput", "getstatusoutput"},
    "os": {"system", "popen", "execv", "execve", "execvp", "execvpe", "execl", "execle", "execlp", "execlpe", "spawnv",
           "spawnve", "spawnvp", "spawnvpe", "spawnl", "spawnle", "spawnlp", "spawnlpe", "posix_spawn", "posix_spawnp",
           "fork", "forkpty", "startfile"},
    "asyncio": {"create_subprocess_exec", "create_subprocess_shell"},
    "pty": {"spawn", "fork"},
}
# Library entry points that start a program on Hermes' behalf: imported names (any alias) …
LIBRARY_SPAWNS = {
    "ptyprocess": {"PtyProcess", "PtyProcessUnicode"},
    "winpty": {"PtyProcess"},
    "pexpect": {"spawn", "run", "popen_spawn"},
    "anyio": {"open_process", "run_process"},
    "webbrowser": {"open", "open_new", "open_new_tab"},
    "mcp": {"StdioServerParameters"},
    "mcp.client.stdio": {"stdio_client"},
    "playwright.sync_api": {"sync_playwright"},
    "playwright.async_api": {"async_playwright"},
    # r5 (critic r4 m1): multiprocessing's spawn reaches _posixsubprocess.fork_exec, which the guard wraps
    "multiprocessing": {"Pool", "Process", "get_context"},
    "multiprocessing.pool": {"Pool"},
    "concurrent.futures": {"ProcessPoolExecutor"},
}
# … and attribute names distinctive enough to be a spawn whatever object carries them (a module re-exporting the
# MCP SDK's names, ``loop.subprocess_exec``).
SPAWN_ATTRIBUTES = {"stdio_client", "StdioServerParameters", "subprocess_exec", "subprocess_shell", "startfile"}

# Rulings 50 + 56 — four outcomes, enforced at runtime by ``tools/environments/host_lane.py`` (audit hook):
#   a  through the environment's shell: a spawn made inside a method of a non-host environment (tools/environments/,
#      plugins/iclone-confinement/) — sandboxed, a container, or remote;
#   b  refused in a confined process — the DEFAULT: any site not listed as ``c`` or ``h``, listed or not in this file;
#   c  an app-fixed program, run INSIDE the agent's Seatbelt: the site is ``fixed`` in spawn_sites.json and starts only
#      the sandbox-exec argv ``host_lane.confine_program`` sealed (plugins/iclone-confinement/programs.py: the class
#      profile for its kind, widened only by what it needs). Each ``c`` row names the kind and the file:line;
#   h  the confined runtime itself: the site is ``hermes`` in spawn_sites.json and starts this runtime's interpreter
#      (or its hermes CLI) on Hermes' own code with ICLONE_CONFINEMENT=1, and that code installs the same guard first.
VERDICTS = ("a", "b", "c", "h")
ENV_DIRS = ("tools/environments/", "plugins/iclone-confinement/")


def _in_scope(rel: str) -> bool:
    """A module of the shipped runtime (not a test, not an excluded top-level directory)."""
    parts = rel.split("/")
    if "tests" in parts or parts[-1].startswith("test_") or not rel.endswith(".py") or "__pycache__" in parts:
        return False
    return parts[0] not in SHIPPED_EXCLUDE


def _annotation_nodes(tree: ast.AST) -> set:
    skip: set = set()

    def mark(node):
        if node is not None:
            skip.update(id(n) for n in ast.walk(node))

    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and getattr(node.func, "id", "") in ("isinstance", "issubclass") \
                and len(node.args) == 2:
            mark(node.args[1])  # a type test names the class, it starts nothing
        elif isinstance(node, ast.ExceptHandler):
            mark(node.type)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            mark(node.returns)
            for arg in node.args.args + node.args.kwonlyargs + node.args.posonlyargs:
                mark(arg.annotation)
            mark(node.args.vararg.annotation if node.args.vararg else None)
            mark(node.args.kwarg.annotation if node.args.kwarg else None)
        elif isinstance(node, ast.AnnAssign):
            mark(node.annotation)
    return skip


def scan_file(path: Path, rel: str) -> list:
    """``[(qualname, callee, line)]`` for every process-starting reference in one module, in source order."""
    with warnings.catch_warnings():  # a module's own invalid escapes are not this scan's business
        warnings.simplefilter("ignore", SyntaxWarning)
        tree = ast.parse(path.read_text(encoding="utf-8"))
    calls = {**EXEC_CALLS, **LIBRARY_SPAWNS}
    # r5 (critic r4 m2): a module rebound onto another's globals (tui_gateway's ``method_ctx.bind_module``) uses
    # ``subprocess``/``os`` as bare globals it never imports: the primitive modules' own names always count.
    modules: dict = {name: name for name in EXEC_CALLS}
    names: dict = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in calls:
                    modules[alias.asname or alias.name.split(".")[0]] = alias.name
        elif isinstance(node, ast.ImportFrom) and node.module in calls and node.level == 0:
            for alias in node.names:
                if alias.name in calls[node.module]:
                    names[alias.asname or alias.name] = f"{node.module}.{alias.name}"
    skip = _annotation_nodes(tree)
    found: list = []
    stack: list = []

    class Visitor(ast.NodeVisitor):
        def _scoped(self, node):
            stack.append(node.name)
            self.generic_visit(node)
            stack.pop()

        visit_FunctionDef = visit_AsyncFunctionDef = visit_ClassDef = _scoped

        def visit_Attribute(self, node):
            if id(node) not in skip and isinstance(node.value, ast.Name) and node.value.id in modules \
                    and node.attr in calls[modules[node.value.id]]:
                found.append((".".join(stack) or "<module>", f"{modules[node.value.id]}.{node.attr}", node.lineno))
            elif id(node) not in skip and isinstance(node.ctx, ast.Load) and node.attr in SPAWN_ATTRIBUTES:
                found.append((".".join(stack) or "<module>", f"*.{node.attr}", node.lineno))
            self.generic_visit(node)

        def visit_Name(self, node):
            if id(node) not in skip and isinstance(node.ctx, ast.Load) and node.id in names:
                found.append((".".join(stack) or "<module>", names[node.id], node.lineno))

    Visitor().visit(tree)
    return found


def scan(root: Path) -> dict:
    """``{key: line}`` for every process-starting reference in the shipped runtime."""
    sites: dict = {}
    for path in sorted(root.rglob("*.py")):
        rel = path.relative_to(root).as_posix()
        if not _in_scope(rel):
            continue
        counts: dict = {}
        try:
            found = scan_file(path, rel)
        except (SyntaxError, UnicodeDecodeError):
            continue
        for qualname, callee, line in found:
            base = f"{rel}::{qualname}::{callee}"
            counts[base] = counts.get(base, 0) + 1
            sites[f"{base}#{counts[base]}"] = line
    return dict(sorted(sites.items()))


# Runtime roots outside the tool layer whose functions the tool layer may import and call (the gateway's shared
# helpers, the CLI's helpers, the package manager). A function there that starts a program is a SPAWN WRAPPER; every
# tool-layer import of one is a site of its own (``<file>::imports::<module>.<function>``).
_WRAPPER_ROOTS = ("hermes_cli", "gateway", "tui_gateway", "cron", "pm", "acp_adapter")
_WRAPPER_FILES = ("hermes_constants.py", "hermes_bootstrap.py", "utils.py")


def _module_name(rel: str) -> str:
    name = rel[:-3].replace("/", ".")
    return name[: -len(".__init__")] if name.endswith(".__init__") else name


def spawn_wrappers(root: Path) -> dict:
    """``{module: {function, …}}`` — top-level functions (or classes) outside the tool layer that start a program."""
    out: dict = {}
    paths = [p for d in _WRAPPER_ROOTS for p in (root / d).rglob("*.py")] + [root / f for f in _WRAPPER_FILES]
    for path in paths:
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if "/tests/" in f"/{rel}" or path.name.startswith("test_"):
            continue
        try:
            found = scan_file(path, rel)
        except (SyntaxError, UnicodeDecodeError):
            continue
        for qualname, _callee, _line in found:
            if qualname != "<module>":
                out.setdefault(_module_name(rel), set()).add(qualname.split(".")[0])
    return out


def wrapper_refs(root: Path) -> dict:
    """``{key: line}`` for every tool-layer ``from <module> import <spawn wrapper>``."""
    wrappers = spawn_wrappers(root)
    refs: dict = {}
    for top in SCAN_ROOTS:
        for path in sorted((root / top).rglob("*.py")):
            rel = path.relative_to(root).as_posix()
            if not _in_scope(rel):
                continue
            counts: dict = {}
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module in wrappers:
                    for alias in node.names:
                        if alias.name in wrappers[node.module]:
                            base = f"{rel}::imports::{node.module}.{alias.name}"
                            counts[base] = counts.get(base, 0) + 1
                            refs[f"{base}#{counts[base]}"] = node.lineno
    return dict(sorted(refs.items()))


def site_of(key: str) -> str:
    """``relpath::qualname`` — what the runtime's guard keys its decision on (the callee and its count dropped)."""
    return key.rsplit("::", 1)[0]


def default_row(key: str) -> dict:
    if key.startswith(ENV_DIRS):
        return {"verdict": "a", "why": "the environment backend's own process control (decided at runtime: a method "
                                       "of a non-host environment)"}
    return {"verdict": "b", "why": "refused by the spawn guard in a confined process (the default outcome)"}


def refresh(root: Path) -> dict:
    """The fixture with this tree's lines: decisions kept, vanished sites dropped, new ones at their default (a for
    the environment backends, b for everything else — the runtime default); ``c`` and ``h`` only ever by hand."""
    path = root / FIXTURE_REL
    old = json.loads(path.read_text()) if path.exists() else {"sites": {}}
    sites = {}
    for key, line in scan(root).items():
        row = dict(old["sites"].get(key) or default_row(key))
        row["line"] = line
        rel = key.split("::")[0]
        if row["why"].endswith(")") and f"({rel}:" in row["why"]:
            row["why"] = row["why"][:row["why"].rindex(f"({rel}:")] + f"({rel}:{line})"  # the cited line follows
        sites[key] = row
    return {"_": __doc__.split("\n\n")[0], "sites": dict(sorted(sites.items()))}


def fixed_sites(fixture: dict, verdict: str = "c") -> list:
    """The runtime allowlist (spawn_sites.json ``fixed`` for c, ``hermes`` for h) derived from the fixture."""
    return sorted({site_of(k) for k, row in fixture["sites"].items() if row["verdict"] == verdict})


if __name__ == "__main__":
    tree = Path(sys.argv[1]).resolve()
    data = refresh(tree)
    if "--write" in sys.argv:
        (tree / FIXTURE_REL).write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
        (tree / ALLOWLIST_REL).write_text(json.dumps({"_": ALLOWLIST_NOTE, "fixed": fixed_sites(data),
                                                      "hermes": fixed_sites(data, "h")}, indent=1) + "\n")
    counts: dict = {}
    for row in data["sites"].values():
        counts[row["verdict"]] = counts.get(row["verdict"], 0) + 1
    print(json.dumps({"sites": len(data["sites"]), "verdicts": counts}))
