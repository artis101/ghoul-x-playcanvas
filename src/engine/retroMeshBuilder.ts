import * as pc from 'playcanvas';
import { EnemyArchetypeId, WeaponSpec } from '../contracts/ballistics.ts';
import { ArchetypeRetroMaterialSet } from './retroTextures.ts';
import { EngineMaterialPalette } from './materials.ts';

export interface LoftRing {
  y: number;
  rx: number;
  rz: number;
  cx?: number;
  cz?: number;
  v?: number;
}

class FacetedMeshBuilder {
  public positions: number[] = [];
  public normals: number[] = [];
  public uvs: number[] = [];
  public indices: number[] = [];

  public addTriangle(
    p0: [number, number, number],
    p1: [number, number, number],
    p2: [number, number, number],
    uv0: [number, number],
    uv1: [number, number],
    uv2: [number, number]
  ): void {
    const ux = p1[0] - p0[0];
    const uy = p1[1] - p0[1];
    const uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0];
    const vy = p2[1] - p0[1];
    const vz = p2[2] - p0[2];

    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-8) return;
    nx /= len;
    ny /= len;
    nz /= len;

    const base = this.positions.length / 3;
    this.positions.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
    this.normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.uvs.push(uv0[0], uv0[1], uv1[0], uv1[1], uv2[0], uv2[1]);
    this.indices.push(base, base + 1, base + 2);
  }

  public addQuad(
    p00: [number, number, number],
    p10: [number, number, number],
    p11: [number, number, number],
    p01: [number, number, number],
    uv00: [number, number],
    uv10: [number, number],
    uv11: [number, number],
    uv01: [number, number]
  ): void {
    this.addTriangle(p00, p10, p11, uv00, uv10, uv11);
    this.addTriangle(p00, p11, p01, uv00, uv11, uv01);
  }

  /**
   * Builds a faceted PS1-style lofted prism from cross-section rings around the Y axis.
   * Angle theta = 0 maps to +Z (front) with u = 0.5!
   */
  public addLoft(
    rings: LoftRing[],
    sides: number,
    capBottom = true,
    capTop = true,
    ringModifier?: (ringIdx: number, sideIdx: number, theta: number, pt: [number, number, number]) => void
  ): void {
    if (rings.length < 2 || sides < 3) return;

    const minY = rings[0].y;
    const maxY = rings[rings.length - 1].y;
    const spanY = Math.max(1e-4, maxY - minY);

    const ringPts: Array<Array<[number, number, number]>> = [];
    const ringVs: number[] = [];

    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
      const v = ring.v !== undefined ? ring.v : (ring.y - minY) / spanY;
      ringVs.push(v);

      const pts: Array<[number, number, number]> = [];
      for (let s = 0; s <= sides; s++) {
        const frac = s / sides;
        const theta = (frac - 0.5) * Math.PI * 2; // s = sides/2 -> theta = 0 (+Z front, u = 0.5)
        const pt: [number, number, number] = [
          Math.sin(theta) * ring.rx + (ring.cx || 0),
          ring.y,
          Math.cos(theta) * ring.rz + (ring.cz || 0),
        ];
        if (ringModifier) {
          ringModifier(r, s % sides, theta, pt);
        }
        pts.push(pt);
      }
      // Ensure seam closure matches exact vertex 0
      pts[sides] = [pts[0][0], pts[0][1], pts[0][2]];
      ringPts.push(pts);
    }

    for (let r = 0; r < rings.length - 1; r++) {
      const v0 = ringVs[r];
      const v1 = ringVs[r + 1];
      for (let s = 0; s < sides; s++) {
        const u0 = s / sides;
        const u1 = (s + 1) / sides;
        this.addQuad(
          ringPts[r][s],
          ringPts[r][s + 1],
          ringPts[r + 1][s + 1],
          ringPts[r + 1][s],
          [u0, v0],
          [u1, v0],
          [u1, v1],
          [u0, v1]
        );
      }
    }

    if (capBottom) {
      const bRing = rings[0];
      const center: [number, number, number] = [bRing.cx || 0, bRing.y, bRing.cz || 0];
      for (let s = 0; s < sides; s++) {
        this.addTriangle(
          center,
          ringPts[0][s + 1],
          ringPts[0][s],
          [0.5, 0.1],
          [(s + 1) / sides, 0.0],
          [s / sides, 0.0]
        );
      }
    }

    if (capTop) {
      const tIdx = rings.length - 1;
      const tRing = rings[tIdx];
      const center: [number, number, number] = [tRing.cx || 0, tRing.y, tRing.cz || 0];
      for (let s = 0; s < sides; s++) {
        this.addTriangle(
          center,
          ringPts[tIdx][s],
          ringPts[tIdx][s + 1],
          [0.5, 0.9],
          [s / sides, 1.0],
          [(s + 1) / sides, 1.0]
        );
      }
    }
  }

  /**
   * Adds an angular faceted box centered at (cx, cy, cz) with dimensions (wx, wy, wz).
   */
  public addBox(
    cx: number,
    cy: number,
    cz: number,
    wx: number,
    wy: number,
    wz: number,
    topScaleX = 1.0,
    topScaleZ = 1.0
  ): void {
    const hx0 = wx * 0.5;
    const hz0 = wz * 0.5;
    const hx1 = hx0 * topScaleX;
    const hz1 = hz0 * topScaleZ;
    const y0 = cy - wy * 0.5;
    const y1 = cy + wy * 0.5;

    const p000: [number, number, number] = [cx - hx0, y0, cz - hz0];
    const p100: [number, number, number] = [cx + hx0, y0, cz - hz0];
    const p101: [number, number, number] = [cx + hx0, y0, cz + hz0];
    const p001: [number, number, number] = [cx - hx0, y0, cz + hz0];

    const p010: [number, number, number] = [cx - hx1, y1, cz - hz1];
    const p110: [number, number, number] = [cx + hx1, y1, cz - hz1];
    const p111: [number, number, number] = [cx + hx1, y1, cz + hz1];
    const p011: [number, number, number] = [cx - hx1, y1, cz + hz1];

    // Front (+Z)
    this.addQuad(p001, p101, p111, p011, [0.25, 0], [0.75, 0], [0.75, 1], [0.25, 1]);
    // Back (-Z)
    this.addQuad(p100, p000, p010, p110, [0.25, 0], [0.75, 0], [0.75, 1], [0.25, 1]);
    // Right (+X)
    this.addQuad(p101, p100, p110, p111, [0, 0], [1, 0], [1, 1], [0, 1]);
    // Left (-X)
    this.addQuad(p000, p001, p011, p010, [0, 0], [1, 0], [1, 1], [0, 1]);
    // Top (+Y)
    this.addQuad(p011, p111, p110, p010, [0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]);
    // Bottom (-Y)
    this.addQuad(p000, p100, p101, p001, [0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]);
  }

  public build(device: pc.GraphicsDevice): pc.Mesh {
    const mesh = new pc.Mesh(device);
    mesh.setPositions(this.positions);
    mesh.setNormals(this.normals);
    mesh.setUvs(0, this.uvs);
    mesh.setIndices(this.indices);
    mesh.update();
    // Retain permanent refCount >= 1 so PlayCanvas MeshInstance.destroy() never frees
    // shared GPU vertex/index buffers when waves or dropped weapon props are cleared!
    mesh.incRefCount();
    return mesh;
  }
}

export interface RetroMeshLibrary {
  headCranium: pc.Mesh;
  headJaw: pc.Mesh;
  neckCollar: pc.Mesh;
  thoraxHeroic: pc.Mesh;
  abdomenIntact: pc.Mesh;
  abdomenEvisceratedOuter: pc.Mesh;
  pelvisBelt: pc.Mesh;
  shoulderCap: pc.Mesh;
  upperArmMuscle: pc.Mesh;
  forearmTapered: pc.Mesh;
  handMittenLeft: pc.Mesh;
  handMittenRight: pc.Mesh;
  thighCargo: pc.Mesh;
  kneeCapPad: pc.Mesh;
  shinBloused: pc.Mesh;
  combatBoot: pc.Mesh;
  pasgtHelmet: pc.Mesh;
  spetsnazBeret: pc.Mesh;
  knitWatchCap: pc.Mesh;
  mohawkSpikes: pc.Mesh;
  wraparoundShades: pc.Mesh;
  ammoPouch: pc.Mesh;
}

let cachedMeshLib: RetroMeshLibrary | null = null;

/**
 * Builds and caches all sculpted low-poly PS1/PS2 anatomical character & tactical gear meshes.
 */
export function getOrCreateRetroMeshes(device: pc.GraphicsDevice): RetroMeshLibrary {
  if (cachedMeshLib) return cachedMeshLib;

  // 1. Head Cranium (8-sided sculpted skull with brow ridge, cheekbones, and angular nose wedge!)
  const headB = new FacetedMeshBuilder();
  headB.addLoft(
    [
      { y: -0.02, rx: 0.072, rz: 0.082, cz: -0.005, v: 0.22 },
      { y: 0.02, rx: 0.088, rz: 0.098, cz: 0.004, v: 0.42 }, // Cheekbones
      { y: 0.065, rx: 0.092, rz: 0.106, cz: 0.008, v: 0.60 }, // Pronounced PS1 Brow Ridge
      { y: 0.115, rx: 0.086, rz: 0.098, cz: -0.004, v: 0.80 }, // Forehead / Temple
      { y: 0.152, rx: 0.058, rz: 0.068, cz: -0.008, v: 0.98 }, // Crown
    ],
    8
  );
  // Angular PS1 nose bridge prism on +Z front!
  headB.addBox(0, 0.032, 0.108, 0.026, 0.048, 0.032, 0.65, 0.55);
  // Low-poly ears on ±X
  headB.addBox(-0.092, 0.042, -0.005, 0.018, 0.042, 0.028);
  headB.addBox(0.092, 0.042, -0.005, 0.018, 0.042, 0.028);

  // 2. Articulated Jaw / Chin
  const jawB = new FacetedMeshBuilder();
  jawB.addLoft(
    [
      { y: -0.042, rx: 0.046, rz: 0.048, cz: 0.012, v: 0.1 }, // Square chin
      { y: -0.005, rx: 0.068, rz: 0.062, cz: 0.0, v: 0.55 }, // Mandible angle
      { y: 0.032, rx: 0.074, rz: 0.064, cz: -0.006, v: 0.92 }, // Upper lip / maxilla seam
    ],
    8
  );

  // 3. Neck & Jacket Collar
  const neckB = new FacetedMeshBuilder();
  neckB.addLoft(
    [
      { y: -0.05, rx: 0.078, rz: 0.076, v: 0.0 }, // Collar base
      { y: 0.01, rx: 0.062, rz: 0.062, v: 0.45 },
      { y: 0.09, rx: 0.056, rz: 0.058, v: 1.0 },
    ],
    6
  );

  // 4. Heroic V-Tapered PS1 Thorax (joint at y=0 corresponds to y=1.30m, neck at y=+0.25m)
  const thoraxB = new FacetedMeshBuilder();
  thoraxB.addLoft(
    [
      { y: -0.03, rx: 0.152, rz: 0.112, cz: 0.004, v: 0.05 }, // Lower ribcage seam
      { y: 0.06, rx: 0.178, rz: 0.132, cz: 0.012, v: 0.38 }, // Pectoral plate & lats
      { y: 0.16, rx: 0.205, rz: 0.138, cz: 0.008, v: 0.75 }, // Broad PS1 upper chest
      { y: 0.235, rx: 0.165, rz: 0.105, cz: -0.004, v: 0.98 }, // Clavicle / trapezius shelf
    ],
    8
  );

  // 5. Intact Lower Abdomen (joint at y=0 corresponds to y=1.10m, thorax at y=+0.20m)
  const abdB = new FacetedMeshBuilder();
  abdB.addLoft(
    [
      { y: -0.03, rx: 0.154, rz: 0.112, v: 0.05 },
      { y: 0.09, rx: 0.146, rz: 0.108, cz: 0.005, v: 0.5 }, // Athletic waist taper
      { y: 0.20, rx: 0.156, rz: 0.115, cz: 0.005, v: 0.95 },
    ],
    8
  );

  // 6. Eviscerated Gut Outer Shell (hollowed front cavity for Soldier of Fortune stomach shotgun wound!)
  const abdGoreB = new FacetedMeshBuilder();
  abdGoreB.addLoft(
    [
      { y: -0.03, rx: 0.156, rz: 0.114, v: 0.05 },
      { y: 0.09, rx: 0.152, rz: 0.112, v: 0.5 },
      { y: 0.20, rx: 0.158, rz: 0.116, v: 0.95 },
    ],
    8,
    true,
    true,
    (r, _s, theta, pt) => {
      // Push front (+Z) middle vertices inward to carve a jagged visceral gut crater!
      if (r === 1 && Math.abs(theta) < 0.9) {
        pt[2] = -0.015;
      }
    }
  );

  // 7. Pelvis & Tactical Utility Belt (joint at y=0 corresponds to y=0.95m, abdomen at y=+0.15m)
  const pelB = new FacetedMeshBuilder();
  pelB.addLoft(
    [
      { y: -0.10, rx: 0.135, rz: 0.102, v: 0.05 }, // Groin / hip base
      { y: -0.02, rx: 0.165, rz: 0.118, v: 0.45 }, // Hip / glutes
      { y: 0.09, rx: 0.162, rz: 0.116, v: 0.74 }, // Waistline
      { y: 0.155, rx: 0.166, rz: 0.120, v: 0.98 }, // Tactical Web Belt Rim
    ],
    8
  );

  // 8. Sculpted Deltoid Shoulder Cap
  const shB = new FacetedMeshBuilder();
  shB.addLoft(
    [
      { y: -0.09, rx: 0.062, rz: 0.062, v: 0.1 },
      { y: -0.02, rx: 0.082, rz: 0.080, v: 0.55 },
      { y: 0.05, rx: 0.058, rz: 0.058, v: 0.95 },
    ],
    7
  );

  // 9. Muscular Upper Arm (hangs along -Y from 0 to -0.26m)
  const uarmB = new FacetedMeshBuilder();
  uarmB.addLoft(
    [
      { y: -0.26, rx: 0.048, rz: 0.048, v: 0.05 }, // Elbow end
      { y: -0.14, rx: 0.064, rz: 0.068, cz: 0.005, v: 0.52 }, // Bicep / Tricep peak
      { y: 0.02, rx: 0.058, rz: 0.058, v: 0.96 }, // Deltoid insertion
    ],
    6
  );

  // 10. Tapered Forearm (hangs along -Y from 0 to -0.25m)
  const farmB = new FacetedMeshBuilder();
  farmB.addLoft(
    [
      { y: -0.25, rx: 0.036, rz: 0.042, v: 0.05 }, // Wrist
      { y: -0.08, rx: 0.052, rz: 0.054, v: 0.68 }, // Forearm extensor belly
      { y: 0.02, rx: 0.048, rz: 0.048, v: 0.96 }, // Elbow socket
    ],
    6
  );

  // 11. PS1 Blocky Tactical Mitten Hands (Left & Right with distinct thumb wedges!)
  const makeHand = (isRight: boolean) => {
    const hb = new FacetedMeshBuilder();
    const dir = isRight ? -1 : 1;
    // Palm + curled fingers block along -Y (wrist at y=0, knuckles at y=-0.09)
    hb.addLoft(
      [
        { y: -0.095, rx: 0.024, rz: 0.038, cz: 0.008, v: 0.08 }, // Curled fingertips
        { y: -0.045, rx: 0.028, rz: 0.046, cz: 0.004, v: 0.50 }, // Knuckles / palm
        { y: 0.015, rx: 0.034, rz: 0.038, v: 0.95 }, // Wrist cuff
      ],
      6
    );
    // Thumb wedge
    hb.addBox(dir * 0.028, -0.038, 0.036, 0.024, 0.048, 0.026, 0.8, 0.8);
    return hb.build(device);
  };

  // 12. Baggy Creased BDU Cargo Thigh (hangs along -Y from +0.03 to -0.36m)
  const thighB = new FacetedMeshBuilder();
  thighB.addLoft(
    [
      { y: -0.36, rx: 0.068, rz: 0.072, v: 0.04 }, // Above knee
      { y: -0.20, rx: 0.092, rz: 0.096, cz: 0.004, v: 0.48 }, // Baggy cargo trouser mid-thigh
      { y: -0.06, rx: 0.096, rz: 0.100, v: 0.82 }, // Upper quad / glute tie-in
      { y: 0.03, rx: 0.084, rz: 0.088, v: 0.98 }, // Hip socket cap
    ],
    7
  );

  // 13. Articulated Knee + Hard-Shell Tactical Knee-Pad on +Z!
  const kneeB = new FacetedMeshBuilder();
  kneeB.addLoft(
    [
      { y: -0.08, rx: 0.060, rz: 0.064, v: 0.1 },
      { y: 0.0, rx: 0.066, rz: 0.070, v: 0.5 },
      { y: 0.06, rx: 0.064, rz: 0.068, v: 0.9 },
    ],
    6
  );
  // Front armored knee-pad shell
  kneeB.addBox(0, -0.01, 0.058, 0.095, 0.105, 0.034, 0.85, 0.8);

  // 14. Bloused Shin / Calf BDU Trouser (hangs along -Y from +0.02 to -0.22m)
  const shinB = new FacetedMeshBuilder();
  shinB.addLoft(
    [
      { y: -0.22, rx: 0.048, rz: 0.050, v: 0.05 }, // Tucked into boot cuff
      { y: -0.15, rx: 0.068, rz: 0.070, v: 0.35 }, // Bloused trouser overhang
      { y: -0.07, rx: 0.066, rz: 0.072, cz: -0.006, v: 0.70 }, // Gastrocnemius calf muscle
      { y: 0.02, rx: 0.060, rz: 0.062, v: 0.96 },
    ],
    6
  );

  // 15. Chunky Sculpted PS1 Combat Boot (+Z points from heel toward steel toe, sole at y = -0.065!)
  const bootB = new FacetedMeshBuilder();
  // Ankle shaft
  bootB.addLoft(
    [
      { y: -0.025, rx: 0.050, rz: 0.056, cz: 0.005, v: 0.35 },
      { y: 0.055, rx: 0.052, rz: 0.054, cz: -0.004, v: 0.95 },
    ],
    6
  );
  // Chunky lug-soled foot & steel toe box extending forward along +Z!
  bootB.addLoft(
    [
      { y: -0.065, rx: 0.056, rz: 0.125, cz: 0.052, v: 0.02 }, // Heavy rubber lug sole
      { y: -0.042, rx: 0.055, rz: 0.124, cz: 0.052, v: 0.22 }, // Sole welt
      { y: -0.012, rx: 0.049, rz: 0.112, cz: 0.046, v: 0.62 }, // Laced instep & rounded steel toe
      { y: 0.008, rx: 0.042, rz: 0.072, cz: 0.018, v: 0.85 }, // Upper tongue
    ],
    8
  );

  // 16. Detachable Headgear Meshes!
  // A) PASGT Kevlar Ballistic Helmet (with flared ear guards & brow brim)
  const helmB = new FacetedMeshBuilder();
  helmB.addLoft(
    [
      { y: 0.02, rx: 0.114, rz: 0.122, cz: 0.004, v: 0.08 }, // Ear & nape flare
      { y: 0.075, rx: 0.112, rz: 0.124, cz: 0.010, v: 0.42 }, // Brim
      { y: 0.135, rx: 0.098, rz: 0.108, cz: -0.002, v: 0.78 },
      { y: 0.172, rx: 0.055, rz: 0.065, cz: -0.005, v: 0.98 },
    ],
    8,
    false,
    true
  );

  // B) Slanted Crimson Spetsnaz Beret
  const beretB = new FacetedMeshBuilder();
  beretB.addLoft(
    [
      { y: 0.085, rx: 0.096, rz: 0.104, v: 0.05 }, // Leather headband
      { y: 0.118, rx: 0.116, rz: 0.116, cx: 0.024, cz: -0.006, v: 0.55 }, // Classic military beret drape to right side
      { y: 0.148, rx: 0.078, rz: 0.084, cx: 0.018, cz: -0.008, v: 0.96 },
    ],
    8,
    false,
    true
  );

  // C) Rolled Knit Watch Cap (Militia Gunner)
  const capB = new FacetedMeshBuilder();
  capB.addLoft(
    [
      { y: 0.072, rx: 0.098, rz: 0.108, v: 0.05 }, // Rolled cuff
      { y: 0.105, rx: 0.096, rz: 0.104, v: 0.42 },
      { y: 0.158, rx: 0.062, rz: 0.070, cz: -0.006, v: 0.98 },
    ],
    8,
    false,
    true
  );

  // D) Punk Mohawk Spikes (NYC Subway Skinhead Punk)
  const mohawkB = new FacetedMeshBuilder();
  for (let i = 0; i < 4; i++) {
    const zOff = 0.06 - i * 0.045;
    const yOff = 0.155 - Math.abs(i - 1.2) * 0.012;
    mohawkB.addBox(0, yOff + 0.035, zOff, 0.026, 0.085, 0.038, 0.25, 0.35);
  }

  // E) Wraparound Street Shades / Tactical Goggles
  const shadesB = new FacetedMeshBuilder();
  shadesB.addBox(0, 0.055, 0.102, 0.148, 0.034, 0.026, 0.95, 0.9);
  shadesB.addBox(-0.082, 0.055, 0.055, 0.014, 0.022, 0.095);
  shadesB.addBox(0.082, 0.055, 0.055, 0.014, 0.022, 0.095);

  // F) Tactical Mag Pouch / Cargo Pocket
  const pouchB = new FacetedMeshBuilder();
  pouchB.addBox(0, 0, 0, 0.068, 0.105, 0.045, 0.92, 0.88);

  cachedMeshLib = {
    headCranium: headB.build(device),
    headJaw: jawB.build(device),
    neckCollar: neckB.build(device),
    thoraxHeroic: thoraxB.build(device),
    abdomenIntact: abdB.build(device),
    abdomenEvisceratedOuter: abdGoreB.build(device),
    pelvisBelt: pelB.build(device),
    shoulderCap: shB.build(device),
    upperArmMuscle: uarmB.build(device),
    forearmTapered: farmB.build(device),
    handMittenLeft: makeHand(false),
    handMittenRight: makeHand(true),
    thighCargo: thighB.build(device),
    kneeCapPad: kneeB.build(device),
    shinBloused: shinB.build(device),
    combatBoot: bootB.build(device),
    pasgtHelmet: helmB.build(device),
    spetsnazBeret: beretB.build(device),
    knitWatchCap: capB.build(device),
    mohawkSpikes: mohawkB.build(device),
    wraparoundShades: shadesB.build(device),
    ammoPouch: pouchB.build(device),
  };

  return cachedMeshLib;
}

/**
 * Helper to attach a custom pc.Mesh onto an Entity with shadow casting.
 */
export function attachCustomMesh(
  entity: pc.Entity,
  mesh: pc.Mesh,
  material: pc.StandardMaterial,
  castShadows = true
): pc.MeshInstance {
  const mi = new pc.MeshInstance(mesh, material);
  entity.addComponent('render', {
    meshInstances: [mi],
    castShadows,
    receiveShadows: true,
  });
  return mi;
}

/**
 * Builds a detachable PS1/PS2 headgear entity for the given enemy archetype.
 */
export function buildArchetypeHeadgearEntity(
  device: pc.GraphicsDevice,
  archetype: EnemyArchetypeId,
  mats: ArchetypeRetroMaterialSet
): pc.Entity {
  const lib = getOrCreateRetroMeshes(device);
  const root = new pc.Entity(`${archetype}_HeadgearRoot`);

  if (archetype === 'HEAVY_ENFORCER') {
    const helm = new pc.Entity('PASGTHelmet');
    attachCustomMesh(helm, lib.pasgtHelmet, mats.headgearMat);
    root.addChild(helm);

    const goggles = new pc.Entity('BallisticGoggles');
    attachCustomMesh(goggles, lib.wraparoundShades, mats.visorMat);
    goggles.setLocalPosition(0, -0.004, 0.005);
    root.addChild(goggles);
  } else if (archetype === 'SNIPER_OPERATIVE') {
    const beret = new pc.Entity('SpetsnazBeret');
    attachCustomMesh(beret, lib.spetsnazBeret, mats.headgearMat);
    root.addChild(beret);
  } else if (archetype === 'SKINHEAD_PUNK') {
    const mohawk = new pc.Entity('PunkMohawk');
    attachCustomMesh(mohawk, lib.mohawkSpikes, mats.headgearMat);
    root.addChild(mohawk);

    const shades = new pc.Entity('StreetShades');
    attachCustomMesh(shades, lib.wraparoundShades, mats.visorMat);
    root.addChild(shades);
  } else {
    const cap = new pc.Entity('KnitWatchCap');
    attachCustomMesh(cap, lib.knitWatchCap, mats.headgearMat);
    root.addChild(cap);
  }

  return root;
}

/**
 * Builds a low-poly PS1/PS2 3D firearm held by the enemy (or spawned as a dropped weapon physics prop!).
 * Local firearm forward barrel points along +Z.
 */
export function buildEnemyWeaponEntity(
  _device: pc.GraphicsDevice,
  archetype: EnemyArchetypeId,
  mats: ArchetypeRetroMaterialSet
): pc.Entity {
  const gun = new pc.Entity(`${archetype}_Weapon`);

  const addPart = (
    name: string,
    mat: pc.StandardMaterial,
    sx: number,
    sy: number,
    sz: number,
    px: number,
    py: number,
    pz: number,
    rx = 0
  ) => {
    const e = new pc.Entity(name);
    e.addComponent('render', {
      type: 'box',
      material: mat,
      castShadows: true,
    });
    e.setLocalScale(sx, sy, sz);
    e.setLocalPosition(px, py, pz);
    if (rx !== 0) e.setLocalEulerAngles(rx, 0, 0);
    gun.addChild(e);
  };

  if (archetype === 'SKINHEAD_PUNK') {
    // MP5 Submachine Gun
    addPart('Receiver', mats.weaponMetalMat, 0.044, 0.068, 0.28, 0, 0.02, 0.06);
    addPart('BarrelSuppressor', mats.weaponMetalMat, 0.032, 0.032, 0.20, 0, 0.028, 0.26);
    addPart('PistolGrip', mats.weaponFurnitureMat, 0.034, 0.095, 0.045, 0, -0.04, -0.02, -16);
    addPart('CurvedMag', mats.weaponMetalMat, 0.026, 0.14, 0.038, 0, -0.065, 0.11, 18);
    addPart('Forend', mats.weaponFurnitureMat, 0.048, 0.048, 0.13, 0, 0.015, 0.17);
  } else if (archetype === 'MILITIA_GUNNER') {
    // Classic AK-47 Assault Rifle!
    addPart('Receiver', mats.weaponMetalMat, 0.045, 0.065, 0.27, 0, 0.02, 0.05);
    addPart('WoodStock', mats.weaponFurnitureMat, 0.040, 0.082, 0.22, 0, -0.008, -0.17, 8);
    addPart('WoodHandguard', mats.weaponFurnitureMat, 0.048, 0.055, 0.17, 0, 0.022, 0.25);
    addPart('Barrel', mats.weaponMetalMat, 0.022, 0.022, 0.26, 0, 0.032, 0.42);
    addPart('FrontSight', mats.weaponMetalMat, 0.016, 0.048, 0.025, 0, 0.052, 0.50);
    addPart('BananaMag', mats.weaponMetalMat, 0.030, 0.165, 0.052, 0, -0.075, 0.12, 24);
    addPart('Grip', mats.weaponFurnitureMat, 0.032, 0.09, 0.042, 0, -0.042, -0.02, -18);
  } else if (archetype === 'HEAVY_ENFORCER') {
    // Heavy Combat 12-Gauge Shotgun
    addPart('Receiver', mats.weaponMetalMat, 0.052, 0.072, 0.28, 0, 0.025, 0.05);
    addPart('Stock', mats.weaponFurnitureMat, 0.044, 0.085, 0.23, 0, -0.005, -0.18, 7);
    addPart('Barrel', mats.weaponMetalMat, 0.028, 0.028, 0.42, 0, 0.042, 0.36);
    addPart('MagTube', mats.weaponMetalMat, 0.026, 0.026, 0.36, 0, 0.014, 0.33);
    addPart('PumpForend', mats.weaponFurnitureMat, 0.056, 0.052, 0.18, 0, 0.012, 0.28);
  } else {
    // SVD Dragunov Marksman Rifle with PSO-1 Scope!
    addPart('Receiver', mats.weaponMetalMat, 0.044, 0.064, 0.30, 0, 0.022, 0.05);
    addPart('ThumbholeStock', mats.weaponFurnitureMat, 0.040, 0.092, 0.26, 0, -0.008, -0.20, 5);
    addPart('Handguard', mats.weaponFurnitureMat, 0.044, 0.050, 0.24, 0, 0.024, 0.29);
    addPart('LongBarrel', mats.weaponMetalMat, 0.020, 0.020, 0.38, 0, 0.032, 0.54);
    addPart('PSOScope', mats.weaponMetalMat, 0.034, 0.034, 0.22, 0, 0.078, 0.05);
    addPart('BoxMag', mats.weaponMetalMat, 0.028, 0.095, 0.068, 0, -0.04, 0.11);
  }

  return gun;
}

/**
 * Rebuilds the player's first-person PS1/PS2 weapon viewmodel to match the active weapon!
 */
export function populatePlayerWeaponViewmodel(
  viewmodelRoot: pc.Entity,
  weapon: WeaponSpec,
  palette: EngineMaterialPalette
): pc.Entity {
  for (const c of [...viewmodelRoot.children]) {
    c.destroy();
  }

  const addBox = (
    name: string,
    mat: pc.StandardMaterial,
    sx: number,
    sy: number,
    sz: number,
    px: number,
    py: number,
    pz: number
  ) => {
    const e = new pc.Entity(name);
    e.addComponent('render', { type: 'box', material: mat });
    e.setLocalScale(sx, sy, sz);
    e.setLocalPosition(px, py, pz);
    viewmodelRoot.addChild(e);
    return e;
  };

  let muzzleZ = -0.52;

  if (weapon.role === 'SHOTGUN') {
    // Mossberg 590 Tactical Pump-Action 12-Gauge
    addBox('Receiver', palette.tacticalArmorVest, 0.068, 0.082, 0.32, 0, 0, -0.06);
    addBox('Barrel', palette.bootsDark, 0.032, 0.032, 0.46, 0, 0.026, -0.36);
    addBox('MagTube', palette.tacticalArmorVest, 0.030, 0.030, 0.40, 0, -0.008, -0.34);
    addBox('PumpForend', palette.sandbagMat, 0.074, 0.062, 0.20, 0, -0.012, -0.30);
    addBox('GhostRingRear', palette.bootsDark, 0.026, 0.022, 0.02, 0, 0.05, 0.04);
    muzzleZ = -0.62;
  } else if (weapon.role === 'HEAVY_PISTOL') {
    // Silver Talon (.50 AE Brushed Chrome Desert Eagle!)
    addBox('ChromeSlide', palette.exposedBoneMat, 0.056, 0.072, 0.28, 0, 0.02, -0.08);
    addBox('TriBarrel', palette.exposedBoneMat, 0.048, 0.055, 0.16, 0, 0.024, -0.24);
    addBox('GripFrame', palette.bootsDark, 0.050, 0.12, 0.08, 0, -0.06, 0.01);
    addBox('FrontSight', palette.bootsDark, 0.012, 0.018, 0.02, 0, 0.06, -0.30);
    muzzleZ = -0.36;
  } else if (weapon.role === 'SNIPER') {
    // MSG90A1 7.62mm Precision Rifle
    addBox('Receiver', palette.bootsDark, 0.060, 0.078, 0.36, 0, 0, -0.08);
    addBox('HeavyBarrel', palette.tacticalArmorVest, 0.026, 0.026, 0.52, 0, 0.02, -0.44);
    addBox('Handguard', palette.bootsDark, 0.056, 0.058, 0.28, 0, 0.008, -0.34);
    addBox('OpticScope', palette.tacticalArmorVest, 0.048, 0.048, 0.26, 0, 0.072, -0.08);
    muzzleZ = -0.72;
  } else {
    // M4A1 5.56mm Carbine
    addBox('UpperLower', palette.bootsDark, 0.058, 0.085, 0.30, 0, 0, -0.06);
    addBox('QuadRail', palette.tacticalArmorVest, 0.062, 0.062, 0.22, 0, 0.012, -0.30);
    addBox('Barrel', palette.bootsDark, 0.024, 0.024, 0.26, 0, 0.015, -0.46);
    addBox('CarryHandleSight', palette.bootsDark, 0.028, 0.036, 0.14, 0, 0.058, -0.05);
    muzzleZ = -0.60;
  }

  const muzzleFlash = new pc.Entity('MuzzleFlash');
  muzzleFlash.addComponent('render', {
    type: 'sphere',
    material: palette.rangeDistanceMarkerMat,
  });
  muzzleFlash.setLocalScale(0.14, 0.14, 0.22);
  muzzleFlash.setLocalPosition(0, 0.025, muzzleZ);
  muzzleFlash.enabled = false;
  viewmodelRoot.addChild(muzzleFlash);

  return muzzleFlash;
}
