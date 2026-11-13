"""Generate several Kimodo takes with one model load, pinning poses for clean transitions.

Run inside the Kimodo environment on chonkster (`source ~/ai/kimodo/env.sh`):

    python scripts/blender/kimodo_batch.py wound_takes.json --out work/takes [--only name ...]

The job file is a list of takes:

    {"name": "hit_head", "prompts": ["A soldier ...", "He ..."], "durations": [0.5, 0.8],
     "seed": 3, "samples": 3,
     "pins": [{"at": [0, 1], "take": "work/ready_loop.npz", "frames": [0, 1]},
              {"at": "end", "take": "work/ready_loop.npz", "frames": [0, 1]}]}

Prompts are chained with Kimodo's multi-prompt transitions; a prompt must not contain a period.
A pin copies a source take's full-body pose (local rotations and root) onto frames of the new
take. `"at": "end"` pins the last frames. Pins are placed relative to the source's first pinned
frame and the new take's origin, so pinning a clip's opening and closing frames to the combat
stance makes it start and end exactly where the idle loop is. `"root": "keep"` keeps the source
root offset instead (a pose that ends where another take begins). Every sample is written as
NPZ and standard-T-pose BVH, plus one contact sheet PNG per take (`kimodo_sheet.py`).
"""

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import torch
from kimodo import load_model
from kimodo.constraints import load_constraints_lst
from kimodo.exports.bvh import save_motion_bvh
from kimodo.exports.motion_io import save_kimodo_npz
from kimodo.geometry import matrix_to_axis_angle
from kimodo.skeleton import global_rots_to_local_rots
from kimodo.tools import seed_everything

FPS = 30


def pin_entry(pin, total):
    source = np.load(pin["take"])
    frames = pin["frames"]
    at = pin["at"]
    if at == "end":
        at = list(range(total - len(frames), total))
    rotations = matrix_to_axis_angle(torch.from_numpy(source["local_rot_mats"][frames])).numpy()
    root = source["root_positions"][frames].astype(np.float64)
    smooth = source["smooth_root_pos"][frames] if "smooth_root_pos" in source.files else root
    smooth = np.asarray(smooth, dtype=np.float64)
    if pin.get("root") == "keep":
        origin = np.zeros(3)
    else:
        origin = np.array([root[0, 0], 0.0, root[0, 2]])
    shift = np.array(pin.get("offset", [0.0, 0.0, 0.0]))
    return {
        "type": "fullbody",
        "frame_indices": at,
        "local_joints_rot": rotations.tolist(),
        "root_positions": (root - origin + shift).tolist(),
        "smooth_root_2d": (smooth - origin + shift)[:, [0, 2]].tolist(),
    }


def merge_pins(entries):
    if not entries:
        return []
    merged = {"type": "fullbody", "frame_indices": [], "local_joints_rot": [], "root_positions": [],
              "smooth_root_2d": []}
    for entry in entries:
        for key in ("frame_indices", "local_joints_rot", "root_positions", "smooth_root_2d"):
            merged[key] += entry[key]
    return [merged]


def save_sample(output, index, path, skeleton, device):
    single = {k: (v[index] if hasattr(v, "shape") and v.ndim > 0 and v.shape[0] == output["posed_joints"].shape[0]
                  else v) for k, v in output.items()}
    save_kimodo_npz(str(path) + ".npz", single)
    joints = torch.from_numpy(output["posed_joints"][index]).to(device)
    rotations = torch.from_numpy(output["global_rot_mats"][index]).to(device)
    save_motion_bvh(str(path) + ".bvh", global_rots_to_local_rots(rotations, skeleton),
                    joints[:, skeleton.root_idx, :], skeleton=skeleton, fps=FPS, standard_tpose=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("jobs")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--only", nargs="*")
    parser.add_argument("--model", default="Kimodo-SOMA-RP-v1.2")
    args = parser.parse_args()

    jobs = json.loads(Path(args.jobs).read_text())
    if args.only:
        jobs = [job for job in jobs if job["name"] in args.only]
    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    model = load_model(args.model, device=device, default_family="Kimodo")
    skeleton = model.skeleton
    if hasattr(skeleton, "somaskel77"):
        skeleton = skeleton.somaskel77.to(device)
    sheet = Path(__file__).with_name("kimodo_sheet.py")
    args.out.mkdir(parents=True, exist_ok=True)

    for job in jobs:
        prompts = job["prompts"]
        if any("." in prompt.rstrip(".") for prompt in prompts):
            raise ValueError(f"{job['name']}: prompts are split on periods; remove inner periods")
        frames = [int(round(d * FPS)) for d in job["durations"]]
        total = sum(frames)
        pins = merge_pins([pin_entry(pin, total) for pin in job.get("pins", [])])
        constraints = load_constraints_lst(pins, model.skeleton) if pins else []
        seed_everything(job.get("seed", 7))
        output = model([p.rstrip(".") + "." for p in prompts], frames, constraint_lst=constraints,
                       num_denoising_steps=job.get("steps", 100), num_samples=job.get("samples", 3),
                       multi_prompt=True, num_transition_frames=job.get("transition", 5),
                       post_processing=True, return_numpy=True)
        stems = []
        for index in range(output["posed_joints"].shape[0]):
            stems.append(args.out / f"{job['name']}_{index:02d}")
            save_sample(output, index, stems[-1], skeleton, device)
        if sheet.exists():
            takes = " ".join(f"{stem}.npz" for stem in stems)
            os.system(f"{sys.executable} {sheet} {args.out / job['name']}.png {takes} --title '{job['name']}' "
                      ">/dev/null 2>&1")
        print(f"{job['name']}: {output['posed_joints'].shape[0]} samples, {total} frames", flush=True)


if __name__ == "__main__":
    main()
