"""Score Kimodo takes so the strongest clean sample of each prompt can be picked.

    python kimodo_score.py work/takes/hit_head_0?.npz

Per sample: how far the head and chest travel from the first pose (the reaction's size), the
lowest the pelvis gets (falls), jitter (mean third difference of joint positions, which shows
as buzzing), and foot slide while a foot is planted.
"""
import sys

import numpy as np
from kimodo.skeleton import SOMASkeleton77

SK = SOMASkeleton77()
IDX = {name: SK.bone_index[name] for name in ("Hips", "Chest", "Head", "LeftHand", "RightHand", "LeftFoot", "RightFoot")}


def score(path):
    take = np.load(path)
    joints = take["posed_joints"]
    rel = joints - joints[:, :1, :] * np.array([1, 0, 1])
    start = rel[0]
    head = np.linalg.norm(rel[:, IDX["Head"]] - start[IDX["Head"]], axis=1).max()
    chest = np.linalg.norm(rel[:, IDX["Chest"]] - start[IDX["Chest"]], axis=1).max()
    hands = max(np.linalg.norm(rel[:, IDX[h]] - start[IDX[h]], axis=1).max() for h in ("LeftHand", "RightHand"))
    jitter = np.abs(np.diff(joints, n=3, axis=0)).mean() * 1000
    hips_low = joints[:, IDX["Hips"], 1].min()
    slide = 0.0
    for foot in ("LeftFoot", "RightFoot"):
        y = joints[:, IDX[foot], 1]
        planted = y < y.min() + 0.03
        step = np.linalg.norm(np.diff(joints[:, IDX[foot], [0, 2]], axis=0), axis=1)
        slide += step[planted[1:] & planted[:-1]].sum()
    return head, chest, hands, jitter, hips_low, slide


print(f"{'take':28s} head  chest hands jitter hipsLow slide")
for path in sys.argv[1:]:
    h, c, hd, j, low, s = score(path)
    print(f"{path.split('/')[-1]:28s} {h:.2f}  {c:.2f}  {hd:.2f}  {j:5.2f}  {low:.2f}   {s:.2f}")
