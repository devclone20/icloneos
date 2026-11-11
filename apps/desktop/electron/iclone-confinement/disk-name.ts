/**
 * G27: one spelling for a name the Mac's disk reads as the same name. Mirror of agent/disk_name.py; the corpus in
 * tests/fixtures/iclone_disk_names.json holds both to one answer. APFS folds case with Unicode's full case folding and
 * treats the normalisation forms as one name; it keeps compatibility forms apart, so this is NFD and not NFKC.
 *
 * JavaScript has no casefold. Upper then lower, one code point at a time so no final-sigma context applies, gives it,
 * except where Unicode's folding is not the round trip: the cases below.
 */
const foldCodePoint = (char: string): string => {
  const point = char.codePointAt(0) ?? 0

  if (point === 0x131 || (point >= 0x13a0 && point <= 0x13f5)) {
    return char
  }

  if (point === 0x1e9e) {
    return 'ss'
  }

  if (point >= 0x13f8 && point <= 0x13fd) {
    return String.fromCodePoint(point - 8)
  }

  if (point >= 0xab70 && point <= 0xabbf) {
    return String.fromCodePoint(point - 0xab70 + 0x13a0)
  }

  return char.toUpperCase().toLowerCase()
}

export const diskFold = (name: string): string => Array.from(name.normalize('NFD'), foldCodePoint).join('').normalize('NFD')
