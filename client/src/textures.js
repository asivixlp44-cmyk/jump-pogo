import { T, texFrom, studMaterial, toLambert } from './engine.js';

// Canvas-generated surface textures: cracked lava, water, bricks, studded walls, cracked stone,
// dotted sandstone and checkerboard.

// Tileable Voronoi lava: bright yellow cell centres, orange body, dark cracks
function lavaCanvas() {
    const N = 256, seeds = [];
    let s = 1337;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < 22; i++) seeds.push([rnd() * N, rnd() * N]);
    const c = document.createElement('canvas'); c.width = c.height = N;
    const x = c.getContext('2d');
    const img = x.createImageData(N, N), d = img.data;
    for (let py = 0; py < N; py++) {
        for (let px = 0; px < N; px++) {
            let f1 = 1e9, f2 = 1e9;
            for (const [sx, sy] of seeds) {
                for (let ox = -N; ox <= N; ox += N) for (let oy = -N; oy <= N; oy += N) {
                    const dx = px - sx - ox, dy = py - sy - oy;
                    const dd = dx * dx + dy * dy;
                    if (dd < f1) { f2 = f1; f1 = dd; } else if (dd < f2) f2 = dd;
                }
            }
            const edge = Math.sqrt(f2) - Math.sqrt(f1);   // distance to the crack
            const centre = Math.min(1, Math.sqrt(f1) / 34); // 0 at the cell centre
            const i = (py * N + px) * 4;
            if (edge < 2.2) { d[i] = 150; d[i + 1] = 38; d[i + 2] = 8; }
            else {
                const k = Math.min(1, (edge - 2.2) / 5);
                const hot = (1 - centre) * k;
                d[i] = 255;
                d[i + 1] = Math.round(120 + 110 * hot);
                d[i + 2] = Math.round(10 + 60 * hot * hot);
            }
            d[i + 3] = 255;
        }
    }
    x.putImageData(img, 0, 0);
    return c;
}

function brickCanvas() {
    const c = document.createElement('canvas'); c.width = 128; c.height = 128;
    const x = c.getContext('2d');
    x.fillStyle = '#b9b3c9'; x.fillRect(0, 0, 128, 128);
    const rows = 8, h = 128 / rows, w = 32;
    let s = 7;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let r = 0; r < rows; r++) {
        const off = r % 2 ? w / 2 : 0;
        for (let b = -1; b < 128 / w + 1; b++) {
            const v = Math.round(225 + rnd() * 30);
            x.fillStyle = `rgb(${v},${v},${Math.min(255, v + 8)})`;
            x.fillRect(b * w + off + 1.5, r * h + 1.5, w - 3, h - 3);
            x.fillStyle = 'rgba(255,255,255,0.18)';
            x.fillRect(b * w + off + 1.5, r * h + 1.5, w - 3, 2);
        }
    }
    return c;
}

// Tileable cartoon water: cyan base with soft white caustic ridges (the stage lanes in the reference)
function waterCanvas() {
    const N = 256, seeds = [];
    let s = 4242;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < 16; i++) seeds.push([rnd() * N, rnd() * N]);
    const c = document.createElement('canvas'); c.width = c.height = N;
    const x = c.getContext('2d');
    const img = x.createImageData(N, N), d = img.data;
    for (let py = 0; py < N; py++) {
        for (let px = 0; px < N; px++) {
            let f1 = 1e9, f2 = 1e9;
            for (const [sx, sy] of seeds) {
                for (let ox = -N; ox <= N; ox += N) for (let oy = -N; oy <= N; oy += N) {
                    const dx = px - sx - ox, dy = py - sy - oy;
                    const dd = dx * dx + dy * dy;
                    if (dd < f1) { f2 = f1; f1 = dd; } else if (dd < f2) f2 = dd;
                }
            }
            const edge = Math.sqrt(f2) - Math.sqrt(f1);
            const i = (py * N + px) * 4;
            // Rounded cyan blobs separated by wide pale bands, like Roblox's water material
            const k = Math.min(1, Math.max(0, (edge - 5) / 7));
            const w = 1 - k * k * (3 - 2 * k);
            d[i] = Math.round(38 + 190 * w);
            d[i + 1] = Math.round(205 + 43 * w);
            d[i + 2] = Math.round(238 + 17 * w);
            d[i + 3] = 255;
        }
    }
    x.putImageData(img, 0, 0);
    return c;
}

// Generated on first use only: the Voronoi canvases are slow to build and this game rarely needs them
const lazy = (make) => { let c = null; return () => c || (c = make()); };
const lavaImg = lazy(lavaCanvas), brickImg = lazy(brickCanvas), waterImg = lazy(waterCanvas);
const waterAnimated = [];
const animated = [];
const cache = new Map();

function repeated(img, key, rx, ry) {
    rx = Math.max(1, Math.round(rx)); ry = Math.max(1, Math.round(ry));
    const id = key + rx + 'x' + ry;
    if (cache.has(id)) return cache.get(id);
    const t = texFrom(img);
    t.wrapS = t.wrapT = T.RepeatWrapping;
    t.repeat.set(rx, ry);
    cache.set(id, t);
    return t;
}

// Unlit so it reads as glowing, but kept below the bloom threshold
export function lavaMaterial(rx, ry) {
    const id = 'lavaMat' + Math.round(rx) + 'x' + Math.round(ry);
    if (cache.has(id)) return cache.get(id);
    const m = new T.MeshBasicMaterial({ map: repeated(lavaImg(), 'lava', rx, ry) });
    animated.push(m.map);
    cache.set(id, m);
    return m;
}
export function brickMaterial(color, rx, ry) {
    const id = 'brickMat' + color + Math.round(rx) + 'x' + Math.round(ry);
    if (cache.has(id)) return cache.get(id);
    const m = new T.MeshLambertMaterial({ color, map: repeated(brickImg(), 'brick', rx, ry) });
    cache.set(id, m);
    return m;
}

// Walkable water lane; the caustics drift slowly (updateMaterials)
export function waterMaterial(rx, ry) {
    const id = 'waterMat' + Math.round(rx) + 'x' + Math.round(ry);
    if (cache.has(id)) return cache.get(id);
    const m = new T.MeshLambertMaterial({ map: repeated(waterImg(), 'water', rx, ry) });
    waterAnimated.push(m.map);
    cache.set(id, m);
    return m;
}

// Roblox-style wall studs: a small raised square per 2x2 studs, lit from the top-left.
// Drawn white so the material colour tints it.
function studCanvas(cracks) {
    const N = 64, c = document.createElement('canvas'); c.width = c.height = N;
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, N, N);
    if (cracks) {
        // Pale branching cracks for the Stage 2 stone
        x.strokeStyle = 'rgba(255,255,255,0.9)'; x.lineWidth = 1.6;
        let s = 99;
        const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
        for (let i = 0; i < 5; i++) {
            let px = rnd() * N, py = rnd() * N;
            x.beginPath(); x.moveTo(px, py);
            for (let k = 0; k < 4; k++) { px += (rnd() - 0.5) * 30; py += (rnd() - 0.5) * 30; x.lineTo(px, py); }
            x.stroke();
        }
    }
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
        const ox = 8 + i * 32, oy = 8 + j * 32, s = 14;
        x.fillStyle = 'rgba(0,0,0,0.28)'; x.fillRect(ox + 2, oy + 2, s, s);
        x.fillStyle = '#d6d6d6'; x.fillRect(ox, oy, s, s);
        x.fillStyle = '#ffffff'; x.fillRect(ox, oy, s - 3, 2.5); x.fillRect(ox, oy, 2.5, s - 3);
    }
    return c;
}
const studImg = studCanvas(false);
const crackImg = studCanvas(true);

// Studded wall surface (Roblox studs, PBR), tinted by colour; rx / ry repeat the 8x8-stud tile
export function studWallMaterial(color, rx, ry, o) {
    return studMaterial(color, { rx, ry, ...(o || {}) });
}
// Grey studded stone with pale cracks (Stage 2's falling walls); a fresh material so each can flash
export function crackedStoneMaterial(rx, ry) {
    return new T.MeshLambertMaterial({ color: 0x8e8ca4, map: repeated(crackImg, 'crack', rx, ry) });
}

// Sandstone wall from the reference: tan with rows of small dark dimples
function dottedCanvas() {
    const N = 64, c = document.createElement('canvas'); c.width = c.height = N;
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, N, N);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        const ox = 8 + i * 16 + (j % 2 ? 8 : 0), oy = 8 + j * 16;
        x.fillStyle = 'rgba(70,40,20,0.55)'; x.beginPath(); x.arc(ox % N, oy, 2.6, 0, Math.PI * 2); x.fill();
        x.fillStyle = 'rgba(255,255,255,0.5)'; x.beginPath(); x.arc((ox % N) - 0.8, oy - 1, 1, 0, Math.PI * 2); x.fill();
    }
    x.strokeStyle = 'rgba(0,0,0,0.08)'; x.lineWidth = 2; x.strokeRect(0, 0, N, N);
    return c;
}
// Soft lavender checkerboard (the "sky" panels inside the stage gates and the Stage 2 walls)
function checkerCanvas() {
    const N = 64, c = document.createElement('canvas'); c.width = c.height = N;
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, N, N);
    x.fillStyle = '#d4d0ec'; x.fillRect(0, 0, 32, 32); x.fillRect(32, 32, 32, 32);
    x.fillStyle = 'rgba(255,255,255,0.35)'; x.fillRect(2, 2, 28, 3); x.fillRect(34, 34, 28, 3);
    return c;
}
const dottedImg = dottedCanvas();
const checkerImg = checkerCanvas();
export function dottedWallMaterial(color, rx, ry) {
    const id = 'dotMat' + color + Math.round(rx) + 'x' + Math.round(ry);
    if (cache.has(id)) return cache.get(id);
    const m = toLambert({ roughness: 0.6, color, map: repeated(dottedImg, 'dot', rx, ry) });
    cache.set(id, m);
    return m;
}
export function checkerMaterial(color, rx, ry) {
    const id = 'chkMat' + color + Math.round(rx) + 'x' + Math.round(ry);
    if (cache.has(id)) return cache.get(id);
    const m = toLambert({ roughness: 0.5, color, map: repeated(checkerImg, 'chk', rx, ry) });
    cache.set(id, m);
    return m;
}

export function updateMaterials(dt) {
    for (const t of animated) { t.offset.y = (t.offset.y + dt * 0.035) % 1; t.offset.x = (t.offset.x + dt * 0.01) % 1; }
    for (const t of waterAnimated) { t.offset.y = (t.offset.y + dt * 0.02) % 1; t.offset.x = (t.offset.x + dt * 0.012) % 1; }
}
