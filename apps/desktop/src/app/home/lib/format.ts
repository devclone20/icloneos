/**
 * iCLONE OS — renderer formatting shared outside the economy windows.
 */

/** `0x1234…abcd`: head and tail of an address or hash; short strings come back whole. */
export function shortAddress(address: string, head = 6, tail = 4): string {
  return address && address.length > head + tail + 1
    ? `${address.slice(0, head)}…${address.slice(-tail)}`
    : (address ?? '')
}
