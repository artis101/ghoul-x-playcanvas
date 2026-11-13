"""Stitch render_grip_frames.py output into one PNG per clip and weapon: a row per time, a
column per view (front, side, top).

    python grip_sheet.py frames_dir out_dir
"""
import sys
from collections import defaultdict
from pathlib import Path

from PIL import Image

VIEWS = ("front", "side", "top")


def main(frames, out):
    out.mkdir(parents=True, exist_ok=True)
    sheets = defaultdict(dict)
    for path in sorted(frames.glob("*.png")):
        stem, view, index = path.stem.rsplit("_", 2)
        sheets[stem][view, int(index)] = path
    for stem, cells in sheets.items():
        rows = sorted({index for _, index in cells})
        first = Image.open(next(iter(cells.values())))
        w, h = first.size
        sheet = Image.new("RGB", (w * len(VIEWS), h * len(rows)), "white")
        for r, index in enumerate(rows):
            for c, view in enumerate(VIEWS):
                if (view, index) in cells:
                    sheet.paste(Image.open(cells[view, index]).convert("RGB"), (c * w, r * h))
        sheet.save(out / f"{stem}.png")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
