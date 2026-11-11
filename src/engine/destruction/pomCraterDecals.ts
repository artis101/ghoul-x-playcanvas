import * as pc from 'playcanvas';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { QuatLike } from '../../contracts/destruction.ts';
import { HardwareInstancedPool } from '../physics/instancedPool.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';

export const MAX_SHADER_WORLD_CRATERS = 16;

export interface ProceduralCraterTextures {
  readonly resolution: number;
  readonly heightMap: pc.Texture;
  readonly normalMap: pc.Texture;
  readonly scorchDiffuseMap: pc.Texture;
}

export interface CraterImpactRecord {
  pointWorld: Vec3Like;
  normalWorld: Vec3Like;
  radiusM: number;
  depthM: number;
}

function hash2D(ix: number, iy: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise2D(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);

  const n00 = hash2D(ix, iy);
  const n10 = hash2D(ix + 1, iy);
  const n01 = hash2D(ix, iy + 1);
  const n11 = hash2D(ix + 1, iy + 1);

  const nx0 = n00 + (n10 - n00) * ux;
  const nx1 = n01 + (n11 - n01) * ux;
  return nx0 + (nx1 - nx0) * uy;
}

function fbmNoise2D(x: number, y: number): number {
  const o1 = valueNoise2D(x, y) * 0.55;
  const o2 = valueNoise2D(x * 2.13 + 17.7, y * 2.13 - 9.3) * 0.3;
  const o3 = valueNoise2D(x * 4.41 - 5.2, y * 4.41 + 23.1) * 0.15;
  return o1 + o2 + o3;
}

interface CraterSurfaceSample {
  readonly height: number;
  readonly crackIntensity: number;
  readonly spallRimMask: number;
  readonly bulletSmearMask: number;
  readonly aggregateContrast: number;
  readonly outerEdgeNoise: number;
}

function sampleCraterMorphology(u: number, v: number): CraterSurfaceSample {
  const dx = (u - 0.5) * 2;
  const dy = (v - 0.5) * 2;
  const r = Math.hypot(dx, dy);
  const theta = Math.atan2(dy, dx);

  // Multi-lobed angular concrete shear profile (fractured spall facets instead of smooth circles)
  const angularLobes =
    0.075 * Math.cos(theta * 5 + 0.62) +
    0.052 * Math.sin(theta * 9 - 1.14) +
    0.032 * Math.cos(theta * 14 + 2.35) +
    0.018 * Math.sin(theta * 21 + 0.4);
  const facetNoise = (fbmNoise2D(u * 18, v * 18) - 0.5) * 0.1;
  const coarseAggregate = Math.abs(valueNoise2D(u * 38 + 4.2, v * 38 - 6.8) - 0.5) * 0.11;
  const microGrit = (valueNoise2D(u * 84 + 11.3, v * 84 - 7.1) - 0.5) * 0.048;

  const warpedR = Math.max(0, r + (angularLobes + facetNoise * 0.55) * Math.min(1, r * 1.65));
  const basePlane = 0.82;

  // Primary & secondary branching radial micro-cracks radiating out from the impact bore
  const jitteredTheta =
    theta +
    (valueNoise2D(u * 11.5 + 3.1, v * 11.5 - 2.7) - 0.5) * 0.42 +
    (valueNoise2D(u * 27.0, v * 27.0) - 0.5) * 0.16;
  const primaryWave = Math.abs(Math.sin(jitteredTheta * 5.5 + 0.35));
  const secondaryWave = Math.abs(Math.sin(jitteredTheta * 11.0 - 1.2));

  let crackIntensity = 0;
  if (warpedR > 0.12 && warpedR < 0.89) {
    const radialReach = Math.max(0, 1 - (warpedR - 0.12) / 0.77);
    const c1 = primaryWave < 0.105 ? ((0.105 - primaryWave) / 0.105) * radialReach : 0;
    const c2 =
      secondaryWave < 0.075 && warpedR < 0.74
        ? ((0.075 - secondaryWave) / 0.075) * radialReach * 0.72
        : 0;
    crackIntensity = Math.min(1, Math.max(c1, c2));
  }

  let height = basePlane;
  if (warpedR < 0.18) {
    // Deep central bullet-punch bore with flattened jacket-smear core
    const boreT = warpedR / 0.18;
    height = 0.035 + 0.145 * (boreT * boreT);
  } else if (warpedR < 0.53) {
    // Stepped fractured concrete spall cone with exposed aggregate facets
    const coneT = (warpedR - 0.18) / (0.53 - 0.18);
    const steppedCone = coneT * coneT * (3 - 2 * coneT) * 0.82 + coneT * 0.18;
    const shelfStep = Math.floor(coneT * 3.4) * 0.025;
    height = 0.18 + (0.935 - 0.18) * steppedCone + shelfStep * 0.35;
  } else if (warpedR < 0.93) {
    // Raised pulverized spall lip settling cleanly back to surrounding concrete plane
    const rimT = Math.min(1, (warpedR - 0.53) / (0.93 - 0.53));
    const smoothRim = rimT * rimT * (3 - 2 * rimT);
    height = 0.935 + (basePlane - 0.935) * smoothRim;
  }

  const edgeFade = Math.max(0, 1 - Math.max(0, (r - 0.72) / 0.24));
  const crackCarve = crackIntensity * 0.34;
  const aggregateRelief =
    warpedR > 0.14 && warpedR < 0.62 ? (coarseAggregate - 0.025) * 0.85 : (facetNoise * 0.25);

  const combined = height + (aggregateRelief + microGrit - crackCarve) * edgeFade;
  const clampedHeight = Math.max(0.02, Math.min(0.98, combined));

  const spallRimMask =
    warpedR > 0.38 && warpedR < 0.78
      ? Math.pow(Math.sin(((warpedR - 0.38) / 0.4) * Math.PI), 0.75)
      : 0;
  const bulletSmearMask =
    warpedR < 0.165 ? Math.max(0, 1 - Math.pow(warpedR / 0.165, 1.8)) : 0;

  return {
    height: clampedHeight,
    crackIntensity,
    spallRimMask,
    bulletSmearMask,
    aggregateContrast: coarseAggregate * 9.0,
    outerEdgeNoise: angularLobes * 0.65 + facetNoise * 0.85,
  };
}

function createRgbaTexture(
  device: pc.GraphicsDevice,
  name: string,
  resolution: number,
  pixels: Uint8Array,
): pc.Texture {
  const maxAniso = Math.min(device.maxAnisotropy || 4, 8);
  const tex = new pc.Texture(device, {
    name,
    width: resolution,
    height: resolution,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: pc.FILTER_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    anisotropy: Math.max(1, maxAniso),
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  const locked = tex.lock();
  locked.set(pixels);
  tex.unlock();
  return tex;
}

/**
 * Procedurally synthesizes matched high-definition concrete bullet-crater Height, Normal, and
 * Scorch/Spall/Smear Alpha `pc.Texture` maps for Parallax Occlusion Mapping (POM).
 */
export function createProceduralCraterTextures(
  device: pc.GraphicsDevice,
  resolution = 256,
): ProceduralCraterTextures {
  const size = Math.max(16, Math.floor(resolution));
  const totalTexels = size * size;
  const heightField = new Float32Array(totalTexels);
  const crackField = new Float32Array(totalTexels);
  const spallField = new Float32Array(totalTexels);
  const smearField = new Float32Array(totalTexels);
  const aggField = new Float32Array(totalTexels);
  const edgeNoiseField = new Float32Array(totalTexels);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const idx = y * size + x;
      const sample = sampleCraterMorphology(u, v);
      heightField[idx] = sample.height;
      crackField[idx] = sample.crackIntensity;
      spallField[idx] = sample.spallRimMask;
      smearField[idx] = sample.bulletSmearMask;
      aggField[idx] = sample.aggregateContrast;
      edgeNoiseField[idx] = sample.outerEdgeNoise;
    }
  }

  const heightPixels = new Uint8Array(totalTexels * 4);
  const normalPixels = new Uint8Array(totalTexels * 4);
  const scorchPixels = new Uint8Array(totalTexels * 4);
  const normalStrength = 4.25;

  for (let y = 0; y < size; y++) {
    const ym = Math.max(0, y - 1);
    const yp = Math.min(size - 1, y + 1);
    const v = (y + 0.5) / size;

    for (let x = 0; x < size; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(size - 1, x + 1);
      const u = (x + 0.5) / size;
      const idx = y * size + x;
      const p4 = idx * 4;

      const h = heightField[idx];
      const hByte = Math.max(0, Math.min(255, Math.round(h * 255)));
      heightPixels[p4] = hByte;
      heightPixels[p4 + 1] = hByte;
      heightPixels[p4 + 2] = hByte;
      heightPixels[p4 + 3] = 255;

      // Crisp Sobel-weighted tangent-space normal for sharp aggregate & radial crack relief
      const hTL = heightField[ym * size + xm];
      const hT = heightField[ym * size + x];
      const hTR = heightField[ym * size + xp];
      const hL = heightField[y * size + xm];
      const hR = heightField[y * size + xp];
      const hBL = heightField[yp * size + xm];
      const hB = heightField[yp * size + x];
      const hBR = heightField[yp * size + xp];

      const dhdx = ((hTR + 2 * hR + hBR) - (hTL + 2 * hL + hBL)) * 0.125 * size * 0.042;
      const dhdy = ((hBL + 2 * hB + hBR) - (hTL + 2 * hT + hTR)) * 0.125 * size * 0.042;

      let nx = -dhdx * normalStrength;
      let ny = -dhdy * normalStrength;
      let nz = 1.0;
      const nLen = Math.hypot(nx, ny, nz);
      nx /= nLen;
      ny /= nLen;
      nz /= nLen;

      normalPixels[p4] = Math.max(0, Math.min(255, Math.round((nx * 0.5 + 0.5) * 255)));
      normalPixels[p4 + 1] = Math.max(0, Math.min(255, Math.round((ny * 0.5 + 0.5) * 255)));
      normalPixels[p4 + 2] = Math.max(0, Math.min(255, Math.round((nz * 0.5 + 0.5) * 255)));
      normalPixels[p4 + 3] = 255;

      // Multi-zone AAA concrete impact albedo + AO:
      // 1) Pulverized light-gray cement spall halo around fractured rim
      // 2) Exposed aggregate grit & deep cavity self-shadowing
      // 3) Dark radial hairline micro-cracks
      // 4) Subtle metallic lead/copper bullet smear at impact bore center
      const r = Math.hypot((u - 0.5) * 2, (v - 0.5) * 2);
      const depthFactor = Math.max(0, Math.min(1, (0.82 - h) / 0.78));
      const crackAo = crackField[idx];
      const spallRim = spallField[idx];
      const smear = smearField[idx];
      const aggSpeckle = (aggField[idx] - 0.45) * 34;
      const fineGrain = (hash2D(x * 5 + 11, y * 7 + 19) - 0.5) * 18;

      let lum =
        134 -
        depthFactor * 104 +
        spallRim * 76 -
        crackAo * 78 +
        aggSpeckle * (0.35 + 0.65 * depthFactor) +
        fineGrain;

      let red = lum;
      let green = lum - 2;
      let blue = lum - 5;

      // Metallic lead/copper-jacket smear glint right at the bullet bore center
      if (smear > 0.02) {
        const jacketGlint = hash2D(x * 3 + 29, y * 3 + 41) > 0.68 ? 1.0 : 0.0;
        const leadR = 64 + jacketGlint * 38;
        const leadG = 66 + jacketGlint * 24;
        const leadB = 74 + jacketGlint * 10;
        const blend = smear * 0.78;
        red = red * (1 - blend) + leadR * blend;
        green = green * (1 - blend) + leadG * blend;
        blue = blue * (1 - blend) + leadB * blend;
      }

      // Irregular fractured spall alpha silhouette (zero circular sticker edge)
      const irregularR = r + edgeNoiseField[idx] * 0.16 - crackAo * 0.08;
      let alpha = 1;
      if (irregularR >= 0.94) {
        alpha = 0;
      } else if (irregularR > 0.58) {
        const fadeT = (irregularR - 0.58) / (0.94 - 0.58);
        alpha = 1 - fadeT * fadeT * (3 - 2 * fadeT);
      }

      scorchPixels[p4] = Math.max(14, Math.min(238, Math.round(red)));
      scorchPixels[p4 + 1] = Math.max(14, Math.min(236, Math.round(green)));
      scorchPixels[p4 + 2] = Math.max(14, Math.min(234, Math.round(blue)));
      scorchPixels[p4 + 3] = Math.max(0, Math.min(255, Math.round(alpha * 255)));
    }
  }

  return {
    resolution: size,
    heightMap: createRgbaTexture(device, 'ConcreteCraterHeightPOM', size, heightPixels),
    normalMap: createRgbaTexture(device, 'ConcreteCraterNormalPOM', size, normalPixels),
    scorchDiffuseMap: createRgbaTexture(device, 'ConcreteCraterScorchPOM', size, scorchPixels),
  };
}

/**
 * Overrides `parallaxPS` and `diffusePS` shader chunks on a `pc.StandardMaterial` in **BOTH**
 * `SHADERLANGUAGE_GLSL` (WebGL2) and `SHADERLANGUAGE_WGSL` (WebGPU) for iterative raymarched
 * Parallax Occlusion Mapping (POM) depth displacement & cavity scorch darkening.
 */
export function applyPomCraterShaderChunks(
  material: pc.StandardMaterial,
  textures: ProceduralCraterTextures,
  pomDepthScale = 0.056,
  scorchDarkening = 0.68,
): void {
  material.diffuse = new pc.Color(0.9, 0.89, 0.86);
  material.diffuseMap = textures.scorchDiffuseMap;
  material.opacityMap = textures.scorchDiffuseMap;
  material.opacityMapChannel = 'a';
  material.normalMap = textures.normalMap;
  material.bumpiness = 1.65;
  material.heightMap = textures.heightMap;
  material.heightMapChannel = 'r';
  material.heightMapFactor = pomDepthScale;
  material.parallaxMode = pc.PARALLAX_OCCLUSION;
  material.useMetalness = true;
  material.metalness = 0.08;
  material.gloss = 0.26;
  material.fresnelModel = pc.FRESNEL_SCHLICK;
  material.blendType = pc.BLEND_NORMAL;
  material.depthWrite = false;
  material.depthBias = -1.5;
  material.slopeDepthBias = -1.5;
  material.shaderChunksVersion = '2.8';

  material.setParameter('uPomCraterDepth', pomDepthScale);
  material.setParameter('uPomScorchDarkening', scorchDarkening);

  const glslChunks = material.getShaderChunks(pc.SHADERLANGUAGE_GLSL);
  glslChunks.set(
    'parallaxPS',
    `
uniform float uPomCraterDepth;
void getParallax() {
    vec3 viewDirT = normalize(dViewDirW * dTBN);
    vec2 viewDirUv = vec2(viewDirT.x, -viewDirT.y);
    float safeViewZ = max(viewDirT.z, 0.14);
    vec2 maxDeltaUv = -uPomCraterDepth * viewDirUv / safeViewZ;

    const int POM_STEPS = 14;
    float stepLayer = 1.0 / float(POM_STEPS);
    float currLayerDepth = 0.0;
    vec2 baseUv = {STD_HEIGHT_TEXTURE_UV};
    vec2 currUv = baseUv;
    float currMapDepth = 1.0 - texture2DLod({STD_HEIGHT_TEXTURE_NAME}, currUv, 0.0).r;

    for (int i = 0; i < POM_STEPS; i++) {
        if (currLayerDepth >= currMapDepth) {
            break;
        }
        currUv += maxDeltaUv * stepLayer;
        currLayerDepth += stepLayer;
        currMapDepth = 1.0 - texture2DLod({STD_HEIGHT_TEXTURE_NAME}, currUv, 0.0).r;
    }

    vec2 prevUv = currUv - maxDeltaUv * stepLayer;
    float prevMapDepth = 1.0 - texture2DLod({STD_HEIGHT_TEXTURE_NAME}, prevUv, 0.0).r;
    float afterDiff = currMapDepth - currLayerDepth;
    float beforeDiff = prevMapDepth - (currLayerDepth - stepLayer);
    float denom = afterDiff - beforeDiff;
    float weight = abs(denom) > 0.0001 ? clamp(afterDiff / denom, 0.0, 1.0) : 0.5;
    vec2 hitUv = mix(currUv, prevUv, weight);
    dUvOffset = hitUv - baseUv;
}
`,
  );

  glslChunks.set(
    'diffusePS',
    `
uniform vec3 material_diffuse;
uniform float uPomScorchDarkening;
void getAlbedo() {
    dAlbedo = material_diffuse.rgb;
    #ifdef STD_DIFFUSE_TEXTURE
        vec3 scorchSample = {STD_DIFFUSE_TEXTURE_DECODE}(texture2DBias({STD_DIFFUSE_TEXTURE_NAME}, {STD_DIFFUSE_TEXTURE_UV}, {STD_TEXTURE_BIAS})).rgb;
        dAlbedo *= scorchSample;
    #endif
    #ifdef STD_HEIGHT_MAP
        float hSample = texture2DBias({STD_HEIGHT_TEXTURE_NAME}, {STD_HEIGHT_TEXTURE_UV}, {STD_TEXTURE_BIAS}).r;
        float cavityDepth = clamp((0.82 - hSample) * 1.42, 0.0, 1.0);
        float spallCrown = clamp((hSample - 0.84) * 3.2, 0.0, 0.16);
        dAlbedo = dAlbedo * (1.0 - cavityDepth * uPomScorchDarkening) + vec3(spallCrown);
    #endif
}
`,
  );

  const wgslChunks = material.getShaderChunks(pc.SHADERLANGUAGE_WGSL);
  wgslChunks.set(
    'parallaxPS',
    `
uniform uPomCraterDepth: f32;
fn getParallax() {
    let viewDirT: vec3f = normalize(dViewDirW * dTBN);
    let viewDirUv: vec2f = vec2f(viewDirT.x, -viewDirT.y);
    let safeViewZ: f32 = max(viewDirT.z, 0.14);
    let maxDeltaUv: vec2f = -uniform.uPomCraterDepth * viewDirUv / safeViewZ;

    let stepLayer: f32 = 1.0 / 14.0;
    var currLayerDepth: f32 = 0.0;
    let baseUv: vec2f = {STD_HEIGHT_TEXTURE_UV};
    var currUv: vec2f = baseUv;
    var currMapDepth: f32 = 1.0 - textureSampleLevel({STD_HEIGHT_TEXTURE_NAME}, {STD_HEIGHT_TEXTURE_NAME}Sampler, currUv, 0.0).r;

    for (var i: i32 = 0; i < 14; i = i + 1) {
        if (currLayerDepth >= currMapDepth) {
            break;
        }
        currUv = currUv + maxDeltaUv * stepLayer;
        currLayerDepth = currLayerDepth + stepLayer;
        currMapDepth = 1.0 - textureSampleLevel({STD_HEIGHT_TEXTURE_NAME}, {STD_HEIGHT_TEXTURE_NAME}Sampler, currUv, 0.0).r;
    }

    let prevUv: vec2f = currUv - maxDeltaUv * stepLayer;
    let prevMapDepth: f32 = 1.0 - textureSampleLevel({STD_HEIGHT_TEXTURE_NAME}, {STD_HEIGHT_TEXTURE_NAME}Sampler, prevUv, 0.0).r;
    let afterDiff: f32 = currMapDepth - currLayerDepth;
    let beforeDiff: f32 = prevMapDepth - (currLayerDepth - stepLayer);
    let denom: f32 = afterDiff - beforeDiff;
    let weight: f32 = select(0.5, clamp(afterDiff / denom, 0.0, 1.0), abs(denom) > 0.0001);
    let hitUv: vec2f = mix(currUv, prevUv, weight);
    dUvOffset = hitUv - baseUv;
}
`,
  );

  wgslChunks.set(
    'diffusePS',
    `
uniform material_diffuse: vec3f;
uniform uPomScorchDarkening: f32;
fn getAlbedo() {
    dAlbedo = uniform.material_diffuse.rgb;
    #ifdef STD_DIFFUSE_TEXTURE
        let scorchSample: vec3f = {STD_DIFFUSE_TEXTURE_DECODE}(textureSampleBias({STD_DIFFUSE_TEXTURE_NAME}, {STD_DIFFUSE_TEXTURE_NAME}Sampler, {STD_DIFFUSE_TEXTURE_UV}, {STD_TEXTURE_BIAS})).rgb;
        dAlbedo = dAlbedo * scorchSample;
    #endif
    #ifdef STD_HEIGHT_MAP
        let hSample: f32 = textureSampleBias({STD_HEIGHT_TEXTURE_NAME}, {STD_HEIGHT_TEXTURE_UV}, {STD_TEXTURE_BIAS}).r;
        let cavityDepth: f32 = clamp((0.82 - hSample) * 1.42, 0.0, 1.0);
        let spallCrown: f32 = clamp((hSample - 0.84) * 3.2, 0.0, 0.16);
        dAlbedo = dAlbedo * (1.0 - cavityDepth * uniform.uPomScorchDarkening) + vec3f(spallCrown);
    #endif
}
`,
  );

  material.update();
}

/**
 * Enhances a concrete wall's `pc.StandardMaterial` in **BOTH** `SHADERLANGUAGE_GLSL` and
 * `SHADERLANGUAGE_WGSL` with a world-space multi-crater uniform array (`uCraterSpheres[16]`)
 * so bullet impacts scorch and parallax-darken concrete across Voronoi chunk boundaries.
 */
export function applyConcreteSurfaceCraterChunks(
  material: pc.StandardMaterial,
  initialBuffer?: Float32Array,
): void {
  const craterBuf = initialBuffer ?? new Float32Array(MAX_SHADER_WORLD_CRATERS * 4);
  material.shaderChunksVersion = '2.8';
  material.setParameter('uCraterSpheres[0]', craterBuf);
  material.setParameter('uCraterCount', 0);

  const glsl = material.getShaderChunks(pc.SHADERLANGUAGE_GLSL);
  glsl.set(
    'litUserDeclarationPS',
    `
uniform vec4 uCraterSpheres[${MAX_SHADER_WORLD_CRATERS}];
uniform float uCraterCount;
`,
  );
  glsl.set(
    'diffusePS',
    `
uniform vec3 material_diffuse;
void getAlbedo() {
    dAlbedo = material_diffuse.rgb;
    #ifdef STD_DIFFUSE_TEXTURE
        dAlbedo *= {STD_DIFFUSE_TEXTURE_DECODE}(texture2DBias({STD_DIFFUSE_TEXTURE_NAME}, {STD_DIFFUSE_TEXTURE_UV}, {STD_TEXTURE_BIAS})).rgb;
    #endif
    int activeCraters = int(clamp(uCraterCount, 0.0, ${MAX_SHADER_WORLD_CRATERS}.0));
    for (int i = 0; i < ${MAX_SHADER_WORLD_CRATERS}; i++) {
        if (i >= activeCraters) {
            break;
        }
        vec4 c = uCraterSpheres[i];
        float rad = max(c.w, 0.001);
        // View-ray parallax shift into concrete depth along dViewDirW
        vec3 parallaxPosW = vPositionW - dViewDirW * (rad * 0.24);
        float dist = length(parallaxPosW - c.xyz);
        if (dist < rad) {
            float normR = dist / rad;
            float pitDarken = (1.0 - smoothstep(0.0, 0.58, normR)) * 0.64;
            float spallRing = smoothstep(0.42, 0.66, normR) * (1.0 - smoothstep(0.66, 1.0, normR)) * 0.24;
            float leadSmear = (1.0 - smoothstep(0.0, 0.18, normR)) * 0.09;
            dAlbedo = dAlbedo * (1.0 - pitDarken) + vec3(spallRing) + vec3(leadSmear * 0.85, leadSmear * 0.9, leadSmear * 1.1);
        }
    }
}
`,
  );

  const wgsl = material.getShaderChunks(pc.SHADERLANGUAGE_WGSL);
  wgsl.set(
    'litUserDeclarationPS',
    `
uniform uCraterSpheres: array<vec4f, ${MAX_SHADER_WORLD_CRATERS}>;
uniform uCraterCount: f32;
`,
  );
  wgsl.set(
    'diffusePS',
    `
uniform material_diffuse: vec3f;
fn getAlbedo() {
    dAlbedo = uniform.material_diffuse.rgb;
    #ifdef STD_DIFFUSE_TEXTURE
        dAlbedo = dAlbedo * {STD_DIFFUSE_TEXTURE_DECODE}(textureSampleBias({STD_DIFFUSE_TEXTURE_NAME}, {STD_DIFFUSE_TEXTURE_UV}, {STD_TEXTURE_BIAS})).rgb;
    #endif
    let activeCraters: i32 = i32(clamp(uniform.uCraterCount, 0.0, ${MAX_SHADER_WORLD_CRATERS}.0));
    for (var i: i32 = 0; i < ${MAX_SHADER_WORLD_CRATERS}; i = i + 1) {
        if (i >= activeCraters) {
            break;
        }
        let c: vec4f = uniform.uCraterSpheres[i];
        let rad: f32 = max(c.w, 0.001);
        let parallaxPosW: vec3f = vPositionW - dViewDirW * (rad * 0.24);
        let dist: f32 = length(parallaxPosW - c.xyz);
        if (dist < rad) {
            let normR: f32 = dist / rad;
            let pitDarken: f32 = (1.0 - smoothstep(0.0, 0.58, normR)) * 0.64;
            let spallRing: f32 = smoothstep(0.42, 0.66, normR) * (1.0 - smoothstep(0.66, 1.0, normR)) * 0.24;
            let leadSmear: f32 = (1.0 - smoothstep(0.0, 0.18, normR)) * 0.09;
            dAlbedo = dAlbedo * (1.0 - pitDarken) + vec3f(spallRing) + vec3f(leadSmear * 0.85, leadSmear * 0.9, leadSmear * 1.1);
        }
    }
}
`,
  );

  material.update();
}

function createTangentDecalQuadMesh(device: pc.GraphicsDevice): pc.Mesh {
  // Unit 1x1 quad lying in XY plane with outward normal +Z and explicit +X tangent for POM dTBN
  const positions = new Float32Array([
    -0.5, -0.5, 0,
     0.5, -0.5, 0,
     0.5,  0.5, 0,
    -0.5,  0.5, 0,
  ]);
  const normals = new Float32Array([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]);
  const tangents = new Float32Array([
    1, 0, 0, 1,
    1, 0, 0, 1,
    1, 0, 0, 1,
    1, 0, 0, 1,
  ]);
  const uvs = new Float32Array([
    0, 0,
    1, 0,
    1, 1,
    0, 1,
  ]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);

  const mesh = new pc.Mesh(device);
  mesh.setPositions(positions);
  mesh.setNormals(normals);
  mesh.setUvs(0, uvs);
  mesh.setVertexStream(pc.SEMANTIC_TANGENT, tangents, 4);
  mesh.setIndices(indices);
  mesh.update(pc.PRIMITIVE_TRIANGLES);
  return mesh;
}

function createConcreteChipMesh(device: pc.GraphicsDevice): pc.Mesh {
  // Angular 6-face fractured concrete spall prism/octahedron shard for crisp 3D tumbling debris
  const pTop = [0.02, 0.52, -0.04];
  const pBot = [-0.03, -0.46, 0.05];
  const p0 = [-0.48, 0.04, 0.42];
  const p1 = [0.52, -0.06, 0.34];
  const p2 = [0.36, 0.08, -0.48];
  const p3 = [-0.42, -0.05, -0.44];

  const faces = [
    [pTop, p0, p1],
    [pTop, p1, p2],
    [pTop, p2, p3],
    [pTop, p3, p0],
    [pBot, p1, p0],
    [pBot, p2, p1],
    [pBot, p3, p2],
    [pBot, p0, p3],
  ];

  const faceCount = faces.length;
  const positions = new Float32Array(faceCount * 9);
  const normals = new Float32Array(faceCount * 9);
  const indices = new Uint16Array(faceCount * 3);

  for (let f = 0; f < faceCount; f++) {
    const [a, b, c] = faces[f];
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const abz = b[2] - a[2];
    const acx = c[0] - a[0];
    const acy = c[1] - a[1];
    const acz = c[2] - a[2];
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    const tri = [a, b, c];
    for (let v = 0; v < 3; v++) {
      const idx = f * 3 + v;
      positions[idx * 3] = tri[v][0];
      positions[idx * 3 + 1] = tri[v][1];
      positions[idx * 3 + 2] = tri[v][2];
      normals[idx * 3] = nx;
      normals[idx * 3 + 1] = ny;
      normals[idx * 3 + 2] = nz;
      indices[idx] = idx;
    }
  }

  const mesh = new pc.Mesh(device);
  mesh.setPositions(positions);
  mesh.setNormals(normals);
  mesh.setIndices(indices);
  mesh.update(pc.PRIMITIVE_TRIANGLES);
  return mesh;
}

function quatFromPlusZToNormalWithRoll(normal: Vec3Like, rollRad: number): QuatLike {
  const nLen = Math.hypot(normal.x, normal.y, normal.z);
  const nx = nLen > 1e-6 ? normal.x / nLen : 0;
  const ny = nLen > 1e-6 ? normal.y / nLen : 0;
  const nz = nLen > 1e-6 ? normal.z / nLen : 1;

  // Shortest-arc quaternion from (0, 0, 1) to (nx, ny, nz)
  let ax: number;
  let ay: number;
  let az: number;
  let aw: number;

  if (nz < -0.9999) {
    ax = 0;
    ay = 1;
    az = 0;
    aw = 0;
  } else {
    ax = -ny;
    ay = nx;
    az = 0;
    aw = 1 + nz;
    const qLen = Math.hypot(ax, ay, az, aw);
    ax /= qLen;
    ay /= qLen;
    az /= qLen;
    aw /= qLen;
  }

  // Post-multiply local Z roll (around quad normal)
  const halfRoll = rollRad * 0.5;
  const rz = Math.sin(halfRoll);
  const rw = Math.cos(halfRoll);

  return {
    x: aw * 0 + ax * rw + ay * rz - az * 0,
    y: aw * 0 - ax * rz + ay * rw + az * 0,
    z: aw * rz + ax * 0 - ay * 0 + az * rw,
    w: aw * rw - ax * 0 - ay * 0 - az * rz,
  };
}

/**
 * Ring-buffered Parallax Occlusion Mapping (POM) concrete crater decal manager +
 * hardware-instanced concrete spall/spark debris emitter.
 */
export class PomCraterDecalSystem {
  public readonly app: pc.Application;
  public readonly maxDecals: number;
  public readonly textures: ProceduralCraterTextures;
  public readonly decalMaterial: pc.StandardMaterial;
  public readonly chipMaterial: pc.StandardMaterial;
  public readonly decalPool: HardwareInstancedPool;
  public readonly chipPool: HardwareInstancedPool;

  private readonly decalMesh: pc.Mesh;
  private readonly chipMesh: pc.Mesh;
  private readonly ringSlots: Int32Array;
  private readonly recentImpacts: CraterImpactRecord[] = [];
  private readonly shaderCraterUniformData = new Float32Array(MAX_SHADER_WORLD_CRATERS * 4);
  private readonly trackedConcreteMaterials = new Set<pc.StandardMaterial>();

  private ringCursor = 0;
  private totalSpawnedCraters = 0;
  private shaderCraterWriteCursor = 0;
  private shaderCraterActiveCount = 0;
  private rngState = 0x9e3779b9;
  private destroyed = false;

  public constructor(
    app: pc.Application,
    maxDecals = 128,
    maxChipParticles = 384,
    textureResolution = 256,
  ) {
    this.app = app;
    this.maxDecals = Math.max(4, Math.floor(maxDecals));
    this.ringSlots = new Int32Array(this.maxDecals).fill(-1);

    const device = app.graphicsDevice;
    this.textures = createProceduralCraterTextures(device, textureResolution);

    this.decalMaterial = new pc.StandardMaterial();
    this.decalMaterial.name = 'ConcretePomCraterDecalMat';
    applyPomCraterShaderChunks(this.decalMaterial, this.textures);

    this.chipMaterial = new pc.StandardMaterial();
    this.chipMaterial.name = 'ConcreteSpallChipMat';
    this.chipMaterial.diffuse = new pc.Color(0.68, 0.66, 0.63);
    this.chipMaterial.useMetalness = true;
    this.chipMaterial.metalness = 0.04;
    this.chipMaterial.gloss = 0.24;
    this.chipMaterial.fresnelModel = pc.FRESNEL_SCHLICK;
    this.chipMaterial.update();

    this.decalMesh = createTangentDecalQuadMesh(device);
    this.chipMesh = createConcreteChipMesh(device);

    this.decalPool = new HardwareInstancedPool(
      app,
      this.decalMesh,
      this.decalMaterial,
      this.maxDecals,
      'ConcretePomCraterDecalPool',
      false,
    );

    this.chipPool = new HardwareInstancedPool(
      app,
      this.chipMesh,
      this.chipMaterial,
      Math.max(32, Math.floor(maxChipParticles)),
      'ConcreteSpallChipPool',
      false,
    );
  }

  public get activeDecalCount(): number {
    return this.decalPool.activeCount;
  }

  public get activeChipCount(): number {
    return this.chipPool.activeCount;
  }

  public get totalCraterCount(): number {
    return this.totalSpawnedCraters;
  }

  public getImpacts(): readonly CraterImpactRecord[] {
    return this.recentImpacts;
  }

  /**
   * Registers a concrete wall `pc.StandardMaterial` to receive synchronized GLSL + WGSL
   * world-space crater scorch & parallax darkening uniforms on bullet hits.
   */
  public registerConcreteMaterial(material: pc.StandardMaterial): void {
    if (this.destroyed || this.trackedConcreteMaterials.has(material)) {
      return;
    }
    applyConcreteSurfaceCraterChunks(material, this.shaderCraterUniformData);
    this.trackedConcreteMaterials.add(material);
  }

  /**
   * Spawns a POM depth-displaced concrete bullet crater decal + instanced concrete spall chip
   * & dust burst at `pointWorld` oriented along `normalWorld`.
   */
  public spawnCraterImpact(
    pointWorld: Vec3Like,
    normalWorld: Vec3Like,
    bulletDirWorld: Vec3Like,
    kineticEnergyJ: number,
    caliberRadiusM = 0.004,
  ): CraterImpactRecord {
    const energyClamped = Math.max(80, Math.min(18000, kineticEnergyJ));
    const energyFactor = Math.cbrt(energyClamped / 1800);
    const craterDiameterM = Math.max(
      0.095,
      Math.min(0.38, (caliberRadiusM * 19 + 0.072) * energyFactor),
    );
    const craterRadiusM = craterDiameterM * 0.5;
    const craterDepthM = craterRadiusM * 0.36;

    if (!this.destroyed) {
      let slotId = this.ringSlots[this.ringCursor];
      if (slotId < 0 || !this.decalPool.isSlotActive(slotId)) {
        slotId = this.decalPool.allocSlot();
        this.ringSlots[this.ringCursor] = slotId;
      }
      this.ringCursor = (this.ringCursor + 1) % this.maxDecals;

      const rollRad = this.nextRandom() * Math.PI * 2;
      const quat = quatFromPlusZToNormalWithRoll(normalWorld, rollRad);
      const surfaceLiftM = 0.0028 + (slotId % 8) * 0.0001;

      if (slotId >= 0) {
        this.decalPool.setSlotTRS(
          slotId,
          {
            x: pointWorld.x + normalWorld.x * surfaceLiftM,
            y: pointWorld.y + normalWorld.y * surfaceLiftM,
            z: pointWorld.z + normalWorld.z * surfaceLiftM,
          },
          quat,
          { x: craterDiameterM, y: craterDiameterM, z: 1 },
        );
        this.decalPool.upload();
      }

      // Update world-space shader crater uniform ring buffer on registered concrete materials
      const uIdx = this.shaderCraterWriteCursor * 4;
      this.shaderCraterUniformData[uIdx] = pointWorld.x;
      this.shaderCraterUniformData[uIdx + 1] = pointWorld.y;
      this.shaderCraterUniformData[uIdx + 2] = pointWorld.z;
      this.shaderCraterUniformData[uIdx + 3] = craterRadiusM;

      this.shaderCraterWriteCursor =
        (this.shaderCraterWriteCursor + 1) % MAX_SHADER_WORLD_CRATERS;
      this.shaderCraterActiveCount = Math.min(
        MAX_SHADER_WORLD_CRATERS,
        this.shaderCraterActiveCount + 1,
      );

      for (const mat of this.trackedConcreteMaterials) {
        mat.setParameter('uCraterSpheres[0]', this.shaderCraterUniformData);
        mat.setParameter('uCraterCount', this.shaderCraterActiveCount);
      }

      this.spawnSpallChipBurst(pointWorld, normalWorld, bulletDirWorld, energyFactor);
    }

    this.totalSpawnedCraters++;
    const record: CraterImpactRecord = {
      pointWorld: { x: pointWorld.x, y: pointWorld.y, z: pointWorld.z },
      normalWorld: { x: normalWorld.x, y: normalWorld.y, z: normalWorld.z },
      radiusM: craterRadiusM,
      depthM: craterDepthM,
    };
    this.recentImpacts.push(record);
    if (this.recentImpacts.length > this.maxDecals) {
      this.recentImpacts.shift();
    }
    return record;
  }

  public spawnSpallChipBurst(
    pointWorld: Vec3Like,
    normalWorld: Vec3Like,
    incidentDirWorld: Vec3Like,
    intensityScale = 1.0,
    chipCountOverride?: number,
  ): number {
    if (this.destroyed) {
      return 0;
    }

    // Reflect incident direction across surface normal for realistic concrete ricochet spall cone
    const dotIN =
      incidentDirWorld.x * normalWorld.x +
      incidentDirWorld.y * normalWorld.y +
      incidentDirWorld.z * normalWorld.z;
    const reflX = incidentDirWorld.x - 2 * dotIN * normalWorld.x;
    const reflY = incidentDirWorld.y - 2 * dotIN * normalWorld.y;
    const reflZ = incidentDirWorld.z - 2 * dotIN * normalWorld.z;

    const count =
      chipCountOverride ?? Math.max(6, Math.min(16, Math.round(9 * intensityScale)));
    let spawned = 0;

    for (let i = 0; i < count; i++) {
      const speed = (2.8 + this.nextRandom() * 5.8) * Math.max(0.65, intensityScale);
      const jitterX = (this.nextRandom() - 0.5) * 1.25;
      const jitterY = this.nextRandom() * 0.95;
      const jitterZ = (this.nextRandom() - 0.5) * 1.25;

      let dirX = normalWorld.x * 0.62 + reflX * 0.38 + jitterX;
      let dirY = normalWorld.y * 0.62 + reflY * 0.38 + jitterY + 0.26;
      let dirZ = normalWorld.z * 0.62 + reflZ * 0.38 + jitterZ;
      const dLen = Math.hypot(dirX, dirY, dirZ) || 1;
      dirX /= dLen;
      dirY /= dLen;
      dirZ /= dLen;

      const chipSize = (0.011 + this.nextRandom() * 0.024) * Math.min(1.65, intensityScale);
      const slot = this.chipPool.spawnKinematicParticle(
        {
          x: pointWorld.x + normalWorld.x * 0.016,
          y: pointWorld.y + normalWorld.y * 0.016,
          z: pointWorld.z + normalWorld.z * 0.016,
        },
        {
          x: dirX * speed,
          y: dirY * speed,
          z: dirZ * speed,
        },
        {
          x: (this.nextRandom() - 0.5) * 26,
          y: (this.nextRandom() - 0.5) * 26,
          z: (this.nextRandom() - 0.5) * 26,
        },
        {
          x: chipSize,
          y: chipSize * (0.62 + this.nextRandom() * 0.35),
          z: chipSize * (0.72 + this.nextRandom() * 0.35),
        },
        -9.81,
        0.38,
        1.45 + this.nextRandom() * 0.95,
      );
      if (slot >= 0) {
        spawned++;
      }
    }

    this.chipPool.upload();
    return spawned;
  }

  public update(rapierWorld: RapierPhysicsWorld | null, dt: number): void {
    if (this.destroyed) {
      return;
    }
    this.decalPool.syncFromPhysics(rapierWorld, dt);
    this.chipPool.syncFromPhysics(rapierWorld, dt);
  }

  public clear(): void {
    if (this.destroyed) {
      return;
    }
    this.ringSlots.fill(-1);
    this.ringCursor = 0;
    this.totalSpawnedCraters = 0;
    this.recentImpacts.length = 0;
    this.shaderCraterUniformData.fill(0);
    this.shaderCraterWriteCursor = 0;
    this.shaderCraterActiveCount = 0;
    for (const mat of this.trackedConcreteMaterials) {
      mat.setParameter('uCraterSpheres[0]', this.shaderCraterUniformData);
      mat.setParameter('uCraterCount', 0);
    }
    this.decalPool.clear();
    this.chipPool.clear();
  }

  public destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.trackedConcreteMaterials.clear();
    this.decalPool.destroy();
    this.chipPool.destroy();
    this.decalMesh.destroy();
    this.chipMesh.destroy();
    this.decalMaterial.destroy();
    this.chipMaterial.destroy();
    this.textures.heightMap.destroy();
    this.textures.normalMap.destroy();
    this.textures.scorchDiffuseMap.destroy();
  }

  private nextRandom(): number {
    let x = this.rngState >>> 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return (this.rngState >>> 0) / 4294967296;
  }
}
