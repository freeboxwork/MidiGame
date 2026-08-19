import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { FXAAPass } from "three/addons/postprocessing/FXAAPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { HOLD_THRESHOLD_SECONDS } from "./chart-generator.js";

const LANE_SPACING = 1.2;
const TRACK_LEFT_X = -2.4;
const LANE_X = [-1.8, -0.6, 0.6, 1.8];
const LANE_COLORS = [0x22e3d5, 0x4b99ff, 0xb74ff4, 0xffbe58];
const TRACK_EDGE_COLORS = [0x35f6e7, 0x52a8ff, 0xd45cff, 0xffb85a, 0xffd58a];
const TRACK_LENGTH = 48;
const TRACK_FRONT_Z = 4.8;
const TRACK_CENTER_Z = TRACK_FRONT_Z - TRACK_LENGTH * 0.5;
const TRACK_FADE_START_Z = -13.5;
const TRACK_FADE_END_Z = -36;
const SCENE_PALETTE = {
  surface: 0x03060d,
  surfaceRaised: 0x080d17,
  boundary: 0x172538,
  materialEdge: 0x29415b,
  keyLight: 0xfff8f0,
  coolFill: 0x4b8dff,
  violetFill: 0x9b52ff,
};
const CAMERA_FRAMING = {
  desktopFov: 44,
  compactLandscapeFov: 52,
  compactHeightStart: 900,
  compactHeightEnd: 640,
  position: [0, 4.4, 9.9],
  target: [0, -0.65, -18.5],
};
const MIRROR_DEFAULTS = {
  tile: 0xd8f2ff,
  tileEmissive: 0x123f5a,
  baseEmissive: 0x071a2a,
  pulse: 0xd69cff,
};
const KEY_TO_LANE = { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3 };
const HIT_Z = 2.25;
const SPAWN_Z = -19;
const TRAVEL_SECONDS = 3.1;
const COUNTDOWN_SECONDS = 3;
const TRAVEL_DISTANCE = HIT_Z - SPAWN_Z;
const NOTE_BASE_DEPTH = 0.56;
const PAD_FOOTPRINT_SCALE = 0.9;
const PAD_REST_Y = 0.04;
const PAD_PRESS_TRAVEL = 0.085;
const GOOD_WINDOW = 0.18;
const HIT_EFFECT_PROFILES = {
  PERFECT: { intensity: 1, shards: 14, duration: 0.46 },
  GREAT: { intensity: 0.72, shards: 10, duration: 0.38 },
  GOOD: { intensity: 0.46, shards: 7, duration: 0.3 },
};
const HIT_CAMERA_SHAKE_PROFILES = {
  PERFECT: { strength: 0.72, duration: 0.15 },
  GREAT: { strength: 0.46, duration: 0.12 },
  GOOD: { strength: 0.27, duration: 0.095 },
};
const HIT_EFFECT_POOL_SIZE = 12;
const MAX_HIT_SHARDS = 14;
const JUDGEMENT_WINDOWS = [
  { name: "PERFECT", seconds: 0.06, points: 1000, accuracy: 1 },
  { name: "GREAT", seconds: 0.12, points: 700, accuracy: 0.78 },
  { name: "GOOD", seconds: GOOD_WINDOW, points: 350, accuracy: 0.45 },
];

function applyTrackDepthFade(
  material,
  fadeStart = TRACK_FADE_START_Z,
  fadeEnd = TRACK_FADE_END_Z,
) {
  material.transparent = true;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "void main() {",
        "varying float vTrackWorldZ;\nvoid main() {",
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvTrackWorldZ = (modelMatrix * vec4(transformed, 1.0)).z;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "void main() {",
        "varying float vTrackWorldZ;\nvoid main() {",
      )
      .replace(
        "#include <opaque_fragment>",
        `diffuseColor.a *= smoothstep(${fadeEnd.toFixed(1)}, ${fadeStart.toFixed(1)}, vTrackWorldZ);
         if (diffuseColor.a < 0.004) discard;
         #include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => `track-depth-fade-${fadeStart}-${fadeEnd}`;
  return material;
}

function createSoftNoteGlowMaterial(color, intensity = 1) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.28) },
      uIntensity: { value: intensity },
    },
    vertexShader: `
      varying vec2 vGlowUv;
      void main() {
        vGlowUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uIntensity;
      varying vec2 vGlowUv;
      void main() {
        vec2 centered = (vGlowUv - 0.5) * 2.0;
        float feather = 1.0 - smoothstep(0.02, 1.0, length(centered));
        float alpha = pow(feather, 1.85) * 0.4 * uIntensity;
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(uColor, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

function padNumber(value, width) {
  return Math.round(value).toString().padStart(width, "0");
}

function isHoldNote(note) {
  return note.type === "hold" || note.duration >= HOLD_THRESHOLD_SECONDS;
}

function judgementForDifference(difference) {
  return JUDGEMENT_WINDOWS.find((entry) => Math.abs(difference) <= entry.seconds);
}

export class RhythmGame {
  constructor({ canvas, container, synth, onUpdate, onJudgement, onState, onCountdown, onHoldState }) {
    this.canvas = canvas;
    this.container = container;
    this.synth = synth;
    this.onUpdate = onUpdate;
    this.onJudgement = onJudgement;
    this.onState = onState;
    this.onCountdown = onCountdown;
    this.onHoldState = onHoldState;
    this.chart = null;
    this.runtimeNotes = [];
    this.noteMeshPool = [];
    this.freeNoteMeshes = [];
    this.state = "loading";
    this.lastCountdown = null;
    this.pulse = [0, 0, 0, 0];
    this.activeHolds = [null, null, null, null];
    this.hitEffects = [];
    this.cameraShakeRemaining = 0;
    this.cameraShakeDuration = 0.15;
    this.cameraShakeCooldown = 0;
    this.cameraShakeStrength = 0;
    this.cameraShakeLaneDirection = 0;
    this.hitShakeCount = 0;
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.stats = this.createStats();
    this.lastUiUpdate = 0;

    this.createScene();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    window.addEventListener("keydown", (event) => this.handleKeyDown(event));
    window.addEventListener("keyup", (event) => this.handleKeyUp(event));
    this.clock = new THREE.Clock();
    this.animate();
  }

  createStats() {
    return {
      score: 0,
      combo: 0,
      maxCombo: 0,
      judged: 0,
      accuracyPoints: 0,
      accuracy: 100,
      perfect: 0,
      great: 0,
      good: 0,
      miss: 0,
    };
  }

  createScene() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.03;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.canvas.dataset.shadowUpdates = "static-cache";

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x010108);
    this.scene.fog = new THREE.FogExp2(0x02030b, 0.019);
    this.cameraBase = new THREE.Vector3(...CAMERA_FRAMING.position);
    this.cameraTarget = new THREE.Vector3(...CAMERA_FRAMING.target);
    this.camera = new THREE.PerspectiveCamera(CAMERA_FRAMING.desktopFov, 1, 0.1, 100);
    this.camera.position.copy(this.cameraBase);
    this.camera.lookAt(this.cameraTarget);
    this.canvas.dataset.hitShakeCount = "0";
    this.canvas.dataset.mirrorFlashCount = "0";

    const ambient = new THREE.HemisphereLight(0xa9d7ff, 0x05020b, 0.78);
    this.scene.add(ambient);
    const keyLight = new THREE.DirectionalLight(SCENE_PALETTE.keyLight, 2.9);
    keyLight.position.set(-3.8, 10.5, 7.5);
    keyLight.target.position.set(0, 0, -8);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.left = -8;
    keyLight.shadow.camera.right = 8;
    keyLight.shadow.camera.top = 9;
    keyLight.shadow.camera.bottom = -7;
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 46;
    keyLight.shadow.bias = -0.00015;
    keyLight.shadow.normalBias = 0.035;
    keyLight.shadow.radius = 3;
    this.scene.add(keyLight, keyLight.target);

    const softbox = new THREE.RectAreaLight(0xe8f4ff, 1.65, 7.5, 9);
    softbox.position.set(0, 7.5, 1.5);
    softbox.lookAt(0, 0, -7);
    this.scene.add(softbox);

    const tunnelLight = new THREE.PointLight(SCENE_PALETTE.coolFill, 5.5, 25, 1.8);
    tunnelLight.position.set(-3.4, 2.6, -7.5);
    this.scene.add(tunnelLight);
    const horizonLight = new THREE.PointLight(SCENE_PALETTE.violetFill, 5, 27, 1.9);
    horizonLight.position.set(3.3, 3.2, -14);
    this.scene.add(horizonLight);

    const floorMaterial = applyTrackDepthFade(
      new THREE.MeshPhysicalMaterial({
        color: SCENE_PALETTE.surface,
        emissive: 0x030915,
        emissiveIntensity: 0.18,
        metalness: 0.58,
        roughness: 0.52,
        clearcoat: 0.68,
        clearcoatRoughness: 0.3,
        opacity: 0.94,
      }),
    );
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(5.96, TRACK_LENGTH), floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -0.08, TRACK_CENTER_Z);
    floor.receiveShadow = true;
    this.scene.add(floor);

    const laneBedGeometry = new THREE.BoxGeometry(LANE_SPACING, 0.045, TRACK_LENGTH);
    for (let lane = 0; lane < 4; lane += 1) {
      const laneColor = new THREE.Color(LANE_COLORS[lane]);
      const laneBed = new THREE.Mesh(
        laneBedGeometry,
        applyTrackDepthFade(
          new THREE.MeshPhysicalMaterial({
            color: laneColor.clone().multiplyScalar(0.055),
            emissive: LANE_COLORS[lane],
            emissiveIntensity: 0.075,
            metalness: 0.52,
            roughness: 0.5,
            clearcoat: 0.68,
            clearcoatRoughness: 0.3,
            opacity: 0.9,
          }),
        ),
      );
      laneBed.position.set(LANE_X[lane], -0.045, TRACK_CENTER_Z - 0.05);
      laneBed.receiveShadow = true;
      this.scene.add(laneBed);
    }

    const wallMaterial = applyTrackDepthFade(
      new THREE.MeshStandardMaterial({
        color: SCENE_PALETTE.surfaceRaised,
        emissive: SCENE_PALETTE.materialEdge,
        emissiveIntensity: 0.22,
        metalness: 0.82,
        roughness: 0.24,
        opacity: 0.7,
      }),
    );
    const wallGeometry = new RoundedBoxGeometry(0.27, 0.22, TRACK_LENGTH, 4, 0.08);
    for (const side of [-1, 1]) {
      const wall = new THREE.Mesh(wallGeometry, wallMaterial);
      wall.position.set(side * 2.84, 0.015, TRACK_CENTER_Z - 0.05);
      wall.receiveShadow = true;
      this.scene.add(wall);
    }

    for (let index = 0; index <= 4; index += 1) {
      if (index === 2) continue;
      const color = TRACK_EDGE_COLORS[index];
      const glowRail = new THREE.Mesh(
        new THREE.BoxGeometry(0.052, 0.008, TRACK_LENGTH),
        applyTrackDepthFade(
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.1,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            toneMapped: false,
          }),
        ),
      );
      glowRail.position.set(TRACK_LEFT_X + index * LANE_SPACING, 0.026, TRACK_CENTER_Z - 0.1);
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(0.013, 0.018, TRACK_LENGTH),
        applyTrackDepthFade(
          new THREE.MeshBasicMaterial({
            color,
            opacity: 0.62,
            toneMapped: false,
          }),
        ),
      );
      rail.position.set(TRACK_LEFT_X + index * LANE_SPACING, 0.036, TRACK_CENTER_Z - 0.1);
      this.scene.add(glowRail, rail);
    }

    const centerRailGeometry = new THREE.BufferGeometry();
    centerRailGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [
          0,
          -0.02,
          TRACK_FRONT_Z - 0.05,
          0,
          -0.02,
          TRACK_FRONT_Z - 0.05,
          0,
          -0.02,
          TRACK_FADE_END_Z - 2,
          0,
          -0.02,
          TRACK_FADE_END_Z - 2,
        ],
        3,
      ),
    );
    centerRailGeometry.setAttribute(
      "aSide",
      new THREE.Float32BufferAttribute([-1, 1, -1, 1], 1),
    );
    centerRailGeometry.setIndex([0, 1, 2, 2, 1, 3]);
    this.centerRailMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0xb54bd8) },
        uViewportWidth: { value: Math.max(1, this.container.clientWidth) },
        uHalfWidthCss: { value: 0.72 },
      },
      vertexShader: `
        attribute float aSide;
        uniform float uViewportWidth;
        uniform float uHalfWidthCss;
        varying float vWorldZ;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vec4 clipPosition = projectionMatrix * viewMatrix * worldPosition;
          clipPosition.x += aSide * uHalfWidthCss * 2.0 * clipPosition.w / uViewportWidth;
          vWorldZ = worldPosition.z;
          gl_Position = clipPosition;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vWorldZ;
        void main() {
          float depthFade = smoothstep(${(TRACK_FADE_END_Z - 2).toFixed(1)}, ${TRACK_FADE_START_Z.toFixed(1)}, vWorldZ);
          gl_FragColor = vec4(uColor, 0.82 * depthFade);
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const centerRail = new THREE.Mesh(centerRailGeometry, this.centerRailMaterial);
    centerRail.frustumCulled = false;
    centerRail.renderOrder = 3;
    this.scene.add(centerRail);

    const crossMaterial = applyTrackDepthFade(
      new THREE.MeshBasicMaterial({ color: 0x35506f, opacity: 0.38 }),
    );
    const crossCount = Math.ceil((HIT_Z - TRACK_FADE_END_Z) / 1.5);
    for (let index = 0; index < crossCount; index += 1) {
      const cross = new THREE.Mesh(new THREE.BoxGeometry(4.76, 0.01, 0.022), crossMaterial);
      cross.position.set(0, 0.024, HIT_Z - index * 1.5);
      this.scene.add(cross);
    }

    this.createCosmicEnvironment();

    this.padMaterials = LANE_COLORS.map(
      (color) => {
        const surfaceColor = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.08);
        return new THREE.MeshPhysicalMaterial({
          color: surfaceColor.multiplyScalar(0.48),
          emissive: color,
          emissiveIntensity: 0.2,
          transparent: false,
          opacity: 1,
          metalness: 0.28,
          roughness: 0.22,
          clearcoat: 1,
          clearcoatRoughness: 0.08,
        });
      },
    );
    this.padMeshes = [];
    const padShadowGeometry = new RoundedBoxGeometry(1.17, 0.055, 0.84, 5, 0.09);
    const padFrameGeometry = new RoundedBoxGeometry(1.11, 0.095, 0.78, 5, 0.085);
    const padBaseGeometry = new RoundedBoxGeometry(1.02, 0.18, 0.66, 6, 0.1);
    const padShadowMaterial = new THREE.MeshStandardMaterial({
      color: 0x000105,
      roughness: 0.82,
      metalness: 0.15,
    });
    const padFrameMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x03060b,
      emissive: 0x122238,
      emissiveIntensity: 0.18,
      metalness: 0.84,
      roughness: 0.18,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
    });
    for (let lane = 0; lane < 4; lane += 1) {
      const receptor = new THREE.Group();
      const aura = new THREE.Mesh(
        new THREE.PlaneGeometry(1.49, 1.1),
        createSoftNoteGlowMaterial(LANE_COLORS[lane], 0.34),
      );
      aura.rotation.x = -Math.PI / 2;
      aura.position.y = -0.035;
      aura.renderOrder = 1;
      const shadowBase = new THREE.Mesh(padShadowGeometry, padShadowMaterial);
      shadowBase.position.set(0.028, -0.065, 0.045);
      shadowBase.receiveShadow = true;
      const frame = new THREE.Mesh(padFrameGeometry, padFrameMaterial);
      frame.position.y = -0.025;
      frame.castShadow = true;
      frame.receiveShadow = true;
      const pad = new THREE.Mesh(padBaseGeometry, this.padMaterials[lane]);
      pad.position.y = PAD_REST_Y;
      pad.castShadow = true;
      pad.receiveShadow = true;
      receptor.add(aura, shadowBase, frame, pad);
      receptor.position.set(LANE_X[lane], 0.02, HIT_Z);
      receptor.scale.set(PAD_FOOTPRINT_SCALE, 1, PAD_FOOTPRINT_SCALE);
      this.padMeshes.push(pad);
      this.scene.add(receptor);
    }

    this.noteGeometry = new RoundedBoxGeometry(0.86, 0.12, 0.5, 5, 0.034);
    this.noteGlowGeometry = new THREE.PlaneGeometry(1.12, 0.62);
    this.hitRingGeometry = new THREE.RingGeometry(0.19, 0.27, 30);
    this.hitShardGeometry = new THREE.BoxGeometry(0.055, 0.055, 0.24);
    this.noteMaterials = LANE_COLORS.map(
      (color) => {
        const surfaceColor = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.14);
        return new THREE.MeshPhysicalMaterial({
          color: surfaceColor,
          emissive: color,
          emissiveIntensity: 0.46,
          metalness: 0.14,
          roughness: 0.2,
          clearcoat: 1,
          clearcoatRoughness: 0.07,
        });
      },
    );
    this.noteGlowMaterials = LANE_COLORS.map((color) => createSoftNoteGlowMaterial(color, 0.72));
    this.holdMaterials = LANE_COLORS.map((color) => {
      const heldColor = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.34);
      return new THREE.MeshPhysicalMaterial({
        color: heldColor.lerp(new THREE.Color(0xffffff), 0.16),
        emissive: color,
        emissiveIntensity: 0.72,
        metalness: 0.12,
        roughness: 0.14,
        clearcoat: 1,
        clearcoatRoughness: 0.08,
      });
    });
    this.createHitEffectPool();
    this.setupPostProcessing();
    this.warmHitEffectShaders();
  }

  createCosmicEnvironment() {
    this.cosmicMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        varying vec3 vDirection;
        void main() {
          vDirection = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        varying vec3 vDirection;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
                     mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0)), f.x), f.y);
        }

        float fbm(vec2 p) {
          float value = 0.0;
          float amplitude = 0.52;
          for (int i = 0; i < 4; i++) {
            value += noise(p) * amplitude;
            p = p * 2.03 + vec2(17.1, 9.2);
            amplitude *= 0.5;
          }
          return value;
        }

        void main() {
          vec3 direction = normalize(vDirection);
          vec2 uv = vec2(
            atan(direction.z, direction.x) / 6.2831853 + 0.5,
            asin(direction.y) / 3.1415926 + 0.5
          );
          float drift = uTime * 0.007;
          float cloud = fbm(uv * vec2(4.2, 3.0) + vec2(drift, -drift * 0.45));
          float detail = noise(uv * vec2(12.0, 7.0) - vec2(drift * 1.7, 0.0));
          float galaxyBand = exp(-pow(abs(uv.y - 0.52 + (cloud - 0.5) * 0.16) * 4.7, 2.0));
          float nebula = smoothstep(0.36, 0.92, cloud * 0.72 + detail * 0.38) * galaxyBand;
          vec3 deepSpace = vec3(0.002, 0.004, 0.025);
          vec3 violet = vec3(0.22, 0.045, 0.46);
          vec3 cyan = vec3(0.025, 0.36, 0.58);
          vec3 color = deepSpace + mix(violet, cyan, detail) * nebula * 0.78;

          gl_FragColor = vec4(color, 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.cosmicBackdrop = new THREE.Mesh(
      new THREE.SphereGeometry(68, 48, 32),
      this.cosmicMaterial,
    );
    this.cosmicBackdrop.position.set(0, 1.4, -8);
    this.cosmicBackdrop.renderOrder = -10;
    this.scene.add(this.cosmicBackdrop);

    const starCount = 525;
    const positions = new Float32Array(starCount * 3);
    const sizes = new Float32Array(starCount);
    const phases = new Float32Array(starCount);
    const temperatures = new Float32Array(starCount);
    const styles = new Float32Array(starCount);
    this.starSpeeds = new Float32Array(starCount);
    for (let index = 0; index < starCount; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 4.6 + Math.pow(Math.random(), 0.72) * 20;
      const offset = index * 3;
      positions[offset] = Math.cos(angle) * radius;
      positions[offset + 1] = Math.sin(angle) * radius * 0.56 + 2.1;
      positions[offset + 2] = -52 + Math.random() * 60;
      this.starSpeeds[index] = 4.2 + Math.random() * 8.8;
      sizes[index] = 0.034 + Math.pow(Math.random(), 2.2) * 0.082;
      phases[index] = Math.random() * Math.PI * 2;
      temperatures[index] = Math.random();
      styles[index] = Math.random();
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    starGeometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    starGeometry.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
    starGeometry.setAttribute("aTemperature", new THREE.BufferAttribute(temperatures, 1));
    starGeometry.setAttribute("aStyle", new THREE.BufferAttribute(styles, 1));
    this.starMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPointScale: { value: 300 },
      },
      vertexShader: `
        uniform float uTime;
        uniform float uPointScale;
        attribute float aSize;
        attribute float aPhase;
        attribute float aTemperature;
        attribute float aStyle;
        varying float vTemperature;
        varying float vStyle;
        varying float vDepthFade;
        varying float vTwinkle;

        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          float cameraDepth = max(1.0, -mvPosition.z);
        gl_PointSize = clamp(aSize * uPointScale * 1.475 / cameraDepth, 2.69, 13.13);
          gl_Position = projectionMatrix * mvPosition;
          vTemperature = aTemperature;
          vStyle = aStyle;
          vDepthFade = mix(0.62, 1.0, 1.0 - smoothstep(8.0, 65.0, cameraDepth));
          vTwinkle = 0.88 + 0.12 * sin(uTime * 1.35 + aPhase);
        }
      `,
      fragmentShader: `
        varying float vTemperature;
        varying float vStyle;
        varying float vDepthFade;
        varying float vTwinkle;

        void main() {
          vec2 point = gl_PointCoord - 0.5;
          float radiusSquared = dot(point, point);
          if (radiusSquared > 0.25) discard;

          float core = 1.0 - smoothstep(0.0, 0.0324, radiusSquared);
          float radialFade = 1.0 - smoothstep(0.0, 0.25, radiusSquared);
          float halo = radialFade * radialFade * 0.32;
          float horizontalSpike = (1.0 - smoothstep(0.0, 0.035, abs(point.y))) *
            (1.0 - smoothstep(0.08, 0.48, abs(point.x)));
          float verticalSpike = (1.0 - smoothstep(0.0, 0.035, abs(point.x))) *
            (1.0 - smoothstep(0.08, 0.48, abs(point.y)));
          float sparkleShape = (horizontalSpike + verticalSpike) * step(0.96, vStyle) * 0.3;
          float edgeFade = 1.0 - smoothstep(0.1225, 0.25, radiusSquared);
          float alpha = clamp(
            (halo + core + sparkleShape) * edgeFade * vTwinkle * vDepthFade,
            0.0,
            0.9
          );

          vec3 warmWhite = vec3(1.0, 0.88, 0.72);
          vec3 coolWhite = vec3(0.62, 0.86, 1.0);
          vec3 starColor = mix(warmWhite, coolWhite, smoothstep(0.08, 0.92, vTemperature));
          float brightness = 0.56 + core * 0.2 + sparkleShape * 0.08;
          gl_FragColor = vec4(starColor * brightness, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      toneMapped: false,
    });
    this.stars = new THREE.Points(starGeometry, this.starMaterial);
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);

    const ringPoints = [];
    for (let index = 0; index < 112; index += 1) {
      const angle = (index / 112) * Math.PI * 2;
      const ripple = 1 + Math.sin(angle * 3) * 0.035;
      ringPoints.push(new THREE.Vector3(Math.cos(angle) * 7.1 * ripple, Math.sin(angle) * 3.65 * ripple, 0));
    }
    const ringGeometry = new THREE.BufferGeometry().setFromPoints(ringPoints);
    this.vortexRings = [];
    for (let index = 0; index < 15; index += 1) {
      const ring = new THREE.LineLoop(
        ringGeometry,
        new THREE.LineBasicMaterial({
          color: index % 3 === 0 ? 0x8ad8ff : index % 3 === 1 ? 0x9a6cff : 0x5ef2ce,
          transparent: true,
          opacity: (0.14 + (index % 4) * 0.018) * 0.8,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
        }),
      );
      ring.position.set(0, 1.5, 4 - index * 3.55);
      ring.rotation.z = (index % 2 ? 1 : -1) * index * 0.035;
      ring.userData.speed = 3.7 + (index % 5) * 0.24;
      ring.userData.spin = (index % 2 ? 1 : -1) * (0.014 + (index % 3) * 0.005);
      this.vortexRings.push(ring);
      this.scene.add(ring);
    }

    this.createMirrorBall();
  }

  createMirrorBall() {
    this.mirrorBall = new THREE.Group();
    this.mirrorBall.position.set(0, 5.45, -35.5);
    this.mirrorBall.scale.setScalar(1.105);

    this.mirrorBaseMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x07111d,
      emissive: MIRROR_DEFAULTS.baseEmissive,
      emissiveIntensity: 0.16,
      metalness: 0.72,
      roughness: 0.24,
      clearcoat: 0.9,
      clearcoatRoughness: 0.16,
    });
    const base = new THREE.Mesh(
      new THREE.SphereGeometry(1.76, 32, 20),
      this.mirrorBaseMaterial,
    );
    this.mirrorBall.add(base);

    const tiles = [];
    const radius = 1.82;
    const latitudeRows = 16;
    for (let row = 0; row < latitudeRows; row += 1) {
      const latitude = THREE.MathUtils.degToRad(
        THREE.MathUtils.lerp(-75, 75, row / (latitudeRows - 1)),
      );
      const ringRadius = Math.cos(latitude);
      const tileCount = Math.max(8, Math.round(28 * ringRadius));
      for (let column = 0; column < tileCount; column += 1) {
        const angle = (column / tileCount) * Math.PI * 2 + (row % 2) * (Math.PI / tileCount);
        const normal = new THREE.Vector3(
          Math.cos(angle) * ringRadius,
          Math.sin(latitude),
          Math.sin(angle) * ringRadius,
        ).normalize();
        const width = ((Math.PI * 2 * radius * ringRadius) / tileCount) * 0.88;
        const height = (THREE.MathUtils.degToRad(10) * radius) * 0.86;
        tiles.push({ normal, width, height });
      }
    }

    this.mirrorTileMaterial = new THREE.MeshPhysicalMaterial({
      color: MIRROR_DEFAULTS.tile,
      emissive: MIRROR_DEFAULTS.tileEmissive,
      emissiveIntensity: 0.11,
      metalness: 0.78,
      roughness: 0.13,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
      side: THREE.DoubleSide,
    });
    const hexTileGeometry = new THREE.CylinderGeometry(
      0.5,
      0.5,
      0.038,
      6,
      1,
      false,
      Math.PI / 6,
    );
    hexTileGeometry.rotateX(Math.PI / 2);
    hexTileGeometry.scale(1, 2 / Math.sqrt(3), 1);
    const tileMesh = new THREE.InstancedMesh(
      hexTileGeometry,
      this.mirrorTileMaterial,
      tiles.length,
    );
    const dummy = new THREE.Object3D();
    const forward = new THREE.Vector3(0, 0, 1);
    const tileColor = new THREE.Color();
    tiles.forEach((tile, index) => {
      dummy.position.copy(tile.normal).multiplyScalar(radius);
      dummy.quaternion.setFromUnitVectors(forward, tile.normal);
      dummy.scale.set(tile.width, tile.height, 1);
      dummy.updateMatrix();
      tileMesh.setMatrixAt(index, dummy.matrix);
      const hue = 0.52 + Math.random() * 0.09;
      const saturation = 0.12 + Math.random() * 0.24;
      const lightness = 0.58 + Math.random() * 0.34;
      tileColor.setHSL(hue, saturation, lightness);
      tileMesh.setColorAt(index, tileColor);
    });
    tileMesh.instanceMatrix.needsUpdate = true;
    if (tileMesh.instanceColor) tileMesh.instanceColor.needsUpdate = true;
    this.mirrorBall.add(tileMesh);
    this.scene.add(this.mirrorBall);

    const mirrorKey = new THREE.PointLight(0x8ad8ff, 24, 16, 1.8);
    mirrorKey.position.set(-4.6, 4.8, -30.5);
    this.scene.add(mirrorKey);
    this.mirrorPulseLight = new THREE.PointLight(MIRROR_DEFAULTS.pulse, 13, 14, 1.8);
    this.mirrorPulseLight.position.set(4.2, 0.7, -31.5);
    this.scene.add(this.mirrorPulseLight);

    this.mirrorAxis = new THREE.Vector3(0.32, 0.88, 0.24).normalize();
    this.mirrorSpeed = 0.09;
    this.mirrorBurst = 0;
    this.mirrorDirectionTimer = 0.8;
    this.tunnelSpeedScale = 0.22;
    this.tunnelBeatBurst = 0;
    this.tunnelBassRise = 0;
    this.previousRawBass = 0;
    this.smoothedAudioEnergy = { bass: 0, mid: 0, high: 0, overall: 0 };
    this.mirrorFlashColor = new THREE.Color(LANE_COLORS[0]);
    this.mirrorDefaultTileColor = new THREE.Color(MIRROR_DEFAULTS.tile);
    this.mirrorDefaultTileEmissive = new THREE.Color(MIRROR_DEFAULTS.tileEmissive);
    this.mirrorDefaultBaseEmissive = new THREE.Color(MIRROR_DEFAULTS.baseEmissive);
    this.mirrorFlashEnergy = 0;
    this.mirrorFlashCount = 0;
  }

  setupPostProcessing() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.3, 0.86);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
    this.fxaaPass = new FXAAPass();
    this.composer.addPass(this.fxaaPass);
  }

  updateMirrorBall(delta) {
    const rawEnergy = this.synth.getAudioEnergy?.() ?? { bass: 0, mid: 0, high: 0, overall: 0 };
    const smoothing = 1 - Math.exp(-delta * 8.5);
    for (const band of ["bass", "mid", "high", "overall"]) {
      this.smoothedAudioEnergy[band] +=
        (rawEnergy[band] - this.smoothedAudioEnergy[band]) * smoothing;
    }

    const bassRise = rawEnergy.bass - this.previousRawBass;
    this.previousRawBass = rawEnergy.bass;
    this.tunnelBassRise = bassRise;
    this.mirrorDirectionTimer -= delta * (0.75 + this.smoothedAudioEnergy.overall * 1.4);

    if (!this.reducedMotion && (bassRise > 0.075 || (this.mirrorDirectionTimer <= 0 && rawEnergy.overall > 0.08))) {
      this.mirrorAxis
        .set(
          Math.random() * 2 - 1,
          Math.random() * 2 - 1,
          Math.random() * 1.35 - 0.675,
        )
        .normalize();
      this.mirrorDirectionTimer = 0.42 + Math.random() * 1.28;
      if (bassRise > 0.075) this.mirrorBurst = Math.max(this.mirrorBurst, 0.45 + rawEnergy.bass * 1.7);
    }

    this.mirrorBurst *= Math.exp(-delta * 3.6);
    const targetSpeed = this.reducedMotion
      ? 0.018
      : 0.075 +
        this.smoothedAudioEnergy.overall * 0.62 +
        this.smoothedAudioEnergy.bass * 1.18 +
        this.mirrorBurst;
    const speedResponse = 1 - Math.exp(-delta * (bassRise > 0.075 ? 13 : 4.2));
    this.mirrorSpeed += (targetSpeed - this.mirrorSpeed) * speedResponse;
    this.mirrorBall.rotation.x += this.mirrorAxis.x * this.mirrorSpeed * delta;
    this.mirrorBall.rotation.y += this.mirrorAxis.y * this.mirrorSpeed * delta;
    this.mirrorBall.rotation.z += this.mirrorAxis.z * this.mirrorSpeed * delta;

    this.mirrorFlashEnergy = Math.max(0, this.mirrorFlashEnergy - delta * 3.2);
    const flashProgress = 1 - this.mirrorFlashEnergy;
    const sparkle = 0.94 + Math.sin(flashProgress * Math.PI * 4) * 0.06;
    const flash = Math.pow(this.mirrorFlashEnergy, 0.62) * sparkle;
    const flashColorAmount = flash * 0.52;

    this.mirrorTileMaterial.color
      .copy(this.mirrorDefaultTileColor)
      .lerp(this.mirrorFlashColor, flashColorAmount);
    this.mirrorTileMaterial.emissive
      .copy(this.mirrorDefaultTileEmissive)
      .lerp(this.mirrorFlashColor, flashColorAmount * 0.7);
    this.mirrorTileMaterial.emissiveIntensity =
      0.09 + this.smoothedAudioEnergy.high * 0.2 + flash * 0.95;
    this.mirrorBaseMaterial.emissive
      .copy(this.mirrorDefaultBaseEmissive)
      .lerp(this.mirrorFlashColor, flashColorAmount * 0.42);
    this.mirrorBaseMaterial.emissiveIntensity = 0.16 + flash * 0.48;
    this.mirrorPulseLight.intensity = 10 + this.smoothedAudioEnergy.bass * 28;
  }

  flashMirrorBall(lane) {
    this.mirrorFlashColor.setHex(LANE_COLORS[lane]);
    this.mirrorFlashEnergy = 1;
    this.mirrorFlashCount += 1;
    this.canvas.dataset.mirrorFlashCount = String(this.mirrorFlashCount);
    this.canvas.dataset.mirrorFlashLane = String(lane);
  }

  updateCosmicEnvironment(delta, elapsed) {
    const motionScale = this.reducedMotion ? 0.13 : 1;
    this.updateMirrorBall(delta);

    const tunnelIsLive = this.state === "playing";
    if (tunnelIsLive && this.tunnelBassRise > 0.055) {
      this.tunnelBeatBurst = Math.max(
        this.tunnelBeatBurst,
        0.55 + this.smoothedAudioEnergy.bass * 1.4,
      );
    }
    this.tunnelBeatBurst *= Math.exp(-delta * 2.7);
    const tunnelTargetSpeed = this.reducedMotion
      ? 0.13
      : tunnelIsLive
        ? Math.min(
            4.8,
            Math.max(
              1.25,
              1.25 +
                this.smoothedAudioEnergy.overall * 1.75 +
                this.smoothedAudioEnergy.bass * 2.15 +
                this.tunnelBeatBurst,
            ),
          )
        : 0.22;
    const tunnelResponse = 1 - Math.exp(
      -delta * (this.tunnelBassRise > 0.055 ? 14 : tunnelIsLive ? 3.4 : 2.8),
    );
    this.tunnelSpeedScale += (tunnelTargetSpeed - this.tunnelSpeedScale) * tunnelResponse;
    this.canvas.tunnelSpeedScale = this.tunnelSpeedScale;

    const positionAttribute = this.stars.geometry.attributes.position;
    const positions = positionAttribute.array;
    for (let index = 0; index < this.starSpeeds.length; index += 1) {
      const zIndex = index * 3 + 2;
      positions[zIndex] += delta * this.starSpeeds[index] * motionScale;
      if (positions[zIndex] > 8) positions[zIndex] = -52;
    }
    positionAttribute.needsUpdate = true;

    for (const ring of this.vortexRings) {
      ring.position.z += delta * ring.userData.speed * this.tunnelSpeedScale;
      if (ring.position.z > 7) ring.position.z -= 53.25;
      if (!this.reducedMotion) ring.rotation.z += delta * ring.userData.spin;
    }

    this.cosmicMaterial.uniforms.uTime.value = elapsed * motionScale;
    this.starMaterial.uniforms.uTime.value = elapsed * motionScale;
    if (!this.reducedMotion) {
      this.cosmicBackdrop.rotation.z = Math.sin(elapsed * 0.035) * 0.055;
    }
  }

  setChart(chart) {
    this.stop(false);
    this.runtimeNotes = chart.notes.map((note) => ({
      note,
      mesh: null,
      status: "pending",
      isHold: isHoldNote(note),
      startTiming: null,
    }));
    this.chart = chart;
    this.canvas.dataset.chartNoteCount = String(this.runtimeNotes.length);
    this.updateNotePoolDiagnostics();
    this.stats = this.createStats();
    this.state = "ready";
    this.emitUpdate();
    this.onState?.("ready", { chart });
  }

  async start(events) {
    if (!this.chart) return;
    this.synth.stop();
    this.stats = this.createStats();
    this.mirrorFlashEnergy = 0;
    this.mirrorFlashCount = 0;
    this.tunnelSpeedScale = this.reducedMotion ? 0.13 : 0.22;
    this.tunnelBeatBurst = 0;
    this.tunnelBassRise = 0;
    this.canvas.dataset.mirrorFlashCount = "0";
    this.cameraShakeRemaining = 0;
    this.cameraShakeCooldown = 0;
    this.hitShakeCount = 0;
    this.canvas.dataset.hitShakeCount = "0";
    delete this.canvas.dataset.hitShakeLane;
    delete this.canvas.dataset.mirrorFlashLane;
    this.resetHoldStates();
    for (const runtime of this.runtimeNotes) {
      runtime.status = "pending";
      runtime.startTiming = null;
      this.releaseNoteMesh(runtime);
    }
    this.lastCountdown = null;
    await this.synth.start(events, COUNTDOWN_SECONDS);
    this.state = "countdown";
    this.emitUpdate();
    this.onState?.("countdown", {});
  }

  stop(emit = true) {
    this.synth.stop();
    this.resetHoldStates();
    if (this.chart) this.state = "ready";
    for (const runtime of this.runtimeNotes) {
      this.releaseNoteMesh(runtime);
    }
    for (const effect of this.hitEffects) {
      effect.active = false;
      effect.group.visible = false;
    }
    this.cameraShakeRemaining = 0;
    this.cameraShakeCooldown = 0;
    this.camera.position.copy(this.cameraBase);
    this.camera.lookAt(this.cameraTarget);
    if (emit && this.chart) this.onState?.("ready", { chart: this.chart });
  }

  resetHoldStates() {
    for (let lane = 0; lane < this.activeHolds.length; lane += 1) {
      this.activeHolds[lane] = null;
      this.onHoldState?.(lane, false);
    }
  }

  createPooledNoteMesh() {
    const mesh = new THREE.Mesh(this.noteGeometry, this.noteMaterials[0]);
    const glow = new THREE.Mesh(this.noteGlowGeometry, this.noteGlowMaterials[0]);
    glow.position.y = -0.075;
    glow.rotation.x = -Math.PI / 2;
    glow.renderOrder = 2;
    mesh.add(glow);
    mesh.visible = false;
    mesh.rotation.x = -0.025;
    mesh.userData.glow = glow;
    this.scene.add(mesh);
    this.noteMeshPool.push(mesh);
    this.canvas.dataset.notePoolSize = String(this.noteMeshPool.length);
    return mesh;
  }

  acquireNoteMesh(runtime) {
    if (runtime.mesh) return runtime.mesh;
    const mesh = this.freeNoteMeshes.pop() ?? this.createPooledNoteMesh();
    const { note, isHold } = runtime;
    mesh.material = this.noteMaterials[note.lane];
    mesh.userData.glow.material = this.noteGlowMaterials[note.lane];
    mesh.position.set(LANE_X[note.lane], 0.1, SPAWN_Z);
    mesh.scale.set(
      1,
      1,
      isHold
        ? Math.max(1.3, (note.duration / TRAVEL_SECONDS) * TRAVEL_DISTANCE / NOTE_BASE_DEPTH)
        : Math.min(2.8, 0.85 + note.duration * 1.45),
    );
    mesh.visible = true;
    runtime.mesh = mesh;
    this.updateNotePoolDiagnostics();
    return mesh;
  }

  releaseNoteMesh(runtime) {
    const mesh = runtime.mesh;
    if (!mesh) return;
    mesh.visible = false;
    mesh.material = this.noteMaterials[runtime.note.lane];
    runtime.mesh = null;
    this.freeNoteMeshes.push(mesh);
    this.updateNotePoolDiagnostics();
  }

  updateNotePoolDiagnostics() {
    this.canvas.dataset.notePoolSize = String(this.noteMeshPool.length);
    this.canvas.dataset.activeNoteMeshes = String(
      this.noteMeshPool.length - this.freeNoteMeshes.length,
    );
  }

  handleKeyDown(event) {
    if (event.code === "Enter" && !event.repeat) {
      this.onState?.("start-request", {});
      return;
    }
    const lane = KEY_TO_LANE[event.code];
    if (lane === undefined || event.repeat) return;
    event.preventDefault();
    this.hitLane(lane);
  }

  handleKeyUp(event) {
    const lane = KEY_TO_LANE[event.code];
    if (lane === undefined) return;
    event.preventDefault();
    this.releaseLane(lane);
  }

  hitLane(lane) {
    this.pulse[lane] = 1.12;
    if (this.state !== "playing") return;
    if (this.activeHolds[lane]) return;

    const songTime = this.synth.songTime;
    let candidate = null;
    let closest = Infinity;
    for (const runtime of this.runtimeNotes) {
      if (runtime.status !== "pending" || runtime.note.lane !== lane) continue;
      const difference = Math.abs(runtime.note.time - songTime);
      if (difference <= GOOD_WINDOW && difference < closest) {
        closest = difference;
        candidate = runtime;
      }
      if (runtime.note.time > songTime + GOOD_WINDOW) break;
    }

    if (!candidate) {
      this.onJudgement?.("EMPTY", null, this.stats, lane, this.getLaneScreenPosition(lane));
      return;
    }

    const timing = candidate.note.time - songTime;
    if (candidate.isHold) {
      this.beginHold(candidate, lane, timing);
      return;
    }

    const judgement = judgementForDifference(timing);
    this.completeNote(candidate, judgement, timing);
  }

  beginHold(runtime, lane, startTiming) {
    this.onCountdown?.(null);
    this.lastCountdown = null;
    runtime.status = "holding";
    runtime.startTiming = startTiming;
    const mesh = this.acquireNoteMesh(runtime);
    mesh.material = this.holdMaterials[lane];
    mesh.visible = true;
    this.activeHolds[lane] = runtime;
    this.pulse[lane] = 1.35;
    this.synth.playHitFeedback("GOOD", lane);
    this.onHoldState?.(lane, true);
    this.onJudgement?.(
      "HOLD",
      startTiming * 1000,
      this.stats,
      lane,
      this.getLaneScreenPosition(lane),
      { hold: true, phase: "start" },
    );
  }

  releaseLane(lane) {
    const runtime = this.activeHolds[lane];
    if (!runtime || this.state !== "playing") return;

    const songTime = this.synth.songTime;
    const endTime = runtime.note.endTime ?? runtime.note.time + runtime.note.duration;
    const releaseTiming = endTime - songTime;
    if (Math.abs(releaseTiming) > GOOD_WINDOW) {
      this.failHold(runtime, releaseTiming > 0 ? "EARLY RELEASE" : "LATE RELEASE", releaseTiming);
      return;
    }

    const worstDifference = Math.max(Math.abs(runtime.startTiming), Math.abs(releaseTiming));
    const judgement = JUDGEMENT_WINDOWS.find((entry) => worstDifference <= entry.seconds);
    this.completeNote(runtime, judgement, releaseTiming, {
      hold: true,
      phase: "release",
      startTiming: runtime.startTiming * 1000,
      releaseTiming: releaseTiming * 1000,
    });
  }

  completeNote(runtime, judgement, timing, details = {}) {
    const lane = runtime.note.lane;
    runtime.status = judgement.name.toLowerCase();
    this.releaseNoteMesh(runtime);
    if (runtime.isHold) {
      this.activeHolds[lane] = null;
      this.onHoldState?.(lane, false);
    }
    this.stats.judged += 1;
    this.stats.combo += 1;
    this.stats.maxCombo = Math.max(this.stats.maxCombo, this.stats.combo);
    this.stats.accuracyPoints += judgement.accuracy;
    this.stats[judgement.name.toLowerCase()] += 1;
    const holdBonus = runtime.isHold ? Math.round(runtime.note.duration * 400) : 0;
    this.stats.score += judgement.points + holdBonus + Math.min(this.stats.combo, 100) * 3;
    this.updateAccuracy();
    this.createHitEffect(lane, judgement.name);
    this.triggerHitShake(judgement.name, lane);
    if (judgement.name === "PERFECT") this.flashMirrorBall(lane);
    this.synth.playHitFeedback(judgement.name, lane);
    if (navigator.vibrate && judgement.name !== "GOOD") {
      navigator.vibrate(judgement.name === "PERFECT" ? 16 : 9);
    }
    this.emitUpdate();
    this.onJudgement?.(
      judgement.name,
      timing * 1000,
      this.stats,
      lane,
      this.getLaneScreenPosition(lane),
      { hold: runtime.isHold, ...details },
    );
  }

  failHold(runtime, reason, timing = null) {
    const lane = runtime.note.lane;
    runtime.status = "miss";
    this.releaseNoteMesh(runtime);
    this.activeHolds[lane] = null;
    this.onHoldState?.(lane, false);
    this.stats.judged += 1;
    this.stats.combo = 0;
    this.stats.miss += 1;
    this.updateAccuracy();
    this.emitUpdate();
    if (navigator.vibrate) navigator.vibrate([22, 18, 22]);
    this.onJudgement?.(
      "MISS",
      timing == null ? null : timing * 1000,
      this.stats,
      lane,
      this.getLaneScreenPosition(lane),
      { hold: true, phase: "break", reason },
    );
  }

  registerMiss(runtime) {
    if (runtime.status === "holding") {
      this.failHold(runtime, "LATE RELEASE");
      return;
    }
    runtime.status = "miss";
    this.releaseNoteMesh(runtime);
    this.stats.judged += 1;
    this.stats.combo = 0;
    this.stats.miss += 1;
    this.updateAccuracy();
    this.emitUpdate();
    this.onJudgement?.(
      "MISS",
      null,
      this.stats,
      runtime.note.lane,
      this.getLaneScreenPosition(runtime.note.lane),
      { hold: runtime.isHold, phase: "miss", reason: runtime.isHold ? "NOT PRESSED" : null },
    );
  }

  triggerHitShake(judgement, lane) {
    if (this.reducedMotion || this.cameraShakeCooldown > 0) return;
    const profile = HIT_CAMERA_SHAKE_PROFILES[judgement];
    if (!profile) return;
    this.cameraShakeDuration = profile.duration;
    this.cameraShakeRemaining = profile.duration;
    this.cameraShakeCooldown = 0.025;
    this.cameraShakeStrength = profile.strength;
    this.cameraShakeLaneDirection = (lane - 1.5) / 1.5;
    this.hitShakeCount += 1;
    this.canvas.dataset.hitShakeCount = String(this.hitShakeCount);
    this.canvas.dataset.hitShakeLane = String(lane);
  }

  updateCameraShake(delta, elapsed) {
    this.cameraShakeCooldown = Math.max(0, this.cameraShakeCooldown - delta);
    this.camera.position.copy(this.cameraBase);

    if (!this.reducedMotion && this.cameraShakeRemaining > 0) {
      const envelope = Math.pow(this.cameraShakeRemaining / this.cameraShakeDuration, 1.8);
      const strength = this.cameraShakeStrength * envelope;
      this.camera.position.x +=
        ((Math.sin(elapsed * 94) + Math.sin(elapsed * 157) * 0.36) * 0.13 +
          this.cameraShakeLaneDirection * 0.038) *
        strength;
      this.camera.position.y += Math.sin(elapsed * 121 + 0.8) * 0.072 * strength;
      this.camera.position.z -= 0.13 * strength;
      this.cameraShakeRemaining = Math.max(0, this.cameraShakeRemaining - delta);
    } else {
      this.cameraShakeRemaining = 0;
    }

    this.camera.lookAt(this.cameraTarget);
  }

  getLaneScreenPosition(lane) {
    this.camera.updateMatrixWorld();
    const projected = new THREE.Vector3(LANE_X[lane], 0.22, HIT_Z).project(this.camera);
    return {
      x: (projected.x * 0.5 + 0.5) * this.container.clientWidth,
      y: (-projected.y * 0.5 + 0.5) * this.container.clientHeight,
    };
  }

  createHitEffectPool() {
    this.hitShardDummy = new THREE.Object3D();
    for (let slot = 0; slot < HIT_EFFECT_POOL_SIZE; slot += 1) {
      const group = new THREE.Group();
      group.visible = false;

      const ringMaterial = new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const ring = new THREE.Mesh(this.hitRingGeometry, ringMaterial);
      ring.rotation.x = -Math.PI / 2;
      group.add(ring);

      const shardMaterial = new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const shards = new THREE.InstancedMesh(
        this.hitShardGeometry,
        shardMaterial,
        MAX_HIT_SHARDS,
      );
      shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      shards.count = 0;
      group.add(shards);

      const shardStates = Array.from({ length: MAX_HIT_SHARDS }, () => ({
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        rotation: new THREE.Vector3(),
        scale: 1,
      }));

      this.scene.add(group);
      this.hitEffects.push({
        active: false,
        age: 0,
        duration: 0,
        intensity: 0,
        group,
        ring,
        shards,
        shardStates,
        ringMaterial,
        shardMaterial,
      });
    }
  }

  warmHitEffectShaders() {
    const effect = this.hitEffects[0];
    effect.group.visible = true;
    effect.ringMaterial.opacity = 0;
    effect.shardMaterial.opacity = 0;
    effect.shards.count = 1;
    this.hitShardDummy.position.set(0, 0, 0);
    this.hitShardDummy.rotation.set(0, 0, 0);
    this.hitShardDummy.scale.setScalar(0.001);
    this.hitShardDummy.updateMatrix();
    effect.shards.setMatrixAt(0, this.hitShardDummy.matrix);
    effect.shards.instanceMatrix.needsUpdate = true;
    this.renderer.compile(this.scene, this.camera);
    effect.shards.count = 0;
    effect.group.visible = false;
  }

  updateHitShardMatrices(effect) {
    for (let index = 0; index < effect.shards.count; index += 1) {
      const state = effect.shardStates[index];
      this.hitShardDummy.position.copy(state.position);
      this.hitShardDummy.rotation.set(state.rotation.x, state.rotation.y, state.rotation.z);
      this.hitShardDummy.scale.setScalar(state.scale);
      this.hitShardDummy.updateMatrix();
      effect.shards.setMatrixAt(index, this.hitShardDummy.matrix);
    }
    effect.shards.instanceMatrix.needsUpdate = true;
  }

  createHitEffect(lane, judgement) {
    const profile = HIT_EFFECT_PROFILES[judgement];
    if (!profile) return;
    const shardCount = this.reducedMotion ? 0 : profile.shards;
    const color = LANE_COLORS[lane];
    const effect = this.hitEffects.find((candidate) => !candidate.active) ?? this.hitEffects[0];
    effect.active = true;
    effect.age = 0;
    effect.duration = profile.duration;
    effect.intensity = profile.intensity;
    effect.group.visible = true;
    effect.group.position.set(LANE_X[lane], 0.22, HIT_Z);
    effect.ring.position.y = 0;
    effect.ring.scale.setScalar(0.55);
    effect.ringMaterial.color.setHex(color);
    effect.ringMaterial.opacity = profile.intensity;
    effect.shardMaterial.color.setHex(color);
    effect.shardMaterial.opacity = profile.intensity;
    effect.shards.count = shardCount;

    for (let index = 0; index < shardCount; index += 1) {
      const angle = (index / shardCount) * Math.PI * 2 + Math.random() * 0.25;
      const speed = (1.8 + Math.random() * 2.1) * profile.intensity;
      const state = effect.shardStates[index];
      state.position.set(0, 0, 0);
      state.rotation.set(Math.random() * Math.PI, angle, Math.random() * Math.PI);
      state.velocity.set(
        Math.cos(angle) * speed,
        1.1 + Math.random() * 1.8,
        Math.sin(angle) * speed * 0.72,
      );
      state.scale = 0.7 + profile.intensity * 0.6;
    }
    this.updateHitShardMatrices(effect);
  }

  updateHitEffects(delta) {
    for (const effect of this.hitEffects) {
      if (!effect.active) continue;
      effect.age += delta;
      const progress = Math.min(1, effect.age / effect.duration);
      const fade = (1 - progress) * effect.intensity;
      effect.ring.scale.setScalar(0.55 + progress * 4.2);
      effect.ring.position.y = progress * 0.12;
      effect.ringMaterial.opacity = fade;
      effect.shardMaterial.opacity = fade * 0.9;

      for (let index = 0; index < effect.shards.count; index += 1) {
        const state = effect.shardStates[index];
        state.position.addScaledVector(state.velocity, delta);
        state.velocity.y -= 5.4 * delta;
        state.rotation.x += delta * 8;
        state.rotation.z += delta * 11;
        state.scale = 0.7 + fade * 0.6;
      }
      this.updateHitShardMatrices(effect);

      if (progress >= 1) {
        effect.active = false;
        effect.group.visible = false;
      }
    }
  }

  updateAccuracy() {
    this.stats.accuracy = this.stats.judged
      ? (this.stats.accuracyPoints / this.stats.judged) * 100
      : 100;
  }

  emitUpdate() {
    this.onUpdate?.({
      ...this.stats,
      scoreLabel: padNumber(this.stats.score, 6),
      comboLabel: padNumber(this.stats.combo, 3),
    });
  }

  finish() {
    if (this.state === "finished") return;
    this.state = "finished";
    this.synth.stop();
    this.resetHoldStates();
    this.onCountdown?.(null);
    this.emitUpdate();
    this.onState?.("finished", { stats: { ...this.stats } });
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    const delta = Math.min(this.clock.getDelta(), 0.05);
    if (this.container.clientWidth < 2 || this.container.clientHeight < 2) return;
    const elapsed = this.clock.elapsedTime;

    this.updateHitEffects(delta);
    this.updateCosmicEnvironment(delta, elapsed);

    for (let lane = 0; lane < 4; lane += 1) {
      this.pulse[lane] = Math.max(0, this.pulse[lane] - delta * 5.5);
      const holding = Boolean(this.activeHolds[lane]);
      const pressEnergy = Math.min(1, holding ? 1 : this.pulse[lane]);
      this.padMaterials[lane].emissiveIntensity = holding
        ? 1.58 + Math.sin(elapsed * 12) * 0.18
        : 0.2 + pressEnergy * 1.9;
      this.padMaterials[lane].color
        .setHex(LANE_COLORS[lane])
        .lerp(new THREE.Color(0xffffff), 0.08 + pressEnergy * 0.24)
        .multiplyScalar(holding ? 1 : 0.48 + pressEnergy * 0.52);
      this.padMaterials[lane].metalness = 0.28 - pressEnergy * 0.12;
      this.padMaterials[lane].roughness = 0.22 - pressEnergy * 0.08;
      this.padMaterials[lane].clearcoat = 1;
      const padScale = 1 - pressEnergy * 0.02;
      this.padMeshes[lane].scale.set(padScale, 1 - pressEnergy * 0.1, padScale);
      this.padMeshes[lane].position.y = PAD_REST_Y - pressEnergy * PAD_PRESS_TRAVEL;
    }

    if (this.state === "countdown" || this.state === "playing") {
      const songTime = this.synth.songTime;
      this.canvas.dataset.songTime = songTime.toFixed(3);
      if (songTime < 0) {
        const count = Math.ceil(-songTime);
        if (count !== this.lastCountdown) {
          this.lastCountdown = count;
          this.onCountdown?.(count);
        }
      } else {
        if (this.state === "countdown") {
          this.state = "playing";
          this.onCountdown?.("GO");
          this.onState?.("playing", {});
        } else if (songTime > 0.45 && this.lastCountdown !== null) {
          this.lastCountdown = null;
          this.onCountdown?.(null);
        }

        if (songTime >= this.chart.meta.duration + 0.65) this.finish();
      }

      for (const runtime of this.runtimeNotes) {
        if (runtime.status === "holding") {
          const mesh = runtime.mesh ?? this.acquireNoteMesh(runtime);
          const endTime = runtime.note.endTime ?? runtime.note.time + runtime.note.duration;
          const remaining = endTime - songTime;
          if (remaining < -GOOD_WINDOW) {
            this.failHold(runtime, "LATE RELEASE", remaining);
            continue;
          }
          const remainingLength = Math.max(0.12, (Math.max(0, remaining) / TRAVEL_SECONDS) * TRAVEL_DISTANCE);
          mesh.visible = true;
          mesh.position.z = HIT_Z - remainingLength / 2;
          mesh.position.y = 0.24;
          mesh.scale.z = remainingLength / NOTE_BASE_DEPTH;
          continue;
        }
        if (runtime.status !== "pending") continue;
        const untilHit = runtime.note.time - songTime;
        if (untilHit < -GOOD_WINDOW) {
          this.registerMiss(runtime);
          continue;
        }
        const approachWindow =
          this.state === "countdown" ? TRAVEL_SECONDS + COUNTDOWN_SECONDS : TRAVEL_SECONDS;
        const visible = untilHit <= approachWindow && untilHit >= -GOOD_WINDOW;
        if (!visible) {
          this.releaseNoteMesh(runtime);
          continue;
        }
        const mesh = this.acquireNoteMesh(runtime);
        const progress = 1 - untilHit / TRAVEL_SECONDS;
        const headZ = SPAWN_Z + progress * TRAVEL_DISTANCE;
        if (runtime.isHold) {
          const holdLength = (runtime.note.duration / TRAVEL_SECONDS) * TRAVEL_DISTANCE;
          mesh.position.z = headZ - holdLength / 2;
          mesh.scale.z = Math.max(1.3, holdLength / NOTE_BASE_DEPTH);
        } else {
          mesh.position.z = headZ;
        }
        mesh.position.y = 0.18 + Math.max(0, progress - 0.92) * 0.45;
      }
    } else if (this.canvas.dataset.songTime) {
      delete this.canvas.dataset.songTime;
    }

    this.updateCameraShake(delta, elapsed);
    this.composer.render();
  }

  resize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width < 2 || height < 2) return;
    const pixelCount = width * height;
    const devicePixelRatio = window.devicePixelRatio || 1;
    const is4K = width >= 3200 || pixelCount >= 6_500_000;
    const isQhdPlus = !is4K && (width >= 2200 || pixelCount >= 3_000_000);
    const renderTier = is4K ? "4k" : isQhdPlus ? "qhd" : "standard";
    const rendererPixelRatio = is4K
      ? Math.min(devicePixelRatio, 0.64)
      : isQhdPlus
        ? Math.min(devicePixelRatio, 1)
        : Math.min(devicePixelRatio, 1.5);

    this.renderer.setPixelRatio(rendererPixelRatio);
    this.renderer.setSize(width, height, false);
    const postFxScale = is4K
      ? 0.45
      : isQhdPlus
        ? 0.7
        : pixelCount <= 1_100_000 || width < 1200
          ? 1
          : 0.9;
    this.composer?.setPixelRatio(postFxScale);
    this.composer?.setSize(width, height);
    if (this.centerRailMaterial) {
      this.centerRailMaterial.uniforms.uViewportWidth.value = width;
      this.centerRailMaterial.uniforms.uHalfWidthCss.value = Math.max(0.72, 0.5 / postFxScale);
    }
    if (this.starMaterial) {
      this.starMaterial.uniforms.uPointScale.value = height * postFxScale * 0.8;
    }
    this.canvas.dataset.postFxScale = postFxScale.toFixed(2);
    this.canvas.dataset.postFxWidth = String(Math.round(width * postFxScale));
    this.canvas.dataset.postFxHeight = String(Math.round(height * postFxScale));
    this.canvas.dataset.antiAliasing = this.fxaaPass?.enabled ? "fxaa" : "none";
    this.canvas.dataset.rendererPixelRatio = rendererPixelRatio.toFixed(2);
    this.canvas.dataset.renderTier = renderTier;
    const aspect = width / height;
    const compactHeightProgress = THREE.MathUtils.clamp(
      (CAMERA_FRAMING.compactHeightStart - height) /
        (CAMERA_FRAMING.compactHeightStart - CAMERA_FRAMING.compactHeightEnd),
      0,
      1,
    );
    const landscapeFov = THREE.MathUtils.lerp(
      CAMERA_FRAMING.desktopFov,
      CAMERA_FRAMING.compactLandscapeFov,
      compactHeightProgress,
    );
    this.camera.aspect = aspect;
    this.camera.fov =
      aspect < 0.8
        ? Math.min(78, CAMERA_FRAMING.desktopFov * (0.8 / Math.max(aspect, 0.46)))
        : landscapeFov;
    this.camera.updateProjectionMatrix();
    this.canvas.dataset.cameraFov = this.camera.fov.toFixed(2);

    this.camera.updateMatrixWorld();
    const lanePositions = LANE_X.map((x) => new THREE.Vector3(x, 0.22, HIT_Z).project(this.camera));
    lanePositions.forEach((position, lane) => {
      this.container.style.setProperty(`--lane-${lane}-x`, `${(position.x * 0.5 + 0.5) * 100}%`);
    });
    const hitLineY = (-lanePositions[0].y * 0.5 + 0.5) * 100;
    this.container.style.setProperty("--hit-line-y", `${hitLineY}%`);
    this.canvas.dataset.hitLineY = hitLineY.toFixed(2);
  }
}
