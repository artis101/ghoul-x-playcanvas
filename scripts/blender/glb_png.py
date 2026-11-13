"""Re-encodes the PNGs inside a GLB as small as possible without changing a pixel.

Blender writes PNGs with light compression. The painted pages use few colours (they are stepped to
15-bit colour), so an indexed PNG usually fits; otherwise RGB with per-row filter choice and zlib 9.
Plain numpy + zlib, because Blender's Python has no imaging library.
"""

import struct
import zlib
from typing import Optional

import numpy as np

SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _chunks(data: bytes):
    pos = 8
    while pos < len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        yield kind, data[pos + 8:pos + 8 + length]
        pos += 12 + length


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = np.abs(p - a), np.abs(p - b), np.abs(p - c)
    return np.where((pa <= pb) & (pa <= pc), a, np.where(pb <= pc, b, c))


def decode_png(data: bytes) -> Optional[np.ndarray]:
    """8-bit, non-interlaced greyscale/RGB/RGBA only; anything else returns None."""
    if not data.startswith(SIGNATURE):
        return None
    idat, header = b"", None
    for kind, body in _chunks(data):
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat += body
    if header is None:
        return None
    width, height, depth, colour, _c, _f, interlace = header
    channels = {0: 1, 2: 3, 6: 4}.get(colour)
    if depth != 8 or interlace or channels is None:
        return None
    raw = np.frombuffer(zlib.decompress(idat), dtype=np.uint8).reshape(height, width * channels + 1)
    out = np.zeros((height, width * channels), dtype=np.int32)
    prev = np.zeros(width * channels, dtype=np.int32)
    for y in range(height):
        kind, line = raw[y, 0], raw[y, 1:].astype(np.int32)
        if kind == 0:
            row = line
        elif kind == 2:
            row = (line + prev) & 255
        else:
            # Sub, average and paeth depend on the pixel to the left: walk the pixels, all channels at once.
            row = np.zeros_like(line)
            zero = np.zeros(channels, dtype=np.int32)
            for x in range(0, width * channels, channels):
                left = row[x - channels:x] if x else zero
                up = prev[x:x + channels]
                corner = prev[x - channels:x] if x else zero
                pred = left if kind == 1 else (left + up) // 2 if kind == 3 else _paeth(left, up, corner)
                row[x:x + channels] = (line[x:x + channels] + pred) & 255
        out[y] = row
        prev = row
    return out.reshape(height, width, channels).astype(np.uint8)


def _filtered(rows: np.ndarray, bpp: int) -> bytes:
    """Per row, the filter whose output has the smallest sum of absolute values."""
    out = bytearray()
    prev = np.zeros(rows.shape[1], dtype=np.int32)
    for row in rows.astype(np.int32):
        left = np.concatenate([np.zeros(bpp, np.int32), row[:-bpp]])
        corner = np.concatenate([np.zeros(bpp, np.int32), prev[:-bpp]])
        options = [row, row - left, row - prev, row - (left + prev) // 2, row - _paeth(left, prev, corner)]
        options = [(o & 255).astype(np.uint8) for o in options]
        cost = [np.abs(o.astype(np.int8).astype(np.int32)).sum() for o in options]
        best = int(np.argmin(cost))
        out.append(best)
        out.extend(options[best].tobytes())
        prev = row
    return bytes(out)


def _chunk(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)


def encode_png(pixels: np.ndarray) -> bytes:
    height, width, channels = pixels.shape
    colours, inverse = np.unique(pixels.reshape(-1, channels), axis=0, return_inverse=True)
    if channels in (3, 4) and len(colours) <= 256:
        header = struct.pack(">IIBBBBB", width, height, 8, 3, 0, 0, 0)
        body = _chunk(b"PLTE", colours[:, :3].astype(np.uint8).tobytes())
        if channels == 4:
            body += _chunk(b"tRNS", colours[:, 3].astype(np.uint8).tobytes())
        data = _filtered(inverse.reshape(height, width).astype(np.uint8), 1)
    else:
        header = struct.pack(">IIBBBBB", width, height, 8, {1: 0, 3: 2, 4: 6}[channels], 0, 0, 0)
        body = b""
        data = _filtered(pixels.reshape(height, width * channels), channels)
    return SIGNATURE + _chunk(b"IHDR", header) + body + _chunk(b"IDAT", zlib.compress(data, 9)) + _chunk(b"IEND", b"")


def shrink_png(data: bytes) -> bytes:
    pixels = decode_png(data)
    if pixels is None:
        return data
    smaller = encode_png(pixels)
    return smaller if len(smaller) < len(data) else data
