"""Shrinks a GLB to stay in budget: vertex normals and UVs packed into small integers
(KHR_mesh_quantization), and every embedded PNG re-encoded losslessly (glb_png.py).

Normals become normalized int8 (stride 4) and UVs normalized uint16 where they sit inside 0..1.
Only meshes whose name starts with one of `prefixes` are touched: the runtime copies some gear
meshes through `Mesh.getNormals`/`getUvs`, which return raw values, so those stay float.
"""

import json
import struct
from typing import Dict, Sequence

import numpy as np

from glb_png import shrink_png

FLOAT, BYTE, USHORT = 5126, 5120, 5123
EXT = "KHR_mesh_quantization"


def _read_glb(path: str):
    data = open(path, "rb").read()
    json_len = struct.unpack("<I", data[12:16])[0]
    gltf = json.loads(data[20:20 + json_len].decode("utf-8"))
    bin_off = 20 + json_len
    bin_len = struct.unpack("<I", data[bin_off:bin_off + 4])[0]
    return gltf, data[bin_off + 8:bin_off + 8 + bin_len]


def _write_glb(path: str, gltf, views, binary: bytes, replaced: Dict[int, bytes]) -> None:
    out = bytearray()
    for index, view in enumerate(views):
        chunk = replaced.get(index)
        if chunk is None:
            start = view.get("byteOffset", 0)
            chunk = binary[start:start + view["byteLength"]]
        while len(out) % 4:
            out.append(0)
        view["byteOffset"] = len(out)
        view["byteLength"] = len(chunk)
        out.extend(chunk)
    while len(out) % 4:
        out.append(0)
    gltf["buffers"][0]["byteLength"] = len(out)
    js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    js += b" " * ((4 - len(js) % 4) % 4)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(out)))
        fh.write(struct.pack("<II", len(js), 0x4E4F534A))
        fh.write(js)
        fh.write(struct.pack("<II", len(out), 0x004E4942))
        fh.write(bytes(out))


def _floats(binary: bytes, view, accessor, width: int) -> np.ndarray:
    stride = view.get("byteStride", width * 4)
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    count = accessor["count"]
    flat = np.frombuffer(binary, dtype="<f4", count=(stride // 4) * (count - 1) + width, offset=start)
    return np.lib.stride_tricks.as_strided(flat, shape=(count, width), strides=(stride, 4)).astype(np.float64)


def quantize_glb_vertex_streams(path: str, prefixes: Sequence[str]) -> int:
    """Returns the number of bytes saved."""
    gltf, binary = _read_glb(path)
    accessors, views = gltf["accessors"], gltf["bufferViews"]
    users: Dict[int, int] = {}
    for accessor in accessors:
        if "bufferView" in accessor:
            users[accessor["bufferView"]] = users.get(accessor["bufferView"], 0) + 1
    replaced: Dict[int, bytes] = {}
    saved = 0
    for mesh in gltf.get("meshes", []):
        if not mesh.get("name", "").startswith(tuple(prefixes)):
            continue
        for prim in mesh["primitives"]:
            for semantic in ("NORMAL", "TEXCOORD_0"):
                index = prim["attributes"].get(semantic)
                if index is None:
                    continue
                accessor = accessors[index]
                view_index = accessor.get("bufferView")
                if accessor["componentType"] != FLOAT or view_index is None or users.get(view_index) != 1 or view_index in replaced:
                    continue
                view = views[view_index]
                if semantic == "NORMAL":
                    rows = _floats(binary, view, accessor, 3)
                    rows /= np.maximum(np.linalg.norm(rows, axis=1, keepdims=True), 1e-9)
                    packed = np.zeros((rows.shape[0], 4), dtype=np.int8)
                    packed[:, :3] = np.clip(np.round(rows * 127.0), -127, 127)
                    accessor["componentType"] = BYTE
                    view["byteStride"] = 4
                else:
                    rows = _floats(binary, view, accessor, 2)
                    if rows.min() < 0.0 or rows.max() > 1.0:
                        continue   # tiled UVs stay float
                    packed = np.round(rows * 65535.0).astype("<u2")
                    accessor["componentType"] = USHORT
                    view.pop("byteStride", None)
                    accessor.pop("min", None)
                    accessor.pop("max", None)
                accessor["normalized"] = True
                accessor["byteOffset"] = 0
                replaced[view_index] = packed.tobytes()
                saved += view["byteLength"] - len(replaced[view_index])
    for image in gltf.get("images", []):
        view_index = image.get("bufferView")
        if view_index is None or users.get(view_index, 0) != 0:
            continue
        view = views[view_index]
        start = view.get("byteOffset", 0)
        smaller = shrink_png(binary[start:start + view["byteLength"]])
        if len(smaller) < view["byteLength"]:
            saved += view["byteLength"] - len(smaller)
            replaced[view_index] = smaller
    if replaced:
        if any(accessor.get("normalized") and accessor["componentType"] in (BYTE, USHORT) for accessor in accessors):
            for key in ("extensionsUsed", "extensionsRequired"):
                names = gltf.setdefault(key, [])
                if EXT not in names:
                    names.append(EXT)
        _write_glb(path, gltf, views, binary, replaced)
    return saved
