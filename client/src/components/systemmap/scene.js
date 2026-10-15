/**
 * MapScene — the live map of the agent as a small universe (three.js).
 *
 *   ☀ Wanar Core      a blue-white star in the centre (the router)
 *   ◯ inner orbit     channels as planets: Web, Telegram, Email, Peka, Briefing…
 *   ◯ outer orbit     providers as big planets, far apart, with their models as
 *                     moons that really orbit them
 *   ✧ deep space      providers without an API key, as distant dim stars
 *
 * Every real trace event becomes a comet that flies along a stream of light and
 * CARRIES THE TEXT it is about: the incoming message, "→ provider / model", the
 * answer coming back, the tool being used, the reply delivered to Telegram.
 * Comets, their text bubbles, planets and moons are all clickable.
 *
 * by Wisnu Alfian Nur Ashar
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CHANNEL_META, FAIL_REASON } from './explain.js';
import { sfx } from './sfx.js';

export const COLORS = {
  in: 0x38bdf8,
  route: 0xfbbf24,
  ok: 0x4ade80,
  err: 0xf87171,
  warn: 0xfb923c,
  tool: 0xc084fc,
  code: 0x2dd4bf,
  out: 0x34d399,
  core: 0x7dd3fc,
  dim: 0x475569,
};

const STATUS_RING = { ok: 0x4ade80, warn: 0xfbbf24, err: 0xf87171, off: 0x475569 };
const PLANET_HUES = [0x60a5fa, 0xf472b6, 0xa78bfa, 0x34d399, 0xfbbf24, 0xf87171, 0x22d3ee, 0xfb923c, 0xa3e635, 0xe879f9, 0x93c5fd, 0xfda4af];

const R_CHANNELS = 21;   // inner orbit
const R_PROVIDERS = 46;  // outer orbit
const R_IDLE = 78;       // deep space

// ------------------------------------------------------------------ textures

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function glowTexture() {
  return canvasTex(128, 128, (g) => {
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.15, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.22)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  });
}

function nebulaTexture(seed) {
  let s = seed;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  return canvasTex(256, 256, (g) => {
    for (let i = 0; i < 26; i++) {
      const x = 60 + rnd() * 136; const y = 60 + rnd() * 136; const r = 30 + rnd() * 90;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(255,255,255,${0.05 + rnd() * 0.08})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
    }
  });
}

/** Banded "gas giant" surface in the planet's colour. */
function planetTexture(hex, seed) {
  let s = seed * 997 + 13;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const base = new THREE.Color(hex);
  return canvasTex(256, 128, (g, w, h) => {
    for (let y = 0; y < h; y++) {
      const band = Math.sin(y * 0.18 + seed) * 0.5 + Math.sin(y * 0.05 + seed * 2) * 0.5;
      const c = base.clone().offsetHSL((rnd() - 0.5) * 0.02, 0, band * 0.12 + (rnd() - 0.5) * 0.05);
      g.fillStyle = `#${c.getHexString()}`;
      g.fillRect(0, y, w, 1);
    }
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `rgba(255,255,255,${rnd() * 0.08})`;
      g.beginPath(); g.ellipse(rnd() * w, rnd() * h, 6 + rnd() * 24, 1 + rnd() * 3, 0, 0, Math.PI * 2); g.fill();
    }
  });
}

function starTexture() {
  return canvasTex(256, 128, (g, w, h) => {
    g.fillStyle = '#dbeafe'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) {
      const x = Math.random() * w; const y = Math.random() * h; const r = 1 + Math.random() * 4;
      g.fillStyle = Math.random() > 0.5 ? 'rgba(125,211,252,0.55)' : 'rgba(255,255,255,0.7)';
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
  });
}

// ------------------------------------------------------------------ shaders

/**
 * Light streams are camera-facing ribbons whose curve is computed on the GPU from the two
 * node positions (uniforms), so they follow planets that orbit nonstop at no CPU cost.
 */
const STREAM_VERT = `
attribute float aT;
attribute float aSide;
uniform vec3 uA;
uniform vec3 uB;
uniform float uWidth;
varying vec2 vUv;
vec3 bez(float t) {
  vec3 m = (uA + uB) * 0.5;
  m.y += distance(uA, uB) * 0.22;
  float u = 1.0 - t;
  return u * u * uA + 2.0 * u * t * m + t * t * uB;
}
void main() {
  vec3 p = bez(aT);
  vec3 q = bez(min(aT + 0.01, 1.0));
  vec3 tang = normalize(q - p + vec3(0.00001));
  vec3 toCam = normalize(cameraPosition - p);
  vec3 side = normalize(cross(tang, toCam) + vec3(0.00001));
  vUv = vec2(aT, aSide);
  gl_Position = projectionMatrix * viewMatrix * vec4(p + side * aSide * uWidth, 1.0);
}`;

/** Full-screen sky: gradient, sun, moon with real phase, rotating stars, milky way, clouds. */
const SKY_VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const SKY_FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uTop;
uniform vec3 uHor;
uniform vec2 uSun;
uniform vec3 uSunCol;
uniform float uSunVis;
uniform vec2 uMoon;
uniform float uMoonVis;
uniform float uPhase;
uniform float uNight;
uniform float uDay;
uniform float uGlow;
varying vec2 vUv;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0; float a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}
void main() {
  vec2 uv = vUv;
  float asp = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(asp, 1.0);

  // sky gradient
  float h = smoothstep(0.0, 1.0, uv.y);
  vec3 col = mix(uHor, uTop, pow(h, 0.8));

  // sun: scattering, disc, corona
  vec2 sp = (uSun - 0.5) * vec2(asp, 1.0);
  float ds = length(p - sp);
  col += uSunCol * (0.35 * exp(-ds * 2.2) + 0.5 * exp(-ds * 7.0)) * uSunVis * (0.5 + uGlow);
  col += uSunCol * exp(-ds * 18.0) * 0.9 * uSunVis;
  col = mix(col, uSunCol * 1.7, (1.0 - smoothstep(0.034, 0.045, ds)) * uSunVis);

  // stars turn slowly around a celestial pole below the screen (nonstop rotation)
  float ang = uTime * 0.0045;
  mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
  vec2 q2 = rot * (p - vec2(0.0, -0.7));
  float stars = 0.0;
  for (int k = 0; k < 3; k++) {
    float sc = 38.0 + float(k) * 52.0;
    vec2 g = q2 * sc;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    float r = hash(id + float(k) * 7.7);
    vec2 o = vec2(hash(id + 3.1), hash(id + 9.7)) - 0.5;
    float dstar = length(f - o * 0.7);
    float tw = 0.6 + 0.4 * sin(uTime * (1.5 + r * 3.0) + r * 60.0);
    float sv = (1.0 - smoothstep(0.0, 0.07, dstar)) * step(0.86, r) * tw;
    stars += sv * (1.0 - 0.25 * float(k));
  }
  col += vec3(0.85, 0.9, 1.0) * stars * uNight * smoothstep(0.0, 0.35, uv.y + 0.1);

  // milky way band
  float band = exp(-pow((q2.y * 0.8 - q2.x * 0.45 + 0.1) * 3.0, 2.0));
  col += vec3(0.28, 0.33, 0.55) * fbm(q2 * 6.0) * band * 0.55 * uNight;

  // shooting star every few seconds at night
  float cyc = floor(uTime / 9.0);
  float ph = fract(uTime / 9.0);
  vec2 head = vec2(hash(vec2(cyc, 1.0)) * 1.4 - 0.7, 0.2 + hash(vec2(cyc, 2.0)) * 0.3);
  vec2 dir = normalize(vec2(1.0, -0.45));
  head += dir * ph * 0.9;
  vec2 rel = p - head;
  float along = dot(rel, -dir);
  float perp = abs(dot(rel, vec2(-dir.y, dir.x)));
  float streak = (1.0 - smoothstep(0.0, 0.003, perp)) * step(0.0, along) * (1.0 - smoothstep(0.0, 0.16, along));
  streak *= smoothstep(0.0, 0.08, ph) * (1.0 - smoothstep(0.3, 0.45, ph)) * step(0.45, hash(vec2(cyc, 3.0)));
  col += vec3(0.9, 0.95, 1.0) * streak * uNight * 1.2;

  // moon with real phase and craters
  vec2 mp = (uMoon - 0.5) * vec2(asp, 1.0);
  vec2 d = p - mp;
  float dm = length(d);
  float R = 0.04;
  col += vec3(0.7, 0.8, 1.0) * exp(-dm * 13.0) * 0.4 * uMoonVis * (0.25 + 0.75 * abs(sin(uPhase * 0.5)));
  if (dm < R * 1.05) {
    vec2 q = d / R;
    float z = sqrt(max(0.0, 1.0 - dot(q, q)));
    vec3 n = vec3(q, z);
    vec3 L = normalize(vec3(sin(uPhase), 0.0, -cos(uPhase)));
    float lit = smoothstep(-0.03, 0.14, dot(n, L));
    float cr = fbm(q * 4.2 + 3.0);
    vec3 mc = mix(vec3(0.58, 0.6, 0.67), vec3(0.95, 0.94, 0.88), cr);
    vec3 shade = mc * (0.07 + 0.93 * lit);
    col = mix(col, shade, (1.0 - smoothstep(R * 0.94, R, dm)) * uMoonVis);
  }

  // clouds drift by day, tinted by the low sun at dawn and dusk
  vec2 cp = vec2(p.x * 1.2 + uTime * 0.006, p.y * 2.2);
  float c = smoothstep(0.52, 0.8, fbm(cp * 2.4)) * smoothstep(0.05, 0.5, uv.y);
  vec3 cc = mix(vec3(1.0), uSunCol * 1.25, clamp(uGlow, 0.0, 1.0) * 0.85);
  col = mix(col, cc, c * (uDay * 0.55 + 0.1 * (1.0 - uNight)));

  col *= 1.0 - 0.7 * dot(uv - 0.5, uv - 0.5);
  gl_FragColor = vec4(col, 1.0);
}`;

/** Sky colours by hour (WIB): [hour, top, horizon]. */
const SKY_KEYS = [
  [0.0, 0x02030a, 0x0a1130],
  [4.3, 0x03061a, 0x111a42],
  [5.1, 0x0c1238, 0x45306a],
  [5.8, 0x23336b, 0xf08a5d],
  [6.6, 0x3d73bd, 0xffc58a],
  [8.0, 0x1f70d4, 0x8fcaff],
  [12.0, 0x1766c8, 0x7fc2ff],
  [15.5, 0x2269bf, 0x9bd0ff],
  [16.9, 0x30579f, 0xffd29a],
  [17.8, 0x3a4a95, 0xff9a4d],
  [18.5, 0x1b1f4d, 0xc2477a],
  [19.2, 0x0a0d28, 0x3a2a6a],
  [20.5, 0x03051a, 0x0d1536],
  [24.0, 0x02030a, 0x0a1130],
];

const STREAM_FRAG = `
uniform vec3 uColor;
uniform vec3 uHot;
uniform float uTime;
uniform float uHeat;
uniform float uBase;
varying vec2 vUv;
void main() {
  float flow = fract(vUv.x * 9.0 - uTime * 0.45);
  float dash = smoothstep(0.0, 0.12, flow) * smoothstep(0.45, 0.12, flow);
  float a = uBase * (0.55 + dash * 0.9) + uHeat * (0.55 + dash * 0.45);
  vec3 col = mix(uColor, uHot, clamp(uHeat * 1.4, 0.0, 1.0));
  gl_FragColor = vec4(col * (1.0 + uHeat * 1.2), a);
}`;

const STAR_FRAG = `
uniform float uTime;
uniform vec3 uA;
uniform vec3 uB;
varying vec3 vPos;
varying vec3 vNormal;
float hash(vec3 p){ p = fract(p * 0.3183099 + .1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
void main() {
  vec3 p = normalize(vPos) * 3.2;
  float n = noise(p + uTime * 0.35) * 0.55 + noise(p * 2.3 - uTime * 0.5) * 0.3 + noise(p * 5.1 + uTime * 0.8) * 0.15;
  float rim = pow(1.0 - abs(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0))), 2.0);
  vec3 col = mix(uA, uB, n) + rim * 0.6;
  gl_FragColor = vec4(col * (1.0 + n * 0.8), 1.0);
}`;

const STAR_VERT = `
varying vec3 vPos;
varying vec3 vNormal;
void main() {
  vPos = position;
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const ATMO_VERT = `
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const ATMO_FRAG = `
uniform vec3 uColor;
uniform float uPower;
uniform float uBoost;
varying vec3 vN;
varying vec3 vV;
void main() {
  float f = pow(1.0 - max(dot(vN, vV), 0.0), uPower);
  gl_FragColor = vec4(uColor * (1.0 + uBoost), f * (0.85 + uBoost));
}`;

function shortNum(n) {
  const v = Number(n || 0);
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}jt`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}rb`;
  return String(v);
}

function hashStr(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}

function clip(text, n) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// ------------------------------------------------------------------ scene

export class MapScene {
  /**
   * @param {HTMLElement} host
   * @param {{onSelectNode?:Function, onSelectTrace?:Function, reducedMotion?:boolean}} opts
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = opts;
    this.reduced = Boolean(opts.reducedMotion);
    this.nodes = new Map();
    this.edges = new Map();
    this.particles = [];
    this.traceState = new Map();
    this.highlight = null;
    this.follow = false;
    this.disposed = false;
    this.clock = new THREE.Clock();
    this.time = 0;
    this.glowTex = glowTexture();
    this.textures = [];
    this.bolts = [];
    this.rings = [];
    this.bursts = [];
    this.shake = 0;
    this.speed = Number(opts.speed) || 2;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x02030a, 1);
    this.renderer.autoClear = false; // sky backdrop first, then the universe on top
    this.renderer.domElement.className = 'sm-canvas';
    host.appendChild(this.renderer.domElement);

    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'sm-labels';
    host.appendChild(this.labelLayer);
    this.flashEl = document.createElement('div');
    this.flashEl.className = 'sm-flash';
    host.appendChild(this.flashEl);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 900);
    this.camera.position.set(0, 40, 95);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.minDistance = 10;
    this.controls.maxDistance = 220;
    this.controls.autoRotate = !this.reduced;
    this.controls.autoRotateSpeed = 0.22;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; this.userMoved = true; this.flyTo = null; clearTimeout(this._resumeTimer); });
    // nonstop: the camera drifts around again a few seconds after you let go
    this.controls.addEventListener('end', () => {
      clearTimeout(this._resumeTimer);
      this._resumeTimer = setTimeout(() => {
        if (!this.disposed && !this.follow && !this.focus && !this.flyTo) this.controls.autoRotate = !this.reduced;
      }, 6000);
    });

    this.scene.add(new THREE.AmbientLight(0x6677aa, 0.35));
    this.coreLight = new THREE.PointLight(0xbfe3ff, 3.2, 160, 1.2);
    this.scene.add(this.coreLight);

    this._universe();
    this._shield();
    this._initSky();

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._onClick = (e) => this._pick(e, true);
    this._onMove = (e) => this._pick(e, false);
    this.renderer.domElement.addEventListener('click', this._onClick);
    this.renderer.domElement.addEventListener('pointermove', this._onMove);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();

    this._loop = this._loop.bind(this);
    this.raf = requestAnimationFrame(this._loop);
  }

  _tex(t) { this.textures.push(t); return t; }

  // ---------------------------------------------------------- deep space

  _universe() {
    // two star layers that twinkle out of phase
    this.starLayers = [];
    for (let layer = 0; layer < 2; layer++) {
      const n = 1800;
      const pos = new Float32Array(n * 3);
      const col = new Float32Array(n * 3);
      const c = new THREE.Color();
      for (let i = 0; i < n; i++) {
        const r = 180 + Math.random() * 260;
        const t = Math.random() * Math.PI * 2;
        const p = Math.acos(2 * Math.random() - 1);
        pos[i * 3] = r * Math.sin(p) * Math.cos(t);
        pos[i * 3 + 1] = r * Math.sin(p) * Math.sin(t);
        pos[i * 3 + 2] = r * Math.cos(p);
        c.setHSL(0.55 + Math.random() * 0.15, 0.4, 0.75 + Math.random() * 0.25);
        col.set([c.r, c.g, c.b], i * 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const m = new THREE.PointsMaterial({ size: layer ? 1.6 : 1.1, map: this.glowTex, vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
      const pts = new THREE.Points(g, m);
      this.scene.add(pts);
      this.starLayers.push(pts);
    }

    // spiral galaxy dust beneath the system
    const n = 5000;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const arm = i % 3;
      const r = 8 + Math.pow(Math.random(), 0.7) * 110;
      const a = r * 0.045 + (arm / 3) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
      pos[i * 3] = Math.cos(a) * r + (Math.random() - 0.5) * 6;
      pos[i * 3 + 1] = (Math.random() - 0.5) * (6 - r * 0.03) - 14;
      pos[i * 3 + 2] = Math.sin(a) * r + (Math.random() - 0.5) * 6;
      c.setHSL(0.6 + (r / 110) * 0.25, 0.7, 0.55 + Math.random() * 0.2);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    gg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.galaxy = new THREE.Points(gg, new THREE.PointsMaterial({ size: 0.9, map: this.glowTex, vertexColors: true, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.scene.add(this.galaxy);

    // nebulae
    this.nebulae = [];
    const hues = [0x6d28d9, 0x0e7490, 0xbe185d, 0x1d4ed8, 0x7c3aed, 0x0f766e];
    hues.forEach((h, i) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._tex(nebulaTexture(i + 3)), color: h, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
      const a = (i / hues.length) * Math.PI * 2;
      s.position.set(Math.cos(a) * 150, (i % 2 ? 40 : -50) + i * 6, Math.sin(a) * 150);
      s.scale.setScalar(170 + (i % 3) * 50);
      this.scene.add(s);
      this.nebulae.push(s);
    });

    // orbit guides
    this.orbits = [];
    for (const [r, tilt, color] of [[R_CHANNELS, 0.28, 0x38bdf8], [R_PROVIDERS, -0.16, 0xa78bfa]]) {
      const pts = new THREE.EllipseCurve(0, 0, r, r).getPoints(160).map((p) => new THREE.Vector3(p.x, 0, p.y));
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false }));
      line.rotation.x = tilt;
      this.scene.add(line);
      this.orbits.push(line);
    }
  }

  resize() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.labelLayer.classList.toggle('compact', w < 560);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._fit();
  }

  /** Frames the whole system (bounding sphere) for any screen shape. */
  _fit() {
    if (this.userMoved) return;
    const r = this.radius || R_PROVIDERS + 8;
    const vfov = (this.camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    // A steep view (~50° above the orbital plane) keeps the orbits round, so planets spread out
    const d = Math.min(200, (r / Math.sin(Math.min(vfov, hfov) / 2)) * (this.camera.aspect < 0.9 ? 0.98 : 0.74));
    this.camera.position.set(d * 0.1, d * 0.74, d * 0.66);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  // ------------------------------------------------------------- graph

  _placeOnOrbit(i, n, r, tilt, phase = 0, wobble = 0) {
    const a = phase + (i / Math.max(1, n)) * Math.PI * 2;
    const v = new THREE.Vector3(Math.cos(a) * r, Math.sin(a * 2 + i) * wobble, Math.sin(a) * r);
    v.applyAxisAngle(new THREE.Vector3(1, 0, 0), tilt);
    return v;
  }

  setGraph(overview) {
    if (!overview) return;
    this.lastOverview = overview;
    const want = new Map();
    const channels = overview.channels || [];
    const providers = overview.providers || [];
    const live = providers.filter((p) => p.configured);
    const idle = providers.filter((p) => !p.configured);

    want.set('core', {
      kind: 'core', pos: new THREE.Vector3(0, 0, 0), color: new THREE.Color(COLORS.core), size: 3.4, ring: 'ok',
      label: { icon: '☀️', title: 'Wanar Core', sub: `router · default ${overview.router?.defaultProvider || '-'}` },
      info: { type: 'core', router: overview.router, usage: overview.usage },
    });

    channels.forEach((c, i) => {
      const meta = CHANNEL_META[c.id] || CHANNEL_META.system;
      want.set(`c:${c.id}`, {
        kind: 'channel', pos: this._placeOnOrbit(i, channels.length, R_CHANNELS, 0.28, Math.PI * 0.85, 2.5),
        color: new THREE.Color(meta.color), size: 1.35, ring: c.active ? 'ok' : 'off', seed: i + 1,
        label: { icon: meta.icon, title: meta.label, sub: c.stats?.requests ? `${c.stats.requests} permintaan/24j` : (c.active ? 'aktif' : 'nonaktif') },
        info: { type: 'channel', ...c },
      });
    });

    // tools: a small violet world with an asteroid belt, just below the star
    want.set('tools', {
      kind: 'tools', pos: new THREE.Vector3(0, -11, 7), color: new THREE.Color(COLORS.tool), size: 1.2, ring: 'ok',
      label: { icon: '🛠️', title: 'Alat (tools)', sub: `${overview.tools?.count || 0} alat` },
      info: { type: 'tools', ...overview.tools },
    });

    live.forEach((p, i) => {
      const hue = p.isDefault ? 0x60a5fa : PLANET_HUES[(hashStr(p.id) + 1) % PLANET_HUES.length];
      const pos = this._placeOnOrbit(i, live.length, R_PROVIDERS, -0.16, Math.PI * 0.12, 7);
      want.set(`p:${p.id}`, {
        kind: 'provider', pos, color: new THREE.Color(hue), size: p.isDefault ? 2.6 : 2.1, ring: providerTone(p), seed: hashStr(p.id) % 50,
        label: { icon: p.isDefault ? '⭐' : '🪐', title: p.label, sub: `${p.modelCount} model · ${shortNum(p.usageToday)} token` },
        info: { type: 'provider', ...p },
      });
      const shown = (p.models || []).slice(0, 6);
      shown.forEach((m, j) => {
        want.set(`m:${p.id}:${m.id}`, {
          kind: 'model', pos: pos.clone(), color: new THREE.Color(m.skip ? COLORS.warn : (m.lastSuccess ? COLORS.ok : 0xe2e8f0)), size: 0.42,
          ring: m.skip ? 'warn' : (m.lastSuccess ? 'ok' : 'off'),
          orbit: { center: `p:${p.id}`, r: 4 + j * 1.05, speed: (0.22 - j * 0.02) * (j % 2 ? -1 : 1), phase: (j / shown.length) * Math.PI * 2, tilt: 0.35 + j * 0.12 },
          label: { title: clip(m.id, 28), sub: m.tokensToday ? `${shortNum(m.tokensToday)} tkn` : '', small: true },
          info: { type: 'model', provider: p.id, providerLabel: p.label, ...m },
        });
      });
    });

    idle.forEach((p, i) => {
      const a = (i / Math.max(1, idle.length)) * Math.PI * 2 + 0.4;
      want.set(`p:${p.id}`, {
        kind: 'idle', pos: new THREE.Vector3(Math.cos(a) * R_IDLE, 18 + (i % 3) * 7, Math.sin(a) * R_IDLE), color: new THREE.Color(COLORS.dim), size: 0.8, ring: 'off',
        label: { title: p.label, sub: 'belum aktif', small: true, dim: true },
        info: { type: 'provider', ...p },
      });
    });

    // Everything revolves around the Core nonstop: channels fast, providers slower, idle stars slowest.
    const ofKind = (k) => [...want.values()].filter((v) => v.kind === k);
    const chs = ofKind('channel');
    chs.forEach((v, i) => { v.helio = { r: R_CHANNELS, a0: Math.PI * 0.85 + (i / chs.length) * Math.PI * 2, speed: 0.045, tilt: 0.28, wobble: 2.5, i }; });
    const pvs = ofKind('provider');
    pvs.forEach((v, i) => { v.helio = { r: R_PROVIDERS, a0: Math.PI * 0.12 + (i / pvs.length) * Math.PI * 2, speed: 0.016, tilt: -0.16, wobble: 7, i }; });
    ofKind('tools').forEach((v) => { v.helio = { r: 12, a0: 1.2, speed: 0.1, tilt: 0.9, wobble: 1, i: 0 }; });
    const ids = ofKind('idle');
    ids.forEach((v, i) => { v.helio = { r: R_IDLE, a0: 0.4 + (i / Math.max(1, ids.length)) * Math.PI * 2, speed: 0.006, tilt: 0.3, wobble: 4, i }; });

    for (const [id, n] of this.nodes) if (!want.has(id)) this._removeNode(id, n);
    for (const [id, spec] of want) this._upsertNode(id, spec);

    // streams of light
    const keep = new Set();
    const link = (a, b, color, base) => { const k = `${a}|${b}`; keep.add(k); this._upsertEdge(k, a, b, color, base); };
    for (const c of channels) link(`c:${c.id}`, 'core', CHANNEL_META[c.id]?.color || '#94a3b8', c.active ? 0.22 : 0.06);
    link('core', 'tools', '#c084fc', 0.18);
    for (const p of live) link('core', `p:${p.id}`, p.isDefault ? '#60a5fa' : '#8b9dc3', p.isDefault ? 0.3 : 0.15);
    for (const [k, e] of this.edges) if (!keep.has(k)) { this.scene.remove(e.mesh); e.mesh.geometry.dispose(); e.mat.dispose(); this.edges.delete(k); }

    this.radius = R_PROVIDERS + 6;
    this._fit();
  }

  _upsertNode(id, spec) {
    let n = this.nodes.get(id);
    if (!n) {
      const group = new THREE.Group();
      let mesh;
      if (spec.kind === 'core') {
        this.coreMat = new THREE.ShaderMaterial({
          vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
          uniforms: { uTime: { value: 0 }, uA: { value: new THREE.Color(0x1d4ed8) }, uB: { value: new THREE.Color(0xe0f2fe) } },
        });
        mesh = new THREE.Mesh(new THREE.SphereGeometry(spec.size, 64, 64), this.coreMat);
        const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(spec.size * 1.45, 1), new THREE.MeshBasicMaterial({ color: COLORS.core, wireframe: true, transparent: true, opacity: 0.22 }));
        group.add(shell);
        group.userData.shell = shell;
        const corona = [];
        for (const [scale, op, col] of [[7, 0.9, 0xffffff], [13, 0.55, 0x7dd3fc], [24, 0.28, 0x3b82f6]]) {
          const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: col, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false }));
          s.scale.setScalar(spec.size * scale * 0.5);
          group.add(s);
          corona.push({ s, base: spec.size * scale * 0.5, op });
        }
        group.userData.corona = corona;
      } else if (spec.kind === 'tools') {
        mesh = new THREE.Mesh(new THREE.OctahedronGeometry(spec.size, 0), new THREE.MeshStandardMaterial({ color: spec.color, emissive: spec.color, emissiveIntensity: 0.5, flatShading: true }));
        const n2 = 140;
        const pos = new Float32Array(n2 * 3);
        for (let i = 0; i < n2; i++) {
          const a = Math.random() * Math.PI * 2; const r = spec.size * 2.2 + Math.random() * 1.2;
          pos.set([Math.cos(a) * r, (Math.random() - 0.5) * 0.4, Math.sin(a) * r], i * 3);
        }
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const belt = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xd8b4fe, size: 0.25, transparent: true, opacity: 0.8, depthWrite: false }));
        belt.rotation.x = 0.4;
        group.add(belt);
        group.userData.belt = belt;
      } else if (spec.kind === 'model' || spec.kind === 'idle') {
        mesh = new THREE.Mesh(new THREE.SphereGeometry(spec.size, 20, 20), new THREE.MeshStandardMaterial({ color: spec.color, emissive: spec.color, emissiveIntensity: spec.kind === 'idle' ? 0.6 : 0.35, roughness: 0.8 }));
      } else {
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(spec.size, 40, 40),
          new THREE.MeshStandardMaterial({ map: this._tex(planetTexture(spec.color.getHex(), spec.seed || 1)), emissive: spec.color, emissiveIntensity: 0.12, roughness: 0.75, metalness: 0.05 })
        );
        if (spec.kind === 'provider' && (spec.seed || 0) % 3 === 0) {
          const ringMesh = new THREE.Mesh(new THREE.RingGeometry(spec.size * 1.35, spec.size * 2.0, 64), new THREE.MeshBasicMaterial({ color: spec.color, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }));
          ringMesh.rotation.x = Math.PI / 2.4;
          group.add(ringMesh);
        }
      }
      mesh.userData.nodeId = id;
      group.add(mesh);

      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: spec.color, transparent: true, opacity: spec.kind === 'core' ? 0 : 0.4, blending: THREE.AdditiveBlending, depthWrite: false }));
      glow.scale.setScalar(spec.size * 4.5);
      group.add(glow);

      if (spec.kind === 'provider' || spec.kind === 'channel') {
        const atmoMat = new THREE.ShaderMaterial({
          vertexShader: ATMO_VERT, fragmentShader: ATMO_FRAG, transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
          uniforms: { uColor: { value: spec.color.clone() }, uPower: { value: 2.4 }, uBoost: { value: 0 } },
        });
        const atmo = new THREE.Mesh(new THREE.SphereGeometry(spec.size * 1.32, 32, 32), atmoMat);
        group.add(atmo);
        group.userData.atmo = atmoMat;
      }

      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(spec.size * 1.5, Math.max(0.03, spec.size * 0.045), 8, 64),
        new THREE.MeshBasicMaterial({ color: STATUS_RING[spec.ring] || STATUS_RING.off, transparent: true, opacity: spec.kind === 'core' ? 0 : 0.7 })
      );
      group.add(halo);

      let orbitLine = null;
      if (spec.orbit) {
        const pts = new THREE.EllipseCurve(0, 0, spec.orbit.r, spec.orbit.r).getPoints(64).map((p) => new THREE.Vector3(p.x, 0, p.y));
        orbitLine = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.12, depthWrite: false }));
        this.scene.add(orbitLine);
      }

      const label = document.createElement('button');
      label.type = 'button';
      label.className = `sm-label sm-label-${spec.kind}`;
      label.addEventListener('click', (e) => { e.stopPropagation(); this.opts.onSelectNode?.(this.nodes.get(id)?.info); });
      this.labelLayer.appendChild(label);

      this.scene.add(group);
      n = { id, kind: spec.kind, group, mesh, glow, halo, label, orbitLine, pos: spec.pos.clone(), base: spec.size, spin: 0.05 + Math.random() * 0.12 };
      group.position.copy(spec.pos);
      this.nodes.set(id, n);
    }
    n.info = spec.info;
    n.orbit = spec.orbit || null;
    n.helio = spec.helio || null;
    if (!n.orbit && !n.helio) { n.pos.copy(spec.pos); n.group.position.copy(spec.pos); }
    n.halo.material.color.setHex(STATUS_RING[spec.ring] || STATUS_RING.off);
    n.baseGlow = spec.color.clone();
    n.glow.material.color.copy(spec.color);
    if (spec.kind === 'model' || spec.kind === 'idle') { n.mesh.material.color.copy(spec.color); n.mesh.material.emissive.copy(spec.color); }
    const l = spec.label;
    n.label.classList.toggle('dim', Boolean(l.dim));
    n.label.classList.toggle('small', Boolean(l.small));
    n.label.dataset.tone = spec.ring;
    n.label.innerHTML = `${l.icon ? `<span class="sm-label-icon">${l.icon}</span>` : ''}<span class="sm-label-text"><b>${escapeHtml(l.title)}</b>${l.sub ? `<small>${escapeHtml(l.sub)}</small>` : ''}</span>`;
    n.label.setAttribute('aria-label', `${l.title}${l.sub ? ` — ${l.sub}` : ''}`);
  }

  _removeNode(id, n) {
    this.scene.remove(n.group);
    n.group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    if (n.orbitLine) { this.scene.remove(n.orbitLine); n.orbitLine.geometry.dispose(); n.orbitLine.material.dispose(); }
    n.label.remove();
    this.nodes.delete(id);
  }

  _curve(a, b) {
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.y += a.distanceTo(b) * 0.22;
    return new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone());
  }

  _upsertEdge(k, a, b, color, base) {
    const na = this.nodes.get(a);
    const nb = this.nodes.get(b);
    if (!na || !nb) return;
    let e = this.edges.get(k);
    if (!e) {
      const N = 72;
      const pos = new Float32Array((N + 1) * 2 * 3);
      const aT = new Float32Array((N + 1) * 2);
      const aSide = new Float32Array((N + 1) * 2);
      const idx = [];
      for (let i = 0; i <= N; i++) {
        aT[i * 2] = i / N; aT[i * 2 + 1] = i / N;
        aSide[i * 2] = -1; aSide[i * 2 + 1] = 1;
        if (i < N) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
      geo.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1));
      geo.setIndex(idx);
      const mat = new THREE.ShaderMaterial({
        vertexShader: STREAM_VERT, fragmentShader: STREAM_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
        uniforms: {
          uColor: { value: new THREE.Color(color) }, uHot: { value: new THREE.Color(color) }, uTime: { value: 0 }, uHeat: { value: 0 }, uBase: { value: base },
          uA: { value: na.pos.clone() }, uB: { value: nb.pos.clone() }, uWidth: { value: 0.11 },
        },
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false; // the curve is computed on the GPU
      this.scene.add(mesh);
      e = { mesh, mat, heat: 0, a, b };
      this.edges.set(k, e);
    } else {
      e.mat.uniforms.uColor.value.set(color);
      e.mat.uniforms.uBase.value = base;
    }
  }

  _edge(a, b) {
    return this.edges.get(`${a}|${b}`) || this.edges.get(`${b}|${a}`) || null;
  }

  // -------------------------------------------------------------- motion

  pulse(nodeId, color = COLORS.core) {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    n.pulse = { t0: performance.now(), color: new THREE.Color(color) };
    n.lastActive = performance.now();
  }

  /**
   * A comet along a path of node ids, carrying a text bubble.
   * @param {string[]} path
   * @param {{color?:number, traceId?:string, text?:string, icon?:string, size?:number}} o
   */
  spawn(path, o = {}) {
    const ids = path.filter((id) => this.nodes.has(id));
    const hops = [];
    for (let i = 0; i < ids.length - 1; i++) if (ids[i] !== ids[i + 1]) hops.push([ids[i], ids[i + 1]]);
    if (!hops.length || this.particles.length > 120) return;

    const color = new THREE.Color(o.color ?? COLORS.in);
    const size = o.size ?? 2.2;
    const mk = (c, s, op = 1) => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: c, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false }));
      sp.scale.setScalar(s);
      this.scene.add(sp);
      return sp;
    };
    const head = mk(color, size);
    head.userData.traceId = o.traceId || null;
    const core = mk(0xffffff, size * 0.4);
    const trail = [];
    for (let i = 0; i < 14; i++) trail.push(mk(color, size * (0.85 - i * 0.05), 0.6 * (1 - i / 14)));

    let bubble = null;
    if (o.text) {
      bubble = document.createElement('button');
      bubble.type = 'button';
      bubble.className = 'sm-bubble';
      bubble.style.setProperty('--c', `#${color.getHexString()}`);
      bubble.innerHTML = `${o.icon ? `<span class="sm-bubble-icon">${o.icon}</span>` : ''}<span class="sm-bubble-text">${escapeHtml(clip(o.text, 90))}</span>`;
      bubble.title = 'Klik untuk melihat seluruh proses pesan ini';
      bubble.addEventListener('click', (e) => { e.stopPropagation(); if (o.traceId) this.opts.onSelectTrace?.(o.traceId); });
      this.labelLayer.appendChild(bubble);
    }
    const p = { head, core, trail, size, bubble, hops, hop: 0, color, traceId: o.traceId, born: performance.now() };
    this._startHop(p);
    this.particles.push(p);
    if (this.follow) this.followTarget = p;
  }

  _hopMs(a, b) {
    const d = this.nodes.get(a).pos.distanceTo(this.nodes.get(b).pos);
    return (Math.min(2400, Math.max(360, 240 + d * 24)) / this.speed) * (this.reduced ? 1.5 : 1);
  }

  _startHop(p) {
    const [a, b] = p.hops[p.hop];
    p.hopMs = this._hopMs(a, b);
    p.t0 = performance.now();
    const e = this._edge(a, b);
    if (e) { e.heat = 1; e.mat.uniforms.uHot.value.copy(p.color); }
    const na = this.nodes.get(a);
    const nb = this.nodes.get(b);
    if (na && nb) this._bolt(na.pos, nb.pos, p.color, { life: 0.28 / Math.sqrt(this.speed), width: 0.1 });
  }

  _kill(p) {
    for (const s of [p.head, p.core, ...p.trail]) { this.scene.remove(s); s.material.dispose(); }
    p.bubble?.remove();
  }

  /** One live SSE message from /api/system-map/events → light and text. */
  handle(msg) {
    if (!msg) return;
    if (msg.kind === 'start') {
      const t = msg.trace;
      const ch = `c:${t.channel}`;
      this.pulse(ch, COLORS.in);
      sfx.play('in', 1);
      this.spawn([ch, 'core'], { color: COLORS.in, traceId: t.id, text: t.input || t.title, icon: CHANNEL_META[t.channel]?.icon || '📥' });
      this.traceState.set(t.id, { channel: t.channel });
      return;
    }
    if (msg.kind === 'end') {
      const t = msg.trace;
      this.pulse(`c:${t.channel}`, t.status === 'error' ? COLORS.err : COLORS.ok);
      setTimeout(() => this.traceState.delete(t.id), 6000);
      return;
    }
    const ev = msg.event;
    const id = msg.traceId;
    const st = this.traceState.get(id) || { channel: msg.channel };
    this.traceState.set(id, st);
    const pNode = (p) => (this.nodes.has(`p:${p}`) ? `p:${p}` : 'core');
    const mNode = (p, m) => (this.nodes.has(`m:${p}:${m}`) ? `m:${p}:${m}` : pNode(p));
    switch (ev.type) {
      case 'intent':
        this.pulse('core', ev.model ? COLORS.core : COLORS.code);
        break;
      case 'route': {
        this.pulse('core', COLORS.route);
        const e = this._edge('core', pNode(ev.requested?.provider));
        if (e) { e.heat = 0.7; e.mat.uniforms.uHot.value.setHex(COLORS.route); }
        break;
      }
      case 'skip':
        this.pulse(mNode(ev.provider, ev.model), COLORS.warn);
        break;
      case 'attempt':
        sfx.play('route', 0.8);
        st.provider = ev.provider; st.model = ev.model;
        this.spawn(['core', pNode(ev.provider), mNode(ev.provider, ev.model)], { color: COLORS.route, traceId: id, text: `${ev.provider} / ${ev.model}`, icon: '🚀', size: 1.9 });
        break;
      case 'first_token':
        this.pulse(mNode(st.provider || ev.provider, st.model), COLORS.ok);
        break;
      case 'fail':
        sfx.play('fail', 1);
        this._flash(COLORS.err, 0.08);
        this.pulse(mNode(ev.provider, ev.model), COLORS.err);
        this.spawn([mNode(ev.provider, ev.model), pNode(ev.provider), 'core'], { color: COLORS.err, traceId: id, text: `gagal: ${FAIL_REASON[ev.reason] || ev.reason}`, icon: '💥', size: 1.8 });
        break;
      case 'success':
        sfx.play('ok', 1);
        this.spawn([mNode(ev.provider, ev.model), pNode(ev.provider), 'core'], { color: COLORS.ok, traceId: id, text: ev.preview || `jawaban ${ev.chars} karakter`, icon: '💬', size: 2.1 });
        break;
      case 'tool_start':
        sfx.play('tool', 0.9);
        this.spawn(['core', 'tools'], { color: COLORS.tool, traceId: id, text: ev.name, icon: '🔧', size: 1.6 });
        break;
      case 'tool_end':
        this.spawn(['tools', 'core'], { color: ev.ok ? COLORS.tool : COLORS.err, traceId: id, text: `${ev.name} ${ev.ok ? 'selesai' : 'gagal'}`, icon: ev.ok ? '🔩' : '⚠️', size: 1.5 });
        break;
      case 'deliver':
        sfx.play(ev.ok === false ? 'fail' : 'out', 1);
        this.spawn(['core', `c:${ev.channel || st.channel}`], {
          color: ev.ok === false ? COLORS.err : COLORS.out, traceId: id,
          text: ev.ok === false ? 'gagal terkirim' : (ev.preview || `terkirim · ${ev.chars} karakter`), icon: ev.ok === false ? '📭' : '📤', size: 2.2,
        });
        break;
      case 'all_failed':
      case 'error':
        this.pulse('core', COLORS.err);
        break;
      default:
        break;
    }
  }

  /** Plays a finished trace again (time-compressed). Returns a cancel function. */
  replay(trace, speed = 1) {
    const timers = [];
    const t = trace;
    this.handle({ kind: 'start', trace: { id: t.id, channel: t.channel, input: t.input, title: t.title } });
    const evs = t.events || [];
    const total = Math.max(1, evs.length ? evs[evs.length - 1].dt : 1);
    const span = Math.min(14000, Math.max(5000, total)) / speed;
    evs.forEach((ev, i) => {
      timers.push(setTimeout(() => this.handle({ kind: 'event', traceId: t.id, channel: t.channel, event: ev }), 1800 + (ev.dt / total) * span + i * 60));
    });
    timers.push(setTimeout(() => this.handle({ kind: 'end', trace: { id: t.id, channel: t.channel, status: t.status } }), 2600 + span + evs.length * 60));
    return () => timers.forEach(clearTimeout);
  }

  setHighlight(traceId) { this.highlight = traceId || null; }

  /** Camera rides along with the newest comet. */
  setFollow(on) {
    this.follow = Boolean(on);
    this.followTarget = null;
    if (on) { this.controls.autoRotate = false; this.userMoved = true; this.flyTo = null; } else this.resetView();
  }

  focusNode(nodeId) {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    this.focus = nodeId;
    this.userMoved = true;
    this.controls.autoRotate = false;
    const dist = n.kind === 'core' ? 34 : n.kind === 'provider' ? 22 : 16;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.flyTo = {
      fromT: this.controls.target.clone(), fromC: this.camera.position.clone(),
      offset: dir.multiplyScalar(dist), t0: performance.now(), node: n,
    };
  }

  resetView() {
    this.focus = null;
    this.flyTo = null;
    this.userMoved = false;
    this.controls.autoRotate = !this.reduced;
    this._fit();
  }

  // ------------------------------------------------------------------ sky

  _initSky() {
    this.skyScene = new THREE.Scene();
    this.skyCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        uRes: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 },
        uTop: { value: new THREE.Color(0x02030a) }, uHor: { value: new THREE.Color(0x0a1130) },
        uSun: { value: new THREE.Vector2(0.5, 0.5) }, uSunCol: { value: new THREE.Color(0xffd9a0) }, uSunVis: { value: 0 },
        uMoon: { value: new THREE.Vector2(0.5, 0.5) }, uMoonVis: { value: 0 }, uPhase: { value: 3.14 },
        uNight: { value: 1 }, uDay: { value: 0 }, uGlow: { value: 0 },
      },
    });
    this.skyQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.skyMat);
    this.skyQuad.frustumCulled = false;
    this.skyScene.add(this.skyQuad);
    this.skyMode = 'auto';
    try { const m = localStorage.getItem('wanarSkyMode'); if (m) this.skyMode = m; } catch { /* private mode */ }
    this.sky = { night: 1, day: 0, hour: 0, label: '', moon: 0 };
    this._skyReport = -1e9;
  }

  /** WIB (UTC+7) hour as a fraction, e.g. 17.5 = 17:30. */
  static wibHour(ms = Date.now()) {
    const d = new Date(ms + 7 * 3600_000);
    return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  }

  /** Fraction of the moon's disc that is lit (0 new … 1 full), from the real lunar cycle. */
  static moonAge(ms = Date.now()) {
    const jd = ms / 86400000 + 2440587.5;
    const age = (((jd - 2451550.1) % 29.530588853) + 29.530588853) % 29.530588853;
    return { age, phase: (age / 29.530588853) * Math.PI * 2, lit: (1 - Math.cos((age / 29.530588853) * Math.PI * 2)) / 2 };
  }

  setSkyMode(mode) {
    this.skyMode = ['auto', 'pagi', 'siang', 'sore', 'malam'].includes(mode) ? mode : 'auto';
    try { localStorage.setItem('wanarSkyMode', this.skyMode); } catch { /* private mode */ }
    this._skyReport = -1e9;
  }

  _skyHour() {
    const fixed = { pagi: 6.6, siang: 12.2, sore: 17.4, malam: 22.0 }[this.skyMode];
    return fixed ?? MapScene.wibHour();
  }

  _updateSky(now) {
    const u = this.skyMat.uniforms;
    const t = this._skyHour();
    // colours: interpolate the keyframes around this hour
    let a = SKY_KEYS[0]; let b = SKY_KEYS[1];
    for (let i = 0; i < SKY_KEYS.length - 1; i++) if (t >= SKY_KEYS[i][0] && t <= SKY_KEYS[i + 1][0]) { a = SKY_KEYS[i]; b = SKY_KEYS[i + 1]; break; }
    const k = (t - a[0]) / Math.max(0.001, b[0] - a[0]);
    u.uTop.value.setHex(a[1]).lerp(new THREE.Color(b[1]), k);
    u.uHor.value.setHex(a[2]).lerp(new THREE.Color(b[2]), k);
    this.renderer.setClearColor(u.uHor.value, 1);

    // sun: east -> west across 05:30–18:30; moon the same arc across 17:30–06:30
    const sunU = (t - 5.5) / 13;
    const moonU = ((((t - 17.5) % 24) + 24) % 24) / 13;
    const edge = (x) => Math.min(1, Math.max(0, Math.min(x, 1 - x) / 0.05));
    const sunVis = sunU >= 0 && sunU <= 1 ? edge(sunU) : 0;
    const moonVis = moonU >= 0 && moonU <= 1 ? edge(moonU) : 0;
    const arc = (x) => [0.1 + 0.8 * x, 0.3 + 0.55 * Math.sin(Math.PI * x)];
    const [sx, sy] = arc(Math.min(1, Math.max(0, sunU)));
    const [mx, my] = arc(Math.min(1, Math.max(0, moonU)));
    u.uSun.value.set(sx, sy);
    u.uMoon.value.set(mx, my);
    const elev = Math.sin(Math.PI * Math.min(1, Math.max(0, sunU)));
    const warm = new THREE.Color(1.0, 0.52, 0.2);
    const white = new THREE.Color(1.0, 0.96, 0.82);
    u.uSunCol.value.copy(warm).lerp(white, Math.min(1, Math.max(0, (elev - 0.1) / 0.5)));
    u.uSunVis.value = sunVis;
    u.uMoonVis.value = moonVis;
    const moon = MapScene.moonAge();
    u.uPhase.value = moon.phase;
    const daylight = sunVis ? Math.min(1, elev * 2.2) * sunVis : 0;
    const night = 1 - Math.min(1, Math.max(0, (t >= 5.3 && t <= 18.7 ? daylight * 1.3 : 0) + (t >= 5.0 && t < 5.5 ? (t - 5.0) * 1.0 : 0)));
    u.uNight.value = night;
    u.uDay.value = Math.min(1, daylight);
    u.uGlow.value = sunVis ? 1 - Math.min(1, Math.max(0, (elev - 0.05) / 0.4)) : 0.1;
    u.uTime.value = this.time;
    u.uRes.value.set(this.host.clientWidth || 1, this.host.clientHeight || 1);

    this.sky.night = night;
    this.sky.day = u.uDay.value;
    this.sky.hour = t;
    this.sky.moon = moon.lit;
    this.coreLight.intensity = 3.2 - 0.9 * this.sky.day;

    // report to the HUD every ~20 s
    if (now - this._skyReport > 20000) {
      this._skyReport = now;
      this.opts.onSky?.(this.getSkyInfo());
    }
  }

  getSkyInfo() {
    const t = this.sky.hour;
    const pick = (h) => {
      if (h < 4.5 || h >= 19.5) return ['🌙', 'Malam'];
      if (h < 5.7) return ['🌌', 'Menjelang fajar'];
      if (h < 7) return ['🌅', 'Fajar'];
      if (h < 11) return ['🌤️', 'Pagi'];
      if (h < 15) return ['☀️', 'Siang'];
      if (h < 17.3) return ['🌤️', 'Sore'];
      if (h < 18.5) return ['🌇', 'Senja'];
      return ['🌆', 'Petang'];
    };
    const [icon, label] = pick(t);
    const hh = Math.floor(t);
    const mm = Math.floor((t - hh) * 60);
    const moonName = (() => {
      const a = MapScene.moonAge().age;
      if (a < 1.8 || a > 27.7) return 'Bulan baru';
      if (a < 6.4) return 'Sabit awal';
      if (a < 8.4) return 'Paruh pertama';
      if (a < 13.8) return 'Cembung awal';
      if (a < 15.8) return 'Bulan purnama';
      if (a < 21.1) return 'Cembung akhir';
      if (a < 23.1) return 'Paruh akhir';
      return 'Sabit akhir';
    })();
    return {
      icon, label, mode: this.skyMode, clock: `${String(hh).padStart(2, '0')}.${String(mm).padStart(2, '0')}`,
      moonPct: Math.round(this.sky.moon * 100), moonName, night: this.sky.night > 0.5,
    };
  }

  // ------------------------------------------------------------- effects

  /** Jagged lightning between two points (midpoint displacement), with a bright core and a side branch. */
  _jagged(a, b, roughness, levels = 4) {
    let pts = [a.clone(), b.clone()];
    let amp = a.distanceTo(b) * roughness;
    for (let l = 0; l < levels; l++) {
      const next = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const m = pts[i].clone().add(pts[i + 1]).multiplyScalar(0.5);
        m.add(new THREE.Vector3((Math.random() - 0.5) * amp, (Math.random() - 0.5) * amp, (Math.random() - 0.5) * amp));
        next.push(m, pts[i + 1]);
      }
      pts = next;
      amp *= 0.55;
    }
    return pts;
  }

  _bolt(a, b, color, { life = 0.3, width = 0.12, branches = 1 } = {}) {
    if (this.bolts.length > 26) return;
    const group = new THREE.Group();
    const mats = [];
    const mk = (pts, radius, c, opacity) => {
      const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.2);
      const geo = new THREE.TubeGeometry(curve, Math.max(8, pts.length * 2), radius, 5, false);
      const mat = new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
      group.add(new THREE.Mesh(geo, mat));
      mats.push({ mat, base: opacity });
    };
    const main = this._jagged(a, b, 0.16);
    mk(main, width * 2.6, color, 0.35); // glow
    mk(main, width, 0xffffff, 0.95);    // white-hot core
    for (let i = 0; i < branches; i++) {
      const at = main[Math.floor(main.length * (0.25 + Math.random() * 0.5))];
      const dir = new THREE.Vector3((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)).normalize().multiplyScalar(a.distanceTo(b) * 0.25);
      mk(this._jagged(at, at.clone().add(dir), 0.2, 3), width * 0.6, color, 0.7);
    }
    this.scene.add(group);
    this.bolts.push({ group, mats, t0: performance.now(), life: life * 1000 });
  }

  /** Expanding ring + sparks + a brief glow at a node (a message landed there). */
  _impact(nodeId, color, big = false) {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    const col = new THREE.Color(color);
    if (this.rings.length < 18) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.92, 1.0, 64),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })
      );
      ring.position.copy(n.pos);
      ring.lookAt(this.camera.position);
      this.scene.add(ring);
      this.rings.push({ ring, t0: performance.now(), life: big ? 900 : 650, base: n.base * (big ? 1.6 : 1.2), grow: big ? 7 : 4.5 });
    }
    if (this.bursts.length < 10) {
      const count = big ? 46 : 24;
      const pos = new Float32Array(count * 3);
      const vel = [];
      for (let i = 0; i < count; i++) {
        pos.set([n.pos.x, n.pos.y, n.pos.z], i * 3);
        const d = new THREE.Vector3((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)).normalize().multiplyScalar((big ? 7 : 4) * (0.4 + Math.random()));
        vel.push(d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const m = new THREE.PointsMaterial({ color: col, size: big ? 0.9 : 0.6, map: this.glowTex, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending });
      const pts = new THREE.Points(g, m);
      this.scene.add(pts);
      this.bursts.push({ pts, vel, t0: performance.now(), life: 750 });
    }
    if (nodeId === 'core' || big) {
      this.shake = Math.min(0.9, this.shake + (nodeId === 'core' ? 0.35 : 0.18));
      this._flash(col, nodeId === 'core' ? 0.16 : 0.09);
    }
    if (n.group.userData.atmo) n.atmoBoost = 1;
  }

  _flash(color, alpha = 0.12) {
    if (this.reduced || !this.flashEl?.animate) return;
    const c = `#${new THREE.Color(color).getHexString()}`;
    this.flashEl.style.background = `radial-gradient(ellipse at 50% 45%, ${c}00 0%, ${c} 140%)`;
    this.flashEl.animate([{ opacity: alpha }, { opacity: 0 }], { duration: 380, easing: 'ease-out' });
  }

  /** Translucent hex shield around the system: where outside probes hit. */
  _shield() {
    const r = 62;
    const geo = new THREE.IcosahedronGeometry(r, 2);
    this.shieldWire = new THREE.LineSegments(
      new THREE.WireframeGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.05, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    this.shieldWire.userData.r = r;
    this.scene.add(this.shieldWire);
    this.shieldFlash = 0;
  }

  /** A real security event: an attacker bolt from outside hits the shield and is blocked. */
  handleSecurity(ev) {
    if (!ev) return;
    const r = this.shieldWire?.userData.r || 62;
    let h = 0;
    for (const ch of String(ev.ip || ev.id)) h = (h * 31 + ch.charCodeAt(0)) | 0;
    const th = ((h % 628) / 100);
    const ph = (((h >> 8) % 314) / 100);
    const dir = new THREE.Vector3(Math.sin(ph) * Math.cos(th), Math.cos(ph) * 0.6, Math.sin(ph) * Math.sin(th)).normalize();
    const from = dir.clone().multiplyScalar(r + 55);
    const hit = dir.clone().multiplyScalar(r);
    const color = ev.severity === 'high' ? 0xf43f5e : ev.severity === 'medium' ? 0xfb923c : 0xfacc15;
    this._bolt(from, hit, color, { life: 0.55, width: 0.18, branches: 2 });
    setTimeout(() => {
      const fake = { pos: hit, base: 3 };
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.9, 1.0, 48),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })
      );
      ring.position.copy(fake.pos);
      ring.lookAt(new THREE.Vector3(0, 0, 0));
      this.scene.add(ring);
      this.rings.push({ ring, t0: performance.now(), life: 900, base: 3, grow: 6 });
      this.shieldFlash = 1;
      this._flash(color, 0.07);
      sfx.play('shield', ev.severity === 'high' ? 1.2 : 0.8);
    }, 220);
  }

  _updateEffects(now, dt) {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      const k = (now - b.t0) / b.life;
      if (k >= 1) {
        this.scene.remove(b.group);
        b.group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
        this.bolts.splice(i, 1);
        continue;
      }
      const flicker = 0.55 + Math.random() * 0.45;
      for (const m of b.mats) m.mat.opacity = m.base * (1 - k) * flicker;
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      const k = (now - r.t0) / r.life;
      if (k >= 1) { this.scene.remove(r.ring); r.ring.geometry.dispose(); r.ring.material.dispose(); this.rings.splice(i, 1); continue; }
      const e = 1 - Math.pow(1 - k, 3);
      r.ring.scale.setScalar(r.base * (1 + e * r.grow));
      r.ring.material.opacity = 0.9 * (1 - k);
      if (r.ring.userData.face !== false) r.ring.lookAt(this.camera.position);
    }
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      const k = (now - b.t0) / b.life;
      if (k >= 1) { this.scene.remove(b.pts); b.pts.geometry.dispose(); b.pts.material.dispose(); this.bursts.splice(i, 1); continue; }
      const arr = b.pts.geometry.attributes.position.array;
      for (let j = 0; j < b.vel.length; j++) {
        arr[j * 3] += b.vel[j].x * dt;
        arr[j * 3 + 1] += b.vel[j].y * dt;
        arr[j * 3 + 2] += b.vel[j].z * dt;
        b.vel[j].multiplyScalar(0.94);
      }
      b.pts.geometry.attributes.position.needsUpdate = true;
      b.pts.material.opacity = 1 - k;
    }
    if (this.shieldWire) {
      this.shieldFlash = Math.max(0, this.shieldFlash - dt * 1.4);
      this.shieldWire.material.opacity = 0.05 + this.shieldFlash * 0.35;
      this.shieldWire.rotation.y += dt * 0.01;
    }
    for (const n of this.nodes.values()) {
      const m = n.group.userData.atmo;
      if (!m) continue;
      n.atmoBoost = Math.max(0, (n.atmoBoost || 0) - dt * 1.6);
      m.uniforms.uBoost.value = n.atmoBoost * 1.4;
    }
    if (this.coreMat) this.coreMat.uniforms.uTime.value = this.time;
    this.shake = Math.max(0, this.shake - dt * 2.4);
  }

  setSpeed(v) { this.speed = Math.min(6, Math.max(0.5, Number(v) || 2)); }

  // --------------------------------------------------------------- loop

  _loop() {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this._loop);
    if (document.hidden) return;
    const now = performance.now();
    const dt = Math.min(0.05, this.clock.getDelta());
    this.time += dt;

    // planets revolve around the Core, never stopping
    const sp = this.reduced ? 0.3 : 1;
    for (const n of this.nodes.values()) {
      const h = n.helio;
      if (!h || n.orbit) continue;
      const a = h.a0 + this.time * h.speed * sp;
      const x = Math.cos(a) * h.r;
      const yy = Math.sin(a * 2 + h.i) * h.wobble;
      const z = Math.sin(a) * h.r;
      const ct = Math.cos(h.tilt); const st = Math.sin(h.tilt);
      n.pos.set(x, yy * ct - z * st, yy * st + z * ct);
      n.group.position.copy(n.pos);
    }
    for (const e of this.edges.values()) {
      const na = this.nodes.get(e.a); const nb = this.nodes.get(e.b);
      if (na && nb) { e.mat.uniforms.uA.value.copy(na.pos); e.mat.uniforms.uB.value.copy(nb.pos); }
    }

    // moons orbit their planets
    for (const n of this.nodes.values()) {
      if (!n.orbit) continue;
      const c = this.nodes.get(n.orbit.center);
      if (!c) continue;
      const a = n.orbit.phase + this.time * n.orbit.speed * (this.reduced ? 0.3 : 1);
      const t = n.orbit.tilt;
      n.pos.set(Math.cos(a) * n.orbit.r, Math.sin(a) * n.orbit.r * Math.sin(t), Math.sin(a) * n.orbit.r * Math.cos(t)).add(c.pos);
      n.group.position.copy(n.pos);
      if (n.orbitLine) { n.orbitLine.position.copy(c.pos); n.orbitLine.rotation.set(-t, 0, 0); }
    }

    if (this.flyTo) {
      const k = Math.min(1, (now - this.flyTo.t0) / 1100);
      const e = 1 - Math.pow(1 - k, 3);
      const to = this.flyTo.node.pos;
      this.controls.target.lerpVectors(this.flyTo.fromT, to, e);
      this.camera.position.lerpVectors(this.flyTo.fromC, to.clone().add(this.flyTo.offset), e);
      if (k >= 1) this.flyTo = null;
    }
    if (this.follow && this.followTarget && this.particles.includes(this.followTarget)) {
      const p = this.followTarget.head.position;
      this.controls.target.lerp(p, 0.08);
      this.camera.position.lerp(p.clone().add(new THREE.Vector3(6, 7, 16)), 0.035);
    }
    this.controls.update();

    // stars, galaxy, nebulae, the star itself
    this._updateSky(now);
    const night = this.sky.night;
    this.starLayers.forEach((s, i) => { s.material.opacity = (0.55 + Math.sin(this.time * (0.8 + i * 0.5) + i * 2) * 0.3) * (0.15 + 0.85 * night); s.rotation.y += dt * 0.012 * (i + 1); });
    this.galaxy.material.opacity = 0.45 * (0.25 + 0.75 * night);
    this.galaxy.rotation.y += dt * 0.03;
    this.nebulae.forEach((s, i) => { s.material.opacity = 0.55 * (0.3 + 0.7 * night); s.material.rotation += dt * 0.02 * (i % 2 ? 1 : -1); });
    for (const o of this.orbits) o.rotation.y += dt * 0.01;
    const core = this.nodes.get('core');
    if (core) {
      core.mesh.rotation.y += dt * 0.08;
      core.group.userData.shell.rotation.y -= dt * 0.25;
      core.group.userData.shell.rotation.x += dt * 0.07;
      core.group.userData.corona.forEach((c, i) => c.s.scale.setScalar(c.base * (1 + Math.sin(this.time * (1.2 + i * 0.4) + i) * 0.06)));
    }

    for (const n of this.nodes.values()) {
      if (n.kind !== 'core') n.mesh.rotation.y += dt * n.spin;
      n.halo.lookAt(this.camera.position);
      if (n.kind === 'tools') n.group.userData.belt.rotation.y += dt * 0.3;
      const hover = this.hover === n.id ? 1.18 : 1;
      if (n.pulse) {
        const k = (now - n.pulse.t0) / 1300;
        if (k < 1) {
          n.group.scale.setScalar(hover * (1 + Math.sin(k * Math.PI) * 0.3));
          n.glow.material.color.copy(n.pulse.color);
          n.glow.material.opacity = 0.4 + (1 - k) * 0.6;
          if (n.kind === 'core') n.group.userData.corona[1].s.material.color.copy(n.pulse.color);
          continue;
        }
        n.pulse = null;
        n.glow.material.color.copy(n.baseGlow);
        n.glow.material.opacity = n.kind === 'core' ? 0 : 0.4;
      }
      n.group.scale.setScalar(THREE.MathUtils.lerp(n.group.scale.x, hover, 0.15));
      if (n.kind === 'core') n.group.userData.corona[1].s.material.color.lerp(new THREE.Color(COLORS.core), 0.05);
    }

    for (const e of this.edges.values()) {
      e.mat.uniforms.uTime.value = this.time;
      if (e.heat > 0) e.heat = Math.max(0, e.heat - dt * 0.4);
      e.mat.uniforms.uHeat.value = e.heat;
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      let k = (now - p.t0) / p.hopMs;
      if (k >= 1) {
        this.pulse(p.hops[p.hop][1], p.color.getHex());
        this._impact(p.hops[p.hop][1], p.color, p.hop === p.hops.length - 1);
        p.hop += 1;
        if (p.hop >= p.hops.length) { this._kill(p); this.particles.splice(i, 1); continue; }
        this._startHop(p);
        k = 0;
      }
      const [a, b] = p.hops[p.hop];
      const na = this.nodes.get(a); const nb = this.nodes.get(b);
      if (!na || !nb) { this._kill(p); this.particles.splice(i, 1); continue; }
      const curve = this._curve(na.pos, nb.pos); // rebuilt every frame: moons move
      const ease = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      p.head.position.copy(curve.getPoint(ease));
      p.core.position.copy(p.head.position);
      const hl = this.highlight && p.traceId === this.highlight ? 1.4 : 1;
      p.head.scale.setScalar(p.size * hl * (1 + Math.sin(now / 80) * 0.1));
      p.trail.forEach((s, j) => s.position.copy(curve.getPoint(Math.max(0, ease - (j + 1) * 0.018))));
    }

    this._updateEffects(now, dt);
    // micro camera shake when something lands on the core
    let sx = 0; let sy = 0;
    if (this.shake > 0.01 && !this.reduced) {
      sx = (Math.random() - 0.5) * this.shake * 0.35;
      sy = (Math.random() - 0.5) * this.shake * 0.35;
      this.camera.position.x += sx; this.camera.position.y += sy;
    }
    this.renderer.clear();
    this.renderer.render(this.skyScene, this.skyCam);
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.camera);
    if (sx || sy) { this.camera.position.x -= sx; this.camera.position.y -= sy; }
    this._labels(now);
  }

  _project(v) {
    const p = v.clone().project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * this.host.clientWidth, y: (-p.y * 0.5 + 0.5) * this.host.clientHeight, behind: p.z > 1 };
  }

  _labels(now) {
    const camRight = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
    for (const n of this.nodes.values()) {
      let show = true;
      if (n.kind === 'model') {
        const owner = `p:${n.info?.provider}`;
        show = (n.lastActive != null && now - n.lastActive < 8000) || this.focus === owner || this.focus === n.id || this.hover === owner || this.hover === n.id;
      }
      const c = this._project(n.pos);
      const edge = this._project(n.pos.clone().add(camRight.clone().multiplyScalar(n.base * (n.kind === 'core' ? 1.6 : 1.3))));
      const r = Math.max(5, Math.hypot(edge.x - c.x, edge.y - c.y)) + 3;
      n.label.style.transform = n.kind === 'model'
        ? `translate(0, -50%) translate(${(c.x + r).toFixed(1)}px, ${c.y.toFixed(1)}px)`
        : `translate(-50%, 0) translate(${c.x.toFixed(1)}px, ${(c.y + r).toFixed(1)}px)`;
      n.label.style.visibility = c.behind || !show ? 'hidden' : 'visible';
    }
    const withText = this.particles.filter((p) => p.bubble);
    const visible = new Set(withText.slice(-5));
    for (const p of withText) {
      if (!visible.has(p) && this.highlight !== p.traceId) { p.bubble.style.visibility = 'hidden'; continue; }
      const s = this._project(p.head.position);
      // fade in on launch, fade out on the final approach
      const last = p.hop === p.hops.length - 1;
      const k = Math.min(1, (now - p.t0) / p.hopMs);
      const fade = Math.min(1, (now - p.born) / 250) * (last && k > 0.88 ? (1 - k) / 0.12 : 1);
      p.bubble.style.opacity = fade.toFixed(2);
      p.bubble.style.transform = `translate(-50%, -130%) translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`;
      p.bubble.style.visibility = s.behind ? 'hidden' : 'visible';
      p.bubble.classList.toggle('hl', this.highlight === p.traceId);
    }
  }

  _pick(e, click) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const heads = this.particles.filter((p) => p.traceId).map((p) => p.head);
    const hitP = heads.length ? this.raycaster.intersectObjects(heads, false)[0] : null;
    const hitN = hitP ? null : this.raycaster.intersectObjects([...this.nodes.values()].map((n) => n.mesh), false)[0];
    this.renderer.domElement.style.cursor = hitP || hitN ? 'pointer' : 'grab';
    this.hover = hitN ? hitN.object.userData.nodeId : null;
    if (!click) return;
    if (hitP) this.opts.onSelectTrace?.(hitP.object.userData.traceId);
    else if (hitN) this.opts.onSelectNode?.(this.nodes.get(hitN.object.userData.nodeId)?.info);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.renderer.domElement.removeEventListener('click', this._onClick);
    this.renderer.domElement.removeEventListener('pointermove', this._onMove);
    for (const p of this.particles) this._kill(p);
    this.particles = [];
    this.flashEl?.remove();
    clearTimeout(this._resumeTimer);
    this.skyQuad?.geometry.dispose();
    this.skyMat?.dispose();
    for (const [id, n] of this.nodes) this._removeNode(id, n);
    for (const e of this.edges.values()) { e.mesh.geometry.dispose(); e.mat.dispose(); }
    this.edges.clear();
    this.scene.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    for (const t of this.textures) t.dispose();
    this.glowTex.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelLayer.remove();
  }
}

function providerTone(p) {
  if (!p.configured) return 'off';
  if (p.health?.down || p.health?.circuitOpen) return 'err';
  if ((p.models || []).some((m) => m.skip) || p.health?.consecutiveFails) return 'warn';
  return 'ok';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return Boolean(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}
