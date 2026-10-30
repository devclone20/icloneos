/** English fallbacks for the composer Effort menu. The `effort.*` i18n keys
 *  are requested from L7a; level names reuse `shell.modelOptions.<level>`. */
export const EFFORT_MENU_COPY = {
  title: 'Effort',
  trigger: (level: string) => `Reasoning effort: ${level}`,
  outputPrice: (price: string) => (price.toLowerCase() === 'free' ? 'Free' : `${price}/Mtok out`),
  costHint: 'Higher effort spends more thinking tokens, billed as output.',
  sends: (level: string) => `Sends ${level} on this route`,
  notOnRoute: (level: string) => `${level} is not sent as-is on this route`,
  catalogMayLower: (provider: string, level: string) =>
    `${provider} may send a lower level than ${level} for this model`,
  thinking: 'Thinking',
  off: 'Off'
} as const
