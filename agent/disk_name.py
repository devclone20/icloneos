"""iclone-seam: G27, one spelling for a name the Mac's disk reads as the same name.

APFS folds case with Unicode's full case folding (U+017F opens ``s``, U+212A opens ``k``, U+00DF opens ``ss``) and treats the
normalisation forms as one name. It keeps compatibility forms apart (a fullwidth letter is another file), so NFKC would
judge a file that is not on the list. Measured on APFS over every assigned code point. Mirror of
apps/desktop/electron/iclone-confinement/disk-name.ts; tests/fixtures/iclone_disk_names.json holds both to one answer.
"""
from __future__ import annotations

from unicodedata import normalize


def disk_fold(name: str) -> str:
    return normalize("NFD", normalize("NFD", name).casefold())
