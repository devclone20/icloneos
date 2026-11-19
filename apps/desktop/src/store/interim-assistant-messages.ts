/**
 * `display.interim_assistant_messages` — the config.yaml key that turns off the commentary a model writes beside its
 * tool calls (default on, hermes_cli/config_defaults.py). The runtime reads it for `message.interim`; the desktop reads
 * it here so the streamed commentary is dropped from the transcript too (lib/chat-messages/interim-off.ts).
 */
import { atom } from 'nanostores'

export const $interimAssistantMessages = atom<boolean>(true)

/** Only an explicit off turns it off: an absent or unreadable value keeps the default. */
export function setInterimAssistantMessagesFromConfig(value: unknown): void {
  $interimAssistantMessages.set(!(value === false || value === 'false' || value === 0))
}
