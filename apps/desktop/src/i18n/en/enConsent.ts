// iclone os — first-launch consent sheet + Settings › Privacy (src/components/consent, privacy-settings.tsx).
// The policy text itself is NOT here: it comes verbatim from the bundled policy (electron/policy-version.generated.ts).

/** The product wordmark as the UI spells it (U1-12-p2): one name in every consent and privacy sentence. */
export const PRODUCT_NAME = 'iclone os'

/** The shape every locale's consent bank fills (U2-p2b-01). A translated bank names every switch itself: the policy's
 *  §9 table is English, so `rows` is open to all keys; the English bank carries only the rows the table lacks. */
export type ConsentBank = Omit<typeof enConsent, 'rows'> & {
  rows: Partial<Record<string, { name: string; purpose: string }>>
}

export const enConsent = {
  sheet: {
    // The document is named by the title it bears (policy.title), never re-spelled by the UI (U1-12-p2 r2).
    eyebrow: (title: string, version: string, effective: string) =>
      `${title} · Version ${version} · Effective ${effective}`,
    termsTitle: 'Before you begin',
    termsLead: `${PRODUCT_NAME} runs your agent on this Mac. This is the short version of how it treats your data.`,
    updateTitle: 'Our policy has changed',
    updateLead: `Read and accept the new version to keep using ${PRODUCT_NAME}. Your saved permission choices stay as they are.`,
    readFull: 'Read the full policy',
    readOffline: 'Read offline',
    hideOffline: 'Hide the full text',
    offlineUnavailable: 'The bundled copy could not be read. The full policy is at cloneframe.io/privacy.',
    // Shown beside the policy in every language but English (U2-p2b-01): the English text is the one that binds.
    policyLanguage: 'The policy is written in English; the English text is the binding version.',
    aiDisclosure:
      'When you connect an AI provider, your messages, files, persona and memory, and tool results including the screen are sent directly from this Mac to that provider (policy §5).',
    accept: (title: string, version: string) =>
      `I have read and accept ${title} v${version}, including sending to the AI provider I connect`,
    quit: 'Quit',
    continue: 'Continue',
    permissionsEyebrow: 'Permissions',
    permissionsTitle: `What your agent and ${PRODUCT_NAME} may do on this Mac`,
    permissionsFooter:
      'Nothing is requested from macOS now. The system asks only when a feature needs it; change this any time in Settings › Privacy or System Settings › Privacy & Security.',
    acceptHint: 'Accept the policy to continue',
    // What the Keychain flag really covers (electron/native-token-store.ts): gateway sign-in tokens, in the state the Mac is in.
    keychainLine: (on: boolean): string =>
      on
        ? 'Your gateway sign-in is encrypted with the Mac Keychain; macOS may ask you to allow it once.'
        : 'Your gateway sign-in is stored on this Mac without Keychain encryption.',
    keychainChange: 'You can change this in Settings › Gateways; macOS may ask again there.',
    skip: 'Skip for now',
    allowAll: 'Allow all',
    allAllowed: 'All allowed',
    allowAllKeychainTitle: 'Keychain is unchanged',
    allowAllKeychain:
      'Allow all does not change Keychain: your saved secrets stay as set in Settings › Gateways (not encrypted). Turn on encryption there.',
    saving: 'Saving…',
    saveFailed: 'Could not save your choice. Try again.',
    step: (n: number, total: number) => `Step ${n} of ${total}`
  },
  groups: {
    capabilities: 'Agent capabilities',
    capabilitiesHint:
      'Your agent is told each choice when it starts. When a task needs one you left off, it asks you here first.',
    device: 'Device',
    deviceHint: 'macOS asks only when a feature needs it.',
    neverUsed: 'Never used',
    neverUsedHint: `For your information: ${PRODUCT_NAME} does not use these.`
  },
  // Rows the policy's §9 table has no line for: names and purposes within what the policy says (§7, §9, §17).
  rows: {
    terminal: {
      name: 'Terminal commands',
      purpose:
        'Letting your agent run commands in a terminal, with your user account’s permissions. You can see what it runs.'
    },
    fileWriting: { name: 'File writing', purpose: 'Letting your agent create and change files on this Mac for a task' },
    webBrowsing: {
      name: 'Web browsing & network calls',
      purpose: 'Letting your agent browse the web or use an online tool for you, sending what the task needs'
    },
    installSoftware: {
      name: 'Install software & packages',
      purpose: 'Letting your agent install tools and packages (Homebrew, npm, pip) when a task needs them'
    },
    scheduledTasks: { name: 'Scheduled tasks', purpose: 'Letting your agent create jobs that run later on this Mac' },
    sendMessages: { name: 'Send email & messages', purpose: 'Letting your agent send agent email on your behalf' },
    spendTrade: {
      name: 'Spend & trade',
      purpose:
        'Letting your agent spend within a card limit, take marketplace jobs or trade, only with authorisations you gave yourself'
    }
  },
  neverUsed: {
    camera: { name: 'Camera', line: 'The app does not use your camera.' },
    location: { name: 'Location', line: 'The app does not use your location.' },
    contacts: { name: 'Contacts', line: 'The app does not use your contacts.' }
  },
  // What each switch actually does in this build — never more than the code enforces.
  effect: {
    terminal: 'Off: your agent is told not to run terminal commands.',
    fileWriting:
      'Off: your agent is told not to create, change or delete files. Reading the folders you choose is unaffected.',
    webBrowsing: 'Off: your agent is told not to browse the web or call online tools.',
    installSoftware: 'Off: your agent is told not to install software or packages.',
    scheduledTasks: 'Off: your agent is told not to create scheduled tasks.',
    sendMessages: 'Off: your agent is told not to send email or messages for you.',
    spendTrade: 'Off: your agent is told not to move value without you.',
    microphone: 'Off: the voice button stays off and macOS is never asked.',
    screen:
      'Off: the app withholds other apps’ window titles, and your agent is told not to take screenshots or recordings.',
    automation: 'Off: your agent is told not to control other apps.',
    notifications: `Off: ${PRODUCT_NAME} shows no chat or agent notifications.`,
    clipboard: 'Off: your agent is told not to use the clipboard. Your own copy and paste always work.',
    keychain:
      'Gateway sign-in details live on this Mac; whether the Keychain encrypts them is shown beside this row and changed in Settings › Gateways.'
  },
  settings: {
    nav: 'Privacy',
    policyHeading: 'Policy',
    policyRow: (version: string) => `${PRODUCT_NAME} Policies & Privacy v${version}`,
    effective: (date: string) => `Effective ${date}`,
    accepted: (date: string) => `Accepted ${date}`,
    acceptedOlder: (version: string) => `Accepted v${version}`,
    notAccepted: 'Not accepted',
    openLive: 'Open the live page',
    readOffline: 'Read offline',
    hideOffline: 'Hide the full text',
    permissionsHeading: 'Permissions',
    notConfigured: 'Not configured',
    notConfiguredHint: 'You skipped this step. Until you choose, macOS asks only when a feature needs a permission.',
    permissionsFooter: `A switch records what ${PRODUCT_NAME} may use; macOS still asks the first time a feature needs a permission. Microphone, window titles and notifications change at once; agent capabilities reach your agent the next time it starts.`,
    requestsHeading: 'Requests from your agent',
    requestsEmpty: 'No requests yet. When a task needs a permission you left off, your agent asks here.',
    requestAnswer: { always: 'Allowed always', once: 'Allowed once', denied: 'Denied', timeout: 'No answer' },
    requestBy: (inft: string, date: string) => `${inft} · ${date}`,
    keychainState: (on: boolean): string => (on ? 'Encrypted' : 'Not encrypted'),
    keychainOpen: 'Open Gateway settings',
    aiHeading: 'AI provider',
    aiRow: 'What the AI provider you connect receives',
    aiRowDesc:
      'Messages, files, persona and memory, and tool results including the screen go directly from this Mac to the provider you connect (policy §5). You accepted this with the policy.',
    aiWithdrawn: (date: string) => `Withdrawn ${date}`,
    aiNotRecorded: 'Not recorded',
    aiWithdrawnHint: `${PRODUCT_NAME} keeps the date you withdrew. It does not cut off a connected provider by itself: disconnect the provider in Settings › Providers to stop sending.`,
    aiAcceptAgain: 'Accept again',
    openProviders: 'Open Providers',
    withdraw: 'Withdraw AI-provider consent',
    withdrawTitle: 'Withdraw AI-provider consent?',
    withdrawDesc: `${PRODUCT_NAME} records the date you withdrew it. It does not cut off a connected provider by itself: to stop sending, disconnect the provider in Settings › Providers.`,
    withdrawConfirm: 'Withdraw',
    saveFailed: 'Could not save. Try again.',
    unavailable: 'Privacy settings are available in the desktop app.'
  },
  door: {
    eyebrow: (inft: string) => `Permission request · ${inft}`,
    title: (name: string) => `Your agent needs ${name}`,
    reasonLabel: 'Why, in your agent’s words',
    hint: `Allow once lasts until ${PRODUCT_NAME} quits. Allow always turns the switch on in Settings › Privacy.`,
    expires: 'No answer within two minutes counts as Deny.',
    deny: 'Deny',
    once: 'Allow once',
    always: 'Allow always'
  }
}
