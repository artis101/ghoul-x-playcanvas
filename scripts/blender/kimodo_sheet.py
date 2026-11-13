"""Contact sheet of Kimodo NPZ takes: stick figures from the front (+X side in red) and the side.

    python kimodo_sheet.py out.png take_00.npz [take_01.npz ...] [--cols 10] [--title text]

Each take gets two rows (front, side) at evenly spaced frames, so samples of one prompt can be
compared on one page.
"""
import argparse

import matplotlib
import numpy as np

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from kimodo.skeleton import SOMASkeleton77


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("out")
    parser.add_argument("takes", nargs="+")
    parser.add_argument("--cols", type=int, default=10)
    parser.add_argument("--title", default="")
    args = parser.parse_args()
    parents = [int(p) for p in SOMASkeleton77().joint_parents]
    rows = 2 * len(args.takes)
    fig, axes = plt.subplots(rows, args.cols, figsize=(args.cols * 1.25, rows * 1.45), squeeze=False)
    for t, path in enumerate(args.takes):
        joints = np.load(path)["posed_joints"]
        n = len(joints)
        lo = joints.reshape(-1, 3).min(0)
        hi = joints.reshape(-1, 3).max(0)
        for c, f in enumerate(np.linspace(0, n - 1, args.cols).round().astype(int)):
            pose = joints[f]
            for r, (a, b) in enumerate(((0, 1), (2, 1))):
                ax = axes[2 * t + r, c]
                for j, p in enumerate(parents):
                    if p < 0:
                        continue
                    colour = "r" if r == 0 and pose[j, 0] - pose[0, 0] > 0 else "k"
                    ax.plot([pose[j, a], pose[p, a]], [pose[j, b], pose[p, b]], color=colour, lw=0.9)
                ax.axhline(0, color="0.7", lw=0.5)
                ax.set_xlim(lo[a] - 0.2, hi[a] + 0.2)
                ax.set_ylim(-0.05, max(1.9, hi[1] + 0.1))
                ax.set_aspect("equal")
                ax.set_xticks([])
                ax.set_yticks([])
                if r == 0:
                    ax.set_title(f"#{t} f{f} {f / 30:.2f}s", fontsize=6)
    fig.suptitle(f"{args.title}   rows: front X-Y / side Z-Y per sample", fontsize=8)
    fig.tight_layout()
    fig.savefig(args.out, dpi=72)


if __name__ == "__main__":
    main()
