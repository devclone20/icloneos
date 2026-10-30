/**
 * Notification sequences a program prints to ask for the owner (clean-room,
 * from the xterm control-sequence spec):
 *   OSC 9 ; <text> BEL            — a desktop notification (iTerm2 style).
 *     `9;9;<path>` is a cwd report and `9;4;…` a progress bar: neither asks.
 *   OSC 777 ; notify ; <title> ; <body> BEL  — rxvt-unicode style.
 * The BEL character on its own is the third signal; xterm reports it as onBell.
 */

const TEXT_MAX = 200

const isControl = (char: string) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f

const clean = (text: string) =>
  Array.from(text, char => (isControl(char) ? ' ' : char))
    .join('')
    .trim()
    .slice(0, TEXT_MAX)

export function osc9Notification(payload: string): null | string {
  if (/^\d+;/.test(payload)) {
    return null
  }

  return clean(payload) || null
}

export function osc777Notification(payload: string): null | string {
  const [kind, title = '', ...body] = payload.split(';')

  if (kind !== 'notify') {
    return null
  }

  return clean([title, body.join(';')].filter(Boolean).join(': ')) || null
}
