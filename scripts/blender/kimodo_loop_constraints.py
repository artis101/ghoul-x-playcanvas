"""Write Kimodo keyframe constraints that make a generated take loop.

Run inside the Kimodo environment on chonkster (`source ~/ai/kimodo/env.sh`). Takes a pose
from an existing take's NPZ and pins it at both ends of a new take: frames 0 and 1 hold the
source pose and the frame after it, and the last two frames hold the same pair moved along
by one stride. The new take then starts and ends in the same pose at the same speed, so the
clip from frame 0 to the second-to-last pinned frame repeats without a cross-fade.

    python kimodo_loop_constraints.py take.npz --start 51 --end 119 --output constraints.json
    kimodo_gen "<prompt>" --duration <(end - start + 2) / 30> --constraints constraints.json ...

Frame numbers are zero-based NPZ frames. `--end` is the source frame that best matches
`--start` one cycle later; it sets the loop length and the stride.
"""

import argparse
import json

import numpy as np
import torch
from kimodo.geometry import matrix_to_axis_angle


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("take")
    parser.add_argument("--start", type=int, required=True)
    parser.add_argument("--end", type=int, required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--in-place", action="store_true", help="Pin both ends at the same spot, for idles")
    args = parser.parse_args()

    take = np.load(args.take)
    length = args.end - args.start
    source = [args.start, args.start + 1]
    rotations = matrix_to_axis_angle(torch.from_numpy(take["local_rot_mats"][source])).numpy()
    root = take["root_positions"][source].astype(np.float64)
    smooth = take["smooth_root_pos"][source].astype(np.float64)
    stride = take["root_positions"][args.end] - take["root_positions"][args.start]
    stride[1] = 0.0
    if args.in_place:
        stride[:] = 0.0
    origin = np.array([root[0, 0], 0.0, root[0, 2]])

    frames, poses, roots, smooth_roots = [], [], [], []
    for offset, shift in ((0, np.zeros(3)), (length, stride)):
        for index in range(2):
            frames.append(offset + index)
            poses.append(rotations[index].tolist())
            roots.append((root[index] - origin + shift).tolist())
            smooth_roots.append((smooth[index] - origin + shift)[[0, 2]].tolist())
    with open(args.output, "w") as handle:
        json.dump([{
            "type": "fullbody",
            "frame_indices": frames,
            "local_joints_rot": poses,
            "root_positions": roots,
            "smooth_root_2d": smooth_roots,
        }], handle)
    print(f"{args.output}: {length} frame loop, stride {np.linalg.norm(stride):.2f} m, "
          f"generate {length + 2} frames ({(length + 2) / 30:.3f} s)")


if __name__ == "__main__":
    main()
