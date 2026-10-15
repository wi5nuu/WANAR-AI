/**
 * MapScene — the 3D live map of the agent (three.js).
 *
 *   channels (left) ──▶ Wanar core / router (center) ──▶ providers ──▶ models (right)
 *                                   └──▶ tools (below)
 *
 * Every real trace event becomes motion: a glowing dot carries the message from
 * the channel into the core, to the provider and model that were tried, back
 * with the answer (green) or a failure (red), through tools, and out again to
 * the channel it is delivered to. Dots and nodes are clickable.
 *
 * by Wisnu Alfian Nur Ashar
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CHANNEL_META, fmtNum } from './explain.js';

export const COLORS = {
  in: 0x38bdf8,
  route: 0xf59e0b,
  ok: 0x22c55e,
  err: 0xef4444,
  warn: 0xf97316,
  tool: 0xa78bfa,
  code: 0x2dd4bf,
  out: 0x34d399,
  core: 0x60a5fa,
  dim: 0x475569,
};

const STATUS_RING = { ok: 0x22c55e, warn: 0xf59e0b, err: 0xef4444, off: 0x475569 };

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.25)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function shortNum(n) {
  const v = Number(n || 0);
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}jt`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}rb`;
  return String(v);
}

export class MapScene {
  /**
   * @param {HTMLElement} host  element that receives the canvas + label layer
   * @param {{onSelectNode?:Function, onSelectTrace?:Function, reducedMotion?:boolean}} opts
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = opts;
    this.reduced = Boolean(opts.reducedMotion);
    this.nodes = new Map();      // id -> { id, kind, group, mesh, glow, ring, label, pos, info, pulse }
    this.edges = new Map();      // "a|b" -> { line, mat, base, heat }
    this.particles = [];         // flying dots
    this.traceState = new Map(); // traceId -> { provider, model }
    this.highlight = null;
    this.disposed = false;
    this.clock = new THREE.Clock();
    this.glowTex = glowTexture();

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x060a16, 1);
    this.renderer.domElement.className = 'sm-canvas';
    host.appendChild(this.renderer.domElement);

    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'sm-labels';
    host.appendChild(this.labelLayer);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x060a16, 0.018);
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 400);
    this.camera.position.set(2, 3, 30);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 70;
    this.controls.target.set(0, 0, 0);
    this.controls.autoRotate = !this.reduced;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; this.userMoved = true; });

    this.scene.add(new THREE.AmbientLight(0x8899bb, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(6, 12, 14);
    this.scene.add(key);
    this.coreLight = new THREE.PointLight(0x60a5fa, 2.2, 22, 1.6);
    this.scene.add(this.coreLight);

    this._stars();
    this._grid();

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._onClick = (e) => this._pick(e, true);
    this._onMove = (e) => this._pick(e, false);
    this.renderer.domElement.addEventListener('click', this._onClick);
    this.renderer.domElement.addEventListener('pointermove', this._onMove);

    this._resize = () => this.resize();
    this.ro = new ResizeObserver(this._resize);
    this.ro.observe(host);
    this.resize();

    this._loop = this._loop.bind(this);
    this.raf = requestAnimationFrame(this._loop);
  }

  // ----------------------------------------------------------------- scenery

  _stars() {
    const n = 700;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 45 + Math.random() * 60;
      const t = Math.random() * Math.PI * 2;
      const p = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(p) * Math.cos(t);
      pos[i * 3 + 1] = r * Math.sin(p) * Math.sin(t);
      pos[i * 3 + 2] = r * Math.cos(p);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8aa0c8, size: 0.18, transparent: true, opacity: 0.7, depthWrite: false }));
    this.scene.add(this.stars);
  }

  _grid() {
    const grid = new THREE.PolarGridHelper(26, 16, 10, 64, 0x1e3a5f, 0x13233d);
    grid.position.y = -11;
    grid.material.transparent = true;
    grid.material.opacity = 0.35;
    this.scene.add(grid);
    this.gridHelper = grid;
  }

  resize() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.labelLayer.classList.toggle('compact', w < 560);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Rotating a phone (or resizing) can flip the layout between wide and tall.
    if (this.lastOverview && (w / h < 0.9) !== this.portrait) this.setGraph(this.lastOverview);
    this._fit();
  }

  /** Keeps the whole map in view on any screen (phones are tall and narrow). */
  _fit() {
    if (this.userMoved || !this.bounds) return;
    const { w, h } = this.bounds;
    const vfov = (this.camera.fov * Math.PI) / 180;
    const distH = (h / 2) / Math.tan(vfov / 2);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const distW = (w / 2) / Math.tan(hfov / 2);
    const d = Math.min(68, Math.max(distH, distW) * 1.12 + 4);
    this.camera.position.set(this.bounds.cx + d * 0.08, this.bounds.cy + d * 0.12, d);
    this.controls.target.set(this.bounds.cx, this.bounds.cy, 0);
    this.controls.update();
  }

  // ------------------------------------------------------------------- graph

  /** Builds or updates the graph from /overview. Unchanged nodes keep their state. */
  setGraph(overview) {
    if (!overview) return;
    this.lastOverview = overview;
    // Tall screens (phones) get a vertical map: channels on top, core, providers below.
    const portrait = this.host.clientWidth / Math.max(1, this.host.clientHeight) < 0.9;
    this.portrait = portrait;
    const want = new Map();
    const channels = overview.channels || [];
    const providers = overview.providers || [];
    const live = providers.filter((p) => p.configured);
    const idle = providers.filter((p) => !p.configured);

    // channels: left column, slight arc
    const cGap = 2.7;
    const cPerRow = 3;
    channels.forEach((c, i) => {
      let x = -11;
      let y = ((channels.length - 1) / 2 - i) * cGap;
      let z = -Math.abs(i - (channels.length - 1) / 2) * 0.7;
      if (portrait) {
        const row = Math.floor(i / cPerRow);
        const inRow = Math.min(cPerRow, channels.length - row * cPerRow);
        x = ((i % cPerRow) - (inRow - 1) / 2) * 4.8;
        y = 11.4 - row * 2.3;
        z = -Math.abs((i % cPerRow) - (inRow - 1) / 2) * 0.5;
      }
      const meta = CHANNEL_META[c.id] || CHANNEL_META.system;
      want.set(`c:${c.id}`, {
        kind: 'channel', pos: new THREE.Vector3(x, y, z), color: new THREE.Color(meta.color), size: 0.62,
        ring: c.active ? 'ok' : 'off',
        label: { icon: meta.icon, title: meta.label, sub: c.stats?.requests ? `${c.stats.requests} permintaan/24j` : (c.active ? 'aktif' : 'nonaktif') },
        info: { type: 'channel', ...c },
      });
    });

    want.set('core', {
      kind: 'core', pos: portrait ? new THREE.Vector3(-1.4, 3.6, 0) : new THREE.Vector3(-3, 0, 0), color: new THREE.Color(COLORS.core), size: 1.15, ring: 'ok',
      label: { icon: '🧠', title: 'Wanar Core', sub: `router · default ${overview.router?.defaultProvider || '-'}` },
      info: { type: 'core', router: overview.router, usage: overview.usage },
    });
    want.set('tools', {
      kind: 'tools', pos: portrait ? new THREE.Vector3(3.8, 3.6, 0.8) : new THREE.Vector3(-3, -6.2, 1.8), color: new THREE.Color(COLORS.tool), size: 0.62, ring: 'ok',
      label: { icon: '🛠️', title: 'Alat (tools)', sub: `${overview.tools?.count || 0} alat` },
      info: { type: 'tools', ...overview.tools },
    });

    // configured providers: columns right of the core (max 7 per column)
    const perCol = 7;
    const cols = Math.max(1, Math.ceil(live.length / perCol));
    const pGap = 2.6;
    live.forEach((p, i) => {
      const col = Math.floor(i / perCol);
      const row = i % perCol;
      const inCol = Math.min(perCol, live.length - col * perCol);
      const y = ((inCol - 1) / 2 - row) * pGap;
      const z = -Math.abs(row - (inCol - 1) / 2) * 0.55 - col * 1.2;
      let pos = new THREE.Vector3(4.6 + col * 8.8, y, z);
      if (portrait) {
        const pr = 3;
        const prow = Math.floor(i / pr);
        const inRow = Math.min(pr, live.length - prow * pr);
        pos = new THREE.Vector3(((i % pr) - (inRow - 1) / 2) * 5.4, -1.2 - prow * 2.7, -Math.abs((i % pr) - (inRow - 1) / 2) * 0.4);
      }
      const status = providerTone(p);
      want.set(`p:${p.id}`, {
        kind: 'provider', pos, color: new THREE.Color(p.isDefault ? 0x60a5fa : 0x94a3b8), size: 0.72, ring: status,
        label: { icon: p.isDefault ? '⭐' : '☁️', title: p.label, sub: `${p.modelCount} model · ${shortNum(p.usageToday)} token` },
        info: { type: 'provider', ...p },
      });
      // models: small satellites orbiting their provider (labels appear when they are used or selected)
      const shown = (p.models || []).slice(0, 6);
      shown.forEach((m, j) => {
        const a = (j / shown.length) * Math.PI * 2 + Math.PI / 6;
        const orbit = portrait ? 1.05 : 1.55;
        const mpos = new THREE.Vector3(pos.x + Math.cos(a) * orbit, pos.y + Math.sin(a) * orbit * 0.6, pos.z + Math.sin(a) * 0.6);
        want.set(`m:${p.id}:${m.id}`, {
          kind: 'model', pos: mpos, color: new THREE.Color(m.skip ? COLORS.warn : (m.lastSuccess ? COLORS.ok : 0xcbd5e1)), size: 0.16,
          ring: m.skip ? 'warn' : (m.lastSuccess ? 'ok' : 'off'),
          label: { title: m.id.length > 28 ? `${m.id.slice(0, 27)}…` : m.id, sub: m.tokensToday ? `${shortNum(m.tokensToday)} tkn` : '', small: true },
          info: { type: 'model', provider: p.id, providerLabel: p.label, ...m },
        });
      });
    });
    this.providerCols = cols;

    // idle providers: a dim arc in the back
    const liveRows = Math.ceil(live.length / 3);
    idle.forEach((p, i) => {
      const a = (i / Math.max(1, idle.length - 1) - 0.5) * 1.6;
      want.set(`p:${p.id}`, {
        kind: 'provider',
        pos: portrait
          ? new THREE.Vector3(((i % 5) - 2) * 2.4, -1.2 - liveRows * 2.7 - 0.6 - Math.floor(i / 5) * 1.5, -3)
          : new THREE.Vector3(6 + Math.sin(a) * 3, Math.cos(a) * 1.2 - 9.4, -6 + i * 0.2), color: new THREE.Color(COLORS.dim), size: 0.34, ring: 'off',
        label: { title: p.label, sub: 'belum aktif', small: true, dim: true },
        info: { type: 'provider', ...p },
      });
    });

    // remove stale, add/update
    for (const [id, n] of this.nodes) if (!want.has(id)) this._removeNode(id, n);
    for (const [id, spec] of want) this._upsertNode(id, spec);

    // edges
    const wantEdges = new Set();
    const link = (a, b, color, opacity = 0.16) => {
      const k = `${a}|${b}`;
      wantEdges.add(k);
      this._upsertEdge(k, a, b, color, opacity);
    };
    for (const c of channels) link(`c:${c.id}`, 'core', CHANNEL_META[c.id]?.color || '#94a3b8', c.active ? 0.22 : 0.07);
    link('core', 'tools', '#a78bfa', 0.18);
    for (const p of live) {
      link('core', `p:${p.id}`, p.isDefault ? '#60a5fa' : '#64748b', p.isDefault ? 0.3 : 0.16);
      for (const m of (p.models || []).slice(0, 6)) link(`p:${p.id}`, `m:${p.id}:${m.id}`, '#94a3b8', 0.14);
    }
    for (const p of idle) link('core', `p:${p.id}`, '#334155', 0.05);
    for (const [k, e] of this.edges) if (!wantEdges.has(k)) { this.scene.remove(e.line); e.line.geometry.dispose(); e.mat.dispose(); this.edges.delete(k); }

    // bounds for camera fit
    const box = new THREE.Box3();
    for (const n of this.nodes.values()) box.expandByPoint(n.pos);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    this.bounds = { w: size.x + (portrait ? 4 : 12), h: size.y + (portrait ? 6 : 4), cx: center.x + (portrait ? 0 : 1.2), cy: center.y + (portrait ? 1.4 : 0) };
    this.gridHelper.position.y = box.min.y - 1.5;
    this._fit();
  }

  _upsertNode(id, spec) {
    let n = this.nodes.get(id);
    if (!n) {
      const group = new THREE.Group();
      let mesh;
      if (spec.kind === 'core') {
        mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(spec.size, 1), new THREE.MeshStandardMaterial({ color: spec.color, emissive: spec.color, emissiveIntensity: 0.55, wireframe: true }));
        const inner = new THREE.Mesh(new THREE.SphereGeometry(spec.size * 0.55, 32, 32), new THREE.MeshStandardMaterial({ color: 0x0b1530, emissive: spec.color, emissiveIntensity: 0.9, roughness: 0.3 }));
        group.add(inner);
        group.userData.inner = inner;
      } else if (spec.kind === 'tools') {
        mesh = new THREE.Mesh(new THREE.OctahedronGeometry(spec.size, 0), new THREE.MeshStandardMaterial({ color: spec.color, emissive: spec.color, emissiveIntensity: 0.45, flatShading: true }));
      } else {
        mesh = new THREE.Mesh(new THREE.SphereGeometry(spec.size, 28, 28), new THREE.MeshStandardMaterial({ color: spec.color, emissive: spec.color, emissiveIntensity: 0.35, roughness: 0.35, metalness: 0.2 }));
      }
      mesh.userData.nodeId = id;
      group.add(mesh);

      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: spec.color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
      glow.scale.setScalar(spec.size * 4.2);
      group.add(glow);

      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(spec.size * 1.45, Math.max(0.025, spec.size * 0.06), 8, 48),
        new THREE.MeshBasicMaterial({ color: STATUS_RING[spec.ring] || STATUS_RING.off, transparent: true, opacity: 0.75 })
      );
      group.add(ring);

      const label = document.createElement('button');
      label.type = 'button';
      label.className = `sm-label sm-label-${spec.kind}`;
      label.addEventListener('click', (e) => { e.stopPropagation(); this.opts.onSelectNode?.(this.nodes.get(id)?.info); });
      this.labelLayer.appendChild(label);

      this.scene.add(group);
      n = { id, kind: spec.kind, group, mesh, glow, ring, label, pos: spec.pos.clone(), info: null, pulse: null, base: spec.size };
      group.position.copy(spec.pos);
      this.nodes.set(id, n);
    }
    // updates that may change every refresh
    n.info = spec.info;
    n.pos.copy(spec.pos);
    n.group.position.copy(spec.pos);
    n.ring.material.color.setHex(STATUS_RING[spec.ring] || STATUS_RING.off);
    n.ringTone = spec.ring;
    if (spec.kind !== 'core') {
      n.mesh.material.color.copy(spec.color);
      n.mesh.material.emissive.copy(spec.color);
    }
    n.glow.material.color.copy(spec.color);
    const l = spec.label;
    n.label.classList.toggle('dim', Boolean(l.dim));
    n.label.classList.toggle('small', Boolean(l.small));
    n.label.dataset.tone = spec.ring;
    n.label.innerHTML = `${l.icon ? `<span class="sm-label-icon">${l.icon}</span>` : ''}<span class="sm-label-text"><b>${escapeHtml(l.title)}</b>${l.sub ? `<small>${escapeHtml(l.sub)}</small>` : ''}</span>`;
    n.label.setAttribute('aria-label', `${l.title}${l.sub ? ` — ${l.sub}` : ''}`);
  }

  _removeNode(id, n) {
    this.scene.remove(n.group);
    n.group.traverse((o) => { o.geometry?.dispose?.(); if (o.material && o.material.map !== this.glowTex) o.material.dispose?.(); else o.material?.dispose?.(); });
    n.label.remove();
    this.nodes.delete(id);
  }

  _curve(a, b) {
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.z += 1.6 + a.distanceTo(b) * 0.08;
    mid.y += 0.4;
    return new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone());
  }

  _upsertEdge(k, a, b, color, opacity) {
    const na = this.nodes.get(a);
    const nb = this.nodes.get(b);
    if (!na || !nb) return;
    const pts = this._curve(na.pos, nb.pos).getPoints(48);
    let e = this.edges.get(k);
    if (!e) {
      const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity, depthWrite: false });
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
      this.scene.add(line);
      e = { line, mat, base: opacity, baseColor: new THREE.Color(color), heat: 0, heatColor: new THREE.Color(color) };
      this.edges.set(k, e);
    } else {
      e.line.geometry.setFromPoints(pts);
      e.base = opacity;
      e.baseColor.set(color);
    }
  }

  _edge(a, b) {
    return this.edges.get(`${a}|${b}`) || this.edges.get(`${b}|${a}`) || null;
  }

  // -------------------------------------------------------------- animation

  pulse(nodeId, color = COLORS.core) {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    n.pulse = { t0: performance.now(), color: new THREE.Color(color) };
    n.lastActive = performance.now();
  }

  /**
   * Sends a glowing dot along a path of node ids (each hop a curve).
   * @param {string[]} path
   * @param {{color?:number, traceId?:string, bubble?:string, size?:number, onArrive?:Function}} o
   */
  spawn(path, o = {}) {
    const ids = path.map((id) => (this.nodes.has(id) ? id : null)).filter(Boolean);
    const hops = [];
    for (let i = 0; i < ids.length - 1; i++) if (ids[i] !== ids[i + 1]) hops.push([ids[i], ids[i + 1]]);
    if (!hops.length) return;
    if (this.particles.length > 160) return; // storm guard

    const color = new THREE.Color(o.color ?? COLORS.in);
    const head = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
    const size = o.size ?? 0.85;
    head.scale.setScalar(size);
    head.userData.traceId = o.traceId || null;
    this.scene.add(head);
    const trail = [];
    for (let i = 0; i < 7; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color, transparent: true, opacity: 0.5 * (1 - i / 7), blending: THREE.AdditiveBlending, depthWrite: false }));
      s.scale.setScalar(size * (0.8 - i * 0.09));
      this.scene.add(s);
      trail.push(s);
    }
    let bubble = null;
    if (o.bubble) {
      bubble = document.createElement('button');
      bubble.type = 'button';
      bubble.className = 'sm-bubble';
      bubble.style.setProperty('--c', `#${color.getHexString()}`);
      bubble.textContent = o.bubble.length > 46 ? `${o.bubble.slice(0, 45)}…` : o.bubble;
      bubble.title = 'Klik untuk melihat seluruh proses pesan ini';
      bubble.addEventListener('click', (e) => { e.stopPropagation(); if (o.traceId) this.opts.onSelectTrace?.(o.traceId); });
      this.labelLayer.appendChild(bubble);
    }
    const hopMs = (this.reduced ? 1500 : 950) * (o.slow ? 1.4 : 1);
    this.particles.push({ head, trail, bubble, hops, hop: 0, t0: performance.now(), hopMs, color, traceId: o.traceId, onArrive: o.onArrive, curve: this._curve(this.nodes.get(hops[0][0]).pos, this.nodes.get(hops[0][1]).pos) });
    const e = this._edge(hops[0][0], hops[0][1]);
    if (e) { e.heat = 1; e.heatColor.copy(color); }
  }

  _killParticle(p) {
    this.scene.remove(p.head);
    p.head.material.dispose();
    for (const s of p.trail) { this.scene.remove(s); s.material.dispose(); }
    p.bubble?.remove();
  }

  /** Maps one live SSE message from /api/system-map/events to motion. */
  handle(msg) {
    if (!msg) return;
    if (msg.kind === 'start') {
      const t = msg.trace;
      const ch = `c:${t.channel}`;
      this.pulse(ch, CHANNEL_META[t.channel] ? new THREE.Color(CHANNEL_META[t.channel].color).getHex() : COLORS.in);
      this.spawn([ch, 'core'], { color: COLORS.in, traceId: t.id, bubble: t.input || t.title, slow: true });
      this.traceState.set(t.id, { channel: t.channel });
      return;
    }
    if (msg.kind === 'end') {
      const t = msg.trace;
      this.pulse(`c:${t.channel}`, t.status === 'error' ? COLORS.err : COLORS.ok);
      setTimeout(() => this.traceState.delete(t.id), 4000);
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
        if (e) { e.heat = 0.6; e.heatColor.setHex(COLORS.route); }
        break;
      }
      case 'skip':
        this.pulse(mNode(ev.provider, ev.model), COLORS.warn);
        break;
      case 'attempt':
        st.provider = ev.provider; st.model = ev.model;
        this.spawn(['core', pNode(ev.provider), mNode(ev.provider, ev.model)], { color: COLORS.route, traceId: id, size: 0.7 });
        break;
      case 'first_token':
        this.pulse(mNode(st.provider || ev.provider, st.model), COLORS.ok);
        break;
      case 'fail':
        this.pulse(mNode(ev.provider, ev.model), COLORS.err);
        this.spawn([mNode(ev.provider, ev.model), pNode(ev.provider), 'core'], { color: COLORS.err, traceId: id, size: 0.6 });
        break;
      case 'success':
        this.spawn([mNode(ev.provider, ev.model), pNode(ev.provider), 'core'], { color: COLORS.ok, traceId: id, size: 0.75 });
        break;
      case 'tool_start':
        this.spawn(['core', 'tools'], { color: COLORS.tool, traceId: id, size: 0.6, bubble: ev.name });
        break;
      case 'tool_end':
        this.spawn(['tools', 'core'], { color: ev.ok ? COLORS.tool : COLORS.err, traceId: id, size: 0.55 });
        break;
      case 'deliver':
        this.spawn(['core', `c:${ev.channel || st.channel}`], { color: ev.ok === false ? COLORS.err : COLORS.out, traceId: id, size: 0.8, bubble: ev.ok === false ? 'gagal terkirim' : `terkirim · ${fmtNum(ev.chars)} karakter` });
        break;
      case 'all_failed':
      case 'error':
        this.pulse('core', COLORS.err);
        break;
      default:
        break;
    }
  }

  /** Plays a finished trace again, time-compressed. Returns a cancel function. */
  replay(trace, speed = 1) {
    const timers = [];
    const t = trace;
    this.handle({ kind: 'start', trace: { id: t.id, channel: t.channel, input: t.input, title: t.title } });
    const evs = t.events || [];
    const total = Math.max(1, evs.length ? evs[evs.length - 1].dt : 1);
    const span = Math.min(9000, Math.max(2500, total)) / speed;
    evs.forEach((ev, i) => {
      const at = 900 + (ev.dt / total) * span + i * 40;
      timers.push(setTimeout(() => this.handle({ kind: 'event', traceId: t.id, channel: t.channel, event: ev }), at));
    });
    timers.push(setTimeout(() => this.handle({ kind: 'end', trace: { id: t.id, channel: t.channel, status: t.status } }), 1300 + span + evs.length * 40));
    return () => timers.forEach(clearTimeout);
  }

  setHighlight(traceId) {
    this.highlight = traceId || null;
  }

  focusNode(nodeId) {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    this.focus = nodeId;
    this.userMoved = true;
    this.controls.autoRotate = false;
    this.flyTo = { from: this.controls.target.clone(), to: n.pos.clone(), t0: performance.now() };
  }

  resetView() {
    this.focus = null;
    this.userMoved = false;
    this.controls.autoRotate = !this.reduced;
    this._fit();
  }

  // -------------------------------------------------------------------- loop

  _loop() {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this._loop);
    if (document.hidden) return;
    const now = performance.now();
    const dt = Math.min(0.05, this.clock.getDelta());

    if (this.flyTo) {
      const k = Math.min(1, (now - this.flyTo.t0) / 700);
      const e = 1 - Math.pow(1 - k, 3);
      this.controls.target.lerpVectors(this.flyTo.from, this.flyTo.to, e);
      if (k >= 1) this.flyTo = null;
    }
    this.controls.update();

    const core = this.nodes.get('core');
    if (core) {
      core.mesh.rotation.y += dt * 0.35;
      core.mesh.rotation.x += dt * 0.12;
      const breathe = 1 + Math.sin(now / 900) * 0.04;
      core.group.userData.inner?.scale.setScalar(breathe);
      this.coreLight.position.copy(core.pos);
    }
    this.stars.rotation.y += dt * 0.004;

    for (const n of this.nodes.values()) {
      n.ring.lookAt(this.camera.position);
      if (n.kind === 'tools') n.mesh.rotation.y += dt * 0.6;
      if (n.pulse) {
        const k = (now - n.pulse.t0) / 1100;
        if (k >= 1) {
          n.pulse = null;
          n.group.scale.setScalar(1);
          n.glow.material.opacity = 0.35;
          n.glow.material.color.copy(n.mesh.material.emissive);
        } else {
          const s = 1 + Math.sin(k * Math.PI) * 0.35;
          n.group.scale.setScalar(s);
          n.glow.material.color.copy(n.pulse.color);
          n.glow.material.opacity = 0.35 + (1 - k) * 0.65;
        }
      }
    }

    for (const e of this.edges.values()) {
      if (e.heat > 0) {
        e.heat = Math.max(0, e.heat - dt * 0.6);
        e.mat.opacity = e.base + (0.9 - e.base) * e.heat;
        e.mat.color.copy(e.baseColor).lerp(e.heatColor, e.heat);
      }
    }

    // particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      let k = (now - p.t0) / p.hopMs;
      if (k >= 1) {
        const [, to] = p.hops[p.hop];
        this.pulse(to, p.color.getHex());
        p.hop += 1;
        if (p.hop >= p.hops.length) {
          p.onArrive?.();
          this._killParticle(p);
          this.particles.splice(i, 1);
          continue;
        }
        const [a, b] = p.hops[p.hop];
        const na = this.nodes.get(a);
        const nb = this.nodes.get(b);
        if (!na || !nb) { this._killParticle(p); this.particles.splice(i, 1); continue; }
        p.curve = this._curve(na.pos, nb.pos);
        p.t0 = now;
        k = 0;
        const e = this._edge(a, b);
        if (e) { e.heat = 1; e.heatColor.copy(p.color); }
      }
      const ease = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      p.head.position.copy(p.curve.getPoint(ease));
      const hl = this.highlight && p.traceId === this.highlight;
      p.head.scale.setScalar((hl ? 1.35 : 1) * (0.85 + Math.sin(now / 90) * 0.08));
      p.trail.forEach((s, j) => s.position.copy(p.curve.getPoint(Math.max(0, ease - (j + 1) * 0.035))));
    }

    this.renderer.render(this.scene, this.camera);
    this._labels();
  }

  _project(v) {
    const p = v.clone().project(this.camera);
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h, behind: p.z > 1 };
  }

  _labels() {
    const now = performance.now();
    this._camRight = (this._camRight || new THREE.Vector3()).setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
    for (const n of this.nodes.values()) {
      let show = true;
      if (n.kind === 'model') {
        const owner = `p:${n.info?.provider}`;
        show = (n.lastActive != null && now - n.lastActive < 7000) || this.focus === owner || this.focus === n.id || this.hover === owner || this.hover === n.id;
      }
      // Labels sit beside the sphere (never on top of the next node): channels left, providers/models right, core/tools below.
      const c = this._project(n.pos);
      const edge = this._project(n.pos.clone().add(this._camRight.clone().multiplyScalar(n.base * 1.5)));
      const r = Math.max(6, Math.hypot(edge.x - c.x, edge.y - c.y)) + 4;
      const side = this.portrait
        ? (n.kind === 'model' ? 'right' : 'below')
        : n.kind === 'channel' ? 'left' : (n.kind === 'core' || n.kind === 'tools') ? 'below' : 'right';
      const tf = side === 'left'
        ? `translate(-100%, -50%) translate(${(c.x - r).toFixed(1)}px, ${c.y.toFixed(1)}px)`
        : side === 'right'
          ? `translate(0, -50%) translate(${(c.x + r).toFixed(1)}px, ${c.y.toFixed(1)}px)`
          : `translate(-50%, 0) translate(${c.x.toFixed(1)}px, ${(c.y + r).toFixed(1)}px)`;
      n.label.style.transform = tf;
      n.label.style.visibility = c.behind || !show ? 'hidden' : 'visible';
    }
    for (const p of this.particles) {
      if (!p.bubble) continue;
      const s = this._project(p.head.position);
      p.bubble.style.transform = `translate(-50%, -140%) translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`;
      p.bubble.style.visibility = s.behind ? 'hidden' : 'visible';
    }
  }

  _pick(e, click) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const heads = this.particles.filter((p) => p.traceId).map((p) => p.head);
    const hitP = heads.length ? this.raycaster.intersectObjects(heads, false)[0] : null;
    const meshes = [...this.nodes.values()].map((n) => n.mesh);
    const hitN = hitP ? null : this.raycaster.intersectObjects(meshes, false)[0];
    this.renderer.domElement.style.cursor = hitP || hitN ? 'pointer' : 'grab';
    this.hover = hitN ? hitN.object.userData.nodeId : null;
    if (!click) return;
    if (hitP) this.opts.onSelectTrace?.(hitP.object.userData.traceId);
    else if (hitN) {
      const id = hitN.object.userData.nodeId;
      this.opts.onSelectNode?.(this.nodes.get(id)?.info);
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.renderer.domElement.removeEventListener('click', this._onClick);
    this.renderer.domElement.removeEventListener('pointermove', this._onMove);
    for (const p of this.particles) this._killParticle(p);
    this.particles = [];
    for (const [id, n] of this.nodes) this._removeNode(id, n);
    for (const e of this.edges.values()) { e.line.geometry.dispose(); e.mat.dispose(); }
    this.edges.clear();
    this.stars.geometry.dispose();
    this.stars.material.dispose();
    this.gridHelper.geometry.dispose();
    this.gridHelper.material.dispose();
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

/** WebGL available? (old phones / disabled GPU) */
export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return Boolean(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}
