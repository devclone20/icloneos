/**
 * iclone os — the `acp` argv allowlist: the command matrix and the gate
 * every renderer-supplied argv passes before the CLI is spawned. Pure — tested
 * through iclone-acp.ts.
 */

// ── the command matrix ──────────────────────────────────────────────────────

type Validator = (value: string) => boolean

/** `true` = a boolean flag (takes no value). */
interface Rule {
  flags?: Record<string, true | Validator>
  /** Free positional after the subcommand (a search query, a symbol). */
  positional?: Validator
  /** Values the main process overwrites whatever the renderer sent. */
  force?: Record<string, string>
  /** Parse the output and strip card numbers before it crosses IPC. */
  redact?: boolean
  /** Groups of flags of which at least one must be present. The CLI opens an
   *  interactive prompt for anything it is not told, and a prompt with no TTY
   *  hangs until the timeout — so a write that would prompt is refused here. */
  require?: string[][]
}

const re =
  (pattern: RegExp): Validator =>
  value =>
    pattern.test(value)

const text =
  (max: number): Validator =>
  value =>
    value.length <= max && !/[\0]/.test(value)

const int =
  (min: number, max: number): Validator =>
  value =>
    /^\d{1,6}$/.test(value) && Number(value) >= min && Number(value) <= max

const oneOf =
  (...allowed: string[]): Validator =>
  value =>
    allowed.includes(value)

const id = re(/^[A-Za-z0-9_.:-]{1,120}$/)
const decimal = re(/^\d{1,9}(\.\d{1,6})?$/)
const httpsUrl = (value: string) => value.length <= 500 && /^https:\/\/[^\s]+$/.test(value)
const csvIds = re(/^[A-Za-z0-9_.:-]{1,120}(,[A-Za-z0-9_.:-]{1,120}){0,39}$/)
const email = re(/^[^\s@]{1,64}@[^\s@]{1,190}\.[A-Za-z]{2,24}$/)
const symbol = re(/^[A-Za-z0-9.-]{1,24}$/)
const csvInts = re(/^\d{1,8}(,\d{1,8}){0,15}$/)

const sortFields = re(
  /^(successfulJobCount|successRate|uniqueBuyerCount|minsFromLastOnlineTime)(,(successfulJobCount|successRate|uniqueBuyerCount|minsFromLastOnlineTime)){0,3}$/
)

/** Every field of an offering: `create` needs them all, `update` any of them. */
const OFFERING_FIELDS: Record<string, true | Validator> = {
  '--name': text(120),
  '--description': text(2000),
  '--price-type': oneOf('fixed', 'percentage'),
  '--price-value': decimal,
  '--sla-minutes': int(5, 525_600),
  '--requirements': text(20_000),
  '--deliverable': text(20_000),
  '--required-funds': true,
  '--no-required-funds': true,
  '--hidden': true,
  '--no-hidden': true,
  '--subscription-ids': csvIds
}

const RULES: Record<string, Rule> = {
  // sign-in (the wizard's split start/complete)
  'configure start': {},
  'configure complete': { flags: { '--request-id': id } },

  // the agent
  'agent whoami': {},
  'agent list': {},
  'agent create': { flags: { '--name': text(120), '--description': text(2000) } },
  'agent use': { flags: { '--agent-id': id } },
  'agent add-signer': {
    flags: { '--agent-id': id, '--policy': oneOf('restricted'), '--no-wait': true },
    force: { '--policy': 'restricted' }
  },
  'agent signer-status': {
    flags: { '--agent-id': id, '--request-id': id, '--public-key': re(/^[A-Za-z0-9+/=_-]{1,400}$/) }
  },
  'agent signer-policy': { flags: { '--agent-id': id } },
  // ERC-8004 identity registration — signs one transaction, on the owner's click.
  'agent register-erc8004': { flags: { '--agent-id': id, '--chain-id': int(1, 99_999_999) } },

  // wallet — reads only
  'wallet address': {},
  'wallet balance': { flags: { '--chain-id': int(1, 99_999_999), '--token': symbol, '--ticker': symbol } },
  'wallet sol address': {},
  'wallet sol balance': { flags: { '--cluster': oneOf('mainnet', 'devnet') } },

  // email — reads, plus the two writes the owner performs by hand
  'email whoami': {},
  'email provision': {},
  'email inbox': {
    flags: { '--folder': re(/^[a-z]{1,20}$/), '--cursor': re(/^[A-Za-z0-9:.+_=-]{1,200}$/), '--limit': int(1, 100) }
  },
  'email thread': { flags: { '--thread-id': id } },
  'email search': { flags: { '--query': text(500) } },
  'email compose': { flags: { '--to': email, '--subject': text(500), '--body': text(20_000) } },
  'email reply': { flags: { '--thread-id': id, '--body': text(20_000) } },
  // The wizard reads the card's sign-in link out of the agent's own inbox.
  'email extract-links': { flags: { '--message-id': id }, require: [['--message-id']] },

  // the virtual card — never `issue`, never a real number over IPC
  'card whoami': { redact: true },
  'card signup': { flags: { '--email': email }, redact: true },
  'card signup-poll': { flags: { '--state': id }, redact: true },
  'card profile': { redact: true },
  // Detach: wipes name, phone and payment method (DELETE card/profile); moves no value.
  'card profile reset': { redact: true },
  // The CLI's own flags (E.164 phone) — the wizard sends exactly these.
  'card profile set': {
    flags: { '--first-name': text(60), '--last-name': text(60), '--phone-number': re(/^\+[1-9]\d{1,14}$/) },
    redact: true
  },
  'card payment-method': { redact: true },
  'card limit': { redact: true },
  // The last step of the card state machine (integer cents, CLI minimum 100).
  'card limit set': { flags: { '--amount': int(100, 1_000_000) }, redact: true },
  'card list': { redact: true },
  'card get': { flags: { '--request-id': id }, redact: true },
  'card 3ds': { redact: true },

  // Hyperliquid — account reads and the market list
  'trade hl-status': {},
  'trade hl-orders': { flags: { '--coin': symbol } },
  'trade stock-list': { positional: symbol },

  // the marketplace
  browse: {
    positional: text(500),
    flags: {
      '--top-k': int(1, 100),
      '--online': oneOf('all', 'online', 'offline'),
      '--mode': oneOf('relevance', 'recency', 'mixed'),
      '--sort-by': sortFields,
      '--chain-ids': csvInts,
      '--cluster': re(/^[A-Za-z0-9_-]{1,40}$/),
      '--mix-new-count': int(0, 50)
    }
  },
  'offering list': {},
  // The catalogue the iNFT sells — the owner writes it here or the agent does
  // from Message; every flag the CLI would otherwise prompt for is required.
  'offering create': {
    flags: OFFERING_FIELDS,
    require: [
      ['--name'],
      ['--description'],
      ['--price-type'],
      ['--price-value'],
      ['--sla-minutes'],
      ['--requirements'],
      ['--deliverable'],
      ['--required-funds', '--no-required-funds'],
      ['--hidden', '--no-hidden']
    ]
  },
  'offering update': {
    flags: { '--offering-id': id, ...OFFERING_FIELDS },
    require: [['--offering-id']]
  },
  'offering delete': { flags: { '--offering-id': id, '--force': true }, require: [['--offering-id'], ['--force']] },
  'resource list': {},
  'resource create': {
    flags: {
      '--name': text(120),
      '--description': text(2000),
      '--url': httpsUrl,
      '--params': text(20_000),
      '--hidden': true,
      '--no-hidden': true
    },
    require: [['--name'], ['--description'], ['--url'], ['--params'], ['--hidden', '--no-hidden']]
  },
  'subscription list': {},
  'subscription create': {
    flags: { '--name': text(120), '--price': decimal, '--duration-days': oneOf('7', '15', '30', '90') },
    require: [['--name'], ['--price'], ['--duration-days']]
  },
  'subscription update': {
    flags: { '--id': id, '--price': decimal, '--duration-days': oneOf('7', '15', '30', '90') },
    require: [['--id']]
  },
  'subscription delete': { flags: { '--id': id, '--force': true }, require: [['--id'], ['--force']] },
  'job list': { flags: { '--all': true, '--legacy': true } },
  'job history': { flags: { '--job-id': id, '--chain-id': int(1, 99_999_999) } },

  'chain list': {},
  'compute status': {}
}

const ROOTS = new Set(Object.keys(RULES).map(key => key.split(' ')[0]))

/**
 * The gate. Returns the argv the CLI will receive, or null. Pure — tested.
 *
 * Shape: `root [sub [sub2]] (--flag value | --bool | positional)* --json?`.
 * The longest listed command prefix wins; no token before it may be a flag;
 * every flag after it must be listed for that command with a value its
 * validator accepts; positionals only where the rule allows one.
 */
export function validateArgv(argv: unknown): string[] | null {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 24) {
    return null
  }

  const args = argv.map(String)

  for (const arg of args) {
    if (arg.length > 20_000 || /[\r\0]/.test(arg)) {
      return null
    }
  }

  if (!ROOTS.has(args[0])) {
    return null
  }

  // The command is the longest run of non-flag tokens that names a rule.
  let rule: Rule | undefined
  let commandLength = 0

  for (let length = Math.min(3, args.length); length >= 1; length--) {
    const head = args.slice(0, length)

    if (head.some(token => token.startsWith('-'))) {
      continue
    }

    const candidate = RULES[head.join(' ')]

    if (candidate) {
      rule = candidate
      commandLength = length

      break
    }
  }

  if (!rule) {
    return null
  }

  const flags = rule.flags ?? {}
  const out = args.slice(0, commandLength)
  let positionals = 0
  let sawJson = false

  for (let index = commandLength; index < args.length; index++) {
    const token = args[index]

    if (token === '--json') {
      sawJson = true

      continue
    }

    if (token.startsWith('-')) {
      const spec = flags[token]

      if (!spec) {
        return null
      }

      if (spec === true) {
        out.push(token)

        continue
      }

      const value = args[index + 1]

      if (value === undefined || value === '--json' || !spec(value)) {
        return null
      }

      out.push(token, rule.force?.[token] ?? value)
      index += 1

      continue
    }

    if (!rule.positional || positionals >= 1 || !rule.positional(token)) {
      return null
    }

    out.push(token)
    positionals += 1
  }

  // A forced flag the renderer left out is still applied.
  for (const [flag, value] of Object.entries(rule.force ?? {})) {
    if (!out.includes(flag)) {
      out.push(flag, value)
    }
  }

  // A write the CLI would have to ask about never leaves here.
  for (const group of rule.require ?? []) {
    if (!group.some(flag => out.includes(flag))) {
      return null
    }
  }

  if (sawJson) {
    out.push('--json')
  }

  return out
}

/** The matrix key an argv falls under: the longest known command prefix. */
function commandKey(args: readonly string[]): string | undefined {
  for (let length = Math.min(3, args.length); length >= 1; length--) {
    const key = args.slice(0, length).join(' ')

    if (Object.hasOwn(RULES, key)) {
      return key
    }
  }

  return undefined
}

export function ruleFor(args: string[]): Rule | undefined {
  const key = commandKey(args)

  return key === undefined ? undefined : RULES[key]
}

// Proven read-only against the bundled CLI: none of these writes its config
// (`agent list` does — it stores the agents it lists) or rotates anything but
// the session token every call may refresh. Anything else runs alone.
const READS = new Set([
  'agent whoami',
  'agent signer-policy',
  'wallet address',
  'wallet balance',
  'wallet sol address',
  'wallet sol balance',
  'email whoami',
  'email inbox',
  'email thread',
  'email search',
  'card whoami',
  'card profile',
  'card payment-method',
  'card limit',
  'card list',
  'card get',
  'trade hl-status',
  'trade hl-orders',
  'trade stock-list',
  'offering list',
  'resource list',
  'subscription list',
  'job list',
  'job history',
  'chain list',
  'compute status'
])

/** True when this argv may run beside other reads of the same iNFT. */
export function isAcpRead(args: readonly string[]): boolean {
  const key = commandKey(args)

  return key !== undefined && READS.has(key)
}
