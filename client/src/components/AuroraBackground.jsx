import { useEffect, useRef } from 'react';

/**
 * AuroraBackground — a dependency-free, true-3D animated particle field.
 *
 * Renders a rotating 3D cloud of brand-colored points connected into a living
 * constellation, projected to 2D with real perspective. It reacts to the
 * pointer (subtle camera parallax), adapts to the active light/dark theme,
 * and is fully non-interactive (pointer-events: none) so it never blocks the UI.
 *
 * Performance & accessibility guards:
 *   - Honors prefers-reduced-motion (renders a single still frame, no loop).
 *   - Pauses the animation loop when the tab is hidden (saves battery/CPU).
 *   - Caps particle count and scales to devicePixelRatio for crisp, cheap draw.
 *
 * @author Wisnu Alfian Nur Ashar
 */
export default function AuroraBackground({ density = 70 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let width = 0;
    let height = 0;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    const COUNT = Math.max(24, Math.min(density, 120));
    const FOCAL = 520; // perspective focal length

    // Brand palette (orange) — alpha varies with depth for a 3D fade.
    const isDark = () =>
      document.documentElement.getAttribute('data-theme') === 'dark';

    // 3D points in a centered cube [-R, R].
    const R = 260;
    const pts = Array.from({ length: COUNT }, () => ({
      x: (Math.random() * 2 - 1) * R,
      y: (Math.random() * 2 - 1) * R,
      z: (Math.random() * 2 - 1) * R,
    }));

    // Pointer-driven target rotation (parallax); eased toward each frame.
    const rot = { x: 0.3, y: 0, tx: 0.3, ty: 0 };
    const onPointer = (e) => {
      const nx = e.clientX / window.innerWidth - 0.5;
      const ny = e.clientY / window.innerHeight - 0.5;
      rot.ty = nx * 0.9;
      rot.tx = 0.3 + ny * 0.6;
    };
    window.addEventListener('pointermove', onPointer, { passive: true });

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    let t = 0;
    function frame() {
      t += 0.0025;
      // Ease rotation toward pointer target; add gentle autonomous drift.
      rot.x += (rot.tx - rot.x) * 0.04;
      rot.y += (rot.ty - rot.y) * 0.04;
      const ay = rot.y + t;
      const ax = rot.x;

      const cosY = Math.cos(ay), sinY = Math.sin(ay);
      const cosX = Math.cos(ax), sinX = Math.sin(ax);
      const cx = width / 2;
      const cy = height / 2;
      const dark = isDark();

      ctx.clearRect(0, 0, width, height);

      // Project all points once.
      const proj = new Array(COUNT);
      for (let i = 0; i < COUNT; i++) {
        const p = pts[i];
        // Rotate around Y then X.
        let x = p.x * cosY - p.z * sinY;
        let z = p.x * sinY + p.z * cosY;
        let y = p.y * cosX - z * sinX;
        z = p.y * sinX + z * cosX;
        const scale = FOCAL / (FOCAL + z + R);
        proj[i] = {
          sx: cx + x * scale,
          sy: cy + y * scale,
          scale,
          depth: (z + R) / (2 * R), // 0 (near) .. 1 (far)
        };
      }

      // Connecting lines (constellation) for nearby projected points.
      const linkDist = 120;
      for (let i = 0; i < COUNT; i++) {
        const a = proj[i];
        for (let j = i + 1; j < COUNT; j++) {
          const b = proj[j];
          const dx = a.sx - b.sx;
          const dy = a.sy - b.sy;
          const d2 = dx * dx + dy * dy;
          if (d2 < linkDist * linkDist) {
            const alpha = (1 - Math.sqrt(d2) / linkDist) * 0.18 * (1 - (a.depth + b.depth) / 2);
            if (alpha <= 0.01) continue;
            ctx.strokeStyle = dark
              ? `rgba(255,152,0,${alpha})`
              : `rgba(245,124,0,${alpha})`;
            ctx.lineWidth = 0.6;
            ctx.beginPath();
            ctx.moveTo(a.sx, a.sy);
            ctx.lineTo(b.sx, b.sy);
            ctx.stroke();
          }
        }
      }

      // Points (orange glow, brighter when near the camera).
      for (let i = 0; i < COUNT; i++) {
        const a = proj[i];
        const r = Math.max(0.6, 2.6 * a.scale);
        const alpha = (0.85 - a.depth * 0.6) * (dark ? 1 : 0.9);
        ctx.beginPath();
        ctx.arc(a.sx, a.sy, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,${Math.round(140 + a.depth * 40)},0,${alpha})`;
        ctx.fill();
      }

      if (running) rafId = requestAnimationFrame(frame);
    }

    let rafId = 0;
    let running = !reduceMotion;
    if (reduceMotion) {
      frame(); // single static frame
    } else {
      rafId = requestAnimationFrame(frame);
    }

    const onVisibility = () => {
      if (reduceMotion) return;
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(rafId);
      } else if (!running) {
        running = true;
        rafId = requestAnimationFrame(frame);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      running = false;
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [density]);

  return (
    <canvas
      ref={canvasRef}
      className="aurora-bg"
      aria-hidden="true"
    />
  );
}
