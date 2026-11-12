# GHOUL-X combatant animation

Character Lab at `/gm/characters` uses the same combatant GLB as gameplay. Select an animation, equip a prop, pause, and scrub Character time to check the pose and grip. The GLB contains twelve Kimodo-derived actions with a right- and left-handed version of each. PlayCanvas supplies the character's world movement, prop attachment, support-hand IK, and ragdoll transitions.

Select **Long Gun Aim** or **Pistol Aim** to see the raise and held pose. With that character pose paused, select the held item's fire animation and scrub **Item time**. The held item's animated grip bones drive the NPC's hands through the cycle. The first-person hands use the weapon's animated root and, on the shotgun, the pump bone.

## Motion sources

`motion/` contains the source SOMA BVH takes. The bake retargets the full skeleton, mirrors the motion for handedness, and closes the movement and idle loops. Walk, run, and strafe combine the generated lower body with the generated combat-ready upper body. Backward walk uses the walk cycle in reverse.

The [Kimodo demo](http://chonkster.local:7860) and CLI run on chonkster. In a Bash shell, `cd ~/ai/kimodo` and `source env.sh`. Use `Kimodo-SOMA-RP-v1.2`, `--bvh` and `--bvh_standard_tpose` for new takes. The combat-ready, guard, kneel, crawl, strafe, long-gun aim, and pistol aim takes used seeds 55, 27, 17, 41, 81, 61, and 72, respectively. The stagger, walk, and run takes came from `motions/heavy_hit_stagger.npz`, `motions/walk.npz`, and `motions/run.npz`, converted with `kimodo_convert … --bvh_standard_tpose`.

## Bake and edit

From `/home/artis/dev/new-age/ghoul-x-playcanvas` on chonkster, run:

```sh
work=$(mktemp -d /tmp/ghoul-kimodo.XXXXXX)
blender -b --python-exit-code 1 --python scripts/blender/bake_kimodo_combatant.py -- \
  scripts/blender/motion public/models/ghoul_combatant.glb "$work/ghoul_combatant.glb" \
  --blend "$work/combatant.blend" --m4a1-reference public/models/m4a1_carbine.glb
```

Open `combatant.blend`, select `GhoulArmature`, and pick the action in Blender's Action Editor. Edit and keyframe bone rotations in Pose Mode. The M4A1 reference is attached to the anatomical right hand (`Bone_HAND_LEFT` in this rig). Hide it when editing the left-handed action and use Character Lab to check the live two-hand grip.

Keep the action name and frame range. To export only the changed bone rotations, use the corresponding clip and bone names:

```sh
blender -b "$work/combatant.blend" --python-exit-code 1 \
  --python scripts/blender/export_combatant_rotations.py -- \
  "$work/ghoul_combatant.glb" "$work/ghoul_combatant-edited.glb" \
  --clip CombatReadyIdle --bones Bone_UPPER_ARM_LEFT Bone_FOREARM_LEFT Bone_HAND_LEFT
```

Copy the edited GLB to `public/models/ghoul_combatant.glb`, reload Character Lab, and scrub the edited section. The exporter samples each frame inside the clip's range. Use `bake_kimodo_combatant.py` to change a clip's source take or timing.
