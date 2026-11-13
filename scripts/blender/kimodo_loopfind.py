"""Find the cleanest loop window in a Kimodo take, for clips cut from a free (unpinned) take.

    python kimodo_loopfind.py take.npz --min 20 --max 60 [--top 5]

Compares every pair of frames (s, e) with e - s in [min, max] on joint rotations relative to the
hips, hip height and joint velocities, and prints the windows whose ends match best. Feed the
1-based range s+1..e+1 to TAKES with a few cross-fade frames to close the remaining gap.
"""
import argparse

import numpy as np


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("take")
    parser.add_argument("--min", type=int, default=20)
    parser.add_argument("--max", type=int, default=60)
    parser.add_argument("--top", type=int, default=5)
    args = parser.parse_args()
    take = np.load(args.take)
    joints = take["posed_joints"]
    # Pose relative to the hips, so travel and heading drift do not count against a gait cycle.
    rel = joints - joints[:, :1, :] * np.array([1, 0, 1])
    rel[:, :, [0, 2]] -= joints[:, :1, [0, 2]] * 0
    rel[:, :, [0, 2]] = joints[:, :, [0, 2]] - joints[:, :1, [0, 2]]
    vel = np.diff(rel, axis=0, prepend=rel[:1])
    n = len(rel)
    results = []
    for s in range(1, n):
        for e in range(s + args.min, min(n, s + args.max + 1)):
            pose = np.linalg.norm(rel[s] - rel[e], axis=1).mean()
            speed = np.linalg.norm(vel[s] - vel[e], axis=1).mean() * 4
            results.append((pose + speed, s, e, pose))
    results.sort()
    picked = []
    for score, s, e, pose in results:
        if any(abs(s - ps) < 6 and abs(e - pe) < 6 for _, ps, pe, _ in picked):
            continue
        picked.append((score, s, e, pose))
        if len(picked) == args.top:
            break
    for score, s, e, pose in picked:
        print(f"frames {s}..{e} (1-based {s + 1}..{e + 1}, {e - s} frames, {(e - s) / 30:.2f} s): "
              f"pose gap {pose * 100:.1f} cm, score {score:.4f}")


if __name__ == "__main__":
    main()
