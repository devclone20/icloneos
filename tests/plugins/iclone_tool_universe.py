"""V3-UP r3 (UP3-1) — derive, by machine, every tool name the runtime under test can put in front of the permission hook.

Ruling 43: the universe of KNOWN tools at the pin must be complete — 0 unknowns across built-ins, bundled plugins,
legacy aliases, lookup/meta tools and every name the Tool Search index can return. This module is that derivation.
It runs in a FRESH interpreter (``python -m tests.plugins.iclone_tool_universe <tree> [--write]``) with a throwaway
HERMES_HOME, and every source is read from the tree itself, never written down here:

registry      tools/registry.py after ``model_tools`` discovery (built-ins + the default-on plugins)
static        every literal ``registry.register(name=…)`` / ``register_tool(name=…)`` in the runtime's code (AST):
              catches a tool registered lazily or behind a flag that discovery did not hit
plugins       every bundled plugin's ``register(ctx)`` run against a recording context (opt-in plugins included)
manifests     every bundled plugin manifest's ``provides_tools``
memory        every bundled memory provider's ``get_tool_schemas()`` (injected into the agent, not registered)
context       every bundled context engine's ``get_tool_schemas()`` (injected the same way)
inline        ``agent.inline_tool_executors.INLINE_TOOL_EXECUTORS`` (the agent loop's own tools)
injected      schemas the agent appends itself (``tools.bot_mode_dm.message_agent_tool_schema``)
aliases       ``model_tools._LEGACY_TOOL_ALIASES`` (old name → the name the hook sees)
bridges       ``tools.tool_search_catalog.BRIDGE_TOOL_NAMES`` (tool_search / tool_describe / tool_call)
search_index  the names ``tools.tool_search`` indexes and can return: the deferrable subset of the full tool
              definitions with every toolset enabled (what ``tool_search`` / ``tool_describe`` answer with)

Dynamic families are not names and cannot be enumerated: ``mcp__<server>__<tool>`` (``MCP_TOOL_NAME_PREFIX``) and
``connectors__…`` (``CONNECTOR_NAME_PREFIX``). They are recorded by their prefix, read from the tree, and ruling 40
classes them with the unknown (strictest) class.
"""

from __future__ import annotations

import ast
import glob
import json
import logging
import os
import re
import sys
import types
from pathlib import Path

FIXTURE_REL = "plugins/iclone-permissions/tests/fixtures/tool_universe.json"

# Directories holding runtime code the static scan reads (tests and the app are not the runtime).
_STATIC_ROOTS = ("tools", "plugins", "agent", "gateway", "tui_gateway", "hermes_cli", "cron", "acp_adapter")
_STATIC_FILES = ("model_tools.py", "run_agent.py", "toolsets.py")
_NAME = re.compile(r"[a-z][a-z0-9_]*\Z")


def _static(root: Path) -> dict:
    """``{name: [file, …]}`` for every literal tool name passed to ``register``/``register_tool`` (AST)."""
    found: dict = {}
    files = [p for d in _STATIC_ROOTS for p in (root / d).rglob("*.py")] + [root / f for f in _STATIC_FILES]
    for path in sorted(f for f in files if f.is_file()):
        rel = path.relative_to(root).as_posix()
        if "/tests/" in f"/{rel}" or path.name.startswith("test_") or rel.startswith("plugins/iclone-"):
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except (SyntaxError, UnicodeDecodeError):
            continue
        consts: dict = {}
        for node in ast.walk(tree):  # NAME = "x" and SCHEMA = {"name": "x", …}
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                    consts[node.targets[0].id] = node.value.value
                elif isinstance(node.value, ast.Dict):
                    for k, v in zip(node.value.keys, node.value.values):
                        if isinstance(k, ast.Constant) and k.value == "name" and isinstance(v, ast.Constant):
                            consts[node.targets[0].id + "['name']"] = v.value

        def value(expr):
            if isinstance(expr, ast.Constant):
                return expr.value
            if isinstance(expr, ast.Name):
                return consts.get(expr.id)
            if (isinstance(expr, ast.Subscript) and isinstance(expr.value, ast.Name)
                    and isinstance(expr.slice, ast.Constant) and expr.slice.value == "name"):
                return consts.get(expr.value.id + "['name']")
            return None

        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            fn = node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", "")
            owner = node.func.value if isinstance(node.func, ast.Attribute) else None
            owner_name = getattr(owner, "id", "") or getattr(owner, "attr", "")
            if fn == "register_tool" or (fn == "register" and owner_name in ("registry", "_registry", "tool_registry")):
                cands = [kw.value for kw in node.keywords if kw.arg == "name"] + node.args[:1]
                for expr in cands:
                    name = value(expr)
                    if isinstance(name, str) and _NAME.match(name):
                        found.setdefault(name, set()).add(rel)
    return {k: sorted(v) for k, v in sorted(found.items())}


class _Recorder:
    """A ``register(ctx)`` context that records tools, memory providers and context engines; everything else no-op."""

    def __init__(self, owner: str, out: dict):
        self.owner, self.out = owner, out

    def register_tool(self, *args, **kwargs):
        name = kwargs.get("name") or (args[0] if args and isinstance(args[0], str) else None)
        schema = kwargs.get("schema")
        if schema is None:
            schema = next((a for a in args[1:] if isinstance(a, dict)), None)
        if name is None and isinstance(schema, dict):
            name = schema.get("name")
        self.out["plugins"].setdefault(name or "<unnamed>", set()).add(self.owner)
        if name and isinstance(schema, dict):
            self.out["schemas"].setdefault(name, schema)

    def register_memory_provider(self, provider):
        self.out["providers"].append((self.owner, provider))

    def register_context_engine(self, engine):
        self.out["engines"].append((self.owner, engine))

    def __getattr__(self, name):
        return lambda *a, **k: None


# A string argument whose NAME or DESCRIPTION suggests it may name a file, a directory or a location. Deliberately
# broad: every candidate must be decided (a local-path kind in classify.PATH_ARGS, or "not local" with its reason in
# the tool-table test), so a new path argument upstream adds can never pass unread.
_PATH_NAME = re.compile(r"path|file|dir|folder|workdir|workspace|cwd|root|image|video|audio|media|attach|upload|"
                        r"output|dest|source|src|url|uri|location|resource", re.I)
_PATH_DESC = re.compile(r"local (file|path)|file ?path|path to|directory|folder|file system|filesystem", re.I)


def _path_candidates(name: str, schema: dict, out: dict) -> None:
    fn = schema.get("function", schema) if isinstance(schema, dict) else {}
    params = (fn or {}).get("parameters") or {}

    def walk(props, prefix):
        for key, spec in (props or {}).items():
            if not isinstance(spec, dict):
                continue
            kind = spec.get("type")
            if isinstance(kind, list):  # ["string", "null"]
                kind = next((k for k in kind if k != "null"), None)
            desc = str(spec.get("description") or "")
            if kind == "object":
                walk(spec.get("properties"), f"{prefix}{key}.")
                continue
            items = spec.get("items") if kind == "array" and isinstance(spec.get("items"), dict) else None
            if items is not None and items.get("type") == "object":
                walk(items.get("properties"), f"{prefix}{key}[].")
                continue
            leaf_type = items.get("type") if items is not None else kind
            leaf = f"{prefix}{key}[]" if items is not None else f"{prefix}{key}"
            if leaf_type not in ("string", None):
                continue
            if _PATH_NAME.search(key) or _PATH_DESC.search(desc):
                out.setdefault(name, {})[leaf] = desc[:160]

    walk(params.get("properties"), "")


def _schema_names(schemas) -> list:
    names = []
    for raw in schemas or []:
        fn = raw.get("function", raw) if isinstance(raw, dict) else {}
        if isinstance(fn, dict) and isinstance(fn.get("name"), str):
            names.append(fn["name"])
    return names


def derive(root: Path) -> dict:
    """The universe of THIS tree (call in a fresh interpreter whose sys.path starts at ``root``)."""
    logging.disable(logging.CRITICAL)
    import model_tools
    from agent.inline_tool_executors import INLINE_TOOL_EXECUTORS
    from tools.registry import registry
    from tools import tool_search
    from tools.tool_search_catalog import BRIDGE_TOOL_NAMES
    from tools.mcp_tool_schema import MCP_TOOL_NAME_PREFIX
    from tools.connectors.gateway.names import CONNECTOR_NAME_PREFIX
    from tools.bot_mode_dm import message_agent_tool_schema
    import hermes_yaml as yaml

    registered = sorted(registry.get_all_tool_names())

    rec = {"plugins": {}, "providers": [], "engines": [], "schemas": {}}
    errors = {}
    if "hermes_plugins" not in sys.modules:
        ns = types.ModuleType("hermes_plugins")
        ns.__path__ = []
        sys.modules["hermes_plugins"] = ns
    manifests: dict = {}
    import importlib.util
    for manifest in sorted(glob.glob(str(root / "plugins" / "**" / "plugin.y*ml"), recursive=True)):
        d = Path(manifest).parent
        rel = d.relative_to(root).as_posix()
        if rel.split("/")[1].startswith("iclone-") or "/tests/" in f"/{rel}/":
            continue  # icloneOS' own plugins register hooks, never tools
        for name in (yaml.safe_load(open(manifest, encoding="utf-8")) or {}).get("provides_tools") or []:
            manifests.setdefault(name, []).append(rel)
        init = d / "__init__.py"
        if not init.is_file():
            continue
        mod_name = "hermes_plugins.universe_" + re.sub(r"\W", "_", rel)
        try:
            spec = importlib.util.spec_from_file_location(mod_name, init, submodule_search_locations=[str(d)])
            mod = importlib.util.module_from_spec(spec)
            sys.modules[mod_name] = mod
            spec.loader.exec_module(mod)
            if hasattr(mod, "register"):
                mod.register(_Recorder(rel, rec))
        except Exception as exc:  # recorded: the test fails on any plugin it could not read
            errors[rel] = f"{type(exc).__name__}: {str(exc)[:160]}"

    schemas = dict(rec["schemas"])
    memory: dict = {}
    for owner, provider in rec["providers"]:
        try:
            for raw in provider.get_tool_schemas():
                for name in _schema_names([raw]):
                    memory.setdefault(name, []).append(owner)
                    schemas.setdefault(name, raw)
        except Exception as exc:
            errors[owner + ":get_tool_schemas"] = f"{type(exc).__name__}: {str(exc)[:160]}"
    context: dict = {}
    for owner, engine in rec["engines"]:
        try:
            for raw in engine.get_tool_schemas():
                for name in _schema_names([raw]):
                    context.setdefault(name, []).append(owner)
                    schemas.setdefault(name, raw)
        except Exception as exc:
            errors[owner + ":get_tool_schemas"] = f"{type(exc).__name__}: {str(exc)[:160]}"
    for name in registered:
        entry = registry.get_entry(name)
        if entry is not None and isinstance(getattr(entry, "schema", None), dict):
            schemas[name] = entry.schema

    # The Tool Search index: what the bridge can return is the deferrable subset of the session's tool definitions.
    # ``search_index`` is that subset of the registry under the shipped ``defer`` default (deterministic: it does not
    # depend on which providers this machine has keys for); ``search_index_built`` is the catalog the bridge really
    # builds here with every toolset on (machine-dependent, never committed) and must be inside it.
    default_defer = tool_search._DEFAULT_DEFERRED_TOOLS
    search_index = sorted(n for n in registered if tool_search.is_deferrable_tool_name(n, default_defer))
    all_toolsets = sorted(model_tools.get_available_toolsets())
    defs = model_tools.get_tool_definitions(enabled_toolsets=all_toolsets, quiet_mode=True,
                                            skip_tool_search_assembly=True) or []
    built = sorted({entry.name for entry in tool_search.build_catalog(
        tool_search.classify_tools(defs, default_defer)[1])})

    injected_schema = message_agent_tool_schema()
    injected = {injected_schema["function"]["name"]: "tools/bot_mode_dm.py"}
    schemas.setdefault(injected_schema["function"]["name"], injected_schema)
    path_args: dict = {}
    for name in sorted(schemas):
        _path_candidates(name, schemas[name], path_args)
    return {
        "registry": registered,
        "toolsets": {n: registry.get_toolset_for_tool(n) for n in registered},
        "static": _static(root),
        "plugins": {k: sorted(v) for k, v in sorted(rec["plugins"].items())},
        "manifests": {k: sorted(v) for k, v in sorted(manifests.items())},
        "memory": {k: sorted(v) for k, v in sorted(memory.items())},
        "context": {k: sorted(v) for k, v in sorted(context.items())},
        "inline": sorted(INLINE_TOOL_EXECUTORS),
        "injected": injected,
        "aliases": dict(sorted(model_tools._LEGACY_TOOL_ALIASES.items())),
        "bridges": sorted(BRIDGE_TOOL_NAMES),
        "search_index": search_index,
        "search_index_built": built,
        "families": {"mcp": MCP_TOOL_NAME_PREFIX, "connectors": CONNECTOR_NAME_PREFIX},
        "path_args": {k: dict(sorted(v.items())) for k, v in sorted(path_args.items())},
        "schemaless": sorted(set(names_of_parts(registered, rec, memory, context, injected)) - set(schemas)),
        "errors": errors,
    }


def names_of_parts(registered, rec, memory, context, injected) -> list:
    return sorted(set(registered) | set(rec["plugins"]) | set(memory) | set(context) | set(injected))


def names(universe: dict) -> list:
    """Every static name in a derived universe (dynamic families excluded)."""
    out = set(universe["registry"]) | set(universe["inline"]) | set(universe["injected"]) | set(universe["aliases"])
    out |= set(universe["bridges"]) | set(universe["search_index"])
    for key in ("static", "plugins", "manifests", "memory", "context"):
        out |= set(universe[key])
    return sorted(out)


def fixture_view(universe: dict) -> dict:
    """What is committed: per name its sources (so a diff says WHERE a new name came from), plus the families."""
    sources: dict = {}
    for key in ("registry", "inline", "bridges", "search_index"):
        for n in universe[key]:
            sources.setdefault(n, set()).add(key)
    for key in ("static", "plugins", "manifests", "memory", "context", "injected"):
        for n in universe[key]:
            sources.setdefault(n, set()).add(key)
    for old in universe["aliases"]:
        sources.setdefault(old, set()).add("alias")
    return {
        "_": "generated by `python -m tests.plugins.iclone_tool_universe <tree> --write`; never edit by hand",
        "names": {n: sorted(s) for n, s in sorted(sources.items())},
        "aliases": universe["aliases"],
        "families": universe["families"],
        "pathArgs": {tool: sorted(args) for tool, args in universe["path_args"].items()},
    }


if __name__ == "__main__":
    tree = Path(sys.argv[1]).resolve()
    universe = derive(tree)
    if "--write" in sys.argv:
        (tree / FIXTURE_REL).write_text(json.dumps(fixture_view(universe), indent=1, sort_keys=False) + "\n")
    print("UNIVERSE-JSON" + json.dumps(universe))
