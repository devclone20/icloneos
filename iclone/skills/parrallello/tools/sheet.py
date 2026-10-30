#!/usr/bin/env python3
"""sheet.py out.png in... --cols N --width 1600 [--labels] [--gap 6]
Contact sheet (PIL): tiles keep their aspect, rows are as tall as their tallest tile, dark background.
--labels writes a caption under each tile (file stem, or the text after `::` when an input is `path::caption`).
Width is capped at 1600 px (efficiency rule 5). Unreadable inputs become a labelled MISSING tile.
Prints one JSON line {out, w, h, n, missing}."""
import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BG, FG, MISS = (14, 14, 16), (225, 225, 228), (60, 20, 24)
MAXW = 1600


def load(path):
    im = Image.open(path)
    im.load()
    if im.mode in ("I;16", "I;16B", "I;16L", "I", "F"):
        im = im.convert("F")
        lo, hi = im.getextrema()
        scale = 255.0 / (hi - lo) if hi > lo else 1.0
        im = im.point(lambda v: (v - lo) * scale).convert("L")
    if im.mode in ("RGBA", "LA", "P", "PA"):
        im = im.convert("RGBA")
        base = Image.new("RGBA", im.size, BG + (255,))
        im = Image.alpha_composite(base, im)
    return im.convert("RGB")


def font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("out")
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("--cols", type=int, default=3)
    ap.add_argument("--width", type=int, default=MAXW)
    ap.add_argument("--labels", action="store_true")
    ap.add_argument("--gap", type=int, default=6)
    a = ap.parse_args()
    width = max(64, min(a.width, MAXW))
    cols = max(1, min(a.cols, len(a.inputs)))
    gap = max(0, a.gap)
    tw = (width - gap * (cols + 1)) // cols
    fsz = max(10, min(18, tw // 22))
    fnt = font(fsz)
    lab_h = fsz + 8 if a.labels else 0
    tiles, missing = [], 0
    for spec in a.inputs:
        path, _, cap = spec.partition("::")
        cap = cap or Path(path).stem
        try:
            im = load(path)
            h = max(1, round(im.height * tw / im.width))
            im = im.resize((tw, h), Image.LANCZOS)
        except Exception as e:  # noqa: BLE001 - any decode failure becomes a visible tile
            missing += 1
            im = Image.new("RGB", (tw, max(48, tw * 9 // 16)), MISS)
            cap = f"MISSING {Path(path).name}: {type(e).__name__}"
        tiles.append((im, cap))
    rows = [tiles[i:i + cols] for i in range(0, len(tiles), cols)]
    row_h = [max(t[0].height for t in r) + lab_h for r in rows]
    H = gap + sum(h + gap for h in row_h)
    sheet = Image.new("RGB", (width, H), BG)
    dr = ImageDraw.Draw(sheet)
    y = gap
    for r, rh in zip(rows, row_h):
        x = gap
        for im, cap in r:
            sheet.paste(im, (x, y))
            if a.labels:
                txt = cap
                while txt and dr.textlength(txt, font=fnt) > tw - 4:
                    txt = txt[:-2]
                dr.text((x + 2, y + rh - lab_h + 3), txt if txt == cap else txt + "…", fill=FG, font=fnt)
            x += tw + gap
        y += rh + gap
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(a.out, optimize=True)
    print(json.dumps({"out": a.out, "w": width, "h": H, "n": len(tiles), "missing": missing}))
    sys.exit(0)


if __name__ == "__main__":
    main()
