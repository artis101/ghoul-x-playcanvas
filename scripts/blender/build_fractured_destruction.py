#!/usr/bin/env python3
"""
Procedural Blender 5.2.1 LTS Pipeline — 3D Voronoi Cell-Fractured Concrete Barrier & Instanced Debris Pack.

Generates:
  - public/models/concrete_wall_fractured.glb   (`IntactConcreteWall` + `Chunk_00` .. `Chunk_35`)
  - public/models/concrete_wall_connectivity.json (`ChunkConnectivityGraphJson`, version: 1)
  - public/models/debris_pack.glb               (`Brick_0..2` + `Splinter_0..2`)
  - public/models/blend_sources/concrete_wall_fractured.blend

Coordinate & Instancing Convention:
  - PlayCanvas / glTF 2.0 (+Y Up):
      Concrete wall spans X in [-1.80, +1.80] (3.60m), Y in [0.00, +2.40] (2.40m), Z in [-0.14, +0.14] (0.28m).
  - Every `Chunk_00..35`, `Brick_0..2`, and `Splinter_0..2` exports as a SINGLE watertight manifold
    glTF primitive (`Primitives created: 1`) with baked `COLOR_0` vertex colors differentiating exterior
    formwork faces from darker interior fracture cut faces, so `HardwareInstancedPool` renders 100% of
    each chunk/debris mesh in a single instanced draw call and Rapier3D receives the complete convex hull!
"""

import json
import math
import os
import random
from typing import Dict, List, Sequence, Tuple

import bmesh
import bpy
from mathutils import Vector


REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_DIR = os.path.join(REPO_ROOT, "public", "models")
OUT_WALL_GLB = os.path.join(OUT_DIR, "concrete_wall_fractured.glb")
OUT_CONN_JSON = os.path.join(OUT_DIR, "concrete_wall_connectivity.json")
OUT_DEBRIS_GLB = os.path.join(OUT_DIR, "debris_pack.glb")
OUT_BLEND = os.path.join(OUT_DIR, "blend_sources", "concrete_wall_fractured.blend")

WALL_WIDTH_X = 3.60
WALL_HEIGHT_Y = 2.40
WALL_THICK_Z = 0.28
CONCRETE_DENSITY_KG_M3 = 2400.0
FRACTURE_BOND_J_PER_M2 = 8500.0


def pc_to_bl(x: float, y: float, z: float) -> Vector:
    return Vector((x, -z, y))


def bl_to_pc(v: Vector) -> Tuple[float, float, float]:
    return (v.x, v.z, -v.y)


# ---------------------------------------------------------------------------
# PBR Materials with Vertex-Color Multiplication (1 Primitive per Instanced Mesh!)
# ---------------------------------------------------------------------------

def make_vcol_pbr_material(
    name: str,
    base_color: Tuple[float, float, float, float],
    roughness: float = 0.86,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name=name)
    if mat.node_tree is None:
        mat.use_nodes = True
    nt = mat.node_tree
    nodes = nt.nodes
    links = nt.links

    bsdf = nodes.get("Principled BSDF") or nodes.new(type="ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = base_color
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = 0.0

    vcol_node = nodes.new(type="ShaderNodeVertexColor")
    vcol_node.layer_name = "Col"
    mix_node = nodes.new(type="ShaderNodeMixRGB")
    mix_node.blend_type = "MULTIPLY"
    mix_node.inputs["Fac"].default_value = 1.0
    mix_node.inputs["Color1"].default_value = base_color

    links.new(vcol_node.outputs["Color"], mix_node.inputs["Color2"])
    links.new(mix_node.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


def build_materials() -> Dict[str, bpy.types.Material]:
    return {
        "concrete": make_vcol_pbr_material("Mat_ReinforcedConcrete", (0.62, 0.63, 0.61, 1.0), roughness=0.88),
        "brick": make_vcol_pbr_material("Mat_MasonryBrick", (0.64, 0.26, 0.18, 1.0), roughness=0.85),
        "wood": make_vcol_pbr_material("Mat_WoodSplinter", (0.74, 0.57, 0.35, 1.0), roughness=0.78),
    }


def assign_triplanar_uvs(bm: bmesh.types.BMesh, scale: float = 0.65) -> None:
    uv_layer = bm.loops.layers.uv.verify()
    for face in bm.faces:
        n = face.normal
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        for loop in face.loops:
            co = loop.vert.co
            if ay >= ax and ay >= az:
                u, v = (co.x + WALL_WIDTH_X * 0.5) * scale, co.z * scale
            elif ax >= ay and ax >= az:
                u, v = co.y * scale + 0.5, co.z * scale
            else:
                u, v = (co.x + WALL_WIDTH_X * 0.5) * scale, co.y * scale + 0.5
            loop[uv_layer].uv = (u, v)


def set_face_loop_colors(
    bm: bmesh.types.BMesh,
    face_color_fn,
) -> None:
    col_layer = bm.loops.layers.color.get("Col") or bm.loops.layers.color.new("Col")
    for face in bm.faces:
        rgba = face_color_fn(face)
        for loop in face.loops:
            loop[col_layer] = rgba


# ---------------------------------------------------------------------------
# 1. Intact Concrete Wall + 36-Cell 3D Voronoi Fracture + Connectivity Graph
# ---------------------------------------------------------------------------

def build_intact_wall_object(
    mats: Dict[str, bpy.types.Material],
    collection: bpy.types.Collection,
) -> bpy.types.Object:
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=2.0)
    hx = WALL_WIDTH_X * 0.5
    hy = WALL_HEIGHT_Y * 0.5
    hz = WALL_THICK_Z * 0.5
    for v in bm.verts:
        pc_x = v.co.x * hx
        pc_y = (v.co.z + 1.0) * hy
        pc_z = v.co.y * hz
        v.co = pc_to_bl(pc_x, pc_y, pc_z)

    bmesh.ops.bevel(
        bm, geom=bm.edges[:], offset=0.012, offset_type="OFFSET", segments=1, profile=0.5, affect="EDGES"
    )
    for f in bm.faces:
        f.material_index = 0
        f.smooth = False

    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    assign_triplanar_uvs(bm, scale=0.5)
    set_face_loop_colors(bm, lambda _f: (0.94, 0.95, 0.93, 1.0))

    mesh = bpy.data.meshes.new(name="IntactConcreteWall")
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(mats["concrete"])

    obj = bpy.data.objects.new(name="IntactConcreteWall", object_data=mesh)
    collection.objects.link(obj)
    return obj


def generate_voronoi_sites_pc(seed: int = 42, cols: int = 6, rows: int = 6) -> List[Tuple[float, float, float]]:
    rng = random.Random(seed)
    sites: List[Tuple[float, float, float]] = []
    dx = WALL_WIDTH_X / cols
    dy = WALL_HEIGHT_Y / rows
    for r in range(rows):
        for c in range(cols):
            jitter_x = rng.uniform(-0.27, 0.27) * dx
            jitter_y = rng.uniform(-0.18, 0.22) * dy if r == 0 else rng.uniform(-0.27, 0.27) * dy
            sx = -WALL_WIDTH_X * 0.5 + (c + 0.5) * dx + jitter_x
            sy = (r + 0.5) * dy + jitter_y
            sz = rng.uniform(-WALL_THICK_Z * 0.24, WALL_THICK_Z * 0.24)
            sites.append((sx, sy, sz))
    return sites


def build_voronoi_fractured_wall(
    mats: Dict[str, bpy.types.Material],
    collection: bpy.types.Collection,
) -> Tuple[List[bpy.types.Object], Dict[str, object]]:
    sites_pc = generate_voronoi_sites_pc(seed=42, cols=6, rows=6)
    sites_bl = [pc_to_bl(*s) for s in sites_pc]
    num_cells = len(sites_bl)

    hx = WALL_WIDTH_X * 0.5
    hy = WALL_HEIGHT_Y * 0.5
    hz = WALL_THICK_Z * 0.5

    raw_contact_area: Dict[Tuple[int, int], float] = {}
    chunk_objs: List[bpy.types.Object] = []
    node_records: List[Dict[str, object]] = []

    for i in range(num_cells):
        si = sites_bl[i]
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=2.0)
        for v in bm.verts:
            pc_x = v.co.x * hx
            pc_y = (v.co.z + 1.0) * hy
            pc_z = v.co.y * hz
            v.co = pc_to_bl(pc_x, pc_y, pc_z)

        nbr_layer = bm.faces.layers.int.new("neighbor_idx")
        for f in bm.faces:
            f[nbr_layer] = -1
            f.material_index = 0
            f.smooth = False

        for j in range(num_cells):
            if i == j:
                continue
            sj = sites_bl[j]
            mid = 0.5 * (si + sj)
            plane_no = (sj - si).normalized()
            ret = bmesh.ops.bisect_plane(
                bm,
                geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
                dist=1e-5,
                plane_co=mid,
                plane_no=plane_no,
                clear_outer=True,
                clear_inner=False,
            )
            cut_edges = [e for e in ret["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
            if cut_edges:
                fill_ret = bmesh.ops.holes_fill(bm, edges=cut_edges, sides=0)
                for nf in fill_ret.get("faces", []):
                    nf[nbr_layer] = j
                    nf.material_index = 0
                    nf.smooth = False

        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        assign_triplanar_uvs(bm, scale=0.65)

        for f in bm.faces:
            nbr = f[nbr_layer]
            if nbr >= 0:
                area = f.calc_area()
                if area > 1e-4:
                    key = (min(i, nbr), max(i, nbr))
                    raw_contact_area[key] = raw_contact_area.get(key, 0.0) + 0.5 * area

        # Bake exterior vs darker aggregate interior fracture face colors before triangulating
        set_face_loop_colors(
            bm,
            lambda f: (0.60, 0.61, 0.59, 1.0) if f[nbr_layer] >= 0 else (0.94, 0.95, 0.93, 1.0),
        )

        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])

        volume_m3 = max(1e-4, float(bm.calc_volume()))
        mass_kg = round(volume_m3 * CONCRETE_DENSITY_KG_M3, 2)

        pc_coords = [bl_to_pc(v.co) for v in bm.verts]
        min_x = min(p[0] for p in pc_coords)
        max_x = max(p[0] for p in pc_coords)
        min_y = min(p[1] for p in pc_coords)
        max_y = max(p[1] for p in pc_coords)
        min_z = min(p[2] for p in pc_coords)
        max_z = max(p[2] for p in pc_coords)

        cx = 0.5 * (min_x + max_x)
        cy = 0.5 * (min_y + max_y)
        cz = 0.5 * (min_z + max_z)
        center_bl = pc_to_bl(cx, cy, cz)

        for v in bm.verts:
            v.co -= center_bl

        chunk_name = f"Chunk_{i:02d}"
        mesh = bpy.data.meshes.new(name=chunk_name)
        bm.to_mesh(mesh)
        bm.free()
        mesh.materials.append(mats["concrete"])

        obj = bpy.data.objects.new(name=chunk_name, object_data=mesh)
        obj.location = center_bl
        collection.objects.link(obj)
        chunk_objs.append(obj)

        is_anchored = min_y <= 0.05
        node_records.append(
            {
                "index": i,
                "name": chunk_name,
                "isAnchored": bool(is_anchored),
                "localCenter": {"x": round(cx, 5), "y": round(cy, 5), "z": round(cz, 5)},
                "halfExtents": {
                    "x": round(0.5 * (max_x - min_x), 5),
                    "y": round(0.5 * (max_y - min_y), 5),
                    "z": round(0.5 * (max_z - min_z), 5),
                },
                "massKg": mass_kg,
                "meshVariant": i,
                "edges": [],
            }
        )

    adjacency: Dict[int, List[Dict[str, object]]] = {i: [] for i in range(num_cells)}
    for (a, b), shared_area in sorted(raw_contact_area.items()):
        if shared_area < 2e-4:
            continue
        threshold_j = round(max(180.0, shared_area * FRACTURE_BOND_J_PER_M2), 1)
        adjacency[a].append({"neighborIndex": b, "breakThresholdJ": threshold_j, "severed": False})
        adjacency[b].append({"neighborIndex": a, "breakThresholdJ": threshold_j, "severed": False})

    for i in range(num_cells):
        edges_sorted = sorted(adjacency[i], key=lambda e: int(e["neighborIndex"]))  # type: ignore[arg-type]
        node_records[i]["edges"] = edges_sorted

    connectivity_json: Dict[str, object] = {
        "version": 1,
        "wallId": "concrete_barrier_v1",
        "nodes": node_records,
    }
    return chunk_objs, connectivity_json


# ---------------------------------------------------------------------------
# 2. Instanced Debris Pack (`Brick_0..2` + `Splinter_0..2`)
# ---------------------------------------------------------------------------

def build_brick_variant(
    index: int,
    mats: Dict[str, bpy.types.Material],
    collection: bpy.types.Collection,
) -> bpy.types.Object:
    rng = random.Random(100 + index)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=2.0)

    hx = 0.1075 * rng.uniform(0.96, 1.03)
    hy = 0.0325 * rng.uniform(0.96, 1.04)
    hz = 0.0510 * rng.uniform(0.96, 1.03)
    for v in bm.verts:
        v.co = pc_to_bl(v.co.x * hx, v.co.z * hy, v.co.y * hz)

    if index >= 1:
        chip_co = pc_to_bl(hx * 0.72, hy * 0.55, hz * (0.65 if index == 1 else -0.65))
        chip_no = pc_to_bl(0.68, 0.52, 0.51 if index == 1 else -0.51).normalized()
        ret = bmesh.ops.bisect_plane(
            bm,
            geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
            dist=1e-5,
            plane_co=chip_co,
            plane_no=chip_no,
            clear_outer=True,
            clear_inner=False,
        )
        cut_edges = [e for e in ret["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
        if cut_edges:
            bmesh.ops.holes_fill(bm, edges=cut_edges, sides=0)

    bmesh.ops.bevel(
        bm, geom=bm.edges[:], offset=0.0045, offset_type="OFFSET", segments=1, profile=0.5, affect="EDGES"
    )
    for f in bm.faces:
        f.material_index = 0
        f.smooth = False

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    shade = 0.96 - index * 0.09
    set_face_loop_colors(
        bm,
        lambda f: (0.86, 0.85, 0.82, 1.0) if (index == 2 and f.normal.z > 0.85) else (shade, shade * 0.94, shade * 0.90, 1.0),
    )
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    assign_triplanar_uvs(bm, scale=4.0)

    name = f"Brick_{index}"
    mesh = bpy.data.meshes.new(name=name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(mats["brick"])

    obj = bpy.data.objects.new(name=name, object_data=mesh)
    collection.objects.link(obj)
    return obj


def build_splinter_variant(
    index: int,
    mats: Dict[str, bpy.types.Material],
    collection: bpy.types.Collection,
) -> bpy.types.Object:
    rng = random.Random(200 + index)
    bm = bmesh.new()

    length_x = 0.20 + index * 0.038
    half_w = 0.016 + rng.uniform(-0.003, 0.005)
    half_t = 0.009 + rng.uniform(-0.002, 0.003)

    stations = [
        (-0.50 * length_x, 0.08, 0.12, rng.uniform(-0.006, 0.006)),
        (-0.26 * length_x, 0.85, 0.90, rng.uniform(-0.004, 0.004)),
        (0.00 * length_x, 1.00, 1.00, 0.0),
        (0.28 * length_x, 0.78, 0.85, rng.uniform(-0.004, 0.004)),
        (0.50 * length_x, 0.06, 0.10, rng.uniform(-0.007, 0.007)),
    ]

    rings: List[List[bmesh.types.BMVert]] = []
    sides = 6
    for sx, sy_scale, sz_scale, y_jag in stations:
        r_verts: List[bmesh.types.BMVert] = []
        for s in range(sides):
            ang = (2.0 * math.pi * s) / sides + (0.22 if s % 2 == 1 else 0.0)
            py = math.sin(ang) * half_w * sy_scale + y_jag
            pz = math.cos(ang) * half_t * sz_scale
            r_verts.append(bm.verts.new(pc_to_bl(sx, py, pz)))
        rings.append(r_verts)

    for r_i in range(len(rings) - 1):
        r0 = rings[r_i]
        r1 = rings[r_i + 1]
        for s in range(sides):
            sn = (s + 1) % sides
            f = bm.faces.new((r0[s], r0[sn], r1[sn], r1[s]))
            f.material_index = 0
            f.smooth = False

    tip_left = bm.verts.new(pc_to_bl(-0.56 * length_x, rng.uniform(-0.005, 0.005), 0.0))
    tip_right = bm.verts.new(pc_to_bl(0.56 * length_x, rng.uniform(-0.005, 0.005), 0.0))
    for s in range(sides):
        sn = (s + 1) % sides
        f0 = bm.faces.new((tip_left, rings[0][sn], rings[0][s]))
        f1 = bm.faces.new((tip_right, rings[-1][s], rings[-1][sn]))
        f0.material_index = 0
        f1.material_index = 0
        f0.smooth = False
        f1.smooth = False

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    set_face_loop_colors(
        bm,
        lambda f: (0.62, 0.52, 0.40, 1.0) if abs(f.normal.y) > 0.75 else (0.96, 0.90, 0.78, 1.0),
    )
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    assign_triplanar_uvs(bm, scale=5.0)

    name = f"Splinter_{index}"
    mesh = bpy.data.meshes.new(name=name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(mats["wood"])

    obj = bpy.data.objects.new(name=name, object_data=mesh)
    collection.objects.link(obj)
    return obj


def export_objects_glb(objs: Sequence[bpy.types.Object], filepath: str) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=filepath,
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_all_vertex_colors=True,
        export_materials="EXPORT",
        export_animations=False,
        export_lights=False,
    )


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(OUT_BLEND), exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0

    mats = build_materials()

    wall_col = bpy.data.collections.new("ConcreteWallFractured")
    debris_col = bpy.data.collections.new("DebrisPack")
    scene.collection.children.link(wall_col)
    scene.collection.children.link(debris_col)

    intact_obj = build_intact_wall_object(mats, wall_col)
    chunk_objs, connectivity_json = build_voronoi_fractured_wall(mats, wall_col)

    export_objects_glb([intact_obj] + chunk_objs, OUT_WALL_GLB)

    with open(OUT_CONN_JSON, "w", encoding="utf-8") as f:
        json.dump(connectivity_json, f, indent=2)
        f.write("\n")

    debris_objs: List[bpy.types.Object] = []
    for idx in range(3):
        debris_objs.append(build_brick_variant(idx, mats, debris_col))
    for idx in range(3):
        debris_objs.append(build_splinter_variant(idx, mats, debris_col))
    export_objects_glb(debris_objs, OUT_DEBRIS_GLB)

    # Offset intact reference wall & debris variants cleanly for non-overlapping inspection in Blender 5.2 GUI
    intact_obj.location.x = -4.2
    for idx, dobj in enumerate(debris_objs):
        dobj.location = pc_to_bl(2.5 + (idx % 3) * 0.45, 0.25 + (idx // 3) * 0.35, 0.0)
    bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND)

    nodes = connectivity_json["nodes"]  # type: ignore[index]
    anchored_count = sum(1 for n in nodes if n["isAnchored"])  # type: ignore[index]
    edge_count = sum(len(n["edges"]) for n in nodes) // 2  # type: ignore[index,arg-type]
    print(
        f"[Fracture Pipeline] {len(chunk_objs)} Voronoi chunks ({anchored_count} anchored, {edge_count} undirected bonds) | "
        f"concrete_wall_fractured.glb: {os.path.getsize(OUT_WALL_GLB) / 1024.0:.1f} KB | "
        f"debris_pack.glb: {os.path.getsize(OUT_DEBRIS_GLB) / 1024.0:.1f} KB"
    )


if __name__ == "__main__":
    main()
