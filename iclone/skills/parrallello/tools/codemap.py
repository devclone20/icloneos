#!/usr/bin/env python3
"""codemap.py <file> [--grep PATTERN] [--max N]
Index of functions/classes with line ranges, so an agent reads only the slice it needs (`sed -n 'a,bp'`).
  .py           -> ast (exact ranges, decorators included, Class.method names)
  .js/.mjs/.cjs -> regex + a string/comment/template/regex-aware brace matcher
Prints `start-end  name` (one per line, at most --max lines, default 200). Exit 2 on unreadable/unsupported input."""
import argparse
import ast
import re
import sys
from pathlib import Path


def py_items(src):
    tree = ast.parse(src)
    out = []

    def visit(node, prefix, depth):
        for ch in ast.iter_child_nodes(node):
            if isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                start = min([ch.lineno] + [d.lineno for d in ch.decorator_list])
                kind = "class " if isinstance(ch, ast.ClassDef) else ""
                out.append((start, ch.end_lineno, depth, f"{kind}{prefix}{ch.name}"))
                # methods of classes always; nested defs only one level deep (keeps the map short)
                if isinstance(ch, ast.ClassDef) or depth == 0:
                    visit(ch, f"{prefix}{ch.name}.", depth + 1)

    visit(tree, "", 0)
    return out


# ---------- JavaScript ----------
KW = {"if", "for", "while", "switch", "catch", "function", "return", "with", "else", "do", "try", "typeof",
      "new", "await", "yield", "super", "import", "export", "constructor_"}
JS_PATTERNS = [
    ("fn", re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(")),
    ("class", re.compile(r"^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)")),
    ("arrow", re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?"
                         r"(?:function\b|\([^()]*(?:\([^()]*\)[^()]*)*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)")),
    ("prop", re.compile(r"^\s+([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)")),
    ("method", re.compile(r"^\s+(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?\*?\s*(#?[A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{\s*(?://.*)?$")),
]
REGEX_PREV = set("(,=:[!&|?{};+-*%<>~^") | {""}


def js_braces(src):
    """Return list of (line, char, depth_after) for code braces; skips strings, comments, templates, regex literals."""
    ev, depth, line, i, n = [], 0, 1, 0, len(src)
    stack = []  # 'T' = inside template expression ${ ... }: a closing brace at its base depth returns to the template
    prev = ""   # previous significant code char (for regex detection)
    def skip_template(i, line):
        # at src[i] inside a template literal (after the backtick); return (i, line, entered_expr)
        while i < n:
            c = src[i]
            if c == "\\":
                if i + 1 < n and src[i + 1] == "\n":
                    line += 1
                i += 2; continue
            if c == "\n":
                line += 1
            if c == "`":
                return i + 1, line, False
            if c == "$" and i + 1 < n and src[i + 1] == "{":
                return i + 2, line, True
            i += 1
        return i, line, False
    while i < n:
        c = src[i]
        if c == "\n":
            line += 1; i += 1; continue
        if c in " \t\r":
            i += 1; continue
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            j = src.find("\n", i); i = n if j < 0 else j; continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2); j = n if j < 0 else j + 2
            line += src.count("\n", i, j); i = j; continue
        if c in "'\"":
            j = i + 1
            while j < n and src[j] != c and src[j] != "\n":
                j += 2 if src[j] == "\\" else 1
            i = j + 1; prev = "a"; continue
        if c == "`":
            i, line, expr = skip_template(i + 1, line)
            if expr:
                stack.append(depth); depth += 1
            prev = "a"; continue
        if c == "/" and prev in REGEX_PREV:
            j, cls = i + 1, False
            while j < n and src[j] != "\n":
                if src[j] == "\\":
                    j += 2; continue
                if src[j] == "[":
                    cls = True
                elif src[j] == "]":
                    cls = False
                elif src[j] == "/" and not cls:
                    break
                j += 1
            if j < n and src[j] == "/":
                i = j + 1; prev = "a"; continue
        if c == "{":
            depth += 1; ev.append((line, "{", depth))
        elif c == "}":
            if stack and depth - 1 == stack[-1]:
                stack.pop(); depth -= 1
                i, line, expr = skip_template(i + 1, line)
                if expr:
                    stack.append(depth); depth += 1
                prev = "a"; continue
            depth -= 1; ev.append((line, "}", depth))
        if c.isalnum() or c in "_$":
            j = i
            while j < n and (src[j].isalnum() or src[j] in "_$"):
                j += 1
            word = src[i:j]
            prev = "" if word in ("return", "typeof", "case", "in", "of", "delete", "void", "yield", "await") else "a"
            i = j; continue
        prev = c if c in REGEX_PREV else ("a" if c in ")]" else c)
        i += 1
    return ev


def js_items(src):
    lines = src.split("\n")
    ev = js_braces(src)
    hits = []
    for ln, text in enumerate(lines, 1):
        if len(text) > 400:
            continue
        for kind, rx in JS_PATTERNS:
            m = rx.match(text)
            if not m:
                continue
            name = m.group(1)
            if kind == "method" and (name in KW or name == "function"):
                continue
            hits.append((ln, kind, name, text))
            break
    out = []
    for ln, kind, name, text in hits:
        end = ln
        if kind == "arrow" and not re.search(r"=>\s*[{(]?\s*(?://.*)?$", text) and "{" not in text.split("=>", 1)[-1]:
            end = ln  # single-expression arrow
        else:
            # body brace = first '{' from this line on whose matching '}' is on a later line
            # (skips `= {}` defaults / inline objects in the signature; all closed on the line -> one-liner)
            k0 = next((idx for idx, e in enumerate(ev) if e[0] >= ln), len(ev))
            seen = False
            for k in range(k0, len(ev)):
                e = ev[k]
                if e[0] > ln + 3 or (seen and e[0] > ln):
                    break  # braces on the start line all closed there -> one-liner (end stays = ln)
                if e[1] != "{":
                    continue
                seen = seen or e[0] == ln
                d = e[2]
                close = next((c for c in ev[k + 1:] if c[1] == "}" and c[2] == d - 1), None)
                if close is None:
                    end = len(lines); break
                if close[0] > e[0] or e[0] > ln:
                    end = close[0]; break
        out.append([ln, end, kind, name])
    # qualify methods with their enclosing class
    classes = [(a, b, nm) for a, b, k, nm in out if k == "class"]
    res = []
    for a, b, k, nm in out:
        owner = None
        if k in ("method", "prop", "fn", "arrow"):
            inside = [c for c in classes if c[0] < a <= c[1]]
            owner = inside[-1][2] if inside else None
        label = ("class " if k == "class" else "") + (f"{owner}.{nm}" if owner and k != "class" else nm)
        res.append((a, b, 1 if owner else 0, label))
    return res


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("file")
    ap.add_argument("--grep", default=None, help="regex filter on names (case-insensitive)")
    ap.add_argument("--max", type=int, default=200)
    a = ap.parse_args()
    p = Path(a.file)
    try:
        src = p.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        print(f"codemap: {e}", file=sys.stderr); sys.exit(2)
    ext = p.suffix.lower()
    try:
        if ext in (".py", ".pyw"):
            items = py_items(src)
        elif ext in (".js", ".mjs", ".cjs", ".jsx", ".ts"):
            items = js_items(src)
        else:
            print(f"codemap: unsupported extension {ext}", file=sys.stderr); sys.exit(2)
    except SyntaxError as e:
        print(f"codemap: syntax error {e}", file=sys.stderr); sys.exit(2)
    if a.grep:
        rx = re.compile(a.grep, re.I)
        items = [it for it in items if rx.search(it[3])]
    items.sort(key=lambda t: (t[0], t[2]))
    nlines = src.count("\n") + 1
    head = f"# {p.name}: {nlines} lines, {len(items)} items"
    print(head)
    lim = len(items) if len(items) <= a.max - 1 else max(1, a.max - 2)  # header + items (+ overflow line) <= --max
    for s, e, depth, name in items[:lim]:
        print(f"{s}-{e}  {'  ' * depth}{name}")
    if len(items) > lim:
        print(f"... +{len(items) - lim} more (narrow with --grep)")


if __name__ == "__main__":
    main()
