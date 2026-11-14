// lib/heroScene.ts — GPGPU particle world, faithful port of the reference mechanism.
// Physics constants + sim/render math extracted from the reference site's own bundle
// (spring-to-target, curl flow, neighbor repulsion, viscosity, mouse-velocity fluid
// impulse, scatter meter, glow accumulation, lit-sphere sprites). Our palette — which
// IS the reference violet family — our Ø mark, our dark theme.
import * as THREE from "three";

export type HeroSceneHandle = {
  setScene: (idx: number, dir?: number) => void; // lock statement scene -> shape (burst + embers forward only)
  setProgress: (p: number) => void; // 0..1 journey (camera, Target 2)
  setPointer: (nx: number, ny: number) => void; // NDC -1..1
  resize: (w: number, h: number) => void;
  dispose: () => void;
};

/* ---------- constants (reference values, verbatim) ---------- */
const SPRING_STIFFNESS = 0.6;
const VISCOSITY = 0.15;
const VELOCITY_DAMPING = 0.93;
const FLOW_STRENGTH = 0.00008;
const FLOW_SCALE = 0.9;
const FLOW_SPEED = 0.5;
const REPULSION_STRENGTH = 0.005;
const REPULSION_RADIUS = 0.0008;
const SCATTER_DURATION = 0.35;
const RETURN_SHARPNESS = 4;
const PULSE_AMPLITUDE = 0.3;
const PARTICLE_SIZE = 0.44;
const SHAPE_SCALE = 5;
/* environment: a closed deep-space shell around the whole journey.
   the mark floats just above eye level over a huge planet cap; the camera
   dips to -1.6, staying ~20 units above the surface (no clipping anywhere). */
const MARK_Y = 2.2;
const GROUND_Y = -22;
const PLANET_RADIUS = 2200;
const PLANET_CENTER = new THREE.Vector3(0, GROUND_Y - PLANET_RADIUS, 0);

/* orbit camera (reference algorithm verbatim; constants adapted to our world) */
const CAMERA_POSITION: [number, number, number] = [5.44, 3.4, 34];
const ORBIT_RADIUS = Math.hypot(CAMERA_POSITION[0], CAMERA_POSITION[2]);
const ORBIT_INITIAL_ANGLE = Math.atan2(CAMERA_POSITION[0], CAMERA_POSITION[2]);
const ORBIT_Y = CAMERA_POSITION[1];
const ORBIT_CLOSE_FACTOR = 0.6;
const LOOKAT_OFFSETS: [number, number, number][] = [
  [0, -1.1, 0], [0, 2.5, 2.5], [0, 0.6, 2], [0, 1.6, 1.6], [0, 0, 0],
];
const SHAPE_BREAKPOINTS = [0.18, 0.4, 0.65, 0.76];
const SHAPE_ROTATIONS = [0, 0, 0, -(77 * Math.PI) / 180, 0]; // heart faces camera at its orbit azimuth
const easeSmooth = (x: number) => x * x * (3 - 2 * x);

/* per-station composition: the mark counterweights the statement — text bottom
   or left keeps it upper-right, text right sends it upper-left. [screen-right,
   screen-up] in world units at the mark's depth, held per scene and eased
   across each breakpoint so the scroll stays reversible. */
const STAGE_X = [2.8, -10.5, 3.6, 12.0, 0];
const STAGE_Y = [1.6, 0.6, 0.8, 0.6, 0.8];
const STAGE_SCALES = [1, 0.85, 0.88, 0.72, 1.12];
const STAGE_WINDOW = 0.035;
function stationAt(values: number[], p: number): number {
  let v = values[0];
  for (let i = 0; i < SHAPE_BREAKPOINTS.length; i++) {
    const b = SHAPE_BREAKPOINTS[i];
    const t = easeSmooth(
      Math.min(1, Math.max(0, (p - (b - STAGE_WINDOW)) / (STAGE_WINDOW * 2))),
    );
    v += (values[i + 1] - v) * t;
  }
  return v;
}

/* energy heartbeat (reference: BURST_SPEED 0.5, fire window 0.8-0.9, SPAWN_BATCH 1600,
   LIFETIME 2.3, pulse decay x0.05/s, centerGlowPulse = 1 + pulse * 0.3).
   Tuned down after the first pass: the reference pulse is a shimmer, not a
   shape-wide breath, so the kick, cadence and glow swell are all softer. */
const BURST_SPEED = 0.34;
const HEARTBEAT_WINDOW: [number, number] = [0.8, 0.9];
const PULSE_AMPLITUDE_GLOW = 0.14;
const PULSE_KICK = 0.16;
const PULSE_DECAY = 0.05;

function sceneIndexForProgress(p: number): number {
  for (let i = SHAPE_BREAKPOINTS.length - 1; i >= 0; i--) {
    if (p > SHAPE_BREAKPOINTS[i]) return i + 1;
  }
  return 0;
}

const PALETTE = {
  PRIMARY: new THREE.Color("#9047ff"),
  SECONDARY: new THREE.Color("#8844ee"),
  TERTIARY: new THREE.Color("#cc66ff"),
  DEEP: new THREE.Color("#6622cc"),
  WHITE: new THREE.Color("#e7f5f5"),
};
const CENTER_GLOW_COLOR = new THREE.Color(14006783); // #D5A8FF
const RIM_COLOR_COOL = new THREE.Color(6740479); // #66CCFF
const RIM_COLOR_WARM = new THREE.Color(15892735); // #F2A7FF
const SPEC_COLOR = new THREE.Color(12556799); // #BF7FFF
const GLOW_COLOR = new THREE.Color(10902015); // #A699FF
const TINT_COLOR = new THREE.Color(15915519); // #F2CFFF
const ENERGY_COLOR = new THREE.Color(4197721); // #401F99
const LIGHT_DIR = new THREE.Vector3(0.5, 0.8, 0.6).normalize();

/* ---------- shape sampling (SHAPE_SCALE proportions) ---------- */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleCube(n: number, rand: () => number): Float32Array {
  const s = 0.62;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const face = Math.floor(rand() * 6);
    const a = rand() * 2 * s - s;
    const b = rand() * 2 * s - s;
    const v = new THREE.Vector3(a, b, face < 3 ? s : -s);
    if (face % 3 === 1) v.set(a, face === 1 ? s : -s, b);
    if (face % 3 === 2) v.set(face === 2 ? s : -s, a, b);
    v.lerp(v.clone().normalize().multiplyScalar(s * 1.12), 0.22);
    out.set([v.x, v.y, v.z], i * 3);
  }
  return out;
}

function sampleSphere(n: number, rand: () => number): Float32Array {
  const r = 0.62;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = rand() * Math.PI * 2;
    const v = Math.acos(2 * rand() - 1);
    const rr = r * (0.99 + rand() * 0.02);
    out.set([rr * Math.sin(v) * Math.cos(u), rr * Math.cos(v), rr * Math.sin(v) * Math.sin(u)], i * 3);
  }
  return out;
}

function sampleHeart(n: number, rand: () => number): Float32Array {
  // reference "heart-tree": wide heart canopy (parametric curve band + light fill)
  // on a sparse trunk, facing +Z so it reads frontal during its scene
  const S = 0.78;
  const out = new Float32Array(n * 3);
  const heartPt = (t: number): [number, number] => {
    const x = 16 * Math.pow(Math.sin(t), 3) / 17;
    const y = (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 17;
    return [x, y];
  };
  for (let i = 0; i < n; i++) {
    const r = rand();
    if (r < 0.16) {
      // trunk + branches
      const t = rand();
      if (t < 0.78) {
        out.set([(rand() - 0.5) * 0.06, -0.62 + t * 0.5, (rand() - 0.5) * 0.06], i * 3);
      } else {
        const side = rand() < 0.5 ? -1 : 1;
        const s2 = rand();
        out.set([side * (0.1 + s2 * 0.34), -0.28 + s2 * 0.3, (rand() - 0.5) * 0.05], i * 3);
      }
      continue;
    }
    const t = rand() * Math.PI * 2;
    const [hx, hy] = heartPt(t);
    if (r < 0.68) {
      // canopy outline band (two-lobe bumps read clearly)
      const j = 0.96 + rand() * 0.08;
      out.set([hx * S * j, hy * S * j + 0.42, (rand() - 0.5) * 0.18], i * 3);
    } else {
      // light interior fill
      const f = Math.sqrt(rand());
      const [fx, fy] = heartPt(rand() * Math.PI * 2);
      out.set([fx * S * f * 0.92, fy * S * f * 0.92 + 0.42, (rand() - 0.5) * 0.34], i * 3);
    }
  }
  return out;
}

function sampleTorus(n: number, rand: () => number): Float32Array {
  const R = 0.9;
  const r = 0.3;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = rand() * Math.PI * 2;
    const v = rand() * Math.PI * 2;
    const rr = r * (0.94 + rand() * 0.12);
    out.set(
      [(R + rr * Math.cos(v)) * Math.cos(u), (R + rr * Math.cos(v)) * Math.sin(u) * 0.98, rr * Math.sin(v)],
      i * 3,
    );
  }
  return out;
}

/** Ø mark — procedural ring + slash (deterministic, no canvas/fonts) */
function sampleGlyph(n: number, rand: () => number): Float32Array {
  const out = new Float32Array(n * 3);
  const R = 0.5;
  const band = 0.1;
  const slashTilt = (68 * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    if (rand() < 0.32) {
      // slash
      const t = rand() * 2 - 1;
      const x = Math.sin(slashTilt) * t * R * 1.15;
      const y = Math.cos(slashTilt) * t * R * 1.15;
      out.set([x + (rand() - 0.5) * 0.05, y + (rand() - 0.5) * 0.05, (rand() - 0.5) * 0.16], i * 3);
    } else {
      // ring band (slight thickness variation for organic density)
      const t = rand() * Math.PI * 2;
      const rr = R + (rand() - 0.5) * band * 2 * (0.7 + rand() * 0.6);
      out.set([Math.cos(t) * rr, Math.sin(t) * rr, (rand() - 0.5) * 0.34], i * 3);
    }
  }
  return out;
}

/* ---------- GPGPU sim (two passes: velocity, then position — no MRT needed) ---------- */
const SIM_VERT = `out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const SIM_COMMON = /* glsl */ `
precision highp float;
in vec2 vUv;
uniform float time;
uniform float delta;
uniform float springStiffness;
uniform float damping;
uniform float viscosity;
uniform float flowStrength;
uniform float flowScale;
uniform float flowSpeed;
uniform float returnSharpness;
uniform float scatterDuration;
uniform float pulseAmplitude;
uniform float burstIntensity;
uniform vec2 uMouseUV;
uniform vec2 uMouseVel;
uniform float uAspect;
uniform float uImpulseScale;
uniform mat4 uMVP;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform float uInteractForce;
uniform float repulsionStrength;
uniform float repulsionRadius;
uniform sampler2D texturePosition;
uniform sampler2D textureVelocity;
uniform sampler2D textureTarget;
uvec2 _pcg3d16(uvec3 p) {
  uvec3 v = p * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v.x += v.y * v.z; v.y += v.z * v.x;
  return v.xy;
}
vec3 _gradient3d(uint hash) {
  vec3 g = vec3(uvec3(hash) & uvec3(0x80000u, 0x40000u, 0x20000u));
  return g * (1.0 / vec3(0x40000, 0x20000, 0x10000)) - 1.0;
}
vec3 BitangentNoise3D(vec3 p) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(p + dot(p, C.yyy));
  vec3 x0 = p - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, i1);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = i + 32768.5;
  uvec2 hash0 = _pcg3d16(uvec3(i));
  uvec2 hash1 = _pcg3d16(uvec3(i + i1));
  uvec2 hash2 = _pcg3d16(uvec3(i + i2));
  uvec2 hash3 = _pcg3d16(uvec3(i + 1.0));
  vec3 p00 = _gradient3d(hash0.x); vec3 p01 = _gradient3d(hash0.y);
  vec3 p10 = _gradient3d(hash1.x); vec3 p11 = _gradient3d(hash1.y);
  vec3 p20 = _gradient3d(hash2.x); vec3 p21 = _gradient3d(hash2.y);
  vec3 p30 = _gradient3d(hash3.x); vec3 p31 = _gradient3d(hash3.y);
  vec4 m = clamp(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0, 1.0);
  vec4 mt = m * m;
  vec4 m4 = mt * mt;
  mt = mt * m;
  vec4 pdotx = vec4(dot(p00, x0), dot(p10, x1), dot(p20, x2), dot(p30, x3));
  vec4 temp = mt * pdotx;
  vec3 gradient0 = -8.0 * (temp.x * x0 + temp.y * x1 + temp.z * x2 + temp.w * x3);
  gradient0 += m4.x * p00 + m4.y * p10 + m4.z * p20 + m4.w * p30;
  pdotx = vec4(dot(p01, x0), dot(p11, x1), dot(p21, x2), dot(p31, x3));
  temp = mt * pdotx;
  vec3 gradient1 = -8.0 * (temp.x * x0 + temp.y * x1 + temp.z * x2 + temp.w * x3);
  gradient1 += m4.x * p01 + m4.y * p11 + m4.z * p21 + m4.w * p31;
  return cross(gradient0, gradient1) * 3918.76;
}
`;

// PASS 1 — velocity + scatter
const SIM_VEL_FRAG = SIM_COMMON + /* glsl */ `
layout(location = 0) out vec4 outVelocity;
void main() {
  vec2 uv = vUv;
  vec4 posData = texture(texturePosition, uv);
  vec4 velData = texture(textureVelocity, uv);
  vec3 pos = posData.xyz;
  vec3 vel = velData.xyz;
  vec3 target = texture(textureTarget, uv).xyz;

  float pulse = 1.0 + burstIntensity * pulseAmplitude * 0.15;
  target *= pulse;
  vel += normalize(pos + vec3(0.001)) * burstIntensity * pulseAmplitude * 0.08;

  vec4 clipPos = uMVP * vec4(pos, 1.0);
  float interactMask = 0.0;
  if (clipPos.w > 0.0) {
    vec2 screenUV = clamp((clipPos.xy / clipPos.w) * 0.5 + 0.5, 0.001, 0.999);
    vec2 d = screenUV - uMouseUV;
    d.x *= uAspect;
    interactMask = 1.0 - smoothstep(0.025, 0.06, length(d));
  }
  vec2 fluidVelXY = vec2(uMouseVel.x * uAspect, uMouseVel.y) * 50.0 * uImpulseScale * interactMask;
  float rawLen = length(fluidVelXY);
  fluidVelXY *= min(1.0, 1.5 / max(rawLen, 1e-4));
  float fluidMag = min(rawLen, 1.5) * uInteractForce;

  vec3 fluidDisp = uCamRight * fluidVelXY.x + uCamUp * fluidVelXY.y;
  vel += fluidDisp * 0.07 * uInteractForce;

  vec3 toTarget = target - pos;
  float dist = length(toTarget);
  float scatter = velData.w;
  float threshold = 1.0 / max(returnSharpness, 1.0);
  float holdFactor = smoothstep(0.0, threshold, scatter);
  float invFluidStrength = max(0.3, 1.0 - fluidMag * 0.8);
  float springReduction = invFluidStrength * (1.0 - holdFactor * 0.6);
  springReduction = max(springReduction, 0.2);
  float distAmp = mix(1.0 + dist * 0.5, 1.0, scatter);
  float springK = springStiffness * distAmp * springReduction;
  vel += toTarget * springK * delta;

  vec3 flowPos = pos * flowScale + vec3(0.0, 0.0, time * flowSpeed);
  float mouseFlowBoost = 1.0 + fluidMag * 2.6;
  vel += BitangentNoise3D(flowPos) * flowStrength * mouseFlowBoost;

  ivec2 texSize = textureSize(texturePosition, 0);
  vec2 repUvStep = vec2(1.0 / float(texSize.x), 1.0 / float(texSize.y)) * 2.0;
  vec3 repulsionForce = vec3(0.0);
  for (int i = 0; i < 2; i++) {
    vec2 off = i == 0 ? vec2(1.0, 1.0) : vec2(-1.0, -1.0);
    vec3 neighborPos = texture(texturePosition, uv + off * repUvStep).xyz;
    vec3 diff = pos - neighborPos;
    float neighborDist = length(diff);
    if (neighborDist > 0.001 && neighborDist < repulsionRadius * 10.0) {
      float repulse = 1.0 / (neighborDist * neighborDist + 0.1);
      repulsionForce += normalize(diff) * repulse * repulsionStrength;
    }
  }
  vel += repulsionForce;

  float uvStep = 1.0 / float(texSize.x);
  vec3 velSum = vel;
  velSum += texture(textureVelocity, uv + vec2(uvStep, uvStep)).xyz;
  velSum += texture(textureVelocity, uv + vec2(-uvStep, -uvStep)).xyz;
  vel = mix(vel, velSum / 3.0, viscosity);
  vel *= damping;
  float vMag = length(vel);
  vel *= min(1.0, 6.0 / max(vMag, 1e-4));

  float targetScatter = clamp(fluidMag * 2.5, 0.0, 1.0);
  float newScatter;
  if (targetScatter > scatter) newScatter = scatter + (targetScatter - scatter) * min(1.0, delta * 15.0);
  else newScatter = scatter - delta / max(scatterDuration, 0.01);
  outVelocity = vec4(vel, clamp(newScatter, 0.0, 1.0));
}`;

// PASS 2 — position + glow (uses the NEW velocity)
const SIM_POS_FRAG = SIM_COMMON + /* glsl */ `
layout(location = 0) out vec4 outPosition;
void main() {
  vec2 uv = vUv;
  vec4 posData = texture(texturePosition, uv);
  vec4 velNew = texture(textureVelocity, uv);
  vec3 pos = posData.xyz;
  float dt60 = delta * 60.0;
  vec3 newPos = pos + velNew.xyz * dt60;

  float prevGlow = posData.w;
  float speed = length(velNew.xyz);
  float velGlow = clamp((speed - 0.05) * 2.5, 0.0, 1.0);
  float scatterGlow = velNew.w * 0.7;
  vec4 clipPos = uMVP * vec4(pos, 1.0);
  float interactMask = 0.0;
  if (clipPos.w > 0.0) {
    vec2 screenUV = clamp((clipPos.xy / clipPos.w) * 0.5 + 0.5, 0.001, 0.999);
    vec2 d = screenUV - uMouseUV;
    d.x *= uAspect;
    interactMask = 1.0 - smoothstep(0.025, 0.06, length(d));
  }
  float impulseMag = length(uMouseVel) * 50.0 * uImpulseScale * interactMask;
  float proxGlow = min(impulseMag * 1.5, 0.8) * uInteractForce;
  float targetGlow = clamp(velGlow + proxGlow + scatterGlow, 0.0, 1.0);
  float glow;
  if (targetGlow > prevGlow) glow = prevGlow + (targetGlow - prevGlow) * min(1.0, delta * 12.0);
  else glow = prevGlow + (targetGlow - prevGlow) * min(1.0, delta * 3.0);
  outPosition = vec4(newPos, clamp(glow, 0.0, 1.0));
}`;

/* ---------- render (lit-sphere sprites, reference math) ---------- */
const RENDER_VERT = /* glsl */ `
uniform sampler2D positionTexture;
uniform sampler2D velocityTexture;
uniform float extrapolateTau;
uniform float size;
uniform float pixelRatio;
uniform float centerGlowSize;
uniform float centerGlowPulse;
uniform float centerGlowBoost;
uniform float burstIntensity;
uniform float uTime;
uniform vec3 GLOW_COLOR_U;
uniform vec3 CENTER_GLOW_COLOR_U;
uniform float CENTER_GLOW_OPACITY_U;
uniform vec3 TINT_COLOR_U;
uniform vec3 ENERGY_COLOR_U;
attribute vec2 texCoord;
attribute vec3 color;
attribute float aHash;
varying vec3 vColor;
varying vec3 vAddColor;
varying vec3 vBoostColor;
varying vec3 vFx;
varying vec3 vLight;
varying float vHash;
varying float vSeam;
varying float vFacet;
void main() {
  vec4 posData = texture2D(positionTexture, texCoord);
  vec4 velData = texture2D(velocityTexture, texCoord);
  vec3 currVel = velData.xyz;
  vec3 pos = posData.xyz + currVel * extrapolateTau;
  float glow = posData.w;
  float scatter = velData.w;
  float speed = length(currVel);
  vColor = color;
  vHash = aHash;
  // cloud-level lighting: the point's radial direction acts as the form's
  // normal, quantized into facets so the whole flock reads as one lit solid
  vec3 nObj = normalize(pos + vec3(0.0001));
  vec3 nS = normalize(normalMatrix * nObj);
  vec3 nQ = normalize(normalMatrix * normalize(floor(nObj * 5.0) + 0.5));
  vec3 keyDir = normalize((viewMatrix * vec4(0.55, 0.82, 0.38, 0.0)).xyz);
  float NdL = dot(nQ, keyDir);
  vLight = vec3(
    smoothstep(-0.40, 0.78, NdL),
    pow(max(NdL, 0.0), 20.0),
    pow(1.0 - abs(nS.z), 2.6)
  );
  vec3 cellD = abs(fract(nObj * 5.0) - 0.5);
  vSeam = 1.0 - smoothstep(0.04, 0.115, min(min(cellD.x, cellD.y), cellD.z));
  vec3 cellId = floor(nObj * 5.0);
  vFacet = 0.90 + 0.20 * fract(sin(dot(cellId, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  float distToCenter = length(pos);
  float glowRadius = centerGlowSize * centerGlowPulse;
  float centerGlow = 1.0 - smoothstep(0.0, glowRadius, distToCenter);
  centerGlow *= centerGlow;
  float speedMix = smoothstep(0.05, 0.5, speed) * 0.5;
  float cgOpacity = CENTER_GLOW_OPACITY_U * (1.0 + centerGlowBoost * 1.2);
  vAddColor = GLOW_COLOR_U * glow * 0.45
    + mix(CENTER_GLOW_COLOR_U, vec3(1.0), centerGlowBoost * 0.55) * centerGlow * cgOpacity * 0.55
    + ENERGY_COLOR_U * speedMix * 0.55;
  vBoostColor = TINT_COLOR_U * (1.3 * (1.0 + glow * 0.4 + centerGlow * 0.3 + burstIntensity));
  float blowoutKey = clamp(
    glow * 0.7 + burstIntensity * 0.5 + scatter * 0.45 + smoothstep(0.08, 0.45, speed) * 0.45, 0.0, 1.0);
  vFx = vec3(1.0 + 0.05 * sin(uTime * 1.5 + aHash * 6.28318), scatter * 0.16,
    smoothstep(0.42, 0.88, blowoutKey) * 0.32);
  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float sizeAttenuation = 350.0 / -mvPosition.z;
  float bloomScale = 1.0 + glow * 0.35;
  gl_PointSize = clamp(
    size * pixelRatio * sizeAttenuation * bloomScale * (0.80 + 0.40 * aHash), 2.0, 100.0) * 0.84;
}`;

const RENDER_FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying vec3 vAddColor;
varying vec3 vBoostColor;
varying vec3 vFx;
varying vec3 vLight;
varying float vHash;
varying float vSeam;
varying float vFacet;
uniform vec3 lightDirView;
uniform vec3 halfDirView;
uniform float uPresence;
uniform vec3 rimColorCool;
uniform vec3 rimColorWarm;
uniform vec3 specColor;
void main() {
  vec2 uv = (gl_PointCoord - 0.5) * 0.84;
  float dist = length(uv);
  float solidEdge = 0.42;
  if (dist > solidEdge) discard;
  float z = sqrt(max(0.0, 0.25 - dist * dist));
  vec3 normal = vec3(uv.x, -uv.y, z) * 2.0;
  float NdotL = max(dot(normal, lightDirView), 0.0);
  float diffuse = NdotL * 0.4 + 0.6;
  float shadow = smoothstep(-0.3, 0.4, normal.y) * 0.25 + 0.75;
  float rim = 1.0 - max(normal.z, 0.0);
  float rim2 = rim * rim;
  float rimGlow = rim2 * rim * 0.4;
  vec3 baseColor = vColor * diffuse * shadow * 1.2;
  float backLit = 1.0 - NdotL;
  baseColor += vColor * (backLit * backLit * 0.18);
  vec3 rimMix = mix(rimColorWarm, rimColorCool, rim2);
  baseColor += rimMix * rimGlow * 0.22;
  float sN = max(dot(normal, halfDirView), 0.0);
  float s2 = sN * sN;
  float s4 = s2 * s2;
  float s8 = s4 * s4;
  float s16 = s8 * s8;
  float spec = s16 * s8 * 0.07;
  baseColor += specColor * spec;
  // form-level lighting: key, facet seams, glossy band and silhouette rim
  baseColor *= 0.16 + 1.55 * vLight.x;
  baseColor *= vFacet;
  baseColor *= 0.88 + 0.24 * vHash;
  baseColor += vec3(0.58, 0.66, 1.0) * vLight.y * 0.30;
  baseColor += vec3(0.60, 0.48, 1.0) * vLight.z * 0.20;
  baseColor += vec3(0.60, 0.66, 0.98) * vSeam * 0.20 * (0.20 + 0.80 * vLight.x);
  baseColor += vAddColor;
  float luma = dot(baseColor, vec3(0.299, 0.587, 0.114));
  baseColor = mix(baseColor, vec3(luma), vFx.y);
  baseColor *= vFx.x;
  vec3 boosted = baseColor * vBoostColor;
  baseColor = mix(boosted, vec3(1.8), vFx.z);
  float ditherNoise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;
  baseColor += ditherNoise / 255.0;
  float alpha = 1.0 - smoothstep(0.36, solidEdge, dist);
  gl_FragColor = vec4(baseColor, alpha * uPresence);
}`;

/* ---------- embers (reference energy particles) ---------- */
const EMBER_VERT = /* glsl */ `
uniform float time;
uniform float size;
uniform float pixelRatio;
attribute float aSpawnTime;
attribute float aLifetime;
attribute vec3 aVelocity;
attribute vec3 aSpawnPos;
attribute float aPhase;
varying float vAlpha;
varying float vAge;
void main() {
  float age = time - aSpawnTime;
  float progress = clamp(age / aLifetime, 0.0, 1.0);
  if (progress >= 1.0 || aSpawnTime < 0.0) {
    gl_Position = vec4(0.0, 0.0, -999.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    return;
  }
  float decel = 1.0 - progress * 0.6;
  vec3 pos = aSpawnPos + aVelocity * age * decel;
  float swirlAngle = age * (2.0 + aPhase * 3.0);
  vec3 radial = normalize(pos + vec3(0.001));
  vec3 up = abs(radial.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 tangent = normalize(cross(radial, up));
  vec3 bitangent = cross(radial, tangent);
  float swirlRadius = (0.18 + aPhase * 0.1) * (1.0 - progress);
  pos += tangent * sin(swirlAngle) * swirlRadius + bitangent * cos(swirlAngle) * swirlRadius;
  float waveFreq = 3.0 + aPhase * 4.0;
  float waveAmp = 0.08 * (1.0 - progress * 0.8);
  pos.x += sin(age * waveFreq + aPhase * 6.28) * waveAmp;
  pos.y += cos(age * waveFreq * 0.7 + aPhase * 4.0) * waveAmp * 0.6;
  float fadeIn = smoothstep(0.0, 0.05, progress);
  float fadeOut = 1.0 - smoothstep(0.4, 1.0, progress);
  vAlpha = fadeIn * fadeOut;
  vAge = progress;
  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float sizeScale = (1.0 - progress * 0.7) * (0.7 + aPhase * 0.6);
  float sizeAttenuation = 350.0 / -mvPosition.z;
  gl_PointSize = size * pixelRatio * sizeAttenuation * sizeScale;
  gl_PointSize = clamp(gl_PointSize, 1.0, 60.0);
}`;

const EMBER_FRAG = /* glsl */ `
precision highp float;
varying float vAlpha;
varying float vAge;
uniform vec3 color;
uniform vec3 glowColor;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  if (d > 0.5) discard;
  float core = smoothstep(0.5, 0.05, d);
  vec3 col = mix(color, glowColor, clamp(vAge * 1.4, 0.0, 1.0));
  col = mix(col, vec3(1.0), core * 0.55);
  gl_FragColor = vec4(col, vAlpha * core);
}`;

/* ---------- scene assembly ---------- */
export function createHeroScene(
  canvas: HTMLCanvasElement,
  opts: { reducedMotion?: boolean; onBeat?: () => void; onHover?: (strength: number) => void } = {},
): HeroSceneHandle {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
  renderer.setPixelRatio(dpr);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, canvas.clientWidth / canvas.clientHeight, 0.1, 6000);
  camera.position.set(0.6, 3.4, 34);
  camera.lookAt(4.2, 6.8, 0);

  const tierHigh = (navigator.hardwareConcurrency || 4) >= 8;
  const TEX = tierHigh ? 280 : 220; // reference: 280 high / 220 low
  const COUNT = TEX * TEX;

  /* ---------- 360° deep-space environment (hamol theme) ----------
     The orbit camera makes a full revolution and the finale flies forward,
     so every background layer must surround the stage. No flat backdrops. */
  const markX = () => (camera.aspect < 0.9 ? 0.8 : 4.2);

  // sky dome: near-black violet gradient, soft nebulae, and an analytic
  // atmosphere halo that hugs the planet limb from any camera angle
  const domeUniforms = {
    uTime: { value: 0 },
    uPlanetCenter: { value: PLANET_CENTER.clone() },
    uPlanetRadius: { value: PLANET_RADIUS },
    uReveal: { value: 0 },
  };
  const domeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    uniforms: domeUniforms,
    vertexShader: `varying vec3 vWorld;
      void main(){
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `precision highp float;
      varying vec3 vWorld;
      uniform float uTime;
      uniform vec3 uPlanetCenter;
      uniform float uPlanetRadius;
      uniform float uReveal;
      float hash(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      float vnoise(vec3 p){
        vec3 i = floor(p); vec3 f = fract(p); f = f*f*(3.0-2.0*f);
        float n000=hash(i), n100=hash(i+vec3(1.0,0.0,0.0)), n010=hash(i+vec3(0.0,1.0,0.0)), n110=hash(i+vec3(1.0,1.0,0.0));
        float n001=hash(i+vec3(0.0,0.0,1.0)), n101=hash(i+vec3(1.0,0.0,1.0)), n011=hash(i+vec3(0.0,1.0,1.0)), n111=hash(i+vec3(1.0,1.0,1.0));
        return mix(mix(mix(n000,n100,f.x), mix(n010,n110,f.x), f.y), mix(mix(n001,n101,f.x), mix(n011,n111,f.x), f.y), f.z);
      }
      float fbm(vec3 p){ float s=0.0, a=0.5; for(int i=0;i<4;i++){ s += a*vnoise(p); p*=2.03; a*=0.5; } return s; }
      void main(){
        vec3 d = normalize(vWorld - cameraPosition);
        float h = d.y;
        vec3 zenith  = vec3(0.008, 0.007, 0.021);
        vec3 mid     = vec3(0.018, 0.013, 0.040);
        vec3 horizon = vec3(0.040, 0.028, 0.086);
        vec3 col = mix(horizon, zenith, smoothstep(0.0, 0.55, h));
        col = mix(mid, col, smoothstep(0.02, 0.22, h));

        // finale: the same sky opens into a deep azure dawn. Palette only —
        // structure is shared, so the shift reads as light, not a filter.
        vec3 zenithB  = vec3(0.012, 0.036, 0.082);
        vec3 midB     = vec3(0.022, 0.062, 0.136);
        vec3 horizonB = vec3(0.105, 0.245, 0.430);
        vec3 colB = mix(horizonB, zenithB, smoothstep(0.0, 0.55, h));
        colB = mix(midB, colB, smoothstep(0.02, 0.22, h));
        col = mix(col, colB, uReveal);

        // two wispy nebula layers: faint violet with a violet-blue edge
        vec3 np = d * 2.3 + vec3(0.0, uTime * 0.003, 0.0);
        float n1 = fbm(np);
        float n2 = fbm(d * 5.1 + vec3(11.3, 4.7, -2.1));
        float neb = smoothstep(0.42, 0.88, n1) * 0.85 + smoothstep(0.52, 0.92, n2) * 0.40;
        neb *= smoothstep(0.0, 0.38, h) * (1.0 - smoothstep(0.75, 1.0, h));
        vec3 nebV = mix(vec3(0.075, 0.045, 0.165), vec3(0.135, 0.090, 0.245), n2);
        vec3 nebB = mix(vec3(0.055, 0.130, 0.300), vec3(0.160, 0.310, 0.520), n2);
        col += mix(nebV, nebB, uReveal) * neb * 0.70;

        // zodiacal dust: a tilted great-circle band of clumped haze and
        // unresolved micro-stars, so the empty sky has structure to read
        float zd = abs(dot(d, normalize(vec3(0.85, 0.50, 0.15))));
        float zband = exp(-pow(zd / 0.20, 2.0));
        float zclump = 0.45 + 0.55 * smoothstep(0.35, 0.85, n2);
        col += mix(vec3(0.085, 0.065, 0.150), vec3(0.060, 0.095, 0.170), uReveal) * zband * zclump * 0.70;
        col += vec3(0.75, 0.72, 0.95) * zband * smoothstep(0.93, 1.0, hash(d * 890.0)) * 0.18;

        // analytic planet halo: angular distance above the limb (exact for a
        // sphere, independent of orbit position)
        vec3 oc = cameraPosition - uPlanetCenter;
        vec3 up = normalize(oc);
        float hgt = length(oc) - uPlanetRadius;
        float delta = acos(clamp(uPlanetRadius / (uPlanetRadius + hgt), -1.0, 1.0));
        float elev = asin(clamp(dot(d, up), -1.0, 1.0));
        float above = max(elev + delta, 0.0);
        float halo = exp(-pow(above / 0.0065, 2.0));
        float wide = exp(-above / 0.016);
        vec3 haloV = mix(vec3(0.34, 0.25, 0.72), vec3(0.86, 0.89, 1.0), halo);
        vec3 haloB = mix(vec3(0.32, 0.60, 1.00), vec3(0.90, 0.97, 1.0), halo);
        col += mix(haloV, haloB, uReveal) * halo * mix(0.46, 0.64, uReveal);
        col += mix(vec3(0.16, 0.12, 0.30), vec3(0.12, 0.25, 0.46), uReveal) * wide * 0.12;
        // broad dawn lift hugging the horizon so the blue world has air
        col += vec3(0.10, 0.20, 0.38) * exp(-above / 0.085) * uReveal * 0.30;

        // limb airglow: a slow band of light just above the atmosphere line that
        // undulates around the horizon so the limb reads alive, not painted
        vec2 az = normalize(vec2(d.x, d.z) + vec2(0.0001));
        float azim = atan(az.y, az.x);
        float band = above - (0.022 + 0.007 * sin(azim * 2.0 + uTime * 0.16));
        float aurora = exp(-pow(band / 0.010, 2.0));
        float shimmer = 0.45 + 0.55 * sin(azim * 5.0 - uTime * 0.26 + sin(azim * 2.0 + uTime * 0.11) * 2.0);
        col += mix(vec3(0.30, 0.33, 0.74), vec3(0.36, 0.68, 1.00), uReveal) * aurora * shimmer * 0.20;

        // aurora curtains: rayed drapery rising off the airglow line, patchy
        // around the limb so some azimuths breathe while others stay quiet
        float rays = vnoise(vec3(azim * 16.0 + uTime * 0.02, above * 2.5 - uTime * 0.06, 3.7)) * 0.60
                   + vnoise(vec3(azim * 38.0 - uTime * 0.035, above * 5.0, 9.2)) * 0.40;
        float curtain = smoothstep(0.004, 0.020, above) * (1.0 - smoothstep(0.045, 0.160, above));
        curtain *= smoothstep(0.34, 0.62, vnoise(vec3(azim * 1.7 + uTime * 0.008, 0.0, 5.1)));
        curtain *= pow(max(rays, 0.0), 1.5);
        vec3 aurV = mix(vec3(0.22, 0.16, 0.55), vec3(0.30, 0.55, 0.95), smoothstep(0.02, 0.10, above));
        vec3 aurB = mix(vec3(0.18, 0.38, 0.75), vec3(0.35, 0.70, 1.00), smoothstep(0.02, 0.10, above));
        col += mix(aurV, aurB, uReveal) * curtain * 0.65;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(3600, 48, 32), domeMat);
  dome.renderOrder = -6;
  dome.frustumCulled = false;
  scene.add(dome);

  // two star shells on the upper hemisphere: a far field plus a closer, dimmer
  // layer whose drift against the far stars gives the orbit real parallax
  const makeStarLayer = (opts: {
    count: number; radius: number; seed: number;
    sizeMin: number; sizeMax: number; alpha: number; twinkle: number;
    spikes?: boolean; sizePow?: number;
  }) => {
    const geo = new THREE.BufferGeometry();
    const sp = new Float32Array(opts.count * 3);
    const ss = new Float32Array(opts.count);
    const sph = new Float32Array(opts.count);
    const st = new Float32Array(opts.count);
    const sr = mulberry32(opts.seed);
    for (let i = 0; i < opts.count; i++) {
      const y = 0.02 + Math.pow(sr(), 0.55) * 0.98;
      const a = sr() * Math.PI * 2;
      const r = Math.sqrt(1 - y * y);
      sp[i * 3] = Math.cos(a) * r * opts.radius;
      sp[i * 3 + 1] = y * opts.radius;
      sp[i * 3 + 2] = Math.sin(a) * r * opts.radius;
      ss[i] = opts.sizeMin + Math.pow(sr(), opts.sizePow ?? 3) * (opts.sizeMax - opts.sizeMin);
      sph[i] = sr();
      st[i] = sr();
    }
    geo.setAttribute("position", new THREE.BufferAttribute(sp, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(ss, 1));
    geo.setAttribute("aPhase", new THREE.BufferAttribute(sph, 1));
    geo.setAttribute("aTemp", new THREE.BufferAttribute(st, 1));
    const uniforms = {
      uTime: { value: 0 },
      pixelRatio: { value: dpr },
      uAlpha: { value: opts.alpha },
      uTwinkle: { value: opts.twinkle },
      uSpikes: { value: opts.spikes ? 1 : 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `attribute float aSize; attribute float aPhase; attribute float aTemp;
        uniform float uTime; uniform float pixelRatio;
        uniform float uAlpha; uniform float uTwinkle; varying float vA; varying float vTemp;
        void main(){
          float tw = 0.55 + 0.45 * sin(uTime * uTwinkle * (0.5 + aPhase) + aPhase * 6.28318);
          vA = (0.25 + tw * 0.65) * uAlpha;
          vTemp = aTemp;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * pixelRatio * (0.85 + 0.3 * tw);
        }`,
      fragmentShader: `precision highp float; varying float vA; varying float vTemp;
        uniform float uSpikes;
        void main(){
          vec2 uv = gl_PointCoord - 0.5; float d = length(uv);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.05, d);
          vec3 col = mix(vec3(0.72, 0.64, 1.0), vec3(1.0), a);
          float alpha = a * vA;
          if (uSpikes > 0.5) {
            // bright anchor star: hot core, four-point diffraction cross,
            // temperature tint from blue-white to a rare warm giant
            vec3 tint = mix(vec3(0.66, 0.74, 1.0), vec3(1.0, 0.90, 0.82), vTemp * vTemp);
            float core = pow(a, 1.7);
            float sx = exp(-abs(uv.y) * 9.0) * pow(max(0.0, 1.0 - abs(uv.x) * 2.0), 1.5);
            float sy = exp(-abs(uv.x) * 9.0) * pow(max(0.0, 1.0 - abs(uv.y) * 2.0), 1.5);
            float spike = (sx + sy) * 0.85;
            col = tint * (core + spike * 0.7) + vec3(1.0) * pow(core, 3.0) * 0.6;
            alpha = (core + spike) * vA;
          }
          gl_FragColor = vec4(col, alpha);
        }`,
    });
    const points = new THREE.Points(geo, mat);
    points.renderOrder = -3;
    points.frustumCulled = false;
    scene.add(points);
    return { points, uniforms };
  };
  const farStars = makeStarLayer({
    count: 2600, radius: 3400, seed: 9091,
    sizeMin: 0.9, sizeMax: 3.1, alpha: 1, twinkle: 1,
  });
  const nearStars = makeStarLayer({
    count: 700, radius: 620, seed: 4177,
    sizeMin: 0.45, sizeMax: 1.25, alpha: 0.55, twinkle: 0.35,
  });
  // bright anchor stars: sparse, spiked, temperature-tinted, on a middle shell
  // so they drift against both faint fields — the eye catches these first
  const brightStars = makeStarLayer({
    count: 190, radius: 1500, seed: 6231,
    sizeMin: 4.0, sizeMax: 12, alpha: 1, twinkle: 0.55, spikes: true, sizePow: 1.6,
  });

  // rare shooting star: one faint tapered streak in the upper sky every ~15-25s.
  // Mounted on the camera so it always crosses well above the limb at any orbit
  // azimuth; it never touches the mark or the layout.
  const skyRig = new THREE.Group();
  camera.add(skyRig);
  scene.add(camera);
  const shootUniforms = { uOpacity: { value: 0 } };
  const shootMat = new THREE.ShaderMaterial({
    uniforms: shootUniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `precision highp float; varying vec2 vUv; uniform float uOpacity;
      void main(){
        float along = vUv.x;                      // 0 tail .. 1 head
        float across = abs(vUv.y - 0.5) * 2.0;
        float width = mix(0.06, 0.82, pow(along, 1.4));
        float core = smoothstep(width, 0.0, across);
        float fade = smoothstep(0.0, 0.22, along) * (1.0 - smoothstep(0.62, 1.0, along));
        vec3 col = mix(vec3(0.55, 0.66, 1.0), vec3(1.0), core * core);
        gl_FragColor = vec4(col, core * fade * uOpacity);
      }`,
  });
  const shoot = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shootMat);
  shoot.renderOrder = -1;
  shoot.visible = false;
  skyRig.add(shoot);
  const shootDir = new THREE.Vector3();
  let shootSpeed = 0;
  let shootAge = 0;
  let shootLife = 1;
  let shootActive = false;
  let nextShootAt = 8 + Math.random() * 8;

  const spawnShoot = () => {
    const halfH = 60 * Math.tan((camera.fov * Math.PI) / 360);
    const halfW = halfH * camera.aspect;
    const sign = Math.random() < 0.5 ? -1 : 1;
    const drop = 0.2 + Math.random() * 0.22;
    shootDir.set(sign * Math.cos(drop), -Math.sin(drop), 0).normalize();
    shoot.rotation.z = Math.atan2(shootDir.y, shootDir.x);
    shoot.position.set(
      halfW * (Math.random() * 0.95 - 0.45),
      halfH * (0.3 + Math.random() * 0.3),
      -60,
    );
    shoot.scale.set(Math.max(12, halfW * 0.5), Math.max(0.7, halfW * 0.024), 1);
    shootLife = 0.75 + Math.random() * 0.4;
    shootSpeed = (halfW * 1.1) / shootLife;
    shootAge = 0;
    shootActive = true;
  };

  // planet cap: a 23° spherical cap of a 2200-unit sphere whose surface sits
  // 22 units below the stage. The silhouette is the limb; normals are analytic
  // (world position - center) so no tessellation bands appear near the pole.
  const waveTimes = new Float32Array(4).fill(-10);
  const groundUniforms = {
    uCenter: { value: PLANET_CENTER.clone() },
    uCam: { value: new THREE.Vector2() },
    uMark: { value: new THREE.Vector2() },
    uTime: { value: 0 },
    uPulse: { value: 0 },
    uWaves: { value: waveTimes },
    uReveal: { value: 0 },
  };
  const groundMat = new THREE.ShaderMaterial({
    uniforms: groundUniforms,
    vertexShader: `varying vec3 vWorld;
      void main(){
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `precision highp float;
      varying vec3 vWorld;
      uniform vec3 uCenter;
      uniform vec2 uCam; uniform vec2 uMark; uniform float uTime; uniform float uPulse;
      uniform float uWaves[4];
      uniform float uReveal;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n2(vec2 p){
        vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
        float a=hash(i), b=hash(i+vec2(1.0,0.0)), c=hash(i+vec2(0.0,1.0)), d=hash(i+vec2(1.0,1.0));
        return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
      }
      float terrain(vec2 q){
        return n2(q * 0.016) * 0.45 + n2(q * 0.062) * 0.33 + n2(q * 0.26) * 0.22;
      }
      void main(){
        vec3 Ng = normalize(vWorld - uCenter);      // analytic sphere normal
        vec3 V  = normalize(cameraPosition - vWorld);
        vec2 q = vWorld.xz;
        float e = 0.12;
        float h0 = terrain(q);
        float hx = terrain(q + vec2(e, 0.0));
        float hz = terrain(q + vec2(0.0, e));
        vec3 N = normalize(Ng + vec3((h0 - hx) * 6.0, 0.0, (h0 - hz) * 6.0));
        vec3 L = normalize(vec3(-0.55, 0.50, 0.40));
        float diff = max(dot(N, L), 0.0);

        // dark basalt with violet dust in the low ground (hamol tonal range)
        vec3 rock = mix(vec3(0.016, 0.015, 0.028), vec3(0.105, 0.097, 0.128), smoothstep(0.18, 0.86, h0));
        rock = mix(rock, vec3(0.150, 0.142, 0.176), smoothstep(0.78, 1.0, h0));
        float grain = n2(q * 1.1) * 0.6 + n2(q * 3.7) * 0.4;
        vec3 col = rock * (0.30 + 1.35 * diff) * (0.78 + grain * 0.44);
        col *= 0.86 + 0.28 * n2(q * 0.55);
        // finale: the basalt picks up the azure sky (cold bounce from above)
        col = mix(col, col * vec3(0.80, 0.93, 1.20) + vec3(0.004, 0.014, 0.036), uReveal * 0.8);
        // ridged crater rims catch the key light
        float ridge = 1.0 - abs(2.0 * n2(q * 0.055 + 17.0) - 1.0);
        ridge = pow(ridge, 4.0);
        col += vec3(0.055, 0.050, 0.070) * ridge * (0.35 + 0.65 * diff);
        col += vec3(0.022, 0.015, 0.050) * (0.5 + 0.5 * Ng.y);

        // airlight: the surface recedes into the atmosphere near the limb
        float dist = length(q - uCam);
        float haze = smoothstep(60.0, 320.0, dist);
        vec3 hazeCol = mix(vec3(0.055, 0.038, 0.100), vec3(0.045, 0.140, 0.310), uReveal);
        col = mix(col, hazeCol, haze * mix(0.85, 0.92, uReveal));

        // razor limb line + soft underglow, exact on the silhouette
        float mu = max(dot(Ng, V), 0.0);
        vec3 rimCol = mix(vec3(0.70, 0.68, 1.0), vec3(0.58, 0.82, 1.0), uReveal);
        col += rimCol * pow(1.0 - mu, 40.0) * mix(1.25, 1.55, uReveal);
        col += mix(vec3(0.30, 0.24, 0.55), vec3(0.16, 0.36, 0.66), uReveal) * pow(1.0 - mu, 6.0) * 0.35;

        // mark light pool + heartbeat rings live in the surface itself
        float md = length(q - uMark);
        float core = exp(-md * md / 26.0);
        float halo = exp(-md * md / 190.0);
        col += mix(vec3(0.30, 0.17, 0.62), vec3(0.82, 0.70, 1.0), core) *
               (halo * 0.045 + core * 0.05) * (1.0 + uPulse * 0.8);
        float rings = 0.0;
        for (int i = 0; i < 4; i++) {
          float t = (uTime + uWaves[i]) / 1.2;
          if (t > 0.0 && t < 1.0) {
            float r = t * 30.0;
            rings += smoothstep(2.0, 0.0, abs(md - r)) * (1.0 - t) * (1.0 - t);
          }
        }
        col += vec3(0.55, 0.42, 0.95) * rings * 0.30;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const planet = new THREE.Mesh(
    new THREE.SphereGeometry(PLANET_RADIUS, 384, 96, 0, Math.PI * 2, 0, 0.42),
    groundMat,
  );
  planet.position.copy(PLANET_CENTER);
  planet.renderOrder = -2;
  planet.frustumCulled = false;
  scene.add(planet);

  /* ---------- finale ring reveal (reference tS / Ore shader, ported) ----------
     The camera dives through the held torus and a thick glowing ring opens from
     its hole until the frame is filled with the site's space ink. Every
     constant is the reference's own; their page texture is replaced by the ink
     the About page itself sits on, so the reveal and the page merge. */
  // cloud noise calibrated to the reference /noise.jpg (mean 127, stdev 40):
  // five wrapped value-noise octaves, then a histogram stretch so the ring
  // boundary gets the same soft organic lumps instead of uniform jitter
  const finaleNoiseN = 256;
  const finaleNoiseData = new Uint8Array(finaleNoiseN * finaleNoiseN * 4);
  {
    const finaleRand = mulberry32(20261107);
    const freqs = [4, 8, 16, 32, 64];
    const lattices = freqs.map((freq) => {
      const grid = new Float32Array(freq * freq);
      for (let i = 0; i < grid.length; i++) grid[i] = finaleRand();
      return grid;
    });
    const fade = (x: number) => x * x * (3 - 2 * x);
    const sampleLayer = (grid: Float32Array, freq: number, x: number, y: number) => {
      const gx = (x / finaleNoiseN) * freq;
      const gy = (y / finaleNoiseN) * freq;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const fx = fade(gx - x0);
      const fy = fade(gy - y0);
      const xa = x0 % freq;
      const xb = (x0 + 1) % freq;
      const ya = y0 % freq;
      const yb = (y0 + 1) % freq;
      const top = grid[ya * freq + xa] * (1 - fx) + grid[ya * freq + xb] * fx;
      const bottom = grid[yb * freq + xa] * (1 - fx) + grid[yb * freq + xb] * fx;
      return top * (1 - fy) + bottom * fy;
    };
    const raw = new Float32Array(finaleNoiseN * finaleNoiseN);
    let sum = 0;
    let sumSq = 0;
    for (let y = 0; y < finaleNoiseN; y++) {
      for (let x = 0; x < finaleNoiseN; x++) {
        let value = 0;
        let amp = 0.5;
        let total = 0;
        for (let o = 0; o < freqs.length; o++) {
          value += sampleLayer(lattices[o], freqs[o], x, y) * amp;
          total += amp;
          amp *= 0.5;
        }
        value /= total;
        raw[y * finaleNoiseN + x] = value;
        sum += value;
        sumSq += value * value;
      }
    }
    const mean = sum / raw.length;
    const variance = Math.max(1e-6, sumSq / raw.length - mean * mean);
    const stretch = 40 / Math.sqrt(variance);
    for (let i = 0; i < raw.length; i++) {
      const value = Math.max(0, Math.min(255, Math.round(127.5 + (raw[i] - mean) * stretch)));
      finaleNoiseData[i * 4] = value;
      finaleNoiseData[i * 4 + 1] = value;
      finaleNoiseData[i * 4 + 2] = value;
      finaleNoiseData[i * 4 + 3] = 255;
    }
  }
  const finaleNoise = new THREE.DataTexture(
    finaleNoiseData,
    finaleNoiseN,
    finaleNoiseN,
    THREE.RGBAFormat,
  );
  finaleNoise.wrapS = THREE.RepeatWrapping;
  finaleNoise.wrapT = THREE.RepeatWrapping;
  finaleNoise.minFilter = THREE.LinearFilter;
  finaleNoise.magFilter = THREE.LinearFilter;
  finaleNoise.needsUpdate = true;

  const rtFinale = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
  });
  const finaleUniforms = {
    uScene: { value: rtFinale.texture as THREE.Texture },
    uNoise: { value: finaleNoise as THREE.Texture },
    uReveal: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uCenter: { value: new THREE.Vector2(0.5, 0.53) },
    uFill: { value: new THREE.Vector3(15 / 255, 13 / 255, 26 / 255) },
    uNoiseStrength: { value: 0.2 },
    uRingWidth: { value: 2 },
    uRingSharpness: { value: 10 },
    uRingGlow: { value: 1.8 },
    uRingColor: { value: new THREE.Vector3(181 / 255, 123 / 255, 1.0) },
    uEdgeSoftness: { value: 0.05 },
  };
  const finaleMat = new THREE.ShaderMaterial({
    uniforms: finaleUniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: `varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }`,
    fragmentShader: `precision highp float;
      uniform sampler2D uScene;
      uniform sampler2D uNoise;
      uniform float uReveal;
      uniform vec2 uResolution;
      uniform vec2 uCenter;
      uniform vec3 uFill;
      uniform float uNoiseStrength;
      uniform float uRingWidth;
      uniform float uRingSharpness;
      uniform float uRingGlow;
      uniform vec3 uRingColor;
      uniform float uEdgeSoftness;
      varying vec2 vUv;

      void main() {
        if (uReveal <= 0.001) {
          gl_FragColor = texture2D(uScene, vUv);
          return;
        }
        if (uReveal >= 0.999) {
          gl_FragColor = vec4(uFill, 1.0);
          return;
        }

        float t = uReveal;
        vec2 uv = vUv;
        float aspect = uResolution.x / uResolution.y;
        vec2 coord = (uv - uCenter) * vec2(aspect, 1.0);
        float distToCenter = length(coord);

        vec2 noiseUv = (uv - 0.5) * 0.8 + 0.5;
        float noiseVal = texture2D(uNoise, noiseUv).r - 0.5;
        float noiseMask = smoothstep(0.0, 0.4, t) * smoothstep(1.0, 0.6, t);
        float distortion = noiseVal * uNoiseStrength * noiseMask;

        vec2 farCorner = max(uCenter, vec2(1.0) - uCenter) * vec2(aspect, 1.0);
        float maxRadius = length(farCorner) * 1.3;
        float radius = maxRadius * t;
        float circle = radius - distToCenter + distortion;

        float ringEnvelope = pow(1.0 - t, 0.6);
        float primaryRing = pow(clamp(1.0 - abs(circle * uRingWidth), 0.0, 1.0), uRingSharpness);
        float secondaryRing = pow(clamp(1.0 - abs((circle - 0.06) * uRingWidth * 0.5), 0.0, 1.0), uRingSharpness * 0.5) * 0.3;
        float ringFactor = ringEnvelope * (primaryRing + secondaryRing);

        float revealMask = smoothstep(-uEdgeSoftness, uEdgeSoftness, circle);
        float edgeFade = smoothstep(0.0, 0.08, t);
        float effectiveReveal = revealMask * edgeFade;
        float glowIntensity = ringFactor * uRingGlow;

        // reference outro branch: the scene composited raw (no lens/CA/
        // desaturation), a foreground page taking over inside the ring. The
        // fill fades in behind the ring so the onset reads as a hollow donut
        // over the scene, exactly like the recording, then ink-opens the page
        float fill = smoothstep(0.02, 0.42, t);
        vec3 bg = texture2D(uScene, uv).rgb;
        vec3 rgb = mix(bg, uFill, effectiveReveal * fill);
        rgb = mix(rgb, uRingColor, glowIntensity * 0.5 * edgeFade);
        gl_FragColor = vec4(rgb, 1.0);
      }`,
  });
  const finaleGeo = new THREE.PlaneGeometry(2, 2);
  const finaleScene = new THREE.Scene();
  const finaleCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  finaleScene.add(new THREE.Mesh(finaleGeo, finaleMat));
  let revealCenterLocked = false;

  /* shapes: each sampled at its own proportions, then normalized so every
     scene occupies the same frame footprint (the reference orb scale) */
  const rand = mulberry32(20261105);
  const SHAPES: Float32Array[] = [
    sampleGlyph(COUNT, rand),
    sampleCube(COUNT, rand),
    sampleSphere(COUNT, rand),
    sampleHeart(COUNT, rand),
    sampleTorus(COUNT, rand),
  ];
  for (const data of SHAPES) {
    let maxR2 = 0;
    for (let i = 0; i < data.length; i += 3) {
      maxR2 = Math.max(maxR2, data[i] ** 2 + data[i + 1] ** 2 + data[i + 2] ** 2);
    }
    const s = 0.66 / Math.sqrt(maxR2);
    for (let i = 0; i < data.length; i++) data[i] *= s;
  }
  const targetTextures = SHAPES.map((data) => {
    const rgba = new Float32Array(COUNT * 4);
    for (let i = 0; i < COUNT; i++) {
      rgba[i * 4] = data[i * 3];
      rgba[i * 4 + 1] = data[i * 3 + 1];
      rgba[i * 4 + 2] = data[i * 3 + 2];
      rgba[i * 4 + 3] = 1;
    }
    const t = new THREE.DataTexture(rgba, TEX, TEX, THREE.RGBAFormat, THREE.FloatType);
    t.needsUpdate = true;
    return t;
  });

  /* GPGPU ping-pong (position+glow, velocity+scatter) */
  const rtOpts = {
    type: THREE.FloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
  } as const;
  const rtPos = [new THREE.WebGLRenderTarget(TEX, TEX, rtOpts), new THREE.WebGLRenderTarget(TEX, TEX, rtOpts)];
  const rtVel = [new THREE.WebGLRenderTarget(TEX, TEX, rtOpts), new THREE.WebGLRenderTarget(TEX, TEX, rtOpts)];
  let ping = 0;

  const simUniforms = {
    time: { value: 0 },
    delta: { value: 0.016 },
    springStiffness: { value: SPRING_STIFFNESS },
    damping: { value: VELOCITY_DAMPING },
    viscosity: { value: VISCOSITY },
    flowStrength: { value: FLOW_STRENGTH },
    flowScale: { value: FLOW_SCALE },
    flowSpeed: { value: FLOW_SPEED },
    returnSharpness: { value: RETURN_SHARPNESS },
    scatterDuration: { value: SCATTER_DURATION },
    pulseAmplitude: { value: PULSE_AMPLITUDE },
    burstIntensity: { value: 0 },
    uMouseUV: { value: new THREE.Vector2(0.5, 0.5) },
    uMouseVel: { value: new THREE.Vector2(0, 0) },
    uAspect: { value: 1 },
    uImpulseScale: { value: 0.2 }, // ratio of our smaller mark footprint to the reference's
    uMVP: { value: new THREE.Matrix4() },
    uCamRight: { value: new THREE.Vector3(1, 0, 0) },
    uCamUp: { value: new THREE.Vector3(0, 1, 0) },
    uInteractForce: { value: 1 },
    repulsionStrength: { value: REPULSION_STRENGTH },
    repulsionRadius: { value: REPULSION_RADIUS },
    texturePosition: { value: null as THREE.Texture | null },
    textureVelocity: { value: null as THREE.Texture | null },
    textureTarget: { value: targetTextures[0] as THREE.Texture },
  };
  const simScene = new THREE.Scene();
  const simCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const simVelMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: SIM_VERT, fragmentShader: SIM_VEL_FRAG, uniforms: simUniforms });
  const simPosMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: SIM_VERT, fragmentShader: SIM_POS_FRAG, uniforms: simUniforms });
  const simVelQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), simVelMat);
  const simPosQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), simPosMat);
  simScene.add(simVelQuad);
  simScene.add(simPosQuad);

  // init pass: pos = shape0, vel = 0
  {
    const initPos = new Float32Array(COUNT * 4);
    for (let i = 0; i < COUNT; i++) {
      initPos[i * 4] = SHAPES[0][i * 3];
      initPos[i * 4 + 1] = SHAPES[0][i * 3 + 1];
      initPos[i * 4 + 2] = SHAPES[0][i * 3 + 2];
      initPos[i * 4 + 3] = 0;
    }
    const ip = new THREE.DataTexture(initPos, TEX, TEX, THREE.RGBAFormat, THREE.FloatType);
    ip.needsUpdate = true;
    const copyMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SIM_VERT,
      fragmentShader: `precision highp float; in vec2 vUv; uniform sampler2D tex;
        layout(location = 0) out vec4 o; void main(){ o = texture(tex, vUv); }`,
      uniforms: { tex: { value: ip } },
    });
    const copyQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), copyMat);
    const copyScene = new THREE.Scene();
    copyScene.add(copyQuad);
    renderer.setRenderTarget(rtPos[0]);
    renderer.render(copyScene, simCam);
    renderer.setRenderTarget(rtVel[0]);
    renderer.render(copyScene, simCam);
    renderer.setRenderTarget(null);
    copyMat.dispose();
    ip.dispose();
  }

  /* render points */
  const geo = new THREE.BufferGeometry();
  const texCoords = new Float32Array(COUNT * 2);
  const colors = new Float32Array(COUNT * 3);
  const hashes = new Float32Array(COUNT);
  {
    const r2 = mulberry32(777);
    const pal = [PALETTE.PRIMARY, PALETTE.SECONDARY, PALETTE.TERTIARY, PALETTE.DEEP, PALETTE.WHITE];
    const weights = [0.40, 0.26, 0.20, 0.12, 0.02];
    for (let i = 0; i < COUNT; i++) {
      texCoords[i * 2] = ((i % TEX) + 0.5) / TEX;
      texCoords[i * 2 + 1] = (Math.floor(i / TEX) + 0.5) / TEX;
      let pick = r2();
      let c = pal[0];
      for (let k = 0; k < pal.length; k++) {
        if (pick < weights[k]) {
          c = pal[k];
          break;
        }
        pick -= weights[k];
      }
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
      hashes[i] = r2();
    }
  }
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
  geo.setAttribute("texCoord", new THREE.BufferAttribute(texCoords, 2));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("aHash", new THREE.BufferAttribute(hashes, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 60);

  const renderUniforms = {
    positionTexture: { value: null as THREE.Texture | null },
    velocityTexture: { value: null as THREE.Texture | null },
    extrapolateTau: { value: 0.5 },
    size: { value: PARTICLE_SIZE },
    pixelRatio: { value: dpr },
    centerGlowSize: { value: 0.7 },
    centerGlowPulse: { value: 1 },
    centerGlowBoost: { value: 0 },
    GLOW_COLOR_U: { value: GLOW_COLOR },
    CENTER_GLOW_COLOR_U: { value: CENTER_GLOW_COLOR },
    CENTER_GLOW_OPACITY_U: { value: 0.10 },
    TINT_COLOR_U: { value: TINT_COLOR },
    ENERGY_COLOR_U: { value: ENERGY_COLOR },
    burstIntensity: { value: 0 },
    uTime: { value: 0 },
    lightDirView: { value: new THREE.Vector3().copy(LIGHT_DIR) },
    halfDirView: { value: new THREE.Vector3().copy(LIGHT_DIR).add(new THREE.Vector3(0, 0, 1)).normalize() },
    uPresence: { value: 1 },
    rimColorCool: { value: RIM_COLOR_COOL },
    rimColorWarm: { value: RIM_COLOR_WARM },
    specColor: { value: SPEC_COLOR },
  };
  const makePointsMat = (presence: number, depthWrite: boolean) =>
    new THREE.ShaderMaterial({
      vertexShader: RENDER_VERT,
      fragmentShader: RENDER_FRAG,
      uniforms: { ...renderUniforms, uPresence: { value: presence } },
      transparent: true,
      depthWrite,
      depthTest: true,
    });
  const pointsMat = makePointsMat(1, true);

  const WORLD_SCALE = 7.15; // unit-space sim -> world-size mark (~33% frame width)
  const NARROW_SCALE = 0.42;
  const markScale = () => WORLD_SCALE * (camera.aspect < 0.9 ? NARROW_SCALE : 1);
  const markPointSize = () => PARTICLE_SIZE * (camera.aspect < 0.9 ? 0.38 : 1);
  renderUniforms.size.value = markPointSize();
  const points = new THREE.Points(geo, pointsMat);
  points.position.set(markX(), MARK_Y, 0);
  points.scale.setScalar(markScale());
  points.frustumCulled = false;
  points.renderOrder = 2;
  scene.add(points);

  /* embers */
  const EMBER_N = tierHigh ? 3000 : 2000;
  const emberGeo = new THREE.BufferGeometry();
  const eSpawnPos = new Float32Array(EMBER_N * 3);
  const eVel = new Float32Array(EMBER_N * 3);
  const eSpawn = new Float32Array(EMBER_N).fill(-1);
  const eLife = new Float32Array(EMBER_N);
  const ePhase = new Float32Array(EMBER_N);
  for (let i = 0; i < EMBER_N; i++) {
    eLife[i] = 1.2 + rand() * 1.8;
    ePhase[i] = rand();
  }
  emberGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(EMBER_N * 3), 3));
  emberGeo.setAttribute("aSpawnPos", new THREE.BufferAttribute(eSpawnPos, 3));
  emberGeo.setAttribute("aVelocity", new THREE.BufferAttribute(eVel, 3));
  emberGeo.setAttribute("aSpawnTime", new THREE.BufferAttribute(eSpawn, 1));
  emberGeo.setAttribute("aLifetime", new THREE.BufferAttribute(eLife, 1));
  emberGeo.setAttribute("aPhase", new THREE.BufferAttribute(ePhase, 1));
  emberGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 60);
  const emberUniforms = {
    time: { value: 0 },
    size: { value: PARTICLE_SIZE * 0.5 },
    pixelRatio: { value: dpr },
    color: { value: PALETTE.TERTIARY },
    glowColor: { value: CENTER_GLOW_COLOR },
  };
  const emberMat = new THREE.ShaderMaterial({
    vertexShader: EMBER_VERT,
    fragmentShader: EMBER_FRAG,
    uniforms: emberUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const embers = new THREE.Points(emberGeo, emberMat);
  embers.position.copy(points.position);
  embers.scale.setScalar(markScale());
  embers.frustumCulled = false;
  embers.renderOrder = 3;
  scene.add(embers);

  /* dust / fireflies — spread around the whole stage so the orbit never empties out */
  const dustGeo = new THREE.BufferGeometry();
  const DUST_N = 280;
  const dustPos = new Float32Array(DUST_N * 3);
  const DUST_CEIL = 30;
  for (let i = 0; i < DUST_N; i++) {
    dustPos[i * 3] = (rand() - 0.5) * 130;
    dustPos[i * 3 + 1] = GROUND_Y + 2 + rand() * (DUST_CEIL - GROUND_Y - 2);
    dustPos[i * 3 + 2] = (rand() - 0.5) * 130;
  }
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(
    dustGeo,
    new THREE.PointsMaterial({ color: 0xb57bff, size: 0.07, transparent: true, opacity: 0.5, depthWrite: false }),
  );
  dust.renderOrder = 4;
  scene.add(dust);

  /* state + loop */
  let sceneIdx = 0;
  let burst = 0;
  let pulseIntensity = 0;
  let prevHeartbeatFired = false;
  let suppressUntil = 0;
  let springScale = 1;
  let elapsed = 0;
  let last = performance.now();
  let raf = 0;
  const mouseUV = new THREE.Vector2(0.5, 0.5);
  const mouseVel = new THREE.Vector2(0, 0);
  const pointerNDC = new THREE.Vector2(0, 0);
  const smoothNDC = new THREE.Vector2(0, 0);
  let pointerSeeded = false;
  let pointerIdle = 999;
  let smoothedYaw = 0;
  let smoothedPitch = 0;
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  const parallaxQ = new THREE.Quaternion();
  const parallaxQ2 = new THREE.Quaternion();
  const parallaxLook = new THREE.Vector3();
  const parallaxView = new THREE.Vector3();
  const parallaxRight = new THREE.Vector3();
  const interactRef = { value: 0 };
  const progressRef = { value: 0 };

  const spawnHeartbeat = () => {
    // reference spawnBatch: batch embers from random shape-surface points,
    // radial velocity + jitter, lifetime 2.3 * (0.6..1.4)
    const BATCH = Math.floor(EMBER_N * 0.12);
    const src = SHAPES[sceneIdx];
    for (let k = 0; k < BATCH; k++) {
      const idx2 = Math.floor(Math.random() * COUNT);
      eSpawn[k] = elapsed;
      const sx = src[idx2 * 3];
      const sy = src[idx2 * 3 + 1];
      const sz = src[idx2 * 3 + 2];
      eSpawnPos[k * 3] = sx;
      eSpawnPos[k * 3 + 1] = sy;
      eSpawnPos[k * 3 + 2] = sz;
      const len = Math.max(0.001, Math.hypot(sx, sy, sz));
      const sp = 0.7 + Math.random() * 1.5;
      eVel[k * 3] = (sx / len) * sp + (Math.random() - 0.5) * 0.35;
      eVel[k * 3 + 1] = (sy / len) * sp + (Math.random() - 0.5) * 0.35 + 0.3;
      eVel[k * 3 + 2] = (sz / len) * sp + (Math.random() - 0.5) * 0.35;
      eLife[k] = 2.3 * (0.6 + Math.random() * 0.8);
    }
    (emberGeo.attributes.aSpawnPos as THREE.BufferAttribute).needsUpdate = true;
    (emberGeo.attributes.aVelocity as THREE.BufferAttribute).needsUpdate = true;
    (emberGeo.attributes.aSpawnTime as THREE.BufferAttribute).needsUpdate = true;
    (emberGeo.attributes.aLifetime as THREE.BufferAttribute).needsUpdate = true;
    // floor ripple: 4-slot wave ring buffer (reference triggerWave)
    waveTimes[waterWaveIdx % 4] = -elapsed;
    waterWaveIdx++;
  };
  let waterWaveIdx = 0;

  const spawnEmbers = () => {
    for (let k = 0; k < EMBER_N; k++) {
      if (Math.random() < 0.5) {
        eSpawn[k] = elapsed;
        const src = SHAPES[sceneIdx];
        const i = Math.floor(Math.random() * COUNT);
        const sx = src[i * 3];
        const sy = src[i * 3 + 1];
        const sz = src[i * 3 + 2];
        eSpawnPos[k * 3] = sx;
        eSpawnPos[k * 3 + 1] = sy;
        eSpawnPos[k * 3 + 2] = sz;
        const len = Math.max(0.001, Math.hypot(sx, sy, sz));
        const sp = 0.55 + Math.random() * 1.0;
        eVel[k * 3] = (sx / len) * sp + (Math.random() - 0.5) * 2;
        eVel[k * 3 + 1] = Math.abs(sy / len) * sp * 0.7 + 0.5 + Math.random() * 0.6;
        eVel[k * 3 + 2] = (sz / len) * sp * 0.5;
      }
    }
    (emberGeo.attributes.aSpawnPos as THREE.BufferAttribute).needsUpdate = true;
    (emberGeo.attributes.aVelocity as THREE.BufferAttribute).needsUpdate = true;
    (emberGeo.attributes.aSpawnTime as THREE.BufferAttribute).needsUpdate = true;
  };

  const reduced = opts.reducedMotion ?? false;
  let finaleWarmed = false;

  const tick = (present = true) => {
    const now = performance.now();
    const delta = Math.min(0.033, Math.max(0.001, (now - last) / 1000));
    last = now;
    elapsed += delta;

    // softenRetarget recovery
    springScale += (1 - springScale) * Math.min(1, delta * 2.2);
    simUniforms.springStiffness.value = SPRING_STIFFNESS * springScale;

    // energy heartbeat: every 2s a burst fires in the 0.8-0.9 phase window
    const hbPhase = (elapsed * BURST_SPEED) % 1;
    const inWindow = hbPhase > HEARTBEAT_WINDOW[0] && hbPhase < HEARTBEAT_WINDOW[1];
    const suppressed = elapsed < suppressUntil;
    if (inWindow && !prevHeartbeatFired && !suppressed) {
      spawnHeartbeat();
      opts.onBeat?.();
      pulseIntensity = 1; // sim kick ties ONLY to pulse (fast reference decay)
    }
    prevHeartbeatFired = inWindow;
    pulseIntensity *= Math.pow(PULSE_DECAY, delta);
    if (burst > 0) burst = Math.max(0, burst - delta * 2.4);
    const effBurst = Math.max(burst, pulseIntensity * PULSE_KICK);
    simUniforms.burstIntensity.value = effBurst;
    renderUniforms.burstIntensity.value = effBurst;
    renderUniforms.centerGlowPulse.value = 1 + pulseIntensity * PULSE_AMPLITUDE_GLOW;
    renderUniforms.centerGlowBoost.value = pulseIntensity * 0.3;

    // environment life: nebula drift, star twinkle, ground haze follows the camera
    domeUniforms.uTime.value = elapsed;
    farStars.uniforms.uTime.value = elapsed;
    nearStars.uniforms.uTime.value = elapsed;
    brightStars.uniforms.uTime.value = elapsed;
    groundUniforms.uTime.value = elapsed;

    // rare shooting star
    if (!reduced) {
      if (!shootActive && elapsed >= nextShootAt) spawnShoot();
      if (shootActive) {
        shootAge += delta;
        const t = shootAge / shootLife;
        if (t >= 1) {
          shootActive = false;
          shoot.visible = false;
          shootUniforms.uOpacity.value = 0;
          nextShootAt = elapsed + 15 + Math.random() * 10;
        } else {
          shoot.visible = true;
          shoot.position.addScaledVector(shootDir, delta * shootSpeed);
          shootUniforms.uOpacity.value = Math.sin(Math.PI * t) * 0.85;
        }
      }
    }
    groundUniforms.uPulse.value = pulseIntensity * 0.5;

    // pointer: reference updatePointer — 0.2/frame position lerp, velocity
    // accumulated from the residual then decayed 0.6/frame; full force is held
    // for 3 s after the last motion, then fades out over 1 s
    const fStep = Math.min(Math.max(delta * 60, 0), 2);
    if (!pointerSeeded) {
      smoothNDC.copy(pointerNDC);
      mouseVel.set(0, 0);
      pointerSeeded = true;
    } else {
      const posK = 1 - Math.pow(0.8, fStep);
      smoothNDC.x += (pointerNDC.x - smoothNDC.x) * posK;
      smoothNDC.y += (pointerNDC.y - smoothNDC.y) * posK;
      mouseVel.x += (pointerNDC.x - smoothNDC.x) * 0.5 * fStep;
      mouseVel.y += (pointerNDC.y - smoothNDC.y) * 0.5 * fStep;
      mouseVel.multiplyScalar(Math.pow(0.6, fStep));
    }
    pointerIdle = mouseVel.lengthSq() > 1e-8 ? 0 : pointerIdle + delta;
    interactRef.value = pointerIdle < 3 ? 1 : Math.max(0, 1 - (pointerIdle - 3));
    simUniforms.uMouseVel.value.copy(mouseVel);
    simUniforms.uMouseUV.value.copy(mouseUV);
    simUniforms.uInteractForce.value = interactRef.value;

    camera.updateMatrixWorld();
    points.updateMatrixWorld();
    // reference multiplies the model matrix — the mask must project RENDER-space
    // positions (scale 8.2 + translate), not raw unit-space sim positions
    simUniforms.uMVP.value
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .multiply(points.matrixWorld);
    const m = camera.matrixWorld.elements;
    const modelInv = new THREE.Matrix4().copy(points.matrixWorld).invert();
    (simUniforms.uCamRight.value as THREE.Vector3)
      .set(m[0], m[1], m[2])
      .transformDirection(modelInv);
    (simUniforms.uCamUp.value as THREE.Vector3)
      .set(m[4], m[5], m[6])
      .transformDirection(modelInv);
    simUniforms.uAspect.value = camera.aspect;

    // hover sound strength: pointer speed × the force envelope × proximity to
    // the mark, gated by the same falloff as the shader's interaction mask
    if (opts.onHover) {
      const c = new THREE.Vector3(points.position.x, points.position.y, points.position.z).project(camera);
      const edge = new THREE.Vector3(points.position.x + points.scale.x * 0.62, points.position.y, points.position.z).project(camera);
      const radius = Math.abs((edge.x - c.x) * 0.5 * camera.aspect);
      const dx = (mouseUV.x - (c.x + 1) / 2) * camera.aspect;
      const dy = mouseUV.y - (c.y + 1) / 2;
      const d = Math.hypot(dx, dy);
      const t = Math.min(1, Math.max(0, (d - radius - 0.025) / 0.035));
      const proximity = 1 - t * t * (3 - 2 * t);
      const speed = Math.min(1, mouseVel.length() * 10);
      opts.onHover(speed * interactRef.value * proximity);
    }
    simUniforms.time.value = elapsed;
    simUniforms.delta.value = delta;
    emberUniforms.time.value = elapsed;
    renderUniforms.uTime.value = elapsed;

    // sim pass 1: velocity
    simUniforms.texturePosition.value = rtPos[ping].texture;
    simUniforms.textureVelocity.value = rtVel[ping].texture;
    simVelQuad.visible = true;
    simPosQuad.visible = false;
    renderer.setRenderTarget(rtVel[1 - ping]);
    renderer.render(simScene, simCam);

    // sim pass 2: position (reads NEW velocity)
    simUniforms.textureVelocity.value = rtVel[1 - ping].texture;
    simVelQuad.visible = false;
    simPosQuad.visible = true;
    renderer.setRenderTarget(rtPos[1 - ping]);
    renderer.render(simScene, simCam);

    renderer.setRenderTarget(null);
    ping = 1 - ping;

    const bypass = (window as unknown as { __bypassSim?: boolean }).__bypassSim;
    renderUniforms.positionTexture.value = bypass ? targetTextures[0] : rtPos[ping].texture;
    renderUniforms.velocityTexture.value = bypass ? targetTextures[0] : rtVel[ping].texture;

    // orbit camera (reference grammar): full revolution, dip closer+lower mid-journey
    const p = progressRef.value;
    const angle = ORBIT_INITIAL_ANGLE + p * Math.PI * 2;
    const dip = Math.sin(p * Math.PI) ** 2;
    const radius = ORBIT_RADIUS - (ORBIT_RADIUS - ORBIT_RADIUS * ORBIT_CLOSE_FACTOR) * dip;
    const oy = ORBIT_Y - 5 * dip;
    // keep the mark at a steady frame footprint through the approach (reference
    // orb holds ~1/3 width) while the camera still gains depth from the limb
    const distComp = 1 - (1 - ORBIT_CLOSE_FACTOR) * dip;
    camera.position.set(
      points.position.x + radius * Math.sin(angle),
      oy,
      radius * Math.cos(angle),
    );
    // finale fly-in: the camera converges onto the hole axis and parks just in
    // front of the torus plane so the ring reveal opens while the torus still
    // frames the viewport (the reference never crosses the plane on screen)
    const FLY_START = 0.88;
    const FLY_END = 0.94;
    let flyT = 0;
    if (p > FLY_START) {
      flyT = easeSmooth(Math.min(1, (p - FLY_START) / (FLY_END - FLY_START)));
      camera.position.set(
        points.position.x + radius * Math.sin(angle) * (1 - flyT),
        oy * (1 - flyT) + points.position.y * flyT,
        radius * Math.cos(angle) * (1 - flyT) + 5.0 * flyT,
      );
    }
    // per-station mark footprint; the finale returns it to neutral for the dive
    const wide = camera.aspect < 0.9 ? 0 : 1;
    const stageScale = wide ? stationAt(STAGE_SCALES, p) : 1;
    const stageS = stageScale * (1 - flyT) + flyT;
    points.scale.setScalar(markScale() * distComp * stageS);
    embers.scale.setScalar(markScale() * distComp * stageS);
    renderUniforms.size.value = markPointSize() * distComp;
    emberUniforms.size.value = markPointSize() * 0.5 * distComp;
    // lookAt: particles anchor + per-scene offsets (smoothstepped between stops);
    // during the fly-through the view turns forward through the hole (never looks back)
    const stops = LOOKAT_OFFSETS;
    const t = easeSmooth(p) * (stops.length - 1);
    const seg = Math.min(Math.floor(t), stops.length - 2);
    const f = t - seg;
    const a = stops[seg];
    const b = stops[seg + 1];
    const lz = points.position.z + a[2] + (b[2] - a[2]) * f;
    // composition: hold the mark in the frame gap left by the statement. shift
    // along the camera's own right vector so it stays put through the orbit
    const stageX = wide ? stationAt(STAGE_X, p) : 0;
    const stageY = wide ? stationAt(STAGE_Y, p) : 1.2;
    const compAmount = stageX * (1 - flyT);
    const compX = -compAmount * Math.cos(angle);
    const compZ = compAmount * Math.sin(angle);
    const compY = -stageY * (1 - flyT);
    const lookX = points.position.x + compX;
    const lookY = points.position.y + compY;
    const lookZ = lz + compZ;
    camera.lookAt(lookX, lookY, lookZ);
    // pointer parallax (reference composeCamera): the whole world rotates around
    // the look-at point — 0.025 rad yaw, pitch *0.1, 0.08/frame lerp. Far layers
    // therefore sway ~10-20 px while the HTML type stays put. Fades out through
    // the finale dive so the fly-through stays on rails.
    const parallaxWeight = 1 - Math.min(1, Math.max(0, (p - 0.85) / 0.05));
    const rotK = 1 - Math.pow(0.92, Math.min(delta * 60, 3));
    const targetYaw = pointerNDC.x * 0.025 * parallaxWeight;
    const targetPitch = -pointerNDC.y * 0.025 * parallaxWeight;
    smoothedYaw += (targetYaw - smoothedYaw) * rotK;
    smoothedPitch += (targetPitch - smoothedPitch) * rotK;
    parallaxLook.set(lookX, lookY, lookZ);
    parallaxView.subVectors(parallaxLook, camera.position).normalize();
    parallaxRight.crossVectors(parallaxView, WORLD_UP).normalize();
    parallaxQ.setFromAxisAngle(WORLD_UP, smoothedYaw);
    parallaxQ.multiply(parallaxQ2.setFromAxisAngle(parallaxView, -smoothedYaw));
    parallaxQ.multiply(parallaxQ2.setFromAxisAngle(parallaxRight, smoothedPitch * 0.1));
    // orbit the camera around the look-at by the inverse rotation, so the whole
    // WebGL world (including the analytic limb) sways while the HTML type holds
    parallaxQ.conjugate();
    camera.position.sub(parallaxLook).applyQuaternion(parallaxQ).add(parallaxLook);
    camera.quaternion.premultiply(parallaxQ);
    // per-shape group rotation (heart faces the camera at its orbit azimuth)
    const rotT = easeSmooth(p) * (SHAPE_ROTATIONS.length - 1);
    const rotSeg = Math.min(Math.floor(rotT), SHAPE_ROTATIONS.length - 2);
    const rotF = rotT - rotSeg;
    let ry =
      SHAPE_ROTATIONS[rotSeg] + (SHAPE_ROTATIONS[rotSeg + 1] - SHAPE_ROTATIONS[rotSeg]) * rotF;
    // last scene: rotate the ring to face the camera (azimuth compensation) so
    // it reads frontal through the centred hold; once the camera parks on the
    // hole axis the target unwinds to zero
    if (p > 0.76) {
      const blend = Math.min(1, (p - 0.76) / 0.06);
      const frontal = -(Math.PI * 2 - angle) * (1 - flyT);
      ry = ry * (1 - blend) + frontal * blend;
    }
    // scroll-driven only — a time-based drift leaves the shape at a different
    // axis when the visitor scrolls back up to the same scene
    points.rotation.y = ry;
    groundUniforms.uCam.value.set(camera.position.x, camera.position.z);
    groundUniforms.uMark.value.set(points.position.x, points.position.z);

    // finale ring reveal: a violet ring opens from the torus hole as the camera
    // crosses its plane, until the ink field fills the frame. The centre is the
    // torus's projected position, frozen at onset so the ring never chases the
    // camera after it passes through. `fp` is journey progress, so the reveal
    // window maps to its own runway (100vh of scroll) in lib/journey.ts.
    const fp = progressRef.value;
    const revealT = easeSmooth(Math.min(1, Math.max(0, (fp - 0.94) / 0.05)));
    if (revealT > 0.0001 && !revealCenterLocked) {
      camera.updateMatrixWorld();
      const c = new THREE.Vector3(points.position.x, points.position.y, points.position.z).project(camera);
      finaleUniforms.uCenter.value.set((c.x + 1) / 2, (c.y + 1) / 2);
      revealCenterLocked = true;
    } else if (revealT <= 0.0001) {
      revealCenterLocked = false;
    }

    // dust drift
    const dp = dustGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < DUST_N; i++) {
      let y = dp.getY(i) + delta * (0.1 + (i % 7) * 0.02);
      if (y > DUST_CEIL) y = GROUND_Y + 2;
      dp.setY(i, y);
    }
    dp.needsUpdate = true;

    if (!present) return;

    if (revealT > 0.0001) {
      renderer.setRenderTarget(rtFinale);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      finaleUniforms.uReveal.value = revealT;
      renderer.render(finaleScene, finaleCam);
    } else {
      renderer.render(scene, camera);
    }

    // the ring's first frame would otherwise allocate the scene target and
    // compile every scene program for its linear output mid-dive; run one
    // full finale pass while the intro idles (uReveal 0 passes the scene through)
    if (!finaleWarmed && elapsed > 1.2 && revealT <= 0.0001) {
      finaleWarmed = true;
      renderer.setRenderTarget(rtFinale);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      finaleUniforms.uReveal.value = 0;
      renderer.render(finaleScene, finaleCam);
      // leave the presented frame on the normal path, not the warmup passthrough
      renderer.render(scene, camera);
    }

    raf = requestAnimationFrame(() => tick());
  };

  if (reduced) {
    // static frame: advance the sim without presenting, then render once —
    // rendering every step blocks the main thread for seconds on slow GPUs
    for (let i = 0; i < 30; i++) tick(false);
    renderer.setRenderTarget(null);
    camera.updateMatrixWorld();
    renderer.render(scene, camera);
  } else {
    raf = requestAnimationFrame(() => tick());
  }

  return {
    setScene(idx, dir = 1) {
      if (idx !== sceneIdx) {
        sceneIdx = idx;
        burst = 1;
        suppressUntil = elapsed + 1.1; // energyFiringSuppressed during transition
        simUniforms.textureTarget.value = targetTextures[idx];
        // the energy burst is a forward-transition event; replaying it on the
        // way back up leaves a white ember halo hanging around the mark
        if (dir > 0) spawnEmbers();
        springScale = 0.2; // softenRetarget: spring drops to 20%, tweens back
      }
    },
    setProgress(p) {
      progressRef.value = p;
    },
    setPointer(nx, ny) {
      // reference frame: dent centre follows the raw pointer, while the impulse
      // is driven by a smoothed pointer velocity (updatePointer in the tick)
      pointerNDC.set(nx, ny);
      mouseUV.set((nx + 1) / 2, (ny + 1) / 2);
      pointerIdle = 0;
    },
    resize(w, h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      const bw = Math.max(1, Math.round(w * dpr));
      const bh = Math.max(1, Math.round(h * dpr));
      rtFinale.setSize(bw, bh);
      finaleUniforms.uResolution.value.set(bw, bh);
      const cx = markX();
      points.position.x = cx;
      points.scale.setScalar(markScale());
      embers.scale.setScalar(markScale());
      renderUniforms.size.value = markPointSize();
      emberUniforms.size.value = markPointSize() * 0.5;
    },
    dispose() {
      cancelAnimationFrame(raf);
      rtPos.forEach((t) => t.dispose());
      rtVel.forEach((t) => t.dispose());
      geo.dispose();
      pointsMat.dispose();
      emberGeo.dispose();
      emberMat.dispose();
      simVelMat.dispose();
      simPosMat.dispose();
      targetTextures.forEach((t) => t.dispose());
      dome.geometry.dispose();
      domeMat.dispose();
      farStars.points.geometry.dispose();
      (farStars.points.material as THREE.Material).dispose();
      nearStars.points.geometry.dispose();
      (nearStars.points.material as THREE.Material).dispose();
      brightStars.points.geometry.dispose();
      (brightStars.points.material as THREE.Material).dispose();
      shoot.geometry.dispose();
      shootMat.dispose();
      planet.geometry.dispose();
      groundMat.dispose();
      rtFinale.dispose();
      finaleNoise.dispose();
      finaleGeo.dispose();
      finaleMat.dispose();
      dustGeo.dispose();
      (dust.material as THREE.Material).dispose();
      renderer.dispose();
    },
  };
}
