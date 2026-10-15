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

const STREAM_VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

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

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x02030a, 1);
    this.renderer.domElement.className = 'sm-canvas';
    host.appendChild(this.renderer.domElement);

    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'sm-labels';
    host.appendChild(this.labelLayer);

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
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; this.userMoved = true; this.flyTo = null; });

    this.scene.add(new THREE.AmbientLight(0x6677aa, 0.35));
    this.coreLight = new THREE.PointLight(0xbfe3ff, 3.2, 160, 1.2);
    this.scene.add(this.coreLight);

    this._universe();

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
        mesh = new THREE.Mesh(new THREE.SphereGeometry(spec.size, 48, 48), new THREE.MeshBasicMaterial({ map: this._tex(starTexture()), color: 0xe0f2fe }));
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
    if (!n.orbit) { n.pos.copy(spec.pos); n.group.position.copy(spec.pos); }
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
    const geo = new THREE.TubeGeometry(this._curve(na.pos, nb.pos), 80, 0.09, 6, false);
    let e = this.edges.get(k);
    if (!e) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: STREAM_VERT, fragmentShader: STREAM_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uColor: { value: new THREE.Color(color) }, uHot: { value: new THREE.Color(color) }, uTime: { value: 0 }, uHeat: { value: 0 }, uBase: { value: base } },
      });
      const mesh = new THREE.Mesh(geo, mat);
      this.scene.add(mesh);
      e = { mesh, mat, heat: 0 };
      this.edges.set(k, e);
    } else {
      e.mesh.geometry.dispose();
      e.mesh.geometry = geo;
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
    return Math.min(3200, Math.max(1100, 700 + d * 55)) * (this.reduced ? 1.5 : 1);
  }

  _startHop(p) {
    const [a, b] = p.hops[p.hop];
    p.hopMs = this._hopMs(a, b);
    p.t0 = performance.now();
    const e = this._edge(a, b);
    if (e) { e.heat = 1; e.mat.uniforms.uHot.value.copy(p.color); }
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
        st.provider = ev.provider; st.model = ev.model;
        this.spawn(['core', pNode(ev.provider), mNode(ev.provider, ev.model)], { color: COLORS.route, traceId: id, text: `${ev.provider} / ${ev.model}`, icon: '🚀', size: 1.9 });
        break;
      case 'first_token':
        this.pulse(mNode(st.provider || ev.provider, st.model), COLORS.ok);
        break;
      case 'fail':
        this.pulse(mNode(ev.provider, ev.model), COLORS.err);
        this.spawn([mNode(ev.provider, ev.model), pNode(ev.provider), 'core'], { color: COLORS.err, traceId: id, text: `gagal: ${FAIL_REASON[ev.reason] || ev.reason}`, icon: '💥', size: 1.8 });
        break;
      case 'success':
        this.spawn([mNode(ev.provider, ev.model), pNode(ev.provider), 'core'], { color: COLORS.ok, traceId: id, text: ev.preview || `jawaban ${ev.chars} karakter`, icon: '💬', size: 2.1 });
        break;
      case 'tool_start':
        this.spawn(['core', 'tools'], { color: COLORS.tool, traceId: id, text: ev.name, icon: '🔧', size: 1.6 });
        break;
      case 'tool_end':
        this.spawn(['tools', 'core'], { color: ev.ok ? COLORS.tool : COLORS.err, traceId: id, text: `${ev.name} ${ev.ok ? 'selesai' : 'gagal'}`, icon: ev.ok ? '🔩' : '⚠️', size: 1.5 });
        break;
      case 'deliver':
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

  // --------------------------------------------------------------- loop

  _loop() {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this._loop);
    if (document.hidden) return;
    const now = performance.now();
    const dt = Math.min(0.05, this.clock.getDelta());
    this.time += dt;

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
    this.starLayers.forEach((s, i) => { s.material.opacity = 0.55 + Math.sin(this.time * (0.8 + i * 0.5) + i * 2) * 0.3; s.rotation.y += dt * 0.002 * (i + 1); });
    this.galaxy.rotation.y += dt * 0.012;
    this.nebulae.forEach((s, i) => { s.material.rotation += dt * 0.01 * (i % 2 ? 1 : -1); });
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

    this.renderer.render(this.scene, this.camera);
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
