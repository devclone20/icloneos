/** iCLONE OS — HTML text escaping shared by the electron main process and the renderer. */

/**
 * The value as text that is safe inside HTML element content and quoted
 * attribute values (single or double quotes). `null`/`undefined` read as ''.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
