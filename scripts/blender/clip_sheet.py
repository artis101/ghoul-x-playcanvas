"""Stitch frames written by render_clip_frames.py into one PNG per clip (front row, side row).

    python clip_sheet.py frames_dir out_dir
"""
import sys
from collections import defaultdict
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.image as mpimg
import matplotlib.pyplot as plt


def main(frames, out):
    out.mkdir(parents=True, exist_ok=True)
    clips = defaultdict(lambda: defaultdict(list))
    for path in sorted(frames.glob("*.png")):
        clip, view, _ = path.stem.rsplit("_", 2)
        clips[clip][view].append(path)
    for clip, views in clips.items():
        cols = max(len(paths) for paths in views.values())
        fig, axes = plt.subplots(len(views), cols, figsize=(cols * 1.2, len(views) * 1.5), squeeze=False)
        for row, view in enumerate(sorted(views)):
            for col, path in enumerate(views[view]):
                axes[row, col].imshow(mpimg.imread(path))
                axes[row, col].axis("off")
        fig.suptitle(clip, fontsize=8)
        fig.tight_layout(pad=0.2)
        fig.savefig(out / f"{clip}.png", dpi=110)
        plt.close(fig)


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
