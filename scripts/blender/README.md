# GHOUL-X guard idle

The first Kimodo take is a stationary guard idle. The bake transfers the SOMA spine, neck, and head rotations onto the existing guard pose. It crossfades the end back into the start and mirrors the motion for the left-handed variant. PlayCanvas still mounts the held item and solves the support arm. AI movement, stride, injury reactions, and ragdoll transitions use their existing paths.

In Character Lab, select **Guard Idle (Kimodo)** or **Guard Idle (Kimodo, left hand)** at `/gm/characters`. Select a held item, pause, and scrub Character time to check the grip. In gameplay the combatant controller selects the matching Kimodo clip while the NPC is guarding and falls back to the original idle if that variant is absent.

## Generate on chonkster

The interactive Kimodo demo is at `http://chonkster.local:7860`. The tracked `motion/guard_idle.bvh` came from this CLI run on chonkster. Its four seconds of source motion were sampled into the existing 2.54-second guard loop.

```sh
ssh chonkster.local
bash
cd ~/ai/kimodo
source env.sh
work=$(mktemp -d /tmp/ghoul-kimodo.XXXXXX)
kimodo_gen 'A person stands in place, breathing softly and slowly shifting their weight between their feet, keeping both feet planted and their torso facing forward' \
  --model Kimodo-SOMA-RP-v1.2 --duration 4 --diffusion_steps 35 --seed 42 \
  --bvh --bvh_standard_tpose --output "$work/guard_idle"
```

## Bake and edit in Blender

Run from the chonkster project root, `/home/artis/dev/new-age/ghoul-x-playcanvas`. The original guard actions are the base for the new clips. Use the pre-Kimodo GLB when rebuilding.

```sh
work=$(mktemp -d /tmp/ghoul-kimodo.XXXXXX)
git show 5220b19:public/models/ghoul_combatant.glb > "$work/combatant-base.glb"
blender -b --python-exit-code 1 --python scripts/blender/bake_kimodo_guard_idle.py -- \
  scripts/blender/motion/guard_idle.bvh "$work/combatant-base.glb" "$work/ghoul_combatant.glb" \
  --blend "$work/guard_idle.blend" --m4a1-reference public/models/m4a1_carbine.glb
```

Open `guard_idle.blend`, select `GhoulArmature`, and edit the `UnsuspectingIdle_Kimodo` action in Pose Mode. The scene includes a hand-parented M4A1 for reference. Character Lab runs the game's live support-hand solver and is the place to check the final grip. For left-handed edits, select the `UnsuspectingIdle_Kimodo_Southpaw` action and hide the right-hand reference prop.

Keep the action's name and frame range. After editing, save the blend and export the rotation tracks of the bones you changed. Add `--southpaw` to export the left-hand action. The exporter samples every frame in the original clip's range. Use it for rotation edits within the existing loop.

```sh
blender -b "$work/guard_idle.blend" --python-exit-code 1 \
  --python scripts/blender/export_guard_idle_rotations.py -- \
  "$work/ghoul_combatant.glb" "$work/ghoul_combatant-edited.glb" \
  --bones Bone_UPPER_ARM_LEFT Bone_FOREARM_LEFT Bone_HAND_LEFT
```

Copy the edited GLB to `public/models/ghoul_combatant.glb`, reload Character Lab, and scrub the edited section with the corresponding held item. The scripts write the animation samples directly into the GLB so the existing meshes, materials, skeleton and other actions survive the export.
