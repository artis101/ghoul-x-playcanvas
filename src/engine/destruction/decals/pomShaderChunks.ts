import * as pc from 'playcanvas';
import type { ProceduralCraterTextures } from './craterTextures.ts';

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
    float nextDiff = currMapDepth - currLayerDepth;
    float prevMapDepth = 1.0 - texture2DLod({STD_HEIGHT_TEXTURE_NAME}, prevUv, 0.0).r;
    float prevDiff = prevMapDepth - (currLayerDepth - stepLayer);
    float weight = clamp(nextDiff / max(nextDiff - prevDiff, 0.0001), 0.0, 1.0);
    vec2 finalUv = mix(currUv, prevUv, weight);

    vec2 boundary = abs(finalUv - vec2(0.5));
    if (max(boundary.x, boundary.y) < 0.5) {
        dUvOffset = finalUv - baseUv;
    }
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
        vec4 texel = {STD_DIFFUSE_TEXTURE_DECODE}(texture2DBias({STD_DIFFUSE_TEXTURE_NAME}, {STD_DIFFUSE_TEXTURE_UV}, {STD_TEXTURE_BIAS}));
        dAlbedo *= texel.rgb;
        #ifdef STD_HEIGHT_TEXTURE
            float cavityDepth = 1.0 - texture2DLod({STD_HEIGHT_TEXTURE_NAME}, {STD_HEIGHT_TEXTURE_UV}, 0.0).r;
            float cavityShadow = 1.0 - clamp(cavityDepth * uPomScorchDarkening * 1.15, 0.0, 0.88);
            dAlbedo *= cavityShadow;
        #endif
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

    let POM_STEPS: i32 = 14;
    let stepLayer: f32 = 1.0 / f32(POM_STEPS);
    var currLayerDepth: f32 = 0.0;
    let baseUv: vec2f = {STD_HEIGHT_TEXTURE_UV};
    var currUv: vec2f = baseUv;
    var currMapDepth: f32 = 1.0 - textureSampleLevel({STD_HEIGHT_TEXTURE_NAME}, {STD_HEIGHT_TEXTURE_NAME}_sampler, currUv, 0.0).r;

    for (var i: i32 = 0; i < POM_STEPS; i = i + 1) {
        if (currLayerDepth >= currMapDepth) {
            break;
        }
        currUv = currUv + maxDeltaUv * stepLayer;
        currLayerDepth = currLayerDepth + stepLayer;
        currMapDepth = 1.0 - textureSampleLevel({STD_HEIGHT_TEXTURE_NAME}, {STD_HEIGHT_TEXTURE_NAME}_sampler, currUv, 0.0).r;
    }

    let prevUv: vec2f = currUv - maxDeltaUv * stepLayer;
    let nextDiff: f32 = currMapDepth - currLayerDepth;
    let prevMapDepth: f32 = 1.0 - textureSampleLevel({STD_HEIGHT_TEXTURE_NAME}, {STD_HEIGHT_TEXTURE_NAME}_sampler, prevUv, 0.0).r;
    let prevDiff: f32 = prevMapDepth - (currLayerDepth - stepLayer);
    let weight: f32 = clamp(nextDiff / max(nextDiff - prevDiff, 0.0001), 0.0, 1.0);
    let finalUv: vec2f = mix(currUv, prevUv, weight);

    let boundary: vec2f = abs(finalUv - vec2f(0.5, 0.5));
    if (max(boundary.x, boundary.y) < 0.5) {
        dUvOffset = finalUv - baseUv;
    }
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
        let texel: vec4f = {STD_DIFFUSE_TEXTURE_DECODE}(textureSampleBias({STD_DIFFUSE_TEXTURE_NAME}, {STD_DIFFUSE_TEXTURE_NAME}_sampler, {STD_DIFFUSE_TEXTURE_UV}, {STD_TEXTURE_BIAS}));
        dAlbedo = dAlbedo * texel.rgb;
        #ifdef STD_HEIGHT_TEXTURE
            let cavityDepth: f32 = 1.0 - textureSampleLevel({STD_HEIGHT_TEXTURE_NAME}, {STD_HEIGHT_TEXTURE_NAME}_sampler, {STD_HEIGHT_TEXTURE_UV}, 0.0).r;
            let cavityShadow: f32 = 1.0 - clamp(cavityDepth * uniform.uPomScorchDarkening * 1.15, 0.0, 0.88);
            dAlbedo = dAlbedo * cavityShadow;
        #endif
    #endif
}
`,
  );

  material.update();
}
