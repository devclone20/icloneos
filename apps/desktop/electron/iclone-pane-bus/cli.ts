/**
 * The `it bus …` branch of the installed `it` script (spliced into CLI_SOURCE
 * by iclone-it.ts). It talks to the bus over the Unix socket named in the
 * pane's environment — never TCP — and presents the pane's own token on
 * stdin (`printf` is a builtin), so the token never reaches argv.
 *
 * The cost of a call is the hop budget: `sh` + `curl` on the common path
 * (plain printable-ASCII arguments are JSON as they stand), plus one `awk`
 * when an argument needs escaping. r1 forked `sed` and `awk` per argument
 * (~35 ms a hop). `nc -U` would save ~3 ms more but half-closes the socket at
 * the end of stdin, which a server cannot tell from a client that hung up —
 * and the per-pane cap of open requests relies on seeing hang-ups.
 *
 * A shell inside tmux gets no bus: a tmux shell outlives the pane that started
 * it, and its environment is frozen at session creation (see pane-env.ts).
 *
 * String.raw: this text is shell, read by /bin/sh exactly as written here.
 */
export const BUS_CLI_FRAGMENT = String.raw`
if [ "$1" = "bus" ]; then
  shift
  if [ -n "$TMUX" ]; then
    echo "it bus: no bus inside tmux in this release (a tmux shell outlives its pane, so it holds no bus identity)" >&2
    exit 1
  fi
  if [ -z "$ICLONE_PANE_TOKEN" ] || [ ! -S "$ICLONE_PANE_SOCK" ]; then
    echo "it bus: this shell is not an iT pane of a running iclone os" >&2
    exit 1
  fi
  LC_ALL=C
  export LC_ALL
  BUS_PLAIN=1
  for BUS_ARG in "$@"; do
    case $BUS_ARG in *[!\ -~]* | *\"* | *\\*) BUS_PLAIN=0; break ;; esac
  done
  if [ "$BUS_PLAIN" -eq 1 ]; then
    BUS_BODY=
    for BUS_ARG in "$@"; do BUS_BODY="$BUS_BODY,\"$BUS_ARG\""; done
    BUS_BODY="{\"argv\":[${'$'}{BUS_BODY#,}]}"
  else
    BUS_BODY=$(awk 'BEGIN {
      for (c = 1; c < 32; c++) code[sprintf("%c", c)] = sprintf("\\u%04x", c)
      code["\n"] = "\\n"; code["\t"] = "\\t"; code["\r"] = "\\r"
      code["\\"] = "\\\\"; code["\""] = "\\\""
      for (i = 1; i < ARGC; i++) {
        s = ARGV[i]; e = ""; n = length(s)
        for (k = 1; k <= n; k++) { ch = substr(s, k, 1); e = e ((ch in code) ? code[ch] : ch) }
        out = out (i > 1 ? "," : "") "\"" e "\""
      }
      printf "{\"argv\":[%s]}", out
    }' "$@")
  fi
  BUS_OUT=$(printf 'Authorization: Pane %s\n' "$ICLONE_PANE_TOKEN" | curl -s --fail-with-body -m 700 \
    --unix-socket "$ICLONE_PANE_SOCK" -X POST http://pane/bus -H @- \
    -H "Content-Type: application/json" --data-binary "$BUS_BODY")
  BUS_STATUS=$?
  if [ "$BUS_STATUS" -eq 0 ]; then
    [ -z "$BUS_OUT" ] || printf '%s\n' "$BUS_OUT"
    exit 0
  fi
  printf '%s\n' "${'$'}{BUS_OUT:-it bus: cannot reach the bus (curl exit $BUS_STATUS)}" >&2
  exit 1
fi
`
