"""Render frames of baked combatant clips for review, without opening Blender's UI.

    blender -b --python-exit-code 1 --python scripts/blender/render_clip_frames.py -- \
      baked.glb out_dir --clips LegLossRight HitFlinchHead --frames 10

Writes `<out_dir>/<clip>_<view>_<index>.png`, a front three-quarter and a side view at evenly
spaced times, on a floor grid so sinking and floating show. Stitch them into one sheet per
clip with `clip_sheet.py`.
"""

import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def setup_scene(glb):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(glb))
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "TEXTURE"
    scene.render.resolution_x = 240
    scene.render.resolution_y = 300
    scene.render.film_transparent = False
    scene.world = bpy.data.worlds.new("World")
    scene.world.color = (0.82, 0.84, 0.86)
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=12, y_subdivisions=12, size=4)
    floor = bpy.context.object
    floor.display_type = "WIRE"
    for obj in scene.objects:
        if obj.type == "MESH" and obj.name.startswith("Skin_Library"):
            obj.hide_render = True
    return scene


def find_armature():
    return next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")


def find_action(clip):
    """The importer may append the armature name; never pick a longer clip name by prefix."""
    for action in bpy.data.actions:
        name = action.name
        if name == clip or (name.startswith(clip + "_") and not name[len(clip) + 1:].startswith("Southpaw")
                            and "Southpaw" not in clip and not name[len(clip) + 1:][:1].isupper()):
            return action
    return None


def add_camera(scene, name, yaw_deg):
    camera = bpy.data.objects.new(name, bpy.data.cameras.new(name))
    scene.collection.objects.link(camera)
    yaw = math.radians(yaw_deg)
    target = Vector((0, 0, 0.62))
    camera.location = target + Vector((math.sin(yaw) * 4.2, -math.cos(yaw) * 4.2, 0.55))
    direction = target - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    camera.data.lens = 58
    return camera


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("glb", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--clips", nargs="+", required=True)
    parser.add_argument("--frames", type=int, default=10)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    args.out.mkdir(parents=True, exist_ok=True)
    scene = setup_scene(args.glb.resolve())
    armature = find_armature()
    armature.animation_data_create()
    # glTF forward is +Z, which Blender imports as -Y; the cameras look at the character's front.
    cameras = {"front": add_camera(scene, "front", 30), "side": add_camera(scene, "side", 90)}
    for clip in args.clips:
        action = find_action(clip)
        if action is None:
            print(f"missing clip {clip}; actions: {sorted(a.name for a in bpy.data.actions)[:8]}")
            continue
        armature.animation_data.action = action
        if hasattr(armature.animation_data, "action_slot") and action.slots:
            armature.animation_data.action_slot = action.slots[0]
        start, end = action.frame_range
        for index in range(args.frames):
            frame = start + (end - start) * index / max(1, args.frames - 1)
            scene.frame_set(int(frame), subframe=frame - int(frame))
            for view, camera in cameras.items():
                scene.camera = camera
                scene.render.filepath = str(args.out / f"{clip}_{view}_{index:02d}.png")
                bpy.ops.render.render(write_still=True)
        print(f"rendered {clip} ({action.name}, frames {start:.0f}-{end:.0f})")


if __name__ == "__main__":
    main()
