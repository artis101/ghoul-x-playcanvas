# GHOUL-X combatant animation

Character Lab at `/gm/characters` uses the same combatant GLB as gameplay. Select an animation, equip a prop, pause, and scrub Character time to check the pose and grip. The GLB contains 60 Kimodo-derived clips: 22 handed actions with a right- and left-handed (`_Southpaw`) version of each, and 16 wound clips named for the side of the body they hurt (the Left clip is the Right take mirrored). How the wound clips chain together in game is in [docs/wound-movement.md](../../docs/wound-movement.md). PlayCanvas supplies the character's world movement, prop attachment, support-hand IK, and ragdoll transitions.

Select **Long Gun Aim** or **Pistol Aim** to see the raise and held pose. With that character pose paused, select the held item's fire animation and scrub **Item time**. The held item's animated grip bones drive the NPC's hands through the cycle. The first-person hands use the weapon's animated root and, on the shotgun, the pump bone.

## Motion sources

`motion/` contains the source SOMA BVH takes. The bake retargets the full skeleton and mirrors the motion for handedness. Backward walk uses the walk cycle in reverse.

The [Kimodo demo](http://chonkster.local:7860) and CLI run on chonkster. In a Bash shell, `cd ~/ai/kimodo` and `source env.sh`. Use `Kimodo-SOMA-RP-v1.2`, `--bvh` and `--bvh_standard_tpose` for new takes.

One-shot clips use a single take. The combat-ready, guard, kneel, collapse, strafe, long-gun aim, and pistol aim takes used seeds 55, 27, 17, 41, 81, 61, and 72, respectively. The stagger, walk, and run takes came from `motions/heavy_hit_stagger.npz`, `motions/walk.npz`, and `motions/run.npz`, converted with `kimodo_convert … --bvh_standard_tpose`.

### Looping clips

Every looping clip is generated twice. The first take supplies the motion; pick the frames where one cycle starts and ends. The second take pins the first take's opening pose at both ends with Kimodo keyframe constraints, so it closes exactly and the bake needs no cross-fade. The bake fails if a looping clip is more than 1.5 degrees or 1 cm off at its seam.

```sh
kimodo_convert motion/walk.bvh walk.npz --bvh_standard_tpose
python scripts/blender/kimodo_loop_constraints.py walk.npz --start 39 --end 69 --output walk.json
kimodo_gen "A person walks forward at a steady pace." --model Kimodo-SOMA-RP-v1.2 \
  --duration 1.08 --constraints walk.json --bvh --bvh_standard_tpose --seed 7 --output walk_loop
```

Frames are zero-based, the duration is `(end - start + 2.4) / 30`, and idles add `--in-place`. The second take's frames 1 to `end - start + 1` are the loop.

| Clip | First take | Frames | Second take |
| --- | --- | --- | --- |
| CombatReadyIdle | `ready.bvh` | 11–104, in place | `ready_loop.bvh` |
| UnsuspectingIdle | `guard.bvh` | 7–111, in place | `guard_loop.bvh` |
| Walk, WalkBackward | `walk.bvh` | 39–69 | `walk_loop.bvh` |
| Run | `run.bvh` | 53–78 | `run_loop.bvh` |
| StrafeLeft, StrafeRight | `strafe.bvh` | 59–90 | `strafe_loop.bvh` |
| Crawl | `crawl_cycle.bvh` | 51–119 | `crawl_loop.bvh` |

The crawl's first take used seed 41 with three samples and the prompt "A wounded person lies on their stomach and crawls forward along the ground, pulling with their arms and dragging their legs."; sample 0 is `crawl_cycle.bvh`. Its second take used the same prompt and seed. The other second takes used seed 7.

### Wound and aim takes

The wound, aim and downed takes were generated in batches with `kimodo_batch.py`, which loads the model once and pins poses for clean transitions. Each job file (`wound_takes*.json`) lists the prompts, seeds, sample counts and pins:

```sh
work=work; mkdir -p $work
kimodo_convert scripts/blender/motion/ready_loop.bvh $work/ready_loop.npz --bvh_standard_tpose
python scripts/blender/kimodo_batch.py scripts/blender/wound_takes.json --out $work/takes
```

- **Prompts describe body mechanics, never events.** "bends forward at the waist and holds the stomach with the left hand", not "is shot in the gut". Kimodo learned from motion descriptions.
- **Pins carry the transitions.** Flinches pin their first and last two frames to frame 0 of `ready_loop`, so they leave and return to the combat stance. Falls pin only their start and end seated by prompt. The leg-loss lift and fall pin to the landing crouch of the free hop take (`hop_r_04` frames 35–36), the stump loop and stump kneel to the last pose of the arm-loss take, and sit-to-crawl to the seated end of a leg-shot fall.
- **Multi-prompt takes need a pin in every segment** or Kimodo fails; write one-segment prompts with "then" otherwise.
- **The one-leg hop** is the free take `hop_r` (frames 36–78, two hops) with a 6-frame cross-fade at the seam. A short pinned window flattened the hops.

Pick a sample per take with `kimodo_score.py` (reaction size, jitter, foot slide) and `kimodo_sheet.py` (stick-figure contact sheets), then compare finalists on the real body: `bake_candidates.py` bakes takes as clips, `render_clip_frames.py` renders them in Blender and `clip_sheet.py` stitches one sheet per clip. The chosen samples are copied to `motion/` under the names `TAKES` uses.

## Bake and edit

From `/home/artis/dev/new-age/ghoul-x-playcanvas` on chonkster, run:

```sh
work=$(mktemp -d /tmp/ghoul-kimodo.XXXXXX)
blender -b --python-exit-code 1 --python scripts/blender/bake_kimodo_combatant.py -- \
  scripts/blender/motion public/models/ghoul_combatant.glb "$work/ghoul_combatant.glb" \
  --blend "$work/combatant.blend" --m4a1-reference public/models/m4a1_carbine.glb
```

Open `combatant.blend`, select `GhoulArmature`, and pick the action in Blender's Action Editor. Edit and keyframe bone rotations in Pose Mode. The M4A1 reference is attached to the character's right hand (`Bone_HAND_RIGHT`). Hide it when editing the left-handed action and use Character Lab to check the live two-hand grip.

Keep the action name and frame range. To export only the changed bone rotations, use the corresponding clip and bone names:

```sh
blender -b "$work/combatant.blend" --python-exit-code 1 \
  --python scripts/blender/export_combatant_rotations.py -- \
  "$work/ghoul_combatant.glb" "$work/ghoul_combatant-edited.glb" \
  --clip CombatReadyIdle --bones Bone_UPPER_ARM_RIGHT Bone_FOREARM_RIGHT Bone_HAND_RIGHT
```

Copy the edited GLB to `public/models/ghoul_combatant.glb`, reload Character Lab, and scrub the edited section. The exporter samples each frame inside the clip's range. Use `bake_kimodo_combatant.py` to change a clip's source take or timing.

## Body and skins

`build_combatant_rigged.py` builds the whole combatant. `combatant_body.py` holds the torso, neck, arm and leg shapes and `combatant_body_loft.py` turns them into skinned zone meshes. Each chain (spine, arm, leg) is one continuous surface cut into `Zone_*` meshes at shared rings. A zone's vertices are weighted only to its own bone and its parent bone, so joints bend and the runtime can rebind a severed zone to its own bone (`combatantSeveredSkin.ts`).

The body is a heavily muscled man about eight heads tall, matching the character sheets (head and hands at true scale). Its shape comes from a `BodyBuild` (muscle, girth, belly, legs). The base build is the heavy one, and `BUILD_MORPHS` exports other builds as morph targets on the zone meshes: `Build_Lean`, `Build_Brute` and `Build_Belly`. A build changes only radii and sculpt depth, so every build keeps the same vertices. The game mixes them per spawn within each archetype's range (`src/core/ghoul/anatomy/archetypeBodyBuild.ts`). To add a variation, add a `BodyBuild` to `BUILD_MORPHS` and give it a range there.

The look is late-90s / early-2000s console: a low polygon count, and one hand-painted 256 px skin page per character with the light painted in, stepped to 15-bit colour and point-sampled. There are no normal or roughness maps. Clothing, muscle, tattoos and faces are all paint, so the four characters share one body.

| File | Holds |
| --- | --- |
| `combatant_skin_designs.py` | the four `LOOKS` (one per archetype) and `paint_page` |
| `combatant_skin_body.py`, `combatant_skin_head.py` | what gets painted on each body part |
| `combatant_skin_paint.py` | brushes: anatomy, cloth folds, pockets, belts, tattoos |
| `combatant_skin_atlas.py` | where each part sits on the page, and the final dither |
| `combatant_skin_uv.py` | puts the head, hands, boots and hat on the page |
| `combatant_gas_mask.py` | Bear's half-face respirator (`Gear_GasMask`) and its own painted page |
| `glb_quantize.py`, `glb_png.py` | the size pass after export: int8 normals and uint16 UVs (`KHR_mesh_quantization`) on meshes the runtime never copies, and every PNG re-encoded losslessly |

The five looks are the skinhead, the Muscle (`MILITIA_GUNNER`), Bear (`MASKED_BRUISER`), the enforcer and the sniper. The body meshes carry the `MILITIA_GUNNER` page. The hidden `Skin_Library` mesh carries all four as `Mat_Skin_<archetype>`, and the runtime swaps in the right one (`combatantGlbMaterials.ts`).

To change a character, edit its `Look` or the painters. To change the body, edit the station tables in `combatant_body.py`. Then rebuild and rebake the animations:

```sh
GHOUL_COMBATANT_OUT="$work" blender -b --python-exit-code 1 --python scripts/blender/build_combatant_rigged.py
blender -b --python-exit-code 1 --python scripts/blender/bake_kimodo_combatant.py -- \
  scripts/blender/motion "$work/ghoul_combatant.glb" "$work/baked.glb"
```

Copy `baked.glb` to `public/models/ghoul_combatant.glb` and `ghoul_combatant.blend` to `public/models/blend_sources/`. The baked GLB must stay under 2 MiB; with the current 60 clips it is about 1.95 MB. Each clip's keys share one buffer view and rotations are stored as normalized int16, which halves the animation data.

While working on the paint, add `GHOUL_SKIP_ANIMATION=1` to skip the placeholder animation bake and `GHOUL_SKIN_PREVIEW=<dir>` to also write each skin page as a PNG.
