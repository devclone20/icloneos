# The browser surface, as it actually is here

## First: which mode are you in?

Hermes ships two different browser surfaces and shows you exactly one. Look at
your own tool schema — never assume:

- **`browser_exec` is present** → Browser-Use CLI mode. Everything below applies.
  This is the mode on this machine (`is_browser_use_cli_mode()` is true, and
  `check_browser_requirements()` is false, so the built-ins are not registered).
- **`browser_navigate`, `browser_snapshot`, `browser_click`, … are present**
  → the built-in tools. Different model entirely: snapshot the page, act on
  `@e5`-style refs. `browser.backend: off` forces this.

`browser_exec` also disappears if the session's toolset lacks `terminal`. No
browser tool at all means a toolset problem, not a browser problem.

## `browser_exec(code*, session?, timeout_s?)`

`code` is **real Python**, stdlib available, executed by the Browser Use CLI
with the browser helpers pre-imported. `print(...)` is how data comes back.

Three properties that decide how you write every call:

1. **Fresh interpreter every call.** Your variables do not survive. The browser
   session and the workspace do.
2. **The workspace persists** at `$BH_AGENT_WORKSPACE` (also `workspace` in
   every result). Functions you define in `agent_helpers.py` there are
   auto-imported into every later call — that is how you build up your own
   vocabulary for a long task.
3. **Batch a whole sub-procedure per call** (navigate → wait → extract), not
   one action per call. But for long extractions prefer several medium calls
   that append to a workspace file over one giant call, so a timeout does not
   cost you everything.

Start `code` with a one-line comment under 60 chars describing the step in
plain language — the UI shows it as the step label to the owner.

`session="name"` gives an isolated named session. `timeout_s` defaults to 300,
max 1800.

## The helpers — all of them

The tool description names ten. Twenty-six exist, and the ones it omits are
most of what "click and work" needs. Verified against `browser_harness` 0.1.9.

### Navigation and tabs

| Helper | Signature | Notes |
|---|---|---|
| `new_tab` | `(url="about:blank")` | Use for the **first** navigation |
| `goto_url` | `(url)` | Navigate the current tab |
| `list_tabs` | `(include_chrome=True)` | Every open tab |
| `current_tab` | `()` | The one you are driving |
| `activate_tab` | `(target)` | Bring a tab to the front |
| `switch_tab` | `(target, activate=False)` | Drive a different tab |
| `close_tab` | `(target=None)` | Close it |
| `ensure_real_tab` | `()` | Recover from a stale or internal tab |
| `iframe_target` | `(url_substr)` | Get an iframe's target to drive inside it |

### Waiting — the difference between reliable and flaky

| Helper | Signature | Notes |
|---|---|---|
| `wait_for_load` | `(timeout=15.0)` | After a navigation |
| `wait_for_element` | `(selector, timeout=10.0, visible=False)` | **Wait for the thing before acting on it** |
| `wait_for_network_idle` | `(timeout=10.0, idle_ms=500)` | For pages that fill in after load |
| `wait` | `(seconds=1.0)` | Last resort. A fixed sleep is a guess |

### Acting

| Helper | Signature | Notes |
|---|---|---|
| `fill_input` | `(selector, text, clear_first=True, timeout=0.0)` | CSS selector, not a ref |
| `type_text` | `(text)` | Types into whatever has focus |
| `press_key` | `(key, modifiers=0)` | `Enter`, `Tab`, `Escape` |
| `dispatch_key` | `(selector, key="Enter", event="keypress")` | Fire a key **at** an element |
| `click_at_xy` | `(x, y, button="left", clicks=1)` | Viewport coordinates |
| `scroll` | `(x, y, dy=-300, dx=0)` | Scroll at a point |
| `upload_file` | `(selector, path)` | File inputs |

### Reading

| Helper | Signature | Notes |
|---|---|---|
| `page_info` | `()` | Summary of the current page state — start here |
| `js` | `(expression, target_id=None)` | Evaluate JS and return the value |
| `capture_screenshot` | `(path=None, full=False, max_dim=None)` | Saves and prints the path |
| `http_get` | `(url, headers=None, timeout=20.0)` | Fetch without navigating |
| `cdp` | `(method, session_id=None, **params)` | Raw DevTools Protocol |
| `drain_events` | `()` | Events queued since the last drain |

### `js()` has one sharp edge

`js('(() => { ... })()')` — a **bare** `'() => {…}'` returns the function
object, uncalled, and you get an unhelpful result rather than an error. Wrap
and invoke.

## Finding what to click

There are no refs in this mode. Two ways to locate an element:

**By CSS selector** — the normal path. `wait_for_element(sel)` then
`fill_input(sel, text)` or `js` to click it. Selectors you derived from
`page_info()` or from `js('document.querySelectorAll(...)')` are reliable;
selectors you guessed are not.

**By accessibility tree, when the DOM is opaque** (canvas apps, custom
widgets):

    nodes = cdp('Accessibility.getFullAXTree')['nodes']
    # thousands of nodes — filter in Python, never print them all
    hit = next(n for n in nodes if n.get('name', {}).get('value') == 'Submit')
    box = cdp('DOM.getBoxModel', backendNodeId=hit['backendDOMNodeId'])
    x, y = box['model']['content'][0], box['model']['content'][1]
    click_at_xy(x, y)

## A worked call

    # Searching the docs for the update command
    new_tab("https://example.com/docs")
    wait_for_load()
    fill_input("input[type=search]", "update")
    press_key("Enter")
    wait_for_network_idle()
    print(page_info())
    print(js("(() => [...document.querySelectorAll('h3')].map(e => e.textContent))()"))

One call, one sub-procedure, everything that matters printed.

## Failure shapes

| What you see | What it is | Do |
|---|---|---|
| `NameError` on a helper | Wrong mode — you are on the built-ins | Check your schema |
| The selector never matches | The page had not rendered it | `wait_for_element` before acting |
| `js` returns something odd | Bare arrow function, uncalled | Wrap as `(() => {…})()` |
| Variables gone next call | By design — fresh interpreter | Persist to `$BH_AGENT_WORKSPACE` |
| Stuck on an internal/blank tab | Stale tab | `ensure_real_tab()` |
| A wall, CAPTCHA or consent gate | Blocked, not broken | The `blocked-page-recovery` skill. **Never solve a CAPTCHA** |
| Login form on a site you expect to be signed into | Wrong session or expired cookies | Stop and ask. **Never type credentials** |
