#!/usr/bin/env python3
"""build-noto-display.py — rebuilds the display face from its recorded npm source (REL-7, critic m2; REL-4 ruling 21).

The two files apps/desktop/src/fonts/NotoSerifDisplay-ExtraCondensedBold-{latin,latin-ext}.woff2 are a static
instance of Noto Serif Display (SIL OFL 1.1) at wdth 62.5 (the axis minimum) and wght 750, made from the variable
fonts in @fontsource-variable/noto-serif-display@5.3.0. This script is the whole recipe:

  1. the npm tarball (registry URL below, or --tarball <file>), refused unless its sha512 is the recorded integrity;
  2. files/noto-serif-display-<subset>-wdth-normal.woff2 for the latin and latin-ext subsets;
  3. fontTools varLib.instancer at {wdth: 62.5, wght: 750};
  4. the name table rewritten (Windows English records only): family "Noto Serif Display ExtraCondensed", style
     "Bold", PostScript name NotoSerifDisplay-ExtraCondensedBold, licence description and URL; usWeightClass 750;
  5. saved as WOFF2 with the head timestamps kept (recalcTimestamp off), so the bytes do not depend on the clock.

Usage (needs fontTools and brotli; built with fontTools 4.67.0):
  build-noto-display.py --out <dir>          write both files into <dir>
  build-noto-display.py --check [--against <dir>]
        rebuild into a temp dir and compare with the committed files (default apps/desktop/src/fonts): glyph order,
        every glyph's outline (contours, points, flags, components), advances and side bearings, cmap and the name
        table must be equal, else exit 1. Byte equality is reported too (it holds with fontTools 4.67.0).
  --tarball <file>   use a local copy of the npm tarball instead of the registry (its integrity is still checked)
Network: one GET of the public npm tarball when --tarball is not given. Nothing else is read or written.
"""
from __future__ import annotations

import base64
import hashlib
import io
import os
import sys
import tarfile
import tempfile
import urllib.request

PACKAGE = '@fontsource-variable/noto-serif-display'
VERSION = '5.3.0'
TARBALL = 'https://registry.npmjs.org/@fontsource-variable/noto-serif-display/-/noto-serif-display-5.3.0.tgz'
INTEGRITY = 'sha512-xjCag3o0sBWYB+76irp7cHMIa3MvWqYdGSgFXDePAmezplEJeTbR8FHvf2tSNNqA09KeO9W3N+HDaehQxzg8yg=='
AXES = {'wdth': 62.5, 'wght': 750}
SUBSETS = {'latin': 'NotoSerifDisplay-ExtraCondensedBold-latin.woff2',
           'latin-ext': 'NotoSerifDisplay-ExtraCondensedBold-latin-ext.woff2'}
FAMILY, STYLE = 'Noto Serif Display ExtraCondensed', 'Bold'
NAMES = {
    1: FAMILY, 2: STYLE, 4: f'{FAMILY} {STYLE}', 6: 'NotoSerifDisplay-ExtraCondensedBold', 16: FAMILY, 17: STYLE,
    3: 'NotoSerifDisplay-ExtraCondensedBold; static instance wdth 62.5 wght 750 for icloneOS',
    13: 'This Font Software is licensed under the SIL Open Font License, Version 1.1.',
    14: 'https://openfontlicense.org',
}
HERE = os.path.dirname(os.path.abspath(__file__))
COMMITTED = os.path.normpath(os.path.join(HERE, '..', '..', 'src', 'fonts'))


def tarball(path: str | None) -> bytes:
    data = open(path, 'rb').read() if path else urllib.request.urlopen(TARBALL, timeout=60).read()
    algo, want = INTEGRITY.split('-', 1)
    got = base64.b64encode(hashlib.new(algo, data).digest()).decode()
    if got != want:
        sys.exit(f'build-noto-display: the tarball is not {PACKAGE}@{VERSION} (integrity {algo}-{got[:16]}…)')
    return data


def build(data: bytes, out: str) -> None:
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer

    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as t:
        for subset, target in SUBSETS.items():
            src = t.extractfile(f'package/files/noto-serif-display-{subset}-wdth-normal.woff2').read()
            font = instancer.instantiateVariableFont(TTFont(io.BytesIO(src)), dict(AXES))
            name = font['name']
            for nid, value in NAMES.items():
                name.setName(value, nid, 3, 1, 0x409)
            for rec in list(name.names):
                if rec.platformID != 3:
                    name.removeNames(platformID=rec.platformID)
            font['OS/2'].usWeightClass = AXES['wght']
            font.recalcTimestamp = False
            font.flavor = 'woff2'
            font.save(os.path.join(out, target))


def outline_diffs(a_path: str, b_path: str) -> list[str]:
    from fontTools.pens.recordingPen import RecordingPen
    from fontTools.ttLib import TTFont

    a, b = TTFont(a_path), TTFont(b_path)
    diffs = []
    if a.getGlyphOrder() != b.getGlyphOrder():
        return ['glyph order differs']
    ga, gb = a.getGlyphSet(), b.getGlyphSet()
    for g in a.getGlyphOrder():
        pa, pb = RecordingPen(), RecordingPen()
        ga[g].draw(pa)
        gb[g].draw(pb)
        if pa.value != pb.value:
            diffs.append(f'outline {g}')
        if a['hmtx'][g] != b['hmtx'][g]:
            diffs.append(f'advance/lsb {g}')
    if a.getBestCmap() != b.getBestCmap():
        diffs.append('cmap')
    na = sorted((r.nameID, r.platformID, r.platEncID, r.langID, r.toUnicode()) for r in a['name'].names)
    nb = sorted((r.nameID, r.platformID, r.platEncID, r.langID, r.toUnicode()) for r in b['name'].names)
    if na != nb:
        diffs.append('name table')
    if a['OS/2'].usWeightClass != b['OS/2'].usWeightClass:
        diffs.append('usWeightClass')
    return diffs


def main(argv: list[str]) -> int:
    opt = lambda flag: argv[argv.index(flag) + 1] if flag in argv else None
    if '--out' not in argv and '--check' not in argv:
        print(__doc__)
        return 1
    import fontTools
    data = tarball(opt('--tarball'))
    if '--out' in argv:
        os.makedirs(opt('--out'), exist_ok=True)
        build(data, opt('--out'))
        print(f'build-noto-display: wrote {", ".join(SUBSETS.values())} into {opt("--out")} (fontTools {fontTools.version})')
        return 0
    against = opt('--against') or COMMITTED
    red = 0
    with tempfile.TemporaryDirectory() as tmp:
        build(data, tmp)
        for target in SUBSETS.values():
            mine, theirs = os.path.join(tmp, target), os.path.join(against, target)
            if not os.path.isfile(theirs):
                print(f'  RED {target}: missing from {against}')
                red += 1
                continue
            diffs = outline_diffs(mine, theirs)
            same = open(mine, 'rb').read() == open(theirs, 'rb').read()
            print(f"  {'RED' if diffs else 'ok '} {target}: " + (f'{len(diffs)} diff(s): {", ".join(diffs[:6])}' if diffs
                  else 'outlines, advances, cmap and names equal') + f'; bytes {"identical" if same else "differ"}')
            red += bool(diffs)
    print(f'build-noto-display --check: {PACKAGE}@{VERSION} at {AXES}, fontTools {fontTools.version}; '
          + ('ok' if red == 0 else f'{red} file(s) differ'))
    return 0 if red == 0 else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
