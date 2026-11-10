import * as pc from 'playcanvas';
import { EnemyArchetypeId } from '../contracts/ballistics.ts';

const BAYER_4X4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

type RGB = [number, number, number];

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function hash2d(x: number, y: number, seed: number): number {
  let n = Math.imul(x * 374761393 + y * 668265263 + seed * 1442695041, 1274126177);
  n = (n ^ (n >>> 13)) >>> 0;
  return (n & 0xffff) / 0xffff;
}

/**
 * Creates a crisp nearest-neighbor PS1/PS2 pixel-art pc.Texture from a procedural pixel painter.
 */
function createRetroPixelTexture(
  device: pc.GraphicsDevice,
  name: string,
  size: number,
  painter: (x: number, y: number, u: number, v: number) => RGB,
  bloodSplatterSeed = 0
): pc.Texture {
  const tex = new pc.Texture(device, {
    name,
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: pc.FILTER_NEAREST,
    magFilter: pc.FILTER_NEAREST,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_REPEAT,
  });

  const pixels = tex.lock() as Uint8Array;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let [r, g, b] = painter(x, y, u, v);

      // Apply authentic PS1 15-bit / 5-6-5 color quantization + ordered 4x4 Bayer dithering!
      const bayer = (BAYER_4X4[y & 3][x & 3] / 16.0 - 0.5) * 14.0;
      r = Math.floor(clampByte(r + bayer) / 8) * 8;
      g = Math.floor(clampByte(g + bayer) / 8) * 8;
      b = Math.floor(clampByte(b + bayer) / 8) * 8;

      // Optional Soldier of Fortune GHOUL blood-soaked laceration overlay
      if (bloodSplatterSeed > 0) {
        const cx = u - 0.5;
        const cy = v - 0.5;
        const n1 = hash2d(x >> 1, y >> 1, bloodSplatterSeed);
        const n2 = hash2d(x, y, bloodSplatterSeed + 99);
        const dist = Math.sqrt(cx * cx * 0.8 + cy * cy * 1.1) - n1 * 0.28;
        if (dist < 0.14) {
          // Deep exposed muscle gash
          r = n2 > 0.35 ? 118 : 74;
          g = n2 > 0.35 ? 10 : 6;
          b = n2 > 0.35 ? 14 : 8;
        } else if (dist < 0.28 || n1 > 0.84) {
          // Soaked crimson blood stain on fabric/skin
          r = Math.round(r * 0.3 + 125 * 0.7);
          g = Math.round(g * 0.12 + 8 * 0.88);
          b = Math.round(b * 0.12 + 12 * 0.88);
        }
      }

      const idx = (y * size + x) * 4;
      pixels[idx] = clampByte(r);
      pixels[idx + 1] = clampByte(g);
      pixels[idx + 2] = clampByte(b);
      pixels[idx + 3] = 255;
    }
  }
  tex.unlock();
  return tex;
}

function makePs1Material(name: string, tex: pc.Texture, gloss = 0.18): pc.StandardMaterial {
  const mat = new pc.StandardMaterial();
  mat.name = name;
  mat.diffuse = new pc.Color(1, 1, 1);
  mat.diffuseMap = tex;
  mat.specular = new pc.Color(0.08, 0.08, 0.08);
  mat.gloss = gloss;
  mat.pixelSnap = false;
  mat.update();
  return mat;
}

export interface ArchetypeRetroMaterialSet {
  headMat: pc.StandardMaterial;
  headBloodyMat: pc.StandardMaterial;
  jawMat: pc.StandardMaterial;
  jawBloodyMat: pc.StandardMaterial;
  torsoMat: pc.StandardMaterial;
  torsoBloodyMat: pc.StandardMaterial;
  abdomenMat: pc.StandardMaterial;
  abdomenBloodyMat: pc.StandardMaterial;
  pelvisMat: pc.StandardMaterial;
  pelvisBloodyMat: pc.StandardMaterial;
  upperArmMat: pc.StandardMaterial;
  upperArmBloodyMat: pc.StandardMaterial;
  forearmMat: pc.StandardMaterial;
  forearmBloodyMat: pc.StandardMaterial;
  handMat: pc.StandardMaterial;
  legsMat: pc.StandardMaterial;
  legsBloodyMat: pc.StandardMaterial;
  kneePadMat: pc.StandardMaterial;
  bootMat: pc.StandardMaterial;
  headgearMat: pc.StandardMaterial;
  visorMat: pc.StandardMaterial;
  pouchWebbingMat: pc.StandardMaterial;
  weaponMetalMat: pc.StandardMaterial;
  weaponFurnitureMat: pc.StandardMaterial;
}

const cachedArchetypeSets = new Map<EnemyArchetypeId, ArchetypeRetroMaterialSet>();

/**
 * Generates and caches PS1/PS2 pixel-art materials (both intact & GHOUL lacerated variants) for each enemy archetype.
 */
export function getArchetypeRetroMaterials(
  device: pc.GraphicsDevice,
  archetype: EnemyArchetypeId
): ArchetypeRetroMaterialSet {
  const existing = cachedArchetypeSets.get(archetype);
  if (existing) return existing;

  const S = 64;

  // Shared tactical boots (laced front, dark leather creases, lug sole)
  const bootTex = createRetroPixelTexture(device, `${archetype}_boot`, S, (x, y, u, v) => {
    const grain = (hash2d(x, y, 11) - 0.5) * 14;
    // Sole rim at bottom
    if (v < 0.18) {
      const tread = x % 6 < 3 ? -12 : 8;
      return [24 + tread, 24 + tread, 26 + tread];
    }
    // Laces strip down front center (u near 0.5)
    if (Math.abs(u - 0.5) < 0.09 && v > 0.25 && v < 0.85) {
      const rung = y % 5 === 0;
      return rung ? [76, 76, 80] : [18, 18, 20];
    }
    const crease = Math.sin(v * 18) * 8;
    return [34 + grain + crease, 33 + grain + crease, 37 + grain + crease];
  });

  const kneePadTex = createRetroPixelTexture(device, `${archetype}_kneepad`, 32, (x, y, u, v) => {
    const border = u < 0.12 || u > 0.88 || v < 0.12 || v > 0.88;
    const rivet = (x === 6 || x === 25) && (y === 6 || y === 25);
    if (rivet) return [135, 138, 142];
    if (border) return [24, 26, 28];
    const n = (hash2d(x, y, 21) - 0.5) * 12;
    return [46 + n, 49 + n, 52 + n];
  });

  const weaponMetalTex = createRetroPixelTexture(device, `${archetype}_gunmetal`, 32, (x, y, _u, v) => {
    const n = (hash2d(x, y, 77) - 0.5) * 16;
    const vent = y % 4 === 0 && x > 10 && x < 26 ? -18 : 0;
    const highlight = Math.abs(v - 0.55) < 0.08 ? 22 : 0;
    return [56 + n + vent + highlight, 60 + n + vent + highlight, 66 + n + vent + highlight];
  });

  const weaponWoodOrPolyTex = createRetroPixelTexture(
    device,
    `${archetype}_gunfurn`,
    32,
    (x, y, u, _v) => {
      if (archetype === 'MILITIA_GUNNER' || archetype === 'SNIPER_OPERATIVE') {
        // Classic AK / SVD warm varnished wood grain!
        const streak = Math.sin(y * 0.9 + hash2d(x >> 2, y, 55) * 2.5) * 16;
        return [128 + streak, 68 + streak * 0.5, 32 + streak * 0.3];
      }
      const checkering = (x + y) % 2 === 0 && u > 0.25 && u < 0.75 ? -10 : 4;
      return [38 + checkering, 40 + checkering, 44 + checkering];
    }
  );

  // Archetype-specific pixel painters!
  const headPainter = (x: number, y: number, u: number, v: number): RGB => {
    const n = (hash2d(x, y, 101) - 0.5) * 14;
    // Front face occupies u in [0.28, 0.72] when cylindrical UV wraps with +Z at u = 0.5
    const du = Math.abs(u - 0.5);

    if (archetype === 'MILITIA_GUNNER') {
      // Black 3-hole knit balaclava with menacing eye cutouts!
      const knit = (x % 2 === 0 ? 4 : -4) + (y % 3 === 0 ? -5 : 2);
      // Eye openings around v = 0.52, u = 0.41 and 0.59
      if (v > 0.44 && v < 0.60 && du > 0.04 && du < 0.16) {
        // Skin around eyes + dark pupil center
        if (v > 0.49 && v < 0.56 && Math.abs(du - 0.10) < 0.03) {
          return [22, 18, 16]; // pupil
        }
        if (v > 0.49 && v < 0.56 && Math.abs(du - 0.10) < 0.05) {
          return [215, 210, 205]; // sclera
        }
        return [186 + n, 142 + n, 112 + n];
      }
      return [34 + knit + n * 0.5, 36 + knit + n * 0.5, 38 + knit + n * 0.5];
    }

    // Skin base tone
    const baseSkin: RGB =
      archetype === 'SKINHEAD_PUNK'
        ? [206, 156, 126]
        : archetype === 'HEAVY_ENFORCER'
          ? [188, 140, 110]
          : [212, 168, 138];

    let [r, g, b] = [baseSkin[0] + n, baseSkin[1] + n, baseSkin[2] + n];

    // Camo face paint stripes for Siberian Sniper!
    if (archetype === 'SNIPER_OPERATIVE' && du < 0.25) {
      const stripe = Math.sin(u * 26 + v * 12);
      if (stripe > 0.55 && v > 0.25 && v < 0.65) {
        r -= 75;
        g -= 52;
        b -= 68;
      }
    }

    // Shaved scalp stubble / hair on back & crown
    if (v > 0.72 || du > 0.27) {
      if (archetype === 'SKINHEAD_PUNK') {
        // Buzzed scalp + center mohawk base
        if (du < 0.06 && v > 0.62) return [165 + n, 28, 28];
        return [r * 0.78, g * 0.76, b * 0.76];
      }
      return [68 + n, 54 + n, 44 + n];
    }

    // Brow & Eyes on front face (v ~ 0.48..0.62)
    if (v > 0.58 && v < 0.64 && du > 0.03 && du < 0.18) {
      return [48, 36, 28]; // angry furrowed eyebrows
    }
    if (v > 0.48 && v < 0.57 && du > 0.05 && du < 0.16) {
      if (Math.abs(du - 0.105) < 0.028) return [24, 22, 20]; // pupil
      return [222, 218, 212]; // eye white
    }
    // Nose bridge shadow
    if (du < 0.035 && v > 0.34 && v < 0.54) {
      return [r - 22, g - 20, b - 18];
    }

    return [r, g, b];
  };

  const jawPainter = (x: number, y: number, u: number, v: number): RGB => {
    const n = (hash2d(x, y, 109) - 0.5) * 14;
    const du = Math.abs(u - 0.5);
    if (archetype === 'MILITIA_GUNNER') {
      // Balaclava mouth hole
      if (du < 0.09 && v > 0.35 && v < 0.65) {
        return v > 0.46 && v < 0.54 ? [78, 28, 28] : [175 + n, 130 + n, 102 + n];
      }
      return [32 + n * 0.5, 34 + n * 0.5, 36 + n * 0.5];
    }
    // Gritty 5-o'clock stubble & grimacing mouth line
    if (du < 0.10 && v > 0.48 && v < 0.58) {
      return [76, 36, 34];
    }
    const stubble = (x + y) % 2 === 0 ? -18 : -4;
    return [182 + stubble + n, 136 + stubble + n, 108 + stubble + n];
  };

  const torsoPainter = (x: number, y: number, u: number, v: number): RGB => {
    const n = (hash2d(x, y, 203) - 0.5) * 16;
    const du = Math.abs(u - 0.5);

    if (archetype === 'SKINHEAD_PUNK') {
      // Classic SoF NYC Subway Punk: Black studded leather biker vest open over stained white ribbed tank-top!
      if (du < 0.11 && v < 0.85) {
        const rib = x % 3 === 0 ? -14 : 6;
        return [198 + rib + n, 194 + rib + n, 184 + rib + n];
      }
      // Silver studs along lapels
      if (Math.abs(du - 0.13) < 0.025 && y % 8 < 2) {
        return [205, 210, 218];
      }
      // Red skull/anarchy back patch hint on rear (du > 0.38)
      if (du > 0.39 && v > 0.35 && v < 0.72) {
        return [155 + n, 26, 24];
      }
      const leatherCrease = Math.sin(v * 16 + u * 8) * 10;
      return [32 + leatherCrease + n * 0.6, 32 + leatherCrease + n * 0.6, 36 + leatherCrease + n * 0.6];
    }

    if (archetype === 'MILITIA_GUNNER') {
      // Olive drab M65 field jacket with khaki Soviet chest rig straps & center zipper!
      if (du < 0.02) return [42, 46, 36]; // zipper seam
      // Diagonal/vertical harness straps
      if (Math.abs(du - 0.14) < 0.035) {
        return [118 + n, 104 + n, 72 + n];
      }
      // Horizontal chest mag bandolier
      if (v > 0.25 && v < 0.48 && du < 0.24) {
        const pocketSeam = x % 8 === 0 ? -20 : 6;
        return [112 + pocketSeam + n, 98 + pocketSeam + n, 66 + pocketSeam + n];
      }
      const fold = Math.sin(v * 20) * 9;
      return [74 + fold + n, 84 + fold + n, 56 + fold + n];
    }

    if (archetype === 'HEAVY_ENFORCER') {
      // Charcoal Kevlar diamond-weave ballistic plate carrier + yellow/white SWAT/ENFORCER stencil!
      const weave = (x + y) % 4 === 0 ? 10 : -6;
      // Stencil bar across upper chest
      if (du < 0.14 && v > 0.62 && v < 0.74 && x % 3 !== 0) {
        return [215, 182, 58];
      }
      // Plate border lines
      if (Math.abs(du - 0.19) < 0.02 || Math.abs(v - 0.2) < 0.03) {
        return [24, 28, 32];
      }
      return [48 + weave + n * 0.5, 54 + weave + n * 0.5, 60 + weave + n * 0.5];
    }

    // SNIPER_OPERATIVE: Winter Arctic/Urban Splinter Camo Parka + dark leather cross-strap!
    if (Math.abs(u - v * 0.5 - 0.25) < 0.035) {
      return [46 + n, 36 + n, 28 + n]; // diagonal sniper sling
    }
    const c1 = hash2d(x >> 3, y >> 3, 311);
    const c2 = hash2d((x + 5) >> 2, (y + 3) >> 2, 317);
    if (c1 > 0.66) return [88 + n, 98 + n, 106 + n];
    if (c2 < 0.3) return [52 + n, 60 + n, 66 + n];
    return [142 + n, 148 + n, 152 + n];
  };

  const legsPainter = (x: number, y: number, u: number, v: number): RGB => {
    const n = (hash2d(x, y, 401) - 0.5) * 14;
    const crease = Math.sin(v * 22 + u * 6) * 8;
    const cellX = Math.floor(x / 6);
    const cellY = Math.floor(y / 6);
    const blotch = hash2d(cellX, cellY, 409);

    if (archetype === 'SKINHEAD_PUNK') {
      // Classic SoF Urban Grey/Black/White Camo Cargo Pants!
      if (blotch > 0.68) return [158 + n + crease, 162 + n + crease, 166 + n + crease];
      if (blotch < 0.32) return [36 + n + crease, 38 + n + crease, 42 + n + crease];
      return [88 + n + crease, 92 + n + crease, 98 + n + crease];
    }

    if (archetype === 'MILITIA_GUNNER') {
      // Classic Woodland M81 Camo BDU trousers!
      if (blotch > 0.72) return [98 + n + crease, 76 + n + crease, 48 + n + crease];
      if (blotch < 0.28) return [32 + n + crease, 36 + n + crease, 28 + n + crease];
      return [62 + n + crease, 78 + n + crease, 48 + n + crease];
    }

    if (archetype === 'HEAVY_ENFORCER') {
      // Tactical Navy-Slate SWAT Ripstop BDU trousers
      const ripstop = x % 4 === 0 || y % 4 === 0 ? -5 : 3;
      return [42 + ripstop + n + crease, 52 + ripstop + n + crease, 68 + ripstop + n + crease];
    }

    // SNIPER_OPERATIVE: Gorka Olive-Khaki Canvas Field Pants
    if (v > 0.28 && v < 0.72 && blotch > 0.55) {
      return [92 + n + crease, 88 + n + crease, 64 + n + crease];
    }
    return [116 + n + crease, 112 + n + crease, 86 + n + crease];
  };

  const armPainter = (isForearm: boolean) => (x: number, y: number, u: number, v: number): RGB => {
    const n = (hash2d(x, y, 503) - 0.5) * 14;
    if (archetype === 'SKINHEAD_PUNK') {
      // Bare muscular arms + dark tribal/barbed-wire pixel tattoo on bicep!
      const muscleShade = Math.cos((u - 0.5) * Math.PI * 2) * 14;
      if (!isForearm && v > 0.42 && v < 0.58 && (x + y) % 3 === 0) {
        return [42, 54, 58]; // tattoo band
      }
      return [204 + muscleShade + n, 152 + muscleShade + n, 120 + muscleShade + n];
    }
    if (archetype === 'MILITIA_GUNNER' && isForearm && v < 0.55) {
      // Rolled-up jacket sleeves exposing bare forearms!
      return [186 + n, 142 + n, 112 + n];
    }
    return torsoPainter(x, y, u, v);
  };

  const beltPelvisPainter = (x: number, y: number, u: number, v: number): RGB => {
    // Top 28% is tactical web belt + brass/steel buckle at front center!
    if (v > 0.72) {
      if (Math.abs(u - 0.5) < 0.07) {
        return [178, 162, 92]; // belt buckle
      }
      const grommet = x % 6 === 0 && y % 3 === 0 ? 35 : 0;
      return [30 + grommet, 32 + grommet, 30 + grommet];
    }
    return legsPainter(x, y, u, v);
  };

  const handGlovePainter = (x: number, y: number, _u: number, v: number): RGB => {
    const n = (hash2d(x, y, 601) - 0.5) * 12;
    if (archetype === 'SKINHEAD_PUNK' || archetype === 'MILITIA_GUNNER') {
      // Fingerless black leather tactical gloves! Bare fingers at v < 0.35
      if (v < 0.36) {
        return [192 + n, 145 + n, 114 + n];
      }
      return [32 + n, 32 + n, 35 + n];
    }
    return [36 + n, 38 + n, 42 + n];
  };

  const headgearPainter = (x: number, y: number, u: number, v: number): RGB => {
    const n = (hash2d(x, y, 701) - 0.5) * 14;
    if (archetype === 'SKINHEAD_PUNK') {
      // Crimson Punk Mohawk spikes!
      return [185 + n, 24 + Math.max(0, n), 28];
    }
    if (archetype === 'SNIPER_OPERATIVE') {
      // Iconic Crimson Spetsnaz Beret with gold flash badge over left temple!
      if (Math.abs(u - 0.42) < 0.05 && v > 0.25 && v < 0.65) {
        return [220, 185, 52];
      }
      if (v < 0.16) return [24, 24, 26]; // black leather headband rim
      return [148 + n, 22 + n * 0.3, 32 + n * 0.3];
    }
    if (archetype === 'HEAVY_ENFORCER') {
      // Dark Slate PASGT Kevlar Helmet with camo scrim band
      if (v > 0.32 && v < 0.46) return [30 + n, 34 + n, 32 + n];
      return [54 + n, 62 + n, 68 + n];
    }
    // MILITIA_GUNNER: Ribbed dark olive watch cap / balaclava crown
    const rib = x % 3 === 0 ? -10 : 6;
    return [44 + rib + n * 0.4, 48 + rib + n * 0.4, 38 + rib + n * 0.4];
  };

  const visorPainter = (x: number, y: number, _u: number, v: number): RGB => {
    const glint = x + y > 24 && x + y < 30 ? 65 : 0;
    if (archetype === 'HEAVY_ENFORCER') {
      // Ballistic amber-gold tactical goggles!
      return [195 + glint, 138 + glint, 28 + glint];
    }
    // Dark wraparound punk shades
    return [22 + glint, 28 + glint + (v > 0.6 ? 18 : 0), 36 + glint];
  };

  const pouchPainter = (x: number, y: number, u: number, v: number): RGB => {
    const n = (hash2d(x, y, 809) - 0.5) * 12;
    const flap = Math.abs(v - 0.62) < 0.05 ? -22 : 0;
    const snap = Math.abs(u - 0.5) < 0.12 && Math.abs(v - 0.52) < 0.08;
    if (snap) return [155, 150, 118];
    if (archetype === 'HEAVY_ENFORCER') return [36 + flap + n, 40 + flap + n, 45 + flap + n];
    return [96 + flap + n, 88 + flap + n, 58 + flap + n];
  };

  const set: ArchetypeRetroMaterialSet = {
    headMat: makePs1Material(`${archetype}_head`, createRetroPixelTexture(device, `${archetype}_head`, S, headPainter)),
    headBloodyMat: makePs1Material(`${archetype}_head_gore`, createRetroPixelTexture(device, `${archetype}_head_gore`, S, headPainter, 11)),
    jawMat: makePs1Material(`${archetype}_jaw`, createRetroPixelTexture(device, `${archetype}_jaw`, 32, jawPainter)),
    jawBloodyMat: makePs1Material(`${archetype}_jaw_gore`, createRetroPixelTexture(device, `${archetype}_jaw_gore`, 32, jawPainter, 17)),
    torsoMat: makePs1Material(`${archetype}_torso`, createRetroPixelTexture(device, `${archetype}_torso`, S, torsoPainter)),
    torsoBloodyMat: makePs1Material(`${archetype}_torso_gore`, createRetroPixelTexture(device, `${archetype}_torso_gore`, S, torsoPainter, 23)),
    abdomenMat: makePs1Material(`${archetype}_abd`, createRetroPixelTexture(device, `${archetype}_abd`, S, torsoPainter)),
    abdomenBloodyMat: makePs1Material(`${archetype}_abd_gore`, createRetroPixelTexture(device, `${archetype}_abd_gore`, S, torsoPainter, 31)),
    pelvisMat: makePs1Material(`${archetype}_pelvis`, createRetroPixelTexture(device, `${archetype}_pelvis`, S, beltPelvisPainter)),
    pelvisBloodyMat: makePs1Material(`${archetype}_pelvis_gore`, createRetroPixelTexture(device, `${archetype}_pelvis_gore`, S, beltPelvisPainter, 41)),
    upperArmMat: makePs1Material(`${archetype}_uarm`, createRetroPixelTexture(device, `${archetype}_uarm`, S, armPainter(false))),
    upperArmBloodyMat: makePs1Material(`${archetype}_uarm_gore`, createRetroPixelTexture(device, `${archetype}_uarm_gore`, S, armPainter(false), 53)),
    forearmMat: makePs1Material(`${archetype}_farm`, createRetroPixelTexture(device, `${archetype}_farm`, S, armPainter(true))),
    forearmBloodyMat: makePs1Material(`${archetype}_farm_gore`, createRetroPixelTexture(device, `${archetype}_farm_gore`, S, armPainter(true), 59)),
    handMat: makePs1Material(`${archetype}_hand`, createRetroPixelTexture(device, `${archetype}_hand`, 32, handGlovePainter)),
    legsMat: makePs1Material(`${archetype}_legs`, createRetroPixelTexture(device, `${archetype}_legs`, S, legsPainter)),
    legsBloodyMat: makePs1Material(`${archetype}_legs_gore`, createRetroPixelTexture(device, `${archetype}_legs_gore`, S, legsPainter, 67)),
    kneePadMat: makePs1Material(`${archetype}_kneepad`, kneePadTex, 0.3),
    bootMat: makePs1Material(`${archetype}_boot`, bootTex, 0.28),
    headgearMat: makePs1Material(`${archetype}_headgear`, createRetroPixelTexture(device, `${archetype}_headgear`, 32, headgearPainter)),
    visorMat: makePs1Material(`${archetype}_visor`, createRetroPixelTexture(device, `${archetype}_visor`, 32, visorPainter), 0.7),
    pouchWebbingMat: makePs1Material(`${archetype}_pouch`, createRetroPixelTexture(device, `${archetype}_pouch`, 32, pouchPainter)),
    weaponMetalMat: makePs1Material(`${archetype}_wmetal`, weaponMetalTex, 0.45),
    weaponFurnitureMat: makePs1Material(`${archetype}_wfurn`, weaponWoodOrPolyTex, 0.25),
  };

  cachedArchetypeSets.set(archetype, set);
  return set;
}

/**
 * Applies crisp PS1/PS2 nearest-neighbor pixel-art concrete tile & hazard textures to the tactical depot environment.
 */
export function applyRetroEnvironmentTextures(
  device: pc.GraphicsDevice,
  floorMat: pc.StandardMaterial,
  concreteMat: pc.StandardMaterial
): void {
  const floorTex = createRetroPixelTexture(device, 'ps1_depot_floor', 64, (x, y, _u, _v) => {
    const n = (hash2d(x, y, 901) - 0.5) * 14;
    const seam = x === 0 || y === 0 || x === 32 || y === 32;
    const bevel = x === 1 || y === 1 || x === 33 || y === 33;
    if (seam) return [18, 22, 26];
    if (bevel) return [46, 52, 60];
    const stain = hash2d(x >> 3, y >> 3, 907) > 0.78 ? -8 : 0;
    return [34 + n + stain, 39 + n + stain, 46 + n + stain];
  });

  floorMat.diffuse = new pc.Color(1, 1, 1);
  floorMat.diffuseMap = floorTex;
  floorMat.diffuseMapTiling = new pc.Vec2(20, 80);
  floorMat.update();

  const wallTex = createRetroPixelTexture(device, 'ps1_concrete_barrier', 64, (x, y, _u, v) => {
    const n = (hash2d(x, y, 919) - 0.5) * 18;
    // Classic 1999 industrial yellow-black hazard stripe along base!
    if (v < 0.18) {
      const diag = ((x + y) >> 3) & 1;
      return diag === 0 ? [196 + n * 0.4, 152 + n * 0.4, 28] : [26, 28, 30];
    }
    const formLine = y % 16 === 0 ? -16 : 0;
    return [84 + n + formLine, 88 + n + formLine, 92 + n + formLine];
  });

  concreteMat.diffuse = new pc.Color(1, 1, 1);
  concreteMat.diffuseMap = wallTex;
  concreteMat.diffuseMapTiling = new pc.Vec2(3, 1);
  concreteMat.update();
}
