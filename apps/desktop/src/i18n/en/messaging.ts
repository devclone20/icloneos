import type { Translations } from '../types'

export const messaging: Translations['messaging'] = {
  search: 'Search messaging...',
  loading: 'Loading messaging platforms...',
  loadFailed: 'Messaging platforms failed to load',
  states: {
    connected: 'Connected',
    connecting: 'Connecting',
    disabled: 'Disabled',
    fatal: 'Error',
    gateway_stopped: 'Messaging service stopped',
    not_configured: 'Needs setup',
    pending_restart: 'Restart needed',
    retrying: 'Retrying',
    startup_failed: 'Startup failed'
  },
  unknown: 'Unknown',
  hintPendingRestart: 'Restart the messaging service from the status bar to apply this change.',
  hintGatewayStopped: 'Start the messaging service from the status bar to connect.',
  credentialsSet: 'Credentials set',
  needsSetup: 'Needs setup',
  gatewayStopped: 'Messaging service stopped',
  getCredentials: 'Get your sign-in details',
  openSetupGuide: 'Open setup guide',
  required: 'What it needs to connect',
  recommended: 'Worth setting',
  advanced: count => `Advanced (${count})`,
  noTokenNeeded: 'This platform does not need a token here. Use the setup guide above, then enable it below.',
  enabled: 'Enabled',
  disabled: 'Disabled',
  unsavedChanges: 'Unsaved changes',
  saving: 'Saving...',
  saveChanges: 'Save changes',
  saved: 'Saved',
  replaceValue: 'Replace current value',
  openDocs: 'Open docs',
  clearField: key => `Clear ${key}`,
  enableAria: name => `Enable ${name}`,
  disableAria: name => `Disable ${name}`,
  platformEnabled: name => `${name} enabled`,
  platformDisabled: name => `${name} disabled`,
  restartToApply: 'This change takes effect after the messaging service restarts.',
  setupSaved: name => `${name} setup saved`,
  restartToReconnect: 'New sign-in details take effect after the messaging service restarts.',
  keyCleared: key => `${key} cleared`,
  setupUpdated: name => `${name} setup was updated.`,
  failedUpdate: name => `Failed to update ${name}`,
  failedSave: name => `Failed to save ${name}`,
  failedClear: key => `Failed to clear ${key}`,
  pendingRequests: count => `Pending requests (${count})`,
  pendingAria: count => `${count} pending pairing ${count === 1 ? 'request' : 'requests'}`,
  approvedUsers: count => `Approved users (${count})`,
  approve: 'Approve',
  approving: 'Approving...',
  revoke: 'Revoke',
  revoking: 'Revoking...',
  revokeAria: name => `Revoke ${name}`,
  revokeTitle: 'Revoke access',
  revokeDesc: (name: string) => `${name} will lose access and stop being recognized on their next message.`,
  approvedUser: name => `${name} approved`,
  approvedHint: 'They are recognized automatically on their next message.',
  revokedUser: name => `${name} revoked`,
  failedApprove: name => `Failed to approve ${name}`,
  failedRevoke: name => `Failed to revoke ${name}`,
  pairingLockedOut: 'Too many failed approvals — this platform is locked out. Try again later.',
  waitingSince: minutes => (minutes < 1 ? 'just now' : `${minutes}m ago`),
  fieldFallbackLabel: 'Fill in this setting',
  fieldFallbackName: 'This setting',
  fieldCopy: {
    TELEGRAM_BOT_TOKEN: {
      label: 'Paste the token your Telegram bot gives you',
      name: 'Bot token',
      help: 'Create a bot with @BotFather, then paste the token it gives you.',
      placeholder: 'Paste Telegram bot token'
    },
    TELEGRAM_ALLOWED_USERS: {
      label: 'Choose who may talk to your agent',
      name: 'Allowed Telegram user IDs',
      help: 'Recommended. Comma-separated numeric IDs from @userinfobot. Without this, anyone can DM your bot.'
    },
    TELEGRAM_PROXY: {
      label: 'Enter a proxy address if Telegram is blocked',
      name: 'Proxy URL',
      help: 'Only needed on networks where Telegram is blocked.'
    },
    DISCORD_BOT_TOKEN: {
      label: 'Paste the token of your Discord bot',
      name: 'Bot token',
      help: 'Create an application in the Discord Developer Portal, add a bot, then paste its token.'
    },
    DISCORD_ALLOWED_USERS: {
      label: 'Choose who may talk to your agent',
      name: 'Allowed Discord user IDs',
      help: 'Recommended. Comma-separated Discord user IDs.'
    },
    DISCORD_REPLY_TO_MODE: {
      label: 'Choose how replies appear in Discord',
      name: 'Reply style',
      help: 'first, all, or off.'
    },
    DISCORD_ALLOW_ALL_USERS: {
      label: 'Allow all Discord users',
      name: 'Allow all Discord users',
      help: 'Development only. When true, anyone can DM the bot without an allowlist.'
    },
    DISCORD_HOME_CHANNEL: {
      label: 'Enter the ID of the channel your agent reports to',
      name: 'Home channel ID',
      help: 'Channel where the bot sends proactive messages (cron output, reminders).'
    },
    DISCORD_HOME_CHANNEL_NAME: {
      label: 'Enter the name of the channel your agent reports to',
      name: 'Home channel name',
      help: 'Display name for the home channel in logs and status output.'
    },
    BLUEBUBBLES_ALLOW_ALL_USERS: {
      label: 'Allow all iMessage users',
      name: 'Allow all iMessage users',
      help: 'When true, skip the BlueBubbles allowlist.'
    },
    MATTERMOST_ALLOW_ALL_USERS: { label: 'Allow all Mattermost users', name: 'Allow all Mattermost users' },
    MATTERMOST_HOME_CHANNEL: { label: 'Enter the channel your agent reports to', name: 'Home channel' },
    QQ_ALLOW_ALL_USERS: { label: 'Allow all QQ users', name: 'Allow all QQ users' },
    QQBOT_HOME_CHANNEL: {
      label: 'Enter the QQ channel your agent reports to',
      name: 'QQ home channel',
      help: 'Default channel or group for cron delivery.'
    },
    QQBOT_HOME_CHANNEL_NAME: {
      label: 'Enter the name of the QQ channel your agent reports to',
      name: 'QQ home channel name'
    },
    SLACK_BOT_TOKEN: {
      label: 'Paste the bot token of your Slack app',
      name: 'Slack bot token',
      help: 'Use the bot token from OAuth & Permissions after installing your Slack app.',
      placeholder: 'Paste Slack bot token'
    },
    SLACK_APP_TOKEN: {
      label: 'Paste the app-level token of your Slack app',
      name: 'Slack app token',
      help: 'Use the app-level token required for Socket Mode.',
      placeholder: 'Paste Slack app token'
    },
    SLACK_ALLOWED_USERS: {
      label: 'Choose who may talk to your agent',
      name: 'Allowed Slack user IDs',
      help: 'Recommended. Comma-separated Slack user IDs.'
    },
    MATTERMOST_URL: {
      label: 'Enter the address of your Mattermost server',
      name: 'Server URL',
      placeholder: 'https://mattermost.example.com'
    },
    MATTERMOST_TOKEN: { label: 'Paste the token of your Mattermost bot', name: 'Bot token' },
    MATTERMOST_ALLOWED_USERS: {
      label: 'Choose who may talk to your agent',
      name: 'Allowed user IDs',
      help: 'Recommended. Comma-separated Mattermost user IDs.'
    },
    MATRIX_HOMESERVER: {
      label: 'Enter the address of your Matrix homeserver',
      name: 'Homeserver URL',
      placeholder: 'https://matrix.org'
    },
    MATRIX_ACCESS_TOKEN: { label: 'Paste the access token of the bot account', name: 'Access token' },
    MATRIX_USER_ID: {
      label: 'Enter the Matrix ID of the bot account',
      name: 'Bot user ID',
      placeholder: '@agent:example.org'
    },
    MATRIX_ALLOWED_USERS: {
      label: 'Choose who may talk to your agent',
      name: 'Allowed Matrix user IDs',
      help: 'Recommended. Comma-separated user IDs in @user:server format.'
    },
    SIGNAL_HTTP_URL: {
      label: 'Enter the address of your Signal bridge',
      name: 'Signal bridge URL',
      placeholder: 'http://127.0.0.1:8080',
      help: 'URL of a running signal-cli REST bridge.'
    },
    SIGNAL_ACCOUNT: {
      label: 'Enter the phone number your agent uses on Signal',
      name: 'Phone number',
      help: 'The number registered with your signal-cli bridge.'
    },
    SIGNAL_ALLOWED_USERS: {
      label: 'Choose who may talk to your agent',
      name: 'Allowed Signal users',
      help: 'Recommended. Comma-separated Signal identifiers.'
    },
    WHATSAPP_ENABLED: {
      label: 'Turn on the WhatsApp bridge',
      name: 'Enable WhatsApp bridge',
      help: 'Set automatically by the toggle below. Leave alone unless you know you need it.'
    },
    WHATSAPP_MODE: { label: 'Choose how WhatsApp connects', name: 'Bridge mode' },
    WHATSAPP_ALLOWED_USERS: {
      label: 'Choose who may talk to your agent',
      name: 'Allowed WhatsApp users',
      help: 'Recommended. Comma-separated phone numbers or WhatsApp IDs.'
    },
    A2A_AGENT_NAME: { label: 'Enter the name other agents see', name: 'Name other agents see' },
    A2A_BEARER_TOKEN: { label: 'Paste the token other agents must present', name: 'Access token other agents use' },
    A2A_HOST: { label: 'Enter the address your agent listens on', name: 'Address it listens on' },
    A2A_PEER_TOKENS: { label: 'Paste the tokens of the agents you trust', name: 'Tokens of trusted agents' },
    A2A_PORT: { label: 'Enter the port your agent listens on', name: 'Port it listens on' },
    API_SERVER_ENABLED: { label: 'Turn it on', name: 'Turn it on' },
    API_SERVER_HOST: { label: 'Enter the address your agent listens on', name: 'Address it listens on' },
    API_SERVER_KEY: { label: 'Paste the key other apps must use', name: 'Access key' },
    API_SERVER_MODEL_NAME: { label: 'Enter the name other apps see', name: 'Name other apps see' },
    API_SERVER_PORT: { label: 'Enter the port your agent listens on', name: 'Port it listens on' },
    BLUEBUBBLES_ALLOWED_USERS: { label: 'Choose who may talk to your agent', name: 'People allowed to talk to it' },
    BLUEBUBBLES_PASSWORD: { label: 'Paste the password of your BlueBubbles server', name: 'Server password' },
    BLUEBUBBLES_SERVER_URL: { label: 'Enter the address of your BlueBubbles server', name: 'Server address' },
    BUZZ_ALLOWED_USERS: { label: 'Choose who may talk to your agent', name: 'People allowed to talk to it' },
    BUZZ_AUTH_TAG: { label: 'Enter the tag your agent signs in with', name: 'Sign-in tag' },
    BUZZ_CHANNELS: { label: 'Choose the channels your agent joins', name: 'Channels to join' },
    BUZZ_CLI_PATH: { label: 'Enter where the Buzz program is installed', name: 'Where the Buzz program is' },
    BUZZ_CREDENTIALS_FILE: { label: 'Enter where the credentials file is', name: 'Credentials file' },
    BUZZ_POLL_INTERVAL: {
      label: 'Set how often your agent checks for messages',
      name: 'How often to check for messages'
    },
    BUZZ_PRIVATE_KEY: { label: 'Paste the private key of your Buzz account', name: 'Private key' },
    BUZZ_RELAY_URL: { label: 'Enter the address of the relay', name: 'Relay address' },
    BUZZ_TRANSPORT: { label: 'Choose how your agent connects', name: 'How it connects' },
    DINGTALK_ALLOWED_USERS: { label: 'Choose who may talk to your agent', name: 'People allowed to talk to it' },
    DINGTALK_CLIENT_ID: { label: 'Enter the client ID of your DingTalk app', name: 'Client ID' },
    DINGTALK_CLIENT_SECRET: { label: 'Paste the client secret of your DingTalk app', name: 'Client secret' },
    DINGTALK_WEBHOOK_URL: { label: 'Enter the address of the group robot', name: 'Group robot address' },
    EMAIL_ADDRESS: { label: 'Enter the email address your agent uses', name: 'Email address' },
    EMAIL_ALLOWED_USERS: {
      label: 'Choose which addresses may write to your agent',
      name: 'Addresses allowed to write to it'
    },
    EMAIL_IMAP_HOST: { label: 'Enter the server that receives your mail', name: 'Incoming mail server' },
    EMAIL_PASSWORD: { label: 'Paste the password of the mailbox', name: 'Mailbox password' },
    EMAIL_SMTP_HOST: { label: 'Enter the server that sends your mail', name: 'Outgoing mail server' },
    EMAIL_SMTP_PORT: { label: 'Enter the port of the outgoing mail server', name: 'Outgoing mail port' },
    FEISHU_ALLOWED_USERS: { label: 'Choose who may talk to your agent', name: 'People allowed to talk to it' },
    FEISHU_APP_ID: { label: 'Enter the ID of your Feishu app', name: 'App ID' },
    FEISHU_APP_SECRET: { label: 'Paste the secret of your Feishu app', name: 'App secret' },
    FEISHU_DOMAIN: { label: 'Choose between Feishu and Lark', name: 'Feishu or Lark' },
    FEISHU_ENCRYPT_KEY: { label: 'Paste the key that encrypts events', name: 'Event encryption key' },
    FEISHU_VERIFICATION_TOKEN: { label: 'Paste the token that verifies events', name: 'Event verification token' },
    GOOGLE_CHAT_ALLOWED_USERS: { label: 'Choose who may talk to your agent', name: 'People allowed to talk to it' },
    GOOGLE_CHAT_HTTP_EVENTS_AUDIENCE: {
      label: 'Enter who events are addressed to',
      name: 'Who events are addressed to'
    },
    GOOGLE_CHAT_HTTP_EVENTS_SERVICE_ACCOUNT_EMAIL: {
      label: 'Enter the service account that sends events',
      name: 'Service account that sends events'
    },
    GOOGLE_CHAT_HTTP_EVENTS_URL: {
      label: 'Enter the address Google Chat sends events to',
      name: 'Address Google Chat sends events to'
    },
    GOOGLE_CHAT_PROJECT_ID: { label: 'Enter the ID of your Google Cloud project', name: 'Google Cloud project ID' },
    GOOGLE_CHAT_SERVICE_ACCOUNT_JSON: {
      label: 'Enter where the service account file is',
      name: 'Service account file'
    },
    GOOGLE_CHAT_SUBSCRIPTION_NAME: {
      label: 'Enter the Pub/Sub subscription your agent reads',
      name: 'Pub/Sub subscription'
    },
    HASS_TOKEN: { label: 'Paste a long-lived access token from Home Assistant', name: 'Long-lived access token' },
    HASS_URL: { label: 'Enter the address of your Home Assistant', name: 'Home Assistant address' },
    IRC_ALLOWED_USERS: { label: 'Choose who may talk to your agent', name: 'People allowed to talk to it' },
    IRC_CHANNEL: { label: 'Enter the channel your agent joins', name: 'Channel to join' },
    IRC_NICKNAME: { label: 'Enter the nickname your agent uses', name: 'Nickname' },
    IRC_NICKSERV_PASSWORD: { label: 'Paste the password of that nickname', name: 'Nickname password' },
    IRC_PORT: { label: 'Enter the port of the IRC server', name: 'Server port' },
    IRC_SERVER: { label: 'Enter the address of the IRC server', name: 'Server address' },
    IRC_SERVER_PASSWORD: { label: 'Paste the password of the IRC server', name: 'Server password' },
    IRC_USE_TLS: { label: 'Use an encrypted connection', name: 'Use an encrypted connection' },
    LINE_ALLOWED_GROUPS: { label: 'Choose which groups may talk to your agent', name: 'Groups allowed to talk to it' },
    LINE_ALLOWED_ROOMS: { label: 'Choose which rooms may talk to your agent', name: 'Rooms allowed to talk to it' },
    LINE_ALLOWED_USERS: { label: 'Choose who may talk to your agent', name: 'People allowed to talk to it' },
    LINE_CHANNEL_ACCESS_TOKEN: { label: 'Paste the access token of your LINE channel', name: 'Channel access token' },
    LINE_CHANNEL_SECRET: { label: 'Paste the secret of your LINE channel', name: 'Channel secret' },
    LINE_HOST: { label: 'Enter the address your agent listens on', name: 'Address it listens on' },
    LINE_PORT: { label: 'Enter the port your agent listens on', name: 'Port it listens on' },
    LINE_PUBLIC_URL: { label: 'Enter the public address LINE sends messages to', name: 'Public address LINE sends to' },
    LINE_SLOW_RESPONSE_THRESHOLD: {
      label: 'Set how many seconds pass before it says it is still working',
      name: 'Seconds before it says it is still working'
    },
    MATRIX_DEVICE_ID: { label: 'Enter the device ID of the bot account', name: 'Device ID' },
    MATRIX_PASSWORD: { label: 'Paste the password of the bot account', name: 'Password' },
    MATRIX_RECOVERY_KEY: {
      label: 'Paste the recovery key for encrypted rooms',
      name: 'Recovery key for encrypted rooms'
    },
    NTFY_ALLOWED_USERS: { label: 'Choose who may talk to your agent', name: 'People allowed to talk to it' },
    NTFY_MARKDOWN: { label: 'Format replies with Markdown', name: 'Format replies with Markdown' },
    NTFY_PUBLISH_TOPIC: { label: 'Enter the topic your agent replies on', name: 'Topic it replies on' },
    NTFY_SERVER_URL: { label: 'Enter the address of your ntfy server', name: 'Server address' },
    NTFY_TOKEN: { label: 'Paste the access token of your ntfy server', name: 'Access token' },
    NTFY_TOPIC: { label: 'Enter the topic your agent listens to', name: 'Topic it listens to' },
    PHOTON_ALLOWED_USERS: { label: 'Choose who may talk to your agent', name: 'People allowed to talk to it' },
    PHOTON_DASHBOARD_HOST: { label: 'Enter the address of the dashboard', name: 'Dashboard address' },
    PHOTON_MARKDOWN: { label: 'Format replies with Markdown', name: 'Format replies with Markdown' },
    PHOTON_MENTION_PATTERNS: {
      label: 'Choose the words that call your agent in a group',
      name: 'Words that call it in a group'
    },
    PHOTON_NODE_BIN: { label: 'Enter where Node.js is installed', name: 'Where Node.js is' },
    PHOTON_PROJECT_ID: { label: 'Enter the ID of your Photon project', name: 'Project ID' },
    PHOTON_PROJECT_SECRET: { label: 'Paste the secret of your Photon project', name: 'Project secret' },
    PHOTON_REACTIONS: { label: 'React to messages', name: 'React to messages' },
    PHOTON_SIDECAR_AUTOSTART: {
      label: 'Start the helper program on its own',
      name: 'Start the helper program on its own'
    },
    PHOTON_SIDECAR_PORT: { label: 'Enter the port of the helper program', name: 'Helper program port' },
    PHOTON_SPECTRUM_HOST: { label: 'Enter the address of Spectrum', name: 'Spectrum address' },
    PHOTON_TELEMETRY: { label: 'Share usage data with Photon', name: 'Share usage data with Photon' },
    QQ_ALLOWED_USERS: { label: 'Choose who may talk to your agent', name: 'People allowed to talk to it' },
    QQ_APP_ID: { label: 'Enter the ID of your QQ app', name: 'App ID' },
    QQ_CLIENT_SECRET: { label: 'Paste the client secret of your QQ app', name: 'Client secret' },
    QQ_GROUP_ALLOWED_USERS: {
      label: 'Choose which groups may talk to your agent',
      name: 'Groups allowed to talk to it'
    },
    QQ_SANDBOX: { label: 'Use the test environment', name: 'Use the test environment' },
    RAFT_PROFILE: { label: 'Choose the workspace profile your agent uses', name: 'Workspace profile' },
    SIMPLEX_ALLOWED_USERS: { label: 'Choose who may talk to your agent', name: 'People allowed to talk to it' },
    SIMPLEX_AUTO_ACCEPT: { label: 'Accept new contacts on its own', name: 'Accept new contacts on its own' },
    SIMPLEX_GROUP_ALLOWED: { label: 'Let it answer in groups', name: 'Let it answer in groups' },
    SIMPLEX_WS_URL: { label: 'Enter the address of the SimpleX program', name: 'Address of the SimpleX program' },
    TEAMS_ALLOWED_USERS: { label: 'Choose who may talk to your agent', name: 'People allowed to talk to it' },
    TEAMS_CLIENT_ID: { label: 'Enter the client ID of your Teams app', name: 'Client ID' },
    TEAMS_CLIENT_SECRET: { label: 'Paste the client secret of your Teams app', name: 'Client secret' },
    TEAMS_HOST: { label: 'Enter the address your agent listens on', name: 'Address it listens on' },
    TEAMS_PORT: { label: 'Enter the port your agent listens on', name: 'Port it listens on' },
    TEAMS_TENANT_ID: { label: 'Enter the ID of your Microsoft tenant', name: 'Tenant ID' },
    TWILIO_ACCOUNT_SID: { label: 'Enter the SID of your Twilio account', name: 'Account SID' },
    TWILIO_AUTH_TOKEN: { label: 'Paste the auth token of your Twilio account', name: 'Auth token' },
    TWILIO_PHONE_NUMBER: { label: 'Enter the phone number that sends texts', name: 'Phone number that sends texts' },
    WEBHOOK_ENABLED: { label: 'Turn it on', name: 'Turn it on' },
    WEBHOOK_PORT: { label: 'Enter the port your agent listens on', name: 'Port it listens on' },
    WEBHOOK_SECRET: { label: 'Paste the secret that signs each request', name: 'Signing secret' },
    WECOM_BOT_ID: { label: 'Paste the key of the group robot', name: 'Group robot key' },
    WECOM_CALLBACK_AGENT_ID: { label: 'Enter the agent ID of your WeCom app', name: 'Agent ID' },
    WECOM_CALLBACK_CORP_ID: { label: 'Enter the ID of your company', name: 'Corp ID' },
    WECOM_CALLBACK_CORP_SECRET: { label: 'Paste the secret of your WeCom app', name: 'App secret' },
    WECOM_CALLBACK_ENCODING_AES_KEY: { label: 'Paste the key that encrypts messages', name: 'Message encryption key' },
    WECOM_CALLBACK_TOKEN: { label: 'Paste the token of the callback', name: 'Callback token' },
    WECOM_SECRET: { label: 'Paste the secret of your WeCom app', name: 'App secret' },
    WEIXIN_ACCOUNT_ID: { label: 'Enter the ID of your Weixin account', name: 'Account ID' },
    WEIXIN_BASE_URL: { label: 'Enter the address of the server', name: 'Server address' },
    WEIXIN_TOKEN: { label: 'Paste the access token of your Weixin account', name: 'Access token' },
    WHATSAPP_DM_POLICY: { label: 'Choose who can message your agent directly', name: 'Who can message it directly' }
  },
  platformIntro: {
    api_server: 'Set an access key, then point Open WebUI, LobeChat or any OpenAI-style app at the address shown.',
    bluebubbles:
      'Run BlueBubbles Server on a Mac signed in to iMessage. Then enter its address and the server password.',
    dingtalk: 'Create a DingTalk app in the developer console. Then copy its client ID and client secret here.',
    discord:
      'In the Discord Developer Portal, create an application, add a bot and copy its token. Then invite the bot to your server.',
    email: 'Use a mailbox just for your agent. For Gmail, create an app password and use the Gmail mail servers.',
    feishu:
      'Create a Feishu or Lark app with the bot feature turned on. Then copy the app ID, the app secret and the event keys.',
    homeassistant:
      'In Home Assistant, open your profile and create a long-lived access token. Paste it here with your Home Assistant address.',
    matrix:
      'Sign in to your homeserver with the bot account. Then copy the access token, the user ID and the homeserver address.',
    mattermost:
      'On your Mattermost server, create a bot account or a personal access token. Then paste the server address and the token here.',
    qqbot: 'Register an app on the QQ Open Platform. Then copy its app ID and client secret.',
    signal:
      'Run a Signal bridge where this computer can reach it. Then enter its address and the registered phone number.',
    slack:
      'Create a Slack app, turn on Socket Mode and install it in your workspace. Then copy the bot token and the app token.',
    sms: 'In the Twilio console, copy your account SID and auth token, and pick a phone number that can send texts.',
    telegram:
      'In Telegram, message @BotFather, create a new bot and copy the token it gives you. Then get your numeric user ID from @userinfobot.',
    webhook: 'Other services send events to the address shown. Use the secret to check that each one is genuine.',
    wecom:
      'Add a group robot in WeCom and copy its webhook key. It can only send; choose WeCom (app) to talk both ways.',
    wecom_callback:
      'Set up your own WeCom app with a callback address. Then enter the corp ID, the secret, the agent ID and the AES key.',
    weixin:
      'Turn the platform on and confirm the QR code with your personal WeChat account. The sign-in is saved for next time.',
    whatsapp: 'Turn the platform on and scan the QR code with WhatsApp the first time it connects.'
  },
  platformSummary: {
    a2a: 'Let other agents talk to your agent directly.',
    api_server: 'Let other chat apps use your agent as if it were an OpenAI model.',
    bluebubbles: 'Talk to your agent in iMessage through a BlueBubbles server.',
    buzz: 'Talk to your agent through Buzz.',
    dingtalk: 'Talk to your agent in DingTalk groups.',
    discord: 'Talk to your agent in Discord messages, channels and threads.',
    email: 'Write to your agent by email and get its answers back.',
    feishu: 'Talk to your agent inside Feishu or Lark.',
    google_chat: 'Talk to your agent in Google Chat.',
    homeassistant: 'Let your agent control your smart home through Home Assistant.',
    irc: 'Talk to your agent in an IRC channel or in private messages.',
    line: 'Talk to your agent on LINE.',
    matrix: 'Talk to your agent in Matrix rooms and direct messages.',
    mattermost: 'Talk to your agent in Mattermost channels and direct messages.',
    msgraph_webhook: 'Let Microsoft 365 tell your agent about new meetings and mail.',
    ntfy: 'Talk to your agent through ntfy notifications.',
    photon: "Talk to your agent in iMessage through Photon's managed service.",
    qqbot: 'Talk to your agent through a QQ bot.',
    raft: 'Let your agent join a Raft workspace.',
    relay: 'Connect your agent through a relay service, still in testing.',
    signal: 'Talk to your agent on Signal through a Signal bridge you run.',
    simplex: 'Talk to your agent privately on SimpleX Chat.',
    slack: 'Talk to your agent in Slack, with only the members you allow.',
    sms: 'Text your agent and get replies by SMS through Twilio.',
    teams: 'Talk to your agent in Microsoft Teams chats.',
    telegram: 'Talk to your agent in Telegram chats, groups and topics.',
    webhook: 'Let GitHub, GitLab and other services send events to your agent.',
    wecom: 'Let your agent post to a WeCom group, without replies.',
    wecom_callback: 'Talk to your agent both ways in WeCom through your own app.',
    weixin: 'Talk to your agent from a personal WeChat account.',
    whatsapp: 'Talk to your agent on WhatsApp after scanning a QR code once.',
    whatsapp_cloud: "Talk to your agent through Meta's hosted WhatsApp service.",
    yuanbao: 'Talk to your agent in Tencent Yuanbao.'
  },
  noPlatforms: 'No messaging platforms found',
  noMatch: query => `No platform matches “${query}”`,
  draftSecretNotKept: 'Not kept in the draft — type it again:'
}
