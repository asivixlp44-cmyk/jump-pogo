import { T, V3, $, renderer, scene, camera, sun } from './engine.js';

// ----- quality presets -----
// No post-processing (bloom) and no tone mapping, like Bloxity's top games: the scene is drawn
// straight to the screen. The presets change the resolution and the shadows, and a change never
// recompiles a shader: shadows stay on in the renderer and Low just stops drawing the shadow map
// and fades the shadows out.
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
export const QUALITIES = {
    low: { label: 'Low', ratio: 0.85, shadows: false },
    medium: { label: 'Medium', ratio: 1, shadows: true },
    high: { label: 'High', ratio: 1.5, shadows: true },
};
let quality = isTouch ? 'low' : 'medium', chosen = false;
try { const q = localStorage.getItem('jpg_quality'); if (q && QUALITIES[q]) { quality = q; chosen = true; } } catch (e) { /* default */ }

renderer.toneMapping = T.NoToneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true;
sun.castShadow = true;
// a 1024 shadow map at every quality, like the top games
if (sun.shadow.mapSize.x !== 1024) sun.shadow.mapSize.set(1024, 1024);

let applied = '';
function applyQuality() {
    const q = QUALITIES[quality];
    applied = quality;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, q.ratio));
    sun.shadow.intensity = q.shadows ? 1 : 0;
    renderer.shadowMap.autoUpdate = q.shadows;
    renderer.shadowMap.needsUpdate = true; // drawn at least once so the shaders always have a map
    resizeFx();
}
export function getQuality() { return quality; }
// auto: a step down by the frame-rate watcher, never saved
export function setQuality(q, auto) {
    if (!QUALITIES[q]) return;
    if (!auto) { chosen = true; try { localStorage.setItem('jpg_quality', q); } catch (e) { /* ignore */ } }
    quality = q;
    if (applied !== q) applyQuality();
}
function resizeFx() {
    lines.width = Math.round(innerWidth * Math.min(devicePixelRatio || 1, 1.5));
    lines.height = Math.round(innerHeight * Math.min(devicePixelRatio || 1, 1.5));
}
addEventListener('resize', resizeFx);

// A PC that can't keep up steps down a level by itself, unless the player picked a quality:
// 3 seconds of frames slower than 40 FPS, after the first 6 seconds of play
let lastT = 0, playT = 0, slowT = 0;
function watchFps() {
    const now = performance.now(), dt = lastT ? (now - lastT) / 1000 : 0;
    lastT = now;
    if (chosen || dt <= 0 || dt > 0.5 || document.hidden) return;
    playT += dt;
    if (playT < 6) return;
    slowT = dt > 1 / 40 ? slowT + dt : Math.max(0, slowT - dt * 0.5);
    if (slowT < 3) return;
    slowT = 0; playT = 3;
    const next = quality === 'high' ? 'medium' : quality === 'medium' ? 'low' : null;
    if (next) setQuality(next, true);
}

export function render() {
    watchFps();
    renderer.render(scene, camera);
}

// ----- speed lines (2D overlay) -----
const lines = $('#speedLines');
const lctx = lines.getContext('2d');
const streaks = Array.from({ length: 70 }, () => ({ a: Math.random() * Math.PI * 2, r: Math.random(), l: 0.1 + Math.random() * 0.25, w: 1 + Math.random() * 2.5 }));
let lineAmt = 0;
export function setSpeedLines(target, dt) {
    const was = lineAmt;
    lineAmt += (target - lineAmt) * Math.min(1, dt * 6);
    // nothing to draw or clear while the lines are off (a full-screen clear every frame costs)
    if (lineAmt < 0.02 && was < 0.02) return;
    const w = lines.width, h = lines.height;
    lctx.clearRect(0, 0, w, h);
    if (lineAmt < 0.02) return;
    const cx = w / 2, cy = h * 0.46, R = Math.hypot(w, h) / 2;
    lctx.lineCap = 'round';
    for (const s of streaks) {
        s.r += dt * (1.6 + s.l * 4);
        if (s.r > 1) { s.r = 0.35 + Math.random() * 0.2; s.a = Math.random() * Math.PI * 2; }
        const r0 = R * s.r, r1 = R * Math.min(1.1, s.r + s.l);
        lctx.strokeStyle = `rgba(255,255,255,${(0.7 * lineAmt * s.r).toFixed(3)})`;
        lctx.lineWidth = s.w;
        lctx.beginPath();
        lctx.moveTo(cx + Math.cos(s.a) * r0, cy + Math.sin(s.a) * r0);
        lctx.lineTo(cx + Math.cos(s.a) * r1, cy + Math.sin(s.a) * r1);
        lctx.stroke();
    }
}

// ----- soft sprite particles (dust, sparkles, fireworks) -----
const softTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(255,255,255,0.6)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace;
    return t;
})();
const sprites = [];
function spawn(pos, vel, color, size, life, opts) {
    opts = opts || {};
    const m = new T.SpriteMaterial({ map: opts.map || softTex, color, transparent: true, depthWrite: false, blending: opts.add ? T.AdditiveBlending : T.NormalBlending, opacity: opts.opacity || 1 });
    if (opts.hdr) m.color.multiplyScalar(opts.hdr);
    const s = new T.Sprite(m);
    s.position.copy(pos); s.scale.setScalar(size);
    scene.add(s);
    sprites.push({ s, v: vel, life, max: life, grow: opts.grow || 0, grav: opts.grav || 0, drag: opts.drag || 0, size, fade0: opts.opacity || 1 });
}
export function dust(pos, n, strength) {
    for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, sp = (2 + Math.random() * 4) * strength;
        spawn(new V3(pos.x + Math.cos(a) * 0.6, pos.y + 0.3, pos.z + Math.sin(a) * 0.6), new V3(Math.cos(a) * sp, 1.5 + Math.random() * 2, Math.sin(a) * sp),
            0xd8d0e8, 0.55 + Math.random() * 0.4, 0.35 + Math.random() * 0.2, { grow: 1.6, drag: 3.5, opacity: 0.35 });
    }
}
export function sparkleColumn(pos, color) {
    for (let i = 0; i < 18; i++) {
        const a = Math.random() * Math.PI * 2, r = 1.8 + Math.random() * 1.2;
        spawn(new V3(pos.x + Math.cos(a) * r, pos.y + Math.random() * 2, pos.z + Math.sin(a) * r), new V3(0, 7 + Math.random() * 8, 0),
            color, 0.3 + Math.random() * 0.3, 0.7 + Math.random() * 0.4, { add: true, hdr: 1.6, drag: 0.6 });
    }
}

// Light trail streaming behind the player, coloured by the equipped trail (-1 = rainbow):
// a vertical ribbon through the last few positions, tapering and fading toward the tail
export function makeTrail(color) {
    const N = 26, pts = [];
    const pos = new Float32Array(N * 2 * 3), col = new Float32Array(N * 2 * 3);
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    geo.setAttribute('color', new T.BufferAttribute(col, 3));
    const idx = [];
    for (let i = 0; i < N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    geo.setIndex(idx);
    const mesh = new T.Mesh(geo, new T.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, toneMapped: false }));
    mesh.frustumCulled = false;
    scene.add(mesh);
    const c = new T.Color(color), hue = new T.Color();
    let acc = 0, rainbow = false, spin = 0;
    return {
        setColor(hex) { rainbow = hex === -1; if (!rainbow) c.set(hex); },
        dispose() { scene.remove(mesh); geo.dispose(); mesh.material.dispose(); },
        update(at, on, dt) {
            acc += dt; spin += dt;
            if (acc >= 0.03) {
                acc = 0;
                if (on) pts.unshift(at.clone()); else pts.pop();
                if (pts.length > N) pts.length = N;
            }
            if (pts.length) pts[0].copy(on ? at : pts[0]);
            for (let i = 0; i < N; i++) {
                const p = pts[Math.min(i, pts.length - 1)];
                const k = pts.length > 1 ? 1 - i / (pts.length - 1) : 0;
                const h = i < pts.length ? 1.1 * k : 0;
                for (let s = 0; s < 2; s++) {
                    const o = (i * 2 + s) * 3;
                    if (p) { pos[o] = p.x; pos[o + 1] = p.y + (s ? h : -h); pos[o + 2] = p.z; }
                    const cc = rainbow ? hue.setHSL((spin * 0.5 + i / N) % 1, 1, 0.6) : c;
                    col[o] = cc.r * k * 0.9; col[o + 1] = cc.g * k * 0.9; col[o + 2] = cc.b * k * 0.9;
                }
            }
            geo.attributes.position.needsUpdate = true;
            geo.attributes.color.needsUpdate = true;
            mesh.visible = pts.length > 1;
        },
    };
}

// Fire puff (the troll balls' fiery grin): rises, shrinks and fades
export function flame(at, spread, size, vel) {
    const p = new V3(at.x + (Math.random() - 0.5) * spread, at.y + (Math.random() - 0.5) * spread * 0.5, at.z + (Math.random() - 0.5) * spread);
    const v = vel ? vel.clone().multiplyScalar(0.7 + Math.random() * 0.6) : new V3(0, 0, 0);
    v.x += (Math.random() - 0.5) * 3; v.y += 3 + Math.random() * 5; v.z += (Math.random() - 0.5) * 3;
    spawn(p, v, Math.random() < 0.45 ? 0xff5a14 : Math.random() < 0.6 ? 0xffb51c : 0xfff0a0,
        (size || 1.4) * (0.7 + Math.random() * 0.6), 0.45 + Math.random() * 0.35, { add: true, hdr: 1.3, grow: -0.5, drag: 1.5, opacity: 0.95 });
}
// Leaves kicked up by running feet
export function leaves(at, n) {
    for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        spawn(new V3(at.x + Math.cos(a) * 0.8, at.y + 0.3, at.z + Math.sin(a) * 0.8), new V3(Math.cos(a) * 3, 2 + Math.random() * 3, Math.sin(a) * 3),
            Math.random() < 0.5 ? 0x46ec50 : 0x9cff5a, 0.35 + Math.random() * 0.25, 0.6 + Math.random() * 0.3, { grav: 9, drag: 1.2, opacity: 0.9 });
    }
}

// Treadmill effects: x3 flames, x9 electric sparks, x25 white/purple twinkles
export function emitTread(at, mult, len, width) {
    const p = new V3(at.x + (Math.random() - 0.5) * len * 0.8, at.y, at.z + (Math.random() - 0.5) * width * 0.9);
    if (mult === 3) {
        spawn(p, new V3((Math.random() - 0.5) * 1.5, 5 + Math.random() * 4, (Math.random() - 0.5) * 1.5), Math.random() < 0.5 ? 0xff7a1a : 0xffc414,
            0.9 + Math.random() * 0.7, 0.45 + Math.random() * 0.3, { add: true, hdr: 1.3, grow: -0.6, opacity: 0.9 });
    } else if (mult === 9) {
        spawn(p.setY(at.y + Math.random() * 2.5), new V3((Math.random() - 0.5) * 8, (Math.random() - 0.3) * 6, (Math.random() - 0.5) * 8), 0x7fe8ff,
            0.35 + Math.random() * 0.3, 0.18 + Math.random() * 0.15, { add: true, hdr: 1.6 });
    } else {
        spawn(p.setY(at.y + Math.random() * 4), new V3(0, 1 + Math.random() * 2, 0), Math.random() < 0.6 ? 0xffffff : 0xc28cff,
            0.3 + Math.random() * 0.35, 0.6 + Math.random() * 0.5, { add: true, hdr: 1.5 });
    }
}

// Water splash: a white crown of spray and a few drops
export function splash(at, size) {
    size = size || 1;
    for (let i = 0; i < 34 * size; i++) {
        const a = Math.random() * Math.PI * 2, sp = (3 + Math.random() * 7) * size;
        spawn(new V3(at.x + Math.cos(a) * 1.2, at.y + 0.2, at.z + Math.sin(a) * 1.2), new V3(Math.cos(a) * sp, (10 + Math.random() * 16) * size, Math.sin(a) * sp),
            Math.random() < 0.6 ? 0xffffff : 0x9ff0ff, (0.6 + Math.random() * 0.6) * size, 0.7 + Math.random() * 0.4, { grav: 40, drag: 0.8, opacity: 0.95, grow: 0.6 });
    }
}
// Trail particles from a pogo's tip: fire, electric sparks, golden stars, pink hearts
export function pogoFx(at, kind) {
    const p = new V3(at.x + (Math.random() - 0.5) * 0.8, at.y + Math.random() * 0.6, at.z + (Math.random() - 0.5) * 0.8);
    if (kind === 'fire') { flame(p, 0.4, 0.9); return; }
    const c = kind === 'spark' ? (Math.random() < 0.5 ? 0x7fe8ff : 0xffffff) : kind === 'heart' ? (Math.random() < 0.6 ? 0xff5ab8 : 0xffc0e4) : (Math.random() < 0.6 ? 0xffd028 : 0xffffff);
    spawn(p, new V3((Math.random() - 0.5) * 3, -1 - Math.random() * 2, (Math.random() - 0.5) * 3), c,
        0.35 + Math.random() * 0.35, 0.5 + Math.random() * 0.4, { add: true, hdr: 1.8, drag: 1.2 });
}
// A big bounce: dust puff plus a bright ring that races out along the ground
export function bounceFx(at, strength, color) {
    dust(at, Math.round(4 + strength * 8), 0.6 + strength * 0.8);
    if (strength > 0.4) ring(at, color || 0xffffff, 3 + strength * 6, 0.35 + strength * 0.2);
}

// Expanding neon ring on the ground (level up, landing big falls)
const rings = [];
export function ring(pos, color, maxR, life) {
    const m = new T.MeshBasicMaterial({ color, transparent: true, depthWrite: false, side: T.DoubleSide });
    m.color.multiplyScalar(2.2);
    const mesh = new T.Mesh(new T.RingGeometry(0.8, 1, 48), m);
    mesh.rotation.x = -Math.PI / 2; mesh.position.copy(pos).setY(pos.y + 0.2);
    scene.add(mesh);
    rings.push({ mesh, t: 0, life: life || 0.7, maxR: maxR || 9 });
}

// Fireworks: a glowing rocket that bursts into coloured sparks
const rockets = [];
const FW_COLORS = [0xffd028, 0x46ec50, 0x28c8ff, 0xff3fa0, 0xc428ff, 0xff6e14];
export function fireworks(center, count, onBurst) {
    for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * 10;
        rockets.push({
            p: new V3(center.x + Math.cos(a) * r, center.y + 1, center.z + Math.sin(a) * r),
            v: new V3((Math.random() * 2 - 1) * 3, 34 + Math.random() * 10, (Math.random() * 2 - 1) * 3),
            t: 0.7 + Math.random() * 0.3 + i * 0.18, trail: 0, color: FW_COLORS[(Math.random() * FW_COLORS.length) | 0], onBurst,
        });
    }
}
function burstFw(p, color) {
    for (let i = 0; i < 46; i++) {
        const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
        const sp = 16 + Math.random() * 8;
        spawn(p.clone(), new V3(s * Math.cos(th) * sp, u * sp, s * Math.sin(th) * sp), i % 5 ? color : 0xffffff, 0.9 + Math.random() * 0.5, 1.1 + Math.random() * 0.5, { add: true, hdr: 2.5, grav: 14, drag: 1.4 });
    }
}

export function updateFx(dt) {
    for (let i = sprites.length - 1; i >= 0; i--) {
        const p = sprites[i];
        p.life -= dt;
        if (p.life <= 0) { scene.remove(p.s); p.s.material.dispose(); sprites.splice(i, 1); continue; }
        p.v.y -= p.grav * dt;
        if (p.drag) p.v.multiplyScalar(Math.exp(-p.drag * dt));
        p.s.position.addScaledVector(p.v, dt);
        const k = p.life / p.max;
        p.s.material.opacity = p.fade0 * Math.min(1, k * 2);
        if (p.grow) p.s.scale.setScalar(Math.max(0.05, p.size * (1 + p.grow * (1 - k))));
    }
    for (let i = rings.length - 1; i >= 0; i--) {
        const r = rings[i];
        r.t += dt;
        const k = r.t / r.life;
        if (k >= 1) { scene.remove(r.mesh); r.mesh.geometry.dispose(); r.mesh.material.dispose(); rings.splice(i, 1); continue; }
        const e = 1 - Math.pow(1 - k, 3);
        r.mesh.scale.setScalar(1 + e * r.maxR);
        r.mesh.material.opacity = 1 - k;
    }
    for (let i = rockets.length - 1; i >= 0; i--) {
        const r = rockets[i];
        r.v.y -= 20 * dt;
        r.p.addScaledVector(r.v, dt);
        r.trail -= dt;
        if (r.trail <= 0) { r.trail = 0.03; spawn(r.p.clone(), new V3(0, -2, 0), 0xffe7a8, 0.7, 0.35, { add: true, hdr: 2 }); }
        r.t -= dt;
        if (r.t <= 0) { burstFw(r.p, r.color); if (r.onBurst) r.onBurst(); rockets.splice(i, 1); }
    }
}

applyQuality();
