"""Read and append animation tracks without re-exporting the combatant mesh."""

import json
import struct
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

    def clear_animations(self):
        # This asset uses standard glTF mesh, skin and image references.
        accessor_refs = []
        for mesh in self.doc["meshes"]:
            for primitive in mesh["primitives"]:
                accessor_refs.append((primitive, "indices"))
                for attrs in [primitive["attributes"], *primitive.get("targets", [])]:
                    accessor_refs.extend((attrs, key) for key in attrs)
        accessor_refs.extend((skin, "inverseBindMatrices") for skin in self.doc["skins"])
        accessor_refs = [(obj, key) for obj, key in accessor_refs if key in obj]
        accessors = self.retain_referenced(self.doc["accessors"], accessor_refs)
        view_refs = [(accessor, "bufferView") for accessor in accessors]
        view_refs.extend((image, "bufferView") for image in self.doc["images"])
        views = self.retain_referenced(self.doc["bufferViews"], view_refs)
        packed = bytearray()
        for view in views:
            start = view.get("byteOffset", 0)
            packed.extend(b"\0" * (-len(packed) % 4))
            view["byteOffset"] = len(packed)
            packed.extend(self.binary[start:start + view["byteLength"]])
        packed.extend(b"\0" * (-len(packed) % 4))
        self.doc.update(animations=[], accessors=accessors, bufferViews=views)
        self.binary = packed

    def prune_unused_images(self):
        """Drops textures and images that no material uses. Call before clear_animations."""
        slots = []

        def visit(value):
            if isinstance(value, dict):
                for key, child in value.items():
                    if key.endswith("Texture") and isinstance(child, dict) and "index" in child:
                        slots.append(child)
                    visit(child)
            elif isinstance(value, list):
                for child in value:
                    visit(child)

        visit(self.doc["materials"])
        textures = self.retain_referenced(self.doc["textures"], [(slot, "index") for slot in slots])
        images = self.retain_referenced(self.doc["images"], [(texture, "source") for texture in textures])
        self.doc.update(textures=textures, images=images)

    @staticmethod
    def retain_referenced(items, refs):
        indices = sorted({obj[key] for obj, key in refs})
        mapping = {index: new for new, index in enumerate(indices)}
        for obj, key in refs:
            obj[key] = mapping[obj[key]]
        return [items[index] for index in indices]

    def add_clip(self, name, times, frames):
        """Appends a clip. Its keys share one buffer view; rotations are normalized int16."""
        clip = {"name": name, "channels": [], "samplers": []}
        self.clip_view = {"buffer": 0, "byteOffset": len(self.binary), "byteLength": 0}
        self.doc["bufferViews"].append(self.clip_view)
        self.clip_view_index = len(self.doc["bufferViews"]) - 1
        time_sampler = {}
        self.replace_times(time_sampler, times)
        node_indices = {node["name"]: index for index, node in enumerate(self.doc["nodes"])}
        for bone, path in frames[0]:
            sampler = {"input": time_sampler["input"], "interpolation": "LINEAR"}
            clip["channels"].append({"sampler": len(clip["samplers"]),
                                     "target": {"node": node_indices[bone], "path": path}})
            clip["samplers"].append(sampler)
            values = [frame[bone, path] for frame in frames]
            if path == "rotation":
                self.replace_rotations(sampler, values)
            else:
                self.replace_vectors(sampler, values)
        self.clip_view["byteLength"] = len(self.binary) - self.clip_view["byteOffset"]
        self.clip_view = None
        self.doc["animations"].append(clip)

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
        component = accessor["componentType"]
        if accessor["type"] != kind or component not in (5126, 5122):
            raise ValueError(f"Expected float or normalized int16 {kind} animation data")
        size = 4 if component == 5126 else 2
        if "sparse" in accessor or view.get("byteStride", size * width) != size * width:
            raise ValueError("Expected tightly packed animation data")
        offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        code = "f" if component == 5126 else "h"
        rows = [struct.unpack_from(f"<{width}{code}", self.binary, offset + row * width * size)
                for row in range(accessor["count"])]
        if component == 5122:
            rows = [tuple(max(value / 32767, -1.0) for value in row) for row in rows]
        return rows

    def replace_rotations(self, sampler, rotations):
        payload = bytearray()
        previous = None
        for rotation in rotations:
            rotation = rotation.normalized()
            if previous is not None and previous.dot(rotation) < 0:
                rotation.negate()
            payload.extend(struct.pack("<4h", *(round(max(-1.0, min(1.0, value)) * 32767)
                                                for value in (rotation.x, rotation.y, rotation.z, rotation.w))))
            previous = rotation
        sampler["output"] = self.append_accessor(payload, "VEC4", len(rotations), component=5122)

    def replace_times(self, sampler, times):
        payload = struct.pack(f"<{len(times)}f", *times)
        sampler["input"] = self.append_accessor(
            payload, "SCALAR", len(times), min=[times[0]], max=[times[-1]]
        )

    def replace_vectors(self, sampler, values):
        payload = b"".join(struct.pack("<3f", *value) for value in values)
        sampler["output"] = self.append_accessor(payload, "VEC3", len(values))

    def append_accessor(self, payload, kind, count, component=5126, **bounds):
        views = self.doc["bufferViews"]
        accessors = self.doc["accessors"]
        accessor = {"componentType": component, "count": count, "type": kind, **bounds}
        if component == 5122:
            accessor["normalized"] = True
        view = getattr(self, "clip_view", None)
        if view is None:
            views.append({"buffer": 0, "byteOffset": len(self.binary), "byteLength": len(payload)})
            accessor["bufferView"] = len(views) - 1
        else:
            self.binary.extend(b"\0" * (-len(self.binary) % 4))
            accessor["bufferView"] = self.clip_view_index
            accessor["byteOffset"] = len(self.binary) - view["byteOffset"]
        self.binary.extend(payload)
        accessors.append(accessor)
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
