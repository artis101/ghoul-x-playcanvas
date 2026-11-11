import * as pc from 'playcanvas';
import { MAX_SHADER_WORLD_CRATERS } from './craterTextures.ts';

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
        dAlbedo = dAlbedo * {STD_DIFFUSE_TEXTURE_DECODE}(textureSampleBias({STD_DIFFUSE_TEXTURE_NAME}, {STD_DIFFUSE_TEXTURE_NAME}_sampler, {STD_DIFFUSE_TEXTURE_UV}, {STD_TEXTURE_BIAS})).rgb;
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
