"""Read and append animation tracks without re-exporting the combatant mesh."""

import json
import struct
from copy import deepcopy
from pathlib import Path

from mathutils import Quaternion


class CombatantGlbAnimation:
    def __init__(self, path: Path):
        data = path.read_bytes()
        magic, version, length = struct.unpack_from("<4sII", data)
        json_length, json_type = struct.unpack_from("<I4s", data, 12)
        bin_length, bin_type = struct.unpack_from("<I4s", data, 20 + json_length)
        if (magic, version, length, json_type, bin_type) != (b"glTF", 2, len(data), b"JSON", b"BIN\0"):
            raise ValueError("Expected a GLB v2 with JSON and BIN chunks")
        self.doc = json.loads(data[20:20 + json_length])
        self.binary = bytearray(data[28 + json_length:])
        if len(self.binary) != bin_length or len(self.doc["buffers"]) != 1:
            raise ValueError("Expected one embedded buffer")
        self.nodes = {node["name"]: node for node in self.doc["nodes"] if "name" in node}

    def clip(self, name):
        return next(clip for clip in self.doc["animations"] if clip["name"] == name)

    def add_variant(self, base_name, variant_name):
        base = self.clip(base_name)
        for clip in self.doc["animations"]:
            if clip["name"] == variant_name:
                raise ValueError(f"{variant_name} already exists. Start from the original combatant GLB.")
        variant = deepcopy(base)
        variant["name"] = variant_name
        self.doc["animations"].append(variant)
        return variant

    def rotation_channels(self, clip):
        for name, node, path, sampler in self.channels(clip):
            if path == "rotation":
                yield name, node, sampler

    def channels(self, clip):
        for channel in clip["channels"]:
            target = channel["target"]
            node = self.doc["nodes"][target["node"]]
            yield node["name"], node, target["path"], clip["samplers"][channel["sampler"]]

    def local_rest(self, name):
        return gltf_quaternion(self.nodes[name].get("rotation", [0, 0, 0, 1]))

    def model_rest_rotations(self):
        rotations = {}

        def visit(index, parent_rotation):
            node = self.doc["nodes"][index]
            rotation = parent_rotation @ gltf_quaternion(node.get("rotation", [0, 0, 0, 1]))
            if "name" in node:
                rotations[node["name"]] = rotation
            for child in node.get("children", []):
                visit(child, rotation)

        for root in self.doc["scenes"][self.doc.get("scene", 0)]["nodes"]:
            visit(root, Quaternion())
        return rotations

    def read(self, index, kind, width):
        accessor = self.doc["accessors"][index]
        view = self.doc["bufferViews"][accessor["bufferView"]]
        if (accessor["componentType"], accessor["type"]) != (5126, kind):
            raise ValueError(f"Expected float {kind} animation data")
        if "sparse" in accessor or view.get("byteStride", 4 * width) != 4 * width:
            raise ValueError("Expected tightly packed animation data")
        offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        return [
            struct.unpack_from(f"<{width}f", self.binary, offset + row * width * 4)
            for row in range(accessor["count"])
        ]

    def replace_rotations(self, sampler, rotations):
        payload = bytearray()
        previous = None
        for rotation in rotations:
            rotation = rotation.normalized()
            if previous is not None and previous.dot(rotation) < 0:
                rotation.negate()
            payload.extend(struct.pack("<4f", rotation.x, rotation.y, rotation.z, rotation.w))
            previous = rotation
        sampler["output"] = self.append_accessor(payload, "VEC4", len(rotations))

    def replace_times(self, sampler, times):
        payload = struct.pack(f"<{len(times)}f", *times)
        sampler["input"] = self.append_accessor(
            payload, "SCALAR", len(times), min=[times[0]], max=[times[-1]]
        )

    def replace_vectors(self, sampler, values):
        payload = b"".join(struct.pack("<3f", *value) for value in values)
        sampler["output"] = self.append_accessor(payload, "VEC3", len(values))

    def append_accessor(self, payload, kind, count, **bounds):
        views = self.doc["bufferViews"]
        accessors = self.doc["accessors"]
        views.append({"buffer": 0, "byteOffset": len(self.binary), "byteLength": len(payload)})
        self.binary.extend(payload)
        accessors.append({"bufferView": len(views) - 1, "componentType": 5126,
                          "count": count, "type": kind, **bounds})
        return len(accessors) - 1

    def write(self, path: Path):
        self.doc["buffers"][0]["byteLength"] = len(self.binary)
        metadata = json.dumps(self.doc, separators=(",", ":")).encode()
        metadata += b" " * (-len(metadata) % 4)
        chunks = (struct.pack("<I4s", len(metadata), b"JSON") + metadata
                  + struct.pack("<I4s", len(self.binary), b"BIN\0") + self.binary)
        path.write_bytes(struct.pack("<4sII", b"glTF", 2, len(chunks) + 12) + chunks)


def gltf_quaternion(xyzw):
    x, y, z, w = xyzw
    return Quaternion((w, x, y, z))
