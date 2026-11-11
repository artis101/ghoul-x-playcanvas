import * as pc from 'playcanvas';

export function createProceduralConcreteMaterial(device: pc.GraphicsDevice): {
  material: pc.StandardMaterial;
  diffuseTexture: pc.Texture;
} {
  const size = 128;
  const pixels = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let h1 = (Math.imul(x + 17, 374761393) + Math.imul(y + 31, 668265263)) >>> 0;
      h1 = Math.imul(h1 ^ (h1 >>> 13), 1274126177) >>> 0;
      const fine = ((h1 ^ (h1 >>> 16)) >>> 0) / 4294967295;

      let h2 =
        (Math.imul((x >> 2) + 5, 2246822519) + Math.imul((y >> 2) + 9, 3266489917)) >>> 0;
      h2 = Math.imul(h2 ^ (h2 >>> 15), 668265263) >>> 0;
      const coarse = ((h2 ^ (h2 >>> 13)) >>> 0) / 4294967295;

      const seam = y % 32 === 0 ? -12 : 0;
      const base = Math.round(148 + (coarse - 0.5) * 24 + (fine - 0.5) * 16 + seam);
      const r = Math.max(60, Math.min(220, base));
      const g = Math.max(60, Math.min(220, base - 2));
      const b = Math.max(58, Math.min(218, base - 5));

      const p4 = (y * size + x) * 4;
      pixels[p4] = r;
      pixels[p4 + 1] = g;
      pixels[p4 + 2] = b;
      pixels[p4 + 3] = 255;
    }
  }

  const tex = new pc.Texture(device, {
    name: 'PouredConcreteAlbedo',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: pc.FILTER_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_REPEAT,
  });
  tex.lock().set(pixels);
  tex.unlock();

  const material = new pc.StandardMaterial();
  material.name = 'MultiDrawVoronoiConcreteMaterial';
  material.diffuse = new pc.Color(0.92, 0.91, 0.89);
  material.diffuseMap = tex;
  material.gloss = 0.2;
  material.update();

  return { material, diffuseTexture: tex };
}
